import { plural } from './format'
import type { Occurrence } from './geo'
import { formatDistance } from './routeEdit'
import { spokenDistance } from './turns'
import type { RoundState } from './types'

/*
 * Bundle drops in a round. A bundle drop is somewhere papers are left in a bundle by hand, so unlike a house on the round it
 * is not enough to drive past it: the driver confirms it with "Dropped", and the app keeps what became of each one.
 *
 * What became of a bundle is told by three lists kept with the round (see `RoundState`), all by the keys of an occurrence (the
 * stop's id for the first time the route goes by it, then `id#2` and so on, so a street driven twice has a bundle for each pass):
 *   - done (`handledStopIds`): the alert is over, however it came to be.
 *   - dropped: done, and the driver tapped "Dropped" (or marked it so in the list).
 *   - missed: done, but the driver drove past in its zone without tapping. It can still be marked dropped later.
 * A bundle that is done and in neither list was skipped over: a skip to a spot or section, a restart, and the catch-up after one
 * all mark what they go over as done without it having been dropped or missed. A bundle not done is still to come.
 * The invariant is that dropped and missed are subsets of done and share nothing. `reconcile` restores it; every function here that
 * changes a round keeps it.
 *
 * A bundle stop on a street the route goes by twice is ONE delivery, whichever pass it is made on. Dropping one pass settles every
 * other pass of the stop (see `markDropped`): one not done yet becomes done without ever alerting, and one that was missed is not missed
 * any more, and the list shows each as covered by the drop. The papers of a stop are counted once (see `bundleTotals`), and a stop
 * counts as missed only when no pass of it is left to come and none was dropped. Taking the drop back puts every pass as it was.
 */

/** What became of a bundle, or where it is: dropped, missed, skipped over, the one coming next, or one that comes after that. */
export type BundleStatus = 'dropped' | 'missed' | 'skipped' | 'next' | 'later'

/** The words for each status, as the list shows them. */
export const BUNDLE_STATUS_LABEL: Record<BundleStatus, string> = {
  dropped: 'Dropped',
  missed: 'Missed',
  skipped: 'Skipped',
  next: 'Next',
  later: 'Later',
}

/** What the name of a bundle is when it has neither a name nor an address. */
export const UNNAMED_BUNDLE = 'Bundle drop'

/**
 * A bundle this far past the driver, in metres, is behind them and is not the next one: the same distance at which the alert
 * for a stop on the route moves on to the one after it. Short of it the driver is still at the bundle.
 */
export const BUNDLE_BEHIND_M = 10

/** A bundle drop as the list shows it: one for every time the route goes by a bundle stop, in route order. */
export interface BundleItem {
  /** The occurrence's key, as kept in the round. */
  key: string
  stopId: string
  /** What the place is called: the stop's name, or else its address, or else `UNNAMED_BUNDLE`. */
  name: string
  /** The address to show under the name, when the stop has a name and an address too. */
  address: string | null
  /** How many papers, or null when no amount was set. */
  papers: number | null
  /** How far along the route it is, in metres. A bundle off the route is where the route comes nearest to it. */
  at: number
  /** How far ahead of the driver it is, in metres along the route, negative once it is behind them. */
  ahead: number
  /** Which time the route goes by the stop this is, 1 for the first. */
  pass: number
  /** How many times the route goes by the stop. */
  passes: number
  /** Whether it is behind the driver by more than `BUNDLE_BEHIND_M`. */
  behind: boolean
  /**
   * Which pass of the stop was dropped, when this pass is covered by it: the stop is one delivery, so a drop on one pass settles the
   * others. Null for a pass that is not covered (the one dropped included). A covered pass has the status 'skipped', and is never the
   * next bundle, a miss or one to mark dropped.
   */
  coveredBy: number | null
  status: BundleStatus
}

/** The key of an occurrence's pass: 1 for the stop's own id, then the number after the `#`. */
function passOf(o: Occurrence): number {
  if (o.key === o.stop.id) return 1
  const n = Number(o.key.slice(o.stop.id.length + 1))
  return Number.isInteger(n) && n >= 1 ? n : 1
}

const trimmed = (text: string | undefined): string | null => text?.trim() || null

/**
 * Every bundle drop on the route in the order the route reaches them, with what became of it or where it is.
 * `occs` are the route's occurrences (only the bundle drops among them are listed), `round` the round's progress and `along` how
 * far along the route the driver is, in metres (0 before the round begins).
 *
 * The status is told by the round: done and dropped is 'dropped', done and missed is 'missed', any other done one is 'skipped'.
 * A pass of a stop that has another pass dropped is covered by that drop (`coveredBy` says which pass) and is 'skipped' whatever the round
 * says of it, so it is never the next bundle, nor a miss, and a round that was kept before the drop settled it still reads right.
 * Of those not done, the first that is not behind the driver (see `behindM`) is 'next', and the rest are 'later'. One not done that
 * is behind the driver, which is rare (a stretch of the round with no fix, say), is 'later' too, with `behind` set, so the list can
 * say it was passed and still offer to mark it dropped. A key in `dropped` or `missed` that is not done is ignored: see `reconcile`.
 */
export function bundleList(
  occs: readonly Occurrence[],
  round: Pick<RoundState, 'handledStopIds' | 'dropped' | 'missed'>,
  along: number,
  behindM: number = BUNDLE_BEHIND_M,
): BundleItem[] {
  const done = new Set(round.handledStopIds)
  const dropped = new Set(round.dropped ?? [])
  const missed = new Set(round.missed ?? [])
  const bundles = occs.filter((o) => o.stop.type === 'bundle').sort((a, b) => a.at - b.at)
  const passes = new Map<string, number>()
  for (const o of bundles) passes.set(o.stop.id, (passes.get(o.stop.id) ?? 0) + 1)
  // The pass of each stop that was dropped (the first in route order, if more than one was), which covers the others.
  const droppedPass = new Map<string, number>()
  for (const o of bundles) if (done.has(o.key) && dropped.has(o.key) && !droppedPass.has(o.stop.id)) droppedPass.set(o.stop.id, passOf(o))
  let nextFound = false
  return bundles.map((o): BundleItem => {
    const ahead = o.at - along
    const behind = ahead < -behindM
    const isDropped = done.has(o.key) && dropped.has(o.key)
    const coveredBy = isDropped ? null : (droppedPass.get(o.stop.id) ?? null)
    let status: BundleStatus
    if (isDropped) status = 'dropped'
    else if (coveredBy !== null) status = 'skipped'
    else if (done.has(o.key)) status = missed.has(o.key) ? 'missed' : 'skipped'
    else if (!nextFound && !behind) {
      nextFound = true
      status = 'next'
    } else status = 'later'
    const label = trimmed(o.stop.label)
    const address = trimmed(o.stop.address)
    return {
      key: o.key,
      stopId: o.stop.id,
      name: label ?? address ?? UNNAMED_BUNDLE,
      address: label && address ? address : null,
      papers: o.stop.qty && o.stop.qty > 0 ? o.stop.qty : null,
      at: o.at,
      ahead,
      pass: passOf(o),
      passes: passes.get(o.stop.id) ?? 1,
      behind,
      coveredBy,
      status,
    }
  })
}

/** The bundle drop coming next, or null when there is none ahead. */
export const nextBundle = (list: readonly BundleItem[]): BundleItem | null => list.find((b) => b.status === 'next') ?? null

/** What became of a bundle stop as a whole, however many times the route goes by it: see `bundleStops`. */
export type StopStatus = 'dropped' | 'missed' | 'skipped' | 'toDrop'

/** A bundle stop as the totals count it: once, whether the route goes by it once or more. */
export interface BundleStop {
  stopId: string
  name: string
  /** How many papers it gets, once: not once for each pass. Null when no amount was set. */
  papers: number | null
  status: StopStatus
}

/**
 * The stops the bundle drops in a list are for, in the order the route first reaches them, with what became of each as one delivery:
 * 'dropped' when any pass of it was; otherwise 'toDrop' while a pass is still to come (the next or a later one, so a first pass missed
 * with a second to come is not missed yet); otherwise 'missed' when a pass was driven past without a tap; otherwise 'skipped'.
 */
export function bundleStops(list: readonly BundleItem[]): BundleStop[] {
  const byStop = new Map<string, BundleItem[]>()
  for (const b of list) {
    const passes = byStop.get(b.stopId)
    if (passes) passes.push(b)
    else byStop.set(b.stopId, [b])
  }
  return [...byStop.values()].map((passes) => {
    const has = (...statuses: BundleStatus[]) => passes.some((b) => statuses.includes(b.status))
    const status: StopStatus = has('dropped') ? 'dropped' : has('next', 'later') ? 'toDrop' : has('missed') ? 'missed' : 'skipped'
    return { stopId: passes[0].stopId, name: passes[0].name, papers: passes[0].papers, status }
  })
}

/** How many bundle stops and papers are in each state. A bundle with no amount set counts as a bundle but adds no papers. */
export interface BundleTotals {
  /** Every bundle stop on the route, counted once however many times the route goes by it. */
  total: number
  dropped: number
  missed: number
  skipped: number
  /** Still to drop: the next one and those after it. */
  toDrop: number
  droppedPapers: number
  missedPapers: number
  /** Papers in the bundles still to drop. Those missed are not counted here: they are in `missedPapers`. */
  toDropPapers: number
}

/**
 * What has been dropped, what is missed and what is still to drop, counted a stop at a time (see `bundleStops`): a stop the route goes
 * by twice is one delivery, so its papers are counted once, and dropping it on either pass drops it.
 */
export function bundleTotals(list: readonly BundleItem[]): BundleTotals {
  const stops = bundleStops(list)
  const totals: BundleTotals = { total: stops.length, dropped: 0, missed: 0, skipped: 0, toDrop: 0, droppedPapers: 0, missedPapers: 0, toDropPapers: 0 }
  for (const stop of stops) {
    const papers = stop.papers ?? 0
    if (stop.status === 'dropped') {
      totals.dropped++
      totals.droppedPapers += papers
    } else if (stop.status === 'missed') {
      totals.missed++
      totals.missedPapers += papers
    } else if (stop.status === 'skipped') totals.skipped++
    else {
      totals.toDrop++
      totals.toDropPapers += papers
    }
  }
  return totals
}

/** Whether the list offers "Mark dropped" for a bundle: one missed, or one still to come. (Not the one dropped already, nor one skipped over.) */
export const canMarkDropped = (b: Pick<BundleItem, 'status'>): boolean => b.status === 'missed' || b.status === 'later'

/** How many papers, as the alert says it ("12 papers"), or null when no amount was set. */
export const papersText = (papers: number | null): string | null => (papers === null ? null : plural(papers, 'paper', 'papers'))

/** How far a bundle is, for the line and the list: "Now" when it is here, "Passed" once it is behind, then "340 m" or "1.2 km". */
export function bundleAheadText(ahead: number): string {
  if (ahead <= -10) return 'Passed'
  if (ahead < 15) return 'Now'
  return formatDistance(Math.round(ahead / 10) * 10)
}

/** The line that is always showing for the bundle coming next: "Next bundle: Co-op · 340 m · 12 papers" (no amount, no papers). */
export function nextBundleLine(next: BundleItem): string {
  const papers = papersText(next.papers)
  return [`Next bundle: ${next.name}`, bundleAheadText(next.ahead), ...(papers ? [papers] : [])].join(' · ')
}

/**
 * The line for the round's bar: the next bundle, or when there is none ahead what is left to say ("All bundles dropped", or
 * "No more bundles ahead", with how many were missed). Null when the route has no bundle drops, so the bar shows nothing.
 */
export function bundleLine(list: readonly BundleItem[]): string | null {
  if (!list.length) return null
  const next = nextBundle(list)
  if (next) return nextBundleLine(next)
  const { total, dropped, missed } = bundleTotals(list)
  if (dropped === total) return 'All bundles dropped'
  return missed ? `No more bundles ahead · ${missed} missed` : 'No more bundles ahead'
}

/** The list's summary: "36 papers dropped · 24 papers to drop · 2 missed". Empty when the route has no bundle drops. */
export function bundleTotalsText(totals: BundleTotals): string {
  if (!totals.total) return ''
  return [
    `${plural(totals.droppedPapers, 'paper', 'papers')} dropped`,
    `${plural(totals.toDropPapers, 'paper', 'papers')} to drop`,
    ...(totals.missed ? [`${totals.missed} missed`] : []),
  ].join(' · ')
}

/** What is said after a bundle is dropped, to name the next: "Next bundle, Co-op, 300 metres". Right here, no distance. */
export function nextBundleSpeech(next: BundleItem): string {
  return `Next bundle, ${next.name}${next.ahead >= 15 ? `, ${spokenDistance(next.ahead)}` : ''}`
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])
const unique = (keys: readonly string[]): string[] => [...new Set(keys)]

/**
 * The round with its lists made consistent: what was dropped or missed is kept only while it is still done, and nothing is both
 * (dropped wins). Duplicates and anything that is not a key are dropped too. Use it whenever the stops done change, with the new
 * list in place: `reconcile({ ...round, handledStopIds })`. Empty lists are left out, and how far the round got and where it
 * started are kept as they are. A new round is returned, and the one given is not changed.
 */
export function reconcile(round: RoundState): RoundState {
  const { dropped: d, missed: m, handledStopIds, ...rest } = round
  const done = new Set(handledStopIds)
  const dropped = unique(strings(d)).filter((k) => done.has(k))
  const droppedSet = new Set(dropped)
  const missed = unique(strings(m)).filter((k) => done.has(k) && !droppedSet.has(k))
  return { ...rest, handledStopIds: [...handledStopIds], ...(dropped.length ? { dropped } : {}), ...(missed.length ? { missed } : {}) }
}

/** Where one pass of a bundle stop stands in the round: still to come ('open'), done with nothing recorded ('skipped'), missed, or dropped. */
export type PassState = 'open' | 'skipped' | 'missed' | 'dropped'

/** What several passes stood at, by key: the memory that lets `undoDropped` put them back exactly. */
export type PassStates = ReadonlyMap<string, PassState>

/** Where the pass with this key stands in the round. */
export function passState(round: Pick<RoundState, 'handledStopIds' | 'dropped' | 'missed'>, key: string): PassState {
  if (!round.handledStopIds.includes(key)) return 'open'
  if (round.dropped?.includes(key)) return 'dropped'
  return round.missed?.includes(key) ? 'missed' : 'skipped'
}

/** Where each of these passes stands in the round now. Keep it from before a drop to take the drop back with `undoDropped`. */
export const passStates = (round: Pick<RoundState, 'handledStopIds' | 'dropped' | 'missed'>, keys: readonly string[]): PassStates =>
  new Map(keys.map((key): [string, PassState] => [key, passState(round, key)]))

/**
 * The keys of the other times the route goes by the same stop as the occurrence with this key, in route order: the passes that dropping
 * this one settles (see `markDropped`). None for a stop the route goes by once, or a key that is not among `occs`.
 */
export function otherPasses(occs: readonly Pick<Occurrence, 'key' | 'stop' | 'at'>[], key: string): string[] {
  const stopId = occs.find((o) => o.key === key)?.stop.id
  if (stopId === undefined) return []
  return occs
    .filter((o) => o.stop.id === stopId && o.key !== key)
    .sort((a, b) => a.at - b.at)
    .map((o) => o.key)
}

/**
 * The bundle was dropped: it is done, and dropped, and no longer missed if it was. Dropping one already dropped changes nothing.
 *
 * A stop the route goes by more than once is one delivery, so `others` (the keys of its other passes: see `otherPasses`) are settled by
 * it: each becomes done without being dropped, which is to say skipped, so it never alerts and is never missed, and one that was missed
 * is not missed any more. A pass of them that is dropped already stays so. Keep `passStates` of the key and `others` from before, to take
 * the drop back exactly with `undoDropped`.
 */
export function markDropped(round: RoundState, key: string, others: readonly string[] = []): RoundState {
  const settled = others.filter((k) => k !== key)
  const done = [...round.handledStopIds]
  const have = new Set(done)
  for (const k of [key, ...settled]) {
    if (have.has(k)) continue
    have.add(k)
    done.push(k)
  }
  const dropped = round.dropped?.includes(key) ? round.dropped : [...(round.dropped ?? []), key]
  const settledSet = new Set(settled)
  const missed = round.missed?.filter((k) => !settledSet.has(k))
  return reconcile({ ...round, handledStopIds: done, dropped, ...(missed ? { missed } : {}) })
}

/**
 * Settles the other passes of every stop that has a pass dropped (see `markDropped`). Use it when the stops done have been rebuilt by
 * a restart or a skip, which count the passes before a spot as done and the rest as not, so a stop dropped on an earlier pass is still
 * one delivery done: the later pass does not come up again. `occs` are the route's occurrences. A new round is returned.
 */
export function settleDrops(round: RoundState, occs: readonly Pick<Occurrence, 'key' | 'stop' | 'at'>[]): RoundState {
  let next = reconcile(round)
  for (const key of next.dropped ?? []) {
    const others = otherPasses(occs, key)
    if (others.length) next = markDropped(next, key, others)
  }
  return next
}

/**
 * Takes back a drop: the bundle goes back to not done, so it is still to come (and alerts again if the driver is at it). A bundle that
 * is not dropped is left as it is, so that a late "Undo" after the round has been restarted can't undo something else.
 *
 * With `before`, the `passStates` of the bundle and of the other passes of its stop from before it was dropped, every pass is put back
 * as it was: the bundle to not done, skipped or missed, as it stood (a bundle marked dropped from the list while missed is missed again),
 * and each other pass that the drop settled to what it was (to come again, or missed again). A pass that has changed since, so that it
 * is no longer just settled, is left alone. Without it, only the bundle itself goes back, to not done.
 */
export function undoDropped(round: RoundState, key: string, before?: PassStates): RoundState {
  if (!round.dropped?.includes(key) || before?.get(key) === 'dropped') return reconcile(round)
  const done = new Set(round.handledStopIds)
  const dropped = new Set(round.dropped)
  dropped.delete(key)
  const missed = new Set(round.missed ?? [])
  const open = new Set<string>()
  const was = before?.get(key)
  if (was === 'skipped' || was === 'missed') {
    if (was === 'missed') missed.add(key)
  } else open.add(key)
  if (before) {
    for (const [k, state] of before) {
      // Only a pass that stands as the drop left it, done and nothing else, goes back.
      if (k === key || !done.has(k) || dropped.has(k) || missed.has(k)) continue
      if (state === 'open') open.add(k)
      else if (state === 'missed') missed.add(k)
    }
  }
  return reconcile({ ...round, handledStopIds: round.handledStopIds.filter((k) => !open.has(k)), dropped: [...dropped], missed: [...missed] })
}

/**
 * Bundles driven past with no "Dropped" are missed. Only keys that are done and not dropped are recorded, so the stops done must
 * already include them: add them first (`reconcile({ ...round, handledStopIds })`), then call this. With `bundleKeys`, only keys in it
 * count, so the keys of every stop that was passed can be given and only the bundle drops among them are recorded. A key already
 * missed stays so. A new round is returned.
 */
export function markMissed(round: RoundState, keys: readonly string[], bundleKeys?: ReadonlySet<string>): RoundState {
  const done = new Set(round.handledStopIds)
  const dropped = new Set(round.dropped ?? [])
  const fresh = keys.filter((k) => done.has(k) && !dropped.has(k) && (!bundleKeys || bundleKeys.has(k)))
  return reconcile({ ...round, missed: [...(round.missed ?? []), ...fresh] })
}
