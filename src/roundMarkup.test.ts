/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AlertBanner } from './AlertBanner'
import { SectionBanner } from './SectionBanner'
import { BundleOrderEditor, BundleOrderList } from './BundleOrderEditor'
import { nextRoundRows } from './bundleFlow'
import { BundlesSheet } from './BundlesSheet'
import { bundleRows, editorRows, type BundleRow, type EditorBundle } from './bundles'
import type { Occurrence } from './geo'
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

const next = (extra: Partial<NextBundle> = {}): NextBundle => ({ lead: 'Next bundle', name: 'Corner Store', distance: '340 m', papers: '12 papers', missed: 0, left: 3, ...extra })

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
    expect(bar({ nextBundle: next({ missed: 1 }) })).toContain(
      'aria-label="Next bundle: Corner Store, 340 m, 3 bundles left, 12 papers. 1 missed. Tap for the list of bundle drops."',
    )
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

  describe('how many bundle drops are left', () => {
    it('is on the row above the name, as "3 left", after the distance', () => {
      const out = bar({ nextBundle: next({ left: 3 }) })
      expect(out).toContain('<span class="left">3 left</span>')
      const top = out.slice(out.indexOf('round-bundle-top'), out.indexOf('round-bundle-name'))
      expect(top).toContain('3 left')
      expect(out.slice(out.indexOf('round-bundle-name'))).not.toContain('3 left')
      expect(out.indexOf('class="dist"')).toBeLessThan(out.indexOf('class="left"'))
    })

    it('says 1 left for one', () => {
      expect(bar({ nextBundle: next({ left: 1 }) })).toContain('<span class="left">1 left</span>')
    })

    it('ranks above the pill for bundles missed and the papers, so a narrow line leaves those off first, in the order lead, distance, left, pill, papers', () => {
      const out = bar({ nextBundle: next({ missed: 2, left: 4 }) })
      const at = ['class="lead"', 'class="dist"', 'class="left"', 'class="round-missed"', 'class="papers"'].map((c) => out.indexOf(c))
      expect(at.every((i) => i > -1)).toBe(true)
      expect([...at].sort((a, b) => a - b)).toEqual(at)
    })

    it('is not on the line when none are left, which says how the round stands instead', () => {
      const out = bar({ nextBundle: next({ lead: 'Bundles', name: 'All bundles dropped', distance: null, papers: null, left: 0 }) })
      expect(out).not.toContain('class="left"')
      expect(out).toContain('<span class="round-bundle-name">All bundles dropped</span>')
    })

    it('keeps the name on its own row, and the others on the row above, with the caution button or the pill beside the line', () => {
      for (const out of [bar({ caution: WAKE }), bar({ nextBundle: next({ missed: 3 }) }), bar()]) {
        expect(out).toContain('<span class="round-bundle-name">Corner Store</span>')
        const top = out.slice(out.indexOf('round-bundle-top'), out.indexOf('round-bundle-name'))
        expect(top).toContain('3 left')
        expect(top).toContain('340 m')
      }
    })
  })

  it('has no distance while the phone has no position, and still has the name and how many are left', () => {
    const out = bar({ nextBundle: next({ distance: null }) })
    expect(out).not.toContain('class="dist"')
    expect(out).toContain('Corner Store')
    expect(out).toContain('3 left')
    expect(out).toContain('aria-label="Next bundle: Corner Store, 3 bundles left, 12 papers. Tap for the list of bundle drops."')
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

describe('the line of the next bundle on a narrow phone', () => {
  it('is one row that clips, so what does not fit is left off whole from the end and never squeezes the name', () => {
    expect(declared(roundBarCss, '.round-bundle-top', 'height')).toBe('16px')
    expect(declared(roundBarCss, '.round-bundle-top', 'overflow')).toBe('hidden')
    expect(declared(roundBarCss, '.round-bundle-top', 'flex-wrap')).toBe('wrap')
    expect(declared(roundBarCss, '.round-bundle-top', 'white-space')).toBe('nowrap')
    // The first line, and the gap before a second, are taller than the box, so a second line is pushed out of the clip.
    const rowGap = Number.parseFloat(declared(roundBarCss, '.round-bundle-top', 'gap')?.split(' ')[0] ?? '0')
    const line = Number.parseFloat(declared(roundBarCss, '.round-bundle-top', 'font-size') ?? '0') * Number.parseFloat(declared(roundBarCss, '.round-bundle-top', 'line-height') ?? '0')
    expect(line + rowGap).toBeGreaterThan(Number.parseFloat(declared(roundBarCss, '.round-bundle-top', 'height') ?? '0'))
    expect(declared(roundBarCss, '.round-bundle', 'flex-direction')).toBe('column')
    expect(declared(roundBarCss, '.round-bundle-name', 'text-overflow')).toBe('ellipsis')
  })

  it('does not break the count within itself, so it is left off whole rather than wrapped in half', () => {
    expect(declared(roundBarCss, '.round-bundle-top', 'white-space')).toBe('nowrap')
    expect(declared(roundBarCss, '.round-missed', 'flex')).toBe('none')
  })

  it('styles how many are left, with the numbers set to line up', () => {
    expect(declared(roundBarCss, '.round-bundle-top .left', 'font-variant-numeric')).toBe('tabular-nums')
  })

  it('keeps the next-bundle line to a tap target of 44 px or more', () => {
    expect(declared(roundBarCss, '.round-bundle', 'min-height')).toBe('44px')
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


/** Every element in a tree that a test would look for, found by walking `props.children`: a component without hooks can be called as a function to get one. */
type El = { type?: unknown; props?: { className?: string; children?: unknown; onClick?: () => void; disabled?: boolean; 'aria-label'?: string } }
function find(node: unknown, test: (n: El) => boolean, found: El[] = []): El[] {
  if (!node || typeof node !== 'object') return found
  const el = node as El
  if (test(el)) found.push(el)
  const kids = el.props?.children
  for (const kid of Array.isArray(kids) ? kids : [kids]) find(kid, test, found)
  return found
}

describe('the bundle drops in the order the driver delivers them', () => {
  const bundles: EditorBundle[] = [
    { id: 'a', name: 'Spar', qty: 6 },
    { id: 'b', name: 'Co-op', qty: null },
    { id: 'c', name: 'Lakeside Convenience Store', qty: 1 },
  ]

  describe('the editor, as in Setup', () => {
    const editor = (order?: string[], list: EditorBundle[] = bundles): string => html(createElement(BundleOrderEditor, { bundles: list, order, onChange: () => undefined }))

    it('lists them in the order kept, numbered, with their papers', () => {
      const out = editor(['c', 'a'])
      const names = [...out.matchAll(/class="bundle-order-name">([^<]*)</g)].map((m) => m[1])
      expect(names).toEqual(['Lakeside Convenience Store', 'Spar', 'Co-op'])
      expect([...out.matchAll(/class="bundle-order-num" aria-hidden="true">(\d)</g)].map((m) => m[1])).toEqual(['1', '2', '3'])
      expect(out).toContain('6 papers')
      expect(out).toContain('1 paper')
    })

    it('is an ordered list that says what it is', () => {
      const out = editor()
      expect(out).toContain('<ol class="bundle-order-list" aria-label="Bundle drops, in the order you deliver them">')
      expect(out).toContain('It never changes unless you move one.')
    })

    it('names the bundle on every button, so a screen reader says which one is moved', () => {
      const out = editor()
      for (const name of ['Spar', 'Co-op', 'Lakeside Convenience Store']) {
        expect(out).toContain(`aria-label="Move ${name} up"`)
        expect(out).toContain(`aria-label="Move ${name} down"`)
      }
    })

    it('has the top one unable to go up and the bottom one unable to go down', () => {
      const out = editor()
      expect(out).toMatch(/aria-label="Move Spar up" disabled=""/)
      expect(out).not.toMatch(/aria-label="Move Spar down" disabled=""/)
      expect(out).toMatch(/aria-label="Move Lakeside Convenience Store down" disabled=""/)
      expect(out).not.toMatch(/aria-label="Move Co-op (up|down)" disabled=""/)
    })

    it('says there are none to put in order for a route with no bundle drops', () => {
      const out = editor(undefined, [])
      expect(out).toContain('There are no bundle drops yet.')
      expect(out).not.toContain('bundle-move')
    })

    it('reads a stale order as it would be read on the round: a gone stop ignored, a new one last', () => {
      const out = editor(['gone', 'b'])
      expect([...out.matchAll(/class="bundle-order-name">([^<]*)</g)].map((m) => m[1])).toEqual(['Co-op', 'Spar', 'Lakeside Convenience Store'])
    })

    it('has a polite note to a screen reader, empty until a bundle is moved', () => {
      expect(editor()).toContain('<div class="bundle-order-said" role="status"></div>')
    })
  })

  describe('in a round', () => {
    const round: EditorBundle[] = [
      { id: 'a', name: 'Spar', status: 'dropped' },
      { id: 'b', name: 'Co-op', status: 'next', qty: 12 },
      { id: 'c', name: 'School', status: 'todo' },
      { id: 'd', name: 'Garage', status: 'missed' },
    ]
    const out = html(createElement(BundleOrderEditor, { bundles: round, order: undefined, onChange: () => undefined }))

    it('shows where each stands', () => {
      expect(out).toContain('class="bundle-order-row dropped"')
      expect(out).toContain('class="bundle-order-row next"')
      expect(out).toContain('<span class="bundle-order-status">Next</span> · 12 papers')
      expect(out).toContain('<span class="bundle-order-status">To do</span>')
      expect(out).toContain('<span class="bundle-order-status">Missed</span>')
    })

    it('has no buttons for one already dropped or missed, and buttons for the others', () => {
      expect(out).not.toContain('Move Spar')
      expect(out).not.toContain('Move Garage')
      expect(out).toContain('Move Co-op up')
      expect(out).toContain('Move School down')
    })
  })

  describe('what a tap does', () => {
    const rows = (order?: string[]) => {
      const calls: [string, number][] = []
      const tree = BundleOrderList({ rows: editorRows(bundles, order), onMove: (row, delta) => calls.push([row.id, delta]), said: '' })
      return { tree, calls }
    }
    const button = (tree: unknown, label: string) => find(tree, (n) => n.props?.['aria-label'] === label)[0]

    it('moves the bundle on its own row, in the direction of the button', () => {
      const { tree, calls } = rows()
      button(tree, 'Move Co-op up').props?.onClick?.()
      button(tree, 'Move Co-op down').props?.onClick?.()
      button(tree, 'Move Spar down').props?.onClick?.()
      expect(calls).toEqual([
        ['b', -1],
        ['b', 1],
        ['a', 1],
      ])
    })

    it('has buttons at least 44 px square, with room between them, as the stylesheet has it', () => {
      for (const selector of ['.bundle-move']) {
        expect(Number.parseInt(declared(bundlesCss, selector, 'width') ?? '0', 10)).toBeGreaterThanOrEqual(44)
        expect(Number.parseInt(declared(bundlesCss, selector, 'height') ?? '0', 10)).toBeGreaterThanOrEqual(44)
      }
      expect(Number.parseInt(declared(bundlesCss, '.bundle-order-moves', 'gap') ?? '0', 10)).toBeGreaterThanOrEqual(4)
    })

    it('dims a button that has nowhere to go', () => {
      expect(declared(bundlesCss, '.bundle-move:disabled', 'opacity')).toBe('0.3')
    })
  })
})

describe("the Bundles list in the driver's order", () => {
  // Three bundles up a street, the phone at its foot. The Co-op is first in the route and the School first in the list.
  const at = (id: string, y: number, extra: Partial<Stop> = {}): Occurrence => ({
    key: id,
    stop: { id, type: 'bundle', lat: -33.87 + y / 111_195, lng: 151.2, pathIdx: 0, ...extra },
    idx: 0,
    at: y,
    off: 0,
  })
  const occs = [at('a', 100, { label: 'Co-op', qty: 12 }), at('b', 400, { label: 'Spar', address: '3 Elm Street', qty: 6 }), at('c', 900, { label: 'School' })]
  const here = { lat: -33.87, lng: 151.2 }
  const sheet = (rows: readonly BundleRow[], extra: Partial<Parameters<typeof BundlesSheet>[0]> = {}): string =>
    html(createElement(BundlesSheet, { rows, onClose: () => undefined, onMark: () => undefined, onUndo: () => undefined, ...extra }))
  const names = (out: string) => [...out.matchAll(/class="bundle-name">([^<]*)</g)].map((m) => m[1])

  it('has the rows in the order the driver put them in, not the route\'s', () => {
    const out = sheet(bundleRows(occs, { handledStopIds: [] }, ['c', 'a', 'b'], here))
    expect(names(out)).toEqual(['School', 'Co-op', 'Spar'])
  })

  it('has Reorder and no row buttons in the list of the next round, opened on a finished round to set the order', () => {
    const finished = { handledStopIds: ['a', 'b', 'c'], dropped: ['a', 'b'], missed: ['c'] }
    const withOrder = { order: undefined, onOrder: () => undefined }
    expect(sheet(bundleRows(occs, finished, undefined, here), withOrder)).not.toContain('>Reorder<')
    const out = sheet(nextRoundRows(occs, undefined, here), withOrder)
    expect(out).toContain('>Reorder<')
    expect(out).not.toContain('Mark dropped')
    expect(out).not.toContain('>Undo<')
    expect(out).toContain('<div class="bundles-count">3 bundles left · 0 of 3 dropped</div>')
  })

  it('heads the list Bundles, and as it is told to for the list of the next round, for a screen reader too', () => {
    const rows = nextRoundRows(occs, undefined, here)
    const plain = sheet(rows)
    expect(plain).toContain('<h2>Bundles</h2>')
    expect(plain).toContain('aria-label="Bundle drops"')
    const next = sheet(rows, { heading: 'Bundles, next round' })
    expect(next).toContain('<h2>Bundles, next round</h2>')
    expect(next).toContain('aria-label="Bundles, next round"')
  })

  it('says in the header how many are left, and how many of the whole are dropped', () => {
    const rows = bundleRows(occs, { handledStopIds: ['a'], dropped: ['a'] }, undefined, here)
    expect(sheet(rows)).toContain('<div class="bundles-count">2 bundles left · 1 of 3 dropped</div>')
  })

  it('says the status of each, the first still to do being Next whatever its place on the route', () => {
    const out = sheet(bundleRows(occs, { handledStopIds: ['a'], dropped: ['a'], missed: [] }, ['c', 'b', 'a'], here))
    expect([...out.matchAll(/class="bundle-status">([^<]*)</g)].map((m) => m[1])).toEqual(['Next', 'To do', 'Dropped'])
    expect(out).toContain('class="bundle-row next"')
    expect(out).toContain('class="bundle-row todo"')
  })

  it('says how far each is from the phone, and the place in the list', () => {
    const out = sheet(bundleRows(occs, { handledStopIds: [] }, undefined, here))
    expect(out).toContain('<span class="bundle-where">100 m away</span>')
    expect(out).toContain('<span class="bundle-where">900 m away</span>')
    expect([...out.matchAll(/class="bundle-place" aria-hidden="true">(\d)</g)].map((m) => m[1])).toEqual(['1', '2', '3'])
  })

  it('says nothing of how far while the phone has no position', () => {
    const out = sheet(bundleRows(occs, { handledStopIds: [] }, undefined, null))
    expect(out).not.toContain('bundle-where')
    expect(names(out)).toEqual(['Co-op', 'Spar', 'School'])
  })

  it('has Mark dropped on each bundle still to do, the next one included, and on one missed, naming the bundle', () => {
    const rows = bundleRows(occs, { handledStopIds: ['a'], missed: ['a'] }, undefined, here)
    const out = sheet(rows)
    expect(out).toContain('aria-label="Mark Co-op as dropped"')
    expect(out).toContain('aria-label="Mark Spar as dropped"')
    expect(out).toContain('aria-label="Mark School as dropped"')
  })

  it('has Undo on a bundle dropped, and no button on one skipped over', () => {
    const rows = bundleRows(occs, { handledStopIds: ['a', 'b'], dropped: ['a'] }, undefined, here)
    const out = sheet(rows)
    expect(out).toContain('aria-label="Undo dropped for Co-op"')
    expect(out).not.toContain('Mark Spar')
    expect(out).not.toContain('Undo dropped for Spar')
    expect(out).toContain('aria-label="Mark School as dropped"')
  })

  it('has one row for a street the route goes by twice, which says so', () => {
    const twice = [at('a', 100, { label: 'Co-op' }), { ...at('a', 900, { label: 'Co-op' }), key: 'a#2' }, at('b', 400, { label: 'Spar' })]
    const out = sheet(bundleRows(twice, { handledStopIds: [] }, undefined, here))
    expect(names(out)).toEqual(['Co-op', 'Spar'])
    expect(out).toContain('2 passes')
    expect(out).toContain('<div class="bundles-count">2 bundles left · 0 of 2 dropped</div>')
  })

  it('offers Reorder when it can be reordered and two or more are still to do', () => {
    const rows = bundleRows(occs, { handledStopIds: [] }, undefined, here)
    expect(sheet(rows, { onOrder: () => undefined, order: undefined })).toContain('>Reorder</button>')
    expect(sheet(rows)).not.toContain('Reorder')
  })

  it('does not offer Reorder with fewer than two to do, since there is nothing to move', () => {
    const one = bundleRows(occs, { handledStopIds: ['a', 'b'], dropped: ['a', 'b'] }, undefined, here)
    expect(sheet(one, { onOrder: () => undefined })).not.toContain('Reorder')
    const none = bundleRows(occs, { handledStopIds: ['a', 'b', 'c'], dropped: ['a', 'b', 'c'] }, undefined, here)
    expect(sheet(none, { onOrder: () => undefined })).not.toContain('Reorder')
  })

  it('says so when the route has no bundle drops', () => {
    expect(sheet([])).toContain('This route has no bundle drops.')
    expect(sheet([])).not.toContain('bundles-count')
  })

  it('says when some bundles have no amount set', () => {
    const rows = bundleRows(occs, { handledStopIds: [] }, undefined, here)
    expect(sheet(rows)).toContain('1 bundle has no amount set, so it adds no papers to these figures.')
  })

  it('has the three figures of the papers: dropped, to drop and missed', () => {
    const rows = bundleRows(occs, { handledStopIds: ['a'], dropped: ['a'] }, undefined, here)
    const out = sheet(rows)
    expect(out).toContain('<b>12</b><span>Papers dropped</span>')
    expect(out).toContain('<b>6</b><span>Papers to drop</span>')
    expect(out).toContain('<b>0</b><span>Missed</span>')
  })

  it('has a Reorder button of 44 px or more, beside Done', () => {
    // It has to beat `.btn.small` (34 px) in index.css, so its selector names all three classes.
    expect(Number.parseInt(declared(bundlesCss, '.btn.small.bundles-reorder', 'min-height') ?? '0', 10)).toBeGreaterThanOrEqual(44)
  })
})

describe('the banner where a named section starts and ends', () => {
  const html = (ended: string | null, started: string | null) => renderToStaticMarkup(createElement(SectionBanner, { ended, started }))

  it('has the end over the start, each with its word and name, and the words of the voice for a screen reader', () => {
    const out = html('Oak Estate', 'Beach Road')
    expect(out.indexOf('Oak Estate')).toBeLessThan(out.indexOf('Beach Road'))
    expect(out.match(/section-row (\w+)/g)).toEqual(['section-row ended', 'section-row started'])
    expect(out).toMatch(/End<\/span><span class="section-name">Oak Estate/)
    expect(out).toMatch(/Start<\/span><span class="section-name">Beach Road/)
    expect(out).toContain('aria-label="End of Oak Estate. Start of Beach Road."')
  })

  it('has only the row there is something for', () => {
    expect(html(null, 'Beach Road')).not.toContain('section-row ended')
    expect(html('Oak Estate', null)).not.toContain('section-row started')
  })

  it('takes no touch, as it sits over the map', () => {
    expect(readFileSync(new URL('./sectionBanner.css', import.meta.url), 'utf8')).not.toContain('pointer-events: auto')
  })
})
