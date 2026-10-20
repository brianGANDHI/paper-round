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
  DEFAULT_ALERT_DISTANCE,
  HEAD_PASSED_M,
  houseRow,
  inTransit,
  isAlertDistance,
  isGoneBy,
  isOffRoute,
  offRouteNote,
  onlyInTransit,
  pickCurrent,
  planSpeech,
  platesLayout,
  plateText,
  quietNoThrows,
  quietNote,
  ROW_GAP_M,
  ROW_MAX,
  ROW_SPAN_M,
  sameWay,
  sideNote,
  SPOKEN_ROW_MAX,
  spokenNumber,
  stopOffRoute,
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
  off: 0,
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
    expect(alertRadius(30)).toEqual({ nothrow: 30, bundle: 30, request: 30 })
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

describe('where nothing is thrown at all', () => {
  // A road heading north, thrown on the left for the first half and only driven for the second.
  const north: Pt[] = Array.from({ length: 11 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 }))
  const mixed = (stops: Stop[]): Route => ({
    points: north,
    sideChanges: [{ idx: 0, side: 'left' }, { idx: 5, side: 'transit' }],
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
    // Out along a street thrown on the left, and back along it as transit.
    const out = Array.from({ length: 6 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 }))
    const twice: Route = {
      points: [...out, ...[...out].reverse().slice(1)],
      sideChanges: [{ idx: 0, side: 'left' }, { idx: 5, side: 'transit' }],
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
    expect(quietNote(1)).toMatch(/^1 no-throw house is on a transit stretch/)
    expect(quietNote(2)).toMatch(/^2 no-throw houses are on transit stretches/)
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
      const wide = { nothrow: 60, bundle: 20, request: 20 }
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
    const transit = { sideChanges: [{ idx: 0, side: 'transit' as Side }] }

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
