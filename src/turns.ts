import { angleBetween, bearing, cumulativeDistances, haversine } from './geo'
import { UTURN_WAY } from './region'
import { spokenStreet } from './streetName'
import type { Pt } from './types'

/**
 * Turn by turn. The route is only a line, with no street names or junctions in it, so a turn here is a place
 * where that line changes direction sharply enough to need steering: a corner, or a curve tight enough to be one.
 * A road that merely bends along its length is not a turn.
 */

/** A turn in the route: how far along it is, how far the heading changes there (positive to the right, negative to the left), and the way the route heads as it comes up to it. */
export interface Turn {
  /** How far along the route the turn is, in metres: the middle of the swing, halfway between `from` and `to`. */
  at: number
  /** How far along the route the swing starts, in metres: where the route begins to change heading. */
  from: number
  /** How far along the route the swing ends, in metres: the road the turn leads into starts here. The same as `from` for a corner with a point on it. */
  to: number
  angle: number
  /** The way the route heads just before the turn, in degrees clockwise from north. */
  heading: number
}

export type TurnKind = 'bear' | 'turn' | 'sharp' | 'uturn'

/** The route is walked in pieces this long, in metres, and the heading of each piece is compared with the one before. */
const STEP_M = 5
/** A change of heading over one piece, in degrees, below which the road counts as running straight there: a curve gentler than about 70 m across. */
const BEND_DEG = 4
/** Up to this many straight joints can sit inside one turn, such as the short straight between two points drawn close together. */
const GAP_JOINTS = 2
/**
 * A piece of the walked route that ends less than this from where it starts, in metres, is one the route doubles back inside, along its own line
 * (a U-turn along the road, or one drawn on the spot that the road resumed beside), not a way it heads: the little that is left of it points
 * whichever way the six-figure coordinates of the road service tip it, so a U-turn there came out to the left now and then, or as a turn the
 * wrong way beside a corner. It is less than any U-turn drawn as two corners is across (2 m and more), so those keep the way they go round.
 */
const FOLD_M = 1
/** A change of heading smaller than this, in degrees, isn't a turn. */
export const MIN_TURN_DEG = 40
/**
 * Two turns the same way with no more than this between them, in metres (from where the first ends to where the next starts),
 * can be the two halves of one U-turn: the way back drawn on the other carriageway, up to about 30 m to the side, with a short
 * piece across. Turns further apart than that, such as the corners of a loop of the block, are separate turns.
 */
export const UTURN_GAP_M = 30
/** Turns the same way, close together, that add up to at least this many degrees are one U-turn (and a turn that is that big alone is left as it is)... */
export const UTURN_MIN_DEG = 150
/** ...and to no more than this: any more is going on round, such as three corners of a block, and they stay as they are. */
export const UTURN_MAX_DEG = 225
/**
 * ...and only when one of them is a sharp corner: it turns the heading by this much or more within `CORNER_M` of route (where the
 * card says a turn and not a bear). A road that curves round, drawn as a string of bends, adds up to a half turn just as well,
 * but it is not a U-turn. A crescent thinned to a point every 30 m or so is bends of 25 to 45 degrees, and none of them is a corner.
 */
export const UTURN_CORNER_DEG = 70
/** The stretch of route, in metres, within which a corner turns the heading: a point on it, or rounded off on a radius of up to about 20 m. */
const CORNER_M = 20
/**
 * A U-turn comes back near where it went in: where it ends is no further than this from where it starts, in metres. That takes in the way back on the
 * other carriageway (`UTURN_GAP_M`, and the corners either side of it) and a half circle on a radius of up to about 27 m, which is tight enough to steer
 * round. A road that follows a long curve through a half turn ends further off than that, and has only gone round a bend, however far its heading has come.
 */
export const UTURN_BACK_M = 55
/**
 * Swings joined into one U-turn that end further apart than this, in metres, have to come round by `UTURN_SQUARE_DEG` as well: the way back across a wide
 * median runs straight back. Two corners of a road, 40 m or so apart with a bend or two to bridge the gap, can add up to 165 degrees and end this far apart,
 * and they are two corners.
 */
export const UTURN_SQUARE_M = 45
export const UTURN_SQUARE_DEG = 171

/** How far ahead a turn is shown (and its first cue given), in metres. */
export const TURN_SHOW_M = 200
/** How far ahead the long-range cue "in 500 metres" is given, in metres, for a driver on a stretch of transit (see `turnCue`). */
export const TURN_HALF_M = 500
/** How far ahead the first long-range cue, "in 1 kilometre", is given, in metres. */
export const TURN_KM_M = 1000
/** Inside this the turn is close enough for the last cue, in metres. */
export const TURN_NEAR_M = 60
/**
 * A turn stays up until the driver is this far past it, in metres, so a fix a little behind doesn't drop it at once; but no longer than until the
 * next turn starts this far ahead, so that one is up in time (see `isThrough`).
 */
export const TURN_PASSED_M = 15
/** Further than this from the route, in metres, the driver is not on it, and what comes next along it means nothing. */
export const TURN_MAX_GAP_M = 40
/** A fix less accurate than this, in metres, can't say how far along the route the driver is. */
export const TURN_MAX_ACCURACY_M = 65

/**
 * Whether the phone is on the route, and its fix good enough, for how far along the route it is to be trusted. `gap` is
 * how far it is from the route, and `lost` is whether it is too far to say where along the route it is. A poor fix is
 * allowed to be further off: it can be out by that much.
 */
export const onTheRoute = (gap: number | null, accuracy: number, lost = false): boolean =>
  !lost && gap !== null && gap <= Math.max(TURN_MAX_GAP_M, 2.5 * accuracy) && accuracy <= TURN_MAX_ACCURACY_M

/** A heading change as an angle from -180 (not included) to 180: positive is to the right. */
const wrap = (deg: number) => 180 - ((((180 - deg) % 360) + 360) % 360)

/** A turn this big or bigger, in degrees, is a U-turn. */
const UTURN_DEG = 165

/**
 * How far a swing of the route turns you: its changes of heading added up, as an angle (see `wrap`). A swing that goes right
 * round to somewhere between a U-turn and a little past it, such as a hairpin drawn with 95 degrees at each corner, is a
 * U-turn the way it went round (180 degrees at most), not one the other way, which is what wrapping alone would make of it.
 */
const swingAngle = (sum: number): number =>
  Math.abs(sum) >= UTURN_DEG && Math.abs(sum) <= UTURN_MAX_DEG ? Math.sign(sum) * Math.min(180, Math.abs(sum)) : wrap(sum)

/** Where the route is after `d` metres along it (kept within the route), given how far along each of its points is. */
export function pointAt(points: Pt[], cum: number[], d: number): Pt {
  let lo = 0
  let hi = cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= d) lo = mid
    else hi = mid
  }
  const span = cum[hi] - cum[lo]
  const t = span > 0 ? Math.min(1, Math.max(0, (d - cum[lo]) / span)) : 0
  const a = points[lo]
  const b = points[hi]
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }
}

/**
 * The turns in a route, in order. The route is walked in short pieces and the heading of each is compared with
 * the last. Where it keeps changing, one swing of the route with no straight in it, those changes add up to one
 * turn, put where the change is half done, and it is as big as the difference between the way you were heading
 * and the way you end up. That makes a roundabout one turn, as far as it turns you, and a chicane none.
 * Turns with a straight between them, such as a dog-leg, stay separate. A change of less than 40 degrees in all
 * is left out, and so is a road that curves gently over a long way, however far round it goes in the end.
 * The exception is a U-turn drawn as two corners the same way, with a short way across between them (the way back on the
 * other side of the road, up to about 30 m off): those are one turn, see `joinUturns`. A loop round a block is not.
 * Nor is a swing that goes a half turn round without coming back near where it went in (see `UTURN_BACK_M`): that is a long curve, and
 * only the corners in it are turns (see `cornersOf`).
 */
export function routeTurns(points: Pt[]): Turn[] {
  if (points.length < 3) return []
  const cum = cumulativeDistances(points)
  const pieces = Math.floor(cum[cum.length - 1] / STEP_M)
  if (pieces < 2) return []
  const heading: number[] = []
  for (let j = 0; j < pieces; j++) {
    const a = pointAt(points, cum, j * STEP_M)
    const b = pointAt(points, cum, (j + 1) * STEP_M)
    // A piece the route doubles back inside (see `FOLD_M`) keeps the heading of the one before, so the whole reversal is at one joint.
    heading.push(j > 0 && haversine(a, b) < FOLD_M ? heading[j - 1] : bearing(a, b))
  }

  // Joint j is where piece j meets piece j + 1, (j + 1) * STEP_M metres along.
  const swings: RawSwing[] = []
  for (let j = 0; j + 1 < pieces; j++) {
    const bend = wrap(heading[j + 1] - heading[j])
    if (Math.abs(bend) < BEND_DEG) continue
    const swing = swings[swings.length - 1]
    if (swing && j - swing.last <= GAP_JOINTS + 1) {
      swing.last = j
      swing.sum += bend
      swing.bends.push({ joint: j, bend })
    } else {
      swings.push({ first: j, last: j, sum: bend, bends: [{ joint: j, bend }] })
    }
  }
  const apart: Apart = (from, to) => haversine(pointAt(points, cum, from), pointAt(points, cum, to))
  const all = swings
    .flatMap(splitLobes)
    .flatMap((s) => (Math.abs(swingTurn(s)) >= UTURN_DEG && apart((s.first + 1) * STEP_M, (s.last + 1) * STEP_M) > UTURN_BACK_M ? cornersOf(s, apart) : [s]))
    .map((s) => ({
      at: ((s.first + s.last + 2) / 2) * STEP_M,
      from: (s.first + 1) * STEP_M,
      to: (s.last + 1) * STEP_M,
      angle: swingTurn(s),
      heading: heading[s.first],
      sharpest: sharpestWithin(s.bends),
    }))
  return joinUturns(all, apart).filter((t) => Math.abs(t.angle) >= MIN_TURN_DEG)
}

/** How far apart two places along the route are on the ground, in metres, given how far along it each is. */
type Apart = (from: number, to: number) => number

/** One change of heading at a joint of the walked route (see `routeTurns`), in degrees: positive to the right. */
interface Bend {
  joint: number
  bend: number
}

/** A swing of the walked route: the first and last joints it spans, its bends and what they add up to. */
interface RawSwing {
  first: number
  last: number
  sum: number
  bends: Bend[]
}

/** A single bend this big, in degrees, is the route going straight back along its own line. Its side then means nothing: it is rounding that makes it +180 or -180. */
export const REVERSAL_DEG = 178.5
/** A lobe of a swing this big, in degrees, is a real corner: the least that is cut away from a U-turn next to it (the U-turn's own size is `UTURN_MIN_DEG` to `UTURN_MAX_DEG`). */
const LOBE_CORNER_DEG = 60

/** Whether a bend is the route going straight back along its own line, in one joint (see `REVERSAL_DEG`). */
const isReversal = (b: Bend | undefined): boolean => !!b && Math.abs(b.bend) >= REVERSAL_DEG

/**
 * A swing cut into its lobes, where it is a U-turn with a corner the other way right next to it. A swing sums its bends and wraps the
 * total, so a left corner within 15 m of a right U-turn cancels to a lone right turn, and the U-turn is never shown. Its bends are cut
 * into lobes, each the bends that turn the same way. Exactly two lobes, one a U-turn's worth (`UTURN_MIN_DEG` to `UTURN_MAX_DEG`) and the
 * other a corner of `LOBE_CORNER_DEG` or more, are two turns. Anything else is left whole: a roundabout is three lobes (in, round, out),
 * and a jog or a chicane is small lobes or equal ones. The same-way case (a right corner and a right U-turn, 270 degrees in all) is left
 * as it is, since it can't be told from a tight spiral; the drawing keeps the two apart instead (see `uturnRun`).
 *
 * A route that goes straight back along its own line in one joint (a road-service U-turn, or a drawn U-turn the road resumes beside) cuts
 * its swing there, whatever its sign, which is only rounding: joined to a corner next to it that happened to turn the same way, the two
 * read as a lone turn the wrong way round, and with a corner on both sides of it (in and out of a short court) as nothing at all, or one
 * U-turn. The bends before it and the bends after it are each a swing of their own (cut into lobes as above), and the reversal is the
 * U-turn, which `swingTurn` gives the way U-turns go round here. So a corner either way next to such a reversal, or one on each side of
 * it, is a turn of its own. A roundabout never turns 178.5 degrees in one joint, so it stays whole.
 */
function splitLobes(s: RawSwing): RawSwing[] {
  if (s.bends.length > 1 && s.bends.some(isReversal)) {
    const of = (bends: Bend[]): RawSwing => ({ first: bends[0].joint, last: bends[bends.length - 1].joint, sum: bends.reduce((t, b) => t + b.bend, 0), bends })
    const parts: RawSwing[] = []
    let run: Bend[] = []
    for (const b of s.bends) {
      if (!isReversal(b)) {
        run.push(b)
        continue
      }
      if (run.length) parts.push(...splitLobes(of(run)))
      run = []
      parts.push(of([b]))
    }
    if (run.length) parts.push(...splitLobes(of(run)))
    return parts
  }
  const lobes: RawSwing[] = []
  for (const b of s.bends) {
    const lobe = lobes[lobes.length - 1]
    // A swing with a reversal and other bends in it was cut at the reversal above, so a reversal here is a swing on its own.
    if (lobe && Math.sign(lobe.sum) === Math.sign(b.bend)) {
      lobe.last = b.joint
      lobe.sum += b.bend
      lobe.bends.push(b)
    } else {
      lobes.push({ first: b.joint, last: b.joint, sum: b.bend, bends: [b] })
    }
  }
  if (lobes.length !== 2) return [s]
  const [a, b] = lobes.map((l) => Math.abs(l.sum))
  const uturn = (deg: number) => deg >= UTURN_MIN_DEG && deg <= UTURN_MAX_DEG
  return (uturn(a) && b >= LOBE_CORNER_DEG) || (uturn(b) && a >= LOBE_CORNER_DEG) ? lobes : [s]
}

/** How far a swing turns the heading: see `swingAngle`, except that a route going straight back along its own line, in one joint, turns the way a U-turn goes round here (`UTURN_WAY`). */
function swingTurn(s: RawSwing): number {
  const angle = swingAngle(s.sum)
  return Math.abs(angle) >= UTURN_DEG && s.bends.some((b) => Math.abs(b.bend) >= REVERSAL_DEG) ? UTURN_WAY * Math.abs(angle) : angle
}

/** How far either side of a place on the route, in metres, `readsAsUturnAt` reads it: further than the bends of a road that curves round it carry a turn there. */
const READ_AROUND_M = 50

/**
 * Whether, of the turns `routeTurns` found in a route, the one at `at` metres along it is a U-turn the way they go round here (`UTURN_WAY`). The turn
 * there is the one whose stretch, from where it starts to where it ends, takes in `at`; or else the one whose middle is nearest, no more than two pieces
 * off; or else the one whose stretch is nearest, no more than a piece off. A slight bend the same way a little before a U-turn is joined into it (see
 * `joinUturns`), which puts its middle halfway between the two, 9 m or more short of where the route turns round, and a route that doubles back along
 * its own line in the middle of a piece turns at one end of that piece, so the stretch of such a U-turn can end a few metres short of the place.
 */
export function uturnThere(turns: readonly Turn[], at: number): boolean {
  /** The turn nearest `at` by `far`, if that is no more than `within`. */
  const nearest = (far: (t: Turn) => number, within: number): Turn | null => {
    const best = turns.reduce<Turn | null>((b, t) => (!b || far(t) < far(b) ? t : b), null)
    return best && far(best) <= within ? best : null
  }
  /** How far `at` is from a turn's stretch: 0 within it. */
  const off = (t: Turn) => Math.max(0, t.from - at, at - t.to)
  const there = turns.find((t) => off(t) === 0) ?? nearest((t) => Math.abs(t.at - at), 2 * STEP_M) ?? nearest(off, STEP_M)
  return !!there && turnKind(there.angle) === 'uturn' && Math.sign(there.angle) === UTURN_WAY
}

/**
 * Whether `routeTurns` reads the route as a U-turn the way they go round here (`UTURN_WAY`) at `at` metres along it (see `uturnThere`), wherever along
 * it its 5 m pieces fall: the route `READ_AROUND_M` either side of the place is read with the pieces starting at every quarter of a metre of one. Where
 * a route doubles back along its own line, the way it goes round is only the way its pieces lean, so where the road curves through, or the way back is
 * a little to one side, it can be read the other way round, or as a sharp turn, at some of those. The route as a whole falls on its pieces at a place
 * between those quarters, so whoever asks this of a route that is to be read as a whole should also ask `uturnThere` of its turns (see roads.ts).
 */
export function readsAsUturnAt(points: Pt[], at: number): boolean {
  const cum = cumulativeDistances(points)
  const to = Math.min(cum[cum.length - 1] ?? 0, at + READ_AROUND_M)
  for (let skip = 0; skip < STEP_M; skip += STEP_M / 20) {
    // Read from `skip` m further on, so the pieces fall that much further on.
    const from = Math.max(0, at - READ_AROUND_M) + skip
    if (from >= at) return false
    const stretch = [pointAt(points, cum, from), ...points.filter((_, i) => cum[i] > from && cum[i] < to), pointAt(points, cum, to)]
    if (!uturnThere(routeTurns(stretch), at - from)) return false
  }
  return true
}

/** A swing as it is joined: a turn, and the most it turns the heading within `CORNER_M` of route. */
type Swing = Turn & { sharpest: number }

/** The most the heading is turned within `CORNER_M` of route by a swing's bends (each `joint` a piece of route along): the most that any run of them close enough together adds up to. */
function sharpestWithin(bends: { joint: number; bend: number }[]): number {
  let most = 0
  for (let i = 0; i < bends.length; i++) {
    let sum = 0
    for (let k = i; k < bends.length && (bends[k].joint - bends[i].joint) * STEP_M <= CORNER_M; k++) sum += bends[k].bend
    most = Math.max(most, Math.abs(sum))
  }
  return most
}

/**
 * The corners of a swing that goes a half turn round and doesn't come back: a long curve, drawn as one swing because no stretch of it runs straight. It is
 * no U-turn, and the road it follows only bends, but a corner in it (often where a street joins the curve) is a corner: each run of bends that turns
 * the heading by `MIN_TURN_DEG` or more within `CORNER_M` of route is a swing of its own, and whatever is left over is gone, as any bend in a road is.
 * A run that is a half turn and ends further than `UTURN_BACK_M` from where it starts is the curve itself, a little too wide to be a U-turn and just tight enough
 * to be a corner, and it is gone too. One that comes back within that is a hairpin the curve runs into with no straight before it: that is a U-turn, as it would
 * be with a straight there.
 */
function cornersOf(s: RawSwing, apart: Apart): RawSwing[] {
  const sharp = new Set<number>()
  s.bends.forEach((b, i) => {
    let sum = 0
    for (let k = i; k < s.bends.length && (s.bends[k].joint - b.joint) * STEP_M <= CORNER_M; k++) {
      sum += s.bends[k].bend
      if (Math.abs(sum) < MIN_TURN_DEG) continue
      for (let n = i; n <= k; n++) sharp.add(n)
      break
    }
  })
  const corners: RawSwing[] = []
  s.bends.forEach((b, i) => {
    if (!sharp.has(i)) return
    const corner = sharp.has(i - 1) ? corners[corners.length - 1] : undefined
    if (!corner) corners.push({ first: b.joint, last: b.joint, sum: b.bend, bends: [b] })
    else {
      corner.last = b.joint
      corner.sum += b.bend
      corner.bends.push(b)
    }
  })
  return corners.filter((c) => Math.abs(swingTurn(c)) < UTURN_DEG || apart((c.first + 1) * STEP_M, (c.last + 1) * STEP_M) <= UTURN_BACK_M)
}

/** A swing that turns the heading by less than `MIN_TURN_DEG` in all: a slight bend, such as the start of a slanted piece across. */
const isSlight = (s: Swing): boolean => Math.abs(s.angle) < MIN_TURN_DEG
/** A swing that turns the heading by `MIN_TURN_DEG` or more but never that much within `CORNER_M`: a stretch of road that curves round, drawn as a string of bends. It is no corner. */
const isCurve = (s: Swing): boolean => !isSlight(s) && s.sharpest < MIN_TURN_DEG

/** Whether the swing before swing `i` turns the same way and ends within `UTURN_GAP_M` of where it starts: it comes in a run of bends, as a road does that curves round. */
const followsBend = (swings: Swing[], i: number): boolean =>
  i > 0 && Math.sign(swings[i - 1].angle) === Math.sign(swings[i].angle) && swings[i].from - swings[i - 1].to <= UTURN_GAP_M

/**
 * Joins the two halves of a U-turn into one turn. A U-turn is drawn in several ways: a point where the route doubles back
 * (one swing of 180 degrees, which needs nothing here), a hairpin of two corners a few metres apart (joined by `routeTurns`
 * already), and the way back drawn on the other lane or carriageway, which is two corners the same way with a short piece
 * between them. Those last are joined here: swings the same way, each starting within `UTURN_GAP_M` of where the last ended,
 * that together turn the heading by `UTURN_MIN_DEG` to `UTURN_MAX_DEG`. The joined turn is as far round as they add up to, 180 at most.
 *
 * They must be corners, though. A road that curves round adds up to a half turn as well, as a string of small bends once the route
 * is thinned, and that is no U-turn, nor a sharp turn, however far round it goes, nor is a curve that comes after a corner or before one:
 *  - one of them is a sharp corner, of `UTURN_CORNER_DEG` within a short stretch of route;
 *  - none of them is a stretch of curve (see `isCurve`);
 *  - no more than one is a slight bend (see `isSlight`), as the start of a slanted piece across is, and a slight bend that comes in
 *    a run of bends (see `followsBend`) does not start a join;
 *  - the route comes back near where it went in (see `UTURN_BACK_M` and `UTURN_SQUARE_M`). Two corners with a long way between them, broken up by a slight
 *    bend so that no one gap is too long, are two corners, and a slight bend a long way before a U-turn is no part of it.
 * A swing that is a half turn already stays as it is, and so does one that is followed by something that doesn't add up to a U.
 */
function joinUturns(swings: Swing[], apart: Apart): Turn[] {
  const turns: Turn[] = swings.map(({ at, from, to, angle, heading }) => ({ at, from, to, angle, heading }))
  const out: Turn[] = []
  for (let i = 0; i < swings.length; ) {
    const first = swings[i]
    let last = -1
    let total = first.angle
    if (Math.abs(total) < UTURN_MIN_DEG && !isCurve(first) && !(isSlight(first) && followsBend(swings, i))) {
      let sharpest = first.sharpest
      let slight = isSlight(first) ? 1 : 0
      for (let k = i + 1; k < swings.length; k++) {
        const next = swings[k]
        if (Math.sign(next.angle) !== Math.sign(first.angle) || next.from - swings[k - 1].to > UTURN_GAP_M || isCurve(next)) break
        // A swing that is a U-turn on its own takes in a slight bend just before it, but not a turn: that is a turn of its own. (The turn into
        // a short court at 40 to 45 degrees, the way U-turns go round, and the reversal at its end added up to no more than `UTURN_MAX_DEG`,
        // and its 'Bear right' was lost in the U-turn.)
        if (Math.abs(next.angle) >= UTURN_MIN_DEG && (k > i + 1 || !isSlight(first))) break
        total += next.angle
        sharpest = Math.max(sharpest, next.sharpest)
        if (isSlight(next)) slight++
        if (slight > 1 || Math.abs(total) > UTURN_MAX_DEG) break
        if (Math.abs(total) >= UTURN_MIN_DEG) {
          const across = apart(first.from, next.to)
          if (sharpest >= UTURN_CORNER_DEG && across <= UTURN_BACK_M && (across <= UTURN_SQUARE_M || Math.abs(total) >= UTURN_SQUARE_DEG)) last = k
          break
        }
      }
    }
    if (last < 0) {
      out.push(turns[i])
      i++
      continue
    }
    const from = first.from
    const to = swings[last].to
    out.push({ at: (from + to) / 2, from, to, angle: Math.sign(total) * Math.min(180, Math.abs(total)), heading: first.heading })
    i = last + 1
  }
  return out
}

export interface UpcomingTurn<T extends Turn = Turn> {
  turn: T
  /** Metres from the driver to the turn: negative once the driver is past it. */
  ahead: number
}

/** A turn only counts as coming up when the driver is heading roughly the way the route does as it reaches it, in degrees. */
export const TURN_HEADING_TOLERANCE = 60
/**
 * How far, in degrees, the phone's heading may be from the way into a U-turn that is the next turn along the route, for it to count: anything nearer
 * the way in than the way out. At a U-turn the heading is what tells a driver who has turned round from one who hasn't, and the way out is a half turn
 * from the way in, so this still does. A bend on the way in that has no card of its own, such as a dog-leg near the end of a court, then doesn't take
 * the U-turn off the card while the car drives it, which also drops its last word if that is waiting to be said. Only the next turn by place has this
 * margin, so a U-turn is never shown ahead of a turn that comes before it. Once the driver is put past the U-turn, the heading has to agree with the
 * way in by the usual margin for the U-turn to stay (see `upcomingTurn`).
 */
export const UTURN_HEADING_TOLERANCE = 90

export interface UpcomingOptions {
  /** The way the phone is heading, in degrees clockwise from north, or null when it can't say. */
  heading?: number | null
  /** Turns at or before this many metres along the route are behind the driver for good, however the position wanders. */
  after?: number
  /**
   * How far along the route the driver is known to have got, in metres (the furthest reached). A turn the driver is through by then (see
   * `passedAt`) is behind them for good, however the position wanders back, and so every turn before one whose swing has been reached is.
   */
  reached?: number
  /** How far ahead, in metres, a turn is still wanted: `TURN_SHOW_M` when not given. `Infinity` finds the next one however far off. */
  range?: number
  /** How far, in degrees, the phone's heading may be from the way the route heads into a turn for the turn to count: `TURN_HEADING_TOLERANCE` when not given. */
  tolerance?: number
}

/**
 * Where along the route, in metres, the card moves on from `turn` before the driver is `TURN_PASSED_M` past it, because the next turn
 * (`next`) starts less than twice that past it: `TURN_PASSED_M` before the next one starts, so it is up in time, but not before the swing
 * of this one ends. Null when the next turn is further off, or there is none, and the turn stays up the whole `TURN_PASSED_M`.
 */
function movesOnAt(turn: Turn, next: Turn | undefined): number | null {
  if (!next) return null
  const early = Math.max(turn.to, next.from - TURN_PASSED_M)
  return early < turn.at + TURN_PASSED_M ? early : null
}

/**
 * Whether a driver `at` metres along the route is through `turn`, for the card to move on from it, given the turn after it (`next`, if
 * any): more than `TURN_PASSED_M` past it, so a fix a little behind doesn't drop it at once; or, when the next turn is close, at or past
 * where the card moves on early (see `movesOnAt`). The turn into a short court, the U-turn at its end and the turn out are 8 to 16 m
 * apart, and with the whole `TURN_PASSED_M` the turn in was still up, for a driver with no heading, until the U-turn was behind them.
 * Either way it is short of where the next turn starts, so a turn is through by the time the next one is reached.
 */
function isThrough(turn: Turn, next: Turn | undefined, at: number): boolean {
  const early = movesOnAt(turn, next)
  return early === null ? at > turn.at + TURN_PASSED_M : at >= early
}

/**
 * The turn to show the driver at `along` metres along the route: the next one not yet passed, once it is near enough
 * (within `range`, which is `TURN_SHOW_M` unless a caller wants to look further). A street driven twice has turns on each
 * pass at the same place, one for each way along it, so a turn that comes up the other way to the way the phone is heading
 * is not the one being driven to, and one already passed does not return. The turns are in order along the route, as
 * `routeTurns` gives them, and may carry more than a `Turn` does, such as the street each leads into: the one returned is
 * the same object.
 *
 * A turn is passed once the driver is through it (see `isThrough`): with turns close together, such as in, round and out of a
 * short court, that is as soon as the next one is coming up, so they are shown in order, and a turn the furthest reached is
 * through (as it is of every turn before one whose swing it has reached) never comes back. Once past a corner, but before it
 * is behind them for good, the phone's heading can still be the way into it, as a heading lags a turn: the turn that moved the
 * card on from it early counts for that heading too, so it is not passed over for a later one that happens to lie the way the
 * driver is still heading (the turn out of a court at 120 degrees to the road lies 60 degrees off the road). Not the turn after a
 * U-turn, though: a place just past a U-turn is the place just before it, so only the heading can say the driver has turned round.
 * For the same reason a U-turn that is the next turn by place counts for any heading nearer the way into it than the way out (see
 * `UTURN_HEADING_TOLERANCE`), so a bend on the way in with no card of its own doesn't blank the card. And a U-turn the next turn moves
 * the card on from early is not passed for a phone still heading the way into it (see `notRound`), so the card does not skip it. The heading
 * helps the other way too: the turn just before a close U-turn is passed for a phone that has come round it though the fix lags (see
 * `cameRound`), and just past a U-turn a phone not yet round is shown no turn but the one after it (see `notYetRound`).
 */
export function upcomingTurn<T extends Turn>(turns: readonly T[], along: number, options: UpcomingOptions = {}): UpcomingTurn<T> | null {
  const { heading = null, after = -Infinity, reached = -Infinity, range = TURN_SHOW_M, tolerance = TURN_HEADING_TOLERANCE } = options
  const agrees = (t: Turn, margin = tolerance) => heading === null || angleBetween(t.heading, heading) <= margin
  const passed = (i: number, at: number) => isThrough(turns[i], turns[i + 1], at)
  /** Whether the turn at `i` is behind the driver for good. */
  const gone = (i: number) => turns[i].at <= after || passed(i, reached)
  /**
   * Whether the driver is put past the U-turn at `i` with the phone still heading the way into it, short of the next turn and within what any U-turn is
   * held for. In a short court a fix a little ahead of the car does that before the car has come to the end, and the card and the voice would go straight
   * on to the turn out. Here the heading goes against the place, so it has to agree with the way in by the usual margin (`TURN_HEADING_TOLERANCE`), not the
   * wider one a U-turn the place says is still ahead has (`UTURN_HEADING_TOLERANCE`), nor a wider one asked for: a phone part way round at the end of an
   * 8 m court brought the U-turn back after the turn out more often with 90 degrees, and no more often said it in time. The way out is a half turn from the
   * way in, so this holds the turn after it back only from a phone that is still nowhere near heading that way. The furthest reached still puts the U-turn
   * behind the driver for good (see `gone`).
   */
  const notRound = (i: number) =>
    turnKind(turns[i].angle) === 'uturn' &&
    heading !== null &&
    angleBetween(turns[i].heading, heading) <= TURN_HEADING_TOLERANCE &&
    along <= turns[i].at + TURN_PASSED_M &&
    along < (turns[i + 1]?.from ?? Infinity)
  /**
   * Whether the phone heads out of `t`, and so has come round it: the way out by the usual margin (`TURN_HEADING_TOLERANCE`), and nearer that than the
   * way in. A heading far from both, as one still the way into a court is from a turn out of it, says nothing of the turn.
   */
  const headsOutOf = (t: Turn) => {
    if (heading === null) return false
    const out = angleBetween(t.heading + t.angle, heading)
    return out <= TURN_HEADING_TOLERANCE && out < angleBetween(t.heading, heading)
  }
  /**
   * Whether the phone says the driver has come round the turn at `i` while the place says they are still in its swing, when a U-turn is next and close
   * enough for the card to move on early. The card holds a turn until its swing ends (see `movesOnAt`), and a fix that lags at the end of a court can sit
   * just short of that until the car is at the end, and the next fix put it past the U-turn: the U-turn was never shown or said. A phone heading within
   * 60 degrees of the way out of the turn (`TURN_HEADING_TOLERANCE`), and nearer that than the way into it, has come round it (see `headsOutOf`). Not
   * before the driver is at the turn, nor more than `TURN_PASSED_M` short of where the U-turn starts (where the card would move on were it not held to
   * the swing), nor with no heading to go by, so a corner rounded off ahead of a U-turn is held as before for a phone that can't say.
   */
  const cameRound = (i: number) => {
    const t = turns[i]
    const then = turns[i + 1]
    return (
      !!then &&
      turnKind(t.angle) !== 'uturn' &&
      turnKind(then.angle) === 'uturn' &&
      movesOnAt(t, then) !== null &&
      along >= Math.max(t.at, then.from - TURN_PASSED_M) &&
      headsOutOf(t)
    )
  }
  /** Whether the driver is through the turn at `i` where they are now: past it by place, or round it by the phone, and not a driver yet to turn round at a U-turn. */
  const through = (i: number) => (passed(i, along) || cameRound(i)) && !notRound(i)
  /** The first turn the driver is not through, by place along the route, and so the one a U-turn's wider margin is for. */
  const next = turns.findIndex((_, i) => !through(i) && !gone(i))
  /**
   * Whether the driver is put just past a U-turn, within what any U-turn is held for, with the next turn the one after it, and the phone not yet round:
   * still nearer the way into the U-turn than the way out (`UTURN_HEADING_TOLERANCE`). The furthest reached can put the U-turn behind the driver for good
   * while the car is still at the end of the court, and a turn further on can lie the way into the court. Its first words then held up the last word for
   * the turn out until the card had gone on, and that was dropped unsaid. Only the next turn by place is shown here, so the card is blank until the heading
   * agrees with it. A phone that has come round chooses as anywhere else, and so does one put in the swing of the turn out and heading out of that: after
   * a U-turn and a turn out of 90 degrees the heading is as near the way into the U-turn as its way out, and a U-turn just after the turn out was kept off
   * the card a second while the fix lagged.
   */
  const notYetRound =
    next > 0 &&
    turnKind(turns[next - 1].angle) === 'uturn' &&
    heading !== null &&
    angleBetween(turns[next - 1].heading, heading) <= UTURN_HEADING_TOLERANCE &&
    along >= turns[next - 1].from &&
    along <= turns[next - 1].at + TURN_PASSED_M &&
    !(along >= turns[next].from && headsOutOf(turns[next]))
  const turn = turns.find((t, i) => {
    if (through(i) || gone(i) || (notYetRound && i > next)) return false
    if (agrees(t)) return true
    if (i === next && turnKind(t.angle) === 'uturn' && agrees(t, Math.max(tolerance, UTURN_HEADING_TOLERANCE))) return true
    const prev = i > 0 ? turns[i - 1] : null
    return !!prev && turnKind(prev.angle) !== 'uturn' && movesOnAt(prev, t) !== null && !gone(i - 1) && agrees(prev)
  })
  if (!turn) return null
  const ahead = turn.at - along
  return ahead <= range ? { turn, ahead } : null
}

/** How sharp a turn is, going by how far it turns the heading. */
export function turnKind(angle: number): TurnKind {
  const a = Math.abs(angle)
  if (a >= UTURN_DEG) return 'uturn'
  if (a >= 130) return 'sharp'
  if (a >= 70) return 'turn'
  return 'bear'
}

/** What to call a turn: as written on the card, and as said out loud after "In 100 metres,". */
export function turnWords(angle: number): { label: string; spoken: string } {
  const side = angle < 0 ? 'left' : 'right'
  switch (turnKind(angle)) {
    case 'uturn':
      return { label: 'U-turn', spoken: 'make a U-turn' }
    case 'sharp':
      return { label: `Sharp ${side}`, spoken: `turn sharp ${side}` }
    case 'turn':
      return { label: `Turn ${side}`, spoken: `turn ${side}` }
    case 'bear':
      return { label: `Bear ${side}`, spoken: `bear ${side}` }
  }
}

/** How far away the turn is, for the card: "Now" when it is right here, otherwise to the nearest 10 m. */
export function turnAheadText(ahead: number): string {
  return ahead < 15 ? 'Now' : `${Math.round(ahead / 10) * 10} m`
}

/**
 * What has been said about a turn: the warning when it came into view (`far`), the last word as the driver reached it
 * (`near`), and, for a driver on a stretch of transit, the two earlier warnings at about a kilometre (`km`) and half that (`half`).
 */
export type TurnCue = 'km' | 'half' | 'far' | 'near'

/** The order cues come in: a cue is only ever given when it is later than the last one given. */
const CUE_ORDER: Record<TurnCue, number> = { km: 1, half: 2, far: 3, near: 4 }

/**
 * What to say now about a turn, if anything. `said` is what has been said about it already. Each is said once, in order:
 * the warning when it comes into view, then the last word when it is near. A turn first seen already near has no warning,
 * only the last word, and one first seen part way in is given the cue for where it is. With `long` (a driver in transit,
 * where the next turn may be a long way off) there are two more cues before those, at about 1 km (`km`) and 500 m (`half`; the cues
 * change over at 550 m and 225 m, so that each says a different distance);
 * without it a turn further than `TURN_SHOW_M` is not spoken of, as before. A cue is never given again once a later one has been.
 */
export function turnCue(ahead: number, said: TurnCue | null, long = false): TurnCue | null {
  if (ahead > (long ? TURN_KM_M : TURN_SHOW_M)) return null
  // The long cues switch a little past the 200 m and 500 m they are named for (at 225 m and 550 m), where the words for the distance change, so a turn
  // first met just beyond one is given the cue that says the nearer distance, and no two cues say the same ("In 500 metres" twice).
  const cue: TurnCue = ahead <= TURN_NEAR_M ? 'near' : (long ? ahead < TURN_SHOW_M + 25 : ahead <= TURN_SHOW_M) ? 'far' : ahead < TURN_HALF_M + 50 ? 'half' : 'km'
  return !said || CUE_ORDER[cue] > CUE_ORDER[said] ? cue : null
}

/** A distance as it is said: to the nearest 10 m under 100 m, to the nearest 50 m above. (The off-route words, in offRoute.ts, go by this too.) */
export const spokenMetres = (m: number): number => (m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50)

/**
 * A distance for a long-range cue as the words for it: "80 metres", "200 metres", "700 metres", "1 kilometre", "1.5 kilometres",
 * "2 kilometres". Under 500 m it is said as `spokenMetres` says it. From 500 m it is to the nearest 100 m under a kilometre, so a
 * turn first heard of a little short of one is "1 kilometre" and not "950 metres", and from a kilometre it is to the nearest 500 m.
 */
export function spokenDistance(m: number): string {
  const metres = m < 500 ? spokenMetres(m) : m < 1000 ? Math.round(m / 100) * 100 : Math.round(m / 500) * 500
  if (metres < 1000) return `${metres} metres`
  const km = metres / 1000
  return `${km} ${km === 1 ? 'kilometre' : 'kilometres'}`
}

/**
 * The words for a cue. When the street the turn leads into is known it comes last, "turn left onto Oak Road", said the way
 * a street is said (see `spokenStreet`). With no street, or an empty one, the turn is said on its own and never "onto" nothing.
 * Every cue but the last begins with how far it is, "In 1 kilometre,", "In 500 metres,", "In 200 metres,".
 */
export function turnSpeech(turn: Pick<Turn, 'angle'> & { street?: string | null }, ahead: number, cue: TurnCue): string {
  const { spoken } = turnWords(turn.angle)
  const street = spokenStreet(turn.street ?? '')
  const words = street ? `${spoken} onto ${street}` : spoken
  if (cue === 'near') return `${words[0].toUpperCase()}${words.slice(1)}.`
  return `In ${spokenDistance(ahead)}, ${words}.`
}

/**
 * The arrow for a turn, drawn on a 48 by 48 grid: a shaft coming up from the bottom, bending where the
 * route turns and ending in a head that points the way it goes. The bend is the real angle, so a
 * gentle bear looks gentle and a sharp turn looks sharp. A U-turn is drawn as a U turning to the right;
 * for one to the left, flip it.
 */
export function arrowShape(angle: number): { shaft: string; head: string } {
  const f = (n: number) => Math.round(n * 10) / 10
  if (turnKind(angle) === 'uturn') {
    return { shaft: 'M18 44V20A6 6 0 0 1 30 20V32', head: '21,32 39,32 30,43' }
  }
  const a = (angle * Math.PI) / 180
  // The way the exit leg goes (up is straight on, y grows downwards), and across it.
  const dx = Math.sin(a)
  const dy = -Math.cos(a)
  const acrossX = -dy
  const acrossY = dx
  const bendY = 26
  const endX = 24 + 14 * dx
  const endY = bendY + 14 * dy
  const corners = [
    [endX + 9 * acrossX, endY + 9 * acrossY],
    [endX - 9 * acrossX, endY - 9 * acrossY],
    [endX + 8 * dx, endY + 8 * dy],
  ]
  return {
    shaft: `M24 44V${bendY}L${f(endX)} ${f(endY)}`,
    head: corners.map(([x, y]) => `${f(x)},${f(y)}`).join(' '),
  }
}
