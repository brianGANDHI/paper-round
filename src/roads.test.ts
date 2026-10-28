import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { angleBetween, distanceToPath, haversine } from './geo'
import {
  arrivalBearing,
  canFollow,
  ENDPOINT,
  extendAlongRoads,
  fetchDrive,
  fetchRoad,
  getJson,
  NEAREST,
  nearestEndpoint,
  rate,
  ROAD_NOTICE,
  ROAD_SIMPLIFY_M,
  reverseBearing,
  RoadError,
  roadPoints,
  roadSeconds,
  roadUrl,
  TIMEOUT_MS,
  undoStretch,
  UTURN_NOTICE,
  UTURN_RANGE_DEG,
  UTURN_SNAP_M,
  uturnAvailable,
  uturnIsOn,
  type Stretch,
} from './roads'
import { removeLastPoint } from './routeEdit'
import type { Pt, Route } from './types'

/**
 * A real answer from routing.openstreetmap.de (car profile, overview=full, geometries=geojson) for a 1.2 km drive
 * in Marrickville, Sydney, with the fields the app doesn't read left out.
 */
const COORDS: [number, number][] = [
  [151.155943, -33.910959], [151.155997, -33.910907], [151.156074, -33.910838], [151.156285, -33.910641],
  [151.156315, -33.910612], [151.156382, -33.910537], [151.156439, -33.910472], [151.156449, -33.910461],
  [151.156462, -33.910447], [151.156469, -33.91044], [151.156667, -33.91023], [151.157768, -33.909068],
  [151.158569, -33.908217], [151.159077, -33.90769], [151.159093, -33.907671], [151.159154, -33.907604],
  [151.159211, -33.907537], [151.159227, -33.907518], [151.159231, -33.907514], [151.159311, -33.907416],
  [151.159418, -33.907288], [151.159481, -33.907228], [151.159829, -33.906803], [151.160266, -33.906264],
  [151.16032, -33.906194], [151.16035, -33.906159], [151.160434, -33.906053], [151.160544, -33.905914],
  [151.160605, -33.905948], [151.161448, -33.906428], [151.161559, -33.906493], [151.162255, -33.9056],
  [151.162267, -33.905581], [151.162291, -33.905543], [151.162309, -33.90551], [151.16232, -33.905496],
  [151.162473, -33.905311], [151.16256, -33.905219], [151.16368, -33.903823],
]
const answer = (coordinates: unknown = COORDS, code = 'Ok') => ({
  code,
  routes: [{ distance: 1172.6, duration: 154.9, geometry: { type: 'LineString', coordinates } }],
  waypoints: [{ name: 'Illawarra Road', location: COORDS[0] }, { name: 'Shepherd Street', location: COORDS[COORDS.length - 1] }],
})

const toPt = ([lng, lat]: [number, number]): Pt => ({ lat, lng })
const START = toPt(COORDS[0])
const END = toPt(COORDS[COORDS.length - 1])
/** Where someone would tap: a few metres off the street at the far end. */
const TAP: Pt = { lat: -33.9038, lng: 151.1637 }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Reply = Response | Error | ((init?: RequestInit) => Promise<Response>)

/** Stands in for fetch: each call takes the next reply. */
function mockFetch(...replies: Reply[]) {
  const fn = vi.fn((_url: string, init?: RequestInit) => {
    const next = replies.shift()
    if (!next) throw new Error('unexpected request')
    if (next instanceof Error) return Promise.reject(next)
    if (typeof next === 'function') return next(init)
    return Promise.resolve(next)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** A server that never answers, but gives up when told to. */
const silent = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
  })

/** The kind of a RoadError. Read from the error itself, since some tests use a fresh copy of the module. */
const kindOf = (e: unknown) => (e instanceof Error && 'kind' in e ? String(e.kind) : 'not a RoadError')
/** How a call failed: the kind of its RoadError, or 'it worked'. */
const thrownKind = (fn: () => unknown) => {
  try {
    fn()
    return 'it worked'
  } catch (e) {
    return kindOf(e)
  }
}
const failure = async (p: Promise<unknown>) => {
  try {
    await p
    return 'it worked'
  } catch (e) {
    return kindOf(e)
  }
}

beforeEach(() => {
  rate.minGapMs = 0
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the request', () => {
  it('names both places longitude first, and asks for the whole street geometry as GeoJSON', () => {
    const url = roadUrl({ lat: -33.910959, lng: 151.155943 }, { lat: -33.903823, lng: 151.16368 })
    expect(url.startsWith(`${ENDPOINT}/151.155943,-33.910959;151.163680,-33.903823?`)).toBe(true)
    const query = new URLSearchParams(url.split('?')[1])
    expect(query.get('overview')).toBe('full')
    expect(query.get('geometries')).toBe('geojson')
  })

  it('only looks for streets close to the taps', () => {
    expect(roadUrl(START, END)).toContain('radiuses=50;50')
  })

  it('can look farther from the places for a street, as an address needs', () => {
    expect(roadUrl(START, END, 250)).toContain('radiuses=250;250')
    expect(roadUrl(START, END, 250)).not.toContain('radiuses=50')
  })

  it('goes to the FOSSGIS server on its car profile', () => {
    expect(ENDPOINT).toBe('https://routing.openstreetmap.de/routed-car/route/v1/driving')
  })
})

describe('the request for a U-turn', () => {
  const query = (url: string) => new URLSearchParams(url.split('?')[1])
  /** How many places the request names. */
  const places = (url: string) => url.split('?')[0].split('/').pop()!.split(';').length

  it('holds the road at the first place to leaving the way the route came, give or take 60 degrees', () => {
    // Arrived heading east, so the road has to leave heading west.
    const url = roadUrl(START, END, undefined, 90)
    expect(query(url).get('bearings')).toBe('270,60;')
    expect(UTURN_RANGE_DEG).toBe(60)
  })

  it('is well formed for two places: one entry each, only the first filled in, whole numbers', () => {
    for (const arrival of [0, 17.4, 89.6, 90, 179.5, 179.6, 180, 270.4, 359.4, 359.9, 360, -45, -200, 725, 1e-9]) {
      const url = roadUrl(START, END, undefined, arrival)
      const bearings = query(url).get('bearings')!
      expect(bearings, String(arrival)).toMatch(/^\d{1,3},60;$/)
      const entries = bearings.split(';')
      expect(entries).toHaveLength(places(url))
      expect(entries[1]).toBe('')
      const back = Number(entries[0].split(',')[0])
      expect(back).toBeGreaterThanOrEqual(0)
      expect(back).toBeLessThan(360)
    }
  })

  it('names the same number of places in the radiuses and the bearings', () => {
    const q = query(roadUrl(START, END, 250, 10))
    expect(q.get('radiuses')!.split(';')).toHaveLength(2)
    expect(q.get('bearings')!.split(';')).toHaveLength(2)
  })

  it('changes only the bearings and the first radius in the request, so everything else about it is as before', () => {
    const plain = roadUrl(START, END, 250)
    const turning = roadUrl(START, END, 250, 90)
    expect(turning).toBe(plain.replace('radiuses=250;250', 'radiuses=30;250') + '&bearings=270,60;')
    expect(query(turning).get('overview')).toBe('full')
    expect(query(turning).get('geometries')).toBe('geojson')
  })

  it('looks for the road to leave by only 30 m round the last point, and for the tap as far as any other tap', () => {
    expect(UTURN_SNAP_M).toBe(30)
    expect(query(roadUrl(START, END, undefined, 90)).get('radiuses')).toBe('30;50')
    expect(query(roadUrl(START, END, 250, 90)).get('radiuses')).toBe('30;250')
    expect(query(roadUrl(START, END, 1000, 90)).get('radiuses')).toBe('30;1000')
  })

  it('does not look farther for the road to leave by than it was told to look for anything', () => {
    expect(query(roadUrl(START, END, 20, 90)).get('radiuses')).toBe('20;20')
    expect(query(roadUrl(START, END, 30, 90)).get('radiuses')).toBe('30;30')
    expect(query(roadUrl(START, END, 31, 90)).get('radiuses')).toBe('30;31')
  })

  it('looks as far as ever for both places when no U-turn is asked for, or what is given is not a bearing', () => {
    expect(query(roadUrl(START, END)).get('radiuses')).toBe('50;50')
    expect(query(roadUrl(START, END, 250)).get('radiuses')).toBe('250;250')
    expect(query(roadUrl(START, END, 250, undefined)).get('radiuses')).toBe('250;250')
    expect(query(roadUrl(START, END, 250, Number.NaN)).get('radiuses')).toBe('250;250')
    expect(query(roadUrl(START, END, 250, Infinity)).get('radiuses')).toBe('250;250')
  })

  it('has no bearings unless a U-turn is asked for, or when what is given is not a bearing', () => {
    expect(roadUrl(START, END)).not.toContain('bearings')
    expect(roadUrl(START, END, 250, undefined)).not.toContain('bearings')
    expect(roadUrl(START, END, 250, Number.NaN)).not.toContain('bearings')
    expect(roadUrl(START, END, 250, Infinity)).not.toContain('bearings')
    expect(roadUrl(START, END, 250, Number('north'))).toBe(roadUrl(START, END, 250))
  })

  it('takes a bearing of 0, north, as a bearing', () => {
    expect(query(roadUrl(START, END, undefined, 0)).get('bearings')).toBe('180,60;')
  })

  it('turns a bearing round to the opposite direction, in whole degrees from 0 to 359', () => {
    const cases: [number, number][] = [
      [0, 180],
      [1, 181],
      [90, 270],
      [179, 359],
      [180, 0],
      [181, 1],
      [270, 90],
      [359, 179],
      [17.4, 197],
      [89.6, 270],
      // Rounding up to 360 comes back round to 0, which is what OSRM expects for north.
      [179.6, 0],
      [179.5, 0],
      [359.5, 180],
      [360, 180],
      [-90, 90],
      [-181, 359],
      [-270, 270],
      [450, 270],
      [725, 185],
    ]
    for (const [from, to] of cases) expect(reverseBearing(from), String(from)).toBe(to)
  })
})

describe('roadPoints', () => {
  it('turns longitude, latitude pairs into points, keeping the ends exactly', () => {
    const pts = roadPoints(answer())
    expect(pts[0]).toEqual(START)
    expect(pts[pts.length - 1]).toEqual(END)
  })

  it('thins the street without cutting its bends by more than the tolerance', () => {
    const pts = roadPoints(answer())
    expect(pts.length).toBeGreaterThanOrEqual(2)
    expect(pts.length).toBeLessThan(COORDS.length)
    for (const c of COORDS) expect(distanceToPath(toPt(c), pts)).toBeLessThanOrEqual(ROAD_SIMPLIFY_M + 0.01)
  })

  it('keeps a point where the road turns', () => {
    // East for 200 m, then north for 200 m.
    const corner: [number, number][] = [[151.0, -33.9], [151.001, -33.9], [151.002, -33.9], [151.002, -33.8982], [151.002, -33.8964]]
    expect(roadPoints(answer(corner))).toEqual([toPt(corner[0]), toPt(corner[2]), toPt(corner[4])])
  })

  it('drops coordinates that are not numbers or not on Earth', () => {
    const messy = [[151, -33], null, ['x', 'y'], [200, 0], [151, 95], [151.001, -33.001], 'nope']
    expect(roadPoints(answer(messy))).toEqual([{ lat: -33, lng: 151 }, { lat: -33.001, lng: 151.001 }])
  })

  it('says there is nothing to follow when the service finds no street or no way', () => {
    for (const code of ['NoRoute', 'NoSegment']) expect(thrownKind(() => roadPoints({ code, message: 'nope' }))).toBe('no-road')
  })

  it('treats any other answer as the service not working', () => {
    const bad: unknown[] = [
      null,
      undefined,
      [],
      'oops',
      {},
      { code: 'InvalidUrl' },
      { code: 'Ok' },
      { code: 'Ok', routes: [] },
      { code: 'Ok', routes: [{}] },
      answer([[151, -33]]),
      answer([]),
      answer('LINESTRING(1 2, 3 4)'),
    ]
    for (const body of bad) expect(thrownKind(() => roadPoints(body))).toBe('service')
  })
})

describe('roadSeconds', () => {
  it('reads how long the drive takes', () => {
    expect(roadSeconds(answer())).toBe(154.9)
  })

  it('is null when the answer has no usable time', () => {
    const bad: unknown[] = [null, undefined, 'x', {}, { routes: [] }, { routes: [{}] }, { routes: [{ duration: '154' }] }, { routes: [{ duration: -3 }] }, { routes: [{ duration: NaN }] }]
    for (const body of bad) expect(roadSeconds(body)).toBeNull()
  })
})

describe('fetchDrive', () => {
  it('returns the street route with how long it takes', async () => {
    mockFetch(json(answer()))
    const drive = await fetchDrive(START, TAP)
    expect(drive.points).toEqual(roadPoints(answer()))
    expect(drive.seconds).toBe(154.9)
  })

  it('looks for a street as far from each end as it is told to', async () => {
    const f = mockFetch(json(answer()))
    await fetchDrive(START, TAP, { radiusM: 250 })
    expect(f.mock.calls[0][0]).toBe(roadUrl(START, TAP, 250))
  })

  it('has no time when the answer does not give one', async () => {
    const body = answer()
    delete (body.routes[0] as { duration?: number }).duration
    mockFetch(json(body))
    expect((await fetchDrive(START, TAP)).seconds).toBeNull()
  })

  it('fails the same ways fetchRoad does', async () => {
    mockFetch(json({ code: 'NoRoute' }, 400))
    expect(await failure(fetchDrive(START, TAP))).toBe('no-road')
  })

  it('leaves the start the way it was told to, looking only 30 m round the start and as far as it is told round the end', async () => {
    const f = mockFetch(json(answer()))
    const drive = await fetchDrive(START, TAP, { radiusM: 250, uturnFrom: 45 })
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0][0]).toBe(roadUrl(START, TAP, 250, 45))
    expect(f.mock.calls[0][0]).toContain('radiuses=30;250&bearings=225,60;')
    expect(drive.points).toEqual(roadPoints(answer()))
  })
})

describe('fetchRoad', () => {
  it('makes one plain request and returns the street route', async () => {
    const f = mockFetch(json(answer()))
    const pts = await fetchRoad(START, TAP)
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(roadUrl(START, TAP))
    // Custom headers would make the browser ask permission first; a bare GET does not.
    expect(Object.keys(init ?? {})).toEqual(['signal'])
    expect(pts).toEqual(roadPoints(answer()))
  })

  it('leaves no timer running afterwards', async () => {
    vi.useFakeTimers()
    mockFetch(json(answer()))
    await fetchRoad(START, TAP)
    expect(vi.getTimerCount()).toBe(0)
  })

  describe('for a U-turn', () => {
    it('makes the same one plain request, with the road held to leaving the way back', async () => {
      const f = mockFetch(json(answer()))
      const pts = await fetchRoad(START, TAP, { uturnFrom: 100 })
      expect(f).toHaveBeenCalledTimes(1)
      const [url, init] = f.mock.calls[0]
      expect(url).toBe(roadUrl(START, TAP, undefined, 100))
      expect(String(url)).toContain('&bearings=280,60;')
      expect(Object.keys(init ?? {})).toEqual(['signal'])
      expect(pts).toEqual(roadPoints(answer()))
    })

    it('reports no road when the start cannot be left that way, as a one-way street cannot', async () => {
      mockFetch(json({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 0' }, 400))
      expect(await failure(fetchRoad(START, TAP, { uturnFrom: 100 }))).toBe('no-road')
    })

    it('fails the other ways just as it does without one', async () => {
      mockFetch(json({ message: 'slow down' }, 429))
      expect(await failure(fetchRoad(START, TAP, { uturnFrom: 100 }))).toBe('service')
      mockFetch(new TypeError('Load failed'))
      expect(await failure(fetchRoad(START, TAP, { uturnFrom: 100 }))).toBe('offline')
    })

    it('gives up on a slow service after the timeout', async () => {
      vi.useFakeTimers()
      mockFetch(silent)
      const outcome = failure(fetchRoad(START, TAP, { uturnFrom: 100 }))
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
      expect(await outcome).toBe('timeout')
    })

    it('can be cancelled while the request is out, which stops the request, and does nothing when cancelled already', async () => {
      vi.useFakeTimers()
      const f = mockFetch(silent)
      const ctl = new AbortController()
      const outcome = failure(fetchRoad(START, TAP, { signal: ctl.signal, uturnFrom: 100 }))
      await vi.advanceTimersByTimeAsync(10)
      ctl.abort()
      expect(await outcome).toBe('cancelled')
      expect(f.mock.calls[0][1]?.signal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)

      const again = mockFetch(json(answer()))
      expect(await failure(fetchRoad(START, TAP, { signal: ctl.signal, uturnFrom: 100 }))).toBe('cancelled')
      expect(again).not.toHaveBeenCalled()
    })

    it('keeps to the gap between requests like any other, and stops waiting the moment it is cancelled', async () => {
      vi.resetModules()
      const fresh = await import('./roads')
      vi.useFakeTimers()
      fresh.rate.minGapMs = 1100
      const f = mockFetch(json(answer()), json(answer()), json(answer()))

      await fresh.fetchRoad(START, TAP)
      const second = fresh.fetchRoad(START, TAP, { uturnFrom: 100 })
      await vi.advanceTimersByTimeAsync(1099)
      expect(f).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      await second
      expect(f).toHaveBeenCalledTimes(2)
      expect(String(f.mock.calls[1][0])).toContain('bearings=')

      const ctl = new AbortController()
      const third = failure(fresh.fetchRoad(START, TAP, { signal: ctl.signal, uturnFrom: 100 }))
      await vi.advanceTimersByTimeAsync(300)
      ctl.abort()
      expect(await third).toBe('cancelled')
      expect(f).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('reports no road when the service finds nothing near a tap, or no way between them', async () => {
    mockFetch(json({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 1' }, 400))
    expect(await failure(fetchRoad(START, TAP))).toBe('no-road')
    mockFetch(json({ code: 'NoRoute', message: 'Impossible route between points' }, 400))
    expect(await failure(fetchRoad(START, TAP))).toBe('no-road')
    mockFetch(json({ code: 'NoRoute', routes: [] }, 200))
    expect(await failure(fetchRoad(START, TAP))).toBe('no-road')
  })

  it('reports the service not working for errors, busy signals and pages that are not JSON', async () => {
    mockFetch(json({ message: 'slow down' }, 429))
    expect(await failure(fetchRoad(START, TAP))).toBe('service')
    mockFetch(json({ code: 'InvalidUrl' }, 400))
    expect(await failure(fetchRoad(START, TAP))).toBe('service')
    mockFetch(new Response('<html>Bad gateway</html>', { status: 502 }))
    expect(await failure(fetchRoad(START, TAP))).toBe('service')
    mockFetch(new Response('<html>Hotel wifi login</html>', { status: 200 }))
    expect(await failure(fetchRoad(START, TAP))).toBe('service')
    mockFetch(json({ code: 'Ok', routes: [] }))
    expect(await failure(fetchRoad(START, TAP))).toBe('service')
  })

  it('reports offline when the request never gets through', async () => {
    mockFetch(new TypeError('Load failed'))
    expect(await failure(fetchRoad(START, TAP))).toBe('offline')
  })

  it('reports offline without even trying when the phone says it has no connection', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const f = mockFetch(json(answer()))
    expect(await failure(fetchRoad(START, TAP))).toBe('offline')
    expect(f).not.toHaveBeenCalled()
  })

  it('gives up on a slow service after the timeout, and says so', async () => {
    vi.useFakeTimers()
    const f = mockFetch(silent)
    const outcome = failure(fetchRoad(START, TAP))
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1)
    expect(f.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe('timeout')
    expect(f.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes the timeout from the options', async () => {
    vi.useFakeTimers()
    mockFetch(silent)
    const outcome = failure(fetchRoad(START, TAP, { timeoutMs: 800 }))
    await vi.advanceTimersByTimeAsync(800)
    expect(await outcome).toBe('timeout')
  })

  it('can be cancelled while the request is out, which stops the request', async () => {
    vi.useFakeTimers()
    const f = mockFetch(silent)
    const ctl = new AbortController()
    const outcome = failure(fetchRoad(START, TAP, { signal: ctl.signal }))
    await vi.advanceTimersByTimeAsync(10)
    ctl.abort()
    expect(await outcome).toBe('cancelled')
    expect(f.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does nothing when it is already cancelled', async () => {
    const f = mockFetch(json(answer()))
    const ctl = new AbortController()
    ctl.abort()
    expect(await failure(fetchRoad(START, TAP, { signal: ctl.signal }))).toBe('cancelled')
    expect(f).not.toHaveBeenCalled()
  })

  it('says it was cancelled, not that there is no connection, when it is both', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const ctl = new AbortController()
    ctl.abort()
    expect(await failure(getJson('https://example.test/', { signal: ctl.signal }))).toBe('cancelled')
  })

  it('leaves a gap between requests, and stops waiting the moment it is cancelled', async () => {
    // A fresh copy of the module, so the time of the last request left by other tests doesn't matter.
    vi.resetModules()
    const fresh = await import('./roads')
    vi.useFakeTimers()
    fresh.rate.minGapMs = 1100
    const f = mockFetch(json(answer()), json(answer()), json(answer()))

    await fresh.fetchRoad(START, TAP)
    expect(f).toHaveBeenCalledTimes(1)

    const second = fresh.fetchRoad(START, TAP)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    await second
    expect(f).toHaveBeenCalledTimes(2)

    const ctl = new AbortController()
    const third = failure(fresh.fetchRoad(START, TAP, { signal: ctl.signal }))
    await vi.advanceTimersByTimeAsync(300)
    ctl.abort()
    expect(await third).toBe('cancelled')
    expect(f).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('canFollow', () => {
  const route = (...points: Pt[]): Route => ({ points, sideChanges: [], stops: [] })

  it('needs a point to start from', () => {
    expect(canFollow(route(), TAP)).toBe(false)
    expect(canFollow(route(START), TAP)).toBe(true)
  })

  it('ignores a tap on the last point', () => {
    expect(canFollow(route(START, TAP), { lat: TAP.lat + 0.00001, lng: TAP.lng })).toBe(false)
  })
})

describe('extending the route along roads', () => {
  const before: Route = { points: [{ lat: -33.9125, lng: 151.1549 }, START], sideChanges: [{ idx: 0, side: 'both' }], stops: [] }

  it('asks for the way from the last point to the tap, once', async () => {
    const f = mockFetch(json(answer()))
    await extendAlongRoads(before, TAP, 'both')
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0][0]).toBe(roadUrl(START, TAP))
  })

  it('adds the street route after the last point', async () => {
    mockFetch(json(answer()))
    const out = await extendAlongRoads(before, TAP, 'both')
    const road = roadPoints(answer())
    expect(out.notice).toBeNull()
    // The street starts where the route already ends, so that point isn't added twice.
    expect(out.route.points).toEqual([...before.points, ...road.slice(1)])
    expect(out.added).toEqual(road.slice(1))
    expect(out.replaced).toBeNull()
    expect(out.route.points[out.route.points.length - 1]).toEqual(END)
  })

  it('keeps the same side going while the side is the same', async () => {
    mockFetch(json(answer()))
    const out = await extendAlongRoads(before, TAP, 'both')
    expect(out.route.sideChanges).toEqual([{ idx: 0, side: 'both' }])
  })

  it('starts one new section where the side changes, as tapping would', async () => {
    mockFetch(json(answer()))
    const out = await extendAlongRoads(before, TAP, 'left')
    expect(out.route.sideChanges).toEqual([
      { idx: 0, side: 'both' },
      { idx: 1, side: 'left' },
    ])
  })

  it('starts a route that is one loose point on the street instead of linking to it', async () => {
    mockFetch(json(answer()))
    const loose: Pt = { lat: -33.9109, lng: 151.1559 }
    const out = await extendAlongRoads({ points: [loose], sideChanges: [], stops: [] }, TAP, 'right')
    const road = roadPoints(answer())
    expect(out.route.points).toEqual(road)
    expect(out.replaced).toEqual(loose)
    expect(out.added).toEqual(road)
    expect(out.route.sideChanges).toEqual([{ idx: 0, side: 'right' }])
  })

  it('draws a straight line when the lookup fails, and says why', async () => {
    const cases: [string, Reply, keyof typeof ROAD_NOTICE][] = [
      ['offline', new TypeError('Load failed'), 'offline'],
      ['the service failing', json({ message: 'down' }, 503), 'service'],
      ['no road near the tap', json({ code: 'NoSegment' }, 400), 'no-road'],
      ['no way between the points', json({ code: 'NoRoute' }, 400), 'no-road'],
    ]
    for (const [, reply, kind] of cases) {
      mockFetch(reply)
      const out = await extendAlongRoads(before, TAP, 'left')
      expect(out.route.points).toEqual([...before.points, TAP])
      expect(out.added).toEqual([TAP])
      expect(out.notice).toBe(ROAD_NOTICE[kind])
      // The side works just as it does without roads.
      expect(out.route.sideChanges).toEqual([
        { idx: 0, side: 'both' },
        { idx: 1, side: 'left' },
      ])
    }
  })

  it('draws a straight line when the service is too slow', async () => {
    vi.useFakeTimers()
    mockFetch(silent)
    const out = extendAlongRoads(before, TAP, 'both')
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    const done = await out
    expect(done.route.points).toEqual([...before.points, TAP])
    expect(done.notice).toBe(ROAD_NOTICE.timeout)
  })

  it('draws a straight line without asking when the phone has no connection', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const f = mockFetch(json(answer()))
    const out = await extendAlongRoads(before, TAP, 'both')
    expect(f).not.toHaveBeenCalled()
    expect(out.notice).toBe(ROAD_NOTICE.offline)
    expect(out.route.points).toEqual([...before.points, TAP])
  })

  it('has a message for every way a lookup can fail, other than being cancelled', () => {
    expect(Object.keys(ROAD_NOTICE).sort()).toEqual(['no-road', 'offline', 'service', 'timeout'])
    for (const text of Object.values(ROAD_NOTICE)) expect(text.length).toBeGreaterThan(10)
  })

  it('does not ask when there is nothing to follow from, or the tap is on the last point', async () => {
    const f = mockFetch(json(answer()))
    const first = await extendAlongRoads({ points: [], sideChanges: [], stops: [] }, TAP, 'left')
    expect(first.route.points).toEqual([TAP])
    expect(first.notice).toBeNull()
    const double = await extendAlongRoads(before, { lat: START.lat + 0.00001, lng: START.lng }, 'left')
    expect(double.route).toBe(before)
    expect(double.added).toEqual([])
    expect(f).not.toHaveBeenCalled()
  })

  it('gives up, rather than drawing a straight line, when cancelled', async () => {
    const f = mockFetch(silent)
    const ctl = new AbortController()
    const settled = failure(extendAlongRoads(before, TAP, 'left', { signal: ctl.signal }))
    // Let the request go out first.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f).toHaveBeenCalledTimes(1)
    ctl.abort()
    expect(await settled).toBe('cancelled')
  })
})

describe('extending the route with a U-turn', () => {
  const before: Route = { points: [{ lat: -33.9125, lng: 151.1549 }, START], sideChanges: [{ idx: 0, side: 'both' }], stops: [] }

  it('asks once, for the road held to leaving the way back, and adds it as usual', async () => {
    const f = mockFetch(json(answer()))
    const out = await extendAlongRoads(before, TAP, 'both', { uturnFrom: 125 })
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0][0]).toBe(roadUrl(START, TAP, undefined, 125))
    expect(String(f.mock.calls[0][0])).toContain('&bearings=305,60;')
    const road = roadPoints(answer())
    expect(out.notice).toBeNull()
    expect(out.route.points).toEqual([...before.points, ...road.slice(1)])
    expect(out.added).toEqual(road.slice(1))
    expect(out.route.sideChanges).toEqual([{ idx: 0, side: 'both' }])
  })

  it('asks without bearings when no U-turn is wanted', async () => {
    const f = mockFetch(json(answer()))
    await extendAlongRoads(before, TAP, 'both', {})
    expect(String(f.mock.calls[0][0])).not.toContain('bearings')
  })

  it('draws a straight line when there is no road to turn back along, and says a U-turn could not be made', async () => {
    for (const code of ['NoSegment', 'NoRoute']) {
      mockFetch(json({ code }, 400))
      const out = await extendAlongRoads(before, TAP, 'left', { uturnFrom: 125 })
      expect(out.route.points).toEqual([...before.points, TAP])
      expect(out.added).toEqual([TAP])
      expect(out.notice).toBe(UTURN_NOTICE)
      expect(out.notice).toContain('U-turn')
      expect(out.route.sideChanges).toEqual([
        { idx: 0, side: 'both' },
        { idx: 1, side: 'left' },
      ])
    }
  })

  it('gives the same notice whichever way there was no road: nothing to leave by, a tap off the road, or no way between', async () => {
    const answers = [
      json({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 0' }, 400),
      json({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 1' }, 400),
      json({ code: 'NoRoute', message: 'Impossible route between points' }, 400),
      // An answer that is a success but says there is no way, as a few servers do.
      json({ code: 'NoRoute', routes: [] }, 200),
    ]
    for (const reply of answers) {
      mockFetch(reply)
      const out = await extendAlongRoads(before, TAP, 'both', { uturnFrom: 125 })
      expect(out.notice).toBe(UTURN_NOTICE)
      expect(out.route.points).toEqual([...before.points, TAP])
    }
  })

  it('does not blame the U-turn alone: the notice names a one-way street and a point far from a road, and still says it is a straight line', () => {
    // The service answers NoSegment for either place and cannot say which, so the words must be true for each of them.
    expect(UTURN_NOTICE).toContain('U-turn')
    expect(UTURN_NOTICE).toMatch(/one-way street/)
    expect(UTURN_NOTICE).toMatch(/too far from a road/)
    expect(UTURN_NOTICE).toMatch(/straight line\.$/)
    // It is a possibility, not a claim of which, and it is not the plain notice either.
    expect(UTURN_NOTICE).toMatch(/\bmay be\b/)
    expect(UTURN_NOTICE).not.toBe(ROAD_NOTICE['no-road'])
  })

  it('says the usual thing, not a U-turn one, when a road was not wanted back or the failure is something else', async () => {
    mockFetch(json({ code: 'NoSegment' }, 400))
    expect((await extendAlongRoads(before, TAP, 'both')).notice).toBe(ROAD_NOTICE['no-road'])
    // A bearing that is not one is no U-turn, and not asked for.
    const f = mockFetch(json({ code: 'NoSegment' }, 400))
    expect((await extendAlongRoads(before, TAP, 'both', { uturnFrom: Number.NaN })).notice).toBe(ROAD_NOTICE['no-road'])
    expect(String(f.mock.calls[0][0])).not.toContain('bearings')

    const cases: [Reply, keyof typeof ROAD_NOTICE][] = [
      [new TypeError('Load failed'), 'offline'],
      [json({ message: 'down' }, 503), 'service'],
    ]
    for (const [reply, kind] of cases) {
      mockFetch(reply)
      const out = await extendAlongRoads(before, TAP, 'both', { uturnFrom: 125 })
      expect(out.notice).toBe(ROAD_NOTICE[kind])
      expect(out.route.points).toEqual([...before.points, TAP])
    }
  })

  it('draws a straight line, with the usual notice, when the service is too slow', async () => {
    vi.useFakeTimers()
    mockFetch(silent)
    const out = extendAlongRoads(before, TAP, 'both', { uturnFrom: 125 })
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    const done = await out
    expect(done.route.points).toEqual([...before.points, TAP])
    expect(done.notice).toBe(ROAD_NOTICE.timeout)
  })

  it('draws a straight line without asking when the phone has no connection', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const f = mockFetch(json(answer()))
    const out = await extendAlongRoads(before, TAP, 'both', { uturnFrom: 125 })
    expect(f).not.toHaveBeenCalled()
    expect(out.notice).toBe(ROAD_NOTICE.offline)
  })

  it('gives up, rather than drawing a straight line, when cancelled', async () => {
    const f = mockFetch(silent)
    const ctl = new AbortController()
    const settled = failure(extendAlongRoads(before, TAP, 'left', { signal: ctl.signal, uturnFrom: 125 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f).toHaveBeenCalledTimes(1)
    ctl.abort()
    expect(await settled).toBe('cancelled')
  })

  it('does not ask when there is nothing to turn back from, or the tap is on the last point', async () => {
    const f = mockFetch(json(answer()))
    const first = await extendAlongRoads({ points: [], sideChanges: [], stops: [] }, TAP, 'left', { uturnFrom: 125 })
    expect(first.route.points).toEqual([TAP])
    const double = await extendAlongRoads(before, { lat: START.lat + 0.00001, lng: START.lng }, 'left', { uturnFrom: 125 })
    expect(double.route).toBe(before)
    expect(f).not.toHaveBeenCalled()
  })

  it('is taken back whole by undo, like any other stretch of road', async () => {
    mockFetch(json(answer()))
    const out = await extendAlongRoads(before, TAP, 'left', { uturnFrom: 125 })
    const undone = undoStretch(out.route, [{ added: out.added, replaced: out.replaced }])!
    expect(undone.route).toEqual(before)
  })

  describe('where the road to leave by may be', () => {
    /** A place this many metres east of the last point of the route. */
    const eastOfStart = (m: number): Pt => ({ lat: START.lat, lng: START.lng + m / (111_320 * Math.cos((START.lat * Math.PI) / 180)) })
    /** A road near the last point: how far from it, and the way it runs (compass degrees). */
    interface Nearby {
      away: number
      heading: number
    }
    /**
     * Stands in for the routing service in the one respect that matters here: the first place is snapped to the nearest road
     * within its `radiuses` entry that runs the way its `bearings` entry says, give or take the range. Otherwise it answers
     * NoSegment, as the real one does. The road then starts where it was snapped, `away` metres east of the last point.
     */
    function service(roads: Nearby[]) {
      return vi.fn((url: string) => {
        const q = new URLSearchParams(url.split('?')[1])
        const radius = Number(q.get('radiuses')!.split(';')[0])
        const [want, range] = (q.get('bearings') ?? '').split(';')[0].split(',').map(Number)
        const found = roads
          .filter((r) => r.away <= radius && (q.get('bearings') === null || angleBetween(r.heading, want) <= range))
          .sort((a, b) => a.away - b.away)[0]
        if (!found) return Promise.resolve(json({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 0' }, 400))
        const start = eastOfStart(found.away)
        return Promise.resolve(json(answer([[start.lng, start.lat], ...COORDS.slice(1)])))
      })
    }
    const arrival = arrivalBearing(before.points)!
    const back = reverseBearing(arrival)
    /** The street the route is on: it runs the way the route came, so it cannot be left the way back. */
    const oneWay: Nearby = { away: 0, heading: arrival }

    it('does not jump to the next street when the one being driven is one-way, even though that street is 47 m away', async () => {
      // Seen live in Manhattan: with 50 m to look in, the road began on the next street and was joined by a 47 m diagonal.
      const f = service([oneWay, { away: 47, heading: back }])
      vi.stubGlobal('fetch', f)
      const out = await extendAlongRoads(before, TAP, 'both', { uturnFrom: arrival })
      expect(f).toHaveBeenCalledTimes(1)
      expect(out.notice).toBe(UTURN_NOTICE)
      expect(out.route.points).toEqual([...before.points, TAP])
      expect(out.added).toEqual([TAP])
    })

    it('turns back along the other carriageway of a dual carriageway, up to 25 m across', async () => {
      for (const away of [3, 12, 25]) {
        const f = service([oneWay, { away, heading: back }])
        vi.stubGlobal('fetch', f)
        const out = await extendAlongRoads(before, TAP, 'both', { uturnFrom: arrival })
        expect(out.notice, `${away} m`).toBeNull()
        const start = out.added[0]
        expect(haversine(START, start), `${away} m`).toBeCloseTo(away, 0)
        expect(out.added[out.added.length - 1]).toEqual(END)
      }
    })

    it('looks as far as 30 m for it, and no farther', async () => {
      vi.stubGlobal('fetch', service([oneWay, { away: UTURN_SNAP_M, heading: back }]))
      expect((await extendAlongRoads(before, TAP, 'both', { uturnFrom: arrival })).notice).toBeNull()
      vi.stubGlobal('fetch', service([oneWay, { away: UTURN_SNAP_M + 1, heading: back }]))
      expect((await extendAlongRoads(before, TAP, 'both', { uturnFrom: arrival })).notice).toBe(UTURN_NOTICE)
    })

    it('still turns back along a two-way street, and finds nothing when the street only runs one way and no other is near', async () => {
      vi.stubGlobal('fetch', service([{ away: 0, heading: back }]))
      const out = await extendAlongRoads(before, TAP, 'both', { uturnFrom: arrival })
      expect(out.notice).toBeNull()
      expect(out.added).toEqual(roadPoints(answer()).slice(1))
      vi.stubGlobal('fetch', service([oneWay]))
      expect((await extendAlongRoads(before, TAP, 'both', { uturnFrom: arrival })).notice).toBe(UTURN_NOTICE)
    })

    it('does not narrow an ordinary tap, which may still start on a street up to 50 m away', async () => {
      const f = service([{ away: 47, heading: arrival }])
      vi.stubGlobal('fetch', f)
      const out = await extendAlongRoads(before, TAP, 'both', {})
      expect(String(f.mock.calls[0][0])).toContain('radiuses=50;50')
      expect(out.notice).toBeNull()
      expect(haversine(START, out.added[0])).toBeCloseTo(47, 0)
    })
  })
})

describe('the way a route arrived', () => {
  const origin: Pt = { lat: 51.5, lng: -0.12 }
  /** A place this many metres north and east of another. */
  const from = (p: Pt, north: number, east: number): Pt => ({
    lat: p.lat + north / 111_320,
    lng: p.lng + east / (111_320 * Math.cos((p.lat * Math.PI) / 180)),
  })
  const near = (got: number | null, want: number, within = 0.5) => {
    expect(got).not.toBeNull()
    expect(angleBetween(got!, want)).toBeLessThanOrEqual(within)
  }

  it('is the compass bearing of the last stretch', () => {
    near(arrivalBearing([origin, from(origin, 50, 0)]), 0)
    near(arrivalBearing([origin, from(origin, 0, 50)]), 90)
    near(arrivalBearing([origin, from(origin, -50, 0)]), 180)
    near(arrivalBearing([origin, from(origin, 0, -50)]), 270)
    near(arrivalBearing([origin, from(origin, 50, 50)]), 45)
  })

  it('goes by only the last stretch, not the whole route', () => {
    const east = from(origin, 0, 100)
    near(arrivalBearing([origin, east, from(east, 80, 0)]), 0)
    const long = [origin, from(origin, 100, 0), from(origin, 100, 100), from(origin, 0, 100)]
    near(arrivalBearing(long), 180)
  })

  it('is the way back after a route doubles back on itself', () => {
    near(arrivalBearing([origin, from(origin, 0, 100), from(origin, 0, 40)]), 270)
  })

  it('looks past a last piece that is the same place as the end', () => {
    const b = from(origin, 0, 30)
    // 0.3 m north of b: on its own that piece points north, which says nothing about how the route arrived.
    near(arrivalBearing([origin, b, from(b, 0.3, 0)]), 90, 2)
    near(arrivalBearing([origin, b, b]), 90)
    near(arrivalBearing([origin, b, b, b]), 90)
  })

  it('uses a piece as short as a metre or two', () => {
    const b = from(origin, 0, 30)
    near(arrivalBearing([origin, b, from(b, 1.5, 0)]), 0, 1)
  })

  it('is null for a route with no way it arrived', () => {
    expect(arrivalBearing([])).toBeNull()
    expect(arrivalBearing([origin])).toBeNull()
    expect(arrivalBearing([origin, origin])).toBeNull()
    expect(arrivalBearing([origin, { ...origin }, from(origin, 0.2, 0.2)])).toBeNull()
  })

  it('does not change the points it is given', () => {
    const points = [origin, from(origin, 0, 50)]
    const copy = structuredClone(points)
    arrivalBearing(points)
    expect(points).toEqual(copy)
  })
})

describe('when a U-turn can be asked for, and when it is on', () => {
  const a: Pt = { lat: 51.5, lng: -0.12 }
  const b: Pt = { lat: 51.5, lng: -0.1195 }
  const c: Pt = { lat: 51.5005, lng: -0.1195 }
  const route = [a, b]

  it('can be asked for while following roads, once the route has a direction', () => {
    expect(uturnAvailable(route, true)).toBe(true)
    expect(uturnAvailable([a, b, c], true)).toBe(true)
  })

  it('cannot be asked for when roads are not being followed', () => {
    expect(uturnAvailable(route, false)).toBe(false)
  })

  it('cannot be asked for before the route has a direction', () => {
    expect(uturnAvailable([], true)).toBe(false)
    expect(uturnAvailable([a], true)).toBe(false)
    expect(uturnAvailable([a, { ...a }], true)).toBe(false)
  })

  it('is on at the end of the route it was switched on at', () => {
    expect(uturnIsOn(b, route, true)).toBe(true)
    // The same place is the same end, whichever object says so.
    expect(uturnIsOn({ ...b }, route, true)).toBe(true)
  })

  it('is off when it was never switched on', () => {
    expect(uturnIsOn(null, route, true)).toBe(false)
  })

  it('goes off once the route ends anywhere else: the tap it was for added, an undo, a point moved or deleted, a clear', () => {
    expect(uturnIsOn(b, [a, b, c], true)).toBe(false)
    expect(uturnIsOn(b, [a], true)).toBe(false)
    expect(uturnIsOn(b, [], true)).toBe(false)
    expect(uturnIsOn(b, [a, { lat: b.lat, lng: b.lng + 1e-6 }], true)).toBe(false)
    expect(uturnIsOn(b, [a, { lat: b.lat + 1e-6, lng: b.lng }], true)).toBe(false)
    expect(uturnIsOn(c, route, true)).toBe(false)
  })

  it('stays on when only the points before the end change', () => {
    expect(uturnIsOn(b, [c, a, b], true)).toBe(true)
  })

  it('goes off when roads are no longer being followed', () => {
    expect(uturnIsOn(b, route, false)).toBe(false)
  })

  it('is off for a route with no direction, even when switched on at its only point', () => {
    expect(uturnIsOn(a, [a], true)).toBe(false)
    expect(uturnIsOn(a, [a, { ...a }], true)).toBe(false)
  })
})

describe('undoing a stretch of road', () => {
  const start: Route = { points: [{ lat: -33.9125, lng: 151.1549 }, START], sideChanges: [{ idx: 0, side: 'both' }], stops: [] }
  const record = ({ added, replaced }: Stretch): Stretch => ({ added, replaced })

  async function tapped(route: Route, side: 'both' | 'left' | 'right' = 'both') {
    mockFetch(json(answer()))
    return extendAlongRoads(route, TAP, side)
  }

  it('takes the whole stretch off in one go, section included', async () => {
    const out = await tapped(start, 'left')
    expect(out.route.points.length).toBeGreaterThan(start.points.length + 3)
    const undone = undoStretch(out.route, [record(out)])!
    expect(undone.route).toEqual(start)
    expect(undone.history).toEqual([])
  })

  it('puts back the loose start point it replaced', async () => {
    const loose: Route = { points: [{ lat: -33.9109, lng: 151.1559 }], sideChanges: [], stops: [] }
    const out = await tapped(loose)
    expect(out.route.points[0]).not.toEqual(loose.points[0])
    expect(undoStretch(out.route, [record(out)])!.route).toEqual(loose)
  })

  it('goes one tap at a time, newest first', async () => {
    const one = await tapped(start)
    mockFetch(json(answer([COORDS[COORDS.length - 1], [151.17, -33.9]])))
    const two = await extendAlongRoads(one.route, { lat: -33.9, lng: 151.17 }, 'both')
    expect(two.added).toHaveLength(1)
    const history = [record(one), record(two)]

    const back1 = undoStretch(two.route, history)!
    expect(back1.route).toEqual(one.route)
    expect(back1.history).toEqual([record(one)])
    const back2 = undoStretch(back1.route, back1.history)!
    expect(back2.route).toEqual(start)
    expect(undoStretch(back2.route, back2.history)).toBeNull()
  })

  it('leaves it to a plain undo once points in the stretch have been edited', async () => {
    const out = await tapped(start)
    const points = out.route.points.slice()
    points[points.length - 2] = { lat: -33.9, lng: 151.1 }
    expect(undoStretch({ ...out.route, points }, [record(out)])).toBeNull()
  })

  it('finds the stretch again once something drawn on top of it has been undone', async () => {
    const out = await tapped(start)
    const withStraightPoint: Route = { ...out.route, points: [...out.route.points, { lat: -33.9, lng: 151.2 }], sideChanges: out.route.sideChanges }
    expect(undoStretch(withStraightPoint, [record(out)])).toBeNull()
    const back = undoStretch(removeLastPoint(withStraightPoint), [record(out)])!
    expect(back.route).toEqual(start)
  })

  it('forgets stretches that are no longer on the route', async () => {
    const one = await tapped(start)
    mockFetch(json(answer([COORDS[COORDS.length - 1], [151.17, -33.9]])))
    const two = await extendAlongRoads(one.route, { lat: -33.9, lng: 151.17 }, 'both')
    // The second stretch was taken back by plain undos, so only the first still ends the route.
    const history = [record(one), record(two)]
    const back = undoStretch(one.route, history)!
    expect(back.route).toEqual(start)
    expect(back.history).toEqual([])
  })

  it('has nothing to take back on a route that has no recorded stretch', () => {
    expect(undoStretch(start, [])).toBeNull()
  })
})

describe('where the nearest street is asked', () => {
  it('is the same server as the routes, with the service swapped', () => {
    expect(nearestEndpoint('https://routing.openstreetmap.de/routed-car/route/v1/driving')).toBe(
      'https://routing.openstreetmap.de/routed-car/nearest/v1/driving',
    )
    expect(nearestEndpoint('https://osrm.example.com/route/v1/driving')).toBe('https://osrm.example.com/nearest/v1/driving')
    expect(NEAREST).toBe('https://routing.openstreetmap.de/routed-car/nearest/v1/driving')
    expect(NEAREST).toBe(nearestEndpoint(ENDPOINT))
  })

  it('is nowhere when the server given is not a routing address, rather than the route address under another name', () => {
    expect(nearestEndpoint('https://osrm.example.com/driving')).toBeNull()
    expect(nearestEndpoint('https://osrm.example.com/route/v1')).toBeNull()
    expect(nearestEndpoint('')).toBeNull()
  })

  it('swaps only the service, not a part of the address that happens to say the same', () => {
    expect(nearestEndpoint('https://host/route/v1/driving')).not.toContain('/route/')
    expect(nearestEndpoint('https://host/a/route/v1/b/route/v1')).toBe('https://host/a/nearest/v1/b/route/v1')
  })
})

describe('the status of a failed request', () => {
  it('is kept on the error when the service answered', async () => {
    mockFetch(json({ message: 'slow down' }, 429))
    try {
      await fetchRoad(START, TAP)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(RoadError)
      expect((e as RoadError).kind).toBe('service')
      expect((e as RoadError).status).toBe(429)
    }
  })

  it('is kept when the answer was not JSON at all', async () => {
    mockFetch(new Response('<html>Bad gateway</html>', { status: 502 }))
    try {
      await fetchRoad(START, TAP)
      expect.unreachable()
    } catch (e) {
      expect((e as RoadError).status).toBe(502)
    }
  })

  it('is not there when nothing came back', async () => {
    mockFetch(new TypeError('Load failed'))
    try {
      await fetchRoad(START, TAP)
      expect.unreachable()
    } catch (e) {
      expect((e as RoadError).kind).toBe('offline')
      expect((e as RoadError).status).toBeUndefined()
    }
    expect(new RoadError('timeout').status).toBeUndefined()
    expect(new RoadError('service', 'odd', 503).status).toBe(503)
  })
})

describe('getJson', () => {
  it('makes one plain request and gives back the status and the body, whatever the status', async () => {
    const f = mockFetch(json({ code: 'Ok' }), json({ code: 'NoSegment' }, 400), json({ message: 'busy' }, 429))
    expect(await getJson('https://example.test/a')).toEqual({ ok: true, status: 200, json: { code: 'Ok' } })
    expect(await getJson('https://example.test/b')).toEqual({ ok: false, status: 400, json: { code: 'NoSegment' } })
    expect(await getJson('https://example.test/c')).toEqual({ ok: false, status: 429, json: { message: 'busy' } })
    expect(f.mock.calls.map((c) => c[0])).toEqual(['https://example.test/a', 'https://example.test/b', 'https://example.test/c'])
    // Custom headers would make the browser ask permission first; a bare GET does not.
    for (const call of f.mock.calls) expect(Object.keys(call[1] ?? {})).toEqual(['signal'])
  })

  it('fails the same ways the road lookups do', async () => {
    mockFetch(new TypeError('Load failed'))
    expect(await failure(getJson('https://example.test/'))).toBe('offline')
    mockFetch(new Response('<html>Hotel wifi login</html>', { status: 200 }))
    expect(await failure(getJson('https://example.test/'))).toBe('service')
    const ctl = new AbortController()
    ctl.abort()
    const f = mockFetch(json({}))
    expect(await failure(getJson('https://example.test/', { signal: ctl.signal }))).toBe('cancelled')
    expect(f).not.toHaveBeenCalled()
    vi.stubGlobal('navigator', { onLine: false })
    expect(await failure(getJson('https://example.test/'))).toBe('offline')
    expect(f).not.toHaveBeenCalled()
  })

  it('gives up on a slow service after the timeout it is given', async () => {
    vi.useFakeTimers()
    mockFetch(silent)
    const outcome = failure(getJson('https://example.test/', { timeoutMs: 800 }))
    await vi.advanceTimersByTimeAsync(799)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe('timeout')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the gap between requests, with more than one thing asking', () => {
  /** A fresh copy of the module with the real gap and a fake clock, so what earlier tests did to the limiter doesn't matter. */
  async function fresh() {
    vi.resetModules()
    const mod = await import('./roads')
    vi.useFakeTimers()
    mod.rate.minGapMs = 1100
    return mod
  }

  /** Lets everything that can happen without a timer happen. */
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('lets the first request go at once, without even a timer', async () => {
    const { spaced: slot } = await fresh()
    let went = false
    void slot().then(() => (went = true))
    await flush()
    expect(went).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps requests that are asked for together a gap apart, in the order they asked', async () => {
    const { spaced: slot } = await fresh()
    const went: string[] = []
    for (const name of ['a', 'b', 'c']) void slot().then(() => went.push(name))
    await vi.advanceTimersByTimeAsync(0)
    expect(went).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(1099)
    expect(went).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(1)
    expect(went).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(1099)
    expect(went).toEqual(['a', 'b'])
    await vi.advanceTimersByTimeAsync(1)
    expect(went).toEqual(['a', 'b', 'c'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits only for what is left of the gap', async () => {
    const { spaced: slot } = await fresh()
    await slot()
    await vi.advanceTimersByTimeAsync(600)
    let went = false
    void slot().then(() => (went = true))
    await vi.advanceTimersByTimeAsync(499)
    expect(went).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(went).toBe(true)
  })

  it('does not wait at all when the last request was exactly long enough ago, or longer', async () => {
    const { spaced: slot } = await fresh()
    await slot()
    for (const quiet of [1100, 5000]) {
      await vi.advanceTimersByTimeAsync(quiet)
      let went = false
      void slot().then(() => (went = true))
      await flush()
      expect(went).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('lets one in the line give up at once, without costing the ones behind it a gap', async () => {
    const { spaced: slot } = await fresh()
    const went: string[] = []
    const ctl = new AbortController()
    void slot().then(() => went.push('a'))
    const b = slot(ctl.signal).then(
      () => went.push('b'),
      (e) => went.push(`b ${kindOf(e)}`),
    )
    void slot().then(() => went.push('c'))
    await vi.advanceTimersByTimeAsync(500)
    ctl.abort()
    await b
    expect(went).toEqual(['a', 'b cancelled'])
    await vi.advanceTimersByTimeAsync(599)
    expect(went).toEqual(['a', 'b cancelled'])
    // c goes a gap after a, not a gap after the place b had in the line.
    await vi.advanceTimersByTimeAsync(1)
    expect(went).toEqual(['a', 'b cancelled', 'c'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets one that is not yet at the front give up at once, and the others carry on', async () => {
    const { spaced: slot } = await fresh()
    const went: string[] = []
    const ctl = new AbortController()
    void slot().then(() => went.push('a'))
    void slot().then(() => went.push('b'))
    const c = slot(ctl.signal).then(
      () => went.push('c'),
      (e) => went.push(`c ${kindOf(e)}`),
    )
    void slot().then(() => went.push('d'))
    await vi.advanceTimersByTimeAsync(500)
    ctl.abort()
    await c
    // c left while b was still waiting for its turn.
    expect(went).toEqual(['a', 'c cancelled'])
    await vi.advanceTimersByTimeAsync(600)
    expect(went).toEqual(['a', 'c cancelled', 'b'])
    await vi.advanceTimersByTimeAsync(1100)
    expect(went).toEqual(['a', 'c cancelled', 'b', 'd'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves nothing listening to the signal once it has had its turn', async () => {
    const { spaced: slot } = await fresh()
    const ctl = new AbortController()
    // What is listening for the signal to be cancelled right now.
    const live = new Set<unknown>()
    const add = ctl.signal.addEventListener.bind(ctl.signal)
    const remove = ctl.signal.removeEventListener.bind(ctl.signal)
    ctl.signal.addEventListener = (type: string, fn: never, opts?: never) => (live.add(fn), add(type, fn, opts))
    ctl.signal.removeEventListener = (type: string, fn: never, opts?: never) => (live.delete(fn), remove(type, fn, opts))
    await slot(ctl.signal)
    const second = slot(ctl.signal)
    await vi.advanceTimersByTimeAsync(1100)
    await second
    expect(live.size).toBe(0)
  })

  it('gives up at once when cancelled while it is the one waiting out the gap', async () => {
    const { spaced: slot } = await fresh()
    await slot()
    const ctl = new AbortController()
    const waiting = failure(slot(ctl.signal))
    await vi.advanceTimersByTimeAsync(300)
    ctl.abort()
    expect(await waiting).toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)
    // The slot was not taken: the next one waits out the gap from the last real request.
    let went = false
    void slot().then(() => (went = true))
    await vi.advanceTimersByTimeAsync(799)
    expect(went).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(went).toBe(true)
  })

  it('does not wait, or take a slot, when it is cancelled already', async () => {
    const { spaced: slot } = await fresh()
    const ctl = new AbortController()
    ctl.abort()
    expect(await failure(slot(ctl.signal))).toBe('cancelled')
    let went = false
    void slot().then(() => (went = true))
    await flush()
    expect(went).toBe(true)
  })

  it('gives up at once, not when its turn comes, when it is cancelled already and others are waiting', async () => {
    const { spaced: slot } = await fresh()
    void slot()
    void slot()
    const ctl = new AbortController()
    ctl.abort()
    let outcome = 'still waiting'
    void failure(slot(ctl.signal)).then((kind) => (outcome = kind))
    await flush()
    expect(outcome).toBe('cancelled')
  })

  it('keeps a lookup of roads and a lookup of anything else a gap apart when they start together', async () => {
    const mod = await fresh()
    const times: number[] = []
    const f = vi.fn(() => {
      times.push(Date.now())
      return Promise.resolve(json(answer()))
    })
    vi.stubGlobal('fetch', f)
    const start = Date.now()
    const both = Promise.all([mod.fetchRoad(START, TAP), mod.getJson('https://example.test/')])
    await vi.advanceTimersByTimeAsync(2000)
    await both
    expect(times.map((t) => t - start)).toEqual([0, 1100])
  })

  it('never waits longer than the gap, even when the clock has been set back since the last request', async () => {
    const { spaced: slot } = await fresh()
    await slot()
    vi.setSystemTime(Date.now() - 3_600_000)
    let went = false
    void slot().then(() => (went = true))
    await vi.advanceTimersByTimeAsync(1099)
    expect(went).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(went).toBe(true)
  })

  it('still lets a single caller go as often as the gap allows, with the gap taken from the setting', async () => {
    const mod = await fresh()
    mod.rate.minGapMs = 0
    const went: number[] = []
    for (let i = 0; i < 3; i++) void mod.spaced().then(() => went.push(i))
    await vi.advanceTimersByTimeAsync(0)
    expect(went).toEqual([0, 1, 2])
  })
})
