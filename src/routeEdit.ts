import { cumulativeDistances, haversine, sideAt, snapToPath, snapWithin, type Occurrence } from './geo'
import type { Pt, Route, Side, SideChange, Stop, StopType } from './types'

/** A tap within this distance of a split target counts as being on the route. */
const SPLIT_TOLERANCE_M = 40
/** A split this close to an existing point reuses that point instead of adding one. */
const VERTEX_SNAP_M = 3
/** Taps this close to the previous point are accidental double taps. */
const DUPLICATE_TAP_M = 2
/** How far from the route a stop may be placed. */
export const MAX_STOP_OFFSET_M = 60

export const segmentCount = (r: Pick<Route, 'points'>) => Math.max(0, r.points.length - 1)

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
}

export function routeLength(points: Pt[]): number {
  const d = cumulativeDistances(points)
  return d[d.length - 1] ?? 0
}

/** Sorted, de-duplicated side changes that start at segment 0 and stay within the route. */
export function normalizeSideChanges(changes: SideChange[], segs: number): SideChange[] {
  if (segs < 1) return []
  const byIdx = new Map<number, Side>()
  for (const c of changes) if (c.idx >= 0 && c.idx < segs) byIdx.set(c.idx, c.side)
  if (!byIdx.has(0)) byIdx.set(0, 'both')
  return [...byIdx.entries()].sort((a, b) => a[0] - b[0]).map(([idx, side]) => ({ idx, side }))
}

/** Make saved data safe to use, whatever version or shape it was saved in. */
export function normalizeRoute(r: Partial<Route> | null | undefined): Route {
  const points = Array.isArray(r?.points) ? r.points : []
  const segs = Math.max(0, points.length - 1)
  const stops = Array.isArray(r?.stops) ? r.stops : []
  return {
    points,
    sideChanges: normalizeSideChanges(Array.isArray(r?.sideChanges) ? r.sideChanges : [], segs),
    stops: stops.map((s) => ({ ...s, pathIdx: Math.min(Math.max(0, s.pathIdx), Math.max(0, segs - 1)) })),
  }
}

export function appendPoint(route: Route, p: Pt): Route {
  const last = route.points[route.points.length - 1]
  if (last && haversine(last, p) < DUPLICATE_TAP_M) return route
  const points = [...route.points, p]
  return { ...route, points, sideChanges: normalizeSideChanges(route.sideChanges, points.length - 1) }
}

export function removeLastPoint(route: Route): Route {
  if (!route.points.length) return route
  const points = route.points.slice(0, -1)
  const segs = Math.max(0, points.length - 1)
  return {
    points,
    sideChanges: normalizeSideChanges(route.sideChanges, segs),
    stops: route.stops.map((s) => (s.pathIdx >= segs ? { ...s, pathIdx: Math.max(0, segs - 1) } : s)),
  }
}

/** A stretch of the route with one delivery side. Covers points idx..endIdx. */
export interface Section {
  index: number
  idx: number
  endIdx: number
  side: Side
  startM: number
  endM: number
}

export function sections(route: Route): Section[] {
  const segs = segmentCount(route)
  const changes = normalizeSideChanges(route.sideChanges, segs)
  const cum = cumulativeDistances(route.points)
  return changes.map((c, i) => {
    const endIdx = i + 1 < changes.length ? changes[i + 1].idx : segs
    return { index: i, idx: c.idx, endIdx, side: c.side, startM: cum[c.idx], endM: cum[endIdx] }
  })
}

export function setSectionSide(route: Route, index: number, side: Side): SideChange[] {
  return sections(route).map((s) => ({ idx: s.idx, side: s.index === index ? side : s.side }))
}

/** Merge a stretch into the one before it. The first stretch can't be merged. */
export function removeSplit(route: Route, index: number): SideChange[] {
  return sections(route)
    .filter((s) => s.index !== index || index === 0)
    .map((s) => ({ idx: s.idx, side: s.side }))
}

/**
 * Start a new stretch where `pos` touches the route (or, with `range`, touches the
 * segments in that range). A point is added to the
 * route when needed; both halves keep the side they had. Null when the tap is
 * off the route or at a spot that can't start a stretch.
 */
export function splitAt(route: Route, pos: Pt, range?: { from: number; to: number }): Route | null {
  // When a road is driven twice both passes lie under the tap, so `range` picks the pass to split.
  const snap = range ? snapWithin(pos, route.points, range.from, range.to) : snapToPath(pos, route.points)
  if (!snap || snap.dist > SPLIT_TOLERANCE_M) return null
  const segs = segmentCount(route)
  const changes = normalizeSideChanges(route.sideChanges, segs)
  const a = route.points[snap.idx]
  const b = route.points[snap.idx + 1]

  let vertex: number | null = null
  if (haversine(snap.point, a) < VERTEX_SNAP_M) vertex = snap.idx
  else if (haversine(snap.point, b) < VERTEX_SNAP_M) vertex = snap.idx + 1
  if (vertex !== null) {
    if (vertex <= 0 || vertex >= segs || changes.some((c) => c.idx === vertex)) return null
    const withSplit = [...changes, { idx: vertex, side: sideAt({ sideChanges: changes }, vertex) }]
    return { ...route, sideChanges: normalizeSideChanges(withSplit, segs) }
  }

  const i = snap.idx
  const points = [...route.points.slice(0, i + 1), snap.point, ...route.points.slice(i + 1)]
  const shifted = changes.map((c) => (c.idx > i ? { ...c, idx: c.idx + 1 } : c))
  shifted.push({ idx: i + 1, side: sideAt({ sideChanges: changes }, i) })
  const stops = route.stops.map((s) => {
    if (s.pathIdx > i) return { ...s, pathIdx: s.pathIdx + 1 }
    if (s.pathIdx < i) return s
    const t = snapToPath(s, [a, b])?.t ?? 0
    return t >= snap.t ? { ...s, pathIdx: i + 1 } : s
  })
  return { points, sideChanges: normalizeSideChanges(shifted, segs + 1), stops }
}

export type RepeatMode = 'back' | 'again'

/**
 * The side a repeated pass starts with. Coming back along a road with the same label
 * covers the other side of the street; going the same way again needs the opposite label.
 */
export function defaultRepeatSide(side: Side, mode: RepeatMode): Side {
  if (side === 'both' || mode === 'back') return side
  return side === 'left' ? 'right' : 'left'
}

/** A gap this small between the end of the route and the start of a repeated pass is the same spot. */
const JOIN_M = 15

/**
 * Add another pass over a section to the end of the route: back along it, or along it
 * again the same way. The new pass gets a side of its own. When it doesn't start where
 * the route ends, the link between the two becomes a short section of its own on both sides.
 */
export function repeatSection(route: Route, index: number, mode: RepeatMode): Route | null {
  const section = sections(route)[index]
  if (!section) return null
  const source = route.points.slice(section.idx, section.endIdx + 1)
  if (source.length < 2) return null
  const pass = mode === 'back' ? [...source].reverse() : source
  const last = route.points[route.points.length - 1]
  const joined = haversine(last, pass[0]) <= JOIN_M
  const points = [...route.points, ...(joined ? pass.slice(1) : pass).map((q) => ({ ...q }))]
  const first = segmentCount(route)
  const side = defaultRepeatSide(section.side, mode)
  const added: SideChange[] = joined ? [{ idx: first, side }] : [{ idx: first, side: 'both' }, { idx: first + 1, side }]
  return {
    ...route,
    points,
    sideChanges: normalizeSideChanges([...normalizeSideChanges(route.sideChanges, first), ...added], segmentCount({ points })),
  }
}

/** The sides thrown to each time the route passes a stop, without repeats, in route order. */
export function stopSides(route: Route, occs: Occurrence[], stopId: string): Side[] {
  const sides: Side[] = []
  for (const o of occs) {
    if (o.stop.id !== stopId) continue
    const side = sideAt(route, o.idx)
    if (!sides.includes(side)) sides.push(side)
  }
  return sides
}

let nextId = 0
export const newStopId = () => `${Date.now().toString(36)}${(nextId++).toString(36)}`

/** A stop at `p`, tied to the nearest part of the route, with how far off the route it is. */
export function stopAt(
  route: Route,
  p: Pt,
  type: StopType,
  extra: { label?: string; qty?: number } = {},
): { stop: Stop; offM: number } | null {
  const snap = snapToPath(p, route.points)
  if (!snap) return null
  const stop: Stop = { id: newStopId(), lat: p.lat, lng: p.lng, pathIdx: snap.idx, type }
  if (extra.qty) stop.qty = extra.qty
  if (extra.label) stop.label = extra.label
  return { stop, offM: snap.dist }
}
