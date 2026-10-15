import { normalizeRoute } from './routeEdit'
import type { Library, RoundState, Route, SavedRoute } from './types'

export const MAX_NAME = 40
export const DEFAULT_NAME = 'My Round'

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

export function setActiveRound(lib: Library, round: RoundState): Library {
  return mapRoute(lib, lib.activeId, (r) => ({ ...r, round }))
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

/** Copy a route under a new name and switch to the copy. Its round starts fresh. */
export function duplicateRoute(lib: Library, id: string, now = Date.now()): Library {
  const source = lib.routes.find((r) => r.id === id)
  if (!source) return lib
  const copy = makeRoute(uniqueName(lib, `${source.name} copy`), structuredClone(source.route), now)
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

/**
 * Add routes from a backup. Nothing is overwritten. A blank starter route is
 * replaced rather than left beside the imported ones, and the first imported
 * route becomes the active one in that case.
 */
export function addImported(lib: Library, imported: { name: string; route: Route }[], now = Date.now()): Library {
  if (!imported.length) return lib
  const [only] = lib.routes
  const replaceStarter = lib.routes.length === 1 && isPristine(only)
  let next: Library = replaceStarter ? { routes: [], activeId: '' } : lib
  for (const item of imported) {
    next = { ...next, routes: [...next.routes, makeRoute(uniqueName(next, item.name || 'Imported route'), item.route, now)] }
  }
  return replaceStarter ? { ...next, activeId: next.routes[0].id } : next
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
    clean.push({
      id,
      name: cleanName(typeof r.name === 'string' ? r.name : '') || DEFAULT_NAME,
      route: normalizeRoute(r.route),
      round: { handledStopIds: handled },
      updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
    })
  }
  if (!clean.length) return null
  return { routes: clean, activeId: clean.some((r) => r.id === activeId) ? (activeId as string) : clean[0].id }
}
