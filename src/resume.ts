import { handledUpTo, type Occurrence } from './geo'
import type { RoundState, StopType } from './types'

/** A stop this much before the place carried on from, in metres, still counts as ahead: it can be right at the driver's wheels. */
export const RESUME_SLACK_M = 15

/**
 * The stops to count as done when a round carries on from `m` metres along the route: every pass that ends before
 * a little short of `m`. It is the whole set, not an addition to what is done now, so carrying on from further back
 * makes the stops after that live again. A street driven twice is judged a pass at a time: carrying on in the
 * second pass marks the first (`id`) and leaves the second (`id#2`).
 */
export function handledForResume(occs: readonly Occurrence[], m: number, slack = RESUME_SLACK_M): string[] {
  return occs.filter((o) => o.at < m - slack).map((o) => o.key)
}

/**
 * How far before a place a stop is still ahead of the driver, for the alert distances in use: no more than RESUME_SLACK_M, and no
 * more than the smallest alert zone, since a stop in the zone behind the wheels alerts, and one beyond it never does, so it would
 * be neither done nor alerting if it were counted ahead.
 */
export const slackFor = (radius: Record<StopType, number>): number => Math.min(RESUME_SLACK_M, ...Object.values(radius))

/** A distance kept from storage, or 0 for anything that isn't one. (A negative one is out-ranked by 0 where it is used.) */
const metres = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)

/**
 * How far along the route a round that is carried on picks up: from where it was started or last skipped to, from the
 * furthest it got, or from the last stop done, whichever is furthest.
 *
 * A bundle stop that was dropped says nothing of where the driver is. It can be marked dropped from the list while it is
 * a long way ahead, and a drop on one pass of a street driven twice marks the other passes done too, so neither the stop dropped
 * nor any other pass of it counts as the last stop done. (The furthest got is kept with the round every hundred metres, and that
 * already covers a bundle dropped at the spot.)
 */
export function continueFrom(round: RoundState, allOccs: readonly Occurrence[], handled: ReadonlySet<string>): number {
  const dropped = new Set(round.dropped ?? [])
  const droppedStops = new Set(allOccs.filter((o) => dropped.has(o.key)).map((o) => o.stop.id))
  const evidence = allOccs.filter((o) => !droppedStops.has(o.stop.id))
  return Math.max(metres(round.startM), metres(round.furthest), handledUpTo(evidence, handled))
}

/** How many stops not yet done would count as done by carrying on from `m` metres along the route: what skipping ahead to it gives up. */
export function skippedBy(occs: readonly Occurrence[], handled: ReadonlySet<string>, m: number, slack = RESUME_SLACK_M): number {
  return occs.filter((o) => o.at < m - slack && !handled.has(o.key)).length
}
