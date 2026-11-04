import { describe, expect, it } from 'vitest'
import { addedOffRouteNote } from './addedStops'
import { quietReachFor } from './alerts'
import { stopAt } from './routeEdit'
import type { Route, Side, StopType } from './types'

// A road north, thrown on one side. One degree of longitude is 70.05 km at 51 degrees north, so `east(65)` is 65 m to the right of the road.
const road = (side: Side): Route => ({ points: Array.from({ length: 6 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 })), sideChanges: [{ idx: 0, side }], stops: [] })
const east = (metres: number) => ({ lat: 51.0025, lng: metres / 70050 })
const west = (metres: number) => ({ lat: 51.0025, lng: -metres / 70050 })
/** A stop placed there, as Setup places one: with how far it is from the route. */
const placed = (route: Route, p: { lat: number; lng: number }, type: StopType = 'nothrow') => stopAt(route, p, type)!

const REACH = quietReachFor(40)

describe('the note on adding stops that are off the route', () => {
  it('says nothing of a no-throw house more than 60 m out that is quiet all the same, as it never alerts', () => {
    const route = road('left')
    expect(addedOffRouteNote(route, [placed(route, east(65))], REACH)).toBe('')
  })

  it('tells of one further than the reach, which alerts by where the driver is whatever is thrown', () => {
    const route = road('left')
    expect(addedOffRouteNote(route, [placed(route, east(75))], REACH)).toMatch(/^It is 75 m from your route, so its alert comes up by where you are/)
  })

  it('still tells of a house that alerts, and of a stop of another kind, as before', () => {
    const route = road('left')
    // On the side that is thrown, or where both are.
    expect(addedOffRouteNote(route, [placed(route, west(65))], REACH)).toContain('65 m')
    expect(addedOffRouteNote(road('both'), [placed(road('both'), east(65))], REACH)).toContain('65 m')
    for (const type of ['bundle', 'request', 'block'] as const) expect(addedOffRouteNote(route, [placed(route, east(65), type)], REACH), type).toContain('65 m')
  })

  it('says a stop more than 60 m out but within the reach still alerts as you drive past it, with its side, and not by where you are', () => {
    // At 40 m the reach is 70 m: a stop 65 m out is met along the route, while it is still about 70 m away in a straight line.
    for (const type of ['bundle', 'request', 'block', 'nothrow'] as const) {
      const route = road('both')
      const note = addedOffRouteNote(route, [placed(route, east(65), type)], quietReachFor(40))
      expect(note, type).toBe(
        'It is 65 m from your route, so the list marks it off the route, but its alert still comes up as you drive past it, with the side it is on, which you can set in the list.',
      )
    }
  })

  it('says the same stop comes up by where you are at an alert distance whose reach it is beyond', () => {
    // At 10 m the reach is 40 m, so a stop 65 m out is met by where you are.
    const route = road('both')
    expect(addedOffRouteNote(route, [placed(route, east(65), 'bundle')], quietReachFor(10))).toBe(
      'It is 65 m from your route, so its alert comes up by where you are, whenever you are within the alert distance of it.',
    )
  })

  it('goes with the alert distance in use: at 60 m a house 85 m out on the side not thrown is quiet', () => {
    const route = road('left')
    expect(addedOffRouteNote(route, [placed(route, east(85))], quietReachFor(60))).toBe('')
    expect(addedOffRouteNote(route, [placed(route, east(85))], REACH)).toContain('85 m')
  })

  it('counts only those it tells of when several are added together', () => {
    const route = road('left')
    const quiet = placed(route, east(65))
    const far = { ...placed(route, east(75)), stop: { ...placed(route, east(75)).stop, id: 'far' } }
    expect(addedOffRouteNote(route, [quiet, far], REACH)).toMatch(/^It is 75 m from your route/)
    expect(addedOffRouteNote(route, [placed(route, east(20))], REACH)).toBe('')
  })
})
