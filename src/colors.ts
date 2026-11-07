import type { Side } from './types'

/**
 * Route colours on the map. These are the iOS system colours, and the map is always light. Transit is a rose-pink that none of
 * the throw sides, the stops or the guide line use: it reads on the light map tiles and on the dark screens round them, and it is
 * plainly not a side that gets papers.
 */
export const SIDE_COLOR: Record<Side, string> = { both: '#007aff', left: '#34c759', right: '#ff9500', transit: '#d6338a' }

/** Deeper shades of the same colours, so white text on the side pill stays readable at a glance. */
export const SIDE_PILL: Record<Side, string> = { both: '#0a6ae0', left: '#2b9a4a', right: '#cf6100', transit: '#b4246f' }

export const SIDE_LABEL: Record<Side, string> = { both: 'Both Sides', left: 'Port Side', right: 'Starboard Side', transit: 'Transit' }

/** The same in a word, for where there is little room. */
export const SIDE_SHORT: Record<Side, string> = { both: 'Both', left: 'Port', right: 'Starboard', transit: 'Transit' }

/**
 * The colour of each kind of stop on the map and in the list. An apartment block is a blue-green teal: not the blue of a bundle drop, the
 * red of a no-throw house, the purple of a request, nor the green of the left side (that one is a yellower green, and a line). It is drawn as
 * a rounded square with a building in it, not a circle, so it is told by its shape as well as its colour.
 */
export const STOP_COLOR = { bundle: '#007aff', nothrow: '#ff3b30', request: '#af52de', block: '#00897b' } as const

/**
 * An apartment block's glyph, as SVG shapes on the 24-unit grid of `Icon`, which has no building: a tall block with a window or two on
 * each floor and a door. The alert (when the side can't be told) and the map marker both draw it, as lines in the colour of the text.
 */
export const BLOCK_GLYPH =
  '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M8.5 7.5h1.5M14 7.5h1.5M8.5 11.5h1.5M14 11.5h1.5"/><path d="M10 21v-4h4v4"/>'

/** The class of an apartment block's marker on the map (see `block.css`): faded once the block is done. */
export const blockMarkClass = (done: boolean): string => (done ? 'block-mark done' : 'block-mark')

/** What is inside an apartment block's marker: a box (`.block-mark > span`, the rounded square) with the building in it, as lines in the colour of the text. */
export const BLOCK_MARK_HTML = `<span><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${BLOCK_GLYPH}</svg></span>`

/** How big the marker's box is, in pixels (it is `.block-mark > span` in `block.css`): the icon is anchored at its middle. */
export const BLOCK_MARK_PX = 28

/**
 * The pane the apartment blocks' markers are drawn in: over the route's lines, and under the overlay pane with the other stops, the
 * driver's dot and the guide line, so the dot is never hidden by a block as the driver passes it. (They are markers and not circles to
 * have a shape and a glyph, which a circle can't, and so are not in the overlay pane.)
 */
export const BLOCK_PANE = { name: 'block-marks', zIndex: 390 } as const

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
