import type { Pt } from '../types'
import type { OsmData, OsmRelation, OsmWay } from './types'

/** The street graph from OSM: ways cut at every node they share, in metres on a flat projection around the route's first point. */

export type XY = [number, number]

/** Where the flat projection is centred. */
export interface Origin {
  lat0: number
  lng0: number
}

/** A stretch of road between two nodes of the graph. */
export interface Piece {
  id: number
  /** Graph node at the start and at the end, as the way is drawn. */
  a: number
  b: number
  pts: XY[]
  /** How far along the piece each point is, in metres. */
  cum: number[]
  len: number
  name: string | null
  highway: string
  way: number
  /** 0 both ways, 1 only a to b, -1 only b to a. */
  oneway: 0 | 1 | -1
  /** A public road with no barrier on it: one a new leg may be sent down even if the old route never was. */
  open: boolean
  /** Part of a roundabout: the side towards the island has no frontage. */
  roundabout: boolean
}

/** A move along a piece, from a node. */
export interface Move {
  piece: number
  dir: 1 | -1
  to: number
}

export interface GridHit {
  piece: number
  seg: number
}

export interface Graph extends Origin {
  nodes: XY[]
  pieces: Piece[]
  /** The moves leaving each node, whichever way a move is allowed. */
  out: Move[][]
  /** The pieces at each node, whichever way they run. A saved route may break a one-way, so matching needs these. */
  incident: number[][]
  grid: Map<number, GridHit[]>
  /** The graph node of an OSM node, where it is one. */
  osmNode: Map<number, number>
}

/** A turn the map says can't be made: from a way, through a node of the graph, onto a way. */
export interface BannedTurn {
  from: number
  via: number
  to: number
}

const EARTH_R = 6371000
const RAD = Math.PI / 180

export const toXY = (o: Origin, p: Pt): XY => [(p.lng - o.lng0) * RAD * Math.cos(o.lat0 * RAD) * EARTH_R, (p.lat - o.lat0) * RAD * EARTH_R]
export const toPt = (o: Origin, [x, y]: XY): Pt => ({ lat: o.lat0 + y / (RAD * EARTH_R), lng: o.lng0 + x / (RAD * Math.cos(o.lat0 * RAD) * EARTH_R) })
export const dist = (a: XY, b: XY): number => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Which way a way may be driven. An explicit tag wins; a roundabout and a motorway are one-way without saying so. */
export function onewayOf(tags: Record<string, string>): 0 | 1 | -1 {
  const o = tags.oneway
  if (o === 'yes' || o === '1' || o === 'true') return 1
  if (o === '-1' || o === 'reverse') return -1
  if (o === 'no' || o === 'false' || o === '0') return 0
  if (tags.junction === 'roundabout' || tags.junction === 'circular' || tags.highway === 'motorway') return 1
  return 0
}

const PUBLIC = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'road', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'])
const NO_ENTRY = new Set(['private', 'no', 'customers', 'delivery', 'agricultural', 'forestry'])
/** Barriers that stop nobody in a car. */
const FREE_BARRIER = new Set(['cattle_grid', 'toll_booth', 'border_control'])

/** Whether a way is a public road anyone may drive. A service road or a track is not, unless the old route already used it. */
export const publicRoad = (tags: Record<string, string>): boolean =>
  PUBLIC.has(tags.highway) && !NO_ENTRY.has(tags.access) && !NO_ENTRY.has(tags.motor_vehicle) && !NO_ENTRY.has(tags.vehicle) && !NO_ENTRY.has(tags.motorcar)

const GRID_M = 40
/** A number for a grid cell, as this is looked up for every point of every match. Cells 40 m across keep well inside the range for the size of a round. */
const cellKey = (cx: number, cy: number) => cx * 131072 + cy

function pieceGrid(pieces: Piece[]): Map<number, GridHit[]> {
  const grid = new Map<number, GridHit[]>()
  for (const p of pieces) {
    for (let seg = 0; seg + 1 < p.pts.length; seg++) {
      const [ax, ay] = p.pts[seg]
      const [bx, by] = p.pts[seg + 1]
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (GRID_M / 2)))
      const seen = new Set<number>()
      for (let s = 0; s <= steps; s++) {
        const key = cellKey(Math.floor((ax + ((bx - ax) * s) / steps) / GRID_M), Math.floor((ay + ((by - ay) * s) / steps) / GRID_M))
        if (seen.has(key)) continue
        seen.add(key)
        const list = grid.get(key)
        if (list) list.push({ piece: p.id, seg })
        else grid.set(key, [{ piece: p.id, seg }])
      }
    }
  }
  return grid
}

/** Builds the graph. A way is cut at any node two ways share, or one way uses twice, and each way's two ends are nodes. */
export function buildGraph(osm: OsmData, origin: Origin): Graph {
  const where = new Map<number, Pt>()
  const barriers = new Set<number>()
  const ways: OsmWay[] = []
  for (const e of osm.elements) {
    if (e.type === 'node') {
      where.set(e.id, { lat: e.lat, lng: e.lon })
      if (e.tags?.barrier && !FREE_BARRIER.has(e.tags.barrier)) barriers.add(e.id)
    } else if (e.type === 'way' && e.nodes.length >= 2) ways.push(e)
  }
  const used = new Map<number, number>()
  for (const w of ways) for (const n of w.nodes) used.set(n, (used.get(n) ?? 0) + 1)
  const osmNode = new Map<number, number>()
  const nodes: XY[] = []
  const nodeOf = (id: number) => {
    let i = osmNode.get(id)
    if (i === undefined) {
      i = nodes.length
      osmNode.set(id, i)
      nodes.push(toXY(origin, where.get(id) as Pt))
    }
    return i
  }
  const pieces: Piece[] = []
  for (const w of ways) {
    const tags = w.tags ?? {}
    const ids = w.nodes.filter((id) => where.has(id))
    let start = 0
    for (let i = 1; i < ids.length; i++) {
      if (i < ids.length - 1 && (used.get(ids[i]) ?? 0) < 2) continue
      const run = ids.slice(start, i + 1)
      start = i
      const pts = run.map((id) => toXY(origin, where.get(id) as Pt))
      const cum = [0]
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + dist(pts[k - 1], pts[k]))
      const len = cum[cum.length - 1]
      if (len <= 0.01) continue
      pieces.push({
        id: pieces.length,
        a: nodeOf(run[0]),
        b: nodeOf(run[run.length - 1]),
        pts,
        cum,
        len,
        name: tags.name ?? (tags.ref ? `Road ${tags.ref}` : null),
        highway: tags.highway ?? 'road',
        way: w.id,
        oneway: onewayOf(tags),
        open: publicRoad(tags) && !run.some((id) => barriers.has(id)),
        roundabout: tags.junction === 'roundabout' || tags.junction === 'circular',
      })
    }
  }
  const out: Move[][] = nodes.map(() => [])
  const incident: number[][] = nodes.map(() => [])
  for (const p of pieces) {
    if (p.oneway >= 0) out[p.a].push({ piece: p.id, dir: 1, to: p.b })
    if (p.oneway <= 0) out[p.b].push({ piece: p.id, dir: -1, to: p.a })
    incident[p.a].push(p.id)
    if (p.b !== p.a) incident[p.b].push(p.id)
  }
  return { ...origin, nodes, pieces, out, incident, grid: pieceGrid(pieces), osmNode }
}

/** The nearest place on a piece. `heading` is the way the piece runs there as drawn, in radians clockwise from north. */
export interface Candidate {
  piece: number
  s: number
  d: number
  heading: number
}

/** The nearest place on each piece near a point, one per piece, nearest first. */
export function candidates(g: Graph, at: XY, radius: number): Candidate[] {
  const cx = Math.floor(at[0] / GRID_M)
  const cy = Math.floor(at[1] / GRID_M)
  const span = Math.ceil(radius / GRID_M)
  const best = new Map<number, Candidate>()
  const seen = new Set<number>()
  for (let i = cx - span; i <= cx + span; i++) {
    for (let j = cy - span; j <= cy + span; j++) {
      for (const hit of g.grid.get(cellKey(i, j)) ?? []) {
        const key = hit.piece * 8192 + hit.seg
        if (seen.has(key)) continue
        seen.add(key)
        const piece = g.pieces[hit.piece]
        const A = piece.pts[hit.seg]
        const B = piece.pts[hit.seg + 1]
        const dx = B[0] - A[0]
        const dy = B[1] - A[1]
        const l2 = dx * dx + dy * dy
        const t = l2 ? Math.max(0, Math.min(1, ((at[0] - A[0]) * dx + (at[1] - A[1]) * dy) / l2)) : 0
        const d = Math.hypot(A[0] + dx * t - at[0], A[1] + dy * t - at[1])
        if (d > radius) continue
        const have = best.get(hit.piece)
        if (!have || d < have.d) best.set(hit.piece, { piece: hit.piece, s: piece.cum[hit.seg] + t * Math.sqrt(l2), d, heading: Math.atan2(dx, dy) })
      }
    }
  }
  return [...best.values()].sort((a, b) => a.d - b.d)
}

/** Turn rules the graph can use, and how many it can't. Only a rule through a single node is read; one through a way is left out and counted. A rule may name several ways it applies from or to, and it holds for each. */
function readRule(g: Graph, r: OsmRelation): BannedTurn[] | null {
  const via = r.members.find((m) => m.role === 'via' && m.type === 'node')
  const ways = (role: string) => r.members.filter((m) => m.role === role && m.type === 'way').map((m) => m.ref)
  const froms = ways('from')
  const tos = ways('to')
  if (!via || !froms.length || !tos.length) return null
  const node = g.osmNode.get(via.ref)
  if (node === undefined) return []
  const rule = r.tags?.restriction ?? ''
  if (rule.startsWith('no_')) return froms.flatMap((from) => tos.map((to) => ({ from, via: node, to })))
  if (!rule.startsWith('only_')) return []
  // "Only straight on" bans every other way out of the node, and a turn back along the way itself.
  const others = new Set(g.incident[node].map((p) => g.pieces[p].way))
  for (const to of tos) others.delete(to)
  return froms.flatMap((from) => [...others].map((other) => ({ from, via: node, to: other })))
}

/** The turns the map bans at the nodes of the graph, and how many rules could not be read. */
export function bannedTurns(g: Graph, osm: OsmData): { banned: BannedTurn[]; unread: number } {
  const banned: BannedTurn[] = []
  let unread = 0
  for (const e of osm.elements) {
    if (e.type !== 'relation' || !e.tags?.restriction) continue
    const rule = readRule(g, e)
    if (rule) banned.push(...rule)
    else unread++
  }
  return { banned, unread }
}
