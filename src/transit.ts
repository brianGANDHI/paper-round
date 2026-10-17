import { formatDuration } from './format'
import { haversine } from './geo'
import { searchPlaces, shortPlaceName, type Place } from './geocode'
import { fetchDrive, RoadError, type Drive } from './roads'
import { appendPoints, formatDistance, routeLength } from './routeEdit'
import type { Pt, Route } from './types'

/**
 * Route by address: the fastest road between two typed addresses, added to the end of the route as Transit.
 *
 * The addresses are looked up by Nominatim, the same OpenStreetMap service the place search uses, and the
 * drive between them is worked out by the OSRM server that Follow roads uses (see roads.ts), so both
 * services' limits apply: one request a second, one lookup at a time. Unlike Follow roads there is no
 * straight-line fallback: a failure adds nothing to the route and says why.
 */

/** An address can sit well back from its street, so the road is looked for this far from it. */
export const ADDRESS_SNAP_M = 250
/** A typed start this close to the end of the route is the same spot: the stretch just carries on from there. */
export const JOIN_M = 100
/** Two places this close are the same place, and there is nothing to drive. */
export const SAME_PLACE_M = 30
/** How long to wait for an address to be found. */
export const FIND_TIMEOUT_MS = 8000

export type Which = 'from' | 'to'

export type TransitFailure =
  | 'blank'
  | 'not-found'
  | 'same-place'
  | 'offline'
  | 'timeout'
  | 'service'
  | 'no-road'
  | 'cancelled'

export class TransitError extends Error {
  kind: TransitFailure
  /** The address a failure is about, when it is about one, and what was typed for it. */
  which: Which | null
  query: string
  constructor(kind: TransitFailure, which: Which | null = null, query = '') {
    super(which ? `${kind}: ${which}` : kind)
    this.name = 'TransitError'
    this.kind = kind
    this.which = which
    this.query = query
  }
}

const clip = (text: string, max = 50) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** What to tell the person when a route couldn't be made. A cancelled lookup says nothing. */
export function transitMessage(e: TransitError): string {
  switch (e.kind) {
    case 'blank':
      return e.which === 'from' ? 'Type where the transit starts, or start it from the end of your route.' : 'Type where the transit ends.'
    case 'not-found':
      return `Couldn't find "${clip(e.query)}". Try adding the suburb or postcode.`
    case 'same-place':
      return 'The start and the end are the same place, so there is nothing to drive.'
    case 'offline':
      return 'Routing by address needs an internet connection.'
    case 'timeout':
      return 'That took too long. Check your connection and try again.'
    case 'service':
      return "The address or road service isn't working right now. Try again in a moment."
    case 'no-road':
      return 'No road route found between those places. Check that both are on or near a street you can drive.'
    case 'cancelled':
      return ''
  }
}

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false

/** Runs a lookup that stops when `signal` aborts or `ms` pass, and turns every way it can fail into a TransitError. */
async function guarded<T>(signal: AbortSignal | undefined, ms: number, task: (stop: AbortSignal) => Promise<T>): Promise<T> {
  if (signal?.aborted) throw new TransitError('cancelled')
  if (offline()) throw new TransitError('offline')
  const stop = new AbortController()
  let slow = false
  const timer = setTimeout(() => {
    slow = true
    stop.abort()
  }, ms)
  const cancel = () => stop.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    return await task(stop.signal)
  } catch (e) {
    if (stop.signal.aborted) throw new TransitError(slow ? 'timeout' : 'cancelled')
    if (e instanceof TransitError) throw e
    // A request that never gets through is a TypeError; anything else is the service answering badly.
    throw new TransitError(e instanceof TypeError ? 'offline' : 'service')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

/** The best match for what was typed, looked for near `near`. */
async function findPlace(query: string, which: Which, near: Pt[], signal?: AbortSignal): Promise<Place> {
  const [hit] = await guarded(signal, FIND_TIMEOUT_MS, (stop) => searchPlaces(query, { near, limit: 1, signal: stop }))
  if (!hit) throw new TransitError('not-found', which, query)
  return hit
}

async function drive(from: Pt, to: Pt, signal?: AbortSignal): Promise<Drive> {
  try {
    return await fetchDrive(from, to, { signal, radiusM: ADDRESS_SNAP_M })
  } catch (e) {
    throw new TransitError(e instanceof RoadError ? e.kind : 'service')
  }
}

export interface TransitRequest {
  /** What was typed for the start, or null to carry on from the end of the route. */
  from: string | null
  /** What was typed for the end. */
  to: string
}

/** What a route by address is working on, for a progress line. */
export type Stage = 'start' | 'end' | 'link' | 'road'

export interface TransitOptions {
  signal?: AbortSignal
  onStage?: (stage: Stage) => void
}

export interface TransitResult {
  route: Route
  /** The points added to the end of the route. */
  added: Pt[]
  /** The place the start was matched to: null when the stretch carries on from the end of the route. */
  from: Place | null
  to: Place
  /** Length of the stretch added, in metres, and how long it takes to drive. */
  meters: number
  seconds: number | null
  /** Whether the way from the end of the route to the typed start had to be driven first. */
  linked: boolean
}

/**
 * The route with the fastest road from one typed address to another added to its end, as Transit. The
 * start can be the end of the route instead. A typed start that is well away from where the route ends is
 * reached by road first, so the route stays one connected drive. Rejects with a TransitError, and adds nothing, when it can't.
 */
export async function routeByAddress(route: Route, request: TransitRequest, opts: TransitOptions = {}): Promise<TransitResult> {
  const { signal, onStage } = opts
  const fromText = request.from === null ? null : request.from.trim()
  const toText = request.to.trim()
  const end = route.points[route.points.length - 1] ?? null
  if (fromText === '' || (fromText === null && !end)) throw new TransitError('blank', 'from')
  if (!toText) throw new TransitError('blank', 'to')

  let from: Place | null = null
  if (fromText !== null) {
    onStage?.('start')
    from = await findPlace(fromText, 'from', route.points, signal)
  }
  onStage?.('end')
  // The end is looked for near the route, or near the start when there is no route yet.
  const to = await findPlace(toText, 'to', route.points.length ? route.points : from ? [from] : [], signal)

  const start: Pt | null = from ?? end
  if (!start) throw new TransitError('blank', 'from')
  if (haversine(start, to) < SAME_PLACE_M) throw new TransitError('same-place')

  const drives: Drive[] = []
  let linked = false
  if (end && from && haversine(end, from) > JOIN_M) {
    onStage?.('link')
    drives.push(await drive(end, from, signal))
    linked = true
  }
  onStage?.('road')
  const main = await drive(start, to, signal)
  // Both places can sit by the same stretch of road, with nothing between them to drive.
  if (routeLength(main.points) < SAME_PLACE_M) throw new TransitError('same-place')
  drives.push(main)

  const points = drives.flatMap((d) => d.points)
  const seconds = drives.every((d) => d.seconds !== null) ? drives.reduce((sum, d) => sum + (d.seconds ?? 0), 0) : null
  const next = appendPoints(route, points, 'transit')
  return { route: next, added: next.points.slice(route.points.length), from, to, meters: routeLength(points), seconds, linked }
}

/** Says what was added, so a wrong match is easy to spot, and that Undo takes it back. */
export function transitNotice(r: TransitResult): string {
  const from = r.from ? shortPlaceName(r.from.name) : 'the end of your route'
  const time = r.seconds === null ? '' : `, ${formatDuration(r.seconds)}`
  let text = `Added transit from ${from} to ${shortPlaceName(r.to.name)}: ${formatDistance(r.meters)}${time}.`
  if (r.linked) text += ' It first drives from the end of your route to the start.'
  const rough = [r.from && !r.from.exact ? 'the start' : null, !r.to.exact ? 'the end' : null].filter((s) => s !== null)
  if (rough.length) {
    text += ` Only the street or area was found for ${rough.join(' and ')}, so ${rough.length > 1 ? 'their positions are' : 'its position is'} approximate.`
  }
  return `${text} Undo takes it back.`
}
