import { cumulativeDistances, haversine, occurrences, type Occurrence } from '../geo'
import { pointAt, routeTurns, turnKind } from '../turns'
import type { Pt, Route, SavedRoute, Stop } from '../types'
import { auditRoute, type Audit } from './audit'
import { wakingClock } from './clock'
import { CELL_M, dropIslands, edgesOf, type Cover, type Edge } from './demand'
import { bannedTurns, buildGraph, dist, toPt, toXY, type BannedTurn, type Graph, type XY } from './graph'
import { bundlePasses, byFirstPass, driverList, otherVisits, walkList, type ListWalk } from './list'
import { arcDijkstra, FRESH_ROAD_FACTOR, makeProblem, STARBOARD_BIAS, type Options, type Visit } from './problem'
import { startOf } from './run'
import { angleOff, type Sample } from './match'
import type { BundleName, OnProgress, OptimiseChoices, OsmData, StartPoint, StreetChoice, UnmatchedPart } from './types'

export { startOf }

/** Everything the solver needs from the saved route and the map. It stays in the worker between the two steps. */

const MAIN_HIGHWAYS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'])
const BUSY_HIGHWAYS = new Set([...MAIN_HIGHWAYS, 'tertiary', 'tertiary_link'])

/** Ends of a route this close, in metres, are the same place: the route closes. */
export const CLOSED_M = 1
/** How many of the nodes nearest the start are tried as the place to start from. */
const DEPOT_TRIES = 12
/** A pass's sample is looked for this many route segments either side of it... */
const VISIT_SEGMENTS = 2
/** ...and if that part of the route is on no road, anywhere this near it, in metres. */
const VISIT_REACH_M = 60
/** A sample heading within this of a pass's own segment, in radians, is going the pass's way, and not back the other way along the road. */
const SAME_WAY = Math.PI / 2

/** The key and the name of a road with no name. */
const UNNAMED_MAIN = '~main'
const UNNAMED = '~plain'
export const NO_NAME = 'Road with no name'

export interface World {
  graph: Graph
  route: Route
  /** The old route, measured. */
  audit: Audit
  nodes: XY[]
  edges: Edge[]
  byPiece: Map<number, Edge[]>
  depot: number
  start: StartPoint
  mainNames: Set<string>
  busyNames: Set<string>
  banned: BannedTurn[]
  /** Rules the map has that the graph can't use. */
  unreadRules: number
  /** The driver's list as it stands today, and whether the driver set it. */
  list: BundleName[]
  orderSet: boolean
  /**
   * The list a run works to. It is `list`, but for a list the driver never set, which is only the order the old route happens to meet the
   * bundles in from its first point: a drive from a Start part way round meets them from there, and comes round.
   */
  order: BundleName[]
  /** The stops to keep, each on the pass of it the run's list takes along the old route, read from where the run starts: see `visitsOf`. */
  visits: Visit[]
  /**
   * The same stops for a run that keeps no order, each on the pass of it today's list takes from the old route's first point, as the driver drives it
   * now. Such a run is held to a bundle's way round only where starboard is off, and that has to be today's way round, not the way of a later pass
   * that a list read round from a Start part way along happens to take. It is `visits` when the two walks are the same.
   */
  freeVisits: Visit[]
  /** How many bundles the list leaves behind on the old route itself: it has no pass of them after the one before them. */
  strandedToday: number
  /** The sample of the old route nearest the start, where a drive from the start picks up its order. */
  startSample: number
  /** Where the old route turns right back. */
  turnsToday: Pt[]
  /** How long matching the old route took, in ms: matching the new one takes about the same, and it has to fit in the budget. */
  matchMs: number
}

export const isMain = (w: Pick<World, 'mainNames'>, e: Pick<Edge, 'name' | 'highway'>): boolean => (!!e.name && w.mainNames.has(e.name)) || MAIN_HIGHWAYS.has(e.highway)
export const isBusy = (w: Pick<World, 'busyNames'>, e: Pick<Edge, 'name' | 'highway'>): boolean => (!!e.name && w.busyNames.has(e.name)) || BUSY_HIGHWAYS.has(e.highway)
export const streetKey = (w: Pick<World, 'mainNames'>, e: Pick<Edge, 'name' | 'highway'>): string => e.name ?? (isMain(w, e) ? UNNAMED_MAIN : UNNAMED)
export const streetName = (e: Pick<Edge, 'name'>): string => e.name ?? NO_NAME

/** The edges of each piece, in order along it. */
function edgesByPiece(edges: Edge[]): Map<number, Edge[]> {
  const out = new Map<number, Edge[]>()
  for (const e of edges) {
    const list = out.get(e.piece)
    if (list) list.push(e)
    else out.set(e.piece, [e])
  }
  return out
}

/** The edge at a place along a piece. */
export function edgeAt(byPiece: Map<number, Edge[]>, piece: number, s: number): Edge | undefined {
  const list = byPiece.get(piece) ?? []
  let run = 0
  for (const e of list) {
    if (s <= run + e.len + 1e-6) return e
    run += e.len
  }
  return list[list.length - 1]
}

/** May a leg use this edge? A public road with no barrier, or a road the old route drove. */
const mayUse = (g: Graph, e: Edge) => e.driven > 0 || g.pieces[e.piece].open

/** The node nearest a place, of those a leg may use. */
function nearestNode(g: Graph, nodes: XY[], edges: Edge[], at: XY): number {
  const usable = new Uint8Array(nodes.length)
  for (const e of edges) {
    if (!mayUse(g, e)) continue
    usable[e.u] = 1
    usable[e.v] = 1
  }
  let best = -1
  let bestD = Infinity
  for (let n = 0; n < nodes.length; n++) {
    if (!usable[n]) continue
    const d = dist(nodes[n], at)
    if (d < bestD) {
      bestD = d
      best = n
    }
  }
  return best
}

/** Whether every stretch to throw at can be got to from a node and back to it, along the roads a leg may use, one-ways counted. */
function servesAll(g: Graph, nodes: XY[], edges: Edge[], from: number): boolean {
  const ahead: number[][] = nodes.map(() => [])
  const behind: number[][] = nodes.map(() => [])
  for (const e of edges) {
    if (!mayUse(g, e)) continue
    if (e.oneway >= 0) {
      ahead[e.u].push(e.v)
      behind[e.v].push(e.u)
    }
    if (e.oneway <= 0) {
      ahead[e.v].push(e.u)
      behind[e.u].push(e.v)
    }
  }
  const reach = (next: number[][]) => {
    const seen = new Uint8Array(nodes.length)
    seen[from] = 1
    const stack = [from]
    while (stack.length) {
      for (const to of next[stack.pop() as number]) {
        if (seen[to]) continue
        seen[to] = 1
        stack.push(to)
      }
    }
    return seen
  }
  const out = reach(ahead)
  const back = reach(behind)
  return edges.every((e) => (!e.reqL && !e.reqR) || (e.oneway >= 0 && out[e.u] && back[e.v]) || (e.oneway <= 0 && out[e.v] && back[e.u]))
}

/**
 * Where the new route starts and ends: the nearest node to the start that the whole round can be driven from. The very nearest may be the
 * tip of a one-way or a stray bit of road, and everything would then read as cut off, so a few are tried before giving up on the nearest.
 */
function depotNear(g: Graph, nodes: XY[], edges: Edge[], at: XY): number {
  const usable = new Set<number>()
  for (const e of edges) {
    if (!mayUse(g, e)) continue
    usable.add(e.u)
    usable.add(e.v)
  }
  const nearest = [...usable].sort((a, b) => dist(nodes[a], at) - dist(nodes[b], at) || a - b).slice(0, DEPOT_TRIES)
  return nearest.find((n) => servesAll(g, nodes, edges, n)) ?? nearest[0] ?? -1
}

/**
 * The sample at the place a pass comes closest to its stop, of those on a road: on that part of the route if it can be, going the way the
 * pass does if it can be, or anywhere near it. Where the route goes into a court or a stub and straight back out, the other leg runs back
 * over the same road a segment or two away, and its samples lie as near the stop as the pass's own, or nearer, as samples fall every few
 * metres. Taking one of those would give the stop the other leg's way round, and a bundle the list takes on the way in would then be held
 * to the way out, so that keep order has to send the driver back up the court for it.
 */
function sampleOfPass(audit: Audit, route: Route, cum: number[], pass: Occurrence, g: Graph): number {
  const a = toXY(g, route.points[pass.idx])
  const b = toXY(g, route.points[pass.idx + 1] ?? route.points[pass.idx])
  const span = (cum[pass.idx + 1] ?? cum[pass.idx]) - cum[pass.idx]
  const t = span > 0 ? (pass.at - cum[pass.idx]) / span : 0
  const foot: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  const heading = Math.atan2(b[0] - a[0], b[1] - a[1])
  const nearest = (fits: (q: Sample) => boolean) => {
    let best = -1
    let bestD = Infinity
    audit.samples.forEach((q, i) => {
      const d = dist(q.at, foot)
      if (audit.matched[i].piece >= 0 && d < bestD && fits(q)) {
        bestD = d
        best = i
      }
    })
    return best
  }
  const near = (q: Sample) => Math.abs(q.seg - pass.idx) <= VISIT_SEGMENTS
  const sameWay = span > 0 ? nearest((q) => near(q) && angleOff(q.heading, heading) <= SAME_WAY) : -1
  if (sameWay >= 0) return sameWay
  const close = nearest(near)
  return close >= 0 ? close : nearest((q) => dist(q.at, foot) <= VISIT_REACH_M)
}

/** The first pass of each stop that has to stay on the route but isn't in the list. */
function firstPasses(route: Route, stops: Stop[]): Occurrence[] {
  const seen = new Set<string>()
  return occurrences({ points: route.points, stops }).filter((o) => {
    if (seen.has(o.stop.id)) return false
    seen.add(o.stop.id)
    return true
  })
}

/** A visit, and the place on the map it came from. */
export interface PlacedVisit extends Visit {
  piece: number
  s: number
}

/** The sample of the old route nearest the start, of those on a road. With no section called Start, a run starts where the old route does. */
function sampleAtStart(audit: Audit, start: StartPoint, at: XY): number {
  if (start.section === null) return 0
  let best = 0
  let bestD = Infinity
  audit.samples.forEach((q, i) => {
    const d = dist(q.at, at)
    if (audit.matched[i].piece >= 0 && d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

/** Metres along the old route as a drive from one of its samples reads them, coming round past the end to the start of it. */
function aroundFrom(route: Route, audit: Audit, g: Graph, sample: number): (at: number) => number {
  if (sample === 0) return (at) => at
  const cum = cumulativeDistances(route.points)
  const { seg, at: place } = audit.samples[sample]
  const from = cum[seg] + haversine(route.points[seg], toPt(g, place))
  const total = cum[cum.length - 1]
  return (at) => (at >= from ? at - from : at + total - from)
}

/** The list a run works to, and how it lies along the old route, read from where the run starts. See `World.order`. */
interface OldWalk {
  order: BundleName[]
  /** The passes in the order the walk took them. */
  passes: Occurrence[]
  walk: ListWalk
}

function walkOfOldRoute(route: Route, list: BundleName[], orderSet: boolean, around: (at: number) => number): OldWalk {
  const all = bundlePasses(route)
  if (orderSet) return { order: list, passes: all, walk: walkList(all, list.map((b) => b.id)) }
  const at = (o: Occurrence) => around(o.at)
  const passes = [...all].sort((a, b) => at(a) - at(b))
  const order = byFirstPass(list, passes, at)
  return { order, passes, walk: walkList(passes, order.map((b) => b.id), at) }
}

/**
 * The stops to keep, each on the pass of it the old route's list takes: walking the list along the old route gives each bundle a pass, and
 * that pass gives its stretch, its way round and its rank. A list the old route can't itself be driven in leaves a bundle with no such
 * pass. It keeps its last pass, and the fit check on the new route has the last word.
 */
function visitsOf(route: Route, audit: Audit, g: Graph, byPiece: Map<number, Edge[]>, { order, passes, walk }: OldWalk): PlacedVisit[] {
  const cum = cumulativeDistances(route.points)
  const visits: PlacedVisit[] = []
  const add = (pass: Occurrence | undefined, rank: number) => {
    if (!pass) return
    const at = sampleOfPass(audit, route, cum, pass, g)
    if (at < 0) return
    const m = audit.matched[at]
    const e = edgeAt(byPiece, m.piece, m.s)
    if (e) visits.push({ edge: e.id, dir: m.dir, rank, piece: m.piece, s: m.s })
  }
  order.forEach((b, rank) => add(walk.picks.get(b.id) ?? passes.filter((o) => o.stop.id === b.id).pop(), rank))
  for (const pass of firstPasses(route, otherVisits(route.stops))) add(pass, -1)
  return visits
}

/**
 * Where to cut a stretch so that bundles that need a pass each get one. A stretch is one task, driven once, so two bundles on it go by
 * together, in the order they lie along it the way it is driven. That can't be right when another bundle comes between them in the list,
 * or when the list has the second of them first: the one after has to wait for a pass that comes later, as the old route's did. Cut half
 * way between them, each has a stretch and a place in the order of its own. The bundles are taken in their order along the stretch, not
 * in the list's, so that one round of cuts leaves every piece holding only bundles that follow on in the list in the order they are
 * passed: in the list's order, a pair next to each other in it but passed the wrong way round would be left together, and a bundle
 * between them along the stretch would be cut from only one of them. Two bundles at the one spot can't be told apart this way, and the
 * fit check gives the honest answer for those.
 */
export function secondPassCuts(visits: readonly PlacedVisit[]): Map<number, Set<number>> {
  const groups = new Map<string, PlacedVisit[]>()
  for (const v of visits) {
    if (v.rank < 0) continue
    const key = `${v.edge}:${v.dir}`
    const group = groups.get(key)
    if (group) group.push(v)
    else groups.set(key, [v])
  }
  const cuts = new Map<number, Set<number>>()
  for (const group of groups.values()) {
    // A group is all one way along its stretch, so `s * dir` is how far along the drive each is. Two at the one spot go in the list's order.
    const alongDrive = [...group].sort((a, b) => a.s * a.dir - b.s * b.dir || a.rank - b.rank)
    for (let i = 1; i < alongDrive.length; i++) {
      const a = alongDrive[i - 1]
      const b = alongDrive[i]
      if (b.rank === a.rank + 1) continue
      const cell = Math.round((a.s + b.s) / 2 / CELL_M)
      if (cell * CELL_M <= Math.min(a.s, b.s) || cell * CELL_M >= Math.max(a.s, b.s)) continue
      const piece = cuts.get(a.piece)
      if (piece) piece.add(cell)
      else cuts.set(a.piece, new Set([cell]))
    }
  }
  return cuts
}

/** The parts of a route on no road, each as long as the samples say. */
export function unmatchedParts(g: Graph, audit: Audit): UnmatchedPart[] {
  const { samples, matched } = audit
  const out: UnmatchedPart[] = []
  for (let i = 0; i < samples.length; i++) {
    if (matched[i].piece >= 0) continue
    let e = i
    while (e + 1 < samples.length && matched[e + 1].piece < 0) e++
    const near = matched[i - 1] ?? matched[e + 1]
    const middle = samples[(i + e) >> 1]
    out.push({
      ...toPt(g, middle.at),
      m: samples[Math.min(e + 1, samples.length - 1)].along - samples[Math.max(i - 1, 0)].along,
      thrown: samples.slice(i, e + 1).some((s) => s.side !== 'transit'),
      street: near && near.piece >= 0 ? (g.pieces[near.piece].name ?? NO_NAME) : NO_NAME,
    })
    i = e
  }
  return out
}

/** Where a route turns right back, as the app reads it. */
function uturnPlaces(points: Pt[]): Pt[] {
  const cum = cumulativeDistances(points)
  return routeTurns(points).filter((t) => turnKind(t.angle) === 'uturn').map((t) => pointAt(points, cum, t.at))
}

/** The edges the old route's cover makes, with any cuts asked for, and what goes with them. */
function edgesFor(g: Graph, cover: Cover[], start: StartPoint, cuts?: Map<number, Set<number>>) {
  const { nodes, edges } = edgesOf(g, cover, cuts)
  dropIslands(g, edges)
  const depot = depotNear(g, nodes, edges, toXY(g, start))
  if (depot < 0) throw new Error('The map has no road this route can use.')
  return { nodes, edges, byPiece: edgesByPiece(edges), depot }
}

/** What the map and the saved route together make, up to the street choices. */
export function makeWorld(saved: SavedRoute, osm: OsmData, onProgress?: OnProgress): World {
  const { route } = saved
  const { points } = route
  if (points.length < 2) throw new Error('This route is too short to optimise.')
  onProgress?.({ step: 'Reading the map', done: 0 })
  const graph = buildGraph(osm, { lat0: points[0].lat, lng0: points[0].lng })
  if (!graph.pieces.length) throw new Error('The map has no roads for this route.')
  const { banned, unread } = bannedTurns(graph, osm)
  onProgress?.({ step: 'Matching the route to the map', done: 0.1 })
  const clock = wakingClock(Date.now)
  const startedAt = clock()
  const audit = auditRoute(graph, route, banned, (done) => {
    // Read as it goes, so that the phone locking during the match isn't taken for a slow phone, which would leave the search no time.
    clock()
    onProgress?.({ step: 'Matching the route to the map', done: 0.1 + done * 0.7 })
  })
  const matchMs = clock() - startedAt
  onProgress?.({ step: 'Working out which sides need papers', done: 0.8 })
  const start = startOf(saved)
  const mainNames = new Set<string>()
  const busyNames = new Set<string>()
  for (const p of graph.pieces) {
    if (!p.name) continue
    if (MAIN_HIGHWAYS.has(p.highway)) mainNames.add(p.name)
    if (BUSY_HIGHWAYS.has(p.highway)) busyNames.add(p.name)
  }
  const list = driverList(route, saved.bundleOrder)
  const orderSet = !!saved.bundleOrder?.length
  const startSample = sampleAtStart(audit, start, toXY(graph, start))
  const oldWalk = walkOfOldRoute(route, list, orderSet, aroundFrom(route, audit, graph, startSample))
  // A list the driver set is walked from the first point whatever the start, and so is any list when the run starts there.
  const todayWalk = orderSet || startSample === 0 ? oldWalk : walkOfOldRoute(route, list, orderSet, (at) => at)
  const uncut = edgesFor(graph, audit.cover, start)
  const first = visitsOf(route, audit, graph, uncut.byPiece, oldWalk)
  const cuts = secondPassCuts(first)
  const streets = cuts.size ? edgesFor(graph, audit.cover, start, cuts) : uncut
  const visits = cuts.size ? visitsOf(route, audit, graph, streets.byPiece, oldWalk) : first
  const freeVisits = todayWalk === oldWalk ? visits : visitsOf(route, audit, graph, streets.byPiece, todayWalk)
  return {
    graph,
    route,
    audit,
    ...streets,
    start,
    mainNames,
    busyNames,
    banned,
    unreadRules: unread,
    list,
    orderSet,
    order: oldWalk.order,
    visits,
    freeVisits,
    strandedToday: oldWalk.walk.stranded.length,
    startSample,
    turnsToday: uturnPlaces(points),
    matchMs,
  }
}

/** The street list for the choices screen: main roads first, then the rest by name, with the roads that have no name last of each. */
export function streetChoices(w: World): StreetChoice[] {
  const byKey = new Map<string, StreetChoice>()
  for (const e of w.edges) {
    if (!e.reqL && !e.reqR) continue
    const key = streetKey(w, e)
    const main = isMain(w, e)
    const street = byKey.get(key)
    if (street) street.km += e.len / 1000
    else byKey.set(key, { key, name: streetName(e), km: e.len / 1000, main, allowed: !main })
  }
  const rank = (s: StreetChoice) => (s.main ? 0 : 1)
  return [...byKey.values()].sort((a, b) => rank(a) - rank(b) || Number(a.name === NO_NAME) - Number(b.name === NO_NAME) || a.name.localeCompare(b.name))
}

/** What the search works to, for the driver's choices. */
export function optionsFor(w: World, choices: Pick<OptimiseChoices, 'allowed' | 'keepOrder'>): Options {
  return {
    allow: (e) => choices.allowed[streetKey(w, e)] ?? !isMain(w, e),
    may: (e) => mayUse(w.graph, e),
    main: (e) => isMain(w, e),
    busy: (e) => isBusy(w, e),
    weight: (e) => (e.driven > 0 ? 1 : FRESH_ROAD_FACTOR),
    way: (e) => w.graph.pieces[e.piece].way,
    banned: w.banned,
    visits: choices.keepOrder ? w.visits : w.freeVisits,
    keepOrder: choices.keepOrder,
    rightBias: STARBOARD_BIAS,
  }
}

/** The way home from the old route's end to its first point, by road, in km: 0 when it closes, and the straight line if the map has no way. */
export function closingKm(w: World): number {
  const { points } = w.route
  const first = points[0]
  const last = points[points.length - 1]
  const straight = haversine(first, last)
  if (straight < CLOSED_M) return 0
  const home = nearestNode(w.graph, w.nodes, w.edges, toXY(w.graph, first))
  const end = nearestNode(w.graph, w.nodes, w.edges, toXY(w.graph, last))
  if (home === end) return 0
  const pr = makeProblem(w.nodes.length, w.edges, { ...optionsFor(w, { allowed: {}, keepOrder: false }), weight: () => 1, visits: [], rightBias: 0 }, home)
  const d = new Float64Array(pr.arcs.length)
  const pre = new Int32Array(pr.arcs.length)
  arcDijkstra(pr, -1, end, d, pre)
  let best = Infinity
  for (const a of pr.arcs) if (a.to === home && d[a.id] < best) best = d[a.id]
  return (best === Infinity ? straight : best) / 1000
}
