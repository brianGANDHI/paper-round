import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bearing } from './geo'
import { arrivalBearing, extendAlongRoads, rate, UTURN_RANGE_DEG } from './roads'
import { appendPoint } from './routeEdit'
import { routeTurns, turnKind } from './turns'
import type { Pt, Route } from './types'

/**
 * A U-turn drawn with Follow roads, from the tap to the turn card. The road service is stood in for by answers shaped like
 * the real ones (see roads.test.ts), the route is built by `extendAlongRoads` exactly as the drawing screen does (the first tap a
 * point, every later one a lookup, the road for a U-turn held to leaving the way back), and `routeTurns` is asked what the driver
 * would be told. What it must find is one U-turn at the place, and nothing else that is not really there.
 */

// A place in Sydney, so the maths is checked away from the equator and the prime meridian.
const ORIGIN: Pt = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
const rad = (deg: number) => (deg * Math.PI) / 180

/** A place in the driver's own frame: [metres to the right of the way the route first heads, metres ahead of the start]. */
type Spot = readonly [number, number]

/** The same place on the map, for a route whose first stretch heads `h` degrees clockwise from north. The shapes below are the same whichever way the road runs. */
const spot = (h: number, [x, y]: Spot): Pt => {
  const east = x * Math.cos(rad(h)) + y * Math.sin(rad(h))
  const north = -x * Math.sin(rad(h)) + y * Math.cos(rad(h))
  return { lat: ORIGIN.lat + north / M_PER_DEG, lng: ORIGIN.lng + east / (M_PER_DEG * Math.cos(rad(ORIGIN.lat))) }
}

/** Points along the road through these places, one at least every `step` metres, as a road service's geometry has. */
function dense(step: number, ...xy: Spot[]): Spot[] {
  const out: Spot[] = [xy[0]]
  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1]
    const [bx, by] = xy[i]
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step))
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n])
  }
  return out
}

/** What the road service answers for a drive along these places: six-figure coordinates, longitude first. */
const answer = (h: number, ...xy: Spot[]) => ({
  code: 'Ok',
  routes: [
    {
      distance: 0,
      duration: 60,
      geometry: {
        type: 'LineString',
        coordinates: dense(20, ...xy).map((s) => {
          const p = spot(h, s)
          return [Number(p.lng.toFixed(6)), Number(p.lat.toFixed(6))]
        }),
      },
    },
  ],
})

/** The place `m` metres on from `from` along a heading of `h` degrees clockwise from the driver's own forward. */
const ahead = ([x, y]: Spot, h: number, m: number): Spot => [x + m * Math.sin(rad(h)), y + m * Math.cos(rad(h))]

/** `n` points along a gentle bend to the right: from `from`, heading `h0`, turning `degrees` more over a radius of `radius` metres. */
const bend = ([x, y]: Spot, h0: number, degrees: number, radius: number, n: number): Spot[] =>
  Array.from({ length: n }, (_, i): Spot => {
    const h = h0 + (degrees * (i + 1)) / n
    return [x + radius * (Math.cos(rad(h0)) - Math.cos(rad(h))), y + radius * (Math.sin(rad(h)) - Math.sin(rad(h0)))]
  })

/** One tap that follows roads: the road the service answers with (the tap lands at its end), and whether U-turn is switched on for it. */
interface Step {
  road: Spot[]
  uturn?: boolean
}

beforeEach(() => {
  rate.minGapMs = 0
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Draws as the screen does with Follow roads on: the first tap is a point of its own (where the first road starts), and every
 * tap after it asks for the road from the end of the route, the U-turn ones held to leaving the way the route arrived. Gives the
 * route and the requests that were made.
 */
async function draw(h: number, ...steps: Step[]): Promise<{ route: Route; urls: string[] }> {
  const urls: string[] = []
  const answers = steps.map((s) => answer(h, ...s.road))
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      urls.push(url)
      const next = answers.shift()
      if (!next) throw new Error('unexpected request')
      return Promise.resolve(new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } }))
    }),
  )
  let route: Route = appendPoint({ points: [], sideChanges: [], stops: [] }, spot(h, steps[0].road[0]), 'both')
  for (const step of steps) {
    const tap = spot(h, step.road[step.road.length - 1])
    const uturnFrom = step.uturn ? (arrivalBearing(route.points) ?? undefined) : undefined
    const done = await extendAlongRoads(route, tap, 'both', { uturnFrom })
    expect(done.notice).toBeNull()
    route = done.route
  }
  return { route, urls }
}

/** Which way round the road is asked to leave: the `bearings` of a request, or null when it has none. */
const bearingsOf = (url: string) => new URLSearchParams(url.split('?')[1]).get('bearings')

/** The kinds of the turns the driver would be told of, in order. */
const kinds = (route: Route) => routeTurns(route.points).map((t) => turnKind(t.angle))

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol

/** Ways the first stretch can head: north, a diagonal, east, south-west, north-west, and just short of north. */
const HEADINGS = [0, 37, 90, 200, 315, 359]

/** The one turn a route has, which must be a U-turn the way given (1 right, -1 left, 0 for either) and as far along as `at`, give or take `tol`. */
function oneUturn(route: Route, way: 1 | -1 | 0, at: number, tol: number) {
  const turns = routeTurns(route.points)
  expect(turns.map((t) => turnKind(t.angle))).toEqual(['uturn'])
  const [t] = turns
  if (way !== 0) expect(Math.sign(t.angle)).toBe(way)
  expect(Math.abs(t.angle)).toBeLessThanOrEqual(180)
  expect(Math.abs(t.angle)).toBeGreaterThanOrEqual(165)
  expect(near(t.at, at, tol), `at ${t.at}, wanted ${at}`).toBe(true)
}

/** The road out: 300 m straight ahead. */
const OUT: Spot[] = [
  [0, 0],
  [0, 300],
]
/** Where the way back ends, 180 m back down it. */
const BACK_TO = 120

describe('a U-turn drawn with Follow roads', () => {
  describe('where the way back is on a parallel road to the side', () => {
    it('is one U-turn, whatever the gap between the two carriageways, to the right', async () => {
      for (const h of HEADINGS) {
        for (const across of [3, 8, 12, 16, 20, 25]) {
          // The road for the tap snaps to the other carriageway at the same place, then runs back along it. The two are joined by a short piece across.
          const { route } = await draw(h, { road: OUT }, { road: [[across, 300], [across, BACK_TO]], uturn: true })
          expect(route.points.length, `${h} ${across}`).toBeGreaterThanOrEqual(4)
          oneUturn(route, 1, 300 + across / 2, 8)
        }
      }
    })

    it('is one U-turn to the left, drawn the other way, in the same way', async () => {
      for (const h of HEADINGS) {
        for (const across of [3, 8, 12, 16, 20, 25]) {
          const { route } = await draw(h, { road: OUT }, { road: [[-across, 300], [-across, BACK_TO]], uturn: true })
          oneUturn(route, -1, 300 + across / 2, 8)
        }
      }
    })

    it('is one U-turn when the other carriageway is joined on a slant, ahead of the end of the first or behind it', async () => {
      for (const h of HEADINGS) {
        for (const across of [10, 16, 25]) {
          for (const skew of [-10, -5, 5, 10]) {
            for (const way of [1, -1] as const) {
              const x = way * across
              const { route } = await draw(h, { road: OUT }, { road: [[x, 300 + skew], [x, BACK_TO]], uturn: true })
              oneUturn(route, way, 300 + across / 2, 10)
            }
          }
        }
      }
    })

    it('is one U-turn when the road back is long and curves gently, and ends at a tap well along', async () => {
      for (const h of HEADINGS) {
        // The far carriageway bends away by 20 degrees over the next 340 m or so (a radius of a kilometre): a curve, not a turn.
        const back: Spot[] = [[16, 300], [16, 100], ...bend([16, 100], 180, 20, 1000, 20)]
        const { route } = await draw(h, { road: OUT }, { road: back, uturn: true })
        oneUturn(route, 1, 316, 8)
      }
    })
  })

  describe('where the way back is the same road', () => {
    it('is one U-turn when the road snaps to the same place and turns back, whether or not the first point is kept', async () => {
      for (const h of HEADINGS) {
        // Less than 2 m from the end of the route is the same place, and is not added; a few metres is a point of its own.
        for (const jog of [0, 0.4, 1.5, 3, 5]) {
          const { route } = await draw(h, { road: OUT }, { road: [[jog, 300], [jog, BACK_TO]], uturn: true })
          oneUturn(route, 0, 300, 6)
        }
      }
    })

    it('is one U-turn when the way back is a few degrees off the way out, from a tap that is not exactly on the road', async () => {
      for (const h of HEADINGS) {
        for (const end of [[2, BACK_TO], [-3, BACK_TO], [6, 60], [-8, 20]] as Spot[]) {
          const { route } = await draw(h, { road: OUT }, { road: [[0.3, 300], end], uturn: true })
          oneUturn(route, 0, 300, 6)
        }
      }
    })
  })

  describe('with the rest of the route around it', () => {
    it('is the only U-turn on a road that is driven on afterwards, with the next corner after it', async () => {
      for (const h of HEADINGS) {
        for (const across of [0.4, 8, 16, 25]) {
          // Back down the far carriageway to a junction, and left (the way back is heading the other way, so that is to the east in the driver's frame).
          const { route } = await draw(
            h,
            { road: OUT },
            { road: [[across, 300], [across, BACK_TO]], uturn: true },
            { road: [[across, BACK_TO], [across + 250, BACK_TO]] },
          )
          expect(kinds(route), `${h} ${across}`).toEqual(['uturn', 'turn'])
          const [u, corner] = routeTurns(route.points)
          expect(near(u.at, 300 + across / 2, 8)).toBe(true)
          expect(corner.angle).toBeLessThan(0)
          expect(near(corner.angle, -90, 8)).toBe(true)
        }
      }
    })

    it('is the only U-turn after a corner earlier on the road, and keeps that corner', async () => {
      for (const h of HEADINGS) {
        for (const across of [0.4, 12, 25]) {
          // A left turn at the foot of the road, and then the same road out and back.
          const { route } = await draw(
            h,
            { road: [[-250, 0], [0, 0], [0, 300]] },
            { road: [[across, 300], [across, BACK_TO]], uturn: true },
          )
          expect(kinds(route), `${h} ${across}`).toEqual(['turn', 'uturn'])
          const [corner, u] = routeTurns(route.points)
          expect(corner.angle).toBeLessThan(0)
          expect(near(corner.at, 250, 6)).toBe(true)
          expect(near(u.at, 550 + across / 2, 8)).toBe(true)
        }
      }
    })

    it('finds a U-turn at each end of a road driven out, back and out again', async () => {
      for (const h of HEADINGS) {
        for (const across of [0.4, 8, 20]) {
          const { route } = await draw(
            h,
            { road: OUT },
            { road: [[across, 300], [across, 0]], uturn: true },
            { road: [[0, 0], [0, 300]], uturn: true },
          )
          const turns = routeTurns(route.points)
          expect(turns.map((t) => turnKind(t.angle)), `${h} ${across}`).toEqual(['uturn', 'uturn'])
          // The first is a quarter of the way along these, the second is where the route has been 300 + across + 300 on.
          expect(near(turns[0].at, 300 + across / 2, 8)).toBe(true)
          expect(near(turns[1].at, 600 + across + across / 2, 12)).toBe(true)
        }
      }
    })

    it('is the only turn found when the road out bends gently before it, and the way back leaves at an angle to where the route started', async () => {
      for (const h of HEADINGS) {
        // Out 150 m straight and then round a bend of 25 degrees (a radius of 700 m), which is too gradual to be a turn.
        const out: Spot[] = [[0, 0], [0, 150], ...bend([0, 150], 0, 25, 700, 12)]
        const end = out[out.length - 1]
        // The other carriageway is 12 m to the right of the road as it ends, and the way back runs straight down it, heading the opposite way to the road's end.
        const across = ahead(end, 25 + 90, 12)
        const { route } = await draw(h, { road: out }, { road: [across, ahead(across, 25 + 180, 170)], uturn: true })
        oneUturn(route, 1, 150 + 700 * rad(25) + 6, 10)
      }
    })
  })

  describe('the request for it', () => {
    it('holds the road to leaving the way the route arrived, whichever way that was, and only for the tap that asks', async () => {
      for (const h of HEADINGS) {
        const { urls } = await draw(
          h,
          { road: OUT },
          { road: [[16, 300], [16, BACK_TO]], uturn: true },
          { road: [[16, BACK_TO], [200, BACK_TO]] },
        )
        expect(urls).toHaveLength(3)
        // No bearings for the first road, and none for the one after the U-turn.
        expect(bearingsOf(urls[0])).toBeNull()
        expect(bearingsOf(urls[2])).toBeNull()
        // For the U-turn, the opposite of the way the route arrived (the heading, to the nearest whole degree), and the range around it.
        expect(bearingsOf(urls[1])).toBe(`${(h + 180) % 360},${UTURN_RANGE_DEG};`)
      }
    })

    it('arrives at the bearing the first stretch was driven on', async () => {
      for (const h of HEADINGS) {
        const { route } = await draw(h, { road: OUT })
        const arrived = arrivalBearing(route.points)!
        const wanted = bearing(spot(h, [0, 0]), spot(h, [0, 300]))
        expect(Math.abs(((arrived - wanted + 540) % 360) - 180)).toBeLessThan(0.5)
      }
    })
  })
})

describe('a loop round a block is not a U-turn', () => {
  it('is turns, and no U-turn, when the road service goes round the block to come back to the road', async () => {
    for (const h of HEADINGS) {
      // Without a U-turn asked for, the service takes the nearest legal way back: on to the next street, right, right again on the street behind, and right again back onto the road.
      for (const side of [50, 80, 150]) {
        const { route } = await draw(
          h,
          { road: OUT },
          { road: [[0, 300], [0, 330], [side, 330], [side, BACK_TO], [0, BACK_TO]] },
          { road: [[0, BACK_TO], [0, -100]] },
        )
        const turns = routeTurns(route.points)
        expect(turns.map((t) => Math.round(t.angle / 10) * 10), `${h} ${side}`).toEqual([90, 90, 90, -90])
        expect(kinds(route)).toEqual(['turn', 'turn', 'turn', 'turn'])
        expect(turns.some((t) => turnKind(t.angle) === 'uturn')).toBe(false)
      }
    }
  })

  it('is four turns, and no U-turn, when it goes round a block and out on the same road the same way', async () => {
    for (const h of HEADINGS) {
      for (const side of [60, 100, 150]) {
        const { route } = await draw(h, { road: [[0, 0], [0, 200]] }, { road: [[0, 200], [side, 200], [side, 200 - side], [0, 200 - side], [0, 400]] })
        const turns = routeTurns(route.points)
        expect(turns.map((t) => Math.round(t.angle / 10) * 10), `${h} ${side}`).toEqual([90, 90, 90, 90])
        expect(turns.some((t) => turnKind(t.angle) === 'uturn')).toBe(false)
      }
    }
  })

  it('is two turns, and no U-turn, when the way back is on the next street along, a block away', async () => {
    for (const h of HEADINGS) {
      for (const across of [45, 60, 100]) {
        const { route } = await draw(h, { road: OUT }, { road: [[0, 300], [across, 300], [across, BACK_TO]] })
        expect(kinds(route), `${h} ${across}`).toEqual(['turn', 'turn'])
      }
    }
  })
})

describe('a road that curves round is not a U-turn', () => {
  /** A road: 300 m straight out, then a bend to the right of `degrees` on `radius` metres (the road service gives a point every 10 m or so), then 300 m on. */
  const curving = (radius: number, degrees: number, flip: 1 | -1): Spot[] => {
    const out: Spot[] = [[0, 0], [0, 300]]
    const round = bend([0, 300], 0, degrees, radius, Math.ceil((rad(degrees) * radius) / 10))
    const end = round[round.length - 1]
    return [...out, ...round, ahead(end, degrees, 300)].map(([x, y]): Spot => [flip * x, y])
  }

  it('is no U-turn and no sharp turn when the service answers with a crescent, whichever way round it goes', async () => {
    for (const h of HEADINGS) {
      for (const flip of [1, -1] as const) {
        for (const radius of [80, 100, 140]) {
          for (const degrees of [150, 180, 210, 300]) {
            const { route } = await draw(h, { road: curving(radius, degrees, flip) })
            const sharp = routeTurns(route.points).filter((t) => Math.abs(t.angle) >= 130)
            expect(sharp, `${h} ${flip} ${radius} ${degrees}`).toEqual([])
          }
        }
      }
    }
  })

  it('is not a U-turn when a street turns off a road onto the crescent, with the street straight on to it or a few metres of its own', async () => {
    for (const h of HEADINGS) {
      for (const radius of [84, 100]) {
        for (const degrees of [120, 150, 180]) {
          for (const along of [1, 21]) {
            // Out 300 m, a corner to the right, 0 or 20 m along the street, and then the street curves right round a crescent.
            const street: Spot[] = [[0, 0], [0, 300], [along, 300], ...bend([along, 300], 90, degrees, radius, Math.ceil((rad(degrees) * radius) / 10))]
            const end = street[street.length - 1]
            const { route } = await draw(h, { road: [...street, ahead(end, 90 + degrees, 300)] })
            const turns = routeTurns(route.points)
            expect(turns.filter((t) => Math.abs(t.angle) >= 130), `${h} ${radius} ${degrees} ${along}`).toEqual([])
            expect(turnKind(turns[0].angle)).toBe('turn')
            expect(near(turns[0].at, 300, 8)).toBe(true)
          }
        }
      }
    }
  })

  it('is still a U-turn when the road is tight enough: a half circle on a radius of 20 m', async () => {
    for (const h of HEADINGS) {
      const { route } = await draw(h, { road: curving(20, 180, 1) })
      expect(kinds(route), `${h}`).toEqual(['uturn'])
    }
  })
})
