import { describe, expect, it } from 'vitest'
import { makeBackup, parseBackup, PHOTOS_NOT_ROUTES, toBackupRoute } from './backup'
import { bearing, occurrences } from './geo'
import { activeRoute, addImported, deleteRoute, duplicateRoute, editActiveRoute, keepCopy, makeRoute } from './library'
import { acceptOptimised } from './optimise/accept'
import { basedOnOf } from './optimise/run'
import type { OptimiseResult, RouteStats } from './optimise/types'
import {
  cleanJpeg,
  formatBytes,
  isPhotosFile,
  MAX_PHOTO_BYTES,
  MAX_PHOTOS,
  parsePhotosFile,
  photoFor,
  PHOTOS_FILE_END,
  photosFileEntry,
  photosFileName,
  photosFileStart,
  photoSweep,
  photoTag,
  restoreSummary,
  showsPhoto,
  shrunkSize,
  stillPutAway,
  stopIdsOf,
  streetViewUrl,
  UNUSED_DAYS,
  type PhotoInfo,
} from './photos'
import { deleteSection, updateStop } from './routeEdit'
import type { Library, Route, Stop } from './types'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0))
/** A part of a JPEG: its marker, its length and what is in it. */
const part = (marker: number, ...data: number[]) => [0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 255, ...data]
const JFIF = part(0xe0, ...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0)
const EXIF = part(0xe1, ...ascii('Exif\0\0'), ...ascii('GPS 33.8 S 151.2 E'))
const XMP = part(0xe1, ...ascii('http://ns.adobe.com/xap/1.0/\0<gps/>'))
const ICC = part(0xe2, ...ascii('ICC_PROFILE\0'), 1, 1, 9, 9)
/** A second picture a phone can hide after the first, with its own location. */
const MPF = part(0xe2, ...ascii('MPF\0'), 1, 2, 3)
const IPTC = part(0xed, ...ascii('Photoshop 3.0\0Sydney'))
const ADOBE = part(0xee, ...ascii('Adobe'), 0, 100, 0, 0, 0, 0, 1)
const NOTE = part(0xfe, ...ascii('taken at home'))
const TABLE = part(0xdb, 0, 1, 2, 3)
const frame = (width: number, height: number, marker = 0xc0) => part(marker, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0)
const HUFF = part(0xc4, 0, 5, 6)
const SCAN = [...part(0xda, 1, 1, 0, 0, 63, 0), 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]
const jpegOf = (...parts: number[][]) => new Uint8Array([0xff, 0xd8, ...parts.flat(), 0xff, 0xd9])
const JPEG = jpegOf(JFIF, TABLE, frame(800, 600), HUFF, SCAN)
const textOf = (bytes: Uint8Array) => String.fromCharCode(...bytes)

describe('how big a photo is kept', () => {
  it('is 800 pixels at most on its longer side, the same shape either way up', () => {
    expect(shrunkSize(4032, 3024)).toEqual({ width: 800, height: 600 })
    expect(shrunkSize(3024, 4032)).toEqual({ width: 600, height: 800 })
  })

  it('is never made bigger, or nothing at all', () => {
    expect(shrunkSize(300, 200)).toEqual({ width: 300, height: 200 })
    expect(shrunkSize(20000, 5)).toEqual({ width: 800, height: 1 })
  })

  it('has no size when the picture has none', () => {
    for (const [w, h] of [
      [0, 10],
      [10, 0],
      [NaN, 10],
      [Infinity, 10],
    ])
      expect(shrunkSize(w, h)).toBeNull()
  })
})

describe('taking the location out of a photo', () => {
  it('leaves a JPEG with nothing but its picture as it is', () => {
    expect(cleanJpeg(JPEG)).toEqual(JPEG)
  })

  it('takes out where and when it was taken, comments, and everything after its end, wherever they are in it', () => {
    const marked = new Uint8Array([...jpegOf(EXIF, JFIF, XMP, TABLE, NOTE, frame(800, 600), IPTC, HUFF, MPF, SCAN), ...ascii('trailer 151.2'), ...jpegOf(EXIF)])
    const clean = cleanJpeg(marked)!
    expect(clean).toEqual(JPEG)
    for (const word of ['GPS', 'gps', 'Sydney', 'home', '151.2', 'MPF']) expect(textOf(clean)).not.toContain(word)
  })

  it('keeps what a picture needs to be drawn in its right colours', () => {
    const coloured = jpegOf(JFIF, ICC, ADOBE, TABLE, frame(10, 10), HUFF, SCAN)
    expect(cleanJpeg(coloured)).toEqual(coloured)
  })

  it('takes a picture that comes in several passes, with tables and locations between them', () => {
    const passes = jpegOf(TABLE, frame(10, 10, 0xc2), HUFF, SCAN, EXIF, HUFF, SCAN)
    expect(cleanJpeg(passes)).toEqual(jpegOf(TABLE, frame(10, 10, 0xc2), HUFF, SCAN, HUFF, SCAN))
  })

  it('takes filler before a marker', () => {
    expect(cleanJpeg(jpegOf([0xff, 0xff], EXIF, TABLE, frame(10, 10), SCAN))).toEqual(jpegOf(TABLE, frame(10, 10), SCAN))
  })

  it('does not change what it was given', () => {
    const marked = jpegOf(EXIF, TABLE, frame(10, 10), SCAN)
    const copy = marked.slice()
    cleanJpeg(marked)
    expect(marked).toEqual(copy)
  })

  it('is refused when it is no JPEG', () => {
    expect(cleanJpeg(new Uint8Array())).toBeNull()
    expect(cleanJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    expect(cleanJpeg(new Uint8Array(ascii('<svg onload="x()">')))).toBeNull()
  })

  it('is refused when it stops short, wherever that is', () => {
    for (let n = 0; n < JPEG.length; n++) expect(cleanJpeg(JPEG.slice(0, n))).toBeNull()
  })

  it('is refused when it has no picture, no size, or is bigger than one kept here', () => {
    expect(cleanJpeg(jpegOf(JFIF, TABLE, frame(10, 10)))).toBeNull()
    expect(cleanJpeg(jpegOf(JFIF, TABLE, SCAN))).toBeNull()
    expect(cleanJpeg(jpegOf(frame(0, 10), SCAN))).toBeNull()
    expect(cleanJpeg(jpegOf(frame(2001, 10), SCAN))).toBeNull()
    expect(cleanJpeg(jpegOf(frame(10, 60000), SCAN))).toBeNull()
    expect(cleanJpeg(jpegOf(frame(2000, 2000), SCAN))).not.toBeNull()
    expect(cleanJpeg(new Uint8Array([...JPEG, ...new Uint8Array(MAX_PHOTO_BYTES)]))).toBeNull()
  })

  it('is refused when a part has a length that can not be', () => {
    expect(cleanJpeg(jpegOf([0xff, 0xe1, 0, 1], frame(10, 10), SCAN))).toBeNull()
    expect(cleanJpeg(jpegOf([0xff, 0xe1, 0xff, 0xff], frame(10, 10), SCAN))).toBeNull()
  })
})

// ---- Which photo shows with an alert ----

const O = { lat: -33.87, lng: 151.2 }
const M = 111195
const at = (x: number, y: number) => ({ lat: O.lat + y / M, lng: O.lng + x / (M * Math.cos((O.lat * Math.PI) / 180)) })
const stop = (id: string, type: Stop['type'], x: number, y: number, extra: Partial<Stop> = {}): Stop => ({ id, type, pathIdx: 0, ...at(x, y), ...extra })
const STREET = [at(0, 0), at(0, 500), at(0, 1000)]
const routeOf = (...stops: Stop[]): Route => ({ points: STREET, sideChanges: [{ idx: 0, side: 'both' }], stops })
const passOf = (s: Stop) => occurrences(routeOf(s))[0]

const house = passOf(stop('h', 'nothrow', -14, 100, { address: '14 Oak Road' }))
const drop = passOf(stop('b', 'bundle', 8, 110, { label: "Joe's Cafe", address: '3 Oak Road', qty: 20 }))
const block = passOf(stop('k', 'block', 14, 120, { label: 'Lakeside' }))
const ask = passOf(stop('r', 'request', 14, 130, { address: '31 Oak Road', note: 'Blue gate' }))
const all = new Set(['h', 'b', 'k', 'r'])
const none: ReadonlySet<string> = new Set()
const shown = (current: typeof house | undefined, bundleUp: typeof house | null = null, blockAhead: typeof house | null = null) => ({ current, bundleUp, blockAhead })

describe('the photo that shows with an alert', () => {
  it('is the stop’s own, for a special request, a bundle drop and an apartment block whatever the switch says', () => {
    for (const o of [ask, drop, block]) {
      expect(photoFor(shown(o), all, false, none)).toBe(o)
      expect(photoFor(shown(o), all, true, none)).toBe(o)
    }
  })

  it('is a no-throw house’s only with the switch on', () => {
    expect(photoFor(shown(house), all, false, none)).toBeNull()
    expect(photoFor(shown(house), all, true, none)).toBe(house)
    expect((['bundle', 'request', 'block', 'nothrow'] as const).map((t) => showsPhoto(t, false))).toEqual([true, true, true, false])
  })

  it('is none with no alert up, or when the stop has no photo', () => {
    expect(photoFor(shown(undefined), all, true, none)).toBeNull()
    expect(photoFor(shown(house), none, true, none)).toBeNull()
    expect(photoFor(shown(drop), new Set(['h']), true, none)).toBeNull()
  })

  it('is the one of the bundle drop, or the apartment block, in a house’s banner when the house has none to show', () => {
    expect(photoFor(shown(house, drop, block), all, false, none)).toBe(drop)
    expect(photoFor(shown(house, drop, block), new Set(['k']), true, none)).toBe(block)
    expect(photoFor(shown(house, drop, block), all, true, none)).toBe(house)
  })

  it('does not come back, and is not followed by another, once it is put away', () => {
    expect(photoFor(shown(house, drop), all, true, new Set([house.key]))).toBeNull()
    // The next alert's own is another matter.
    expect(photoFor(shown(drop), all, true, new Set([house.key]))).toBe(drop)
  })

  it('is let back only once the alert it was put away from has gone', () => {
    const away = new Set([house.key, drop.key])
    expect(stillPutAway(away, [house, drop])).toBe(away)
    expect([...stillPutAway(away, [drop])]).toEqual([drop.key])
    expect([...stillPutAway(away, [])]).toEqual([])
    expect(stillPutAway(none, [house])).toBe(none)
  })

  it('is marked with the number of a house, and the name of a place', () => {
    expect(photoTag(house.stop)).toBe('14')
    expect(photoTag(ask.stop)).toBe('31')
    expect(photoTag(drop.stop)).toBe("Joe's Cafe")
    expect(photoTag(block.stop)).toBe('Lakeside')
    expect(photoTag(stop('x', 'bundle', 0, 0, { address: '9 Elm Way' }))).toBe('9')
    expect(photoTag(stop('x', 'nothrow', 0, 0, { label: 'The Lodge' }))).toBe('The Lodge')
    expect(photoTag(stop('x', 'nothrow', 0, 0))).toBe('No Throw')
    expect(photoTag(stop('x', 'request', 0, 0, { note: 'Blue gate' }))).toBe('Special Request')
  })
})

describe('the link to Street View', () => {
  it('is Google’s own, for the stop’s place and nothing else of the stop', () => {
    const s = stop('secret-id', 'nothrow', 14, 250, { label: 'The Smiths', address: '14 Oak Road', note: 'Dog' })
    const url = new URL(streetViewUrl(s, STREET))
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/@')
    expect([...url.searchParams.keys()].sort()).toEqual(['api', 'heading', 'map_action', 'viewpoint'])
    expect(url.searchParams.get('api')).toBe('1')
    expect(url.searchParams.get('map_action')).toBe('pano')
    expect(url.searchParams.get('viewpoint')).toBe(`${Math.round(s.lat * 1e6) / 1e6},${Math.round(s.lng * 1e6) / 1e6}`)
  })

  it('looks from the road to the stop', () => {
    const look = (x: number) => Number(new URL(streetViewUrl(stop('s', 'nothrow', x, 250), STREET)).searchParams.get('heading'))
    expect(look(14)).toBe(90)
    expect(look(-14)).toBe(270)
    expect(bearing(at(0, 250), at(14, 250))).toBeCloseTo(90, 0)
  })

  it('says no way to look for a stop on the road, far from it, or with no route drawn', () => {
    for (const url of [streetViewUrl(stop('s', 'bundle', 0.5, 250), STREET), streetViewUrl(stop('s', 'bundle', 90, 250), STREET), streetViewUrl(stop('s', 'bundle', 14, 250), [])]) {
      expect(url).not.toContain('heading')
      expect(url).toContain('viewpoint=')
    }
  })
})

// ---- Photos stay with their stops ----

const info = (stopId: string, unusedSince?: number): PhotoInfo => ({ stopId, bytes: 10, savedAt: 1, ...(unusedSince === undefined ? {} : { unusedSince }) })

describe('photos of stops on no route', () => {
  it('are marked, kept a month, and only then removed', () => {
    expect(photoSweep([info('a')], new Set(), NOW)).toEqual({ mark: ['a'], clear: [], remove: [] })
    expect(photoSweep([info('a', NOW - UNUSED_DAYS * DAY + 1)], new Set(), NOW)).toEqual({ mark: [], clear: [], remove: [] })
    expect(photoSweep([info('a', NOW - UNUSED_DAYS * DAY)], new Set(), NOW)).toEqual({ mark: [], clear: [], remove: ['a'] })
  })

  it('are let off when the stop is back, however long it was away', () => {
    expect(photoSweep([info('a', NOW - 400 * DAY), info('b')], new Set(['a', 'b']), NOW)).toEqual({ mark: [], clear: ['a'], remove: [] })
  })

  it('are never removed the first time they are missed, or by a clock put back', () => {
    expect(photoSweep([info('a')], new Set(), Number.MAX_SAFE_INTEGER).remove).toEqual([])
    expect(photoSweep([info('a', NOW + DAY)], new Set(), NOW)).toEqual({ mark: ['a'], clear: [], remove: [] })
    expect(photoSweep([info('a', NaN)], new Set(), NOW)).toEqual({ mark: ['a'], clear: [], remove: [] })
  })
})

const STATS: RouteStats = { km: 1, mapKm: 1, closingKm: 0, closedKm: 1, left: 1, right: 0, both: 0, transit: 0, twiceKm: 0, uturns: 0, sideChanges: 0 }

describe('photos kept by stop id', () => {
  const route = routeOf(house.stop, drop.stop, block.stop, ask.stop)
  const saved = { ...makeRoute('Monday', route, 1) }
  const lib: Library = { routes: [saved], activeId: saved.id }
  const ids = ['b', 'h', 'k', 'r']
  const used = (l: Library) => [...stopIdsOf(l.routes)].sort()

  it('go with a copy of the route, and stay when either is deleted', () => {
    const two = duplicateRoute(lib, saved.id)
    expect(two.routes[1].route.stops.map((s) => s.id)).toEqual(route.stops.map((s) => s.id))
    expect(used(deleteRoute(two, two.routes[1].id))).toEqual(ids)
    expect(used(deleteRoute(two, saved.id))).toEqual(ids)
    expect(used(keepCopy(lib, saved, 'Old').library)).toEqual(ids)
  })

  it('are of no route once the only one is deleted, and are back when its backup is restored, replacing or beside another', () => {
    const gone = deleteRoute(lib, saved.id)
    expect(used(gone)).toEqual([])
    const back = parseBackup(makeBackup([toBackupRoute(saved)]))
    if (!back.ok) throw new Error(back.error)
    expect(used(addImported(gone, back.routes))).toEqual(ids)
    expect(used(addImported(lib, back.routes, 2, 'replace'))).toEqual(ids)
    expect(used(addImported(lib, back.routes, 2, 'keep'))).toEqual(ids)
  })

  it('stay with a stop that is edited or has its side set, and go with only the stops a stretch takes with it', () => {
    expect(updateStop(route, 'h', { label: 'New name' }).stops.map((s) => s.id)).toEqual(route.stops.map((s) => s.id))
    const split: Route = { ...route, sideChanges: [{ idx: 0, side: 'both' }, { idx: 1, side: 'left' }] }
    const cut = deleteSection(split, 1)
    expect(cut?.route.stops.map((s) => s.id).sort()).toEqual(ids)
    const without = editActiveRoute(lib, { ...route, stops: route.stops.filter((s) => s.id !== 'h') })
    expect(used(without)).toEqual(['b', 'k', 'r'])
    // Undo puts the route back as it was.
    expect(used(editActiveRoute(without, route))).toEqual(ids)
  })

  it('go with both the new route and the old one that Optimise Route keeps', () => {
    const points = [...STREET].reverse()
    const result: OptimiseResult = {
      route: { points, sideChanges: [{ idx: 0, side: 'both' }] },
      before: STATS,
      after: STATS,
      keepOrder: true,
      gaps: [],
      gapKm: 0,
      newRoads: [],
      newRoadKm: 0,
      turnBacks: [],
      blocked: [],
      notes: [],
      worthChecking: [],
      bundles: { before: [], after: [], changed: false, fits: true, stranded: [], store: null },
      streets: [],
      basedOn: basedOnOf(saved),
    }
    const outcome = acceptOptimised(lib, result, 1000)
    if (!outcome.ok) throw new Error(outcome.reason)
    for (const r of outcome.library.routes) expect(r.route.stops.map((s) => s.id).sort()).toEqual(ids)
    expect(outcome.library.routes).toHaveLength(2)
    expect(used(deleteRoute(outcome.library, outcome.kept.id))).toEqual(ids)
    expect(activeRoute(outcome.library).route.points).toEqual(points)
  })

  it('are not in a backup of the routes, which is what it was', () => {
    const text = makeBackup([toBackupRoute(saved)])
    expect(text).not.toContain('photo')
    expect(text).not.toContain('jpeg')
    expect(parseBackup(text)).toMatchObject({ ok: true })
  })
})

// ---- The photos file ----

const fileOf = (...photos: { stopId: string; jpeg: Uint8Array }[]) => photosFileStart(new Date(NOW)) + photos.map((p, i) => photosFileEntry(p, i === 0)).join('') + PHOTOS_FILE_END
const wrap = (photos: unknown, extra: object = {}) => JSON.stringify({ app: 'paper-round', kind: 'photos', version: 1, photos, ...extra })
const b64 = (bytes: Uint8Array) => btoa(textOf(bytes))

describe('the photos file', () => {
  it('reads back every photo as it was, with the stop it is of', () => {
    const big = jpegOf(JFIF, TABLE, frame(800, 600), HUFF, [...SCAN, ...Array.from({ length: 100_000 }, (_, i) => i % 200)])
    const result = parsePhotosFile(fileOf({ stopId: 'a', jpeg: JPEG }, { stopId: 'b "2"', jpeg: big }))
    if (!result.ok) throw new Error(result.error)
    expect(result.damaged).toBe(0)
    expect(result.photos.map((p) => p.stopId)).toEqual(['a', 'b "2"'])
    expect(result.photos[0].jpeg).toEqual(JPEG)
    expect(result.photos[1].jpeg).toEqual(big)
  })

  it('has the photos and their stops’ ids in it, and nothing else of the route', () => {
    const data = JSON.parse(fileOf({ stopId: 'a', jpeg: JPEG })) as { photos: object[] }
    expect(Object.keys(data)).toEqual(['app', 'kind', 'version', 'exportedAt', 'photos'])
    expect(Object.keys(data.photos[0])).toEqual(['stopId', 'jpeg'])
  })

  it('has the location taken out of every photo it gives back, whoever made it', () => {
    const result = parsePhotosFile(wrap([{ stopId: 'a', jpeg: b64(jpegOf(EXIF, JFIF, TABLE, frame(800, 600), HUFF, SCAN)) }]))
    if (!result.ok) throw new Error(result.error)
    expect(result.photos[0].jpeg).toEqual(JPEG)
  })

  it('leaves out photos that are damaged, and counts them, keeping the rest', () => {
    const result = parsePhotosFile(
      wrap([
        { stopId: 'a', jpeg: b64(JPEG) },
        { stopId: 'b', jpeg: 'not base64 !!' },
        { stopId: 'c', jpeg: b64(JPEG.slice(0, 20)) },
        { stopId: '', jpeg: b64(JPEG) },
        { stopId: 7, jpeg: b64(JPEG) },
        { stopId: 'x'.repeat(101), jpeg: b64(JPEG) },
        { stopId: 'd' },
        null,
        'e',
        { stopId: 'f', jpeg: btoa('<script>alert(1)</script>') },
      ]),
    )
    if (!result.ok) throw new Error(result.error)
    expect(result.photos.map((p) => p.stopId)).toEqual(['a'])
    expect(result.damaged).toBe(9)
  })

  it('takes the last of two for one stop', () => {
    const other = jpegOf(TABLE, frame(5, 5), SCAN)
    const result = parsePhotosFile(wrap([{ stopId: 'a', jpeg: b64(JPEG) }, { stopId: 'a', jpeg: b64(other) }]))
    expect(result).toMatchObject({ ok: true, photos: [{ stopId: 'a', jpeg: other }] })
  })

  it('says what is wrong with a file that is not one', () => {
    const error = (text: string) => {
      const r = parsePhotosFile(text)
      return r.ok ? 'ok' : r.error
    }
    for (const text of ['', 'hello', '[]', 'null', '{}', '{"app":"other"}', wrap('x'), '{"app":"paper-round","kind":"drive"}']) expect(error(text)).toBe("That isn't a Paper Round photos file.")
    const routes = makeBackup([toBackupRoute(makeRoute('Monday', routeOf(drop.stop), 1))])
    expect(error(routes)).toBe("That's a backup of your routes. Use Restore from Backup for it.")
    expect(error(routes.slice(routes.indexOf('{')))).toBe("That's a backup of your routes. Use Restore from Backup for it.")
    expect(error(wrap([]))).toBe('That file has no photos in it.')
    expect(error(wrap([{}]))).toBe('None of the photos in that file could be read.')
    expect(error(wrap([{}], { version: 2 }))).toContain('newer version')
    expect(error(wrap(Array.from({ length: MAX_PHOTOS + 1 }, () => ({}))))).toBe('That file has too many photos.')
  })

  it('is told apart from a backup of routes, which says where to take it', () => {
    const file = fileOf({ stopId: 'a', jpeg: JPEG })
    expect(isPhotosFile(file)).toBe(true)
    expect(parseBackup(file)).toEqual({ ok: false, error: PHOTOS_NOT_ROUTES })
    expect(isPhotosFile(makeBackup([toBackupRoute(makeRoute('Monday', routeOf(drop.stop), 1))]))).toBe(false)
  })

  it('is named for the day it was made', () => {
    expect(photosFileName(new Date(2026, 10, 5))).toBe('Paper Round photos - 2026-11-05.txt')
  })

  it('tells what became of it in plain words', () => {
    expect(restoreSummary({ saved: 1, failed: {} }, 0, 0)).toBe('1 photo restored.')
    expect(restoreSummary({ saved: 3, failed: { full: 2 } }, 1, 0)).toBe('3 photos restored. 2 were not kept, as this phone has no room left. 1 in the file was damaged and left out.')
    expect(restoreSummary({ saved: 0, failed: { blocked: 1 } }, 0, 0)).toBe("No photos were restored. 1 was not kept, as this phone isn't letting the app keep photos.")
    expect(restoreSummary({ saved: 4, failed: {} }, 0, 2)).toBe('4 photos restored. 2 are of stops on no route here: restore the route within 30 days and they come up with it.')
    expect(restoreSummary({ saved: 4, failed: {} }, 0, 1)).toContain('1 is of a stop on no route here: restore the route within 30 days and it comes up with it.')
  })

  it('has its size told as people read one', () => {
    expect([1, 84_400, 999_400, 999_900, 1_940_000].map(formatBytes)).toEqual(['1 KB', '84 KB', '999 KB', '1.0 MB', '1.9 MB'])
  })
})
