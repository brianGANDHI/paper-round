import { alertSide, approachSide, houseRow, isGoneBy, planSpeech, voiceable } from './alerts'
import { byPosition, sideAt, type Occurrence } from './geo'
import type { Progress } from './progress'
import type { Pt, Route, Stop } from './types'

/**
 * What the voice says about the alerts that are up, worked out on every fix and kept apart from the round screen so it can be tested.
 * The beep and the banner come up as soon as the driver is near a stop, as the safety warning; the words wait until they are right. A
 * no-throw house is named only once the side thrown where the driver is includes the side the house is on (see `voiceable`), so the
 * houses of the stretch after a change of side are not read out while the pill still says the other side, and are read out as the driver
 * crosses the change. A house passed before the change is dropped without being said.
 */

/** Where the driver is. */
export interface VoiceDriver {
  /** The segment of the route the driver is on (`Progress.idx`): the side thrown there is the side thrown now. */
  idx: number
  /** How far along the route the driver is, and the furthest they have got, in metres (`Progress.along` and `Progress.furthest`). */
  along: number
  driven: number
  /** Where the phone is (`Progress.at`), or null when it is not known. */
  pos: Pt | null
  /** The way the phone is heading, when it is known: it tells which side an apartment block off the route is on. */
  heading?: number | null
}

export interface VoiceInput {
  route: Pick<Route, 'points' | 'sideChanges'>
  /** Every time the route passes a stop, and those of them that alert (`occurrences` and `alertable`), in route order. */
  allOccs: Occurrence[]
  occs: Occurrence[]
  /** The keys of the stops done. */
  handled: ReadonlySet<string>
  radius: Record<Stop['type'], number>
  /** The alerts up or waiting, as the screen's queue has them (those just come up may be in it already or not). */
  queue: readonly Occurrence[]
  /** The alerts that have just come up on this fix. */
  fresh: readonly Occurrence[]
  /** The keys already said, and the keys that came up and were kept back (`VoicePlan.held` of the last fix). */
  announced: ReadonlySet<string>
  held: ReadonlySet<string>
  driver: VoiceDriver
}

export interface VoicePlan {
  /** What to say now: empty for nothing. */
  text: string
  /** The keys it covers, to add to the ones already said. */
  announce: string[]
  /** The keys of the alerts that are up but kept back until the driver is on the side they are on: hand them back as `held` on the next fix. */
  held: string[]
  /**
   * Whether the words name a no-throw house (a row of them): they warn of a wrong throw, so they are said as a warning (see
   * `SayOptions.warning`), before the other alerts' words, and with the side word in the order the two are asked for.
   */
  noThrow: boolean
}

/**
 * What to say now for the alerts that have just come up and those kept back, and what to keep back. A no-throw house kept back is
 * said on the first fix where the side thrown at the driver's place includes its side, as the row it is in, and is dropped when the
 * driver has gone by it first. A stop that is not a no-throw house is always said, once. Nothing already said is said again, and a
 * row said with "and N more" is not said again for the houses that were left out.
 */
export function planVoice(input: VoiceInput): VoicePlan {
  const { route, allOccs, occs, handled, radius, announced, held, driver } = input
  const thrownNow = sideAt(route, driver.idx)
  const comeUp = new Set(input.fresh.map((o) => o.key))
  const seen = new Set<string>()
  const due: Occurrence[] = []
  for (const o of [...input.queue, ...input.fresh]) {
    if (seen.has(o.key)) continue
    seen.add(o.key)
    if (announced.has(o.key) || !(comeUp.has(o.key) || held.has(o.key))) continue
    if (isGoneBy(o, driver.driven, driver.along, driver.pos, radius)) continue
    due.push(o)
  }
  const now = due.filter((o) => voiceable(route, allOccs, o, thrownNow, radius))
  const later = due.filter((o) => !now.includes(o))

  const rowOf = (first: Occurrence) => houseRow(route, allOccs, occs, handled, first, radius).filter((o) => voiceable(route, allOccs, o, thrownNow, radius))
  // The side of an apartment block is as the route passes it, or for one off the route as the driver comes up to it.
  const sideOf = (o: Occurrence) => (byPosition(o, radius) ? approachSide(driver.heading ?? null, driver.pos, o.stop) : alertSide(route, allOccs, o))
  const plan = planSpeech(now, rowOf, announced, sideOf)
  return {
    text: plan.text,
    // Every other stop is said on its own, once.
    announce: [...plan.announce, ...now.filter((o) => o.stop.type !== 'nothrow').map((o) => o.key)],
    held: later.map((o) => o.key),
    // The plan's own keys are those of the no-throw rows it says, and it says one for each row it names.
    noThrow: plan.announce.length > 0,
  }
}

/** Where the driver is when an alert's words come to be said: the tracker's place, or null when there is none yet. */
export type DriverNow = Pick<Progress, 'along' | 'furthest' | 'at' | 'turned'>

/**
 * The check that an alert's words are out of date by the time their turn comes (`SayOptions.stale`): true once the driver has gone by
 * every stop they name (`keys`, the plan's `announce`, found in `occs`), by the rule by which `planVoice` names no stop gone by (see
 * `isGoneBy`). An alert's words are said in full, and the next alert's wait for them (see `SayOptions.whole`); those cut off by a warning
 * or a side word are said again after it (after a side word, even if out of date by then, for a moment: see `CUT_GRACE_MS`). So where
 * alerts come up faster than they can be said the words fall behind the car: this
 * leaves out those whose turn comes only once the car is past all they are about, so the voice never names a house passed some way back,
 * and the words for the stops still ahead are not held up behind them. While a turn round is not sure (see `Progress.turned`) the driver is judged where the turn put them from, as the alerts that are up
 * are: the turn may be undone, and the stops are then still to come. A stop met by where the phone is (see `byPosition`) is never gone by
 * in this sense, so its words are always said. `now` is asked each time, for where the driver is then.
 */
export function alertWordsStale(
  keys: readonly string[],
  occs: readonly Occurrence[],
  now: () => DriverNow | null,
  radius: Record<Stop['type'], number>,
): () => boolean {
  const named = new Set(keys)
  const stops = occs.filter((o) => named.has(o.key))
  return () => {
    const p = now()
    if (!p || !stops.length) return false
    const along = p.turned ? p.turned.from : p.along
    return stops.every((o) => isGoneBy(o, p.furthest, along, p.at, radius))
  }
}
