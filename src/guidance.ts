import { TURN_SHOW_M, turnWords, upcomingTurn, type Turn, type UpcomingOptions, type UpcomingTurn } from './turns'

/**
 * Guidance for the driver on a stretch of transit, where they only drive (between delivery areas, say) and the next turn
 * can be many kilometres off. Off transit the turn card is only up for the next 200 m, which is right for streets full of
 * turns and houses. On a long drive that leaves the driver with nothing to go by, so here the way ahead is always said:
 * the next turn when it is near, and how far to carry on to it when it isn't. All of it is pure and takes the driver's
 * place along the route, so it is told the same way as the turn card (see `upcomingTurn` in turns.ts).
 */

/** The eight points of the compass, from north round by the right, as written on the heading badge... */
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const
/** ...and as they are said or read out. */
const POINT_NAMES = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const

/** The point of the compass a heading is nearest to, as an index into the lists above: each point covers 45 degrees, centred on itself. */
function pointIndex(deg: number): number {
  return Math.round((((deg % 360) + 360) % 360) / 45) % 8
}

/**
 * The 8-point compass abbreviation for a heading in degrees clockwise from north: "N", "NE", "E", "SE", "S", "SW", "W" or "NW".
 * Any number of degrees will do (-90 is "W", 450 is "E"). An empty string for a heading that isn't a number, so the badge
 * has nothing to show until the phone knows which way it is going.
 */
export const compassLabel = (deg: number): string => (Number.isFinite(deg) ? POINTS[pointIndex(deg)] : '')

/** The same point in words, for a screen reader: "north-east". Empty for a heading that isn't a number. */
export const compassName = (deg: number): string => (Number.isFinite(deg) ? POINT_NAMES[pointIndex(deg)] : '')

/** The driver has a turn to make soon: show it as a turn, the same as off transit. */
export interface TurnAhead<T extends Turn = Turn> extends UpcomingTurn<T> {
  kind: 'turn'
}

/** No turn for a while: carry on. `ahead` is how far to the next turn, or to the end of the route when `then` is null. */
export interface Straight<T extends Turn = Turn> {
  kind: 'straight'
  /** Metres to carry on for: to the turn in `then`, or to the end of the route when there is none. Never negative. */
  ahead: number
  /** The turn after the straight, or null when the route runs out first. */
  then: T | null
}

export type TransitGuidance<T extends Turn = Turn> = TurnAhead<T> | Straight<T>

/**
 * How far, in degrees, the phone's heading may be from the way the route comes up to a turn, on a stretch of transit, for a turn
 * the card would not show to be the next. It is wide, so that only a turn that comes up the other way (a street driven twice) is set
 * aside: far off, the road can bend a long way before the turn, and the heading can be well off for a while on a roundabout, a slip
 * road or just after joining from a side road. A turn near enough to show keeps to `TURN_HEADING_TOLERANCE`, as anywhere on the route.
 */
export const TRANSIT_HEADING_TOLERANCE = 120

/**
 * What to tell a driver on a stretch of transit, at `along` metres along a route that is `routeEnd` metres long. The next turn
 * is looked for however far off. A turn within `TURN_SHOW_M` is shown as a turn, as it would be anywhere on the route. A turn further off
 * is `then` after a straight of `ahead` metres, to carry on. With no turn left at all the straight runs to the end of the route.
 * The turns may be named turns: the one given back is the same object.
 *
 * The heading and `after` count as in `upcomingTurn`: a turn for the other way along a street driven twice, or one already passed,
 * is not the next. The turn the plain card would show (within `TURN_SHOW_M`, and the heading within 60 degrees of the way it comes up)
 * is the one shown. Otherwise the next turn is the first the heading is within `TRANSIT_HEADING_TOLERANCE` of, so that a turn is not
 * lost because the road bends on the way to it, and a turn close by that the heading is only part against is not set aside for one
 * further on. And the route is never said to end while a turn is left, whatever the heading: with none the heading agrees with, the next
 * turn by its place along the route is the one.
 */
export function transitGuidance<T extends Turn>(
  turns: readonly T[],
  along: number,
  routeEnd: number,
  options: Omit<UpcomingOptions, 'range' | 'tolerance'> = {},
): TransitGuidance<T> {
  const anywhere: UpcomingOptions = { ...options, range: Infinity }
  const next =
    upcomingTurn(turns, along, options) ??
    upcomingTurn(turns, along, { ...anywhere, tolerance: TRANSIT_HEADING_TOLERANCE }) ??
    upcomingTurn(turns, along, { ...anywhere, heading: null })
  if (!next) return { kind: 'straight', ahead: Math.max(0, routeEnd - along), then: null }
  if (next.ahead <= TURN_SHOW_M) return { kind: 'turn', turn: next.turn, ahead: next.ahead }
  return { kind: 'straight', ahead: next.ahead, then: next.turn }
}

/**
 * The turn the voice is to speak of, however it is shown: the turn itself, or the turn the straight is going to. Null when
 * the straight runs to the end of the route and there is none. Give its distance to `turnCue(..., true)` and `turnSpeech`.
 */
export function guidedTurn<T extends Turn>(guidance: TransitGuidance<T>): UpcomingTurn<T> | null {
  if (guidance.kind === 'turn') return { turn: guidance.turn, ahead: guidance.ahead }
  return guidance.then ? { turn: guidance.then, ahead: guidance.ahead } : null
}

/**
 * A long distance for the card: to the nearest 10 m under 100 m, 50 m under a kilometre, then kilometres to a tenth under
 * ten ("3.2 km", "1 km", never "1.0 km"), and to the whole kilometre beyond that. A distance that rounds up to 1000 m is "1 km".
 */
export function distanceText(metres: number): string {
  const m = Number.isFinite(metres) ? Math.max(0, metres) : 0
  const rounded = m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50
  if (rounded < 1000) return `${rounded} m`
  const km = m / 1000
  return `${km < 10 ? Math.round(km * 10) / 10 : Math.round(km)} km`
}

/** "Continue 3.2 km": the card's line for a straight that ends at a turn. */
export const continueText = (ahead: number): string => `Continue ${distanceText(ahead)}`

/** "Route ends in 800 m": the card's line for a straight that ends where the route does, or "Route ends here" when that is right here. */
export const routeEndsText = (ahead: number): string => (ahead < 15 ? 'Route ends here' : `Route ends in ${distanceText(ahead)}`)

/** What the card says for a straight: the line to carry on, and what comes after it. */
export interface StraightText {
  /** "Continue 3.2 km", or "Route ends in 800 m" when there is no turn left. */
  title: string
  /** What the straight leads to, as a line under the title: "Then turn left onto Oak Road", or null when it leads to the end of the route. */
  then: string | null
}

/**
 * The words for a straight on the card. `street` is the street the turn leads into as the card writes it, when that is known;
 * a turn with none is just "Then turn left", never "onto" nothing.
 */
export function straightText(straight: Pick<Straight, 'ahead' | 'then'>, street?: string | null): StraightText {
  const { then } = straight
  if (!then) return { title: routeEndsText(straight.ahead), then: null }
  const name = street?.trim()
  return { title: continueText(straight.ahead), then: `Then ${turnWords(then.angle).spoken}${name ? ` onto ${name}` : ''}` }
}
