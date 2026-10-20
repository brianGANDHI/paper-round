import { angleBetween, bearing, cumulativeDistances } from './geo'
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
/** A change of heading smaller than this, in degrees, isn't a turn. */
export const MIN_TURN_DEG = 40

/** How far ahead a turn is shown (and its first cue given), in metres. */
export const TURN_SHOW_M = 200
/** Inside this the turn is close enough for the last cue, in metres. */
export const TURN_NEAR_M = 60
/** A turn stays up until the driver is this far past it, in metres, so a fix a little behind doesn't drop it at once. */
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
 */
export function routeTurns(points: Pt[]): Turn[] {
  if (points.length < 3) return []
  const cum = cumulativeDistances(points)
  const pieces = Math.floor(cum[cum.length - 1] / STEP_M)
  if (pieces < 2) return []
  const heading: number[] = []
  for (let j = 0; j < pieces; j++) heading.push(bearing(pointAt(points, cum, j * STEP_M), pointAt(points, cum, (j + 1) * STEP_M)))

  // Joint j is where piece j meets piece j + 1, (j + 1) * STEP_M metres along.
  const swings: { first: number; last: number; sum: number }[] = []
  for (let j = 0; j + 1 < pieces; j++) {
    const bend = wrap(heading[j + 1] - heading[j])
    if (Math.abs(bend) < BEND_DEG) continue
    const swing = swings[swings.length - 1]
    if (swing && j - swing.last <= GAP_JOINTS + 1) {
      swing.last = j
      swing.sum += bend
    } else {
      swings.push({ first: j, last: j, sum: bend })
    }
  }
  return swings
    .map((s) => ({
      at: ((s.first + s.last + 2) / 2) * STEP_M,
      from: (s.first + 1) * STEP_M,
      to: (s.last + 1) * STEP_M,
      angle: wrap(s.sum),
      heading: heading[s.first],
    }))
    .filter((t) => Math.abs(t.angle) >= MIN_TURN_DEG)
}

export interface UpcomingTurn {
  turn: Turn
  /** Metres from the driver to the turn: negative once the driver is past it. */
  ahead: number
}

/** A turn only counts as coming up when the driver is heading roughly the way the route does as it reaches it, in degrees. */
export const TURN_HEADING_TOLERANCE = 60

export interface UpcomingOptions {
  /** The way the phone is heading, in degrees clockwise from north, or null when it can't say. */
  heading?: number | null
  /** Turns at or before this many metres along the route are behind the driver for good, however the position wanders. */
  after?: number
}

/**
 * The turn to show the driver at `along` metres along the route: the next one not yet passed, once it is near enough.
 * A street driven twice has turns on each pass at the same place, one for each way along it, so a turn that comes up
 * the other way to the way the phone is heading is not the one being driven to, and one already passed does not return.
 */
export function upcomingTurn(turns: Turn[], along: number, options: UpcomingOptions = {}): UpcomingTurn | null {
  const { heading = null, after = -Infinity } = options
  const turn = turns.find(
    (t) => t.at - along >= -TURN_PASSED_M && t.at > after && (heading === null || angleBetween(t.heading, heading) <= TURN_HEADING_TOLERANCE),
  )
  if (!turn) return null
  const ahead = turn.at - along
  return ahead <= TURN_SHOW_M ? { turn, ahead } : null
}

/** How sharp a turn is, going by how far it turns the heading. */
export function turnKind(angle: number): TurnKind {
  const a = Math.abs(angle)
  if (a >= 165) return 'uturn'
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

/** What has been said about a turn: the warning when it came into view, or the last word as the driver reached it. */
export type TurnCue = 'far' | 'near'

/**
 * What to say now about a turn, if anything. `said` is what has been said about it already. Each is said once:
 * the warning when it comes into view, then the last word when it is near. A turn first seen already near has
 * no warning, only the last word.
 */
export function turnCue(ahead: number, said: TurnCue | null): TurnCue | null {
  if (ahead > TURN_SHOW_M) return null
  if (ahead <= TURN_NEAR_M) return said === 'near' ? null : 'near'
  return said ? null : 'far'
}

/** A distance as it is said: to the nearest 10 m under 100 m, to the nearest 50 m above. */
export const spokenMetres = (m: number): number => (m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50)

/**
 * The words for a cue. When the street the turn leads into is known it comes last, "turn left onto Oak Road", said the way
 * a street is said (see `spokenStreet`). With no street, or an empty one, the turn is said on its own and never "onto" nothing.
 */
export function turnSpeech(turn: Pick<Turn, 'angle'> & { street?: string | null }, ahead: number, cue: TurnCue): string {
  const { spoken } = turnWords(turn.angle)
  const street = spokenStreet(turn.street ?? '')
  const words = street ? `${spoken} onto ${street}` : spoken
  if (cue === 'near') return `${words[0].toUpperCase()}${words.slice(1)}.`
  return `In ${spokenMetres(ahead)} metres, ${words}.`
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
