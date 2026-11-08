import { bundleRows } from '../bundles'
import { occurrences, type Occurrence } from '../geo'
import type { Route, Stop } from '../types'
import type { BundleName } from './types'

/**
 * The driver's bundle list and how it lies along a route. The app alerts only the next bundle in the list, so a route that reaches a bundle
 * earlier than its turn strands it without a word. Stored stop order (`pathIdx`) has nothing to do with this: the list is read the way the
 * app reads it, and walked over the route's own passes.
 */

type Line = Pick<Route, 'points' | 'stops'>

const onlyBundles = (route: Line): Line => ({ points: route.points, stops: route.stops.filter((s) => s.type === 'bundle') })

/** Every time a route passes a bundle, in route order. */
export const bundlePasses = (route: Line): Occurrence[] => occurrences(onlyBundles(route))

/** The list the app shows on a route: the driver's order if there is one, otherwise the order the route first reaches each bundle. */
export function driverList(route: Line, order: readonly string[] | undefined): BundleName[] {
  return bundleRows(bundlePasses(route), { handledStopIds: [] }, order, null).map(({ id, name }) => ({ id, name }))
}

export interface ListWalk {
  /** Each bundle's place in the list, with the pass of it the walk took. */
  picks: Map<string, Occurrence>
  /** Ids of the bundles with no pass after the one before them. */
  stranded: string[]
}

/**
 * Works down a list along a route: each bundle takes its first pass after the bundle before it. Being first, this leaves the most road
 * for the rest, so if it strands a bundle, no choice of passes would have fitted. Two bundles at the one spot may share it. `at` says
 * how far along the drive a pass is, for a drive that doesn't begin at the route's first point, and `passes` come in that order.
 */
export function walkList(passes: readonly Occurrence[], ids: readonly string[], at: (pass: Occurrence) => number = (o) => o.at): ListWalk {
  const byStop = new Map<string, Occurrence[]>()
  for (const o of passes) {
    const list = byStop.get(o.stop.id)
    if (list) list.push(o)
    else byStop.set(o.stop.id, [o])
  }
  const picks = new Map<string, Occurrence>()
  const stranded: string[] = []
  let after = -Infinity
  for (const id of ids) {
    const pass = byStop.get(id)?.find((o) => at(o) >= after)
    if (!pass) {
      stranded.push(id)
      continue
    }
    picks.set(id, pass)
    after = at(pass)
  }
  return { picks, stranded }
}

/** A list in the order a drive first reaches each bundle, by how far along the drive `at` puts each pass. */
export function byFirstPass(list: readonly BundleName[], passes: readonly Occurrence[], at: (pass: Occurrence) => number): BundleName[] {
  const first = new Map<string, number>()
  for (const o of passes) first.set(o.stop.id, Math.min(first.get(o.stop.id) ?? Infinity, at(o)))
  return [...list].sort((a, b) => (first.get(a.id) ?? Infinity) - (first.get(b.id) ?? Infinity))
}

/** The stops besides bundles that have to stay on the route. */
export const otherVisits = (stops: readonly Stop[]): Stop[] => stops.filter((s) => s.type === 'request' || s.type === 'block')
