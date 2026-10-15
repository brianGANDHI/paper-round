import { createLibrary, DEFAULT_NAME, makeRoute, normalizeLibrary } from './library'
import { normalizeRoute } from './routeEdit'
import type { Library, RoundState, Route } from './types'

/** Where everything is kept on the phone. */
const LIBRARY_KEY = 'paperround.library.v2'
const FOLLOW_ROADS_KEY = 'paperround.followRoads'

/** The single route and its progress, as saved by earlier versions of the app. */
const LEGACY_ROUTE_KEY = 'paperround.route.v1'
const LEGACY_ROUND_KEY = 'paperround.round.v1'

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Bring across the one route earlier versions saved, so nobody has to draw it again. */
function readLegacy(): Library | null {
  const saved = read(LEGACY_ROUTE_KEY)
  if (!saved) return null
  const round = read(LEGACY_ROUND_KEY) as Partial<RoundState> | null
  const first = makeRoute(DEFAULT_NAME, normalizeRoute(saved as Partial<Route>), 0)
  if (Array.isArray(round?.handledStopIds)) {
    first.round = { handledStopIds: round.handledStopIds.filter((s): s is string => typeof s === 'string') }
  }
  return { routes: [first], activeId: first.id }
}

/** Returns false when the phone refuses to store it, for example in a private tab. */
export function saveLibrary(library: Library): boolean {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(library))
    return true
  } catch {
    return false
  }
}

/** Does this phone let the app store anything at all? */
export function canSave(): boolean {
  try {
    const probe = 'paperround.probe'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

/** Whether Follow roads was left switched on, so the choice survives leaving Setup. Off until someone turns it on. */
export function loadFollowRoads(): boolean {
  return read(FOLLOW_ROADS_KEY) === true
}

export function saveFollowRoads(on: boolean): void {
  try {
    localStorage.setItem(FOLLOW_ROADS_KEY, JSON.stringify(on))
  } catch {
    // The phone won't store it; the switch just starts off next time.
  }
}

/** Open the saved routes, carrying over an old single route the first time. */
export function loadLibrary(): Library {
  const stored = normalizeLibrary(read(LIBRARY_KEY))
  if (stored) return stored
  const library = readLegacy() ?? createLibrary()
  saveLibrary(library)
  return library
}
