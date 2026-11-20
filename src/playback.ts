import { EXTENT_MERGE_M, type SideExtent } from './driveEdit'
import { bearing, cumulativeDistances, haversine } from './geo'
import { shortest } from './mapHeading'
import { formatDistance } from './routeEdit'
import { pointAt } from './turns'
import type { Pt, Side } from './types'

/*
 * Previewing the drive: the route played back from its start, faster than real time, with a marker going along it, so the throw side of
 * every part of it can be checked before the round, with someone about to drive it. Everything here is pure: how fast the marker goes,
 * where it is drawn, where a jump to the next or the previous stretch lands, and how the map is turned. The screen is Preview.tsx.
 */

/** The speeds the preview plays at, as so many times real time. */
export const PREVIEW_SPEEDS = [10, 30, 60] as const
export type PreviewSpeed = (typeof PREVIEW_SPEEDS)[number]
export const isPreviewSpeed = (v: unknown): v is PreviewSpeed => PREVIEW_SPEEDS.some((s) => s === v)

/** The speed a preview starts at: slow enough to read the side of a stretch a couple of hundred metres long as it goes by. */
export const FIRST_SPEED: PreviewSpeed = 10

/** Real time, in kilometres an hour: about the pace of a round where papers are thrown, and on transit between the places delivered. */
export const REAL_KMH = { throw: 25, transit: 50 } as const

/** How fast the marker goes at real time along a stretch thrown to `side`, in metres a second. */
export const realSpeed = (side: Side): number => (side === 'transit' ? REAL_KMH.transit : REAL_KMH.throw) / 3.6

/** A stretch of the route as the preview goes along it: where it starts and ends along the route, in metres, and its side. */
export interface PreviewStretch {
  startM: number
  endM: number
  side: Side
}

/**
 * Two distances this close, in metres, are the same place: the start of a stretch painted from where the marker is comes out a hair further on
 * once the route's distances are added up again, and the marker is to be in the stretch it has just changed, not the one before.
 */
const SAME_M = 0.01

/**
 * Which stretch `along` metres along the route is in, by its place in the list: a stretch's start is its own and its end is the next one's, as
 * on the round, so the marker shows the new side the moment it reaches it. Before the start is the first, and at or past the end of the route
 * the last. A stretch with no length is never the one. -1 when there are none.
 */
export function stretchAt(stretches: readonly Pick<PreviewStretch, 'endM'>[], along: number): number {
  if (!stretches.length) return -1
  let lo = 0
  let hi = stretches.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (along < stretches[mid].endM - SAME_M) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** How long the route is, in metres, by its stretches. */
export const previewEnd = (stretches: readonly Pick<PreviewStretch, 'endM'>[]): number => stretches[stretches.length - 1]?.endM ?? 0

/**
 * Where the marker is `seconds` after being at `along`, playing at `speed`: each stretch is gone along at its own real pace (a stretch of
 * transit faster than one where papers are thrown) times the speed, and it stops at the end of the route.
 */
export function advanceAlong(stretches: readonly PreviewStretch[], along: number, seconds: number, speed: number): number {
  const end = previewEnd(stretches)
  let at = Math.min(Math.max(Number.isFinite(along) ? along : 0, 0), end)
  let left = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  while (left > 0 && at < end) {
    const s = stretches[stretchAt(stretches, at)]
    const v = realSpeed(s.side) * speed
    const room = s.endM - at
    if (!(v > 0) || !(room > 0)) break
    if (room >= v * left) return at + v * left
    at = s.endM
    left -= room / v
  }
  return at
}

/** How long the preview takes from `along` to the end of the route at `speed`, in seconds. */
export function secondsLeft(stretches: readonly PreviewStretch[], along: number, speed: number): number {
  let real = 0
  for (const s of stretches) {
    const from = Math.max(s.startM, along)
    if (s.endM > from) real += (s.endM - from) / realSpeed(s.side)
  }
  return speed > 0 ? real / speed : Infinity
}

/** "About 6 min left", "Under a minute left", for how long the rest of the preview takes. */
export function timeLeftText(seconds: number): string {
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return 'Under a minute left'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `About ${minutes} min left`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `About ${hours} h${rest ? ` ${rest} min` : ''} left`
}

/** The stretch a tap on Next Stretch goes to the start of: the one after the stretch the marker is in, or null from the last. */
export function nextStretch(stretches: readonly Pick<PreviewStretch, 'endM'>[], along: number): number | null {
  const i = stretchAt(stretches, along)
  return i >= 0 && i + 1 < stretches.length ? i + 1 : null
}

/** Further than this, in metres, into a stretch, Previous Stretch goes back to its start; nearer than that, to the start of the one before. */
export const BACK_SLACK_M = 20

/**
 * The stretch a tap on Previous Stretch goes to the start of: the one the marker is in, once it is more than `BACK_SLACK_M` into it, and
 * otherwise the one before, as a music player's back button does, so two taps in a row go back two stretches. Null when there are none.
 */
export function previousStretch(stretches: readonly Pick<PreviewStretch, 'startM' | 'endM'>[], along: number): number | null {
  const i = stretchAt(stretches, along)
  if (i < 0) return null
  return i === 0 || along - stretches[i].startM > BACK_SLACK_M ? i : i - 1
}

/** A stretch's line as the map draws it (a pass over a road driven twice is drawn beside the other one), with how far along that line each of its points is. */
export interface DrawnStretch {
  startM: number
  endM: number
  points: Pt[]
  cum: number[]
}

/** The stretches' lines as the map draws them, ready for `markerAt`. */
export const drawnStretches = (views: readonly { startM: number; endM: number; points: Pt[] }[]): DrawnStretch[] =>
  views.map((v) => ({ startM: v.startM, endM: v.endM, points: v.points, cum: cumulativeDistances(v.points) }))

/** The heading at a place on a line is taken from this many metres behind it to this many ahead, so a corner is turned as the marker comes into it. */
const HEADING_BACK_M = 5
const HEADING_AHEAD_M = 15

/** The way a line heads `at` metres along it, in degrees clockwise from north, or null where it has no length to tell by. */
export function headingOn(points: Pt[], cum: number[], at: number): number | null {
  const length = cum[cum.length - 1] ?? 0
  if (!(length > 0) || !Number.isFinite(at)) return null
  const a = pointAt(points, cum, Math.max(0, at - HEADING_BACK_M))
  const b = pointAt(points, cum, Math.min(length, at + HEADING_AHEAD_M))
  return haversine(a, b) < 0.5 ? null : bearing(a, b)
}

/**
 * Where the marker is when it is `along` metres along the route, and the way it is heading there. It is drawn on the line of the stretch it is in
 * as the map draws it, the same share of the way along that line as it is along the stretch, so on a road driven twice it is on the pass being
 * played and not between the two. Null when there is no line to be on.
 */
export function markerAt(drawn: readonly DrawnStretch[], along: number): { pos: Pt; heading: number | null } | null {
  const d = drawn[stretchAt(drawn, along)]
  if (!d || d.points.length === 0) return null
  const length = d.cum[d.cum.length - 1] ?? 0
  const share = d.endM > d.startM ? Math.min(1, Math.max(0, (along - d.startM) / (d.endM - d.startM))) : 0
  const at = share * length
  return { pos: pointAt(d.points, d.cum, at), heading: headingOn(d.points, d.cum, at) }
}

/** Moves the marker to `along` metres along the route. `leadTo` is where it will be one glide (`GLIDE_MS`) from now while it plays, or null for a jump: the map is put on it at once. */
export type Mover = (along: number, leadTo: number | null) => void

/** While it plays the map glides on to keep up with the marker, every this many milliseconds, to where the marker will be by then. */
export const GLIDE_MS = 250

/** A place on the screen from the middle of the map, in pixels: right and down are positive. */
export interface ScreenOffset {
  x: number
  y: number
}

/**
 * What the map's marker is moved by (see `PlaybackMarker` in MapView.tsx): the stretches' lines as the map draws them, where along the route the
 * marker is, where on the screen it sits from the middle of the map (so it is in the part the panels leave clear, see `markerOffset`), and the
 * mover it hands back.
 */
export interface PlaybackHandles {
  drawn: DrawnStretch[]
  alongRef: { current: number }
  offsetRef: { current: ScreenOffset }
  moveRef: { current: Mover | null }
}

/** A box on the screen, in pixels from the top left of the map. */
export interface ScreenBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** The marker's disc is this many pixels across: anything over the map within half that of the middle line hides it. */
const MARKER_PX = 36

/**
 * The part of the map that nothing is over, where the marker is to be: on a phone held upright, between what is at the top (the side, the turn
 * card) and the panel at the bottom, and above the map's buttons too when they lie across the middle of the map (in a row, on a short screen). On
 * a phone on its side the panel is at the right, and it is the part to the left of the panel, under the side and above the buttons.
 */
export function clearPart(map: { width: number; height: number }, top: ScreenBox, panel: ScreenBox, buttons: ScreenBox): ScreenBox {
  const gap = 8
  const sideways = panel.left > map.width * 0.3
  if (sideways) {
    const right = panel.left - gap
    const bottom = buttons.left < right ? buttons.top - gap : map.height
    return { left: 0, top: top.bottom + gap, right, bottom }
  }
  const middle = map.width / 2
  const acrossMiddle = buttons.left < middle + MARKER_PX / 2 && buttons.right > middle - MARKER_PX / 2
  return { left: 0, top: top.bottom + gap, right: map.width, bottom: Math.min(panel.top, acrossMiddle ? buttons.top : Infinity) - gap }
}

/** Where the marker sits from the middle of the map so that it is in the middle of `clear`. */
export function markerOffset(map: { width: number; height: number }, clear: ScreenBox): ScreenOffset {
  return { x: Math.round((clear.left + clear.right - map.width) / 2), y: Math.round((clear.top + clear.bottom - map.height) / 2) }
}

/** A change of heading smaller than this, in degrees, leaves the map turned as it is, so it turns at the corners and not at every bend in the line. */
export const MAP_TURN_DEG = 20

/**
 * The heading the map is turned to, pointing the way the marker goes, given the one it is turned to now: kept until the marker heads `MAP_TURN_DEG`
 * or more away from it. Both are unwrapped (they can pass 360 or go below 0), so going from 350 degrees to 10 turns the map 20 degrees on, not 340
 * back. A heading that is not known leaves the map as it is.
 */
export function mapTurn(shown: number | null, heading: number | null, minDeg = MAP_TURN_DEG): number | null {
  if (heading === null || !Number.isFinite(heading)) return shown
  if (shown === null || !Number.isFinite(shown)) return heading
  const by = shortest(shown, heading)
  return Math.abs(by) < minDeg ? shown : shown + by
}

/**
 * The parts of the stretch the marker is in that its side can be changed for from the preview (see `sideExtents`), with the one that is all of the
 * stretch called the whole stretch. A jump by stretch leaves the marker at the start of one, where "To the end of this stretch" reaches both of its
 * ends and the whole stretch is left out as the same choice: it is put as what it is, the whole stretch, and covers all of it.
 */
export function withWholeStretch(extents: readonly SideExtent[], stretch: { startM: number; endM: number }): SideExtent[] {
  if (extents.some((e) => e.key === 'stretch')) return [...extents]
  return extents.map((e) =>
    Math.abs(e.fromM - stretch.startM) <= EXTENT_MERGE_M && Math.abs(e.toM - stretch.endM) <= EXTENT_MERGE_M
      ? { key: 'stretch', fromM: stretch.startM, toM: stretch.endM, label: 'The whole stretch', detail: `${formatDistance(stretch.endM - stretch.startM)}, all of it` }
      : e,
  )
}
