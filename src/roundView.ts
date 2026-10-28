/**
 * How the driver looks at the round's map, kept apart from the screen so it can be tested: free look (the map left where the driver
 * put it, instead of following them), how much of the map the bar along the bottom covers, the room kept round the whole route when
 * it is fitted, what the zoom buttons do to the map, and what takes the middle of the bar.
 */

/** Free look ends this long after the driver last touched the map, in milliseconds. */
export const FREE_LOOK_MS = 15000

/** What the map is doing when the driver moves it. */
export interface LookState {
  /** The whole route is up, so nothing follows the driver. */
  overview: boolean
  /** The map is turned to the way the driver is heading. */
  headingUp: boolean
  /** The driver is already looking around. */
  freeLook: boolean
}

export interface LookChange {
  /** Whether the driver is looking around now. */
  freeLook: boolean
  /** Whether the wait before following starts again begins afresh, from this move. */
  restart: boolean
}

/**
 * What a move of the map by the driver does to free look. A drag of the north-up map starts it, or keeps it going. A zoom keeps it
 * going when it is on, and never starts it. Every move that counts starts the wait before following resumes again, so it runs from
 * the last touch. With the whole route up nothing follows, and with the map turned to the heading one finger can't drag it and a
 * pinch is about the driver's dot: neither is looking around, so they change nothing.
 */
export function afterUserMove(kind: 'drag' | 'zoom', now: LookState): LookChange {
  if (now.overview || now.headingUp) return { freeLook: now.freeLook, restart: false }
  if (kind === 'drag') return { freeLook: true, restart: true }
  return { freeLook: now.freeLook, restart: now.freeLook }
}

/**
 * How many pixels along the bottom of the map the bar covers, from where the screen ends and where the bar begins (the bar's height
 * and the gap under it). Null when that is not a size to go by, such as before anything has been laid out.
 */
export function barCover(screenBottom: number, barTop: number): number | null {
  const px = Math.round(screenBottom - barTop)
  return Number.isFinite(px) && px > 0 ? px : null
}

/**
 * Room kept clear round the route when it is fitted to the map, in pixels: the top for the side, the turn and any alert, the bottom
 * for whatever covers it (`coverPx`, on top of a margin), and at the right the column of buttons (48 px and the gap to the edge,
 * with a little to spare). The left and the bottom margins are only a margin.
 */
export function fitPadding(coverPx: number): { topLeft: [number, number]; bottomRight: [number, number] } {
  return { topLeft: [30, 70], bottomRight: [70, 30 + Math.round(coverPx)] }
}

/**
 * The animation to ask Leaflet for when the map goes to the driver's position. Following a fix on the same map is left to Leaflet
 * (a short way is glided, a far one, such as after looking around, is jumped, since a glide over more than a screen shows blank
 * tiles on the way), and turning the map between north and the heading is never glided.
 */
export function followAnimation(modeChanged: boolean): boolean | undefined {
  return modeChanged ? false : undefined
}

/** What the middle of the bar shows: a problem with the GPS, the wait for the first fix, the next bundle drop, or else the alert distance. */
export type BarMiddle = 'problem' | 'finding' | 'bundle' | 'alerts'

/**
 * What takes the middle of the bar, in this order of say: a problem with the GPS that stays until it is put right, then the wait for
 * the first fix, then the next bundle drop when the route has any, and only when there is nothing else the alert distance. A
 * caution that is not about where the phone is (the screen may sleep) is not here at all: it is a button of its own and takes no room.
 */
export function barMiddle(has: { problem: boolean; located: boolean; bundle: boolean }): BarMiddle {
  if (has.problem) return 'problem'
  if (!has.located) return 'finding'
  return has.bundle ? 'bundle' : 'alerts'
}

/** The word the next-bundle line leads with. "Next bundle" gives way to "Next" when the line is `crowded` (the pill that counts the bundles missed is on it, or the caution button takes room beside it), so the rest of the line keeps its room. */
export function barLead(lead: string, crowded: boolean): string {
  return crowded && lead === 'Next bundle' ? 'Next' : lead
}

/** The part of a Leaflet map that the zoom buttons use. */
export interface ZoomMap {
  getZoom(): number
  getMinZoom(): number
  getMaxZoom(): number
  setZoom(zoom: number): unknown
}

/** The zoom the buttons are heading for while the map has not got there yet, or null when they are not heading anywhere. */
export interface ZoomGoal {
  current: number | null
}

/**
 * One step in (+1) or out (-1) from a press of a zoom button. Leaflet ignores a zoom asked for while it is still zooming (about a
 * quarter of a second, and the animation only starts a frame after it is asked for), so a second press made in a hurry would aim at
 * the same zoom as the first and be lost. The steps instead count from the zoom the last press was heading for (`goal`), and
 * `settleZoom` carries on to it when Leaflet has finished. At the limit of the zoom with nothing under way there is nowhere to go
 * and no goal is kept, so a pinch that follows is not undone.
 */
export function stepZoom(map: ZoomMap, goal: ZoomGoal, by: number): void {
  const here = Math.round(map.getZoom())
  // From a whole zoom, so a half step left by an interrupted zoom doesn't carry on.
  const want = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), Math.round(goal.current ?? map.getZoom()) + by))
  if (goal.current === null && want === here) return
  goal.current = want
  map.setZoom(want)
}

/** Call when the map has finished zooming: carries on to the zoom the buttons were heading for if a press was lost to the animation, and forgets the goal once it is reached. */
export function settleZoom(map: ZoomMap, goal: ZoomGoal): void {
  const want = goal.current
  goal.current = null
  if (want === null || want === Math.round(map.getZoom())) return
  goal.current = want
  map.setZoom(want)
}
