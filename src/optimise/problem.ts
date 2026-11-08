import type { Edge } from './demand'
import type { BannedTurn } from './graph'
import { MinHeap } from './heap'

/**
 * A mixed rural postman over the street edges. A task is a stretch of street to serve, and a tour is an order of tasks, each with a way
 * to drive it. Costs are in metres, but they are not the km shown: they carry what a driver would rather avoid as well.
 */

/** Turning back costs this, as a distance in metres, on a plain street. */
export const UTURN_M = 40
/** What counts as turning back where you can't: at any node touching a main road, short of a true dead end. */
export const NO_UTURN_M = 4000
/** Turning back at a junction with a busier through road is allowed, but worth avoiding. */
export const BUSY_UTURN_M = 200
/** A road the old route never drove costs this many times its length, so the driver isn't sent somewhere new for a few metres. */
export const FRESH_ROAD_FACTOR = 1.25
/** A one-sided street driven with its side on the starboard costs this much more of its length: allowed, but a pass with it to port is better. */
export const STARBOARD_BIAS = 0.25
/** Stands in for "no way there" in the cost table, so the search's sums stay numbers. It is more than any real drive. */
const NO_WAY = 1e7

export interface Arc {
  id: number
  edge: number
  from: number
  to: number
  len: number
  /** The same edge the other way, or -1 on a one-way. */
  rev: number
  dir: 1 | -1
  way: number
  main: boolean
  busy: boolean
  weight: number
}

export interface Task {
  id: number
  edge: number
  /** The arcs that serve it: both ways on a street where either will do. */
  options: number[]
}

/** A stop that has to stay on the route, on a stretch and a way round. `rank` is its place in the bundle list, or -1 when it has none. */
export interface Visit {
  edge: number
  dir: 1 | -1
  rank: number
}

/** A stretch of street the search has something to report about. */
export interface EdgeNote {
  edge: number
  len: number
}

export interface Problem {
  nodes: number
  arcs: Arc[]
  out: number[][]
  tasks: Task[]
  depot: number
  deadEnd: Uint8Array
  banned: Set<string>
  bannedAt: Uint8Array
  bias: Float64Array
  /** What turning back costs at each node. */
  uturnAt: Float64Array
  /** The task each visit is served by, or -1 when that task had to be left out. */
  visitTask: number[]
  /** Stretches a one-way forces to be thrown from the starboard. */
  forced: EdgeNote[]
  /** Stretches no road the route may use can reach and come back from, so they were left out of the search. */
  unreachable: EdgeNote[]
}

export interface Options {
  /** May this edge be thrown starboard or both? */
  allow: (e: Edge) => boolean
  /** May a leg use this edge at all? */
  may: (e: Edge) => boolean
  main: (e: Edge) => boolean
  busy: (e: Edge) => boolean
  way: (e: Edge) => number
  /** How many times its length this edge costs. */
  weight: (e: Edge) => number
  banned: BannedTurn[]
  visits: Visit[]
  /** Hold the driver's bundle order: see `heldWays`. */
  keepOrder: boolean
  rightBias: number
}

const turnKey = (from: number, via: number, to: number) => `${from}:${via}:${to}`

/** Whether a move from one arc to the next is banned. A rule from a way back onto itself is a ban on turning back, not on going straight on. */
export function turnBanned(pr: Pick<Problem, 'banned' | 'bannedAt'>, a: Arc, b: Arc): boolean {
  return pr.bannedAt[a.to] === 1 && pr.banned.has(turnKey(a.way, a.to, b.way)) && (a.way !== b.way || a.rev === b.id)
}

function makeArcs(edges: Edge[], opt: Options): { arcs: Arc[]; forward: Int32Array; backward: Int32Array } {
  const arcs: Arc[] = []
  const forward = new Int32Array(edges.length).fill(-1)
  const backward = new Int32Array(edges.length).fill(-1)
  for (const e of edges) {
    if (!opt.may(e)) continue
    const way = opt.way(e)
    const main = opt.main(e)
    const busy = opt.busy(e)
    const weight = e.len * opt.weight(e)
    let f = -1
    if (e.oneway >= 0) {
      f = arcs.length
      arcs.push({ id: f, edge: e.id, from: e.u, to: e.v, len: e.len, rev: -1, dir: 1, way, main, busy, weight })
      forward[e.id] = f
    }
    if (e.oneway <= 0) {
      const b = arcs.length
      arcs.push({ id: b, edge: e.id, from: e.v, to: e.u, len: e.len, rev: f, dir: -1, way, main, busy, weight })
      backward[e.id] = b
      if (f >= 0) arcs[f].rev = b
    }
  }
  return { arcs, forward, backward }
}

/**
 * What it costs to turn back at each node. A dead end is a node with one way in and that same street out, driven the other way: turning
 * there is what it's for, so it stays cheap even on a main road.
 */
function uturnCosts(nodes: number, arcs: Arc[], out: number[][]): { deadEnd: Uint8Array; uturnAt: Float64Array } {
  const degree = new Int32Array(nodes)
  for (const a of arcs) {
    degree[a.from]++
    degree[a.to]++
  }
  const deadEnd = new Uint8Array(nodes)
  // Two one-ways end to end have the same count at their node, one in and one out, and there is no turning back there.
  for (let n = 0; n < nodes; n++) if (out[n].length === 1 && degree[n] === 2 && arcs[out[n][0]].rev >= 0) deadEnd[n] = 1
  const uturnAt = new Float64Array(nodes).fill(UTURN_M)
  for (const a of arcs) {
    for (const n of [a.from, a.to]) {
      if (deadEnd[n]) continue
      if (a.main) uturnAt[n] = NO_UTURN_M
      else if (a.busy && uturnAt[n] < BUSY_UTURN_M) uturnAt[n] = BUSY_UTURN_M
    }
  }
  return { deadEnd, uturnAt }
}

/**
 * The ways round an allowed street's edge has to be held to keep the bundle list. One undirected task is one pass, either way round. Two
 * bundles on it come in the wrong order driven the other way, so it's held to the way they were passed; bundles passed going each way
 * need a pass each way. An edge with no entry takes the one undirected task.
 */
function heldWays(opt: Options, edges: Edge[]): Map<number, Set<1 | -1>> {
  if (!opt.keepOrder) return new Map()
  const ranked = new Map<number, Visit[]>()
  for (const v of opt.visits) {
    if (v.rank < 0 || !opt.allow(edges[v.edge])) continue
    const list = ranked.get(v.edge)
    if (list) list.push(v)
    else ranked.set(v.edge, [v])
  }
  const held = new Map<number, Set<1 | -1>>()
  for (const [edge, list] of ranked) if (list.length > 1) held.set(edge, new Set(list.map((v) => v.dir)))
  return held
}

/** The tasks of one edge that needs throwing. Sides a one-way can't put to port are thrown from the one pass there is, and reported. */
function tasksOf(e: Edge, arcOf: (dir: 1 | -1) => number, opt: Options, held: Set<1 | -1> | undefined, forced: EdgeNote[]): number[][] {
  const f = arcOf(1)
  const b = arcOf(-1)
  if (f < 0 && b < 0) return [[]]
  if (held) {
    const list = [...held].map((dir) => [arcOf(dir)]).filter(([a]) => a >= 0)
    if (list.length) return list
  }
  if (opt.allow(e)) return [[f, b].filter((a) => a >= 0)]
  // Only ever thrown to port: the left of the edge from u to v, the right of it from v to u.
  const wanted = new Set<number>()
  for (const [need, arc, other] of [[e.reqL, f, b], [e.reqR, b, f]] as const) {
    if (!need) continue
    if (arc >= 0) wanted.add(arc)
    else {
      forced.push({ edge: e.id, len: e.len })
      wanted.add(other)
    }
  }
  return [...wanted].map((a) => [a])
}

/** Which arcs can be reached from the depot and can get back to it, under the turn rules. Anything else is cut off from the drive. */
function usableArcs(pr: Pick<Problem, 'arcs' | 'out' | 'depot' | 'banned' | 'bannedAt' | 'nodes'>): Uint8Array {
  const n = pr.arcs.length
  const seen = new Uint8Array(n)
  const stack: number[] = []
  const reach = (a: number) => {
    if (seen[a]) return
    seen[a] = 1
    stack.push(a)
  }
  for (const a of pr.out[pr.depot] ?? []) reach(a)
  while (stack.length) {
    const arc = pr.arcs[stack.pop() as number]
    for (const b of pr.out[arc.to]) if (!turnBanned(pr, arc, pr.arcs[b])) reach(b)
  }
  const into: number[][] = Array.from({ length: pr.nodes }, () => [])
  for (const a of pr.arcs) into[a.to].push(a.id)
  const back = new Uint8Array(n)
  const goBack = (a: number) => {
    if (back[a]) return
    back[a] = 1
    stack.push(a)
  }
  for (const a of into[pr.depot] ?? []) goBack(a)
  while (stack.length) {
    const arc = pr.arcs[stack.pop() as number]
    for (const p of into[arc.from]) if (!turnBanned(pr, pr.arcs[p], arc)) goBack(p)
  }
  for (let a = 0; a < n; a++) if (!back[a]) seen[a] = 0
  return seen
}

/** Everything the search needs: the arcs that may be driven, the tasks, and what each costs. */
export function makeProblem(nodeCount: number, edges: Edge[], opt: Options, depot: number): Problem {
  const { arcs, forward, backward } = makeArcs(edges, opt)
  const arcOf = (e: number, dir: 1 | -1) => (dir === 1 ? forward : backward)[e]
  const out: number[][] = Array.from({ length: nodeCount }, () => [])
  for (const a of arcs) out[a.from].push(a.id)
  const { deadEnd, uturnAt } = uturnCosts(nodeCount, arcs, out)
  const banned = new Set<string>()
  const bannedAt = new Uint8Array(nodeCount)
  for (const t of opt.banned) {
    banned.add(turnKey(t.from, t.via, t.to))
    bannedAt[t.via] = 1
  }
  const usable = usableArcs({ arcs, out, depot, banned, bannedAt, nodes: nodeCount })
  const held = heldWays(opt, edges)
  const forced: EdgeNote[] = []
  const unreachable: EdgeNote[] = []
  const tasks: Task[] = []
  const hasTask = new Set<number>()
  const addTasks = (edge: number, lists: number[][]) => {
    hasTask.add(edge)
    let any = false
    for (const options of lists) {
      const open = options.filter((a) => usable[a])
      if (!open.length) continue
      any = true
      tasks.push({ id: tasks.length, edge, options: open })
    }
    if (!any) unreachable.push({ edge, len: edges[edge].len })
  }
  for (const e of edges) {
    if (!e.reqL && !e.reqR) continue
    addTasks(e.id, tasksOf(e, (dir) => arcOf(e.id, dir), opt, held.get(e.id), forced))
  }
  // A bundle, a request or a block has to stay on the way: either way round on an allowed street, today's way round elsewhere.
  for (const v of opt.visits) {
    const e = edges[v.edge]
    if (opt.allow(e)) {
      if (!hasTask.has(e.id)) addTasks(e.id, tasksOf(e, (dir) => arcOf(e.id, dir), opt, held.get(e.id), forced))
      continue
    }
    const wanted = arcOf(e.id, v.dir)
    const arc = wanted >= 0 ? wanted : arcOf(e.id, v.dir === 1 ? -1 : 1)
    if (arc >= 0 && !tasks.some((t) => t.options.includes(arc))) addTasks(e.id, [[arc]])
  }
  const bias = new Float64Array(arcs.length)
  for (const t of tasks) {
    const e = edges[t.edge]
    if (t.options.length !== 2 || e.reqL === e.reqR) continue
    bias[arcOf(e.id, e.reqL ? -1 : 1)] = e.len * opt.rightBias
  }
  const visitTask = opt.visits.map((v) => {
    const arc = arcOf(v.edge, v.dir)
    const t = tasks.find((x) => x.edge === v.edge && x.options.includes(arc)) ?? tasks.find((x) => x.edge === v.edge)
    return t ? t.id : -1
  })
  return { nodes: nodeCount, arcs, out, tasks, depot, deadEnd, banned, bannedAt, bias, uturnAt, visitTask, forced, unreachable }
}

/**
 * From having just driven arc `from` (or, when `from` is -1, from standing at `node`), the cheapest cost to have finished each arc,
 * a turn back costing what it costs at that node. It works over arcs and not nodes, as the cost of going on depends on the way you came.
 */
export function arcDijkstra(pr: Problem, from: number, node: number, d: Float64Array, pre: Int32Array): void {
  d.fill(Infinity)
  pre.fill(-1)
  const heap = new MinHeap()
  if (from >= 0) {
    d[from] = 0
    heap.push(0, from)
  } else {
    for (const a of pr.out[node]) {
      d[a] = pr.arcs[a].weight
      heap.push(d[a], a)
    }
  }
  while (heap.size) {
    const c = heap.topKey
    const a = heap.pop()
    if (c > d[a]) continue
    const arc = pr.arcs[a]
    for (const b of pr.out[arc.to]) {
      const next = pr.arcs[b]
      if (turnBanned(pr, arc, next)) continue
      const nc = c + next.weight + (b === arc.rev ? pr.uturnAt[arc.to] : 0)
      if (nc < d[b]) {
        d[b] = nc
        pre[b] = a
        heap.push(nc, b)
      }
    }
  }
}

/** The cost of going on from each task arc to each other, and what it takes to index it. */
export interface Matrix {
  /** How many task arcs there are. Rows and columns are indices into `arcOf`, with one more for the depot at the end. */
  m: number
  arcOf: number[]
  idxOf: Int32Array
  /** The task of each index. */
  taskOf: Int32Array
  /** Without either arc's own length, as every tour drives each task once. */
  c: Float32Array
}

/** The cheapest cost in `d` to have arrived at the depot. */
function costHome(pr: Problem, d: Float64Array): number {
  let best = Infinity
  for (let a = 0; a < pr.arcs.length; a++) if (pr.arcs[a].to === pr.depot && d[a] < best) best = d[a]
  return best
}

export function buildMatrix(pr: Problem, onStep?: (done: number) => void): Matrix {
  const arcOf: number[] = []
  const taskList: number[] = []
  const idxOf = new Int32Array(pr.arcs.length).fill(-1)
  for (const t of pr.tasks) {
    for (const a of t.options) {
      if (idxOf[a] >= 0) throw new Error(`Arc ${a} is in two tasks.`)
      idxOf[a] = arcOf.length
      arcOf.push(a)
      taskList.push(t.id)
    }
  }
  const m = arcOf.length
  const width = m + 1
  const c = new Float32Array(width * width)
  const d = new Float64Array(pr.arcs.length)
  const pre = new Int32Array(pr.arcs.length)
  for (let i = 0; i <= m; i++) {
    if (onStep && (i & 31) === 0) onStep(i / width)
    if (i < m) arcDijkstra(pr, arcOf[i], -1, d, pre)
    else arcDijkstra(pr, -1, pr.depot, d, pre)
    for (let j = 0; j < m; j++) {
      const a = arcOf[j]
      // The same arc again is all the way round to it, and no tour ever asks for that.
      c[i * width + j] = i === j || d[a] === Infinity ? NO_WAY : d[a] - pr.arcs[a].weight + pr.bias[a]
    }
    c[i * width + m] = i < m ? Math.min(costHome(pr, d), NO_WAY) : 0
  }
  return { m, arcOf, idxOf, taskOf: Int32Array.from(taskList), c }
}

/** One arc of the drive, in order. */
export interface Leg {
  arc: number
  serves: boolean
}

/** The whole drive, arc by arc, with which arcs serve a task. `seq` holds matrix indices, the depot at both ends. */
export function expand(pr: Problem, mx: Matrix, seq: Int32Array): Leg[] {
  const d = new Float64Array(pr.arcs.length)
  const pre = new Int32Array(pr.arcs.length)
  const pathTo = (end: number, from: number): number[] => {
    if (d[end] === Infinity) throw new Error('The new drive has a stretch with no way to it.')
    const path: number[] = []
    for (let a = end; a !== -1 && a !== from; a = pre[a]) path.push(a)
    return path.reverse()
  }
  const out: Leg[] = []
  const n = pr.tasks.length
  let cur = -1
  for (let i = 1; i <= n; i++) {
    const next = mx.arcOf[seq[i]]
    arcDijkstra(pr, cur, pr.depot, d, pre)
    const path = pathTo(next, cur)
    path.forEach((arc, k) => out.push({ arc, serves: k === path.length - 1 }))
    cur = next
  }
  if (cur >= 0 && pr.arcs[cur].to !== pr.depot) {
    arcDijkstra(pr, cur, pr.depot, d, pre)
    let home = -1
    for (let a = 0; a < pr.arcs.length; a++) if (pr.arcs[a].to === pr.depot && d[a] < (home < 0 ? Infinity : d[home])) home = a
    if (home < 0) throw new Error('The new drive has no way back to the start.')
    for (const arc of pathTo(home, cur)) out.push({ arc, serves: false })
  }
  return out
}
