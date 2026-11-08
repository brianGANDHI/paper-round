import type { Edge } from './demand'
import { MinHeap } from './heap'
import type { Matrix, Problem } from './problem'

/**
 * A way to a whole drive that owes nothing to the search: build a joined-up, even network from the streets (join the pieces of work up,
 * then pair the odd junctions), turn it into one-way drives that balance at every junction, then walk it. It gives the search a good start
 * for the shortest route.
 */

interface Hop {
  to: number
  edge: number
  len: number
}

/** Plain shortest paths over the edges from any of `sources`, either way along every edge. */
function shortestFrom(adj: Hop[][], sources: number[], d: Float64Array, pre: Int32Array, preEdge: Int32Array) {
  d.fill(Infinity)
  pre.fill(-1)
  preEdge.fill(-1)
  const heap = new MinHeap()
  for (const s of sources) {
    d[s] = 0
    heap.push(0, s)
  }
  while (heap.size) {
    const du = heap.topKey
    const u = heap.pop()
    if (du > d[u]) continue
    for (const h of adj[u]) {
      if (du + h.len < d[h.to]) {
        d[h.to] = du + h.len
        pre[h.to] = u
        preEdge[h.to] = h.edge
        heap.push(d[h.to], h.to)
      }
    }
  }
}

/** A good pairing of an even set, from a cost table: greedy, then swapping partners until no swap helps. */
function pairUp(cost: Float64Array, n: number): Int32Array {
  const mate = new Int32Array(n).fill(-1)
  const all: [number, number, number][] = []
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) all.push([cost[i * n + j], i, j])
  all.sort((a, b) => a[0] - b[0])
  for (const [, i, j] of all) {
    if (mate[i] < 0 && mate[j] < 0) {
      mate[i] = j
      mate[j] = i
    }
  }
  for (let again = true; again; ) {
    again = false
    for (let a = 0; a < n; a++) {
      for (let c = a + 1; c < n; c++) {
        const b = mate[a]
        const d = mate[c]
        if (c === b) continue
        const now = cost[a * n + b] + cost[c * n + d]
        if (cost[a * n + c] + cost[b * n + d] < now - 1e-6) {
          mate[a] = c
          mate[c] = a
          mate[b] = d
          mate[d] = b
          again = true
        } else if (cost[a * n + d] + cost[b * n + c] < now - 1e-6) {
          mate[a] = d
          mate[d] = a
          mate[b] = c
          mate[c] = b
          again = true
        }
      }
    }
  }
  return mate
}

interface Flip {
  from: number
  to: number
  cap: number
}

/** The cheapest extra drives that leave every junction as often as it's entered, by minimum cost flow, and how much of each flip was used. */
function balance(pr: Problem, excess: Int32Array, flips: Flip[]): { extra: Int32Array; flipped: Int32Array } {
  const size = pr.nodes + 2
  const source = pr.nodes
  const sink = pr.nodes + 1
  const to: number[] = []
  const cap: number[] = []
  const cost: number[] = []
  const next: number[] = []
  const head = new Int32Array(size).fill(-1)
  const add = (u: number, v: number, c: number, w: number) => {
    const id = to.length
    to.push(v, u)
    cap.push(c, 0)
    cost.push(w, -w)
    next.push(head[u], head[v])
    head[u] = id
    head[v] = id + 1
    return id
  }
  const flipId = flips.map((f) => add(f.from, f.to, f.cap, 0))
  const arcId = pr.arcs.map((a) => add(a.from, a.to, 1e6, a.weight))
  for (let v = 0; v < pr.nodes; v++) {
    if (excess[v] > 0) add(source, v, excess[v], 0)
    else if (excess[v] < 0) add(v, sink, -excess[v], 0)
  }
  const d = new Float64Array(size)
  const queued = new Uint8Array(size)
  const via = new Int32Array(size)
  for (;;) {
    d.fill(Infinity)
    via.fill(-1)
    d[source] = 0
    const queue: number[] = [source]
    queued[source] = 1
    for (let at = 0; at < queue.length; at++) {
      const u = queue[at]
      queued[u] = 0
      for (let e = head[u]; e !== -1; e = next[e]) {
        if (cap[e] > 0 && d[u] + cost[e] < d[to[e]] - 1e-7) {
          d[to[e]] = d[u] + cost[e]
          via[to[e]] = e
          if (!queued[to[e]]) {
            queued[to[e]] = 1
            queue.push(to[e])
          }
        }
      }
    }
    if (d[sink] === Infinity) break
    let push = Infinity
    for (let v = sink; v !== source; v = to[via[v] ^ 1]) push = Math.min(push, cap[via[v]])
    for (let v = sink; v !== source; v = to[via[v] ^ 1]) {
      cap[via[v]] -= push
      cap[via[v] ^ 1] += push
    }
  }
  for (let e = head[source]; e !== -1; e = next[e]) if (cap[e] > 0 && !(e & 1)) throw new Error('The network could not be balanced.')
  return { extra: Int32Array.from(arcId.map((id) => cap[id ^ 1])), flipped: Int32Array.from(flipId.map((id) => cap[id ^ 1])) }
}

/** Which way each drive of the network goes: as few extra drives as can be, every junction left as often as entered. */
function orient(pr: Problem, edges: Edge[], drives: Int32Array): Int32Array {
  const count = new Int32Array(pr.arcs.length)
  const rest = drives.slice()
  const fwd = new Int32Array(edges.length).fill(-1)
  const bwd = new Int32Array(edges.length).fill(-1)
  for (const a of pr.arcs) (a.dir === 1 ? fwd : bwd)[a.edge] = a.id
  for (const t of pr.tasks) {
    if (t.options.length !== 1) continue
    count[t.options[0]]++
    rest[t.edge]--
  }
  const free: { edge: number; n: number }[] = []
  for (const e of edges) {
    const r = rest[e.id]
    if (r <= 0) continue
    if (fwd[e.id] < 0) count[bwd[e.id]] += r
    else if (bwd[e.id] < 0) count[fwd[e.id]] += r
    else {
      // Forward to begin with: the flow below turns some round.
      count[fwd[e.id]] += r
      free.push({ edge: e.id, n: r })
    }
  }
  const excessNow = () => {
    const excess = new Int32Array(pr.nodes)
    for (const a of pr.arcs) {
      excess[a.to] += count[a.id]
      excess[a.from] -= count[a.id]
    }
    return excess
  }
  const first = balance(pr, excessNow(), free.map((f) => ({ from: edges[f.edge].v, to: edges[f.edge].u, cap: 2 * f.n })))
  // Whole turns are taken as they stand. A half turn is one drive that could go either way: those run in trails, each driven one way along the trail.
  const half: { edge: number; used: boolean }[] = []
  const halfAt: number[][] = Array.from({ length: pr.nodes }, () => [])
  free.forEach((f, i) => {
    const turns = first.flipped[i] >> 1
    count[fwd[f.edge]] -= turns
    count[bwd[f.edge]] += turns
    if (first.flipped[i] & 1) {
      const id = half.length
      half.push({ edge: f.edge, used: false })
      halfAt[edges[f.edge].u].push(id)
      halfAt[edges[f.edge].v].push(id)
    }
  })
  for (const a of pr.arcs) count[a.id] += first.extra[a.id]
  const trailFrom = (start: number) => {
    let u = start
    for (;;) {
      const id = halfAt[u].find((h) => !half[h].used)
      if (id === undefined) return
      half[id].used = true
      const e = edges[half[id].edge]
      if (u === e.v) {
        // Driven from v to u: turn it round.
        count[fwd[e.id]]--
        count[bwd[e.id]]++
      }
      u = u === e.u ? e.v : e.u
    }
  }
  for (let v = 0; v < pr.nodes; v++) if (halfAt[v].length & 1) trailFrom(v)
  for (let v = 0; v < pr.nodes; v++) trailFrom(v)
  // What's still out of balance is put right with extra drives.
  const second = balance(pr, excessNow(), [])
  for (const a of pr.arcs) count[a.id] += second.extra[a.id]
  return count
}

/** How the walk goes on: the way a drive leaves a node or reaches its end, for going straight on where it can. */
function headingOf(pr: Problem, edges: Edge[], arc: number, end: boolean): number {
  const a = pr.arcs[arc]
  const p = edges[a.edge].pts
  const n = p.length
  const forward = a.dir === 1
  const [s, t] = end ? (forward ? [p[n - 2], p[n - 1]] : [p[1], p[0]]) : forward ? [p[0], p[1]] : [p[n - 1], p[n - 2]]
  return Math.atan2(t[0] - s[0], t[1] - s[1])
}

/**
 * Walks a balanced network into one drive: a closed walk at a time, going on straight where it can, each spliced into the walk so far.
 * The splice copies the walk, which is quadratic in the number of walks. A round is a few thousand arcs at most, so that is left simple.
 */
function walkNetwork(pr: Problem, edges: Edge[], count: Int32Array): number[] {
  const left = count.slice()
  const walkFrom = (start: number, prev: number): number[] => {
    const out: number[] = []
    let u = start
    let last = prev
    for (;;) {
      let best = -1
      let bestScore = Infinity
      for (const c of pr.out[u]) {
        if (left[c] <= 0) continue
        let score = 0
        if (last >= 0) {
          if (pr.arcs[last].rev === c) score += 10
          let turn = Math.abs(headingOf(pr, edges, c, false) - headingOf(pr, edges, last, true))
          if (turn > Math.PI) turn = 2 * Math.PI - turn
          score += turn
        }
        if (score < bestScore) {
          bestScore = score
          best = c
        }
      }
      if (best < 0) return out
      left[best]--
      out.push(best)
      last = best
      u = pr.arcs[best].to
    }
  }
  let tour = walkFrom(pr.depot, -1)
  for (;;) {
    const spot = tour.findIndex((arc) => pr.out[pr.arcs[arc].to].some((c) => left[c] > 0))
    if (spot < 0) return tour
    tour = [...tour.slice(0, spot + 1), ...walkFrom(pr.arcs[tour[spot]].to, tour[spot]), ...tour.slice(spot + 1)]
  }
}

/** How many times each edge goes in the even network: every task, what joins them to the depot, and what pairs the odd junctions. */
function evenNetwork(pr: Problem, edges: Edge[]): Int32Array {
  const N = pr.nodes
  const adj: Hop[][] = Array.from({ length: N }, () => [])
  const usable = new Uint8Array(edges.length)
  const weight = new Float64Array(edges.length)
  for (const a of pr.arcs) {
    usable[a.edge] = 1
    weight[a.edge] = a.weight
  }
  for (const e of edges) {
    if (!usable[e.id]) continue
    adj[e.u].push({ to: e.v, edge: e.id, len: weight[e.id] })
    adj[e.v].push({ to: e.u, edge: e.id, len: weight[e.id] })
  }
  const drives = new Int32Array(edges.length)
  const required = new Int32Array(edges.length)
  for (const t of pr.tasks) {
    drives[t.edge]++
    required[t.edge]++
  }
  // Join the pieces of work up, nearest first, from the depot's own.
  const parent = Int32Array.from({ length: N }, (_, i) => i)
  const find = (start: number): number => {
    let a = start
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]]
      a = parent[a]
    }
    return a
  }
  const onNetwork = new Uint8Array(N)
  onNetwork[pr.depot] = 1
  for (const e of edges) {
    if (!drives[e.id]) continue
    parent[find(e.u)] = find(e.v)
    onNetwork[e.u] = 1
    onNetwork[e.v] = 1
  }
  const d = new Float64Array(N)
  const pre = new Int32Array(N)
  const preEdge = new Int32Array(N)
  const home = find(pr.depot)
  for (;;) {
    const sources: number[] = []
    for (let v = 0; v < N; v++) if (onNetwork[v] && find(v) === find(home)) sources.push(v)
    shortestFrom(adj, sources, d, pre, preEdge)
    let best = -1
    for (let v = 0; v < N; v++) if (onNetwork[v] && find(v) !== find(home) && d[v] < Infinity && (best < 0 || d[v] < d[best])) best = v
    if (best < 0) break
    for (let v = best; pre[v] >= 0; v = pre[v]) {
      drives[preEdge[v]]++
      parent[find(v)] = find(pre[v])
      onNetwork[v] = 1
      onNetwork[pre[v]] = 1
    }
    parent[find(best)] = find(home)
  }
  // Pair the odd junctions.
  const degree = new Int32Array(N)
  for (const e of edges) {
    if (!drives[e.id]) continue
    degree[e.u] += drives[e.id]
    degree[e.v] += drives[e.id]
  }
  const odd: number[] = []
  for (let v = 0; v < N; v++) if (degree[v] & 1) odd.push(v)
  const n = odd.length
  const table = new Float64Array(n * n)
  const paths: { pre: Int32Array; preEdge: Int32Array }[] = []
  for (let i = 0; i < n; i++) {
    shortestFrom(adj, [odd[i]], d, pre, preEdge)
    paths.push({ pre: pre.slice(), preEdge: preEdge.slice() })
    for (let j = 0; j < n; j++) table[i * n + j] = i === j ? 1e12 : d[odd[j]]
  }
  const mate = pairUp(table, n)
  for (let i = 0; i < n; i++) {
    if (i >= mate[i]) continue
    const { pre: p, preEdge: pe } = paths[i]
    for (let v = odd[mate[i]]; p[v] >= 0; v = p[v]) drives[pe[v]]++
  }
  // Take out what the network doesn't need: a stretch driven two extra times, if the rest still joins up.
  const reached = () => {
    const seen = new Uint8Array(N)
    const stack = [pr.depot]
    seen[pr.depot] = 1
    while (stack.length) {
      const u = stack.pop() as number
      for (const h of adj[u]) {
        if (drives[h.edge] > 0 && !seen[h.to]) {
          seen[h.to] = 1
          stack.push(h.to)
        }
      }
    }
    return seen
  }
  const longestFirst = edges.filter((e) => usable[e.id]).sort((a, b) => b.len - a.len)
  for (const e of longestFirst) {
    while (drives[e.id] - required[e.id] >= 2) {
      drives[e.id] -= 2
      const seen = reached()
      const joined = edges.every((f) => drives[f.id] === 0 || (seen[f.u] && seen[f.v])) && pr.tasks.every((t) => seen[edges[t.edge].u])
      if (!joined) {
        drives[e.id] += 2
        break
      }
    }
  }
  return drives
}

/** The tasks in the order the walk of the even network first meets them, as a start for the search, in matrix indices. */
export function networkStart(pr: Problem, mx: Matrix, edges: Edge[]): Int32Array {
  const tour = walkNetwork(pr, edges, orient(pr, edges, evenNetwork(pr, edges)))
  const done = new Uint8Array(pr.tasks.length)
  const start: number[] = []
  for (const arc of tour) {
    const i = mx.idxOf[arc]
    if (i < 0 || done[mx.taskOf[i]]) continue
    done[mx.taskOf[i]] = 1
    start.push(i)
  }
  for (const t of pr.tasks) if (!done[t.id]) start.push(mx.idxOf[t.options[0]])
  return Int32Array.from(start)
}
