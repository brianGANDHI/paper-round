import { describe, expect, it } from 'vitest'
import { STALE_REASON } from './optimise/accept'
import { CRASHED_MESSAGE, NOT_READY_MESSAGE } from './optimise/protocol'
import { COVER_GATE_M, defaultChoices } from './optimise/run'
import type { OptimiseResult, PreparedView, RouteStats, StreetChoice, TurnBack, WorthChecking } from './optimise/types'
import {
  acceptGate,
  advance,
  bundleSummary,
  canClose,
  closesOnTapBeside,
  closingNote,
  FIRST_STEP,
  gapNote,
  hasBundleOrder,
  keepOrderNote,
  keptText,
  length,
  moreOnText,
  notesFirst,
  savingText,
  SHOWN_CHECKS,
  shownChecks,
  startLine,
  statRows,
  streetGroups,
  streetNote,
  streetOn,
  TAP_THROUGH_MS,
  tooSoon,
  turnBackRows,
  unmatchedLines,
  workingLine,
  type ChoicesState,
  type OptimiseEvent,
  type OptimiseState,
  type ResultsState,
} from './optimiseFlow'

/** The figures of a route, made up. */
const stats = (over: Partial<RouteStats> = {}): RouteStats => ({ km: 20, mapKm: 20.2, closingKm: 0, closedKm: 20.2, left: 12, right: 0.4, both: 5, transit: 2.6, twiceKm: 0.3, uturns: 9, sideChanges: 31, ...over })

const VIEW: PreparedView = {
  basedOn: { routeId: 'r', updatedAt: 1, fingerprint: 'f' },
  start: { lat: -33, lng: 151, section: 'Start' },
  streets: [
    { key: 'way:1', name: 'Long Road', km: 3.2, main: true, allowed: false },
    { key: 'name:elm', name: 'Elm Street', km: 0.8, main: false, allowed: true },
    { key: 'name:oak', name: 'Oak Avenue', km: 1.1, main: false, allowed: true },
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

const RESULT: OptimiseResult = {
  route: { points: [], sideChanges: [] },
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
  basedOn: VIEW.basedOn,
}

/** The state after these things have happened, from the start. */
const after = (...events: OptimiseEvent[]): OptimiseState => events.reduce(advance, FIRST_STEP)

const fetching = (): OptimiseState => after({ type: 'start' })
const choices = (): OptimiseState => after({ type: 'start' }, { type: 'prepared', view: VIEW })
const solving = (): OptimiseState => advance(choices(), { type: 'run' })

function results(result: OptimiseResult = RESULT, placed: string[] | null = []): ResultsState {
  const state = advance(solving(), { type: 'solved', result })
  const done = placed ? advance(state, { type: 'placed', unplaced: placed }) : state
  if (done.step !== 'results') throw new Error('not at the results')
  return done
}

const accepting = (): OptimiseState => advance(results(), { type: 'accept' })
const failed = (kind: 'offline' | 'busy' | 'nothing' | 'route' | 'crashed' | 'not-ready', from: OptimiseState = fetching()): OptimiseState => advance(from, { type: 'failed', kind, message: `It was ${kind}` })

describe('from the start', () => {
  it('opens on the words about what it does', () => {
    expect(FIRST_STEP).toEqual({ step: 'intro' })
  })

  it('goes to get the map when asked', () => {
    expect(after({ type: 'start' })).toEqual({ step: 'fetching', progress: null })
  })

  it('takes nothing else', () => {
    const others: OptimiseEvent[] = [
      { type: 'progress', progress: { step: 'x', done: 0.5 } },
      { type: 'prepared', view: VIEW },
      { type: 'failed', kind: 'busy', message: 'x' },
      { type: 'cancel' },
      { type: 'keep-order', on: false },
      { type: 'street', key: 'k', on: false },
      { type: 'run' },
      { type: 'solved', result: RESULT },
      { type: 'placed', unplaced: [] },
      { type: 'back' },
      { type: 'show-all-checks' },
      { type: 'accept' },
      { type: 'accepted', kept: 'x', unplaced: [] },
      { type: 'refused', reason: 'x' },
    ]
    for (const event of others) expect(advance(FIRST_STEP, event), event.type).toBe(FIRST_STEP)
  })
})

describe('while the map is fetched', () => {
  it('shows how it is going, a bar for each part of the step', () => {
    const one = advance(fetching(), { type: 'progress', progress: { step: 'Getting the map', done: 0.9 } })
    expect(one).toEqual({ step: 'fetching', progress: { step: 'Getting the map', done: 0.9 } })
    expect(advance(one, { type: 'progress', progress: { step: 'Reading the map', done: 0.1 } })).toEqual({ step: 'fetching', progress: { step: 'Reading the map', done: 0.1 } })
  })

  it('goes on to the choices, with each street at its default and the bundle order kept', () => {
    expect(advance(fetching(), { type: 'prepared', view: VIEW })).toEqual({
      step: 'choices',
      view: VIEW,
      choices: { allowed: { 'way:1': false, 'name:elm': true, 'name:oak': true }, keepOrder: true },
      allStreets: false,
      pinned: [],
    })
  })

  it('does not keep an order where there is none to keep, as holding it only makes the search weaker', () => {
    for (const bundles of [[], [VIEW.bundles[0]]]) {
      expect(hasBundleOrder({ bundles })).toBe(false)
      expect(advance(fetching(), { type: 'prepared', view: { ...VIEW, bundles } })).toMatchObject({ step: 'choices', choices: { keepOrder: false } })
    }
    expect(hasBundleOrder(VIEW)).toBe(true)
    expect(defaultChoices(VIEW).keepOrder).toBe(true)
  })

  it('goes back to the start on Cancel', () => {
    expect(advance(fetching(), { type: 'cancel' })).toEqual({ step: 'intro' })
  })

  it('takes no notice of the word that a step was cancelled', () => {
    const state = fetching()
    expect(advance(state, { type: 'failed', kind: 'cancelled', message: 'Cancelled.' })).toBe(state)
  })

  it('offers Try Again when offline or the server is busy', () => {
    expect(failed('offline')).toEqual({ step: 'failed', message: 'It was offline', recovery: 'try-again' })
    expect(failed('busy')).toEqual({ step: 'failed', message: 'It was busy', recovery: 'try-again' })
  })

  it('has nothing to offer when another fetch would give the same', () => {
    for (const kind of ['nothing', 'route'] as const) expect(failed(kind)).toMatchObject({ step: 'failed', recovery: 'none' })
  })

  it('offers Try Again when the worker broke, as that starts a new one', () => {
    expect(failed('crashed')).toEqual({ step: 'failed', message: 'It was crashed', recovery: 'try-again' })
    expect(advance(failed('crashed'), { type: 'start' })).toEqual({ step: 'fetching', progress: null })
  })

  it('starts from the first step when told it is not ready', () => {
    expect(failed('not-ready')).toEqual({ step: 'failed', message: 'It was not-ready', recovery: 'start-again' })
  })

  it('does not run ahead', () => {
    const state = fetching()
    expect(advance(state, { type: 'run' })).toBe(state)
    expect(advance(state, { type: 'solved', result: RESULT })).toBe(state)
  })
})

describe('after a failure', () => {
  it('fetches again on Try Again, from the top of the bar', () => {
    expect(advance(failed('busy'), { type: 'start' })).toEqual({ step: 'fetching', progress: null })
    expect(advance(failed('not-ready'), { type: 'start' })).toEqual({ step: 'fetching', progress: null })
  })

  it('has no way on where it offered none', () => {
    const state = failed('nothing')
    expect(advance(state, { type: 'start' })).toBe(state)
    expect(advance(state, { type: 'back' })).toBe(state)
  })

  it('does not go to the choices from a failed fetch', () => {
    const state = failed('busy')
    expect(advance(state, { type: 'back' })).toBe(state)
  })

  it('goes back to the choices from a failed run, as they were', () => {
    const changed = advance(advance(choices(), { type: 'keep-order', on: false }), { type: 'run' })
    const state = failed('crashed', changed)
    expect(state).toMatchObject({ step: 'failed', message: 'It was crashed', recovery: 'choices' })
    expect(advance(state, { type: 'back' })).toMatchObject({ step: 'choices', choices: { keepOrder: false } })
  })

  it('does not fetch again from a failed run, as the choices are there to go back to', () => {
    const state = failed('route', solving())
    expect(advance(state, { type: 'start' })).toBe(state)
  })

  it('starts over when a run is told it is not ready, as the map has gone', () => {
    expect(advance(solving(), { type: 'failed', kind: 'not-ready', message: NOT_READY_MESSAGE })).toEqual({ step: 'failed', message: NOT_READY_MESSAGE, recovery: 'start-again' })
  })

  it('takes a failure only while something is running', () => {
    for (const state of [choices(), results(), failed('busy')]) expect(advance(state, { type: 'failed', kind: 'crashed', message: CRASHED_MESSAGE })).toBe(state)
  })
})

describe('the choices', () => {
  it('switches keep order off and on again', () => {
    const off = advance(choices(), { type: 'keep-order', on: false })
    expect(off).toMatchObject({ choices: { keepOrder: false } })
    expect(advance(off, { type: 'keep-order', on: true })).toMatchObject({ choices: { keepOrder: true } })
  })

  it('switches one street and leaves the rest', () => {
    expect(advance(choices(), { type: 'street', key: 'way:1', on: true })).toMatchObject({ choices: { allowed: { 'way:1': true, 'name:elm': true, 'name:oak': true } } })
    expect(advance(choices(), { type: 'street', key: 'name:oak', on: false })).toMatchObject({ choices: { allowed: { 'way:1': false, 'name:elm': true, 'name:oak': false } } })
  })

  it('changes nothing in what it was given', () => {
    const state = choices()
    const before = JSON.stringify(state)
    advance(state, { type: 'street', key: 'way:1', on: true })
    expect(JSON.stringify(state)).toBe(before)
  })

  it('takes a change only on this step', () => {
    for (const state of [fetching(), solving(), results()]) {
      expect(advance(state, { type: 'keep-order', on: false })).toBe(state)
      expect(advance(state, { type: 'street', key: 'way:1', on: true })).toBe(state)
      expect(advance(state, { type: 'show-all-streets' })).toBe(state)
    }
  })

  it('lists every street when asked', () => {
    expect(advance(choices(), { type: 'show-all-streets' })).toMatchObject({ step: 'choices', allStreets: true })
  })

  it('keeps in view the other streets that are off, each time the step comes up, and not the main roads, which are always listed', () => {
    const off = advance(advance(choices(), { type: 'street', key: 'name:oak', on: false }), { type: 'street', key: 'way:1', on: false })
    expect(off).toMatchObject({ pinned: [] })
    const back = advance(advance(advance(off, { type: 'run' }), { type: 'solved', result: RESULT }), { type: 'back' })
    expect(back).toMatchObject({ step: 'choices', allStreets: false, pinned: ['name:oak'] })
    expect(advance(advance(off, { type: 'run' }), { type: 'cancel' })).toMatchObject({ pinned: ['name:oak'] })
    expect(advance(failed('crashed', advance(off, { type: 'run' })), { type: 'back' })).toMatchObject({ pinned: ['name:oak'] })
  })

  it('keeps a street it kept in view there when it is switched back on, so it does not vanish from under the finger', () => {
    const back = advance(advance(advance(advance(choices(), { type: 'street', key: 'name:oak', on: false }), { type: 'run' }), { type: 'solved', result: RESULT }), { type: 'back' })
    expect(advance(back, { type: 'street', key: 'name:oak', on: true })).toMatchObject({ choices: { allowed: { 'name:oak': true } }, pinned: ['name:oak'] })
  })

  it('runs with the choices as they stand', () => {
    const state = advance(advance(choices(), { type: 'keep-order', on: false }), { type: 'run' })
    expect(state).toMatchObject({ step: 'solving', choices: { keepOrder: false }, progress: null })
  })
})

describe('while the route is worked out', () => {
  it('shows how it is going', () => {
    expect(advance(solving(), { type: 'progress', progress: { step: 'Searching', done: 0.4 } })).toMatchObject({ step: 'solving', progress: { step: 'Searching', done: 0.4 } })
  })

  it('goes back to the choices on Cancel, with what was chosen', () => {
    const state = advance(advance(choices(), { type: 'street', key: 'way:1', on: true }), { type: 'run' })
    expect(advance(state, { type: 'cancel' })).toMatchObject({ step: 'choices', view: VIEW, choices: { allowed: { 'way:1': true } } })
    expect(advance(state, { type: 'cancel' })).not.toHaveProperty('progress')
  })

  it('takes no notice of the word that a run was cancelled', () => {
    const state = solving()
    expect(advance(state, { type: 'failed', kind: 'cancelled', message: 'Cancelled.' })).toBe(state)
  })

  it('takes no notice of a word that comes late', () => {
    const state = advance(solving(), { type: 'cancel' })
    expect(advance(state, { type: 'progress', progress: { step: 'x', done: 1 } })).toBe(state)
    expect(advance(state, { type: 'solved', result: RESULT })).toBe(state)
    expect(advance(state, { type: 'failed', kind: 'crashed', message: 'x' })).toBe(state)
  })

  it('goes on to the results, with the sections still to be worked out', () => {
    expect(advance(solving(), { type: 'solved', result: RESULT })).toMatchObject({ step: 'results', result: RESULT, unplaced: null, accepting: false, refused: null, allChecks: false })
  })
})

describe('the results', () => {
  it('takes in the sections that can not be placed', () => {
    expect(advance(results(RESULT, null), { type: 'placed', unplaced: ['Beach End'] })).toMatchObject({ unplaced: ['Beach End'] })
  })

  it('goes back to the choices as they were, for another run', () => {
    const state = advance(advance(advance(choices(), { type: 'keep-order', on: false }), { type: 'run' }), { type: 'solved', result: RESULT })
    expect(advance(state, { type: 'back' })).toMatchObject({ step: 'choices', choices: { keepOrder: false } })
  })

  it('runs again from there and starts the results afresh', () => {
    const again = advance(advance(advance(results(), { type: 'show-all-checks' }), { type: 'back' }), { type: 'run' })
    expect(advance(again, { type: 'solved', result: RESULT })).toMatchObject({ unplaced: null, allChecks: false })
  })

  it('shows the whole list of things worth checking when asked', () => {
    expect(results().allChecks).toBe(false)
    expect(advance(results(), { type: 'show-all-checks' })).toMatchObject({ allChecks: true })
  })
})

describe('Accept', () => {
  it('starts when tapped', () => {
    expect(accepting()).toMatchObject({ step: 'results', accepting: true })
  })

  it('waits for the sections to be worked out, as what they come to is part of the choice', () => {
    const state = results(RESULT, null)
    expect(advance(state, { type: 'accept' })).toBe(state)
  })

  it('is not taken while a problem stands', () => {
    const state = results({ ...RESULT, blocked: ['Elm Street is not thrown at.'] })
    expect(advance(state, { type: 'accept' })).toBe(state)
  })

  it('is not taken twice', () => {
    const state = accepting()
    expect(advance(state, { type: 'accept' })).toBe(state)
  })

  it('can not be left while it is being written', () => {
    const state = accepting()
    expect(advance(state, { type: 'back' })).toBe(state)
    expect(canClose(state)).toBe(false)
  })

  it('ends by saying where the old route went and what was not placed', () => {
    expect(advance(accepting(), { type: 'accepted', kept: 'Monday (before optimise)', unplaced: ['Beach End'] })).toEqual({ step: 'accepted', kept: 'Monday (before optimise)', unplaced: ['Beach End'] })
  })

  it('says why when it is refused, and can be left again', () => {
    const state = advance(accepting(), { type: 'refused', reason: STALE_REASON })
    expect(state).toMatchObject({ step: 'results', accepting: false, refused: STALE_REASON })
    expect(canClose(state)).toBe(true)
  })

  it('takes neither outcome unless it was asked for', () => {
    const state = results()
    expect(advance(state, { type: 'accepted', kept: 'x', unplaced: [] })).toBe(state)
    expect(advance(state, { type: 'refused', reason: 'x' })).toBe(state)
  })

  it('stays done', () => {
    const done = advance(accepting(), { type: 'accepted', kept: 'x', unplaced: [] })
    for (const event of [{ type: 'accept' }, { type: 'back' }, { type: 'start' }, { type: 'cancel' }, { type: 'run' }] as OptimiseEvent[]) expect(advance(done, event)).toBe(done)
  })
})

describe('whether Accept is offered', () => {
  it('is yes with nothing against it', () => {
    expect(acceptGate(results(), false)).toEqual({ ready: true, why: [] })
  })

  it('is no, saying why, for each problem', () => {
    const gate = acceptGate(results({ ...RESULT, blocked: ['One thing.', 'Another.'] }), false)
    expect(gate).toEqual({ ready: false, why: ['One thing.', 'Another.'] })
  })

  it('is no when the route has changed since the run', () => {
    expect(acceptGate(results(), true)).toEqual({ ready: false, why: [STALE_REASON] })
  })

  it('is no, with nothing to explain, until the sections are worked out', () => {
    expect(acceptGate(results(RESULT, null), false)).toEqual({ ready: false, why: [] })
  })

  it('is no while Accept is being done', () => {
    const state = accepting()
    if (state.step !== 'results') throw new Error('not at the results')
    expect(acceptGate(state, false).ready).toBe(false)
  })

  it('says the reason Accept gave, once', () => {
    const state = advance(accepting(), { type: 'refused', reason: STALE_REASON })
    if (state.step !== 'results') throw new Error('not at the results')
    expect(acceptGate(state, true).why).toEqual([STALE_REASON])
  })
})

describe('closing the sheet', () => {
  it('can be done at every step but while Accept is written', () => {
    for (const state of [FIRST_STEP, fetching(), choices(), solving(), results(), failed('busy')]) expect(canClose(state)).toBe(true)
  })

  it('takes a tap beside the sheet only where nothing would be lost', () => {
    expect(closesOnTapBeside(FIRST_STEP)).toBe(true)
    expect(closesOnTapBeside(failed('busy'))).toBe(true)
    expect(closesOnTapBeside(advance(accepting(), { type: 'accepted', kept: 'x', unplaced: [] }))).toBe(true)
    for (const state of [fetching(), choices(), solving(), results()]) expect(closesOnTapBeside(state)).toBe(false)
  })

  it('does not take one after a run that failed, as the choices are kept to go back to', () => {
    const state = failed('route', solving())
    expect(state).toMatchObject({ recovery: 'choices' })
    expect(closesOnTapBeside(state)).toBe(false)
    expect(closesOnTapBeside(failed('not-ready', solving()))).toBe(true)
  })
})

describe('a double tap', () => {
  it('is held back from the foot of a step that has only just come up', () => {
    expect(tooSoon(0)).toBe(true)
    expect(tooSoon(TAP_THROUGH_MS - 1)).toBe(true)
    expect(tooSoon(TAP_THROUGH_MS)).toBe(false)
    expect(tooSoon(2000)).toBe(false)
  })

  it('leaves time for no more than a double tap, so a real tap is never lost for long', () => {
    expect(TAP_THROUGH_MS).toBeGreaterThanOrEqual(250)
    expect(TAP_THROUGH_MS).toBeLessThanOrEqual(500)
  })
})

describe('a step that is running', () => {
  it('says what the worker is doing under the title', () => {
    expect(workingLine('fetching', { step: 'The map service is busy, so trying another', done: 0.2 })).toBe('The map service is busy, so trying another')
    expect(workingLine('solving', { step: 'Looking for a better drive', done: 0.5 })).toBe('Looking for a better drive')
  })

  it('never says the title over again, and says what it waits on instead', () => {
    expect(workingLine('fetching', { step: 'Getting the map', done: 0 })).toBe('Asking the map service')
    expect(workingLine('solving', { step: 'Finding your route', done: 0 })).toBe('')
  })

  it('has something to say before the first word from the worker', () => {
    expect(workingLine('fetching', null)).toBe('Starting')
  })
})

describe('the words on the choices screen', () => {
  it('names the section the route starts at', () => {
    expect(startLine({ lat: 0, lng: 0, section: 'START' })).toEqual({ title: 'START', note: 'The new route starts and ends at this section.' })
  })

  it("says so when it is the route's first point", () => {
    expect(startLine({ lat: 0, lng: 0, section: null })).toEqual({ title: "The route's first point", note: 'No section is called Start, so the new route starts and ends here.' })
  })

  it('says what the switch does each way', () => {
    expect(keepOrderNote(true)).toBe('Your bundles stay in your order.')
    expect(keepOrderNote(false)).toBe('Gets the shortest route. Your bundle list then follows the new drive.')
  })

  it('gives each street its length, and says which are main roads', () => {
    expect(streetNote({ km: 3.24, main: true })).toBe('Main road · 3.2 km')
    expect(streetNote({ km: 0.8, main: false })).toBe('800 m')
  })

  it('gives a short street its length in metres, so it never reads as nothing', () => {
    expect(streetNote({ km: 0.037, main: true })).toBe('Main road · 37 m')
    expect(length(0.027)).toBe('27 m')
    expect(length(1.04)).toBe('1.0 km')
  })

  it('reads a street from the choices, or its default where they leave it out', () => {
    const street = { key: 'k', allowed: false }
    expect(streetOn({ allowed: { k: true }, keepOrder: true }, street)).toBe(true)
    expect(streetOn({ allowed: {}, keepOrder: true }, street)).toBe(false)
  })

  const listing = (state: OptimiseState) => {
    if (state.step !== 'choices') throw new Error('not at the choices')
    return streetGroups(state.view.streets, state).map((g) => [g.label, g.streets.map((s) => s.name), g.moreOn])
  }

  it('sets the main roads apart, first', () => {
    expect(listing(choices())).toEqual([
      ['Main roads', ['Long Road'], 0],
      ['Other streets', ['Elm Street', 'Oak Avenue'], 0],
    ])
  })

  it('has no group for a kind of street there is none of', () => {
    expect(listing(after({ type: 'start' }, { type: 'prepared', view: { ...VIEW, streets: VIEW.streets.filter((s) => !s.main) } })).map((g) => g[0])).toEqual(['Other streets'])
  })

  /** A round with many streets: two main roads, and these other streets, each on unless it is named in `off`. */
  const manyStreets = (count: number, off: number[] = []): StreetChoice[] => [
    { key: 'way:1', name: 'Long Road', km: 3.2, main: true, allowed: false },
    { key: 'way:2', name: 'Ridge Road', km: 1.2, main: true, allowed: false },
    ...Array.from({ length: count }, (_, i) => ({ key: `name:${i}`, name: `Street ${i}`, km: 0.3, main: false, allowed: !off.includes(i) })),
  ]
  const choosing = (streets: StreetChoice[]): ChoicesState => {
    const state = after({ type: 'start' }, { type: 'prepared', view: { ...VIEW, streets } })
    if (state.step !== 'choices') throw new Error('not at the choices')
    return state
  }

  it('folds a long list of other streets into a count of those that are on, until Show All', () => {
    expect(listing(choosing(manyStreets(135)))).toEqual([
      ['Main roads', ['Long Road', 'Ridge Road'], 0],
      ['Other streets', [], 135],
    ])
    const all = listing(advance(choosing(manyStreets(135)), { type: 'show-all-streets' }))
    expect(all[1][1]).toHaveLength(135)
    expect(all[1][2]).toBe(0)
  })

  it('lists any other street that is off, and counts only those that are on', () => {
    expect(listing(choosing(manyStreets(135, [4, 90])))).toEqual([
      ['Main roads', ['Long Road', 'Ridge Road'], 0],
      ['Other streets', ['Street 4', 'Street 90'], 133],
    ])
  })

  it('lists a street turned off when the choices come up again, and keeps it there when it is turned back on', () => {
    const open = advance(choosing(manyStreets(135)), { type: 'show-all-streets' })
    const off = advance(open, { type: 'street', key: 'name:7', on: false })
    const back = advance(advance(off, { type: 'run' }), { type: 'cancel' })
    expect(listing(back)[1]).toEqual(['Other streets', ['Street 7'], 134])
    expect(listing(advance(back, { type: 'street', key: 'name:7', on: true }))[1]).toEqual(['Other streets', ['Street 7'], 134])
  })

  it('lists a short list in full, as a count would save next to nothing', () => {
    expect(listing(choosing(manyStreets(8)))[1][2]).toBe(0)
    expect(listing(choosing(manyStreets(12, [0, 1, 2, 3])))[1][2]).toBe(0)
  })

  it('says how many other streets are on', () => {
    expect(moreOnText(135)).toBe('135 other streets are on')
    expect(moreOnText(1)).toBe('1 other street is on')
  })

  it('warns before a run of a thrown part that is not on the map and will keep Accept off, once for each street', () => {
    const part = { lat: 0, lng: 0, m: 30, thrown: true, street: 'Elm Street' }
    expect(unmatchedLines([part, part, { ...part, thrown: false, street: 'Oak Avenue' }])).toEqual(["Part of today's route near Elm Street isn't on any road on the map, so Accept will stay off."])
  })

  it('says nothing before a run of a thrown part too short to keep Accept off', () => {
    expect(unmatchedLines([{ lat: 0, lng: 0, m: 10, thrown: true, street: 'Elm Street' }])).toEqual([])
    expect(unmatchedLines([{ lat: 0, lng: 0, m: COVER_GATE_M, thrown: true, street: 'Elm Street' }])).toHaveLength(1)
  })
})

describe('the figures', () => {
  it('sets today and the new route side by side, in the order of the spec', () => {
    const rows = statRows(stats({ closedKm: 21.06, left: 12.34, right: 0.44, both: 5.05, transit: 2.61, twiceKm: 0.76, uturns: 83, sideChanges: 194 }), stats({ closedKm: 20.04, left: 11, right: 0.05, both: 6, transit: 3, twiceKm: 0.1, uturns: 72, sideChanges: 220 }))
    expect(rows.map((r) => [r.label, r.before, r.after])).toEqual([
      ['Total', '21.1 km', '20.0 km'],
      ['Port', '12.3 km', '11.0 km'],
      ['Starboard', '0.4 km', '0.1 km'],
      ['Both', '5.0 km', '6.0 km'],
      ['Transit', '2.6 km', '3.0 km'],
      ['Thrown twice', '0.8 km', '0.1 km'],
      ['U-turns', '83', '72'],
      ['Side changes', '194', '220'],
    ])
  })

  it('gives the sides their stored names for their colours, and shows Port and Starboard', () => {
    const rows = statRows(stats(), stats())
    expect(rows.filter((r) => r.side).map((r) => [r.side, r.label])).toEqual([
      ['left', 'Port'],
      ['right', 'Starboard'],
      ['both', 'Both'],
      ['transit', 'Transit'],
    ])
  })

  it('compares the route closed, as a route that ends elsewhere still has to get home', () => {
    expect(statRows(stats({ km: 19, closingKm: 0.9, closedKm: 21.1 }), stats())[0].before).toBe('21.1 km')
  })

  it("puts today's way back to the start in its transit, as the new route's own way back is in its transit", () => {
    const rows = statRows(stats({ transit: 10.3, closingKm: 0.88 }), stats({ transit: 11.17 }))
    expect(rows.find((r) => r.label === 'Transit')).toMatchObject({ before: '11.2 km', after: '11.2 km' })
    expect(statRows(stats({ transit: 10.3 }), stats()).find((r) => r.label === 'Transit')?.before).toBe('10.3 km')
  })

  it('says how much shorter or longer', () => {
    expect(savingText(stats({ closedKm: 20 }), stats({ closedKm: 18.72 }), true)).toBe('1.3 km shorter than today')
    expect(savingText(stats({ closedKm: 18 }), stats({ closedKm: 18.4 }), false)).toBe('0.4 km longer than today')
  })

  it('says plainly when a route kept to the bundle order comes out longer', () => {
    expect(savingText(stats({ closedKm: 18 }), stats({ closedKm: 18.4 }), true)).toBe('0.4 km longer than today, keeping your bundle order')
  })

  it('calls lengths that read the same the same', () => {
    expect(savingText(stats({ closedKm: 20 }), stats({ closedKm: 19.97 }), true)).toBe('About the same length as today')
    expect(savingText(stats({ closedKm: 20 }), stats({ closedKm: 20.04 }), true)).toBe('About the same length as today')
  })

  it('puts the notes of a run up top where a route kept to the bundle order comes out longer, as they say why', () => {
    expect(notesFirst({ keepOrder: true, before: stats({ closedKm: 18 }), after: stats({ closedKm: 18.4 }) })).toBe(true)
    expect(notesFirst({ keepOrder: false, before: stats({ closedKm: 18 }), after: stats({ closedKm: 18.4 }) })).toBe(false)
    expect(notesFirst({ keepOrder: true, before: stats({ closedKm: 18 }), after: stats({ closedKm: 17 }) })).toBe(false)
    expect(notesFirst({ keepOrder: true, before: stats({ closedKm: 18 }), after: stats({ closedKm: 18.04 }) })).toBe(false)
  })

  /** Today's figures for a route that closes, drawn along its roads. */
  const closed = (over: Partial<RouteStats> = {}) => stats({ km: 20, mapKm: 20, closingKm: 0, closedKm: 20, ...over })

  it("says, in one note, that today's total and transit include the way back and that the total is measured along the roads", () => {
    expect(closingNote(stats({ km: 84.78, mapKm: 85.11, closingKm: 0.88, closedKm: 85.99 }))).toBe(
      "Today's total and transit include 0.9 km back to the start. Today's total is measured along the roads, and its sides and transit along your line as drawn, which comes to about 0.3 km less.",
    )
  })

  it('says only what applies', () => {
    expect(closingNote(closed({ closingKm: 0.88, closedKm: 20.88 }))).toBe("Today's total and transit include 0.9 km back to the start.")
    expect(closingNote(closed({ mapKm: 20.3, closedKm: 20.3 }))).toBe("Today's total is measured along the roads, and its sides and transit along your line as drawn, which comes to about 0.3 km less.")
    expect(closingNote(closed({ mapKm: 19.8, closedKm: 19.8 }))).toBe("Today's total is measured along the roads, and its sides and transit along your line as drawn, which comes to about 0.2 km more.")
  })

  it('says nothing for a route that closes, drawn along its roads', () => {
    expect(closingNote(closed())).toBeNull()
    expect(closingNote(closed({ closingKm: 0.04, mapKm: 20.04 }))).toBeNull()
  })
})

describe('the lists on the results screen', () => {
  const turn = (street: string, level: TurnBack['level'], alsoToday = false): TurnBack => ({ lat: 0, lng: 0, street, level, alsoToday })

  it('lists the most awkward turns first, those new to the driver before those not', () => {
    expect(turnBackRows([turn('A', 'plain'), turn('B', 'plain', true), turn('C', 'busy', true), turn('D', 'main'), turn('E', 'busy')])).toEqual([
      { street: 'D', note: 'On a main road' },
      { street: 'E', note: 'On a busy road' },
      { street: 'C', note: 'On a busy road, as you do today' },
      { street: 'A', note: 'On a quiet street' },
      { street: 'B', note: 'On a quiet street, as you do today' },
    ])
  })

  const list = (over: Partial<OptimiseResult['bundles']>): OptimiseResult['bundles'] => ({ before: [{ id: 'a', name: 'Shop' }], after: [{ id: 'a', name: 'Shop' }], changed: false, fits: true, stranded: [], store: null, ...over })

  it('says a kept order is kept', () => {
    expect(bundleSummary({ keepOrder: true, bundles: list({}) })).toEqual({ note: 'Your bundle order stays as it is.', order: [] })
  })

  it('shows the new order when it has changed', () => {
    const after = [
      { id: 'b', name: 'Newsagent' },
      { id: 'a', name: 'Shop' },
    ]
    expect(bundleSummary({ keepOrder: false, bundles: list({ changed: true, fits: false, after }) })).toEqual({ note: 'Your bundle list will follow the new drive.', order: after })
  })

  it('says so when the shortest route happens to keep the order', () => {
    expect(bundleSummary({ keepOrder: false, bundles: list({}) })).toEqual({ note: 'Your bundle order stays as it is.', order: [] })
  })

  it('has nothing to say with no bundles, or when the list blocks Accept', () => {
    expect(bundleSummary({ keepOrder: true, bundles: list({ before: [], after: [] }) })).toBeNull()
    expect(bundleSummary({ keepOrder: true, bundles: list({ fits: false }) })).toBeNull()
  })

  const check = (m: number, kind: WorthChecking['kind'] = 'gap'): WorthChecking => ({ lat: 0, lng: 0, street: 'Elm', m, kind, text: `${kind} ${m}` })

  it('shows the longest of what is worth checking until asked for the rest', () => {
    const checks = Array.from({ length: SHOWN_CHECKS + 5 }, (_, i) => check(100 - i))
    expect(shownChecks(checks, false)).toHaveLength(SHOWN_CHECKS)
    expect(shownChecks(checks, false)[0]).toBe(checks[0])
    expect(shownChecks(checks, true)).toHaveLength(checks.length)
  })

  /** The list as the engine gives it, longest first: one-sided stretches, which are all longer, then the stretches the new route leaves. */
  const mixed = (oneSided: number, gaps: number) => [...Array.from({ length: oneSided }, (_, i) => check(200 - i, 'one-side')), ...Array.from({ length: gaps }, (_, i) => check(15 - i * 0.1))]

  it('shows what the new route stops throwing at first, half and half with the one-sided stretches', () => {
    const shown = shownChecks(mixed(10, 10), false)
    expect(shown.map((c) => c.kind)).toEqual(['gap', 'gap', 'gap', 'gap', 'one-side', 'one-side', 'one-side', 'one-side'])
    expect(shown[0].m).toBe(15)
    expect(shown[4].m).toBe(200)
  })

  it('fills from the other kind where one runs short', () => {
    expect(shownChecks(mixed(20, 0), false).map((c) => c.kind)).toEqual(Array(SHOWN_CHECKS).fill('one-side'))
    expect(shownChecks(mixed(2, 20), false).map((c) => c.kind)).toEqual(['gap', 'gap', 'gap', 'gap', 'gap', 'gap', 'one-side', 'one-side'])
    expect(shownChecks(mixed(20, 2), false).map((c) => c.kind)).toEqual(['gap', 'gap', 'one-side', 'one-side', 'one-side', 'one-side', 'one-side', 'one-side'])
  })

  it('shows the whole list in the same order, the stretches the new route stops throwing at first', () => {
    const all = shownChecks(mixed(10, 10), true)
    expect(all).toHaveLength(20)
    expect(all.slice(0, 10).every((c) => c.kind === 'gap')).toBe(true)
  })

  it('only ever says about for the gaps, and says where they are when most are at the ends of courts', () => {
    expect(gapNote([{ m: 200, atHead: true }, { m: 60, atHead: false }], 0.26)).toBe("About 0.3 km thrown at today isn't thrown at on the new route, mostly at the ends of courts where it turns on a point.")
    expect(gapNote([{ m: 60, atHead: true }, { m: 200, atHead: false }], 0.26)).toBe("About 0.3 km thrown at today isn't thrown at on the new route.")
  })

  it('has nothing to say of gaps too small to show', () => {
    expect(gapNote([{ m: 10, atHead: true }], 0.01)).toBeNull()
  })

  it('says where the old route is and how to get back to it', () => {
    expect(keptText('Monday (before optimise)')).toBe('Your old route is kept as “Monday (before optimise)” in the Routes list. Tap it there to go back to it.')
  })
})
