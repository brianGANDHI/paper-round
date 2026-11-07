import { bearing, haversine, sideAt } from './geo'
import { UTURN_WAY } from './region'
import { appendPoint, appendPoints, segmentCount } from './routeEdit'
import { MIN_TURN_DEG } from './turns'
import type { Pt, Route, Side } from './types'

/**
 * A U-turn drawn on the spot, with no road service: three points added to the end of the route that take it on a little way, across the
 * road and back down it. The road service is a poor way to turn round, since it answers for the map and not for the driver (a one-way
 * street, a wide median or a loop through the side streets are all refusals or detours), and it needs a connection. This needs neither:
 * it is the U-turn button, and what is drawn when a U-turn along the road could not be found.
 *
 * The shape is small on purpose, because the round tracks the driver along it. It is a box the width of a road: on past the end, across
 * to the right (traffic keeps left, see `UTURN_WAY`) and back down, ending a little behind where the route ended (short of that just after a
 * corner, see `uturnBehind`, and then the box goes on further, see `localUturn`). That is enough for
 * `routeTurns` to see one U-turn, a few metres past the old end, and a longer or wider box only lags the tracker behind a car that
 * turns round short of it.
 */

/** How far on past the end of the route the U-turn goes before it turns, in metres. Less than 6 and a route that ends inside the shape can't be read as a U-turn. */
export const UTURN_RUN_M = 6
/** How far across the road it turns, to the side, in metres: the width the arrow of the card is drawn for, not the width of any real road. */
export const UTURN_ACROSS_M = 5
/** How far back down the road it ends, past where the route ended, in metres: less where the route turned a corner just before its end (see `uturnBehind`). */
export const UTURN_BEHIND_M = 8
/** The way the route is heading at its end is measured over this many metres of it, so one short last piece or a bend close to the end doesn't point the U-turn wrong. */
export const HEADING_BASE_M = 12
/**
 * A corner (a turn of `MIN_TURN_DEG` or more) before the end of the route is kept this many metres from where the U-turn starts to turn, by starting the box
 * further on (see `uturnRun`), so that the two don't read as one turn. `routeTurns` chains bends up to 15 m apart into one swing, and it reads the route in
 * 5 m pieces counted from its start, so a corner or a turn of the box that falls between the ends of two pieces is spread over both: nearly 5 m either
 * way. So this is 15 + 5 + 5 (about 24.3 m at worst), with a margin. At 22 a corner the same way read as one wrong turn about half the time, and so did
 * the button pressed twice. A way back that stops short after a corner (see `uturnBehind`) is kept this long too, so that a turn out of the street at its
 * end, tapped next, is apart from the box's second corner (see `localUturn`).
 */
export const UTURN_CLEAR_M = 26
/** A leg of the route after a corner is this long, in metres, before it counts as a way the car is heading in, and not part of the corner. */
export const MIN_LEG_M = 3
/** The bends of a corner are taken together when they are within this many metres of route: a point on it, or rounded off on a radius of a few metres. */
const CORNER_SPAN_M = 10

const M_PER_DEG = (6371000 * Math.PI) / 180
const rad = (deg: number) => (deg * Math.PI) / 180
/** A last piece shorter than this, in metres, is the same place as the end, and has no way. */
const SAME_PLACE_M = 1

/** The place `ahead` metres on from `p` along `heading` (degrees clockwise from north) and `right` metres to the right of it. */
function step(p: Pt, heading: number, ahead: number, right: number): Pt {
  const east = ahead * Math.sin(rad(heading)) + right * Math.cos(rad(heading))
  const north = ahead * Math.cos(rad(heading)) - right * Math.sin(rad(heading))
  return { lat: p.lat + north / M_PER_DEG, lng: p.lng + east / (M_PER_DEG * Math.cos(rad(p.lat))) }
}

/** A change of heading from one way to another, from -180 (not included) to 180: positive is to the right. */
const turned = (from: number, to: number) => ((((to - from + 180) % 360) + 360) % 360) - 180

/** The way of the last piece of the route that is not the same place as its end, or null when the route has none. */
function lastWay(points: readonly Pt[]): number | null {
  const last = points[points.length - 1]
  for (let i = points.length - 2; last && i >= 0; i--) if (haversine(points[i], last) >= SAME_PLACE_M) return bearing(points[i], last)
  return null
}

/**
 * Where a route of at least one point is `m` metres back along it from its end (its first point, if it is shorter): the place, and the index of the
 * point before it, so that the route up to there is its points up to that one and then the place.
 */
function backAlong(points: readonly Pt[], m: number): { at: Pt; before: number } {
  let at = points[points.length - 1]
  let left = m
  for (let i = points.length - 2; i >= 0; i--) {
    const len = haversine(points[i], at)
    if (len >= left && len > 0) {
      const t = left / len
      return { at: { lat: at.lat + (points[i].lat - at.lat) * t, lng: at.lng + (points[i].lng - at.lng) * t }, before: i }
    }
    at = points[i]
    left -= len
  }
  return { at, before: 0 }
}

/** The way the route heads over its last `base` metres (all of it, if it is shorter): see `endHeading`. */
function headingOver(points: readonly Pt[], base: number): number | null {
  const last = points[points.length - 1]
  if (!last || points.length < 2) return null
  const { at: from } = backAlong(points, base)
  // The route comes back to the place it ended (a short spur out and back): the way is that of its last piece.
  return haversine(from, last) >= SAME_PLACE_M ? bearing(from, last) : lastWay(points)
}

/**
 * The way the route is heading at its end, in degrees clockwise from north: from the place `HEADING_BASE_M` back along the route (all of it, if
 * it is shorter) to the end. A chord rather than the last piece, which can be a few metres long or follow a bend: measured over the last piece a
 * bend of 45 degrees close to the end gave a U-turn that read as 'Sharp'. But a corner `MIN_LEG_M` or more before the end is the start of a leg that
 * has a way of its own, and the chord is then taken over that leg only, not across the corner (which would point the U-turn between the two ways).
 * Null when the route has no way: under two points, or none a metre apart.
 */
export function endHeading(points: readonly Pt[]): number | null {
  const corner = lastCornerBack(points)
  return headingOver(points, corner !== null && corner >= MIN_LEG_M && corner < HEADING_BASE_M ? corner : HEADING_BASE_M)
}

/**
 * How far before the end of the route its last corner is, in metres, looking back no further than `UTURN_CLEAR_M`: the nearest to the end of the
 * places where the route turns by `MIN_TURN_DEG` or more within `CORNER_SPAN_M` of route. Null when there is none. Taken at the points of the route
 * (a corner is one, tapped, or several close together, rounded off by the road service), the bends of the points near each other summed with their signs,
 * so a zigzag is no corner and a curve that turns by only a few degrees at a time isn't one.
 */
export function lastCornerBack(points: readonly Pt[]): number | null {
  // Only the end of the route matters, and a route can have thousands of points: take the points within reach of a corner, and the one before them.
  let first = points.length - 1
  for (let reach = 0; first > 0 && reach <= UTURN_CLEAR_M + CORNER_SPAN_M; first--) reach += haversine(points[first - 1], points[first])
  const tail = points.slice(Math.max(0, first - 1))
  const n = tail.length
  if (n < 3) return null
  // back[i]: metres from point i to the end of the route.
  const back = new Array<number>(n).fill(0)
  for (let i = n - 2; i >= 0; i--) back[i] = back[i + 1] + haversine(tail[i], tail[i + 1])
  // bend[i]: how far the route turns at point i, 0 where a piece beside it is no length.
  const bend = new Array<number>(n).fill(0)
  for (let i = 1; i < n - 1; i++) {
    if (haversine(tail[i - 1], tail[i]) >= 0.5 && haversine(tail[i], tail[i + 1]) >= 0.5) {
      bend[i] = turned(bearing(tail[i - 1], tail[i]), bearing(tail[i], tail[i + 1]))
    }
  }
  for (let i = n - 2; i >= 1 && back[i] <= UTURN_CLEAR_M; i--) {
    let sum = 0
    for (let k = i; k >= 1 && back[k] - back[i] <= CORNER_SPAN_M; k--) sum += bend[k]
    if (Math.abs(sum) >= MIN_TURN_DEG) return back[i]
  }
  return null
}

/**
 * How far on past the end the U-turn runs before it turns. `UTURN_RUN_M`, unless the route has a corner just before its end: a corner and a U-turn
 * that turn the same way, closer than about 25 m, read as one wrong turn (270 degrees, shown as the other way round), and `routeTurns` can't be
 * made to tell that from a tight spiral. So the box starts further on, as far as it takes to put `UTURN_CLEAR_M` between the corner and the first of
 * its two corners. A corner turning the other way is told apart whatever the run (`routeTurns` cuts it from the U-turn), and this does no harm there.
 * The way back is then that much longer, and where it would end near the road before the corner it stops short instead (see `uturnBehind`), with the
 * box going on further than this to keep the way back `UTURN_CLEAR_M` long (see `localUturn`).
 */
export function uturnRun(points: readonly Pt[]): number {
  const back = lastCornerBack(points)
  return back === null ? UTURN_RUN_M : Math.max(UTURN_RUN_M, UTURN_CLEAR_M - back)
}

/**
 * The end of the way back is kept at least `UTURN_ACROSS_M` and this many metres more from the line of the road before a corner just behind the end of the
 * route (see `uturnBehind`), so that the road service, with Follow roads on, snaps it onto the street the U-turn is in, which is `UTURN_ACROSS_M` away, and not
 * onto the road before the corner.
 */
export const UTURN_SNAP_CLEAR_M = 1
/** The way back of a U-turn is never shorter than this, in metres, however short of the end it stops (see `uturnBehind`). */
const MIN_BACK_M = 8
/** The road before a corner is a straight road, with a line of its own, when the way it heads over its last this many metres... */
const LEG_END_M = 4
/** ...is within this many degrees of the way it heads over `HEADING_BASE_M`. */
const STRAIGHT_DEG = 20
/** How far the end of the way back is moved on at a time, in metres, looking for where it is clear of the road before a corner. */
const BEHIND_STEP_M = 0.25

/** How far a place is from the line through `on` heading `heading` (degrees clockwise from north), in metres, to either side. */
function offLine(p: Pt, on: Pt, heading: number): number {
  const east = (p.lng - on.lng) * M_PER_DEG * Math.cos(rad(on.lat))
  const north = (p.lat - on.lat) * M_PER_DEG
  return Math.abs(east * Math.cos(rad(heading)) - north * Math.sin(rad(heading)))
}

/**
 * How far behind the end of the route the U-turn's way back ends, in metres (less than 0 is past the end): `UTURN_BEHIND_M`, unless the route turned a corner
 * off a straight road just before its end. The way back ends `across` to the side, and `UTURN_BEHIND_M` behind it lies near the road before the corner, or
 * across it, so the road service snapped it onto that road: with Follow roads on, the road for the next tap started there, the U-turn's way back could not
 * be drawn on from (see roads.ts), and the jog across to it read as a second U-turn, or swallowed the U-turn, or turned the turn out the wrong way. So the
 * way back stops short where it has to, at the first place, a quarter of a metre at a time, that is `across` and `UTURN_SNAP_CLEAR_M` from the line of
 * that road, measured from the corner along the way the road heads into it; it is never shorter than `MIN_BACK_M`. A road before the corner that is not
 * straight over its last `LEG_END_M` (within `STRAIGHT_DEG` of the way over `HEADING_BASE_M`) has no line to keep clear of, such as the piece across of a
 * U-turn drawn just before, and the way back ends `UTURN_BEHIND_M` behind as usual. `heading`, `turn`, `run` and `across` are the U-turn's (see `localUturn`).
 */
export function uturnBehind(points: readonly Pt[], heading: number, turn: 1 | -1, run: number, across: number): number {
  const back = lastCornerBack(points)
  const last = points[points.length - 1]
  if (back === null || !last) return UTURN_BEHIND_M
  // The route up to the corner, and the way it heads into it.
  const { at: corner, before } = backAlong(points, back)
  const into = [...points.slice(0, before + 1), corner]
  const way = headingOver(into, HEADING_BASE_M)
  const end = headingOver(into, LEG_END_M)
  // No line to keep clear of: the road into the corner is no length, or bends over its last few metres.
  if (way === null || end === null || haversine(backAlong(into, HEADING_BASE_M).at, corner) < SAME_PLACE_M) return UTURN_BEHIND_M
  if (Math.abs(turned(way, end)) > STRAIGHT_DEG) return UTURN_BEHIND_M
  for (let behind = UTURN_BEHIND_M; behind >= MIN_BACK_M - run; behind -= BEHIND_STEP_M) {
    if (offLine(step(last, heading, -behind, turn * across), corner, way) >= across + UTURN_SNAP_CLEAR_M) return behind
  }
  return MIN_BACK_M - run
}

/** How big a U-turn is drawn, in metres: see `UTURN_RUN_M`, `UTURN_ACROSS_M` and `UTURN_BEHIND_M`. */
export interface UturnSize {
  run: number
  across: number
  behind: number
}

/**
 * The three points of a U-turn at the end of the route: on past it by the run (`uturnRun`, 6 m or more), across by `UTURN_ACROSS_M` to the side
 * the U-turn goes round (`turn`: 1 to the right, as traffic keeping left does, -1 to the left) and back down the road to the run and
 * `UTURN_BEHIND_M` behind the end, or less after a corner just before the end (`uturnBehind`, which keeps the end of the way back clear of the road
 * before the corner). Where it ends less than that behind, the box goes on further than the run, as far as it takes for a way back of `UTURN_CLEAR_M`:
 * the end of the way back stays where `uturnBehind` put it. `size` changes any of those, and a `run` or `behind` given is used as it is, with nothing
 * made longer. Null when the route has no way it is heading (see `endHeading`).
 */
export function localUturn(points: readonly Pt[], turn: 1 | -1 = UTURN_WAY, size: Partial<UturnSize> = {}): Pt[] | null {
  const heading = endHeading(points)
  const last = points[points.length - 1]
  if (heading === null || !last) return null
  let run = size.run ?? uturnRun(points)
  const across = size.across ?? UTURN_ACROSS_M
  const behind = size.behind ?? uturnBehind(points, heading, turn, run, across)
  // A way back stopped short after a corner can be shorter than `UTURN_CLEAR_M`, and a turn out of the street at its end, tapped next as a straight line,
  // was then read with the box's second corner as one swing: the U-turn was lost and the turn out came the wrong way. The box goes on further instead, and
  // where its way back ends stays put (so `endsWithUturn` and the road drawn on from the U-turn are as they were).
  if (size.run === undefined && size.behind === undefined && behind < UTURN_BEHIND_M && run + behind < UTURN_CLEAR_M) run = UTURN_CLEAR_M - behind
  const a = step(last, heading, run, 0)
  const b = step(a, heading, 0, turn * across)
  const c = step(b, heading, -(run + behind), 0)
  return [a, b, c]
}

/** Whether a U-turn can be drawn at the end of the route: it has a way it is heading. */
export const canDrawUturn = (points: readonly Pt[]): boolean => endHeading(points) !== null

/**
 * The route with the U-turn added. The run on past the end belongs to the pass just driven, so it keeps that pass's side; the turn and the way back
 * start a section of `side` if that is not the side already (as the same points tapped would). Taking the three points off again, one after the other,
 * puts the route back as it was.
 */
export function withUturn(route: Route, shape: readonly Pt[], side: Side): Route {
  const [on, ...round] = shape
  if (!on) return route
  const was = sideAt(route, Math.max(0, segmentCount(route) - 1))
  return appendPoints(appendPoint(route, on, was), round, side)
}

/** A U-turn drawn at the end of a route: the route with it, and the points it added, in order (which is what Undo takes off again, all at once). */
export interface DrawnUturn {
  route: Route
  added: Pt[]
}

/** The route with a U-turn drawn at its end, thrown on `side` (see `localUturn` and `withUturn`). Null where the route has no way it is heading, so nothing to turn back from. */
export function drawUturn(route: Route, side: Side): DrawnUturn | null {
  const shape = localUturn(route.points)
  if (!shape) return null
  const next = withUturn(route, shape, side)
  return { route: next, added: next.points.slice(route.points.length) }
}

/**
 * Whether the route ends with a U-turn drawn by `drawUturn`: its last three points are exactly where `localUturn` puts them for the route before
 * them. Exactly, since the shape is worked out from those points and nothing else (and a route saved and loaded keeps its numbers), so three points
 * tapped by hand, or a U-turn whose points or the route before it were edited since, are not one.
 */
export function endsWithUturn(points: readonly Pt[]): boolean {
  if (points.length < 5) return false
  const shape = localUturn(points.slice(0, -3))
  const tail = points.slice(-3)
  return !!shape && shape.every((p, i) => p.lat === tail[i].lat && p.lng === tail[i].lng)
}

/** What to tell the driver once the U-turn is drawn. */
export const UTURN_ADDED_NOTICE = 'U-turn added. Tap where the road goes next.'
/** And, when the brush is Port or Starboard, that the side means something else now that the car is facing the other way. */
export const UTURN_SIDE_NOTICE = 'Port and Starboard are as you drive, so after the U-turn this is the other side of the street.'

/** The notice for a U-turn drawn with the brush on `side`. */
export const uturnHereNotice = (side: Side): string => (side === 'left' || side === 'right' ? `${UTURN_ADDED_NOTICE} ${UTURN_SIDE_NOTICE}` : UTURN_ADDED_NOTICE)
