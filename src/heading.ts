import { bearing, haversine } from './geo'
import type { Pt } from './types'

/**
 * Which way the phone is heading, worked out from where it has been, for when it has no course of its own: a phone
 * only gives one while it is moving fast enough, and over a few metres its position wanders more than it moves. So
 * the heading is the way from a place at least a few lot widths back to where it is now, and only when the trail
 * between runs reasonably straight. A phone standing still, or turning, has no heading rather than a guessed one.
 */

export interface TrailPoint extends Pt {
  /** When it was, in milliseconds. */
  time: number
}

/** How long the trail remembers, in milliseconds. */
const TRAIL_MS = 60_000
/** And how many places. */
const TRAIL_MAX = 30
/** The shortest stretch a heading is worked out over, in metres, or 2.5 times the fix's accuracy if more. */
const MIN_BASELINE_M = 25
/** The net distance must be at least this share of the distance walked, or the trail is turning, or only wandering. */
const STRAIGHT = 0.85

/** The trail with a place added: the recent places only, newest last. */
export function pushTrail(trail: TrailPoint[], point: TrailPoint): TrailPoint[] {
  return [...trail.filter((p) => point.time - p.time <= TRAIL_MS), point].slice(-TRAIL_MAX)
}

/** The way the trail is heading, in degrees clockwise from north, or null when there is none to be sure of. */
export function trailHeading(trail: TrailPoint[], accuracy: number): number | null {
  const last = trail[trail.length - 1]
  if (!last) return null
  const baseline = Math.max(MIN_BASELINE_M, 2.5 * accuracy)
  let walked = 0
  for (let i = trail.length - 2; i >= 0; i--) {
    walked += haversine(trail[i], trail[i + 1])
    const net = haversine(trail[i], last)
    if (net < baseline) continue
    return net >= STRAIGHT * walked ? bearing(trail[i], last) : null
  }
  return null
}
