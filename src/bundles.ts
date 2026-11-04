import { plural } from './format'
import { haversine, type Occurrence } from './geo'
import { formatDistance } from './routeEdit'
import { spokenDistance } from './turns'
import type { Pt, RoundState, Stop } from './types'

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
 *
 * Two layers. The list of PASSES (`bundleList`) is in route order and its 'next' and 'later' go by where the driver is along the route:
 * it is how the rules above are kept, and is not what the driver sees as the next bundle. What the driver sees is the list of STOPS in
 * THEIR order (`bundleRows`): one row for each bundle stop, in the order the driver put them in (`SavedRoute.bundleOrder`), which never
 * changes by itself. The next bundle is the first in that order that is still to do, wherever it is, and its distance is the straight
 * line from the phone. The bar, the list and the voice after a drop all go by the rows.
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
      name: bundleNameOf(o.stop),
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

/**
 * The pass coming next by where the driver is along the route, or null when there is none ahead. This is the route's own order, kept for
 * the passes: the bundle the driver is shown as next is `nextInOrder` of `bundleRows`, which goes by the driver's list.
 */
export const nextBundle = (list: readonly BundleItem[]): BundleItem | null => list.find((b) => b.status === 'next') ?? null

/** What became of a bundle stop as a whole, however many times the route goes by it: see `bundleStops`. */
export type StopStatus = 'dropped' | 'missed' | 'skipped' | 'toDrop'

/** A bundle stop as the totals count it: once, whether the route goes by it once or more. */
export interface BundleStop {
  stopId: string
  name: string
  /** The address to show under the name, when the stop has a name and an address too. */
  address: string | null
  /** How many papers it gets, once: not once for each pass. Null when no amount was set. */
  papers: number | null
  status: StopStatus
  /** The keys of every time the route goes by it, in route order. */
  keys: string[]
  /** How many times the route goes by it. */
  passes: number
  /**
   * The key "Mark dropped" acts on: the first pass in route order that is still to come or missed. Null when there is nothing to mark
   * (the stop is dropped, or was skipped over). Dropping that pass settles the others, so one key is enough for the stop.
   */
  markKey: string | null
  /** The key of the pass that was dropped, which "Undo" takes back; null when none was. */
  undoKey: string | null
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
    const [first] = passes
    // A pass of a stop dropped on another is covered by it and so skipped, and a stop skipped over has nothing left: neither has one to mark.
    const markable = passes.find((b) => b.status === 'next' || b.status === 'later' || b.status === 'missed')
    return {
      stopId: first.stopId,
      name: first.name,
      address: first.address,
      papers: first.papers,
      status,
      keys: passes.map((b) => b.key),
      passes: passes.length,
      markKey: markable?.key ?? null,
      undoKey: passes.find((b) => b.status === 'dropped')?.key ?? null,
    }
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

/** The totals of stops that each have their papers and what became of them: the one place the counting is done. */
function totalsOf(stops: readonly Pick<BundleStop, 'papers' | 'status'>[]): BundleTotals {
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

/**
 * What has been dropped, what is missed and what is still to drop, counted a stop at a time (see `bundleStops`): a stop the route goes
 * by twice is one delivery, so its papers are counted once, and dropping it on either pass drops it.
 */
export const bundleTotals = (list: readonly BundleItem[]): BundleTotals => totalsOf(bundleStops(list))

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

/**
 * A line of words for the pass coming next by place on the route (see `nextBundle`): "Next bundle: Co-op · 340 m · 12 papers" (no amount,
 * no papers). The bar's own line, for the bundle next in the driver's list, is `barBundle` in bundleFlow.ts.
 */
export function nextBundleLine(next: BundleItem): string {
  const papers = papersText(next.papers)
  return [`Next bundle: ${next.name}`, bundleAheadText(next.ahead), ...(papers ? [papers] : [])].join(' · ')
}

/**
 * A line of words for the round's bar, by place on the route (see `nextBundleLine`): the next bundle, or when there is none ahead what is
 * left to say ("All bundles dropped", or "No more bundles ahead", with how many were missed). Null when the route has no bundle drops.
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

/**
 * What is said after a bundle is dropped, to name the next in the driver's order (see `nextInOrder`): "Next bundle, Co-op, 300 metres".
 * The distance is the straight line from the phone. Right here, or with the phone's position not known, there is no distance.
 */
export function nextBundleSpeech(next: Pick<BundleRow, 'name' | 'distance'>): string {
  const { distance } = next
  return `Next bundle, ${next.name}${distance !== null && distance >= 15 ? `, ${spokenDistance(distance)}` : ''}`
}

/* ------------------------------------------------------------------ *
 * The driver's order. The list the driver sees has one row for each bundle STOP, in the order the driver put them in (kept with the
 * route as `SavedRoute.bundleOrder`, a list of stop ids). It never changes by itself: new bundles go after those in it, in route
 * order, and ids of stops that no longer exist are ignored, all worked out each time it is read (`orderedStops`), so editing the route
 * never has to touch it.
 * ------------------------------------------------------------------ */

/** The most ids kept in a bundle order, so damaged data can't fill the phone: as many as a backup holds stops. */
export const MAX_BUNDLE_ORDER = 5000

/** What the name of a bundle stop is: its name, else its address, else `UNNAMED_BUNDLE`. */
export const bundleNameOf = (stop: Pick<Stop, 'label' | 'address'>): string => trimmed(stop.label) ?? trimmed(stop.address) ?? UNNAMED_BUNDLE

/** An order read back from storage or a backup, made safe to use: only ids (text), none twice, no more than `MAX_BUNDLE_ORDER`. */
export function normalizeBundleOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  for (const id of raw) {
    if (seen.size >= MAX_BUNDLE_ORDER) break
    if (typeof id === 'string' && id) seen.add(id)
  }
  return [...seen]
}

/**
 * The stops in the driver's order: those whose id is in `order`, in its sequence, then any that are not (new ones) in the order they are
 * given, so give them in route order. An id in `order` with no stop is ignored (the stop was deleted), and so is an id twice. Nothing
 * is changed, and with no order the stops come out as they went in.
 */
export function orderedStops<T extends { id: string }>(stops: readonly T[], order: readonly string[] | undefined): T[] {
  const byId = new Map<string, T[]>()
  for (const stop of stops) {
    const same = byId.get(stop.id)
    if (same) same.push(stop)
    else byId.set(stop.id, [stop])
  }
  const out: T[] = []
  for (const id of order ?? []) {
    const same = byId.get(id)
    if (!same) continue
    out.push(...same)
    byId.delete(id)
  }
  for (const stop of stops) if (byId.has(stop.id)) out.push(stop)
  return out
}

/** The place a bundle would move to going one way from `from`: the nearest that is not one to hop over, or -1 when there is none. */
function neighbour(list: readonly string[], from: number, step: 1 | -1, hop: ReadonlySet<string> | undefined): number {
  for (let at = from + step; at >= 0 && at < list.length; at += step) if (!hop?.has(list[at])) return at
  return -1
}

/**
 * The order with the bundle `id` moved `delta` places up (negative) or down (positive), as the whole new order: every id in `ids`
 * (the bundles there are now), in the driver's order with new ones last (see `orderedStops`), so the order the driver sees is the
 * order that is kept. One place is a swap with the neighbour. The ids in `hop` (bundles already dropped, missed or skipped, which are
 * not waiting to be delivered) are hopped over rather than counted, so a bundle moves past the ones that are done in one go. At the top
 * or the bottom there is nowhere further to go and it stays. An `id` that is not among `ids` changes nothing. A new array is returned.
 */
export function moveBundle(order: readonly string[] | undefined, ids: readonly string[], id: string, delta: number, hop?: ReadonlySet<string>): string[] {
  const list = orderedStops(
    ids.map((i) => ({ id: i })),
    order,
  ).map((s) => s.id)
  const step = delta < 0 ? -1 : 1
  let at = list.indexOf(id)
  for (let places = Math.abs(Math.trunc(delta)); at >= 0 && places > 0; places--) {
    const to = neighbour(list, at, step, hop)
    if (to < 0) break
    list.splice(at, 1)
    list.splice(to, 0, id)
    at = to
  }
  return list
}

/** Whether `moveBundle` would move the bundle one place up (`delta` -1) or down (+1), which is whether its button is of any use. */
export function canMoveBundle(order: readonly string[] | undefined, ids: readonly string[], id: string, delta: number, hop?: ReadonlySet<string>): boolean {
  const list = orderedStops(
    ids.map((i) => ({ id: i })),
    order,
  ).map((s) => s.id)
  const at = list.indexOf(id)
  return at >= 0 && neighbour(list, at, delta < 0 ? -1 : 1, hop) >= 0
}

/**
 * Where a bundle stop stands in the driver's list: the one coming next (the first in the list still to do, wherever it is), one to do
 * after that, dropped, missed (driven past in its zone with no tap), or skipped over.
 */
export type RowStatus = 'next' | 'todo' | 'dropped' | 'missed' | 'skipped'

/** The words for each status of a row, as the list shows them. */
export const ROW_STATUS_LABEL: Record<RowStatus, string> = { next: 'Next', todo: 'To do', dropped: 'Dropped', missed: 'Missed', skipped: 'Skipped' }

/** Whether a bundle is still to do: the next or one after it. Missed and skipped ones are not, and are never the next. */
export const isToDo = (status: RowStatus): boolean => status === 'next' || status === 'todo'

/** The status of a row as the totals count it: the next and those after it are all still to drop. */
const stopStatusOf = (status: RowStatus): StopStatus => (status === 'next' || status === 'todo' ? 'toDrop' : status)

/** One bundle stop in the driver's list, however many times the route goes by it. */
export interface BundleRow {
  /** The stop's id, which the order is kept by. */
  id: string
  /** What the place is called: the stop's name, or else its address, or else `UNNAMED_BUNDLE`. */
  name: string
  /** The address to show under the name, when the stop has a name and an address too. */
  address: string | null
  /** How many papers, once, or null when no amount was set. */
  papers: number | null
  /** How many times the route goes by it. */
  passes: number
  status: RowStatus
  /** The straight line from the phone to the stop, in metres, or null while the phone's position is not known. */
  distance: number | null
  /** The key "Mark dropped" acts on (see `BundleStop.markKey`), or null when the row has no such button. */
  markKey: string | null
  /** The key "Undo" acts on, the pass that was dropped, or null when the row has no such button. */
  undoKey: string | null
}

/**
 * The driver's list: one row for each bundle stop on the route, in the driver's order (`order`, as kept: stale or missing ids are put
 * right here, see `orderedStops`), each with what became of it counted as one delivery whichever pass it was made on (see `bundleStops`).
 * `here` is the phone's position, or null before it is known. The first row still to do is 'next', and the rest still to do 'todo'.
 * Where the driver is along the route does not matter: the next is the next in the list.
 */
export function bundleRows(
  occs: readonly Occurrence[],
  round: Pick<RoundState, 'handledStopIds' | 'dropped' | 'missed'>,
  order: readonly string[] | undefined,
  here: Pt | null,
): BundleRow[] {
  const where = new Map<string, Pt>()
  for (const o of occs) if (o.stop.type === 'bundle' && !where.has(o.stop.id)) where.set(o.stop.id, o.stop)
  const stops = bundleStops(bundleList(occs, round, 0)).map((s): BundleRow => {
    const spot = where.get(s.stopId)
    return {
      id: s.stopId,
      name: s.name,
      address: s.address,
      papers: s.papers,
      passes: s.passes,
      status: s.status === 'toDrop' ? 'todo' : s.status,
      distance: here && spot ? haversine(here, spot) : null,
      markKey: s.markKey,
      undoKey: s.undoKey,
    }
  })
  const rows = orderedStops(stops, order)
  const first = rows.findIndex((r) => r.status === 'todo')
  if (first >= 0) rows[first] = { ...rows[first], status: 'next' }
  return rows
}

/** A bundle drop in the order editor: what it is called, its papers and, in a round, where it stands. */
export interface EditorBundle {
  /** The stop's id, which the order is kept by. */
  id: string
  name: string
  /** How many papers, when an amount was set. */
  qty?: number | null
  /**
   * Where it stands in a round. Dropped, missed and skipped bundles are shown but have no buttons, as they are not waiting to be delivered,
   * and a bundle moved past them hops over them. Left out in Setup, where every bundle is still to do.
   */
  status?: RowStatus
}

/** The ids of the bundles in a round that are not waiting to be delivered: dropped, missed or skipped over. */
const finishedIds = (bundles: readonly EditorBundle[]): Set<string> => new Set(bundles.filter((b) => b.status !== undefined && !isToDo(b.status)).map((b) => b.id))

/** One row of the order editor, as words and flags: what to show, and which of Move up and Move down is of any use. */
export interface EditorRow {
  id: string
  name: string
  /** Its place in the order, from 1. */
  place: number
  status: RowStatus | null
  statusLabel: string | null
  /** "12 papers", or null when no amount was set. */
  papers: string | null
  /** Already dropped, missed or skipped: shown dimmed, with no buttons. */
  finished: boolean
  canUp: boolean
  canDown: boolean
}

/** The rows of the order editor: the bundles in the driver's order (see `orderedStops`), each with whether it can move up or down. */
export function editorRows(bundles: readonly EditorBundle[], order: readonly string[] | undefined): EditorRow[] {
  const ids = bundles.map((b) => b.id)
  const hop = finishedIds(bundles)
  return orderedStops(bundles, order).map((b, i) => ({
    id: b.id,
    name: b.name,
    place: i + 1,
    status: b.status ?? null,
    statusLabel: b.status ? ROW_STATUS_LABEL[b.status] : null,
    papers: papersText(b.qty && b.qty > 0 ? b.qty : null),
    finished: hop.has(b.id),
    canUp: !hop.has(b.id) && canMoveBundle(order, ids, b.id, -1, hop),
    canDown: !hop.has(b.id) && canMoveBundle(order, ids, b.id, 1, hop),
  }))
}

/** The whole new order when the editor's bundle `id` is moved up (-1) or down (+1), hopping over those already done. */
export const editorMove = (bundles: readonly EditorBundle[], order: readonly string[] | undefined, id: string, delta: -1 | 1): string[] =>
  moveBundle(order, bundles.map((b) => b.id), id, delta, finishedIds(bundles))

/**
 * The bundle drops of a route for the order editor in Setup, with every one still to do: each stop once, in the order the route first
 * reaches it, which is where a bundle added since is put in the order (see `orderedStops`). `occs` are the route's occurrences.
 */
export const setupBundles = (occs: readonly Occurrence[]): EditorBundle[] =>
  bundleStops(bundleList(occs, { handledStopIds: [] }, 0)).map((s) => ({ id: s.stopId, name: s.name, qty: s.papers }))

/** The bundle coming next in the driver's list, or null when none is left to do. */
export const nextInOrder = (rows: readonly BundleRow[]): BundleRow | null => rows.find((r) => r.status === 'next') ?? null

/** How many bundle drops are left to do: stops, so a street driven twice counts once. */
export const bundlesLeft = (rows: readonly Pick<BundleRow, 'status'>[]): number => rows.filter((r) => isToDo(r.status)).length

/** The totals of the driver's list, counted as `bundleTotals` counts them: a stop once, with its papers once. */
export const rowTotals = (rows: readonly Pick<BundleRow, 'papers' | 'status'>[]): BundleTotals =>
  totalsOf(rows.map((r) => ({ papers: r.papers, status: stopStatusOf(r.status) })))

/** How far a bundle is from the phone, for the bar: "340 m", "Now" when it is here, or null while the phone's position is not known. */
export const distanceText = (distance: number | null): string | null => (distance === null ? null : bundleAheadText(distance))

/** How far a bundle is, for the list: "340 m away", "Here now", or null while the phone's position is not known. */
export function awayText(distance: number | null): string | null {
  const text = distanceText(distance)
  return text === null ? null : text === 'Now' ? 'Here now' : `${text} away`
}

/** The list's header: how many are left, and how many of the whole are dropped: "3 bundles left · 5 of 8 dropped". Empty for no bundles. */
export function bundleLeftText(totals: BundleTotals): string {
  if (!totals.total) return ''
  const of = `${totals.dropped} of ${totals.total} dropped`
  if (totals.toDrop > 0) return `${plural(totals.toDrop, 'bundle', 'bundles')} left · ${of}`
  if (totals.dropped < totals.total) return `No bundles left · ${of}`
  return totals.total === 1 ? 'The bundle is dropped' : `All ${totals.total} bundles dropped`
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
