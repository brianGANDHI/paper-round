import { cumulativeDistances, haversine, sideAt, snapToPath } from './geo'
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
 * Start a new stretch where `pos` touches the route. A point is added to the
 * route when needed; both halves keep the side they had. Null when the tap is
 * off the route or at a spot that can't start a stretch.
 */
export function splitAt(route: Route, pos: Pt): Route | null {
  const snap = snapToPath(pos, route.points)
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
