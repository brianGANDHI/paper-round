import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UNUSED_DAYS } from './photos'

/*
 * The phone's database of photos, here a small stand-in for IndexedDB (the tests have no browser) with what photoStore.ts asks of it, and the ways a
 * phone lets an app down: no database, no room, a connection closed in the background, a write that fails, and one that never answers.
 */

const DAY = 24 * 60 * 60 * 1000
const error = (name: string) => Object.assign(new Error(name), { name })

interface Row {
  stopId: string
  jpeg?: ArrayBuffer
  bytes?: number
  savedAt?: number
  unusedSince?: number
}

/** The phone: what is on its disk, and what goes wrong. */
function fakePhone() {
  const disk = new Map<string, Map<string, Row>>()
  const phone = {
    disk,
    /** How many bytes of photos it has room for. */
    room: Infinity,
    /** The next goes at the disk fail like this. */
    failNext: [] as string[],
    /** Nothing answers. */
    hung: false,
    /** Opening it is refused. */
    refused: false,
    /** What is written comes out cut short. */
    corrupt: false,
    opened: 0,
    /** The transaction before has finished. */
    turn: Promise.resolve(),
    connections: [] as { closed: boolean; onclose?: () => void }[],
    /** As an iPhone does to an app in the background: with or without a word. */
    close(tell: boolean) {
      for (const c of phone.connections) {
        c.closed = true
        if (tell) c.onclose?.()
      }
    },
    photos: () => [...(disk.get('photos')?.values() ?? [])],
    infos: () => [...(disk.get('info')?.values() ?? [])],
    indexedDB: {
      open() {
        const req: { result?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {}
        phone.opened++
        setTimeout(() => {
          if (phone.hung) return
          if (phone.refused) return req.onerror?.()
          const connection = {
            closed: false,
            onclose: undefined as (() => void) | undefined,
            objectStoreNames: { contains: (n: string) => disk.has(n) },
            createObjectStore: (n: string) => void disk.set(n, new Map()),
            close: () => {
              connection.closed = true
            },
            transaction,
          }
          function transaction(names: string[]) {
            if (connection.closed) throw error('InvalidStateError')
            // What it changes, from when its turn comes (one at a time, as a database does) until it is over.
            let work = new Map<string, Map<string, Row>>()
            let done: () => void = () => {}
            const before = phone.turn
            phone.turn = new Promise<void>((resolve) => (done = resolve))
            const queue: (() => void)[] = []
            let over = false
            const tx = {
              error: null as unknown,
              oncomplete: undefined as (() => void) | undefined,
              onabort: undefined as (() => void) | undefined,
              abort() {
                if (over) throw error('InvalidStateError')
                over = true
                done()
                tx.onabort?.()
              },
              objectStore(name: string) {
                const rows = { set: (id: string, r: Row) => work.get(name)!.set(id, r), delete: (id: string) => work.get(name)!.delete(id), get: (id: string) => work.get(name)!.get(id), values: () => work.get(name)!.values() }
                const ask = <T,>(answer: () => T) => {
                  const r: { result?: T; onsuccess?: () => void } = {}
                  queue.push(() => {
                    r.result = answer()
                    r.onsuccess?.()
                  })
                  return r
                }
                return {
                  put: (v: Row) => ask(() => void rows.set(v.stopId, structuredClone(phone.corrupt && v.jpeg ? { ...v, jpeg: v.jpeg.slice(1) } : v))),
                  delete: (id: string) => ask(() => void rows.delete(id)),
                  get: (id: string) => ask(() => structuredClone(rows.get(id))),
                  getAll: () => ask(() => structuredClone([...rows.values()])),
                }
              },
            }
            const step = () => {
              if (phone.hung || over) return
              const next = queue.shift()
              if (next) {
                next()
                return void setTimeout(step, 0)
              }
              const size = [...(work.get('photos')?.values() ?? [])].reduce((n, r) => n + (r.jpeg?.byteLength ?? 0), 0)
              const was = phone.photos().reduce((n, r) => n + (r.jpeg?.byteLength ?? 0), 0)
              const why = phone.failNext.shift() ?? (size > phone.room && size > was ? 'QuotaExceededError' : null)
              over = true
              done()
              if (why) {
                tx.error = error(why)
                return tx.onabort?.()
              }
              for (const [n, rows] of work) disk.set(n, rows)
              tx.oncomplete?.()
            }
            void before.then(() => {
              work = new Map(names.map((n) => [n, new Map(disk.get(n))]))
              setTimeout(step, 0)
            })
            return tx
          }
          phone.connections.push(connection)
          req.result = connection
          if (!disk.has('photos')) req.onupgradeneeded?.()
          req.onsuccess?.()
        }, 0)
        return req
      },
    },
  }
  return phone
}

let phone: ReturnType<typeof fakePhone>
let store: typeof import('./photoStore')
beforeEach(async () => {
  phone = fakePhone()
  vi.resetModules()
  vi.stubGlobal('indexedDB', phone.indexedDB)
  store = await import('./photoStore')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill)
const ids = async () => (await store.photoInfos())?.map((i) => i.stopId).sort()

describe('a photo kept on the phone', () => {
  it('reads back as it was, with how big it is and when it was added', async () => {
    expect(await store.savePhoto('a', bytes(100), 5)).toBe('saved')
    expect(await store.readPhoto('a')).toEqual(bytes(100))
    expect(await store.photoInfos()).toEqual([{ stopId: 'a', bytes: 100, savedAt: 5 }])
  })

  it('is kept as plain bytes of its own, not a blob, and not the buffer it was cut from', async () => {
    const big = bytes(1000)
    await store.savePhoto('a', big.subarray(10, 30))
    expect(phone.photos()[0].jpeg).toBeInstanceOf(ArrayBuffer)
    expect(phone.photos()[0].jpeg!.byteLength).toBe(20)
  })

  it('is replaced by a new one, and there is only ever one of a stop', async () => {
    await store.savePhoto('a', bytes(100), 5)
    expect(await store.savePhoto('a', bytes(40, 9), 6)).toBe('saved')
    expect(await store.readPhoto('a')).toEqual(bytes(40, 9))
    expect(await store.photoInfos()).toEqual([{ stopId: 'a', bytes: 40, savedAt: 6 }])
  })

  it('is removed with what is known of it, and the others stay', async () => {
    for (const id of ['a', 'b', 'c']) await store.savePhoto(id, bytes(10))
    expect(await store.removePhotos(['a', 'c', 'never'])).toBe(true)
    expect(await ids()).toEqual(['b'])
    expect(phone.photos().map((p) => p.stopId)).toEqual(['b'])
    expect(await store.readPhoto('a')).toBeNull()
  })

  it('is told of as it changes, until it is asked not to be', async () => {
    const told: (readonly string[])[] = []
    const stop = store.onPhotosChanged((changed) => told.push(changed))
    await store.savePhoto('a', bytes(10))
    await store.removePhotos(['a'])
    stop()
    await store.savePhoto('b', bytes(10))
    expect(told).toEqual([['a'], ['a']])
  })
})

describe('a phone that will not keep a photo', () => {
  it('is said to have no room, and the stop’s old photo is as it was', async () => {
    await store.savePhoto('a', bytes(100))
    phone.room = 150
    expect(await store.savePhoto('b', bytes(100))).toBe('full')
    expect(await ids()).toEqual(['a'])
    expect(await store.savePhoto('a', bytes(200))).toBe('full')
    expect(await store.readPhoto('a')).toEqual(bytes(100))
    expect(await store.photoInfos()).toMatchObject([{ stopId: 'a', bytes: 100 }])
  })

  it('is said to let the app keep nothing, with no database or one it will not open, and never throws', async () => {
    phone.refused = true
    expect(await store.savePhoto('a', bytes(10))).toBe('blocked')
    expect(await store.photoInfos()).toBeNull()
    expect(await store.readPhoto('a')).toBeNull()
    expect(await store.removePhotos(['a'])).toBe(false)
    expect(await store.tidyPhotos(new Set())).toBe(0)
    vi.stubGlobal('indexedDB', undefined)
    vi.resetModules()
    store = await import('./photoStore')
    expect(await store.savePhoto('a', bytes(10))).toBe('blocked')
    expect(await store.photoInfos()).toBeNull()
  })

  it('is asked again once it lets the app in', async () => {
    phone.refused = true
    expect(await store.savePhoto('a', bytes(10))).toBe('blocked')
    phone.refused = false
    expect(await store.savePhoto('a', bytes(10))).toBe('saved')
  })

  it('has one more go at a write that failed, and says so when that fails too', async () => {
    phone.failNext = ['UnknownError']
    expect(await store.savePhoto('a', bytes(10))).toBe('saved')
    phone.failNext = ['UnknownError', 'AbortError']
    expect(await store.savePhoto('b', bytes(10))).toBe('failed')
    expect(await ids()).toEqual(['a'])
    phone.failNext = ['UnknownError', 'UnknownError']
    expect(await store.removePhotos(['a'])).toBe(false)
    expect(await ids()).toEqual(['a'])
  })

  it('says a photo that does not read back whole was not kept', async () => {
    phone.corrupt = true
    expect(await store.savePhoto('a', bytes(10))).toBe('failed')
  })

  it('is given up on when it never answers, opening or writing, and works again when it does', async () => {
    await store.savePhoto('a', bytes(10))
    vi.useFakeTimers()
    phone.hung = true
    let result: string | undefined
    void store.savePhoto('b', bytes(10)).then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(result).toBe('failed')
    let read: unknown = 'waiting'
    void store.readPhoto('a').then((r) => (read = r))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toBeNull()
    vi.useRealTimers()
    phone.hung = false
    expect(await store.savePhoto('b', bytes(10))).toBe('saved')
  })
})

describe('a database the phone closed in the background', () => {
  for (const told of [true, false]) {
    it(`is opened again${told ? '' : ', though the app was not told'}`, async () => {
      await store.savePhoto('a', bytes(10))
      phone.close(told)
      expect(await store.readPhoto('a')).toEqual(bytes(10))
      phone.close(told)
      expect(await store.savePhoto('b', bytes(10))).toBe('saved')
      expect(await ids()).toEqual(['a', 'b'])
      expect(phone.opened).toBe(3)
    })
  }

  it('is opened once, and not for each photo', async () => {
    await Promise.all(['a', 'b', 'c'].map((id) => store.savePhoto(id, bytes(10))))
    expect(phone.opened).toBe(1)
    expect(await ids()).toEqual(['a', 'b', 'c'])
  })
})

describe('the photos of a file', () => {
  const entries = (...list: [string, number][]) => list.map(([stopId, n]) => ({ stopId, jpeg: bytes(n) }))

  it('are all kept, with how many are done told as they are', async () => {
    const done: number[] = []
    expect(await store.restorePhotos(entries(['a', 10], ['b', 10]), (n) => done.push(n))).toEqual({ saved: 2, failed: {} })
    expect(done).toEqual([1, 2])
    expect(await ids()).toEqual(['a', 'b'])
  })

  it('stop at the first there is no room for, counting the rest, and those kept stay', async () => {
    phone.room = 25
    expect(await store.restorePhotos(entries(['a', 10], ['b', 10], ['c', 10], ['d', 10]))).toEqual({ saved: 2, failed: { full: 2 } })
    expect(await ids()).toEqual(['a', 'b'])
  })

  it('stop at once on a phone that keeps nothing', async () => {
    phone.refused = true
    expect(await store.restorePhotos(entries(['a', 10], ['b', 10], ['c', 10]))).toEqual({ saved: 0, failed: { blocked: 3 } })
  })

  it('go on past one that could not be saved', async () => {
    phone.corrupt = true
    expect(await store.restorePhotos(entries(['a', 10], ['b', 10]))).toEqual({ saved: 0, failed: { failed: 2 } })
  })
})

describe('tidying up as the app opens', () => {
  const t = 1_800_000_000_000

  it('marks the photos of stops on no route, and removes them a month later and not before', async () => {
    for (const id of ['a', 'b']) await store.savePhoto(id, bytes(10), t)
    expect(await store.tidyPhotos(new Set(['a']), t)).toBe(0)
    expect((await store.photoInfos())!.map((i) => [i.stopId, i.unusedSince])).toEqual([
      ['a', undefined],
      ['b', t],
    ])
    expect(await store.tidyPhotos(new Set(['a']), t + (UNUSED_DAYS - 1) * DAY)).toBe(0)
    expect(await store.readPhoto('b')).not.toBeNull()
    expect(await store.tidyPhotos(new Set(['a']), t + UNUSED_DAYS * DAY)).toBe(1)
    expect(await ids()).toEqual(['a'])
    expect(phone.photos().map((p) => p.stopId)).toEqual(['a'])
  })

  it('lets off a photo whose stop came back, and its month starts again if it goes', async () => {
    await store.savePhoto('a', bytes(10), t)
    await store.tidyPhotos(new Set(), t)
    await store.tidyPhotos(new Set(['a']), t + 40 * DAY)
    expect(await store.photoInfos()).toEqual([{ stopId: 'a', bytes: 10, savedAt: t }])
    expect(await store.tidyPhotos(new Set(), t + 41 * DAY)).toBe(0)
    expect(await store.readPhoto('a')).toEqual(bytes(10))
  })

  it('loses nothing to one opening with no routes at all, as when they could not be read', async () => {
    for (const id of ['a', 'b']) await store.savePhoto(id, bytes(10), t)
    expect(await store.tidyPhotos(new Set(), t + 500 * DAY)).toBe(0)
    await store.tidyPhotos(new Set(['a', 'b']), t + 500 * DAY + 1)
    expect(await ids()).toEqual(['a', 'b'])
    expect((await store.photoInfos())!.every((i) => i.unusedSince === undefined)).toBe(true)
  })

  it('starts a new photo of the stop with a clean slate', async () => {
    await store.savePhoto('a', bytes(10), t)
    await store.tidyPhotos(new Set(), t)
    await store.savePhoto('a', bytes(12), t + DAY)
    expect(await store.photoInfos()).toEqual([{ stopId: 'a', bytes: 12, savedAt: t + DAY }])
  })

  it('tells of the photos that went, and only those', async () => {
    for (const id of ['a', 'b']) await store.savePhoto(id, bytes(10), t)
    await store.tidyPhotos(new Set(['a']), t)
    const told: (readonly string[])[] = []
    store.onPhotosChanged((changed) => told.push(changed))
    await store.tidyPhotos(new Set(['a']), t + DAY)
    await store.tidyPhotos(new Set(['a']), t + 60 * DAY)
    expect(told).toEqual([['b']])
  })
})
