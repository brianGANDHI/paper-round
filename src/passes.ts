import { haversine, offsetPath, pathDistancer } from './geo'
import { sections } from './routeEdit'
import type { Pt, Route, Side } from './types'

/** How far, in metres, a pass over ground an earlier section already covers is drawn to the side. */
export const PASS_OFFSET_M = 12

/** Two stretches cover the same ground when this share of one lies within SAME_GROUND_M of the other. */
const SAME_GROUND_SHARE = 0.6
const SAME_GROUND_M = 12

/** One section of the route, ready to draw. */
export interface PassView {
  /** Index of the section. */
  index: number
  side: Side
  /** The section's path as drawn: shifted sideways when it covers ground an earlier section covers. */
  points: Pt[]
  /** The first earlier section whose ground this one covers again, if any. */
  repeatOf: number | null
  /** True when this section goes the other way along that ground. */
  reversed: boolean
}

/** Points along a path every `stepM` metres, plus its corners. */
function samplePath(points: Pt[], stepM: number): Pt[] {
  const out: Pt[] = [points[0]]
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const len = haversine(a, b)
    for (let k = 1; len > 0 && k * stepM < len; k++) {
      const f = (k * stepM) / len
      out.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f })
    }
    out.push(b)
  }
  return out
}

/** The share of `path` that lies on `other`'s ground. */
function shareOnGround(path: Pt[], distanceToOther: (p: Pt) => number): number {
  const length = path.slice(1).reduce((sum, p, i) => sum + haversine(path[i], p), 0)
  const samples = samplePath(path, Math.max(8, length / 150))
  return samples.filter((p) => distanceToOther(p) <= SAME_GROUND_M).length / samples.length
}

/**
 * The sections of a route as they should be drawn. A section that goes over ground an
 * earlier one already covers (the other half of an out-and-back, say) is shifted to the
 * side so both can be seen, and says which section it repeats and which way it goes.
 */
export function passViews(route: Route): PassView[] {
  if (route.points.length < 2) return []
  const secs = sections(route)
  const paths = secs.map((s) => route.points.slice(s.idx, s.endIdx + 1))
  const distancers = paths.map((path) => pathDistancer(path))
  return secs.map((s, i) => {
    const covered: number[] = []
    for (let e = 0; e < i; e++) {
      if (shareOnGround(paths[i], distancers[e]) >= SAME_GROUND_SHARE) covered.push(e)
    }
    const repeatOf = covered[0] ?? null
    const earlier = repeatOf === null ? null : paths[repeatOf]
    const reversed =
      earlier !== null &&
      haversine(paths[i][0], earlier[earlier.length - 1]) < haversine(paths[i][0], earlier[0])
    return {
      index: s.index,
      side: s.side,
      points: offsetPath(paths[i], covered.length * PASS_OFFSET_M),
      repeatOf,
      reversed,
    }
  })
}
