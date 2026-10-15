import type { Pt, Route, Side, Stop } from './types'

const R = 6371000
const rad = (d: number) => (d * Math.PI) / 180

export function haversine(a: Pt, b: Pt): number {
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Local equirectangular projection to metres around a reference latitude. */
function project(p: Pt, refLat: number): [number, number] {
  return [rad(p.lng) * R * Math.cos(rad(refLat)), rad(p.lat) * R]
}

function distToSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): { dist: number; t: number } {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return { dist: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)), t }
}

/** Douglas-Peucker simplification, tolerance in metres. */
export function simplify(points: Pt[], toleranceM: number): Pt[] {
  if (points.length < 3) return points.slice()
  const refLat = points[0].lat
  const xy = points.map((p) => project(p, refLat))
  const keep = new Array<boolean>(points.length).fill(false)
  keep[0] = keep[points.length - 1] = true
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    let maxD = 0
    let idx = -1
    for (let i = s + 1; i < e; i++) {
      const { dist } = distToSegment(xy[i], xy[s], xy[e])
      if (dist > maxD) {
        maxD = dist
        idx = i
      }
    }
    if (idx !== -1 && maxD > toleranceM) {
      keep[idx] = true
      stack.push([s, idx], [idx, e])
    }
  }
  return points.filter((_, i) => keep[i])
}

export interface Snap {
  /** Segment start index. */
  idx: number
  dist: number
}

/**
 * Snap a position to the path. With a previous index, prefer a window ahead of
 * it so loops and overlapping streets don't make the position jump.
 */
export function snapToPath(pos: Pt, points: Pt[], prevIdx = 0): Snap | null {
  if (points.length < 2) return null
  const refLat = points[0].lat
  const p = project(pos, refLat)
  const xy = points.map((q) => project(q, refLat))
  const search = (from: number, to: number): Snap | null => {
    let best: Snap | null = null
    for (let i = Math.max(0, from); i < Math.min(points.length - 1, to); i++) {
      const { dist } = distToSegment(p, xy[i], xy[i + 1])
      if (!best || dist < best.dist) best = { idx: i, dist }
    }
    return best
  }
  const windowed = search(prevIdx - 3, prevIdx + 40)
  if (windowed && windowed.dist < 50) return windowed
  return search(0, points.length - 1)
}

export function sideAt(route: Pick<Route, 'sideChanges'>, idx: number): Side {
  let side: Side = 'both'
  let at = -1
  for (const c of route.sideChanges) {
    if (c.idx <= idx && c.idx >= at) {
      side = c.side
      at = c.idx
    }
  }
  return side
}

export const APPROACH_RADIUS: Record<Stop['type'], number> = {
  bundle: 150,
  nothrow: 100,
}

/**
 * Unhandled special stops the driver is approaching: within radius, and not
 * already well behind on the path. Nearest first.
 */
export function approachingStops(
  pos: Pt,
  snapIdx: number,
  stops: Stop[],
  handled: ReadonlySet<string>,
  radius: Record<Stop['type'], number> = APPROACH_RADIUS,
): Stop[] {
  return stops
    .filter(
      (s) =>
        !handled.has(s.id) &&
        s.pathIdx >= snapIdx - 1 &&
        haversine(pos, s) <= radius[s.type],
    )
    .sort((a, b) => haversine(pos, a) - haversine(pos, b))
}
