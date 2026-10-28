/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AlertBanner } from './AlertBanner'
import { RoundBar, type NextBundle } from './RoundBar'
import type { Stop } from './types'

/** A stylesheet as written. (Imported with `?raw` it comes out empty under the tests, which leave stylesheets out.) */
const sheet = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8')
const indexCss = sheet('./index.css')
const bundlesCss = sheet('./bundles.css')
const roundBarCss = sheet('./roundBar.css')
const roundMenuCss = sheet('./roundMenu.css')
const guidanceCss = sheet('./guidance.css')

/** The markup a component gives, as text. Nothing is mounted: this is only what the screen would be told to draw. */
const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element)

const next = (extra: Partial<NextBundle> = {}): NextBundle => ({ lead: 'Next bundle', name: 'Corner Store', distance: '340 m', papers: '12 papers', missed: 0, ...extra })

const bar = (props: Partial<Parameters<typeof RoundBar>[0]> = {}): string =>
  html(
    createElement(RoundBar, {
      remaining: 5,
      alertDistance: 40,
      located: true,
      notice: null,
      onNoticeDone: () => undefined,
      problem: null,
      caution: null,
      onCaution: () => undefined,
      nextBundle: next(),
      onBundles: () => undefined,
      onMenu: () => undefined,
      ...props,
    }),
  )

const WAKE = 'Keep the phone awake so GPS keeps updating.'

describe('the bar along the bottom of the round', () => {
  it('shows the next bundle with the venue by itself on its row and the papers on the row above, not beside the name', () => {
    const out = bar()
    expect(out).toContain('<span class="round-bundle-name">Corner Store</span>')
    const top = out.slice(out.indexOf('round-bundle-top'), out.indexOf('round-bundle-name'))
    expect(top).toContain('12 papers')
    expect(top).toContain('340 m')
    expect(top).toContain('Next bundle')
    expect(out.slice(out.indexOf('round-bundle-name'))).not.toContain('12 papers')
  })

  it('has no chip for the alert distance: it is in the menu', () => {
    const out = bar()
    expect(out).not.toContain('round-alerts')
    expect(out).not.toContain('Alerts at')
    expect(out).not.toContain('Alerts come up')
  })

  it('says the alert distance in the middle only when there is nothing else to say', () => {
    expect(bar({ nextBundle: null })).toContain('<div class="round-plain">Alerts at 40 m</div>')
    expect(bar({ nextBundle: null, alertDistance: 60 })).toContain('Alerts at 60 m')
    expect(bar({ nextBundle: null, located: false })).toContain('Finding your location...')
    expect(bar({ nextBundle: null, located: false })).not.toContain('Alerts at')
    expect(bar({ nextBundle: null, problem: 'Waiting for GPS signal...' })).not.toContain('Alerts at')
  })

  it('keeps the next bundle in view while the screen is not being kept awake, with a small amber button for the caution', () => {
    const out = bar({ caution: WAKE })
    expect(out).toContain('Corner Store')
    expect(out).toContain('340 m')
    expect(out).toContain('12 papers')
    expect(out).toContain('<button class="round-caution" aria-label="Warning: Keep the phone awake so GPS keeps updating.">')
    // The caution is not a line of words in the bar: it takes no more room than its button.
    expect(out).not.toContain('round-warn')
    expect(out.match(/Keep the phone awake/g)).toHaveLength(1)
  })

  it('has no caution button when the screen is being kept awake', () => {
    expect(bar()).not.toContain('round-caution')
  })

  it('says the caution as a notice when its button is tapped', () => {
    const told: string[] = []
    const element = RoundBar({
      remaining: 5,
      alertDistance: 40,
      located: true,
      notice: null,
      onNoticeDone: () => undefined,
      problem: null,
      caution: WAKE,
      onCaution: (m) => told.push(m),
      nextBundle: next(),
      onMenu: () => undefined,
    })
    const found: { props: { className?: string; onClick?: () => void; children?: unknown } }[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      const el = node as { props?: { className?: string; onClick?: () => void; children?: unknown } }
      if (el.props?.className === 'round-caution') found.push(el as (typeof found)[number])
      const kids = el.props?.children
      for (const kid of Array.isArray(kids) ? kids : [kids]) walk(kid)
    }
    walk(element)
    expect(found).toHaveLength(1)
    found[0].props.onClick?.()
    expect(told).toEqual([WAKE])
  })

  it('lets a problem with the GPS take the middle, in place of the bundle line, and keeps the count', () => {
    const out = bar({ problem: 'Waiting for GPS signal...' })
    expect(out).toContain('<div class="round-warn" role="status">')
    expect(out).toContain('Waiting for GPS signal...')
    expect(out).not.toContain('round-bundle')
    expect(out).toContain('round-count')
  })

  it('leads with "Next" beside the pill for bundles missed, or beside the caution button, so the line keeps its room', () => {
    expect(bar({ nextBundle: next({ missed: 1 }) })).toContain('<span class="lead">Next</span>')
    expect(bar({ caution: WAKE })).toContain('<span class="lead">Next</span>')
    expect(bar()).toContain('<span class="lead">Next bundle</span>')
  })

  it('still reads out the whole lead, whatever is shown', () => {
    expect(bar({ nextBundle: next({ missed: 1 }) })).toContain('aria-label="Next bundle: Corner Store, 340 m, 12 papers. 1 missed. Tap for the list of bundle drops."')
  })

  it('puts the pill for bundles missed before the papers, so a narrow line leaves off the papers first', () => {
    const out = bar({ nextBundle: next({ missed: 2 }) })
    const lead = out.indexOf('class="lead"')
    const dist = out.indexOf('class="dist"')
    const missed = out.indexOf('class="round-missed"')
    const papers = out.indexOf('class="papers"')
    expect(lead).toBeGreaterThan(-1)
    expect(lead).toBeLessThan(dist)
    expect(dist).toBeLessThan(missed)
    expect(missed).toBeLessThan(papers)
  })

  it('takes the whole line for a notice, with Undo, and no caution button over it', () => {
    const out = bar({ caution: WAKE, notice: { message: 'Dropped', undo: () => undefined } })
    expect(out).toContain('Dropped')
    expect(out).toContain('Undo')
    expect(out).not.toContain('round-caution')
    expect(out).not.toContain('round-bundle')
  })
})

const bundle: Stop = { id: 'b1', type: 'bundle', lat: -33.87, lng: 151.2, pathIdx: 0, label: 'Lakeside Convenience Store', address: '12 Oak Road, Springfield', qty: 12 }

const alert = (stop: Stop, extra: Partial<Parameters<typeof AlertBanner>[0]> = {}): string =>
  html(createElement(AlertBanner, { stops: [stop], ahead: 120, side: 'left', waiting: 0, ...extra }))

describe('the alert for a bundle drop', () => {
  it('hides the distance, which changes as the driver approaches, from a screen reader, so it is not read out again at every step', () => {
    expect(alert(bundle, { onDropped: () => undefined })).toContain('<span class="stop-alert-dist" aria-hidden="true">120 m</span>')
    expect(alert(bundle)).toContain('<span class="stop-alert-dist" aria-hidden="true">120 m</span>')
  })

  it('hides it on a special request and a no-throw house too, which are alerts of the same kind', () => {
    const request: Stop = { id: 'r1', type: 'request', lat: -33.87, lng: 151.2, pathIdx: 0, note: 'Leave it on the porch' }
    const nothrow: Stop = { id: 'n1', type: 'nothrow', lat: -33.87, lng: 151.2, pathIdx: 0, address: '14 Elm Street' }
    expect(alert(request)).toContain('class="stop-alert-dist" aria-hidden="true"')
    expect(alert(nothrow)).toContain('class="stop-alert-dist" aria-hidden="true"')
  })

  it('keeps its words in the banner label, which is not hidden', () => {
    expect(alert(bundle, { onDropped: () => undefined })).toContain('role="alert" aria-label="Bundle drop, 12, 12 papers."')
  })

  it('puts the papers beside the Dropped button, so the name and the address have the width', () => {
    const out = alert(bundle, { onDropped: () => undefined })
    const act = out.slice(out.indexOf('stop-alert-act'))
    expect(act).toContain('<span class="stop-alert-qty">12 papers</span>')
    expect(act.indexOf('stop-alert-qty')).toBeLessThan(act.indexOf('stop-alert-drop'))
    // Not in the row with the plate, the name and the address.
    const sub = out.slice(out.indexOf('stop-alert-sub'), out.indexOf('stop-alert-act'))
    expect(sub).not.toContain('stop-alert-qty')
    expect(sub).toContain('Lakeside Convenience Store')
    expect(sub).toContain('Oak Road, Springfield')
  })

  it('has the button alone when there is no amount', () => {
    const out = alert({ ...bundle, qty: undefined }, { onDropped: () => undefined })
    expect(out).toContain('stop-alert-act')
    expect(out).not.toContain('stop-alert-qty')
    expect(out).toContain('aria-label="Dropped: Lakeside Convenience Store"')
  })

  it('keeps the papers beside the name where there is no button to put them beside', () => {
    const out = alert(bundle)
    expect(out).not.toContain('stop-alert-act')
    expect(out.slice(out.indexOf('stop-alert-sub'))).toContain('<span class="stop-alert-qty">12 papers</span>')
  })
})

/** The value of a property in the first rule of a stylesheet whose selector is exactly `selector`. */
const declared = (css: string, selector: string, property: string): string | null => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`(?:^|})\\s*${escaped}\\s*{([^}]*)}`).exec(rules)
  const value = rule ? new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`).exec(rule[1]) : null
  return value ? value[1].trim() : null
}

describe('which is on top at the bottom of the round', () => {
  it('has the top of the round (the alert, with its Dropped button) above the bottom of it (the bar and the buttons)', () => {
    const top = Number(declared(indexCss, '.map-top', 'z-index'))
    const bottom = Number(declared(roundBarCss, '.round-bottom', 'z-index'))
    expect(bottom).toBe(1000)
    expect(top).toBeGreaterThan(bottom)
  })

  it('still has the sheets and their dimming above the top of the round, until they raise it themselves', () => {
    const top = Number(declared(indexCss, '.map-top', 'z-index'))
    expect(top).toBeLessThan(1050)
  })

  it('makes only the Dropped button of an alert take a tap, and lays the papers beside it out of the way of one', () => {
    expect(declared(bundlesCss, '.stop-alert-drop', 'pointer-events')).toBe('auto')
    expect(declared(indexCss, '.stop-alert', 'pointer-events')).toBe('none')
    expect(declared(bundlesCss, '.stop-alert-act', 'display')).toBe('flex')
  })
})

describe('the sheets under a Dropped alert', () => {
  const NOT_SIDEWAYS = '@media not all and (orientation: landscape) and (max-height: 600px)'

  it('keep below the alert on every screen but a phone on its side, where the sheet is at the right and the alert at the left', () => {
    for (const css of [bundlesCss, roundMenuCss]) {
      const at = css.indexOf(NOT_SIDEWAYS)
      expect(at).toBeGreaterThan(-1)
      const rule = css.slice(at, css.indexOf('}\n}', at))
      expect(rule).toContain('.screen:has(.stop-alert.ask)')
      expect(rule).toContain('max-height: calc(100% - 330px)')
    }
    // Not for portrait alone: a tablet or a window on its side that is tall has the alert across the top too.
    expect(bundlesCss).not.toMatch(/@media \(orientation: portrait\) \{\s*\.screen:has\(\.stop-alert\.ask\) \.bundles-sheet/)
    expect(roundMenuCss).not.toMatch(/@media \(orientation: portrait\) \{\s*\.screen:has\(\.stop-alert\.ask\) \.round-menu/)
  })

  it('let the menu scroll rather than cut its rows: its groups keep their height', () => {
    expect(roundMenuCss).toMatch(/\.round-menu > \* \{\s*flex: none;\s*\}/)
  })

  it('give the list the room on a short portrait screen by leaving out its three figures', () => {
    expect(bundlesCss).toMatch(/@media \(orientation: portrait\) and \(max-height: 720px\) \{\s*\.screen:has\(\.stop-alert\.ask\) \.bundles-summary \{\s*display: none;/)
  })
})

describe('the side and the next turn on the narrowest phones', () => {
  it('wrap, so the turn goes under the side when the two do not fit', () => {
    const at = guidanceCss.indexOf('@media (max-width: 350px)')
    expect(at).toBeGreaterThan(-1)
    expect(guidanceCss.slice(at)).toMatch(/\.map-top \.hud-row \{[^}]*flex-wrap: wrap;/)
  })
})
