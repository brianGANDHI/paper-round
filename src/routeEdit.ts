import { alongPath, bearing, cumulativeDistances, haversine, sideAt, snapWithin, type Occurrence, type Snap } from './geo'
import type { Pt, Route, Side, SideChange, Stop, StopType } from './types'

/** A tap within this distance of the route counts as being on it, when editing sections. */
export const ON_ROUTE_M = 40
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
    stops: stops.map(({ side, ...s }) => ({
      ...s,
      pathIdx: Math.min(Math.max(0, s.pathIdx), Math.max(0, segs - 1)),
      ...(side === 'left' || side === 'right' ? { side } : {}),
    })),
  }
}

/** Whether a tap lands on the route's last point, which adding it would ignore. */
export function isDuplicateTap(route: Pick<Route, 'points'>, p: Pt): boolean {
  const last = route.points[route.points.length - 1]
  return !!last && haversine(last, p) < DUPLICATE_TAP_M
}

/**
 * Add a point to the end of the route. With `side`, the stretch it creates is thrown on that
 * side: when that differs from the stretch before it, a new section starts there.
 */
export function appendPoint(route: Route, p: Pt, side?: Side): Route {
  if (isDuplicateTap(route, p)) return route
  const points = [...route.points, p]
  const segs = points.length - 1
  let changes = normalizeSideChanges(route.sideChanges, segmentCount(route))
  if (side && segs >= 1) {
    const created = segs - 1
    if (created === 0) changes = [{ idx: 0, side }]
    else if (sideAt({ sideChanges: changes }, created - 1) !== side) changes = [...changes, { idx: created, side }]
  }
  return { ...route, points, sideChanges: normalizeSideChanges(changes, segs) }
}

/**
 * Add several points to the end of the route, in order, exactly as if each had been tapped with
 * `side`: a new section starts at the first of them if the side differs from the route's last stretch.
 */
export function appendPoints(route: Route, pts: Pt[], side?: Side): Route {
  return pts.reduce((r, p) => appendPoint(r, p, side), route)
}

/** The closest point on the route, anywhere along it, or only within the segments of `range`. */
export function nearestOnRoute(route: Pick<Route, 'points'>, pos: Pt, range?: { from: number; to: number }): Snap | null {
  return snapWithin(pos, route.points, range?.from ?? 0, range?.to ?? route.points.length)
}

/** Move one point. */
export function movePoint(route: Route, index: number, pos: Pt): Route {
  if (index < 0 || index >= route.points.length) return route
  return { ...route, points: route.points.map((q, i) => (i === index ? { lat: pos.lat, lng: pos.lng } : q)) }
}

/**
 * Make sure the route has a point at `snap`: a point already within a few metres is reused,
 * otherwise one is added. Sections and stops after the new point shift along with it.
 */
function ensureVertex(route: Route, snap: Snap): { route: Route; vertex: number } {
  const i = snap.idx
  const a = route.points[i]
  const b = route.points[i + 1]
  if (haversine(snap.point, a) < VERTEX_SNAP_M) return { route, vertex: i }
  if (haversine(snap.point, b) < VERTEX_SNAP_M) return { route, vertex: i + 1 }
  const segs = segmentCount(route)
  const points = [...route.points.slice(0, i + 1), snap.point, ...route.points.slice(i + 1)]
  // The segment is cut in two and both halves keep its side, so only later sections move.
  const changes = normalizeSideChanges(route.sideChanges, segs).map((c) => (c.idx > i ? { ...c, idx: c.idx + 1 } : c))
  const stops = route.stops.map((s) => {
    if (s.pathIdx > i) return { ...s, pathIdx: s.pathIdx + 1 }
    if (s.pathIdx < i) return s
    const t = snapWithin(s, [a, b], 0, 1)?.t ?? 0
    return t >= snap.t ? { ...s, pathIdx: i + 1 } : s
  })
  return { route: { points, sideChanges: normalizeSideChanges(changes, segs + 1), stops }, vertex: i + 1 }
}

/** Add a point in the middle of a segment (its midpoint unless `pos` is given). Returns the new point's index. */
export function insertPoint(route: Route, segment: number, pos?: Pt): { route: Route; vertex: number } | null {
  const a = route.points[segment]
  const b = route.points[segment + 1]
  if (!a || !b) return null
  const point = pos ?? { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }
  const snap = snapWithin(point, route.points, segment, segment + 1)
  if (!snap) return null
  const result = ensureVertex(route, { ...snap, point })
  return result
}

/** Take a point out. The route closes up around it and every other section keeps its side. */
export function deletePoint(route: Route, index: number): Route {
  const n = route.points.length
  if (index < 0 || index >= n) return route
  const points = route.points.filter((_, i) => i !== index)
  const before = n - 1
  const after = Math.max(0, points.length - 1)

  // Where each old segment ends up. Deleting a point in the middle joins the two segments beside it
  // into one that keeps the earlier one's side.
  const moved = (k: number): number | null => {
    if (index === 0) return k === 0 ? null : k - 1
    if (index === n - 1) return k === n - 2 ? null : k
    if (k < index - 1) return k
    if (k === index - 1) return k
    if (k === index) return null
    return k - 1
  }

  const changes = normalizeSideChanges(route.sideChanges, before)
  const next: SideChange[] = []
  changes.forEach((c, s) => {
    const end = s + 1 < changes.length ? changes[s + 1].idx : before
    for (let k = c.idx; k < end; k++) {
      const m = moved(k)
      if (m !== null) {
        next.push({ idx: m, side: c.side })
        break
      }
    }
  })
  const stops = route.stops.map((st) => ({
    ...st,
    pathIdx: Math.max(0, Math.min(moved(st.pathIdx) ?? Math.max(0, index - 1), after - 1)),
  }))
  return { points, sideChanges: normalizeSideChanges(next, after), stops }
}

/** Turning by more than this at a point means the route doubles back, as when a road is driven a second time. */
const TURN_BACK_DEG = 120

function turnsBack(points: Pt[], v: number): boolean {
  const a = points[v - 1]
  const b = points[v]
  const c = points[v + 1]
  if (!a || !b || !c) return false
  const turn = Math.abs(((bearing(b, c) - bearing(a, b) + 540) % 360) - 180)
  return turn > TURN_BACK_DEG
}

/**
 * Give segments from point `from` up to point `to` one side. The stretch becomes a section of its
 * own, and the part after it keeps the side it had. A stretch painted next to one on the same side
 * joins it, unless the route doubles back there: then the next stretch is another pass over the road.
 */
export function paintRange(route: Route, from: number, to: number, side: Side): Route {
  const segs = segmentCount(route)
  const i = Math.max(0, from)
  const j = Math.min(segs, to)
  if (i >= j) return route
  const changes = normalizeSideChanges(route.sideChanges, segs)
  const before = i > 0 ? sideAt({ sideChanges: changes }, i - 1) : null
  const after = j < segs ? sideAt({ sideChanges: changes }, j) : null
  const next: SideChange[] = changes.filter((c) => c.idx < i || c.idx > j)
  if (before === null || before !== side || turnsBack(route.points, i)) next.push({ idx: i, side })
  if (after !== null && (after !== side || turnsBack(route.points, j))) next.push({ idx: j, side: after })
  return { ...route, sideChanges: normalizeSideChanges(next, segs) }
}

/**
 * Paint the stretch of road between two taps with a side. Points are added where the taps fall,
 * unless one is already close. Null when a tap is off the route or the two are the same place.
 * With `range`, only the segments in that range are considered, to choose between passes over the same road.
 */
export function paintStretch(
  route: Route,
  a: Pt,
  b: Pt,
  side: Side,
  range?: { from: number; to: number },
): { route: Route; from: number; to: number } | null {
  const snapA = nearestOnRoute(route, a, range)
  const snapB = nearestOnRoute(route, b, range)
  if (!snapA || !snapB || snapA.dist > ON_ROUTE_M || snapB.dist > ON_ROUTE_M) return null
  const cum = cumulativeDistances(route.points)
  const along = (s: Snap) => alongPath(cum, s.idx, s.t)
  const [early, late] = along(snapA) <= along(snapB) ? [snapA, snapB] : [snapB, snapA]
  // The later point goes in first, so the earlier one's position in the route doesn't move.
  const withLate = ensureVertex(route, late)
  const withEarly = ensureVertex(withLate.route, early)
  const addedEarly = withEarly.route.points.length > withLate.route.points.length
  const from = withEarly.vertex
  const to = withLate.vertex + (addedEarly ? 1 : 0)
  if (to <= from) return null
  return { route: paintRange(withEarly.route, from, to, side), from, to }
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
 * segments in that range). A point is added to the route when needed; both halves keep
 * the side they had. Null when the tap is off the route or at a spot that can't start a stretch.
 */
export function splitAt(route: Route, pos: Pt, range?: { from: number; to: number }): Route | null {
  // When a road is driven twice both passes lie under the tap, so `range` picks the pass to split.
  const snap = nearestOnRoute(route, pos, range)
  if (!snap || snap.dist > ON_ROUTE_M) return null
  const { route: next, vertex } = ensureVertex(route, snap)
  const segs = segmentCount(next)
  if (vertex <= 0 || vertex >= segs) return null
  const changes = normalizeSideChanges(next.sideChanges, segs)
  if (changes.some((c) => c.idx === vertex)) return null
  const withSplit = [...changes, { idx: vertex, side: sideAt({ sideChanges: changes }, vertex) }]
  return { ...next, sideChanges: normalizeSideChanges(withSplit, segs) }
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
  const snap = nearestOnRoute(route, p)
  if (!snap) return null
  const stop: Stop = { id: newStopId(), lat: p.lat, lng: p.lng, pathIdx: snap.idx, type }
  if (extra.qty) stop.qty = extra.qty
  if (extra.label) stop.label = extra.label
  return { stop, offM: snap.dist }
}
