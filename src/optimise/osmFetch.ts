import type { Pt } from '../types'
import type { OnProgress, OsmData, OsmElement, OsmMember } from './types'

/**
 * The map for a route, from a public Overpass server: the roads around it, their nodes, and the turn rules on them. Overpass is often overloaded, and
 * none of its servers promises to answer, so the same question goes to each mirror in turn, for a few rounds with a wait between them. An
 * answer is checked before it is believed: a server out of time can say so inside a 200, or stop part way through. The request itself says only a box
 * on the map, with no email address or anything else about the driver, but like any web request it also shows the phone's IP address and the app's web
 * address. Every server asked sees those: overpass-api.de and its lz4 and z hosts, maps.mail.ru and overpass.openstreetmap.fr.
 */

/**
 * The servers, in the order they are asked. The two hosts of the main service come first, but a mirror apart from it comes third, not last. When those
 * hosts hang, each costs a full `ANSWER_TIMEOUT_MS`, and the total has room for only three or so of those: an independent server has to be in reach by then.
 */
const MIRRORS = ['https://lz4.overpass-api.de', 'https://z.overpass-api.de', 'https://maps.mail.ru/osm/tools/overpass', 'https://overpass-api.de', 'https://overpass.openstreetmap.fr']
const INTERPRETER_PATH = '/api/interpreter'

/** Where to ask, in order: every mirror, or just the one server set by VITE_OVERPASS_URL when building. */
export const overpassUrls = (override: unknown): string[] => {
  const own = String(override || '').replace(/\/+$/, '')
  return own ? [own] : MIRRORS.map((mirror) => `${mirror}${INTERPRETER_PATH}`)
}

export const OVERPASS_URLS: string[] = overpassUrls(import.meta.env.VITE_OVERPASS_URL)

/** The roads a route could use. Everything a car can drive on, tracks and service roads included: which of them are open to it is the engine's to judge. */
const ROAD_CLASSES = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|track'

/** How far beyond the route the map reaches, in metres: a new route can leave the old one's roads, but not by far. */
export const MAP_MARGIN_M = 1000
/** How long the server is told it has, in seconds. Asking for less than its default makes it likelier to take the query when it is busy. */
const SERVER_TIMEOUT_S = 30
/** How long to wait for one answer, in milliseconds. Good answers have been seen to take 20 to 34 seconds, so this leaves room for the server's time, its queue and the answer getting here. */
export const ANSWER_TIMEOUT_MS = 50_000
/** The longest the whole search for the map may take, in milliseconds. Past that, the driver is better off told. */
export const TOTAL_TIMEOUT_MS = 180_000
/** The wait before each round after the first, in milliseconds. */
export const ROUND_WAITS_MS = [3000, 8000]

const M_PER_DEG = (6371000 * Math.PI) / 180

/** What went wrong getting the map, for the screen to put plainly. */
export type OsmFailure = 'offline' | 'busy' | 'nothing' | 'cancelled'

export class OsmError extends Error {
  kind: OsmFailure
  constructor(kind: OsmFailure, detail?: string) {
    super(detail ? `${kind}: ${detail}` : kind)
    this.name = 'OsmError'
    this.kind = kind
  }
}

/** What to tell the driver. A cancelled fetch says nothing. */
export const OSM_NOTICE: Record<Exclude<OsmFailure, 'cancelled'>, string> = {
  offline: "Couldn't reach the map service. Check you are online, then try again.",
  busy: 'The map service is busy right now. Try again in a minute or two.',
  nothing: "The map has no roads around this route, so there's nothing to work from.",
}

/** A box on the map, in degrees. */
export interface MapBox {
  south: number
  west: number
  north: number
  east: number
}

/** The box around a route with `marginM` metres to spare on every side. Null for a route with no points. */
export function routeBox(points: readonly Pt[], marginM = MAP_MARGIN_M): MapBox | null {
  if (!points.length) return null
  const lats = points.map((p) => p.lat)
  const lngs = points.map((p) => p.lng)
  const north = Math.max(...lats) + marginM / M_PER_DEG
  const south = Math.min(...lats) - marginM / M_PER_DEG
  // A degree of longitude is shortest at the edge furthest from the equator, so that edge sets the margin.
  const nearestPole = Math.min(89, Math.max(Math.abs(north), Math.abs(south)))
  const across = marginM / (M_PER_DEG * Math.cos((nearestPole * Math.PI) / 180))
  return { south, west: Math.min(...lngs) - across, north, east: Math.max(...lngs) + across }
}

/** The one query: the ways in the box, all of their nodes (a barrier on one closes the road), and the turn rules on them. */
export function overpassQuery(box: MapBox): string {
  const bbox = [box.south, box.west, box.north, box.east].map((n) => n.toFixed(5)).join(',')
  return `[out:json][timeout:${SERVER_TIMEOUT_S}];way["highway"~"^(${ROAD_CLASSES})$"](${bbox})->.w;(.w;node(w.w);rel(bw.w)["type"="restriction"];);out body;`
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A map's tags, as the engine reads them: text only. */
function cleanTags(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined
  const tags = Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string')
  return tags.length ? Object.fromEntries(tags) : undefined
}

const withTags = (tags: Record<string, string> | undefined) => (tags ? { tags } : {})

function cleanMember(raw: unknown): OsmMember | null {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !isId(raw.ref) || typeof raw.role !== 'string') return null
  return { type: raw.type, ref: raw.ref, role: raw.role }
}

/** An element of an answer as the engine types it, with nothing else on it. Null for one that isn't whole. Something else the server chose to send is left out. */
function cleanElement(raw: unknown): OsmElement | 'other' | null {
  if (!isRecord(raw) || !isId(raw.id)) return null
  const tags = withTags(cleanTags(raw.tags))
  if (raw.type === 'node') {
    const { lat, lon } = raw
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
    return { type: 'node', id: raw.id, lat, lon, ...tags }
  }
  if (raw.type === 'way') {
    if (!Array.isArray(raw.nodes) || !raw.nodes.every(isId)) return null
    return { type: 'way', id: raw.id, nodes: raw.nodes, ...tags }
  }
  if (raw.type === 'relation') {
    const members = Array.isArray(raw.members) ? raw.members.map(cleanMember) : [null]
    return members.every((m): m is OsmMember => m !== null) ? { type: 'relation', id: raw.id, members, ...tags } : null
  }
  return 'other'
}

/** Why an answer can't be used: damaged, or the server running out of time part way through. Another mirror may do better. */
class BadAnswer extends Error {}

/** When the data in an answer dates from, read from what Overpass says about itself. Nothing for one that doesn't say: an answer is no worse for that. */
const dateOf = (about: unknown): string | undefined => (isRecord(about) && typeof about.timestamp_osm_base === 'string' ? about.timestamp_osm_base : undefined)

/**
 * The map in an answer, with the date of its data if the server gives one. A BadAnswer for one that can't be believed: not JSON, which is what a body
 * cut off on its way here is; not the shape Overpass answers in; the remark it adds when it ran out of time or memory and sent what it had; or a way with
 * a node missing, which is a damaged answer. That last can't catch a server stopping part way, as nodes come before ways and relations, so what it did
 * send is whole: the remark is the only sign of that. An answer with no roads is a good answer that says so.
 */
export function readAnswer(text: string): OsmData {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new BadAnswer('not JSON')
  }
  if (!isRecord(body) || !Array.isArray(body.elements)) throw new BadAnswer('no elements')
  if (typeof body.remark === 'string' && /error/i.test(body.remark)) throw new BadAnswer(body.remark)
  const elements: OsmElement[] = []
  const nodes = new Set<number>()
  for (const raw of body.elements) {
    const element = cleanElement(raw)
    if (element === null) throw new BadAnswer('a damaged element')
    if (element === 'other') continue
    if (element.type === 'node') nodes.add(element.id)
    elements.push(element)
  }
  for (const e of elements) if (e.type === 'way' && !e.nodes.every((id) => nodes.has(id))) throw new BadAnswer('a way with a node missing')
  const date = dateOf(body.osm3s)
  return date ? { elements, date } : { elements }
}

/** Waits, giving up the moment `signal` says so. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OsmError('cancelled'))
      return
    }
    const cancel = () => {
      clearTimeout(timer)
      reject(new OsmError('cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }, ms)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

export interface MapOptions {
  /** Cancels it, wherever it has got to. */
  signal?: AbortSignal
  onProgress?: OnProgress
  /** Where to ask. `OVERPASS_URLS` when not given. */
  urls?: readonly string[]
  /** How long one answer may take, in milliseconds. `ANSWER_TIMEOUT_MS` when not given. */
  timeoutMs?: number
  /** Stand-ins for the tests. */
  fetchFn?: typeof fetch
  pause?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** How one mirror answered: a map; none, because no answer came at all; none, because it couldn't give one; or none, because it has no roads there. */
type Asked = OsmData | 'unreached' | 'failed' | 'empty'

/** Asks one mirror, for no longer than `timeoutMs`. Cancelling throws. Anything else that goes wrong is how it answered, for the next mirror to do better. */
async function askMirror(url: string, query: string, options: MapOptions, timeoutMs: number): Promise<Asked> {
  const { signal, fetchFn = fetch } = options
  const stop = new AbortController()
  const cancel = () => stop.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, timeoutMs)
  let reachedIt = false
  try {
    const response = await fetchFn(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: stop.signal })
    reachedIt = true
    // A 429 is this server saying it has had enough of this phone, a 502 that it is at capacity, and a 504 that it had no room for the query. Whatever the body says, another may have room.
    if (!response.ok) return 'failed'
    const map = readAnswer(await response.text())
    return map.elements.some((e) => e.type === 'way') ? map : 'empty'
  } catch (e) {
    if (signal?.aborted) throw new OsmError('cancelled')
    // Fetch fails like this only when nothing came back at all, which is a phone with no connection. Timed out, the phone got no answer, but it may have a connection.
    return e instanceof TypeError && !reachedIt && !stop.signal.aborted ? 'unreached' : 'failed'
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false

/**
 * Gets the map for a route. Each round asks every mirror in turn, until one gives a good answer. Throws an OsmError when none does: `offline` when
 * the phone says so, or when not one mirror of a round could be reached (there's no use waiting and asking again); `nothing` only when every mirror of
 * one round says it has no roads there, as a mirror that hasn't the whole world can say that too, and `nothing` offers no Try Again; `busy` for
 * everything else, after the last round or `TOTAL_TIMEOUT_MS`; and `cancelled` as soon as `signal` says so.
 */
export async function fetchMap(points: readonly Pt[], options: MapOptions = {}): Promise<OsmData> {
  const { signal, onProgress, urls = OVERPASS_URLS, timeoutMs = ANSWER_TIMEOUT_MS, pause = wait } = options
  if (signal?.aborted) throw new OsmError('cancelled')
  const box = routeBox(points)
  if (!box) throw new OsmError('nothing', 'a route with no points')
  if (isOffline()) throw new OsmError('offline')
  const query = overpassQuery(box)
  const giveUpAt = Date.now() + TOTAL_TIMEOUT_MS
  const rounds = ROUND_WAITS_MS.length + 1
  const asks = rounds * urls.length
  for (let round = 0; round < rounds; round++) {
    if (round > 0) {
      onProgress?.({ step: 'The map service is busy, so waiting to try again', done: (round * urls.length) / asks })
      await pause(ROUND_WAITS_MS[round - 1], signal)
    }
    const answers: Asked[] = []
    for (const [i, url] of urls.entries()) {
      if (Date.now() >= giveUpAt) throw new OsmError('busy', 'out of time')
      onProgress?.({ step: round === 0 && i === 0 ? 'Getting the map' : 'The map service is busy, so trying another', done: (round * urls.length + i) / asks })
      const answer = await askMirror(url, query, options, Math.min(timeoutMs, giveUpAt - Date.now()))
      if (typeof answer === 'object') return answer
      answers.push(answer)
    }
    if (answers.every((a) => a === 'unreached')) throw new OsmError('offline')
    if (answers.every((a) => a === 'empty')) throw new OsmError('nothing')
  }
  throw new OsmError('busy')
}
