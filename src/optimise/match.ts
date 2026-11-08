import type { Pt, Side, SideChange } from '../types'
import { candidates, dist, toXY, type Graph, type Origin, type XY } from './graph'
import { MinHeap } from './heap'

/** Matching a saved route onto the street graph: a hidden Markov match, with a state for "no road here". */

/** How far apart the route is sampled, in metres. */
export const SAMPLE_M = 8

export interface Sample {
  at: XY
  heading: number
  side: Side
  /** The route segment it is on, and how far along the route it is. */
  seg: number
  along: number
}

/** Where a sample landed: `piece` is -1 where there is no road. */
export interface Matched {
  piece: number
  dir: 1 | -1
  s: number
}

const NO_ROAD = -1
/** How far from a sample a road can be, in metres, and how many are tried. */
const MATCH_RADIUS_M = 35
const MAX_CANDIDATES = 8
/** How much being off the road counts against a place, and how much pointing the wrong way does, as the spread of each. */
const SIGMA_OFF_M = 9
const SIGMA_HEADING = 0.7
/** Staying off the road altogether costs this per sample, more than any plain mismatch, so it is a last resort. */
const NO_ROAD_COST = 14
/** Going on or off the road at all. */
const LEAVE_ROAD_COST = 3
/** A saved route may have broken a one-way, so this is a cost and not a rule. */
const AGAINST_ONE_WAY_COST = 6
/** Reversing inside a piece, as a distance in metres. */
const TURN_ON_PIECE_M = 14
/** Slipping back a little along a piece is the line wobbling, not reversing, in metres. */
const SLIP_BACK_M = 3
/** How much a jump between samples may differ from the sample step, as a divisor of the difference. */
const STEP_SPREAD_M = 6
/** How far to look along the roads between two pieces, in metres. */
const LINK_LIMIT_M = 90

/**
 * The route as samples about `step` metres apart, each with the side thrown on its segment. Sides follow `sideAt`: a change applies
 * from its index on, the last row of an index wins, and everything before the first row is 'both'.
 */
export function samplesOf(origin: Origin, points: Pt[], sides: SideChange[], step: number = SAMPLE_M): Sample[] {
  const xy = points.map((p) => toXY(origin, p))
  const sorted = sides.map((c, order) => ({ ...c, order })).sort((a, b) => a.idx - b.idx || a.order - b.order)
  const out: Sample[] = []
  let along = 0
  let side: Side = 'both'
  let row = 0
  for (let i = 0; i + 1 < xy.length; i++) {
    while (row < sorted.length && sorted[row].idx <= i) side = sorted[row++].side
    const A = xy[i]
    const B = xy[i + 1]
    const len = dist(A, B)
    if (len < 0.01) continue
    const n = Math.max(1, Math.ceil(len / step))
    const heading = Math.atan2(B[0] - A[0], B[1] - A[1])
    for (let k = 0; k < n; k++) {
      const t = k / n
      out.push({ at: [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t], heading, side, seg: i, along: along + len * t })
    }
    along += len
  }
  const tail = out[out.length - 1]
  if (tail) out.push({ at: xy[xy.length - 1], heading: tail.heading, side: tail.side, seg: tail.seg, along })
  return out
}

export const angleOff = (a: number, b: number) => {
  const d = Math.abs(a - b) % (2 * Math.PI)
  return d > Math.PI ? 2 * Math.PI - d : d
}

/** Shortest distances from a node along the pieces, out to `limit` metres, whichever way they are drawn. */
function nearNodes(g: Graph, from: number, limit: number): Map<number, number> {
  const dists = new Map<number, number>([[from, 0]])
  const heap = new MinHeap()
  heap.push(0, from)
  while (heap.size) {
    const d = heap.topKey
    const n = heap.pop()
    if (d > (dists.get(n) ?? Infinity)) continue
    for (const p of g.incident[n]) {
      const piece = g.pieces[p]
      const to = piece.a === n ? piece.b : piece.a
      const nd = d + piece.len
      if (nd <= limit && nd < (dists.get(to) ?? Infinity)) {
        dists.set(to, nd)
        heap.push(nd, to)
      }
    }
  }
  return dists
}

interface State {
  piece: number
  dir: 1 | -1
  s: number
  cost: number
  from: number
}

/** The road distance to go from one state to the next, or Infinity when one can't follow the other. */
function stepDistance(g: Graph, a: State, b: State, near: (n: number) => Map<number, number>): number {
  if (a.piece === b.piece && a.dir === b.dir) {
    const ahead = (b.s - a.s) * b.dir
    return ahead >= -SLIP_BACK_M ? Math.max(ahead, 0) : Infinity
  }
  if (a.piece === b.piece) return Math.abs(b.s - a.s) + TURN_ON_PIECE_M
  const pa = g.pieces[a.piece]
  const pb = g.pieces[b.piece]
  const leave = a.dir === 1 ? pa.len - a.s : a.s
  const enter = b.dir === 1 ? b.s : pb.len - b.s
  const end = a.dir === 1 ? pa.b : pa.a
  const begin = b.dir === 1 ? pb.a : pb.b
  return leave + (near(end).get(begin) ?? Infinity) + enter
}

function statesAt(g: Graph, sample: Sample): State[] {
  const here: State[] = []
  for (const c of candidates(g, sample.at, MATCH_RADIUS_M).slice(0, MAX_CANDIDATES)) {
    const piece = g.pieces[c.piece]
    for (const dir of [1, -1] as const) {
      const off = angleOff(sample.heading, dir === 1 ? c.heading : c.heading + Math.PI)
      const against = (piece.oneway === 1 && dir === -1) || (piece.oneway === -1 && dir === 1) ? AGAINST_ONE_WAY_COST : 0
      here.push({ piece: c.piece, dir, s: c.s, cost: (c.d / SIGMA_OFF_M) ** 2 / 2 + (off / SIGMA_HEADING) ** 2 / 2 + against, from: -1 })
    }
  }
  here.push({ piece: NO_ROAD, dir: 1, s: 0, cost: NO_ROAD_COST, from: -1 })
  return here
}

/** Each sample to a place on a piece and a way along it, or to no road: the cheapest path through all of them. `onStep` hears how far it has got. */
export function matchRoute(g: Graph, samples: Sample[], onStep?: (done: number) => void): Matched[] {
  const cache = new Map<number, Map<number, number>>()
  const near = (n: number) => {
    let dists = cache.get(n)
    if (!dists) {
      dists = nearNodes(g, n, LINK_LIMIT_M)
      cache.set(n, dists)
    }
    return dists
  }
  const layers: State[][] = []
  for (let k = 0; k < samples.length; k++) {
    if (onStep && (k & 255) === 0) onStep(k / samples.length)
    const here = statesAt(g, samples[k])
    if (k > 0) {
      const prev = layers[k - 1]
      const step = dist(samples[k - 1].at, samples[k].at)
      for (const st of here) {
        let bestCost = Infinity
        let bestFrom = 0
        for (let i = 0; i < prev.length; i++) {
          const pr = prev[i]
          if (pr.cost === Infinity) continue
          let trans: number
          if (st.piece === NO_ROAD || pr.piece === NO_ROAD) trans = st.piece === pr.piece ? 0 : LEAVE_ROAD_COST
          else {
            const d = stepDistance(g, pr, st, near)
            trans = d === Infinity ? Infinity : Math.abs(d - step) / STEP_SPREAD_M
          }
          const total = pr.cost + trans
          if (total < bestCost) {
            bestCost = total
            bestFrom = i
          }
        }
        st.cost += bestCost
        st.from = bestFrom
      }
    }
    layers.push(here)
  }
  const out: Matched[] = new Array(samples.length)
  const last = layers[layers.length - 1]
  if (!last) return out
  let at = 0
  for (let i = 1; i < last.length; i++) if (last[i].cost < last[at].cost) at = i
  for (let k = samples.length - 1; k >= 0; k--) {
    const st = layers[k][at]
    out[k] = { piece: st.piece, dir: st.dir, s: st.s }
    at = st.from
  }
  return out
}
