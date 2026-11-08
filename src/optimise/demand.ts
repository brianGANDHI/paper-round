import type { Side } from '../types'
import { dist, type Graph, type Piece, type XY } from './graph'
import { MinHeap } from './heap'
import { angleOff, type Matched, type Sample } from './match'
import { COVER_GATE_M } from './run'

/**
 * From a matched route: which absolute side of which stretch of street gets a paper, and how often. Sides are absolute here, not as the
 * driver has them: side 0 is the left of a piece as it is drawn, side 1 its right, so a street driven both ways adds up on one footing.
 */

/** Cells of a piece, in metres. */
export const CELL_M = 4
/** A stretch of a side thrown shorter than this at the end of a street is the match nibbling at the junction, and a gap shorter than this is a slip. */
const NIBBLE_M = 14
/** Marks more than this many samples apart are separate passes of a cell. Closer, they are one pass, however the match wobbled. */
const PASS_GAP = 14
/** Two nodes are only linked this far apart: a jump longer than that is not one road, in metres. */
const LINK_LIMIT_M = 120
/** A piece this near the line of another at a node, in radians, carries the street straight on. */
export const STRAIGHT_ON = 0.6

/** What a route did along one piece, per cell. */
export interface Cover {
  /** Times each side was thrown at. */
  count: [Uint16Array, Uint16Array]
  last: [Int32Array, Int32Array]
  /** Times driven each way: 0 as drawn, 1 against. */
  drive: [Uint16Array, Uint16Array]
  driveLast: [Int32Array, Int32Array]
}

/** A stretch of street with one need all along it: the unit the solver works in. */
export interface Edge {
  id: number
  u: number
  v: number
  pts: XY[]
  len: number
  name: string | null
  highway: string
  oneway: 0 | 1 | -1
  piece: number
  /** Whether the left and the right of the edge as drawn, u to v, are to be thrown at. */
  reqL: boolean
  reqR: boolean
  /** Times the old route threw at each side here, and drove it, at most over the edge. */
  beforeL: number
  beforeR: number
  driven: number
}

export function emptyCover(g: Graph): Cover[] {
  return g.pieces.map((p) => {
    const n = Math.max(1, Math.ceil(p.len / CELL_M))
    return {
      count: [new Uint16Array(n), new Uint16Array(n)],
      last: [new Int32Array(n).fill(-9999), new Int32Array(n).fill(-9999)],
      drive: [new Uint16Array(n), new Uint16Array(n)],
      driveLast: [new Int32Array(n).fill(-9999), new Int32Array(n).fill(-9999)],
    }
  })
}

/** Marks a stretch of a piece as driven, from `s0` to `s1` metres along it, at sample `k`, with the side thrown. */
function mark(cover: Cover, dir: 1 | -1, s0: number, s1: number, side: Side, k: number) {
  const n = cover.count[0].length
  const lo = Math.max(0, Math.floor(Math.min(s0, s1) / CELL_M))
  const hi = Math.min(n - 1, Math.floor((Math.max(s0, s1) - 1e-6) / CELL_M))
  const way = dir === 1 ? 0 : 1
  // The piece's own side that is on the driver's left.
  const left: 0 | 1 = dir === 1 ? 0 : 1
  const sides: (0 | 1)[] = side === 'both' ? [0, 1] : side === 'left' ? [left] : side === 'right' ? [left === 0 ? 1 : 0] : []
  for (let i = lo; i <= hi; i++) {
    if (k - cover.driveLast[way][i] > PASS_GAP) cover.drive[way][i]++
    cover.driveLast[way][i] = k
    for (const a of sides) {
      if (k - cover.last[a][i] > PASS_GAP) cover.count[a][i]++
      cover.last[a][i] = k
    }
  }
}

interface Step {
  piece: number
  dir: 1 | -1
}

/** The pieces of the shortest way from node `a` to node `b`, close by, or null when they aren't close. */
function linkPath(g: Graph, a: number, b: number): Step[] | null {
  if (a === b) return []
  const best = new Map<number, number>([[a, 0]])
  const from = new Map<number, Step & { node: number }>()
  const heap = new MinHeap()
  heap.push(0, a)
  while (heap.size) {
    const d = heap.topKey
    const n = heap.pop()
    if (d > (best.get(n) ?? Infinity)) continue
    if (n === b || d > LINK_LIMIT_M) break
    for (const p of g.incident[n]) {
      const piece = g.pieces[p]
      const dir: 1 | -1 = piece.a === n ? 1 : -1
      const to = dir === 1 ? piece.b : piece.a
      const nd = d + piece.len
      if (nd < (best.get(to) ?? Infinity)) {
        best.set(to, nd)
        from.set(to, { node: n, piece: p, dir })
        heap.push(nd, to)
      }
    }
  }
  if (!from.has(b)) return null
  const out: Step[] = []
  for (let n = b; n !== a; ) {
    const step = from.get(n) as Step & { node: number }
    out.push({ piece: step.piece, dir: step.dir })
    n = step.node
  }
  return out.reverse()
}

/** Marks everything a matched route drove and threw at, and gives how many metres it drove in all, which is the route's length along the map. */
export function coverOf(g: Graph, samples: Sample[], matched: Matched[], cover: Cover[]): number {
  let driven = 0
  const add = (piece: number, dir: 1 | -1, s0: number, s1: number, side: Side, k: number) => {
    if (Math.abs(s1 - s0) < 1e-6) return
    mark(cover[piece], dir, s0, s1, side, k)
    driven += Math.abs(s1 - s0)
  }
  for (let k = 0; k + 1 < matched.length; k++) {
    const a = matched[k]
    const b = matched[k + 1]
    const side = samples[k].side
    if (a.piece < 0 || b.piece < 0) continue
    if (a.piece === b.piece) {
      add(a.piece, b.dir, a.s, b.s, side, k)
      continue
    }
    const pa = g.pieces[a.piece]
    const pb = g.pieces[b.piece]
    add(a.piece, a.dir, a.s, a.dir === 1 ? pa.len : 0, side, k)
    const end = a.dir === 1 ? pa.b : pa.a
    const begin = b.dir === 1 ? pb.a : pb.b
    for (const step of linkPath(g, end, begin) ?? []) add(step.piece, step.dir, 0, g.pieces[step.piece].len, side, k)
    add(b.piece, b.dir, b.dir === 1 ? 0 : pb.len, b.s, side, k)
  }
  return driven
}

/** The cells that were thrown at, with short gaps filled, between runs and to the ends of the piece. */
function fillSlips(count: Uint16Array): boolean[] {
  const on = Array.from(count, (c) => c > 0)
  const n = on.length
  const need = Math.ceil(NIBBLE_M / CELL_M)
  for (let i = 0; i < n; ) {
    if (on[i]) {
      i++
      continue
    }
    let e = i
    while (e + 1 < n && !on[e + 1]) e++
    const touchesEnd = i === 0 || e === n - 1
    if (e - i + 1 <= need && !(i === 0 && e === n - 1)) {
      const before = i > 0 && on[i - 1]
      const after = e < n - 1 && on[e + 1]
      if ((before && after) || (touchesEnd && (before || after))) for (let k = i; k <= e; k++) on[k] = true
    }
    i = e + 1
  }
  return on
}

/** Drops short runs that sit at an end of the piece, when the piece goes on past them, but for an end told to keep its run. */
function dropNibbles(cells: boolean[], keepStart: boolean, keepEnd: boolean): boolean[] {
  const on = [...cells]
  const n = on.length
  const need = Math.ceil(NIBBLE_M / CELL_M)
  for (let i = 0; i < n; ) {
    if (!on[i]) {
      i++
      continue
    }
    let e = i
    while (e + 1 < n && on[e + 1]) e++
    if (e - i + 1 <= need && e - i + 1 < n && ((i === 0 && !keepStart) || (e === n - 1 && !keepEnd))) for (let k = i; k <= e; k++) on[k] = false
    i = e + 1
  }
  return on
}

/** The cells of a side to throw at, tidied: a nibble at a junction dropped, a slip filled, and a run that all but reaches an end taken to it. */
export function tidy(count: Uint16Array, keepStart = false, keepEnd = false): boolean[] {
  return dropNibbles(fillSlips(count), keepStart, keepEnd)
}

/** How many cells are on, counted in from one end. */
function runFrom(on: boolean[], atEnd: boolean): number {
  let n = 0
  while (n < on.length && on[atEnd ? on.length - 1 - n : n]) n++
  return n
}

/** The way a piece runs at one of its ends, going towards that end if `into`, and away from it if not. */
export function headingAtEnd(p: Piece, atEnd: boolean, into: boolean): number {
  const last = p.pts.length - 1
  const [near, next] = atEnd ? [p.pts[last], p.pts[last - 1]] : [p.pts[0], p.pts[1]]
  const [a, b] = into ? [next, near] : [near, next]
  return Math.atan2(b[0] - a[0], b[1] - a[1])
}

/**
 * Whether the street goes on from piece `p`, at the node at one of its ends (its far end if `pAtEnd`), into piece `q`, which reaches that node
 * at its far end if `qAtEnd`: from one piece of a roundabout to the next, whatever each is called and however sharply the ring is drawn, or
 * along the same way, or one of the same name, near enough straight on. What the demand keeps as one stretch across a node (see `joinsOn`)
 * and what the coverage gate joins into one missed run (`joinedMissed`, in audit.ts) both go by this, so they can't disagree. They did once:
 * the gate joined two short runs either side of a junction on a ring drawn as unnamed ways, which the demand had dropped as nibbles, so a
 * route the solver had served in full was blocked.
 */
export function streetGoesOn(p: Piece, pAtEnd: boolean, q: Piece, qAtEnd: boolean): boolean {
  if (p.roundabout && q.roundabout) return true
  if (p.way !== q.way && (!p.name || p.name !== q.name)) return false
  return angleOff(headingAtEnd(q, qAtEnd, false), headingAtEnd(p, pAtEnd, true)) <= STRAIGHT_ON
}

/**
 * Which side of piece `q` is the same side of the road as `side` of piece `p`, where the street goes on from `p` into `q` at a node (see
 * `streetGoesOn` for `pAtEnd` and `qAtEnd`). A piece drawn on away from the node keeps the sides of one drawn into it, and one drawn back
 * towards it has them the other way round.
 */
export function sameSideOn(side: 0 | 1, pAtEnd: boolean, qAtEnd: boolean): 0 | 1 {
  const leavesFromStart = !qAtEnd
  return leavesFromStart === pAtEnd ? side : side === 0 ? 1 : 0
}

/**
 * Whether a short run at one end of a side goes on past the node into a short run of the street straight ahead, on the same side of the
 * road. Alone each looks like the match nibbling at a junction, but together they are a stretch that was really thrown at, and a side
 * street happens to cut it in two. A long run beside a short one is still a nibble: keeping that would send the driver up a stub. Together
 * they have to come to the coverage gate's own length, as the gate joins the same two runs into one gap by the same rule (`joinedMissed`, in
 * audit.ts): a pair it would block Accept over must be a pair the solver is asked to throw, and one length for both keeps them from drifting.
 */
function joinsOn(g: Graph, thrown: [boolean[], boolean[]][], p: Piece, side: 0 | 1, atEnd: boolean): boolean {
  const need = Math.ceil(NIBBLE_M / CELL_M)
  const cells = thrown[p.id][side]
  const mine = runFrom(cells, atEnd)
  if (!mine || mine > need || mine === cells.length) return false
  const node = atEnd ? p.b : p.a
  for (const id of g.incident[node]) {
    const q = g.pieces[id]
    const qAtEnd = q.a !== node
    if (id === p.id || !streetGoesOn(p, atEnd, q, qAtEnd)) continue
    const hers = thrown[id][sameSideOn(side, atEnd, qAtEnd)]
    const theirs = runFrom(hers, qAtEnd)
    const metres = (run: number, piece: Piece, of: number) => run * Math.min(CELL_M, piece.len / of)
    if (theirs && theirs <= need && theirs < hers.length && metres(mine, p, cells.length) + metres(theirs, q, hers.length) >= COVER_GATE_M) return true
  }
  return false
}

/** The part of a piece from `s0` to `s1` metres along it, as points. */
function slice(p: Piece, s0: number, s1: number): XY[] {
  const at = (s: number): XY => {
    // The very end is the node itself, so that the route can close exactly on it.
    if (s >= p.len) return p.pts[p.pts.length - 1]
    let i = 0
    while (i + 2 < p.cum.length && p.cum[i + 1] < s) i++
    const span = p.cum[i + 1] - p.cum[i]
    const t = span ? (s - p.cum[i]) / span : 0
    return [p.pts[i][0] + (p.pts[i + 1][0] - p.pts[i][0]) * t, p.pts[i][1] + (p.pts[i + 1][1] - p.pts[i][1]) * t]
  }
  const out: XY[] = [at(s0)]
  for (let i = 0; i < p.cum.length; i++) if (p.cum[i] > s0 + 0.01 && p.cum[i] < s1 - 0.01) out.push(p.pts[i])
  out.push(at(s1))
  return out
}

/**
 * Which cells of a closed road the old route really drove. A new leg may only use such a road as far as the old route did, and the match
 * nibbling at its mouth from the road it joins is no reason to open it at all. Null for a public road, which any leg may use.
 */
function drivenCells(p: Piece, c: Cover): boolean[] | null {
  return p.open ? null : tidy(c.drive[0].map((n, i) => n + c.drive[1][i]))
}

/**
 * The street graph cut where what is thrown changes, every stretch an edge with the sides it needs, and at `extraCuts`, cells to cut at by
 * piece, whatever is thrown there. New nodes are added after the graph's own.
 */
export function edgesOf(g: Graph, cover: Cover[], extraCuts: ReadonlyMap<number, ReadonlySet<number>> = new Map()): { nodes: XY[]; edges: Edge[] } {
  const nodes: XY[] = g.nodes.map((n) => [n[0], n[1]])
  const edges: Edge[] = []
  const thrown = cover.map((c): [boolean[], boolean[]] => [fillSlips(c.count[0]), fillSlips(c.count[1])])
  const sideOf = (p: Piece, side: 0 | 1) => dropNibbles(thrown[p.id][side], joinsOn(g, thrown, p, side, false), joinsOn(g, thrown, p, side, true))
  for (const p of g.pieces) {
    const c = cover[p.id]
    const L = sideOf(p, 0)
    const R = sideOf(p, 1)
    const walked = drivenCells(p, c)
    const n = L.length
    const cuts = [0]
    const extra = extraCuts.get(p.id)
    for (let i = 1; i < n; i++) if (L[i] !== L[i - 1] || R[i] !== R[i - 1] || (walked && walked[i] !== walked[i - 1]) || extra?.has(i)) cuts.push(i)
    cuts.push(n)
    let u = p.a
    for (let k = 0; k + 1 < cuts.length; k++) {
      const c0 = cuts[k]
      const c1 = cuts[k + 1]
      const final = k + 2 === cuts.length
      const pts = slice(p, c0 * CELL_M, final ? p.len : c1 * CELL_M)
      let v = p.b
      if (!final) {
        v = nodes.length
        nodes.push(pts[pts.length - 1])
      }
      let beforeL = 0
      let beforeR = 0
      let driven = 0
      for (let i = c0; i < c1; i++) {
        beforeL = Math.max(beforeL, c.count[0][i])
        beforeR = Math.max(beforeR, c.count[1][i])
        driven = Math.max(driven, c.drive[0][i] + c.drive[1][i])
      }
      if (walked && !walked[c0] && !L[c0] && !R[c0]) driven = 0
      let len = 0
      for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i])
      edges.push({ id: edges.length, u, v, pts, len, name: p.name, highway: p.highway, oneway: p.oneway, piece: p.id, reqL: L[c0], reqR: R[c0], beforeL, beforeR, driven })
      u = v
    }
  }
  return { nodes, edges }
}

/** Whether a side of a piece is the side towards a roundabout's island: it's on the driver's right all the way round. */
export const islandSide = (p: Pick<Piece, 'roundabout' | 'oneway'>, side: 0 | 1): boolean => p.roundabout && side === (p.oneway >= 0 ? 1 : 0)

/** There's nothing to throw at on a roundabout's island, so that demand goes. Gives the metres dropped. */
export function dropIslands(g: Graph, edges: Edge[]): number {
  let dropped = 0
  for (const e of edges) {
    const p = g.pieces[e.piece]
    if (islandSide(p, 1) && e.reqR) {
      e.reqR = false
      dropped += e.len
    } else if (islandSide(p, 0) && e.reqL) {
      e.reqL = false
      dropped += e.len
    }
  }
  return dropped
}
