import { cleanName, normalizeStreets } from './library'
import { normalizeSections } from './namedSections'
import { newStopId, normalizeRoute } from './routeEdit'
import { isSide, type NamedSection, type Pt, type Route, type SavedRoute, type SideChange, type Stop, type TurnStreet } from './types'

export const BACKUP_APP = 'paper-round'
export const BACKUP_VERSION = 1

/**
 * Sanity limits, so a mistaken paste can't fill the phone. The text limit is about as much as a phone's storage holds
 * and a backup is never longer than the routes as they are stored, so a backup made here can be read back.
 */
const LIMITS = { chars: 5_000_000, routes: 100, points: 20_000, stops: 5_000 }

/** The most a backup file may hold, which the text length limit already allows for. */
export const MAX_BACKUP_CHARS = LIMITS.chars

const HEADER = 'Paper Round backup'
const NOT_A_BACKUP = "That doesn't look like a Paper Round backup. Paste the whole text you copied."

export interface BackupRoute {
  name: string
  route: Route
  /** The route's named parts, if it has any. A backup made before they existed has none. */
  sections?: NamedSection[]
  /** The street names found for the route's turns, if it has any. */
  streets?: TurnStreet[]
}

/** What a saved route puts in a backup: its name, route, named sections and street names, and not its progress. */
export const toBackupRoute = (r: Pick<SavedRoute, 'name' | 'route' | 'sections' | 'streets'>): BackupRoute => ({
  name: r.name,
  route: r.route,
  sections: r.sections ?? [],
  streets: r.streets ?? [],
})

export type ParseResult = { ok: true; routes: BackupRoute[] } | { ok: false; error: string }

/** About 10 cm, which is far finer than a hand-drawn route and keeps the text short. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** The text to keep somewhere safe. Progress through a run is not included. */
export function makeBackup(routes: BackupRoute[], now = new Date()): string {
  const payload = {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    routes: routes.map(({ name, route, sections, streets }) => ({
      name,
      route: {
        points: route.points.map((p) => ({ lat: round6(p.lat), lng: round6(p.lng) })),
        sideChanges: route.sideChanges,
        stops: route.stops.map((s) => ({ ...s, lat: round6(s.lat), lng: round6(s.lng) })),
      },
      // Written even when there are none, which says the route has none: restoring over a route that has some takes them off. A
      // backup made before they existed has no such lines, and leaves a route's own alone.
      ...(sections
        ? { sections: sections.map(({ id, name: label, lat, lng, pass }) => ({ id, name: label, lat: round6(lat), lng: round6(lng), pass })) }
        : {}),
      ...(streets ? { streets: streets.map(({ lat, lng, out, name: label }) => ({ lat: round6(lat), lng: round6(lng), out, name: label })) } : {}),
    })),
  }
  return `${HEADER}\n${JSON.stringify(payload)}`
}

/** A name for the file a backup is saved as, fine on any computer or phone. */
export function backupFileName(label: string): string {
  const clean = label
    .replace(/[\\/:*?"<>|\u201c\u201d]|\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim()
  return `Paper Round - ${clean || 'Routes'}.txt`
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
    if (!isObject(s) || !isPoint(s) || (s.type !== 'bundle' && s.type !== 'nothrow' && s.type !== 'request')) {
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
    if (s.type === 'request' && typeof s.note === 'string' && s.note.trim()) stop.note = s.note.trim().slice(0, 120)
    if (typeof s.label === 'string' && s.label.trim()) stop.label = s.label.trim().slice(0, 120)
    if (typeof s.address === 'string' && s.address.trim()) stop.address = s.address.trim().slice(0, 120)
    if (s.side === 'left' || s.side === 'right') stop.side = s.side
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
    isSide(c.side)
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
  // Named sections and street names are extras: whatever is wrong with them, the route itself is still restored.
  const sections = normalizeSections(item.sections)
  const streets = normalizeStreets(item.streets)
  return {
    name: cleanName(typeof item.name === 'string' ? item.name : ''),
    route: normalizeRoute({ points: valid, sideChanges: parseSideChanges(sideChanges), stops: parsedStops }),
    // A list that is there and empty says the route has none. One whose every entry was damaged says nothing: the route's own stay.
    ...(Array.isArray(item.sections) && (sections.length > 0 || item.sections.length === 0) ? { sections } : {}),
    ...(Array.isArray(item.streets) && (streets.length > 0 || item.streets.length === 0) ? { streets } : {}),
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
