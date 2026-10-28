import {
  BUNDLE_STATUS_LABEL,
  bundleAheadText,
  bundleStops,
  bundleTotals,
  canMarkDropped,
  markMissed,
  nextBundle,
  papersText,
  reconcile,
  settleDrops,
  undoDropped,
  type BundleItem,
  type BundleStatus,
  type PassStates,
} from './bundles'
import type { Occurrence } from './geo'
import { handledForResume } from './resume'
import type { NextBundle } from './RoundBar'
import type { RoundState } from './types'

/*
 * What the round screen does with bundle drops, kept apart from the screen so it can be tested: how the round is kept so that what
 * was dropped or missed is never lost by accident, what the bar and the list of bundles say, and the notice for one driven past.
 * The rules of the bundles themselves (what dropped, missed and skipped mean) are in bundles.ts.
 */

/**
 * The round to keep when the stops done change: the new list of stops done, how far the round got and where it started, with the
 * bundles dropped and missed carried over from `prev` (only those still among the stops done survive: see `reconcile`). The screen
 * builds the round afresh at each save, so without this a save would forget every drop. `missedKeys` are bundles driven past just
 * now with no tap; they must be among `handledStopIds` and are recorded as missed. Nothing in `prev` is changed.
 */
export function savedRound(prev: RoundState, handledStopIds: readonly string[], furthest: number | undefined, startM: number, missedKeys: readonly string[] = []): RoundState {
  const { dropped, missed } = prev
  const next = reconcile({
    handledStopIds: [...handledStopIds],
    ...(furthest ? { furthest } : {}),
    ...(startM > 0 ? { startM } : {}),
    ...(dropped ? { dropped } : {}),
    ...(missed ? { missed } : {}),
  })
  return missedKeys.length ? markMissed(next, missedKeys) : next
}

/**
 * The round when it is started, or skipped to, `metres` along the route. At 0 it is a fresh start and forgets everything, drops and
 * misses included, and so is a start from a spot after a round that was finished (`fresh`: see `freshStart`), which is a new round and
 * must not open with yesterday's papers counted. Anywhere else the stops before the spot count as done and those after it as not done,
 * so a bundle dropped or missed before the spot stays so, one after it comes up again (it is no longer dropped or missed), and one before
 * it that was still to do is skipped: neither dropped nor missed. A bundle stop is one delivery however many times the route goes by
 * it, so a stop whose drop stays (it was on a pass before the spot) has its later passes done too, and does not alert again; one
 * dropped on a pass after the spot comes up again on every pass.
 */
export function restartedRound(prev: RoundState, occs: readonly Occurrence[], metres: number, slack: number, fresh = false): RoundState {
  if (metres <= 0) return { handledStopIds: [] }
  const base: RoundState = fresh ? { handledStopIds: [] } : prev
  return settleDrops({ ...base, handledStopIds: handledForResume(occs, metres, slack), startM: metres, furthest: metres }, occs)
}

/**
 * Whether a start from a spot begins a new round, forgetting the bundles dropped and missed: it does when it is a start (not a skip
 * while driving) and the round before it was finished, as Start New Round does. A start on a round not finished, such as after the
 * app was closed part way, and any skip, keep what was dropped or missed before the spot.
 */
export const freshStart = (skip: boolean, finished: boolean): boolean => !skip && finished

/**
 * What starting or skipping to `metres` along the route does to the stops, as the words that tell the driver say it: how many not yet
 * done count as done (those before it) and how many done come up again (those after it, except the later passes of a stop whose drop
 * stays, which stay done). It goes by `restartedRound`, so what the sheets say is what is done.
 */
export function restartEffect(
  round: RoundState,
  occs: readonly Occurrence[],
  handled: ReadonlySet<string>,
  metres: number,
  slack: number,
  fresh = false,
): { newly: number; back: number } {
  const after = new Set(restartedRound(round, occs, metres, slack, fresh).handledStopIds)
  return {
    newly: [...after].filter((key) => !handled.has(key)).length,
    back: occs.filter((o) => handled.has(o.key) && !after.has(o.key)).length,
  }
}

/** How long after a Dropped tap another is ignored: a second tap that quick is the first one again, not a drop of the next bundle at the same spot. */
export const DROP_LOCK_MS = 600

/** Whether a Dropped tap is taken, given when the last one was (`-Infinity` for none). */
export const dropAllowed = (lastAt: number, now: number): boolean => now - lastAt >= DROP_LOCK_MS

/**
 * Which of the stops just driven past in their zone are bundles missed: the bundle drops among them, and only while the driver is on
 * the route. Any other way a bundle ends up done (a sweep after leaving the route, a catch-up, a skip) leaves it skipped, so nothing
 * is recorded as missed for those, and a no-throw house or a special request is never missed.
 */
export const missedAmong = (passed: readonly Pick<Occurrence, 'key' | 'stop'>[], onRoute: boolean): string[] =>
  onRoute ? passed.filter((o) => o.stop.type === 'bundle').map((o) => o.key) : []

/**
 * Takes back a drop. The bundle goes back to what it was before it was dropped: to do again, or missed again when it was missed (it was
 * marked dropped from the list while missed). `was` says what it was: `true` for missed and `false` for not, for the bundle alone, or
 * better the `passStates` taken before the drop, of the bundle and of the other passes of its stop, which puts every pass the drop
 * settled back as it was too (to come, or missed, or skipped). A bundle that is not dropped any more, such as after the round was
 * restarted, is left alone, so a late Undo can't change something else.
 */
export function restoreBundle(round: RoundState, key: string, was: boolean | PassStates): RoundState {
  if (!round.dropped?.includes(key)) return reconcile(round)
  if (typeof was !== 'boolean') return undoDropped(round, key, was)
  const open = undoDropped(round, key)
  return was ? markMissed({ ...open, handledStopIds: [...open.handledStopIds, key] }, [key]) : open
}

/**
 * The bar's line for bundle drops: the next one with how far it is and its papers, or when none is ahead how the round stands. Null
 * when the route has no bundle drops, so the bar shows no such line. `missed` is how many bundle stops were driven past without being
 * dropped, counted once each however many times the route goes by (see `bundleTotals`); one with a pass still to come is not missed yet.
 */
export function barBundle(list: readonly BundleItem[]): NextBundle | null {
  if (!list.length) return null
  const totals = bundleTotals(list)
  const next = nextBundle(list)
  if (next) return { lead: 'Next bundle', name: next.name, distance: bundleAheadText(next.ahead), papers: papersText(next.papers), missed: totals.missed }
  return { lead: 'Bundles', name: totals.dropped === totals.total ? 'All bundles dropped' : 'No more bundles ahead', distance: null, papers: null, missed: totals.missed }
}

/** The longest a venue's name is in a notice, in characters: a long one would grow the bar's line. */
const NOTICE_NAME_MAX = 26

const shortName = (name: string): string => (name.length > NOTICE_NAME_MAX ? `${name.slice(0, NOTICE_NAME_MAX - 1).trimEnd()}…` : name)

/**
 * The bar's notice for bundles driven past in their zone without a tap: "Missed bundle: Co-op". Two or more name the first two and say
 * how many more. Empty when there are none.
 */
export function missedNotice(names: readonly string[]): string {
  if (!names.length) return ''
  const shown = names.slice(0, 2).map(shortName)
  const more = names.length - shown.length
  const list = more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(' and ')
  return names.length === 1 ? `Missed bundle: ${list}` : `Missed ${names.length} bundles: ${list}`
}

/** How far a bundle is, for the list: "340 m ahead", "Here now", or "Behind you". */
export function bundleWhere(ahead: number): string {
  const text = bundleAheadText(ahead)
  if (text === 'Passed') return 'Behind you'
  return text === 'Now' ? 'Here now' : `${text} ahead`
}

/** One bundle in the list, as words: everything the row shows or reads out, and what its button does. */
export interface SheetRow {
  key: string
  name: string
  /** Shown under the name, when the stop has both. */
  address: string | null
  status: BundleStatus
  statusLabel: string
  where: string
  /** "12 papers", or null when no amount was set. */
  papers: string | null
  /** "Pass 2 of 2" for a street the route goes by more than once; null otherwise. */
  pass: string | null
  /** "mark" is Mark dropped (for a bundle missed or still to come), "undo" takes back a drop, and a bundle skipped over has no button. */
  action: 'mark' | 'undo' | null
  /** The whole row for a screen reader. */
  label: string
}

/** The words for a row's state: the status, or for a pass covered by the drop of another "Dropped on pass 1". */
const statusWords = (b: Pick<BundleItem, 'status' | 'coveredBy'>): string => (b.coveredBy === null ? BUNDLE_STATUS_LABEL[b.status] : `Dropped on pass ${b.coveredBy}`)

export function sheetRow(b: BundleItem): SheetRow {
  const statusLabel = statusWords(b)
  const papers = papersText(b.papers)
  const where = bundleWhere(b.ahead)
  const pass = b.passes > 1 ? `Pass ${b.pass} of ${b.passes}` : null
  const action = canMarkDropped(b) ? 'mark' : b.status === 'dropped' ? 'undo' : null
  const label = [`${statusLabel}.`, `${b.name}${papers ? `, ${papers}` : ''}${pass ? `, ${pass.toLowerCase()}` : ''}.`, `${where}.`].join(' ')
  return { key: b.key, name: b.name, address: b.address, status: b.status, statusLabel, where, papers, pass, action, label }
}

/**
 * How many bundle stops that count towards the papers (dropped, or still to drop) have no amount set. The totals add nothing for them, so
 * the list says its figures are short when there are any. A stop the route goes by twice counts once.
 */
export const unsetAmounts = (list: readonly BundleItem[]): number =>
  bundleStops(list).filter((s) => s.papers === null && (s.status === 'dropped' || s.status === 'toDrop')).length
