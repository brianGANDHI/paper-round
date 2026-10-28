import { describe, expect, it } from 'vitest'
import { LEAFLET_Z, LINE_PANES, lineStyle, SIDE_COLOR, SIDE_PILL, STOP_COLOR } from './colors'
import type { Side } from './types'

const SIDES: Side[] = ['both', 'left', 'right', 'transit']

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}

/** WCAG contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The colours the line has to read against: the casing, the map's land, and the card the side's dot is on in dark mode. */
const WHITE = '#ffffff'
const OSM_LAND = '#f2efe9'
const DARK_CARD = '#2c2c2e'
/** The colour of the guide line back to the route, which MapView draws itself. */
const GUIDE = '#d97706'

describe('how a section is drawn', () => {
  it('has a white casing wider than its line, almost opaque, for every side', () => {
    for (const side of SIDES) {
      const { casing, line } = lineStyle(side)
      expect(casing.weight).toBeGreaterThan(line.weight)
      expect(casing.opacity).toBeGreaterThanOrEqual(0.9)
    }
  })

  it('keeps the throwing sides as they were: a line of 6 in a casing of 10', () => {
    for (const side of ['both', 'left', 'right'] as const) expect(lineStyle(side)).toEqual({ casing: { weight: 10, opacity: 0.95 }, line: { weight: 6 } })
  })

  it('draws transit solid and wider than any side, so it is a road to follow, not a faint dotted one', () => {
    const transit = lineStyle('transit')
    // A dash would show as a dashArray in the line's style.
    expect(Object.keys(transit.line)).toEqual(['weight'])
    expect(Object.keys(transit.casing).sort()).toEqual(['opacity', 'weight'])
    for (const side of ['both', 'left', 'right'] as const) {
      expect(transit.line.weight).toBeGreaterThan(lineStyle(side).line.weight)
      expect(transit.casing.weight).toBeGreaterThan(lineStyle(side).casing.weight)
    }
    // Not fainter than a side either: it used to be a thin, half-faded dotted line.
    expect(transit.casing.opacity).toBeGreaterThanOrEqual(lineStyle('both').casing.opacity)
  })
})

describe('the colour of transit', () => {
  it('is not the colour of any throwing side, any stop or the guide line', () => {
    const others = [SIDE_COLOR.both, SIDE_COLOR.left, SIDE_COLOR.right, ...Object.values(STOP_COLOR), GUIDE]
    expect(others).not.toContain(SIDE_COLOR.transit)
    // And it is a different colour, not a shade of the grey it was (which looked like the faded, already driven part).
    expect(SIDE_COLOR.transit).not.toBe('#76767a')
  })

  it('reads on the casing, on the light map and on the dark card a side dot sits on', () => {
    for (const background of [WHITE, OSM_LAND, DARK_CARD]) expect(contrast(SIDE_COLOR.transit, background)).toBeGreaterThanOrEqual(3)
  })

  it('has a pill deep enough for the white text on it, like every side', () => {
    for (const side of SIDES) expect(contrast(SIDE_PILL[side], WHITE)).toBeGreaterThanOrEqual(3)
    expect(contrast(SIDE_PILL.transit, WHITE)).toBeGreaterThanOrEqual(4.5)
  })

  it('has its pill in the same family as its line: darker, not another colour', () => {
    expect(luminance(SIDE_PILL.transit)).toBeLessThan(luminance(SIDE_COLOR.transit))
    const hue = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255]
      // Pink: red leads, blue follows, green is the least.
      return r > b && b > g
    }
    expect(hue(SIDE_COLOR.transit)).toBe(true)
    expect(hue(SIDE_PILL.transit)).toBe(true)
  })
})

describe('the panes the route is drawn in', () => {
  const panes = Object.values(LINE_PANES)

  it('stack from the emphasis, through what is behind the driver, to the casings and then the lines still to come', () => {
    expect(LINE_PANES.highlight.zIndex).toBeLessThan(LINE_PANES.driven.zIndex)
    expect(LINE_PANES.driven.zIndex).toBeLessThan(LINE_PANES.aheadCasing.zIndex)
    expect(LINE_PANES.aheadCasing.zIndex).toBeLessThan(LINE_PANES.ahead.zIndex)
  })

  it('has what is behind the driver under everything that is ahead, casings included, so a faded pass never lies over a bright one', () => {
    expect(LINE_PANES.driven.zIndex).toBeLessThan(Math.min(LINE_PANES.aheadCasing.zIndex, LINE_PANES.ahead.zIndex))
  })

  it('is all above the tiles and below the overlay pane, which has the stops, marks, position and guide line', () => {
    for (const pane of panes) {
      expect(pane.zIndex).toBeGreaterThan(LEAFLET_Z.tiles)
      expect(pane.zIndex).toBeLessThan(LEAFLET_Z.overlay)
    }
    expect(LEAFLET_Z.overlay).toBeLessThan(LEAFLET_Z.markers)
  })

  it('has a name of its own for each, and none of Leaflet default panes (which react-leaflet refuses)', () => {
    const names = panes.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
    for (const reserved of ['mapPane', 'markerPane', 'overlayPane', 'popupPane', 'shadowPane', 'tilePane', 'tooltipPane']) expect(names).not.toContain(reserved)
    // Leaflet uses a pane name as a renderer key and a class, so keep them plain.
    for (const name of names) expect(name).toMatch(/^[a-z][a-z-]*$/)
  })

  it('gives every pane a different z-index, so the order never depends on which was made first', () => {
    const zs = panes.map((p) => p.zIndex)
    expect(new Set(zs).size).toBe(zs.length)
  })
})
