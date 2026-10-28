import { reconcile } from './bundles'
import { occurrences } from './geo'
import { normalizeSections, tidyText } from './namedSections'
import { normalizeRoute } from './routeEdit'
import type { Library, NamedSection, RoundState, Route, SavedRoute, TurnStreet } from './types'

export const MAX_NAME = 40
export const DEFAULT_NAME = 'My Round'
/** The most street names kept for one route, so damaged data can't fill the phone. */
export const MAX_STREETS = 5000
/** The longest street name kept. */
export const MAX_STREET_NAME = 60

export function newId(): string {
  const c = globalThis.crypto
  if (c && 'randomUUID' in c) return c.randomUUID()
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

const emptyRoute = (): Route => ({ points: [], sideChanges: [], stops: [] })
const freshRound = (): RoundState => ({ handledStopIds: [] })

export function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME)
}

/** A name no other route uses: "Monday", then "Monday 2", "Monday 3" and so on. */
export function uniqueName(lib: Pick<Library, 'routes'>, wanted: string, ignoreId?: string): string {
  const base = cleanName(wanted) || DEFAULT_NAME
  const taken = new Set(lib.routes.filter((r) => r.id !== ignoreId).map((r) => r.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`
    const candidate = base.slice(0, MAX_NAME - suffix.length) + suffix
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

export function makeRoute(name: string, route: Route = emptyRoute(), now = Date.now()): SavedRoute {
  return { id: newId(), name, route, round: freshRound(), updatedAt: now }
}

export function createLibrary(): Library {
  const first = makeRoute(DEFAULT_NAME, emptyRoute(), 0)
  return { routes: [first], activeId: first.id }
}

export function activeRoute(lib: Library): SavedRoute {
  return lib.routes.find((r) => r.id === lib.activeId) ?? lib.routes[0]
}

/** A route nobody has drawn on yet, such as the one a fresh install starts with. */
export const isPristine = (r: SavedRoute) => r.route.points.length === 0 && r.route.stops.length === 0

const mapRoute = (lib: Library, id: string, fn: (r: SavedRoute) => SavedRoute): Library => ({
  ...lib,
  routes: lib.routes.map((r) => (r.id === id ? fn(r) : r)),
})

/** The route was edited: keep it, and start its round over because stop ids may have changed. */
export function editActiveRoute(lib: Library, route: Route, now = Date.now()): Library {
  return mapRoute(lib, lib.activeId, (r) => ({ ...r, route, round: freshRound(), updatedAt: now }))
}

/**
 * The route was changed in a way that leaves its stops where they were, such as a side changed while driving: keep it
 * and the round's progress (how far it got, where it was started, which bundles were dropped or missed), forgetting only the
 * stops done that are no longer met on the route. Unlike `editActiveRoute`, the round carries on.
 */
export function adjustActiveRoute(lib: Library, route: Route, now = Date.now()): Library {
  const met = new Set(occurrences(route).map((o) => o.key))
  return mapRoute(lib, lib.activeId, (r) => ({
    ...r,
    route,
    round: reconcile({ ...r.round, handledStopIds: r.round.handledStopIds.filter((key) => met.has(key)) }),
    updatedAt: now,
  }))
}

/** Keep the round's progress. The bundles dropped or missed are kept only while they are among the stops done: see `reconcile`. */
export function setActiveRound(lib: Library, round: RoundState): Library {
  return mapRoute(lib, lib.activeId, (r) => ({ ...r, round: reconcile(round) }))
}

/** A route with its named sections and street names set; a key is left out when there are none. */
function withExtras(r: SavedRoute, sections: readonly NamedSection[] | undefined, streets: readonly TurnStreet[] | undefined): SavedRoute {
  const { sections: _sections, streets: _streets, ...rest } = r
  return { ...rest, ...(sections?.length ? { sections: [...sections] } : {}), ...(streets?.length ? { streets: [...streets] } : {}) }
}

/** Give the route in use its named sections. Nothing else about it changes, as naming a part does not alter the route. */
export function setActiveSections(lib: Library, sections: readonly NamedSection[]): Library {
  return mapRoute(lib, lib.activeId, (r) => withExtras(r, sections, r.streets))
}

/** Give the route in use the street names found for its turns. Nothing else about it changes. */
export function setActiveStreets(lib: Library, streets: readonly TurnStreet[]): Library {
  return mapRoute(lib, lib.activeId, (r) => withExtras(r, r.sections, streets))
}

export function selectRoute(lib: Library, id: string): Library {
  return lib.routes.some((r) => r.id === id) ? { ...lib, activeId: id } : lib
}

/** Add a route and switch to it. */
export function addRoute(lib: Library, name: string, route?: Route, now = Date.now()): Library {
  const created = makeRoute(uniqueName(lib, name), route, now)
  return { routes: [...lib.routes, created], activeId: created.id }
}

export function renameRoute(lib: Library, id: string, name: string): Library {
  if (!cleanName(name)) return lib
  return mapRoute(lib, id, (r) => ({ ...r, name: uniqueName(lib, name, id) }))
}

/** Copy a route, with its named sections and street names, under a new name and switch to the copy. Its round starts fresh. */
export function duplicateRoute(lib: Library, id: string, now = Date.now()): Library {
  const source = lib.routes.find((r) => r.id === id)
  if (!source) return lib
  const made = makeRoute(uniqueName(lib, `${source.name} copy`), structuredClone(source.route), now)
  const copy = withExtras(made, structuredClone(source.sections), structuredClone(source.streets))
  return { routes: [...lib.routes, copy], activeId: copy.id }
}

/** Remove a route. The library never ends up empty: deleting the last one leaves a blank route. */
export function deleteRoute(lib: Library, id: string): Library {
  const remaining = lib.routes.filter((r) => r.id !== id)
  if (!remaining.length) return createLibrary()
  if (lib.activeId !== id) return { routes: remaining, activeId: lib.activeId }
  const position = lib.routes.findIndex((r) => r.id === id)
  return { routes: remaining, activeId: remaining[Math.min(position, remaining.length - 1)].id }
}

/** Whether two route names are the same name, ignoring case and stray spaces. */
export const sameName = (a: string, b: string) => cleanName(a).toLowerCase() === cleanName(b).toLowerCase()

/** What to do when a backup has a route with the name of one already here. */
export type ImportMode = 'keep' | 'replace'

/**
 * The routes already here that a backup would collide with by name. Nothing collides with the blank
 * route a fresh install starts with, as that is replaced anyway.
 */
export function importClashes(lib: Library, imported: { name: string }[]): string[] {
  if (lib.routes.length === 1 && isPristine(lib.routes[0])) return []
  return lib.routes.filter((r) => imported.some((i) => sameName(i.name, r.name))).map((r) => r.name)
}

/**
 * Add routes from a backup. By default nothing is overwritten: a route with the name of one already here
 * is added under a new name. With `replace`, it takes the place of the route with that name instead, which
 * keeps its place in the list and starts its round over. A blank starter route is replaced rather than left
 * beside the imported ones, and the first imported route becomes the active one in that case.
 */
export function addImported(
  lib: Library,
  imported: { name: string; route: Route; sections?: NamedSection[]; streets?: TurnStreet[] }[],
  now = Date.now(),
  mode: ImportMode = 'keep',
): Library {
  if (!imported.length) return lib
  const [only] = lib.routes
  const replaceStarter = lib.routes.length === 1 && isPristine(only)
  let next: Library = replaceStarter ? { routes: [], activeId: '' } : lib
  for (const item of imported) {
    const existing = mode === 'replace' ? next.routes.find((r) => sameName(r.name, item.name)) : undefined
    // A backup made before sections or street names existed has none, so a route it replaces keeps its own.
    next = existing
      ? {
          ...next,
          routes: next.routes.map((r) =>
            r.id === existing.id
              ? withExtras({ ...r, route: item.route, round: freshRound(), updatedAt: now }, item.sections ?? r.sections, item.streets ?? r.streets)
              : r,
          ),
        }
      : {
          ...next,
          routes: [...next.routes, withExtras(makeRoute(uniqueName(next, item.name || 'Imported route'), item.route, now), item.sections, item.streets)],
        }
  }
  return replaceStarter ? { ...next, activeId: next.routes[0].id } : next
}

/**
 * Make street names read back from storage or a backup safe to use: junk is dropped (not an object, a place that is not
 * on Earth, a way out that is not a whole number of degrees from 0 to 359, a name that is not text), names are tidied
 * and kept to MAX_STREET_NAME (an empty one is fine: the road has no name), and no more than MAX_STREETS are kept.
 */
export function normalizeStreets(raw: unknown): TurnStreet[] {
  if (!Array.isArray(raw)) return []
  const clean: TurnStreet[] = []
  for (const item of raw) {
    if (clean.length >= MAX_STREETS) break
    if (typeof item !== 'object' || item === null) continue
    const { lat, lng, out, name } = item as Record<string, unknown>
    if (typeof lat !== 'number' || typeof lng !== 'number' || typeof out !== 'number' || typeof name !== 'string') continue
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue
    if (!Number.isInteger(out) || out < 0 || out > 359) continue
    clean.push({ lat, lng, out, name: tidyText(name, MAX_STREET_NAME) })
  }
  return clean
}

/** Make anything read back from storage safe to use. Null when there is nothing usable. */
export function normalizeLibrary(raw: unknown): Library | null {
  if (!raw || typeof raw !== 'object') return null
  const { routes, activeId } = raw as { routes?: unknown; activeId?: unknown }
  if (!Array.isArray(routes)) return null
  const seen = new Set<string>()
  const clean: SavedRoute[] = []
  for (const item of routes) {
    if (!item || typeof item !== 'object') continue
    const r = item as Partial<SavedRoute>
    const id = typeof r.id === 'string' && r.id && !seen.has(r.id) ? r.id : newId()
    seen.add(id)
    const handled = Array.isArray(r.round?.handledStopIds)
      ? r.round.handledStopIds.filter((s): s is string => typeof s === 'string')
      : []
    const furthest = r.round?.furthest
    const startM = r.round?.startM
    const sections = normalizeSections(r.sections)
    const streets = normalizeStreets(r.streets)
    clean.push({
      id,
      name: cleanName(typeof r.name === 'string' ? r.name : '') || DEFAULT_NAME,
      route: normalizeRoute(r.route),
      // The bundles dropped or missed are read like the stops done, and kept only while they are among them.
      round: reconcile({
        handledStopIds: handled,
        ...(typeof furthest === 'number' && Number.isFinite(furthest) && furthest > 0 ? { furthest } : {}),
        ...(typeof startM === 'number' && Number.isFinite(startM) && startM >= 0 ? { startM } : {}),
        dropped: r.round?.dropped,
        missed: r.round?.missed,
      }),
      updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
      ...(sections.length ? { sections } : {}),
      ...(streets.length ? { streets } : {}),
    })
  }
  if (!clean.length) return null
  return { routes: clean, activeId: clean.some((r) => r.id === activeId) ? (activeId as string) : clean[0].id }
}
