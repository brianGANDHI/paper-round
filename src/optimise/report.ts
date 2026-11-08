import { haversine } from '../geo'
import { STREET_MATCH_DEG, STREET_SNAP_M, streetQueries } from '../streets'
import { routeTurns } from '../turns'
import type { Pt, TurnStreet } from '../types'
import { joinedMissed, missedStretches, newRoadMetres, placeOn, type Audit, type Stretch } from './audit'
import type { Edge } from './demand'
import { candidates, toPt, toXY, type Graph } from './graph'
import { BUSY_UTURN_M, NO_UTURN_M, type Leg, type Problem } from './problem'
import { COVER_GATE_M } from './run'
import type { Gap, NewRoad, StreetStretch, TurnBack, WorthChecking } from './types'
import { NO_NAME, streetKey, streetName, type World } from './world'

/** What a finished run has to say for itself, beyond the route: gaps, new roads, turn-backs, and what's worth a look on the ground. */

/** New road shorter than this on a street is the match's edge at a junction, not somewhere new to go, in metres. */
const NEW_ROAD_MIN_M = 20
/** One-sided stretches shorter than this aren't worth a line, in metres. */
const ONE_SIDE_MIN_M = 40
/** A gap this near a dead end is at its head, in metres: a court's head and the turn in it are about this big. */
const HEAD_M = 25
/** The old route turned back here too if it did so within this distance, in metres. */
const SAME_TURN_M = 30
/** A road with a name may be this much further than the nearest and still be the one, in metres: the nearest may be a driveway with no name. */
const NAMED_WINDOW_M = 10

const wholeMetres = (m: number) => Math.round(m)

/**
 * Stretches the old route threw at and the new one doesn't, longest first. A run of them that goes on from one piece into the next along the same side
 * is one gap, as long as all of it (see `joinedMissed`): it is that length the coverage gate goes by. A gap is named and placed by its longest piece
 * that has a name, and it is at the head of a dead end when most of it is.
 */
export function gapsOf(w: World, pr: Pick<Problem, 'deadEnd'>, after: Audit): Gap[] {
  const { graph: g } = w
  const head = (node: number, m: number) => pr.deadEnd[node] === 1 && m <= HEAD_M
  const atHead = (s: Stretch) => {
    const piece = g.pieces[s.piece]
    return head(piece.a, s.s) || head(piece.b, piece.len - s.s - s.len)
  }
  const longest = (run: Stretch[]) => run.reduce((a, b) => (b.len > a.len ? b : a))
  return joinedMissed(g, missedStretches(g, w.audit.cover, after.cover))
    .map((run) => {
      const named = run.filter((s) => g.pieces[s.piece].name !== null)
      const s = longest(named.length ? named : run)
      const piece = g.pieces[s.piece]
      const m = run.reduce((sum, r) => sum + r.len, 0)
      const headM = run.reduce((sum, r) => sum + (atHead(r) ? r.len : 0), 0)
      return { ...placeOn(g, piece, s.s + s.len / 2), street: piece.name ?? NO_NAME, m, atHead: headM * 2 > m }
    })
    .sort((a, b) => b.m - a.m)
}

/** Roads the new route uses that the old one never drove, by street, longest first. */
export function newRoadsOf(w: World, after: Audit): { roads: NewRoad[]; km: number } {
  const metres = new Map<string, number>()
  let total = 0
  for (const [piece, m] of newRoadMetres(w.graph, w.audit.cover, after.cover)) {
    const name = w.graph.pieces[piece].name ?? NO_NAME
    metres.set(name, (metres.get(name) ?? 0) + m)
    total += m
  }
  const roads = [...metres].filter(([, m]) => m >= NEW_ROAD_MIN_M).map(([street, m]) => ({ street, km: m / 1000 }))
  return { roads: roads.sort((a, b) => b.km - a.km), km: total / 1000 }
}

/** Closed roads the new route drives further along than the old one did: a private road, a gated one, a track or a service road. */
export function closedRoadsUsed(w: World, after: Audit): string[] {
  const names = new Set<string>()
  for (const [piece, m] of newRoadMetres(w.graph, w.audit.cover, after.cover)) {
    const p = w.graph.pieces[piece]
    if (!p.open && m >= COVER_GATE_M) names.add(p.name ?? NO_NAME)
  }
  return [...names]
}

/** Where the drive turns back with no dead end to make it. */
export function turnBacksOf(w: World, pr: Problem, run: Leg[]): TurnBack[] {
  const out: TurnBack[] = []
  for (let i = 1; i < run.length; i++) {
    const a = pr.arcs[run[i].arc]
    if (pr.arcs[run[i - 1].arc].rev !== a.id || pr.deadEnd[a.from]) continue
    const cost = pr.uturnAt[a.from]
    const at = toPt(w.graph, w.nodes[a.from])
    out.push({
      ...at,
      street: streetName(w.edges[a.edge]),
      level: cost >= NO_UTURN_M ? 'main' : cost >= BUSY_UTURN_M ? 'busy' : 'plain',
      alsoToday: w.turnsToday.some((p) => haversine(p, at) <= SAME_TURN_M),
    })
  }
  return out
}

/** One-sided edges joined up where they meet, street by street. */
function oneSidedRuns(edges: Edge[]): Edge[][] {
  const parent = new Map<number, number>()
  const find = (start: number): number => {
    let a = start
    for (let up = parent.get(a); up !== undefined && up !== a; up = parent.get(a)) a = up
    return a
  }
  for (const e of edges) {
    parent.set(e.u, find(e.u))
    parent.set(e.v, find(e.v))
    parent.set(find(e.u), find(e.v))
  }
  const runs = new Map<number, Edge[]>()
  for (const e of edges) {
    const root = find(e.u)
    const list = runs.get(root)
    if (list) list.push(e)
    else runs.set(root, [e])
  }
  return [...runs.values()]
}

/**
 * Stretches thrown on one side only, on streets otherwise thrown on both. Demand comes from the old route's own sides, so the new route
 * throws what the old one did and these can't be called missed. It may just be that nobody lives there, but it's worth asking.
 */
export function oneSidedStretches(w: World): StreetStretch[] {
  const byStreet = new Map<string, Edge[]>()
  for (const e of w.edges) {
    if (!e.name || (!e.reqL && !e.reqR)) continue
    const key = streetKey(w, e)
    const list = byStreet.get(key)
    if (list) list.push(e)
    else byStreet.set(key, [e])
  }
  const out: StreetStretch[] = []
  for (const list of byStreet.values()) {
    const sum = (edges: Edge[]) => edges.reduce((a, e) => a + e.len, 0)
    const oneSided = list.filter((e) => e.reqL !== e.reqR)
    if (!oneSided.length || sum(list.filter((e) => e.reqL && e.reqR)) < sum(oneSided)) continue
    for (const run of oneSidedRuns(oneSided)) {
      const m = sum(run)
      if (m < ONE_SIDE_MIN_M) continue
      const mid = run[run.length >> 1]
      out.push({ ...toPt(w.graph, mid.pts[mid.pts.length >> 1]), street: streetName(mid), m })
    }
  }
  return out.sort((a, b) => b.m - a.m)
}

const gapText = (g: Gap) =>
  g.atHead
    ? `${g.street}: about ${wholeMetres(g.m)} m at the end isn't thrown at, where the old route looped round and the new one turns on a point.`
    : `${g.street}: about ${wholeMetres(g.m)} m isn't thrown at.`

/** The list for the driver, longest first: a street's gaps counted as one line, and each one-sided stretch as one. */
export function worthChecking(gaps: Gap[], oneSided: StreetStretch[]): WorthChecking[] {
  const byStreet = new Map<string, Gap>()
  for (const g of gaps) {
    const have = byStreet.get(g.street)
    if (have) {
      have.m += g.m
      have.atHead ||= g.atHead
    } else byStreet.set(g.street, { ...g })
  }
  const lines: WorthChecking[] = [...byStreet.values()].map(({ atHead, ...g }) => ({ ...g, kind: 'gap', text: gapText({ ...g, atHead }) }))
  for (const s of oneSided) lines.push({ ...s, kind: 'one-side', text: `${s.street}: about ${wholeMetres(s.m)} m thrown on one side only, and the rest of the street on both.` })
  return lines.sort((a, b) => b.m - a.m)
}

/** The name of the road at a place, running about the way given: the nearest named road near the nearest of all. Empty when it has none. */
function roadAt(g: Graph, at: Pt, bearingDeg: number): string {
  const heading = (bearingDeg * Math.PI) / 180
  const near = candidates(g, toXY(g, at), STREET_SNAP_M).filter((c) => {
    const off = Math.abs(((c.heading - heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
    return Math.min(off, Math.PI - off) <= (STREET_MATCH_DEG * Math.PI) / 180
  })
  if (!near.length) return ''
  const named = near.find((c) => g.pieces[c.piece].name && c.d <= near[0].d + NAMED_WINDOW_M)
  return named ? (g.pieces[named.piece].name ?? '') : ''
}

/** Names for a route's turns from the map in hand, in the form the app keeps them: an empty name means the road has none. */
export function turnStreets(g: Graph, points: Pt[]): TurnStreet[] {
  const out: TurnStreet[] = []
  for (const q of streetQueries(points, routeTurns(points))) {
    if (q) out.push({ lat: q.lat, lng: q.lng, out: q.out, name: roadAt(g, q.point, q.out) })
  }
  return out
}
