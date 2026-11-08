import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { haversine } from '../geo'
import { ANSWER_TIMEOUT_MS, fetchMap, MAP_MARGIN_M, OSM_NOTICE, OsmError, OVERPASS_URLS, overpassQuery, overpassUrls, readAnswer, ROUND_WAITS_MS, routeBox, TOTAL_TIMEOUT_MS, type MapOptions } from './osmFetch'
import { gridWays, osmOf, place, turnRule, WAY } from './testNetwork'
import type { ProgressInfo } from './types'

/** Stands in for fetch: each call takes the next reply, and the last reply goes on for ever. A reply can be a status, a body, or something to throw. */
type Reply = number | string | object | Error | (() => Promise<Response>)

function fakeFetch(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]
    if (typeof reply === 'function') return reply()
    if (reply instanceof Error) throw reply
    if (typeof reply === 'number') return new Response('<html>busy</html>', { status: reply })
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status: 200 })
  })
  return { fetchFn: fn as unknown as typeof fetch, calls }
}

const ROUTE = [place([0, 0]), place([3, 2])]
const MAP = osmOf(gridWays(), [], [turnRule(50, 'no_left_turn', WAY.ash, [1, 0], WAY.fig)])
const offlineError = () => new TypeError('Load failed')
const pause = vi.fn(async (_ms: number) => {})
const options = (fetchFn: typeof fetch, extra: MapOptions = {}): MapOptions => ({ fetchFn, pause, urls: ['https://one.test/i', 'https://two.test/i'], ...extra })

async function kindOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
    return 'fine'
  } catch (e) {
    return e instanceof OsmError ? e.kind : `thrown: ${String(e)}`
  }
}

beforeEach(() => pause.mockClear())
afterEach(() => vi.unstubAllGlobals())

describe('where to ask', () => {
  it('asks the two main hosts, then a server apart from them, then the rest, all at the same path', () => {
    expect(OVERPASS_URLS).toEqual([
      'https://lz4.overpass-api.de/api/interpreter',
      'https://z.overpass-api.de/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.openstreetmap.fr/api/interpreter',
    ])
  })

  it('asks only the server given when building, as VITE_ROUTING_URL does', () => {
    expect(overpassUrls('https://my.test/api/interpreter/')).toEqual(['https://my.test/api/interpreter'])
    expect(overpassUrls('')).toHaveLength(5)
    expect(overpassUrls(undefined)).toHaveLength(5)
  })
})

describe('the question', () => {
  it('reaches a kilometre beyond the route on every side', () => {
    const points = [{ lat: -30, lng: 150 }, { lat: -30.1, lng: 150.2 }]
    const box = routeBox(points)!
    expect(haversine({ lat: box.north, lng: 150 }, { lat: -30, lng: 150 })).toBeCloseTo(MAP_MARGIN_M, 0)
    expect(haversine({ lat: -30.1, lng: 150 }, { lat: box.south, lng: 150 })).toBeCloseTo(MAP_MARGIN_M, 0)
    // Measured at the edge of the box furthest from the equator, where a degree of longitude is shortest.
    expect(haversine({ lat: box.south, lng: 150.2 }, { lat: box.south, lng: box.east })).toBeCloseTo(MAP_MARGIN_M, 0)
    expect(haversine({ lat: box.south, lng: box.west }, { lat: box.south, lng: 150 })).toBeCloseTo(MAP_MARGIN_M, 0)
    expect(routeBox([])).toBeNull()
  })

  it('asks for the ways of every road class, their nodes and the turn rules on them', () => {
    const query = overpassQuery({ south: -30.5, west: 150.25, north: -30, east: 150.75 })
    expect(query).toContain('[out:json]')
    expect(query).toContain('(-30.50000,150.25000,-30.00000,150.75000)')
    for (const road of ['motorway', 'trunk_link', 'tertiary', 'residential', 'living_street', 'service', 'road', 'track']) expect(query).toMatch(new RegExp(`[(|]${road}[|)]`))
    expect(query).toContain('node(w.w)')
    expect(query).toContain('rel(bw.w)["type"="restriction"]')
    expect(query.endsWith('out body;')).toBe(true)
  })

  it('tells the server it has less time than the phone will wait, with room left for a slow good answer', () => {
    expect(overpassQuery({ south: -30.5, west: 150.25, north: -30, east: 150.75 })).toContain('[timeout:30]')
    expect(ANSWER_TIMEOUT_MS).toBe(50_000)
    expect(TOTAL_TIMEOUT_MS).toBe(180_000)
  })

  it('goes as a form with the query in it, and says nothing about the driver', async () => {
    const { fetchFn, calls } = fakeFetch(MAP)
    await fetchMap(ROUTE, options(fetchFn))
    const [{ url, init }] = calls
    expect(url).toBe('https://one.test/i')
    expect(init.method).toBe('POST')
    expect(init.headers).toBeUndefined()
    const body = init.body as URLSearchParams
    expect([...body.keys()]).toEqual(['data'])
    expect(`${url} ${String(body)}`).not.toMatch(/%40|@/)
  })
})

describe('an answer', () => {
  it('gives back the map, with nodes, ways and rules together', async () => {
    const { fetchFn, calls } = fakeFetch({ version: 0.6, generator: 'Overpass', ...MAP })
    const map = await fetchMap(ROUTE, options(fetchFn))
    expect(calls).toHaveLength(1)
    expect(map.elements).toEqual(MAP.elements)
  })

  it('keeps only what the engine reads', () => {
    const { elements } = readAnswer(JSON.stringify({ elements: [
      { type: 'node', id: 1, lat: -30, lon: 150, tags: { barrier: 'gate', layer: 2 }, extra: 'x' },
      { type: 'node', id: 2, lat: -30, lon: 150.1 },
      { type: 'way', id: 3, nodes: [1, 2], tags: {} },
      { type: 'count', id: 0, tags: { total: '3' } },
    ] }))
    expect(elements).toEqual([
      { type: 'node', id: 1, lat: -30, lon: 150, tags: { barrier: 'gate' } },
      { type: 'node', id: 2, lat: -30, lon: 150.1 },
      { type: 'way', id: 3, nodes: [1, 2] },
    ])
  })

  it.each([
    ['text that is not JSON', 'Dispatcher_Client::request_read_and_idx::timeout'],
    ['JSON of another shape', '{"hello":1}'],
    ['a list', '[1,2]'],
    ['a node with no place', '{"elements":[{"type":"node","id":1}]}'],
    ['a node that is not on Earth', '{"elements":[{"type":"node","id":1,"lat":200,"lon":0}]}'],
    ['a way with no nodes listed', '{"elements":[{"type":"way","id":1}]}'],
    ['a rule with a damaged member', '{"elements":[{"type":"relation","id":1,"members":[{"type":"way"}]}]}'],
    ['a way with a node missing, as a damaged answer has', '{"elements":[{"type":"node","id":1,"lat":-30,"lon":150},{"type":"way","id":2,"nodes":[1,9]}]}'],
    ['the remark a server out of time adds', JSON.stringify({ ...MAP, remark: 'runtime error: Query timed out in "query" at line 1 after 46 seconds.' })],
  ])('is not believed when it is %s, and the next mirror is asked', async (_, bad) => {
    const { fetchFn, calls } = fakeFetch(bad, MAP)
    expect((await fetchMap(ROUTE, options(fetchFn))).elements).toHaveLength(MAP.elements.length)
    expect(calls.map((c) => c.url)).toEqual(['https://one.test/i', 'https://two.test/i'])
  })

  it('is believed with a remark that is no error', () => {
    expect(readAnswer(JSON.stringify({ ...MAP, remark: 'a note about the data' })).elements).toHaveLength(MAP.elements.length)
  })

  it('keeps the date the server gives for its data, all the way to the map handed back', async () => {
    const answer = { ...MAP, osm3s: { timestamp_osm_base: '2026-01-02T03:04:05Z', copyright: 'The data' } }
    expect(readAnswer(JSON.stringify(answer)).date).toBe('2026-01-02T03:04:05Z')
    expect((await fetchMap(ROUTE, options(fakeFetch(answer).fetchFn))).date).toBe('2026-01-02T03:04:05Z')
  })

  it.each([
    ['no word about itself', {}],
    ['no date', { osm3s: { copyright: 'The data' } }],
    ['a date that is not text', { osm3s: { timestamp_osm_base: 20260102 } }],
    ['no date, in a form of its own', { osm3s: 'The data' }],
    ['an empty date', { osm3s: { timestamp_osm_base: '' } }],
  ])('is still a good answer with %s, and no date on it', (_, about) => {
    const map = readAnswer(JSON.stringify({ ...MAP, ...about }))
    expect(map.elements).toHaveLength(MAP.elements.length)
    expect(map).not.toHaveProperty('date')
  })
})

describe('a server that is busy', () => {
  it('goes on to the next mirror after a 429', async () => {
    const { fetchFn, calls } = fakeFetch(429, MAP)
    await fetchMap(ROUTE, options(fetchFn))
    expect(calls.map((c) => c.url)).toEqual(['https://one.test/i', 'https://two.test/i'])
    expect(pause).not.toHaveBeenCalled()
  })

  it('goes on to the next mirror after a 504', async () => {
    const { fetchFn, calls } = fakeFetch(504, MAP)
    await fetchMap(ROUTE, options(fetchFn))
    expect(calls).toHaveLength(2)
  })

  /** What the main hosts were seen to send when full: plain text, not an Overpass answer of any kind. */
  const atCapacity = async () => new Response('The server is currently at capacity. Please try again later.', { status: 502, headers: { 'Content-Type': 'text/plain' } })

  it('goes on to the next mirror after a 502 with plain text in it, and does not wait', async () => {
    const { fetchFn, calls } = fakeFetch(atCapacity, MAP)
    expect((await fetchMap(ROUTE, options(fetchFn))).elements).toHaveLength(MAP.elements.length)
    expect(calls.map((c) => c.url)).toEqual(['https://one.test/i', 'https://two.test/i'])
    expect(pause).not.toHaveBeenCalled()
  })

  it('says it is busy when every mirror gives a 502 with plain text in it, after every round', async () => {
    const { fetchFn, calls } = fakeFetch(atCapacity)
    expect(await kindOf(fetchMap(ROUTE, options(fetchFn)))).toBe('busy')
    expect(calls).toHaveLength((ROUND_WAITS_MS.length + 1) * 2)
  })

  it('tries every mirror, waits, and tries them all again, the wait growing each round', async () => {
    const { fetchFn, calls } = fakeFetch(504, 429, 504, 429, MAP)
    await fetchMap(ROUTE, options(fetchFn))
    expect(calls.map((c) => c.url.split('/')[2])).toEqual(['one.test', 'two.test', 'one.test', 'two.test', 'one.test'])
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual(ROUND_WAITS_MS.slice(0, 2))
    expect(ROUND_WAITS_MS[1]).toBeGreaterThan(ROUND_WAITS_MS[0])
  })

  it('says it is busy after the last round', async () => {
    const { fetchFn, calls } = fakeFetch(429)
    expect(await kindOf(fetchMap(ROUTE, options(fetchFn)))).toBe('busy')
    expect(calls).toHaveLength((ROUND_WAITS_MS.length + 1) * 2)
  })

  it('says it is busy when nothing but bad answers came', async () => {
    const { fetchFn } = fakeFetch('{"elements":[{"type":"node","id":1}]}')
    expect(await kindOf(fetchMap(ROUTE, options(fetchFn)))).toBe('busy')
  })

  it('gives up on an answer that never comes, and asks the next mirror', async () => {
    const never = vi.fn((_url: string, init: RequestInit) => {
      if (never.mock.calls.length === 2) return Promise.resolve(new Response(JSON.stringify(MAP)))
      return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
    })
    expect((await fetchMap(ROUTE, options(never as unknown as typeof fetch, { timeoutMs: 5 }))).elements).toHaveLength(MAP.elements.length)
  })

  it('tells the screen what it is doing', async () => {
    const steps: ProgressInfo[] = []
    const { fetchFn } = fakeFetch(504, 504, MAP)
    await fetchMap(ROUTE, options(fetchFn, { onProgress: (p) => steps.push(p) }))
    expect(steps[0].step).toBe('Getting the map')
    expect(steps.map((s) => s.step)).toContain('The map service is busy, so waiting to try again')
    expect(steps.every((s, i) => s.done >= 0 && s.done < 1 && (i === 0 || s.done >= steps[i - 1].done))).toBe(true)
  })

  it('stops asking when all the time for it has gone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const slow = async () => {
        vi.setSystemTime(Date.now() + TOTAL_TIMEOUT_MS / 2 + 1)
        return new Response('', { status: 504 })
      }
      const { fetchFn, calls } = fakeFetch(slow)
      expect(await kindOf(fetchMap(ROUTE, options(fetchFn)))).toBe('busy')
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('servers that hang', () => {
  const hostOf = (url: string) => new URL(url).host
  /** A request that never gets an answer: it ends only when it is stopped. */
  const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))

  /** Runs the real fetch over the real mirrors on a clock a test can wind on, with each mirror answering in its own way. */
  function fetchWith(reply: (host: string, init: RequestInit) => Promise<Response>) {
    const began = Date.now()
    const asked: { host: string; at: number }[] = []
    const heard: number[] = []
    const fetchFn = ((url: string, init: RequestInit) => {
      asked.push({ host: hostOf(url), at: Date.now() - began })
      return reply(hostOf(url), init)
    }) as unknown as typeof fetch
    const run = fetchMap(ROUTE, { fetchFn, onProgress: () => heard.push(Date.now() - began) })
    return { run, asked, heard, took: () => Date.now() - began }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('gets the map from the independent server, well within the total, when both main hosts hang', async () => {
    const SLOW_ANSWER_MS = 21_000
    const { run, asked, took } = fetchWith(async (host, init) => {
      if (host !== 'maps.mail.ru') return hang(init)
      await new Promise((resolve) => setTimeout(resolve, SLOW_ANSWER_MS))
      return new Response(JSON.stringify(MAP))
    })
    await vi.advanceTimersByTimeAsync(2 * ANSWER_TIMEOUT_MS + SLOW_ANSWER_MS)
    expect((await run).elements).toHaveLength(MAP.elements.length)
    expect(asked.map((a) => a.host)).toEqual(['lz4.overpass-api.de', 'z.overpass-api.de', 'maps.mail.ru'])
    expect(asked[2].at).toBe(2 * ANSWER_TIMEOUT_MS)
    expect(took()).toBeLessThan(TOTAL_TIMEOUT_MS * 0.75)
  })

  it('takes a good answer that is slow, as the main hosts have been seen to give', async () => {
    const { run, asked } = fetchWith(async () => {
      await new Promise((resolve) => setTimeout(resolve, 34_000))
      return new Response(JSON.stringify(MAP))
    })
    await vi.advanceTimersByTimeAsync(34_000)
    expect((await run).elements).toHaveLength(MAP.elements.length)
    expect(asked).toHaveLength(1)
  })

  it('says it is busy at the end of the total when every server hangs, and has told the screen before every ask', async () => {
    const { run, asked, heard, took } = fetchWith((_host, init) => hang(init))
    const kind = kindOf(run)
    await vi.advanceTimersByTimeAsync(TOTAL_TIMEOUT_MS)
    expect(await kind).toBe('busy')
    expect(took()).toBe(TOTAL_TIMEOUT_MS)
    expect(asked.map((a) => a.host)).toEqual(['lz4.overpass-api.de', 'z.overpass-api.de', 'maps.mail.ru', 'overpass-api.de'])
    expect(heard).toEqual(asked.map((a) => a.at))
  })
})

describe('no connection', () => {
  it('says so at once when the phone knows it is offline, and asks nobody', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const { fetchFn, calls } = fakeFetch(MAP)
    expect(await kindOf(fetchMap(ROUTE, options(fetchFn)))).toBe('offline')
    expect(calls).toHaveLength(0)
  })

  it('says so after one round when no mirror could be reached, without waiting to ask again', async () => {
    const { fetchFn, calls } = fakeFetch(offlineError())
    expect(await kindOf(fetchMap(ROUTE, options(fetchFn)))).toBe('offline')
    expect(calls).toHaveLength(2)
    expect(pause).not.toHaveBeenCalled()
  })

  it('is not what one mirror out of reach means: the rest are still asked', async () => {
    const { fetchFn } = fakeFetch(offlineError(), MAP)
    expect((await fetchMap(ROUTE, options(fetchFn))).elements).toHaveLength(MAP.elements.length)
  })

  it('is not what one out of reach and one busy means: that is busy', async () => {
    const { fetchFn } = fakeFetch(offlineError(), 504)
    expect(await kindOf(fetchMap(ROUTE, options(fetchFn)))).toBe('busy')
  })
})

describe('nothing there', () => {
  const NOTHING = { elements: [] }

  it('says so when every mirror says it has no roads there, in one round', async () => {
    const { fetchFn, calls } = fakeFetch(NOTHING)
    expect(await kindOf(fetchMap(ROUTE, options(fetchFn)))).toBe('nothing')
    expect(calls).toHaveLength(2)
  })

  it('takes a map from another mirror over one that has none', async () => {
    const { fetchFn } = fakeFetch(NOTHING, MAP)
    expect((await fetchMap(ROUTE, options(fetchFn))).elements).toHaveLength(MAP.elements.length)
  })

  it('is not what one mirror with no roads means while the others are busy, in every round: that is busy', async () => {
    const { fetchFn, calls } = fakeFetch(NOTHING, 504, NOTHING, 504, NOTHING, 504)
    expect(await kindOf(fetchMap(ROUTE, options(fetchFn)))).toBe('busy')
    expect(calls).toHaveLength((ROUND_WAITS_MS.length + 1) * 2)
  })

  it('is not what one empty answer among refusals means: that is busy', async () => {
    const { fetchFn, calls } = fakeFetch(429, 429, NOTHING, 429)
    expect(await kindOf(fetchMap(ROUTE, options(fetchFn)))).toBe('busy')
    expect(calls).toHaveLength((ROUND_WAITS_MS.length + 1) * 2)
  })

  it('is not what one empty answer means when the time runs out: that is busy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const late = (reply: () => Response) => async () => {
        vi.setSystemTime(Date.now() + TOTAL_TIMEOUT_MS / 2 + 1)
        return reply()
      }
      const { fetchFn, calls } = fakeFetch(late(() => new Response(JSON.stringify(NOTHING))), late(() => new Response('', { status: 504 })))
      expect(await kindOf(fetchMap(ROUTE, options(fetchFn)))).toBe('busy')
      expect(calls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('needs every mirror of one round to say so, not one left out of reach', async () => {
    const { fetchFn } = fakeFetch(NOTHING, offlineError(), NOTHING, offlineError(), NOTHING, offlineError())
    expect(await kindOf(fetchMap(ROUTE, options(fetchFn)))).toBe('busy')
  })

  it('is what a route with no points gets, without asking', async () => {
    const { fetchFn, calls } = fakeFetch(MAP)
    expect(await kindOf(fetchMap([], options(fetchFn)))).toBe('nothing')
    expect(calls).toHaveLength(0)
  })
})

describe('cancelling', () => {
  it('asks nobody when it was cancelled before it began', async () => {
    const stop = new AbortController()
    stop.abort()
    const { fetchFn, calls } = fakeFetch(MAP)
    expect(await kindOf(fetchMap(ROUTE, options(fetchFn, { signal: stop.signal })))).toBe('cancelled')
    expect(calls).toHaveLength(0)
  })

  it('stops a request under way, and asks no one else', async () => {
    const stop = new AbortController()
    const { fetchFn, calls } = fakeFetch(() => {
      stop.abort()
      return Promise.reject(new DOMException('Aborted', 'AbortError'))
    })
    expect(await kindOf(fetchMap(ROUTE, options(fetchFn, { signal: stop.signal })))).toBe('cancelled')
    expect(calls).toHaveLength(1)
    expect(calls[0].init.signal?.aborted).toBe(true)
  })

  it('stops the wait between rounds, with the real wait', async () => {
    const stop = new AbortController()
    const { fetchFn, calls } = fakeFetch(504)
    const run = fetchMap(ROUTE, { fetchFn, urls: ['https://one.test/i'], signal: stop.signal, onProgress: ({ step }) => step.includes('waiting') && setTimeout(() => stop.abort(), 1) })
    expect(await kindOf(run)).toBe('cancelled')
    expect(calls).toHaveLength(1)
  })
})

describe('what the screen says', () => {
  it('has plain words for each failure but cancelling', () => {
    expect(Object.keys(OSM_NOTICE).sort()).toEqual(['busy', 'nothing', 'offline'])
    for (const words of Object.values(OSM_NOTICE)) expect(words).toMatch(/^[A-Z].+\.$/)
  })

  it('leaves room, with no connection, for the phone being online and the service out of reach', () => {
    expect(OSM_NOTICE.offline).toBe("Couldn't reach the map service. Check you are online, then try again.")
  })
})
