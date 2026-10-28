/**
 * The rules the round's map follows, kept apart from the map itself so they can be tested: turning it to point the way the driver
 * is going (which heading it is turned to, and how it is laid out so that turning it never leaves a corner of the screen bare),
 * where the driver's dot sits above whatever covers the bottom of the map, when a zoom is the driver's and when it is ours, and
 * which part of the route is drawn as already driven. Headings are in degrees clockwise from north.
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

/** Where the driver's dot sits down the screen, as a share of its height, when nothing is known to cover the bottom of the map. */
export const HEADING_UP_FRAC = 0.7
/** How far above whatever covers the bottom of the map the driver's dot sits, in pixels: its halo (22 px) and a thumb's width of room. */
export const DOT_CLEARANCE_PX = 72
/** The dot never sits higher than halfway down the screen, nor lower than this share of it, so there is road ahead on a short screen too. */
export const ANCHOR_MIN_FRAC = 0.5
export const ANCHOR_MAX_FRAC = 0.82

/**
 * How many pixels of a map `height` pixels high a panel along its bottom covers. The panel is `bottomPx` pixels high, or covers
 * `bottomFrac` of the map (a sheet that grows with the screen); given both, whichever covers more. Anything that is not a
 * positive number counts as none.
 */
export function bottomCover(height: number, bottomFrac?: number, bottomPx?: number): number {
  const h = Number.isFinite(height) ? Math.max(0, height) : 0
  const fromFrac = bottomFrac !== undefined && Number.isFinite(bottomFrac) ? Math.max(0, bottomFrac) * h : 0
  const fromPx = bottomPx !== undefined && Number.isFinite(bottomPx) ? Math.max(0, bottomPx) : 0
  return Math.max(fromFrac, fromPx)
}

/**
 * How far down the screen, as a share of `height`, the driver's dot goes when `coverPx` pixels along the bottom are covered: as
 * low as it can go and still clear the cover by `DOT_CLEARANCE_PX`, so most of the screen is road ahead, but kept between
 * `ANCHOR_MIN_FRAC` and `ANCHOR_MAX_FRAC`. With nothing known about the cover (null), or no height yet, `HEADING_UP_FRAC`.
 */
export function headingUpFrac(height: number, coverPx: number | null): number {
  if (coverPx === null || !Number.isFinite(coverPx) || !(height > 0)) return HEADING_UP_FRAC
  return Math.min(ANCHOR_MAX_FRAC, Math.max(ANCHOR_MIN_FRAC, (height - Math.max(0, coverPx) - DOT_CLEARANCE_PX) / height))
}

/**
 * How the map is laid out to be turned about the driver's dot: the dot is `frac` of the way down the screen, and the map is a
 * square, centred on the dot, big enough to still cover every corner of the screen at any angle.
 */
export function headingUpLayout(width: number, height: number, frac = HEADING_UP_FRAC): { ax: number; ay: number; s: number } {
  const ax = width / 2
  const ay = height * frac
  const s = 2 * Math.ceil(Math.hypot(Math.max(ax, width - ax), Math.max(ay, height - ay)))
  return { ax, ay, s }
}

/** How far to turn a label back, in degrees, so that it stays upright on a map turned to `heading`. No turn without a heading. */
export const counterRotation = (heading: number | null): number => (heading !== null && Number.isFinite(heading) ? heading : 0)

/** The zoom the map goes to when the driver starts being followed: street level. */
export const STREET_ZOOM = 17

/**
 * The zoom to follow the driver at. The driver's own zoom is never taken from them: a position fix keeps the zoom the map has. Only
 * when following starts afresh (the first time the position is followed, or back from the view of the whole route) is `street`
 * true, and then the map is brought in to street level, unless it is already closer than that.
 */
export const followZoom = (current: number, street: boolean): number => (street ? Math.max(current, STREET_ZOOM) : current)

/**
 * Tells a move of the map the driver made with their fingers (or the wheel or keys) from one the app made itself, such as
 * following a fix, fitting the route or the zoom buttons. The map shows no difference between the two, so the screen feeds this
 * the touches, wheel turns and key presses that reach the map, and asks whether a move came just after one. `at` is a time in
 * milliseconds from any one clock.
 */
export interface UserInput {
  /** A touch started, moved or ended on the map, with this many fingers now on the screen. */
  touch(fingers: number, at: number): void
  /** A wheel turn, key press or other input that is over at once. */
  input(at: number): void
  /** Whether a move at `at` is the driver's: a finger is down, or was a moment ago, or the wheel or a key was just used. */
  active(at: number): boolean
  /** Whether a finger is down on the map (a drag or a pinch is under way, or about to be). */
  touching(at: number): boolean
}

/** How long after the last touch, wheel turn or key a move of the map still counts as the driver's, in milliseconds (the snap to a whole zoom after a pinch comes after the fingers lift). */
export const USER_INPUT_MS = 600
/** A touch that has said nothing for this long, in milliseconds, is taken to be over: a missed "touch ended" must not hold the map up for ever. */
export const TOUCH_STALE_MS = 5000

/** A fresh record of the driver's input, with no finger down. */
export function userInput(): UserInput {
  let fingers = 0
  let last = -Infinity
  const down = (at: number) => fingers > 0 && at - last < TOUCH_STALE_MS
  return {
    touch(n, at) {
      fingers = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
      last = at
    },
    input(at) {
      last = at
    },
    active(at) {
      return down(at) || at - last < USER_INPUT_MS
    },
    touching(at) {
      return down(at)
    },
  }
}

/** The driven part of the route is cut at multiples of this many metres, so its line isn't redrawn on every fix. */
export const DRIVEN_STEP_M = 10

/**
 * Where, in metres along the route, the part already driven ends for the map: how far the driver has got, rounded down to a
 * multiple of `DRIVEN_STEP_M`. Undefined when there is none (nothing is driven, as when planning the route), and for anything that
 * is not a number, so a bad value fades nothing instead of garbling the line.
 */
export function drivenCut(drivenM: number | undefined): number | undefined {
  if (drivenM === undefined || !Number.isFinite(drivenM)) return undefined
  return Math.floor(Math.max(0, drivenM) / DRIVEN_STEP_M) * DRIVEN_STEP_M
}

/** How much of a section, from 0 to 1 along its own line, lies before the cut: a section that starts after it has none, one that ends before it all. A section with no length counts as all. */
export function drivenShare(cutM: number, startM: number, endM: number): number {
  if (!(endM > startM)) return 1
  return Math.min(1, Math.max(0, (cutM - startM) / (endM - startM)))
}

/** Whether something `routeM` metres along the route is still to come, and so drawn, as against already driven, and hidden. With no cut, all of it is ahead. */
export const isAhead = (routeM: number, cutM: number | undefined): boolean => cutM === undefined || routeM >= cutM
