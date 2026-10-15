import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lookupAddress, parsePlaces, rate, searchPlaces, viewboxFor } from './geocode'
import { AUSTRALIA } from './region'
import type { Route } from './types'

const route: Route = {
  points: [
    { lat: 51.0, lng: 0 },
    { lat: 51.004, lng: 0 },
  ],
  sideChanges: [{ idx: 0, side: 'both' }],
  stops: [],
}

const house = (lat: number, lon: number, name = 'House') => ({
  lat: String(lat),
  lon: String(lon),
  display_name: name,
  place_rank: 30,
  addresstype: 'house',
})

function mockFetch(...responses: unknown[][]) {
  const fn = vi.fn()
  for (const r of responses) fn.mockResolvedValueOnce({ ok: true, json: async () => r })
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  rate.minGapMs = 0
})
afterEach(() => vi.unstubAllGlobals())

describe('parsePlaces', () => {
  it('reads coordinates and tells houses from streets', () => {
    const places = parsePlaces([
      house(51.001, 0.0001, '12 Oak Road'),
      { lat: '51.002', lon: '0', display_name: 'Oak Road', place_rank: 26, addresstype: 'road' },
    ])
    expect(places.map((p) => [p.name, p.exact])).toEqual([
      ['12 Oak Road', true],
      ['Oak Road', false],
    ])
    expect(places[0].lat).toBeCloseTo(51.001)
  })

  it('drops rubbish and non-arrays', () => {
    expect(parsePlaces([{ lat: 'x', lon: '1' }, null])).toEqual([])
    expect(parsePlaces({ error: 'nope' })).toEqual([])
  })
})

describe('viewboxFor', () => {
  it('surrounds the route with a margin as left,top,right,bottom', () => {
    const [left, top, right, bottom] = viewboxFor(route.points, 1000)!.split(',').map(Number)
    expect(left).toBeLessThan(0)
    expect(right).toBeGreaterThan(0)
    expect(top).toBeGreaterThan(51.004)
    expect(bottom).toBeLessThan(51.0)
  })

  it('has nothing to box without points', () => {
    expect(viewboxFor([])).toBeNull()
  })
})

describe('lookupAddress', () => {
  it('asks inside the route area first and measures the distance to the route', async () => {
    const f = mockFetch([house(51.002, 0.0003, '12 Oak Road')])
    const m = (await lookupAddress('12 Oak Road', route))!
    const url = new URL(f.mock.calls[0][0])
    expect(url.searchParams.get('bounded')).toBe('1')
    expect(url.searchParams.get('q')).toBe('12 Oak Road')
    expect(m.exact).toBe(true)
    expect(m.offM).toBeGreaterThan(15)
    expect(m.offM).toBeLessThan(25)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('widens the search and picks the candidate closest to the route', async () => {
    const f = mockFetch([], [house(52, 1, 'Far away'), house(51.002, 0.0002, 'Close by')])
    const m = (await lookupAddress('7 High Street', route))!
    expect(f).toHaveBeenCalledTimes(2)
    expect(new URL(f.mock.calls[1][0]).searchParams.get('bounded')).toBeNull()
    expect(m.place.name).toBe('Close by')
  })

  it('returns null when nothing is found', async () => {
    mockFetch([], [])
    expect(await lookupAddress('Nowhere', route)).toBeNull()
  })

  it('surfaces service errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }))
    await expect(lookupAddress('x', route)).rejects.toThrow('429')
  })
})

describe('searchPlaces', () => {
  it('leans toward Australia, without restricting to it, when there is no route yet', async () => {
    const f = mockFetch([house(-33.87, 151.21, 'Victoria Street, Sydney')])
    const places = await searchPlaces('Victoria Street')
    const url = new URL(f.mock.calls[0][0])
    expect(url.searchParams.get('viewbox')).toBe(AUSTRALIA.viewbox)
    expect(url.searchParams.get('bounded')).toBeNull()
    expect(places).toHaveLength(1)
  })

  it('prefers the area around the route over Australia once there is one', async () => {
    const f = mockFetch([])
    await searchPlaces('Oak Road', { near: route.points })
    const url = new URL(f.mock.calls[0][0])
    expect(url.searchParams.get('viewbox')).toBe(viewboxFor(route.points))
    expect(url.searchParams.get('viewbox')).not.toBe(AUSTRALIA.viewbox)
  })

  it('leaves a gap between requests but stops waiting the moment it is cancelled', async () => {
    mockFetch([house(51, 0)])
    await searchPlaces('first')
    rate.minGapMs = 5000
    const ctl = new AbortController()
    const started = Date.now()
    const second = searchPlaces('second', { signal: ctl.signal })
    ctl.abort()
    await expect(second).rejects.toBeTruthy()
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
