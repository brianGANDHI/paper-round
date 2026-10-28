import type { Side } from './types'

/**
 * Route colours on the map. These are the iOS system colours, and the map is always light. Transit is a rose-pink that none of
 * the throw sides, the stops or the guide line use: it reads on the light map tiles and on the dark screens round them, and it is
 * plainly not a side that gets papers.
 */
export const SIDE_COLOR: Record<Side, string> = { both: '#007aff', left: '#34c759', right: '#ff9500', transit: '#d6338a' }

/** Deeper shades of the same colours, so white text on the side pill stays readable at a glance. */
export const SIDE_PILL: Record<Side, string> = { both: '#0a6ae0', left: '#2b9a4a', right: '#cf6100', transit: '#b4246f' }

export const SIDE_LABEL: Record<Side, string> = { both: 'Both Sides', left: 'Left Side', right: 'Right Side', transit: 'Transit' }

/** The same in a word, for where there is little room. */
export const SIDE_SHORT: Record<Side, string> = { both: 'Both', left: 'Left', right: 'Right', transit: 'Transit' }

export const STOP_COLOR = { bundle: '#007aff', nothrow: '#ff3b30', request: '#af52de' } as const

/** How a section is drawn: a white casing under a coloured line, so the line reads on any map background. */
export interface LineStyle {
  casing: { weight: number; opacity: number }
  line: { weight: number }
}

/**
 * A section is a solid line in its colour. Transit is wider, so the road between the places you deliver stands out and has room
 * for its direction arrows, and solid like the rest, not dotted: it is a road to follow, not something faint to ignore.
 */
export function lineStyle(side: Side): LineStyle {
  return side === 'transit' ? { casing: { weight: 12, opacity: 0.95 }, line: { weight: 8 } } : { casing: { weight: 10, opacity: 0.95 }, line: { weight: 6 } }
}

/** Leaflet's own panes stack by these z-indexes (its stylesheet): the tiles, then everything drawn on the overlay pane (stops, marks, the dot, the guide line), then the markers (arrows, labels, handles). */
export const LEAFLET_Z = { tiles: 200, overlay: 400, markers: 600 } as const

/**
 * The panes the route's lines are drawn in, bottom to top. Each pane has its own renderer, so the order is the stacking, whatever
 * order the lines were added in: what is behind the driver (drawn faded) can never lie over what is still ahead, even on a road
 * that is driven twice, and every white casing is under every line. All of them are between the tiles and the overlay pane, so the
 * stops, marks, position and guide line stay on top of the lines.
 */
export const LINE_PANES = {
  highlight: { name: 'route-highlight', zIndex: 310 },
  driven: { name: 'route-driven', zIndex: 320 },
  aheadCasing: { name: 'route-ahead-casing', zIndex: 330 },
  ahead: { name: 'route-ahead', zIndex: 340 },
} as const
