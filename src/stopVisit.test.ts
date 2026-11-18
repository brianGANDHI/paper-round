import { describe, expect, it } from 'vitest'
import { alertRadius } from './alerts'
import { occurrences } from './geo'
import { startOffRoute, startOffWatch, stepWatched, unasked, type OffEvent, type OffState, type OffWatch, type RouteFix } from './offRoute'
import { offRouteGap, type Progress } from './progress'
import { noVisit, stepVisit, visitOver, type StopVisit } from './stopVisit'
import type { Pt, Stop } from './types'

/*
 * The visit to a stop away from the route and the off-route machine, put together as the round screen does (see `weighOff` in Round.tsx), with the
 * tracker's places given by hand: a tracker that holds its place while it weighs up a jump, or while the fixes are poor, can take some time to put
 * the car where it has come back onto the route, and the visit can be over by then.
 */

const ORIGIN = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
type XY = [number, number]
const spot = ([x, y]: XY): Pt => ({ lat: ORIGIN.lat + y / M_PER_DEG, lng: ORIGIN.lng + x / (M_PER_DEG * Math.cos((ORIGIN.lat * Math.PI) / 180)) })

// A north to 1500 m, across 300 m west, and B back south. The bakehouse K is 89 m west of A at 600 m, on a lane through to B; from it B is 211 m
// away, out of its reach (89 m off the route, an alert distance of 40 m and OFF_ROUTE_STOP_M).
const K: Stop = { id: 'K', type: 'bundle', pathIdx: 0, label: 'K', qty: 10, ...spot([-89, 600]) }
const occs = occurrences({ points: ([[0, 0], [0, 1500], [-300, 1500], [-300, 0]] as XY[]).map(spot), stops: [K] })
const radius = alertRadius(40)
/** How far along the route a place on B is. */
const onB = (y: number) => 1500 + 300 + (1500 - y)

interface Fix {
  t: number
  xy: XY
  /** Where along the route the tracker puts the car, and how far the phone is from there. */
  along: number
  gap: number
  /** How far the phone is from the nearest part of the route (the gap when left out). */
  offBy?: number
  accuracy?: number
  speed?: number
  /** A jump the tracker is weighing up, to here along the route: its gap is then that place's. */
  doubt?: number
}

const progress = (f: Fix): Progress =>
  ({
    idx: 0,
    t: 0,
    along: f.along,
    furthest: f.along,
    gap: f.gap,
    offBy: f.offBy ?? f.gap,
    at: spot(f.xy),
    accuracy: f.accuracy ?? 8,
    time: f.t * 1000,
    seen: f.t * 1000,
    lost: false,
    doubt: f.doubt === undefined ? null : { along: f.doubt, fixes: 1 },
    backward: 0,
    outliers: 0,
    recent: [],
  }) as unknown as Progress

/** The fixes, weighed as the round screen weighs them, with K done from `doneAt` on: what the machine says. */
function weigh(fixes: Fix[], doneAt: number): OffEvent[] {
  let visit: StopVisit = noVisit
  let state: OffState = startOffRoute
  let watch: OffWatch = startOffWatch
  const said: OffEvent[] = []
  for (const f of fixes) {
    const now = progress(f)
    const step = stepVisit(visit, now, occs, new Set(f.t >= doneAt ? [occs[0].key] : []), radius)
    visit = step.visit
    state = visitOver(state, step.ended)
    if (step.beside) {
      watch = unasked(watch)
      continue
    }
    const reading: RouteFix = { time: now.time, at: now.at, accuracy: now.accuracy, speed: f.speed ?? 8, gap: offRouteGap(now), along: now.along, furthest: now.furthest, lost: now.lost, doubt: now.doubt !== null }
    const told = stepWatched(watch, state, reading, 0)
    watch = told.watch
    state = told.state
    if (told.event) said.push(told.event)
  }
  return said
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
/** Up A to K's turn, 10 m a second, and into K, parked from 70 s; held by the tracker at the turn, 600 m along. */
const toK = (parkedTo: number): Fix[] => [
  ...range(0, 59).map((t) => ({ t, xy: [0, 10 * t] as XY, along: 10 * t, gap: 2 })),
  ...range(60, 69).map((t) => ({ t, xy: [-8 * (t - 59), 600] as XY, along: 600, gap: 8 * (t - 59) })),
  ...range(70, parkedTo).map((t) => ({ t, xy: [-80, 600] as XY, along: 600, gap: 80, speed: 0 })),
]
/** Down B from beside K's lane, 10 m a second from `from`: first a jump the tracker weighs up for 5 fixes, then believed. */
const downB = (from: number): Fix[] =>
  range(from, from + 30).map((t) => {
    const y = 600 - 10 * (t - from)
    return t < from + 5 ? { t, xy: [-300, y] as XY, along: 600, gap: 3, doubt: onB(y) } : { t, xy: [-300, y] as XY, along: onB(y), gap: 3 }
  })

describe('the end of a visit to a stop away from the route, before the tracker has put the car back on the route', () => {
  it('asks about a lane from the stop onto a later street of the route, though the tracker held the car where it left until it was out of reach', () => {
    // A minute parked at K, then the lane at 3.5 m a second, with fixes of 50 m beyond 200 m west: the tracker holds the car at the turn (as one
    // does that won't let poor fixes take it far), and the machine can't go by them. Out of K's reach at 280 m west, near B. The time since the car
    // was last on the route (two minutes) could explain the jump onto B, 2 km on along the route, at 20 m a second; but the phone was seen all
    // along, away from the route, for all but 30 s of it.
    const lane = range(130, 189).map((t) => {
      const x = -89 - 3.5 * (t - 130)
      return { t, xy: [x, 600] as XY, along: 600, gap: -x, offBy: Math.min(-x, x + 300), accuracy: x < -200 ? 50 : 8 }
    })
    expect(weigh([...toK(129), ...lane, ...downB(190)], 100)).toEqual(['rejoined-elsewhere'])
  })

  it('is not asked about when the phone was dark from the stop until the car was on a later street of the route, which it could have driven unseen', () => {
    // Thirty seconds parked at K, then no fix for five minutes: the first is on B, out of K's reach, 2 km on along the route.
    expect(weigh([...toK(99), ...downB(400)], 80)).toEqual([])
  })
})
