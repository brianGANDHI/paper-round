/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { alertSpeech } from './alerts'
import { SIDE_LABEL, SIDE_SHORT } from './colors'
import { passViews } from './passes'
import { BRUSH_OPTIONS } from './sideOptions'
import { SidesTab } from './SidesTab'
import { sideWords } from './sideVoice'
import { turnWords } from './turns'
import { SIDES, type Route, type Stop } from './types'

/*
 * The driver heard Left and Right as the way to go, not the side to throw, so a throw side, and the side of the road a stop is on, is Port or
 * Starboard wherever the driver is told of it, on every screen and in the voice. A turn stays left or right, and what a saved route holds stays
 * as it was, so routes already saved keep working.
 */

/** A file of the app as written. */
const source = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

/** A file of the app without its comments, which talk of the left and the right of the road as the code's own words for them. */
const code = (name: string): string =>
  source(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

/** The words a piece of markup shows, without its tags. */
const shown = (markup: string): string => markup.replace(/<[^>]*>/g, '')

const noop = () => undefined

/** The Throw Side tab, for a route of a port section and a starboard one. */
function sidesTab(painting = false): string {
  const route: Route = {
    points: [
      { lat: -33.87, lng: 151.2 },
      { lat: -33.869, lng: 151.2 },
      { lat: -33.868, lng: 151.2 },
    ],
    sideChanges: [
      { idx: 0, side: 'left' },
      { idx: 1, side: 'right' },
    ],
    stops: [],
  }
  return renderToStaticMarkup(
    createElement(SidesTab, {
      route,
      views: passViews(route),
      focus: null,
      painting,
      onPainting: noop,
      brush: 'left',
      onBrush: noop,
      paintStarted: false,
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

describe('the name of a throw side', () => {
  it('is Port or Starboard in full, for the toasts and the labels', () => {
    expect(SIDE_LABEL).toEqual({ both: 'Both Sides', left: 'Port Side', right: 'Starboard Side', transit: 'Transit' })
    // Painting a stretch says so in the middle of a sentence: "Painted 120 m for starboard side."
    expect(SIDE_LABEL.right.toLowerCase()).toBe('starboard side')
  })

  it('is Port or Starboard in a word, for the pill on the round and the alert', () => {
    expect(SIDE_SHORT).toEqual({ both: 'Both', left: 'Port', right: 'Starboard', transit: 'Transit' })
  })

  it('is on the round screen, on the pill and in what a screen reader hears of it', () => {
    const round = code('Round.tsx')
    expect(round).toContain('{SIDE_SHORT[side]}')
    expect(round).toContain('`Throw side: ${SIDE_LABEL[side]}. Tap to change it for the part you are driving.`')
  })

  it('is one plain word to the voice, spelt Starboard, with nothing for a speech engine to read as two', () => {
    expect(sideWords('left')).toBe('Port')
    expect(sideWords('right')).toBe('Starboard')
    for (const side of ['left', 'right'] as const) expect(sideWords(side)).toMatch(/^[A-Z][a-z]+$/)
  })

  it('comes after the papers when an apartment block is said, as a word in the sentence', () => {
    const block: Stop = { id: 'k', type: 'block', lat: 0, lng: 0, pathIdx: 0, qty: 12 }
    expect(alertSpeech([block], 'left')).toBe('Apartment block, 12 papers, port.')
    expect(alertSpeech([block], 'right')).toBe('Apartment block, 12 papers, starboard.')
    expect(alertSpeech([block], null)).toBe('Apartment block, 12 papers.')
  })
})

describe('choosing a side', () => {
  it('offers Port and Starboard with the line colours, for the route, the paint and the box on the map', () => {
    expect(BRUSH_OPTIONS.map((o) => o.value)).toEqual(['both', 'left', 'right', 'transit'])
    expect(BRUSH_OPTIONS.map((o) => shown(renderToStaticMarkup(createElement('div', null, o.label))))).toEqual(['Both', 'Port', 'Starboard', 'Transit'])
    expect(BRUSH_OPTIONS.map((o) => o.ariaLabel)).toEqual(['Both sides', 'Port side', 'Starboard side', 'Transit, no throwing'])
  })

  it('offers Port and Starboard on each section of the Throw Side tab, and for a screen reader', () => {
    const out = sidesTab()
    expect(out).toContain('<button type="button" aria-pressed="true" aria-label="Port side" data-on="true">Port</button>')
    expect(out).toContain('<button type="button" aria-pressed="false" aria-label="Starboard side">Starboard</button>')
  })

  it('offers them for the paint as well', () => {
    expect(shown(sidesTab(true))).toContain('Paint withBothPortStarboardTransit')
  })

  it('offers Port and Starboard when the side of the road a stop is on is picked by hand', () => {
    const setup = code('Setup.tsx')
    expect(setup).toContain("{ value: 'left', label: 'Port' }")
    expect(setup).toContain("{ value: 'right', label: 'Starboard' }")
  })
})

describe('the help on the Throw Side tab', () => {
  it('says once which is which, as you face the way you drive', () => {
    const help = shown(sidesTab())
    expect(help).toContain('Port is your left and starboard your right as you face the way you drive')
    expect(help.match(/your left/g)).toHaveLength(1)
    expect(help.match(/your right/g)).toHaveLength(1)
  })

  it('uses the names everywhere else', () => {
    const help = shown(sidesTab())
    expect(help).toContain('a Port or Starboard stretch keeps quiet the no-throw houses on the other side of the road')
    expect(help).not.toMatch(/\b(Left|Right)\b/)
  })
})

describe('what does not change', () => {
  it('keeps a turn as left or right, on the card and in the voice', () => {
    expect(turnWords(-90)).toEqual({ label: 'Turn left', spoken: 'turn left' })
    expect(turnWords(90)).toEqual({ label: 'Turn right', spoken: 'turn right' })
    expect(turnWords(-50)).toEqual({ label: 'Bear left', spoken: 'bear left' })
    expect(turnWords(50)).toEqual({ label: 'Bear right', spoken: 'bear right' })
  })

  it('keeps the values a saved route holds, so routes already saved still load', () => {
    expect(SIDES).toEqual(['both', 'left', 'right', 'transit'])
  })
})

describe('the words of the app as a whole', () => {
  // Every other name for a side is pinned where it is used; this is for one added later. A turn is written in lower case, after a word of its
  // own ("Turn left", "Bear right"), so a Left or Right on its own in the code is a side, or else starts a sentence.
  it('has no Left or Right left in what it shows or says, in any of its files', () => {
    const files = readdirSync(new URL('.', import.meta.url)).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))
    expect(files).toContain('AlertBanner.tsx')
    expect(files).toContain('sideVoice.ts')
    const found = files.flatMap((f) => (code(f).match(/.*\b(?:Left|Right|LEFT|RIGHT)\b.*/g) ?? []).map((line) => `${f}: ${line.trim()}`))
    // "Left alone" is the round waiting for an answer: nothing to do with a side.
    expect(found.filter((line) => !line.includes('Left alone,'))).toEqual([])
  })
})
