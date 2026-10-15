import { cleanName } from './library'
import { newStopId, normalizeRoute } from './routeEdit'
import type { Pt, Route, SideChange, Stop } from './types'

export const BACKUP_APP = 'paper-round'
export const BACKUP_VERSION = 1

/** Sanity limits, so a mistaken paste can't fill the phone. */
const LIMITS = { chars: 5_000_000, routes: 100, points: 20_000, stops: 5_000 }

const HEADER = 'Paper Round backup'
const NOT_A_BACKUP = "That doesn't look like a Paper Round backup. Paste the whole text you copied."

export interface BackupRoute {
  name: string
  route: Route
}

export type ParseResult = { ok: true; routes: BackupRoute[] } | { ok: false; error: string }

/** About 10 cm, which is far finer than a hand-drawn route and keeps the text short. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** The text to keep somewhere safe. Progress through a run is not included. */
export function makeBackup(routes: BackupRoute[], now = new Date()): string {
  const payload = {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    routes: routes.map(({ name, route }) => ({
      name,
      route: {
        points: route.points.map((p) => ({ lat: round6(p.lat), lng: round6(p.lng) })),
        sideChanges: route.sideChanges,
        stops: route.stops.map((s) => ({ ...s, lat: round6(s.lat), lng: round6(s.lng) })),
      },
    })),
  }
  return `${HEADER}\n${JSON.stringify(payload)}`
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function isPoint(v: unknown): v is Pt {
  return (
    isObject(v) &&
    typeof v.lat === 'number' &&
    typeof v.lng === 'number' &&
    Number.isFinite(v.lat) &&
    Number.isFinite(v.lng) &&
    Math.abs(v.lat) <= 90 &&
    Math.abs(v.lng) <= 180
  )
}

function parseStops(raw: unknown, label: string): Stop[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > LIMITS.stops) return `${label} has a stop list that isn't valid.`
  const seen = new Set<string>()
  const stops: Stop[] = []
  for (const s of raw) {
    if (!isObject(s) || !isPoint(s) || (s.type !== 'bundle' && s.type !== 'nothrow')) {
      return `${label} has a stop that isn't valid.`
    }
    const id = typeof s.id === 'string' && s.id && !seen.has(s.id) ? s.id : newStopId()
    seen.add(id)
    const stop: Stop = {
      id,
      type: s.type,
      lat: s.lat as number,
      lng: s.lng as number,
      pathIdx: typeof s.pathIdx === 'number' && Number.isFinite(s.pathIdx) ? Math.max(0, Math.trunc(s.pathIdx)) : 0,
    }
    if (typeof s.qty === 'number' && Number.isFinite(s.qty) && s.qty > 0) stop.qty = Math.trunc(s.qty)
    if (typeof s.label === 'string' && s.label.trim()) stop.label = s.label.trim().slice(0, 120)
    stops.push(stop)
  }
  return stops
}

function parseSideChanges(raw: unknown): SideChange[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((c) =>
    isObject(c) &&
    typeof c.idx === 'number' &&
    Number.isFinite(c.idx) &&
    c.idx >= 0 &&
    (c.side === 'both' || c.side === 'left' || c.side === 'right')
      ? [{ idx: Math.trunc(c.idx), side: c.side }]
      : [],
  )
}

function parseRoute(item: unknown, index: number): BackupRoute | string {
  const label = `Route ${index + 1} in the backup`
  if (!isObject(item) || !isObject(item.route)) return `${label} is damaged.`
  const { points, sideChanges, stops } = item.route
  if (!Array.isArray(points) || points.length > LIMITS.points) return `${label} has a list of points that isn't valid.`
  const valid: Pt[] = []
  for (const p of points) {
    if (!isPoint(p)) return `${label} has a location that isn't valid.`
    valid.push({ lat: p.lat, lng: p.lng })
  }
  const parsedStops = parseStops(stops, label)
  if (typeof parsedStops === 'string') return parsedStops
  return {
    name: cleanName(typeof item.name === 'string' ? item.name : ''),
    route: normalizeRoute({ points: valid, sideChanges: parseSideChanges(sideChanges), stops: parsedStops }),
  }
}

const fail = (error: string): ParseResult => ({ ok: false, error })

/** Read text pasted back in. Strict about the contents, forgiving about how it got here. */
export function parseBackup(text: string): ParseResult {
  if (text.length > LIMITS.chars) return fail('That text is too long to be a backup.')
  // Notes and Messages can turn straight quotes into curly ones.
  const straight = text.replace(/[“”„‟]/g, '"').replace(/[‘’]/g, "'")
  const start = straight.indexOf('{')
  const end = straight.lastIndexOf('}')
  if (start < 0 || end <= start) return fail(NOT_A_BACKUP)

  let data: unknown
  try {
    data = JSON.parse(straight.slice(start, end + 1))
  } catch {
    return fail(NOT_A_BACKUP)
  }
  if (!isObject(data) || data.app !== BACKUP_APP || !Array.isArray(data.routes)) return fail(NOT_A_BACKUP)
  if (typeof data.version === 'number' && data.version > BACKUP_VERSION) {
    return fail('This backup was made by a newer version of the app. Update the app, then try again.')
  }
  if (!data.routes.length) return fail('That backup has no routes in it.')
  if (data.routes.length > LIMITS.routes) return fail('That backup has too many routes.')

  const routes: BackupRoute[] = []
  for (const [i, item] of data.routes.entries()) {
    const parsed = parseRoute(item, i)
    if (typeof parsed === 'string') return fail(parsed)
    routes.push(parsed)
  }
  return { ok: true, routes }
}
