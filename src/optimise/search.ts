import type { Matched } from './match'
import type { Edge } from './demand'
import type { Matrix, Problem } from './problem'

/** The search: an order of tasks, each with a way to drive it, annealed from a good start. All its randomness is local to a run. */

/** The numbers a run draws. The same seed gives the same run. */
export interface Rng {
  next: () => number
  below: (n: number) => number
}

export function makeRng(seed: number): Rng {
  let state = seed >>> 0
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
  return { next, below: (n) => Math.floor(next() * n) }
}

/** How many of the nearest arcs after each arc are tried as somewhere to move to. */
const NEAR_K = 12
/** The heat the search cools to. */
const COLD = 0.3
/** Moves between looks at the clock. */
const CHUNK = 4096

/** A full tour: matrix indices, the depot at both ends. */
export interface Tour {
  seq: Int32Array
  cost: number
}

/**
 * The nearest arcs after each arc, row by row, the earlier arc first on a tie. It's worked out once, as it's the same for every stretch of
 * the search. Each row keeps a short list as it goes, rather than sorting a thousand costs to use a dozen. A row with fewer arcs than that
 * repeats them, so that any place in it can be drawn.
 */
export function nearTable(mx: Matrix): Int32Array {
  const { m, c } = mx
  const width = m + 1
  const near = new Int32Array(width * NEAR_K)
  const list = new Int32Array(NEAR_K)
  for (let i = 0; i <= m; i++) {
    const row = i * width
    let size = 0
    for (let j = 0; j < m; j++) {
      const cost = c[row + j]
      if (size === NEAR_K && cost >= c[row + list[size - 1]]) continue
      let at = Math.min(size, NEAR_K - 1)
      for (; at > 0 && c[row + list[at - 1]] > cost; at--) list[at] = list[at - 1]
      list[at] = j
      if (size < NEAR_K) size++
    }
    for (let n = 0; n < NEAR_K; n++) near[i * NEAR_K + n] = list[n % size]
  }
  return near
}

export interface AnnealPlan {
  /** Where to start, in matrix indices, one for each task. */
  start: Int32Array
  heat: number
  seed: number
  /** A kept order: each task's rank, -1 for those with none. Only a move that keeps the ranks in order is taken. */
  ranks?: Int32Array
  /** How much of this stretch has gone, from 0 to 1, by the number of moves tried. At 1 it stops. */
  used: (moves: number) => number
}

/** Anneals a tour: moves runs of tasks, turns runs round, and swaps which way a task is driven. */
export function anneal(pr: Problem, mx: Matrix, near: Int32Array, plan: AnnealPlan): Tour {
  const rng = makeRng(plan.seed)
  const { m, c, idxOf, taskOf } = mx
  const { ranks } = plan
  const W = m + 1
  const n = pr.tasks.length
  const DEPOT = m
  const revOf = new Int32Array(m).fill(-1)
  for (const t of pr.tasks) {
    if (t.options.length !== 2) continue
    const [a, b] = t.options.map((x) => idxOf[x])
    revOf[a] = b
    revOf[b] = a
  }
  const seq = new Int32Array(n + 2)
  seq[0] = DEPOT
  seq.set(plan.start, 1)
  seq[n + 1] = DEPOT
  const pos = new Int32Array(n)
  const repos = (a: number, b: number) => {
    for (let i = a; i <= b; i++) pos[taskOf[seq[i]]] = i
  }
  repos(1, n)
  let total = 0
  for (let i = 0; i <= n; i++) total += c[seq[i] * W + seq[i + 1]]
  const best = seq.slice()
  let bestCost = total
  let temp = plan.heat
  const tmp = new Int32Array(n + 2)
  const accept = (delta: number) => delta <= 0 || rng.next() < Math.exp(-delta / temp)
  const rankOf = (k: number) => (ranks as Int32Array)[taskOf[seq[k]]]
  // What a run jumps over must stay on the same side of it. This is only asked of a move that would be taken, as it costs a scan.
  const moveKeeps = (i: number, e: number, j: number) => {
    let lo = Infinity
    let hi = -1
    for (let k = i; k <= e; k++) {
      const r = rankOf(k)
      if (r >= 0) {
        if (r < lo) lo = r
        if (r > hi) hi = r
      }
    }
    if (hi < 0) return true
    const a = j > e ? e + 1 : j
    const b = j > e ? j - 1 : i - 1
    for (let k = a; k <= b; k++) {
      const r = rankOf(k)
      if (r >= 0 && (j > e ? r > lo : r < hi)) return false
    }
    return true
  }
  const turnKeeps = (i: number, j: number) => {
    let seen = -1
    for (let k = i; k <= j; k++) {
      const r = rankOf(k)
      if (r >= 0) {
        if (seen >= 0 && r !== seen) return false
        seen = r
      }
    }
    return true
  }
  // Drive one task the other way.
  const flipOne = () => {
    const i = 1 + rng.below(n)
    const a = seq[i]
    const r = revOf[a]
    if (r < 0) return
    const p = seq[i - 1]
    const q = seq[i + 1]
    const delta = c[p * W + r] + c[r * W + q] - c[p * W + a] - c[a * W + q]
    if (accept(delta)) {
      seq[i] = r
      total += delta
    }
  }
  // Move a run of tasks to go before an arc close to its end.
  const moveRun = () => {
    const size = rng.next()
    const L = 1 + (size < 0.5 ? 0 : size < 0.75 ? rng.below(6) : size < 0.93 ? rng.below(40) : rng.below(Math.max(1, n >> 1)))
    const i = 1 + rng.below(n)
    const e = i + L - 1
    if (e > n) return
    const first = seq[i]
    const last = seq[e]
    const y = near[last * NEAR_K + rng.below(NEAR_K)]
    const j = pos[taskOf[y]]
    if (j >= i && j <= e + 1) return
    const after = seq[j]
    const prior = seq[j - 1]
    if (after !== y && revOf[after] !== y) return
    const before = seq[i - 1]
    const next = seq[e + 1]
    const delta = c[before * W + next] + c[prior * W + first] + c[last * W + after] - c[before * W + first] - c[last * W + next] - c[prior * W + after]
    if (!accept(delta) || (ranks && !moveKeeps(i, e, j))) return
    tmp.set(seq.subarray(i, e + 1), 0)
    if (j > e) {
      // Shift what lies between back over the run.
      seq.copyWithin(i, e + 1, j)
      seq.set(tmp.subarray(0, L), j - L)
      repos(i, j - 1)
    } else {
      seq.copyWithin(j + L, j, i)
      seq.set(tmp.subarray(0, L), j)
      repos(j, e)
    }
    total += delta
  }
  // Turn a run of tasks round: each is then driven the other way, so all of them have to be able to be.
  const turnRun = () => {
    const i = 1 + rng.below(n)
    const y = near[seq[i - 1] * NEAR_K + rng.below(NEAR_K)]
    const r = revOf[y]
    if (r < 0) return
    const j = pos[taskOf[y]]
    if (j < i || seq[j] !== r) return
    for (let k = i; k <= j; k++) if (revOf[seq[k]] < 0) return
    let delta = 0
    for (let k = i; k < j; k++) delta += c[revOf[seq[k + 1]] * W + revOf[seq[k]]] - c[seq[k] * W + seq[k + 1]]
    delta += c[seq[i - 1] * W + revOf[seq[j]]] + c[revOf[seq[i]] * W + seq[j + 1]] - c[seq[i - 1] * W + seq[i]] - c[seq[j] * W + seq[j + 1]]
    if (!accept(delta) || (ranks && !turnKeeps(i, j))) return
    for (let a = i, b = j; a <= b; a++, b--) {
      const x = revOf[seq[a]]
      const w = revOf[seq[b]]
      seq[a] = w
      seq[b] = x
    }
    repos(i, j)
    total += delta
  }
  for (let moves = 0; n > 0; moves++) {
    if ((moves & (CHUNK - 1)) === 0) {
      const used = plan.used(moves)
      if (used >= 1) break
      temp = plan.heat * Math.pow(COLD / plan.heat, used)
    }
    const kind = rng.next()
    if (kind < 0.12) flipOne()
    else if (kind < 0.72) moveRun()
    else turnRun()
    if (total < bestCost - 1e-6) {
      bestCost = total
      best.set(seq)
    }
  }
  // Annealing keeps a running sum of single precision steps, so add it up afresh.
  let check = 0
  for (let i = 0; i <= n; i++) check += c[best[i] * W + best[i + 1]]
  return { seq: best, cost: check }
}

/** Finds the edge at a place along a piece. */
export type EdgeAt = (piece: number, s: number) => Edge | undefined

/** The tasks in the order the old route met them, each the way it drove them. Tasks it never met go in wherever they cost least. */
export function oldSequence(pr: Problem, mx: Matrix, matched: Matched[], edgeAt: EdgeAt, edgeCount: number): Int32Array {
  const fwd = new Int32Array(edgeCount).fill(-1)
  const bwd = new Int32Array(edgeCount).fill(-1)
  for (const a of pr.arcs) (a.dir === 1 ? fwd : bwd)[a.edge] = a.id
  const seen = new Uint8Array(pr.tasks.length)
  const order: number[] = []
  for (const at of matched) {
    if (at.piece < 0) continue
    const e = edgeAt(at.piece, at.s)
    if (!e) continue
    const arc = at.dir === 1 ? fwd[e.id] : bwd[e.id]
    if (arc < 0 || mx.idxOf[arc] < 0) continue
    const i = mx.idxOf[arc]
    if (seen[mx.taskOf[i]]) continue
    seen[mx.taskOf[i]] = 1
    order.push(i)
  }
  const W = mx.m + 1
  const D = mx.m
  const { c } = mx
  for (const t of pr.tasks) {
    if (seen[t.id]) continue
    let best = Infinity
    let at = 0
    let arc = -1
    for (const a of t.options) {
      const j = mx.idxOf[a]
      for (let i = 0; i <= order.length; i++) {
        const p = i ? order[i - 1] : D
        const q = i < order.length ? order[i] : D
        const v = c[p * W + j] + c[j * W + q] - c[p * W + q]
        if (v < best) {
          best = v
          at = i
          arc = j
        }
      }
    }
    order.splice(at, 0, arc)
    seen[t.id] = 1
  }
  return Int32Array.from(order)
}

/** A start that honours a kept order: what's already in order stays where it is, and what isn't is lifted out and put back in the cheapest place its order allows. */
export function orderedStart(pr: Problem, mx: Matrix, start: Int32Array, ranks: Int32Array): Int32Array {
  const { taskOf, c } = mx
  const rankAt = (j: number) => ranks[taskOf[j]]
  const spots: number[] = []
  for (let i = 0; i < start.length; i++) if (rankAt(start[i]) >= 0) spots.push(i)
  // The longest run through them that never goes down.
  const best = spots.map(() => 1)
  const from = spots.map(() => -1)
  let end = 0
  for (let i = 0; i < spots.length; i++) {
    for (let k = 0; k < i; k++) {
      if (rankAt(start[spots[k]]) <= rankAt(start[spots[i]]) && best[k] + 1 > best[i]) {
        best[i] = best[k] + 1
        from[i] = k
      }
    }
    if (best[i] > best[end]) end = i
  }
  const stays = new Set<number>()
  if (spots.length) for (let i = end; i >= 0; i = from[i]) stays.add(spots[i])
  const lifted: number[] = []
  const out: number[] = []
  for (let i = 0; i < start.length; i++) {
    if (rankAt(start[i]) >= 0 && !stays.has(i)) lifted.push(taskOf[start[i]])
    else out.push(start[i])
  }
  lifted.sort((a, b) => ranks[a] - ranks[b])
  const W = mx.m + 1
  const D = mx.m
  for (const t of lifted) {
    const r = ranks[t]
    let lo = 0
    let hi = out.length
    for (let i = 0; i < out.length; i++) {
      const x = rankAt(out[i])
      if (x < 0) continue
      if (x <= r) lo = i + 1
      else if (i < hi) {
        hi = i
        break
      }
    }
    let cost = Infinity
    let at = lo
    let arc = -1
    for (const a of pr.tasks[t].options) {
      const j = mx.idxOf[a]
      for (let i = lo; i <= hi; i++) {
        const p = i ? out[i - 1] : D
        const q = i < out.length ? out[i] : D
        const v = c[p * W + j] + c[j * W + q] - c[p * W + q]
        if (v < cost) {
          cost = v
          at = i
          arc = j
        }
      }
    }
    out.splice(at, 0, arc)
  }
  return Int32Array.from(out)
}
