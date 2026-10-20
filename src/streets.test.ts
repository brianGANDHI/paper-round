import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bearing, distanceToPath, haversine, pathLength, snapAtDistance } from './geo'
import { MAX_STREET_NAME, normalizeStreets } from './library'
import { NEAREST, rate, RoadError, TIMEOUT_MS } from './roads'
import { cardStreet as cardStreetDirect, MAX_STREET_CHARS, spokenStreet as spokenStreetDirect, streetKey } from './streetName'
import {
  cardStreet,
  fetchStreetName,
  lookUpStreets,
  mergeStreets,
  missingQueries,
  nameTurns,
  nearestUrl,
  pickStreetName,
  pruneStreets,
  spokenStreet,
  STREET_MATCH_DEG,
  STREET_MATCH_M,
  STREET_MIN_ROOM_M,
  STREET_SAMPLE_M,
  STREET_SNAP_M,
  streetFor,
  streetQueries,
  type StreetQuery,
} from './streets'
import { routeTurns, type Turn } from './turns'
import type { Pt, TurnStreet } from './types'

// A place in Sydney, so the maths is checked away from the equator and the prime meridian.
const ORIGIN = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
const sin = (deg: number) => Math.sin((deg * Math.PI) / 180)
const cos = (deg: number) => Math.cos((deg * Math.PI) / 180)

/** A spot `x` metres east and `y` metres north of the start. */
const spot = ([x, y]: readonly [number, number]): Pt => ({
  lat: ORIGIN.lat + y / M_PER_DEG,
  lng: ORIGIN.lng + x / (M_PER_DEG * cos(ORIGIN.lat)),
})

/** A route that goes through these spots (metres east and north of the start). */
const through = (...xy: [number, number][]): Pt[] => xy.map(spot)

type Move = { straight: number } | { turn: number; radius: number }

/** A route driven from the start heading north: along a straight, or round a bend (positive to the right) of that radius, a point every `step` metres. */
function drive(moves: Move[], step = 5): Pt[] {
  let x = 0
  let y = 0
  let h = 0
  const out: [number, number][] = [[x, y]]
  for (const m of moves) {
    if ('straight' in m) {
      const n = Math.max(1, Math.round(m.straight / step))
      for (let i = 1; i <= n; i++) out.push([x + ((m.straight * i) / n) * sin(h), y + ((m.straight * i) / n) * cos(h)])
      x += m.straight * sin(h)
      y += m.straight * cos(h)
    } else {
      const s = Math.sign(m.turn)
      const around = [x + s * m.radius * cos(h), y - s * m.radius * sin(h)]
      const n = Math.max(1, Math.ceil(((Math.abs(m.turn) * Math.PI) / 180) * m.radius / step))
      for (let i = 1; i <= n; i++) {
        const heading = h + (s * Math.abs(m.turn) * i) / n
        out.push([around[0] - s * m.radius * cos(heading), around[1] + s * m.radius * sin(heading)])
      }
      const end = h + m.turn
      x = around[0] - s * m.radius * cos(end)
      y = around[1] + s * m.radius * sin(end)
      h = end
    }
  }
  return out.map(spot)
}

/** A turn made by hand, `half` metres either side of where it is. */
const turnAt = (at: number, half = 0, angle = 90): Turn => ({ at, from: at - half, to: at + half, angle, heading: 0 })

/** Metres between two places. */
const metres = (a: Pt, b: Pt) => haversine(a, b)
const near = (a: number, b: number, within: number) => Math.abs(a - b) <= within

/** A stored street name for a query. */
const stored = (q: StreetQuery | null, name: string): TurnStreet => ({ lat: q!.lat, lng: q!.lng, out: q!.out, name })

/** Stands in for the street at a place `x` metres east and `y` north of where the entry for `q` is. */
const nudged = (q: StreetQuery, x: number, y: number, name: string, out = q.out): TurnStreet => {
  const p = { lat: q.lat + y / M_PER_DEG, lng: q.lng + x / (M_PER_DEG * cos(q.lat)) }
  return { ...p, out, name }
}

// ---------- fetch stand-ins, as roads.test.ts has ----------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Reply = Response | Error | ((init?: RequestInit, url?: string) => Promise<Response> | Response)

/** Stands in for fetch: each call takes the next reply. */
function mockFetch(...replies: Reply[]) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const next = replies.shift()
    if (!next) throw new Error('unexpected request')
    if (next instanceof Error) return Promise.reject(next)
    if (typeof next === 'function') return Promise.resolve(next(init, url))
    return Promise.resolve(next)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** Stands in for fetch by working out each answer from the request. */
function server(answer: (url: URL, call: number) => Response | Error | Promise<Response>) {
  let call = 0
  const fn = vi.fn((url: string) => {
    const result = answer(new URL(url), call++)
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** A server that never answers, but gives up when told to. */
const silent = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
  })

const kindOf = (e: unknown) => (e instanceof Error && 'kind' in e ? String(e.kind) : 'not a RoadError')
const failure = async (p: Promise<unknown>) => {
  try {
    await p
    return 'it worked'
  } catch (e) {
    return kindOf(e)
  }
}

/** What the server answers for the nearest road: the real shape, with the fields the app doesn't read left out. */
const wp = (name: string, distance: number) => ({ name, distance, location: [151.2085, -33.8733], nodes: [1, 2] })
const nearestAnswer = (...waypoints: { name: string; distance: number }[]) => ({ code: 'Ok', waypoints })

/** A query for a turn at a place, asking about a point 15 m on. */
const query = (at: Pt, out: number, point?: Pt): StreetQuery => ({ lat: at.lat, lng: at.lng, out, point: point ?? { lat: at.lat + 0.0001, lng: at.lng } })

beforeEach(() => {
  rate.minGapMs = 0
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

// ---------- where to ask ----------

describe('the numbers that decide what is asked and matched', () => {
  it('are the ones decided', () => {
    expect([STREET_MATCH_M, STREET_MATCH_DEG, STREET_SNAP_M, STREET_SAMPLE_M, STREET_MIN_ROOM_M]).toEqual([12, 35, 25, 15, 6])
  })
})

describe('where to ask about each turn', () => {
  it('has one entry for every turn, in order, and none for a route with no turns', () => {
    const route = through([0, 0], [0, 300], [300, 300], [300, 600], [600, 600])
    const turns = routeTurns(route)
    expect(turns).toHaveLength(3)
    expect(streetQueries(route, turns)).toHaveLength(3)
    expect(streetQueries(route, [])).toEqual([])
    expect(streetQueries([], [])).toEqual([])
  })

  it('has nothing for a route too short to measure, whatever the turns say', () => {
    expect(streetQueries([], [turnAt(10)])).toEqual([null])
    expect(streetQueries([spot([0, 0])], [turnAt(10), turnAt(40)])).toEqual([null, null])
    expect(streetQueries([spot([0, 0]), spot([0, 0])], [turnAt(0)])).toEqual([null])
  })

  it('asks 15 m past a corner, on the road it leads into, and keeps the corner as the place', () => {
    const route = through([0, 0], [0, 200], [200, 200])
    const turns = routeTurns(route)
    const [q] = streetQueries(route, turns)
    expect(q).not.toBeNull()
    expect(metres(q!, route[1])).toBeLessThan(0.5)
    expect(q!.out).toBe(90)
    // 15 m east of the corner.
    expect(Math.abs(metres(q!.point, route[1]) - 15)).toBeLessThan(0.1)
    expect(Math.abs(q!.point.lat - route[1].lat)).toBeLessThan(1e-7)
  })

  it('says which way the road leaves, in whole degrees, for each way round the compass', () => {
    const right = streetQueries(through([0, 0], [0, 200], [200, 200]), [turnAt(200)])[0]
    const left = streetQueries(through([0, 0], [0, 200], [-200, 200]), [turnAt(200, 0, -90)])[0]
    const north = streetQueries(through([0, 0], [200, 0], [200, 200]), [turnAt(200, 0, -90)])[0]
    const south = streetQueries(through([0, 0], [200, 0], [200, -200]), [turnAt(200, 0, 90)])[0]
    const southWest = streetQueries(through([0, 0], [0, 200], [-100, 100]), [turnAt(200, 0, -135)])[0]
    expect([right!.out, left!.out, north!.out, south!.out, southWest!.out]).toEqual([90, 270, 0, 180, 225])
  })

  it('goes by the road itself 15 m on, not by the first few metres of it', () => {
    // The road leaves east for a jog of 8 m and then runs north: 15 m on it is heading mostly north.
    const route = through([0, 0], [0, 200], [8, 200], [8, 300])
    const [q] = streetQueries(route, [turnAt(200)])
    // From the corner to a point 8 m east and 7 m north.
    expect(q!.out).toBe(Math.round(bearing(route[1], q!.point)))
    expect(q!.out).toBe(49)
  })

  it('asks on the line that was drawn, even where the road curves away after the turn', () => {
    const route = drive([{ straight: 190 }, { turn: 90, radius: 10 }, { straight: 100 }, { turn: -90, radius: 40 }, { straight: 200 }], 2)
    const turns = routeTurns(route)
    const queries = streetQueries(route, turns)
    for (const [i, q] of queries.entries()) {
      expect(q).not.toBeNull()
      expect(distanceToPath(q!.point, route)).toBeLessThan(0.01)
      expect(metres(q!.point, snapAtDistance(route, turns[i].to + STREET_SAMPLE_M)!.point)).toBeLessThan(0.01)
    }
  })

  it('gives the way out of a rounded corner to the left too', () => {
    const route = drive([{ straight: 190 }, { turn: -90, radius: 10 }, { straight: 190 }], 2)
    const [q] = streetQueries(route, routeTurns(route))
    expect(near(q!.out, 270, 3)).toBe(true)
  })

  it('is the turn itself, the middle of the swing, that is the place', () => {
    const route = drive([{ straight: 190 }, { turn: 90, radius: 10 }, { straight: 190 }], 2)
    const turns = routeTurns(route)
    const [q] = streetQueries(route, turns)
    expect(metres(q!, snapAtDistance(route, turns[0].at)!.point)).toBeLessThan(0.01)
    // The way out is the way the road leaves the end of the turn, east, not the way from the middle of it.
    expect(near(q!.out, 90, 3)).toBe(true)
    // And it is not the corner end of the swing.
    expect(metres(q!, snapAtDistance(route, turns[0].to)!.point)).toBeGreaterThan(1)
  })

  it('starts counting from the end of the swing, not from the middle of it', () => {
    const line = through([0, 0], [0, 1000])
    const [q] = streetQueries(line, [turnAt(100, 10)])
    // The swing ends at 110 m, so the road is asked about 15 m after that.
    expect(Math.abs(metres(q!.point, line[0]) - 125)).toBeLessThan(0.1)
    expect(Math.abs(metres(q!, line[0]) - 100)).toBeLessThan(0.1)
  })

  it('asks at most 15 m on, however much road there is', () => {
    const line = through([0, 0], [0, 1000])
    const [q] = streetQueries(line, [turnAt(100)])
    expect(Math.abs(metres(q!.point, line[0]) - 115)).toBeLessThan(0.1)
  })

  it('stops short of the next turn, 3 m before the swing starts', () => {
    const line = through([0, 0], [0, 1000])
    const at = (gap: number) => {
      const [q] = streetQueries(line, [turnAt(100), turnAt(100 + gap)])
      return q ? Math.round(metres(q.point, line[0]) * 100) / 100 : null
    }
    // Room is the gap, less 3 m, and 15 m is the most it asks.
    expect(at(100)).toBe(115)
    expect(at(18)).toBe(115)
    expect(at(17)).toBe(114)
    expect(at(12)).toBe(109)
    expect(at(10)).toBe(107)
  })

  it('goes by where the next swing starts, not by its middle', () => {
    const line = through([0, 0], [0, 1000])
    // The next turn is centred 40 m on but starts at 112 m: 9 m of room less 3 m.
    const [q] = streetQueries(line, [turnAt(100), { at: 140, from: 112, to: 168, angle: 90, heading: 0 }])
    expect(Math.abs(metres(q!.point, line[0]) - 109)).toBeLessThan(0.1)
    // And the room is from where this swing ends, not from the middle of it.
    const [wide] = streetQueries(line, [turnAt(100, 10), turnAt(200, 80)])
    expect(Math.abs(metres(wide!.point, line[0]) - 117)).toBeLessThan(0.1)
  })

  it('has no road to ask about when there are less than 6 m of room, and asks when there are 6', () => {
    const line = through([0, 0], [0, 1000])
    const room = (gap: number) => streetQueries(line, [turnAt(100), turnAt(100 + gap)])[0]
    expect(room(9)).not.toBeNull()
    expect(room(9.01)).not.toBeNull()
    expect(room(8.99)).toBeNull()
    expect(room(4)).toBeNull()
    expect(room(0)).toBeNull()
    expect(STREET_MIN_ROOM_M).toBe(6)
  })

  it('asks as little as 6 m on when that is all there is', () => {
    const line = through([0, 0], [0, 1000])
    const [q] = streetQueries(line, [turnAt(100), turnAt(109)])
    expect(Math.abs(metres(q!.point, line[0]) - 106)).toBeLessThan(0.1)
  })

  it('leaves out a turn whose next one has already started, however it came about', () => {
    const line = through([0, 0], [0, 1000])
    expect(streetQueries(line, [turnAt(100, 20), turnAt(110, 20)])).toEqual([null, expect.anything()])
    expect(streetQueries(line, [turnAt(100), turnAt(90)])[0]).toBeNull()
  })

  it('has nothing for a turn that is not at a place', () => {
    const line = through([0, 0], [0, 1000])
    const nowhere = { at: NaN, from: NaN, to: NaN, angle: 90, heading: 0 }
    expect(streetQueries(line, [nowhere])).toEqual([null])
    expect(streetQueries(line, [turnAt(100), nowhere])[0]).toBeNull()
    expect(streetQueries(line, [nowhere, turnAt(500)])[1]).not.toBeNull()
  })

  it('measures the room after the last turn from the end of the route', () => {
    const line = through([0, 0], [0, 1000])
    const length = pathLength(line)
    // 6 m of room: the route ends 3 m on from where it is asked about, and 3 m is kept clear.
    expect(streetQueries(line, [turnAt(length - 9 - 1e-6)])[0]).not.toBeNull()
    expect(streetQueries(line, [turnAt(length - 9 + 1e-6)])[0]).toBeNull()
    expect(streetQueries(line, [turnAt(length - 3)])[0]).toBeNull()
    expect(streetQueries(line, [turnAt(length + 50)])[0]).toBeNull()
    // Where the swing ends, not where it is centred, is what has to leave room: this one is 10 m either side.
    expect(streetQueries(line, [turnAt(length - 19 - 1e-6, 10)])[0]).not.toBeNull()
    expect(streetQueries(line, [turnAt(length - 19 + 1e-6, 10)])[0]).toBeNull()
  })

  it('asks about the road after the last turn too, however short, but not past the end', () => {
    const route = through([0, 0], [0, 200], [10, 200])
    // A corner with only 10 m of road after it has 7 m of room.
    const [q] = streetQueries(route, [turnAt(200)])
    expect(q).not.toBeNull()
    expect(metres(q!.point, route[2])).toBeGreaterThan(2.9)
    expect(metres(q!.point, route[2])).toBeLessThan(3.1)
  })

  it('does not ask when the road after the turn goes nowhere', () => {
    // The route goes 7.5 m on and comes straight back, so the road 15 m on is where it started.
    const route = through([0, 0], [0, 100], [0, 107.5], [0, 100], [0, 300])
    expect(streetQueries(route, [turnAt(100)])[0]).toBeNull()
  })

  it('asks when the road after the turn ends up a metre or more from where it started, and not when it is less', () => {
    // Out `a` m and then back down the road: 15 m on it is 2a - 15 m from where it started.
    const wobble = (a: number) => through([0, 0], [0, 100], [0, 100 + a], [0, 50], [0, 300])
    expect(streetQueries(wobble(7.95), [turnAt(100)])[0]).toBeNull()
    expect(streetQueries(wobble(8.05), [turnAt(100)])[0]).not.toBeNull()
    expect(streetQueries(wobble(9), [turnAt(100)])[0]).not.toBeNull()
  })

  it('asks when the road after the turn goes a little way', () => {
    const route = through([0, 0], [0, 100], [0, 109], [0, 98], [0, 300])
    const [q] = streetQueries(route, [turnAt(100)])
    expect(q).not.toBeNull()
    expect(metres(q!.point, route[1])).toBeGreaterThan(2.9)
  })

  it('gives each of two turns at one spot, one each way along a street driven twice, its own way out', () => {
    // North to a corner, east to a dead end and a U-turn, back west to the corner, and south again.
    const route = through([0, 0], [0, 300], [300, 300], [0, 300], [0, 0])
    const turns = routeTurns(route)
    const queries = streetQueries(route, turns)
    expect(queries.every((q) => q !== null)).toBe(true)
    // Right at the corner out east, a U-turn at the end out west, and left at the corner out south.
    expect(queries.map((q) => q!.out)).toEqual([90, 270, 180])
    expect(metres(queries[0]!, queries[2]!)).toBeLessThan(1)
  })

  it('works out the same for a route in the northern hemisphere', () => {
    const route: Pt[] = [
      { lat: 51, lng: -0.1 },
      { lat: 51.002, lng: -0.1 },
      { lat: 51.002, lng: -0.0971 },
    ]
    const turns = routeTurns(route)
    const [q] = streetQueries(route, turns)
    expect(q!.out).toBe(90)
    expect(metres(q!.point, snapAtDistance(route, turns[0].to + 15)!.point)).toBeLessThan(0.01)
  })

  it('keeps the way out in 0 to 359', () => {
    // A road leaving just west of north: 359.8 degrees rounds up to a whole turn, which is 0.
    const nearlyNorth = [spot([0, 0]), spot([0, 50]), spot([-0.349, 150])]
    expect(streetQueries(nearlyNorth, [turnAt(50)])[0]!.out).toBe(0)
    const justUnder = [spot([0, 0]), spot([0, 50]), spot([-0.9, 150])]
    expect(streetQueries(justUnder, [turnAt(50)])[0]!.out).toBe(359)
  })

  it('does not change what it is given', () => {
    const route = through([0, 0], [0, 300], [300, 300])
    const turns = routeTurns(route)
    const before = JSON.stringify([route, turns])
    streetQueries(route, turns)
    expect(JSON.stringify([route, turns])).toBe(before)
  })
})

// ---------- finding a name already known ----------

describe('finding the street kept for a turn', () => {
  const here = spot([0, 0])

  it('has none when nothing is kept', () => {
    expect(streetFor(here, 90, [])).toBeUndefined()
  })

  it('finds the one kept for the same turn', () => {
    const entry = { ...here, out: 90, name: 'Oak Road' }
    expect(streetFor(here, 90, [entry])).toBe(entry)
  })

  it('finds one that is up to 12 m away, and not further', () => {
    for (const [x, y] of [[11.9, 0], [-11.9, 0], [0, 11.9], [0, -11.9], [8.4, 8.4]] as const) {
      expect(streetFor(here, 90, [nudged(query(here, 90), x, y, 'Oak Road')])?.name).toBe('Oak Road')
    }
    for (const [x, y] of [[12.1, 0], [-12.1, 0], [0, 12.1], [0, -12.1], [8.7, 8.7]] as const) {
      expect(streetFor(here, 90, [nudged(query(here, 90), x, y, 'Oak Road')])).toBeUndefined()
    }
  })

  it('finds one whose way out is up to 35 degrees from this one, and not more', () => {
    const kept = (out: number) => [{ ...here, out, name: 'Oak Road' }]
    expect(streetFor(here, 90, kept(90 + 35))?.name).toBe('Oak Road')
    expect(streetFor(here, 90, kept(90 - 35))?.name).toBe('Oak Road')
    expect(streetFor(here, 90, kept(90 + 36))).toBeUndefined()
    expect(streetFor(here, 90, kept(90 - 36))).toBeUndefined()
  })

  it('goes round the compass: 350 and 10 are 20 degrees apart', () => {
    const kept = (out: number) => [{ ...here, out, name: 'Oak Road' }]
    expect(streetFor(here, 10, kept(350))?.name).toBe('Oak Road')
    expect(streetFor(here, 350, kept(10))?.name).toBe('Oak Road')
    expect(streetFor(here, 355, kept(30))?.name).toBe('Oak Road')
    expect(streetFor(here, 355, kept(31))).toBeUndefined()
    expect(streetFor(here, 0, kept(359))?.name).toBe('Oak Road')
    expect(streetFor(here, 0, kept(180))).toBeUndefined()
  })

  it('tells the two ways along a street apart, which have opposite ways out', () => {
    const out = { ...here, out: 90, name: 'Oak Road' }
    const back = { ...here, out: 270, name: 'Elm Street' }
    expect(streetFor(here, 90, [out, back])).toBe(out)
    expect(streetFor(here, 270, [out, back])).toBe(back)
    expect(streetFor(here, 270, [out])).toBeUndefined()
  })

  it('finds the nearest when more than one qualifies, whatever order they are kept in', () => {
    const q = query(here, 90)
    const far = nudged(q, 10, 0, 'Far')
    const mid = nudged(q, 0, 6, 'Mid')
    const near = nudged(q, 2, 0, 'Near')
    for (const list of [[far, mid, near], [near, mid, far], [mid, far, near]]) expect(streetFor(here, 90, list)?.name).toBe('Near')
  })

  it('ignores a nearer one that goes another way for a farther one that goes this way', () => {
    const q = query(here, 90)
    const wrong = nudged(q, 1, 0, 'Wrong way', 180)
    const right = nudged(q, 10, 0, 'Right way', 100)
    expect(streetFor(here, 90, [wrong, right])?.name).toBe('Right way')
  })

  it('finds the first kept when two are equally near', () => {
    const a = { ...here, out: 90, name: 'A' }
    const b = { ...here, out: 95, name: 'B' }
    expect(streetFor(here, 90, [a, b])?.name).toBe('A')
    expect(streetFor(here, 90, [b, a])?.name).toBe('B')
  })

  it('finds a kept answer that there is no name for, which is an answer all the same', () => {
    expect(streetFor(here, 90, [{ ...here, out: 90, name: '' }])?.name).toBe('')
  })

  it('takes a query where a place is wanted', () => {
    const q = query(here, 90)
    const entry = stored(q, 'Oak Road')
    expect(streetFor(q, q.out, [entry])).toBe(entry)
  })

  it('finds nothing for a way out or a place that is not a number', () => {
    const entry = { ...here, out: 90, name: 'Oak Road' }
    expect(streetFor(here, NaN, [entry])).toBeUndefined()
    expect(streetFor({ lat: NaN, lng: NaN }, 90, [entry])).toBeUndefined()
  })
})

// ---------- naming the turns ----------

describe('naming the turns of a route', () => {
  // Four turns, a long way apart: right, left, left, right.
  const route = through([0, 0], [0, 300], [300, 300], [300, 600], [0, 600], [0, 900])
  const turns = routeTurns(route)
  const queries = streetQueries(route, turns)
  const keep = (...names: (string | null)[]) => names.flatMap((name, i) => (name === null ? [] : [stored(queries[i], name)]))
  const streetsOf = (names: (string | null)[]) => nameTurns(route, turns, keep(...names)).map((t) => t.street)

  it('has four turns to name', () => {
    expect(turns.map((t) => Math.sign(t.angle))).toEqual([1, -1, -1, 1])
    expect(queries.every((q) => q !== null)).toBe(true)
  })

  it('gives each turn the street kept for it, and the rest of the turn as it was', () => {
    const named = nameTurns(route, turns, keep('Oak Road', 'Elm Street', 'Pine Avenue', 'Ash Lane'))
    expect(named.map((t) => t.street)).toEqual(['Oak Road', 'Elm Street', 'Pine Avenue', 'Ash Lane'])
    for (const [i, t] of named.entries()) expect({ ...t, street: undefined }).toEqual({ ...turns[i], street: undefined })
  })

  it('has no street for a turn nothing is kept for', () => {
    expect(streetsOf(['Oak Road', null, 'Pine Avenue', null])).toEqual(['Oak Road', null, 'Pine Avenue', null])
    expect(nameTurns(route, turns, []).map((t) => t.street)).toEqual([null, null, null, null])
  })

  it('has no street where the road has none, and not an empty one', () => {
    expect(streetsOf(['Oak Road', '', 'Pine Avenue', ''])).toEqual(['Oak Road', null, 'Pine Avenue', null])
    expect(streetsOf(['   ', null, null, null])[0]).toBeNull()
  })

  it('has no street for a turn that was left out for want of room', () => {
    // The last turn has only 8 m of road after it: 5 m of room, which is not enough.
    const short = through([0, 0], [0, 300], [300, 300], [300, 600], [308, 600])
    const shortTurns = routeTurns(short)
    const shortQueries = streetQueries(short, shortTurns)
    expect(shortTurns).toHaveLength(3)
    expect(shortQueries.map((q) => q === null)).toEqual([false, false, true])
    // Even a name kept for just that place is not used for a turn that was never asked about.
    const stray = { ...spot([300, 600]), out: 90, name: 'Stray Road' }
    const named = nameTurns(short, shortTurns, [stored(shortQueries[0], 'Oak Road'), stored(shortQueries[1], 'Elm Street'), stray])
    expect(named.map((t) => t.street)).toEqual(['Oak Road', 'Elm Street', null])
  })

  it('leaves the street out when it is the one already being driven, the same name as the turn before', () => {
    expect(streetsOf(['Oak Road', 'Oak Road', 'Elm Street', 'Ash Lane'])).toEqual(['Oak Road', null, 'Elm Street', 'Ash Lane'])
  })

  it('compares names without regard to capitals, spaces or the way an accent is stored', () => {
    expect(streetsOf(['Oak Road', ' oak   ROAD ', 'Elm Street', 'Ash Lane'])[1]).toBeNull()
    expect(streetsOf(['Rue Ch\u00eane', 'rue che\u0302ne', 'Elm Street', 'Ash Lane'])[1]).toBeNull()
  })

  it('compares with the turn before whether or not that one was shown', () => {
    // The street stays the same for three turns, and is only said at the first.
    expect(streetsOf(['Oak Road', 'Oak Road', 'Oak Road', 'Elm Street'])).toEqual(['Oak Road', null, null, 'Elm Street'])
  })

  it('says the street again when it comes back after another one', () => {
    expect(streetsOf(['Oak Road', 'Elm Street', 'Oak Road', 'Elm Street'])).toEqual(['Oak Road', 'Elm Street', 'Oak Road', 'Elm Street'])
  })

  it('says a street when the turn before is not known, since the road being driven is not', () => {
    expect(streetsOf([null, 'Oak Road', 'Oak Road', 'Elm Street'])).toEqual([null, 'Oak Road', null, 'Elm Street'])
    expect(streetsOf(['', 'Oak Road', null, 'Oak Road'])).toEqual([null, 'Oak Road', null, 'Oak Road'])
  })

  it('shows the first street, since the road before it is not known', () => {
    expect(streetsOf(['Oak Road', null, null, null])[0]).toBe('Oak Road')
  })

  it('finds a name for a turn whose corner has moved a little since', () => {
    const near = queries.map((q, i) => nudged(q!, 8, 0, `Street ${i}`))
    expect(nameTurns(route, turns, near).map((t) => t.street)).toEqual(['Street 0', 'Street 1', 'Street 2', 'Street 3'])
  })

  it('does not take a name that was found for a turn that has moved further than that', () => {
    const far = queries.map((q, i) => nudged(q!, 30, 0, `Street ${i}`))
    expect(nameTurns(route, turns, far).map((t) => t.street)).toEqual([null, null, null, null])
  })

  it('does not take a name that was found for the road leaving another way', () => {
    const wrong = queries.map((q, i) => stored({ ...q!, out: (q!.out + 90) % 360 }, `Street ${i}`))
    expect(nameTurns(route, turns, wrong).map((t) => t.street)).toEqual([null, null, null, null])
  })

  it('tidies the name, and keeps it to 60 characters, for the card', () => {
    const long = 'A'.repeat(50) + ' ' + 'B'.repeat(50)
    const [a, b] = nameTurns(route, turns, keep('  Oak   Road ', long))
    expect(a.street).toBe('Oak Road')
    expect(b.street).toBe(cardStreet(long))
    expect([...b.street!]).toHaveLength(60)
  })

  it('does not change what it is given, and gives a new list', () => {
    const kept = keep('Oak Road', 'Elm Street', null, null)
    const before = JSON.stringify([route, turns, kept])
    const named = nameTurns(route, turns, kept)
    expect(JSON.stringify([route, turns, kept])).toBe(before)
    expect(named).not.toBe(turns)
    expect(named[0]).not.toBe(turns[0])
  })

  it('has nothing for no turns', () => {
    expect(nameTurns(route, [], keep('Oak Road'))).toEqual([])
    expect(nameTurns([], [], [])).toEqual([])
  })
})

describe('the turns still waiting for a street name', () => {
  const route = through([0, 0], [0, 300], [300, 300], [300, 600], [0, 600], [0, 900])
  const turns = routeTurns(route)
  const queries = streetQueries(route, turns)

  it('are all of them when nothing is kept, in order, as asked about', () => {
    expect(missingQueries(route, turns, [])).toEqual(queries)
  })

  it('are none once every one has an answer, even one that says the road has no name', () => {
    expect(missingQueries(route, turns, queries.map((q, i) => stored(q, i % 2 ? '' : 'Oak Road')))).toEqual([])
  })

  it('are the ones without an answer', () => {
    expect(missingQueries(route, turns, [stored(queries[0], 'A'), stored(queries[2], 'C')])).toEqual([queries[1], queries[3]])
  })

  it('count an answer for a place a few metres away as an answer', () => {
    const near = queries.map((q) => nudged(q!, 0, 9, 'Oak Road'))
    expect(missingQueries(route, turns, near)).toEqual([])
    const far = queries.map((q) => nudged(q!, 0, 13, 'Oak Road'))
    expect(missingQueries(route, turns, far)).toEqual(queries)
  })

  it('count an answer for the road going another way as no answer', () => {
    expect(missingQueries(route, turns, [nudged(queries[0]!, 0, 0, 'A', (queries[0]!.out + 36) % 360)])).toEqual(queries)
    expect(missingQueries(route, turns, [nudged(queries[0]!, 0, 0, 'A', (queries[0]!.out + 35) % 360)])).toEqual(queries.slice(1))
  })

  it('leave out the turns with no room for a question', () => {
    const short = through([0, 0], [0, 300], [300, 300], [300, 600], [308, 600])
    const shortTurns = routeTurns(short)
    const shortQueries = streetQueries(short, shortTurns)
    expect(shortQueries.map((q) => q === null)).toEqual([false, false, true])
    expect(missingQueries(short, shortTurns, [])).toEqual([shortQueries[0], shortQueries[1]])
  })

  it('ask once for turns that would get the same answer: the same place, the same way out', () => {
    const line = through([0, 0], [0, 1000])
    const hand = [turnAt(100), turnAt(111.5), turnAt(300)]
    const asked = missingQueries(line, hand, [])
    expect(asked).toHaveLength(2)
    expect(metres(asked[0], line[0])).toBeCloseTo(100, 0)
    expect(metres(asked[1], line[0])).toBeCloseTo(300, 0)
  })

  it('ask for both when they are a little further apart than that', () => {
    const line = through([0, 0], [0, 1000])
    expect(missingQueries(line, [turnAt(100), turnAt(113)], [])).toHaveLength(2)
    expect(missingQueries(line, [turnAt(100), turnAt(112.5)], [])).toHaveLength(2)
    expect(missingQueries(line, [turnAt(100), turnAt(111.5)], [])).toHaveLength(1)
  })

  it('ask once for turns at one spot that leave within 35 degrees of each other, and twice beyond that', () => {
    // North to a corner and east out of it, round to the start again, and north to the corner a second time: out again,
    // `bend` degrees further round. The first and the second time at the corner are the pair.
    const corner = spot([0, 300])
    const twice = (bend: number) => {
      const a = ((90 + bend) * Math.PI) / 180
      return through([0, 0], [0, 300], [300, 300], [300, 0], [0, 0], [0, 300], [300 * Math.sin(a), 300 + 300 * Math.cos(a)])
    }
    const cornerQueries = (route: Pt[]) => streetQueries(route, routeTurns(route)).filter((q) => q && metres(q, corner) < 12)
    const asked = (route: Pt[]) => missingQueries(route, routeTurns(route), []).filter((q) => metres(q, corner) < 12)
    expect(cornerQueries(twice(35)).map((q) => q!.out)).toEqual([90, 125])
    expect(asked(twice(35))).toHaveLength(1)
    expect(cornerQueries(twice(36)).map((q) => q!.out)).toEqual([90, 126])
    expect(asked(twice(36))).toHaveLength(2)
    expect(cornerQueries(twice(-35)).map((q) => q!.out)).toEqual([90, 55])
    expect(asked(twice(-35))).toHaveLength(1)
    expect(asked(twice(-36))).toHaveLength(2)
  })

  it('ask once for a loop driven twice, which turns the same corners the same way each time', () => {
    const loop = through([0, 0], [0, 300], [300, 300], [300, 0], [0, 0], [0, 300], [300, 300], [300, 0])
    const loopTurns = routeTurns(loop)
    expect(loopTurns.length).toBeGreaterThanOrEqual(6)
    const asked = missingQueries(loop, loopTurns, [])
    expect(asked.length).toBeLessThan(loopTurns.length)
    // Four corners, each asked about once; a corner is asked about whichever pass came first.
    expect(asked).toHaveLength(4)
    // And answering those four covers every turn of the route.
    const answers = asked.map((q) => stored(q, 'Oak Road'))
    expect(missingQueries(loop, loopTurns, answers)).toEqual([])
  })

  it('ask for the two ways along a street driven out and back', () => {
    const outAndBack = through([0, 0], [0, 300], [300, 300], [0, 300], [0, 0])
    const outTurns = routeTurns(outAndBack)
    const asked = missingQueries(outAndBack, outTurns, [])
    // The corner turned at twice, once each way, is two questions: they leave different ways.
    expect(asked).toHaveLength(outTurns.length)
    expect(asked.map((q) => q.out)).toEqual([90, 270, 180])
  })

  it('keep the first of two that match, in the order of the route', () => {
    const line = through([0, 0], [0, 1000])
    const asked = missingQueries(line, [turnAt(100), turnAt(111.5)], [])
    expect(metres(asked[0], line[0])).toBeCloseTo(100, 0)
  })

  it('are none for no turns', () => {
    expect(missingQueries(route, [], [])).toEqual([])
    expect(missingQueries([], [], [])).toEqual([])
  })
})

// ---------- choosing a name from the answer ----------

describe('choosing the street from what the server found nearby', () => {
  const pick = (...list: { name?: string; distance: number }[]) => pickStreetName(list)
  const w = (name: string, distance: number) => ({ name, distance })

  it('is nothing when nothing was found, or nothing has a name', () => {
    expect(pick()).toBe('')
    expect(pick(w('', 3))).toBe('')
    expect(pick(w('', 3), w('', 8))).toBe('')
    expect(pick(w('   ', 3))).toBe('')
    expect(pick({ distance: 3 })).toBe('')
  })

  it('is the name of the only road found', () => {
    expect(pick(w('Oak Road', 5))).toBe('Oak Road')
    expect(pick(w('Oak Road', 0))).toBe('Oak Road')
  })

  it('tidies the name', () => {
    expect(pick(w('  Oak   Road ', 5))).toBe('Oak Road')
  })

  it('takes a named road close behind one with no name, which is likely a driveway or a path', () => {
    expect(pick(w('', 5), w('Oak Road', 13))).toBe('Oak Road')
  })

  it('takes a name up to 10 m beyond the nearest road, and not more', () => {
    expect(pick(w('', 5), w('Oak Road', 15))).toBe('Oak Road')
    expect(pick(w('', 5), w('Oak Road', 15.1))).toBe('')
    expect(pick(w('', 2.5), w('Oak Road', 12.5))).toBe('Oak Road')
    expect(pick(w('', 2.5), w('Oak Road', 12.6))).toBe('')
  })

  it('takes nothing more than 25 m away, however near the nearest was', () => {
    expect(pick(w('', 20), w('Oak Road', 25))).toBe('Oak Road')
    expect(pick(w('', 20), w('Oak Road', 25.1))).toBe('')
    expect(pick(w('Oak Road', 25))).toBe('Oak Road')
    expect(pick(w('Oak Road', 25.1))).toBe('')
    expect(pick(w('Oak Road', 60))).toBe('')
  })

  it('takes the street with most segments among those close together', () => {
    expect(pick(w('Oak Road', 5), w('Elm Street', 6), w('Elm Street', 7))).toBe('Elm Street')
    expect(pick(w('Elm Street', 6), w('Oak Road', 5), w('Elm Street', 7))).toBe('Elm Street')
  })

  it('goes by the nearest when streets have the same number of segments', () => {
    expect(pick(w('Oak Road', 5), w('Elm Street', 6), w('Elm Street', 8), w('Oak Road', 9))).toBe('Oak Road')
    expect(pick(w('Elm Street', 4), w('Oak Road', 5), w('Oak Road', 8), w('Elm Street', 9))).toBe('Elm Street')
    expect(pick(w('Elm Street', 9), w('Oak Road', 8), w('Oak Road', 5), w('Elm Street', 4))).toBe('Elm Street')
  })

  it('goes by the first listed when streets are as many and as near as each other', () => {
    expect(pick(w('Oak Road', 5), w('Elm Street', 5))).toBe('Oak Road')
    expect(pick(w('Elm Street', 5), w('Oak Road', 5))).toBe('Elm Street')
  })

  it('is Park Street, not the tunnel that runs under it, where a street has more segments near than the tunnel has', () => {
    // A real answer in Sydney, for a point on Park Street: the Cross City Tunnel 15.7 m away, two segments of
    // Park Street at 17.9 and 18.2 m, and the tunnel again at 27.9 m. The nearest is the tunnel, so the window is
    // 25 m (the cap, and less than 25.7). Park Street has two segments in it and the tunnel one, so Park Street wins.
    const answer = [w('Cross City Tunnel', 15.7), w('Park Street', 17.9), w('Park Street', 18.2), w('Cross City Tunnel', 27.9)]
    expect(pickStreetName(answer)).toBe('Park Street')
    // The order they are listed in makes no difference.
    expect(pickStreetName([...answer].reverse())).toBe('Park Street')
    expect(pickStreetName([answer[1], answer[3], answer[0], answer[2]])).toBe('Park Street')
  })

  it('is still the tunnel where it runs right under the street, as near and as often as the street: the rule cannot tell', () => {
    // The limit of the rule, kept here so nobody is surprised by it: a tie in segments goes to the nearest.
    const answer = [w('Cross City Tunnel', 15.7), w('Park Street', 17.9), w('Park Street', 18.2), w('Cross City Tunnel', 24.9)]
    expect(pickStreetName(answer)).toBe('Cross City Tunnel')
  })

  it('counts the segments of one street even when it is spelt with other capitals or spaces', () => {
    expect(pick(w('Oak Road', 4), w('park street', 5), w('PARK  STREET', 6))).toBe('park street')
    expect(pick(w('Oak Road', 4), w('Park Street', 5), w(' Park Street ', 6))).toBe('Park Street')
  })

  it('shows a street as the nearest of its segments spells it', () => {
    expect(pick(w('PARK STREET', 6), w('Park Street', 5))).toBe('Park Street')
    expect(pick(w('Park Street', 5), w('PARK STREET', 6))).toBe('Park Street')
  })

  it('shows a street as the first listed of its segments spells it when they are equally near', () => {
    expect(pick(w('Park Street', 5), w('PARK STREET', 5))).toBe('Park Street')
    expect(pick(w('PARK STREET', 5), w('Park Street', 5))).toBe('PARK STREET')
  })

  it('does not count roads with no name, which are not a street', () => {
    expect(pick(w('', 3), w('', 4), w('', 5), w('Oak Road', 6))).toBe('Oak Road')
    expect(pick(w('   ', 3), w('', 4), w('Oak Road', 6))).toBe('Oak Road')
  })

  it('does not go by something that is not a name', () => {
    expect(pickStreetName([{ name: 5 as unknown as string, distance: 3 }, w('Oak Road', 6)])).toBe('Oak Road')
    expect(pickStreetName([{ name: null as unknown as string, distance: 3 }, w('Oak Road', 6)])).toBe('Oak Road')
  })

  it('does not go by a distance that is not a distance', () => {
    expect(pick(w('Bad', NaN), w('Oak Road', 6))).toBe('Oak Road')
    expect(pick(w('Bad', -1), w('Oak Road', 6))).toBe('Oak Road')
    expect(pick(w('Bad', Infinity), w('Oak Road', 6))).toBe('Oak Road')
    expect(pickStreetName([{ name: 'Bad', distance: '3' as unknown as number }, w('Oak Road', 6)])).toBe('Oak Road')
    // A road that is not there does not set how close the nearest is either.
    expect(pick(w('', -1), w('Oak Road', 20))).toBe('Oak Road')
    expect(pick(w('', NaN), w('Oak Road', 20))).toBe('Oak Road')
    expect(pick(w('Bad', NaN))).toBe('')
  })

  it('keeps a name to 60 characters', () => {
    const long = 'Name '.repeat(20)
    const name = pick(w(long, 3))
    expect([...name].length).toBeLessThanOrEqual(60)
    expect(name).toBe(cardStreet(long))
  })

  it('does not change the list it is given', () => {
    const list = [w('Oak Road', 5), w('Elm Street', 6)]
    const before = JSON.stringify(list)
    pickStreetName(list)
    expect(JSON.stringify(list)).toBe(before)
  })

  it('does not mind how many are listed', () => {
    const many = Array.from({ length: 50 }, (_, i) => w(i % 2 ? 'Oak Road' : 'Elm Street', 1 + i * 0.1))
    expect(pickStreetName(many)).toBe('Elm Street')
  })
})

// ---------- the request ----------

describe('the request for the nearest street', () => {
  const q: StreetQuery = { lat: -33.8733, lng: 151.2085, out: 90, point: { lat: -33.873312, lng: 151.208612 } }

  it('asks the nearest service of the same server, with the point to ask about, longitude first', () => {
    expect(NEAREST).toBe('https://routing.openstreetmap.de/routed-car/nearest/v1/driving')
    expect(nearestUrl(q)).toBe(
      'https://routing.openstreetmap.de/routed-car/nearest/v1/driving/151.208612,-33.873312?number=4&bearings=90,35&radiuses=25&generate_hints=false',
    )
  })

  it('asks about the point, not about the turn', () => {
    expect(nearestUrl(q)).not.toContain('151.2085,')
    expect(nearestUrl(q)).toContain('/151.208612,-33.873312?')
  })

  it('gives the point to 6 decimal places', () => {
    expect(nearestUrl({ ...q, point: { lat: -33.87, lng: 151.2 } })).toContain('/151.200000,-33.870000?')
    expect(nearestUrl({ ...q, point: { lat: -33.8733123456, lng: 151.2086129999 } })).toContain('/151.208613,-33.873312?')
  })

  it('asks for the four nearest, within 25 m, with no hints', () => {
    const query = new URLSearchParams(nearestUrl(q).split('?')[1])
    expect(query.get('number')).toBe('4')
    expect(query.get('radiuses')).toBe('25')
    expect(query.get('generate_hints')).toBe('false')
  })

  it('asks for roads that run the way the turn leaves, 35 degrees either way', () => {
    expect(new URLSearchParams(nearestUrl(q).split('?')[1]).get('bearings')).toBe('90,35')
    expect(nearestUrl({ ...q, out: 0 })).toContain('bearings=0,35&')
    expect(nearestUrl({ ...q, out: 359 })).toContain('bearings=359,35&')
    expect(nearestUrl({ ...q, out: 225 })).toContain('bearings=225,35&')
  })

  it('never gives a bearing the server would refuse', () => {
    expect(nearestUrl({ ...q, out: 360 })).toContain('bearings=0,35&')
    expect(nearestUrl({ ...q, out: 725 })).toContain('bearings=5,35&')
    expect(nearestUrl({ ...q, out: -10 })).toContain('bearings=350,35&')
    expect(nearestUrl({ ...q, out: -370 })).toContain('bearings=350,35&')
    expect(nearestUrl({ ...q, out: 89.6 })).toContain('bearings=90,35&')
    expect(nearestUrl({ ...q, out: 359.6 })).toContain('bearings=0,35&')
    expect(nearestUrl({ ...q, out: -0.4 })).toContain('bearings=0,35&')
  })
})

describe('asking for a street name', () => {
  const q: StreetQuery = { lat: -33.8733, lng: 151.2085, out: 90, point: { lat: -33.873312, lng: 151.208612 } }

  it('makes one plain request and gives the street', async () => {
    const f = mockFetch(json(nearestAnswer(wp('Park Street', 3.2), wp('Park Street', 9.8))))
    expect(await fetchStreetName(q)).toBe('Park Street')
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(nearestUrl(q))
    // Custom headers would make the browser ask permission first; a bare GET does not.
    expect(Object.keys(init ?? {})).toEqual(['signal'])
  })

  it('picks by the rule when the answer is mixed up with a tunnel', async () => {
    mockFetch(json(nearestAnswer(wp('Cross City Tunnel', 15.7), wp('Park Street', 17.9), wp('Park Street', 18.2), wp('Cross City Tunnel', 27.9))))
    expect(await fetchStreetName(q)).toBe('Park Street')
  })

  it('is empty, not a failure, when there is no named road there', async () => {
    mockFetch(json(nearestAnswer(wp('', 0))))
    expect(await fetchStreetName(q)).toBe('')
    mockFetch(json(nearestAnswer()))
    expect(await fetchStreetName(q)).toBe('')
    mockFetch(json(nearestAnswer(wp('Far Road', 24), wp('', 5))))
    expect(await fetchStreetName(q)).toBe('')
  })

  it('is empty when the server finds no road near enough, which it says with a 400', async () => {
    mockFetch(json({ code: 'NoSegment', message: 'Could not find a matching segments for coordinate' }, 400))
    expect(await fetchStreetName(q)).toBe('')
  })

  it('is empty when it says that with a 200', async () => {
    mockFetch(json({ code: 'NoSegment', message: 'Could not find a matching segments for coordinate' }, 200))
    expect(await fetchStreetName(q)).toBe('')
  })

  it('is a failure for any other 400', async () => {
    for (const code of ['InvalidOptions', 'InvalidQuery', 'InvalidUrl', 'TooBig']) {
      mockFetch(json({ code, message: 'no' }, 400))
      let error: unknown
      try {
        await fetchStreetName(q)
      } catch (e) {
        error = e
      }
      expect(error).toBeInstanceOf(RoadError)
      expect(kindOf(error)).toBe('service')
      expect((error as RoadError).status).toBe(400)
    }
  })

  it('is a failure, with the status, when the server is busy or broken', async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      mockFetch(new Response('<html>no</html>', { status }))
      try {
        await fetchStreetName(q)
        expect.unreachable()
      } catch (e) {
        expect(kindOf(e)).toBe('service')
        expect((e as RoadError).status).toBe(status)
      }
    }
    mockFetch(json({ message: 'Too many requests' }, 429))
    try {
      await fetchStreetName(q)
      expect.unreachable()
    } catch (e) {
      expect((e as RoadError).status).toBe(429)
    }
  })

  it('is a failure for a server error, whatever the body says', async () => {
    mockFetch(json(nearestAnswer(wp('Oak Road', 3)), 500))
    expect(await failure(fetchStreetName(q))).toBe('service')
    mockFetch(json(nearestAnswer(wp('Oak Road', 3)), 429))
    expect(await failure(fetchStreetName(q))).toBe('service')
  })

  it('is a failure when the answer makes no sense, rather than an answer of no name', async () => {
    const bad: unknown[] = [null, 'oops', [], {}, { code: 'Ok' }, { code: 'Ok', waypoints: 'x' }, { code: 'Ok', waypoints: {} }, { code: 'Error' }, { waypoints: [wp('Oak Road', 3)] }]
    for (const body of bad) {
      mockFetch(json(body))
      expect(await failure(fetchStreetName(q))).toBe('service')
    }
    mockFetch(new Response('<html>Hotel wifi login</html>', { status: 200 }))
    expect(await failure(fetchStreetName(q))).toBe('service')
  })

  it('goes by the roads that make sense when the others in the answer do not', async () => {
    mockFetch(json({ code: 'Ok', waypoints: [null, 'x', { distance: 'far', name: 'Bad' }, {}, wp('Oak Road', 4), { name: 'No distance' }] }))
    expect(await fetchStreetName(q)).toBe('Oak Road')
  })

  it('is offline when the request never gets through', async () => {
    mockFetch(new TypeError('Load failed'))
    expect(await failure(fetchStreetName(q))).toBe('offline')
  })

  it('is offline without even trying when the phone says it has no connection', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const f = mockFetch(json(nearestAnswer(wp('Oak Road', 3))))
    expect(await failure(fetchStreetName(q))).toBe('offline')
    expect(f).not.toHaveBeenCalled()
  })

  it('gives up on a slow service after the timeout, and says so', async () => {
    vi.useFakeTimers()
    const f = mockFetch(silent)
    const outcome = failure(fetchStreetName(q))
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
    const outcome = failure(fetchStreetName(q, { timeoutMs: 800 }))
    await vi.advanceTimersByTimeAsync(800)
    expect(await outcome).toBe('timeout')
  })

  it('can be cancelled while the request is out, which stops the request', async () => {
    vi.useFakeTimers()
    const f = mockFetch(silent)
    const ctl = new AbortController()
    const outcome = failure(fetchStreetName(q, { signal: ctl.signal }))
    await vi.advanceTimersByTimeAsync(10)
    ctl.abort()
    expect(await outcome).toBe('cancelled')
    expect(f.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does nothing when it is already cancelled', async () => {
    const f = mockFetch(json(nearestAnswer(wp('Oak Road', 3))))
    const ctl = new AbortController()
    ctl.abort()
    expect(await failure(fetchStreetName(q, { signal: ctl.signal }))).toBe('cancelled')
    expect(f).not.toHaveBeenCalled()
  })

  it('leaves no timer running afterwards', async () => {
    vi.useFakeTimers()
    mockFetch(json(nearestAnswer(wp('Oak Road', 3))))
    await fetchStreetName(q)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps to the same one request a second as the road lookups do', async () => {
    vi.resetModules()
    const roads = await import('./roads')
    const streets = await import('./streets')
    vi.useFakeTimers()
    roads.rate.minGapMs = 1100
    const times: number[] = []
    const f = vi.fn((url: string) => {
      times.push(Date.now())
      return Promise.resolve(url.includes('/nearest/') ? json(nearestAnswer(wp('Oak Road', 3))) : json({ code: 'NoRoute' }, 400))
    })
    vi.stubGlobal('fetch', f)
    const start = Date.now()
    const a: Pt = { lat: -33.9, lng: 151.1 }
    const b: Pt = { lat: -33.91, lng: 151.11 }
    const all = Promise.allSettled([streets.fetchStreetName(q), roads.fetchDrive(a, b), streets.fetchStreetName(q)])
    await vi.advanceTimersByTimeAsync(3000)
    await all
    expect(times.map((t) => t - start)).toEqual([0, 1100, 2200])
  })

  it('does not ask at all when the server is not one for routes, since it cannot know the nearest street', async () => {
    vi.stubEnv('VITE_ROUTING_URL', 'https://osrm.example.com/driving')
    vi.resetModules()
    const streets = await import('./streets')
    const f = mockFetch(json(nearestAnswer(wp('Oak Road', 3))))
    expect(await failure(streets.fetchStreetName(q))).toBe('service')
    expect(f).not.toHaveBeenCalled()
  })

  it('stops a run when cancelled even where the server cannot be asked', async () => {
    vi.stubEnv('VITE_ROUTING_URL', 'https://osrm.example.com/driving')
    vi.resetModules()
    const streets = await import('./streets')
    const ctl = new AbortController()
    ctl.abort()
    const run = await streets.lookUpStreets([q], { signal: ctl.signal, onFound: () => {} })
    expect(run).toEqual({ found: 0, unnamed: 0, failed: 0, stopped: 'cancelled' })
    // And not cancelled, the same run fails: there is no point asking again and again.
    const failed = await streets.lookUpStreets([q, q, q, q], { onFound: () => {} })
    expect(failed).toEqual({ found: 0, unnamed: 0, failed: 3, stopped: 'service' })
  })

  it('asks the other server when one is set, with the same service swapped', async () => {
    vi.stubEnv('VITE_ROUTING_URL', 'https://osrm.example.com/route/v1/driving/')
    vi.resetModules()
    const streets = await import('./streets')
    const f = mockFetch(json(nearestAnswer(wp('Oak Road', 3))))
    expect(await streets.fetchStreetName(q)).toBe('Oak Road')
    expect(f.mock.calls[0][0]).toBe(
      'https://osrm.example.com/nearest/v1/driving/151.208612,-33.873312?number=4&bearings=90,35&radiuses=25&generate_hints=false',
    )
  })
})

// ---------- the run ----------

describe('looking up a lot of street names', () => {
  const qs = (n: number): StreetQuery[] =>
    Array.from({ length: n }, (_, i) => ({ lat: -33.87 - i * 0.001, lng: 151.2, out: (i * 40) % 360, point: { lat: -33.87 - i * 0.001 - 0.0001, lng: 151.2 } }))
  const names = (...list: string[]) => list.map((name) => json(nearestAnswer(wp(name, 3))))

  /** What the hooks were called with. */
  function hooks(extra: Partial<Parameters<typeof lookUpStreets>[1]> = {}) {
    const found: [StreetQuery, string][] = []
    const progress: [number, number][] = []
    return {
      found,
      progress,
      hooks: {
        onFound: (q: StreetQuery, name: string) => void found.push([q, name]),
        onProgress: (done: number, total: number) => void progress.push([done, total]),
        ...extra,
      },
    }
  }

  it('does nothing for nothing to look up', async () => {
    const f = mockFetch()
    const h = hooks()
    expect(await lookUpStreets([], h.hooks)).toEqual({ found: 0, unnamed: 0, failed: 0, stopped: 'done' })
    expect(f).not.toHaveBeenCalled()
    expect(h.found).toEqual([])
    expect(h.progress).toEqual([])
  })

  it('asks about each in turn and reports each name as it comes', async () => {
    const f = mockFetch(...names('Oak Road', 'Elm Street', 'Pine Avenue'))
    const list = qs(3)
    const h = hooks()
    const run = await lookUpStreets(list, h.hooks)
    expect(run).toEqual({ found: 3, unnamed: 0, failed: 0, stopped: 'done' })
    expect(f.mock.calls.map((c) => c[0])).toEqual(list.map(nearestUrl))
    expect(h.found).toEqual([
      [list[0], 'Oak Road'],
      [list[1], 'Elm Street'],
      [list[2], 'Pine Avenue'],
    ])
    expect(h.found[0][0]).toBe(list[0])
  })

  it('reports how far it has got after each one', async () => {
    mockFetch(...names('A', 'B', 'C', 'D'))
    const h = hooks()
    await lookUpStreets(qs(4), h.hooks)
    expect(h.progress).toEqual([[1, 4], [2, 4], [3, 4], [4, 4]])
  })

  it('reports a name before the progress it makes', async () => {
    mockFetch(...names('A', 'B'))
    const order: string[] = []
    await lookUpStreets(qs(2), {
      onFound: (_q, name) => void order.push(`found ${name}`),
      onProgress: (done) => void order.push(`done ${done}`),
    })
    expect(order).toEqual(['found A', 'done 1', 'found B', 'done 2'])
  })

  it('works without a progress hook or a signal', async () => {
    mockFetch(...names('A'))
    const found: string[] = []
    expect((await lookUpStreets(qs(1), { onFound: (_q, name) => void found.push(name) })).found).toBe(1)
    expect(found).toEqual(['A'])
  })

  it('counts a road with no name as found, and as unnamed, and says so with an empty name', async () => {
    mockFetch(...names('Oak Road'), json({ code: 'NoSegment' }, 400), json(nearestAnswer(wp('', 2))), json(nearestAnswer()))
    const h = hooks()
    const run = await lookUpStreets(qs(4), h.hooks)
    expect(run).toEqual({ found: 4, unnamed: 3, failed: 0, stopped: 'done' })
    expect(h.found.map(([, name]) => name)).toEqual(['Oak Road', '', '', ''])
  })

  it('asks one at a time: the next only after the last has been answered', async () => {
    let open = 0
    let most = 0
    server(async () => {
      open++
      most = Math.max(most, open)
      await new Promise((resolve) => setTimeout(resolve, 5))
      open--
      return json(nearestAnswer(wp('Oak Road', 3)))
    })
    await lookUpStreets(qs(5), hooks().hooks)
    expect(most).toBe(1)
  })

  it('leaves the gap the server asks for between one and the next', async () => {
    vi.resetModules()
    const roads = await import('./roads')
    const streets = await import('./streets')
    vi.useFakeTimers()
    roads.rate.minGapMs = 1100
    const times: number[] = []
    vi.stubGlobal('fetch', () => {
      times.push(Date.now())
      return Promise.resolve(json(nearestAnswer(wp('Oak Road', 3))))
    })
    const start = Date.now()
    const done = streets.lookUpStreets(qs(3), { onFound: () => {} })
    await vi.advanceTimersByTimeAsync(3000)
    await done
    expect(times.map((t) => t - start)).toEqual([0, 1100, 2200])
  })

  it('stops after 3 failures in a row, and keeps what it had found', async () => {
    const f = mockFetch(...names('A', 'B'), new TypeError('x'), new TypeError('x'), new TypeError('x'), ...names('never'))
    const h = hooks()
    const run = await lookUpStreets(qs(10), h.hooks)
    expect(run).toEqual({ found: 2, unnamed: 0, failed: 3, stopped: 'offline' })
    expect(f).toHaveBeenCalledTimes(5)
    expect(h.found.map(([, name]) => name)).toEqual(['A', 'B'])
    expect(h.progress).toEqual([[1, 10], [2, 10], [3, 10], [4, 10], [5, 10]])
  })

  it('does not stop for 2 failures in a row, nor for failures that are not in a row', async () => {
    const e = new TypeError('x')
    const f = mockFetch(e, e, ...names('A'), e, e, ...names('B'), e, ...names('C'))
    const run = await lookUpStreets(qs(8), hooks().hooks)
    expect(run).toEqual({ found: 3, unnamed: 0, failed: 5, stopped: 'done' })
    expect(f).toHaveBeenCalledTimes(8)
  })

  it('counts the one it fails on as done, as it does for the ones it names', async () => {
    mockFetch(new TypeError('x'), ...names('B'))
    const h = hooks()
    await lookUpStreets(qs(2), h.hooks)
    expect(h.progress).toEqual([[1, 2], [2, 2]])
  })

  it('says why it stopped: the way the last of the 3 failed', async () => {
    mockFetch(new TypeError('x'), new TypeError('x'), json({ code: 'InvalidOptions' }, 400))
    expect((await lookUpStreets(qs(5), hooks().hooks)).stopped).toBe('service')
    vi.useFakeTimers()
    mockFetch(silent, silent, silent)
    const run = lookUpStreets(qs(5), hooks().hooks)
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 3)
    expect(await run).toEqual({ found: 0, unnamed: 0, failed: 3, stopped: 'timeout' })
  })

  it('stops at once when the server says it is busy, however many it had asked', async () => {
    const f = mockFetch(...names('A'), json({ message: 'Too many requests' }, 429), ...names('never'))
    const run = await lookUpStreets(qs(10), hooks().hooks)
    expect(run).toEqual({ found: 1, unnamed: 0, failed: 1, stopped: 'service' })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('stops at once for any 5xx, even with a page and not JSON', async () => {
    for (const status of [500, 502, 503, 504, 599]) {
      const f = mockFetch(new Response('<html>no</html>', { status }), ...names('never'))
      const run = await lookUpStreets(qs(10), hooks().hooks)
      expect(run).toEqual({ found: 0, unnamed: 0, failed: 1, stopped: 'service' })
      expect(f).toHaveBeenCalledTimes(1)
    }
  })

  it('does not stop at once for other things that go wrong with the server, only after 3', async () => {
    for (const status of [400, 403, 404, 408, 428, 430, 499]) {
      const f = server(() => json({ message: 'no' }, status))
      const run = await lookUpStreets(qs(10), hooks().hooks)
      expect(run).toEqual({ found: 0, unnamed: 0, failed: 3, stopped: 'service' })
      expect(f).toHaveBeenCalledTimes(3)
    }
    // An answer that is not what was asked for: a login page from the wifi.
    const f = server(() => new Response('<html>Hotel wifi login</html>', { status: 200 }))
    const run = await lookUpStreets(qs(10), hooks().hooks)
    expect(run.failed).toBe(3)
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('does not ask at all when there is no connection, but stops after 3 all the same', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const f = mockFetch()
    const run = await lookUpStreets(qs(10), hooks().hooks)
    expect(run).toEqual({ found: 0, unnamed: 0, failed: 3, stopped: 'offline' })
    expect(f).not.toHaveBeenCalled()
  })

  it('does not call a failure not found, and does not report one', async () => {
    mockFetch(...names('A'), new TypeError('x'), ...names('C'))
    const h = hooks()
    await lookUpStreets(qs(3), h.hooks)
    expect(h.found.map(([, name]) => name)).toEqual(['A', 'C'])
  })

  it('stops when cancelled before it starts, without asking', async () => {
    const f = mockFetch(...names('A'))
    const ctl = new AbortController()
    ctl.abort()
    const h = hooks()
    expect(await lookUpStreets(qs(3), { ...h.hooks, signal: ctl.signal })).toEqual({ found: 0, unnamed: 0, failed: 0, stopped: 'cancelled' })
    expect(f).not.toHaveBeenCalled()
    expect(h.progress).toEqual([])
  })

  it('stops when cancelled between one and the next, keeping what was found', async () => {
    const f = mockFetch(...names('A', 'B', 'C'))
    const ctl = new AbortController()
    const h = hooks({ onFound: (q: StreetQuery, name: string) => void (h.found.push([q, name]), ctl.abort()) })
    const run = await lookUpStreets(qs(3), { ...h.hooks, signal: ctl.signal })
    expect(run).toEqual({ found: 1, unnamed: 0, failed: 0, stopped: 'cancelled' })
    expect(f).toHaveBeenCalledTimes(1)
    expect(h.found.map(([, name]) => name)).toEqual(['A'])
  })

  it('stops when cancelled while a request is out, and does not count that as a failure', async () => {
    const ctl = new AbortController()
    let calls = 0
    const f = mockFetch(
      ...names('A'),
      (init) => {
        calls++
        queueMicrotask(() => ctl.abort())
        return silent(init) as Promise<Response>
      },
    )
    const h = hooks()
    const run = await lookUpStreets(qs(5), { ...h.hooks, signal: ctl.signal })
    expect(run).toEqual({ found: 1, unnamed: 0, failed: 0, stopped: 'cancelled' })
    expect(calls).toBe(1)
    expect(f).toHaveBeenCalledTimes(2)
    expect(f.mock.calls[1][1]?.signal?.aborted).toBe(true)
  })

  it('stops when cancelled while waiting out the gap', async () => {
    vi.resetModules()
    const roads = await import('./roads')
    const streets = await import('./streets')
    vi.useFakeTimers()
    roads.rate.minGapMs = 1100
    const f = mockFetch(json(nearestAnswer(wp('A', 3))), json(nearestAnswer(wp('B', 3))))
    const ctl = new AbortController()
    const run = streets.lookUpStreets(qs(3), { onFound: () => {}, signal: ctl.signal })
    await vi.advanceTimersByTimeAsync(500)
    ctl.abort()
    expect(await run).toEqual({ found: 1, unnamed: 0, failed: 0, stopped: 'cancelled' })
    expect(f).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never throws: a hook that does is ignored and the run carries on', async () => {
    mockFetch(...names('A', 'B'))
    let calls = 0
    const run = await lookUpStreets(qs(2), {
      onFound: () => {
        calls++
        throw new Error('the screen went away')
      },
      onProgress: () => {
        throw new Error('so did this')
      },
    })
    expect(run).toEqual({ found: 2, unnamed: 0, failed: 0, stopped: 'done' })
    expect(calls).toBe(2)
  })

  it('never throws: a question that cannot be made is a failure like any other', async () => {
    const f = mockFetch(...names('A'))
    const run = await lookUpStreets([{} as StreetQuery, {} as StreetQuery, {} as StreetQuery, ...qs(2)], hooks().hooks)
    expect(run).toEqual({ found: 0, unnamed: 0, failed: 3, stopped: 'service' })
    expect(f).not.toHaveBeenCalled()
  })
})

// ---------- keeping the answers ----------

describe('keeping the names that were found', () => {
  const entry = (lat: number, lng: number, out: number, name: string): TurnStreet => ({ lat, lng, out, name })

  it('adds new ones after the ones kept, in the order found', () => {
    const merged = mergeStreets([entry(-33.1, 151, 90, 'A')], [entry(-33.2, 151, 90, 'B'), entry(-33.3, 151, 90, 'C')])
    expect(merged.map((s) => s.name)).toEqual(['A', 'B', 'C'])
  })

  it('puts a new answer for a turn in the place of the old one', () => {
    const merged = mergeStreets([entry(-33.1, 151, 90, 'A'), entry(-33.2, 151, 90, 'B')], [entry(-33.1, 151, 90, 'New A')])
    expect(merged).toEqual([entry(-33.1, 151, 90, 'New A'), entry(-33.2, 151, 90, 'B')])
  })

  it('counts a turn as the same one when it is the same place and way out, to within a metre', () => {
    const merged = mergeStreets([entry(-33.1, 151, 90, 'A')], [entry(-33.1 + 0.8 / M_PER_DEG, 151, 90, 'New A')])
    expect(merged.map((s) => s.name)).toEqual(['New A'])
    const apart = mergeStreets([entry(-33.1, 151, 90, 'A')], [entry(-33.1 + 1.2 / M_PER_DEG, 151, 90, 'Other')])
    expect(apart.map((s) => s.name)).toEqual(['A', 'Other'])
  })

  it('counts a turn as another one when it leaves a different way', () => {
    const merged = mergeStreets([entry(-33.1, 151, 90, 'A')], [entry(-33.1, 151, 180, 'B')])
    expect(merged.map((s) => s.name)).toEqual(['A', 'B'])
    // Each is still the answer for its own turn.
    expect(streetFor({ lat: -33.1, lng: 151 }, 90, merged)?.name).toBe('A')
    expect(streetFor({ lat: -33.1, lng: 151 }, 180, merged)?.name).toBe('B')
  })

  it('counts a turn as the same one when it leaves nearly the same way, which a lookup could not tell apart', () => {
    // The same corner asked about again can leave a degree or two different: the new answer must not sit behind the old.
    const merged = mergeStreets([entry(-33.1, 151, 90, 'Old')], [entry(-33.1, 151, 91, 'New')])
    expect(merged).toEqual([entry(-33.1, 151, 91, 'New')])
    expect(streetFor({ lat: -33.1, lng: 151 }, 91, merged)?.name).toBe('New')
  })

  it('tells a new answer from an old one by the same angle a lookup does, 35 degrees', () => {
    expect(STREET_MATCH_DEG).toBe(35)
    const same = mergeStreets([entry(-33.1, 151, 90, 'Old')], [entry(-33.1, 151, 90 + STREET_MATCH_DEG, 'New')])
    expect(same.map((s) => s.name)).toEqual(['New'])
    const apart = mergeStreets([entry(-33.1, 151, 90, 'Old')], [entry(-33.1, 151, 90 + STREET_MATCH_DEG + 1, 'New')])
    expect(apart.map((s) => s.name)).toEqual(['Old', 'New'])
    const before = mergeStreets([entry(-33.1, 151, 90, 'Old')], [entry(-33.1, 151, 90 - STREET_MATCH_DEG, 'New')])
    expect(before.map((s) => s.name)).toEqual(['New'])
    const further = mergeStreets([entry(-33.1, 151, 90, 'Old')], [entry(-33.1, 151, 90 - STREET_MATCH_DEG - 1, 'New')])
    expect(further.map((s) => s.name)).toEqual(['Old', 'New'])
  })

  it('counts the way round north: 359 and 1 are 2 degrees apart', () => {
    const merged = mergeStreets([entry(-33.1, 151, 359, 'Old')], [entry(-33.1, 151, 1, 'New')])
    expect(merged.map((s) => s.name)).toEqual(['New'])
    const apart = mergeStreets([entry(-33.1, 151, 350, 'Old')], [entry(-33.1, 151, 30, 'New')])
    expect(apart.map((s) => s.name)).toEqual(['Old', 'New'])
  })

  it('does not count a turn as the same one when it is more than a metre away, whatever way it leaves', () => {
    const merged = mergeStreets([entry(-33.1, 151, 90, 'Old')], [entry(-33.1 + 1.2 / M_PER_DEG, 151, 91, 'New')])
    expect(merged.map((s) => s.name)).toEqual(['Old', 'New'])
    // The nearer of the two is the answer for a turn at the new one's place.
    expect(streetFor({ lat: -33.1 + 1.2 / M_PER_DEG, lng: 151 }, 91, merged)?.name).toBe('New')
  })

  it('puts a new answer in the place of every old one for the same turn, where the first was', () => {
    const old = [
      entry(-33.1, 151, 90, 'First'),
      entry(-33.1, 151, 120, 'Second'),
      entry(-33.2, 151, 90, 'Other'),
      entry(-33.1, 151, 70, 'Third'),
      entry(-33.1, 151, 270, 'Opposite'),
    ]
    const merged = mergeStreets(old, [entry(-33.1, 151, 100, 'New')])
    expect(merged.map((s) => s.name)).toEqual(['New', 'Other', 'Opposite'])
    expect(merged[0].out).toBe(100)
    // And when it is not the first that matches.
    const later = mergeStreets([entry(-33.2, 151, 90, 'Other'), ...old.slice(0, 2), old[3]], [entry(-33.1, 151, 100, 'New')])
    expect(later.map((s) => s.name)).toEqual(['Other', 'New'])
  })

  it('keeps the newest of two found together for nearly the same turn', () => {
    const merged = mergeStreets([], [entry(-33.1, 151, 90, 'First'), entry(-33.1, 151, 91, 'Second')])
    expect(merged.map((s) => s.name)).toEqual(['Second'])
  })

  it('gives the newest name for a turn asked about again, however the way out came out this time', () => {
    const at = { lat: -33.8, lng: 151.2 }
    const old = [entry(at.lat, at.lng, 90, 'Old')]
    for (const out of [85, 89, 90, 91, 95, 120]) {
      const merged = mergeStreets(old, [entry(at.lat, at.lng, out, 'New')])
      expect(streetFor(at, out, merged)?.name, String(out)).toBe('New')
      expect(merged, String(out)).toHaveLength(1)
    }
  })

  it('keeps the newest of two found for the same turn', () => {
    const merged = mergeStreets([], [entry(-33.1, 151, 90, 'First'), entry(-33.1, 151, 90, 'Second')])
    expect(merged.map((s) => s.name)).toEqual(['Second'])
  })

  it('can replace a name with none, since the road may have lost its name', () => {
    expect(mergeStreets([entry(-33.1, 151, 90, 'A')], [entry(-33.1, 151, 90, '')])[0].name).toBe('')
  })

  it('is the old list when nothing was found, and the new when nothing was kept', () => {
    const old = [entry(-33.1, 151, 90, 'A')]
    expect(mergeStreets(old, [])).toEqual(old)
    expect(mergeStreets([], old)).toEqual(old)
    expect(mergeStreets([], [])).toEqual([])
  })

  it('gives a new list and changes nothing it is given', () => {
    const old = [entry(-33.1, 151, 90, 'A')]
    const found = [entry(-33.1, 151, 90, 'B'), entry(-33.2, 151, 90, 'C')]
    const before = JSON.stringify([old, found])
    const merged = mergeStreets(old, found)
    expect(JSON.stringify([old, found])).toBe(before)
    expect(merged).not.toBe(old)
    expect(merged).not.toBe(found)
  })

  it('is what can be put back after being read from storage, round the 6 decimal places a backup keeps', () => {
    const six = (n: number) => Math.round(n * 1e6) / 1e6
    const old = [entry(six(-33.1234567), six(151.7654321), 90, 'A')]
    const merged = mergeStreets(old, [entry(-33.1234567, 151.7654321, 90, 'B')])
    expect(merged).toHaveLength(1)
    expect(merged[0].name).toBe('B')
  })
})

describe('dropping the names no turn uses any more', () => {
  const route = through([0, 0], [0, 300], [300, 300], [300, 600], [0, 600], [0, 900])
  const turns = routeTurns(route)
  const queries = streetQueries(route, turns)
  const all = queries.map((q, i) => stored(q, `Street ${i}`))
  const entry = (lat: number, lng: number, out: number, name: string): TurnStreet => ({ lat, lng, out, name })

  it('keeps every name a turn uses', () => {
    expect(pruneStreets(route, turns, all)).toEqual(all)
  })

  it('drops names for places that are no longer turns, such as after the route changed', () => {
    const elsewhere = [entry(-33.0, 150, 90, 'Gone'), { ...all[1], name: 'Kept' }]
    expect(pruneStreets(route, turns, elsewhere).map((s) => s.name)).toEqual(['Kept'])
  })

  it('drops names for a turn that now leaves another way', () => {
    const turned = all.map((s) => ({ ...s, out: (s.out + 90) % 360 }))
    expect(pruneStreets(route, turns, turned)).toEqual([])
  })

  it('keeps a name that is up to 12 m from the turn it is for', () => {
    const moved = queries.map((q, i) => nudged(q!, 9, 0, `Street ${i}`))
    expect(pruneStreets(route, turns, moved)).toEqual(moved)
    const away = queries.map((q, i) => nudged(q!, 14, 0, `Street ${i}`))
    expect(pruneStreets(route, turns, away)).toEqual([])
  })

  it('keeps an answer that there is no name, which a turn uses all the same', () => {
    const none = queries.map((q) => stored(q, ''))
    expect(pruneStreets(route, turns, none)).toEqual(none)
  })

  it('drops all of them when there are no turns left', () => {
    expect(pruneStreets(route, [], all)).toEqual([])
    expect(pruneStreets([], [], all)).toEqual([])
  })

  it('drops all of them when the turns have no room to be asked about', () => {
    expect(pruneStreets(route, [turnAt(10000)], all)).toEqual([])
  })

  it('keeps one name for two turns that share it', () => {
    const loop = through([0, 0], [0, 300], [300, 300], [300, 0], [0, 0], [0, 300], [300, 300], [300, 0])
    const loopTurns = routeTurns(loop)
    const asked = missingQueries(loop, loopTurns, [])
    const names = asked.map((q) => stored(q, 'Oak Road'))
    expect(loopTurns.length).toBeGreaterThan(names.length)
    expect(pruneStreets(loop, loopTurns, names)).toEqual(names)
  })

  it('drops a second name that sits behind a nearer one, which no turn would use', () => {
    const near = stored(queries[0], 'Near')
    const behind = nudged(queries[0]!, 9, 0, 'Behind')
    expect(pruneStreets(route, turns, [behind, near])).toEqual([near])
  })

  it('drops the copy when the same name is there twice', () => {
    const twice = [all[0], { ...all[0] }]
    expect(pruneStreets(route, turns, twice)).toHaveLength(1)
  })

  it('keeps the names in the order they were in', () => {
    const reversed = [...all].reverse()
    expect(pruneStreets(route, turns, reversed)).toEqual(reversed)
  })

  it('is a new list, and changes nothing it is given', () => {
    const before = JSON.stringify([route, turns, all])
    const kept = pruneStreets(route, turns, all)
    expect(JSON.stringify([route, turns, all])).toBe(before)
    expect(kept).not.toBe(all)
  })
})

// ---------- writing a name ----------

describe('a street name on the card', () => {
  it('is the whole name, with its spaces tidied', () => {
    expect(cardStreet('Oak Road')).toBe('Oak Road')
    expect(cardStreet('  Oak   Road \n')).toBe('Oak Road')
    expect(cardStreet('Oak Road / Rue du Chene')).toBe('Oak Road / Rue du Chene')
    expect(cardStreet('')).toBe('')
    expect(cardStreet('   ')).toBe('')
  })

  it('is kept to 60 characters', () => {
    expect(cardStreet('a'.repeat(60))).toBe('a'.repeat(60))
    expect(cardStreet('a'.repeat(61))).toBe('a'.repeat(60))
    expect(cardStreet('a'.repeat(200))).toBe('a'.repeat(60))
  })

  it('does not end on a space where it is cut', () => {
    expect(cardStreet(`${'a'.repeat(59)} bbbbb`)).toBe('a'.repeat(59))
  })

  it('does not cut a character in half', () => {
    // An emoji takes two units of text, so 61 of them are cut to the 30 that fit in 60 units, the way the saved routes cut them.
    const cut = cardStreet('\u{1F6E3}'.repeat(61))
    expect([...cut]).toHaveLength(30)
    expect(cut).toBe('\u{1F6E3}'.repeat(30))
    // One that would be split by the cut is left out whole.
    expect(cardStreet(`${'a'.repeat(59)}\u{1F6E3}`)).toBe('a'.repeat(59))
    expect(cardStreet(`${'a'.repeat(58)}\u{1F6E3}`)).toBe(`${'a'.repeat(58)}\u{1F6E3}`)
  })

  it('is cut at the same length the saved routes cut a name to, counted the same way', () => {
    expect(MAX_STREET_CHARS).toBe(MAX_STREET_NAME)
    expect(cardStreet('\u{1F6E3}'.repeat(60))).toHaveLength(MAX_STREET_NAME)
    expect(cardStreet('\u{20000}'.repeat(40))).toHaveLength(MAX_STREET_NAME)
    expect(cardStreet('a'.repeat(MAX_STREET_NAME + 1))).toHaveLength(MAX_STREET_NAME)
  })

  it('is empty for something that is not a name', () => {
    for (const junk of [undefined, null, 5, {}, []]) {
      expect(cardStreet(junk as unknown as string)).toBe('')
      expect(spokenStreet(junk as unknown as string)).toBe('')
    }
  })

  it('is the same function the rest of the app gets from streetName', () => {
    expect(cardStreet).toBe(cardStreetDirect)
  })

  it('survives being kept: a name from the server is never one the saved routes would drop or cut', () => {
    const q: TurnStreet = { lat: -33.8, lng: 151.2, out: 90, name: pickStreetName([{ name: `  ${'Long Name '.repeat(10)}`, distance: 2 }]) }
    expect(normalizeStreets([q])).toEqual([q])
  })

  // Names that are made of more than letters: two-unit characters at the cut, and the controls and invisible marks the saved routes take out.
  const AWKWARD = [
    '\u{1F6E3}'.repeat(60),
    '\u{1F6E3}'.repeat(30),
    '\u{1F6E3}'.repeat(31),
    '\u{20000}'.repeat(40),
    `${'a'.repeat(59)}\u{1F6E3}`,
    `${'a'.repeat(58)}\u{1F6E3}x`,
    `${'a'.repeat(58)}\u{1F6E3} b`,
    `${'a'.repeat(59)}\u200b b`,
    `${'a'.repeat(59)} \u200b`,
    `${'\u{1F6E3}'.repeat(29)} \u{1F6E3}`,
    'Oak\0Road',
    'Oak\u0007Road',
    '\u0007Oak Road\u0007',
    'Oak\u200bRoad',
    'Oak\u00a0\u00a0Road',
    '\u200b',
    '\u200b\u200b\u2060',
    '\ufeff',
    '\0',
    '  \u200b \u0007 ',
    '\u{1F468}\u200d\u{1F469}\u200d\u{1F467} Road',
    'Cafe\u0301 Road',
    'ab\ud83d',
    'ab\ud83d\ud83d',
    'ab\ud83d\ud83d\ud83d ',
    '\ud83d\ud83d',
    '\ude00ab',
    `${'a'.repeat(59)}\ud83d`,
  ]

  it('is unchanged by being kept with the route, whatever the name is made of', () => {
    for (const awkward of AWKWARD) {
      const name = cardStreet(awkward)
      expect(normalizeStreets([{ lat: -33.8, lng: 151.2, out: 90, name }]), JSON.stringify(awkward)).toEqual([{ lat: -33.8, lng: 151.2, out: 90, name }])
      expect(cardStreet(name), JSON.stringify(awkward)).toBe(name)
    }
  })

  it('is unchanged by being kept with the route when it came from the server', () => {
    for (const awkward of AWKWARD) {
      const name = pickStreetName([{ name: awkward, distance: 3 }])
      expect(name, JSON.stringify(awkward)).toBe(cardStreet(awkward))
      expect(normalizeStreets([{ lat: -33.8, lng: 151.2, out: 90, name }]), JSON.stringify(awkward)).toEqual([{ lat: -33.8, lng: 151.2, out: 90, name }])
    }
  })

  it('is unchanged by being kept with the route, for names of any mix of text', () => {
    const pieces = ['a', 'Oak', ' ', '  ', '\n', '\t', '\u00a0', '\0', '\u0007', '\u200b', '\u2060', '\ufeff', '\u200d', '\u0301', '\u{1F6E3}', '\u{1F468}', '\u{20000}', '\u4e2d', '\ud83d', '\ude00', '/', ' - ']
    let seed = 12345
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let i = 0; i < 1500; i++) {
      let awkward = ''
      for (let k = next(90); k > 0; k--) awkward += pieces[next(pieces.length)]
      const name = cardStreet(awkward)
      expect(name.length, JSON.stringify(awkward)).toBeLessThanOrEqual(MAX_STREET_NAME)
      expect(normalizeStreets([{ lat: -33.8, lng: 151.2, out: 90, name }])[0]?.name, JSON.stringify(awkward)).toBe(name)
      expect(cardStreet(name), JSON.stringify(awkward)).toBe(name)
    }
  })

  it('is cut after control characters and runs of spaces have been squeezed to one, as the saved routes cut it', () => {
    // 120 units that are 79 once squeezed: cut at 60 from the squeezed text, not from the text as it came.
    const raw = 'a\0\0'.repeat(40)
    const name = cardStreet(raw)
    expect(name).toBe(`${'a '.repeat(29)}a`)
    expect(normalizeStreets([{ lat: -33.8, lng: 151.2, out: 90, name: raw }])[0].name).toBe(name)
    const spaced = 'a   '.repeat(40)
    expect(cardStreet(spaced)).toBe(`${'a '.repeat(29)}a`)
    expect(normalizeStreets([{ lat: -33.8, lng: 151.2, out: 90, name: spaced }])[0].name).toBe(cardStreet(spaced))
  })

  it('is nothing when it shows nothing, as it is nothing once kept', () => {
    for (const blank of ['\u200b', '\u200b\u200b\u2060', '\ufeff', '\0', '  \u200b \u0007 ']) {
      expect(cardStreet(blank), JSON.stringify(blank)).toBe('')
      expect(pickStreetName([{ name: blank, distance: 2 }]), JSON.stringify(blank)).toBe('')
    }
  })
})

describe('whether two spellings are the same street', () => {
  it('ignores capitals, the spaces round and between words, and the way an accent is stored', () => {
    expect(streetKey('  Oak   Road ')).toBe('oak road')
    expect(streetKey('OAK ROAD')).toBe(streetKey('oak road'))
    expect(streetKey('Rue Ch\u00eane')).toBe(streetKey('Rue Che\u0302ne'))
  })

  it('tells different streets apart', () => {
    expect(streetKey('Oak Road')).not.toBe(streetKey('Oak Street'))
    expect(streetKey('Oak Road')).not.toBe(streetKey('OakRoad'))
  })

  it('is empty for no name, or something that is not one', () => {
    expect(streetKey('')).toBe('')
    expect(streetKey('   ')).toBe('')
    expect(streetKey(undefined as unknown as string)).toBe('')
  })
})

describe('a street name said aloud', () => {
  it('is the name as it is', () => {
    expect(spokenStreet('Oak Road')).toBe('Oak Road')
    expect(spokenStreet('Cross City Tunnel')).toBe('Cross City Tunnel')
    expect(spokenStreet('Broadway')).toBe('Broadway')
    expect(spokenStreet('')).toBe('')
  })

  it('is the first of a name in two languages, divided by a slash, dash or bar with spaces round it', () => {
    expect(spokenStreet('Oak Road / Rue du Chene')).toBe('Oak Road')
    expect(spokenStreet('Oak Road - Rue du Chene')).toBe('Oak Road')
    expect(spokenStreet('Oak Road | Rue du Chene')).toBe('Oak Road')
    expect(spokenStreet('Oak Road  /  Rue du Chene / Oak Strasse')).toBe('Oak Road')
    expect(spokenStreet('Oak Road - Rue du Chene | Oak Strasse')).toBe('Oak Road')
  })

  it('does not divide a name at a dash or slash with no spaces round it', () => {
    expect(spokenStreet('Smith-Jones Street')).toBe('Smith-Jones Street')
    expect(spokenStreet('Princes Hwy/Route 1')).toBe('Princes Hwy/Route 1')
    expect(spokenStreet('A-B Road')).toBe('A-B Road')
  })

  it('says a short ending in full', () => {
    const ends: [string, string][] = [
      ['St', 'Street'],
      ['Rd', 'Road'],
      ['Ave', 'Avenue'],
      ['Dr', 'Drive'],
      ['Cres', 'Crescent'],
      ['Pl', 'Place'],
      ['Ct', 'Court'],
      ['Pde', 'Parade'],
      ['Hwy', 'Highway'],
      ['Tce', 'Terrace'],
      ['Cl', 'Close'],
      ['Blvd', 'Boulevard'],
    ]
    for (const [short, full] of ends) expect(spokenStreet(`Oak ${short}`)).toBe(`Oak ${full}`)
  })

  it('says it in full whatever its capitals, or with a full stop', () => {
    expect(spokenStreet('Oak ST')).toBe('Oak Street')
    expect(spokenStreet('Oak st')).toBe('Oak Street')
    expect(spokenStreet('Oak Rd.')).toBe('Oak Road')
    expect(spokenStreet('Oak St.')).toBe('Oak Street')
  })

  it('says only the ending, and only at the end', () => {
    expect(spokenStreet('Dr Smith Road')).toBe('Dr Smith Road')
    expect(spokenStreet('Pl Oak Street')).toBe('Pl Oak Street')
    expect(spokenStreet('Oak St North')).toBe('Oak St North')
    expect(spokenStreet('Oak Street')).toBe('Oak Street')
    expect(spokenStreet('Old Cl Road')).toBe('Old Cl Road')
  })

  it('leaves a name of one word alone, even if it is one of the endings', () => {
    for (const word of ['St', 'Rd', 'Ave', 'Dr', 'Blvd']) expect(spokenStreet(word)).toBe(word)
  })

  it('leaves words that only end like an ending', () => {
    expect(spokenStreet('Oak Street West')).toBe('Oak Street West')
    expect(spokenStreet('Oak Crest')).toBe('Oak Crest')
    expect(spokenStreet('Oak Ave Extension')).toBe('Oak Ave Extension')
    expect(spokenStreet('Mount Pleasant')).toBe('Mount Pleasant')
    expect(spokenStreet('Oak Stx')).toBe('Oak Stx')
  })

  it('says a St at the start as Saint', () => {
    expect(spokenStreet('St Kilda Road')).toBe('Saint Kilda Road')
    expect(spokenStreet('St. Marys Street')).toBe('Saint Marys Street')
    expect(spokenStreet('ST Johns Rd')).toBe('Saint Johns Road')
    expect(spokenStreet('St Kilda St')).toBe('Saint Kilda Street')
    expect(spokenStreet('Stanley Street')).toBe('Stanley Street')
    expect(spokenStreet('Stone Road')).toBe('Stone Road')
  })

  it('does both with a name in two languages', () => {
    expect(spokenStreet('Pitt St / Rue Pitt')).toBe('Pitt Street')
    expect(spokenStreet('Rue Pitt - Pitt St')).toBe('Rue Pitt')
  })

  it('says a last word that is also a name on every object as it is, not what that name holds', () => {
    // An endings list is looked up by the last word, which comes from the server: these are names every plain object has.
    for (const word of ['constructor', 'Constructor', 'CONSTRUCTOR', '__proto__', '__PROTO__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__lookupGetter__']) {
      expect(spokenStreet(`Oak ${word}`), word).toBe(`Oak ${word}`)
      expect(spokenStreet(`Oak ${word}.`), word).toBe(`Oak ${word}.`)
      expect(spokenStreet(`St ${word} ${word}`), word).toBe(`Saint ${word} ${word}`)
    }
  })

  it('is the same when said again', () => {
    for (const name of ['Oak Rd', 'St Kilda Rd', 'Oak Road / Rue', 'Pitt St.', '  Oak   St ']) {
      expect(spokenStreet(spokenStreet(name))).toBe(spokenStreet(name))
    }
  })

  it('tidies spaces first', () => {
    expect(spokenStreet('  Oak    Rd  ')).toBe('Oak Road')
  })

  it('is the same function the rest of the app gets from streetName', () => {
    expect(spokenStreet).toBe(spokenStreetDirect)
  })
})

// ---------- all of it together ----------

describe('naming the turns of a route, from a lookup to the card', () => {
  // A street map for a pretend server: the road a point is on, by the way it is asked to run.
  const roadFor = (bearings: number) => (bearings >= 45 && bearings < 135 ? 'Oak Road' : bearings >= 225 && bearings < 315 ? 'Elm Street' : bearings < 45 || bearings >= 315 ? 'Pine Avenue' : '')
  const pretend = (url: URL) => {
    const bearings = Number(url.searchParams.get('bearings')!.split(',')[0])
    const name = roadFor(bearings)
    return json(name ? nearestAnswer(wp('Unnamed Lane', 2), wp(name, 4), wp(name, 6)) : { code: 'NoSegment' }, name ? 200 : 400)
  }

  it('finds every name once, keeps them, and has nothing left to ask', async () => {
    const route = through([0, 0], [0, 300], [300, 300], [300, 600], [0, 600], [0, 900])
    const turns = routeTurns(route)
    server(pretend)
    const missing = missingQueries(route, turns, [])
    expect(missing).toHaveLength(4)

    let kept: TurnStreet[] = []
    const run = await lookUpStreets(missing, { onFound: (q, name) => void (kept = mergeStreets(kept, [{ lat: q.lat, lng: q.lng, out: q.out, name }])) })
    expect(run).toEqual({ found: 4, unnamed: 0, failed: 0, stopped: 'done' })

    // Round: right onto Oak Road (east), left onto Pine Avenue (north), left onto Elm Street (west), right onto Pine Avenue (north).
    const named = nameTurns(route, turns, kept)
    expect(named.map((t) => t.street)).toEqual(['Oak Road', 'Pine Avenue', 'Elm Street', 'Pine Avenue'])

    // Setup: nothing is missing, nothing is dropped, and what was kept is what a saved route would keep.
    expect(missingQueries(route, turns, kept)).toEqual([])
    expect(pruneStreets(route, turns, kept)).toEqual(kept)
    expect(normalizeStreets(JSON.parse(JSON.stringify(kept)))).toEqual(kept)
  })

  it('remembers a road with no name, so that it is not asked about again', async () => {
    // Right onto an east road that has a name, and right again onto a south one that has none.
    const route = through([0, 0], [0, 300], [300, 300], [300, 0])
    const turns = routeTurns(route)
    server(pretend)
    let kept: TurnStreet[] = []
    const run = await lookUpStreets(missingQueries(route, turns, kept), {
      onFound: (q, name) => void (kept = mergeStreets(kept, [{ lat: q.lat, lng: q.lng, out: q.out, name }])),
    })
    expect(run).toEqual({ found: 2, unnamed: 1, failed: 0, stopped: 'done' })
    expect(kept.map((s) => s.name)).toEqual(['Oak Road', ''])
    expect(nameTurns(route, turns, kept).map((t) => t.street)).toEqual(['Oak Road', null])
    expect(missingQueries(route, turns, kept)).toEqual([])
    expect(normalizeStreets(JSON.parse(JSON.stringify(kept)))).toEqual(kept)
  })

  it('asks again only for what a change to the route made new', async () => {
    const route = through([0, 0], [0, 300], [300, 300], [300, 600])
    const turns = routeTurns(route)
    server(pretend)
    let kept: TurnStreet[] = []
    await lookUpStreets(missingQueries(route, turns, kept), { onFound: (q, name) => void (kept = mergeStreets(kept, [{ lat: q.lat, lng: q.lng, out: q.out, name }])) })
    expect(kept).toHaveLength(2)

    // The route is carried on, with a new turn at its end: the old turns are still named.
    const longer = [...route, spot([-300, 600])]
    const longerTurns = routeTurns(longer)
    expect(longerTurns).toHaveLength(3)
    const missing = missingQueries(longer, longerTurns, kept)
    expect(missing).toHaveLength(1)
    expect(missing[0].out).toBe(270)
    expect(nameTurns(longer, longerTurns, kept).map((t) => t.street)).toEqual(['Oak Road', 'Pine Avenue', null])
  })

  it('names a turn that was kept in a backup, which rounds the place to 6 decimal places', async () => {
    const route = through([0, 0], [0, 300], [300, 300])
    const turns = routeTurns(route)
    const queries = streetQueries(route, turns)
    const six = (n: number) => Math.round(n * 1e6) / 1e6
    const restored = queries.map((q) => ({ lat: six(q!.lat), lng: six(q!.lng), out: q!.out, name: 'Oak Road' }))
    expect(nameTurns(route, turns, restored).map((t) => t.street)).toEqual(['Oak Road'])
    expect(missingQueries(route, turns, restored)).toEqual([])
  })

  it('goes round a roundabout: one turn, one question, asked on the road it leaves by', () => {
    // In heading north, round a roundabout, and out: the turn ends where the road leaves it.
    const route = drive([{ straight: 150 }, { turn: -90, radius: 8 }, { turn: 90, radius: 20 }, { turn: -90, radius: 8 }, { straight: 150 }])
    const turns = routeTurns(route)
    expect(turns).toHaveLength(1)
    const [q] = streetQueries(route, turns)
    expect(q).not.toBeNull()
    const end = snapAtDistance(route, turns[0].to)!.point
    expect(Math.abs(metres(q!.point, end) - 15)).toBeLessThan(0.5)
    expect(q!.out).toBe(Math.round(bearing(end, q!.point)) % 360)
    // Left 90 to get on, right 90 round it and left 90 to get off: it leaves heading west.
    expect(near(q!.out, 270, 6)).toBe(true)
    // And the place is the middle of the whole roundabout, well before the road it leaves by.
    expect(turns[0].to - turns[0].from).toBeGreaterThan(40)
    expect(metres(q!, end)).toBeGreaterThan(20)
  })
})
