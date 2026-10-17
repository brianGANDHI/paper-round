import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { haversine } from './geo'
import { rate as geocodeRate, viewboxFor } from './geocode'
import { ENDPOINT, rate as roadRate, roadPoints, type Stretch } from './roads'
import { routeLength } from './routeEdit'
import {
  ADDRESS_SNAP_M,
  FIND_TIMEOUT_MS,
  JOIN_M,
  routeByAddress,
  TransitError,
  transitMessage,
  transitNotice,
  type Stage,
  type TransitFailure,
  type TransitResult,
} from './transit'
import { undoStretch } from './roads'
import type { Pt, Route } from './types'

// Streets in Marrickville, Sydney. A is where a transit starts and B where it ends, about 2.4 km apart by road.
const A: Pt = { lat: -33.91, lng: 151.156 }
const B: Pt = { lat: -33.9, lng: 151.17 }
/** Where the round that is already drawn stops: 72 m from A, so close enough to carry straight on. */
const END: Pt = { lat: -33.9105, lng: 151.1555 }
const route: Route = {
  points: [{ lat: -33.9125, lng: 151.153 }, { lat: -33.9115, lng: 151.1542 }, END],
  sideChanges: [{ idx: 0, side: 'both' }],
  stops: [],
}
const nothing: Route = { points: [], sideChanges: [], stops: [] }

/** A point this many metres north of another. */
const north = (p: Pt, m: number): Pt => ({ lat: p.lat + m / 111320, lng: p.lng })

const NAME_A = '1, Start Street, Marrickville, Sydney, Inner West Council, New South Wales, 2204, Australia'
const NAME_B = '9, End Road, Marrickville, Sydney, Inner West Council, New South Wales, 2204, Australia'

const hit = (p: Pt, name: string, exact = true) => ({
  lat: String(p.lat),
  lon: String(p.lng),
  display_name: name,
  place_rank: exact ? 30 : 26,
  addresstype: exact ? 'house' : 'road',
})

/** What the road service answers for a drive that goes along the latitude, then along the longitude. */
function ell(from: Pt, to: Pt, seconds = 300) {
  const corner = { lat: from.lat, lng: to.lng }
  const coordinates = [from, corner, to].map((p) => [p.lng, p.lat])
  return { code: 'Ok', routes: [{ distance: 2400, duration: seconds, geometry: { type: 'LineString', coordinates } }] }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Reply = Response | Error | ((init?: RequestInit) => Promise<Response>)

/** A server that never answers, but gives up when told to. */
const silent = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
  })

const asReply = (r: Reply, init?: RequestInit): Promise<Response> => {
  if (r instanceof Error) return Promise.reject(r)
  if (typeof r === 'function') return r(init)
  return Promise.resolve(r)
}

/**
 * Stands in for both services. `places` is what the address service says for each thing typed (lower case);
 * `roads` replaces the road service's answers, one request at a time, and after those it draws an L-shaped drive.
 * `calls` lists the requests as they were made.
 */
function services(places: Record<string, unknown[] | Reply>, roads: Reply[] = []) {
  const calls: string[] = []
  const urls: URL[] = []
  const fn = vi.fn((input: string, init?: RequestInit) => {
    if (input.startsWith(ENDPOINT)) {
      const m = /driving\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)\?/.exec(input)
      if (!m) throw new Error(`unexpected road request ${input}`)
      const from = { lat: Number(m[2]), lng: Number(m[1]) }
      const to = { lat: Number(m[4]), lng: Number(m[3]) }
      calls.push('road')
      urls.push(new URL(input))
      return asReply(roads.shift() ?? json(ell(from, to)), init)
    }
    const url = new URL(input)
    const q = url.searchParams.get('q') ?? ''
    calls.push(`search ${q}`)
    urls.push(url)
    const said = places[q.toLowerCase()] ?? []
    return asReply(Array.isArray(said) ? json(said) : said, init)
  })
  vi.stubGlobal('fetch', fn)
  return { fn, calls, urls }
}

/** How a route by address failed: the kind of its TransitError, or 'it worked'. */
const failure = async (p: Promise<unknown>): Promise<TransitFailure | 'it worked' | 'not a TransitError'> => {
  try {
    await p
    return 'it worked'
  } catch (e) {
    return e instanceof TransitError ? e.kind : 'not a TransitError'
  }
}

const both = { 'start street': [hit(A, NAME_A)], 'end road': [hit(B, NAME_B)] }
const request = { from: 'Start Street', to: 'End Road' }

beforeEach(() => {
  geocodeRate.minGapMs = 0
  roadRate.minGapMs = 0
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a route between two typed addresses', () => {
  it('finds both addresses, then asks once for the fastest road from the first to the second', async () => {
    const s = services(both)
    const r = await routeByAddress(nothing, request)
    expect(s.calls).toEqual(['search Start Street', 'search End Road', 'road'])
    const asked = s.urls[2].pathname.split('/driving/')[1].split(';')
    expect(asked[0]).toBe(`${A.lng.toFixed(6)},${A.lat.toFixed(6)}`)
    expect(asked[1]).toBe(`${B.lng.toFixed(6)},${B.lat.toFixed(6)}`)
    expect(r.from?.name).toBe(NAME_A)
    expect(r.to.name).toBe(NAME_B)
  })

  it('draws the road it is given, as Transit all the way', async () => {
    services(both)
    const r = await routeByAddress(nothing, request)
    expect(r.route.points).toEqual(roadPoints(ell(A, B)))
    expect(r.route.sideChanges).toEqual([{ idx: 0, side: 'transit' }])
    expect(r.added).toEqual(r.route.points)
    expect(r.linked).toBe(false)
  })

  it('says how long the drive is and how long it takes', async () => {
    services(both, [json(ell(A, B, 437))])
    const r = await routeByAddress(nothing, request)
    expect(r.meters).toBeCloseTo(routeLength(r.route.points), 5)
    expect(r.meters).toBeGreaterThan(2000)
    expect(r.seconds).toBe(437)
  })

  it('looks for a street within 250 m of each address, since a house can sit well back from its road', async () => {
    const s = services(both)
    await routeByAddress(nothing, request)
    expect(ADDRESS_SNAP_M).toBe(250)
    expect(s.urls[2].searchParams.get('radiuses')).toBe('250;250')
  })

  it('looks for the addresses near the route, or near the start when there is no route yet', async () => {
    const s = services(both)
    await routeByAddress(route, request)
    expect(s.urls[0].searchParams.get('viewbox')).toBe(viewboxFor(route.points))
    expect(s.urls[1].searchParams.get('viewbox')).toBe(viewboxFor(route.points))

    const t = services(both)
    await routeByAddress(nothing, request)
    // Nothing to go on for the start, so Australia; then the end is looked for near where the start was found.
    expect(t.urls[1].searchParams.get('viewbox')).toBe(viewboxFor([A]))
    expect(t.urls[0].searchParams.get('viewbox')).not.toBe(t.urls[1].searchParams.get('viewbox'))
  })

  it('takes the best match only', async () => {
    const s = services(both)
    await routeByAddress(nothing, request)
    expect(s.urls[0].searchParams.get('limit')).toBe('1')
    expect(s.urls[1].searchParams.get('limit')).toBe('1')
  })

  it('looks up what was typed without the spaces round it', async () => {
    const s = services(both)
    await routeByAddress(nothing, { from: '  Start Street ', to: ' End Road  ' })
    expect(s.calls.slice(0, 2)).toEqual(['search Start Street', 'search End Road'])
  })

  it('leaves the route it was given untouched', async () => {
    services(both)
    const before = structuredClone(route)
    const r = await routeByAddress(route, request)
    expect(route).toEqual(before)
    expect(r.route).not.toBe(route)
  })
})

describe('added to a route that is already drawn', () => {
  it('starts a new Transit section after it and leaves the rest as it was', async () => {
    services(both)
    const r = await routeByAddress(route, request)
    expect(r.route.points.slice(0, route.points.length)).toEqual(route.points)
    expect(r.route.points.length).toBeGreaterThan(route.points.length + 1)
    expect(r.added).toEqual(r.route.points.slice(route.points.length))
    expect(r.route.sideChanges).toEqual([
      { idx: 0, side: 'both' },
      { idx: 2, side: 'transit' },
    ])
  })

  it('carries straight on when the start is within a few steps of where the route ends', async () => {
    const s = services(both)
    expect(haversine(END, A)).toBeLessThan(JOIN_M)
    const r = await routeByAddress(route, request)
    expect(s.calls).toEqual(['search Start Street', 'search End Road', 'road'])
    expect(r.linked).toBe(false)
    expect(r.route.points[route.points.length]).toEqual(A)
  })

  it('carries on from the end of the route when no start is typed, and looks only for the end', async () => {
    const s = services(both)
    const r = await routeByAddress(route, { from: null, to: 'End Road' })
    expect(s.calls).toEqual(['search End Road', 'road'])
    const asked = s.urls[1].pathname.split('/driving/')[1].split(';')
    expect(asked[0]).toBe(`${END.lng.toFixed(6)},${END.lat.toFixed(6)}`)
    expect(r.from).toBeNull()
    expect(r.linked).toBe(false)
    expect(r.route.points[r.route.points.length - 1]).toEqual(B)
    // The road starts where the route ends, so that point isn't there twice.
    expect(r.route.points.slice(0, route.points.length)).toEqual(route.points)
    expect(r.route.points[route.points.length - 1]).toEqual(END)
  })

  it('first drives to a start that is well away from where the route ends, as part of the same transit', async () => {
    const far = north(END, 1000)
    const s = services(
      { 'start street': [hit(far, NAME_A)], 'end road': [hit(B, NAME_B)] },
      [json(ell(END, far, 120)), json(ell(far, B, 300))],
    )
    const r = await routeByAddress(route, request)
    expect(s.calls).toEqual(['search Start Street', 'search End Road', 'road', 'road'])
    const link = s.urls[2].pathname.split('/driving/')[1].split(';')
    const main = s.urls[3].pathname.split('/driving/')[1].split(';')
    expect(link[0]).toBe(`${END.lng.toFixed(6)},${END.lat.toFixed(6)}`)
    expect(link[1]).toBe(`${far.lng.toFixed(6)},${far.lat.toFixed(6)}`)
    expect(main[0]).toBe(`${far.lng.toFixed(6)},${far.lat.toFixed(6)}`)
    expect(main[1]).toBe(`${B.lng.toFixed(6)},${B.lat.toFixed(6)}`)

    expect(r.linked).toBe(true)
    // The way there, then the way on from it, with the start only once.
    expect(r.added).toEqual([...roadPoints(ell(END, far)).slice(1), ...roadPoints(ell(far, B)).slice(1)])
    expect(r.seconds).toBe(420)
    expect(r.route.sideChanges).toEqual([
      { idx: 0, side: 'both' },
      { idx: 2, side: 'transit' },
    ])
  })

  it('goes by road to a start a little over 100 m away, and straight on to one a little under', async () => {
    const near = north(END, JOIN_M - 10)
    const over = north(END, JOIN_M + 10)
    expect(haversine(END, near)).toBeLessThan(JOIN_M)
    expect(haversine(END, over)).toBeGreaterThan(JOIN_M)

    const a = services({ 'start street': [hit(near, NAME_A)], 'end road': [hit(B, NAME_B)] })
    expect((await routeByAddress(route, request)).linked).toBe(false)
    expect(a.calls.filter((c) => c === 'road')).toHaveLength(1)

    const b = services({ 'start street': [hit(over, NAME_A)], 'end road': [hit(B, NAME_B)] })
    expect((await routeByAddress(route, request)).linked).toBe(true)
    expect(b.calls.filter((c) => c === 'road')).toHaveLength(2)
  })

  it('has no way to link anything on a route that is not drawn yet, so a typed start is where it begins', async () => {
    const s = services(both)
    const r = await routeByAddress(nothing, request)
    expect(s.calls.filter((c) => c === 'road')).toHaveLength(1)
    expect(r.route.points[0]).toEqual(A)
  })

  it('works from a route that is a single point', async () => {
    services(both)
    const lone: Route = { points: [END], sideChanges: [], stops: [] }
    const r = await routeByAddress(lone, request)
    expect(r.route.points[0]).toEqual(END)
    expect(r.route.sideChanges).toEqual([{ idx: 0, side: 'transit' }])
  })

  it('can be taken back whole with Undo', async () => {
    services(both)
    const r = await routeByAddress(route, request)
    const stretch: Stretch = { added: r.added, replaced: null }
    const undone = undoStretch(r.route, [stretch])!
    expect(undone.route).toEqual({ ...route, sideChanges: [{ idx: 0, side: 'both' }] })
    expect(undone.history).toEqual([])
  })
})

describe('when it cannot be done', () => {
  it('names the address that was not found, and asks for nothing more', async () => {
    const s = services({ 'end road': [hit(B, NAME_B)] })
    const e = await routeByAddress(route, request).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(TransitError)
    expect(e).toMatchObject({ kind: 'not-found', which: 'from', query: 'Start Street' })
    expect(s.calls).toEqual(['search Start Street'])
  })

  it('names an end that was not found, before any road is asked for', async () => {
    const s = services({ 'start street': [hit(A, NAME_A)] })
    const e = await routeByAddress(route, request).catch((x: unknown) => x)
    expect(e).toMatchObject({ kind: 'not-found', which: 'to', query: 'End Road' })
    expect(s.calls).toEqual(['search Start Street', 'search End Road'])
  })

  it('needs something typed for each address', async () => {
    const s = services(both)
    for (const [r, req, which] of [
      [route, { from: '', to: 'End Road' }, 'from'],
      [route, { from: '   ', to: 'End Road' }, 'from'],
      [route, { from: 'Start Street', to: '' }, 'to'],
      [route, { from: null, to: '  ' }, 'to'],
      [nothing, { from: null, to: 'End Road' }, 'from'],
    ] as const) {
      const e = await routeByAddress(r, req).catch((x: unknown) => x)
      expect(e).toMatchObject({ kind: 'blank', which })
    }
    expect(s.fn).not.toHaveBeenCalled()
  })

  it('will not make a route between two addresses at the same place', async () => {
    const s = services({ 'start street': [hit(A, NAME_A)], 'end road': [hit(north(A, 10), NAME_B)] })
    expect(await failure(routeByAddress(nothing, request))).toBe('same-place')
    expect(s.calls).toEqual(['search Start Street', 'search End Road'])
  })

  it('will not make a route when both addresses turn out to be on the same bit of road', async () => {
    services(both, [json(ell(A, A))])
    expect(await failure(routeByAddress(nothing, request))).toBe('same-place')
  })

  it('says when there is no road between the places, or none near one of them', async () => {
    for (const code of ['NoRoute', 'NoSegment']) {
      services(both, [json({ code, message: 'nope' }, 400)])
      expect(await failure(routeByAddress(nothing, request))).toBe('no-road')
    }
  })

  it('says when the road service is down, or the address service is', async () => {
    services(both, [json({ message: 'down' }, 503)])
    expect(await failure(routeByAddress(nothing, request))).toBe('service')
    services({ 'start street': json({ error: 'slow down' }, 429) })
    expect(await failure(routeByAddress(nothing, request))).toBe('service')
    services({ 'start street': new Response('<html>Bad gateway</html>', { status: 200 }) })
    expect(await failure(routeByAddress(nothing, request))).toBe('service')
  })

  it('says when the request never gets through to either service', async () => {
    services({ 'start street': new TypeError('Load failed') })
    expect(await failure(routeByAddress(nothing, request))).toBe('offline')
    services(both, [new TypeError('Load failed')])
    expect(await failure(routeByAddress(nothing, request))).toBe('offline')
  })

  it('does not even try when the phone says it has no connection', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const s = services(both)
    expect(await failure(routeByAddress(nothing, request))).toBe('offline')
    expect(s.fn).not.toHaveBeenCalled()
  })

  it('gives up on a slow address service, and says so', async () => {
    vi.useFakeTimers()
    const s = services({ 'start street': silent })
    const outcome = failure(routeByAddress(nothing, request))
    await vi.advanceTimersByTimeAsync(FIND_TIMEOUT_MS - 1)
    expect(s.fn.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe('timeout')
    expect(s.fn.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up on a slow road service, and says so', async () => {
    vi.useFakeTimers()
    services(both, [silent])
    const outcome = failure(routeByAddress(nothing, request))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await outcome).toBe('timeout')
  })

  it('stops when cancelled, wherever it has got to', async () => {
    for (const [places, roads] of [
      [{ 'start street': silent }, []],
      [{ 'start street': [hit(A, NAME_A)], 'end road': silent }, []],
      [both, [silent]],
    ] as [Record<string, unknown[] | Reply>, Reply[]][]) {
      const s = services(places, roads)
      const ctl = new AbortController()
      const outcome = failure(routeByAddress(nothing, request, { signal: ctl.signal }))
      // Let the requests that are going to be made go out.
      await new Promise((resolve) => setTimeout(resolve, 20))
      ctl.abort()
      expect(await outcome).toBe('cancelled')
      expect(s.calls.length).toBeGreaterThan(0)
    }
  })

  it('does nothing when it is already cancelled', async () => {
    const s = services(both)
    const ctl = new AbortController()
    ctl.abort()
    expect(await failure(routeByAddress(nothing, request, { signal: ctl.signal }))).toBe('cancelled')
    expect(s.fn).not.toHaveBeenCalled()
  })

  it('leaves no timer running afterwards, whether it worked or not', async () => {
    vi.useFakeTimers()
    services(both)
    await routeByAddress(nothing, request)
    expect(vi.getTimerCount()).toBe(0)
    services({})
    await failure(routeByAddress(nothing, request))
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('progress', () => {
  const stages = async (r: Route, req: { from: string | null; to: string }) => {
    const seen: Stage[] = []
    await routeByAddress(r, req, { onStage: (s) => seen.push(s) })
    return seen
  }

  it('goes through finding the start, the end, then the road', async () => {
    services(both)
    expect(await stages(nothing, request)).toEqual(['start', 'end', 'road'])
  })

  it('adds the way to the start when there is one', async () => {
    services({ 'start street': [hit(north(END, 1000), NAME_A)], 'end road': [hit(B, NAME_B)] })
    expect(await stages(route, request)).toEqual(['start', 'end', 'link', 'road'])
  })

  it('leaves out finding the start when it is the end of the route', async () => {
    services(both)
    expect(await stages(route, { from: null, to: 'End Road' })).toEqual(['end', 'road'])
  })
})

describe('what it says', () => {
  const kinds: TransitFailure[] = ['blank', 'not-found', 'same-place', 'offline', 'timeout', 'service', 'no-road', 'cancelled']

  it('has a message for every way it can fail, and says nothing for a cancel', () => {
    for (const kind of kinds) {
      const text = transitMessage(new TransitError(kind, 'to', 'x'))
      if (kind === 'cancelled') expect(text).toBe('')
      else expect(text.length).toBeGreaterThan(15)
    }
  })

  it('quotes what was typed when it was not found, shortened if it is long', () => {
    expect(transitMessage(new TransitError('not-found', 'to', '9 End Road'))).toContain('"9 End Road"')
    const long = transitMessage(new TransitError('not-found', 'to', 'x'.repeat(200)))
    expect(long.length).toBeLessThan(120)
    expect(long).toContain('…')
  })

  it('tells a missing start from a missing end', () => {
    expect(transitMessage(new TransitError('blank', 'from'))).toMatch(/starts/)
    expect(transitMessage(new TransitError('blank', 'to'))).toMatch(/ends/)
  })

  const done = async (r: Route, req: { from: string | null; to: string }, roads?: Reply[]): Promise<TransitResult> => {
    services(both, roads)
    return routeByAddress(r, req)
  }

  it('says where it goes from and to, how far, how long, and that Undo takes it back', async () => {
    const text = transitNotice(await done(nothing, request, [json(ell(A, B, 437))]))
    expect(text).toContain('Added transit from 1 Start Street, Marrickville, Sydney to 9 End Road, Marrickville, Sydney')
    expect(text).toMatch(/\d\.\d km, about 7 min\./)
    expect(text.endsWith('Undo takes it back.')).toBe(true)
    expect(text).not.toContain('approximate')
  })

  it('says it started from the end of the route when it did', async () => {
    const text = transitNotice(await done(route, { from: null, to: 'End Road' }))
    expect(text).toContain('from the end of your route to 9 End Road')
  })

  it('leaves out the time when the road service did not give one', async () => {
    const noTime = ell(A, B)
    delete (noTime.routes[0] as { duration?: number }).duration
    const text = transitNotice(await done(nothing, request, [json(noTime)]))
    expect(text).toMatch(/km\./)
    expect(text).not.toContain('about')
  })

  it('says when a start had to be driven to first', async () => {
    services({ 'start street': [hit(north(END, 1000), NAME_A)], 'end road': [hit(B, NAME_B)] })
    const text = transitNotice(await routeByAddress(route, request))
    expect(text).toContain('It first drives from the end of your route to the start.')
  })

  it('warns when only a street or area was found, so a wrong position is not a surprise', async () => {
    services({ 'start street': [hit(A, NAME_A, false)], 'end road': [hit(B, NAME_B)] })
    const startOnly = transitNotice(await routeByAddress(nothing, request))
    expect(startOnly).toContain('Only the street or area was found for the start, so its position is approximate.')
    services({ 'start street': [hit(A, NAME_A)], 'end road': [hit(B, NAME_B, false)] })
    expect(transitNotice(await routeByAddress(nothing, request))).toContain('Only the street or area was found for the end, so its position')
    services({ 'start street': [hit(A, NAME_A, false)], 'end road': [hit(B, NAME_B, false)] })
    expect(transitNotice(await routeByAddress(nothing, request))).toContain('Only the street or area was found for the start and the end, so their positions are approximate')
  })
})
