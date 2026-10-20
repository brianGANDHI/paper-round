/**
 * Turning the round's map to point the way the driver is going: which heading it is turned to, and how it is laid out so that
 * turning it never leaves a corner of the screen bare. Headings are in degrees clockwise from north.
 */

/** A heading kept within 0 up to 360. */
export const norm360 = (d: number): number => ((d % 360) + 360) % 360

/** The signed turn from one heading to another, in degrees from -180 (not included) to 180: from 350 to 10 is 20, and from 10 to 350 is -20. */
export function shortest(from: number, to: number): number {
  const d = norm360(to - from)
  return d > 180 ? d - 360 : d
}

/** A change in heading smaller than this, in degrees, is the phone's noise: the map holds still. */
export const HEADING_DEADBAND_DEG = 2.5
/** How quickly the map catches up with a new heading: the time, in seconds, for it to cover about two thirds of the way. */
const CATCH_UP_S = 1.2
/** A fix is taken to come between 0.2 and 3 seconds after the one before, whatever its time says. */
const MIN_DT_S = 0.2
const MAX_DT_S = 3
/** A turn bigger than this, in degrees, such as a corner, is caught up with at least this fraction at once. */
const FAST_TURN_DEG = 60
const FAST_SHARE = 0.8

/**
 * The map's heading after a new heading from the phone `dtSec` seconds on. Both the one before and the one returned are
 * unwrapped: they can pass 360 or go below 0, so that a map being turned to the next heading always goes the short way round,
 * and a transition that follows them never spins the long way. Small changes are ignored, larger ones are smoothed, and
 * corners are caught up with quickly. With no heading before, it is the new one. A heading that is not a number is no heading:
 * a target like that changes nothing, and a previous one like that is started again from the target, so a bad value is never kept.
 */
export function smoothHeading(prev: number | null, target: number, dtSec: number): number {
  if (prev === null || !Number.isFinite(prev)) return target
  if (!Number.isFinite(target)) return prev
  const d = shortest(prev, target)
  if (Math.abs(d) < HEADING_DEADBAND_DEG) return prev
  // A gap that is not a number is taken as the usual second between fixes.
  const dt = Number.isNaN(dtSec) ? 1 : Math.min(MAX_DT_S, Math.max(MIN_DT_S, dtSec))
  let share = 1 - Math.exp(-dt / CATCH_UP_S)
  if (Math.abs(d) > FAST_TURN_DEG) share = Math.max(share, FAST_SHARE)
  return prev + d * share
}

/**
 * The heading the map is turned to next. A course from the phone (it only has one while moving) is smoothed in. With none,
 * the map holds the heading it has, so it doesn't spin while the car is stopped. At the very start, before any course, the
 * way the route runs here will do. Until there is any of these, null: the map stays north up. Anything that is not a number
 * counts as not there, so it never reaches the map.
 */
export function holdHeading(prev: number | null, course: number | null, routeBearing: number | null, dtSec: number): number | null {
  const held = prev !== null && Number.isFinite(prev) ? prev : null
  if (course !== null && Number.isFinite(course)) return smoothHeading(held, course, dtSec)
  if (held !== null) return held
  return routeBearing !== null && Number.isFinite(routeBearing) ? routeBearing : null
}

/**
 * How the map is laid out to be turned about the driver's dot: the dot is `frac` of the way down the screen, and the map is a
 * square, centred on the dot, big enough to still cover every corner of the screen at any angle.
 */
export function headingUpLayout(width: number, height: number, frac = 0.7): { ax: number; ay: number; s: number } {
  const ax = width / 2
  const ay = height * frac
  const s = 2 * Math.ceil(Math.hypot(Math.max(ax, width - ax), Math.max(ay, height - ay)))
  return { ax, ay, s }
}

/** How far to turn a label back, in degrees, so that it stays upright on a map turned to `heading`. No turn without a heading. */
export const counterRotation = (heading: number | null): number => (heading !== null && Number.isFinite(heading) ? heading : 0)
