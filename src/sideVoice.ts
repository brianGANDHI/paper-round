import { sideAt } from './geo'
import { ALERT_SECONDS } from './sound'
import type { Route, Side } from './types'

/**
 * Saying the side being thrown out loud, each time it changes, so the driver need not look at the pill to know: "Port", "Starboard",
 * "Both", and "Transit" when throwing stops. Everything here is pure; the round screen holds the state (see `createSideCue`) and does the
 * speaking (see `say` in speech.ts, as a queued word: it breaks in on another alert's words being said, which are said again after it,
 * and a no-throw house's words and it are said in the order asked, neither cutting the other off).
 */

/** The words for each side: exactly these four, and only the word, so the change is heard at a glance. */
export const SIDE_WORDS: Record<Side, string> = { left: 'Port', right: 'Starboard', both: 'Both', transit: 'Transit' }

/** What is said for a side. */
export const sideWords = (side: Side): string => SIDE_WORDS[side]

/**
 * How far ahead of the driver, in metres, the side is looked at to be said: the change is said a little before it, so that the word is
 * done as the side changes and not after. This is for a driver whose speed is not known (see `sideLookAheadM`).
 */
export const SIDE_LOOKAHEAD_M = 15
/** The least and the most the look-ahead is, in metres, whatever the speed: a crawl still wants a little warning and a motorway no more than a few seconds. */
export const SIDE_LOOKAHEAD_MIN_M = 8
export const SIDE_LOOKAHEAD_MAX_M = 30
/**
 * How long a word takes to say, in seconds, with the wait before it and the quiet lead-in said after a silence (see `LEAD_IN` in speech.ts),
 * which a side word usually has, as the changes of side are far enough apart.
 */
const SAY_SECONDS = 1.6
/**
 * The longest an alert's beep lasts, in seconds (a no-throw house's three: see `ALERT_SECONDS`). A side word asked for on the fix an alert
 * comes up on waits for the beep to end, so as not to be lost under it; the look-ahead allows for that wait, or such a word would start only
 * as the side changes. Which fix that is can't be told on the fix before, so the look-ahead allows for it on every fix.
 */
export const SIDE_BEEP_SECONDS = Math.max(...Object.values(ALERT_SECONDS))

/**
 * How far ahead of the driver to look for the side to say, in metres, given their speed in metres a second (`SIDE_LOOKAHEAD_M` when it
 * is not known): the distance the car goes while the word may wait for an alert's beep, starts and is said (`SIDE_BEEP_SECONDS` and
 * `SAY_SECONDS`), kept between `SIDE_LOOKAHEAD_MIN_M` and `SIDE_LOOKAHEAD_MAX_M`.
 */
export function sideLookAheadM(speed: number | null | undefined): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0) return SIDE_LOOKAHEAD_M
  return Math.min(SIDE_LOOKAHEAD_MAX_M, Math.max(SIDE_LOOKAHEAD_MIN_M, Math.round(speed * (SAY_SECONDS + SIDE_BEEP_SECONDS))))
}

/**
 * The side thrown `along` metres along the route: the side of the segment that distance is on. `cum` is how far along the route each of its
 * points is (see `cumulativeDistances`). A distance before the start is the first segment's, and one past the end the last's.
 */
export function sideAtAlong(route: Pick<Route, 'sideChanges'>, cum: readonly number[], along: number): Side {
  let idx = 0
  while (idx < cum.length - 2 && cum[idx + 1] <= along) idx++
  return sideAt(route, idx)
}

/**
 * A different side asked for within this many metres of where the last was said is the position wobbling across the change, not a new
 * change, so it is not said: the driver would hear "Starboard, Port, Starboard" at one spot.
 */
export const SIDE_SETTLE_M = 6

/** What the cue has said: the side said last (null before anything is, and after a reset), and how far along the route the driver was then. */
export interface SideCueState {
  last: Side | null
  at: number | null
}

/** Nothing said yet: the next side asked about is said, whatever it is. */
export const NO_SIDE_CUE: SideCueState = { last: null, at: null }

/**
 * The next step of the cue. `here` is the side at the driver's place and `ahead` the side a few metres further on (`sideLookAheadM`);
 * `along` is how far along the route the driver is, when it is known. The first time, the side at the driver's place is said, as a round
 * has just started or been skipped to a spot. After that the side ahead is said when it is not the one said last, so each change is said
 * once, as the driver comes to it, and the same side is never said twice running. Returns what to say (null for nothing) and the state to
 * hand back next time.
 */
export function stepSideCue(state: SideCueState, here: Side, ahead: Side, along?: number): { state: SideCueState; say: Side | null } {
  const want = state.last === null ? here : ahead
  if (want === state.last) return { state, say: null }
  const wobble = state.last !== null && state.at !== null && along !== undefined && Math.abs(along - state.at) < SIDE_SETTLE_M
  if (wobble) return { state, say: null }
  return { state: { last: want, at: along ?? null }, say: want }
}

/** The cue the round screen keeps for a round: see `stepSideCue`. */
export interface SideCue {
  /** Give it the side at the driver's place and a few metres ahead (and how far along the route they are): the side to say now, or null. */
  update(here: Side, ahead: Side, along?: number): Side | null
  /** Forget what was said, so the next update says the side it is given: for a round started or skipped to a spot, and the voice switched on. */
  reset(): void
  /** The side said last, or null when none has been since the start or a reset. */
  last(): Side | null
}

export function createSideCue(): SideCue {
  let state = NO_SIDE_CUE
  return {
    update(here, ahead, along) {
      const step = stepSideCue(state, here, ahead, along)
      state = step.state
      return step.say
    },
    reset() {
      state = NO_SIDE_CUE
    },
    last: () => state.last,
  }
}

/** The sides the Test Voice button says, in turn: the ones that say where to throw. */
const TEST_SIDES: readonly Side[] = ['left', 'right', 'both']

/**
 * How long after one word of the test the next is asked for, in milliseconds. A word takes a second or two to say, with what goes before
 * it, which leaves about 3 seconds of silence: over `COLD_MS` (see speech.ts), so each word is a single word after a silence, as on the road,
 * and a shorter wait would test only the first of them.
 */
export const VOICE_TEST_GAP_MS = 4000

/**
 * Says the side words one at a time with a silence between them, for the Test Voice button, as each would come on the road. The first is
 * asked for at once and the rest a gap apart. `say` is what says one word. Returns what to call to leave out those not yet asked for.
 */
export function testVoice(say: (word: string) => void): () => void {
  const timers = TEST_SIDES.slice(1).map((side, i) => setTimeout(() => say(sideWords(side)), (i + 1) * VOICE_TEST_GAP_MS))
  say(sideWords(TEST_SIDES[0]))
  return () => timers.forEach((t) => clearTimeout(t))
}
