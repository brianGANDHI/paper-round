import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { distanceToPath } from './geo'
import {
  canFollow,
  ENDPOINT,
  extendAlongRoads,
  fetchDrive,
  fetchRoad,
  rate,
  ROAD_NOTICE,
  ROAD_SIMPLIFY_M,
  roadPoints,
  roadSeconds,
  roadUrl,
  TIMEOUT_MS,
  undoStretch,
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
