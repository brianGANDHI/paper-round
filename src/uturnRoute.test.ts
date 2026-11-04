import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bearing, haversine, sideAt } from './geo'
import { guidedTurn } from './guidance'
import { pushTrail, trailHeading, type TrailPoint } from './heading'
import { advance, makeTrack, type Progress } from './progress'
import {
  arrivalBearing,
  extendAlongRoads,
  rate,
  TIMEOUT_MS,
  undoStretch,
  UTURN_NO_ROAD_NOTICE,
  UTURN_RANGE_DEG,
  UTURN_UNREACHED_NOTICE,
  type Extension,
} from './roads'
import { appendPoint, appendPoints, routeLength } from './routeEdit'
import { guidanceToShow } from './transitView'
import { onTheRoute, readsAsUturnAt, routeTurns, TURN_PASSED_M, turnKind } from './turns'
import type { Pt, Route, Side } from './types'
import { drawUturn, localUturn, UTURN_ACROSS_M, UTURN_BEHIND_M, UTURN_RUN_M, type DrawnUturn, type UturnSize } from './uturnShape'

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

    it('is the turn into a short court, the U-turn at its end and the turn out, when the road runs in and straight back out, whichever way it goes on', async () => {
      // A tap on the end of a court 8 to 16 m deep, and then one on the road further on, or back the way it came: the road service runs the second road
      // straight back out of the court from its end. The corner in, the reversal and the corner out were one swing, read as no turn at all or one U-turn.
      for (const h of HEADINGS) {
        for (const start of [0, 1.25, 2.5, 3.75]) {
          for (const gap of [8, 10, 12, 16]) {
            for (const turn of [1, -1] as const) {
              for (const on of [true, false]) {
                const court: Spot = [turn * gap, 100]
                const { route } = await draw(h, { road: [[0, -start], [0, 100], court] }, { road: [court, [0, 100], [0, on ? 250 : -100]] })
                const read = routeTurns(route.points).map((t) => [turnKind(t.angle), Math.sign(t.angle)])
                expect(read, `${h} ${start} ${gap} ${turn} ${on}`).toEqual([['turn', turn], ['uturn', 1], ['turn', on ? turn : -turn]])
              }
            }
          }
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

/**
 * The U-turn drawn on the spot (the U-turn here button, and what stands in when the road service gives none): how `routeTurns` reads
 * it, whatever follows it, how the round tracks a car that turns round on it, and what a failed lookup draws instead of a straight line.
 */

/** Where the driver frame of a route is for a map point: the opposite of `spot`. */
const frame = (h: number, p: Pt): Spot => {
  const east = (p.lng - ORIGIN.lng) * M_PER_DEG * Math.cos(rad(ORIGIN.lat))
  const north = (p.lat - ORIGIN.lat) * M_PER_DEG
  return [east * Math.cos(rad(h)) - north * Math.sin(rad(h)), east * Math.sin(rad(h)) + north * Math.cos(rad(h))]
}

const EMPTY: Route = { points: [], sideChanges: [], stops: [] }
/** A route through these places, thrown on both sides. */
const routeAlong = (h: number, spots: Spot[]): Route => appendPoints(EMPTY, spots.map((s) => spot(h, s)), 'both')

/** Every ten degrees round the compass. */
const ALL_HEADINGS = Array.from({ length: 36 }, (_, i) => i * 10)

type Ending = 'end' | 'resume' | 'jog'
const ENDINGS: Ending[] = ['end', 'resume', 'jog']

/**
 * The road out and then the U-turn, and what the route does after it: nothing (it ends at the shape), the road service resuming from the end
 * of the shape and running back 150 m (the next tap), or resuming snapped onto the centreline, a jog of the shape's width across first.
 */
function withShape(h: number, turn: 1 | -1, size: Partial<UturnSize> = {}, ending: Ending = 'end', out: Spot[] = dense(20, ...OUT)): Route {
  const route = routeAlong(h, out)
  const shape = localUturn(route.points, turn, size)!
  let points = [...route.points, ...shape]
  if (ending !== 'end') {
    const c = frame(h, shape[2])
    const tail: Spot[] = ending === 'resume' ? dense(20, c, [c[0], c[1] - 150]) : dense(20, c, [0, c[1]], [0, c[1] - 150])
    points = [...points, ...tail.slice(1).map((s) => spot(h, s))]
  }
  return { ...route, points }
}

describe('a U-turn drawn on the spot', () => {
  describe('is read as one U-turn, the way it goes round, just past the end of the road', () => {
    it('whichever way the road runs, to the right or the left, whatever the road does next', () => {
      for (const h of ALL_HEADINGS) {
        for (const turn of [1, -1] as const) {
          for (const ending of ENDINGS) {
            const route = withShape(h, turn, {}, ending)
            const turns = routeTurns(route.points)
            expect(turns.map((t) => turnKind(t.angle)), `${h} ${turn} ${ending}`).toEqual(['uturn'])
            expect(Math.sign(turns[0].angle), `${h} ${turn} ${ending}`).toBe(turn)
            // The middle of the box is 8 to 9 m past the old end; the rest is the 5 m sampling.
            const past = turns[0].at - 300
            if (ending === 'jog') expect(past, `${h} ${turn}`).toBeGreaterThan(10)
            else expect(past > 5 && past < 11, `${h} ${turn} ${ending}: ${past}`).toBe(true)
          }
        }
      }
    })

    it('whatever size from 6 to 8 m on, 2 to 7 m across and 3 to 8 m back', () => {
      let shapes = 0
      for (const h of [0, 37, 90, 200, 315, 359]) {
        for (const run of [UTURN_RUN_M, 7, 8]) {
          for (const across of [2, 3, 4, 5, 6, 7]) {
            for (const behind of [3, 5, UTURN_BEHIND_M]) {
              for (const turn of [1, -1] as const) {
                for (const ending of ENDINGS) {
                  const turns = routeTurns(withShape(h, turn, { run, across, behind }, ending).points)
                  expect(turns.map((t) => turnKind(t.angle)), `${h} ${run} ${across} ${behind} ${turn} ${ending}`).toEqual(['uturn'])
                  expect(Math.sign(turns[0].angle)).toBe(turn)
                  shapes++
                }
              }
            }
          }
        }
      }
      expect(shapes).toBe(6 * 3 * 6 * 3 * 2 * 3)
    })

    it('with a run of 6 m, which is the least that is always seen: the last piece of the road is 5 m, and a shorter run goes unnoticed', () => {
      const reads = (run: number) => {
        let n = 0
        for (const h of ALL_HEADINGS) {
          for (const across of [3, 5, 7]) {
            for (const behind of [3, 8]) {
              for (const turn of [1, -1] as const) {
                const turns = routeTurns(withShape(h, turn, { run, across, behind }).points)
                if (turns.length === 1 && turnKind(turns[0].angle) === 'uturn' && Math.sign(turns[0].angle) === turn) n++
              }
            }
          }
        }
        return n
      }
      expect(reads(UTURN_RUN_M)).toBe(36 * 3 * 2 * 2)
      expect(reads(3)).toBeLessThan(36 * 3 * 2 * 2)
    })

    it('after a corner too: a turn and then a U-turn, in order', () => {
      for (const h of ALL_HEADINGS) {
        for (const corner of [1, -1] as const) {
          // 200 m, a corner to the right or left, and 80 m along the street to the end.
          const out: Spot[] = [...dense(20, [0, 0], [0, 200]), ...dense(20, [0, 200], [corner * 80, 200]).slice(1)]
          const route = routeAlong(h, out)
          const full = { ...route, points: [...route.points, ...localUturn(route.points)!] }
          expect(kinds(full), `${h} ${corner}`).toEqual(['turn', 'uturn'])
        }
      }
    })

    it('and the next corner after the road resumes, as two cards', () => {
      for (const h of ALL_HEADINGS) {
        const route = withShape(h, 1, {}, 'resume')
        const c = frame(h, route.points[route.points.length - 1])
        // On down the road 150 m from the U-turn, and a left turn there (the way back is heading the other way, so east in the driver's frame).
        const full = { ...route, points: [...route.points, ...dense(20, c, [c[0] + 150, c[1]]).slice(1).map((s) => spot(h, s))] }
        const turns = routeTurns(full.points)
        expect(turns.map((t) => turnKind(t.angle)), `${h}`).toEqual(['uturn', 'turn'])
        expect(turns[0].angle).toBeGreaterThan(0)
        expect(turns[1].angle).toBeLessThan(0)
      }
    })

    it('twice over, out and back and out again, a U-turn at each end', () => {
      for (const h of ALL_HEADINGS) {
        const first = drawUturn(routeAlong(h, dense(20, ...OUT)), 'both')!
        const c = frame(h, first.route.points[first.route.points.length - 1])
        // The road resumes and runs back to the foot of it, and a U-turn is drawn there too.
        const back = appendPoints(first.route, dense(20, c, [c[0], 0]).slice(1).map((s) => spot(h, s)), 'both')
        const second = drawUturn(back, 'both')!
        const turns = routeTurns(second.route.points)
        expect(turns.map((t) => turnKind(t.angle)), `${h}`).toEqual(['uturn', 'uturn'])
        expect(turns.every((t) => t.angle > 0)).toBe(true)
        expect(turns[1].at).toBeGreaterThan(turns[0].at + 280)
      }
    })
  })

  describe('with a corner just before the end', () => {
    /** `at` m (200 unless given), a corner (right if `corner` is 1) and `after` m on, with the U-turn drawn at the end as the button does. */
    const afterCorner = (h: number, corner: 1 | -1, after: number, size: Partial<UturnSize> = {}, at = 200): Route => {
      const route = routeAlong(h, [...dense(20, [0, 0], [0, at]), [corner * after, at]])
      return { ...route, points: [...route.points, ...localUturn(route.points, 1, size)!] }
    }
    /** The card's kind and way round for each turn, in order. */
    const read = (route: Route) => routeTurns(route.points).map((t) => [turnKind(t.angle), Math.sign(t.angle)] as const)

    it('is a turn and a U-turn, in order, from 3.5 m to 14 m after the corner, a right or a left', () => {
      for (const h of [0, 37, 90, 200, 315]) {
        for (const corner of [1, -1] as const) {
          for (const after of [3.5, 4, 5, 6, 8, 10, 12, 14, 16, 20, 30]) {
            const turns = routeTurns(afterCorner(h, corner, after).points)
            expect(turns.map((t) => turnKind(t.angle)), `${h} ${corner} ${after}`).toEqual(['turn', 'uturn'])
            expect(Math.sign(turns[0].angle)).toBe(corner)
            expect(Math.sign(turns[1].angle)).toBe(1)
            expect(Math.abs(turns[0].angle)).toBeGreaterThan(75)
            expect(Math.abs(turns[0].angle)).toBeLessThan(105)
          }
        }
      }
    })

    it('is a turn and a U-turn wherever the corner falls on the 5 m pieces the route is read in, and not only at the end of one', () => {
      // A corner between the ends of two pieces is spread over both, and so is the U-turn: two swings 15 m apart are one, so the gap is that and up to 5 m at each end.
      for (const h of [0, 37, 90, 200, 315]) {
        for (const corner of [1, -1] as const) {
          for (const off of [0.25, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]) {
            for (const after of [3.5, 5, 8, 10, 12, 15, 16, 18, 20]) {
              expect(read(afterCorner(h, corner, after, {}, 200 + off)), `${h} ${corner} ${off} ${after}`).toEqual([['turn', corner], ['uturn', 1]])
            }
          }
        }
      }
    })

    it('is a turn and a U-turn after a corner rounded off on a radius of 6 m, with a point every 2 m', () => {
      for (const h of [0, 37, 90, 200, 315]) {
        for (const corner of [1, -1] as const) {
          for (const off of [0, 1, 2, 3, 4]) {
            for (const after of [3.5, 5, 8, 12, 16]) {
              // 200 m and a bit, round the corner in 5 pieces of 1.9 m, and `after` m along the street.
              const arc = bend([0, 200 + off], 0, 90, 6, 5)
              const end = arc[arc.length - 1]
              const out = [...dense(20, [0, 0], [0, 200 + off]), ...arc, [end[0] + after, end[1]] as Spot].map(([x, y]): Spot => [corner * x, y])
              const route = routeAlong(h, out)
              const full = { ...route, points: [...route.points, ...localUturn(route.points)!] }
              expect(read(full), `${h} ${corner} ${off} ${after}`).toEqual([['turn', corner], ['uturn', 1]])
            }
          }
        }
      }
    })

    it('is a turn, a U-turn and the turn out when the next taps are straight lines back out to the road before the corner, at the junction or far along it', { timeout: 60_000 }, () => {
      // Follow roads off, or the road service out of reach: a turn off the road into a side street, the end of the route a few metres along it, U-turn here,
      // and a tap at the junction and then one on the road 120 m on or back, or that far tap alone, each a straight line. The way back stops short just after
      // the corner (see `uturnBehind`), and when it was shorter than 26 m its second corner and the turn out were read as one swing: a right turn in, the
      // junction and 120 m on read 'Turn right, Turn left' for 'Turn right, U-turn, Turn right'. The box goes on further now, so the way back is 26 m.
      let n = 0
      for (const angle of [60, 80, 90, 100, 120]) {
        for (const back of [3.5, 4, 4.5, 5, 6, 8, 10, 12]) {
          for (let h = 0; h < 360; h += 30) {
            for (const start of [0, 1.25, 2.5, 3.75]) {
              for (const turn of [1, -1] as const) {
                for (const on of [true, false]) {
                  // The side street, from the corner at 200 m on the first road.
                  const way: Spot = [Math.sin(rad(turn * angle)), Math.cos(rad(turn * angle))]
                  const box = drawUturn(routeAlong(h, [...dense(20, [0, -start], [0, 200]), [back * way[0], 200 + back * way[1]]]), 'both')!
                  const far: Spot = [0, on ? 320 : 80]
                  const turnOut = turn * (on ? 180 - angle : -angle)
                  for (const taps of [[[0, 200], far], [far]] as Spot[][]) {
                    const route = appendPoints(box.route, taps.map((s) => spot(h, s)), 'both')
                    expect(read(route), `${angle} ${back} ${h} ${start} ${turn} ${on} ${taps.length}`).toEqual([
                      [turnKind(turn * angle), turn],
                      ['uturn', 1],
                      [turnKind(turnOut), Math.sign(turnOut)],
                    ])
                    n++
                  }
                }
              }
            }
          }
        }
      }
      expect(n).toBe(5 * 8 * 12 * 4 * 2 * 2 * 2)
    })

    it('is two U-turns when the button is pressed twice: the second starts far enough on from the first one\'s corners', () => {
      for (const h of ALL_HEADINGS) {
        // The road starts part way along a 5 m piece, so the U-turns fall anywhere on the pieces.
        for (const start of [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]) {
          const first = drawUturn(routeAlong(h, dense(20, [0, start], [0, 300])), 'both')!
          const second = drawUturn(first.route, 'both')!
          expect(read(second.route), `${h} ${start}`).toEqual([['uturn', 1], ['uturn', 1]])
        }
      }
    })

    it('is a U-turn alone when the corner is under 3 m back: the same place', () => {
      for (const h of [0, 90, 215]) {
        for (const corner of [1, -1] as const) {
          for (const after of [1, 2]) {
            const turns = routeTurns(afterCorner(h, corner, after).points)
            expect(turns.map((t) => turnKind(t.angle)), `${h} ${corner} ${after}`).toEqual(['uturn'])
          }
        }
      }
    })

    it('would be one turn the wrong way round if the U-turn still started 6 m on: a right corner 8 to 12 m back, and a right U-turn', () => {
      // Why the run is longer after a corner: this is what the same route reads as without it.
      for (const h of [0, 37, 90, 200, 315]) {
        for (const after of [8, 10, 12]) {
          const turns = routeTurns(afterCorner(h, 1, after, { run: UTURN_RUN_M }).points)
          expect(turns.map((t) => turnKind(t.angle)).includes('uturn'), `${h} ${after}`).toBe(false)
          expect(turns, `${h} ${after}`).toHaveLength(1)
          expect(turns[0].angle).toBeLessThan(0)
        }
      }
    })
  })
})

/**
 * The tap after a U-turn drawn on the spot, with Follow roads on. The U-turn ends 5 m to the side of the road, and the road service snaps that onto the
 * middle of the road: the road for the tap then takes the place of the U-turn's way back, from its first point, rather than jogging back across to it.
 */
describe('the road drawn on from a U-turn drawn on the spot', () => {
  /** A place as the road service gives it: six-figure coordinates. */
  const sixFigures = (p: Pt): Pt => ({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) })
  /** The road out, 300 m as the road service gives it, thrown on `side`: `start` m more of it at the start moves where the U-turn falls on the 5 m pieces the route is read in. */
  const roadOut = (h: number, start = 0, side: Side = 'both'): Route => appendPoints(EMPTY, dense(20, [0, -start], [0, 300]).map((s) => sixFigures(spot(h, s))), side)

  /** The next tap with Follow roads on, the road service answering with a road through these places: the first is where it put the end of the route. */
  async function tapRoad(h: number, route: Route, road: Spot[], side: Side = 'both'): Promise<Extension> {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(answer(h, ...road)), { status: 200, headers: { 'content-type': 'application/json' } }))))
    return extendAlongRoads(route, spot(h, road[road.length - 1]), side)
  }

  /** Where the U-turn's way back ends, 5 m to the right of the road and 8 m behind its end, snapped onto the middle of the road. */
  const SNAPPED: Spot = [0, 300 - UTURN_BEHIND_M]
  /** The road from there: back down it `d` m, and round a bend of `deg` degrees (positive to the right as it is driven back, the left of the way out) for 100 m. */
  const roadBack = (d: number, deg: number): Spot[] => {
    const corner: Spot = [0, SNAPPED[1] - d]
    return [SNAPPED, corner, ahead(corner, 180 + deg, 100)]
  }
  const STARTS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]

  it('goes on from the U-turn\'s first point straight back down the road, and the turn and the way back of the U-turn are what it replaced', async () => {
    for (const h of [0, 37, 90, 200, 315]) {
      const box = drawUturn(roadOut(h), 'both')!
      const [a, b, c] = box.added
      const done = await tapRoad(h, box.route, roadBack(100, 0))
      expect(done.notice).toBeNull()
      // The road is all there, from where the road service put the end of the U-turn: on the line the route came in on, 14 m back from the first point.
      expect(done.added[0], `${h}`).toEqual(sixFigures(spot(h, SNAPPED)))
      expect(done.route.points, `${h}`).toEqual([...box.route.points.slice(0, -2), ...done.added])
      expect(done.route.points[done.route.points.length - done.added.length - 1]).toEqual(a)
      expect(haversine(a, done.added[0])).toBeCloseTo(UTURN_RUN_M + UTURN_BEHIND_M, 0)
      expect(done.replaced, `${h}`).toEqual([
        { point: b, side: 'both' },
        { point: c, side: 'both' },
      ])
    }
  })

  it('is the same after a U-turn along the road that could not be found, which draws the same U-turn', async () => {
    const out = roadOut(37)
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 'NoSegment' }), { status: 400, headers: { 'content-type': 'application/json' } }))))
    const failed = await extendAlongRoads(out, spot(37, [14, 200]), 'both', { uturnFrom: arrivalBearing(out.points) ?? undefined })
    expect(failed.notice).toBe(UTURN_NO_ROAD_NOTICE)
    const done = await tapRoad(37, failed.route, roadBack(100, 0))
    expect(done.route.points).toEqual([...out.points, failed.added[0], ...done.added])
    expect(Array.isArray(done.replaced) && done.replaced.map((t) => t.point)).toEqual(failed.added.slice(1))
  })

  it('is a U-turn and then the corner, a right or a left, from 5 to 25 m on, wherever the U-turn falls on the pieces', async () => {
    for (const h of [0, 37, 90, 200, 315]) {
      for (const start of STARTS) {
        for (const d of [5, 10, 15, 20, 25]) {
          for (const corner of [1, -1] as const) {
            const done = await tapRoad(h, drawUturn(roadOut(h, start), 'both')!.route, roadBack(d, corner * 90))
            const read = routeTurns(done.route.points).map((t) => [turnKind(t.angle), Math.sign(t.angle)])
            expect(read, `${h} ${start} ${d} ${corner}`).toEqual([['uturn', 1], ['turn', corner]])
          }
        }
      }
    }
  })

  it('is a U-turn and no more for a bend of 20 or 30 degrees either way 10 to 25 m on, and a U-turn and a bear for one of 45', { timeout: 60_000 }, async () => {
    for (const h of [0, 37, 90, 200, 315]) {
      for (const start of STARTS) {
        for (const d of [10, 15, 20, 25]) {
          for (const deg of [20, -20, 30, -30, 45, -45]) {
            const done = await tapRoad(h, drawUturn(roadOut(h, start), 'both')!.route, roadBack(d, deg))
            const read = routeTurns(done.route.points).map((t) => [turnKind(t.angle), Math.sign(t.angle)])
            expect(read, `${h} ${start} ${d} ${deg}`).toEqual(Math.abs(deg) < 40 ? [['uturn', 1]] : [['uturn', 1], ['bear', Math.sign(deg)]])
          }
        }
      }
    }
  })

  it('is one U-turn to the right, as the U-turn was drawn, straight back down the road, whichever way it runs and wherever the U-turn falls', { timeout: 60_000 }, async () => {
    for (let h = 0; h < 360; h += 3) {
      for (const start of STARTS) {
        const done = await tapRoad(h, drawUturn(roadOut(h, start), 'both')!.route, roadBack(150, 0))
        const turns = routeTurns(done.route.points)
        expect(turns.map((t) => turnKind(t.angle)), `${h} ${start}`).toEqual(['uturn'])
        expect(turns[0].angle, `${h} ${start}`).toBeGreaterThan(0)
      }
    }
  })

  it('keeps the jog where the road curves through the U-turn, and goes straight back only where the turns read that as the same U-turn', async () => {
    // The road out bends on a radius of 100 to 200 m over its last 28 m, either way, and the road back runs round the same bend. Straight back from the
    // U-turn's first point would then read as a U-turn the other way round, or as a sharp turn, for some places of the 5 m pieces; the jog never does.
    let replaced = 0
    let kept = 0
    for (const radius of [100, 150, 200]) {
      for (const way of [1, -1] as const) {
        for (let h = 0; h < 360; h += 30) {
          for (const start of [0, 1, 2, 2.5, 3, 4]) {
            const along = (s: number): Spot => (s < 0 ? [0, 200 + s] : [way * radius * (1 - Math.cos(s / radius)), 200 + radius * Math.sin(s / radius)])
            const bendPoints = Array.from({ length: 7 }, (_, i) => along(4 * (i + 1)))
            const out = appendPoints(EMPTY, [...dense(20, [0, -start], [0, 200]), ...bendPoints].map((s) => sixFigures(spot(h, s))), 'both')
            const box = drawUturn(out, 'both')!
            // The road service snaps the end of the U-turn onto the nearest place on the road, and the road runs back from there.
            const [cx, cy] = frame(h, box.added[2])
            const off = (s: number) => Math.hypot(along(s)[0] - cx, along(s)[1] - cy)
            let snapped = 0
            for (let s = -40; s <= 28; s += 0.05) if (off(s) < off(snapped)) snapped = s
            const road: Spot[] = [along(snapped)]
            for (let s = Math.ceil(snapped / 4) * 4 - 4; s > -150; s -= 4) road.push(along(s))
            const done = await tapRoad(h, box.route, road)
            const read = routeTurns(done.route.points)
              .filter((t) => t.at > 190)
              .map((t) => [turnKind(t.angle), Math.sign(t.angle)])
            expect(read, `${radius} ${way} ${h} ${start}`).toEqual([['uturn', 1]])
            if (Array.isArray(done.replaced)) replaced++
            else kept++
          }
        }
      }
    }
    // Most go straight back, where the bend is gentle enough; some keep the jog.
    expect(replaced).toBeGreaterThan(kept)
    expect(kept).toBeGreaterThan(0)
  })

  it('after a corner just before the end, the road back out to the road before it is a turn, a U-turn and a turn the right way', { timeout: 60_000 }, async () => {
    // A turn off the road into a side street, the end of the route a few metres along it, U-turn here, and a tap on the first road 120 m on or back. The road
    // service puts the end of the U-turn on the nearer of the two roads. The way back used to end 8 m behind, near the first road or across it, so it was put
    // there: the road started with a jog back to it, read as a second U-turn, as no U-turn, or with the turn out the wrong way.
    const cells: [number[], number[]][] = [
      [[75, 90, 105], [3.5, 4, 4.5, 5, 6, 8, 10, 12, 14, 16, 20]],
      [[60, 120, 135], [8, 10, 12, 14, 16, 20]],
    ]
    let n = 0
    for (const [angles, backs] of cells) {
      for (const angle of angles) {
        for (const back of backs) {
          for (let h = 0; h < 360; h += 30) {
            for (const start of [0, 1.25, 2.5, 3.75]) {
              for (const turn of [1, -1] as const) {
                for (const on of [true, false]) {
                  // The side street, from the corner at 200 m on the first road.
                  const way: Spot = [Math.sin(rad(turn * angle)), Math.cos(rad(turn * angle))]
                  const corner: Spot = [0, 200]
                  const out = appendPoints(EMPTY, [...dense(20, [0, -start], corner), [back * way[0], 200 + back * way[1]] as Spot].map((s) => sixFigures(spot(h, s))), 'both')
                  const box = drawUturn(out, 'both')!
                  // The road service puts the end of the U-turn on the nearest place of the first road or of the side street, and runs from there.
                  const [cx, cy] = frame(h, box.added[2])
                  const along = Math.max(0, cx * way[0] + (cy - 200) * way[1])
                  const onStreet: Spot = [along * way[0], 200 + along * way[1]]
                  const tap: Spot = [0, on ? 320 : 80]
                  const road: Spot[] = Math.abs(cx) <= Math.hypot(cx - onStreet[0], cy - onStreet[1]) ? [[0, cy], tap] : [onStreet, corner, tap]
                  const done = await tapRoad(h, box.route, road)
                  const read = routeTurns(done.route.points).map((t) => [turnKind(t.angle), Math.sign(t.angle)])
                  const turnOut = turn * (on ? 180 - angle : -angle)
                  const label = `${angle} ${back} ${h} ${start} ${turn} ${on}`
                  expect(read, label).toEqual([[turnKind(turn * angle), turn], ['uturn', 1], [turnKind(turnOut), Math.sign(turnOut)]])
                  expect(Array.isArray(done.replaced), label).toBe(true)
                  n++
                }
              }
            }
          }
        }
      }
    }
    expect(n).toBe((3 * 11 + 3 * 6) * 12 * 4 * 2 * 2)
  })

  /** The road out through these places, as the road service gives it, and the tap back down it to `back`: the road starts where the U-turn's end is nearest the road out. */
  async function kinked(h: number, out: Spot[], back: Spot): Promise<{ box: DrawnUturn; done: Extension }> {
    const box = drawUturn(appendPoints(EMPTY, dense(20, ...out).map((s) => sixFigures(spot(h, s))), 'both'), 'both')!
    const [cx, cy] = frame(h, box.added[2])
    let best = { at: out[0], leg: 0, off: Infinity }
    for (let i = 0; i + 1 < out.length; i++) {
      const [[ax, ay], [bx, by]] = [out[i], out[i + 1]]
      const t = Math.max(0, Math.min(1, ((cx - ax) * (bx - ax) + (cy - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
      const at: Spot = [ax + t * (bx - ax), ay + t * (by - ay)]
      if (Math.hypot(cx - at[0], cy - at[1]) < best.off) best = { at, leg: i, off: Math.hypot(cx - at[0], cy - at[1]) }
    }
    return { box, done: await tapRoad(h, box.route, [best.at, ...out.slice(1, best.leg + 1).reverse(), back]) }
  }

  it('goes straight back after a slight bend the same way a little before the end, which the turns join into the U-turn', async () => {
    // The road out bends 20 or 30 degrees to the right 18 to 28 m before the end. Straight back, the turns join that bend into the U-turn, and put the middle
    // of it 12 m or more short of where the route turns round: asked only of the turn whose middle was nearest, the route was not a U-turn there, and the jog
    // was kept, which now and then read as a U-turn and a bear or a turn the other way, or as a sharp turn.
    for (const kink of [20, 30]) {
      for (const q of [18, 23, 28]) {
        for (let h = 0; h < 360; h += 30) {
          for (const start of [0, 1.25, 2.5, 3.75]) {
            const { done } = await kinked(h, [[0, -start], [0, 200], ahead([0, 200], kink, q)], [0, 40])
            const label = `${kink} ${q} ${h} ${start}`
            expect(Array.isArray(done.replaced), label).toBe(true)
            expect(routeTurns(done.route.points).map((t) => [turnKind(t.angle), Math.sign(t.angle)]), label).toEqual([['uturn', 1]])
          }
        }
      }
    }
  })

  it('keeps the jog where the whole route would read the U-turn to the left, though every place the turns are asked at reads it to the right', async () => {
    // A slight bend to the left 2 to 5 m before the end, and the route falling on its 5 m pieces between two of the quarters of a metre that
    // `readsAsUturnAt` tries: straight back, the round would show the U-turn's arrow to the left.
    const cases: [number, number, number, number][] = [
      [-5, 2, 105, 4.75],
      [-5, 3, 285, 4],
      [-10, 4, 30, 3],
      [-10, 4, 225, 3],
      [-15, 5, 0, 2],
      [-15, 5, 240, 2],
    ]
    for (const [kink, q, h, start] of cases) {
      const label = `${kink} ${q} ${h} ${start}`
      const { box, done } = await kinked(h, [[0, -start], [0, 200], ahead([0, 200], kink, q)], [0, 40])
      // Drawn on from the U-turn's first point instead, the route reads right wherever its pieces are tried, and to the left as a whole.
      const base = { ...box.route, points: box.route.points.slice(0, -2) }
      const straightBack = appendPoints(base, done.added, 'both')
      const at = routeLength(base.points)
      expect(readsAsUturnAt(straightBack.points, at), label).toBe(true)
      expect(routeTurns(straightBack.points).map((t) => [turnKind(t.angle), Math.sign(t.angle)]), label).toEqual([['uturn', -1]])
      // So the jog is kept, and it reads as the U-turn it is.
      expect(done.replaced, label).toBeNull()
      expect(routeTurns(done.route.points).map((t) => [turnKind(t.angle), Math.sign(t.angle)]), label).toEqual([['uturn', 1]])
    }
  })

  it('throws the road on the side being drawn, and Undo of the tap gives the U-turn back as it was, sides and all', async () => {
    const sides: Side[] = ['both', 'left', 'right', 'transit']
    for (const was of sides) {
      for (const turned of sides) {
        for (const now of sides) {
          const out = roadOut(90, 0, was)
          const box = drawUturn(out, turned)!
          const done = await tapRoad(90, box.route, roadBack(100, 0), now)
          const first = done.route.points.length - done.added.length - 1
          // The run on past the end keeps the side of the road out, and the road back from the U-turn's first point is thrown on the side picked for it.
          expect(sideAt(done.route, first - 1), `${was} ${turned} ${now}`).toBe(was)
          expect(sideAt(done.route, first), `${was} ${turned} ${now}`).toBe(now)
          expect(done.replaced, `${was} ${turned} ${now}`).toEqual([
            { point: box.added[1], side: turned },
            { point: box.added[2], side: turned },
          ])
          const history = [
            { added: box.added, replaced: null },
            { added: done.added, replaced: done.replaced },
          ]
          const undone = undoStretch(done.route, history)!
          expect(undone.route, `${was} ${turned} ${now}`).toEqual(box.route)
          expect(undone.history).toEqual(history.slice(0, 1))
          expect(undoStretch(undone.route, undone.history)!.route, `${was} ${turned} ${now}`).toEqual(out)
        }
      }
    }
  })

  it('jogs across from the end of the U-turn as before when the road starts anywhere else, or the route does not end with one drawn on the spot', async () => {
    const h = 200
    const box = drawUturn(roadOut(h), 'both')!
    // A road snapped 1.5 m off the line, 3 m further back down it, or onto a street 7 m along from the end of the U-turn.
    for (const start of [[1.5, SNAPPED[1]], [0, SNAPPED[1] - 3], [UTURN_ACROSS_M, SNAPPED[1] - 7]] as Spot[]) {
      const done = await tapRoad(h, box.route, [start, [start[0], 100]])
      expect(done.replaced, `${start}`).toBeNull()
      expect(done.route.points.slice(0, box.route.points.length), `${start}`).toEqual(box.route.points)
    }
    // The same three points with the last moved a little, or a U-turn of another size drawn by hand, are no U-turn drawn on the spot.
    const out = roadOut(h)
    const moved: Route = { ...box.route, points: [...box.route.points.slice(0, -1), { ...box.added[2], lat: box.added[2].lat + 1e-6 }] }
    const narrow: Route = { ...out, points: [...out.points, ...localUturn(out.points, 1, { across: 4 })!] }
    for (const route of [moved, narrow]) {
      const done = await tapRoad(h, route, roadBack(100, 0))
      expect(done.replaced).toBeNull()
      expect(done.route.points.slice(0, route.points.length)).toEqual(route.points)
    }
  })
})

describe('a U-turn drawn on the spot is followed by the round', () => {
  /** A seeded random number generator, so a run is the same every time. */
  function random(seed: number) {
    let s = seed
    return () => {
      s = (s + 0x6d2b79f5) | 0
      let t = Math.imul(s ^ (s >>> 15), 1 | s)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const gaussian = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())

  /** The along of the nearest point to `p` on a polyline of driver-frame places. */
  function alongOn(poly: Spot[], p: Spot): number {
    let best = Infinity
    let along = 0
    let acc = 0
    for (let i = 0; i + 1 < poly.length; i++) {
      const [ax, ay] = poly[i]
      const [bx, by] = poly[i + 1]
      const len = Math.hypot(bx - ax, by - ay)
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / (len * len)))
      const d = Math.hypot(p[0] - (ax + t * (bx - ax)), p[1] - (ay + t * (by - ay)))
      if (d < best) {
        best = d
        along = acc + t * len
      }
      acc += len
    }
    return along
  }

  interface Result {
    drives: number
    /** Drives in which the tracker ever lost the car. */
    lost: number
    /** Drives in which the tracker put the car on the way out more than 40 m from where it was, 25 m or more after it turned round. */
    wrong: number
  }

  interface Car {
    /** The metres a second the car goes at 1 m/s plus this much for each metre from where it turns round, up to 10 (a ramp), or flat out at `crawl` for `plateau` metres. */
    plateau: number
    /** How many metres short of the end of the road the car turns round: negative is past it. */
    early: number
    noise: number
    seeds: number
  }

  /**
   * Drive cars past a route that is the road out, the U-turn drawn at its end and the road resumed from it, and count the drives the tracker
   * loses or puts on the wrong pass. The car drives the left lane of the road, turns round in a half ellipse 4 m deep and 3.6 m across (a crawl of
   * `plateau` metres at 1 m/s around the turn, then a ramp up to 10 m/s) and drives back down the right lane. It has a heading when it is going at 1.5 m/s or more,
   * from its course (15 degrees out), and the trail otherwise, as the app does. A fix is 1.5 times the noise out, the error carried over from fix to fix.
   * With `corner`, the road is 200 m, a corner to the right, and `corner` m on to the end, and the car turns round on that last leg. With `drawnOn`,
   * the next tap's road took the place of the U-turn's way back (see `extendAlongRoads`): the route goes on to the U-turn's first point and straight back.
   */
  function drives(car: Car, o: { headings: number[]; corner?: number; drawnOn?: boolean }): Result {
    const lane = 1.8
    const result: Result = { drives: 0, lost: 0, wrong: 0 }
    for (const h of o.headings) {
      const out: Spot[] = o.corner === undefined ? dense(20, ...OUT) : [...dense(20, [0, 0], [0, 200]), [o.corner, 200]]
      const route = routeAlong(h, out)
      const box = localUturn(route.points)!.map((p) => frame(h, p))
      // With `drawnOn`, the road was drawn on from the U-turn's first point instead, straight back down the middle of the road from where it put the end.
      const shape: Spot[] = o.drawnOn ? [box[0], [0, box[2][1]]] : box
      const c = shape[shape.length - 1]
      // The road resumes from the end of the U-turn: back down the other lane, and round the corner into the street if there is one.
      const tail: Spot[] =
        o.corner === undefined ? dense(20, c, [c[0], c[1] - 200]).slice(1) : [...dense(20, c, [0, c[1]]).slice(1), ...dense(20, [0, c[1]], [0, c[1] - 120]).slice(1)]
      const track = makeTrack([...out, ...shape, ...tail].map((s) => spot(h, s)))
      const outLen = out.reduce((len, p, i) => (i ? len + Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) : 0), 0)
      const shapeLen = shape.reduce((len, p, i) => len + Math.hypot(p[0] - (i ? shape[i - 1] : out[out.length - 1])[0], p[1] - (i ? shape[i - 1] : out[out.length - 1])[1]), 0)
      const back: Spot[] = [c, ...tail]
      for (let seed = 1; seed <= car.seeds; seed++) {
        // The car's own path, in the driver frame.
        const path: Spot[] = []
        let turnAt = 0
        if (o.corner === undefined) {
          const y0 = 300 - car.early
          path.push(...dense(4, [-lane, 0], [-lane, y0]))
          turnAt = path.length - 1
          for (let k = 1; k <= 8; k++) path.push([-lane * Math.cos((Math.PI * k) / 8), y0 + 4 * Math.sin((Math.PI * k) / 8)])
          path.push(...dense(4, [lane, y0], [lane, 100]).slice(1))
        } else {
          const x0 = o.corner - car.early
          path.push(...dense(4, [-lane, 0], [-lane, 200 + lane]), ...dense(4, [-lane, 200 + lane], [x0, 200 + lane]).slice(1))
          turnAt = path.length - 1
          for (let k = 1; k <= 8; k++) path.push([x0 + 4 * Math.sin((Math.PI * k) / 8), 200 + lane * Math.cos((Math.PI * k) / 8)])
          path.push(...dense(4, [x0, 200 - lane], [lane, 200 - lane]).slice(1), ...dense(4, [lane, 200 - lane], [lane, 100]).slice(1))
        }
        const truth = path.map((s) => spot(h, s))
        const cum = [0]
        for (let i = 1; i < truth.length; i++) cum.push(cum[i - 1] + haversine(truth[i - 1], truth[i]))
        const turnS = cum[turnAt] + 6
        const r = random(seed * 7919 + h)
        let err = [0, 0]
        let s = 0
        let clock = 0
        let progress: Progress | null = null
        let trail: TrailPoint[] = []
        let lost = false
        let wrong = false
        while (s <= cum[cum.length - 1]) {
          const d = Math.abs(s - turnS)
          const v = d <= car.plateau / 2 ? 1.0 : Math.min(10, 1.0 + (d - car.plateau / 2) * 0.3)
          let i = 0
          while (i < truth.length - 2 && cum[i + 1] < s) i++
          const t = Math.min(1, Math.max(0, (s - cum[i]) / (cum[i + 1] - cum[i])))
          const pos = { lat: truth[i].lat + (truth[i + 1].lat - truth[i].lat) * t, lng: truth[i].lng + (truth[i + 1].lng - truth[i].lng) * t }
          err = err.map((e) => 0.6 * e + 0.8 * gaussian(r) * car.noise)
          const fix = {
            lat: pos.lat + err[1] / M_PER_DEG,
            lng: pos.lng + err[0] / (M_PER_DEG * Math.cos(rad(ORIGIN.lat))),
            accuracy: Math.max(5, car.noise * 1.5),
            time: clock,
            speed: v >= 1.5 ? v : 0.3,
          }
          const course = v >= 1.5 ? (bearing(truth[i], truth[i + 1]) + gaussian(r) * 15 + 360) % 360 : null
          const before: Progress | null = progress
          progress = advance(track, progress, fix, course ?? trailHeading(trail, fix.accuracy))
          if (!progress) throw new Error('no progress')
          if (progress !== before) trail = pushTrail(trail, { lat: progress.at.lat, lng: progress.at.lng, time: progress.time ?? clock })
          if (progress.lost) lost = true
          // Once the car has been round and clear of the turn, it is on the way back, and the tracker has to be too.
          if (s > turnS + 25) {
            const where = alongOn(back, frame(h, pos))
            if (where > 15 && Math.abs(progress.along - (outLen + shapeLen + where)) > 40) wrong = true
          }
          s += v
          clock += 1000
        }
        result.drives++
        if (lost) result.lost++
        if (wrong) result.wrong++
      }
    }
    return result
  }

  it('after a car turns round at the end of the road, or 8 m past it, or up to 30 m short, crawling or not', () => {
    let n = 0
    for (const early of [-8, 0, 15, 30]) {
      for (const plateau of [0, 12, 18]) {
        for (const noise of [4, 8]) {
          const r = drives({ early, plateau, noise, seeds: 4 }, { headings: [0, 100, 215] })
          expect(r, `${early} ${plateau} ${noise}`).toEqual({ drives: 12, lost: 0, wrong: 0 })
          n += r.drives
        }
      }
    }
    expect(n).toBe(4 * 3 * 2 * 12)
  })

  it('after a car turns round there too when the road was drawn on from the U-turn\'s first point, straight back down the middle of the road', () => {
    for (const early of [-8, 0, 15, 30]) {
      for (const plateau of [0, 12, 18]) {
        for (const noise of [4, 8]) {
          const r = drives({ early, plateau, noise, seeds: 4 }, { headings: [0, 100, 215], drawnOn: true })
          expect(r, `${early} ${plateau} ${noise}`).toEqual({ drives: 12, lost: 0, wrong: 0 })
        }
      }
    }
  })

  it('after a corner 4 m before the end, where the U-turn starts 28 m on and its way back ends 2 m past the end, as after any other road', () => {
    for (const early of [0, 4]) {
      for (const plateau of [0, 12]) {
        const r = drives({ early, plateau, noise: 6, seeds: 4 }, { headings: [0, 100, 215], corner: 4 })
        expect(r, `${early} ${plateau}`).toEqual({ drives: 12, lost: 0, wrong: 0 })
      }
    }
  })

  /**
   * U-turn here a few metres into a side street off a road, and the next tap back out to the road before the corner, 120 m on up it or back the
   * way the car came: with Follow roads on (the road service puts the end of the U-turn on the side street, or on the road if that is nearer,
   * and the road out is drawn on from the U-turn's first point where it can be), or off (straight lines to the junction and on). The box goes on
   * 26 m or more past the corner (see `localUturn`), so the route turns round 30 to 40 m into the side street, while the driver turns round where
   * they tapped. Each fix goes through what Round does with one: the tracker (`advance`, with the phone's course, or the trail's heading when it
   * has none), whether the phone is on the route (`onTheRoute`), and the card (`guidanceToShow`, with what is behind the driver for good going
   * by the furthest reached), as courtGuidance.test.ts has it.
   */
  describe('after U-turn here a few metres into a side street, for a car that turns round there and drives back out to the road', () => {
    const sixFigures = (p: Pt): Pt => ({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) })
    /** The side street: `back` m along it from the corner at 200 m, `angle` degrees off the road, to the right (`turn` 1) or the left. */
    interface SideStreet {
      angle: number
      back: number
      turn: 1 | -1
      /** Out 120 m on up the road, or back the way the car came. */
      on: boolean
      h: number
      roads: boolean
    }
    const CORNER: Spot = [0, 200]
    const wayOf = (s: SideStreet): Spot => [Math.sin(rad(s.turn * s.angle)), Math.cos(rad(s.turn * s.angle))]

    /**
     * The route as the drawing screen draws it: the road and the side street, U-turn here, and the tap out on the road. With it, which of its points
     * is where the route itself turns round (the U-turn's first point, which the road out is drawn on from, or the box goes on across from).
     */
    async function drawn(s: SideStreet): Promise<{ route: Route; turnsAt: number }> {
      const way = wayOf(s)
      const out = appendPoints(EMPTY, [...dense(20, [0, -200], CORNER), [s.back * way[0], 200 + s.back * way[1]] as Spot].map((p) => sixFigures(spot(s.h, p))), 'both')
      const box = drawUturn(out, 'both')!
      const tap: Spot = [0, s.on ? 320 : 80]
      const turnsAt = out.points.length
      if (!s.roads) return { route: appendPoints(box.route, [CORNER, tap].map((p) => spot(s.h, p)), 'both'), turnsAt }
      // The road service puts the end of the U-turn on the nearest place of the road or of the side street, and runs from there.
      const [cx, cy] = frame(s.h, box.added[2])
      const along = Math.max(0, cx * way[0] + (cy - 200) * way[1])
      const onStreet: Spot = [along * way[0], 200 + along * way[1]]
      const road: Spot[] = Math.abs(cx) <= Math.hypot(cx - onStreet[0], cy - onStreet[1]) ? [[0, cy], tap] : [onStreet, CORNER, tap]
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(answer(s.h, ...road)), { status: 200, headers: { 'content-type': 'application/json' } }))))
      const done = await extendAlongRoads(box.route, spot(s.h, tap), 'both')
      expect(done.notice).toBeNull()
      return { route: done.route, turnsAt }
    }

    /** The line through these places, `lane` metres to its left, with the corners mitred. */
    function keepLeft(xy: Spot[], lane: number): Spot[] {
      const left = (i: number): Spot => {
        const [dx, dy] = [xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]]
        const len = Math.hypot(dx, dy)
        return [-dy / len, dx / len]
      }
      return xy.map(([x, y], i) => {
        const a = left(Math.max(0, i - 1))
        const b = left(Math.min(i, xy.length - 2))
        const [mx, my] = [a[0] + b[0], a[1] + b[1]]
        const k = lane / Math.max(0.2, (mx * mx + my * my) / 2)
        return [x + mx * k, y + my * k]
      })
    }

    /** What happened on a drive: the tracker 40 m or more behind the car, the turn in or the U-turn still on the card 20 m out of the side street, a house on the road out never in reach of an alert, and whether the turn out was ever on the card. */
    interface Outcome {
      behind: boolean
      stale: boolean
      missed: boolean
      turnOut: boolean
    }

    /**
     * The car up the left of the road at 8 m/s, into the side street at 3 m/s, round in a half ellipse 4 m deep at 1 m/s (`further` m past where the
     * route ended), out down the other side and onto the road. A fix a second, 4 m out (the error carried over from fix to fix), with the phone's
     * course, 10 degrees out, from 1.5 m/s. With `junction`, the car brakes and speeds up at 1.5 m/s² instead: down to 3 m/s at the corner going in,
     * 1 m/s round, up to 4 m/s at most in the side street and down to `junction` m/s where it comes out onto the road, to give way, then up to 8.
     */
    function driveOut(s: SideStreet, { route, turnsAt }: { route: Route; turnsAt: number }, further: number, seed: number, junction?: number): Outcome {
      const track = makeTrack(route.points)
      const routeEnd = track.cum[track.cum.length - 1]
      const turns = routeTurns(route.points)
      const uturn = turns.findIndex((t) => turnKind(t.angle) === 'uturn')
      expect(uturn, JSON.stringify(s)).toBeGreaterThanOrEqual(0)
      const way = wayOf(s)
      const round: Spot = [(s.back + further) * way[0], 200 + (s.back + further) * way[1]]
      const lane = 1.8
      const into = keepLeft([[0, 0], CORNER, round], lane)
      const outOf = keepLeft([round, CORNER, [0, s.on ? 320 : 80]], lane)
      const ellipse = Array.from({ length: 7 }, (_, k): Spot => {
        const a = (Math.PI * (k + 1)) / 8
        return [round[0] + 4 * Math.sin(a) * way[0] - lane * Math.cos(a) * way[1], round[1] + 4 * Math.sin(a) * way[1] + lane * Math.cos(a) * way[0]]
      })
      const path = [...dense(1, ...into), ...ellipse, ...dense(1, ...outOf)]
      const cum = [0]
      for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]))
      const inAt = dense(1, into[0], into[1]).length - 1
      const roundFrom = cum[dense(1, ...into).length - 1]
      const roundTo = cum[dense(1, ...into).length + ellipse.length]
      const outAt = roundTo + Math.hypot(outOf[1][0] - outOf[0][0], outOf[1][1] - outOf[0][1])
      // How far along the route the car truly is once it has turned round: the nearest place of the route from where the route itself turns round on.
      const from = track.cum[turnsAt]
      const along = (p: Spot) => {
        let best = { d: Infinity, at: 0 }
        for (let i = 0; i + 1 < track.points.length; i++) {
          if (track.cum[i + 1] < from) continue
          const [a, b] = [frame(s.h, track.points[i]), frame(s.h, track.points[i + 1])]
          const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
          const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
          if (d < best.d) best = { d, at: track.cum[i] + t * (track.cum[i + 1] - track.cum[i]) }
        }
        return best.at
      }
      const houses = [5, 15, 25, 35, 45].map((m) => along(CORNER) + m)
      const reached = houses.map(() => false)
      const r = random(seed * 7919 + s.h + s.angle)
      let err = [0, 0]
      let progress: Progress | null = null
      let trail: TrailPoint[] = []
      let card: number | null = null
      const o: Outcome = { behind: false, stale: false, missed: false, turnOut: false }
      /** How fast the car goes `x` m along its way. */
      const pace = (x: number): number => {
        if (junction === undefined) return x >= roundFrom && x <= roundTo ? 1 : x >= cum[inAt] - 6 && x <= outAt + 6 ? 3 : 8
        const brake = (v: number, m: number) => Math.sqrt(v * v + 2 * 1.5 * Math.max(0, m))
        if (x < cum[inAt]) return Math.min(8, brake(3, cum[inAt] - x))
        if (x < roundFrom) return Math.max(1, Math.min(3, brake(1, roundFrom - x)))
        if (x <= roundTo) return 1
        if (x < outAt) return Math.max(0.8, Math.min(4, brake(1, x - roundTo), brake(junction, outAt - x)))
        return Math.min(8, brake(junction, x - outAt))
      }
      for (let x = 0, clock = 0; x < cum[cum.length - 1]; clock += 1000) {
        const speed = pace(x)
        let i = 0
        while (cum[i + 1] < x) i++
        const t = (x - cum[i]) / (cum[i + 1] - cum[i])
        const here: Spot = [path[i][0] + t * (path[i + 1][0] - path[i][0]), path[i][1] + t * (path[i + 1][1] - path[i][1])]
        const pos = spot(s.h, here)
        err = err.map((e) => 0.6 * e + 0.8 * gaussian(r) * 4)
        const fix = { lat: pos.lat + err[1] / M_PER_DEG, lng: pos.lng + err[0] / (M_PER_DEG * Math.cos(rad(ORIGIN.lat))), accuracy: 6, time: clock, speed }
        const course = speed >= 1.5 ? (bearing(spot(s.h, path[i]), spot(s.h, path[i + 1])) + gaussian(r) * 10 + 360) % 360 : trailHeading(trail, fix.accuracy)
        const now = advance(track, progress, fix, course)
        // A fix the tracker set aside, or one that left the car where it was, changes nothing on the screen.
        if (now && now !== progress) {
          progress = now
          trail = pushTrail(trail, { lat: now.at.lat, lng: now.at.lng, time: now.time ?? clock })
          const onTrack = onTheRoute(now.gap, now.accuracy, now.lost)
          const shown = guidanceToShow(turns, { onTrack, transit: false, along: now.along, routeEnd, heading: course, after: now.furthest - TURN_PASSED_M, reached: now.furthest })
          const guided = shown ? guidedTurn(shown) : null
          card = guided ? turns.indexOf(guided.turn) : null
          if (onTrack) houses.forEach((at, k) => (reached[k] ||= now.along >= at - 40 && now.along <= at + 20))
        }
        if (card !== null && card === uturn + 1) o.turnOut = true
        if (card !== null && card <= uturn && x > outAt + 20) o.stale = true
        if (progress && x > (roundFrom + roundTo) / 2 + 25 && along(here) - progress.along >= 40) o.behind = true
        x += speed
      }
      o.missed = reached.some((k) => !k)
      return o
    }

    it('keeps up with it from its first fixes out, shows the turn out, and comes to every house on the road out, with Follow roads on or off', { timeout: 60_000 }, async () => {
      // The route turns round 30 to 40 m into the side street, so the way back level with the car is 45 to 75 m on along the route. That cost kept the
      // driver on the road before the corner (a fit 40 to 60 degrees out by heading, which is never going back) with too little side street for the
      // run of fixes heading against the way in, and then at the corner while the car drove 30 to 80 m up the road out: the turn in stayed on the
      // card, the turn out never came, and the houses on the first 50 m of the road out were jumped over. Here that was 298 of these 1280 drives.
      // Over 60, 90 and 120 degrees, 3.5 to 12 m back, turning round there or 8 m further in, it was 203 of 1896 drives 40 m behind with Follow
      // roads on and 334 of 2016 with it off (45 and 92 with the box of round 2, which went on 6 m less); now none. The turn out is not on the card
      // only where the car has a fix or none heading out of the side street before it turns onto the road (120 degrees, 4 to 6 m back), or where
      // the straight taps read as no turn out at all (one route here): 98% shown, 95% before.
      const cells: [number, number[]][] = [
        [90, [5, 6, 8, 10]],
        [120, [4, 5, 6, 8, 10, 12]],
      ]
      let n = 0
      let turnOut = 0
      const wrong: string[] = []
      for (const [angle, backs] of cells) {
        for (const back of backs) {
          for (const h of [0, 100, 215, 300]) {
            for (const turn of [1, -1] as const) {
              for (const on of [true, false]) {
                for (const roads of [true, false]) {
                  const s: SideStreet = { angle, back, turn, on, h, roads }
                  const route = await drawn(s)
                  for (const further of [0, 8]) {
                    for (const seed of [1, 2]) {
                      const o = driveOut(s, route, further, seed)
                      n++
                      if (o.turnOut) turnOut++
                      if (o.behind || o.stale || o.missed) wrong.push(`${angle} ${back} ${h} ${turn} ${on} ${roads} ${further} ${seed}: ${JSON.stringify(o)}`)
                    }
                  }
                }
              }
            }
          }
        }
      }
      expect(n).toBe(10 * 4 * 2 * 2 * 2 * 2 * 2)
      expect(wrong).toEqual([])
      expect(turnOut / n).toBeGreaterThan(0.97)
    })

    it('keeps up with a car that slows to give way where it comes out onto the road, and goes on up it the way it came', { timeout: 60_000 }, async () => {
      // Braking and speeding up at 1.5 m/s², down to 2 m/s at the junction: the fixes heading out of the side street were under 3 m/s, too slow for a
      // course to be taken for the way back of the U-turn then, and on the road, with the driver still put on the road before the corner (which runs
      // the way the road out does), the phone was heading along the stretch the driver was on. So the driver was left at the corner while the car
      // drove 30 to 80 m up the road out, the turn in stayed on the card and the houses on the road out were jumped over: 106 of these 640 drives.
      // (Going back down the road the way the car came in, none.)
      let n = 0
      const wrong: string[] = []
      for (const [angle, backs] of [[90, [5, 6, 8, 10]], [120, [4, 5, 6, 8, 10, 12]]] as [number, number[]][]) {
        for (const back of backs) {
          for (const h of [0, 100, 215, 300]) {
            for (const turn of [1, -1] as const) {
              for (const roads of [true, false]) {
                const s: SideStreet = { angle, back, turn, on: true, h, roads }
                const route = await drawn(s)
                for (const further of [0, 8]) {
                  for (const seed of [1, 2]) {
                    const o = driveOut(s, route, further, seed, 2)
                    n++
                    if (o.behind || o.stale || o.missed) wrong.push(`${angle} ${back} ${h} ${turn} ${roads} ${further} ${seed}: ${JSON.stringify(o)}`)
                  }
                }
              }
            }
          }
        }
      }
      expect(n).toBe(10 * 4 * 2 * 2 * 2 * 2)
      expect(wrong).toEqual([])
    })
  })
})

describe('a U-turn that could not be drawn along the road is drawn on the spot', () => {
  const answer = (code: string) => new Response(JSON.stringify({ code }), { status: 400, headers: { 'content-type': 'application/json' } })

  /** Ways the road service can fail, each as the reply to the first request, and the notice the driver gets. */
  const FAILURES: [string, () => void, string][] = [
    ['no segment', () => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(answer('NoSegment')))), UTURN_NO_ROAD_NOTICE],
    ['no route', () => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(answer('NoRoute')))), UTURN_NO_ROAD_NOTICE],
    [
      'HTTP 500',
      () => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"message":"down"}', { status: 500, headers: { 'content-type': 'application/json' } })))),
      UTURN_UNREACHED_NOTICE,
    ],
    ['offline', () => vi.stubGlobal('navigator', { onLine: false }), UTURN_UNREACHED_NOTICE],
    [
      'a timeout',
      () => vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))),
      UTURN_UNREACHED_NOTICE,
    ],
  ]

  beforeEach(() => {
    rate.minGapMs = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Asks for the U-turn along the road from the end of a road out of 300 m, tapping 100 m back and 14 m across, which is where the tap would be. */
  async function ask(h: number, timeout: boolean) {
    const route = routeAlong(h, dense(20, ...OUT))
    const tap = spot(h, [14, 200])
    const pending = extendAlongRoads(route, tap, 'both', { uturnFrom: arrivalBearing(route.points) ?? undefined })
    if (timeout) await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    return { route, tap, done: await pending }
  }

  for (const [name, fail, notice] of FAILURES) {
    it(`reads as one U-turn to the right, and not as the straight line it used to be, when the answer is ${name}`, async () => {
      for (const h of [0, 37, 90, 200, 315, 359]) {
        vi.unstubAllGlobals()
        if (name === 'a timeout') vi.useFakeTimers()
        fail()
        const { route, tap, done } = await ask(h, name === 'a timeout')
        expect(done.notice, `${h}`).toBe(notice)
        // The three points of the shape are added, and the tap is not.
        expect(done.added, `${h}`).toEqual(localUturn(route.points))
        expect(done.route.points, `${h}`).toEqual([...route.points, ...done.added])
        expect(done.added).not.toContainEqual(tap)
        expect(done.replaced).toBeNull()
        // It reads as the U-turn it is. (A straight line to that tap reads as 'Sharp' or a bear and a turn.)
        const turns = routeTurns(done.route.points)
        expect(turns.map((t) => turnKind(t.angle)), `${h}`).toEqual(['uturn'])
        expect(turns[0].angle).toBeGreaterThan(0)
        // Undo takes all three points off at once.
        expect(undoStretch(done.route, [{ added: done.added, replaced: done.replaced }])!.route).toEqual(route)
        vi.useRealTimers()
      }
    })
  }

  it('draws nothing at all when the lookup is cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))))
    const route = routeAlong(0, dense(20, ...OUT))
    const ctl = new AbortController()
    const pending = extendAlongRoads(route, spot(0, [14, 200]), 'both', { uturnFrom: 0, signal: ctl.signal }).then(
      () => 'drew something',
      (e: unknown) => (e instanceof Error && 'kind' in e ? String(e.kind) : 'other'),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    ctl.abort()
    expect(await pending).toBe('cancelled')
  })
})
