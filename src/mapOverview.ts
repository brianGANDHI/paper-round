import { lineStyle, type LineStyle } from './colors'
import { fitPadding } from './roundView'
import type { Side } from './types'

/*
 * How a map to look over differs from the map a round is driven on, such as the one in Optimise Route's results. It sits in a list that scrolls, so
 * a finger on it has to scroll the list, and it shows a whole round in a small box, so the route is fitted close and drawn thin. Kept apart from the
 * map itself so each part of it can be tested.
 */

/** How near the edges an overview's route is fitted, in pixels: close, as nothing is over the map, but clear of the edge itself. */
export const OVERVIEW_PAD_PX = 12

/**
 * How an overview draws a section: a whole round fits a small box, where the round's own lines would be hundreds of metres wide and run into one
 * another, so it is a thin line, the same for every side as there are no arrows to make room for, on a thin casing that keeps the colours apart.
 */
const OVERVIEW_LINE: LineStyle = { casing: { weight: 5, opacity: 0.95 }, line: { weight: 3 } }

/** What the map is told when it is made, for how it takes a finger, the wheel and a fit. */
export interface MapOptions {
  dragging: boolean
  scrollWheelZoom: boolean
  zoomSnap: number
}

/**
 * The map's options. An overview takes no finger and no wheel, so they scroll the list, while two fingers still zoom and move it. Its zoom isn't kept
 * to whole steps, so the fit fills the box rather than dropping to the step below. Otherwise they are Leaflet's own, as the round's map has always had.
 */
export function mapOptions(overview: boolean): MapOptions {
  return overview ? { dragging: false, scrollWheelZoom: false, zoomSnap: 0 } : { dragging: true, scrollWheelZoom: true, zoomSnap: 1 }
}

/** Room kept clear round the route when it is fitted, in pixels: an overview has nothing over it, and the round's map keeps clear of its panels (see `fitPadding`). */
export function fitPaddingFor(overview: boolean, coverPx: number): { topLeft: [number, number]; bottomRight: [number, number] } {
  return overview ? { topLeft: [OVERVIEW_PAD_PX, OVERVIEW_PAD_PX], bottomRight: [OVERVIEW_PAD_PX, OVERVIEW_PAD_PX] } : fitPadding(coverPx)
}

/** How a section of each side is drawn. */
export const lineStyleFor = (overview: boolean, side: Side): LineStyle => (overview ? OVERVIEW_LINE : lineStyle(side))

/** Whether the way to drive is shown by arrows along the line. An overview has none: at its size there would be hundreds of them, over the colours. */
export const drawsArrows = (overview: boolean): boolean => !overview
