import { cumulativeDistances, haversine, sideAt } from '../geo'
import { normalizeSideChanges } from '../routeEdit'
import { routeTurns, turnKind } from '../turns'
import type { Pt, Route } from '../types'
import { CELL_M, coverOf, emptyCover, islandSide, sameSideOn, streetGoesOn, type Cover } from './demand'
import { candidates, toPt, toXY, type BannedTurn, type Graph, type Piece, type XY } from './graph'
import { angleOff, matchRoute, samplesOf, type Matched, type Sample } from './match'
import type { RouteStats } from './types'

/** Measures any route on one footing, from its points and side changes alone: a fresh match and the same cells. It knows nothing of how the route was made. */

type Drawn = Pick<Route, 'points' | 'sideChanges'>

/** A way back along a piece this near its end, in metres, is a turn at that end: a sample can't land any nearer than its own step. */
const TURN_BACK_NEAR_M = 8
/** A match this near a node, in metres, is on it. */
const END_TIE_M = 0.01
/** The walk along a new route that `onMapCheck` makes: its step, and how near a road has to be, in metres. */
const ON_MAP_STEP_M = 1
const ON_MAP_REACH_M = 1.2
/** How far a piece's heading may be from the route's and still be the road it is on, in radians either way. */
const ON_MAP_HEADING = 0.35
/** This many metres off the map, or against a one-way, block Accept. It is above the odd metre of rounding at a sharp bend. */
export const ON_MAP_GATE_M = 2

export interface Audit {
  samples: Sample[]
  matched: Matched[]
  cover: Cover[]
  /** The route along the roads, in metres. */
  drivenM: number
  /** Samples on no road, samples against a one-way, and banned turns made. */
  offRoad: number
  wrongWay: number
  bannedTurns: number
  /** Frontage thrown at more than once, in km. */
  twiceKm: number
  /** How far the end is from the start, in metres. */
  closesM: number
}

/** How far a place on a piece is from the end it is heading for, in metres. */
const toEnd = (p: Piece, m: Pick<Matched, 'dir' | 's'>) => (m.dir === 1 ? p.len - m.s : m.s)

function countBannedTurns(g: Graph, matched: Matched[], banned: BannedTurn[]): number {
  const rules = new Set(banned.map((t) => `${t.from}:${t.via}:${t.to}`))
  let count = 0
  for (let k = 1; k < matched.length; k++) {
    const a = matched[k - 1]
    const b = matched[k]
    if (a.piece < 0 || b.piece < 0) continue
    const pa = g.pieces[a.piece]
    const via = a.dir === 1 ? pa.b : pa.a
    if (a.piece === b.piece) {
      // Turning back at the end of a piece is the only turn a piece makes on its own, and a rule from a way onto itself is about just that.
      if (a.dir !== b.dir && toEnd(pa, a) <= TURN_BACK_NEAR_M && rules.has(`${pa.way}:${via}:${pa.way}`)) count++
      continue
    }
    const pb = g.pieces[b.piece]
    // A route's two ends sit right on a node, where the piece it never drives ties with the one it does. No turn is made into or out of nothing.
    if (k === 1 && toEnd(pa, a) < END_TIE_M) continue
    if (k === matched.length - 1 && pb.len - toEnd(pb, b) < END_TIE_M) continue
    // A rule from a way back onto itself is about turning back, and going straight on along a way cut at a node isn't that.
    if (pa.way === pb.way) continue
    if (rules.has(`${pa.way}:${via}:${pb.way}`)) count++
  }
  return count
}

/** Km of frontage thrown at more than once. A run of one cell is the match's own edge at a turn, not a second throw. */
function twiceThrown(g: Graph, cover: Cover[]): number {
  let twice = 0
  for (let p = 0; p < cover.length; p++) {
    for (const a of [0, 1] as const) {
      const c = cover[p].count[a]
      const cellLen = Math.min(CELL_M, g.pieces[p].len / c.length)
      for (let i = 0; i < c.length; ) {
        if (c[i] <= 1) {
          i++
          continue
        }
        let e = i
        while (e + 1 < c.length && c[e + 1] > 1) e++
        if (e - i + 1 >= 2 || c.length <= 2) for (let k = i; k <= e; k++) twice += cellLen * (c[k] - 1)
        i = e + 1
      }
    }
  }
  return twice / 1000
}

/** What a route's points do on the map, in metres. */
export interface OnMap {
  offRoadM: number
  wrongWayM: number
}

/** How one place on a route lies on the map, going the way given. */
function fitAt(g: Graph, at: XY, heading: number): 'good' | 'against' | 'off' {
  let against = false
  for (const c of candidates(g, at, ON_MAP_REACH_M)) {
    const off = angleOff(heading, c.heading)
    const { oneway } = g.pieces[c.piece]
    if (off <= ON_MAP_HEADING) {
      if (oneway >= 0) return 'good'
      against = true
    } else if (Math.PI - off <= ON_MAP_HEADING) {
      if (oneway <= 0) return 'good'
      against = true
    }
  }
  return against ? 'against' : 'off'
}

/**
 * Lays a route on the map's own lines, a metre at a time, from its points and nothing else. The match can't do this job: it is built to
 * forgive a hand-drawn line, so it will slide a stretch onto a road beside it. A new route's points are the map's own, so here there is
 * nothing to forgive, which is also why this is only for a new route and never for the old one.
 */
export function onMapCheck(g: Graph, points: Pt[]): OnMap {
  const xy = points.map((p) => toXY(g, p))
  const found: OnMap = { offRoadM: 0, wrongWayM: 0 }
  for (let i = 0; i + 1 < xy.length; i++) {
    const [ax, ay] = xy[i]
    const [bx, by] = xy[i + 1]
    const len = Math.hypot(bx - ax, by - ay)
    const heading = Math.atan2(bx - ax, by - ay)
    const steps = Math.ceil(len / ON_MAP_STEP_M)
    for (let k = 0; k < steps; k++) {
      // The middle of each step, as a point's own place can tie between the two parts of a road that meet there.
      const t = (k + 0.5) / steps
      const fit = fitAt(g, [ax + (bx - ax) * t, ay + (by - ay) * t], heading)
      if (fit === 'off') found.offRoadM += len / steps
      else if (fit === 'against') found.wrongWayM += len / steps
    }
  }
  return found
}

/** Runs the fresh match over a route and counts what's wrong with it. */
export function auditRoute(g: Graph, route: Drawn, banned: BannedTurn[], onStep?: (done: number) => void): Audit {
  const samples = samplesOf(g, route.points, route.sideChanges)
  const matched = matchRoute(g, samples, onStep)
  const cover = emptyCover(g)
  const drivenM = coverOf(g, samples, matched, cover)
  let offRoad = 0
  let wrongWay = 0
  for (const m of matched) {
    if (m.piece < 0) {
      offRoad++
      continue
    }
    const way = g.pieces[m.piece].oneway
    if ((way === 1 && m.dir === -1) || (way === -1 && m.dir === 1)) wrongWay++
  }
  const { points } = route
  return {
    samples,
    matched,
    cover,
    drivenM,
    offRoad,
    wrongWay,
    bannedTurns: countBannedTurns(g, matched, banned),
    twiceKm: twiceThrown(g, cover),
    closesM: points.length ? haversine(points[0], points[points.length - 1]) : 0,
  }
}

/** The km of each side as the app reads them, by `sideAt`, and the route's length, on the app's own distances. */
export function sideKm(route: Drawn): Pick<RouteStats, 'km' | 'left' | 'right' | 'both' | 'transit'> {
  const cum = cumulativeDistances(route.points)
  const km = { left: 0, right: 0, both: 0, transit: 0 }
  for (let i = 0; i + 1 < cum.length; i++) km[sideAt(route, i)] += (cum[i + 1] - cum[i]) / 1000
  return { km: (cum[cum.length - 1] ?? 0) / 1000, ...km }
}

/** Real changes of side: rows that repeat the side before them change nothing. */
export function realSideChanges(route: Drawn): number {
  const rows = normalizeSideChanges(route.sideChanges, route.points.length - 1)
  let n = 0
  for (let i = 1; i < rows.length; i++) if (rows[i].side !== rows[i - 1].side) n++
  return n
}

/** U-turns as the app itself reads them. */
export const uturnCount = (points: Pt[]): number => routeTurns(points).filter((t) => turnKind(t.angle) === 'uturn').length

/** A route measured, as the same code before and after. */
export function routeStats(route: Drawn, audit: Audit, closingKm: number): RouteStats {
  const mapKm = audit.drivenM / 1000
  return {
    ...sideKm(route),
    mapKm,
    closingKm,
    closedKm: mapKm + closingKm,
    twiceKm: audit.twiceKm,
    uturns: uturnCount(route.points),
    sideChanges: realSideChanges(route),
  }
}

/** A stretch of one side of a piece. `s` is how far along the piece it starts. */
export interface Stretch {
  piece: number
  side: 0 | 1
  s: number
  len: number
}

/** Stretches of frontage that `need` throws at and `got` doesn't, leaving out a roundabout's island, where nothing can be thrown at. */
export function missedStretches(g: Graph, need: Cover[], got: Cover[]): Stretch[] {
  const out: Stretch[] = []
  for (let p = 0; p < need.length; p++) {
    for (const side of [0, 1] as const) {
      if (islandSide(g.pieces[p], side)) continue
      const n = need[p].count[side]
      const h = got[p].count[side]
      const cellLen = Math.min(CELL_M, g.pieces[p].len / n.length)
      for (let i = 0; i < n.length; ) {
        if (!(n[i] > 0 && h[i] === 0)) {
          i++
          continue
        }
        let e = i
        while (e + 1 < n.length && n[e + 1] > 0 && h[e + 1] === 0) e++
        out.push({ piece: p, side, s: i * cellLen, len: (e - i + 1) * cellLen })
        i = e + 1
      }
    }
  }
  return out
}

/** A missed stretch that ends this near an end of its piece, in metres, reaches the node there. */
const AT_NODE_M = 0.01

/**
 * Whether one missed stretch goes on into another at a node they both reach, along the same side of the road. It is the rule the demand keeps two
 * short runs across a node by (`streetGoesOn`), so that two short runs the gate would join into one of 16 m or more are runs the solver was asked to
 * throw. `aEnd` and `bEnd` say which end of its piece each reaches the node at.
 */
function carriesOn(g: Graph, a: Stretch, aEnd: boolean, b: Stretch, bEnd: boolean): boolean {
  return b.side === sameSideOn(a.side, aEnd, bEnd) && streetGoesOn(g.pieces[a.piece], aEnd, g.pieces[b.piece], bEnd)
}

/**
 * The missed stretches in runs, each run those that go on one into the next across a node along the same side of the road (see `carriesOn`). A
 * frontage that side streets cut into short pieces, or a roundabout cut by the roads into it, is missed as a whole, so it is a run that the coverage
 * gate goes by, and not each piece of it alone, which can be short of the gate where the whole is not.
 */
export function joinedMissed(g: Graph, stretches: readonly Stretch[]): Stretch[][] {
  const parent = stretches.map((_, i) => i)
  const root = (i: number): number => {
    let r = i
    while (parent[r] !== r) r = parent[r]
    return r
  }
  const atNode = new Map<number, { i: number; atEnd: boolean }[]>()
  const reach = (node: number, i: number, atEnd: boolean) => {
    const list = atNode.get(node)
    if (list) list.push({ i, atEnd })
    else atNode.set(node, [{ i, atEnd }])
  }
  stretches.forEach((s, i) => {
    const p = g.pieces[s.piece]
    if (s.s <= AT_NODE_M) reach(p.a, i, false)
    if (s.s + s.len >= p.len - AT_NODE_M) reach(p.b, i, true)
  })
  for (const ends of atNode.values()) {
    for (let x = 0; x < ends.length; x++) {
      for (let y = x + 1; y < ends.length; y++) {
        const a = ends[x]
        const b = ends[y]
        if (a.i !== b.i && carriesOn(g, stretches[a.i], a.atEnd, stretches[b.i], b.atEnd)) parent[root(a.i)] = root(b.i)
      }
    }
  }
  const runs = new Map<number, Stretch[]>()
  stretches.forEach((s, i) => {
    const r = root(i)
    const run = runs.get(r)
    if (run) run.push(s)
    else runs.set(r, [s])
  })
  return [...runs.values()]
}

/** Metres of each piece that the second route drives and the first never did. */
export function newRoadMetres(g: Graph, before: Cover[], after: Cover[]): Map<number, number> {
  const out = new Map<number, number>()
  for (let p = 0; p < before.length; p++) {
    const b = before[p].drive
    const c = after[p].drive
    const cells = b[0].length
    const cellLen = Math.min(CELL_M, g.pieces[p].len / cells)
    let metres = 0
    for (let i = 0; i < cells; i++) if (b[0][i] + b[1][i] === 0 && c[0][i] + c[1][i] > 0) metres += cellLen
    if (metres) out.set(p, metres)
  }
  return out
}

/** Where a place along a piece is. */
export function placeOn(g: Graph, piece: Piece, s: number): Pt {
  let i = 0
  while (i + 2 < piece.cum.length && piece.cum[i + 1] < s) i++
  const span = piece.cum[i + 1] - piece.cum[i]
  const t = span ? Math.min(1, (s - piece.cum[i]) / span) : 0
  const [ax, ay] = piece.pts[i]
  const [bx, by] = piece.pts[i + 1]
  return toPt(g, [ax + (bx - ax) * t, ay + (by - ay) * t])
}
