import { describe, expect, it } from 'vitest'
import {
  aheadText,
  alertable,
  alertSpeech,
  alertRadius,
  alertText,
  aheadOf,
  approachSide,
  alertSide,
  ALERT_DISTANCES,
  BACK_OFF_SLACK_M,
  courtLegsOf,
  DEFAULT_ALERT_DISTANCE,
  HEAD_PASSED_M,
  houseRow,
  inTransit,
  isAlertDistance,
  isGoneBy,
  isOffRoute,
  keepAlertsAhead,
  legsOnResume,
  offRouteNote,
  onlyInTransit,
  pickCurrent,
  planSpeech,
  platesLayout,
  plateText,
  quietHouseIds,
  quietNoThrows,
  quietNote,
  QUIET_REACH_M,
  quietReachFor,
  quietReason,
  quietText,
  resumedLegs,
  roundCounts,
  ROW_GAP_M,
  ROW_MAX,
  ROW_SPAN_M,
  sameWay,
  sideNote,
  SPOKEN_ROW_MAX,
  spokenNumber,
  stopOffRoute,
  stopQuietReasons,
  stopRoadSides,
  stopsWithoutSide,
  voiceable,
  zoneExit,
  type QuietReason,
} from './alerts'
import { approachingOccurrences, byPosition, occurrences, type Occurrence } from './geo'
import { normalizeCourtLegs } from './resume'
import type { Pt, Route, Side, SideChange, Stop, StopType } from './types'

const occ = (type: StopType, at: number): Occurrence => ({
  key: 's',
  stop: { id: 's', type, pathIdx: 0, lat: 0, lng: 0 },
  idx: 0,
  at,
  off: 0,
})

/** A spot `x` metres east and `y` metres north of a start at 51 degrees north, for routes with exact distances. */
const M_PER_DEG = (6371000 * Math.PI) / 180
const spot = (x: number, y: number): Pt => ({ lat: 51 + y / M_PER_DEG, lng: x / (M_PER_DEG * Math.cos((51 * Math.PI) / 180)) })

describe('how the round stands', () => {
  const passes = (...keys: string[]) => keys.map((key) => ({ key }))

  it('has nothing done, nothing left and is not finished for a round with no stops', () => {
    expect(roundCounts([], new Set())).toEqual({ total: 0, done: 0, remaining: 0, finished: false })
    expect(roundCounts([], new Set(['a']))).toEqual({ total: 0, done: 0, remaining: 0, finished: false })
  })

  it('counts the passes done and left, and is finished once none is left', () => {
    expect(roundCounts(passes('a', 'b', 'c'), new Set(['a']))).toEqual({ total: 3, done: 1, remaining: 2, finished: false })
    expect(roundCounts(passes('a', 'b', 'c'), new Set(['a', 'b', 'c']))).toEqual({ total: 3, done: 3, remaining: 0, finished: true })
  })

  it('does not count a key that is not one of the passes', () => {
    expect(roundCounts(passes('a', 'b'), new Set(['a', 'zzz', 'a#2']))).toEqual({ total: 2, done: 1, remaining: 1, finished: false })
  })
})

describe('the distances an alert can come up at', () => {
  it('are 10 to 60 metres in steps of ten, with 40 the usual one', () => {
    expect([...ALERT_DISTANCES]).toEqual([10, 20, 30, 40, 50, 60])
    expect(DEFAULT_ALERT_DISTANCE).toBe(40)
  })

  it('are the only ones recognised', () => {
    for (const d of ALERT_DISTANCES) expect(isAlertDistance(d)).toBe(true)
    for (const junk of [0, 5, 35, 70, 100, '40', null, undefined, NaN]) expect(isAlertDistance(junk)).toBe(false)
  })

  it('apply to every kind of stop', () => {
    expect(alertRadius(30)).toEqual({ nothrow: 30, bundle: 30, request: 30, block: 30 })
  })
})

describe('when the driver leaves the zone around a stop', () => {
  const zone = alertRadius(40)

  it('has not left while the stop is ahead or only just behind', () => {
    expect(zoneExit(occ('nothrow', 500), 470, zone)).toBeNull()
    expect(zoneExit(occ('nothrow', 500), 500, zone)).toBeNull()
    expect(zoneExit(occ('nothrow', 500), 530, zone)).toBeNull()
  })

  it('has passed the stop once it is further behind than the zone reaches', () => {
    const edge = 500 + 40
    expect(zoneExit(occ('nothrow', 500), edge, zone)).toBeNull()
    expect(zoneExit(occ('nothrow', 500), edge + 1, zone)).toBe('passed')
  })

  it('has gone back when the stop is further ahead than the zone, with room for GPS jitter', () => {
    const edge = 40 + BACK_OFF_SLACK_M
    expect(zoneExit(occ('nothrow', 500), 500 - edge, zone)).toBeNull()
    expect(zoneExit(occ('nothrow', 500), 500 - edge - 1, zone)).toBe('back')
    // Just outside the zone, before the slack runs out, is not yet a move away.
    expect(zoneExit(occ('nothrow', 500), 500 - 41, zone)).toBeNull()
  })

  it('treats a bundle drop the same as a no-throw house', () => {
    expect(zoneExit(occ('bundle', 500), 541, zone)).toBe('passed')
    expect(zoneExit(occ('bundle', 500), 539, zone)).toBeNull()
  })

  it('follows the chosen distance', () => {
    // 35 m past: outside a 30 m zone, still inside a 40 m one.
    expect(zoneExit(occ('nothrow', 500), 535, alertRadius(30))).toBe('passed')
    expect(zoneExit(occ('nothrow', 500), 535, alertRadius(40))).toBeNull()
    // A 10 m zone has its back-off edge at 25 m.
    expect(zoneExit(occ('nothrow', 500), 474, alertRadius(10))).toBe('back')
    expect(zoneExit(occ('nothrow', 500), 475, alertRadius(10))).toBeNull()
  })
})

describe('how far away a stop is said to be', () => {
  it('rounds to the nearest ten metres', () => {
    expect(aheadText(120)).toBe('120 m')
    expect(aheadText(124)).toBe('120 m')
    expect(aheadText(126)).toBe('130 m')
    expect(aheadText(20)).toBe('20 m')
  })

  it('says now when it is right here', () => {
    expect(aheadText(15)).toBe('20 m')
    expect(aheadText(14)).toBe('Now')
    expect(aheadText(0)).toBe('Now')
    expect(aheadText(-9)).toBe('Now')
  })

  it('says passed once it is behind', () => {
    expect(aheadText(-10)).toBe('Passed')
    expect(aheadText(-45)).toBe('Passed')
  })
})

describe('whether the route runs the same way along two segments', () => {
  // On the equator, so a step of the same size east or north is the same distance.
  const step = (dx: number, dy: number): Pt[] => [
    { lat: 0, lng: 0 },
    { lat: dy, lng: dx },
  ]
  const path = (a: Pt[], b: Pt[]): Pt[] => [a[0], a[1], b[1]]

  it('is true for the same direction and false for the opposite one', () => {
    const north = [0, 1, 2, 3].map((i): Pt => ({ lat: i * 0.001, lng: 0 }))
    expect(sameWay(north, 0, 2)).toBe(true)
    expect(sameWay([...north, ...[...north].reverse().slice(1)], 0, 4)).toBe(false)
  })

  it('counts a turn of less than a right angle as the same way, and more as back', () => {
    // The second segment is the second leg of a path: it starts where the first ends.
    expect(sameWay(path(step(0.001, 0), [{ lat: 0, lng: 0.001 }, { lat: 0.001, lng: 0.002 }]), 0, 1)).toBe(true) // 45 degrees
    expect(sameWay(path(step(0.001, 0), [{ lat: 0, lng: 0.001 }, { lat: 0.001, lng: 0 }]), 0, 1)).toBe(false) // 135 degrees
  })

  it('counts a turn of exactly a right angle as the same way, and a degree more as back', () => {
    // East, then due south: exactly 90 degrees between the two.
    const east = { lat: 0, lng: 0.001 }
    expect(sameWay([{ lat: 0, lng: 0 }, east, { lat: -0.001, lng: 0.001 }], 0, 1)).toBe(true)
    // A degree either side of that: south by a hair west of due south is more than a right angle, a hair east is less.
    const hair = 0.001 * Math.tan((1 * Math.PI) / 180)
    expect(sameWay([{ lat: 0, lng: 0 }, east, { lat: -0.001, lng: 0.001 - hair }], 0, 1)).toBe(false)
    expect(sameWay([{ lat: 0, lng: 0 }, east, { lat: -0.001, lng: 0.001 + hair }], 0, 1)).toBe(true)
  })

  it('says yes when there is no segment to compare', () => {
    expect(sameWay([], 0, 3)).toBe(true)
  })
})

describe('the side an alert shows', () => {
  // A road heading north. 0.0001 degrees of longitude is about 7 m here.
  const north: Pt[] = Array.from({ length: 11 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 }))
  const out = north
  const outAndBack: Pt[] = [...north, ...[...north].reverse().slice(1)]
  const stop = (extra: Partial<Stop> & { lat?: number; lng?: number } = {}): Stop => ({
    id: 's',
    type: 'nothrow',
    pathIdx: 0,
    lat: 51.0045,
    lng: 0.0002,
    ...extra,
  })
  const route = (points: Pt[], stops: Stop[], side: Side = 'both'): Route => ({ points, sideChanges: [{ idx: 0, side }], stops })
  const sides = (r: Route, id = 's') => stopRoadSides(r, occurrences(r), id)

  it('is worked out from where the stop sits beside the route', () => {
    expect(sides(route(out, [stop()]))).toEqual(['right'])
    expect(sides(route(out, [stop({ lng: -0.0002 })]))).toEqual(['left'])
  })

  it('swaps on the way back along the same street', () => {
    expect(sides(route(outAndBack, [stop()]))).toEqual(['right', 'left'])
    expect(sides(route(outAndBack, [stop({ lng: -0.0002 })]))).toEqual(['left', 'right'])
  })

  it('goes by a side picked by hand, even over where the stop sits', () => {
    expect(sides(route(out, [stop({ side: 'left' })]))).toEqual(['left'])
    expect(sides(route(out, [stop({ lng: -0.0002, side: 'right' })]))).toEqual(['right'])
  })

  it('swaps a side picked by hand on a pass the other way, as it does for one worked out from the map', () => {
    expect(sides(route(outAndBack, [stop({ lng: 0, side: 'right' })]))).toEqual(['right', 'left'])
    expect(sides(route(outAndBack, [stop({ lng: 0, side: 'left' })]))).toEqual(['left', 'right'])
  })

  it('keeps a side picked by hand on a second pass the same way', () => {
    // North along the street, round a block, and north along it again.
    const twice: Pt[] = [
      ...north,
      { lat: 51.01, lng: 0.01 },
      { lat: 51, lng: 0.01 },
      ...north,
    ]
    const r = route(twice, [stop({ lng: 0, side: 'right' })])
    expect(occurrences(r)).toHaveLength(2)
    expect(sides(r)).toEqual(['right', 'right'])
  })

  it('takes the side a no-throw house on the line is thrown to', () => {
    expect(sides(route(out, [stop({ lng: 0 })], 'left'))).toEqual(['left'])
    expect(sides(route(out, [stop({ lng: 0 })], 'right'))).toEqual(['right'])
  })

  it('has no side for a no-throw house on the line where both sides are thrown to', () => {
    expect(sides(route(out, [stop({ lng: 0 })], 'both'))).toEqual([null])
  })

  it('does not guess for a bundle drop on the line', () => {
    expect(sides(route(out, [stop({ type: 'bundle', lng: 0 })], 'left'))).toEqual([null])
    // But it can be told, or worked out, like any other stop.
    expect(sides(route(out, [stop({ type: 'bundle', lng: 0, side: 'right' })], 'left'))).toEqual(['right'])
    expect(sides(route(out, [stop({ type: 'bundle' })]))).toEqual(['right'])
  })

  it('lists a stop that is not on the route as having no passes', () => {
    const r = route(out, [stop()])
    expect(stopRoadSides(r, occurrences(r), 'nope')).toEqual([])
  })

  it('follows the section of the route at each pass for a no-throw house on the line', () => {
    // Left thrown on the way out, right on the way back.
    const r: Route = { points: outAndBack, sideChanges: [{ idx: 0, side: 'left' }, { idx: 10, side: 'right' }], stops: [stop({ lng: 0 })] }
    expect(sides(r)).toEqual(['left', 'right'])
  })

  it('answers the same for an occurrence given directly', () => {
    const r = route(out, [stop()])
    const [o] = occurrences(r)
    expect(alertSide(r, [o], o)).toBe('right')
  })
})

describe('telling the driver about houses with no side', () => {
  const north: Pt[] = Array.from({ length: 11 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 }))
  const house = (id: string, extra: Partial<Stop> = {}): Stop => ({ id, type: 'nothrow', pathIdx: 0, lat: 51.0045, lng: 0.0002, ...extra })
  const route = (stops: Stop[], side: Side = 'both'): Route => ({ points: north, sideChanges: [{ idx: 0, side }], stops })

  it('names the added no-throw houses that sit on the line where both sides are thrown to', () => {
    const stops = [house('beside'), house('online', { lng: 0 }), house('picked', { lng: 0, side: 'left' })]
    expect(stopsWithoutSide(route(stops), stops).map((s) => s.id)).toEqual(['online'])
  })

  it('has none once the route throws one way there, or for a bundle drop', () => {
    const stops = [house('online', { lng: 0 })]
    expect(stopsWithoutSide(route(stops, 'left'), stops)).toEqual([])
    const bundle = [house('drop', { type: 'bundle', lng: 0 })]
    expect(stopsWithoutSide(route(bundle), bundle)).toEqual([])
  })

  it('only looks at the stops that were just added', () => {
    const old = house('old', { lng: 0 })
    const added = house('new')
    expect(stopsWithoutSide(route([old, added]), [added])).toEqual([])
  })

  it('has something to say for one house or several, and nothing for none', () => {
    expect(sideNote(0)).toBe('')
    expect(sideNote(1)).toMatch(/Set side on it/)
    expect(sideNote(3)).toMatch(/3 of them/)
  })
})

describe('where nothing is thrown at all', () => {
  // A road heading north, thrown on the right for the first half and only driven for the second. The houses are east of it, on the right.
  const north: Pt[] = Array.from({ length: 11 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 }))
  const mixed = (stops: Stop[]): Route => ({
    points: north,
    sideChanges: [{ idx: 0, side: 'right' }, { idx: 5, side: 'transit' }],
    stops,
  })
  const house = (id: string, lat: number, extra: Partial<Stop> = {}): Stop => ({ id, type: 'nothrow', pathIdx: 0, lat, lng: 0.0002, ...extra })
  const early = house('early', 51.002)
  const late = house('late', 51.007)
  const drop = house('drop', 51.007, { type: 'bundle' })

  it('knows when the route passes a stop on a transit stretch', () => {
    const r = mixed([early, late])
    const [a, b] = occurrences(r)
    expect([inTransit(r, a), inTransit(r, b)]).toEqual([false, true])
  })

  it('keeps a no-throw house there quiet, but not one elsewhere', () => {
    const r = mixed([early, late])
    expect(alertable(r, occurrences(r)).map((o) => o.stop.id)).toEqual(['early'])
  })

  it('still alerts for a bundle drop on a transit stretch, which has nothing to do with throwing', () => {
    const r = mixed([early, drop])
    expect(alertable(r, occurrences(r)).map((o) => o.stop.id)).toEqual(['early', 'drop'])
  })

  it('counts the no-throw houses that are quiet', () => {
    expect(quietNoThrows(mixed([early, late]))).toBe(1)
    expect(quietNoThrows(mixed([early]))).toBe(0)
    expect(quietNoThrows(mixed([late, drop, house('late2', 51.0085)]))).toBe(2)
  })

  it('is only quiet when every pass of the house is in transit', () => {
    // Out along a street thrown on the right, where the house is, and back along it as transit.
    const out = Array.from({ length: 6 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 }))
    const twice: Route = {
      points: [...out, ...[...out].reverse().slice(1)],
      sideChanges: [{ idx: 0, side: 'right' }, { idx: 5, side: 'transit' }],
      stops: [house('s', 51.0025)],
    }
    const occs = occurrences(twice)
    expect(occs).toHaveLength(2)
    expect(onlyInTransit(twice, occs, 's')).toBe(false)
    expect(alertable(twice, occs)).toHaveLength(1)
    expect(onlyInTransit(twice, occs, 'nobody')).toBe(false)
  })

  it('never gives transit as the side a house is on', () => {
    // On the line, so the throw side is all there is to go by, and a transit stretch throws nowhere.
    const r: Route = { points: north, sideChanges: [{ idx: 0, side: 'transit' }], stops: [{ ...drop, type: 'nothrow', lng: 0 }] }
    const [o] = occurrences(r)
    expect(alertSide(r, [o], o)).toBeNull()
  })

  it('does not ask for a side for a house that stays quiet', () => {
    const online = house('online', 51.007, { lng: 0 })
    const r = mixed([online])
    expect(stopsWithoutSide(r, [online])).toEqual([])
    // The same house on a stretch where both sides are thrown to would have to be asked about.
    const both: Route = { ...r, sideChanges: [{ idx: 0, side: 'both' }] }
    expect(stopsWithoutSide(both, [online]).map((s) => s.id)).toEqual(['online'])
  })

  it('has something to say for one house or several, and nothing for none', () => {
    expect(quietNote(0)).toBe('')
    expect(quietNote(1)).toBe("1 no-throw house won't alert: it is on a transit stretch, or on the side you don't throw.")
    expect(quietNote(2)).toBe("2 no-throw houses won't alert: they are on transit stretches, or on the side you don't throw.")
  })
})

describe('a no-throw house on the side of the road that is not thrown', () => {
  // A road heading north, 11 points about 111 m apart. 0.0002 degrees of longitude is about 14 m: east is the right of the way
  // north and the left of the way back south.
  const north: Pt[] = Array.from({ length: 11 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 }))
  const outAndBack: Pt[] = [...north, ...[...north].reverse().slice(1)]
  /** East of the road, which is the right of the way north. */
  const east = (id: string, lat = 51.0045, extra: Partial<Stop> = {}): Stop => ({ id, type: 'nothrow', pathIdx: 0, lat, lng: 0.0002, ...extra })
  /** West of the road, which is the left of the way north. */
  const west = (id: string, lat = 51.0045, extra: Partial<Stop> = {}): Stop => east(id, lat, { lng: -0.0002, ...extra })
  const route = (points: Pt[], sideChanges: SideChange[], stops: Stop[]): Route => ({ points, sideChanges, stops })
  const thrown = (side: Side, stops: Stop[], points = north) => route(points, [{ idx: 0, side }], stops)
  const alerts = (r: Route) => alertable(r, occurrences(r)).map((o) => o.key)
  const reasons = (r: Route, id = 's') => stopQuietReasons(r, occurrences(r), id)

  it('alerts only for a house on the side that is thrown', () => {
    expect(alerts(thrown('left', [west('w'), east('e')]))).toEqual(['w'])
    expect(alerts(thrown('right', [west('w'), east('e')]))).toEqual(['e'])
  })

  it('says it is the other side that keeps it quiet', () => {
    expect(reasons(thrown('left', [east('s')]))).toEqual(['otherSide'])
    expect(reasons(thrown('right', [west('s')]))).toEqual(['otherSide'])
    expect(reasons(thrown('right', [east('s')]))).toEqual([null])
    expect(reasons(thrown('left', [west('s')]))).toEqual([null])
  })

  it('alerts for a house on either side where both sides are thrown', () => {
    expect(alerts(thrown('both', [west('w'), east('e')])).sort()).toEqual(['e', 'w'])
  })

  it('stays quiet on a stretch where nothing is thrown, whichever side the house is on', () => {
    const r = thrown('transit', [west('w'), east('e')])
    expect(alerts(r)).toEqual([])
    expect(reasons(r, 'w')).toEqual(['transit'])
    expect(reasons(r, 'e')).toEqual(['transit'])
  })

  it('alerts for a house whose side cannot be told, rather than risk missing it', () => {
    // On the line of the road, where both sides are thrown there is nothing to go by.
    const online = east('s', 51.0045, { lng: 0 })
    expect(alerts(thrown('both', [online]))).toEqual(['s'])
    // Where one side only is thrown a house on the line takes that side, so it alerts too.
    expect(alerts(thrown('left', [online]))).toEqual(['s'])
    expect(alerts(thrown('right', [online]))).toEqual(['s'])
    // A house a metre or so off the line has no side to speak of either.
    expect(alerts(thrown('left', [east('s', 51.0045, { lng: 0.00001 })]))).toEqual(['s'])
  })

  it('never keeps a bundle drop or a special request quiet for being on the other side', () => {
    const r = thrown('left', [east('b', 51.003, { type: 'bundle' }), east('q', 51.004, { type: 'request' }), east('n', 51.005)])
    expect(alerts(r)).toEqual(['b', 'q'])
    const [b, q] = occurrences(r)
    expect(quietReason(r, occurrences(r), b)).toBeNull()
    expect(quietReason(r, occurrences(r), q)).toBeNull()
  })

  it('goes by a side picked by hand, even over where the house sits', () => {
    // The house sits on the right of the road but was picked as being on the left.
    expect(alerts(thrown('left', [east('s', 51.0045, { side: 'left' })]))).toEqual(['s'])
    expect(alerts(thrown('right', [east('s', 51.0045, { side: 'left' })]))).toEqual([])
    // And the other way about.
    expect(alerts(thrown('right', [west('s', 51.0045, { side: 'right' })]))).toEqual(['s'])
    expect(alerts(thrown('left', [west('s', 51.0045, { side: 'right' })]))).toEqual([])
  })

  it('follows the stretch of the route the house is passed on', () => {
    // Left thrown for the first half of the road, right for the second.
    const r = route(north, [{ idx: 0, side: 'left' }, { idx: 5, side: 'right' }], [
      east('e1', 51.002),
      east('e2', 51.007),
      west('w1', 51.002),
      west('w2', 51.007),
    ])
    expect(alerts(r).sort()).toEqual(['e2', 'w1'])
  })

  describe('on a street driven both ways', () => {
    it('is judged a pass at a time: the house on the right going out is on the left coming back', () => {
      const left = thrown('left', [east('s')], outAndBack)
      expect(reasons(left)).toEqual(['otherSide', null])
      expect(alerts(left)).toEqual(['s#2'])
      const right = thrown('right', [east('s')], outAndBack)
      expect(reasons(right)).toEqual([null, 'otherSide'])
      expect(alerts(right)).toEqual(['s'])
    })

    it('is the other way about for a house on the other side of the road', () => {
      expect(alerts(thrown('left', [west('s')], outAndBack))).toEqual(['s'])
      expect(alerts(thrown('right', [west('s')], outAndBack))).toEqual(['s#2'])
    })

    it('alerts on both passes when each pass throws the side the house is on', () => {
      const r = route(outAndBack, [{ idx: 0, side: 'right' }, { idx: 10, side: 'left' }], [east('s')])
      expect(alerts(r)).toEqual(['s', 's#2'])
    })

    it('is quiet on both passes when each throws the other side', () => {
      const r = route(outAndBack, [{ idx: 0, side: 'left' }, { idx: 10, side: 'right' }], [east('s')])
      expect(alerts(r)).toEqual([])
      expect(reasons(r)).toEqual(['otherSide', 'otherSide'])
    })

    it('swaps a side picked by hand on the way back, as the alert does', () => {
      // Picked as the left going out (though it sits on the right), so on the right coming back.
      const left = thrown('left', [east('s', 51.0045, { side: 'left' })], outAndBack)
      expect(reasons(left)).toEqual([null, 'otherSide'])
      const right = thrown('right', [east('s', 51.0045, { side: 'left' })], outAndBack)
      expect(reasons(right)).toEqual(['otherSide', null])
    })

    it('keeps a side picked by hand on a second pass the same way', () => {
      // North along the street, round a block, and north along it again.
      const twice: Pt[] = [...north, { lat: 51.01, lng: 0.01 }, { lat: 51, lng: 0.01 }, ...north]
      const stops = [east('s', 51.0045, { lng: 0, side: 'right' })]
      expect(occurrences(thrown('right', stops, twice))).toHaveLength(2)
      expect(alerts(thrown('right', stops, twice))).toEqual(['s', 's#2'])
      expect(alerts(thrown('left', stops, twice))).toEqual([])
    })

    it('keeps the keys of the passes that alert, whichever pass is quiet', () => {
      // Quiet on the first pass, so the only key that alerts is the second pass's, as it would be with both alerting.
      const r = thrown('left', [east('s')], outAndBack)
      const all = occurrences(r)
      expect(all.map((o) => o.key)).toEqual(['s', 's#2'])
      expect(alertable(r, all)).toEqual([all[1]])
    })

    it('leaves the passes that alert in route order, among the other stops', () => {
      const r = thrown('left', [east('a', 51.002), west('b', 51.003), east('c', 51.008), west('d', 51.006)], outAndBack)
      expect(alerts(r)).toEqual(['b', 'd', 'c#2', 'a#2'])
    })

    it('counts what is left from the passes that alert', () => {
      // Round counts what is left and when the round is finished with roundCounts, over these, against the keys of the passes it has done.
      const r = thrown('left', [east('s')], outAndBack)
      const occs = alertable(r, occurrences(r))
      expect(occs).toHaveLength(1)
      expect(roundCounts(occs, new Set())).toEqual({ total: 1, done: 0, remaining: 1, finished: false })
      // The first pass is quiet, so doing it is not doing the stop.
      expect(roundCounts(occs, new Set(['s']))).toEqual({ total: 1, done: 0, remaining: 1, finished: false })
      expect(roundCounts(occs, new Set(['s#2']))).toEqual({ total: 1, done: 1, remaining: 0, finished: true })
    })

    it('can be quiet for different reasons on the two passes', () => {
      // Driving out, then nothing thrown on the way back: both of them keep it quiet.
      const r = route(outAndBack, [{ idx: 0, side: 'left' }, { idx: 10, side: 'transit' }], [east('s')])
      expect(reasons(r)).toEqual(['otherSide', 'transit'])
      expect(alerts(r)).toEqual([])
    })
  })

  describe('a house off the route', () => {
    const farEast = (m: number) => east('s', 51.0045, { lng: m / 70050 })

    it('is never kept quiet for being on the other side, as it is on no stretch of the route', () => {
      expect(alerts(thrown('left', [farEast(100)]))).toEqual(['s'])
      expect(alerts(thrown('transit', [farEast(100)]))).toEqual(['s'])
    })

    it('is judged by the side only while it is within 40 m of the route, and always alerts beyond that', () => {
      expect(QUIET_REACH_M).toBe(40)
      expect(alerts(thrown('left', [farEast(35)]))).toEqual([])
      expect(alerts(thrown('left', [farEast(45)]))).toEqual(['s'])
      expect(alerts(thrown('left', [farEast(55)]))).toEqual(['s'])
      expect(alerts(thrown('left', [farEast(65)]))).toEqual(['s'])
      expect(alerts(thrown('transit', [farEast(35)]))).toEqual([])
      expect(alerts(thrown('transit', [farEast(45)]))).toEqual(['s'])
    })

    it('stops being kept quiet just beyond 40 m from the route, for either reason', () => {
      const r = thrown('left', [farEast(30)])
      const [o] = occurrences(r)
      expect(quietReason(r, [o], { ...o, off: QUIET_REACH_M })).toBe('otherSide')
      expect(quietReason(r, [o], { ...o, off: QUIET_REACH_M + 0.01 })).toBeNull()
      const t = thrown('transit', [farEast(30)])
      const [p] = occurrences(t)
      expect(quietReason(t, [p], { ...p, off: QUIET_REACH_M })).toBe('transit')
      expect(quietReason(t, [p], { ...p, off: QUIET_REACH_M + 0.01 })).toBeNull()
    })

    it('is never kept quiet when it would alert by where the driver is, at whatever alert distance', () => {
      const r = thrown('left', [farEast(30)])
      const [o] = occurrences(r)
      for (const distance of ALERT_DISTANCES) {
        for (let m = 0; m <= 120; m++) {
          const far = { ...o, off: m }
          if (byPosition(far, alertRadius(distance))) expect(quietReason(r, [far], far), `${m} m from the route at ${distance} m`).toBeNull()
        }
      }
      // And the distance is the one that matters: at the shortest alert distance a house is met by position from just beyond it.
      expect(byPosition({ ...o, off: QUIET_REACH_M + 0.01 }, alertRadius(ALERT_DISTANCES[0]))).toBe(true)
      expect(byPosition({ ...o, off: QUIET_REACH_M }, alertRadius(ALERT_DISTANCES[0]))).toBe(false)
    })

    it('is not counted or listed as quiet when it is beyond that, and is not only in transit there', () => {
      const r = thrown('left', [farEast(45)])
      expect(reasons(r)).toEqual([null])
      expect(quietHouseIds(r, occurrences(r)).size).toBe(0)
      expect(quietNoThrows(r)).toBe(0)
      const t = thrown('transit', [farEast(30)])
      const [o] = occurrences(t)
      expect(onlyInTransit(t, [o], 's')).toBe(true)
      expect(onlyInTransit(t, [{ ...o, off: 45 }], 's')).toBe(false)
    })

    it('is judged by the occurrence given, not where the stop sits', () => {
      const r = thrown('left', [farEast(30)])
      const [o] = occurrences(r)
      expect(quietReason(r, [o], o)).toBe('otherSide')
      expect(quietReason(r, [o], { ...o, off: 200 })).toBeNull()
    })
  })

  describe('what the Stops list and the counts say', () => {
    it('is still only transit that onlyInTransit speaks of', () => {
      const r = thrown('left', [east('s')])
      expect(onlyInTransit(r, occurrences(r), 's')).toBe(false)
      expect(onlyInTransit(thrown('transit', [east('s')]), occurrences(thrown('transit', [east('s')])), 's')).toBe(true)
    })

    it('lists why a house is quiet on each pass, and nothing for a stop that is not on the route', () => {
      const r = thrown('left', [east('s')], outAndBack)
      expect(stopQuietReasons(r, occurrences(r), 's')).toEqual(['otherSide', null])
      expect(stopQuietReasons(r, occurrences(r), 'nobody')).toEqual([])
    })

    it('counts the houses that are quiet on every pass, for either reason', () => {
      const r = route(north, [{ idx: 0, side: 'left' }, { idx: 5, side: 'transit' }], [
        west('alerts', 51.002),
        east('side', 51.003),
        west('transit', 51.007),
        east('bundle', 51.003, { type: 'bundle' }),
      ])
      expect(quietHouseIds(r, occurrences(r))).toEqual(new Set(['side', 'transit']))
      expect(quietNoThrows(r)).toBe(2)
    })

    it('does not count a house that still alerts on one of its passes', () => {
      expect(quietNoThrows(thrown('left', [east('s')], outAndBack))).toBe(0)
      // Quiet in transit going out and for the other side coming back: quiet on every pass.
      const both = route(outAndBack, [{ idx: 0, side: 'transit' }, { idx: 10, side: 'right' }], [east('s'), west('t')])
      expect(reasons(both)).toEqual(['transit', 'otherSide'])
      expect(reasons(both, 't')).toEqual(['transit', null])
      expect(quietHouseIds(both, occurrences(both))).toEqual(new Set(['s']))
      expect(quietNoThrows(both)).toBe(1)
    })

    it('counts nothing for a route with no houses, or with none quiet', () => {
      expect(quietNoThrows(thrown('left', []))).toBe(0)
      expect(quietNoThrows(thrown('both', [east('s'), west('t')]))).toBe(0)
      expect(quietNoThrows({ points: [], sideChanges: [], stops: [east('s')] })).toBe(0)
    })

    it('does not ask for the side of a house on a transit stretch, but does for one that alerts either way', () => {
      const online = east('s', 51.0045, { lng: 0 })
      expect(stopsWithoutSide(thrown('transit', [online]), [online])).toEqual([])
      expect(stopsWithoutSide(thrown('both', [online]), [online]).map((h) => h.id)).toEqual(['s'])
    })
  })

  describe('saying so in the Stops list', () => {
    const says = (...r: (QuietReason | null)[]) => quietText(r)

    it('says nothing for a house that alerts on every pass, or has none', () => {
      expect(says()).toBe('')
      expect(says(null)).toBe('')
      expect(says(null, null)).toBe('')
    })

    it('says why when it is quiet on every pass', () => {
      expect(says('transit')).toBe('in transit, so no alert')
      expect(says('transit', 'transit')).toBe('in transit, so no alert')
      expect(says('otherSide')).toBe('quiet here: you throw the other side')
      expect(says('otherSide', 'otherSide')).toBe('quiet here: you throw the other side')
      expect(says('transit', 'otherSide')).toBe('quiet here: in transit or you throw the other side')
    })

    it('says which pass when it is quiet on some', () => {
      expect(says('otherSide', null)).toBe('quiet on pass 1: you throw the other side')
      expect(says(null, 'otherSide')).toBe('quiet on pass 2: you throw the other side')
      expect(says(null, 'transit')).toBe('quiet on pass 2: in transit')
    })

    it('lists the passes when it is quiet on several', () => {
      expect(says('otherSide', null, 'otherSide')).toBe('quiet on passes 1 and 3: you throw the other side')
      expect(says('transit', 'transit', 'transit', null)).toBe('quiet on passes 1, 2 and 3: in transit')
    })

    it('gives each reason its passes when they differ', () => {
      expect(says('transit', 'otherSide', null)).toBe('quiet on pass 1: in transit; on pass 2: you throw the other side')
      expect(says('otherSide', null, 'transit', 'otherSide')).toBe('quiet on pass 3: in transit; on passes 1 and 4: you throw the other side')
    })
  })
})

describe('what the banner for a stop says', () => {
  const stop = (type: StopType, extra: Partial<Stop> = {}): Stop => ({ id: 's', type, pathIdx: 0, lat: 0, lng: 0, ...extra })

  it('gives a bundle drop its name and how many papers', () => {
    expect(alertText(stop('bundle', { label: "Joe's Cafe", qty: 12 }))).toEqual({
      title: 'Bundle Drop',
      name: "Joe's Cafe",
      address: null,
      papers: '12 papers',
      number: null,
    })
  })

  it('says one paper for one', () => {
    expect(alertText(stop('bundle', { label: 'Kiosk', qty: 1 })).papers).toBe('1 paper')
  })

  it('has no papers to show when the bundle drop has no amount, and a line to say what it is when it has no name', () => {
    expect(alertText(stop('bundle', { label: "Joe's Cafe" })).papers).toBeNull()
    expect(alertText(stop('bundle', { qty: 5 })).name).toBe('Bundle stop ahead.')
    expect(alertText(stop('bundle'))).toEqual({ title: 'Bundle Drop', name: 'Bundle stop ahead.', address: null, papers: null, number: null })
  })

  it('shows a no-throw house by its name, or says what to do, and never counts papers', () => {
    expect(alertText(stop('nothrow', { label: 'Mrs Smith' }))).toEqual({ title: 'No Throw', name: 'Mrs Smith', address: null, papers: null, number: null })
    expect(alertText(stop('nothrow')).name).toBe('This house does not want a paper.')
    // An amount left on a house that has become a no-throw is not something to leave at the door.
    expect(alertText(stop('nothrow', { qty: 3 })).papers).toBeNull()
  })

  it('shows a name as it was given', () => {
    expect(alertText(stop('bundle', { label: 'Hartley & Sons, 14 High St', qty: 40 })).name).toBe('Hartley & Sons, 14 High St')
  })

  it('puts the address under the name when there is both', () => {
    expect(alertText(stop('bundle', { label: "Joe's Cafe", address: '12 Oak Road, Lewes', qty: 12 }))).toEqual({
      title: 'Bundle Drop',
      name: "Joe's Cafe",
      address: 'Oak Road, Lewes',
      papers: '12 papers',
      number: '12',
    })
    expect(alertText(stop('nothrow', { label: 'Mrs Smith', address: '9 Elm Street' }))).toEqual({
      title: 'No Throw',
      name: 'Mrs Smith',
      address: 'Elm Street',
      papers: null,
      number: '9',
    })
  })

  it('uses the address as the name when there is no name, rather than showing it twice', () => {
    expect(alertText(stop('nothrow', { address: 'Oak Road' }))).toEqual({ title: 'No Throw', name: 'Oak Road', address: null, papers: null, number: null })
    expect(alertText(stop('bundle', { address: 'Oak Road', qty: 5 }))).toEqual({
      title: 'Bundle Drop',
      name: 'Oak Road',
      address: null,
      papers: '5 papers',
      number: null,
    })
  })
})

describe('what the banner for a special request says', () => {
  const request = (extra: Partial<Stop> = {}): Stop => ({ id: 'r', type: 'request', pathIdx: 0, lat: 0, lng: 0, ...extra })

  it('is told by its note, with the house number on the plate and nothing else to read', () => {
    expect(alertText(request({ address: '23 Oak Road, Lewes', note: 'Blue gate, deliver by hand' }))).toEqual({
      title: 'Special Request',
      name: 'Blue gate, deliver by hand',
      address: null,
      papers: null,
      number: '23',
    })
  })

  it('puts the address under the note when there is no house number to show instead', () => {
    expect(alertText(request({ address: 'Rose Cottage, Mill Lane', note: 'Blue gate' }))).toEqual({
      title: 'Special Request',
      name: 'Blue gate',
      address: 'Rose Cottage, Mill Lane',
      papers: null,
      number: null,
    })
  })

  it('shows the note as it was written, even when it starts with a number', () => {
    expect(alertText(request({ address: '23 Oak Road', note: '23 is the one with the blue gate' })).name).toBe('23 is the one with the blue gate')
  })

  it('has the address for its line, without the number, when it has no note', () => {
    expect(alertText(request({ address: '23 Oak Road, Lewes' }))).toEqual({
      title: 'Special Request',
      name: 'Oak Road, Lewes',
      address: null,
      papers: null,
      number: '23',
    })
  })

  it('has an address with no number for its line as it is, and shows it only once', () => {
    expect(alertText(request({ address: 'Rose Cottage, Mill Lane' }))).toEqual({
      title: 'Special Request',
      name: 'Rose Cottage, Mill Lane',
      address: null,
      papers: null,
      number: null,
    })
  })

  it('says what it is when it has neither a note nor an address', () => {
    expect(alertText(request())).toEqual({ title: 'Special Request', name: 'Special request ahead.', address: null, papers: null, number: null })
  })

  it('never counts papers, whatever it was left with', () => {
    expect(alertText(request({ note: 'Blue gate', qty: 4 })).papers).toBeNull()
  })

  it('is not kept quiet on a stretch where nothing is thrown, as a no-throw house is', () => {
    const route: Route = {
      points: [{ lat: 51, lng: 0 }, { lat: 51.01, lng: 0 }],
      sideChanges: [{ idx: 0, side: 'transit' }],
      stops: [
        { id: 'r', type: 'request', pathIdx: 0, lat: 51.005, lng: 0.0002 },
        { id: 'n', type: 'nothrow', pathIdx: 0, lat: 51.005, lng: 0.0002 },
        { id: 'b', type: 'bundle', pathIdx: 0, lat: 51.005, lng: 0.0002 },
      ],
    }
    const occs = occurrences(route)
    expect(alertable(route, occs).map((o) => o.stop.id).sort()).toEqual(['b', 'r'])
    expect(onlyInTransit(route, occs, 'r')).toBe(true)
    // It is not a no-throw house, so it isn't one of those that stay quiet.
    expect(quietNoThrows(route)).toBe(1)
  })
})

describe('a stop that is off the route', () => {
  const east = (m: number) => m / 70050
  const zone = alertRadius(40)
  const stop = (type: StopType = 'bundle', extra: Partial<Stop> = {}): Stop => ({ id: 's', type, pathIdx: 0, lat: 51.005, lng: east(200), ...extra })
  const off = (type: StopType = 'bundle', m = 200): Occurrence => ({ key: 's', stop: stop(type), idx: 4, at: 500, off: m })
  const at = (metres: number) => ({ lat: 51.005, lng: east(200 + metres) })

  describe('leaving its zone', () => {
    it('does not depend on how far along the route the driver is', () => {
      for (const driverAt of [0, 120, 500, 5000]) expect(zoneExit(off(), driverAt, zone, at(10))).toBeNull()
    })

    it('is done once the driver is further from the stop than the zone and the slack', () => {
      const edge = 40 + BACK_OFF_SLACK_M
      expect(zoneExit(off(), 500, zone, at(edge - 1))).toBeNull()
      expect(zoneExit(off(), 500, zone, at(edge + 1))).toBe('passed')
      // Whichever side of the stop the driver is on, and wherever they are along the route.
      expect(zoneExit(off(), 0, zone, { lat: 51.005, lng: east(200 - edge - 1) })).toBe('passed')
      expect(zoneExit(off(), 9999, zone, at(edge + 1))).toBe('passed')
    })

    it('stays up between the zone and the slack, so a fix at its edge does not set it off again and again', () => {
      expect(zoneExit(off(), 500, zone, at(41))).toBeNull()
      expect(zoneExit(off(), 500, zone, at(40 + BACK_OFF_SLACK_M))).toBeNull()
    })

    it('is never left, as far as can be told, without a position', () => {
      expect(zoneExit(off(), 500, zone)).toBeNull()
    })

    it('goes by the zone of its own kind of stop', () => {
      const wide = { nothrow: 60, bundle: 20, request: 20, block: 20 }
      expect(zoneExit(off('bundle'), 500, wide, at(40))).toBe('passed')
      expect(zoneExit(off('nothrow'), 500, wide, at(40))).toBeNull()
    })

    it('is left as before when it is beside the route after all, where only the route says', () => {
      const along = { ...off('bundle', 20), stop: stop('bundle', { lng: east(20) }) }
      expect(zoneExit(along, 500, zone, at(-150))).toBeNull()
      expect(zoneExit(along, 560, zone, { lat: 51.005, lng: east(20) })).toBe('passed')
      expect(zoneExit(along, 400, zone, { lat: 51.005, lng: east(20) })).toBe('back')
    })
  })

  describe('being off the route', () => {
    it('is further from it than a stop can be placed beside it', () => {
      expect(isOffRoute({ off: 60 })).toBe(false)
      expect(isOffRoute({ off: 61 })).toBe(true)
      expect(isOffRoute({ off: 0 })).toBe(false)
    })

    it('is told from the stop, by any of its passes', () => {
      const occs = [{ ...off(), off: 200 }, { ...off('bundle', 10), stop: stop('bundle', { id: 'near' }), key: 'near', off: 10 }]
      expect(stopOffRoute(occs, 's')).toBe(true)
      expect(stopOffRoute(occs, 'near')).toBe(false)
      expect(stopOffRoute(occs, 'nobody')).toBe(false)
    })
  })

  describe('quiet on transit', () => {
    const transit = { points: [] as Pt[], sideChanges: [{ idx: 0, side: 'transit' as Side }] }

    it('does not make a no-throw house off the route quiet, as it is on no stretch of the route', () => {
      const onIt = { ...off('nothrow', 20), key: 'on', stop: stop('nothrow', { id: 'on' }) }
      const offIt = off('nothrow', 200)
      expect(alertable(transit, [onIt, offIt]).map((o) => o.key)).toEqual(['s'])
    })

    it('still lets a bundle drop alert wherever it is', () => {
      expect(alertable(transit, [off('bundle', 20), off('bundle', 200)])).toHaveLength(2)
    })

    it('does not count a no-throw house off the route as only in transit', () => {
      expect(onlyInTransit(transit, [off('nothrow', 200)], 's')).toBe(false)
      expect(onlyInTransit(transit, [off('nothrow', 20)], 's')).toBe(true)
    })
  })

  describe('telling the driver', () => {
    it('says nothing for stops along the route', () => {
      expect(offRouteNote([])).toBe('')
      expect(offRouteNote([0, 12, 60])).toBe('')
    })

    it('says how far a single stop is from the route, and what that means for its alert', () => {
      expect(offRouteNote([120.4])).toBe('It is 120 m from your route, so its alert comes up by where you are, whenever you are within the alert distance of it.')
      expect(offRouteNote([61])).toContain('61 m')
    })

    it('rounds the distance to the nearest metre', () => {
      expect(offRouteNote([120.6])).toContain('121 m')
      expect(offRouteNote([120.4])).toContain('120 m')
    })

    it('counts them when there are several, leaving out the ones that are along the route', () => {
      expect(offRouteNote([100, 5, 300])).toBe('2 of them are off your route, so their alerts come up by where you are, whenever you are within the alert distance of them.')
      expect(offRouteNote([5, 100])).toContain('100 m')
    })

    it('says a stop within the reach of the alert distance is marked off the route but still alerts as you drive past it, with its side', () => {
      // At 40 m the reach is 70 m: a stop 65 m out is met along the route, 25 m before its nearest point, with the side it is on.
      expect(offRouteNote([65], quietReachFor(40))).toBe(
        'It is 65 m from your route, so the list marks it off the route, but its alert still comes up as you drive past it, with the side it is on, which you can set in the list.',
      )
      // At 10 m the reach is 40 m, so the same stop is met by where you are.
      expect(offRouteNote([65], quietReachFor(10))).toBe('It is 65 m from your route, so its alert comes up by where you are, whenever you are within the alert distance of it.')
    })

    it('says a stop comes up by where you are exactly when it does, at every alert distance', () => {
      for (const d of ALERT_DISTANCES) {
        for (let off = 61; off <= 100; off += 0.5) {
          const o = { off, stop: { id: 's', type: 'bundle' as const, pathIdx: 0, lat: 0, lng: 0 } }
          expect(offRouteNote([off], quietReachFor(d)).includes('by where you are'), `${off} m at ${d} m`).toBe(byPosition(o, alertRadius(d)))
        }
      }
    })

    it('tells each kind apart when stops of both kinds are added together', () => {
      const reach = quietReachFor(40)
      expect(offRouteNote([65, 68, 5], reach)).toBe(
        '2 of them are more than 60 m from your route, so the list marks them off the route, but their alerts still come up as you drive past them, with the side each is on, which you can set in the list.',
      )
      expect(offRouteNote([65, 120], reach)).toBe(
        'One is 120 m from your route, so its alert comes up by where you are, whenever you are within the alert distance of it. One is 65 m from your route, so the list marks it off the route, but its alert still comes up as you drive past it, with the side it is on, which you can set in the list.',
      )
      expect(offRouteNote([120, 65, 300, 66], reach)).toMatch(/^2 of them are off your route, so their alerts come up by where you are, [^]*\. 2 of them are more than 60 m from your route, so the list marks them off the route/)
    })
  })
})

describe('which side an off-route stop is on as the driver comes up to it', () => {
  const here: Pt = { lat: 51, lng: 0 }
  /** A stop `m` metres from `here` in the compass direction `deg`. */
  const stopAt = (deg: number, m = 50): Pt => ({
    lat: here.lat + (m * Math.cos((deg * Math.PI) / 180)) / 111320,
    lng: here.lng + (m * Math.sin((deg * Math.PI) / 180)) / 70050,
  })

  it('is the right when it is to the right of the way the driver is heading, and the left when to the left', () => {
    expect(approachSide(0, here, stopAt(90))).toBe('right')
    expect(approachSide(0, here, stopAt(270))).toBe('left')
    expect(approachSide(90, here, stopAt(180))).toBe('right')
    expect(approachSide(180, here, stopAt(90))).toBe('left')
    expect(approachSide(350, here, stopAt(40))).toBe('right')
  })

  it('has none when it is straight ahead or straight behind', () => {
    expect(approachSide(0, here, stopAt(0))).toBeNull()
    expect(approachSide(0, here, stopAt(180))).toBeNull()
    expect(approachSide(90, here, stopAt(95))).toBeNull()
    expect(approachSide(0, here, stopAt(355))).toBeNull()
  })

  it('starts to have a side just outside that', () => {
    expect(approachSide(0, here, stopAt(14))).toBeNull()
    expect(approachSide(0, here, stopAt(16))).toBe('right')
    expect(approachSide(0, here, stopAt(344))).toBe('left')
    expect(approachSide(0, here, stopAt(164))).toBe('right')
    expect(approachSide(0, here, stopAt(166))).toBeNull()
  })

  it('has none until there is a heading and a position', () => {
    expect(approachSide(null, here, stopAt(90))).toBeNull()
    expect(approachSide(0, null, stopAt(90))).toBeNull()
  })
})

describe('the house number on the banner', () => {
  const stop = (extra: Partial<Stop>): Stop => ({ id: 's', type: 'nothrow', pathIdx: 0, lat: 0, lng: 0, ...extra })

  it('comes from the address', () => {
    expect(alertText(stop({ address: '12 Oak Road, Lewes' })).number).toBe('12')
    expect(alertText(stop({ label: "Joe's Cafe", address: 'Unit 3, 120 High Street', type: 'bundle', qty: 5 })).number).toBe('120')
  })

  it('comes from a name that is a number', () => {
    expect(alertText(stop({ label: 'No. 14' })).number).toBe('14')
  })

  it('is left off the front of the name and the address, since the plate says it', () => {
    // An address that is the name too, with nothing else to call the place:
    expect(alertText(stop({ address: '9 Elm Street, Lewes' }))).toMatchObject({ name: 'Elm Street, Lewes', address: null, number: '9' })
    // A name that is an address typed as the name, with an address of its own:
    expect(alertText(stop({ label: '14 Oak Road', address: '14 Oak Road, Lewes' }))).toMatchObject({ name: 'Oak Road', address: 'Oak Road, Lewes', number: '14' })
    // A number that is all there is of the name stays, so the line is not empty:
    expect(alertText(stop({ label: '14' }))).toMatchObject({ name: '14', number: '14' })
    // Anything that does not start with the number is shown as it is:
    expect(alertText(stop({ label: 'Hartley & Sons', address: 'Unit 3, 120 High Street' }))).toMatchObject({ name: 'Hartley & Sons', address: 'Unit 3, 120 High Street', number: '120' })
  })

  it('is nothing when there is none to read', () => {
    expect(alertText(stop({ label: "Joe's Cafe" })).number).toBeNull()
    expect(alertText(stop({})).number).toBeNull()
    expect(alertText(stop({ address: 'Oak Road' })).number).toBeNull()
  })
})

describe('houses in a row', () => {
  // A road running north, ~111 m per 0.001 degrees. A house is `m` metres along it, a few metres to the east or west.
  const road: Pt[] = [{ lat: 51, lng: 0 }, { lat: 51.02, lng: 0 }]
  const house = (id: string, m: number, side: 'e' | 'w' = 'e', type: StopType = 'nothrow'): Stop => ({
    id,
    type,
    pathIdx: 0,
    lat: 51 + m / 111195,
    lng: (side === 'e' ? 1 : -1) * (8 / 70050),
  })
  const setup = (stops: Stop[], sideChanges: Route['sideChanges'] = [{ idx: 0, side: 'both' }]) => {
    const route: Route = { points: road, sideChanges, stops }
    const all = occurrences(route)
    const occs = alertable(route, all)
    return { route, all, occs }
  }
  const zone = alertRadius(40)
  const keys = (row: { key: string }[]) => row.map((o) => o.key)

  it('is every house along the road within a few lots of the one before it, in route order, starting with the first', () => {
    const { route, all, occs } = setup([house('a', 100), house('b', 120), house('c', 140), house('d', 165)])
    expect(keys(houseRow(route, all, occs, new Set(), occs[0], zone))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('ends where the gap to the next house is too long', () => {
    const { route, all, occs } = setup([house('a', 100), house('b', 150), house('c', 150 + ROW_GAP_M), house('d', 150 + ROW_GAP_M + 80)])
    expect(keys(houseRow(route, all, occs, new Set(), occs[0], zone))).toEqual(['a', 'b', 'c'])
  })

  it('counts the gap from each house to the next, not from the first', () => {
    const { route, all, occs } = setup([house('a', 100), house('b', 150), house('c', 200), house('d', 250)])
    expect(houseRow(route, all, occs, new Set(), occs[0], zone)).toHaveLength(4)
  })

  it('starts from the house it is given, and leaves out the ones before it', () => {
    const { route, all, occs } = setup([house('a', 100), house('b', 120), house('c', 140)])
    expect(keys(houseRow(route, all, occs, new Set(), occs[1], zone))).toEqual(['b', 'c'])
  })

  it('leaves out houses already done', () => {
    const { route, all, occs } = setup([house('a', 100), house('b', 120), house('c', 140), house('d', 160)])
    expect(keys(houseRow(route, all, occs, new Set(['b']), occs[0], zone))).toEqual(['a', 'c', 'd'])
  })

  it('keeps the houses on one side of the road apart from those on the other', () => {
    const { route, all, occs } = setup([house('a', 100, 'e'), house('b', 105, 'w'), house('c', 120, 'e'), house('d', 125, 'w')])
    const east = occs.find((o) => o.key === 'a')!
    const west = occs.find((o) => o.key === 'b')!
    expect(keys(houseRow(route, all, occs, new Set(), east, zone))).toEqual(['a', 'c'])
    expect(keys(houseRow(route, all, occs, new Set(), west, zone))).toEqual(['b', 'd'])
  })

  it('does not take a bundle drop or a special request into a row of no-throw houses, nor start one with them', () => {
    const { route, all, occs } = setup([house('a', 100), house('b', 120, 'e', 'bundle'), house('c', 140), house('d', 160, 'e', 'request')])
    expect(keys(houseRow(route, all, occs, new Set(), occs[0], zone))).toEqual(['a', 'c'])
    expect(keys(houseRow(route, all, occs, new Set(), occs[1], zone))).toEqual(['b'])
    expect(keys(houseRow(route, all, occs, new Set(), occs[3], zone))).toEqual(['d'])
  })

  it('has houses with the same position in a row together', () => {
    const { route, all, occs } = setup([house('a', 100), house('b', 100)])
    expect(houseRow(route, all, occs, new Set(), occs[0], zone)).toHaveLength(2)
  })

  it('is no more than a driver can read at a glance', () => {
    const { route, all, occs } = setup(Array.from({ length: 20 }, (_, i) => house(`h${i}`, 100 + i * 15)))
    expect(houseRow(route, all, occs, new Set(), occs[0], zone)).toHaveLength(ROW_MAX)
  })

  it('has no other houses on a stretch where nothing is thrown, as those houses stay quiet there', () => {
    const { route, all, occs } = setup([house('a', 100), house('b', 120), house('c', 140)], [{ idx: 0, side: 'transit' }])
    expect(occs).toHaveLength(0)
    expect(keys(houseRow(route, all, occs, new Set(), all[0], zone))).toEqual(['a'])
  })

  it('has only the houses on the side that is thrown, as the others stay quiet', () => {
    const { route, all, occs } = setup([house('a', 100, 'e'), house('b', 105, 'w'), house('c', 120, 'e'), house('d', 125, 'w')], [{ idx: 0, side: 'left' }])
    // West is the left of the road north.
    expect(keys(occs)).toEqual(['b', 'd'])
    expect(keys(houseRow(route, all, occs, new Set(), occs[0], zone))).toEqual(['b', 'd'])
    const right = setup([house('a', 100, 'e'), house('b', 105, 'w'), house('c', 120, 'e'), house('d', 125, 'w')], [{ idx: 0, side: 'right' }])
    expect(keys(houseRow(right.route, right.all, right.occs, new Set(), right.occs[0], zone))).toEqual(['a', 'c'])
  })

  it('is just the house itself when it alerts by where the driver is, as one off the route does', () => {
    // Nearest to the road before the houses, so the houses come after it and could join it if it were in the row.
    const far: Stop = { id: 'far', type: 'nothrow', pathIdx: 0, lat: 51 + 90 / 111195, lng: 400 / 70050 }
    const { route, all, occs } = setup([house('a', 100), far, house('b', 120)])
    const off = occs.find((o) => o.key === 'far')!
    expect(keys(houseRow(route, all, occs, new Set(), off, zone))).toEqual(['far'])
    expect(keys(houseRow(route, all, occs, new Set(), occs.find((o) => o.key === 'a')!, zone))).toEqual(['a', 'b'])
  })

  it('is a row of one for a lone house', () => {
    const { route, all, occs } = setup([house('a', 100)])
    expect(keys(houseRow(route, all, occs, new Set(), occs[0], zone))).toEqual(['a'])
  })

  it('reaches no further ahead than a driver can see from the first house, however close together they are', () => {
    const { route, all, occs } = setup(Array.from({ length: 12 }, (_, i) => house(`h${i}`, 100 + i * 40)))
    const row = houseRow(route, all, occs, new Set(), occs[0], zone)
    expect(row.length).toBeGreaterThan(1)
    expect(row.length).toBeLessThan(12)
    expect(row[row.length - 1].at - row[0].at).toBeLessThanOrEqual(ROW_SPAN_M)
  })

  it('does not carry on round a U-turn to the houses on the way back', () => {
    // Up the road and straight back down it. A house on the east side as the driver goes up is on the left coming back, and one on
    // the west side is on the right coming back, so the same side of the road, driving, is the other side of it by the street.
    // The houses are far enough back from the road that the turn at the top is two passes of them, not one.
    const back = (id: string, m: number, side: 'e' | 'w'): Stop => ({ ...house(id, m, side), lng: (side === 'e' ? 1 : -1) * (14 / 70050) })
    const out: Route = {
      points: [{ lat: 51, lng: 0 }, { lat: 51.0018, lng: 0 }, { lat: 51, lng: 0.0001 }],
      sideChanges: [{ idx: 0, side: 'both' }],
      stops: [back('a', 140, 'e'), back('b', 172, 'e'), back('c', 172, 'w'), back('d', 140, 'w')],
    }
    const all = occurrences(out)
    const occs = alertable(out, all)
    const first = occs.find((o) => o.key === 'a')!
    // Every house is passed twice, and the way back is within the gap of the way out here.
    expect(all.find((o) => o.key === 'c#2')!.at - all.find((o) => o.key === 'b')!.at).toBeLessThan(ROW_GAP_M)
    expect(keys(houseRow(out, all, occs, new Set(), first, zone))).toEqual(['a', 'b'])
  })

  describe('on a street driven both ways, with a side picked by hand', () => {
    // Up the road 400 m and straight back, with left thrown both ways. A house 12 m east is on the right going out, so it is quiet
    // there, and on the left coming back, where it alerts. So a house picked as the right going out is only on the alerting list on
    // its second pass, and the first pass it is told from is not among the passes that alert.
    const twice = (stops: Stop[]): Route => ({ points: [spot(0, 0), spot(0, 400), spot(0, 0)], sideChanges: [{ idx: 0, side: 'left' }], stops })
    const east = (id: string, y: number, extra: Partial<Stop> = {}): Stop => ({ id, type: 'nothrow', pathIdx: 0, ...spot(12, y), ...extra })
    const rowFrom = (stops: Stop[], from: string) => {
      const r = twice(stops)
      const all = occurrences(r)
      const occs = alertable(r, all)
      return { occs, row: keys(houseRow(r, all, occs, new Set(), occs.find((o) => o.key === from)!, zone)) }
    }

    it('takes the swapped side of a house picked by hand into the row, though its first pass is quiet', () => {
      // On the way back the house further along (t) is met first, then s, 40 m after it.
      const { occs, row } = rowFrom([east('s', 300, { side: 'right' }), east('t', 340)], 't#2')
      expect(keys(occs)).toEqual(['t#2', 's#2'])
      expect(row).toEqual(['t#2', 's#2'])
    })

    it('starts a row from a house picked by hand with the side that swaps, though its first pass is quiet', () => {
      const { row } = rowFrom([east('s', 340, { side: 'right' }), east('t', 300)], 's#2')
      expect(row).toEqual(['s#2', 't#2'])
    })
  })
})

describe('which of the queued alerts is the one showing', () => {
  const radius = alertRadius(40)
  const q = (key: string, type: StopType, at: number, off = 0): Occurrence => ({
    key,
    stop: { id: key, type, pathIdx: 0, lat: 0, lng: 0 },
    idx: 0,
    at,
    off,
  })

  it('is the nearest no-throw house ahead, ahead of anything else queued', () => {
    const queue = [q('bundle', 'bundle', 110), q('b', 'nothrow', 140), q('a', 'nothrow', 120)]
    expect(pickCurrent(queue, 100, 100, null, radius)?.key).toBe('a')
  })

  it('is the nearest of the others when no no-throw house is queued', () => {
    expect(pickCurrent([q('r', 'request', 150), q('b', 'bundle', 120)], 100, 100, null, radius)?.key).toBe('b')
  })

  it('moves on to the next house once the one before is gone by, though it is still in the queue', () => {
    const queue = [q('a', 'nothrow', 120), q('b', 'nothrow', 140)]
    expect(pickCurrent(queue, 100, 100, null, radius)?.key).toBe('a')
    expect(pickCurrent(queue, 125 + HEAD_PASSED_M, 125 + HEAD_PASSED_M, null, radius)?.key).toBe('b')
  })

  it('does not go back to a house the driver has gone by when their position wobbles back', () => {
    const queue = [q('a', 'nothrow', 120), q('b', 'nothrow', 140)]
    // The furthest reached is past `a`, though the driver's own position is back before it.
    expect(pickCurrent(queue, 135, 100, null, radius)?.key).toBe('b')
  })

  it('is the one least far behind when all are gone by, and nothing when the queue is empty', () => {
    const queue = [q('a', 'nothrow', 120), q('b', 'nothrow', 140)]
    expect(pickCurrent(queue, 200, 200, null, radius)?.key).toBe('b')
    expect(pickCurrent([], 0, 0, null, radius)).toBeUndefined()
  })

  it('measures a stop met by where the driver is from where they are, not along the route', () => {
    const far = { ...q('off', 'nothrow', 120, 200), stop: { id: 'off', type: 'nothrow' as const, pathIdx: 0, lat: 0.0009, lng: 0 } }
    expect(aheadOf(far, 0, { lat: 0, lng: 0 }, radius)).toBeGreaterThan(90)
    expect(aheadOf(far, 0, { lat: 0, lng: 0 }, radius)).toBeLessThan(110)
    expect(aheadOf(q('a', 'nothrow', 120), 100, { lat: 0, lng: 0 }, radius)).toBe(20)
  })

  it('counts a stop as gone by only once the driver is past it by a few metres', () => {
    const a = q('a', 'nothrow', 120)
    expect(isGoneBy(a, 118, 118, null, radius)).toBe(false)
    expect(isGoneBy(a, 125, 125, null, radius)).toBe(false)
    expect(isGoneBy(a, 120 + HEAD_PASSED_M, 120 + HEAD_PASSED_M, null, radius)).toBe(true)
  })

  describe('a no-throw house the driver has gone by, and a stop still to come', () => {
    it('does not hide a bundle drop that is live, whose Dropped button is the only way to confirm it', () => {
      const queue = [q('house', 'nothrow', 100), q('bundle', 'bundle', 120)]
      // 15 m past the house and 5 m short of the bundle.
      expect(pickCurrent(queue, 115, 115, null, radius)?.key).toBe('bundle')
      // Whichever order they were queued in.
      expect(pickCurrent([...queue].reverse(), 115, 115, null, radius)?.key).toBe('bundle')
    })

    it('does not hide a special request that is live either', () => {
      expect(pickCurrent([q('house', 'nothrow', 100), q('request', 'request', 130)], 120, 120, null, radius)?.key).toBe('request')
    })

    it('moves on to the live stop exactly when the house is gone by, and not before', () => {
      const queue = [q('house', 'nothrow', 100), q('bundle', 'bundle', 120)]
      expect(pickCurrent(queue, 100 + HEAD_PASSED_M - 0.5, 100 + HEAD_PASSED_M - 0.5, null, radius)?.key).toBe('house')
      expect(pickCurrent(queue, 100 + HEAD_PASSED_M, 100 + HEAD_PASSED_M, null, radius)?.key).toBe('bundle')
    })

    it('goes by the furthest the driver got, so a wobble back does not bring the house back over the bundle', () => {
      const queue = [q('house', 'nothrow', 100), q('bundle', 'bundle', 120)]
      expect(pickCurrent(queue, 115, 90, null, radius)?.key).toBe('bundle')
    })

    it('still puts a house that is live before a bundle that is live', () => {
      const queue = [q('bundle', 'bundle', 110), q('house', 'nothrow', 140)]
      expect(pickCurrent(queue, 100, 100, null, radius)?.key).toBe('house')
    })

    it('still takes the nearest live house, and not one gone by, when several are queued', () => {
      const queue = [q('gone', 'nothrow', 90), q('near', 'nothrow', 110), q('far', 'nothrow', 150), q('bundle', 'bundle', 105)]
      expect(pickCurrent(queue, 105, 105, null, radius)?.key).toBe('near')
    })

    it('judges a stop met by where the driver is by how far away it is, whichever it is', () => {
      const far = { ...q('off', 'bundle', 120, 200), stop: { id: 'off', type: 'bundle' as const, pathIdx: 0, lat: 0.0003, lng: 0 } }
      // About 33 m from the driver: live, and the house just behind does not hide it.
      expect(pickCurrent([q('house', 'nothrow', 100), far], 115, 115, { lat: 0, lng: 0 }, radius)?.key).toBe('off')
    })
  })

  describe('an apartment block and a bundle drop or special request', () => {
    it('puts a live bundle drop or special request before a live block, whichever is nearer, as the block is shown in its banner', () => {
      for (const type of ['bundle', 'request'] as const) {
        // The block 5 m ahead and the other 15 m ahead, in either order.
        const queue = [q('k', 'block', 105), q('o', type, 115)]
        expect(pickCurrent(queue, 100, 100, null, radius)?.key, type).toBe('o')
        expect(pickCurrent([...queue].reverse(), 100, 100, null, radius)?.key, type).toBe('o')
      }
    })

    it('does not let a block just behind the car hide a bundle drop at the wheels, whose Dropped button is the only way to confirm it', () => {
      const queue = [q('k', 'block', 100), q('o', 'bundle', 105)]
      expect(pickCurrent(queue, 105, 105, null, radius)?.key).toBe('o')
      // Nor once the car is a few metres past the bundle, while the block is still live too.
      expect(pickCurrent(queue, 108, 108, null, radius)?.key).toBe('o')
    })

    it('is the block when nothing else is live, and a live no-throw house before either', () => {
      expect(pickCurrent([q('o', 'bundle', 80), q('k', 'block', 105)], 100, 100, null, radius)?.key).toBe('k')
      expect(pickCurrent([q('k', 'block', 105), q('o', 'bundle', 110), q('h', 'nothrow', 120)], 100, 100, null, radius)?.key).toBe('h')
    })

    it('is the nearest of two blocks when there is nothing else', () => {
      expect(pickCurrent([q('far', 'block', 130), q('near', 'block', 110)], 100, 100, null, radius)?.key).toBe('near')
    })
  })
})

describe('driving past a bundle drop with a no-throw house near it, as the round screen does', () => {
  // A road north with a bundle drop 500 m along. The driver goes along it in 2 m steps without tapping anything. As the screen does, each step
  // leaves the zones that have been left (a stop gone past is done), brings up what has come into reach, and shows what pickCurrent picks.
  const STEP = 2
  const radius = alertRadius(40)
  const drive = (stops: Stop[]) => {
    const route: Route = { points: [spot(0, 0), spot(0, 1000)], sideChanges: [{ idx: 0, side: 'both' }], stops }
    const occs = alertable(route, occurrences(route))
    let queue: Occurrence[] = []
    const seen = new Set<string>()
    const handled = new Set<string>()
    const showing: [number, string | undefined][] = []
    for (let y = 0; y <= 1000; y += STEP) {
      const pos = spot(0, y)
      const left = queue.flatMap((o) => {
        const exit = zoneExit(o, y, radius, pos)
        return exit ? [{ o, exit }] : []
      })
      queue = queue.filter((o) => !left.some((l) => l.o.key === o.key))
      for (const l of left) {
        if (l.exit === 'passed') handled.add(l.o.key)
        else seen.delete(l.o.key)
      }
      const fresh = approachingOccurrences(y, pos, occs, handled, radius, 5).filter((o) => !seen.has(o.key))
      for (const o of fresh) seen.add(o.key)
      queue = [...queue, ...fresh]
      showing.push([y, pickCurrent(queue, y, y, pos, radius)?.key])
    }
    return showing
  }
  const bundle: Stop = { id: 'bundle', type: 'bundle', pathIdx: 0, ...spot(8, 500) }
  const house = (offset: number): Stop => ({ id: 'house', type: 'nothrow', pathIdx: 0, ...spot(8, 500 + offset) })
  /** Metres of road, before the bundle and in all, on which its alert (and so its Dropped button) was showing. */
  const metres = (stops: Stop[]) => {
    const log = drive(stops)
    const on = log.filter(([, key]) => key === 'bundle')
    return { before: on.filter(([y]) => y < 500).length * STEP, total: on.length * STEP }
  }

  /** Within a step of the figure: where exactly a zone starts depends on the rounding of the distances. */
  const about = (got: number, want: number) => expect(Math.abs(got - want), `${got} against ${want}`).toBeLessThanOrEqual(STEP)

  it('shows a bundle drop alone for the whole of its zone', () => {
    const alone = metres([bundle])
    about(alone.before, 40)
    about(alone.total, 80)
  })

  it('shows the bundle once a house just before it is passed, instead of only after the car has gone by the bundle', () => {
    // The house is 30 m before the bundle: passed 10 m on, 20 m before the bundle. The bundle was hidden for all of that before.
    const thirty = metres([bundle, house(-30)])
    about(thirty.before, 20)
    about(thirty.total, 62)
    const fifteen = metres([bundle, house(-15)])
    about(fifteen.before, 4)
    about(fifteen.total, 32)
  })

  it('shows the bundle for the stretch before a house just after it comes into reach', () => {
    about(metres([bundle, house(10)]).before, 8)
    about(metres([bundle, house(25)]).before, 24)
    about(metres([bundle, house(40)]).before, 38)
  })

  it('has the bundle showing as the car reaches it when the house before it has been passed', () => {
    const at = (y: number, log: [number, string | undefined][]) => log.find(([m]) => m === y)?.[1]
    const log = drive([bundle, house(-30)])
    expect(at(470, log)).toBe('house')
    expect(at(490, log)).toBe('bundle')
    expect(at(500, log)).toBe('bundle')
  })

  it('still has the bundle wait for a house at the same spot, which is passed only as the bundle is', () => {
    // What still waits: a house at the very spot of the bundle hides it for as long as it is live, and then the bundle is gone by too.
    expect(metres([bundle, house(0)]).before).toBe(0)
  })
})

describe('how a row of plates is laid out', () => {
  it('is one line for as many as fit on one', () => {
    expect(platesLayout(1, 5)).toEqual({ shown: 1, more: 0, lines: 1 })
    expect(platesLayout(5, 5)).toEqual({ shown: 5, more: 0, lines: 1 })
  })

  it('is two lines when there are more than fit on one', () => {
    expect(platesLayout(6, 5)).toEqual({ shown: 6, more: 0, lines: 2 })
    expect(platesLayout(10, 5)).toEqual({ shown: 10, more: 0, lines: 2 })
  })

  it('is two lines with the last place saying how many more, when even two are not enough', () => {
    expect(platesLayout(11, 5)).toEqual({ shown: 9, more: 2, lines: 2 })
    expect(platesLayout(12, 5)).toEqual({ shown: 9, more: 3, lines: 2 })
  })

  it('always accounts for every house, in the plates or in the more', () => {
    for (let n = 1; n <= 30; n++) {
      const { shown, more } = platesLayout(n, 4)
      expect(shown + more).toBe(n)
    }
  })
})

describe('what a plate shows', () => {
  const stop = (extra: Partial<Stop>): Stop => ({ id: 's', type: 'nothrow', pathIdx: 0, lat: 0, lng: 0, ...extra })

  it('shows the house number', () => {
    expect(plateText(stop({ address: '14 Oak Road' }))).toEqual({ text: '14', named: false })
  })

  it('shows the start of what a house is called when it has no number, marked as a name', () => {
    expect(plateText(stop({ label: 'Mrs Smith' }))).toEqual({ text: 'Mrs\u2026', named: true })
    expect(plateText(stop({ label: 'Rose' }))).toEqual({ text: 'Rose', named: true })
  })

  it('shows a dot for a house with neither', () => {
    expect(plateText(stop({}))).toEqual({ text: '\u2022', named: false })
  })
})

describe('what is said for the alerts that have just come up', () => {
  const q = (key: string, type: StopType, at: number, extra: Partial<Stop> = {}): Occurrence => ({
    key,
    stop: { id: key, type, pathIdx: 0, lat: 0, lng: 0, ...extra },
    idx: 0,
    at,
    off: 0,
  })
  const num = (n: string, at: number) => q(n, 'nothrow', at, { address: `${n} Oak Road` })

  it('says a row of houses once, all together, and marks every one of them as said', () => {
    const row = [num('12', 100), num('14', 120), num('16', 140)]
    const plan = planSpeech([row[0]], () => row, new Set())
    expect(plan.text).toBe('No throw, 12, 14, 16.')
    expect(plan.announce).toEqual(['12', '14', '16'])
  })

  it('says the row only once when several of its houses come up together', () => {
    const row = [num('12', 100), num('14', 120)]
    const plan = planSpeech(row, () => row, new Set())
    expect(plan.text).toBe('No throw, 12, 14.')
  })

  it('says nothing for a row that has been said', () => {
    const row = [num('12', 100), num('14', 120)]
    expect(planSpeech([row[1]], () => row, new Set(['12', '14'])).text).toBe('')
  })

  it('marks as said only the houses that were said, so the rest are said when the driver gets to them', () => {
    const row = Array.from({ length: 9 }, (_, i) => num(String(10 + i * 2), 100 + i * 20))
    const plan = planSpeech([row[0]], () => row, new Set())
    expect(plan.text).toContain(`and ${9 - SPOKEN_ROW_MAX} more`)
    expect(plan.announce).toEqual(row.slice(0, SPOKEN_ROW_MAX).map((o) => o.key))
  })

  it('says a bundle drop or a special request on its own, after the houses', () => {
    const house = num('12', 100)
    const bundle = q('b', 'bundle', 90, { address: '9 Elm Street', qty: 3 })
    const plan = planSpeech([bundle, house], () => [house], new Set())
    expect(plan.text).toBe('No throw, 12. Bundle drop, 9, 3 papers.')
    expect(plan.announce).toEqual(['12'])
  })

  it('says nothing when nothing has come up', () => {
    expect(planSpeech([], () => [], new Set())).toEqual({ text: '', announce: [] })
  })
})

describe('saying a house number', () => {
  it('says a plain number as it is', () => {
    expect(spokenNumber('14')).toBe('14')
    expect(spokenNumber('120')).toBe('120')
  })

  it('says the letter of a number by itself', () => {
    expect(spokenNumber('12A')).toBe('12 A')
    expect(spokenNumber('7B')).toBe('7 B')
  })

  it('says a unit and a number, and a range', () => {
    expect(spokenNumber('3/12')).toBe('3 slash 12')
    expect(spokenNumber('12-14')).toBe('12 to 14')
    expect(spokenNumber('3/12A')).toBe('3 slash 12 A')
  })
})

describe('what is said when an alert comes up', () => {
  const stop = (type: StopType, extra: Partial<Stop> = {}): Stop => ({ id: 's', type, pathIdx: 0, lat: 0, lng: 0, ...extra })
  const house = (n: string) => stop('nothrow', { id: n, address: `${n} Oak Road` })

  it('says no throw and the number of a no-throw house', () => {
    expect(alertSpeech([house('14')])).toBe('No throw, 14.')
    expect(alertSpeech([stop('nothrow', { address: '12A Oak Road' })])).toBe('No throw, 12 A.')
  })

  it('says every number in a row of no-throw houses, in order', () => {
    expect(alertSpeech([house('12'), house('14'), house('16')])).toBe('No throw, 12, 14, 16.')
  })

  it('says how many more there are in a row too long to say', () => {
    const row = Array.from({ length: 9 }, (_, i) => house(String(10 + i * 2)))
    expect(alertSpeech(row)).toBe(`No throw, 10, 12, 14, 16, 18, 20, and ${9 - SPOKEN_ROW_MAX} more.`)
  })

  it('says what a no-throw house is called when it has no number, and just no throw when it has neither', () => {
    expect(alertSpeech([stop('nothrow', { label: 'Mrs Smith' })])).toBe('No throw, Mrs Smith.')
    expect(alertSpeech([stop('nothrow', { address: 'Rose Cottage, Mill Lane' })])).toBe('No throw, Rose Cottage, Mill Lane.')
    expect(alertSpeech([stop('nothrow')])).toBe('No throw.')
  })

  it('leaves out the houses with nothing to say in a row', () => {
    expect(alertSpeech([house('12'), stop('nothrow'), house('16')])).toBe('No throw, 12, 16.')
  })

  it('says how many papers a bundle drop gets, with its number', () => {
    expect(alertSpeech([stop('bundle', { address: '9 Elm Street', qty: 12 })])).toBe('Bundle drop, 9, 12 papers.')
    expect(alertSpeech([stop('bundle', { label: "Joe's Cafe", qty: 1 })])).toBe("Bundle drop, Joe's Cafe, 1 paper.")
    expect(alertSpeech([stop('bundle', { address: '9 Elm Street' })])).toBe('Bundle drop, 9.')
    expect(alertSpeech([stop('bundle')])).toBe('Bundle drop.')
  })

  it('says a special request with its number and then its note', () => {
    expect(alertSpeech([stop('request', { address: '23 Oak Road', note: 'Blue gate, deliver by hand' })])).toBe('Special request, 23. Blue gate, deliver by hand.')
    expect(alertSpeech([stop('request', { note: 'Blue gate' })])).toBe('Special request. Blue gate.')
    expect(alertSpeech([stop('request', { address: '23 Oak Road' })])).toBe('Special request, 23.')
  })

  it('says nothing for nothing', () => {
    expect(alertSpeech([])).toBe('')
  })
})

describe('how far from the route a no-throw house can be kept quiet, at the alert distance', () => {
  // A road heading north, 11 points about 111 m apart, thrown to the left. East is its right, the side that is not thrown.
  const north: Pt[] = Array.from({ length: 11 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 }))
  const farEast = (id: string, m: number, lat = 51.0045): Stop => ({ id, type: 'nothrow', pathIdx: 0, lat, lng: m / 70050 })
  const thrown = (side: Side, stops: Stop[]): Route => ({ points: north, sideChanges: [{ idx: 0, side }], stops })
  const alerts = (r: Route, reach?: number) => alertable(r, occurrences(r), reach).map((o) => o.stop.id)

  it('is the alert distance and 30 m, which is where a house starts to be met by where the driver is', () => {
    for (const d of ALERT_DISTANCES) {
      expect(quietReachFor(d)).toBe(d + 30)
      expect(byPosition({ off: quietReachFor(d), stop: { type: 'nothrow' } as Stop }, alertRadius(d))).toBe(false)
      expect(byPosition({ off: quietReachFor(d) + 0.01, stop: { type: 'nothrow' } as Stop }, alertRadius(d))).toBe(true)
    }
    expect(quietReachFor(DEFAULT_ALERT_DISTANCE)).toBe(70)
    expect(quietReachFor(ALERT_DISTANCES[0])).toBe(QUIET_REACH_M)
  })

  it('keeps a house 41 to 70 m back on the side that is not thrown quiet at the usual alert distance', () => {
    const reach = quietReachFor(40)
    for (const m of [41, 45, 55, 65, 70]) {
      const r = thrown('left', [farEast('s', m)])
      expect(alerts(r, reach), `${m} m`).toEqual([])
      expect(stopQuietReasons(r, occurrences(r), 's', reach)).toEqual(['otherSide'])
      // As it was, with the reach at its least: it alerts, beeping and being named, whatever is thrown.
      expect(alerts(r), `${m} m at the least reach`).toEqual(['s'])
    }
  })

  it('still alerts for a house beyond the reach, which is met by where the driver is', () => {
    expect(alerts(thrown('left', [farEast('s', 75)]), quietReachFor(40))).toEqual(['s'])
    expect(alerts(thrown('left', [farEast('s', 95)]), quietReachFor(40))).toEqual(['s'])
    expect(alerts(thrown('transit', [farEast('s', 75)]), quietReachFor(40))).toEqual(['s'])
  })

  it('keeps such a house quiet all through a stretch of transit', () => {
    const r = thrown('transit', [farEast('a', 45), farEast('b', 50, 51.0055), farEast('c', 25, 51.0065)])
    expect(alerts(r, quietReachFor(40))).toEqual([])
    expect(alerts(r)).toEqual(['a', 'b'])
    expect(stopQuietReasons(r, occurrences(r), 'a', quietReachFor(40))).toEqual(['transit'])
  })

  it('widens and narrows with the alert distance, so a house is never silenced that would alert by where the driver is', () => {
    for (const d of ALERT_DISTANCES) {
      const radius = alertRadius(d)
      for (let m = 5; m <= 130; m += 5) {
        const r = thrown('left', [farEast('s', m)])
        const [o] = occurrences(r)
        const quiet = quietReason(r, [o], o, quietReachFor(d)) !== null
        expect(quiet, `${m} m at ${d} m`).toBe(!byPosition(o, radius))
      }
    }
  })

  it('is judged exactly at the reach: quiet at it, alerting just past it', () => {
    const r = thrown('left', [farEast('s', 30)])
    const [o] = occurrences(r)
    for (const reach of [40, 70, 90]) {
      expect(quietReason(r, [o], { ...o, off: reach }, reach)).toBe('otherSide')
      expect(quietReason(r, [o], { ...o, off: reach + 0.01 }, reach)).toBeNull()
    }
  })

  it('is passed to every count and list that depends on it', () => {
    const reach = quietReachFor(40)
    const wide = thrown('left', [farEast('s', 55)])
    const occs = occurrences(wide)
    expect(quietHouseIds(wide, occs).size).toBe(0)
    expect(quietHouseIds(wide, occs, reach)).toEqual(new Set(['s']))
    expect(quietNoThrows(wide)).toBe(0)
    expect(quietNoThrows(wide, reach)).toBe(1)
    const transit = thrown('transit', [farEast('s', 55)])
    expect(onlyInTransit(transit, occurrences(transit), 's')).toBe(false)
    expect(onlyInTransit(transit, occurrences(transit), 's', reach)).toBe(true)
    // A house on the line of a route thrown both ways has no side to tell, at either reach.
    const online = thrown('both', [{ ...farEast('o', 0), lng: 0 }])
    expect(stopsWithoutSide(online, online.stops).map((x) => x.id)).toEqual(['o'])
    expect(stopsWithoutSide(online, online.stops, reach).map((x) => x.id)).toEqual(['o'])
    // On transit it is not asked about, since it never alerts.
    const dark = thrown('transit', [{ ...farEast('o', 0), lng: 0 }])
    expect(stopsWithoutSide(dark, dark.stops, reach)).toEqual([])
  })

  it('leaves the least reach as it was when none is given', () => {
    expect(QUIET_REACH_M).toBe(40)
    expect(alerts(thrown('left', [farEast('s', 35)]))).toEqual([])
    expect(alerts(thrown('left', [farEast('s', 45)]))).toEqual(['s'])
  })

  it('is what makes a round of a Left street with houses back from the road name no right-hand house', () => {
    // Houses every 20 m on both sides, the east ones 45 m back and the west ones 15 m. Left is thrown.
    const stops: Stop[] = []
    for (let i = 0; i < 20; i++) {
      stops.push(farEast(`e${i}`, 45, 51.0003 + i * 0.00045))
      stops.push({ ...farEast(`w${i}`, 0, 51.0003 + i * 0.00045), lng: -15 / 70050 })
    }
    const r = thrown('left', stops)
    const reach = quietReachFor(40)
    expect(alerts(r, reach).every((id) => id.startsWith('w'))).toBe(true)
    expect(alerts(r, reach)).toHaveLength(20)
    expect(alerts(r).filter((id) => id.startsWith('e'))).toHaveLength(20)
  })
})

describe('when the voice may name a no-throw house', () => {
  // A road heading north. East is the right of the way, west the left.
  const north: Pt[] = Array.from({ length: 11 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 }))
  const radius = alertRadius(40)
  const stop = (id: string, lng: number, extra: Partial<Stop> = {}): Stop => ({ id, type: 'nothrow', pathIdx: 0, lat: 51.0045, lng, ...extra })
  const route = (stops: Stop[], side: Side = 'both'): Route => ({ points: north, sideChanges: [{ idx: 0, side }], stops })
  const may = (stops: Stop[], id: string, thrownNow: Side, side: Side = 'both') => {
    const r = route(stops, side)
    const occs = occurrences(r)
    return voiceable(r, occs, occs.find((o) => o.key === id)!, thrownNow, radius)
  }
  const onLeft = stop('l', -0.0002)
  const onRight = stop('r', 0.0002)

  it('is only for a house on the side thrown where the driver is', () => {
    expect(may([onLeft], 'l', 'left')).toBe(true)
    expect(may([onLeft], 'l', 'right')).toBe(false)
    expect(may([onRight], 'r', 'right')).toBe(true)
    expect(may([onRight], 'r', 'left')).toBe(false)
  })

  it('is for a house on either side where both sides are thrown', () => {
    expect(may([onLeft], 'l', 'both')).toBe(true)
    expect(may([onRight], 'r', 'both')).toBe(true)
  })

  it('is never while the driver is on a stretch of transit', () => {
    expect(may([onLeft], 'l', 'transit')).toBe(false)
    expect(may([onRight], 'r', 'transit')).toBe(false)
  })

  it('is for a house whose side cannot be told, whatever is thrown', () => {
    const online = stop('o', 0)
    for (const thrownNow of ['left', 'right', 'both'] as const) expect(may([online], 'o', thrownNow, 'both')).toBe(true)
    // On the line of a route thrown to the left, the house takes the left, as the alert shows it.
    expect(may([online], 'o', 'left', 'left')).toBe(true)
    expect(may([online], 'o', 'right', 'left')).toBe(false)
  })

  it('goes by a side picked by hand', () => {
    expect(may([stop('p', 0.0002, { side: 'left' })], 'p', 'left')).toBe(true)
    expect(may([stop('p', 0.0002, { side: 'left' })], 'p', 'right')).toBe(false)
  })

  it('is for a house met by where the driver is, which no stretch of the route says anything of', () => {
    const far = stop('f', 130 / 70050)
    for (const thrownNow of ['left', 'right', 'both', 'transit'] as const) expect(may([far], 'f', thrownNow, 'left')).toBe(true)
  })

  it('is for a bundle drop, a special request and an apartment block, on any side and on transit', () => {
    for (const type of ['bundle', 'request', 'block'] as const) {
      const other = stop('x', 0.0002, { type })
      for (const thrownNow of ['left', 'right', 'both', 'transit'] as const) expect(may([other], 'x', thrownNow), `${type} ${thrownNow}`).toBe(true)
    }
  })

  it('judges a street driven twice by the pass, as the alert does', () => {
    const back = [...north].reverse().slice(1)
    const r: Route = { points: [...north, ...back], sideChanges: [{ idx: 0, side: 'both' }], stops: [onRight] }
    const [first, second] = occurrences(r)
    expect(voiceable(r, [first, second], first, 'right', radius)).toBe(true)
    expect(voiceable(r, [first, second], first, 'left', radius)).toBe(false)
    expect(voiceable(r, [first, second], second, 'left', radius)).toBe(true)
    expect(voiceable(r, [first, second], second, 'right', radius)).toBe(false)
  })
})

describe('an apartment block', () => {
  const block = (extra: Partial<Stop> = {}): Stop => ({ id: 'b', type: 'block', pathIdx: 0, lat: 0, lng: 0, ...extra })

  describe('on the banner', () => {
    it('is titled as an apartment block, with how many papers to throw there', () => {
      expect(alertText(block({ label: 'Oak Towers', qty: 12 }))).toEqual({
        title: 'Apartment block',
        name: 'Oak Towers',
        address: null,
        papers: '12 papers',
        number: null,
      })
      expect(alertText(block({ label: 'Oak Towers', qty: 1 })).papers).toBe('1 paper')
    })

    it('has no papers to show when it has no count, and a line to say what it is when it has no name', () => {
      expect(alertText(block({ label: 'Oak Towers' })).papers).toBeNull()
      expect(alertText(block({ label: 'Oak Towers', qty: 0 })).papers).toBeNull()
      expect(alertText(block())).toEqual({ title: 'Apartment block', name: 'Throw its papers here.', address: null, papers: null, number: null })
    })

    it('shows the house number on its plate, and the address under the name when there is both', () => {
      expect(alertText(block({ label: 'Oak Towers', address: '12 Oak Road, Lewes', qty: 30 }))).toEqual({
        title: 'Apartment block',
        name: 'Oak Towers',
        address: 'Oak Road, Lewes',
        papers: '30 papers',
        number: '12',
      })
      expect(alertText(block({ address: '12 Oak Road', qty: 30 }))).toMatchObject({ name: 'Oak Road', address: null, number: '12' })
    })
  })

  describe('out loud', () => {
    it('says how many papers and which side', () => {
      expect(alertSpeech([block({ qty: 12 })], 'left')).toBe('Apartment block, 12 papers, left.')
      expect(alertSpeech([block({ qty: 12 })], 'right')).toBe('Apartment block, 12 papers, right.')
      expect(alertSpeech([block({ qty: 1 })], 'left')).toBe('Apartment block, 1 paper, left.')
    })

    it('says its number, or what it is called, as the other alerts do', () => {
      expect(alertSpeech([block({ address: '9 Elm Street', qty: 12 })], 'left')).toBe('Apartment block, 9, 12 papers, left.')
      expect(alertSpeech([block({ label: 'Oak Towers', qty: 12 })], 'right')).toBe('Apartment block, Oak Towers, 12 papers, right.')
      expect(alertSpeech([block({ address: '12A Elm Street', qty: 3 })], 'left')).toBe('Apartment block, 12 A, 3 papers, left.')
    })

    it('leaves the side out when it cannot be told', () => {
      expect(alertSpeech([block({ qty: 12 })])).toBe('Apartment block, 12 papers.')
      expect(alertSpeech([block({ qty: 12 })], null)).toBe('Apartment block, 12 papers.')
    })

    it('leaves the papers out when there is no count', () => {
      expect(alertSpeech([block()], 'left')).toBe('Apartment block, left.')
      expect(alertSpeech([block({ address: '9 Elm Street' })], 'right')).toBe('Apartment block, 9, right.')
      expect(alertSpeech([block({ qty: 0 })], 'left')).toBe('Apartment block, left.')
      expect(alertSpeech([block()])).toBe('Apartment block.')
    })

    it('does not put a side on the other alerts', () => {
      expect(alertSpeech([{ ...block({ qty: 3, address: '9 Elm Street' }), type: 'bundle' }], 'left')).toBe('Bundle drop, 9, 3 papers.')
      expect(alertSpeech([{ ...block({ address: '9 Elm Street' }), type: 'nothrow' }], 'left')).toBe('No throw, 9.')
      expect(alertSpeech([{ ...block({ note: 'Blue gate' }), type: 'request' }], 'left')).toBe('Special request. Blue gate.')
    })
  })

  describe('in what is said for the alerts that have just come up', () => {
    const q = (key: string, type: StopType, at: number, extra: Partial<Stop> = {}): Occurrence => ({
      key,
      stop: { id: key, type, pathIdx: 0, lat: 0, lng: 0, ...extra },
      idx: 0,
      at,
      off: 0,
    })

    it('says it on its own, after the houses, with the side the screen gives', () => {
      const house = q('12', 'nothrow', 100, { address: '12 Oak Road' })
      const flats = q('b', 'block', 90, { address: '9 Elm Street', qty: 12 })
      const plan = planSpeech([flats, house], () => [house], new Set(), () => 'left')
      expect(plan.text).toBe('No throw, 12. Apartment block, 9, 12 papers, left.')
      // It is not a row of houses, so it is not among those marked as said.
      expect(plan.announce).toEqual(['12'])
    })

    it('says it without a side when the screen gives none', () => {
      const flats = q('b', 'block', 90, { qty: 12 })
      expect(planSpeech([flats], () => [flats], new Set()).text).toBe('Apartment block, 12 papers.')
      expect(planSpeech([flats], () => [flats], new Set(), () => null).text).toBe('Apartment block, 12 papers.')
    })

    it('asks for the side of each stop it says that is not a house', () => {
      const asked: string[] = []
      const bundle = q('d', 'bundle', 80, { qty: 2, address: '7 Elm Street' })
      const flats = q('b', 'block', 90, { qty: 12 })
      const plan = planSpeech([bundle, flats], () => [], new Set(), (o) => (asked.push(o.key), 'right'))
      expect(plan.text).toBe('Bundle drop, 7, 2 papers. Apartment block, 12 papers, right.')
      expect(asked).toContain('b')
    })
  })

  describe('among the alerts', () => {
    const north: Pt[] = Array.from({ length: 11 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 }))
    const flats = (extra: Partial<Stop> = {}): Stop => ({ id: 'b', type: 'block', pathIdx: 0, lat: 51.0045, lng: 0.0002, qty: 12, ...extra })
    const r = (side: Side, stops: Stop[]): Route => ({ points: north, sideChanges: [{ idx: 0, side }], stops })

    it('is never quiet, on whichever side is thrown and on transit', () => {
      for (const side of ['left', 'right', 'both', 'transit'] as const) {
        const route = r(side, [flats()])
        expect(alertable(route, occurrences(route)).map((o) => o.stop.id), side).toEqual(['b'])
        expect(stopQuietReasons(route, occurrences(route), 'b')).toEqual([null])
        expect(quietNoThrows(route)).toBe(0)
        expect(quietHouseIds(route, occurrences(route)).size).toBe(0)
      }
    })

    it('is never quiet however far it is from the route', () => {
      const far = r('transit', [flats({ lng: 100 / 70050 })])
      expect(alertable(far, occurrences(far)).map((o) => o.stop.id)).toEqual(['b'])
      expect(alertable(far, occurrences(far), quietReachFor(60))).toHaveLength(1)
    })

    it('is not asked for a side, and is not a house in transit', () => {
      const route = r('transit', [flats({ lng: 0 })])
      expect(stopsWithoutSide(route, route.stops)).toEqual([])
      expect(onlyInTransit(route, occurrences(route), 'b')).toBe(true)
    })

    it('is asked for a side when it is on the line where something is thrown, as its side is said with its alert', () => {
      for (const side of ['left', 'right', 'both'] as const) {
        const online = r(side, [flats({ lng: 0 })])
        expect(stopsWithoutSide(online, online.stops).map((s) => s.id), side).toEqual(['b'])
        const beside = r(side, [flats()])
        expect(stopsWithoutSide(beside, beside.stops), side).toEqual([])
      }
      expect(stopsWithoutSide(r('left', [flats({ lng: 0, side: 'left' })]), [flats({ lng: 0, side: 'left' })])).toEqual([])
    })

    it('has a side worked out like any stop, and nothing for one on the line', () => {
      expect(stopRoadSides(r('left', [flats()]), occurrences(r('left', [flats()])), 'b')).toEqual(['right'])
      expect(stopRoadSides(r('left', [flats({ lng: -0.0002 })]), occurrences(r('left', [flats({ lng: -0.0002 })])), 'b')).toEqual(['left'])
      expect(stopRoadSides(r('left', [flats({ lng: 0 })]), occurrences(r('left', [flats({ lng: 0 })])), 'b')).toEqual([null])
    })

    it('is done when it is passed, as a house is, by a zone as wide as the alert distance', () => {
      const zone = alertRadius(30)
      const o: Occurrence = { key: 'b', stop: flats(), idx: 0, at: 500, off: 0 }
      expect(zone.block).toBe(30)
      expect(zoneExit(o, 500, zone)).toBeNull()
      expect(zoneExit(o, 531, zone)).toBe('passed')
      expect(zoneExit(o, 500 - 30 - BACK_OFF_SLACK_M - 1, zone)).toBe('back')
    })

    it('is a stop on its own in a row of houses, which it is not part of', () => {
      const route = r('left', [flats({ lng: -0.0002 }), { id: 'h', type: 'nothrow', pathIdx: 0, lat: 51.0046, lng: -0.0002 }])
      const occs = occurrences(route)
      const radius = alertRadius(40)
      const b = occs.find((o) => o.stop.id === 'b')!
      const h = occs.find((o) => o.stop.id === 'h')!
      expect(houseRow(route, occs, occs, new Set(), b, radius)).toEqual([b])
      expect(houseRow(route, occs, occs, new Set(), h, radius)).toEqual([h])
    })

    it('shows after a house is gone by, like a bundle drop: a live house is the alert', () => {
      const radius = alertRadius(40)
      const house = { ...occ('nothrow', 520), key: 'h' }
      const flat = { ...occ('block', 500), key: 'b' }
      expect(pickCurrent([flat, house], 490, 490, null, radius)?.key).toBe('h')
      expect(pickCurrent([flat, house], 600, 600, null, radius)?.key).toBe('h')
      expect(pickCurrent([flat], 490, 490, null, radius)?.key).toBe('b')
    })
  })
})

describe('a house at the turn-round of a court', () => {
  const house = (id: string, x: number, y: number, extra: Partial<Stop> = {}): Stop => ({ id, type: 'nothrow', pathIdx: 0, ...spot(x, y), ...extra })
  /** A house every 15 m up the court, each side of the street. East is the right going in and the left coming out. */
  const stops = (): Stop[] => {
    const out: Stop[] = []
    for (let y = 0; y <= 300; y += 15) out.push(house(`E${y}`, 12, y), house(`W${y}`, -12, y))
    return out
  }
  /** Three ways of turning round at the end of a 300 m court: straight back along the line, the U-turn the app draws (6 m on, 5 m across, 8 m back), and a longer one. */
  const heads: Record<string, Pt[]> = {
    'an exact reversal': [spot(0, 0), spot(0, 300), spot(0, 0)],
    'the U-turn shape': [spot(0, 0), spot(0, 300), spot(0, 306), spot(5, 306), spot(5, 292), spot(5, 0)],
    'a longer U-turn shape': [spot(0, 0), spot(0, 300), spot(0, 316), spot(7, 316), spot(7, 302), spot(7, 0)],
  }
  const court = (points: Pt[], side: Side, list = stops()): Route => ({ points, sideChanges: [{ idx: 0, side }], stops: list })
  /** How many times each house alerts. */
  const alertsOf = (r: Route, reach?: number) => {
    const counts = new Map<string, number>()
    for (const o of alertable(r, occurrences(r), reach)) counts.set(o.stop.id, (counts.get(o.stop.id) ?? 0) + 1)
    return counts
  }

  for (const [name, points] of Object.entries(heads)) {
    describe(`at the end of ${name}`, () => {
      it('alerts every house once when the same side is thrown both ways: none is silent and none alerts twice', () => {
        for (const side of ['right', 'left'] as const) {
          const r = court(points, side)
          const counts = alertsOf(r)
          for (const s of r.stops) expect(counts.get(s.id) ?? 0, `${s.id} thrown ${side}`).toBe(1)
        }
      })

      it('alerts the houses at 285 m and 300 m, on both sides, when right is thrown both ways', () => {
        const r = court(points, 'right')
        const counts = alertsOf(r)
        for (const id of ['E285', 'W285', 'E300', 'W300']) expect(counts.get(id), id).toBe(1)
      })

      it('alerts every house as many times as the route passes it when both sides are thrown', () => {
        const r = court(points, 'both')
        const counts = alertsOf(r)
        const passes = new Map<string, number>()
        for (const o of occurrences(r)) passes.set(o.stop.id, (passes.get(o.stop.id) ?? 0) + 1)
        for (const s of r.stops) expect(counts.get(s.id), s.id).toBe(passes.get(s.id))
      })

      it('keeps the keys and the number of passes of every house', () => {
        const r = court(points, 'right')
        const occs = occurrences(r)
        for (const s of r.stops) {
          const keys = occs.filter((o) => o.stop.id === s.id).map((o) => o.key)
          expect(keys).toEqual(keys.length === 2 ? [s.id, `${s.id}#2`] : [s.id])
        }
      })
    })
  }

  it('is quiet only when it is quiet on both legs', () => {
    // Left going in and right coming out: the house on the east is on the right going in and on the left coming out, so it is quiet on both.
    const r: Route = { points: heads['an exact reversal'], sideChanges: [{ idx: 0, side: 'left' }, { idx: 1, side: 'right' }], stops: [house('E', 12, 300), house('W', -12, 300)] }
    const occs = occurrences(r)
    expect(stopQuietReasons(r, occs, 'E')).toEqual(['otherSide'])
    expect(stopQuietReasons(r, occs, 'W')).toEqual([null])
    expect(alertable(r, occs).map((o) => o.stop.id)).toEqual(['W'])
    expect(quietHouseIds(r, occs)).toEqual(new Set(['E']))
  })

  it('alerts when the leg that is not the one the pass is on is the one that is thrown', () => {
    // Going in is transit and coming out is right: the house on the west is on the right coming out.
    const r: Route = { points: heads['an exact reversal'], sideChanges: [{ idx: 0, side: 'transit' }, { idx: 1, side: 'right' }], stops: [house('W', -12, 300), house('E', 12, 300)] }
    const occs = occurrences(r)
    expect(alertable(r, occs).map((o) => o.stop.id)).toEqual(['W'])
    expect(stopQuietReasons(r, occs, 'E')[0]).not.toBeNull()
  })

  it('shows the side of the leg it alerts on, which is the side thrown', () => {
    const r = court(heads['an exact reversal'], 'right', [house('E', 12, 300), house('W', -12, 285)])
    const occs = occurrences(r)
    expect(stopRoadSides(r, occs, 'E')).toEqual(['right'])
    expect(stopRoadSides(r, occs, 'W')).toEqual(['right'])
    // Thrown left both ways, they are on the left of the other leg.
    const left = court(heads['an exact reversal'], 'left', [house('E', 12, 300), house('W', -12, 285)])
    expect(stopRoadSides(left, occurrences(left), 'E')).toEqual(['left'])
    expect(stopRoadSides(left, occurrences(left), 'W')).toEqual(['left'])
  })

  it('shows the side of the leg the pass is on when it alerts on both, or on neither', () => {
    const both = court(heads['an exact reversal'], 'both', [house('E', 12, 300)])
    const [o] = occurrences(both)
    expect(stopRoadSides(both, [o], 'E')).toEqual(['left'])
    const quiet: Route = { points: heads['an exact reversal'], sideChanges: [{ idx: 0, side: 'left' }, { idx: 1, side: 'right' }], stops: [house('E', 12, 300)] }
    expect(stopRoadSides(quiet, occurrences(quiet), 'E')).toEqual(['left'])
  })

  it('swaps a side picked by hand on the other leg, as it does on a pass the other way', () => {
    // Picked as the right of the way in, so the left of the way out: thrown right both ways it alerts, and the alert shows the right.
    const picked = house('P', 12, 300, { side: 'right' })
    const r = court(heads['an exact reversal'], 'right', [picked])
    const occs = occurrences(r)
    expect(occs).toHaveLength(1)
    expect(alertable(r, occs)).toHaveLength(1)
    // Picked as the left of the leg the pass is on, thrown right on both: the other leg is its right, so it alerts through that leg.
    const left = court(heads['an exact reversal'], 'right', [house('P', 12, 300, { side: 'left' })])
    expect(alertable(left, occurrences(left))).toHaveLength(1)
    expect(stopRoadSides(left, occurrences(left), 'P')).toEqual(['right'])
  })

  it('is left as it was for a house a way down the street, which is passed twice', () => {
    const r = court(heads['an exact reversal'], 'right', [house('E', 12, 150), house('W', -12, 150)])
    const occs = occurrences(r)
    expect(occs).toHaveLength(4)
    expect(stopQuietReasons(r, occs, 'E')).toEqual([null, 'otherSide'])
    expect(stopQuietReasons(r, occs, 'W')).toEqual(['otherSide', null])
  })

  it('is judged as before when it is passed the one way: a stop off a corner', () => {
    const corner: Route = { points: [spot(0, 0), spot(0, 100), spot(100, 100)], sideChanges: [{ idx: 0, side: 'left' }], stops: [house('A', 12, 90), house('B', -12, 90)] }
    expect(alertable(corner, occurrences(corner)).map((o) => o.stop.id)).toEqual(['B'])
  })

  describe('put on the leg its alert is for', () => {
    // Nearest the way in at 285 m (segment 0), and passed again on the way out at 315 m (segment 1).
    const e285 = house('E', 12, 285)

    it('is moved to the other leg when it is thrown only there, keeping its key, and timed where that leg passes it', () => {
      // Thrown left both ways: on the right going in, on the left coming out.
      const r = court(heads['an exact reversal'], 'left', [e285])
      const [o] = occurrences(r)
      expect(o).toMatchObject({ idx: 0, alt: 1 })
      const [moved] = alertable(r, occurrences(r))
      expect(moved).toMatchObject({ key: 'E', idx: 1, alt: 0, off: o.off })
      expect(moved.at).toBeCloseTo(315, 0)
      expect(moved.altAt).toBeCloseTo(285, 0)
      // It is the same pass, so it is judged and shown the same.
      expect(quietReason(r, occurrences(r), moved)).toBeNull()
      expect(alertSide(r, occurrences(r), moved)).toBe('left')
      expect(alertSide(r, occurrences(r), o)).toBe('left')
    })

    it('stays where it is when it is thrown on the leg nearest it', () => {
      const r = court(heads['an exact reversal'], 'right', [e285])
      expect(alertable(r, occurrences(r))).toEqual(occurrences(r))
    })

    it('is moved to the leg that comes first when it is thrown on both, and shows the side of that leg', () => {
      // The U-turn the app draws: the way back is 5 m to the right, so a house on the right near the end is nearest the way back.
      const r = court(heads['the U-turn shape'], 'both', [house('E', 12, 290)])
      const [o] = occurrences(r)
      expect(o.idx).toBeGreaterThan(1)
      expect(o.altAt).toBeLessThan(o.at)
      const [moved] = alertable(r, occurrences(r))
      expect(moved.idx).toBe(o.alt)
      expect(moved.at).toBeCloseTo(290, 0)
      // On the right going in, which is where it is first thrown at.
      expect(alertSide(r, occurrences(r), moved)).toBe('right')
      expect(stopRoadSides(r, occurrences(r), 'E')).toEqual(['right'])
      // Where the legs meet, at the tip, it stays on the one the pass is on, and so it does for a leg less than a metre earlier.
      const tip = court(heads['an exact reversal'], 'both', [house('T', 12, 300)])
      expect(alertable(tip, occurrences(tip))).toEqual(occurrences(tip))
      const [t] = occurrences(tip)
      const nearly = { ...t, altAt: t.at - 0.5 }
      expect(alertable(tip, [nearly])).toEqual([nearly])
    })

    it('is not done for a bundle drop, a special request or an apartment block, which are never quiet', () => {
      for (const type of ['bundle', 'request', 'block'] as const) {
        const r = court(heads['the U-turn shape'], 'right', [house('S', 12, 290, { type, qty: 3 })])
        expect(alertable(r, occurrences(r)), type).toEqual(occurrences(r))
      }
    })

    it('keeps the passes in route order', () => {
      // Thrown left both ways the house on the east goes from 285 m to 315 m, past the house on the west at 295 m, which stays.
      const r = court(heads['an exact reversal'], 'left', [e285, house('W', -12, 295)])
      expect(occurrences(r).map((o) => o.key)).toEqual(['E', 'W'])
      const placed = alertable(r, occurrences(r))
      expect(placed.map((o) => o.key)).toEqual(['W', 'E'])
      expect(placed.map((o) => Math.round(o.at))).toEqual([295, 315])
    })

    it('is a row with the houses of the leg it is put on, and not with those of the leg it was nearest', () => {
      // Thrown left both ways: the west houses are thrown going in and the east ones coming out, so a row going in stops at the turn.
      const r = court(heads['an exact reversal'], 'left', [house('W1', -12, 280), house('W2', -12, 292), e285, house('E2', 12, 295)])
      const all = occurrences(r)
      const occs = alertable(r, all)
      const first = occs.find((o) => o.key === 'W1')!
      expect(houseRow(r, all, occs, new Set(), first, alertRadius(40)).map((o) => o.key)).toEqual(['W1', 'W2'])
      const out = occs.find((o) => o.key === 'E2')!
      expect(houseRow(r, all, occs, new Set(), out, alertRadius(40)).map((o) => o.key)).toEqual(['E2', 'E'])
    })

    it('tells a side picked by hand from the first pass, not from the leg it is put on', () => {
      // Picked as the right of the way in, so the left of the way out: thrown left both ways it alerts on the way out, on the left.
      const r = court(heads['an exact reversal'], 'left', [house('P', 12, 285, { side: 'right' })])
      const all = occurrences(r)
      const [moved] = alertable(r, all)
      expect(moved.idx).toBe(1)
      expect(moved.at).toBeCloseTo(315, 0)
      expect(alertSide(r, all, moved)).toBe('left')
      expect(quietReason(r, all, moved)).toBeNull()
      expect(voiceable(r, all, moved, 'left', alertRadius(40))).toBe(true)
      expect(voiceable(r, all, moved, 'right', alertRadius(40))).toBe(false)
      expect(stopRoadSides(r, all, 'P')).toEqual(['left'])
      // Picked as the left of the way in, thrown left both ways: it alerts going in and stays there.
      const kept = court(heads['an exact reversal'], 'left', [house('P', 12, 285, { side: 'left' })])
      expect(alertable(kept, occurrences(kept))).toEqual(occurrences(kept))
    })

    it('tells a side picked by hand against the leg the route reaches first, though the other is nearer the house', () => {
      // The U-turn the app draws: a house on the right near the end is nearest the way back, and reached first on the way in.
      const r = court(heads['the U-turn shape'], 'right', [house('P', 12, 290, { side: 'right' })])
      const all = occurrences(r)
      expect(all[0].idx).toBeGreaterThan(1)
      const [o] = alertable(r, all)
      expect(o.at).toBeCloseTo(290, 0)
      expect(alertSide(r, all, o)).toBe('right')
      expect(stopRoadSides(r, all, 'P')).toEqual(['right'])
    })

    it('tells a side picked by hand at the very tip against the leg of the pass, as the other is less than a metre sooner', () => {
      // Picked as the right going in, and thrown right: it alerts going in, and is not put on the way out, which meets it at the tip.
      const tip = court(heads['an exact reversal'], 'right', [house('T', 12, 300, { side: 'right' })])
      const [t] = occurrences(tip)
      const nearly = { ...t, altAt: t.at - 0.5 }
      expect(alertable(tip, [nearly])).toEqual([nearly])
      expect(alertSide(tip, [nearly], nearly)).toBe('right')
    })
  })

  describe('after a change of throw side part way through a round', () => {
    const radius = alertRadius(10)
    // Thrown right both ways the house on the west at 285 m is on the left going in and the right coming back, so it alerts coming back,
    // at 315 m; the house on the east alerts going in.
    const w285 = house('W', -12, 285)
    const e285 = house('E', 12, 285)
    /** The passes that alerted before the throw side was changed along the whole court, and those that alert after. */
    const change = (from: Side, to: Side, list: Stop[], points = heads['an exact reversal']) => {
      const after = court(points, to, list)
      const all = occurrences(after)
      return { after, all, was: alertable(court(points, from, list), all), now: alertable(after, all) }
    }

    it('keeps an alert moved onto the leg the car has gone by on the leg still ahead, where it is still thrown, with that leg’s side', () => {
      const { after, all, was, now } = change('right', 'both', [w285])
      expect(was[0].at).toBeCloseTo(315, 0)
      // Thrown on both legs now, it is timed on the first, 15 m behind a car at the tip.
      expect(now[0].at).toBeCloseTo(285, 0)
      const { occs, done } = keepAlertsAhead(after, all, was, now, 300, radius)
      expect(done).toEqual([])
      expect(occs).toHaveLength(1)
      expect(occs[0]).toMatchObject({ key: 'W', idx: 1, off: now[0].off })
      expect(occs[0].at).toBeCloseTo(315, 0)
      // The leg gone by has no more to tell of, so the pass is judged and shown on the leg ahead alone.
      expect('alt' in occs[0]).toBe(false)
      expect('altAt' in occs[0]).toBe(false)
      expect(alertSide(after, all, occs[0])).toBe('right')
      expect(quietReason(after, all, occs[0])).toBeNull()
    })

    it('leaves out, and does not count as done, an alert moved onto the leg gone by when the house is quiet on the leg still ahead', () => {
      // Thrown left both ways the house on the east alerts coming back. Changed to right it is thrown going in only, behind the car, and the
      // car is still to pass it coming back, where it is quiet.
      const { after, all, was, now } = change('left', 'right', [e285])
      expect(was[0].at).toBeCloseTo(315, 0)
      expect(now[0].at).toBeCloseTo(285, 0)
      for (const along of [300, 310, 314]) expect(keepAlertsAhead(after, all, was, now, along, radius), `${along}`).toEqual({ occs: [], done: [] })
    })

    it('counts as done an alert moved onto the leg gone by once the car is past the house on both legs', () => {
      const { after, all, was, now } = change('left', 'right', [e285])
      for (const along of [316, 320]) expect(keepAlertsAhead(after, all, was, now, along, radius), `${along}`).toEqual({ occs: now, done: ['E'] })
    })

    it('brings a pass it left out back, on the leg ahead and not done, when the change is taken back', () => {
      const { after, all, was, now } = change('left', 'right', [e285])
      const left = keepAlertsAhead(after, all, was, now, 300, radius)
      expect(left).toEqual({ occs: [], done: [] })
      // Undo 2 m on: thrown left both ways again, it alerts coming back, ahead of the car, as a pass that did not alert before.
      const undone = court(heads['an exact reversal'], 'left', [e285])
      const undoneAll = occurrences(undone)
      const back = alertable(undone, undoneAll)
      expect(back[0].at).toBeCloseTo(315, 0)
      expect(keepAlertsAhead(undone, undoneAll, left.occs, back, 302, radius)).toEqual({ occs: back, done: [] })
    })

    it('leaves out a pass that starts to alert behind the car while it is quiet on the leg still ahead, and counts it done once both are behind', () => {
      // Nothing thrown before. Thrown right now, the house on the east alerts going in only.
      const { after, all, was, now } = change('transit', 'right', [e285])
      expect(was).toEqual([])
      expect(keepAlertsAhead(after, all, was, now, 300, radius)).toEqual({ occs: [], done: [] })
      // Another change while the car is still to pass it coming back finds it left out, so it is still not done.
      expect(keepAlertsAhead(after, all, [], now, 310, radius)).toEqual({ occs: [], done: [] })
      expect(keepAlertsAhead(after, all, [], now, 320, radius)).toEqual({ occs: now, done: ['E'] })
    })

    it('keeps on the leg ahead, not done, a pass that starts to alert behind the car when it alerts on the leg ahead too', () => {
      // Nothing thrown before, both sides now: timed on the way in, behind the car, and thrown coming back as well, which the car is still
      // to pass. It did not alert before, and is kept on the leg ahead as one whose alert moved is.
      const { after, all, was, now } = change('transit', 'both', [e285])
      expect(was).toEqual([])
      expect(now[0].at).toBeCloseTo(285, 0)
      const { occs, done } = keepAlertsAhead(after, all, was, now, 300, radius)
      expect(done).toEqual([])
      expect(occs).toHaveLength(1)
      expect(occs[0]).toMatchObject({ key: 'E', idx: 1 })
      expect(occs[0].at).toBeCloseTo(315, 0)
      expect('alt' in occs[0]).toBe(false)
      // Past it on both legs, it is done.
      expect(keepAlertsAhead(after, all, was, now, 320, radius)).toEqual({ occs: now, done: ['E'] })
    })

    it('brings a pass it left out back on the leg ahead when the side is changed back from the tip on, leaving the way in as the change made it', () => {
      // Thrown right both ways, changed to left at the tip: the west house is thrown going in only, behind the car, and is left out.
      const { after, all, was, now } = change('right', 'left', [w285])
      const left = keepAlertsAhead(after, all, was, now, 300, radius)
      expect(left).toEqual({ occs: [], done: [] })
      // Changed back to right from the last turn (the tip) to the end, 2 m on: left going in, right coming back, so it is thrown on both
      // legs and `alertable` times it on the way in, behind the car. Not done: kept on the way back, where the car is still to pass it.
      for (const to of ['right', 'both'] as const) {
        const back: Route = { ...after, sideChanges: [{ idx: 0, side: 'left' }, { idx: 1, side: to }] }
        const backAll = occurrences(back)
        const fresh = alertable(back, backAll)
        expect(fresh[0].at, to).toBeCloseTo(285, 0)
        const { occs, done } = keepAlertsAhead(back, backAll, left.occs, fresh, 302, radius)
        expect(done, to).toEqual([])
        expect(occs, to).toHaveLength(1)
        expect(occs[0], to).toMatchObject({ key: 'W', idx: 1 })
        expect(occs[0].at, to).toBeCloseTo(315, 0)
        expect(alertSide(back, backAll, occs[0]), to).toBe('right')
      }
    })

    it('leaves a pass that alerted on a leg already behind the car there, though it alerts on the leg ahead too', () => {
      // Thrown both ways, the house on the west alerts going in, and the car went by it there. A change after the tip changes nothing for it.
      const { after, all, now } = change('both', 'both', [w285])
      expect(keepAlertsAhead(after, all, now, now, 302, radius)).toEqual({ occs: now, done: [] })
    })

    it('never leaves out a bundle drop, a special request or an apartment block, which are never quiet', () => {
      for (const type of ['bundle', 'request', 'block'] as const) {
        const { after, all, now } = change('right', 'right', [{ ...e285, type }])
        expect(now[0].alt, type).toBeDefined()
        expect(keepAlertsAhead(after, all, [], now, 300, radius), type).toEqual({ occs: now, done: ['E'] })
      }
    })

    it('lets the round finish without a house it leaves out', () => {
      // Thrown right both ways the east house alerts going in, done by the tip, and the west house coming back. Changed to left at the tip,
      // the west house is thrown going in only and is left out.
      const { after, all, was, now } = change('right', 'left', [w285, e285])
      const { occs } = keepAlertsAhead(after, all, was, now, 300, radius)
      expect(occs.map((o) => o.key)).toEqual(['E'])
      expect(roundCounts(occs, new Set(['E']))).toEqual({ total: 1, done: 1, remaining: 0, finished: true })
    })

    it('leaves an alert on the first leg when the car has not gone past it there: backed up, or changed before the court', () => {
      const { after, all, was, now } = change('right', 'both', [w285])
      for (const along of [100, 280, 284]) expect(keepAlertsAhead(after, all, was, now, along, radius), `${along}`).toEqual({ occs: now, done: [] })
    })

    it('leaves an alert that did not move, and one that moved ahead, as it is', () => {
      // Thrown right both ways the house on the east alerts going in, and still does thrown both ways: it was done going in.
      const both = change('right', 'both', [e285])
      expect(keepAlertsAhead(both.after, both.all, both.was, both.now, 300, radius)).toEqual({ occs: both.now, done: [] })
      // Thrown left both ways the house on the west alerts going in; thrown right it alerts coming back, ahead of the car.
      const right = change('left', 'right', [w285])
      expect(keepAlertsAhead(right.after, right.all, right.was, right.now, 300, radius)).toEqual({ occs: right.now, done: [] })
    })

    it('counts as done a pass that starts to alert behind the car, but not one ahead, nor one just behind that can still come up', () => {
      // Thrown left both ways the east houses are quiet going in. Changed to right at 200 m they alert going in.
      const { after, all, was, now } = change('left', 'right', [house('E100', 12, 100), house('E195', 12, 195), house('E250', 12, 250)])
      expect(keepAlertsAhead(after, all, was, now, 200, radius).done).toEqual(['E100'])
      // A pass that alerted before, and is behind the car, is not counted again.
      expect(keepAlertsAhead(after, all, now, now, 200, radius)).toEqual({ occs: now, done: [] })
    })

    it('leaves a stop met by where the driver is alone, as it has no leg', () => {
      const far = house('F', 150, 100)
      const { after, all, now } = change('left', 'right', [far, house('E100', 12, 100)])
      expect(byPosition(now.find((o) => o.key === 'F')!, radius)).toBe(true)
      expect(keepAlertsAhead(after, all, [], now, 300, radius).done).toEqual(['E100'])
    })

    it('keeps the house on the leg ahead at the U-turn the app draws, changed while the car goes across', () => {
      // On the left going in, nearest the way in, and on the right coming back down the lane 5 m over.
      const { after, all, was, now } = change('right', 'both', [house('W', -12, 286)], heads['the U-turn shape'])
      expect(now[0].at).toBeCloseTo(286, 0)
      const { occs, done } = keepAlertsAhead(after, all, was, now, 308, radius)
      expect(done).toEqual([])
      expect(occs[0].idx).toBe(4)
      expect(occs[0].at).toBeCloseTo(331, 0)
      expect(alertSide(after, all, occs[0])).toBe('right')
    })

    it('puts the alert back on the first leg for a round started again before the court, and keeps it ahead for one carried on at the tip', () => {
      const { after, all, was, now } = change('right', 'both', [w285])
      const inUse = keepAlertsAhead(after, all, was, now, 300, radius).occs
      // Skipped back to 250 m the car passes the house going in again, thrown both ways, so it alerts there.
      expect(keepAlertsAhead(after, all, inUse, now, 250, radius).occs).toEqual(now)
      expect(keepAlertsAhead(after, all, inUse, now, 300, radius).occs).toEqual(inUse)
    })

    it('puts a pass it left out back on the first leg for a round started again before the court, and leaves it out for one carried on at the tip', () => {
      const { after, all, was, now } = change('left', 'right', [e285])
      const inUse = keepAlertsAhead(after, all, was, now, 300, radius).occs
      expect(keepAlertsAhead(after, all, inUse, now, 250, radius).occs).toEqual(now)
      expect(keepAlertsAhead(after, all, inUse, now, 300, radius).occs).toEqual([])
    })

    it('gives the same again when given its own result, so the round can work out the passes where the route changes and the keys done later', () => {
      for (const [from, to] of [
        ['right', 'both'],
        ['left', 'right'],
        ['right', 'left'],
        ['both', 'right'],
        ['transit', 'both'],
      ] as const) {
        const { after, all, was, now } = change(from, to, [w285, e285, house('E100', 12, 100)])
        const first = keepAlertsAhead(after, all, was, now, 300, radius)
        expect(keepAlertsAhead(after, all, was, first.occs, 300, radius), `${from} to ${to}`).toEqual(first)
      }
    })

    describe('carried on after the round screen was left', () => {
      // What the round keeps of a change at the tip, and puts back when the screen comes back: the passes as `alertable` gives them for the
      // route as it is now, with what the change made of those at the head of the court, read back from storage.
      const kept = (fresh: Occurrence[], inUse: Occurrence[]) => normalizeCourtLegs(JSON.parse(JSON.stringify(courtLegsOf(fresh, inUse))))

      it('keeps a house a change left out, and one it kept on the leg ahead, and nothing of any other pass', () => {
        const left = change('right', 'left', [w285, e285, house('E100', 12, 100)])
        expect(courtLegsOf(left.now, keepAlertsAhead(left.after, left.all, left.was, left.now, 300, radius).occs)).toEqual({ W: 'out' })
        const both = change('right', 'both', [w285, e285, house('E100', 12, 100)])
        expect(courtLegsOf(both.now, keepAlertsAhead(both.after, both.all, both.was, both.now, 300, radius).occs)).toEqual({ W: 'ahead' })
        // Nothing for a round with no change, nor for a change that moved nothing.
        expect(courtLegsOf(left.now, left.now)).toEqual({})
        expect(courtLegsOf(both.now, keepAlertsAhead(both.after, both.all, both.was, both.now, 250, radius).occs)).toEqual({})
      })

      it('puts the passes back as the change left them, wherever the round is carried on from and wherever the car is', () => {
        for (const [from, to] of [
          ['right', 'left'],
          ['right', 'both'],
          ['transit', 'both'],
          ['transit', 'right'],
          ['left', 'right'],
        ] as const) {
          const { after, all, was, now } = change(from, to, [w285, e285, house('E100', 12, 100)])
          for (const along of [300, 306, 314]) {
            const inUse = keepAlertsAhead(after, all, was, now, along, radius).occs
            // It takes no place along the route: nothing is worked out from a fix, beside a later street or anywhere else.
            expect(resumedLegs(after, all, now, kept(now, inUse), radius), `${from} to ${to} at ${along}`).toEqual(inUse)
          }
        }
      })

      it('lets the round finish without a house a change at the tip left out, and says so on the start screen before Continue Round', () => {
        // Thrown right both ways and changed to left at the tip: the east house was done going in, and the west house was left out.
        const { after, all, was, now } = change('right', 'left', [w285, e285])
        const handled = new Set(['E'])
        expect(roundCounts(now, handled).finished).toBe(false)
        const occs = resumedLegs(after, all, now, kept(now, keepAlertsAhead(after, all, was, now, 300, radius).occs), radius)
        expect(occs.map((o) => o.key)).toEqual(['E'])
        expect(roundCounts(occs, handled)).toEqual({ total: 1, done: 1, remaining: 0, finished: true })
      })

      it('keeps on the leg ahead a house a change to Both at the tip kept there, with that leg’s side, so it comes up before the car passes it coming back', () => {
        const { after, all, was, now } = change('right', 'both', [w285, e285])
        const occs = resumedLegs(after, all, now, kept(now, keepAlertsAhead(after, all, was, now, 300, radius).occs), radius)
        const w = occs.find((o) => o.key === 'W')!
        expect(w).toMatchObject({ idx: 1 })
        expect(w.at).toBeCloseTo(315, 0)
        expect('alt' in w).toBe(false)
        expect(alertSide(after, all, w)).toBe('right')
        // The east house is as `alertable` gives it.
        expect(occs.find((o) => o.key === 'E')).toBe(now.find((o) => o.key === 'E'))
        expect(roundCounts(occs, new Set(['E']))).toEqual({ total: 2, done: 1, remaining: 1, finished: false })
      })

      it('gives the passes as `alertable` gives them when nothing was kept, as for a round saved before it was', () => {
        for (const side of ['right', 'left', 'both'] as const) {
          const { after, all, now } = change('right', side, [w285, e285, house('E100', 12, 100)])
          expect(resumedLegs(after, all, now, undefined, radius), side).toBe(now)
          expect(resumedLegs(after, all, now, {}, radius), side).toBe(now)
          // A house the car has not yet passed after the place carried on from alerts as it would: nothing is left out for want of a fix.
          expect(resumedLegs(after, all, now, kept(now, now), radius), side).toBe(now)
        }
      })

      it('lets go of what no longer fits the pass, as after the route or the alert distance has changed since', () => {
        // Left out, but thrown right both ways it alerts on the later leg: it is as `alertable` gives it there.
        const right = change('right', 'right', [w285, e285])
        expect(resumedLegs(right.after, right.all, right.now, { W: 'out' }, radius)).toBe(right.now)
        // Kept ahead, but it is quiet on the later leg now.
        const left = change('right', 'left', [w285])
        expect(resumedLegs(left.after, left.all, left.now, { W: 'ahead' }, radius)).toBe(left.now)
        // Left out, but it is thrown on the later leg now too.
        const both = change('right', 'both', [w285])
        expect(resumedLegs(both.after, both.all, both.now, { W: 'out' }, radius)).toBe(both.now)
        // A pass the route no longer has, and keys of no pass at all.
        expect(resumedLegs(left.after, left.all, left.now, normalizeCourtLegs(JSON.parse('{"E":"out","W#2":"ahead","__proto__":"out"}')), radius)).toBe(left.now)
      })

      it('never leaves out or moves a bundle drop, a special request or an apartment block, nor a stop met by where the driver is', () => {
        for (const type of ['bundle', 'request', 'block'] as const) {
          const { after, all, now } = change('right', 'left', [{ ...w285, type }])
          expect(resumedLegs(after, all, now, { W: 'out' }, radius), type).toBe(now)
          expect(resumedLegs(after, all, now, { W: 'ahead' }, radius), type).toBe(now)
        }
        const far = house('F', 150, 290)
        const { after, all, now } = change('right', 'left', [far])
        expect(byPosition(now[0], radius)).toBe(true)
        expect(resumedLegs(after, all, now, { F: 'out' }, radius)).toBe(now)
      })

      it('brings a house left out back on the leg ahead when the side is then changed back, as without the screen being left', () => {
        const { after, all, was, now } = change('right', 'left', [w285, e285])
        const resumed = resumedLegs(after, all, now, kept(now, keepAlertsAhead(after, all, was, now, 300, radius).occs), radius)
        expect(resumed.map((o) => o.key)).toEqual(['E'])
        const undone = court(heads['an exact reversal'], 'right', [w285, e285])
        const undoneAll = occurrences(undone)
        const { occs, done } = keepAlertsAhead(undone, undoneAll, resumed, alertable(undone, undoneAll), 306, radius)
        expect(done).toEqual([])
        expect(occs.find((o) => o.key === 'W')!.at).toBeCloseTo(315, 0)
      })

      it('gives a start part way or a skip what it gives in the round that was left, and alone what it gave before when nothing was kept', () => {
        for (const [from, to] of [
          ['right', 'left'],
          ['right', 'both'],
          ['right', 'right'],
        ] as const) {
          const { after, all, was, now } = change(from, to, [w285, e285, house('E100', 12, 100), house('W250', -12, 250)])
          const inUse = keepAlertsAhead(after, all, was, now, 300, radius).occs
          const resumed = resumedLegs(after, all, now, kept(now, inUse), radius)
          for (const at of [0, 100, 250, 290, 300, 310, 320, 400]) {
            // As `restartAt` works the passes out from the spot.
            expect(keepAlertsAhead(after, all, resumed, now, at, radius).occs, `${from} to ${to}, from ${at}`).toEqual(keepAlertsAhead(after, all, inUse, now, at, radius).occs)
            expect(keepAlertsAhead(after, all, resumedLegs(after, all, now, undefined, radius), now, at, radius).occs, `${from} to ${to}, from ${at}`).toEqual(now)
          }
        }
      })

      it('keeps the same again once put back, however many times the round is carried on', () => {
        for (const [from, to] of [
          ['right', 'both'],
          ['right', 'left'],
          ['transit', 'both'],
          ['left', 'right'],
        ] as const) {
          const { after, all, was, now } = change(from, to, [w285, e285, house('E100', 12, 100)])
          for (const along of [300, 306, 314]) {
            const inUse = keepAlertsAhead(after, all, was, now, along, radius).occs
            const once = resumedLegs(after, all, now, kept(now, inUse), radius)
            expect(kept(now, once), `${from} to ${to} at ${along}`).toEqual(kept(now, inUse))
            expect(resumedLegs(after, all, now, kept(now, once), radius), `${from} to ${to} at ${along}`).toEqual(once)
          }
        }
      })

      describe('at the first fix on the route after Continue Round', () => {
        // At 10 m the slack for the zones is 10 m: a house up to 10 m behind the car can still come up where it is.
        const none = new Set<string>()

        it('puts a house thrown on both legs, not done, on the leg ahead once the car is more than the slack past it on the way in, with that leg’s side', () => {
          const { after, all, now } = change('both', 'both', [w285, e285])
          for (const along of [296, 300, 310, 314]) {
            const occs = legsOnResume(after, all, now, none, along, radius)
            expect(occs.map((o) => o.key).sort(), `${along}`).toEqual(['E', 'W'])
            for (const o of occs) {
              expect(o, `${o.key} at ${along}`).toMatchObject({ idx: 1, off: now.find((n) => n.key === o.key)!.off })
              expect(o.at, `${o.key} at ${along}`).toBeCloseTo(315, 0)
              expect('alt' in o, `${o.key} at ${along}`).toBe(false)
              expect('altAt' in o, `${o.key} at ${along}`).toBe(false)
            }
            expect(alertSide(after, all, occs.find((o) => o.key === 'W')!), `${along}`).toBe('right')
            expect(alertSide(after, all, occs.find((o) => o.key === 'E')!), `${along}`).toBe('left')
          }
          // The U-turn the app draws: on the way back down the lane, 5 m over.
          const box = change('both', 'both', [house('W', -12, 286)], heads['the U-turn shape'])
          const [w] = legsOnResume(box.after, box.all, box.now, none, 310, radius)
          expect(w.idx).toBe(4)
          expect(w.at).toBeCloseTo(331, 0)
          expect(alertSide(box.after, box.all, w)).toBe('right')
        })

        it('changes nothing for a pass done, one still in reach behind the car, one whose other leg is behind the car too, or with the car before the court', () => {
          const { after, all, now } = change('both', 'both', [w285, e285, house('E100', 12, 100)])
          expect(legsOnResume(after, all, now, new Set(['W', 'E']), 300, radius)).toBe(now)
          for (const along of [0, 100, 284, 290, 294, 316, 320, 590]) expect(legsOnResume(after, all, now, none, along, radius), `${along}`).toBe(now)
          // Only the one not done is moved.
          const one = legsOnResume(after, all, now, new Set(['W']), 300, radius)
          expect(one.find((o) => o.key === 'W')).toBe(now.find((o) => o.key === 'W'))
          expect(one.find((o) => o.key === 'E')!.at).toBeCloseTo(315, 0)
          expect(one.find((o) => o.key === 'E100')).toBe(now.find((o) => o.key === 'E100'))
        })

        it('never leaves a pass out or counts it done: a house thrown going in only, the car between the legs, is left as it is', () => {
          for (const [from, to] of [
            ['right', 'right'],
            ['left', 'left'],
            ['right', 'left'],
            ['left', 'right'],
            ['transit', 'right'],
            ['both', 'right'],
            ['right', 'both'],
          ] as const) {
            const { after, all, now } = change(from, to, [w285, e285, house('E100', 12, 100)])
            for (let along = 0; along <= 600; along += 2) {
              const occs = legsOnResume(after, all, now, none, along, radius)
              expect(occs.map((o) => o.key).sort(), `${from} to ${to} at ${along}`).toEqual(now.map((o) => o.key).sort())
              // Thrown on one side only, each house alerts on one leg of its pass, and nothing is moved.
              if (to !== 'both') expect(occs, `${from} to ${to} at ${along}`).toBe(now)
            }
          }
          // Thrown right both ways, the east house alerts going in only: with the car past it there, it is neither left out nor moved.
          const right = change('right', 'right', [e285])
          expect(right.now[0].at).toBeCloseTo(285, 0)
          for (const along of [300, 306, 314]) expect(legsOnResume(right.after, right.all, right.now, none, along, radius), `${along}`).toBe(right.now)
        })

        it('changes nothing with the fix beside a later street, or between the legs of a later court whose house is thrown going in only', () => {
          // The court, a street west and north, a second court east and straight back, and on north. The house of the second court, S, is on
          // the right going in and the left coming back; W and E are at the head of the first.
          const points = [spot(0, 0), spot(0, 300), spot(0, 0), spot(-200, 0), spot(-200, 600), spot(100, 600), spot(-200, 600), spot(-200, 1000)]
          const stops = [w285, e285, house('S', 85, 588)]
          const right: Route = { points, sideChanges: [{ idx: 0, side: 'right' }], stops }
          const rightAll = occurrences(right)
          const rightNow = alertable(right, rightAll)
          const s = rightNow.find((o) => o.key === 'S')!
          expect(s.at).toBeCloseTo(1685, 0)
          expect(s.altAt).toBeCloseTo(1715, 0)
          for (const along of [1700, 1710, 1800, 2100]) expect(legsOnResume(right, rightAll, rightNow, none, along, radius), `${along}`).toBe(rightNow)
          // Thrown both ways, a fix beside a later street changes nothing either: both legs of every court are behind it.
          const both: Route = { ...right, sideChanges: [{ idx: 0, side: 'both' }] }
          const bothAll = occurrences(both)
          const bothNow = alertable(both, bothAll)
          for (const along of [1800, 2100]) expect(legsOnResume(both, bothAll, bothNow, none, along, radius), `${along}`).toBe(bothNow)
        })

        it('never moves a bundle drop, a special request or an apartment block, nor a stop met by where the driver is', () => {
          for (const type of ['bundle', 'request', 'block'] as const) {
            const { after, all, now } = change('both', 'both', [{ ...w285, type }])
            expect(now[0].alt, type).toBeDefined()
            expect(legsOnResume(after, all, now, none, 300, radius), type).toBe(now)
          }
          const { after, all, now } = change('both', 'both', [house('F', 150, 290)])
          expect(byPosition(now[0], radius)).toBe(true)
          expect(legsOnResume(after, all, now, none, 300, radius)).toBe(now)
        })

        it('is kept with the round as a pass kept on the leg ahead, so a later Continue Round puts it there again, and moves nothing more after that', () => {
          const { after, all, now } = change('both', 'both', [w285, e285])
          const moved = legsOnResume(after, all, now, none, 300, radius)
          expect(kept(now, moved)).toEqual({ W: 'ahead', E: 'ahead' })
          expect(resumedLegs(after, all, now, kept(now, moved), radius)).toEqual(moved)
          for (const along of [300, 310]) expect(legsOnResume(after, all, moved, none, along, radius), `${along}`).toBe(moved)
        })
      })
    })
  })
})
