import { describe, expect, it } from 'vitest'
import {
  alertable,
  alertRadius,
  alertSide,
  courtLegsOf,
  keepAlertsAhead,
  legsOnResume,
  quietReachFor,
  quietReason,
  resumedLegs,
  roundCounts,
  sideGuessed,
  stopRoadSides,
  zoneExit,
  type AlertDistance,
} from './alerts'
import { freshStart, restartedRound } from './bundleFlow'
import { sideExtents } from './driveEdit'
import { approachingOccurrences, cumulativeDistances, occurrences, project, sideAt, snapAtDistance, stopSide, type Occurrence } from './geo'
import { activeRoute, addRoute, createLibrary, normalizeLibrary, setActiveRound } from './library'
import { appendPoints, paintMetres } from './routeEdit'
import { continueFrom, normalizeCourtLegs, slackFor, withCourtLegs } from './resume'
import { routeTurns } from './turns'
import { drawUturn } from './uturnShape'
import { planVoice } from './voicePlan'
import type { CourtLeg, Pt, Route, Side, Stop } from './types'

/**
 * The no-throw houses at the head of a court, driven over fix by fix the way the round screen does: where each comes up, whether it is in the
 * queue as the car goes by it, and when the voice names it. The heads are the exact reversal the road service draws, the U-turn the app draws
 * with 'U-turn here' (6 m on, 5 m across to the right, 8 m back: `drawUturn`) with the road taken on down the lane or back to the street,
 * and a bulb. A house at the head is passed on both legs by one pass of the route, and is quiet only when it is quiet on both; when it
 * alerts it alerts once, before the car is beside it on the leg where it is thrown (the first of them, when it is thrown on both).
 */

/** A spot `x` metres east and `y` metres north of a start at 51 degrees north. */
const M_PER_DEG = (6371000 * Math.PI) / 180
const spot = (x: number, y: number): Pt => ({ lat: 51 + y / M_PER_DEG, lng: x / (M_PER_DEG * Math.cos((51 * Math.PI) / 180)) })
const EMPTY: Route = { points: [], sideChanges: [], stops: [] }

/** Points along a straight line, one at least every 20 m, as a road drawn along a street has. */
function line(from: [number, number], to: [number, number]): Pt[] {
  const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 20))
  return Array.from({ length: n + 1 }, (_, k) => spot(from[0] + ((to[0] - from[0]) * k) / n, from[1] + ((to[1] - from[1]) * k) / n))
}

/** How deep the courts are, in metres. */
const DEEP = 300

/** Up the court thrown `inSide` and straight back down the same line thrown `outSide`. */
const exactReversal = (inSide: Side, outSide: Side): Route => appendPoints(appendPoints(EMPTY, line([0, 0], [0, DEEP]), inSide), line([0, DEEP], [0, 0]).slice(1), outSide)

/** Up the court thrown `inSide`, a U-turn drawn with 'U-turn here' thrown `outSide`, and the road on from its end: down the lane 5 m over, or back to the street. */
function uturnHere(inSide: Side, outSide: Side, back: 'lane' | 'street'): Route {
  const turned = drawUturn(appendPoints(EMPTY, line([0, 0], [0, DEEP]), inSide), outSide)!.route
  const end: [number, number] = [5, DEEP - 8]
  const way = back === 'lane' ? line(end, [5, 0]) : [...line(end, [0, DEEP - 20]), ...line([0, DEEP - 20], [0, 0]).slice(1)]
  return appendPoints(turned, way.slice(1), outSide)
}

/** Up a 280 m court thrown `inSide`, once round a bulb 12 m across at its end (clockwise, as traffic keeping left goes round) and back down, thrown `outSide`. */
function bulb(inSide: Side, outSide: Side): Route {
  const ring = Array.from({ length: 16 }, (_, k) => {
    const turn = ((k + 1) * 22.5 * Math.PI) / 180
    return spot(-12 * Math.sin(turn), 292 - 12 * Math.cos(turn))
  })
  return appendPoints(appendPoints(appendPoints(EMPTY, line([0, 0], [0, 280]), inSide), ring, outSide), line([0, 280], [0, 0]).slice(1), outSide)
}

/** No-throw houses, numbered from 101 in twos, so the voice names each by its own number. */
function numbered(...at: [number, number][]): Stop[] {
  return at.map(([x, y], i) => ({ id: String(101 + 2 * i), type: 'nothrow', pathIdx: 0, ...spot(x, y), address: `${101 + 2 * i} Oak Court` }))
}

/** Each side of the street near the head, and one each side half way up, which is passed twice. */
const besideTheStreet = (): Stop[] => numbered([12, 276], [-12, 276], [12, 286], [-12, 286], [12, 294], [-12, 294], [12, 200], [-12, 200])
/** Beyond the end of a court closed with 'U-turn here': straight ahead, ahead to the left and right, and nearly so. */
const beyondTheEnd = (): Stop[] => numbered([0, 316], [-11, 311], [2.5, 316], [8, 312], [-6, 314])

/** The house numbers a spoken line names (not the count in "and 2 more"). */
const numbers = (text: string): number[] => [...text.replace(/and \d+ more/g, '').matchAll(/\b\d+\b/g)].map((m) => Number(m[0]))

const PLANS: Record<string, [Side, Side]> = {
  'right both ways': ['right', 'right'],
  'left both ways': ['left', 'left'],
  'transit in and both out': ['transit', 'both'],
  'both both ways': ['both', 'both'],
}
const DISTANCES: AlertDistance[] = [10, 20, 30, 40, 60]
/** How far the car goes between fixes, in metres. */
const STEP = 2

/**
 * Drives the route from end to end, a fix every `STEP` metres along it, the way the round screen does on each: the stops left behind are done,
 * those coming up join the queue (each key once), and the voice says what `planVoice` gives. The place, the segment and so the side thrown
 * are those of the route at that distance, so the car follows the route's own shape.
 */
function drive(route: Route, distance: AlertDistance) {
  const radius = alertRadius(distance)
  const allOccs = occurrences(route)
  const occs = alertable(route, allOccs, quietReachFor(distance))
  const cum = cumulativeDistances(route.points)
  const handled = new Set<string>()
  const seen = new Set<string>()
  const announced = new Set<string>()
  let held = new Set<string>()
  let queue: Occurrence[] = []
  const cameUp: { along: number; key: string }[] = []
  const said: { along: number; text: string }[] = []
  const queued: { along: number; keys: Set<string> }[] = []
  for (let along = 0; along <= cum[cum.length - 1]; along += STEP) {
    const snap = snapAtDistance(route.points, along)!
    const pos = snap.point
    const left = queue.filter((o) => zoneExit(o, along, radius, pos))
    for (const o of left) {
      if (zoneExit(o, along, radius, pos) === 'passed') handled.add(o.key)
      else seen.delete(o.key)
    }
    queue = queue.filter((o) => !left.includes(o))
    const fresh = approachingOccurrences(along, pos, occs, handled, radius, 0).filter((o) => !seen.has(o.key))
    for (const o of fresh) {
      seen.add(o.key)
      cameUp.push({ along, key: o.key })
    }
    const plan = planVoice({ route, allOccs, occs, handled, radius, queue, fresh, announced, held, driver: { idx: snap.idx, along, driven: along, pos } })
    for (const key of plan.announce) announced.add(key)
    held = new Set(plan.held)
    if (plan.text) said.push({ along, text: plan.text })
    queue = [...queue, ...fresh]
    queued.push({ along, keys: new Set(queue.map((o) => o.key)) })
  }
  return {
    allOccs,
    occs,
    cameUp,
    said,
    /** Where a stop's alerts came up, one entry for each time. */
    upsOf: (id: string) => cameUp.filter((c) => c.key.split('#')[0] === id),
    /** Where the voice first named a house, or null. */
    namedAt: (id: string) => said.find((s) => numbers(s.text).includes(Number(id)))?.along ?? null,
    /** Whether an alert for the stop was in the queue at the fix nearest a distance along the route. */
    upAt: (id: string, along: number) => [...queued.reduce((a, b) => (Math.abs(b.along - along) < Math.abs(a.along - along) ? b : a)).keys].some((k) => k.split('#')[0] === id),
  }
}

/**
 * Where the car is beside a house on each leg of a court within 30 m of it, worked out from the shape alone: the way in is every piece of
 * the route heading north and the way back every piece heading south (not the way across a U-turn, which goes past nothing). For each, how
 * far along the route the car is nearest the house, and whether a paper would be thrown at it there: both sides are thrown, or the side
 * thrown is the side it is on (or it is on the line, which can't be told, and something is thrown).
 */
function legsOf(route: Route, stop: Stop): { along: number; thrown: boolean }[] {
  const xy = route.points.map((q) => project(q, route.points[0].lat))
  const cum = cumulativeDistances(route.points)
  const p = project(stop, route.points[0].lat)
  const legs: number[][] = [[], []]
  for (let i = 0; i < xy.length - 1; i++) {
    const dy = xy[i + 1][1] - xy[i][1]
    const len = Math.hypot(xy[i + 1][0] - xy[i][0], dy)
    if (len > 0.5 && Math.abs(dy) > len * Math.SQRT1_2) legs[dy > 0 ? 0 : 1].push(i)
  }
  return legs
    .flatMap((leg) => {
      let best = { dist: Infinity, along: 0, seg: 0, offset: 0 }
      for (const i of leg) {
        const [ax, ay] = xy[i]
        const dx = xy[i + 1][0] - ax
        const dy = xy[i + 1][1] - ay
        const len = Math.hypot(dx, dy)
        const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (len * len)))
        const dist = Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1])
        if (dist < best.dist - 0.01) best = { dist, along: cum[i] + t * (cum[i + 1] - cum[i]), seg: i, offset: (dx * (p[1] - ay) - dy * (p[0] - ax)) / len }
      }
      if (best.dist > 30) return []
      const side = Math.abs(best.offset) < 3 ? null : best.offset > 0 ? 'left' : 'right'
      const thrown = sideAt(route, best.seg)
      return [{ along: best.along, thrown: thrown === 'both' || (thrown !== 'transit' && (side === null || side === thrown)) }]
    })
    .sort((a, b) => a.along - b.along)
}

/**
 * Everything that goes wrong for the houses of a route driven at an alert distance, as lines to read: none when every house thrown on some
 * leg came up before the car was beside it on the first leg it is thrown on (and no sooner than the alert distance before it), was in the queue
 * there and named by then, came up once for each time it is passed at most (once only at the head), and every house thrown on no leg is quiet.
 */
function faults(route: Route, distance: AlertDistance): string[] {
  const run = drive(route, distance)
  const out: string[] = []
  for (const stop of route.stops) {
    const thrown = legsOf(route, stop).filter((l) => l.thrown)
    const ups = run.upsOf(stop.id)
    const passes = run.allOccs.filter((o) => o.stop.id === stop.id)
    const what = `${stop.id} at ${distance} m`
    if (!thrown.length) {
      if (ups.length) out.push(`${what}: quiet on both legs but came up`)
      continue
    }
    const first = thrown[0].along
    if (!ups.length) out.push(`${what}: never came up`)
    else {
      if (new Set(ups.map((u) => u.key)).size < ups.length) out.push(`${what}: came up twice`)
      if (passes.length === 1 && ups.length > 1) out.push(`${what}: at the head, but came up ${ups.length} times`)
      if (ups[0].along >= first) out.push(`${what}: came up at ${ups[0].along}, but the car was beside it at ${first.toFixed(0)}`)
      if (ups[0].along < first - distance - 1) out.push(`${what}: came up at ${ups[0].along}, before ${first.toFixed(0)} less the alert distance`)
    }
    if (!run.upAt(stop.id, first)) out.push(`${what}: not in the queue when the car was beside it at ${first.toFixed(0)}`)
    const named = run.namedAt(stop.id)
    if (named === null || named > first) out.push(`${what}: named at ${named}, but the car was beside it at ${first.toFixed(0)}`)
  }
  return out
}

describe('the houses at the head of a court, driven', () => {
  const heads: Record<string, (a: Side, b: Side) => Route> = {
    'an exact reversal': (a, b) => ({ ...exactReversal(a, b), stops: besideTheStreet() }),
    "'U-turn here', down the lane": (a, b) => ({ ...uturnHere(a, b, 'lane'), stops: besideTheStreet() }),
    "'U-turn here', back to the street": (a, b) => ({ ...uturnHere(a, b, 'street'), stops: besideTheStreet() }),
    "beyond the end of 'U-turn here', down the lane": (a, b) => ({ ...uturnHere(a, b, 'lane'), stops: beyondTheEnd() }),
    "beyond the end of 'U-turn here', back to the street": (a, b) => ({ ...uturnHere(a, b, 'street'), stops: beyondTheEnd() }),
  }
  for (const [head, make] of Object.entries(heads)) {
    describe(`at ${head}`, () => {
      for (const [plan, [a, b]] of Object.entries(PLANS)) {
        it(`alerts each house thrown on a leg, once, in time and named by then, and none that is not, thrown ${plan}`, () => {
          const route = make(a, b)
          expect(DISTANCES.flatMap((d) => faults(route, d))).toEqual([])
        })
      }
    })
  }

  it('has head houses that alert on the way in and head houses that alert on the way back, thrown the same side both ways, so both are tried', () => {
    for (const [a, b] of Object.values(PLANS)) {
      const route = { ...uturnHere(a, b, 'lane'), stops: besideTheStreet() }
      const occs = alertable(route, occurrences(route), quietReachFor(40))
      const way = (o: Occurrence) => (o.at < DEEP + 6 ? 'in' : 'back')
      const ways = new Set(occs.filter((o) => o.alt !== undefined).map(way))
      expect(ways.size, `${a} ${b}`).toBeGreaterThan(a === 'transit' || a === 'both' ? 0 : 1)
    }
  })
})

describe("a house on the right near the end of a court closed with 'U-turn here', thrown right both ways", () => {
  // Up 200 m, the U-turn, and the road back down from 180 m. The houses on the east are on the right going in, and nearer the way back.
  const route = (stops: Stop[]): Route => {
    const turned = drawUturn(appendPoints(EMPTY, [spot(0, 0), spot(0, 100), spot(0, 200)], 'right'), 'right')!.route
    return { ...appendPoints(turned, [spot(0, 180), spot(0, 0)], 'right'), stops }
  }
  const [e185, e195] = numbered([12, 185], [12, 196])

  it('is nearest the way back, where it is quiet, and is put on the way in, where it is thrown', () => {
    const r = route([e185, e195])
    const all = occurrences(r)
    for (const o of all) expect(quietReason(r, all, o), o.key).toBeNull()
    expect(all.every((o) => o.at > 210)).toBe(true)
    const occs = alertable(r, all)
    expect(occs.map((o) => [o.key, Math.round(o.at)])).toEqual([
      [e185.id, 185],
      [e195.id, 196],
    ])
    for (const o of occs) expect(alertSide(r, all, o)).toBe('right')
  })

  it('comes up the alert distance before the car passes it going in, and is named then', () => {
    for (const d of [10, 20, 30, 40] as const) {
      const run = drive(route([e185, e195]), d)
      for (const [house, beside] of [
        [e185, 185],
        [e195, 196],
      ] as const) {
        const [up] = run.upsOf(house.id)
        expect(up.along, `${house.id} at ${d} m`).toBeLessThanOrEqual(beside - d + STEP)
        expect(up.along).toBeGreaterThanOrEqual(beside - d - 1)
        // Named as it comes up, or before with the house before it, as a row.
        expect(run.namedAt(house.id)).toBeLessThanOrEqual(up.along)
        expect(run.upsOf(house.id)).toHaveLength(1)
      }
    }
  })

  it('is timed the same with a side picked by hand', () => {
    // Picked as you drive past it the first time: the right going in, though the way back is the leg nearest it.
    const picked = { ...e185, side: 'right' as const }
    const r = route([picked])
    expect(occurrences(r)[0].at).toBeGreaterThan(210)
    const [o] = alertable(r, occurrences(r))
    expect(o.at).toBeCloseTo(185, 0)
    expect(alertSide(r, occurrences(r), o)).toBe('right')
    const run = drive(r, 40)
    expect(run.upsOf(picked.id).map((u) => u.along)).toEqual([146])
  })

  it('is timed on the way back with the left picked, as it is then on the right coming back, where it is thrown', () => {
    const picked = { ...e185, side: 'left' as const }
    const r = route([picked])
    const [o] = alertable(r, occurrences(r))
    expect(o.at).toBeCloseTo(229, 0)
    expect(alertSide(r, occurrences(r), o)).toBe('right')
  })

  it('has a side that is no guess when it is right by the way back but well to one side of the way in it alerts on', () => {
    // 1.5 m from the lane the way back runs down, and 6.5 m to the right of the way in.
    const near = (side: Side): Route => ({ ...uturnHere(side, side, 'lane'), stops: numbered([6.5, 296]) })
    const right = near('right')
    const all = occurrences(right)
    expect(all[0].at).toBeGreaterThan(DEEP)
    expect(sideGuessed(right, all, '101')).toEqual([false])
    expect(stopRoadSides(right, all, '101')).toEqual(['right'])
    expect(stopRoadSides(right, all, '101')).toEqual([alertSide(right, all, alertable(right, all)[0])])
    // Thrown left both ways it is quiet going in and alerts on the way back, where it is on the line: that side is a guess.
    const left = near('left')
    expect(sideGuessed(left, occurrences(left), '101')).toEqual([true])
  })
})

describe('the houses at the head of a court, with each side picked by hand as you drive past it the first time', () => {
  const picked = (): Stop[] => besideTheStreet().map((s) => ({ ...s, side: s.lng > 0 ? ('right' as const) : ('left' as const) }))
  const heads: Record<string, (a: Side, b: Side, stops: Stop[]) => Route> = {
    'an exact reversal': (a, b, stops) => ({ ...exactReversal(a, b), stops }),
    "'U-turn here', down the lane": (a, b, stops) => ({ ...uturnHere(a, b, 'lane'), stops }),
    "'U-turn here', back to the street": (a, b, stops) => ({ ...uturnHere(a, b, 'street'), stops }),
  }
  for (const [head, make] of Object.entries(heads)) {
    for (const [plan, [a, b]] of Object.entries(PLANS)) {
      it(`alerts as the map says, at ${head}, thrown ${plan}`, () => {
        const route = make(a, b, picked())
        const map = make(a, b, besideTheStreet())
        const all = occurrences(route)
        const mapAll = occurrences(map)
        const timing = (r: Route, occs: Occurrence[]) => alertable(r, occs, quietReachFor(40)).map((o) => [o.key, Math.round(o.at), alertSide(r, occs, o)])
        expect(timing(route, all)).toEqual(timing(map, mapAll))
        expect(DISTANCES.flatMap((d) => faults(route, d))).toEqual([])
      })
    }
  }

  it("alerts a house on the right near the end of 'U-turn here' going in, picked as the right, before the car passes it", () => {
    // Nearer the way back, which runs down the lane 7 m from it.
    const route: Route = { ...uturnHere('right', 'right', 'lane'), stops: [{ ...numbered([12, 296])[0], side: 'right' }] }
    for (const d of DISTANCES) {
      const run = drive(route, d)
      const [up] = run.upsOf('101')
      expect(up.along, `${d} m`).toBeLessThanOrEqual(296 - d + STEP)
      expect(up.along, `${d} m`).toBeGreaterThanOrEqual(296 - d - 1)
      expect(run.upAt('101', 296), `${d} m`).toBe(true)
      expect(run.namedAt('101'), `${d} m`).toBeLessThanOrEqual(up.along)
    }
  })
})

describe('the houses at the head of a court driven straight back down the same line', () => {
  // Up 200 m and back: the way in and the way out tie, and a house is on the way in. East houses are the right going in.
  const points = [spot(0, 0), spot(0, 100), spot(0, 200), spot(0, 100), spot(0, 0)]
  const stops = numbered([12, 177], [-12, 181], [12, 185], [-12, 191], [12, 195])
  const make = (sides: [number, Side][]): Route => ({ points, sideChanges: sides.map(([idx, side]) => ({ idx, side })), stops })

  it('are each named, with nothing thrown going in and both sides coming out, as the car turns and before it is beside them', () => {
    for (const d of [10, 20, 30, 40, 60] as const) {
      const run = drive(make([
        [0, 'transit'],
        [2, 'both'],
      ]), d)
      for (const s of stops) {
        const named = run.namedAt(s.id)
        const y = (s.lat - 51) * M_PER_DEG
        expect(named, `${s.id} at ${d} m`).not.toBeNull()
        expect(named).toBeGreaterThanOrEqual(200)
        expect(named).toBeLessThanOrEqual(400 - y)
        expect(run.upAt(s.id, 400 - y), `${s.id} at ${d} m`).toBe(true)
      }
    }
  })

  it('are still up as the car passes them coming out, thrown left both ways, when they are on the right going in', () => {
    for (const d of [20, 40] as const) {
      const run = drive(make([[0, 'left']]), d)
      for (const s of stops.filter((x) => x.lng > 0)) {
        const y = (s.lat - 51) * M_PER_DEG
        expect(run.upAt(s.id, 400 - y), `${s.id} at ${d} m`).toBe(true)
        expect(run.upsOf(s.id)).toHaveLength(1)
        expect(run.upsOf(s.id)[0].along).toBeGreaterThanOrEqual(400 - y - d - 1)
      }
    }
  })
})

describe("a house beyond the end of a court closed with 'U-turn here'", () => {
  // The way across the U-turn is square to both legs, so a house beyond it would be judged on it alone: on its left, whichever side it is.
  const base = (side: Side) => drawUturn(appendPoints(EMPTY, line([0, 0], [0, DEEP]), side), side)!.route
  const withWayBack = (side: Side, stops: Stop[]): Route => {
    const turned = base(side)
    return { ...appendPoints(turned, line([5, DEEP - 8], [5, 100]).slice(1), side), stops }
  }
  const [ahead, aheadLeft, nearlyAhead] = numbered([0, 316], [-11, 311], [2.5, 316])

  it('alerts thrown right both ways: it is on the left of the way in and the right of the way back', () => {
    const r = withWayBack('right', [ahead, aheadLeft, nearlyAhead])
    const all = occurrences(r)
    for (const o of all) {
      expect(o.alt, o.key).toBeDefined()
      expect(quietReason(r, all, o), o.key).toBeNull()
    }
    expect(alertSide(r, all, all.find((o) => o.stop.id === aheadLeft.id)!)).toBe('right')
    expect(alertable(r, all)).toHaveLength(3)
  })

  it('is as it was thrown left both ways: on the left as the way in reaches it', () => {
    const r = withWayBack('left', [ahead, aheadLeft, nearlyAhead])
    const all = occurrences(r)
    for (const o of all) {
      expect(quietReason(r, all, o), o.key).toBeNull()
      expect(alertSide(r, all, o), o.key).toBe('left')
    }
  })

  it('is passed on the way in and the way back, not on the way across, in a route that is not of the U-turn button too', () => {
    // A box 7 m across drawn by hand, 16 m on past the end: the house beyond it is passed on both legs.
    const hand: Route = {
      points: [spot(0, 0), spot(0, DEEP), spot(0, DEEP + 16), spot(7, DEEP + 16), spot(7, DEEP + 2), spot(7, 0)],
      sideChanges: [{ idx: 0, side: 'right' }],
      stops: [ahead],
    }
    const [o] = occurrences(hand)
    expect(o).toMatchObject({ idx: 1, alt: 3 })
    expect(quietReason(hand, [o], o)).toBeNull()
  })

  describe('between the two legs of a U-turn 10 m across, tapped by hand', () => {
    // 6 m on, 10 m across to the right and back down: the houses straight ahead, beyond the way across, are 4 m or more from both legs.
    const hand = (side: Side, stops = numbered([5, 314], [5, 321], [4, 311])): Route => ({
      points: [spot(0, 0), spot(0, DEEP), spot(0, DEEP + 6), spot(10, DEEP + 6), spot(10, DEEP - 8), spot(10, 0)],
      sideChanges: [{ idx: 0, side }],
      stops,
    })

    it('is judged on the way across, on its left as the car swings round outside it: thrown left both ways it alerts', () => {
      const r = hand('left')
      const all = occurrences(r)
      for (const o of all) {
        expect(o, o.key).toMatchObject({ idx: 2 })
        expect(o.alt, o.key).toBeUndefined()
        expect(quietReason(r, all, o), o.key).toBeNull()
        expect(alertSide(r, all, o), o.key).toBe('left')
      }
      expect(alertable(r, all)).toHaveLength(3)
      for (const d of DISTANCES) {
        const run = drive(r, d)
        for (const s of r.stops) expect(run.upsOf(s.id), `${s.id} at ${d} m`).toHaveLength(1)
      }
    })

    it('is quiet thrown right both ways, as it is on the side not thrown as the car crosses', () => {
      const r = hand('right')
      const all = occurrences(r)
      for (const o of all) expect(quietReason(r, all, o), o.key).toBe('otherSide')
    })

    it('still puts a house straight on from the way in, or out to the left, on the two legs', () => {
      const r = hand('right', numbered([0, 316], [-11, 311]))
      for (const o of occurrences(r)) expect(o, o.key).toMatchObject({ idx: 1, alt: 3 })
    })
  })

  it('leaves a house beside the cross street of a block 30 m across as it was: on its left, quiet thrown right', () => {
    const block: Route = { points: [spot(0, 0), spot(0, 100), spot(30, 100), spot(30, 0)], sideChanges: [{ idx: 0, side: 'right' }], stops: numbered([15, 110]) }
    const [o] = occurrences(block)
    expect(o.idx).toBe(1)
    expect(o.alt).toBeUndefined()
    expect(quietReason(block, [o], o)).toBe('otherSide')
  })
})

describe('a house at the head of a court, with the throw side changed as the car turns round', () => {
  /**
   * What happens to the round as the car gets `at` metres along: the route is changed, or the round screen is left (or the app reloads) and
   * the round carried on with *Continue Round*. The screen is left at `leftAt` when that is before `at` (the car drives on unseen until the
   * round is carried on), and otherwise where it is carried on. `firstFixAt` is how far along the route the first fix after *Continue Round*
   * puts the driver, when that is not where the car is (as beside a later street of the route): the car goes on from where it is.
   */
  type Change = { at: number; route: Route } | { at: number; resume: true; lost?: boolean; leftAt?: number; firstFixAt?: number }

  /**
   * Drives `first` as `drive` does, with each of `changes` in turn as the car gets `at` metres along. A change of route is taken the way the
   * round screen takes one part way through a round: the passes it alerts for are worked out again and kept ahead of the car (see
   * `keepAlertsAhead`), a pass that no longer alerts is forgotten as seen, the queue takes them as they now are, and those that now alert
   * behind the car count as done. A change taken back with Undo puts the route back as it was, so it is the route before it. A round carried
   * on is rebuilt as the screen builds it when it comes back: the passes as `alertable` gives them with what the changes made of the passes at
   * the head of a court put back from what was kept with the round (`courtLegsOf`, through storage, and `resumedLegs`), nothing queued or
   * seen, and only the stops done kept. Then, at the first fix after it, a house at the head of a court whose two legs the driver is between
   * is put on the leg ahead where it alerts there (`legsOnResume`), and nothing else is worked out from where the car is. With `lost`, what
   * the changes made of the passes is lost with the screen, as it was before it was kept with the round. `startScreen` is how the round
   * stands on the start screen at each.
   */
  function driveWithChanges(first: Route, changes: Change[], distance: AlertDistance) {
    const radius = alertRadius(distance)
    const reach = quietReachFor(distance)
    const cum = cumulativeDistances(first.points)
    let route = first
    let occs = alertable(route, occurrences(route), reach)
    let next = 0
    const handled = new Set<string>()
    const seen = new Set<string>()
    let queue: Occurrence[] = []
    const cameUp: { along: number; key: string }[] = []
    const queued: { along: number; keys: Set<string> }[] = []
    const startScreen: ReturnType<typeof roundCounts>[] = []
    for (let along = 0; along <= cum[cum.length - 1]; along += STEP) {
      // The round screen is left: nothing is seen until the round is carried on.
      const coming = changes[next]
      if (coming && 'resume' in coming && coming.leftAt !== undefined && along >= coming.leftAt && along < coming.at) continue
      let firstFix: number | null = null
      while (next < changes.length && along >= changes[next].at) {
        const change = changes[next++]
        if ('resume' in change) {
          const all = occurrences(route)
          const rebuilt = alertable(route, all, reach)
          // Kept with the round as the library keeps it, as text, and read back.
          const kept: Record<string, CourtLeg> = normalizeCourtLegs(JSON.parse(JSON.stringify(courtLegsOf(rebuilt, occs))))
          occs = change.lost ? rebuilt : resumedLegs(route, all, rebuilt, kept, radius)
          startScreen.push(roundCounts(occs, handled))
          queue = []
          seen.clear()
          firstFix = change.firstFixAt ?? along
          continue
        }
        route = change.route
        const all = occurrences(route)
        const kept = keepAlertsAhead(route, all, occs, alertable(route, all, reach), along, radius)
        const byKey = new Map(kept.occs.map((o) => [o.key, o]))
        for (const o of occs) if (!byKey.has(o.key)) seen.delete(o.key)
        occs = kept.occs
        queue = queue.flatMap((o) => byKey.get(o.key) ?? [])
        for (const key of kept.done) handled.add(key)
      }
      // The first fix after Continue Round, worked out once (the round screen does it before anything else at that fix).
      if (firstFix !== null) occs = legsOnResume(route, occurrences(route), occs, handled, firstFix, radius)
      const pos = snapAtDistance(route.points, along)!.point
      const left = queue.filter((o) => zoneExit(o, along, radius, pos))
      for (const o of left) {
        if (zoneExit(o, along, radius, pos) === 'passed') handled.add(o.key)
        else seen.delete(o.key)
      }
      queue = queue.filter((o) => !left.includes(o))
      const fresh = approachingOccurrences(along, pos, occs, handled, radius, 0).filter((o) => !seen.has(o.key))
      for (const o of fresh) {
        seen.add(o.key)
        cameUp.push({ along, key: o.key })
      }
      queue = [...queue, ...fresh]
      queued.push({ along, keys: new Set(queue.map((o) => o.key)) })
    }
    return {
      handled,
      /** The passes the round alerts for at the end. */
      occs,
      /** Where a pass's alert came up from a distance along the route on. */
      upsFrom: (key: string, from: number) => cameUp.filter((c) => c.key === key && c.along >= from).map((c) => c.along),
      /** Whether the pass was in the queue at the fix nearest a distance along the route. */
      upAt: (key: string, along: number) => queued.reduce((a, b) => (Math.abs(b.along - along) < Math.abs(a.along - along) ? b : a)).keys.has(key),
      /** The round would show it is finished: there is a pass to alert for at the end, and every one is done. */
      finished: roundCounts(occs, handled).finished,
      startScreen,
    }
  }

  /** The route with its throw side changed to `side` along the whole of it. */
  const wholly = (route: Route, side: Side): Route => ({ ...route, sideChanges: [{ idx: 0, side }] })
  /** Drives `first`, with its throw side changed to `side` along the whole of it as the car gets `changeAt` metres along. */
  const driveWithChange = (first: Route, side: Side, changeAt: number, distance: AlertDistance) => driveWithChanges(first, [{ at: changeAt, route: wholly(first, side) }], distance)
  /** Drives `first`, with its throw side changed to `side` along the whole of it at `changeAt`, and the change taken back at `undoAt`. */
  const driveWithUndo = (first: Route, side: Side, changeAt: number, undoAt: number, distance: AlertDistance) =>
    driveWithChanges(
      first,
      [
        { at: changeAt, route: wholly(first, side) },
        { at: undoAt, route: first },
      ],
      distance,
    )

  // West and east of the street 15 m before the end. Thrown right both ways the west house is on the left going in and the right coming
  // back, so it alerts coming back, at 315 m.
  const reversal = (side: Side): Route => ({ ...exactReversal(side, side), stops: numbered([-12, 285], [12, 285]) })

  it('still alerts a house thrown on both legs once changed to Both at the tip, before the car passes it coming back, and finishes', () => {
    for (const d of [10, 20, 40] as const) {
      for (const at of [298, 300, 304]) {
        const run = driveWithChange(reversal('right'), 'both', at, d)
        expect(run.upAt('101', 315), `${d} m, changed at ${at}`).toBe(true)
        expect(run.finished, `${d} m, changed at ${at}`).toBe(true)
      }
    }
  })

  it('leaves out a house now thrown only on the leg the car has gone by and quiet coming back, so it does not come up and the round finishes', () => {
    for (const d of [10, 20, 40] as const) {
      // Thrown left both ways the east house alerts coming back. Changed to right it is thrown going in only, which is behind the car.
      const run = driveWithChange(reversal('left'), 'right', 300, d)
      expect(run.upsFrom('103', 300), `${d} m`).toEqual([])
      // Not done: the car is still to pass it coming back, where a change back to left would have it alert.
      expect(run.handled.has('103'), `${d} m`).toBe(false)
      expect(run.occs.map((o) => o.key), `${d} m`).not.toContain('103')
      expect(run.finished, `${d} m`).toBe(true)
    }
  })

  it('counts as done a house whose alert moved behind the car once it is past the house on both legs', () => {
    for (const d of [10, 20, 40] as const) {
      // Changed to right just after the car went by the east house coming back, at 315 m.
      const run = driveWithChange(reversal('left'), 'right', 318, d)
      expect(run.handled.has('103'), `${d} m`).toBe(true)
      expect(run.occs.map((o) => o.key), `${d} m`).toContain('103')
      expect(run.finished, `${d} m`).toBe(true)
    }
  })

  // Thrown right both ways, the west house is on the left going in, so it alerts only coming back, at 315 m. Changed to left at the tip by
  // mistake, it is thrown going in only, behind the car. The change taken back (Undo, or the side changed back) has it alert coming back again.
  it('alerts a house left out by a change at the tip once the change is taken back, before the car passes it coming back, and finishes', () => {
    const run = driveWithUndo(reversal('right'), 'left', 300, 302, 10)
    expect(run.upAt('101', 315)).toBe(true)
    expect(run.finished).toBe(true)
    for (const d of [10, 20, 40] as const) {
      for (let at = 286; at <= 312; at += 2) {
        const undone = driveWithUndo(reversal('right'), 'left', at, at + 2, d)
        expect(undone.upAt('101', 315), `${d} m, changed at ${at}`).toBe(true)
        expect(undone.finished, `${d} m, changed at ${at}`).toBe(true)
      }
    }
  })

  it('leaves out a house a change at the tip leaves quiet coming back, with no Undo: it does not come up, is not done, and the round finishes', () => {
    for (const d of [10, 20, 40] as const) {
      const run = driveWithChange(reversal('right'), 'left', 300, d)
      expect(run.upsFrom('101', 300), `${d} m`).toEqual([])
      expect(run.handled.has('101'), `${d} m`).toBe(false)
      expect(run.occs.map((o) => o.key), `${d} m`).not.toContain('101')
      expect(run.finished, `${d} m`).toBe(true)
    }
  })

  it("keeps a house on the way back of 'U-turn here' when changed to Both going across", () => {
    // On the left going in and the right coming back down the lane, nearest the way in.
    const route: Route = { ...uturnHere('right', 'right', 'lane'), stops: numbered([-12, 286]) }
    const [o] = occurrences(route)
    expect(o.at).toBeCloseTo(286, 0)
    const back = o.altAt!
    expect(back).toBeGreaterThan(DEEP + 11)
    for (const d of [10, 20, 40] as const) {
      const run = driveWithChange(route, 'both', DEEP + 8, d)
      expect(run.upAt('101', back), `${d} m`).toBe(true)
      expect(run.finished, `${d} m`).toBe(true)
    }
  })

  it("alerts a house on the way back of 'U-turn here' left out by a change to Left going across, once the change is taken back", () => {
    const route: Route = { ...uturnHere('right', 'right', 'lane'), stops: numbered([-12, 286]) }
    const back = occurrences(route)[0].altAt!
    expect(back).toBeCloseTo(331, 0)
    // Changed and taken back at these distances along the route. At 20 m a change at 300 m is too soon to leave the house out: 14 m behind
    // the car it can still come up (see `keepAlertsAhead`), so it does, and is passed going across, so it is done before an Undo at 320 m.
    const pairs: Record<10 | 20, [number, number][]> = {
      10: [
        [300, 304],
        [306, 310],
        [310, 316],
        [300, 320],
      ],
      20: [
        [300, 304],
        [306, 310],
        [310, 316],
      ],
    }
    for (const d of [10, 20] as const) {
      for (const [at, undoAt] of pairs[d]) {
        const run = driveWithUndo(route, 'left', at, undoAt, d)
        expect(run.upAt('101', back), `${d} m, ${at} to ${undoAt}`).toBe(true)
        expect(run.finished, `${d} m, ${at} to ${undoAt}`).toBe(true)
      }
      for (let at = 290; at <= 328; at += 2) {
        const run = driveWithUndo(route, 'left', at, at + 2, d)
        expect(run.upAt('101', back), `${d} m, changed at ${at}`).toBe(true)
        expect(run.finished, `${d} m, changed at ${at}`).toBe(true)
      }
    }
  })

  /**
   * `route` with the side changed to `side` along the first choice the round offers at `along` that reaches the end of the stretch (see
   * `sideExtents`), not the whole stretch: what the driver changes the side back with from where they are, which leaves the way in as it is.
   */
  const toTheEnd = (route: Route, along: number, side: Side): { route: Route; label: string; first: boolean } => {
    const { extents } = sideExtents(route, routeTurns(route.points), [], along)
    const end = cumulativeDistances(route.points).at(-1)!
    const choice = extents.find((e) => e.key !== 'stretch' && e.toM >= end - 1)!
    return { route: paintMetres(route, choice.fromM, choice.toM, side)!, label: choice.label, first: extents[0] === choice }
  }

  it('alerts a house left out by a change at the tip once the side is changed back from the last turn to the end, and finishes', () => {
    // Changed to left along the whole stretch at the tip, and 2 m on back to right from the last turn (the tip) to the end, the first
    // choice offered: the way in stays left, so the house is thrown on both legs, and is timed on the way in, which the car has gone by.
    const left = wholly(reversal('right'), 'left')
    for (const side of ['right', 'both'] as const) {
      const back = toTheEnd(left, 302, side)
      expect(back.label).toBe('From the last turn to the end of this stretch')
      expect(back.first).toBe(true)
      for (const d of [10, 20] as const) {
        const run = driveWithChanges(reversal('right'), [{ at: 300, route: left }, { at: 302, route: back.route }], d)
        expect(run.upAt('101', 315), `${side}, ${d} m`).toBe(true)
        expect(run.finished, `${side}, ${d} m`).toBe(true)
      }
    }
    // Changed at any spot from where the change leaves it out (or, at 40 m, where it is still up) until the car is about to pass it coming back.
    const from: Record<10 | 20 | 40, number> = { 10: 296, 20: 300, 40: 290 }
    for (const d of [10, 20, 40] as const) {
      for (let at = from[d]; at <= 312; at += 2) {
        for (const side of ['right', 'both'] as const) {
          const run = driveWithChanges(reversal('right'), [{ at, route: left }, { at: at + 2, route: toTheEnd(left, at + 2, side).route }], d)
          expect(run.upAt('101', 315), `${side}, ${d} m, changed at ${at}`).toBe(true)
          expect(run.finished, `${side}, ${d} m, changed at ${at}`).toBe(true)
        }
      }
    }
  })

  it("alerts a house on the way back of 'U-turn here' left out by a change to Left once the side is changed back to the end, and finishes", () => {
    const route: Route = { ...uturnHere('right', 'right', 'lane'), stops: numbered([-12, 286]) }
    const back = occurrences(route)[0].altAt!
    const left = wholly(route, 'left')
    // Not within the 10 m (or 15 m) behind the car where a house can still come up as it is, so is left as it is (see `keepAlertsAhead`).
    const from: Record<10 | 20 | 40, number> = { 10: 296, 20: 302, 40: 302 }
    for (const d of [10, 20, 40] as const) {
      for (let at = from[d]; at <= 328; at += 2) {
        for (const side of ['right', 'both'] as const) {
          const run = driveWithChanges(route, [{ at, route: left }, { at: at + 2, route: toTheEnd(left, at + 2, side).route }], d)
          expect(run.upAt('101', back), `${side}, ${d} m, changed at ${at}`).toBe(true)
          expect(run.finished, `${side}, ${d} m, changed at ${at}`).toBe(true)
        }
      }
    }
  })

  it('alerts the houses at the tip of a court driven in transit once it is changed to Both there, before the car passes them coming back', () => {
    // Nothing thrown before, so neither house alerted. Thrown on both legs now, they are timed on the way in, which the car has gone by.
    const transit: Route = { ...exactReversal('transit', 'transit'), stops: numbered([-12, 285], [12, 285]) }
    for (const d of [10, 20, 40] as const) {
      for (let at = 294; at <= 310; at += 2) {
        const run = driveWithChange(transit, 'both', at, d)
        expect(run.upAt('101', 315), `${d} m, changed at ${at}`).toBe(true)
        expect(run.upAt('103', 315), `${d} m, changed at ${at}`).toBe(true)
        expect(run.finished, `${d} m, changed at ${at}`).toBe(true)
      }
    }
  })

  describe('carried on after the round screen was left, or the app reloaded', () => {
    // The houses at the tip, and one each side of the street on the way in, each passed twice.
    const four = (side: Side): Route => ({ ...exactReversal(side, side), stops: numbered([-12, 285], [12, 285], [12, 100], [-12, 150]) })

    it('leaves out a house a change at the tip left out, so the round finishes, where before it never could', () => {
      for (const d of [10, 20, 40] as const) {
        for (const at of [300, 306, 310]) {
          for (const resumeAt of [312, 330, 420]) {
            const changes: Change[] = [
              { at, route: wholly(four('right'), 'left') },
              { at: resumeAt, resume: true },
            ]
            const run = driveWithChanges(four('right'), changes, d)
            const what = `${d} m, changed at ${at}, carried on at ${resumeAt}`
            expect(run.finished, what).toBe(true)
            expect(run.upsFrom('101', at), what).toEqual([])
            // Left out at the change, it is still not done: only left out again. (At 20 m and more a change at 300 m is within 15 m of it,
            // where it is left as it is, and it is done as the car goes by.)
            if (d === 10 || at > 300) {
              expect(run.handled.has('101'), what).toBe(false)
              expect(run.occs.map((o) => o.key), what).not.toContain('101')
              // Nor is it among the stops on the start screen, before Continue Round: of 3, not of 4.
              expect(run.startScreen.map((c) => c.total), what).toEqual([3])
              // As the round was carried on before: the house comes back as still to do, behind the car, and holds up the round.
              const lost = driveWithChanges(four('right'), [changes[0], { at: resumeAt, resume: true, lost: true }], d)
              expect(lost.finished, what).toBe(false)
              expect(lost.startScreen.map((c) => c.total), what).toEqual([4])
            }
          }
        }
      }
    })

    it('shows a round whose only stop left was a house left out as finished on the start screen, so it starts a new round', () => {
      for (const d of [10, 20, 40] as const) {
        const changes: Change[] = [
          { at: 306, route: wholly(four('right'), 'left') },
          { at: 598, resume: true },
        ]
        expect(driveWithChanges(four('right'), changes, d).startScreen, `${d} m`).toEqual([{ total: 3, done: 3, remaining: 0, finished: true }])
        expect(driveWithChanges(four('right'), [changes[0], { at: 598, resume: true, lost: true }], d).startScreen[0].finished, `${d} m`).toBe(false)
      }
    })

    // The same without the east house, which is up on the way in as the car reaches the tip (and, thrown both ways once changed to Both,
    // is put on the way back at the first fix after Continue Round when it is not yet done: see the test after this one).
    const three = (side: Side): Route => ({ ...four(side), stops: four(side).stops.filter((s) => s.id !== '103') })

    it('keeps a house a change to Both at the tip kept on the way back there, so it comes up before the car passes it, where before it never did', { timeout: 60_000 }, () => {
      for (const d of [10, 20, 40] as const) {
        for (const at of [298, 300, 304]) {
          for (const resumeAt of [306, 310, 314]) {
            for (const first of [four('right'), three('right')]) {
              const changes: Change[] = [
                { at, route: wholly(first, 'both') },
                { at: resumeAt, resume: true },
              ]
              const what = `${first.stops.length} houses, ${d} m, changed at ${at}, carried on at ${resumeAt}`
              const run = driveWithChanges(first, changes, d)
              expect(run.upAt('101', 315), what).toBe(true)
              expect(run.handled.has('101'), what).toBe(true)
              if (first.stops.length === 3) expect(run.finished, what).toBe(true)
              // Without what was kept, the first fix after Continue Round puts it there too, as the car is more than the slack past it on
              // the way in (see `legsOnResume`). Where it is not, only what was kept does: see the next test but one.
              expect(driveWithChanges(first, [changes[0], { at: resumeAt, resume: true, lost: true }], d).upAt('101', 315), what).toBe(true)
            }
          }
        }
      }
    })

    it('alerts the east house too, up on the way in when the side was changed to Both at the tip and not yet done, before the car passes it coming back', () => {
      // Thrown right both ways it alerts going in, and at 40 m it is still up at the tip; thrown both ways it alerts on the way in, which the
      // car has gone by. The round screen is left there and the round carried on further across the tip, where it was never up again.
      for (const d of [20, 40] as const) {
        for (const at of [298, 300, 304]) {
          for (const resumeAt of [306, 310, 314]) {
            const changes: Change[] = [
              { at, route: wholly(four('right'), 'both') },
              { at: resumeAt, resume: true },
            ]
            const what = `${d} m, changed at ${at}, carried on at ${resumeAt}`
            const run = driveWithChanges(four('right'), changes, d)
            if (d === 40) {
              expect(run.upsFrom('103', resumeAt).length, what).toBe(1)
              expect(run.upAt('103', 315), what).toBe(true)
            }
            expect(run.upAt('101', 315), what).toBe(true)
            expect(run.finished, what).toBe(true)
          }
        }
      }
    })

    it('keeps a house a change to Both at the tip kept on the way back when the round is carried on too near it on the way in for the first fix to move it', () => {
      // Within the slack for the zones of it (10 m at 10 m, 15 m from 20 m on) it can still come up on the way in, so the first fix leaves it
      // there (see `legsOnResume`). Without what was kept it would, and be done there, and the car would pass it coming back with no alert.
      for (const [d, at, resumeAt] of [
        [10, 290, 294],
        [20, 296, 298],
      ] as const) {
        const changes: Change[] = [
          { at, route: wholly(three('right'), 'both') },
          { at: resumeAt, resume: true },
        ]
        const what = `${d} m, changed at ${at}, carried on at ${resumeAt}`
        const run = driveWithChanges(three('right'), changes, d)
        expect(run.upAt('101', 315), what).toBe(true)
        expect(run.finished, what).toBe(true)
        expect(driveWithChanges(three('right'), [changes[0], { at: resumeAt, resume: true, lost: true }], d).upAt('101', 315), what).toBe(false)
      }
    })

    it('goes on from what was kept however many times the round is carried on', () => {
      for (const d of [10, 20, 40] as const) {
        const again = (...at: number[]): Change[] => at.map((a) => ({ at: a, resume: true }))
        const left = driveWithChanges(four('right'), [{ at: 306, route: wholly(four('right'), 'left') }, ...again(308, 310, 330)], d)
        expect(left.finished, `${d} m`).toBe(true)
        expect(left.occs.map((o) => o.key), `${d} m`).not.toContain('101')
        expect(left.startScreen.map((c) => c.total), `${d} m`).toEqual([3, 3, 3])
        const both = driveWithChanges(three('right'), [{ at: 302, route: wholly(three('right'), 'both') }, ...again(304, 308)], d)
        expect(both.upAt('101', 315), `${d} m`).toBe(true)
        expect(both.finished, `${d} m`).toBe(true)
      }
    })

    it('alerts a house left out, carried on with, once the side is changed back before the car passes it coming back', () => {
      const left = wholly(four('right'), 'left')
      for (const d of [10, 20, 40] as const) {
        for (const back of [four('right'), toTheEnd(left, 310, 'right').route]) {
          const run = driveWithChanges(four('right'), [{ at: 306, route: left }, { at: 308, resume: true }, { at: 310, route: back }], d)
          expect(run.upAt('101', 315), `${d} m`).toBe(true)
          expect(run.finished, `${d} m`).toBe(true)
        }
      }
    })

    /** The keys of the passes of the four houses. */
    const KEYS = ['101', '103', '105', '107'].flatMap((id) => [id, `${id}#2`])

    it('changes nothing for a round with no change of side, wherever it is carried on: every house is as `alertable` gives it', { timeout: 60_000 }, () => {
      // What was kept is nothing here, so the round is carried on as it was before what a change makes of the passes was kept with it: the
      // first fix after Continue Round puts the same houses on the way back either way (see `legsOnResume`).
      const spots = [50, 150, 200, 240, 284, 290, ...Array.from({ length: 16 }, (_, i) => 296 + 2 * i), 330, 420, 480]
      for (const d of [10, 20, 40] as const) {
        for (const side of ['right', 'left', 'both'] as const) {
          const whole = driveWithChanges(four(side), [], d)
          for (const resumeAt of spots) {
            const run = driveWithChanges(four(side), [{ at: resumeAt, resume: true }], d)
            const before = driveWithChanges(four(side), [{ at: resumeAt, resume: true, lost: true }], d)
            const what = `${side}, ${d} m, carried on at ${resumeAt}`
            for (const key of KEYS) expect(run.upsFrom(key, resumeAt), `${key}, ${what}`).toEqual(before.upsFrom(key, resumeAt))
            expect(run.occs, what).toEqual(before.occs)
            expect(run.finished, what).toBe(before.finished)
            // Carried on away from any house, every house still to pass comes up as it does in a round driven without stopping.
            if ([50, 200, 240].includes(resumeAt)) {
              for (const key of KEYS) expect(run.upsFrom(key, resumeAt), `${key}, ${what}`).toEqual(whole.upsFrom(key, resumeAt))
              expect(run.finished, what).toBe(true)
            }
          }
        }
      }
    })

    // A court, a street west and north, then a second court east and back, and on north: thrown right all the way. The first court's west
    // house alerts coming back; changed to Left on that court at its tip it is left out. The second court's house (S) is on the right going
    // in and the left coming back, so it alerts going in only, as the house that went unalerted did when the round was carried on beside a
    // later street of the route.
    const laterCourt = (): Route => {
      const path = [
        ...line([0, 0], [0, DEEP]),
        ...line([0, DEEP], [0, 0]).slice(1),
        ...line([0, 0], [-200, 0]).slice(1),
        ...line([-200, 0], [-200, 600]).slice(1),
        ...line([-200, 600], [100, 600]).slice(1),
        ...line([100, 600], [-200, 600]).slice(1),
        ...line([-200, 600], [-200, 1000]).slice(1),
      ]
      return { ...appendPoints(EMPTY, path, 'right'), stops: numbered([-12, 285], [85, 588]) }
    }

    it('still alerts a house at the head of a court further on, thrown going in only, that the car has not reached, as well as leaving out one a change left out', { timeout: 60_000 }, () => {
      const route = laterCourt()
      const s = occurrences(route).find((o) => o.key === '103')!
      expect(s.at).toBeCloseTo(1685, 0)
      expect(s.altAt).toBeCloseTo(1715, 0)
      const left = paintMetres(route, 0, 2 * DEEP, 'left')!
      for (const d of [10, 20, 40] as const) {
        for (const resumeAt of [312, 420, 900, 1500, 1650]) {
          const run = driveWithChanges(route, [{ at: 306, route: left }, { at: resumeAt, resume: true }], d)
          const what = `${d} m, carried on at ${resumeAt}`
          expect(run.upsFrom('103', resumeAt).length, what).toBe(1)
          expect(run.upAt('103', 1685), what).toBe(true)
          expect(run.occs.map((o) => o.key), what).not.toContain('101')
          expect(run.finished, what).toBe(true)
        }
      }
    })

    it('leaves that house as it is when the first fix after Continue Round is between the legs of its court or beside a later street, not where the car is', { timeout: 60_000 }, () => {
      // Carried on at 450 m, before the second court, with the first fix put at its tip, between its legs, or beside a street after it, as a
      // fix taken at a break spot beside a later street of the round is. The house is thrown going in only, so it is not left out: the car
      // goes on from where it is, and it comes up before the car passes it going in. Nothing else is changed either.
      const route = laterCourt()
      const left = paintMetres(route, 0, 2 * DEEP, 'left')!
      for (const d of [10, 20, 40] as const) {
        const there = driveWithChanges(route, [{ at: 306, route: left }, { at: 450, resume: true }], d)
        for (const firstFixAt of [1700, 1710, 1800, 2100]) {
          const run = driveWithChanges(route, [{ at: 306, route: left }, { at: 450, resume: true, firstFixAt }], d)
          const what = `${d} m, first fix at ${firstFixAt}`
          expect(run.upsFrom('103', 450).length, what).toBe(1)
          expect(run.upAt('103', 1685), what).toBe(true)
          expect(run.occs, what).toEqual(there.occs)
          expect(run.finished, what).toBe(true)
        }
      }
    })

    it('alerts the houses at the head of a court thrown on both legs before the car passes them coming back, when the screen was left on the way in and the round carried on past the tip', { timeout: 60_000 }, () => {
      // Thrown both ways, each is timed on the way in (see `alertable`), which the car has gone by when the round is carried on. Neither was up
      // when the screen was left, and no side was changed, so nothing was kept with the round: the first fix after Continue Round puts them
      // on the way back (see `legsOnResume`), where before neither ever came up and the round could not finish.
      const box: Route = { ...uturnHere('both', 'both', 'lane'), stops: numbered([-12, 285], [12, 285]) }
      for (const o of alertable(box, occurrences(box))) {
        expect(o.at, o.key).toBeCloseTo(285, 0)
        expect(o.altAt, o.key).toBeCloseTo(332, 0)
      }
      // As it was found: 20 m, the screen left at 240 m, and the round carried on at 310 m, across the U-turn the app draws.
      const found = driveWithChanges(box, [{ at: 310, resume: true, leftAt: 240 }], 20)
      for (const key of ['101', '103']) {
        expect(found.upsFrom(key, 310)[0], key).toBeLessThan(332)
        expect(found.upAt(key, 332), key).toBe(true)
      }
      expect(found.finished).toBe(true)
      const reversal: Route = { ...exactReversal('both', 'both'), stops: numbered([-12, 285], [12, 285]) }
      // The tip of each, and where the car passes the houses coming back: carried on 4 to 16 m past the tip.
      const heads: [string, Route, number, number[]][] = [
        ["'U-turn here'", box, 332, [310, 316, 322]],
        ['an exact reversal', reversal, 315, [304, 310]],
      ]
      for (const [name, route, back, resumes] of heads) {
        for (const d of [10, 20, 40] as const) {
          for (const leftAt of [200, 240]) {
            for (const resumeAt of resumes) {
              const run = driveWithChanges(route, [{ at: resumeAt, resume: true, leftAt }], d)
              const what = `${name}, ${d} m, left at ${leftAt}, carried on at ${resumeAt}`
              for (const key of ['101', '103']) {
                expect(run.upsFrom(key, resumeAt).length, `${key}, ${what}`).toBe(1)
                expect(run.upAt(key, back), `${key}, ${what}`).toBe(true)
              }
              expect(run.finished, what).toBe(true)
            }
          }
        }
      }
      // Left with their alerts up on the way in at 40 m, and carried on there as the car turns round, they are put on the way back too.
      for (const resumeAt of [302, 306, 310]) {
        const run = driveWithChanges(box, [{ at: resumeAt, resume: true }], 40)
        for (const key of ['101', '103']) expect(run.upAt(key, 332), `${key}, carried on at ${resumeAt}`).toBe(true)
        expect(run.finished, `carried on at ${resumeAt}`).toBe(true)
      }
    })

    it("forgets what a change kept with the round when 'Start Round' starts a round with nothing done, so a house it left out alerts going in", () => {
      // A 60 m court at the start of the route, then on south past where it began. Thrown right both ways the west house alerts coming back;
      // changed to Left at the tip it is thrown going in only, behind the car, and is left out. The east house further on alerts on Left.
      const path = [...line([0, 0], [0, 60]), ...line([0, 60], [0, 0]).slice(1), ...line([0, 0], [0, -300]).slice(1)]
      const right: Route = { ...appendPoints(EMPTY, path, 'right'), stops: numbered([-12, 50], [12, -150]) }
      const left = wholly(right, 'left')
      const all = occurrences(left)
      for (const d of [10, 20, 40] as const) {
        const radius = alertRadius(d)
        const fresh = alertable(left, all, quietReachFor(d))
        const inUse = keepAlertsAhead(left, all, alertable(right, occurrences(right), quietReachFor(d)), fresh, 68, radius).occs
        // Kept with the round, before the furthest reached is kept (every 100 m) and with nothing done, and read back after a reload.
        const saved = setActiveRound(addRoute(createLibrary(), 'Monday', left), withCourtLegs({ handledStopIds: [] }, courtLegsOf(fresh, inUse)))
        const round = activeRoute(normalizeLibrary(JSON.parse(JSON.stringify(saved)))!).round
        expect(round.courtLegs, `${d} m`).toEqual({ '101': 'out' })
        // The start screen: one stop, none done, and nowhere to carry on from, so it offers 'Start Round', not Continue Round.
        const handled = new Set(round.handledStopIds)
        const shown = resumedLegs(left, all, fresh, round.courtLegs, radius)
        expect(roundCounts(shown, handled), `${d} m`).toEqual({ total: 1, done: 0, remaining: 1, finished: false })
        expect(continueFrom(round, all, handled), `${d} m`).toBe(0)
        // Started afresh at the start of the route, as Start Over does: nothing of the change is kept, and the house is back on the way in.
        const based = keepAlertsAhead(left, all, shown, fresh, 0, radius).occs
        const started = withCourtLegs(restartedRound(round, based, 0, slackFor(radius), freshStart(false, false)), courtLegsOf(fresh, based))
        expect('courtLegs' in started, `${d} m`).toBe(false)
        expect(based, `${d} m`).toEqual(fresh)
        expect(resumedLegs(left, all, fresh, started.courtLegs, radius), `${d} m`).toBe(fresh)
        // Driven from the start, it comes up before the car is beside it going in.
        const drove = drive(left, d)
        expect(drove.upsOf('101').length, `${d} m`).toBe(1)
        expect(drove.upsOf('101')[0].along, `${d} m`).toBeLessThan(50)
      }
    })
  })
})

describe('the houses round a bulb at the end of a court, driven', () => {
  // Two each side of the street just before the bulb, and four round the outside of it: the outside is on the left all the way round.
  const round = (turn: number): [number, number] => [-22 * Math.sin((turn * Math.PI) / 180), 292 - 22 * Math.cos((turn * Math.PI) / 180)]
  const stops = numbered([12, 262], [-12, 262], round(90), round(150), round(210), round(270))

  for (const [plan, [a, b]] of Object.entries(PLANS)) {
    it(`alerts each pass on a leg where it is thrown, once, in time and named by then, thrown ${plan}`, () => {
      const route: Route = { ...bulb(a, b), stops }
      for (const d of DISTANCES) {
        const run = drive(route, d)
        for (const o of run.occs) {
          // The leg it is timed on is one it is thrown on, worked out from the shape: the side it is on there and the side thrown there.
          const thrown = sideAt(route, o.idx)
          const side = stopSide(route.points, o.idx, o.stop)
          expect(thrown === 'both' || (thrown !== 'transit' && (side === null || side === thrown)), `${o.key} at ${d} m`).toBe(true)
          const ups = run.cameUp.filter((c) => c.key === o.key)
          expect(ups, `${o.key} at ${d} m`).toHaveLength(1)
          expect(ups[0].along).toBeLessThanOrEqual(o.at - d + STEP)
          expect(run.upAt(o.stop.id, o.at)).toBe(true)
          // Named by then, or on the first fix after it for one passed right where the side thrown changes, which the voice waits for.
          const named = run.namedAt(o.stop.id)
          expect(named, `${o.key} at ${d} m`).not.toBeNull()
          expect(named).toBeLessThanOrEqual(o.at + STEP)
        }
        // A stop with no pass that alerts never comes up.
        for (const s of stops) if (!run.occs.some((o) => o.stop.id === s.id)) expect(run.upsOf(s.id), `${s.id} at ${d} m`).toEqual([])
      }
    })
  }

  it('alerts every house round the outside thrown left, on the ring, as the car goes round', () => {
    const left: Route = { ...bulb('left', 'left'), stops }
    const occs = alertable(left, occurrences(left), quietReachFor(40))
    for (const s of stops.slice(2)) {
      const ring = occs.filter((o) => o.stop.id === s.id && o.at > 280 && o.at < 280 + 2 * Math.PI * 12)
      expect(ring.length, s.id).toBeGreaterThan(0)
    }
  })
})
