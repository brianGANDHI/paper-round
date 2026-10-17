import { plural } from './format'
import { alongPath, bearing, cumulativeDistances, haversine, sideAt, snapWithin, type Occurrence, type Snap } from './geo'
import { isSide, type Pt, type Route, type Side, type SideChange, type Stop, type StopType } from './types'

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
  for (const c of changes) if (c.idx >= 0 && c.idx < segs) byIdx.set(c.idx, isSide(c.side) ? c.side : 'both')
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

/** What deleting a section leaves: the route, and what went with the section. */
export interface SectionDeletion {
  route: Route
  /** Where the section was: at the start of the route, at its end, or between two others. */
  where: 'start' | 'end' | 'middle'
  /** How much of the route went, in metres. */
  meters: number
  /** Whether the two ends it left behind were joined by a straight line of transit, rather than already meeting. */
  line: boolean
  /** The stops that were along it and are not beside any other part of the route. */
  removed: Stop[]
}

/**
 * The route without one of its sections. A section at the start or the end just comes off, and the route
 * begins or ends where the next or the previous one does. One in the middle leaves a gap, which is closed
 * with a straight line of transit, since nothing is thrown on a stretch nobody has drawn. The stops that
 * were along the section go with it, unless another part of the route that is kept still passes within reach
 * of them (the other pass of a street driven twice, say). Null for a section that isn't there, and for the
 * only one: that is clearing the route.
 */
export function deleteSection(route: Route, index: number): SectionDeletion | null {
  const secs = sections(route)
  const gone = secs[index]
  if (!gone || secs.length < 2) return null
  const { idx: a, endIdx: b } = gone
  const where = index === 0 ? 'start' : index === secs.length - 1 ? 'end' : 'middle'
  const keep = (s: Section): SideChange => ({ idx: s.idx, side: s.side })

  let points: Pt[]
  let changes: SideChange[]
  let line = false
  if (where === 'start') {
    points = route.points.slice(b)
    changes = secs.slice(1).map((s) => ({ idx: s.idx - b, side: s.side }))
  } else if (where === 'end') {
    points = route.points.slice(0, a + 1)
    changes = secs.slice(0, -1).map(keep)
  } else {
    // The sections either side meet at the points a and b. When those are the same spot the route simply
    // carries on; otherwise a straight line joins them, which is a segment of its own.
    line = haversine(route.points[a], route.points[b]) >= DUPLICATE_TAP_M
    points = [...route.points.slice(0, a + 1), ...route.points.slice(line ? b : b + 1)]
    const before = secs.slice(0, index).map(keep)
    const after = secs.slice(index + 1).map((s) => ({ idx: s.idx - b + a + (line ? 1 : 0), side: s.side }))
    const previous = secs[index - 1].side
    const next = secs[index + 1].side
    // The line is transit: part of a transit section beside it, or a section of its own.
    if (line && previous !== 'transit') {
      if (next === 'transit') after[0] = { ...after[0], idx: a }
      else before.push({ idx: a, side: 'transit' })
    }
    changes = [...before, ...after]
  }

  // The stops along the section go with it. The line that closes the gap doesn't count as a road for them
  // to be beside: only the parts of the route that are kept do.
  const kept: Pt[][] =
    where === 'start' ? [route.points.slice(b)] : where === 'end' ? [route.points.slice(0, a + 1)] : [route.points.slice(0, a + 1), route.points.slice(b)]
  const nearKept = (p: Pt) => Math.min(...kept.map((part) => nearestOnRoute({ points: part }, p)?.dist ?? Infinity))
  const removed: Stop[] = []
  const stops: Stop[] = []
  for (const stop of route.stops) {
    const was = nearestOnRoute(route, stop)
    if (was && was.idx >= a && was.idx < b && nearKept(stop) > MAX_STOP_OFFSET_M) removed.push(stop)
    else stops.push({ ...stop, pathIdx: nearestOnRoute({ points }, stop)?.idx ?? 0 })
  }
  const segs = Math.max(0, points.length - 1)
  const result: Route = { points, sideChanges: normalizeSideChanges(changes, segs), stops }
  return { route: result, where, meters: gone.endM - gone.startM, line, removed }
}

/** What to tell someone before a section is deleted. */
export function deleteWarning(d: SectionDeletion): string {
  const length = formatDistance(d.meters)
  const stops = d.removed.length ? ` and the ${plural(d.removed.length, 'stop', 'stops')} along it` : ''
  if (d.where === 'start') return `This removes ${length} from the start of your route${stops}.`
  if (d.where === 'end') return `This removes ${length} from the end of your route${stops}.`
  return `This removes ${length} of your route${stops}.${d.line ? ' Its two ends are joined by a straight transit line, which you can redraw afterwards.' : ''}`
}

/** What to tell them once it is done. */
export function deletedNote(d: SectionDeletion, index: number): string {
  const stops = d.removed.length ? ` and ${plural(d.removed.length, 'stop', 'stops')}` : ''
  return `Deleted section ${index + 1}: ${formatDistance(d.meters)}${stops}.${d.line ? ' Its ends are joined by a straight transit line.' : ''}`
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
  if (side === 'both' || side === 'transit' || mode === 'back') return side
  return side === 'left' ? 'right' : 'left'
}

/**
 * A side to start from when changing just part of a section, so it isn't the side the section already has:
 * Left and Right swap, Both goes to Left and Transit to Both.
 */
export function otherSide(side: Side): Side {
  if (side === 'left') return 'right'
  if (side === 'right') return 'left'
  return side === 'transit' ? 'both' : 'left'
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

/** The longest name a stop is given, so an alert on a phone can show it. */
export const MAX_LABEL = 60
/** The longest address kept with a stop. */
export const MAX_ADDRESS = 100
/** The most papers a stop can be given: a bundle is a few dozen at most, and this keeps a slip of the finger sensible. */
export const MAX_QTY = 9999

const tidy = (text: string, max: number): string | undefined => text.replace(/\s+/g, ' ').trim().slice(0, max).trim() || undefined

/** A name for a stop as it was typed: spaces tidied and kept to a length an alert can show. Nothing when it is blank. */
export const cleanLabel = (text: string): string | undefined => tidy(text, MAX_LABEL)

/** An address for a stop as it was typed, tidied the same way. Nothing when it is blank. */
export const cleanAddress = (text: string): string | undefined => tidy(text, MAX_ADDRESS)

/** Whether a piece of text reads as a street address: a house number, perhaps with a unit or a range, and then words. */
export const looksLikeAddress = (text: string): boolean => /^(?:\d+[a-z]?\/)?\d+[a-z]?(?:-\d+[a-z]?)?\s+\p{L}/iu.test(text.trim())

/**
 * The name and the address to offer for a stop that is being edited. Stops made before a place had an address of
 * its own kept a typed address in the name, so one that is all that, and reads as an address, is offered as the address.
 */
export function stopFields(s: Pick<Stop, 'label' | 'address'>): { name: string; address: string } {
  if (s.address === undefined && s.label && looksLikeAddress(s.label)) return { name: '', address: s.label }
  return { name: s.label ?? '', address: s.address ?? '' }
}

/** How many papers, from what was typed: a whole number from 1 up, or nothing. */
export function parseQty(text: string): number | undefined {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return undefined
  const n = Number.parseInt(t, 10)
  return n >= 1 && n <= MAX_QTY ? n : undefined
}

/** What is wrong with what was typed for the papers, or null when it is blank (no amount) or fine. */
export const qtyProblem = (text: string): string | null =>
  !text.trim() || parseQty(text) !== undefined ? null : `Papers must be a whole number from 1 to ${MAX_QTY}.`

/** What a stop is called in a list: its name, or its address when it has no name. */
export const stopName = (s: Pick<Stop, 'type' | 'label' | 'address'>): string =>
  s.label ?? s.address ?? (s.type === 'bundle' ? 'Bundle drop' : 'No-throw house')

/** The address to show under a stop's name, which is only when it has both: with no name the address is the name. */
export const stopWhere = (s: Pick<Stop, 'label' | 'address'>): string | null => (s.label && s.address ? s.address : null)

/** How many papers a bundle drop gets, or that no amount is set. For a no-throw house, what it is. */
export const stopDetail = (s: Pick<Stop, 'type' | 'qty'>): string =>
  s.type === 'bundle' ? (s.qty ? plural(s.qty, 'paper', 'papers') : 'no amount set') : 'No-throw'

/**
 * The route with one stop's name, address and papers changed. Anything left out is taken off the stop, so blank
 * means none. Only a bundle drop has papers. The route is the same one when there is no such stop.
 */
export function updateStop(route: Route, id: string, change: { label?: string; address?: string; qty?: number }): Route {
  if (!route.stops.some((s) => s.id === id)) return route
  return {
    ...route,
    stops: route.stops.map((s) => {
      if (s.id !== id) return s
      const { label: _label, address: _address, qty: _qty, ...rest } = s
      return {
        ...rest,
        ...(change.label ? { label: change.label } : {}),
        ...(change.address ? { address: change.address } : {}),
        ...(s.type === 'bundle' && change.qty ? { qty: change.qty } : {}),
      }
    }),
  }
}

let nextId = 0
export const newStopId = () => `${Date.now().toString(36)}${(nextId++).toString(36)}`

/** A stop at `p`, tied to the nearest part of the route, with how far off the route it is. */
export function stopAt(
  route: Route,
  p: Pt,
  type: StopType,
  extra: { label?: string; address?: string; qty?: number } = {},
): { stop: Stop; offM: number } | null {
  const snap = nearestOnRoute(route, p)
  if (!snap) return null
  const stop: Stop = { id: newStopId(), lat: p.lat, lng: p.lng, pathIdx: snap.idx, type }
  if (extra.qty) stop.qty = extra.qty
  if (extra.label) stop.label = extra.label
  if (extra.address) stop.address = extra.address
  return { stop, offM: snap.dist }
}
