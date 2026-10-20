import { simplify } from './geo'
import { appendPoint, appendPoints, isDuplicateTap, removeLastPoint } from './routeEdit'
import type { Pt, Route, Side } from './types'

/**
 * Follow roads: the stretch between two taps worked out along streets by a public OSRM server.
 *
 * It is the one FOSSGIS runs at routing.openstreetmap.de, which also serves the directions on
 * openstreetmap.org, on its car profile so one-way streets are respected. Its terms
 * (fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen) allow one request a second, ask for
 * OpenStreetMap attribution with a link to fix the map, rule out heavy use, and promise no
 * availability. So there is a gap between requests, only one runs at a time, and any failure is
 * answered with a straight line instead. Route by address (transit.ts) asks the same server for the
 * road between two typed addresses, and reports a failure instead. Street names (streets.ts) ask it which
 * road is nearest a point. All of them ask through the same gap, one at a time in the order they asked.
 */
const DEFAULT_ENDPOINT = 'https://routing.openstreetmap.de/routed-car/route/v1/driving'

/** FOSSGIS asks that its URL isn't baked into apps: set VITE_ROUTING_URL when building to use another OSRM server. */
export const ENDPOINT: string = String(import.meta.env.VITE_ROUTING_URL || DEFAULT_ENDPOINT).replace(/\/+$/, '')

/**
 * Where the same server answers "which street is nearest this point", for naming the streets turns lead into: the
 * route address with its service swapped. Null when the address given is not one for routes, so there is no guessing.
 */
export const nearestEndpoint = (endpoint: string): string | null =>
  endpoint.includes('/route/v1/') ? endpoint.replace('/route/v1/', '/nearest/v1/') : null

export const NEAREST: string | null = nearestEndpoint(ENDPOINT)

/** The service allows one request a second; tests set this to 0. */
export const rate = { minGapMs: 1100 }
/** How long to wait for an answer before the stretch is drawn straight instead. */
export const TIMEOUT_MS = 5000
/** A tap farther than this from any street has nothing to follow. */
const SNAP_RADIUS_M = 50
/** The streets come back exact, so only points that hardly change the line are thinned away. */
export const ROAD_SIMPLIFY_M = 2

export type RoadFailure = 'offline' | 'timeout' | 'service' | 'no-road' | 'cancelled'

export class RoadError extends Error {
  kind: RoadFailure
  /** The status the service answered with, when it did. A 429 or a 5xx means it is refusing or struggling, so asking more would only make it worse. */
  status?: number
  constructor(kind: RoadFailure, detail?: string, status?: number) {
    super(detail ? `${kind}: ${detail}` : kind)
    this.name = 'RoadError'
    this.kind = kind
    this.status = status
  }
}

/** What to tell the user when a stretch had to be drawn straight. A cancelled lookup says nothing. */
export const ROAD_NOTICE: Record<Exclude<RoadFailure, 'cancelled'>, string> = {
  offline: 'Following roads needs an internet connection, so that stretch is a straight line.',
  timeout: 'The road service was too slow, so that stretch is a straight line.',
  service: "The road service isn't working right now, so that stretch is a straight line.",
  'no-road': 'No road route found there, so that stretch is a straight line.',
}

const lngLat = (p: Pt) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`

/** The request for the way from one place to another. OSRM wants longitude first. */
export const roadUrl = (from: Pt, to: Pt, radiusM = SNAP_RADIUS_M) =>
  `${ENDPOINT}/${lngLat(from)};${lngLat(to)}?overview=full&geometries=geojson&radiuses=${radiusM};${radiusM}`

interface RawRoute {
  code?: unknown
  routes?: { duration?: unknown; geometry?: { coordinates?: unknown } }[]
}

/** OSRM's two ways of saying there is nothing to follow: no street near a point, or no way between them. */
const isNoRoad = (code: unknown) => code === 'NoSegment' || code === 'NoRoute'

const isCoordinate = (c: unknown): c is [number, number] =>
  Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90

/** The points of the street route in an OSRM answer, thinned. Throws a RoadError when there isn't one. */
export function roadPoints(json: unknown): Pt[] {
  const body = (json && typeof json === 'object' ? json : {}) as RawRoute
  if (isNoRoad(body.code)) throw new RoadError('no-road', String(body.code))
  if (body.code !== 'Ok') throw new RoadError('service', `answered ${String(body.code)}`)
  const coords = body.routes?.[0]?.geometry?.coordinates
  const points = Array.isArray(coords) ? coords.filter(isCoordinate).map(([lng, lat]) => ({ lat, lng })) : []
  if (points.length < 2) throw new RoadError('service', 'no route in the answer')
  return simplify(points, ROAD_SIMPLIFY_M)
}

/** How long the drive takes, in seconds, as the service works it out. Null when the answer doesn't say. */
export function roadSeconds(json: unknown): number | null {
  const seconds = (json as RawRoute | null)?.routes?.[0]?.duration
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

export interface LookupOptions {
  /** Cancels the lookup, wherever it has got to. */
  signal?: AbortSignal
  timeoutMs?: number
  /** How far from each end to look for a street, in metres. */
  radiusM?: number
}

/** A drive from one place to another. */
export interface Drive {
  /** The street route, thinned, from the snapped start to the snapped end. */
  points: Pt[]
  seconds: number | null
}

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false

let lastCall = 0
/** The last of those waiting their turn to ask: whoever asks next waits for it. */
let line: Promise<unknown> = Promise.resolve()

const cancelled = () => new RoadError('cancelled')

/** Wait out what is left of the gap since the last request, then take the slot. Gives up the moment the lookup is cancelled, without taking it. */
function takeSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelled())
  // Never longer than the gap itself, so a clock that was set back cannot hold everything up until it catches up.
  const wait = Math.min(rate.minGapMs, lastCall + rate.minGapMs - Date.now())
  if (wait <= 0) {
    lastCall = Date.now()
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel)
      lastCall = Date.now()
      resolve()
    }, wait)
    const cancel = () => {
      clearTimeout(timer)
      reject(cancelled())
    }
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

/**
 * Leave a gap after the last request, giving up the moment the lookup is cancelled. Everything that asks goes through
 * here, one after another in the order it asked, so two lookups started together (such as following roads while street
 * names are being found) still keep to one request a second. One that gives up leaves the line without costing the rest a gap.
 */
export function spaced(signal?: AbortSignal): Promise<void> {
  const mine = line.then(() => takeSlot(signal))
  line = mine.catch(() => undefined)
  if (!signal) return mine
  return new Promise((resolve, reject) => {
    const leave = () => reject(cancelled())
    signal.addEventListener('abort', leave, { once: true })
    mine.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave))
    // Cancelled before it even joined the line.
    if (signal.aborted) leave()
  })
}

/** What a request got back: whether it was a success, its status, and its body read as JSON. */
export interface Reply {
  ok: boolean
  status: number
  json: unknown
}

/**
 * One plain request, never faster than the service allows, read as JSON whatever its status (the body of an error says
 * more about it). Always a RoadError when it fails: offline (no connection, or the request never got through), timeout,
 * service (an answer that is not JSON) or cancelled.
 */
export async function getJson(url: string, opts: Pick<LookupOptions, 'signal' | 'timeoutMs'> = {}): Promise<Reply> {
  const { signal, timeoutMs = TIMEOUT_MS } = opts
  if (signal?.aborted) throw cancelled()
  if (offline()) throw new RoadError('offline')
  await spaced(signal)
  if (signal?.aborted) throw cancelled()

  // One controller for both ways of stopping early: the caller cancelling and the time running out.
  const stop = new AbortController()
  let slow = false
  const timer = setTimeout(() => {
    slow = true
    stop.abort()
  }, timeoutMs)
  const cancel = () => stop.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const stopped = () => (stop.signal.aborted ? new RoadError(slow ? 'timeout' : 'cancelled') : null)

  try {
    let res: Response
    try {
      // No custom headers, so the browser sends a plain request with no preflight.
      res = await fetch(url, { signal: stop.signal })
    } catch {
      throw stopped() ?? new RoadError('offline')
    }
    let json: unknown
    try {
      json = await res.json()
    } catch {
      throw stopped() ?? new RoadError('service', `unreadable answer (${res.status})`, res.status)
    }
    return { ok: res.ok, status: res.status, json }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

/**
 * The fastest street route from one place to another, thinned, from the snapped start to the snapped end,
 * with how long it takes. One request, never faster than the service allows. Always a RoadError when it
 * fails: offline (no connection, or the request never got through), timeout, service (an error
 * or an answer that makes no sense), no-road (nothing to follow there) or cancelled.
 */
export async function fetchDrive(from: Pt, to: Pt, opts: LookupOptions = {}): Promise<Drive> {
  const { ok, status, json } = await getJson(roadUrl(from, to, opts.radiusM), opts)
  if (!ok) throw new RoadError(isNoRoad((json as RawRoute | null)?.code) ? 'no-road' : 'service', `status ${status}`, status)
  return { points: roadPoints(json), seconds: roadSeconds(json) }
}

/** The street route from one place to another: `fetchDrive` without the time. */
export async function fetchRoad(from: Pt, to: Pt, opts: LookupOptions = {}): Promise<Pt[]> {
  return (await fetchDrive(from, to, opts)).points
}

/** Whether a tap can be followed along roads: there has to be a point to start from, and the tap has to be somewhere new. */
export const canFollow = (route: Route, tap: Pt) => route.points.length > 0 && !isDuplicateTap(route, tap)

/** What one tap added to the route. */
export interface Stretch {
  /** The points added to the end of the route. */
  added: Pt[]
  /** The route's only point, when the start of the road took its place. */
  replaced: Pt | null
}

export interface Extension extends Stretch {
  route: Route
  /** Why the stretch had to be a straight line, or null when roads were followed. */
  notice: string | null
}

function straight(route: Route, tap: Pt, side: Side, notice: string | null): Extension {
  const next = appendPoint(route, tap, side)
  return { route: next, notice, added: next.points.slice(route.points.length), replaced: null }
}

/**
 * The route with a stretch added from its end to `tap`, thrown on `side`. It follows streets when
 * they can be found and is a straight line otherwise, with a notice saying why. The first point of a
 * route and a tap on the last point need no lookup. Rejects with a 'cancelled' RoadError, and only that, when cancelled.
 */
export async function extendAlongRoads(route: Route, tap: Pt, side: Side, opts: LookupOptions = {}): Promise<Extension> {
  const from = route.points[route.points.length - 1]
  if (!from || isDuplicateTap(route, tap)) return straight(route, tap, side, null)
  let road: Pt[]
  try {
    road = await fetchRoad(from, tap, opts)
  } catch (e) {
    const kind = e instanceof RoadError ? e.kind : 'service'
    if (kind === 'cancelled') throw e
    return straight(route, tap, side, ROAD_NOTICE[kind])
  }
  // A route that is just one loose point starts on the street instead, rather than with a short link to it.
  const lone = route.points.length === 1
  const base: Route = lone ? { ...route, points: [] } : route
  const next = appendPoints(base, road, side)
  return { route: next, notice: null, added: next.points.slice(base.points.length), replaced: lone ? from : null }
}

/** Whether the route ends with exactly these points. */
const endsWith = (points: Pt[], tail: Pt[]) =>
  tail.length > 0 &&
  tail.length <= points.length &&
  tail.every((q, i) => {
    const p = points[points.length - tail.length + i]
    return p.lat === q.lat && p.lng === q.lng
  })

/**
 * Take back the last tap, which may have added a whole stretch of road: the newest recorded stretch that
 * still ends the route comes off again (and the start it replaced goes back). Stretches recorded after it
 * are forgotten, as they no longer fit. Null when none ends the route, for example after points were edited.
 */
export function undoStretch(route: Route, history: Stretch[]): { route: Route; history: Stretch[] } | null {
  const at = history.findLastIndex((h) => endsWith(route.points, h.added))
  if (at < 0) return null
  const { added, replaced } = history[at]
  let next = route
  for (let i = 0; i < added.length; i++) next = removeLastPoint(next)
  if (replaced) next = appendPoint(next, replaced)
  return { route: next, history: history.slice(0, at) }
}
