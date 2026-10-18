import { DEFAULT_ALERT_DISTANCE, isAlertDistance, type AlertDistance } from './alerts'
import { createLibrary, DEFAULT_NAME, makeRoute, normalizeLibrary } from './library'
import { normalizeRoute } from './routeEdit'
import type { Library, RoundState, Route } from './types'

/** Where everything is kept on the phone. */
const LIBRARY_KEY = 'paperround.library.v2'
const FOLLOW_ROADS_KEY = 'paperround.followRoads'
const ALERT_DISTANCE_KEY = 'paperround.alertDistance'
const VOICE_TURNS_KEY = 'paperround.voiceTurns'

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

/** Whether the next turn is also said out loud, as last chosen. Off until someone turns it on: the arrow is enough on its own. */
export function loadVoiceTurns(): boolean {
  return read(VOICE_TURNS_KEY) === true
}

export function saveVoiceTurns(on: boolean): void {
  try {
    localStorage.setItem(VOICE_TURNS_KEY, JSON.stringify(on))
  } catch {
    // The phone won't store it; the voice starts off next time.
  }
}

/** What earlier versions called the choices, in metres. */
const OLD_ALERT_DISTANCES: Record<string, AlertDistance> = { close: 20, normal: 40, far: 60 }

/** How close to a stop its alert comes up, in metres, as the driver last chose it. Anything unexpected reads as the usual 40. */
export function loadAlertDistance(): AlertDistance {
  const saved = read(ALERT_DISTANCE_KEY)
  if (isAlertDistance(saved)) return saved
  return (typeof saved === 'string' && OLD_ALERT_DISTANCES[saved]) || DEFAULT_ALERT_DISTANCE
}

export function saveAlertDistance(distance: AlertDistance): void {
  try {
    localStorage.setItem(ALERT_DISTANCE_KEY, JSON.stringify(distance))
  } catch {
    // The phone won't store it; the usual distance comes back next time.
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
