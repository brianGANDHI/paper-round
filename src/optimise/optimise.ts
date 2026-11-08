import { bundleNameOf } from '../bundles'
import { pathDistancer } from '../geo'
import type { Route, SavedRoute, Stop } from '../types'
import { auditRoute, ON_MAP_GATE_M, onMapCheck, routeStats, type Audit } from './audit'
import { assignSides, buildRoute, smoothSides, type BuiltRoute } from './build'
import { wakingClock } from './clock'
import { bundlePasses, driverList, otherVisits, walkList } from './list'
import { networkStart } from './network'
import { buildMatrix, expand, makeProblem, type Leg, type Matrix, type Problem } from './problem'
import { closedRoadsUsed, gapsOf, newRoadsOf, oneSidedStretches, turnBacksOf, turnStreets, worthChecking } from './report'
import { basedOnOf, COVER_GATE_M } from './run'
import { anneal, nearTable, oldSequence, orderedStart, type Tour } from './search'
import { DEFAULT_BUDGET_MS, type Budget, type BundleName, type BundleOutcome, type OnProgress, type OptimiseChoices, type OptimiseResult, type OsmData, type Prepared, type PreparedView, type RouteStats, type UnmatchedPart } from './types'
import { closingKm, edgeAt, makeWorld, optionsFor, streetChoices, streetName, unmatchedParts, type World } from './world'

/**
 * Optimise Route, as two steps, so the street list can be shown before solving. `prepare` matches the saved route to the map and works
 * out what it throws at. `solve` finds a new drive for the driver's choices, and then checks it as if it had come from anywhere: every
 * figure and every reason to block Accept comes from a fresh match of the finished points.
 */

/** Heats the search anneals at. A hot run can leave the old shape behind, which only the shortest route wants. */
const SHORTEST_HEATS = [4, 25]
const KEEP_ORDER_HEATS = [4]
/** How many seeds each heat is tried from. */
const SEEDS = 3
const FIRST_SEED = 11
/**
 * What's kept out of the budget for turning the best drive into a route and checking it, measured on this phone as far as it can be: walking
 * the drive is road searches like the cost table's, about one for each task. Checking it is a match like the old route's, and then the walk
 * along the map, which takes about 1.4 times as long as a match. Going by the match keeps that in step with the phone it runs on.
 */
const FINISH_MS = 300
const FINISH_TABLE_SHARE = 0.8
const FINISH_MATCH_SHARE = 3
/** The screen hears how the search is going this often, in moves: a few times a second, and a power of two as it's checked on every look at the clock. */
const TELL_EVERY_MOVES = 1 << 20
/** A stop must stay this near the route, or as near as it was and this much more, in metres. */
const STOP_REACH_M = 30
const STOP_DRIFT_M = 15

export { basedOnOf, defaultChoices, fingerprintOf, isStale } from './run'

/** The first step: the map, the match, what's thrown, the street list and today's figures. */
export function prepare(saved: SavedRoute, osm: OsmData, onProgress?: OnProgress): Prepared {
  const world = makeWorld(saved, osm, onProgress)
  onProgress?.({ step: 'Measuring the route', done: 0.9 })
  const notes: string[] = []
  if (world.unreadRules) notes.push(`The map has ${world.unreadRules} turn rule${world.unreadRules === 1 ? '' : 's'} this can't read, so check any turn that looks wrong.`)
  const age = mapAgeNote(osm.date, Date.now())
  if (age) notes.push(age)
  const view: PreparedView = {
    basedOn: basedOnOf(saved),
    start: world.start,
    streets: streetChoices(world),
    before: routeStats(world.route, world.audit, closingKm(world)),
    bundles: world.list,
    bundleOrderSet: world.orderSet,
    unmatched: unmatchedParts(world.graph, world.audit),
    notes,
  }
  onProgress?.({ step: 'Ready', done: 1 })
  return { view, world }
}

/** A map older than this is worth a word, in days: a mirror can run this far behind, and the audit can only go by the map in hand. */
const OLD_MAP_DAYS = 60
const DAY_MS = 86400000
const DAYS_IN_MONTH = 30

/** A line saying how old the map is, when it is old. Nothing is said of a map with no date, or one that can't be read. */
export function mapAgeNote(date: string | undefined, now: number): string | null {
  const days = (now - Date.parse(date ?? '')) / DAY_MS
  if (!(days > OLD_MAP_DAYS)) return null
  return `This map is about ${Math.round(days / DAYS_IN_MONTH)} months old, so a road that has changed since won't show on it.`
}

/** Each task's place in the list, by the first bundle it serves. */
function ranksOf(pr: Problem, w: World): Int32Array {
  const ranks = new Int32Array(pr.tasks.length).fill(-1)
  const ranked = w.visits.map((v, i) => ({ rank: v.rank, task: pr.visitTask[i] })).filter((v) => v.rank >= 0 && v.task >= 0)
  for (const { rank, task } of ranked.sort((a, b) => a.rank - b.rank)) if (ranks[task] < 0) ranks[task] = rank
  return ranks
}

/** The tasks in the order the old route meets them, coming round from where the new route starts, which is where its drive will begin. */
function oldOrder(w: World, pr: Problem, mx: Matrix): Int32Array {
  const { matched } = w.audit
  const fromStart = [...matched.slice(w.startSample), ...matched.slice(0, w.startSample)]
  return oldSequence(pr, mx, fromStart, (p, s) => edgeAt(w.byPiece, p, s), w.edges.length)
}

/** Where the search starts. If the network can't be built, which only an odd map would do, the old route's own order is as good a start. */
function shortestStart(w: World, pr: Problem, mx: Matrix): Int32Array {
  try {
    return networkStart(pr, mx, w.edges)
  } catch {
    return oldOrder(w, pr, mx)
  }
}

/** Runs the search for as long as the budget lets it, and gives the cheapest tour of all its runs. */
function search(w: World, pr: Problem, mx: Matrix, keepOrder: boolean, budget: Budget, clock: () => number, deadline: number, tableMs: number, onProgress?: OnProgress): Tour {
  const { iterations } = budget
  const near = nearTable(mx)
  const ranks = keepOrder ? ranksOf(pr, w) : undefined
  const start = ranks ? orderedStart(pr, mx, oldOrder(w, pr, mx), ranks) : shortestStart(w, pr, mx)
  const heats = keepOrder ? KEEP_ORDER_HEATS : SHORTEST_HEATS
  const firstSeed = budget.seed ?? FIRST_SEED
  const runs = Array.from({ length: SEEDS }, (_, s) => heats.map((heat) => ({ heat, seed: firstSeed + s }))).flat()
  const finish = tableMs * FINISH_TABLE_SHARE + w.matchMs * FINISH_MATCH_SHARE + FINISH_MS
  const tours = runs.map((run, i) => {
    const from = clock()
    const share = (deadline - finish - from) / (runs.length - i)
    const used = (moves: number) => {
      const part = iterations ? moves / iterations : share > 0 ? (clock() - from) / share : 1
      if ((moves & (TELL_EVERY_MOVES - 1)) === 0) onProgress?.({ step: 'Looking for a better drive', done: 0.15 + (0.7 * (i + Math.min(part, 1))) / runs.length })
      return part
    }
    return anneal(pr, mx, near, { ...run, start, ranks, used })
  })
  return tours.reduce((a, b) => (b.cost < a.cost ? b : a))
}

/** The stops that have to stay on the route and no longer are. A bundle or a request gets its own stretch, so this is a last check that it held. */
function stopsLeftOff(route: Route, points: BuiltRoute['points']): Stop[] {
  const stops = [...route.stops.filter((s) => s.type === 'bundle'), ...otherVisits(route.stops)]
  const oldOff = pathDistancer(route.points)
  const newOff = pathDistancer(points)
  return stops.filter((s) => newOff(s) > Math.max(STOP_REACH_M, oldOff(s) + STOP_DRIFT_M))
}

/** What to call a stop in a reason: a bundle as the list does, anything else by the first thing it has to go by. */
const stopName = (s: Stop): string => (s.type === 'bundle' ? bundleNameOf(s) : (s.label?.trim() || s.address?.trim() || s.note?.trim() || 'A stop'))

/** What becomes of the bundle list on the new route. */
function bundleOutcome(w: World, built: BuiltRoute, keepOrder: boolean): BundleOutcome {
  const newLine = { points: built.points, stops: w.route.stops }
  const ids = (keepOrder ? w.order : w.list).map((b) => b.id)
  const named = (id: string): BundleName => w.list.find((b) => b.id === id) ?? { id, name: id }
  const walk = walkList(bundlePasses(newLine), ids)
  const drive = driverList(newLine, undefined)
  const sameAs = (a: BundleName[], b: BundleName[]) => a.length === b.length && a.every((x, i) => x.id === b[i].id)
  const after = keepOrder ? w.order : drive
  return {
    before: w.list,
    after,
    changed: !sameAs(w.list, after),
    fits: walk.stranded.length === 0,
    stranded: walk.stranded.map(named),
    // A kept list has to be written down unless the new drive reaches the bundles in that order of itself.
    store: keepOrder && (w.orderSet || !sameAs(w.order, drive)) ? ids : null,
  }
}

/** The streets the search had to leave out. */
const cutOff = (w: World, pr: Problem): string[] => [...new Set(pr.unreachable.map((u) => streetName(w.edges[u.edge])))]

/** Why Accept can't be offered, from the finished route and nothing the solver said about it. */
export function blockers(w: World, pr: Problem, view: Pick<PreparedView, 'unmatched'>, built: BuiltRoute, after: Audit, gaps: OptimiseResult['gaps'], bundles: BundleOutcome, keepOrder: boolean): string[] {
  const out: string[] = []
  for (const part of view.unmatched) {
    if (part.thrown && part.m >= COVER_GATE_M) out.push(`Part of today's route near ${part.street} isn't on any road on the map, and it is thrown at. It can't be carried over.`)
  }
  for (const name of cutOff(w, pr)) out.push(`${name} can't be reached by roads the route may use.`)
  for (const s of stopsLeftOff(w.route, built.points)) out.push(`${stopName(s)} is no longer on the route.`)
  for (const g of gaps) if (g.m >= COVER_GATE_M) out.push(`${g.street}: ${Math.round(g.m)} m that is thrown at today is not thrown at on the new route.`)
  for (const name of closedRoadsUsed(w, after)) out.push(`The new route uses ${name}, a road that isn't open to it.`)
  const onMap = onMapCheck(w.graph, built.points)
  if (after.offRoad || onMap.offRoadM >= ON_MAP_GATE_M) out.push('The new route leaves the roads on the map.')
  if (after.wrongWay || onMap.wrongWayM >= ON_MAP_GATE_M) out.push('The new route goes against a one-way.')
  if (after.bannedTurns) out.push('The new route makes a turn the map bans.')
  if (after.closesM > 0) out.push("The new route doesn't end where it starts.")
  if (keepOrder && !bundles.fits) {
    const names = bundles.stranded.map((b) => b.name).join(', ')
    out.push(`Your bundle list doesn't fit this route: it never comes back past ${names} after the bundle before it. Turn off Keep my bundle order to get a route with its own order.`)
  }
  return out
}

/**
 * What holding the list costs, when it costs something the driver can't see the reason for: a list that doesn't fit today's route, or a
 * kept route that comes out longer than today. Nothing else on the screen says why, or that the switch is the way out. One bundle has no order to hold.
 */
export function keepOrderNote(stranded: number, bundles: number, overKm: number): string | null {
  const longer = Number(overKm.toFixed(1)) > 0
  if (bundles < 2 || (!stranded && !longer)) return null
  const why = stranded ? `${stranded} of your ${bundles} bundles can't be reached in list order on today's route.` : `Your ${bundles} bundles are kept in list order.`
  const cost = longer ? ` This route comes out ${overKm.toFixed(1)} km longer than today.` : ''
  return `${why}${cost} Turn off Keep my bundle order to get the shortest route.`
}

/** A line for the parts of today's route on no road that don't block Accept. */
export function offMapNote(parts: Pick<UnmatchedPart, 'm'>[]): string | null {
  if (!parts.length) return null
  const size = parts.every((u) => u.m < COVER_GATE_M) ? 'short ' : ''
  return `${parts.length} ${size}part${parts.length === 1 ? '' : 's'} of today's route ${parts.length === 1 ? "isn't" : "aren't"} on any road on the map.`
}

/** The notes for a finished run. */
function notesOf(w: World, pr: Problem, view: PreparedView, keepOrder: boolean, after: RouteStats): string[] {
  const forced = new Map<string, number>()
  for (const f of pr.forced) {
    const name = streetName(w.edges[f.edge])
    forced.set(name, (forced.get(name) ?? 0) + f.len)
  }
  const notes = [...view.notes]
  for (const [name, m] of forced) notes.push(`${name}: ${Math.round(m)} m can only be thrown from the starboard side, as it is one-way.`)
  const parts = offMapNote(view.unmatched.filter((u) => !u.thrown || u.m < COVER_GATE_M))
  if (parts) notes.push(parts)
  const kept = keepOrder ? keepOrderNote(w.strandedToday, w.order.length, after.closedKm - view.before.closedKm) : null
  if (kept) notes.push(kept)
  return notes
}

/**
 * The whole drive for the best order. An order the search kept to can leave two tasks with no way between them, as with a banned turn
 * where the list has it go straight on. It is the list that can't be met, so that's what the driver hears, with the way past it.
 */
function driveOf(w: World, pr: Problem, mx: Matrix, seq: Int32Array, keepOrder: boolean): Leg[] {
  try {
    return expand(pr, mx, seq)
  } catch (e) {
    if (!keepOrder || w.order.length < 2) throw e
    throw new Error("Your bundle list can't be kept on the roads this route may use. Turn off Keep my bundle order to get a route with its own order.")
  }
}

/** The drive as a route: its sides on its passes, then smoothed, then points. */
function routeOf(w: World, pr: Problem, run: Leg[], choices: OptimiseChoices): BuiltRoute {
  const raw = assignSides(pr, run, w.edges)
  return buildRoute(w.graph, pr, run, w.edges, smoothSides(pr, run, w.edges, raw, optionsFor(w, choices).allow))
}

/** Why there's nothing to serve. A route with nothing on the map to serve has papers to throw all the same, so it mustn't be told it hasn't. */
function nothingReason(view: PreparedView, cut: string[]): string {
  if (cut.length) return `${cut.join(', ')} can't be reached by roads the route may use.`
  if (view.unmatched.some((u) => u.thrown)) return "The part of today's route that is thrown at isn't on any road on the map, so there is nothing to optimise."
  return 'This route has no streets thrown at and no stops to keep, so there is nothing to optimise.'
}

/** With nothing to serve there's no drive to find, so the old route stands and Accept stays closed. */
function nothingToDo(prepared: Prepared, keepOrder: boolean, pr: Problem): OptimiseResult {
  const { view, world: w } = prepared
  const { route } = w
  return {
    route: { points: route.points, sideChanges: route.sideChanges },
    before: view.before,
    after: view.before,
    keepOrder,
    gaps: [],
    gapKm: 0,
    newRoads: [],
    newRoadKm: 0,
    turnBacks: [],
    blocked: [nothingReason(view, cutOff(w, pr))],
    notes: view.notes,
    worthChecking: [],
    bundles: { before: w.list, after: w.list, changed: false, fits: true, stranded: [], store: w.orderSet ? w.list.map((b) => b.id) : null },
    streets: [],
    basedOn: view.basedOn,
  }
}

/** The second step: finds a new drive for the driver's choices and checks it. Nothing here changes `prepared`, so it can be run again with other choices. */
export function solve(prepared: Prepared, choices: OptimiseChoices, budget: Budget = {}, onProgress?: OnProgress): OptimiseResult {
  const { view, world: w } = prepared
  const clock = wakingClock(budget.clock ?? Date.now)
  const deadline = clock() + (budget.ms ?? DEFAULT_BUDGET_MS)
  onProgress?.({ step: 'Setting up the streets', done: 0 })
  const pr = makeProblem(w.nodes.length, w.edges, optionsFor(w, choices), w.depot)
  if (!pr.tasks.length) return nothingToDo(prepared, choices.keepOrder, pr)
  const tableFrom = clock()
  const mx = buildMatrix(pr, (done) => {
    // Read as it goes, as a long table on a slow phone is time spent, and one step that long would look like the phone asleep.
    clock()
    onProgress?.({ step: 'Working out the ways between streets', done: 0.02 + done * 0.13 })
  })
  const best = search(w, pr, mx, choices.keepOrder, budget, clock, deadline, clock() - tableFrom, onProgress)
  onProgress?.({ step: 'Building the route', done: 0.86 })
  const run = driveOf(w, pr, mx, best.seq, choices.keepOrder)
  const built = routeOf(w, pr, run, choices)
  const after = auditRoute(w.graph, built, w.banned, (done) => onProgress?.({ step: 'Checking the new route', done: 0.88 + done * 0.1 }))
  const gaps = gapsOf(w, pr, after)
  const roads = newRoadsOf(w, after)
  const bundles = bundleOutcome(w, built, choices.keepOrder)
  const blocked = blockers(w, pr, view, built, after, gaps, bundles, choices.keepOrder)
  const stats = routeStats(built, after, 0)
  onProgress?.({ step: 'Done', done: 1 })
  return {
    route: built,
    before: view.before,
    after: stats,
    keepOrder: choices.keepOrder,
    gaps,
    gapKm: gaps.reduce((a, g) => a + g.m, 0) / 1000,
    newRoads: roads.roads,
    newRoadKm: roads.km,
    turnBacks: turnBacksOf(w, pr, run),
    blocked,
    notes: notesOf(w, pr, view, choices.keepOrder, stats),
    worthChecking: worthChecking(gaps, oneSidedStretches(w)),
    bundles,
    streets: turnStreets(w.graph, built.points),
    basedOn: view.basedOn,
  }
}
