/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AlertPhoto } from './AlertPhoto'
import { BackUpPhotosDialog, RestorePhotosDialog } from './PhotoBackup'
import { PhotoDialog } from './PhotoDialog'
import type { PhotoInfo } from './photos'
import { RoundMenu } from './RoundMenu'
import { Routes } from './Routes'
import { makeRoute } from './library'
import { shrinkPhoto } from './shrinkPhoto'
import { StopsTab } from './StopsTab'
import { loadPhotoNoThrow, savePhotoNoThrow } from './storage'
import type { Stop } from './types'

/* What the photo screens would be told to draw. Nothing is mounted, and which photos there are is said by the test. */
const kept = vi.hoisted(() => ({ ids: [] as string[], url: null as string | null }))
// The map needs a page.
vi.mock('./MapView', () => ({ MapView: () => null }))
vi.mock('./usePhotos', () => ({
  usePhotoIds: () => new Set(kept.ids),
  usePhotoInfos: (): PhotoInfo[] => kept.ids.map((stopId) => ({ stopId, bytes: 100_000, savedAt: 1 })),
  usePhotoUrl: () => kept.url,
}))

afterEach(() => {
  kept.ids = []
  kept.url = null
  vi.unstubAllGlobals()
})

const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element)
const noop = () => undefined
const css = readFileSync(new URL('./photos.css', import.meta.url), 'utf8')
const POINTS = [
  { lat: 51, lng: 0 },
  { lat: 51.005, lng: 0 },
]
const stop = (type: Stop['type'], extra: Partial<Stop> = {}): Stop => ({ id: 's', type, pathIdx: 0, lat: 51.002, lng: 0.0002, ...extra })
const house = stop('nothrow', { address: '14 Oak Road' })

describe('the photo under an alert', () => {
  const photo = (s: Stop) => html(createElement(AlertPhoto, { stop: s, onPutAway: noop }))

  it('is nothing at all until there is one to show', () => {
    expect(photo(house)).toBe('')
  })

  it('stays hidden until the picture has been drawn, so no empty box comes up with the alert', () => {
    kept.url = 'blob:1'
    expect(photo(house)).toContain('hidden=""')
    expect(photo(house)).toContain('src="blob:1"')
  })

  it('is one button that puts it away, marked with which house it is of, in the colour of its alert', () => {
    kept.url = 'blob:1'
    const out = photo(house)
    expect(out.match(/<button/g)).toHaveLength(1)
    expect(out).toContain('class="alert-photo nothrow"')
    expect(out).toContain('aria-label="Photo of 14 Oak Road. Tap to put it away."')
    expect(out).toContain('<span class="alert-photo-tag">14</span>')
    expect(photo(stop('bundle', { label: 'Cafe' }))).toContain('class="alert-photo bundle"')
    for (const kind of ['nothrow', 'bundle', 'request', 'block']) expect(css).toContain(`.alert-photo.${kind} {`)
  })

  it('adds nothing for a screen reader to read out with the alert', () => {
    kept.url = 'blob:1'
    expect(photo(house)).toContain('alt=""')
    expect(photo(house)).not.toMatch(/role="(alert|status)"|aria-live/)
  })

  it('is small, at the left, and gives way before anything else in the column does', () => {
    const rule = css.slice(css.indexOf('.map-top > .alert-photo {'), css.indexOf('}', css.indexOf('.map-top > .alert-photo {')))
    expect(rule).toContain('--photo: 112px')
    expect(rule).toContain('flex: 0 1 var(--photo)')
    expect(rule).toContain('align-self: flex-start')
    expect(css).toMatch(/\.map-top:has\(\.alert-photo:not\(\[hidden\]\)\) > :not\(\.alert-photo\) \{\s*flex: none;/)
  })

  it('counts as up in the styles only once it is drawn', () => {
    expect(css.match(/:has\(\.alert-photo/g)!.length).toBe(css.match(/:has\(\.alert-photo:not\(\[hidden\]\)\)/g)!.length)
  })
})

describe('the photo of a stop, in Setup', () => {
  const dialog = (s: Stop) => html(createElement(PhotoDialog, { stop: s, points: POINTS, onClose: noop }))
  const onPhone = () => vi.stubGlobal('matchMedia', () => ({ matches: true }))

  it('takes one with the camera or chooses one, on a phone, and only chooses one on a computer', () => {
    onPhone()
    const phone = dialog(house)
    expect(phone).toContain('Take Photo')
    expect(phone).toContain('Choose Photo')
    expect(phone).toContain('capture="environment"')
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    expect(dialog(house)).not.toContain('Take Photo')
    expect(dialog(house)).toContain('Choose Photo')
  })

  it('can be chosen from the library, not only taken', () => {
    onPhone()
    const inputs = dialog(house).match(/<input[^>]*type="file"[^>]*>/g)!
    expect(inputs).toHaveLength(2)
    expect(inputs.filter((i) => i.includes('capture'))).toHaveLength(1)
    for (const i of inputs) expect(i).toContain('accept="image/*"')
  })

  it('offers to remove one only when there is one', () => {
    expect(dialog(house)).toContain('No photo yet')
    expect(dialog(house)).not.toContain('Remove Photo')
    kept.ids = ['s']
    expect(dialog(house)).toContain('Remove Photo')
    expect(dialog(house)).toContain('Opening the photo')
    kept.url = 'blob:1'
    expect(dialog(house)).toContain('src="blob:1"')
  })

  it('has the switch for no-throw houses only for one, as the others always show', () => {
    expect(dialog(house)).toContain('Photos of no-throw houses on the round')
    for (const type of ['bundle', 'request', 'block'] as const) expect(dialog(stop(type))).not.toContain('no-throw houses')
  })

  it('opens Street View by a plain link that tells Google nothing more, and only when it is tapped', () => {
    const out = dialog(house)
    const link = /<a [^>]*>/.exec(out)![0]
    expect(link).toContain('href="https://www.google.com/maps/@?api=1&amp;map_action=pano&amp;viewpoint=51.002%2C0.0002&amp;heading=90"')
    expect(link).toContain('target="_blank"')
    expect(link).toContain('rel="noopener noreferrer"')
    expect(link).toContain('referrerPolicy="no-referrer"')
    // Nothing of Google's is fetched: no picture, frame or script of theirs.
    expect(out.match(/google\.com/g)).toHaveLength(1)
    expect(out).not.toMatch(/<(iframe|script|link)/)
  })
})

describe('the list of stops in Setup', () => {
  const list = (stops: Stop[]) =>
    html(
      createElement(StopsTab, {
        route: { points: POINTS, sideChanges: [{ idx: 0, side: 'both' }], stops },
        type: 'nothrow',
        onType: noop,
        qty: '',
        onQty: noop,
        note: '',
        onNote: noop,
        label: '',
        onLabel: noop,
        address: '',
        onAddress: noop,
        placing: false,
        onPlacing: noop,
        canMark: false,
        onMarkHere: noop,
        onAdd: () => '',
        onPickSide: noop,
        onEdit: noop,
        onRemove: noop,
        onFocus: noop,
        onNotice: noop,
        onBack: noop,
        onNext: noop,
      }),
    )

  it('has a camera button for every stop, whatever kind it is, which says whether it has a photo', () => {
    kept.ids = ['a']
    const out = list((['bundle', 'nothrow', 'request', 'block'] as const).map((type, i) => stop(type, { id: 'abcd'[i], address: `${i + 1} Oak Road` })))
    expect(out.match(/class="icon-btn edit photo"/g)).toHaveLength(4)
    expect(out).toContain('data-on="true" aria-label="Photo of 1 Oak Road, and Street View"')
    expect(out.match(/aria-label="Add a photo of \d Oak Road, and Street View"/g)).toHaveLength(3)
    expect(out.match(/data-on="true" aria-label="Photo/g)).toHaveLength(1)
  })
})

describe('backing up and restoring photos', () => {
  it('is apart from the routes’ own, in Routes, with how many stops there have one', () => {
    const route = { ...makeRoute('Monday', { points: POINTS, sideChanges: [], stops: [house, stop('bundle', { id: 'b' })] }, 1) }
    const screen = () => html(createElement(Routes, { library: { routes: [route], activeId: route.id }, update: () => null, onGoSetup: noop }))
    expect(screen()).toContain('Back Up Photos')
    expect(screen()).toContain('Restore Photos')
    expect(screen()).toContain('Photos of your stops go in a file of their own')
    kept.ids = ['s', 'of no route']
    expect(screen()).toContain('1 stop has a photo. They go in a file of their own.')
  })

  it('says how many there are and how big, and which are of no route, to be kept for a month or deleted now', () => {
    kept.ids = ['a', 'b', 'c']
    const out = html(createElement(BackUpPhotosDialog, { used: new Set(['a']), onClose: noop }))
    expect(out).toContain('3 photos, 300 KB.')
    expect(out).toContain('2 photos are of stops on no route here any more. They are kept for 30 days')
    expect(out).toContain('Delete Them Now')
    expect(html(createElement(BackUpPhotosDialog, { used: new Set(['a', 'b', 'c']), onClose: noop }))).not.toContain('Delete')
  })

  it('says so when there are none', () => {
    const out = html(createElement(BackUpPhotosDialog, { used: new Set<string>(), onClose: noop }))
    expect(out).toContain('no photos on this phone yet')
    expect(out).not.toContain('Save File')
  })

  it('restores from a file', () => {
    vi.stubGlobal('navigator', {})
    const out = html(createElement(RestorePhotosDialog, { used: new Set<string>(), onClose: noop }))
    expect(out).toContain('Open File')
    expect(out).toContain('accept=".txt,.json,text/plain,application/json"')
  })
})

describe('the round’s menu', () => {
  it('has a row for photos of no-throw houses when there are any, with whether they show', () => {
    const menu = (extra: Partial<Parameters<typeof RoundMenu>[0]>) => html(createElement(RoundMenu, { alertDistance: 40, onClose: noop, onWholeRoute: noop, onSkip: noop, onAlertDistance: noop, onReset: noop, ...extra }))
    expect(menu({ noThrowPhotos: true })).not.toContain('Photos of no-throw houses')
    expect(menu({ noThrowPhotos: false, onNoThrowPhotos: noop })).toMatch(/Photos of no-throw houses.*>Off</)
    expect(menu({ noThrowPhotos: true, onNoThrowPhotos: noop })).toMatch(/Photos of no-throw houses.*>On</)
  })
})

describe('whether photos of no-throw houses show', () => {
  it('is off until it is turned on, is kept, and says when the phone will not keep it', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k, v) })
    expect(loadPhotoNoThrow()).toBe(false)
    expect(savePhotoNoThrow(true)).toBe(true)
    expect(loadPhotoNoThrow()).toBe(true)
    savePhotoNoThrow(false)
    expect(loadPhotoNoThrow()).toBe(false)
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('no room')
      },
    })
    expect(savePhotoNoThrow(true)).toBe(false)
  })
})

describe('making a photo ready to keep', () => {
  /** A page with a picture and a canvas, whose JPEGs come out as `sizes` says, best quality first. */
  function page({ opens = true, pen = true, width = 4032, height = 3024, sizes = [5000] }: { opens?: boolean; pen?: boolean; width?: number; height?: number; sizes?: number[] }) {
    const drawn: unknown[] = []
    const asked: number[] = []
    const revoked: string[] = []
    const exif = [0xff, 0xe1, 0, 12, ...[...'Exif\0\0GPS!'].map((c) => c.charCodeAt(0))]
    const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, ...exif, 0xff, 0xc0, 0, 11, 8, 2, 88, 3, 32, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, ...new Uint8Array(n), 0xff, 0xd9])
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:file', revokeObjectURL: (u: string) => revoked.push(u) })
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = width
        naturalHeight = height
        onload?: () => void
        onerror?: () => void
        set src(_: string) {
          setTimeout(() => (opens ? this.onload?.() : this.onerror?.()), 0)
        }
      },
    )
    vi.stubGlobal('document', {
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => (pen ? { fillRect: noop, drawImage: (...args: unknown[]) => drawn.push(args.slice(1)) } : null),
          toBlob: (give: (b: Blob | null) => void, type: string, quality: number) => {
            asked.push(quality)
            const n = sizes[asked.length - 1]
            give(n === undefined ? null : new Blob([jpeg(n)], { type }))
          },
        }
        return canvas
      },
    })
    return { drawn, asked, revoked }
  }

  it('draws it small, and leaves where it was taken behind', async () => {
    const p = page({})
    const jpeg = (await shrinkPhoto(new Blob(['x'])))!
    expect(p.drawn).toEqual([[0, 0, 800, 600]])
    expect(String.fromCharCode(...jpeg)).not.toContain('GPS')
    expect(jpeg.length).toBeLessThan(5100)
    expect(p.revoked).toEqual(['blob:file'])
  })

  it('keeps one that comes out too big at a lower quality, and the smallest it could get of one that always does', async () => {
    const twice = page({ sizes: [400_000, 150_000, 90_000] })
    expect((await shrinkPhoto(new Blob(['x'])))!.length).toBeLessThan(151_000)
    expect(twice.asked).toEqual([0.8, 0.65])
    page({ sizes: [400_000, 300_000, 250_000] })
    expect((await shrinkPhoto(new Blob(['x'])))!.length).toBeLessThan(251_000)
  })

  it('gives nothing for a file that is no picture, or on a phone that can not draw it, and never throws', async () => {
    const no = page({ opens: false })
    expect(await shrinkPhoto(new Blob(['x']))).toBeNull()
    expect(no.revoked).toEqual(['blob:file'])
    page({ pen: false })
    expect(await shrinkPhoto(new Blob(['x']))).toBeNull()
    page({ width: 0 })
    expect(await shrinkPhoto(new Blob(['x']))).toBeNull()
    page({ sizes: [] })
    expect(await shrinkPhoto(new Blob(['x']))).toBeNull()
    vi.stubGlobal('document', {
      createElement: () => {
        throw new Error('no room')
      },
    })
    expect(await shrinkPhoto(new Blob(['x']))).toBeNull()
  })
})
