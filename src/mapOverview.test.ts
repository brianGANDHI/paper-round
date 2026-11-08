import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { lineStyle } from './colors'
import { drawsArrows, fitPaddingFor, lineStyleFor, mapOptions, OVERVIEW_PAD_PX } from './mapOverview'
import { fitPadding } from './roundView'
import { SIDES } from './types'

/*
 * The map to look over, as in Optimise Route's results, against the round's map. The zoom a fit comes to is Leaflet's own sum, `getBoundsZoom`, run on
 * a map that is never drawn: Leaflet only needs a few of a browser's globals to load, and these stand in for a phone's, where it zooms by fractions.
 */
type Leaflet = typeof import('leaflet')
let L: Leaflet

beforeAll(() => {
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('devicePixelRatio', 2)
  vi.stubGlobal('document', { documentElement: { style: {} }, createElement: () => ({}) })
  vi.stubGlobal('navigator', { userAgent: 'test', platform: 'test' })
  // A phone's browser can move the map by fractions of a pixel, which is when Leaflet goes by `zoomSnap` at all.
  vi.stubGlobal(
    'WebKitCSSMatrix',
    class {
      m11 = 1
    },
  )
  L = createRequire(import.meta.url)('leaflet') as Leaflet
})
afterAll(() => {
  vi.unstubAllGlobals()
})

/** The zoom Leaflet fits a box to, for a map made with these options, this big, with this much room kept clear round the route. */
function fitZoom(options: { zoomSnap: number }, box: [number, number], bounds: [[number, number], [number, number]], pad: { topLeft: [number, number]; bottomRight: [number, number] }): number {
  const map = Object.create(L.Map.prototype) as InstanceType<Leaflet['Map']> & { _size: unknown; _sizeChanged: boolean; _zoom: number }
  map.options = { ...L.Map.prototype.options, ...options, maxZoom: 18 }
  map._size = L.point(box[0], box[1])
  map._sizeChanged = false
  map._zoom = 0
  // `fitBounds` asks for the zoom with the two corners' room added together.
  return map.getBoundsZoom(L.latLngBounds(bounds), false, L.point(pad.topLeft).add(pad.bottomRight))
}

/** How much of the box's height a route this tall in metres takes at a zoom, on Leaflet's own scale at that latitude. */
const heightShare = (metres: number, lat: number, zoom: number, boxPx: number) => metres / ((156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom) / boxPx

// A made-up round, 3 km across and 10 km from top to bottom, at a latitude where a degree of longitude is shorter than one of latitude.
const LAT = -30
const ROUND: [[number, number], [number, number]] = [
  [LAT, 150],
  [LAT + 10 / 111.32, 150 + 3 / (111.32 * Math.cos((LAT * Math.PI) / 180))],
]
// The results map on a phone 390 points wide: the sheet's width less its gutters, and min(420px, 60vh) high.
const BOX: [number, number] = [366, 420]

describe('the options a map is made with', () => {
  it('lets one finger and the wheel go by an overview, to scroll the list, and fits it by fractions of a zoom step', () => {
    expect(mapOptions(true)).toEqual({ dragging: false, scrollWheelZoom: false, zoomSnap: 0 })
  })

  it("are Leaflet's own for the round's map, so it is as it always was", () => {
    const { dragging, scrollWheelZoom, zoomSnap } = L.Map.prototype.options
    expect(mapOptions(false)).toEqual({ dragging, scrollWheelZoom, zoomSnap })
  })
})

describe('the room kept clear round a fitted route', () => {
  it('is the same small margin on every side of an overview, whatever the round would keep clear of', () => {
    for (const cover of [0, 180]) expect(fitPaddingFor(true, cover)).toEqual({ topLeft: [OVERVIEW_PAD_PX, OVERVIEW_PAD_PX], bottomRight: [OVERVIEW_PAD_PX, OVERVIEW_PAD_PX] })
    expect(OVERVIEW_PAD_PX).toBe(12)
  })

  it("is the round's own on the round's map", () => {
    expect(fitPaddingFor(false, 180)).toEqual(fitPadding(180))
  })
})

describe('how the route is drawn', () => {
  it('is a thin line on an overview, the same for every side', () => {
    for (const side of SIDES) expect(lineStyleFor(true, side)).toEqual({ casing: { weight: 5, opacity: 0.95 }, line: { weight: 3 } })
  })

  it("is the round's own line on the round's map", () => {
    for (const side of SIDES) expect(lineStyleFor(false, side)).toEqual(lineStyle(side))
  })

  it('has arrows on the round only', () => {
    expect(drawsArrows(true)).toBe(false)
    expect(drawsArrows(false)).toBe(true)
  })
})

describe('the zoom a whole round is fitted to', () => {
  it('fills nine tenths of the height or more on an overview, between whole zoom steps', () => {
    const zoom = fitZoom(mapOptions(true), BOX, ROUND, fitPaddingFor(true, 0))
    expect(zoom).toBeCloseTo(12.39, 2)
    expect(heightShare(10_000, LAT, zoom, BOX[1])).toBeGreaterThan(0.9)
  })

  it("would leave a quarter of the box empty with the round's options or its margins, which is what the overview's are for", () => {
    const whole = fitZoom(mapOptions(false), BOX, ROUND, fitPaddingFor(true, 0))
    const roundMargins = fitZoom(mapOptions(true), BOX, ROUND, fitPaddingFor(false, 0))
    expect(whole).toBe(12)
    for (const zoom of [whole, roundMargins]) expect(heightShare(10_000, LAT, zoom, BOX[1])).toBeLessThan(0.8)
  })
})
