import { alertText } from './alerts'
import { plural } from './format'
import { bearing } from './geo'
import type { Occurrence } from './geo'
import { houseNumber, nearestOnRoute } from './routeEdit'
import type { Pt, Stop, StopType } from './types'

/*
 * The driver's own photos of places on the round: which one shows with an alert, how big a photo is kept, how its location is taken out, the file
 * they are backed up to, and which are kept for stops no longer on any route. None of it touches the page or the phone's database (that is
 * photoStore.ts and shrinkPhoto.ts), so it can be tested. The photos are the driver's own: Google doesn't allow Street View pictures to be saved,
 * so for those there is only a link that opens Street View itself.
 */

/** A photo is kept no longer than this on its longer side, in pixels: plenty for the round, and about a tenth of a megabyte. */
export const PHOTO_SIDE_PX = 800
/** How good a photo is kept, best first: the next is tried when a photo comes out bigger than `PHOTO_BYTES`. */
export const PHOTO_QUALITIES = [0.8, 0.65, 0.5] as const
/** A photo bigger than this, in bytes, is tried at the next quality. */
export const PHOTO_BYTES = 200_000
/** The most a photo may be, in bytes and pixels a side: anything more in a photos file was not made here. */
export const MAX_PHOTO_BYTES = 1_500_000
export const MAX_PHOTO_SIDE = 2000
/** A photos file may hold no more photos than this, and be no bigger, in bytes. */
export const MAX_PHOTOS = 2000
export const MAX_PHOTOS_FILE = 100_000_000
/** The photo of a stop on no route any more is kept this long, in days, in case its route is restored from a backup. */
export const UNUSED_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/** How big a photo is drawn to be kept: no longer than `PHOTO_SIDE_PX` on its longer side, the same shape, and never made bigger. Null when it has no size. */
export function shrunkSize(width: number, height: number): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return null
  const scale = Math.min(1, PHOTO_SIDE_PX / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

const ascii = (bytes: Uint8Array, at: number, text: string) => [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0))

/** A JPEG's parts that carry no picture and can carry where it was taken: only the two a picture needs to be drawn right are kept. */
function keepPart(marker: number, bytes: Uint8Array, at: number): boolean {
  // The comment, and everything a camera writes (its location among it).
  if (marker === 0xfe) return false
  if (marker < 0xe0 || marker > 0xef) return true
  if (marker === 0xe0) return ascii(bytes, at, 'JFIF\0')
  if (marker === 0xe2) return ascii(bytes, at, 'ICC_PROFILE\0')
  return marker === 0xee && ascii(bytes, at, 'Adobe')
}

/** The frame of a JPEG: where its size is. DHT (c4), JPG (c8) and DAC (cc) are among the numbers and are not one. */
const isFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

/**
 * A JPEG with everything but the picture taken out: the place, time and camera a phone writes into it, any comment, and anything after its end. Null
 * when it isn't a whole JPEG, or is bigger than a photo kept here can be. A photo is drawn afresh before it is kept, which leaves its location behind
 * already; this makes sure of it, and of every photo in a photos file.
 */
export function cleanJpeg(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (bytes.length > MAX_PHOTO_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  const parts: Uint8Array[] = [bytes.subarray(0, 2)]
  let at = 2
  let framed = false
  let scanned = false
  for (;;) {
    if (bytes[at] !== 0xff) return null
    // Any number of filler bytes may come before a marker.
    while (bytes[at + 1] === 0xff) at++
    const marker = bytes[at + 1]
    if (marker === undefined) return null
    if (marker === 0xd9) {
      if (!framed || !scanned) return null
      parts.push(bytes.subarray(at, at + 2))
      break
    }
    // Only a marker with a length can come here: the others belong in the picture's data.
    if (marker < 0xc0 || (marker >= 0xd0 && marker <= 0xd8)) return null
    const length = ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)
    let end = at + 2 + length
    if (length < 2 || end > bytes.length) return null
    if (isFrame(marker)) {
      const height = ((bytes[at + 5] ?? 0) << 8) | (bytes[at + 6] ?? 0)
      const width = ((bytes[at + 7] ?? 0) << 8) | (bytes[at + 8] ?? 0)
      if (length < 8 || !width || !height || width > MAX_PHOTO_SIDE || height > MAX_PHOTO_SIDE) return null
      framed = true
    }
    if (marker === 0xda) {
      // The picture itself runs on from here to the next marker that isn't part of it.
      while (end < bytes.length && !(bytes[end] === 0xff && bytes[end + 1] !== 0 && bytes[end + 1] !== 0xff && !(bytes[end + 1] >= 0xd0 && bytes[end + 1] <= 0xd7))) end++
      scanned = true
    }
    if (keepPart(marker, bytes, at + 4)) parts.push(bytes.subarray(at, end))
    at = end
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let to = 0
  for (const p of parts) {
    out.set(p, to)
    to += p.length
  }
  return out
}

/** What became of a photo that was to be kept: kept, or not, for want of room, because the phone keeps nothing for the app, or for some other reason. */
export type PhotoTrouble = 'full' | 'blocked' | 'failed'
export type SaveResult = 'saved' | PhotoTrouble

/** Why a photo wasn't kept, in plain words. */
export const PHOTO_TROUBLE: Record<PhotoTrouble, string> = {
  full: 'This phone has no room left for the photo, so it was not kept.',
  blocked: "This phone isn't letting the app keep photos, so it was not kept. Try a normal (not private) tab.",
  failed: 'The photo could not be saved, so it was not kept. Try again.',
}

/** What is kept of a photo beside its bytes: whose it is, how big it is, when it was added, and since when its stop has been on no route. */
export interface PhotoInfo {
  stopId: string
  bytes: number
  savedAt: number
  unusedSince?: number
}

/** The id of every stop on these routes. A route copied, or kept by Optimise Route, has the same stops with the same ids, so it has their photos too. */
export const stopIdsOf = (routes: readonly { route: { stops: readonly Pick<Stop, 'id'>[] } }[]): Set<string> => new Set(routes.flatMap((r) => r.route.stops.map((s) => s.id)))

/**
 * What to do with the photos kept, as the app opens: those whose stop is on no route any more are marked with since when (`mark`), those whose stop is
 * back are unmarked (`clear`), and those marked `UNUSED_DAYS` ago or more are removed. A photo is never removed the first time its stop is missed, so
 * a route deleted by mistake, or routes that could not be read, take no photos with them if they are put back in that time.
 */
export function photoSweep(infos: readonly PhotoInfo[], used: ReadonlySet<string>, now: number): { mark: string[]; clear: string[]; remove: string[] } {
  const mark: string[] = []
  const clear: string[] = []
  const remove: string[] = []
  for (const { stopId, unusedSince } of infos) {
    if (used.has(stopId)) {
      if (unusedSince !== undefined) clear.push(stopId)
    } else if (unusedSince === undefined || !(unusedSince <= now)) {
      // Not marked yet, or marked by a clock since put back.
      mark.push(stopId)
    } else if (now - unusedSince >= UNUSED_DAYS * DAY_MS) {
      remove.push(stopId)
    }
  }
  return { mark, clear, remove }
}

/** Whether a stop of this kind shows its photo with its alert: always, but for a no-throw house, which has a switch. */
export const showsPhoto = (type: StopType, noThrow: boolean): boolean => type !== 'nothrow' || noThrow

/** What a photo is marked with on the round, so it can't be taken for another house's: its number, or what the place is called. */
export function photoTag(stop: Stop): string {
  const number = houseNumber(stop)
  const name = stop.label ?? stop.address
  return (stop.type === 'bundle' || stop.type === 'block' ? (stop.label ?? number ?? name) : (number ?? name)) ?? alertText(stop).title
}

/**
 * The stop whose photo shows with the alert that is up: the stop the alert is for (the next house, in a row of them) if it has a photo to show, or else
 * the bundle drop or the apartment block shown in its banner. One photo only, so the map keeps its room, and one put away is not followed by another.
 * Never a later house of the row: the photo has to be of the house to look for now.
 */
export function photoFor(
  shown: { current: Occurrence | undefined; bundleUp: Occurrence | null; blockAhead: Occurrence | null },
  has: ReadonlySet<string>,
  noThrow: boolean,
  putAway: ReadonlySet<string>,
): Occurrence | null {
  const first = [shown.current, shown.bundleUp, shown.blockAhead].find((o) => o && has.has(o.stop.id) && showsPhoto(o.stop.type, noThrow))
  return first && !putAway.has(first.key) ? first : null
}

/** The photos put away that still have their alert up. The same set when none has gone. */
export function stillPutAway(putAway: ReadonlySet<string>, queue: readonly Pick<Occurrence, 'key'>[]): ReadonlySet<string> {
  if (!putAway.size) return putAway
  const up = new Set(queue.map((o) => o.key))
  const kept = [...putAway].filter((key) => up.has(key))
  return kept.length === putAway.size ? putAway : new Set(kept)
}

/** A stop nearer the road than this, in metres, or further from it, is not looked at from the road: which way it lies can't be said. */
const LOOK_MIN_M = 3
const LOOK_MAX_M = 60

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * The link that opens Street View at a stop, in Google Maps: the picture nearest it, looking from the road to it where the route says which way that is.
 * Nothing is sent to Google until the link is tapped, and then only where the stop is and which way to look.
 */
export function streetViewUrl(stop: Pt, points: Pt[]): string {
  const snap = points.length > 1 ? nearestOnRoute({ points }, stop) : null
  const look = snap && snap.dist >= LOOK_MIN_M && snap.dist <= LOOK_MAX_M ? Math.round(bearing(snap.point, stop)) % 360 : null
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${round6(stop.lat)}%2C${round6(stop.lng)}${look === null ? '' : `&heading=${look}`}`
}

/** A size in bytes as it is read: "84 KB", "1.9 MB". */
export const formatBytes = (n: number): string => (n < 999_500 ? `${Math.max(1, Math.round(n / 1000))} KB` : `${(n / 1_000_000).toFixed(1)} MB`)

// ---- The photos file ----

const APP = 'paper-round'
const KIND = 'photos'
const VERSION = 1
/** What `btoa` is given at a time: a call can't take any number of arguments. */
const CHUNK = 0x8000

export interface PhotoEntry {
  stopId: string
  jpeg: Uint8Array<ArrayBuffer>
}

const toBase64 = (bytes: Uint8Array): string => {
  let text = ''
  for (let i = 0; i < bytes.length; i += CHUNK) text += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(text)
}

function fromBase64(text: string): Uint8Array | null {
  try {
    const raw = atob(text)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/**
 * The photos file, in pieces: its start, one photo at a time, and its end, so a file of every photo is never one long string. It has the photos and
 * which stop each is of (by id, as a route's backup has it), and nothing else of the route.
 */
export const photosFileStart = (now: Date): string => `${JSON.stringify({ app: APP, kind: KIND, version: VERSION, exportedAt: now.toISOString() }).slice(0, -1)},"photos":[\n`
export const photosFileEntry = (entry: { stopId: string; jpeg: Uint8Array }, first: boolean): string => `${first ? '' : ',\n'}${JSON.stringify({ stopId: entry.stopId, jpeg: toBase64(entry.jpeg) })}`
export const PHOTOS_FILE_END = '\n]}\n'

/** What the photos file is called. */
export function photosFileName(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `Paper Round photos - ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}.txt`
}

const ROUTES_NOT_PHOTOS = "That's a backup of your routes. Use Restore from Backup for it."

export type PhotosResult = { ok: true; photos: PhotoEntry[]; damaged: number } | { ok: false; error: string }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Whether this is the text of a photos file, which the routes' Restore says plainly. */
export const isPhotosFile = (text: string): boolean => /^\s*\{"app":"paper-round","kind":"photos"/.test(text.slice(0, 200))

/**
 * The photos in a photos file. One that is damaged, too big or no JPEG is left out and counted, and the rest are kept. Each has its location taken out
 * again (`cleanJpeg`), whoever made the file. With two for a stop, the last counts.
 */
export function parsePhotosFile(text: string): PhotosResult {
  // A backup of routes begins with its own name, so is no JSON as it stands.
  if (/^\s*Paper Round backup/.test(text.slice(0, 200))) return { ok: false, error: ROUTES_NOT_PHOTOS }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  if (!isObject(data) || data.app !== APP) return { ok: false, error: "That isn't a Paper Round photos file." }
  if (data.kind !== KIND || !Array.isArray(data.photos)) return { ok: false, error: Array.isArray(data.routes) ? ROUTES_NOT_PHOTOS : "That isn't a Paper Round photos file." }
  if (typeof data.version === 'number' && data.version > VERSION) return { ok: false, error: 'This photos file was made by a newer version of the app. Update the app, then try again.' }
  if (!data.photos.length) return { ok: false, error: 'That file has no photos in it.' }
  if (data.photos.length > MAX_PHOTOS) return { ok: false, error: 'That file has too many photos.' }
  const photos = new Map<string, PhotoEntry>()
  let damaged = 0
  for (const item of data.photos) {
    const stopId = isObject(item) && typeof item.stopId === 'string' && item.stopId.length <= 100 ? item.stopId : ''
    const raw = isObject(item) && typeof item.jpeg === 'string' && item.jpeg.length <= MAX_PHOTO_BYTES * 1.4 ? fromBase64(item.jpeg) : null
    const jpeg = raw && cleanJpeg(raw)
    if (stopId && jpeg) photos.set(stopId, { stopId, jpeg })
    else damaged++
  }
  if (!photos.size) return { ok: false, error: 'None of the photos in that file could be read.' }
  return { ok: true, photos: [...photos.values()], damaged }
}

/** What became of the photos of a file: how many were kept, and how many not, by why. */
export interface RestoreCount {
  saved: number
  failed: Partial<Record<PhotoTrouble, number>>
}

/** Why photos of a file were not kept, after how many: "2 were not kept, as ..." */
const WHY: Record<PhotoTrouble, string> = {
  full: 'as this phone has no room left',
  blocked: "as this phone isn't letting the app keep photos",
  failed: 'as they could not be saved',
}

/** What became of the photos of a file, in plain words: those kept, those not and why, those damaged, and those of stops on no route here. */
export function restoreSummary(count: RestoreCount, damaged: number, unmatched: number): string {
  const parts = [count.saved ? `${plural(count.saved, 'photo', 'photos')} restored.` : 'No photos were restored.']
  for (const why of ['full', 'blocked', 'failed'] as const) {
    const n = count.failed[why]
    if (n) parts.push(`${n} ${n === 1 ? 'was' : 'were'} not kept, ${WHY[why]}.`)
  }
  if (damaged) parts.push(`${damaged} in the file ${damaged === 1 ? 'was' : 'were'} damaged and left out.`)
  if (unmatched) parts.push(`${unmatched} ${unmatched === 1 ? 'is of a stop' : 'are of stops'} on no route here: restore the route within ${UNUSED_DAYS} days and ${unmatched === 1 ? 'it comes' : 'they come'} up with it.`)
  return parts.join(' ')
}
