import { photoSweep, type PhotoEntry, type PhotoInfo, type PhotoTrouble, type RestoreCount, type SaveResult } from './photos'

/*
 * The photos of stops, in this phone's own database, so they are there with no signal. Each is kept by the id of its stop, not with a route: a copy of
 * a route, the old route Optimise Route keeps, and a route restored from a backup have the same stops, and so the same photos. They are not in the
 * routes' own storage, which they would soon fill. Nothing is taken for kept until the phone has said it is and it has been read back, and every call
 * here gives an answer, whatever the phone does: a phone that won't keep photos drives on as ever, without them.
 */

const DB_NAME = 'paper-round-photos'
/** The pictures, and what is known of each, kept apart so that listing them reads no pictures. Always written together. */
const PHOTOS = 'photos'
const INFO = 'info'
/** A phone that says nothing for this long, in milliseconds, has not kept it (an iPhone's database can stop answering). */
const WAIT_MS = 10_000

/** A picture as it is kept: its bytes as a plain buffer, as an iPhone has lost photos kept as blobs. */
interface Kept {
  stopId: string
  jpeg: ArrayBuffer
}

type Outcome<T> = { ok: true; value: T } | { ok: false; why: PhotoTrouble; again: boolean }

let opening: Promise<IDBDatabase | null> | null = null

/** The database, or null where the phone has none or won't open it. Asked for again after it fails or is closed, as an iPhone closes it at times in the background. */
function db(): Promise<IDBDatabase | null> {
  if (opening) return opening
  const asked = new Promise<IDBDatabase | null>((resolve) => {
    const forget = () => {
      if (opening === asked) opening = null
    }
    const none = () => {
      forget()
      resolve(null)
    }
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const timer = setTimeout(none, WAIT_MS)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const d = req.result
        if (!d.objectStoreNames.contains(PHOTOS)) d.createObjectStore(PHOTOS, { keyPath: 'stopId' })
        if (!d.objectStoreNames.contains(INFO)) d.createObjectStore(INFO, { keyPath: 'stopId' })
      }
      req.onsuccess = () => {
        clearTimeout(timer)
        const d = req.result
        d.onclose = forget
        d.onversionchange = () => {
          d.close()
          forget()
        }
        resolve(d)
      }
      req.onerror = () => {
        clearTimeout(timer)
        none()
      }
    } catch {
      // `none` can't be called yet: `asked` is still being made. The next call asks again.
      setTimeout(forget, 0)
      resolve(null)
    }
  })
  opening = asked
  return asked
}

const isFull = (e: unknown) => (e as { name?: unknown } | null | undefined)?.name === 'QuotaExceededError'

/** One go at `work`, in a transaction of its own over both stores. What it gives back is read once the phone has finished it. */
async function once<T>(mode: IDBTransactionMode, work: (photos: IDBObjectStore, info: IDBObjectStore) => () => T): Promise<Outcome<T>> {
  const d = await db()
  if (!d) return { ok: false, why: 'blocked', again: false }
  return new Promise((resolve) => {
    const fail = (e: unknown, again = true) => resolve(isFull(e) ? { ok: false, why: 'full', again: false } : { ok: false, why: 'failed', again })
    try {
      // Asked to be on the disk before it is called done, where the phone can.
      const tx = mode === 'readwrite' ? d.transaction([PHOTOS, INFO], mode, { durability: 'strict' }) : d.transaction([PHOTOS, INFO], mode)
      const timer = setTimeout(() => {
        opening = null
        fail(null, false)
        try {
          tx.abort()
        } catch {
          // Over already.
        }
      }, WAIT_MS)
      const over = (then: () => void) => () => {
        clearTimeout(timer)
        then()
      }
      const result = work(tx.objectStore(PHOTOS), tx.objectStore(INFO))
      tx.oncomplete = over(() => resolve({ ok: true, value: result() }))
      tx.onabort = over(() => fail(tx.error))
    } catch (e) {
      // The database has been closed under us, most likely: it is opened again for another go.
      opening = null
      fail(e)
    }
  })
}

/** `work` in a transaction, with one more go when the database had gone away. Never throws. */
async function run<T>(mode: IDBTransactionMode, work: (photos: IDBObjectStore, info: IDBObjectStore) => () => T): Promise<Outcome<T>> {
  const first = await once(mode, work)
  if (first.ok || !first.again) return first
  opening = null
  return once(mode, work)
}

// ---- Being told of a change ----

type Listener = (stopIds: readonly string[]) => void
const listeners = new Set<Listener>()

/** Calls back with the stops whose photo was added, replaced or removed. Gives back the way to stop. */
export function onPhotosChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
const tell = (stopIds: readonly string[]) => {
  if (stopIds.length) for (const listener of [...listeners]) listener(stopIds)
}

// ---- Reading ----

/** What is known of every photo kept, or null when the phone can't say. */
export async function photoInfos(): Promise<PhotoInfo[] | null> {
  const got = await run('readonly', (_, info) => {
    const req = info.getAll() as IDBRequest<PhotoInfo[]>
    return () => req.result
  })
  return got.ok ? got.value : null
}

/** The photo of a stop, or null when there is none or it can't be read. */
export async function readPhoto(stopId: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const got = await run('readonly', (photos) => {
    const req = photos.get(stopId) as IDBRequest<Kept | undefined>
    return () => req.result
  })
  const jpeg = got.ok ? got.value?.jpeg : undefined
  return jpeg && jpeg.byteLength > 0 ? new Uint8Array(jpeg) : null
}

// ---- Writing ----

/**
 * Keeps the photo of a stop, in place of any it has, and says what became of it: kept only once the phone has finished writing it and it reads back
 * whole. One that isn't kept leaves the stop's old photo as it was.
 */
export async function savePhoto(stopId: string, jpeg: Uint8Array, now = Date.now()): Promise<SaveResult> {
  // A copy of its own bytes, whatever they were cut from.
  const bytes = new Uint8Array(jpeg)
  const wrote = await run('readwrite', (photos, info) => {
    photos.put({ stopId, jpeg: bytes.buffer } satisfies Kept)
    info.put({ stopId, bytes: bytes.length, savedAt: now } satisfies PhotoInfo)
    return () => null
  })
  if (!wrote.ok) return wrote.why
  const back = await readPhoto(stopId)
  tell([stopId])
  return back?.length === bytes.length ? 'saved' : 'failed'
}

/** Removes the photos of these stops, and says whether they are gone. */
export async function removePhotos(stopIds: readonly string[]): Promise<boolean> {
  const done = await run('readwrite', (photos, info) => {
    for (const id of stopIds) {
      photos.delete(id)
      info.delete(id)
    }
    return () => null
  })
  if (done.ok) tell(stopIds)
  return done.ok
}

/**
 * Keeps the photos of a photos file, one at a time, so a phone that runs out of room keeps those that fit. It stops at the first the phone has no room
 * for, or won't keep at all, as the rest would go the same way, and counts them.
 */
export async function restorePhotos(photos: readonly PhotoEntry[], onEach: (done: number) => void = () => {}): Promise<RestoreCount> {
  const count: RestoreCount = { saved: 0, failed: {} }
  for (const [i, photo] of photos.entries()) {
    const result = await savePhoto(photo.stopId, photo.jpeg)
    if (result === 'saved') count.saved++
    else {
      const rest = result === 'failed' ? 1 : photos.length - i
      count.failed[result] = (count.failed[result] ?? 0) + rest
      if (result !== 'failed') break
    }
    onEach(i + 1)
  }
  return count
}

/**
 * As the app opens: marks the photos of stops on no route, unmarks those back on one, and removes those that have been on none for a month (see
 * `photoSweep`). It is all one transaction, so a photo put back meanwhile is never removed. Says how many went.
 */
export async function tidyPhotos(used: ReadonlySet<string>, now = Date.now()): Promise<number> {
  const removed: string[] = []
  const done = await run('readwrite', (photos, info) => {
    removed.length = 0
    const req = info.getAll() as IDBRequest<PhotoInfo[]>
    req.onsuccess = () => {
      const byId = new Map(req.result.map((i) => [i.stopId, i]))
      const { mark, clear, remove } = photoSweep(req.result, used, now)
      for (const id of mark) info.put({ ...byId.get(id)!, unusedSince: now })
      for (const id of clear) {
        const { unusedSince: _unusedSince, ...rest } = byId.get(id)!
        info.put(rest)
      }
      for (const id of remove) {
        photos.delete(id)
        info.delete(id)
        removed.push(id)
      }
    }
    return () => null
  })
  if (!done.ok) return 0
  tell(removed)
  return removed.length
}
