import { offRouteNote, quietHouseIds } from './alerts'
import { occurrences } from './geo'
import type { Route, Stop } from './types'

/**
 * What to tell the driver about stops just added (`added`, each with how far it is from the route, as `stopAt` gives it) that are off the
 * route, in a route that did not have them yet: see `offRouteNote`, which `reachM` (the reach for the alert distance in use, see
 * `quietReachFor`) is given to, so a stop said to come up by where the driver is is one that does, and one more than 60 m out but within the
 * reach is said to come up as they drive past it, as it does. A no-throw house that is quiet on every pass of the route once it is added
 * (see `quietHouseIds`) is left out, as it never alerts, by where the driver is or otherwise: one more than 60 m from the route but within
 * the reach is still met along the route, and can be on the side that isn't thrown. That is the same as a quiet house nearer the road, which
 * gets no note of its own either. Empty when none is left to tell of.
 */
export function addedOffRouteNote(route: Pick<Route, 'points' | 'sideChanges' | 'stops'>, added: readonly { stop: Stop; offM: number }[], reachM: number): string {
  const next = { ...route, stops: [...route.stops, ...added.map((a) => a.stop)] }
  const quiet = quietHouseIds(next, occurrences(next), reachM)
  return offRouteNote(
    added.filter((a) => !quiet.has(a.stop.id)).map((a) => a.offM),
    reachM,
  )
}
