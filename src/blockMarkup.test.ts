/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AlertBanner } from './AlertBanner'
import { alertSpeech } from './alerts'
import { BLOCK_GLYPH, BLOCK_MARK_PX, blockMarkClass, STOP_COLOR } from './colors'
import { StopsTab } from './StopsTab'
import type { Route, Stop } from './types'

/** A stylesheet as written. (Imported with `?raw` it comes out empty under the tests, which leave stylesheets out.) */
const sheet = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8')
const blockCss = sheet('./block.css')
const indexCss = sheet('./index.css')
const bundlesCss = sheet('./bundles.css')
const roundMenuCss = sheet('./roundMenu.css')

/** The markup a component gives, as text. Nothing is mounted: this is only what the screen would be told to draw. */
const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element)

const flats: Stop = { id: 'k1', type: 'block', lat: -33.87, lng: 151.2, pathIdx: 0, label: 'Lakeside Apartments', address: '12 Oak Road, Springfield', qty: 12 }
const bundle: Stop = { id: 'b1', type: 'bundle', lat: -33.87, lng: 151.2, pathIdx: 0, label: 'Lakeside Convenience Store', address: '12 Oak Road, Springfield', qty: 12 }

const alert = (stop: Stop, extra: Partial<Parameters<typeof AlertBanner>[0]> = {}): string =>
  html(createElement(AlertBanner, { stops: [stop], ahead: 120, side: 'left', waiting: 0, ...extra }))

/** The side tile of an alert, the arrow and the word. */
const sideTile = (out: string): string => /<div class="stop-alert-side">.*?<\/div>/.exec(out)?.[0] ?? ''

describe('a bundle drop with its alert up in the banner of another stop', () => {
  const house: Stop = { id: 'h1', type: 'nothrow', lat: -33.87, lng: 151.2, pathIdx: 0, label: '14 Oak Road' }
  const tap = () => {}

  it('has its name, papers and Dropped button in a strip at the foot, and the banner stays the house\'s', () => {
    const out = alert(house, { bundleUp: bundle, onDropped: tap })
    expect(out).toMatch(/class="stop-alert red\b/)
    expect(out).toContain('class="bundle-strip"')
    expect(out).toContain('Lakeside Convenience Store')
    expect(out).toContain('aria-label="Dropped: 12 Lakeside Convenience Store"')
    expect(out).toMatch(/<span class="stop-alert-qty">[^<]*12/)
  })

  it('has its button do what the banner was handed: it is the only way to confirm the bundle, and markup does not show it', () => {
    const onDropped = vi.fn()
    const drawn = (node: unknown): ReactElement<Record<string, unknown>>[] => {
      if (Array.isArray(node)) return node.flatMap(drawn)
      if (!isValidElement<Record<string, unknown>>(node)) return []
      if (typeof node.type === 'function') return drawn((node.type as (props: unknown) => unknown)(node.props))
      return [node, ...drawn(node.props.children)]
    }
    const button = drawn(AlertBanner({ stops: [house], ahead: 120, side: 'left', waiting: 0, bundleUp: bundle, onDropped })).find((e) => e.type === 'button')
    const press = button?.props.onClick as (() => void) | undefined
    press?.()
    expect(onDropped).toHaveBeenCalledTimes(1)
  })

  it('has the house number in front of the name, in the line and on the button, as its own banner has it on a plate', () => {
    const out = alert(house, { bundleUp: { ...bundle, label: undefined, address: '12 Main St' }, onDropped: tap })
    expect(out).toContain('<div class="bundle-strip-name">12 Main St</div>')
    expect(out).toContain('aria-label="Dropped: 12 Main St"')
  })

  it('has no number in front of a name with none', () => {
    const out = alert(house, { bundleUp: { ...bundle, address: undefined }, onDropped: tap })
    expect(out).toContain('<div class="bundle-strip-name">Lakeside Convenience Store</div>')
  })

  it('is not there with no button to give it', () => {
    expect(alert(house, { bundleUp: bundle })).not.toContain('bundle-strip')
  })

  it('has the name in the strip itself, and the strip stacked under the stop\'s details', () => {
    const out = alert(house, { bundleUp: bundle, onDropped: tap })
    expect(out).toContain('<div class="bundle-strip-name">12 Lakeside Convenience Store</div>')
    expect(out).toMatch(/class="stop-alert red[^"]*\bwith-block\b/)
    expect(out).toContain('<div class="block-body">')
  })

  it('has the bundle in the banner\'s label as well', () => {
    const out = alert(house, { bundleUp: bundle, onDropped: tap })
    expect(out).toContain(`aria-label="${alertSpeech([house], 'left')} ${alertSpeech([bundle], null)}"`.replace(/'/g, '&#x27;'))
  })

  it('is not there with no bundle up, or on a bundle\'s own banner', () => {
    expect(alert(house)).not.toContain('bundle-strip')
    expect(alert(bundle, { bundleUp: bundle, onDropped: tap })).not.toContain('bundle-strip')
  })

  it('has its button at least as big as on the bundle\'s own banner, and over the blue, which does not flash', () => {
    expect(bundlesCss).toMatch(/\.bundle-strip \{[^}]*background: #0a63d6/)
    expect(bundlesCss).toMatch(/\.stop-alert-drop \{[^}]*min-height: 58px/)
    expect(bundlesCss).toMatch(/\.stop-alert-drop \{[^}]*pointer-events: auto/)
  })

  it('keeps the menu as clear of the strip as the list, and both clearer of the tallest banner there is, a strip under a block\'s strip or two lines of plates', () => {
    const kept = (css: string, selector: string) => declared(media(css, 'not all and (orientation: landscape) and (max-height: 600px)'), selector, 'max-height')
    expect(kept(roundMenuCss, '.screen:has(.bundle-strip) .round-menu')).toBe('calc(100% - 330px)')
    expect(kept(roundMenuCss, '.screen:has(.stop-alert.ask) .round-menu')).toBe('calc(100% - 330px)')
    expect(kept(bundlesCss, '.screen:has(.bundle-strip) .bundles-sheet')).toBe('calc(100% - 330px)')
    for (const [css, name] of [[bundlesCss, '.bundles-sheet'], [roundMenuCss, '.round-menu']]) {
      expect(kept(css, `.screen:has(.bundle-strip):has(.block-strip) ${name}`)).toBe('calc(100% - 420px)')
      expect(kept(css, `.screen:has(.stop-alert.tall .bundle-strip) ${name}`)).toBe('calc(100% - 420px)')
    }
  })

  it('puts the name and the papers one over the other beside the button on a phone on its side, so another stop\'s banner does not push it under the bar along the bottom', () => {
    const side = media(bundlesCss, '(orientation: landscape) and (max-height: 600px)')
    expect(declared(side, '.bundle-strip', 'display')).toBe('grid')
    expect(declared(side, '.bundle-strip', 'grid-template-columns')).toBe('minmax(0, 1fr) auto')
    expect(declared(side, '.bundle-strip .stop-alert-act', 'display')).toBe('contents')
    expect(declared(side, '.bundle-strip-name', 'grid-column')).toBe('1')
    expect(declared(side, '.bundle-strip:not(:has(.stop-alert-qty)) .bundle-strip-name', 'grid-row')).toBe('1 / span 2')
    expect(declared(side, '.bundle-strip .stop-alert-qty', 'grid-column')).toBe('1')
    expect(declared(side, '.bundle-strip .stop-alert-drop', 'grid-column')).toBe('2')
    expect(declared(side, '.bundle-strip .stop-alert-drop', 'grid-row')).toBe('1 / span 2')
  })

  it('keeps a sheet opened over it clear of the taller banner', () => {
    expect(bundlesCss).toMatch(/\.screen:has\(\.bundle-strip\) \.bundles-sheet/)
  })
})

describe('the alert for an apartment block', () => {
  it('is titled Apartment block, in the alert for the stop, with the name and address', () => {
    const out = alert(flats)
    expect(out).toContain('<span class="stop-alert-title">Apartment block</span>')
    expect(out).toContain('Lakeside Apartments')
    expect(out).toContain('Oak Road, Springfield')
    expect(out).toContain('role="alert"')
  })

  it('is teal, and none of the colours the other alerts are', () => {
    const out = alert(flats)
    expect(out).toMatch(/class="stop-alert teal\b/)
    for (const other of ['blue', 'red', 'purple']) expect(out).not.toMatch(new RegExp(`class="stop-alert [^"]*\\b${other}\\b`))
    expect(alert(bundle)).toMatch(/class="stop-alert blue\b/)
  })

  it('shows how many papers to throw, big, in a panel of its own under its details', () => {
    const out = alert(flats)
    expect(out).toContain('<div class="block-papers"><span class="block-count">12</span> <span class="block-unit">papers</span></div>')
    // Under the details, not among them.
    expect(out.indexOf('block-papers')).toBeGreaterThan(out.indexOf('stop-alert-sub'))
    expect(out.slice(0, out.indexOf('block-papers'))).not.toContain('stop-alert-qty')
    expect(out).not.toContain('stop-alert-qty')
  })

  it('says one paper in the singular', () => {
    expect(alert({ ...flats, qty: 1 })).toContain('<span class="block-count">1</span> <span class="block-unit">paper</span>')
  })

  it('has no panel when there is no amount, and is still the apartment block alert, with its side', () => {
    const out = alert({ ...flats, qty: undefined })
    expect(out).not.toContain('block-papers')
    expect(out).not.toContain('block-count')
    expect(out).toContain('Apartment block')
    expect(out).toContain('Port')
  })

  it('shows the side as the bundle drop alert does, the same arrow and word, on the left', () => {
    const block = sideTile(alert(flats))
    expect(block).toContain('Port')
    expect(block).toBe(sideTile(alert(bundle)))
    expect(block).toMatch(/^<div class="stop-alert-side"><svg/)
  })

  it('puts the side at the right edge for a stop on the right, with the right arrow', () => {
    const out = alert(flats, { side: 'right' })
    expect(sideTile(out)).toContain('Starboard')
    expect(sideTile(out)).toBe(sideTile(alert(bundle, { side: 'right' })))
    expect(sideTile(out)).not.toBe(sideTile(alert(flats)))
    // The tile is after the text, at the right edge; for the left it comes before.
    expect(out.indexOf('stop-alert-side')).toBeGreaterThan(out.indexOf('stop-alert-text'))
    expect(alert(flats).indexOf('stop-alert-side')).toBeLessThan(alert(flats).indexOf('stop-alert-text'))
    expect(out).toMatch(/class="stop-alert teal right\b/)
  })

  it('shows a building in place of the side when the side cannot be told', () => {
    const out = alert(flats, { side: null })
    expect(out).not.toContain('stop-alert-side')
    const glyph = out.slice(out.indexOf('stop-alert-glyph'), out.indexOf('stop-alert-text'))
    expect(glyph).toContain(BLOCK_GLYPH)
    expect(glyph).toContain('aria-hidden="true"')
    // The bundle drop's box has the package, not the building.
    expect(alert(bundle, { side: null })).not.toContain(BLOCK_GLYPH)
  })

  it('has no button, and nothing to tap, even if it is given a way to be dropped', () => {
    for (const out of [alert(flats), alert(flats, { onDropped: () => undefined }), alert(flats, { side: 'right', waiting: 2 })]) {
      expect(out).not.toContain('<button')
      expect(out).not.toContain('stop-alert-drop')
      expect(out).not.toContain('Dropped')
      expect(out).not.toContain('stop-alert-act')
      expect(out).not.toMatch(/class="stop-alert [^"]*\bask\b/)
      expect(out).not.toContain('onclick')
    }
    // Where a bundle drop with the same props has its button.
    expect(alert(bundle, { onDropped: () => undefined })).toContain('stop-alert-drop')
  })

  it('says all of it to a screen reader, in the label of the alert: the stop, its papers and its side', () => {
    const named: Stop = { ...flats, address: 'Oak Road, Springfield' }
    expect(alert(named, { side: 'left' })).toContain('role="alert" aria-label="Apartment block, Lakeside Apartments, 12 papers, port."')
    expect(alert({ ...named, label: undefined, address: undefined }, { side: 'right' })).toContain('aria-label="Apartment block, 12 papers, starboard."')
    expect(alert({ ...named, qty: undefined }, { side: 'right' })).toContain('aria-label="Apartment block, Lakeside Apartments, starboard."')
    // With a house number, the number is said first, as for the other stops.
    expect(alert({ ...flats, qty: 30 }, { side: 'left' })).toContain('aria-label="Apartment block, 12, 30 papers, port."')
  })

  it('says nothing of a side in the label when it cannot be told', () => {
    expect(alert({ ...flats, label: undefined, address: undefined }, { side: null })).toContain('aria-label="Apartment block, 12 papers."')
  })

  it('hides the distance, which changes as the driver approaches, from a screen reader, like the other alerts', () => {
    expect(alert(flats)).toContain('<span class="stop-alert-dist" aria-hidden="true">120 m</span>')
  })

  it('tells the house number on a plate, apart from the name and the address', () => {
    const out = alert({ ...flats, address: '12 Oak Road, Springfield' })
    expect(out).toContain('aria-label="House number 12"')
    expect(out).toContain('>12</span>')
    expect(out).not.toContain('>12 Oak Road')
  })

  it('keeps the whole of a long name and address in the markup, for the stylesheet to clamp, and says how many alerts are waiting', () => {
    const long = { ...flats, label: 'The Lakeside Gardens and Riverside Terraces Apartments, Block C', address: '123/45-47 Bartholomew Montgomery Crescent, North Springfield Heights' }
    const out = alert(long, { waiting: 3, pass: 2 })
    expect(out).toContain('The Lakeside Gardens and Riverside Terraces Apartments, Block C')
    expect(out).toContain('Bartholomew Montgomery Crescent')
    expect(out).toContain('pass 2')
    expect(out).toContain('aria-label="3 more waiting"')
    expect(out).toContain('<div class="block-papers">')
  })

  it('lets the name wrap in the box and the title stay whole, as the other alerts do', () => {
    // The title is a single line that is cut with an ellipsis only as a last resort, and the name takes the room left.
    expect(declared(indexCss, '.stop-alert-title', 'white-space')).toBe('nowrap')
    expect(declared(indexCss, '.stop-alert-name', 'overflow-wrap')).toBe('anywhere')
    expect(declared(indexCss, '.stop-alert-text', 'min-width')).toBe('0')
    expect(declared(blockCss, '.block-body', 'min-width')).toBe('0')
  })
})

describe('an apartment block in the banner of a no-throw house', () => {
  const house = (n: number): Stop => ({ id: `h${n}`, type: 'nothrow', lat: -33.87, lng: 151.2, pathIdx: 0, address: `${n} Elm Street` })
  const named: Stop = { ...flats, address: 'Oak Road, Springfield' }
  const banner = (extra: Partial<Parameters<typeof AlertBanner>[0]> = {}): string =>
    html(createElement(AlertBanner, { stops: [house(14), house(16)], ahead: 30, side: 'left', waiting: 0, blockAhead: { stop: named, side: 'left' }, ...extra }))
  /** The strip, from its start to the end of the banner. */
  const strip = (out: string): string => (out.includes('block-strip') ? out.slice(out.indexOf('<div class="block-strip')) : '')

  it('is a teal strip under the row of houses, in the red banner, with the papers and the side', () => {
    const out = banner()
    expect(out).toMatch(/class="stop-alert red\b[^"]*\bwith-block\b/)
    // The houses keep their plates, above the strip.
    expect(out).toContain('<span class="stop-alert-num">14</span>')
    expect(out).toContain('<span class="stop-alert-num">16</span>')
    expect(out.indexOf('stop-alert-plates')).toBeLessThan(out.indexOf('block-strip'))
    const s = strip(out)
    expect(s).toMatch(/^<div class="block-strip">/)
    expect(s).toContain('<div class="block-strip-title">Apartment block</div>')
    expect(s).toContain('<span class="block-strip-count">12</span><span class="block-strip-unit">papers</span>')
    expect(s).toMatch(/<div class="block-strip-side"><svg[^]*?<\/svg>Port<\/div>/)
    // The side comes first, at the left edge.
    expect(s.indexOf('block-strip-side')).toBeLessThan(s.indexOf('block-strip-title'))
  })

  it('is not there without a block, and the banner is then just as it was', () => {
    const without = banner({ blockAhead: undefined })
    expect(without).not.toContain('block-strip')
    expect(without).not.toContain('with-block')
    expect(without).toBe(html(createElement(AlertBanner, { stops: [house(14), house(16)], ahead: 30, side: 'left', waiting: 0 })))
  })

  it('says the block in the label of the banner, after the houses, with its papers and side', () => {
    expect(banner()).toContain('role="alert" aria-label="No throw, 14, 16. Apartment block, Lakeside Apartments, 12 papers, port."')
    expect(banner({ blockAhead: { stop: named, side: null } })).toContain('aria-label="No throw, 14, 16. Apartment block, Lakeside Apartments, 12 papers."')
  })

  it('has the side at the right edge for a block on the right, whichever side the houses are', () => {
    const s = strip(banner({ blockAhead: { stop: named, side: 'right' } }))
    expect(s).toMatch(/^<div class="block-strip right">/)
    expect(s).toMatch(/<div class="block-strip-side"><svg[^]*?<\/svg>Starboard<\/div>/)
    expect(s.indexOf('block-strip-side')).toBeGreaterThan(s.indexOf('block-strip-papers'))
  })

  it('has a building in place of the side when the side cannot be told', () => {
    const s = strip(banner({ blockAhead: { stop: named, side: null } }))
    expect(s).not.toContain('block-strip-side')
    expect(s).toContain('block-strip-glyph')
    expect(s).toContain(BLOCK_GLYPH)
  })

  it('leaves the count out for a block with no amount, and says one paper in the singular', () => {
    expect(strip(banner({ blockAhead: { stop: { ...named, qty: undefined }, side: 'left' } }))).not.toContain('block-strip-papers')
    expect(strip(banner({ blockAhead: { stop: { ...named, qty: 0 }, side: 'left' } }))).not.toContain('block-strip-papers')
    expect(strip(banner({ blockAhead: { stop: { ...named, qty: 1 }, side: 'left' } }))).toContain('<span class="block-strip-count">1</span><span class="block-strip-unit">paper</span>')
  })

  it('is in the banner of a single house as of a row', () => {
    const out = banner({ stops: [house(14)] })
    expect(strip(out)).toContain('<span class="block-strip-count">12</span>')
    expect(out).toContain('aria-label="No throw, 14. Apartment block, Lakeside Apartments, 12 papers, port."')
  })

  it('is never in the banner of a block of its own, which has its papers already', () => {
    const out = alert(flats, { blockAhead: { stop: named, side: 'left' } })
    expect(out).not.toContain('block-strip')
    expect(out).not.toContain('with-block')
  })

  it('has nothing to tap', () => {
    expect(strip(banner())).not.toContain('<button')
  })
})

describe('an apartment block in the banner of a bundle drop or a special request', () => {
  const named: Stop = { ...flats, address: 'Oak Road, Springfield' }
  const request: Stop = { id: 'r', type: 'request', lat: -33.87, lng: 151.2, pathIdx: 0, address: 'Elm Street', note: 'Blue gate, deliver by hand' }

  it("is a teal strip in the bundle drop's banner, between its details and its Dropped button, which stays", () => {
    const out = alert(bundle, { blockAhead: { stop: named, side: 'left' }, onDropped: () => undefined })
    expect(out).toMatch(/class="stop-alert blue\b[^"]*\bask\b[^"]*\bwith-block\b/)
    expect(out).toContain('<span class="block-strip-count">12</span><span class="block-strip-unit">papers</span>')
    // The bundle's details, then the strip, then the papers and the button.
    expect(out.indexOf('stop-alert-body')).toBeLessThan(out.indexOf('block-strip'))
    expect(out.indexOf('block-strip')).toBeLessThan(out.indexOf('stop-alert-act'))
    expect(out.indexOf('block-strip')).toBeLessThan(out.indexOf('stop-alert-drop'))
    expect(out).toContain('aria-label="Dropped: Lakeside Convenience Store"')
    // The label says the bundle and then the block, with its papers and its side.
    expect(out).toContain(`aria-label="${alertSpeech([bundle], 'left')} ${alertSpeech([named], 'left')}"`)
    expect(out).toContain('Apartment block, Lakeside Apartments, 12 papers, port."')
  })

  it("is a teal strip under the special request's note", () => {
    const out = alert(request, { blockAhead: { stop: named, side: 'right' } })
    expect(out).toMatch(/class="stop-alert purple\b[^"]*\bwith-block\b/)
    expect(out.indexOf('Blue gate, deliver by hand')).toBeLessThan(out.indexOf('block-strip'))
    expect(out).toContain('<div class="block-strip right">')
    expect(out).toContain('Apartment block, Lakeside Apartments, 12 papers, starboard."')
    expect(out).not.toContain('<button')
  })

  it('leaves either banner as it was without a block', () => {
    const plain = alert(bundle, { onDropped: () => undefined })
    expect(plain).not.toContain('block-strip')
    expect(plain).not.toContain('with-block')
    expect(alert(request)).not.toContain('with-block')
  })
})

/** The value of a property in the first rule of a stylesheet whose selector is exactly `selector`, inside or outside a media query. */
function declared(css: string, selector: string, property: string): string | null {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')
  const rule = new RegExp(`(?:^|[}{])\\s*${escaped}\\s*{([^}]*)}`).exec(rules)
  const value = rule ? new RegExp(`(?:^|;|\\s)${property.replace(/-/g, '\\-')}\\s*:\\s*([^;]+)`).exec(rule[1]) : null
  return value ? value[1].trim() : null
}

/** What is inside the first `@media` whose condition is exactly `query`. */
function media(css: string, query: string): string {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const start = rules.indexOf(`@media ${query} {`)
  if (start < 0) return ''
  let depth = 0
  for (let i = rules.indexOf('{', start); i < rules.length; i++) {
    if (rules[i] === '{') depth++
    if (rules[i] === '}' && --depth === 0) return rules.slice(rules.indexOf('{', start) + 1, i)
  }
  return ''
}

const luminance = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const hue = (hex: string): number => {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return 0
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return (h * 60 + 360) % 360
}
const hueGap = (a: string, b: string): number => {
  const d = Math.abs(hue(a) - hue(b))
  return Math.min(d, 360 - d)
}
const px = (value: string | null): number => Number.parseFloat(value ?? 'NaN')

describe('the stylesheet of the apartment block alert', () => {
  const tealLight = declared(blockCss, '.stop-alert.teal', '--teal')!
  const tealDark = declared(media(blockCss, '(prefers-color-scheme: dark)'), '.stop-alert.teal', '--teal')!
  const others = ['blue', 'red', 'purple'].map((name) => declared(indexCss, `.stop-alert.${name}`, 'background')!)

  it('paints the alert in its own teal, in light and in dark', () => {
    expect(tealLight).toMatch(/^#[0-9a-f]{6}$/)
    expect(tealDark).toMatch(/^#[0-9a-f]{6}$/)
    expect(declared(blockCss, '.stop-alert.teal', 'background')).toBe('var(--teal)')
  })

  it('has white type on it that reads, in both appearances', () => {
    expect(contrast(tealLight, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrast(tealDark, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    // The house number's plate is white with the banner's colour on it: the same ratio.
    expect(declared(blockCss, '.stop-alert.teal .stop-alert-num', 'color')).toBe('var(--teal)')
  })

  it('is not the colour of the other alerts: a blue-green a clear step from the blue, red and purple', () => {
    expect(others.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true)
    for (const [i, other] of others.entries()) {
      for (const teal of [tealLight, tealDark]) {
        expect(teal).not.toBe(other)
        expect(hueGap(teal, other), `${teal} against ${['blue', 'red', 'purple'][i]}`).toBeGreaterThanOrEqual(30)
      }
    }
    expect(hue(tealLight)).toBeGreaterThan(165)
    expect(hue(tealLight)).toBeLessThan(190)
  })

  it('is the colour of the marker on the map, in a shade deeper for the text', () => {
    expect(hueGap(tealLight, STOP_COLOR.block)).toBeLessThan(10)
    expect(luminance(tealLight)).toBeLessThan(luminance(STOP_COLOR.block))
  })

  it('takes no touch: nothing in it asks for pointer events, and the alert it is part of lets them through', () => {
    expect(blockCss).not.toMatch(/pointer-events\s*:\s*(auto|all|visible)/)
    expect(declared(indexCss, '.stop-alert', 'pointer-events')).toBe('none')
    // Where the Dropped button is the one part that does.
    expect(declared(bundlesCss, '.stop-alert-drop', 'pointer-events')).toBe('auto')
  })

  it('has the papers bigger than a bundle drop papers panel, and the word beside the count', () => {
    const count = px(declared(blockCss, '.block-count', 'font-size'))
    expect(count).toBeGreaterThanOrEqual(34)
    expect(count).toBeGreaterThan(px(declared(bundlesCss, '.stop-alert.ask .stop-alert-qty', 'font-size')))
    expect(px(declared(blockCss, '.block-unit', 'font-size'))).toBeLessThan(count)
    expect(declared(blockCss, '.block-papers', 'white-space')).toBe('nowrap')
    expect(declared(blockCss, '.block-papers', 'display')).toBe('flex')
    // A pale panel like the side tile, so it is not taken for a button.
    expect(declared(blockCss, '.block-papers', 'background')).toBe('rgba(255, 255, 255, 0.2)')
  })

  it('lays the details across the top in a row that can shrink, with the side tile as the bundle drop alert has it', () => {
    expect(declared(blockCss, '.stop-alert.teal', 'flex-direction')).toBe('column')
    expect(declared(blockCss, '.block-body', 'display')).toBe('flex')
    expect(px(declared(blockCss, '.stop-alert.teal .stop-alert-side', 'height'))).toBeGreaterThanOrEqual(50)
  })

  it('has a size down for the narrowest phones (320 px), so the title still fits beside the distance and the count beside its word', () => {
    const narrow = media(blockCss, '(max-width: 360px)')
    expect(narrow).not.toBe('')
    expect(px(declared(narrow, '.block-count', 'font-size'))).toBeLessThan(px(declared(blockCss, '.block-count', 'font-size')))
    expect(px(declared(narrow, '.block-count', 'font-size'))).toBeGreaterThanOrEqual(34)
    expect(px(declared(narrow, '.stop-alert.teal .stop-alert-side', 'width'))).toBeLessThan(px(declared(blockCss, '.stop-alert.teal .stop-alert-side', 'width')))
    expect(px(declared(narrow, '.stop-alert.teal .stop-alert-dist', 'font-size'))).toBeLessThan(px(declared(blockCss, '.stop-alert.teal .stop-alert-dist', 'font-size')))
    // The widest the papers can be: four digits and the word, in the narrowest banner (320 less the screen's 12 px and the banner's 10 px at each side).
    const room = 320 - 2 * 12 - 2 * 10 - 2 * 14
    const digits = 4 * px(declared(narrow, '.block-count', 'font-size')) * 0.6
    const word = 6 * px(declared(narrow, '.block-unit', 'font-size')) * 0.6
    expect(digits + word + 8).toBeLessThan(room)
  })

  it('has room for the title whole, with a count of waiting alerts and the distance beside it, from 320 px up', () => {
    // Measured in a browser, in the system font at weight 800: "Apartment block" is 8 em wide, a "+2" badge 30 px, "120 m" 2.5 em, with 8 px between.
    const narrow = media(blockCss, '(max-width: 360px)')
    const size = (property: string, selector: string, inNarrow: boolean) => px((inNarrow ? declared(narrow, selector, property) : null) ?? declared(blockCss, selector, property))
    for (const width of [320, 340, 360, 361, 375, 390, 414, 430]) {
      const small = width <= 360
      const padding = small ? px(/padding:\s*\d+px (\d+)px/.exec(narrow)![1]) : 12
      const tile = size('width', '.stop-alert.teal .stop-alert-side', small)
      const gap = size('gap', '.block-body', small)
      const text = width - 2 * 12 - 2 * padding - tile - gap
      const title = size('font-size', '.stop-alert.teal .stop-alert-title', small)
      const dist = size('font-size', '.stop-alert.teal .stop-alert-dist', small)
      expect(8 * title + 30 + 2.5 * dist + 2 * 8, `${width} px`).toBeLessThanOrEqual(text)
    }
  })

  it('is a little tighter on a phone on its side, which has little height', () => {
    const landscape = media(blockCss, '(orientation: landscape) and (max-height: 600px)')
    expect(px(declared(landscape, '.block-count', 'font-size'))).toBeLessThan(px(declared(blockCss, '.block-count', 'font-size')))
    expect(px(declared(landscape, '.block-count', 'font-size'))).toBeGreaterThanOrEqual(30)
  })

  it('keeps the list of bundles and the menu clear of it when they come up over it, as they are of the Dropped button', () => {
    const portrait = media(blockCss, 'not all and (orientation: landscape) and (max-height: 600px)')
    expect(portrait).toContain('.screen:has(.stop-alert.teal) .bundles-sheet')
    expect(portrait).toContain('.screen:has(.stop-alert.teal) .round-menu')
    expect(portrait).toMatch(/max-height:\s*calc\(100% - 330px\)/)
  })
})

describe('the stylesheet of the block in a no-throw house banner', () => {
  // The strip's own rules, from where they start: its dark shade is in a media query after its light one, so it wins in dark mode.
  const stripCss = blockCss.slice(blockCss.indexOf('.block-strip {'))
  const tealLight = declared(stripCss, '.block-strip', '--teal')!
  const tealDark = declared(media(stripCss, '(prefers-color-scheme: dark)'), '.block-strip', '--teal')!

  it('is the teal of the block own banner, in light and in dark, with white type that reads on it', () => {
    expect(declared(stripCss, '.block-strip', 'background')).toBe('var(--teal)')
    expect(tealLight).toBe(declared(blockCss, '.stop-alert.teal', '--teal'))
    expect(tealDark).toBe(declared(media(blockCss, '(prefers-color-scheme: dark)'), '.stop-alert.teal', '--teal'))
    expect(contrast(tealLight, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrast(tealDark, '#ffffff')).toBeGreaterThanOrEqual(4.5)
  })

  it('lays the banner out with the houses across the top and the strip across the width under them', () => {
    expect(declared(blockCss, '.stop-alert.with-block', 'flex-direction')).toBe('column')
    expect(declared(blockCss, '.stop-alert.with-block', 'align-items')).toBe('stretch')
    expect(declared(blockCss, '.block-strip', 'display')).toBe('flex')
    expect(declared(blockCss, '.block-strip', 'white-space')).toBe('nowrap')
    expect(declared(blockCss, '.block-strip-title', 'min-width')).toBe('0')
    expect(declared(blockCss, '.block-strip-title', 'text-overflow')).toBe('ellipsis')
  })

  it('has the count bigger than the title, and a side tile of 44 px or more', () => {
    expect(px(declared(blockCss, '.block-strip-count', 'font-size'))).toBeGreaterThan(px(declared(blockCss, '.block-strip-title', 'font-size')))
    expect(px(declared(blockCss, '.block-strip-side', 'height'))).toBeGreaterThanOrEqual(44)
  })

  it('has room for the title whole beside the side and three figures of papers, from 320 px up', () => {
    // As measured for the block's own banner: "Apartment block" is 8 em wide; a figure is 0.6 em, as is a letter of "papers".
    const narrow = media(stripCss, '(max-width: 360px)')
    const size = (property: string, selector: string, inNarrow: boolean) => px((inNarrow ? declared(narrow, selector, property) : null) ?? declared(blockCss, selector, property))
    /** The padding at the left and right of a `padding` value of two or three lengths. */
    const across = (value: string | null) => px(value?.split(/\s+/)[1] ?? null)
    for (const width of [320, 340, 360, 361, 375, 390, 414, 430]) {
      const small = width <= 360
      const padding = across(declared(small ? narrow : blockCss, '.stop-alert.with-block', 'padding'))
      const inside = across(declared(blockCss, '.block-strip', 'padding'))
      const room = width - 2 * 12 - 2 * padding - 2 * inside
      const gap = px(declared(blockCss, '.block-strip', 'gap'))
      const papers = Math.max(3 * size('font-size', '.block-strip-count', small), 6 * size('font-size', '.block-strip-unit', small)) * 0.6 + 8
      const title = 8 * size('font-size', '.block-strip-title', small)
      expect(px(declared(blockCss, '.block-strip-side', 'width')) + gap + title + gap + papers, `${width} px`).toBeLessThanOrEqual(room)
    }
  })

  it('keeps the list of bundles and the menu clear of the taller banner when they come up over it', () => {
    const portrait = media(blockCss, 'not all and (orientation: landscape) and (max-height: 600px)')
    expect(portrait).toContain('.screen:has(.block-strip) .bundles-sheet')
    expect(portrait).toContain('.screen:has(.block-strip) .round-menu')
    expect(media(blockCss, '(orientation: portrait) and (max-height: 720px)')).toContain('.screen:has(.block-strip) .bundles-summary')
  })

  it("keeps them clear of a bundle drop's banner with the strip too, by the strip's height and gap more than under a Dropped button", () => {
    const portrait = media(blockCss, 'not all and (orientation: landscape) and (max-height: 600px)')
    const kept = (css: string, selector: string) => px(/calc\(100% - (\d+)px\)/.exec(declared(css, selector, 'max-height') ?? '')?.[1] ?? null)
    const underButton = kept(media(bundlesCss, 'not all and (orientation: landscape) and (max-height: 600px)'), '.screen:has(.stop-alert.ask) .bundles-sheet')
    const strip = px(declared(blockCss, '.block-strip', 'min-height')) + px(declared(blockCss, '.stop-alert.ask.with-block', 'gap'))
    for (const selector of ['.screen:has(.stop-alert.ask.with-block) .bundles-sheet', '.screen:has(.stop-alert.ask.with-block) .round-menu']) {
      expect(portrait).toContain(selector)
    }
    expect(px(/\.screen:has\(\.stop-alert\.ask\.with-block\) \.round-menu\s*{\s*max-height:\s*calc\(100% - (\d+)px\)/.exec(portrait)?.[1] ?? null)).toBeGreaterThanOrEqual(
      underButton + strip,
    )
    expect(underButton).toBe(330)
  })

  it("lays a bundle drop's banner with a strip out as a column, with the strip's gap and padding whichever stylesheet comes first", () => {
    expect(declared(bundlesCss, '.stop-alert.ask', 'flex-direction')).toBe('column')
    const stripCss = blockCss.slice(blockCss.indexOf('.block-strip {'))
    for (const [css, what] of [
      [blockCss, 'on a phone'],
      [media(stripCss, '(max-width: 360px)'), 'on the narrowest phones'],
      [media(stripCss, '(orientation: landscape) and (max-height: 600px)'), 'on a phone on its side'],
    ] as const) {
      for (const property of ['gap', 'padding']) {
        const plain = declared(css, '.stop-alert.with-block', property)
        const bundle = declared(css, '.stop-alert.ask.with-block', property) ?? (property === 'padding' && css === blockCss ? declared(bundlesCss, '.stop-alert.ask', property) : null)
        expect(bundle, `${property} ${what}`).toBe(plain)
      }
    }
  })
})

describe('the stylesheet of the marker on the map', () => {
  it('is a rounded square in the colour of the stop, with a white edge and a white building, not a circle', () => {
    expect(declared(blockCss, '.block-mark > span', 'background')?.toLowerCase()).toBe(STOP_COLOR.block)
    expect(declared(blockCss, '.block-mark > span', 'border')).toBe('3px solid #fff')
    expect(declared(blockCss, '.block-mark > span', 'color')).toBe('#fff')
    const radius = px(declared(blockCss, '.block-mark > span', 'border-radius'))
    expect(radius).toBeGreaterThan(0)
    expect(radius).toBeLessThan(px(declared(blockCss, '.block-mark > span', 'width')) / 2)
  })

  it('is the size of the circles the other stops are drawn as, and a little over, and is as big as the map is told it is', () => {
    // A circle of radius 12 with a 3 px edge is 27 px across.
    expect(px(declared(blockCss, '.block-mark > span', 'width'))).toBeGreaterThanOrEqual(27)
    expect(px(declared(blockCss, '.block-mark > span', 'width'))).toBeLessThanOrEqual(32)
    expect(px(declared(blockCss, '.block-mark > span', 'width'))).toBe(BLOCK_MARK_PX)
    expect(px(declared(blockCss, '.block-mark > span', 'height'))).toBe(BLOCK_MARK_PX)
  })

  it('is styled by the classes the map gives the marker', () => {
    expect(blockCss).toContain(`.${blockMarkClass(false)} > span`)
    expect(blockCss).toContain(`.${blockMarkClass(true).replace(' ', '.')} > span`)
  })

  it('is turned back by however far the map is turned, so the building stays upright', () => {
    expect(declared(blockCss, '.block-mark > span', 'transform')).toBe('rotate(var(--unrot, 0deg))')
  })

  it('is faded once it is done', () => {
    expect(px(declared(blockCss, '.block-mark.done > span', 'opacity'))).toBeLessThan(0.7)
  })
})

describe('the choice of kind of stop', () => {
  const road: Route = {
    points: Array.from({ length: 6 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 })),
    sideChanges: [{ idx: 0, side: 'left' }],
    stops: [],
  }
  const noop = () => undefined
  const tab = (extra: Partial<Parameters<typeof StopsTab>[0]> = {}): string =>
    html(
      createElement(StopsTab, {
        route: road,
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
        ...extra,
      }),
    )
  const types = ['nothrow', 'bundle', 'request', 'block'] as const
  const labels = { nothrow: 'No-Throw', bundle: 'Bundle Drop', request: 'Special Request', block: 'Apartment Block' }

  it('offers the four kinds, with an apartment block called Apartment Block', () => {
    const out = tab()
    for (const label of Object.values(labels)) expect(out).toContain(`>${label}</button>`)
    expect(out).toContain('aria-label="Type of stop"')
  })

  it('has each kind chosen when it is the type, and only that one', () => {
    for (const type of types) {
      const out = tab({ type })
      const pressed = [...out.matchAll(/<button type="button" aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)]
      expect(pressed.filter((m) => m[1] === 'true').map((m) => m[2]), type).toEqual([labels[type]])
      expect(pressed.map((m) => m[2]), type).toEqual(Object.values(labels))
    }
  })

  it('lays the four out two by two on a phone, each at least 42 px tall', () => {
    expect(tab()).toContain('<div class="stop-types"><div class="segmented many"')
    expect(declared(blockCss, '.stop-types .segmented', 'grid-template-columns')).toBe('1fr 1fr')
    expect(px(declared(blockCss, '.stop-types .segmented.many button', 'min-height'))).toBeGreaterThanOrEqual(42)
    expect(declared(blockCss, '.stop-types .segmented.many button', 'white-space')).toBe('normal')
  })

  it('asks for the papers when placing an apartment block, as for a bundle drop, and not for the other kinds', () => {
    const papers = '<span class="title">Papers</span>'
    expect(tab({ type: 'block' })).toContain(papers)
    expect(tab({ type: 'bundle' })).toContain(papers)
    expect(tab({ type: 'nothrow' })).not.toContain(papers)
    expect(tab({ type: 'request' })).not.toContain(papers)
  })

  it('asks for a name of the apartment block, not a business name or a note', () => {
    const out = tab({ type: 'block' })
    expect(out).toContain('<span class="title">Name</span>')
    expect(out).toContain('placeholder="e.g. Lakeside Apartments"')
    expect(out).not.toContain('Business name')
    expect(out).not.toContain('<span class="title">Note</span>')
    expect(out).toContain('how many papers to throw there')
  })
})

describe('the list of stops on the route', () => {
  const house = (id: string, lat: number, lng: number, extra: Partial<Stop> = {}): Stop => ({ id, type: 'nothrow', lat, lng, pathIdx: 2, ...extra })
  const road = (side: 'left' | 'right' | 'both' | 'transit', ...stops: Stop[]): Route => ({
    points: Array.from({ length: 6 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 })),
    sideChanges: [{ idx: 0, side }],
    stops,
  })
  const noop = () => undefined
  const list = (route: Route): string =>
    html(
      createElement(StopsTab, {
        route,
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
  /** The rows of the list of stops, each as its markup. */
  const rows = (out: string): string[] => out.split('<li class="row stop-row"').slice(1)
  /** The side chip of a row: its label and whether it is asking for attention. */
  const chip = (row: string): { label: string; warn: boolean } => {
    const m = /<button class="chip-btn"([^>]*)>([^<]*)<\/button>/.exec(row)!
    return { label: m[2], warn: m[1].includes('data-warn="true"') }
  }

  it('lists an apartment block with its name, the papers it gets and the teal of its marker', () => {
    const [row] = rows(list(road('left', { id: 'k', type: 'block', lat: 51.0025, lng: 0.0003, pathIdx: 2, label: 'Lakeside Apartments', address: '12 Oak Road', qty: 12 })))
    expect(row).toContain('Lakeside Apartments')
    expect(row).toContain('12 papers')
    expect(row).toContain(`background:${STOP_COLOR.block}`)
    expect(row).not.toContain('warn-text')
    expect(row).toContain('aria-label="Edit Lakeside Apartments"')
  })

  it('flags an apartment block that has no amount, as it does a bundle drop', () => {
    const [block, bundleRow] = rows(
      list(road('left', { id: 'k', type: 'block', lat: 51.0025, lng: 0.0003, pathIdx: 2 }, { id: 'b', type: 'bundle', lat: 51.0035, lng: 0.0003, pathIdx: 3 })),
    )
    expect(block).toContain('<span class="warn-text">no amount set</span>')
    expect(bundleRow).toContain('<span class="warn-text">no amount set</span>')
    expect(block).toContain('Apartment block')
  })

  it('shows the side an apartment block is on, and asks for one when the map cannot tell', () => {
    const [beside, on] = rows(
      list(road('left', { id: 'k', type: 'block', lat: 51.0025, lng: 0.0003, pathIdx: 2, qty: 5 }, { id: 'o', type: 'block', lat: 51.0035, lng: 0, pathIdx: 3, qty: 5 })),
    )
    expect(chip(beside)).toEqual({ label: 'Starboard', warn: false })
    expect(chip(on)).toEqual({ label: 'Set side', warn: true })
  })

  describe('a no-throw house a little further from the road than the route is wide', () => {
    // A house east of a road that runs north, so on the right of it. One degree of longitude is 70.05 km at 51 degrees north.
    const east = (metres: number, extra: Partial<Stop> = {}): Stop => house('far', 51.0025, metres / 70050, extra)

    afterEach(() => vi.unstubAllGlobals())

    it('says it is quiet, with the reason, when it is kept quiet by the alert distance in use (40 m: met along the route up to 70 m)', () => {
      const [row] = rows(list(road('left', east(65))))
      expect(row).toContain('quiet here: you throw the other side')
      expect(row).not.toContain('off the route')
    })

    it('says it is off the route when it alerts by where the driver is, whatever is thrown', () => {
      const [row] = rows(list(road('left', east(75))))
      expect(row).toContain('off the route (75 m)')
      expect(row).not.toContain('quiet here')
    })

    it('goes with the alert distance the driver has chosen: at 60 m a house 85 m back is still met along the route', () => {
      vi.stubGlobal('localStorage', { getItem: () => '60' })
      const [row] = rows(list(road('left', east(85))))
      expect(row).toContain('quiet here: you throw the other side')
      expect(row).not.toContain('off the route')
      expect(rows(list(road('left', east(95)))).join('')).toContain('off the route (95 m)')
    })

    it('is not asked a side of when it is in transit that far back, as it never alerts there', () => {
      // 55 m past the end of a road thrown to nothing: on the line of it, so no side can be told, and 55 m from it.
      const beyond = house('beyond', 51.005 + 55 / 111320, 0, { pathIdx: 4 })
      const [row] = rows(list(road('transit', beyond)))
      expect(chip(row).warn).toBe(false)
      expect(row).toContain('in transit, so no alert')
      // The same house where something is thrown has no side to tell, so it asks.
      expect(chip(rows(list(road('left', beyond)))[0])).toEqual({ label: 'Set side', warn: true })
    })

    it('counts it in the note of houses that will not alert', () => {
      const out = list(road('left', east(65), east(20, { id: 'near' })))
      expect(out).toContain('2 no-throw houses won&#x27;t alert')
    })

    it('has the button with its side, to set it by hand, while it is met along the route, more than 60 m out or not', () => {
      const [row] = rows(list(road('left', east(65))))
      expect(chip(row)).toEqual({ label: 'Starboard', warn: false })
      expect(row).toContain('class="icon-btn edit"')
      expect(row).not.toContain('solo')
      // One that alerts there, on the side thrown, has it too.
      expect(chip(rows(list(road('right', east(65))))[0])).toEqual({ label: 'Starboard', warn: false })
    })

    it('has no side button once it is met by where the driver is, further out than that', () => {
      const [row] = rows(list(road('left', east(75))))
      expect(row).not.toContain('chip-btn')
      expect(row).toContain('class="icon-btn edit solo"')
    })

    it('goes by the alert distance in use for the button too: at 60 m a house 85 m out has it, and one 95 m out not', () => {
      vi.stubGlobal('localStorage', { getItem: () => '60' })
      expect(chip(rows(list(road('left', east(85))))[0])).toEqual({ label: 'Starboard', warn: false })
      expect(rows(list(road('left', east(95))))[0]).not.toContain('chip-btn')
    })
  })

  describe('a no-throw house whose side the map cannot tell', () => {
    it('asks for a side on a Port or Starboard stretch, not only on Both', () => {
      for (const side of ['left', 'right', 'both'] as const) {
        const [row] = rows(list(road(side, house('on', 51.0025, 0))))
        expect(chip(row), side).toEqual({ label: 'Set side', warn: true })
        expect(row, side).toContain('side not known')
      }
    })

    it('does not show the side thrown as if it were the house own', () => {
      const [row] = rows(list(road('left', house('on', 51.0025, 0))))
      expect(row).not.toMatch(/>Port</)
      expect(row).not.toContain('Port')
    })

    it('shows the side of a house beside the road, on either side, without asking', () => {
      const [west, east] = rows(list(road('both', house('w', 51.0025, -0.0003), house('e', 51.0035, 0.0003))))
      expect(chip(west)).toEqual({ label: 'Port', warn: false })
      expect(chip(east)).toEqual({ label: 'Starboard', warn: false })
    })

    it('stops asking once a side is picked by hand', () => {
      const [row] = rows(list(road('left', house('on', 51.0025, 0, { side: 'right' }))))
      expect(chip(row)).toEqual({ label: 'Starboard', warn: false })
    })

    it('does not ask on a stretch where only transit is driven, where the house never alerts', () => {
      const [row] = rows(list(road('transit', house('on', 51.0025, 0))))
      expect(chip(row).warn).toBe(false)
    })
  })
})
