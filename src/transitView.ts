import { distanceText, straightText, transitGuidance, type Straight, type TransitGuidance } from './guidance'
import { shortest } from './mapHeading'
import { turnCue, turnSpeech, turnWords, upcomingTurn, type Turn, type TurnCue } from './turns'

/**
 * What the round screen does with the guidance for a driver on a stretch of transit (see guidance.ts), kept apart from the
 * screen so it can be tested: which card to show, what the voice says about it, the words on the straight card, and how the
 * heading badge turns. Everything here is pure.
 */

/** Where in the saved turns a turn is kept, by how far along the route it is to the nearest metre, so that an edit that moves it a fraction doesn't make it new. */
export const turnKey = (at: number): number => Math.round(at)

/** What decides the card. */
export interface GuidanceContext {
  /** The phone is on the route with a fix good enough to say how far along it is, and the Off the route banner is not up. With nothing of that there is no guidance. */
  onTrack: boolean
  /** The side at the driver's place on the route is Transit. */
  transit: boolean
  /** How far along the route the driver is, and how long the route is, in metres. */
  along: number
  routeEnd: number
  /** The way the phone is heading, or null when it can't say. */
  heading: number | null
  /** Turns at or before this many metres along the route are behind the driver for good. */
  after: number
}

/**
 * The card for the driver: nothing while they are not on the route. On a stretch of transit it is always something (the next turn
 * however far off, or a straight that leads to it, or to the end of the route); anywhere else it is the next turn once it is within
 * 200 m, as it always was. The turns may be named turns: the one given back is the same object.
 */
export function guidanceToShow<T extends Turn>(turns: readonly T[], c: GuidanceContext): TransitGuidance<T> | null {
  if (!c.onTrack) return null
  const options = { heading: c.heading, after: c.after }
  if (c.transit) return transitGuidance(turns, c.along, c.routeEnd, options)
  const next = upcomingTurn(turns, c.along, options)
  return next ? { kind: 'turn', turn: next.turn, ahead: next.ahead } : null
}

/** What the voice is to say about a turn, and the cue it is. */
export interface SpokenTurn {
  cue: TurnCue
  text: string
}

/**
 * What to say now about a turn that is `ahead` metres off, if anything, given what has been said about it (`said`). `long` is for a
 * driver on a stretch of transit, who is also told at about a kilometre and at 500 m; anywhere else it is 200 m, then 60 m, as it was.
 * Only the one cue for where the turn is now comes back, so a turn first met part way in, such as when transit begins or after a skip,
 * is not told of with every cue it missed.
 */
export function cueToSay(turn: Pick<Turn, 'angle'> & { street?: string | null }, ahead: number, said: TurnCue | null, long: boolean): SpokenTurn | null {
  const cue = turnCue(ahead, said, long)
  return cue ? { cue, text: turnSpeech(turn, ahead, cue) } : null
}

/** A straight on the card, split for its three lines. */
export interface StraightCard {
  /** The small line over the distance: "Continue", or "Route ends in". */
  lead: string
  /** The big line: "3.2 km", or "Here" when the route ends right here. Empty when the words could not be split (then `lead` is the whole line). */
  value: string
  /** What the straight leads to, under the distance: the street the turn leads into, or what the turn is when there is no street. Null when it leads to the end of the route. */
  thenText: string | null
  /** The whole card in one sentence, for a screen reader: "Continue 3.2 km, then turn left onto Oak Road". */
  label: string
}

/**
 * The words for the straight card. They come from `straightText` (guidance.ts), so the card says what the rest of the app does, only
 * with the distance split off to be the big line, since it is the part to read at a glance. `street` is the street the turn leads into
 * as the card writes it, when that is known.
 */
export function straightCard(straight: Pick<Straight, 'ahead' | 'then'>, street?: string | null): StraightCard {
  const { title, then } = straightText(straight, street)
  const here = !straight.then && straight.ahead < 15
  const value = here ? 'Here' : distanceText(straight.ahead)
  const split = title.toLowerCase().endsWith(value.toLowerCase())
  const name = street?.trim()
  return {
    lead: split ? title.slice(0, title.length - value.length).trim() : title,
    value: split ? value : '',
    thenText: straight.then ? name || turnWords(straight.then.angle).label : null,
    label: then ? `${title}, ${then[0].toLowerCase()}${then.slice(1)}` : title,
  }
}

/** A heading closer than this, in degrees, to the one being shown is the same one: it doesn't set the badge turning. */
const HEADING_STEP_DEG = 0.05

/**
 * The angle the heading badge is turned to for a new heading, given the angle it is turned to now. Both are unwrapped (they can pass
 * 360 or go below 0), so that going from 350 degrees to 10 turns it 20 degrees on, not 340 back, which is what a transition from
 * one number to the other would do. A heading that is the same one, or not a number, leaves it where it is.
 */
export function turnTo(shown: number, heading: number): number {
  if (!Number.isFinite(heading)) return shown
  if (!Number.isFinite(shown)) return heading
  const by = shortest(shown, heading)
  return Math.abs(by) < HEADING_STEP_DEG ? shown : shown + by
}
