import type { Progress } from './progress'
import type { Pt } from './types'

/*
 * A round driven, kept for replaying: every fix the phone gave, as it gave it, and where the tracker put the driver for it. Only while the driver has
 * asked for it (Record this round, in the round's menu), and only on this phone, in its own database: the app never sends it anywhere. Setup saves it
 * as a file, JSON (with the route, so the drive can be played through the tracker again in a test) or GPX (for a map). A phone that won't store it
 * (a private tab, no room) drives on as ever: every call here is wrapped, and the worst it does is keep nothing.
 */

/** A fix as the phone gave it. */
export interface DriveFix {
  lat: number
  lng: number
  accuracy: number
  /** The phone's own course, in degrees clockwise from north, or null when it gave none. */
  heading: number | null
  speed: number | null
  /** When it was taken, in milliseconds since 1970. */
  time: number
}

/** Where the tracker put the driver for a fix it took in (null for one it set aside, or a phone standing still). */
export interface DriveMatch {
  idx: number
  t: number
  along: number
  furthest: number
  gap: number
  lost: boolean
  /** Whether it was holding the driver's old place, doubting a jump. */
  doubt: boolean
  /** Whether a turn round not sure yet stood. */
  turned: boolean
}

export interface DriveEntry {
  fix: DriveFix
  match: DriveMatch | null
}

/** A drive kept: which route, when it began, and the route's line as it was then. */
export interface DriveInfo {
  id: string
  routeName: string
  startedAt: number
  route: Pt[]
}

/** A drive as it is saved to a file (JSON). */
export interface DriveFile {
  app: 'paper-round'
  kind: 'drive'
  version: 1
  routeName: string
  startedAt: number
  route: Pt[]
  fixes: (DriveFix & { match: DriveMatch | null })[]
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places

/** What is kept of where the tracker put the driver. */
export const matchOf = (p: Progress): DriveMatch => ({
  idx: p.idx,
  t: round(p.t, 4),
  along: round(p.along, 1),
  furthest: round(p.furthest, 1),
  gap: round(p.gap, 1),
  lost: p.lost,
  doubt: p.doubt !== null,
  turned: !!p.turned,
})

/** A fix as it is kept: as the phone gave it, at the precision a phone has. */
export const fixOf = (f: DriveFix): DriveFix => ({
  lat: round(f.lat, 7),
  lng: round(f.lng, 7),
  accuracy: round(f.accuracy, 1),
  heading: f.heading === null ? null : round(f.heading, 1),
  speed: f.speed === null ? null : round(f.speed, 2),
  time: f.time,
})

/** The drive as a JSON file, which the replay test reads. */
export function driveJson(info: DriveInfo, entries: readonly DriveEntry[]): string {
  const file: DriveFile = {
    app: 'paper-round',
    kind: 'drive',
    version: 1,
    routeName: info.routeName,
    startedAt: info.startedAt,
    route: info.route.map((p) => ({ lat: round(p.lat, 7), lng: round(p.lng, 7) })),
    fixes: entries.map((e) => ({ ...fixOf(e.fix), match: e.match })),
  }
  return JSON.stringify(file)
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The drive as a GPX track, for a map: each fix with its time, and its accuracy, speed, course and place along the route as extensions. */
export function driveGpx(info: DriveInfo, entries: readonly DriveEntry[]): string {
  const name = xml(`${info.routeName} ${new Date(info.startedAt).toISOString()}`)
  const points = entries.map(({ fix, match }) => {
    const f = fixOf(fix)
    const extra = [
      `<pr:accuracy>${f.accuracy}</pr:accuracy>`,
      f.speed === null ? '' : `<pr:speed>${f.speed}</pr:speed>`,
      f.heading === null ? '' : `<pr:course>${f.heading}</pr:course>`,
      match ? `<pr:along>${match.along}</pr:along><pr:furthest>${match.furthest}</pr:furthest>${match.lost ? '<pr:lost>1</pr:lost>' : ''}${match.doubt ? '<pr:doubt>1</pr:doubt>' : ''}` : '',
    ].join('')
    return `<trkpt lat="${f.lat}" lon="${f.lng}"><time>${new Date(f.time).toISOString()}</time><extensions>${extra}</extensions></trkpt>`
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Paper Round" xmlns="http://www.topografix.com/GPX/1/1" xmlns:pr="https://github.com/brianGANDHI/paper-round/drive">',
    `<trk><name>${name}</name><trkseg>`,
    ...points,
    '</trkseg></trk>',
    '</gpx>',
    '',
  ].join('\n')
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const orNull = (n: unknown): number | null => (finite(n) ? n : null)

/** A drive read back from its JSON file, or null if it isn't one. Fixes that are not whole are left out. */
export function parseDrive(text: string): DriveFile | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const d = data as Partial<DriveFile>
  if (d.app !== 'paper-round' || d.kind !== 'drive' || !Array.isArray(d.route) || !Array.isArray(d.fixes)) return null
  const route = d.route.filter((p) => p && finite(p.lat) && finite(p.lng)).map((p) => ({ lat: p.lat, lng: p.lng }))
  const fixes = d.fixes
    .filter((f) => f && finite(f.lat) && finite(f.lng) && finite(f.accuracy) && finite(f.time))
    .map((f) => ({ lat: f.lat, lng: f.lng, accuracy: f.accuracy, heading: orNull(f.heading), speed: orNull(f.speed), time: f.time, match: f.match && typeof f.match === 'object' ? f.match : null }))
  return { app: 'paper-round', kind: 'drive', version: 1, routeName: typeof d.routeName === 'string' ? d.routeName : 'Drive', startedAt: finite(d.startedAt) ? d.startedAt : (fixes[0]?.time ?? 0), route, fixes }
}

/** What a drive's file is called. */
export const driveFileName = (info: Pick<DriveInfo, 'routeName' | 'startedAt'>, kind: 'json' | 'gpx') => {
  const d = new Date(info.startedAt)
  const two = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}`
  return `Paper Round drive - ${info.routeName.replace(/[\\/:*?"<>|]/g, '').trim() || 'Route'} ${stamp}.${kind}`
}

// ---- The phone's own database ----

const DB_NAME = 'paper-round-drives'
const DRIVES = 'drives'
const FIXES = 'fixes'
let opening: Promise<IDBDatabase | null> | null = null

/** The database, or null where the phone has none or won't open it. */
function db(): Promise<IDBDatabase | null> {
  if (opening) return opening
  opening = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const d = req.result
        if (!d.objectStoreNames.contains(DRIVES)) d.createObjectStore(DRIVES, { keyPath: 'id' })
        if (!d.objectStoreNames.contains(FIXES)) d.createObjectStore(FIXES, { autoIncrement: true }).createIndex('drive', 'drive')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return opening
}

/** Runs `work` in a transaction, and gives back what it gives, or `fallback` if anything goes wrong. */
async function inStore<T, F>(mode: IDBTransactionMode, work: (drives: IDBObjectStore, fixes: IDBObjectStore) => IDBRequest<T> | null, fallback: F): Promise<T | F> {
  try {
    const d = await db()
    if (!d) return fallback
    return await new Promise<T | F>((resolve) => {
      try {
        const tx = d.transaction([DRIVES, FIXES], mode)
        const req = work(tx.objectStore(DRIVES), tx.objectStore(FIXES))
        let result: T | F = fallback
        if (req) req.onsuccess = () => (result = req.result)
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => resolve(fallback)
        tx.onabort = () => resolve(fallback)
      } catch {
        resolve(fallback)
      }
    })
  } catch {
    return fallback
  }
}

/** Begins keeping a drive of this route. Its id, or null if the phone won't keep it. */
export async function startDrive(routeName: string, route: readonly Pt[], now = Date.now()): Promise<string | null> {
  const id = `${now}-${Math.random().toString(36).slice(2, 8)}`
  const info: DriveInfo = { id, routeName, startedAt: now, route: route.map((p) => ({ lat: p.lat, lng: p.lng })) }
  const ok = await inStore('readwrite', (drives) => drives.put(info), null)
  return ok === null ? null : id
}

/** Keeps a fix of the drive, and where the tracker put the driver for it. Never throws, and never waits. */
export function logFix(id: string, fix: DriveFix, progress: Progress | null): void {
  void inStore('readwrite', (_, fixes) => fixes.add({ drive: id, fix: fixOf(fix), match: progress ? matchOf(progress) : null }), null)
}

/** The drives kept, newest first, with how many fixes each has. */
export async function listDrives(): Promise<(Omit<DriveInfo, 'route'> & { fixes: number })[]> {
  const drives = await inStore('readonly', (store) => store.getAll() as IDBRequest<DriveInfo[]>, [] as DriveInfo[])
  const out: (Omit<DriveInfo, 'route'> & { fixes: number })[] = []
  for (const d of drives) {
    const fixes = await inStore('readonly', (_, store) => store.index('drive').count(IDBKeyRange.only(d.id)), 0)
    out.push({ id: d.id, routeName: d.routeName, startedAt: d.startedAt, fixes })
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

/** A drive kept, with its fixes in the order they came, or null. */
export async function readDrive(id: string): Promise<{ info: DriveInfo; entries: DriveEntry[] } | null> {
  const info = await inStore('readonly', (store) => store.get(id) as IDBRequest<DriveInfo | undefined>, undefined as DriveInfo | undefined)
  if (!info) return null
  const rows = await inStore('readonly', (_, store) => store.index('drive').getAll(IDBKeyRange.only(id)) as IDBRequest<{ fix: DriveFix; match: DriveMatch | null }[]>, [] as { fix: DriveFix; match: DriveMatch | null }[])
  return { info, entries: rows.map((r) => ({ fix: r.fix, match: r.match })).sort((a, b) => a.fix.time - b.fix.time) }
}

/** Forgets every drive kept. */
export async function deleteDrives(): Promise<void> {
  await inStore(
    'readwrite',
    (drives, fixes) => {
      drives.clear()
      return fixes.clear()
    },
    undefined,
  )
}

/**
 * Saves a drive's file: on a phone by its share sheet (which has Save to Files and AirDrop), on a computer as a download. Says whether it was saved:
 * closing the share sheet without choosing anything is not.
 */
export async function saveDriveFile(text: string, fileName: string, type: string): Promise<boolean> {
  try {
    const file = new File([text], fileName, { type })
    if (!matchMedia('(pointer: coarse)').matches || !navigator.canShare?.({ files: [file] })) {
      const url = URL.createObjectURL(file)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      return true
    }
    await navigator.share({ files: [file], title: 'Paper Round drive' })
    return true
  } catch {
    return false
  }
}
