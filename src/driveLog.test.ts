import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoundMenu } from './RoundMenu'
import { driveFileName, driveGpx, driveJson, matchOf, parseDrive, type DriveEntry } from './driveLog'
import { makeTrack, startProgress } from './progress'

/*
 * Record this round: what is kept, how it is saved as a file, and the phone's database it is kept in, here a small stand-in for IndexedDB (the
 * tests have no browser), with just what driveLog.ts asks of it.
 */

const ROUTE = [
  { lat: -33.87, lng: 151.2 },
  { lat: -33.869, lng: 151.2 },
]
const fix = (k: number) => ({ lat: -33.87 + k * 1e-5, lng: 151.2, accuracy: 8.04, heading: k ? 0.04 : null, speed: k ? 5.123 : null, time: 1_700_000_000_000 + k * 1000 })

describe('a drive saved as a file', () => {
  const info = { id: 'a', routeName: 'Round <1> & "two"', startedAt: 1_700_000_000_000, route: ROUTE }
  const p = { ...startProgress(makeTrack(ROUTE), 20), lost: false }
  const entries: DriveEntry[] = [
    { fix: fix(0), match: null },
    { fix: fix(1), match: matchOf(p) },
  ]

  it('as JSON has the route and every fix with where the tracker put the driver, and reads back', () => {
    const file = parseDrive(driveJson(info, entries))!
    expect(file.routeName).toBe(info.routeName)
    expect(file.route).toEqual(ROUTE)
    expect(file.fixes.map((f) => f.match?.along ?? null)).toEqual([null, 20])
    expect(file.fixes[1]).toMatchObject({ accuracy: 8, heading: 0, speed: 5.12, time: fix(1).time })
    expect(file.fixes[0]).toMatchObject({ heading: null, speed: null })
  })

  it('as GPX is a track of the fixes, with the route name made safe for it', () => {
    const gpx = driveGpx(info, entries)
    expect(gpx).toContain('<name>Round &lt;1&gt; &amp; &quot;two&quot; 2023-11-14T22:13:20.000Z</name>')
    expect(gpx.match(/<trkpt /g)).toHaveLength(2)
    expect(gpx).toContain('<pr:along>20</pr:along>')
    expect(gpx).toContain(`<time>${new Date(fix(1).time).toISOString()}</time>`)
  })

  it('is named for the route and when it began, with nothing a file name cannot have', () => {
    expect(driveFileName({ routeName: 'A/B: C', startedAt: new Date(2026, 10, 12, 5, 7).getTime() }, 'gpx')).toBe('Paper Round drive - AB C 2026-11-12 0507.gpx')
  })
})

/** Just enough of IndexedDB for driveLog.ts: one database, its stores, an index on the drive, requests that succeed a moment later. */
function fakeIndexedDB() {
  type Row = { key: number | string; value: Record<string, unknown> }
  const stores = new Map<string, { rows: Row[]; keyPath?: string; next: number; indexes: Map<string, string> }>()
  const later = (fn: () => void) => setTimeout(fn, 0)
  const request = <T,>(result: () => T) => {
    const req: { result?: T; onsuccess?: () => void; onerror?: () => void } = {}
    later(() => {
      req.result = result()
      req.onsuccess?.()
    })
    return req
  }
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore(name: string, o: { keyPath?: string; autoIncrement?: boolean }) {
      const s = { rows: [] as Row[], keyPath: o.keyPath, next: 1, indexes: new Map<string, string>() }
      stores.set(name, s)
      return { createIndex: (index: string, path: string) => s.indexes.set(index, path) }
    },
    transaction() {
      const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: (n: string) => unknown } = {
        objectStore(name: string) {
          const s = stores.get(name)!
          const keyOf = (v: Record<string, unknown>) => (s.keyPath ? (v[s.keyPath] as string) : s.next++)
          const matching = (index: string, range: { only: unknown }) => s.rows.filter((r) => r.value[s.indexes.get(index)!] === range.only)
          return {
            put: (v: Record<string, unknown>) => {
              const key = keyOf(v)
              s.rows = [...s.rows.filter((r) => r.key !== key), { key, value: structuredClone(v) }]
              return request(() => key)
            },
            add: (v: Record<string, unknown>) => {
              const key = keyOf(v)
              s.rows.push({ key, value: structuredClone(v) })
              return request(() => key)
            },
            get: (key: string) => request(() => s.rows.find((r) => r.key === key)?.value),
            getAll: () => request(() => s.rows.map((r) => r.value)),
            clear: () => request(() => void (s.rows = [])),
            index: (index: string) => ({
              count: (range: { only: unknown }) => request(() => matching(index, range).length),
              getAll: (range: { only: unknown }) => request(() => matching(index, range).map((r) => r.value)),
            }),
          }
        },
      }
      later(() => later(() => tx.oncomplete?.()))
      return tx
    },
  }
  return {
    open() {
      const req: { result?: typeof db; onupgradeneeded?: () => void; onsuccess?: () => void } = {}
      later(() => {
        req.result = db
        req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }
}

describe('drives kept on the phone', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('keeps each fix of a drive begun, lists the drives with their fixes, reads one back in order, and forgets them all', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDB())
    vi.stubGlobal('IDBKeyRange', { only: (v: unknown) => ({ only: v }) })
    const log = await import('./driveLog')
    const id = await log.startDrive('My Round', ROUTE, 1_700_000_000_000)
    expect(id).not.toBeNull()
    const p = { ...startProgress(makeTrack(ROUTE), 30), lost: false }
    log.logFix(id!, fix(2), p)
    log.logFix(id!, fix(1), null)
    await new Promise((r) => setTimeout(r, 20))
    expect(await log.listDrives()).toEqual([{ id, routeName: 'My Round', startedAt: 1_700_000_000_000, fixes: 2 }])
    const kept = (await log.readDrive(id!))!
    expect(kept.info.route).toEqual(ROUTE)
    expect(kept.entries.map((e) => [e.fix.time, e.match?.along ?? null])).toEqual([
      [fix(1).time, null],
      [fix(2).time, 30],
    ])
    await log.deleteDrives()
    expect(await log.listDrives()).toEqual([])
  })

  it('keeps nothing, and never throws, on a phone with no database', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const log = await import('./driveLog')
    expect(await log.startDrive('My Round', ROUTE)).toBeNull()
    expect(() => log.logFix('x', fix(1), null)).not.toThrow()
    expect(await log.listDrives()).toEqual([])
    expect(await log.readDrive('x')).toBeNull()
  })
})

describe('Record this round, in the round menu', () => {
  const rows = (node: ReactNode): ReactElement<{ onClick?: () => void; children?: ReactNode; title?: string; value?: ReactNode }>[] => {
    if (Array.isArray(node)) return node.flatMap(rows)
    if (!isValidElement(node)) return []
    const el = node as ReactElement<{ children?: ReactNode; title?: string }>
    return [el, ...rows(el.props.children)]
  }
  const menu = (recording: boolean | undefined, onRecording?: () => void, onClose = () => {}) =>
    rows(RoundMenu({ alertDistance: 40, onClose, onWholeRoute: () => {}, onSkip: () => {}, onAlertDistance: () => {}, onReset: () => {}, recording, onRecording }))

  it('is a row with whether it is on, which closes the menu and turns it over', () => {
    const calls: string[] = []
    const row = menu(false, () => calls.push('record'), () => calls.push('close')).find((e) => e.props.title === 'Record this round')!
    expect(row.props.value).toBe('Off')
    row.props.onClick!()
    expect(calls).toEqual(['close', 'record'])
    expect(menu(true, () => {}).find((e) => e.props.title === 'Record this round')!.props.value).toBe('On')
  })

  it('is not there without a way to turn it on', () => {
    expect(menu(undefined).some((e) => e.props.title === 'Record this round')).toBe(false)
  })
})
