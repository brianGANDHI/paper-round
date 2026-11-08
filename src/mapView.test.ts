import { createRequire } from 'node:module'
import type { DivIcon } from 'leaflet'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { lineStyle } from './colors'
import type { Pt, Route } from './types'

/*
 * The map as an overview, such as Optimise Route's results, against the round's own map: what it is made with and what it draws. Nothing is mounted (the
 * tests have no page): react-leaflet's parts are stood in for by ones that keep what they were given and draw what is inside them, and the map is
 * rendered as markup, where no effect runs, so all that is seen is what it would be told to draw. Leaflet is the real one, loaded under a few of a
 * browser's globals as in mapOverview.test.ts, so the round's options can be held against Leaflet's own. The route is made up.
 */
const parts = vi.hoisted(() => ({ made: [] as { kind: string; props: Record<string, unknown> }[] }))
vi.mock('react-leaflet', async () => {
  const { Fragment, createElement } = await import('react')
  const part =
    (kind: string) =>
    (props: Record<string, unknown> & { children?: ReactNode }): ReactNode => {
      parts.made.push({ kind, props })
      return createElement(Fragment, null, props.children)
    }
  // The map the parts inside it ask for. They only read its options as they are drawn: everything they do with it waits for effects.
  const map = { options: {} }
  return {
    AttributionControl: part('AttributionControl'),
    CircleMarker: part('CircleMarker'),
    MapContainer: part('MapContainer'),
    Marker: part('Marker'),
    Pane: part('Pane'),
    Polyline: part('Polyline'),
    TileLayer: part('TileLayer'),
    useMap: () => map,
    useMapEvents: () => map,
  }
})

type Leaflet = typeof import('leaflet')
let L: Leaflet
let MapView: typeof import('./MapView').MapView

beforeAll(async () => {
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('devicePixelRatio', 2)
  vi.stubGlobal('document', { documentElement: { style: {} }, createElement: () => ({}) })
  vi.stubGlobal('navigator', { userAgent: 'test', platform: 'test' })
  L = createRequire(import.meta.url)('leaflet') as Leaflet
  // The map loads Leaflet for its icons as it is loaded itself, so it is loaded once the globals are there.
  ;({ MapView } = await import('./MapView'))
})
afterAll(() => {
  vi.unstubAllGlobals()
})

// A made-up road running north for 1.2 km: 600 m delivered on the port side, then 600 m of transit.
const LAT = -30
const north = (metres: number): Pt => ({ lat: LAT + metres / 111_320, lng: 150 })
const ROUTE: Route = {
  points: Array.from({ length: 13 }, (_, k) => north(100 * k)),
  sideChanges: [
    { idx: 0, side: 'left' },
    { idx: 6, side: 'transit' },
  ],
  stops: [],
}

/**
 * What each of react-leaflet's parts was given, by part, for the map drawn as Optimise Route's results draw it, with `overview` as asked: or with no
 * `overview` at all when it isn't, as the round's own map is drawn.
 */
function draw(overview?: boolean): Map<string, Record<string, unknown>[]> {
  parts.made.length = 0
  renderToStaticMarkup(createElement(MapView, { route: ROUTE, position: null, outsideCredit: true, ...(overview === undefined ? {} : { overview }) }))
  const byKind = new Map<string, Record<string, unknown>[]>()
  for (const { kind, props } of parts.made) byKind.set(kind, [...(byKind.get(kind) ?? []), props])
  return byKind
}

/** The one map that was made, and what it was told. */
function container(made: Map<string, Record<string, unknown>[]>): Record<string, unknown> {
  const maps = made.get('MapContainer') ?? []
  expect(maps).toHaveLength(1)
  return maps[0]
}

/** The arrows along the line, by their class, in the order they were drawn. */
const arrows = (made: Map<string, Record<string, unknown>[]>): string[] =>
  (made.get('Marker') ?? [])
    .map((props) => (props.icon as DivIcon | undefined)?.options.className ?? '')
    .filter((name) => name.split(' ').includes('arrow'))

/** The weights the route's lines are drawn with: the white casings and the coloured lines over them. */
const weights = (made: Map<string, Record<string, unknown>[]>): Set<unknown> =>
  new Set((made.get('Polyline') ?? []).map((props) => (props.pathOptions as { weight?: number }).weight))

describe('an overview map', () => {
  it('lets one finger and the wheel go by, to scroll the list, and fits by fractions of a zoom step', () => {
    const made = container(draw(true))
    expect(made).toMatchObject({ dragging: false, scrollWheelZoom: false, zoomSnap: 0 })
    // Two fingers still zoom it, as Leaflet has them do.
    expect(made.touchZoom).toBeUndefined()
  })

  it('draws no arrows along the line, and draws it thin', () => {
    const made = draw(true)
    expect(arrows(made)).toEqual([])
    expect(weights(made)).toEqual(new Set([5, 3]))
  })
})

describe("the round's map", () => {
  it("is made with Leaflet's own options, as it always has been", () => {
    const { dragging, scrollWheelZoom, zoomSnap } = L.Map.prototype.options
    expect([dragging, scrollWheelZoom, zoomSnap]).toEqual([true, true, 1])
    for (const made of [container(draw()), container(draw(false))]) {
      expect(made).toMatchObject({ dragging, scrollWheelZoom, zoomSnap, zoomControl: false, attributionControl: false, doubleClickZoom: false })
    }
  })

  it('has its arrows every 150 m, bigger on transit, and its own lines', () => {
    const made = draw()
    expect(arrows(made)).toEqual(['arrow', 'arrow', 'arrow', 'arrow', 'arrow transit', 'arrow transit', 'arrow transit', 'arrow transit'])
    const port = lineStyle('left')
    const transit = lineStyle('transit')
    expect(weights(made)).toEqual(new Set([port.casing.weight, port.line.weight, transit.casing.weight, transit.line.weight]))
  })
})
