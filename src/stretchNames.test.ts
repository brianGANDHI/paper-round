/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { passNote, passViews } from './passes'
import { deletedNote, deleteSection } from './routeEdit'
import { SidePopover } from './SidePopover'
import { SidesTab } from './SidesTab'
import type { Route } from './types'

/*
 * The named sections are told on the round as "Section 1", "Section 2" and so on, so the parts of the route with a throw side of their own are
 * called stretches, "Stretch 1", "Stretch 2", wherever the driver sees them. Otherwise Setup would show two different Section 2s on one route.
 */

/** A file of the app as written. */
const source = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

/** A file of the app without its comments or imports, which use the code's own word for a stretch. */
const code = (name: string): string =>
  source(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/^import .*$/gm, '')

/** The word section, as the driver would read it: not the code's `sections(route)`, nor an element's id such as `section-2`. */
const SECTION_WORD = /\bsections?\b(?![-(])/gi

const noop = () => undefined

/** A route of three stretches: port, starboard, then port again. */
const route: Route = {
  points: [
    { lat: -33.87, lng: 151.2 },
    { lat: -33.869, lng: 151.2 },
    { lat: -33.868, lng: 151.2 },
    { lat: -33.867, lng: 151.2 },
  ],
  sideChanges: [
    { idx: 0, side: 'left' },
    { idx: 1, side: 'right' },
    { idx: 2, side: 'left' },
  ],
  stops: [],
}

/** The Throw Side tab with the second stretch picked, so its Delete button shows too. */
function sidesTab(painting = false, paintStarted = false): string {
  return renderToStaticMarkup(
    createElement(SidesTab, {
      route,
      views: passViews(route),
      focus: painting ? null : 1,
      painting,
      onPainting: noop,
      brush: 'left',
      onBrush: noop,
      paintStarted,
      onFocus: noop,
      onSide: noop,
      onMerge: noop,
      onRepeat: noop,
      onDelete: noop,
      onBack: noop,
      onNext: noop,
    }),
  )
}

describe('the parts of the route with a throw side of their own', () => {
  it('are called Stretch 1, 2, 3 on their cards in Setup', () => {
    const out = sidesTab()
    expect(out).toContain('<div class="title">Stretch 1</div>')
    expect(out).toContain('<div class="title">Stretch 2</div>')
    expect(out).toContain('<div class="title">Stretch 3</div>')
  })

  it('are called stretches on their buttons, for a screen reader too', () => {
    const out = sidesTab()
    expect(out).toContain('aria-label="Repeat stretch 1"')
    expect(out).toContain('aria-label="Merge stretch 2 into stretch 1"')
    expect(out).toContain('aria-label="Throw side for stretch 3"')
    expect(out).toContain('aria-label="Delete stretch 2"')
    expect(out).toContain('Delete Stretch</button>')
  })

  it('never say section on the Throw Side tab, painting or not', () => {
    for (const out of [sidesTab(), sidesTab(true), sidesTab(true, true)]) expect(out.match(SECTION_WORD)).toBeNull()
    expect(sidesTab(true)).toContain('Tap the route where the part to paint starts, then where it ends. If the road is driven twice, pick the stretch for that pass in the list first.')
    expect(sidesTab(true, true)).toContain('Now tap the route where the part to paint ends.')
  })

  it('are called stretches in the box that opens on the map', () => {
    const out = renderToStaticMarkup(
      createElement(SidePopover, { at: { x: 10, y: 10 }, title: 'Stretch 2 · 120 m', side: 'right', onSide: noop, onPart: noop, onDelete: noop, onClose: noop }),
    )
    expect(out).toContain('aria-label="Delete this stretch"')
    expect(out.match(SECTION_WORD)).toBeNull()
  })

  it('are numbered as stretches in the box, the questions and the notes that Setup shows', () => {
    const setup = code('Setup.tsx')
    expect(setup).toContain('title={`Stretch ${picking.index + 1} · ${formatDistance(pickedSection.endM - pickedSection.startM)}`}')
    expect(setup).toContain('title: `Delete Stretch ${index + 1}?`,')
    expect(setup).toContain("confirmLabel: 'Delete Stretch',")
    expect(setup).toContain('title: `Repeat Stretch ${index + 1}`,')
    expect(setup).toContain('setNotice("That stretch can\'t be repeated.")')
    expect(setup).toContain("setNotice(`Added stretch ${last + 1}, ${mode === 'back' ? 'back along' : 'again along'} stretch ${index + 1}.")
    expect(setup).not.toMatch(/Delete Section|Repeat Section|`Section \$\{picking|Added section/)
  })

  it('are stretches when one drives the road of another again, or is deleted', () => {
    expect(passNote({ repeatOf: 1, reversed: true })).toBe('back along stretch 2')
    expect(passNote({ repeatOf: 1, reversed: false })).toBe('again along stretch 2')
    expect(deletedNote(deleteSection(route, 0)!, 0)).toMatch(/^Deleted stretch 1: /)
  })

  it('are stretches when drawing the route', () => {
    const tab = code('RouteTab.tsx')
    expect(tab).toContain('Change the side above to start a new stretch.')
    expect(tab).toContain('change the side of a stretch you have already drawn,')
    expect(tab.match(SECTION_WORD)).toBeNull()
  })

  it('are what the Sections tab tells the named sections apart from', () => {
    const tab = code('SectionsTab.tsx')
    expect(tab).toContain('These are separate from the stretches on the Throw Side tab: they only give a place a name.')
    expect(tab).not.toContain('throw-side sections')
  })

  it('are not what the paint tool asks the driver to mark, which is just the part to paint', () => {
    const setup = code('Setup.tsx')
    expect(setup).toContain("setNotice('Tap on the route to mark where the part to paint starts.')")
    expect(setup).toContain("setNotice('Tap on the route, away from where you started painting, to mark where it ends.')")
  })

  it('are throw sides, beside the named sections, in what replacing or deleting a route takes with it', () => {
    expect(code('Setup.tsx')).toContain('replaces the current route, its throw sides, its named sections, its street names and its stops.')
    expect(code('Routes.tsx')).toContain('This removes the route, its throw sides, its named sections, its street names, its stops and its progress')
    expect(code('Setup.tsx') + code('Routes.tsx')).not.toContain('its sections, its named sections')
  })
})
