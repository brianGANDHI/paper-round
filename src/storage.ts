import { normalizeRoute } from './routeEdit'
import type { RoundState, Route } from './types'

const ROUTE_KEY = 'paperround.route.v1'
const ROUND_KEY = 'paperround.round.v1'

export const emptyRoute = (): Route => ({ points: [], sideChanges: [], stops: [] })

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or blocked; the app keeps working for this session.
  }
}

export const loadRoute = () => normalizeRoute(load<Route>(ROUTE_KEY, emptyRoute()))
export const saveRoute = (r: Route) => save(ROUTE_KEY, r)
export const loadRound = () => load<RoundState>(ROUND_KEY, { handledStopIds: [] })
export const saveRound = (r: RoundState) => save(ROUND_KEY, r)
