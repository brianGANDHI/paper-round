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

const lerp = (a: Pt, b: Pt, t: number): Pt => ({
  lat: a.lat + (b.lat - a.lat) * t,
  lng: a.lng + (b.lng - a.lng) * t,
})

/** Back from local metres to a position. */
function unproject(xy: [number, number], refLat: number): Pt {
  return {
    lat: (xy[1] / R) * (180 / Math.PI),
    lng: (xy[0] / (R * Math.cos(rad(refLat)))) * (180 / Math.PI),
  }
}

/** Compass bearing from a to b in degrees (0 = north, clockwise). */
export function bearing(a: Pt, b: Pt): number {
  const dLng = rad(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(rad(b.lat))
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** Distance from the start of the path to each point, in metres. */
export function cumulativeDistances(points: Pt[]): number[] {
  const out = points.length ? [0] : []
  for (let i = 1; i < points.length; i++) out.push(out[i - 1] + haversine(points[i - 1], points[i]))
  return out
}

/** How far along the path a point on segment `idx` is, in metres. `t` is 0 at the segment's start, 1 at its end. */
export function alongPath(cum: number[], idx: number, t: number): number {
  return cum[idx] + t * ((cum[idx + 1] ?? cum[idx]) - cum[idx])
}

/** A function giving how far a position is from a path, for checking many positions against one path. */
export function pathDistancer(points: Pt[]): (pos: Pt) => number {
  if (points.length < 2) return (pos) => (points.length ? haversine(pos, points[0]) : Infinity)
  const refLat = points[0].lat
  const xy = points.map((q) => project(q, refLat))
  return (pos) => {
    const p = project(pos, refLat)
    let best = Infinity
    for (let i = 0; i < xy.length - 1; i++) best = Math.min(best, distToSegment(p, xy[i], xy[i + 1]).dist)
    return best
  }
}

/** How far a position is from the nearest part of a path, in metres. */
export const distanceToPath = (pos: Pt, points: Pt[]) => pathDistancer(points)(pos)

/**
 * The path shifted sideways by `meters` to the right of the direction of travel
 * (negative shifts left). Used to draw two passes over the same road side by side.
 */
export function offsetPath(points: Pt[], meters: number): Pt[] {
  if (!meters || points.length < 2) return points
  const refLat = points[0].lat
  const xy = points.map((q) => project(q, refLat))
  // Unit normal pointing right of each segment; null for a zero-length segment.
  const normals = xy.slice(0, -1).map((a, i) => {
    const dx = xy[i + 1][0] - a[0]
    const dy = xy[i + 1][1] - a[1]
    const len = Math.hypot(dx, dy)
    return len ? ([dy / len, -dx / len] as [number, number]) : null
  })
  return points.map((q, i) => {
    const before = normals[i - 1] ?? null
    const after = normals[i] ?? null
    let n = after ?? before
    if (before && after) {
      const sx = before[0] + after[0]
      const sy = before[1] + after[1]
      const len = Math.hypot(sx, sy)
      if (len > 1e-6) {
        // Meet the two offset segments at a corner, without letting a sharp bend spike outwards.
        const scale = Math.min(2, 1 / Math.max(0.5, (sx * before[0] + sy * before[1]) / len))
        n = [(sx / len) * scale, (sy / len) * scale]
      }
    }
    if (!n) return q
    return unproject([xy[i][0] + n[0] * meters, xy[i][1] + n[1] * meters], refLat)
  })
}

/** Evenly spaced direction markers along the path. */
export function arrowsAlong(points: Pt[], spacingM: number): { pos: Pt; bearing: number }[] {
  const out: { pos: Pt; bearing: number }[] = []
  let next = spacingM / 2
  let walked = 0
  for (let i = 0; i < points.length - 1; i++) {
    const len = haversine(points[i], points[i + 1])
    while (len > 0 && next <= walked + len) {
      out.push({ pos: lerp(points[i], points[i + 1], (next - walked) / len), bearing: bearing(points[i], points[i + 1]) })
      next += spacingM
    }
    walked += len
  }
  return out
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
  /** Position along that segment: 0 at its start, 1 at its end. */
  t: number
  /** The closest point on the path. */
  point: Pt
}

/**
 * How much a stretch already driven counts against a snap, in metres. When the
 * same road is driven twice (out and back), the position fits both passes equally
 * well; this makes it carry on forward instead of slipping back to the first pass.
 */
const BEHIND_PENALTY_M = 25

/**
 * How much a segment pointing the opposite way to the direction of travel counts against a
 * snap, in metres (half that at right angles). On the way back along a road already driven,
 * this is what tells the return pass from the first, which lie on exactly the same line.
 */
const HEADING_PENALTY_M = 40

/** Smallest angle between two compass bearings, in degrees (0 to 180). */
const angleBetween = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)

/**
 * Snap a position to the path. With a previous index, prefer a window ahead of
 * it, and prefer going forward over back, so loops and roads driven twice don't
 * make the position jump. `heading` is the compass direction the driver is moving
 * in, when known; segments that run the opposite way count against a snap.
 */
export function snapToPath(pos: Pt, points: Pt[], prevIdx = 0, heading: number | null = null): Snap | null {
  if (points.length < 2) return null
  const refLat = points[0].lat
  const p = project(pos, refLat)
  const xy = points.map((q) => project(q, refLat))
  const search = (from: number, to: number): Snap | null => {
    let best: Snap | null = null
    let bestScore = Infinity
    for (let i = Math.max(0, from); i < Math.min(points.length - 1, to); i++) {
      const { dist, t } = distToSegment(p, xy[i], xy[i + 1])
      let score = dist + (i < prevIdx ? BEHIND_PENALTY_M : 0)
      if (heading !== null) {
        const dx = xy[i + 1][0] - xy[i][0]
        const dy = xy[i + 1][1] - xy[i][1]
        if (dx || dy) {
          const against = angleBetween((Math.atan2(dx, dy) * 180) / Math.PI, heading)
          score += ((1 - Math.cos(rad(against))) / 2) * HEADING_PENALTY_M
        }
      }
      if (score < bestScore) {
        bestScore = score
        best = { idx: i, dist, t, point: lerp(points[i], points[i + 1], t) }
      }
    }
    return best
  }
  const windowed = search(prevIdx - 3, prevIdx + 40)
  if (windowed && windowed.dist < 50) return windowed
  return search(0, points.length - 1)
}

/** The closest point on segments `from` up to (not including) `to`, ignoring where the driver has been. */
export function snapWithin(pos: Pt, points: Pt[], from: number, to: number): Snap | null {
  if (points.length < 2) return null
  const refLat = points[0].lat
  const p = project(pos, refLat)
  let best: Snap | null = null
  for (let i = Math.max(0, from); i < Math.min(points.length - 1, to); i++) {
    const { dist, t } = distToSegment(p, project(points[i], refLat), project(points[i + 1], refLat))
    if (!best || dist < best.dist) best = { idx: i, dist, t, point: lerp(points[i], points[i + 1], t) }
  }
  return best
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

/** How far ahead a stop alerts when no other distances are given. The app passes the driver's own choice. */
export const APPROACH_RADIUS: Record<Stop['type'], number> = {
  bundle: 150,
  nothrow: 100,
  request: 150,
}

/** A stop as met along the route: once for every time the route passes it. */
export interface Occurrence {
  /** Key in a run's progress: the stop's id for the first pass, then `id#2`, `id#3` and so on. */
  key: string
  stop: Stop
  /** The route segment that passes it most closely this time. */
  idx: number
  /** How far along the route that closest point is, in metres. */
  at: number
  /** How far the stop is from the route, in metres: the same for every time the route passes it. */
  off: number
}

/** A pass counts as passing a stop if it comes within this much of it, or 1.5 times its closest pass. */
const PASS_MIN_M = 30
const PASS_FACTOR = 1.5
/** How finely the route is walked to tell one pass of a stop from the next. */
const WALK_STEP_M = 5

/**
 * Every time the route goes past each stop, in route order. A street driven twice
 * gives each of its stops two occurrences, so the warning comes round on both passes.
 * A route that passes a stop only once gives one occurrence, keyed by the stop's id.
 */
export function occurrences(route: Pick<Route, 'points' | 'stops'>): Occurrence[] {
  const { points, stops } = route
  if (points.length < 2 || !stops.length) return []
  const refLat = points[0].lat
  const xy = points.map((q) => project(q, refLat))
  const cum = cumulativeDistances(points)
  const out: Occurrence[] = []
  for (const stop of stops) {
    const p = project(stop, refLat)
    const nearest = xy.slice(0, -1).reduce((m, a, i) => Math.min(m, distToSegment(p, a, xy[i + 1]).dist), Infinity)
    const limit = Math.max(PASS_MIN_M, nearest * PASS_FACTOR)

    // Walk the route in small steps. Each unbroken stretch that stays near the stop is one pass,
    // and the step where it comes closest gives the occurrence. Walking (rather than judging whole
    // segments) keeps the two passes apart even when each is a single long straight segment.
    const passes: number[] = []
    let best: { seg: number; dist: number } | null = null
    const visit = (seg: number, x: number, y: number) => {
      const dist = Math.hypot(x - p[0], y - p[1])
      if (dist <= limit) {
        if (!best || dist < best.dist) best = { seg, dist }
      } else if (best) {
        passes.push(best.seg)
        best = null
      }
    }
    for (let i = 0; i < xy.length - 1; i++) {
      const [ax, ay] = xy[i]
      const [bx, by] = xy[i + 1]
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / WALK_STEP_M))
      for (let k = 0; k < steps; k++) visit(i, ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps)
    }
    visit(xy.length - 2, xy[xy.length - 1][0], xy[xy.length - 1][1])
    if (best) passes.push((best as { seg: number }).seg)

    passes.forEach((seg, n) => {
      out.push({
        key: n === 0 ? stop.id : `${stop.id}#${n + 1}`,
        stop,
        idx: seg,
        at: alongPath(cum, seg, distToSegment(p, xy[seg], xy[seg + 1]).t),
        off: nearest,
      })
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** How far behind the driver a stop may be and still count, to forgive GPS jitter. */
const PASSED_M = 20
/** How much farther than the alert radius the stop may be from the driver's real position. */
export const LATERAL_SLACK_M = 30
/** A fix out by more than this, in metres, isn't trusted to say the driver is near a stop that is off the route. */
export const POSITION_MAX_ACCURACY_M = 40

/**
 * Whether a stop is too far from the route for driving the route to bring the driver near enough to be
 * alerted for it. Such a stop alerts by where the driver is instead: within the alert distance of it,
 * however they got there.
 */
export const byPosition = (o: Pick<Occurrence, 'off' | 'stop'>, radius: Record<Stop['type'], number>): boolean =>
  o.off > radius[o.stop.type] + LATERAL_SLACK_M

/**
 * The stops the driver is approaching: not yet handled, no more than the alert
 * distance ahead along the route (so the next pass of a street doesn't warn early),
 * and physically close. `driverAt` is how far along the route the driver is.
 *
 * A stop that is off the route (see `byPosition`) is not met along it, so it needs only the driver to be
 * within the alert distance of it. It is met one pass at a time, the first the stop has not been done for,
 * and only on a fix that is accurate enough to say so (`accuracy`, in metres). Nearest first.
 */
export function approachingOccurrences(
  driverAt: number,
  pos: Pt,
  occs: Occurrence[],
  handled: ReadonlySet<string>,
  radius: Record<Stop['type'], number> = APPROACH_RADIUS,
  accuracy = 0,
): Occurrence[] {
  const next = new Map<string, Occurrence>()
  for (const o of occs) {
    if (!byPosition(o, radius) || handled.has(o.key)) continue
    const first = next.get(o.stop.id)
    if (!first || o.at < first.at) next.set(o.stop.id, o)
  }
  return occs
    .filter((o) => {
      if (handled.has(o.key)) return false
      const r = radius[o.stop.type]
      if (byPosition(o, radius)) return next.get(o.stop.id) === o && accuracy <= POSITION_MAX_ACCURACY_M && haversine(pos, o.stop) <= r
      const ahead = o.at - driverAt
      // A small zone is also small behind the stop, so a stop already out of it doesn't alert and clear at once.
      return ahead <= r && ahead >= -Math.min(PASSED_M, r) && haversine(pos, o.stop) <= r + LATERAL_SLACK_M
    })
    .sort((a, b) => haversine(pos, a.stop) - haversine(pos, b.stop))
}

/** A stop nearer than this to the line of the road has no side worth showing. */
const SIDE_MIN_M = 3

/**
 * Which side of the road a stop is on, as the route goes past it: the left or right of the way you
 * are heading. Null when it sits on the line itself, so there is no telling. `idx` is the segment
 * that passes it, as an occurrence gives it, so a street driven twice has a side for each pass.
 */
export function stopSide(points: Pt[], idx: number, stop: Pt): 'left' | 'right' | null {
  const a = points[idx]
  const b = points[idx + 1]
  if (!a || !b) return null
  const [ax, ay] = project(a, a.lat)
  const [bx, by] = project(b, a.lat)
  const [px, py] = project(stop, a.lat)
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len === 0) return null
  // The cross product of the way you are heading with the way to the stop is positive on your left.
  const offset = (dx * (py - ay) - dy * (px - ax)) / len
  if (Math.abs(offset) < SIDE_MIN_M) return null
  return offset > 0 ? 'left' : 'right'
}
