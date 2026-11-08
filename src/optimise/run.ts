import type { SavedRoute } from '../types'
import type { BasedOn, OptimiseChoices, PreparedView, StartPoint } from './types'

/**
 * What a run starts from and is based on, kept apart from the engine: the choices screen and Accept need these on the phone's main thread, and
 * importing them from `optimise.ts` would bring the whole solver along with them, when it belongs in the worker.
 */

/** A short fingerprint of everything Accept would replace. FNV-1a over the text is plenty to tell one saved route from the next. */
export function fingerprintOf(saved: Pick<SavedRoute, 'route' | 'bundleOrder'>): string {
  const text = JSON.stringify([saved.route.points, saved.route.sideChanges, saved.route.stops, saved.bundleOrder ?? null])
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`
}

export const basedOnOf = (saved: SavedRoute): BasedOn => ({ routeId: saved.id, updatedAt: saved.updatedAt, fingerprint: fingerprintOf(saved) })

/** Whether a route has changed since the run that gave `basedOn`, in which case the result is for a route that no longer exists. */
export const isStale = (saved: SavedRoute, basedOn: BasedOn): boolean => saved.id !== basedOn.routeId || fingerprintOf(saved) !== basedOn.fingerprint

/**
 * A thrown stretch of today's route this long or longer, in metres, blocks Accept when the new route leaves it out or it isn't on the map. It is here,
 * with the engine's other plain values, so that the choices screen can say so before a run without bringing the solver onto the phone's main thread.
 */
export const COVER_GATE_M = 16

/** A route with fewer bundles than this has no order to keep, and holding it only makes the search weaker. */
const ORDER_MIN_BUNDLES = 2

/** Whether a route has a bundle order to keep, so that the choices offer Keep my bundle order. */
export const hasBundleOrder = (view: Pick<PreparedView, 'bundles'>): boolean => view.bundles.length >= ORDER_MIN_BUNDLES

/** The choices a run starts from: each street's default, and the bundle order kept where there is an order to keep. */
export function defaultChoices(view: Pick<PreparedView, 'streets' | 'bundles'>): OptimiseChoices {
  return { allowed: Object.fromEntries(view.streets.map((s) => [s.key, s.allowed])), keepOrder: hasBundleOrder(view) }
}

/** Whether a named section is the one a run starts and ends at. */
export const isStartSection = (section: { name: string }): boolean => section.name.trim().toLowerCase() === 'start'

/** Where the route starts and ends: the section called Start, or the route's first point. */
export function startOf(saved: Pick<SavedRoute, 'route' | 'sections'>): StartPoint {
  const section = saved.sections?.find(isStartSection)
  if (section) return { lat: section.lat, lng: section.lng, section: section.name }
  const [first] = saved.route.points
  return { lat: first.lat, lng: first.lng, section: null }
}
