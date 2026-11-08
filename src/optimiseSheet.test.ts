/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ALERT_DISTANCE, quietReachFor } from './alerts'
import { activeRoute, addRoute, createLibrary, editActiveRoute } from './library'
import { acceptOptimised, NO_ROOM_REASON, NO_SAVE_REASON, ROUND_RESET_WARNING, roundInProgress, STALE_REASON, type AcceptOutcome } from './optimise/accept'
import { OptimiseError, type Optimiser, type OptimiserOptions } from './optimise/client'
import { CANCELLED_MESSAGE } from './optimise/protocol'
import { basedOnOf } from './optimise/run'
import type { OptimiseChoices, OptimiseResult, PreparedView, RouteStats, WorthChecking } from './optimise/types'
import { advance, FIRST_STEP, SHOWN_CHECKS, type OptimiseEvent, type OptimiseState } from './optimiseFlow'
import { OptimiseBody, OptimiseSheet, type SheetActions } from './OptimiseSheet'
import { Routes } from './Routes'
import type { SaveTrouble } from './storage'
import type { Library, Pt, SavedRoute, Stop } from './types'

/*
 * The Optimise Route sheet. What each step draws is read from its markup, and what a tap does is played render after render, as in loadCard.test.ts:
 * nothing is mounted (the tests have no page), so React's hooks are played by the test, the sheet is called as a plain function that keeps its state from
 * one render to the next, and its controls are used by calling their handlers. Effects wait for the test to run them, and their clean-ups are kept to be
 * run when the sheet goes, as React would. All the routes and streets are made up.
 */
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  at: 0,
  pending: [] as { run: () => void | (() => void); cell: { undo?: void | (() => void) } }[],
  cells: [] as { undo?: void | (() => void) }[],
}))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const slot = <T>(make: () => T): T => {
    const i = hooks.at++
    if (!(i in hooks.slots)) hooks.slots[i] = make()
    return hooks.slots[i] as T
  }
  const keep = (run: () => void | (() => void), deps?: unknown[]) => {
    const cell = slot(() => {
      const made = { deps: undefined as unknown[] | undefined, undo: undefined as void | (() => void) }
      hooks.cells.push(made)
      return made
    })
    const same = deps && cell.deps && deps.every((d, i) => Object.is(d, cell.deps?.[i]))
    cell.deps = deps
    if (!same) hooks.pending.push({ run, cell })
  }
  return {
    ...actual,
    useState: <T>(init: T | (() => T)) => {
      const cell = slot(() => {
        const made = { value: typeof init === 'function' ? (init as () => T)() : init, set: (next: T) => (made.value = next) }
        return made
      })
      return [cell.value, cell.set]
    },
    useReducer: <S, E>(reduce: (state: S, event: E) => S, init: S) => {
      const cell = slot(() => {
        const made = { value: init, send: (event: E) => (made.value = reduce(made.value, event)) }
        return made
      })
      return [cell.value, cell.send]
    },
    useRef: <T>(init: T) => slot(() => ({ current: init })),
    useMemo: <T>(make: () => T, deps: unknown[]) => {
      const cell = slot(() => ({ value: undefined as T, deps: undefined as unknown[] | undefined }))
      if (!cell.deps || !deps.every((d, i) => Object.is(d, cell.deps?.[i]))) {
        cell.value = make()
        cell.deps = deps
      }
      return cell.value
    },
    useCallback: <T>(fn: T) => fn,
    useEffect: keep,
    useLayoutEffect: keep,
  }
})
vi.mock('react-dom', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-dom')>()), createPortal: (node: unknown) => node }))
vi.mock('./MapView', () => ({ MapView: vi.fn(() => null) }))
// Watched, not changed, so a test can count how often the sheet asks it.
vi.mock('./optimise/accept', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./optimise/accept')>()
  return { ...actual, roundInProgress: vi.fn(actual.roundInProgress) }
})

const { MapView } = await import('./MapView')

/** Runs the effects waiting, each after the clean-up of its last run. */
function settle() {
  for (const { run, cell } of hooks.pending.splice(0)) {
    if (typeof cell.undo === 'function') cell.undo()
    cell.undo = run()
  }
}

/** What React does as the sheet goes: every clean-up. */
function unmount() {
  for (const cell of hooks.cells.splice(0)) if (typeof cell.undo === 'function') cell.undo()
}

const stats = (over: Partial<RouteStats> = {}): RouteStats => ({ km: 20, mapKm: 20.2, closingKm: 0, closedKm: 20.2, left: 12, right: 0.4, both: 5, transit: 2.6, twiceKm: 0.3, uturns: 9, sideChanges: 31, ...over })

const LINE: Pt[] = [
  { lat: -33.87, lng: 151.2 },
  { lat: -33.869, lng: 151.2 },
  { lat: -33.868, lng: 151.2 },
]

/** A route in a library, as the app holds it. */
function library(): Library {
  return editActiveRoute(addRoute(createLibrary(), 'Monday'), { points: LINE, sideChanges: [{ idx: 0, side: 'left' }], stops: [] }, 5)
}

const VIEW: PreparedView = {
  basedOn: { routeId: 'r', updatedAt: 1, fingerprint: 'f' },
  start: { lat: -33, lng: 151, section: 'Start' },
  streets: [
    { key: 'way:1', name: 'Long Road', km: 3.2, main: true, allowed: false },
    { key: 'name:elm', name: 'Elm Street', km: 0.8, main: false, allowed: true },
  ],
  before: stats(),
  bundles: [
    { id: 'a', name: 'Corner Shop' },
    { id: 'b', name: 'Newsagent' },
  ],
  bundleOrderSet: false,
  unmatched: [],
  notes: [],
}

const resultFor = (saved: SavedRoute, over: Partial<OptimiseResult> = {}): OptimiseResult => ({
  route: { points: saved.route.points, sideChanges: saved.route.sideChanges },
  before: stats(),
  after: stats({ closedKm: 18.9 }),
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
  ...over,
})

const RESULT = resultFor(activeRoute(library()))

const after = (...events: OptimiseEvent[]): OptimiseState => events.reduce(advance, FIRST_STEP)
const fetching = (): OptimiseEvent[] => [{ type: 'start' }]
const choosing = (view: PreparedView = VIEW): OptimiseEvent[] => [...fetching(), { type: 'prepared', view }]
const solving = (): OptimiseEvent[] => [...choosing(), { type: 'run' }]
const showing = (result: OptimiseResult, unplaced: string[] | null = []): OptimiseEvent[] => [...solving(), { type: 'solved', result }, ...(unplaced ? ([{ type: 'placed', unplaced }] as OptimiseEvent[]) : [])]

const NO_ACTS: SheetActions = { start: () => undefined, cancel: () => undefined, run: () => undefined, accept: () => undefined, close: () => undefined, send: () => undefined }
const PLAIN: Pick<SavedRoute, 'sections'> = {}

/** A step's markup. */
function draw(state: OptimiseState, saved: Pick<SavedRoute, 'sections'> = PLAIN, stale = false, roundUnderWay = false): string {
  hooks.slots = []
  hooks.at = 0
  hooks.pending = []
  hooks.cells = []
  return renderToStaticMarkup(createElement(OptimiseBody, { state, saved, stale, roundUnderWay, act: NO_ACTS }))
}

/** The words a piece of markup shows, without its tags. */
const shown = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ')

/** The figures table as words, a row at a time. */
const tableOf = (out: string): string[][] => [...out.matchAll(/<tr>(.*?)<\/tr>/g)].map((row) => [...row[1].matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>|<td><\/td>/g)].map((cell) => shown(cell[1] ?? '').trim()))

/** The markup of the button with these words. */
const buttonOf = (out: string, label: string): string => {
  const button = [...out.matchAll(/<button[^>]*>.*?<\/button>/g)].map((m) => m[0]).find((b) => shown(b).trim() === label)
  expect(button, label).toBeDefined()
  return button ?? ''
}

const isDisabled = (button: string): boolean => /^<button[^>]* disabled=""/.test(button)

describe('the first step', () => {
  const out = draw(FIRST_STEP)

  it('says what it needs, and that nothing changes until Accept', () => {
    expect(shown(out)).toContain('It needs internet to get the map. Nothing changes until you tap Accept.')
  })

  it('has a button to start', () => {
    expect(buttonOf(out, 'Start')).toContain('btn primary block')
  })
})

describe('a step that is running', () => {
  it('shows what is being done, how far along, and Cancel, while the map is fetched', () => {
    const out = draw(after(...fetching(), { type: 'progress', progress: { step: 'Asking the map service', done: 0.25 } }))
    expect(out).toContain('Getting the map')
    expect(out).toContain('role="status">Asking the map service<')
    expect(out).toMatch(/role="progressbar" aria-label="Getting the map" aria-valuemin="0" aria-valuemax="100" aria-valuenow="25"/)
    expect(out).toContain('style="width:25%"')
    expect(buttonOf(out, 'Cancel')).toBeTruthy()
  })

  it('does as much while the route is worked out', () => {
    const out = draw(after(...solving(), { type: 'progress', progress: { step: 'Trying other orders', done: 0.5 } }))
    expect(out).toContain('Finding your route')
    expect(out).toContain('role="status">Trying other orders<')
    expect(out).toContain('aria-valuenow="50"')
    expect(shown(out)).toContain('about 20 seconds')
    expect(buttonOf(out, 'Cancel')).toBeTruthy()
  })

  it('has something to say before the first word from the worker', () => {
    const out = draw(after(...fetching()))
    expect(out).toContain('role="status">Starting<')
    expect(out).toContain('aria-valuenow="0"')
  })

  it('says the title once, and what it waits on under it, when the worker only says the title again', () => {
    const out = draw(after(...fetching(), { type: 'progress', progress: { step: 'Getting the map', done: 0 } }))
    expect(shown(out).match(/Getting the map/g)).toHaveLength(1)
    expect(out).toContain('role="status">Asking the map service<')
  })
})

describe('a step that failed', () => {
  const failure = (kind: 'offline' | 'busy' | 'nothing' | 'route' | 'crashed' | 'not-ready', message: string, from = fetching()) => draw(after(...from, { type: 'failed', kind, message }))

  it('shows the plain message and Try Again, offline or with a busy server', () => {
    const offline = failure('offline', 'This needs an internet connection.')
    expect(offline).toContain('banner warn')
    expect(shown(offline)).toContain('This needs an internet connection.')
    expect(buttonOf(offline, 'Try Again')).toBeTruthy()
    expect(buttonOf(failure('busy', 'The map service is busy right now.'), 'Try Again')).toBeTruthy()
  })

  it('offers Try Again when the worker broke while the map was got, as a new one may not', () => {
    const out = failure('crashed', 'Something went wrong working out the route. Nothing has changed.')
    expect(buttonOf(out, 'Try Again')).toContain('btn primary block')
  })

  it('offers nothing where trying again would not help', () => {
    const out = failure('nothing', "The map has no roads around this route.")
    expect(shown(out)).toContain('The map has no roads around this route.')
    expect(out).not.toContain('<button')
  })

  it('goes back to the choices after a run that broke', () => {
    expect(buttonOf(failure('crashed', 'Something went wrong.', solving()), 'Back to Choices')).toBeTruthy()
  })

  it('starts again when told to', () => {
    expect(buttonOf(failure('not-ready', "The route isn't ready to work on.", solving()), 'Start Again')).toBeTruthy()
  })
})

describe('the choices', () => {
  const rowOf = (out: string, title: string): string => {
    const row = [...out.matchAll(/<label class="row optimise-switch">.*?<\/label>/g)].map((m) => m[0]).find((r) => r.includes(`class="title">${title}<`))
    expect(row, title).toBeDefined()
    return row ?? ''
  }
  const isOn = (row: string) => /<input[^>]* checked=""/.test(row)

  it('names the section the route starts and ends at', () => {
    const out = shown(draw(after(...choosing())))
    expect(out).toContain('Start and end')
    expect(out).toContain('The new route starts and ends at this section.')
  })

  it('says when that is only the first point', () => {
    const out = shown(draw(after(...choosing({ ...VIEW, start: { lat: 0, lng: 0, section: null } }))))
    expect(out).toContain("The route's first point")
    expect(out).toContain('No section is called Start')
  })

  it('has Keep my bundle order on to begin with, as a switch', () => {
    const row = rowOf(draw(after(...choosing())), 'Keep my bundle order')
    expect(row).toContain('role="switch"')
    expect(isOn(row)).toBe(true)
    expect(row).toContain('Your bundles stay in your order.')
  })

  it('says what comes of switching it off', () => {
    const row = rowOf(draw(after(...choosing(), { type: 'keep-order', on: false })), 'Keep my bundle order')
    expect(isOn(row)).toBe(false)
    expect(row).toContain('Gets the shortest route.')
  })

  it('has no Keep my bundle order for a route with no order of bundles to keep', () => {
    for (const bundles of [[], VIEW.bundles.slice(0, 1)]) expect(draw(after(...choosing({ ...VIEW, bundles })))).not.toContain('Keep my bundle order')
  })

  it('lists the streets under the plain name of the setting, main roads first and off, the rest on', () => {
    const out = draw(after(...choosing()))
    expect(out).toContain('Allow throwing starboard or both')
    const coast = rowOf(out, 'Long Road')
    const elm = rowOf(out, 'Elm Street')
    expect(out.indexOf(coast)).toBeLessThan(out.indexOf(elm))
    expect(isOn(coast)).toBe(false)
    expect(isOn(elm)).toBe(true)
    expect(coast).toContain('Main road · 3.2 km')
    expect(elm).toContain('800 m')
    expect(coast).toContain('aria-label="Allow throwing starboard or both on Long Road"')
  })

  /** A view of a round with two main roads and many other streets, the ones named in `off` switched off. */
  const manyStreets = (count: number, off: number[] = []): PreparedView => ({
    ...VIEW,
    streets: [
      { key: 'way:1', name: 'Long Road', km: 3.2, main: true, allowed: false },
      { key: 'way:2', name: 'Ridge Road', km: 1.2, main: true, allowed: false },
      ...Array.from({ length: count }, (_, i) => ({ key: `name:${i}`, name: `Street ${i}`, km: 0.3, main: false, allowed: !off.includes(i) })),
    ],
  })
  const switches = (out: string) => [...out.matchAll(/<label class="row optimise-switch">.*?<\/label>/g)].length

  it('lists the main roads and folds the other streets into a line saying how many are on, with Show All', () => {
    const out = draw(after(...choosing(manyStreets(135))))
    expect(switches(out)).toBe(1 + 2)
    expect(shown(out)).toContain('135 other streets are on')
    expect(buttonOf(out, 'Show All 135')).toContain('btn secondary block')
  })

  it('lists every street after Show All', () => {
    const out = draw(after(...choosing(manyStreets(135)), { type: 'show-all-streets' }))
    expect(switches(out)).toBe(1 + 2 + 135)
    expect(shown(out)).not.toContain('other streets are on')
    expect(out).not.toContain('Show All')
  })

  it('keeps a street that is off in view while the rest are folded, and counts only those that are on', () => {
    const out = draw(after(...choosing(manyStreets(135, [17]))))
    expect(isOn(rowOf(out, 'Street 17'))).toBe(false)
    expect(shown(out)).toContain('134 other streets are on')
    expect(buttonOf(out, 'Show All 135')).toBeTruthy()
  })

  it('warns of a thrown part of the route that is not on the map, and shows any note', () => {
    const out = shown(draw(after(...choosing({ ...VIEW, unmatched: [{ lat: 0, lng: 0, m: 40, thrown: true, street: 'Elm Street' }], notes: ['The map has 1 turn rule this can not read.'] }))))
    expect(out).toContain("Part of today's route near Elm Street isn't on any road on the map, so Accept will stay off.")
    expect(out).toContain('The map has 1 turn rule this can not read.')
  })

  it('has a button to run', () => {
    expect(buttonOf(draw(after(...choosing())), 'Find My Route')).toContain('btn primary block')
  })
})

describe('the results', () => {
  const results = (over: Partial<OptimiseResult> = {}, unplaced?: string[] | null) => after(...showing({ ...RESULT, ...over }, unplaced))

  it('sets the figures side by side', () => {
    const out = draw(results({ before: stats({ closedKm: 21 }), after: stats({ closedKm: 19.5, uturns: 7, sideChanges: 40 }) }))
    expect(tableOf(out)).toEqual([
      ['', 'Today', 'New'],
      ['Total', '21.0 km', '19.5 km'],
      ['Port', '12.0 km', '12.0 km'],
      ['Starboard', '0.4 km', '0.4 km'],
      ['Both', '5.0 km', '5.0 km'],
      ['Transit', '2.6 km', '2.6 km'],
      ['Thrown twice', '0.3 km', '0.3 km'],
      ['U-turns', '9', '7'],
      ['Side changes', '31', '40'],
    ])
    expect(shown(out)).toContain('1.5 km shorter than today')
  })

  it("shows today's km as including the way back to the start, where it doesn't close, in its total and its transit", () => {
    const out = draw(results({ before: stats({ closingKm: 0.9, closedKm: 21, transit: 2.6 }) }))
    expect(shown(out)).toContain("Today's total and transit include 0.9 km back to the start.")
    expect(tableOf(out).find((row) => row[0] === 'Transit')).toEqual(['Transit', '3.5 km', '2.6 km'])
    expect(shown(draw(results()))).not.toContain('back to the start')
  })

  it('says plainly when a route kept to the bundle order comes out longer, with the notes of the run up top', () => {
    const note = 'Your 2 bundles are kept in list order. This route comes out 1.3 km longer than today. Turn off Keep my bundle order to get the shortest route.'
    const out = shown(draw(results({ keepOrder: true, after: stats({ closedKm: 21.5 }), notes: [note] })))
    expect(out).toContain('1.3 km longer than today, keeping your bundle order')
    expect(out.indexOf(note)).toBeGreaterThan(out.indexOf('keeping your bundle order'))
    expect(out.indexOf(note)).toBeLessThan(out.indexOf('Today New'))
    expect(out.split(note)).toHaveLength(2)
  })

  it('leaves the notes at the foot of the list otherwise', () => {
    const note = 'Elm Street: 40 m can only be thrown from the starboard side, as it is one-way.'
    const out = shown(draw(results({ notes: [note] })))
    expect(out.indexOf(note)).toBeGreaterThan(out.indexOf('Today New'))
  })

  it('shows the sides in the colours of the map', () => {
    expect(draw(results())).toContain('<span class="seg-dot" style="background:#34c759"></span>Port')
    expect(draw(results())).toContain('<span class="seg-dot" style="background:#ff9500"></span>Starboard')
  })

  it('draws the new line on the map, coloured by its sides, with no stops over it', () => {
    vi.mocked(MapView).mockClear()
    draw(results())
    expect(vi.mocked(MapView).mock.calls[0][0]).toMatchObject({ route: { points: RESULT.route.points, sideChanges: RESULT.route.sideChanges, stops: [] }, position: null, outsideCredit: true })
  })

  it('draws it as an overview, so a finger on it scrolls the sheet and the route fills it', () => {
    vi.mocked(MapView).mockClear()
    draw(results())
    expect(vi.mocked(MapView).mock.calls[0][0]).toMatchObject({ overview: true })
  })

  it('credits the map', () => {
    expect(draw(results())).toContain('OpenStreetMap')
  })

  it('lists new road with how much of it, a short one in metres, and the total in metres too while it is under a km', () => {
    const out = shown(draw(results({ newRoads: [{ street: 'Elm Street', km: 0.34 }, { street: 'Oak Avenue', km: 0.033 }], newRoadKm: 0.373 })))
    expect(out).toContain("Roads you don't drive today · 373 m")
    expect(out).toContain('Elm Street 340 m')
    expect(out).toContain('Oak Avenue 33 m')
    expect(shown(draw(results({ newRoads: [{ street: 'Oak Avenue', km: 0.033 }], newRoadKm: 0.033 })))).toContain("Roads you don't drive today · 33 m")
  })

  it('gives a total of a km or more in km', () => {
    expect(shown(draw(results({ newRoads: [{ street: 'Elm Street', km: 1.44 }], newRoadKm: 1.44 })))).toContain("Roads you don't drive today · 1.4 km")
  })

  it('has nothing on new road when there is none', () => {
    expect(shown(draw(results()))).not.toContain("Roads you don't drive today")
  })

  it('lists turn-backs away from a dead end, saying how awkward', () => {
    const out = shown(draw(results({ turnBacks: [{ lat: 0, lng: 0, street: 'Long Road', level: 'main', alsoToday: false }] })))
    expect(out).toContain('Turning back, with no dead end')
    expect(out).toContain('Long Road On a main road')
  })

  it('lists the sections that can not be placed', () => {
    const out = shown(draw(results({}, ['Beach End', 'The Estate'])))
    expect(out).toContain("Sections that can't be placed")
    expect(out).toContain('Beach End')
    expect(out).toContain('The Estate')
    expect(out).toContain("They stay on the old route only. The new route won't show their banners or offer them as a place to start.")
  })

  it('has nothing on sections when all of them go on', () => {
    expect(shown(draw(results()))).not.toContain("can't be placed")
  })

  const bundles = (over: Partial<OptimiseResult['bundles']>): OptimiseResult['bundles'] => ({
    before: [
      { id: 'a', name: 'Corner Shop' },
      { id: 'b', name: 'Newsagent' },
    ],
    after: [
      { id: 'b', name: 'Newsagent' },
      { id: 'a', name: 'Corner Shop' },
    ],
    changed: true,
    fits: false,
    stranded: [],
    store: null,
    ...over,
  })

  it('shows the new bundle order with keep order off, numbered, in the order it will be', () => {
    const out = draw(results({ keepOrder: false, bundles: bundles({}) }))
    expect(out).toContain('New bundle order')
    const list = /<ol class="group">(.*?)<\/ol>/.exec(out)?.[1] ?? ''
    expect(shown(list).trim()).toBe('1 Newsagent 2 Corner Shop')
    expect(shown(out)).toContain('Your bundle list will follow the new drive.')
  })

  it('says a kept order stays, with keep order on, and shows no list', () => {
    const out = draw(results({ keepOrder: true, bundles: bundles({ after: bundles({}).before, changed: false, fits: true }) }))
    expect(out).not.toContain('New bundle order')
    expect(out).not.toContain('<ol')
    expect(shown(out)).toContain('Your bundle order stays as it is.')
  })

  const checks = (count: number): WorthChecking[] => Array.from({ length: count }, (_, i) => ({ lat: 0, lng: 0, street: 'Elm Street', m: 90 - i, kind: 'one-side', text: `Elm Street: stretch ${i + 1}.` }))

  it('caps what is worth checking at the longest, with a way to see the rest', () => {
    const out = shown(draw(results({ worthChecking: checks(30) })))
    expect(out).toContain('Worth checking')
    expect(out).toContain(`Elm Street: stretch ${SHOWN_CHECKS}.`)
    expect(out).not.toContain(`Elm Street: stretch ${SHOWN_CHECKS + 1}.`)
    expect(out).toContain('Show All 30')
  })

  it('shows all of it when asked', () => {
    const out = shown(draw(advance(results({ worthChecking: checks(30) }), { type: 'show-all-checks' })))
    expect(out).toContain('Elm Street: stretch 30.')
    expect(out).not.toContain('Show All')
  })

  it('has no way to see more when it is all there', () => {
    expect(shown(draw(results({ worthChecking: checks(SHOWN_CHECKS) })))).not.toContain('Show All')
  })

  it('shows the stretches the new route stops throwing at before Show All, not only the longer one-sided ones', () => {
    const gap = (i: number): WorthChecking => ({ lat: 0, lng: 0, street: 'Oak Avenue', m: 12 - i, kind: 'gap', text: `Oak Avenue: gap ${i + 1}.` })
    const out = shown(draw(results({ worthChecking: [...checks(20), ...Array.from({ length: 10 }, (_, i) => gap(i))] })))
    expect(out).toContain('Oak Avenue: gap 1.')
    expect(out).toContain(`Oak Avenue: gap ${SHOWN_CHECKS / 2}.`)
    expect(out).not.toContain(`Oak Avenue: gap ${SHOWN_CHECKS / 2 + 1}.`)
    expect(out.indexOf('Oak Avenue: gap 1.')).toBeLessThan(out.indexOf('Elm Street: stretch 1.'))
    expect(out).toContain('Show All 30')
  })

  it('says the gaps are only about so much', () => {
    expect(shown(draw(results({ gaps: [{ lat: 0, lng: 0, street: 'Elm Street', m: 12, atHead: true }], gapKm: 0.26 })))).toContain('About 0.3 km thrown at today')
  })

  it('shows the notes of the run', () => {
    expect(shown(draw(results({ notes: ['Elm Street: 40 m can only be thrown from the starboard side, as it is one-way.'] })))).toContain('Elm Street: 40 m can only be thrown')
  })

  it('has Accept, Cancel and Change Choices', () => {
    const out = draw(results())
    expect(isDisabled(buttonOf(out, 'Accept'))).toBe(false)
    expect(buttonOf(out, 'Accept')).toContain('btn primary block')
    expect(isDisabled(buttonOf(out, 'Cancel'))).toBe(false)
    expect(isDisabled(buttonOf(out, 'Change Choices'))).toBe(false)
  })

  it('disables Accept and says why when there is a blocking problem', () => {
    const out = draw(results({ blocked: ['Elm Street: 40 m that is thrown at today is not thrown at on the new route.', 'The new route goes against a one-way.'] }))
    const accept = buttonOf(out, 'Accept')
    expect(isDisabled(accept)).toBe(true)
    expect(accept).toContain('aria-describedby="optimise-why"')
    const why = /id="optimise-why">(.*?)<\/div>/.exec(out)?.[1] ?? ''
    expect(shown(why)).toContain('Elm Street: 40 m that is thrown at today is not thrown at on the new route.')
    expect(shown(why)).toContain('The new route goes against a one-way.')
    expect(isDisabled(buttonOf(out, 'Change Choices'))).toBe(false)
  })

  it('tells a list that does not fit how to get a route', () => {
    const reason = "Your bundle list doesn't fit this route: it never comes back past Newsagent after the bundle before it. Turn off Keep my bundle order to get a route with its own order."
    const out = draw(results({ blocked: [reason], bundles: bundles({ after: bundles({}).before, changed: false, stranded: [{ id: 'b', name: 'Newsagent' }] }) }))
    expect(shown(out)).toContain('Turn off Keep my bundle order')
    expect(out).not.toContain('New bundle order')
  })

  it('disables Accept and says why when the route has changed', () => {
    const out = draw(results(), PLAIN, true)
    expect(isDisabled(buttonOf(out, 'Accept'))).toBe(true)
    expect(shown(out)).toContain(STALE_REASON)
  })

  it('warns before Accept that a round in progress starts over', () => {
    const out = draw(results(), PLAIN, false, true)
    expect(shown(out)).toContain(ROUND_RESET_WARNING)
    expect(out.indexOf(ROUND_RESET_WARNING)).toBeLessThan(out.indexOf('>Accept<'))
    expect(isDisabled(buttonOf(out, 'Accept'))).toBe(false)
  })

  it('has no such warning with no round under way', () => {
    expect(shown(draw(results()))).not.toContain(ROUND_RESET_WARNING)
  })

  it('holds Accept back until the sections are worked out, saying so', () => {
    const out = draw(results({}, null), { ...PLAIN, sections: [{ id: 's', name: 'Beach End', lat: 0, lng: 0 }] })
    expect(isDisabled(buttonOf(out, 'Accept'))).toBe(true)
    expect(shown(out)).toContain('Checking your sections.')
  })

  it('shows it is busy while Accept is done, and takes no other tap', () => {
    const out = draw(advance(results(), { type: 'accept' }))
    expect(isDisabled(buttonOf(out, 'Saving'))).toBe(true)
    expect(isDisabled(buttonOf(out, 'Cancel'))).toBe(true)
    expect(isDisabled(buttonOf(out, 'Change Choices'))).toBe(true)
  })
})

describe('after Accept', () => {
  const accepted = (unplaced: string[] = []) => after(...showing(RESULT), { type: 'accept' }, { type: 'accepted', kept: 'Monday (before optimise)', unplaced })

  it('says where the old route is and how to go back', () => {
    const out = shown(draw(accepted()))
    expect(out).toContain('Your new route is in use.')
    expect(out).toContain('Your old route is kept as “Monday (before optimise)” in the Routes list. Tap it there to go back to it.')
  })

  it('names the sections left on the old route', () => {
    const out = shown(draw(accepted(['Beach End'])))
    expect(out).toContain("Sections that couldn't be placed")
    expect(out).toContain('Beach End')
    expect(out).toContain("They are on the old route only. The new route won't show their banners or offer them as a place to start.")
  })

  it('offers nothing more to tap', () => {
    expect(draw(accepted())).not.toContain('<button')
  })
})

describe('the words for the sides', () => {
  const everything: OptimiseState[] = [
    FIRST_STEP,
    after(...fetching()),
    after(...choosing()),
    after(...solving()),
    after(...showing({ ...RESULT, blocked: ['A reason.'], turnBacks: [{ lat: 0, lng: 0, street: 'Elm Street', level: 'plain', alsoToday: true }], worthChecking: [{ lat: 0, lng: 0, street: 'Elm Street', m: 50, kind: 'one-side', text: 'Elm Street: about 50 m thrown on one side only, and the rest of the street on both.' }] })),
    after(...showing(RESULT), { type: 'accept' }, { type: 'accepted', kept: 'Monday (before optimise)', unplaced: ['Beach End'] }),
  ]

  /** What a step shows or says: its words, and what a screen reader hears. */
  const said = (state: OptimiseState) => {
    const out = draw(state)
    return `${shown(out)} ${[...out.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]).join(' ')}`
  }

  it('are Port and Starboard in the figures', () => {
    const out = said(after(...showing(RESULT)))
    expect(out).toContain('Port')
    expect(out).toContain('Starboard')
  })

  it('are starboard in the setting', () => {
    expect(said(after(...choosing()))).toContain('Allow throwing starboard or both')
  })

  it('are never Left or Right, on any step', () => {
    for (const state of everything) expect(said(state), state.step).not.toMatch(/\b(left|right)\b/i)
  })
})

interface Step<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function step<T>(): Step<T> {
  let resolve: Step<T>['resolve'] = () => undefined
  let reject: Step<T>['reject'] = () => undefined
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** Stands in for the worker's client, with each step left for the test to finish. A step that is ended rejects as the real one does. */
function fakeOptimiser() {
  const calls = { prepare: [] as SavedRoute[], solve: [] as OptimiseChoices[], cancel: 0, close: 0 }
  let running: Step<never> | null = null
  const begin = <T>(): Step<T> => {
    const s = step<T>()
    running = s as unknown as Step<never>
    return s
  }
  const stop = () => {
    running?.reject(new OptimiseError({ kind: 'cancelled', message: CANCELLED_MESSAGE }))
    running = null
  }
  const steps = { prepare: [] as Step<PreparedView>[], solve: [] as Step<OptimiseResult>[] }
  let tell: OptimiserOptions['onProgress']
  const make = (options: OptimiserOptions): Optimiser => {
    tell = options.onProgress
    return {
      prepare: (saved) => {
        calls.prepare.push(saved)
        const s = begin<PreparedView>()
        steps.prepare.push(s)
        return s.promise
      },
      solve: (choices) => {
        calls.solve.push(choices)
        const s = begin<OptimiseResult>()
        steps.solve.push(s)
        return s.promise
      },
      cancel: () => {
        calls.cancel++
        stop()
      },
      close: () => {
        calls.close++
        stop()
      },
    }
  }
  return { calls, steps, make, progress: (step: string, done: number) => tell?.({ step, done }) }
}

type El = { type?: unknown; props?: Record<string, unknown> & { children?: unknown; className?: string } }

/** The tree with every component of ours drawn, so what is on the screen can be found in it. */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand)
  if (!node || typeof node !== 'object') return node
  const el = node as El
  if (typeof el.type === 'function') return expand((el.type as (props: unknown) => unknown)(el.props))
  return el.props ? { ...el, props: { ...el.props, children: expand(el.props.children) } } : el
}

function find(node: unknown, test: (n: El) => boolean, found: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const kid of node) find(kid, test, found)
    return found
  }
  if (!node || typeof node !== 'object') return found
  const el = node as El
  if (test(el)) found.push(el)
  find(el.props?.children, test, found)
  return found
}

const words = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(words).join('')
  return node && typeof node === 'object' ? words((node as El).props?.children) : ''
}

/** Calls one of an element's handlers. */
const fire = (el: El, handler: string, ...args: unknown[]) => {
  const run = el.props?.[handler] as (...given: unknown[]) => void
  run(...args)
}

/** Lets what the promises have finished reach the sheet. */
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** The sheet on a route, as Routes has it: `onAccept` goes through `acceptOptimised` on the library, which `saved` then reads from. */
function sheet(start: Library = library(), acceptWith?: (result: OptimiseResult) => AcceptOutcome) {
  const worker = fakeOptimiser()
  const state = { lib: start, closes: 0, accepts: 0 }
  const onAccept =
    acceptWith ??
    ((result: OptimiseResult) => {
      state.accepts++
      const outcome = acceptOptimised(state.lib, result, 9)
      if (outcome.ok) state.lib = outcome.library
      return outcome
    })
  const onClose = () => state.closes++
  hooks.slots = []
  hooks.pending = []
  hooks.cells = []
  const render = (): unknown => {
    hooks.at = 0
    const tree = expand(OptimiseSheet({ saved: activeRoute(state.lib), onAccept, onClose, makeOptimiser: worker.make }))
    settle()
    return tree
  }
  const button = (label: string): El => {
    const [el] = find(render(), (n) => n.type === 'button' && words(n) === label)
    expect(el, label).toBeDefined()
    return el
  }
  /** Taps the button with these words, and draws the sheet as that leaves it. */
  const tap = (label: string) => {
    fire(button(label), 'onClick')
    render()
  }
  /** Switches the row with this title. */
  const toggle = (title: string, checked: boolean) => {
    const [row] = find(render(), (n) => n.type === 'label' && words(n).startsWith(title))
    expect(row, title).toBeDefined()
    const [input] = find(row, (n) => n.type === 'input')
    fire(input, 'onChange', { target: { checked } })
  }
  const texts = () => words(render())
  const has = (label: string) => find(render(), (n) => n.type === 'button' && words(n) === label).length > 0
  return { worker, state, render, button, tap, toggle, texts, has }
}

/** A sheet brought as far as the choices. */
async function atChoices(s: ReturnType<typeof sheet>, view: PreparedView = VIEW) {
  s.tap('Start')
  s.worker.steps.prepare.at(-1)?.resolve(view)
  await flush()
}

/** A sheet brought as far as the results, with the sections worked out. */
async function atResults(s: ReturnType<typeof sheet>, over: Partial<OptimiseResult> = {}) {
  await atChoices(s)
  s.tap('Find My Route')
  s.worker.steps.solve.at(-1)?.resolve(resultFor(activeRoute(s.state.lib), over))
  await flush()
  s.render()
  await vi.advanceTimersByTimeAsync(100)
}

describe('the sheet at work', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('opens on the first step, asking nothing of the worker', () => {
    const s = sheet()
    expect(s.texts()).toContain('It needs internet')
    expect(s.worker.calls.prepare).toEqual([])
  })

  it('gets the map for the route in use when Start is tapped', async () => {
    const s = sheet()
    s.tap('Start')
    expect(s.worker.calls.prepare).toEqual([activeRoute(s.state.lib)])
    expect(s.texts()).toContain('Getting the map')
    s.worker.steps.prepare[0].resolve(VIEW)
    await flush()
    expect(s.texts()).toContain('Keep my bundle order')
  })

  it('shows the words the worker sends', () => {
    const s = sheet()
    s.tap('Start')
    s.worker.progress('Reading the map', 0.4)
    expect(s.texts()).toContain('Reading the map')
  })

  it('stops the fetch and goes back on Cancel, with the route as it was', async () => {
    const s = sheet()
    const lib = s.state.lib
    s.tap('Start')
    s.tap('Cancel')
    expect(s.worker.calls.cancel).toBe(1)
    await flush()
    expect(s.texts()).toContain('It needs internet')
    expect(s.state.lib).toBe(lib)
  })

  it('tries again after a busy server, with a new fetch', async () => {
    const s = sheet()
    s.tap('Start')
    s.worker.steps.prepare[0].reject(new OptimiseError({ kind: 'busy', message: 'The map service is busy right now.' }))
    await flush()
    expect(s.texts()).toContain('The map service is busy right now.')
    s.tap('Try Again')
    expect(s.worker.calls.prepare).toHaveLength(2)
    expect(s.texts()).toContain('Getting the map')
  })

  it('reads anything else that goes wrong as broken, in plain words', async () => {
    const s = sheet()
    s.tap('Start')
    s.worker.steps.prepare[0].reject(new Error('undefined is not an object'))
    await flush()
    expect(s.texts()).toContain('Something went wrong working out the route. Nothing has changed.')
    expect(s.texts()).not.toContain('undefined is not an object')
  })

  it('starts afresh on Try Again after the worker broke getting the map', async () => {
    const s = sheet()
    s.tap('Start')
    s.worker.steps.prepare[0].reject(new OptimiseError({ kind: 'crashed', message: 'Something went wrong.' }))
    await flush()
    s.tap('Try Again')
    expect(s.worker.calls.prepare).toHaveLength(2)
    s.worker.steps.prepare[1].resolve(VIEW)
    await flush()
    expect(s.texts()).toContain('Find My Route')
  })

  it('runs with what was chosen', async () => {
    const s = sheet()
    await atChoices(s)
    s.toggle('Long Road', true)
    s.toggle('Keep my bundle order', false)
    s.tap('Find My Route')
    expect(s.worker.calls.solve).toEqual([{ allowed: { 'way:1': true, 'name:elm': true }, keepOrder: false }])
  })

  it('stops a run on Cancel and goes back to the choices, as they were, to run again', async () => {
    const s = sheet()
    const lib = s.state.lib
    await atChoices(s)
    s.toggle('Elm Street', false)
    s.tap('Find My Route')
    s.tap('Cancel')
    expect(s.worker.calls.cancel).toBe(1)
    await flush()
    expect(s.texts()).toContain('Keep my bundle order')
    expect(s.state.lib).toBe(lib)
    s.tap('Find My Route')
    expect(s.worker.calls.solve[1].allowed['name:elm']).toBe(false)
  })

  it('goes back to the choices from a run that broke', async () => {
    const s = sheet()
    await atChoices(s)
    s.tap('Find My Route')
    s.worker.steps.solve[0].reject(new OptimiseError({ kind: 'crashed', message: 'Something went wrong.' }))
    await flush()
    s.tap('Back to Choices')
    expect(s.texts()).toContain('Keep my bundle order')
  })

  it('works out the sections after the results are up, and only then offers Accept', async () => {
    const s = sheet()
    await atChoices(s)
    s.tap('Find My Route')
    s.worker.steps.solve[0].resolve(resultFor(activeRoute(s.state.lib)))
    await flush()
    expect(s.button('Accept').props?.disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(s.button('Accept').props?.disabled).toBe(false)
  })

  it('leaves the route as it was on Cancel at the results, and closes', async () => {
    const s = sheet()
    const lib = s.state.lib
    await atResults(s)
    s.tap('Cancel')
    expect(s.state.closes).toBe(1)
    expect(s.state.accepts).toBe(0)
    expect(s.state.lib).toBe(lib)
  })

  it('goes back for another run without fetching again', async () => {
    const s = sheet()
    await atResults(s)
    s.tap('Change Choices')
    s.tap('Find My Route')
    expect(s.worker.calls.prepare).toHaveLength(1)
    expect(s.worker.calls.solve).toHaveLength(2)
  })

  it('saves on Accept, once, and says where the old route is', async () => {
    const s = sheet()
    await atResults(s)
    s.tap('Accept')
    expect(s.button('Saving').props?.disabled).toBe(true)
    expect(s.state.accepts).toBe(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(s.state.accepts).toBe(1)
    expect(s.texts()).toContain('Your old route is kept as “Monday (before optimise)” in the Routes list.')
    expect(s.state.lib.routes.map((r) => r.name)).toEqual(['My Round', 'Monday', 'Monday (before optimise)'])
    expect(activeRoute(s.state.lib).name).toBe('Monday')
  })

  it('does nothing with a second tap', async () => {
    const s = sheet()
    await atResults(s)
    const accept = s.button('Accept').props?.onClick as () => void
    accept()
    s.render()
    accept()
    await vi.advanceTimersByTimeAsync(100)
    s.render()
    await vi.advanceTimersByTimeAsync(100)
    expect(s.state.accepts).toBe(1)
  })

  it('does not take Accept with a blocking problem, even if asked', async () => {
    const s = sheet()
    await atResults(s, { blocked: ['Elm Street is not thrown at.'] })
    expect(s.button('Accept').props?.disabled).toBe(true)
    s.tap('Accept')
    await vi.advanceTimersByTimeAsync(100)
    expect(s.state.accepts).toBe(0)
    expect(s.texts()).toContain('Elm Street is not thrown at.')
  })

  it('does not take Accept once the route has changed under it, even if asked', async () => {
    const s = sheet()
    const was = s.state.lib
    await atResults(s)
    s.state.lib = editActiveRoute(s.state.lib, { ...activeRoute(s.state.lib).route, points: LINE.slice(0, 2) }, 7)
    expect(s.texts()).toContain(STALE_REASON)
    expect(s.button('Accept').props?.disabled).toBe(true)
    s.tap('Accept')
    await vi.advanceTimersByTimeAsync(100)
    expect(s.state.accepts).toBe(0)
    expect(s.state.lib).not.toBe(was)
    expect(s.state.lib.routes).toHaveLength(was.routes.length)
  })

  it('says why, and keeps nothing, when Accept itself finds the route has changed', async () => {
    const s = sheet()
    await atResults(s)
    const changed = editActiveRoute(s.state.lib, { ...activeRoute(s.state.lib).route, points: LINE.slice(0, 2) }, 7)
    s.tap('Accept')
    s.state.lib = changed
    await vi.advanceTimersByTimeAsync(100)
    expect(s.state.lib).toBe(changed)
    expect(s.texts()).toContain(STALE_REASON)
    expect(s.button('Accept').props?.disabled).toBe(true)
    expect(s.button('Cancel').props?.disabled).toBe(false)
  })

  it('lets go if Accept breaks, rather than hold the sheet shut', async () => {
    const s = sheet(library(), () => {
      throw new Error('out of room')
    })
    await atResults(s)
    s.tap('Accept')
    await vi.advanceTimersByTimeAsync(100)
    expect(s.texts()).toContain('Something went wrong working out the route. Nothing has changed.')
    expect(s.button('Close').props?.disabled).toBe(false)
  })

  it('says why when the screen behind refuses', async () => {
    const s = sheet(library(), () => ({ ok: false, reason: 'No room to keep it.' }))
    await atResults(s)
    s.tap('Accept')
    await vi.advanceTimersByTimeAsync(100)
    expect(s.texts()).toContain('No room to keep it.')
  })

  /** The route with two stops along it, and a round on it with these done. */
  const withRound = (handledStopIds: string[]): Library => {
    const lib = library()
    const stops: Stop[] = [1, 2].map((n) => ({ id: `s${n}`, type: 'request', lat: -33.87 + n * 0.0007, lng: 151.20004, pathIdx: n - 1, label: `s${n}` }))
    return { ...lib, routes: lib.routes.map((r) => (r.id === lib.activeId ? { ...r, route: { ...r.route, stops }, round: { handledStopIds } } : r)) }
  }

  it('warns of a round in progress, from the route itself, and not of one that was finished', async () => {
    for (const [done, warns] of [
      [['s1'], true],
      [['s1', 's2'], false],
    ] as const) {
      const s = sheet(withRound([...done]))
      await atResults(s)
      expect(s.texts().includes(ROUND_RESET_WARNING), done.join()).toBe(warns)
    }
  })

  it('works out whether a round is under way once the results are up, and not again on every draw', async () => {
    vi.mocked(roundInProgress).mockClear()
    const s = sheet(withRound(['s1']))
    await atChoices(s)
    s.render()
    expect(roundInProgress).not.toHaveBeenCalled()
    s.tap('Find My Route')
    s.worker.steps.solve.at(-1)?.resolve(resultFor(activeRoute(s.state.lib)))
    await flush()
    s.render()
    await vi.advanceTimersByTimeAsync(100)
    for (let i = 0; i < 3; i++) s.render()
    expect(roundInProgress).toHaveBeenCalledTimes(1)
    expect(s.texts()).toContain(ROUND_RESET_WARNING)
  })

  it('reads the round with the reach the Round screen keeps houses quiet to, for the alert distance chosen there', async () => {
    for (const [stored, distance] of [
      [null, DEFAULT_ALERT_DISTANCE],
      ['60', 60],
    ] as const) {
      vi.stubGlobal('localStorage', { getItem: () => stored, setItem: () => undefined, removeItem: () => undefined })
      vi.mocked(roundInProgress).mockClear()
      const s = sheet(withRound(['s1']))
      await atResults(s)
      await vi.advanceTimersByTimeAsync(100)
      expect(roundInProgress).toHaveBeenCalledWith(expect.anything(), quietReachFor(distance))
    }
  })

  it('ends the worker when it goes, at any step', async () => {
    for (const reach of [async () => undefined, atChoices, atResults]) {
      const s = sheet()
      s.render()
      await reach(s)
      expect(s.worker.calls.close).toBe(0)
      unmount()
      expect(s.worker.calls.close).toBe(1)
    }
  })

  it('ends a run that is going when it goes, and nothing comes of what the worker says after', async () => {
    const s = sheet()
    await atChoices(s)
    s.tap('Find My Route')
    unmount()
    expect(s.worker.calls.close).toBe(1)
    await flush()
    expect(s.state.accepts).toBe(0)
  })

  const pressEscape = (handlers: ((e: { key: string }) => void)[]) => {
    for (const handler of handlers) handler({ key: 'Escape' })
  }
  const listening = () => {
    const handlers: ((e: { key: string }) => void)[] = []
    vi.stubGlobal('window', {
      addEventListener: (_: string, handler: (e: { key: string }) => void) => handlers.push(handler),
      removeEventListener: (_: string, handler: (e: { key: string }) => void) => {
        const at = handlers.indexOf(handler)
        if (at >= 0) handlers.splice(at, 1)
      },
    })
    return handlers
  }

  it('closes on Escape', () => {
    const handlers = listening()
    const s = sheet()
    s.render()
    pressEscape(handlers)
    expect(s.state.closes).toBe(1)
  })

  it('does not close on Escape where it would throw away a run or its choices, as a tap beside it would not', async () => {
    const handlers = listening()
    const s = sheet()
    await atChoices(s)
    pressEscape(handlers)
    s.tap('Find My Route')
    pressEscape(handlers)
    s.worker.steps.solve[0].reject(new OptimiseError({ kind: 'route', message: 'It could not be worked out.' }))
    await flush()
    s.render()
    expect(s.has('Back to Choices')).toBe(true)
    pressEscape(handlers)
    s.tap('Back to Choices')
    s.tap('Find My Route')
    s.worker.steps.solve[1].resolve(resultFor(activeRoute(s.state.lib)))
    await flush()
    s.render()
    pressEscape(handlers)
    expect(s.state.closes).toBe(0)
    s.tap('Close')
    expect(s.state.closes).toBe(1)
  })

  it('can not be closed while Accept is being written', async () => {
    const handlers = listening()
    const s = sheet()
    await atResults(s)
    s.tap('Accept')
    s.render()
    pressEscape(handlers)
    expect(s.state.closes).toBe(0)
    expect(s.button('Close').props?.disabled).toBe(true)
  })

  it('closes from its head at every other step', async () => {
    const s = sheet()
    await atResults(s)
    expect(s.button('Close').props?.disabled).toBe(false)
    s.tap('Close')
    expect(s.state.closes).toBe(1)
  })

  const scrim = (s: ReturnType<typeof sheet>) => find(s.render(), (n) => n.props?.className === 'load-scrim')[0]

  it('takes a tap beside it on the first step, and not over a run', async () => {
    const s = sheet()
    expect(scrim(s).props?.onClick).toBeDefined()
    await atChoices(s)
    expect(scrim(s).props?.onClick).toBeUndefined()
  })

  it('says Done in its head once the route is saved', async () => {
    const s = sheet()
    await atResults(s)
    s.tap('Accept')
    await vi.advanceTimersByTimeAsync(100)
    expect(s.has('Done')).toBe(true)
    expect(s.has('Close')).toBe(false)
  })

  it('is a dialog with a name, that fills the screen and takes the focus', () => {
    const s = sheet()
    const [dialog] = find(s.render(), (n) => n.props?.role === 'dialog')
    expect(dialog.props).toMatchObject({ 'aria-modal': 'true', 'aria-label': 'Optimise Route', tabIndex: -1 })
    expect(dialog.props?.className).toBe('load-sheet optimise-sheet')
  })

  it('holds back a tap on the foot that comes just after the step changed, as the second half of a double tap on the step before', () => {
    // A stand-in for a page's element: the button tapped, which is or isn't on the foot.
    class Spot {
      foot: boolean
      constructor(foot: boolean) {
        this.foot = foot
      }
      closest(selector: string) {
        return this.foot && selector === '.optimise-foot' ? this : null
      }
    }
    vi.stubGlobal('Element', Spot)
    let now = 1000
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const s = sheet()
      s.render()
      const tapOn = (foot: boolean) => {
        const [dialog] = find(s.render(), (n) => n.props?.role === 'dialog')
        const stop = vi.fn()
        fire(dialog, 'onClickCapture', { target: new Spot(foot), stopPropagation: stop })
        return stop.mock.calls.length > 0
      }
      now += 2000
      s.tap('Start')
      now += 100
      expect(tapOn(true)).toBe(true)
      expect(tapOn(false)).toBe(false)
      now += 400
      expect(tapOn(true)).toBe(false)
    } finally {
      clock.mockRestore()
    }
  })

  it('draws the map of the new route once, as nothing on the results step changes the route', async () => {
    const s = sheet()
    await atResults(s, { worthChecking: Array.from({ length: 20 }, (_, i) => ({ lat: 0, lng: 0, street: 'Elm Street', m: 90 - i, kind: 'one-side' as const, text: `Elm Street: stretch ${i + 1}.` })) })
    const mapOf = () => find(s.render(), (n) => typeof n.type === 'object' && n.type !== null && 'compare' in n.type)
    const [before] = mapOf()
    expect(before).toBeDefined()
    s.tap('Show All 20')
    const [afterTap] = mapOf()
    expect(afterTap.type).toBe(before.type)
    expect(afterTap.props?.route).toBe(before.props?.route)
  })
})

describe('the row on the Routes screen', () => {
  /** The Routes screen as the app has it. `troubles` says what keeps the phone from saving each change, as `update` reports it; it saves all of them unless told. */
  const routes = (lib: Library, onUpdate?: (lib: Library) => void, troubles: (SaveTrouble | null)[] = []) => {
    const state = { lib }
    const update = (change: (l: Library) => Library) => {
      state.lib = change(state.lib)
      onUpdate?.(state.lib)
      return troubles.shift() ?? null
    }
    hooks.slots = []
    hooks.pending = []
    hooks.cells = []
    const render = (): El => {
      hooks.at = 0
      return Routes({ library: state.lib, update, onGoSetup: () => undefined }) as El
    }
    return { state, render }
  }

  const rowsOf = (tree: unknown) => find(tree, (n) => n.type === 'button' && n.props?.className === 'row').map(words)

  beforeEach(() => {
    vi.stubGlobal('document', { body: {} })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('comes after Duplicate, in the group of the route in use', () => {
    const rows = rowsOf(routes(library()).render())
    expect(rows.slice(0, 4)).toEqual(['Rename', 'Duplicate', 'Optimise Route', 'Delete'])
  })

  it('is not there for a route with no line to work on', () => {
    expect(rowsOf(routes(addRoute(createLibrary(), 'Monday')).render())).not.toContain('Optimise Route')
  })

  const open = (r: ReturnType<typeof routes>): El => {
    const [row] = find(r.render(), (n) => n.type === 'button' && words(n) === 'Optimise Route')
    fire(row, 'onClick')
    const [opened] = find(r.render(), (n) => n.type === OptimiseSheet)
    expect(opened).toBeDefined()
    return opened
  }

  it('opens the sheet on the route in use', () => {
    const r = routes(library())
    expect(find(r.render(), (n) => n.type === OptimiseSheet)).toEqual([])
    expect(open(r).props?.saved).toBe(activeRoute(r.state.lib))
  })

  it('closes it again, with the route as it was', () => {
    const r = routes(library())
    const before = r.state.lib
    fire(open(r), 'onClose')
    expect(find(r.render(), (n) => n.type === OptimiseSheet)).toEqual([])
    expect(r.state.lib).toBe(before)
  })

  it('saves Accept, keeping the old route under its own name, and says so', () => {
    const r = routes(library())
    const onAccept = open(r).props?.onAccept as (result: OptimiseResult) => AcceptOutcome
    const outcome = onAccept(resultFor(activeRoute(r.state.lib)))
    expect(outcome).toMatchObject({ ok: true, kept: { name: 'Monday (before optimise)' } })
    expect(r.state.lib.routes.map((x) => x.name)).toEqual(['My Round', 'Monday', 'Monday (before optimise)'])
    expect(words(r.render())).toContain('Route optimised. Your old route is kept as “Monday (before optimise)”.')
  })

  it('refuses Accept when the phone has no room to keep it, with the routes put back as they were and no word that it worked', () => {
    const r = routes(library(), undefined, ['full'])
    const before = r.state.lib
    const onAccept = open(r).props?.onAccept as (result: OptimiseResult) => AcceptOutcome
    expect(onAccept(resultFor(activeRoute(before)))).toEqual({ ok: false, reason: NO_ROOM_REASON })
    expect(r.state.lib).toBe(before)
    expect(words(r.render())).not.toContain('Route optimised')
    expect(NO_ROOM_REASON).toMatch(/run Optimise Route again/)
  })

  it('refuses Accept on a phone that saves nothing with words that say so, not that there is no room, as deleting a route would not help', () => {
    const r = routes(library(), undefined, ['blocked', 'blocked'])
    const before = r.state.lib
    const onAccept = open(r).props?.onAccept as (result: OptimiseResult) => AcceptOutcome
    expect(onAccept(resultFor(activeRoute(before)))).toEqual({ ok: false, reason: NO_SAVE_REASON })
    expect(r.state.lib).toBe(before)
    expect(words(r.render())).not.toContain('Route optimised')
    expect(NO_SAVE_REASON).toMatch(/isn't letting the app save/)
    expect(NO_SAVE_REASON).toMatch(/run Optimise Route again/)
    expect(NO_SAVE_REASON).not.toMatch(/room|Delete/)
  })

  it('refuses a result for a route that has changed, and changes nothing', () => {
    const r = routes(library())
    const onAccept = open(r).props?.onAccept as (result: OptimiseResult) => AcceptOutcome
    const result = resultFor(activeRoute(r.state.lib))
    const changed = editActiveRoute(r.state.lib, { ...activeRoute(r.state.lib).route, points: LINE.slice(0, 2) }, 7)
    r.state.lib = changed
    expect(onAccept(result)).toEqual({ ok: false, reason: STALE_REASON })
    expect(r.state.lib).toBe(changed)
  })

  it('refuses a result with a blocking problem, and changes nothing', () => {
    const r = routes(library())
    const before = r.state.lib
    const onAccept = open(r).props?.onAccept as (result: OptimiseResult) => AcceptOutcome
    expect(onAccept(resultFor(activeRoute(r.state.lib), { blocked: ['Elm Street is not thrown at.'] }))).toEqual({ ok: false, reason: 'Elm Street is not thrown at.' })
    expect(r.state.lib).toBe(before)
  })
})

const source = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')
const css = source('optimise.css').replace(/\/\*[\s\S]*?\*\//g, '')

describe('what the app carries', () => {
  it('leaves the engine in the worker', () => {
    for (const file of ['OptimiseSheet.tsx', 'optimiseFlow.ts', 'Routes.tsx', 'optimise/accept.ts', 'optimise/client.ts', 'optimise/run.ts']) {
      const imports = [...source(file).matchAll(/^import (?!type )[^\n]*from '([^']+)'/gm)].map((m) => m[1])
      expect(imports.filter((i) => /optimise\/(optimise|handler|osmFetch|worker)$|^\.\/(optimise|handler|osmFetch|worker)$/.test(i)), file).toEqual([])
    }
  })

  it('starts the worker only through the client, from inside the app, so no file is fetched after start-up', () => {
    const client = source('optimise/client.ts')
    expect(client).toContain("import OptimiseWorker from './worker?worker&inline'")
    expect(client).not.toContain("new URL('./worker")
    expect(source('OptimiseSheet.tsx')).not.toContain('new Worker')
  })

  it('draws in the colours of the theme, so it follows dark mode', () => {
    const colours = [...css.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0])
    expect(new Set(colours)).toEqual(new Set(['#fff']))
  })

  it('gives the map of the new route room for a whole round, and leaves room to scroll past it on any screen', () => {
    expect(/\.optimise-map \{[^}]*height: min\(420px, 60vh\);/.exec(css)).not.toBeNull()
  })

})
