import { snapToPath } from './geo'
import type { Pt, Route } from './types'

const ENDPOINT = 'https://nominatim.openstreetmap.org/search'

/** Nominatim allows one request a second; tests set this to 0. */
export const rate = { minGapMs: 1100 }
let lastCall = 0

async function spaced(signal?: AbortSignal) {
  signal?.throwIfAborted()
  const wait = lastCall + rate.minGapMs - Date.now()
  if (wait > 0) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, wait)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(signal.reason)
        },
        { once: true },
      )
    })
  }
  lastCall = Date.now()
}

export interface Place extends Pt {
  name: string
  /** True for a house or building, false when only the street was found. */
  exact: boolean
}

interface RawPlace {
  lat?: string
  lon?: string
  display_name?: string
  place_rank?: number
  addresstype?: string
}

/** Search box covering the route plus a margin, as Nominatim's `left,top,right,bottom`. */
export function viewboxFor(points: Pt[], marginM = 3000): string | null {
  if (!points.length) return null
  const lats = points.map((p) => p.lat)
  const lngs = points.map((p) => p.lng)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const dLat = marginM / 111320
  const dLng = marginM / (111320 * Math.max(0.2, Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180))))
  return [minLng - dLng, maxLat + dLat, maxLng + dLng, minLat - dLat].map((n) => n.toFixed(6)).join(',')
}

export function parsePlaces(json: unknown): Place[] {
  if (!Array.isArray(json)) return []
  return (json as RawPlace[]).flatMap((r) => {
    const lat = Number(r?.lat)
    const lng = Number(r?.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return []
    const exact = (r.place_rank ?? 0) >= 29 || r.addresstype === 'house' || r.addresstype === 'building'
    return [{ lat, lng, name: r.display_name ?? '', exact }]
  })
}

interface SearchOpts {
  /** Prefer results near these points. */
  near?: Pt[]
  /** Only return results inside the area around `near`. */
  bounded?: boolean
  limit?: number
  signal?: AbortSignal
}

export async function searchPlaces(query: string, opts: SearchOpts = {}): Promise<Place[]> {
  const params = new URLSearchParams({ format: 'jsonv2', q: query, limit: String(opts.limit ?? 3) })
  const box = opts.near ? viewboxFor(opts.near) : null
  if (box) {
    params.set('viewbox', box)
    if (opts.bounded) params.set('bounded', '1')
  }
  await spaced(opts.signal)
  const res = await fetch(`${ENDPOINT}?${params}`, { signal: opts.signal, headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`Lookup failed (${res.status})`)
  return parsePlaces(await res.json())
}

export interface Match {
  place: Place
  /** How far the place is from the route, in metres. */
  offM: number
  exact: boolean
}

/** Find an address near the route; the result closest to the route wins. */
export async function lookupAddress(line: string, route: Route, signal?: AbortSignal): Promise<Match | null> {
  let places = await searchPlaces(line, { near: route.points, bounded: true, limit: 1, signal })
  if (!places.length) places = await searchPlaces(line, { near: route.points, limit: 3, signal })
  let best: Match | null = null
  for (const place of places) {
    const snap = snapToPath(place, route.points)
    if (snap && (!best || snap.dist < best.offM)) best = { place, offM: snap.dist, exact: place.exact }
  }
  return best
}
