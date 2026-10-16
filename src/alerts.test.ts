import { describe, expect, it } from 'vitest'
import {
  aheadText,
  alertRadius,
  alertSide,
  ALERT_DISTANCES,
  BACK_OFF_SLACK_M,
  DEFAULT_ALERT_DISTANCE,
  isAlertDistance,
  sameWay,
  sideNote,
  stopRoadSides,
  stopsWithoutSide,
  zoneExit,
} from './alerts'
import { occurrences, type Occurrence } from './geo'
import type { Pt, Route, Side, Stop, StopType } from './types'

const occ = (type: StopType, at: number): Occurrence => ({
  key: 's',
  stop: { id: 's', type, pathIdx: 0, lat: 0, lng: 0 },
  idx: 0,
  at,
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

  it('apply to both kinds of stop', () => {
    expect(alertRadius(30)).toEqual({ nothrow: 30, bundle: 30 })
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
