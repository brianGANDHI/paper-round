import { describe, expect, it } from 'vitest'
import { alertSide, DEFAULT_ALERT_DISTANCE, QUIET_REACH_M, quietReachFor } from '../alerts'
import { makeBackup, parseBackup, toBackupRoute } from '../backup'
import { occurrences, passesNear, type Occurrence } from '../geo'
import { activeRoute, MAX_NAME, selectRoute, setBundleOrder } from '../library'
import { DEFAULT_LOAD } from '../load'
import { anchorAt, resolveSections } from '../namedSections'
import { nearestOnRoute } from '../routeEdit'
import { missingQueries, nameTurns, streetQueries } from '../streets'
import { routeTurns } from '../turns'
import type { Library, LoadList, NamedSection, Pt, RoundState, Route, SavedRoute, Stop, TurnStreet } from '../types'
import { acceptOptimised, ROUND_RESET_WARNING, roundInProgress, STALE_REASON, unplacedSections } from './accept'
import { bundlePasses, walkList } from './list'
import { defaultChoices, prepare, solve } from './optimise'
import { basedOnOf } from './run'
import { drive, gridWays, osmOf, place, savedRoute, stopAt, type Cell, type Stretch } from './testNetwork'
import type { Budget, OptimiseResult, RouteStats } from './types'

const QUICK: Budget = { iterations: 4000, seed: 1 }
const NOW = 1000
const STATS: RouteStats = { km: 1, mapKm: 1, closingKm: 0, closedKm: 1, left: 1, right: 0, both: 0, transit: 0, twiceKm: 0, uturns: 0, sideChanges: 0 }
const LOAD: LoadList = { lines: [{ id: 'l1', bundles: 3, kind: 'bagged', note: '1 pallet' }], papersEach: DEFAULT_LOAD.papersEach }

/** Round the block east along the top and home along the bottom. */
const CLOCKWISE = drive([['left', [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0]]])
/** The same block the other way round. */
const WIDDERSHINS = drive([['left', [0, 0], [0, 1], [1, 1], [2, 1], [3, 1], [3, 0], [2, 0], [1, 0], [0, 0]]])

/** A finished run with nothing to report, for these points. */
const resultOf = (saved: SavedRoute, route: Pick<Route, 'points' | 'sideChanges'>, extra: Partial<OptimiseResult> = {}): OptimiseResult => ({
  route,
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
  bundles: { before: [], after: [], changed: false, fits: true, stranded: [], store: saved.bundleOrder ?? null },
  streets: [],
  basedOn: basedOnOf(saved),
  ...extra,
})

const libraryOf = (saved: SavedRoute, ...others: SavedRoute[]): Library => ({ routes: [saved, ...others], activeId: saved.id })

function accepted(library: Library, result: OptimiseResult) {
  const outcome = acceptOptimised(library, result, NOW)
  if (!outcome.ok) throw new Error(outcome.reason)
  const active = outcome.library.routes.find((r) => r.id === outcome.library.activeId) as SavedRoute
  const copy = outcome.library.routes.find((r) => r.id === outcome.kept.id) as SavedRoute
  return { ...outcome, active, copy }
}

/** A section starting at a cell of a route, on that route's pass of it nearest `m`, if given. */
function sectionAt(points: Pt[], cell: Cell, name: string, nth = 0): NamedSection {
  const pass = passesNear(points, place(cell))[nth]
  const section = anchorAt(points, pass.at, name, `id-${name.toLowerCase()}`)
  if (!section) throw new Error(`no section at ${name}`)
  return section
}

const resolved = (r: SavedRoute) => resolveSections(r.route.points, r.sections ?? [])
const namesInOrder = (r: SavedRoute) => resolved(r).list.filter((s) => !s.lead).map((s) => s.name)

describe('the route it leaves in use', () => {
  it('is the new line, with its sides, and is still the route in use, with its id and name', () => {
    const saved = savedRoute(CLOCKWISE, [], { name: 'Monday' })
    const { active, library } = accepted(libraryOf(saved), resultOf(saved, WIDDERSHINS))
    expect(library.activeId).toBe(saved.id)
    expect(active.id).toBe(saved.id)
    expect(active.name).toBe('Monday')
    expect(active.route.points).toEqual(WIDDERSHINS.points)
    expect(active.route.sideChanges).toEqual(WIDDERSHINS.sideChanges)
    expect(active.updatedAt).toBe(NOW)
  })

  it('changes nothing about another route', () => {
    const saved = savedRoute(CLOCKWISE)
    const other = savedRoute(WIDDERSHINS, [], { id: 'r2', name: 'Other' })
    const { library } = accepted(libraryOf(saved, other), resultOf(saved, WIDDERSHINS))
    expect(library.routes.find((r) => r.id === 'r2')).toBe(other)
  })

  it('does not change the library it was given', () => {
    const saved = savedRoute(CLOCKWISE, [stopAt('a', 'bundle', [1, 0])], { bundleOrder: ['a'] })
    const library = libraryOf(saved)
    const was = structuredClone(library)
    accepted(library, resultOf(saved, WIDDERSHINS))
    expect(library).toEqual(was)
  })
})

describe('the stops', () => {
  const STOPS: Stop[] = [stopAt('one', 'bundle', [1.5, 0]), stopAt('two', 'nothrow', [2.5, 1], { pathIdx: 2, address: '2 Some St' }), stopAt('three', 'request', [3, 0.5], { note: 'Blue gate', pathIdx: 3 }), stopAt('four', 'block', [0.5, 1], { qty: 12 })]

  it('keeps every stop, with its id and everything about it but its place along the route', () => {
    const saved = savedRoute(CLOCKWISE, STOPS)
    const { active } = accepted(libraryOf(saved), resultOf(saved, WIDDERSHINS))
    expect(active.route.stops.map((s) => s.id)).toEqual(['one', 'two', 'three', 'four'])
    expect(active.route.stops.map(({ pathIdx: _a, ...s }) => s)).toEqual(STOPS.map(({ pathIdx: _a, ...s }) => s))
  })

  it('finds each stop its nearest segment of the new line, as the app places one', () => {
    const saved = savedRoute(CLOCKWISE, STOPS)
    const { active } = accepted(libraryOf(saved), resultOf(saved, WIDDERSHINS))
    for (const s of active.route.stops) {
      expect(s.pathIdx).toBe(nearestOnRoute({ points: WIDDERSHINS.points }, s)?.idx)
      const { points } = active.route
      // Stored order is no guide to the new line: the first stop is on its sixth segment now, not its second.
      expect(s.pathIdx).toBeLessThan(points.length - 1)
    }
    expect(active.route.stops[0].pathIdx).toBe(6)
  })

  const sideOf = (r: SavedRoute, id: string, n = 0) => {
    const occs = occurrences(r.route)
    return alertSide(r.route, occs, occs.filter((o: Occurrence) => o.stop.id === id)[n])
  }

  it('swaps a side picked by hand where the first pass now runs the other way, so the same pass says the same side', () => {
    const saved = savedRoute(CLOCKWISE, [stopAt('house', 'nothrow', [1.5, 0], { side: 'left' })])
    const { active } = accepted(libraryOf(saved), resultOf(saved, WIDDERSHINS))
    expect(active.route.stops[0].side).toBe('right')
    expect(sideOf(saved, 'house')).toBe('left')
    expect(sideOf(active, 'house')).toBe('right')
  })

  it('leaves a side picked by hand where the first pass runs the way it did', () => {
    const saved = savedRoute(CLOCKWISE, [stopAt('house', 'nothrow', [1.5, 0], { side: 'right' })])
    const round = drive([['both', [0, 0], [1, 0], [2, 0], [2, 1], [3, 1], [3, 0], [2, 0], [1, 0], [0, 0]]])
    const { active } = accepted(libraryOf(saved), resultOf(saved, round))
    expect(active.route.stops[0].side).toBe('right')
  })

  it('goes by the first pass of each route, not the nearest, on a street driven both ways', () => {
    // East and back on the old route, and on the new one back first and then east: its first pass runs the other way.
    const old = drive([['both', [0, 0], [1, 0], [2, 0], [1, 0], [0, 0]]])
    const next = drive([['both', [2, 0], [1, 0], [0, 0], [1, 0], [2, 0]]])
    const saved = savedRoute(old, [stopAt('house', 'nothrow', [1, 0], { side: 'left' })])
    const { active } = accepted(libraryOf(saved), resultOf(saved, next))
    expect(active.route.stops[0].side).toBe('right')
  })

  it('leaves alone a stop with no side picked', () => {
    const saved = savedRoute(CLOCKWISE, [stopAt('house', 'nothrow', [1.5, 0])])
    const { active } = accepted(libraryOf(saved), resultOf(saved, WIDDERSHINS))
    expect(active.route.stops[0]).not.toHaveProperty('side')
  })
})

describe('the round', () => {
  it('starts over on the route in use, as any edit does, and the copy keeps it as it was, so going back loses nothing', () => {
    const round = { handledStopIds: ['a'], furthest: 500, startM: 100, dropped: ['a'], courtLegs: { a: 'out' as const } }
    const saved = savedRoute(CLOCKWISE, [stopAt('a', 'bundle', [1, 0])], { round })
    const { active, copy, library, kept } = accepted(libraryOf(saved), resultOf(saved, WIDDERSHINS))
    expect(active.round).toEqual({ handledStopIds: [] })
    expect(copy.round).toEqual(round)
    expect(copy.round).not.toBe(saved.round)
    const back = activeRoute(selectRoute(library, kept.id))
    expect(back.route).toEqual(saved.route)
    expect(back.round).toEqual(saved.round)
  })

  describe('can say a round is under way, so the screen can warn of it', () => {
    const STOPS = [stopAt('a', 'request', [1.5, 0]), stopAt('b', 'request', [2.5, 1])]
    const REACH = quietReachFor(DEFAULT_ALERT_DISTANCE)
    const underWay = (round: RoundState) => roundInProgress(savedRoute(CLOCKWISE, STOPS, { round }), REACH)

    it('is not for a round with nothing done', () => {
      expect(underWay({ handledStopIds: [] })).toBe(false)
    })

    it('is for one half done', () => {
      expect(underWay({ handledStopIds: ['a'], furthest: 200 })).toBe(true)
    })

    it('is for one driven or started some way with no stop done yet', () => {
      expect(underWay({ handledStopIds: [], furthest: 100 })).toBe(true)
      expect(underWay({ handledStopIds: [], startM: 100 })).toBe(true)
    })

    it('is not for one that was finished, which keeps what was done until the next starts', () => {
      expect(underWay({ handledStopIds: ['a', 'b'], furthest: 800 })).toBe(false)
    })

    it('is not for a route with nothing on it to do', () => {
      expect(roundInProgress(savedRoute(CLOCKWISE, [], { round: { handledStopIds: [], furthest: 100 } }), REACH)).toBe(false)
    })

    describe('with a no-throw house set back from a stretch that is only driven', () => {
      // Along the top with nothing thrown, and the house well back from it; the requests are on the way home, where papers are thrown.
      const ROUTE = drive([['transit', [0, 0], [1, 0], [2, 0], [3, 0]], ['left', [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0]]])
      const STOPS = [stopAt('house', 'nothrow', [1.5, -0.45]), stopAt('a', 'request', [3, 0.5]), stopAt('b', 'request', [1.5, 1])]
      const underWayAt = (round: RoundState, reachM: number) => roundInProgress(savedRoute(ROUTE, STOPS, { round }), reachM)

      it('sits between the shortest reach and the one for the alert distance the round starts with', () => {
        const off = occurrences({ points: ROUTE.points, stops: STOPS }).filter((o) => o.stop.id === 'house').map((o) => o.off)
        expect(off).toHaveLength(1)
        expect(off[0]).toBeGreaterThan(QUIET_REACH_M)
        expect(off[0]).toBeLessThan(REACH)
      })

      it('goes by the reach the Round screen uses, which keeps the house quiet, so a round with the requests done is finished', () => {
        expect(underWayAt({ handledStopIds: ['a', 'b'], furthest: 800 }, REACH)).toBe(false)
        // At the shortest reach the house would be a stop still to do, which the Round screen at this distance never alerts for or marks done.
        expect(underWayAt({ handledStopIds: ['a', 'b'], furthest: 800 }, QUIET_REACH_M)).toBe(true)
      })

      it('still says a round half done is under way', () => {
        expect(underWayAt({ handledStopIds: ['a'], furthest: 400 }, REACH)).toBe(true)
      })
    })

    it('has words for it', () => {
      expect(ROUND_RESET_WARNING).toMatch(/start over/)
    })
  })
})

describe('the bundle order', () => {
  const STOPS = [stopAt('a', 'bundle', [1, 0]), stopAt('b', 'bundle', [2, 0])]

  it('is written down when the run says to', () => {
    const saved = savedRoute(CLOCKWISE, STOPS)
    const result = resultOf(saved, WIDDERSHINS)
    const { active } = accepted(libraryOf(saved), { ...result, bundles: { ...result.bundles, store: ['a', 'b'] } })
    expect(active.bundleOrder).toEqual(['a', 'b'])
  })

  it('is taken off when the run says to, so the list follows the new drive, and the old route keeps its own', () => {
    const saved = savedRoute(CLOCKWISE, STOPS, { bundleOrder: ['b', 'a'] })
    const result = resultOf(saved, WIDDERSHINS)
    const { active, copy } = accepted(libraryOf(saved), { ...result, bundles: { ...result.bundles, store: null } })
    expect(active).not.toHaveProperty('bundleOrder')
    expect(copy.bundleOrder).toEqual(['b', 'a'])
  })
})

describe('the named sections', () => {
  it('are placed afresh on the new line, keeping their ids and their order', () => {
    const sections = [sectionAt(CLOCKWISE.points, [1, 0], 'Top'), sectionAt(CLOCKWISE.points, [2, 1], 'Bottom')]
    const saved = savedRoute(CLOCKWISE, [], { sections })
    const round = drive([['both', [0, 0], [1, 0], [1, 1], [2, 1], [3, 1], [3, 0], [2, 0], [1, 0], [0, 0]]])
    const { active, unplaced } = accepted(libraryOf(saved), resultOf(saved, round))
    expect(unplaced).toEqual([])
    expect(active.sections?.map((s) => s.id)).toEqual(['id-top', 'id-bottom'])
    expect(namesInOrder(active)).toEqual(['Top', 'Bottom'])
    expect(resolved(active).detached).toEqual([])
  })

  it('never carries a pass number across: a section on the second pass of the old route is on the only pass of the new one', () => {
    const old = drive([['both', [0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [1, 0], [2, 0], [3, 0]]])
    const section = sectionAt(old.points, [1.5, 0], 'Second', 1)
    expect(section.pass).toBe(2)
    const saved = savedRoute(old, [], { sections: [section] })
    const once = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0]]])
    const { active, unplaced } = accepted(libraryOf(saved), resultOf(saved, once))
    expect(unplaced).toEqual([])
    expect(active.sections?.[0]).not.toHaveProperty('pass')
    expect(active.sections?.[0].id).toBe('id-second')
  })

  it('takes a later pass where that is what keeps them in order, and says so with a pass number of its own', () => {
    const old = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0]]])
    const sections = [sectionAt(old.points, [2.5, 0], 'First'), sectionAt(old.points, [0.5, 0], 'Second')].reverse()
    const saved = savedRoute(old, [], { sections })
    // The old route has Second, then First. The new one meets First's spot first, so First's place in order is on its last pass of the spot.
    const there = drive([['both', [2, 0], [3, 0], [2, 0], [1, 0], [0, 0], [1, 0], [2, 0], [3, 0], [3, 1]]])
    const { active, unplaced } = accepted(libraryOf(saved), resultOf(saved, there))
    expect(unplaced).toEqual([])
    expect(namesInOrder(active)).toEqual(['Second', 'First'])
    const first = active.sections?.find((s) => s.id === 'id-first')
    expect(first?.pass).toBe(3)
  })

  it('finds a place for the most it can, and one early section with its only pass at the end does not push out the rest', () => {
    const old = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0]]])
    const sections = [sectionAt(old.points, [0.5, 0], 'A'), sectionAt(old.points, [1.5, 0], 'B'), sectionAt(old.points, [2.5, 0], 'C')]
    const saved = savedRoute(old, [], { sections })
    const round = drive([['both', [0, 1], [1, 1], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0], [1, 0]]])
    const { active, unplaced } = accepted(libraryOf(saved), resultOf(saved, round))
    expect(namesInOrder(active)).toEqual(['B', 'C'])
    expect(unplaced).toEqual(['A'])
  })

  it('can say before Accept which sections will not go on, and they are the ones Accept leaves off', () => {
    const old = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0]]])
    const sections = [sectionAt(old.points, [0.5, 0], 'A'), sectionAt(old.points, [1.5, 0], 'B'), sectionAt(old.points, [2.5, 0], 'C')]
    const saved = savedRoute(old, [], { sections })
    const round = drive([['both', [0, 1], [1, 1], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0], [1, 0]]])
    expect(unplacedSections(saved, round.points)).toEqual(['A'])
    expect(accepted(libraryOf(saved), resultOf(saved, round)).unplaced).toEqual(['A'])
  })

  it('lists a section whose spot the new route does not go near, and leaves it off', () => {
    const old = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0], [3, 2]]])
    const sections = [sectionAt(old.points, [1, 0], 'Stays'), sectionAt(old.points, [3, 2], 'Gone', 0)].slice(0, 1)
    sections.push({ id: 'gone', name: 'Gone', lat: place([3, 1.5]).lat, lng: place([3, 1.5]).lng })
    const saved = savedRoute(old, [], { sections })
    const short = drive([['both', [0, 0], [1, 0], [2, 0]]])
    const { active, unplaced, copy } = accepted(libraryOf(saved), resultOf(saved, short))
    expect(active.sections?.map((s) => s.name)).toEqual(['Stays'])
    expect(unplaced).toEqual(['Gone'])
    expect(copy.sections).toEqual(sections)
  })

  it('lists one that already could not be placed on the old route, and does not scramble it back in', () => {
    const old = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0]]])
    const loose: NamedSection = { id: 'loose', name: 'Loose', lat: place([1, 2]).lat, lng: place([1, 2]).lng }
    const saved = savedRoute(old, [], { sections: [sectionAt(old.points, [1, 0], 'Fine'), loose] })
    const { active, unplaced } = accepted(libraryOf(saved), resultOf(saved, drive([['both', [0, 0], [1, 0], [1, 1], [1, 2], [2, 2]]])))
    expect(unplaced).toEqual(['Loose'])
    expect(active.sections?.map((s) => s.name)).toEqual(['Fine'])
  })

  it('starts the order at the section called Start, where the new route starts', () => {
    const old = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0]]])
    const start = sectionAt(old.points, [3, 1], 'START')
    const other = sectionAt(old.points, [1, 0], 'Top')
    const saved = savedRoute(old, [], { sections: [other, start] })
    const fromStart = drive([['both', [3, 1], [2, 1], [1, 1], [0, 1], [0, 0], [1, 0], [2, 0], [3, 0], [3, 1]]])
    const { active, unplaced } = accepted(libraryOf(saved), resultOf(saved, fromStart))
    expect(unplaced).toEqual([])
    expect(namesInOrder(active)).toEqual(['START', 'Top'])
    expect(resolved(active).list[0]).toMatchObject({ name: 'START', startM: 0, lead: false })
  })

  describe('the one called Start, which the new route was made to start at', () => {
    const LOOP = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0]]])
    const startAt0 = (r: SavedRoute) => expect(resolved(r).list[0]).toMatchObject({ name: 'Start', startM: 0, lead: false })

    it('goes at metre 0 when the route begins a little way from its spot and leaves it the other way, passing it again only near the end', () => {
      // Start is 40 m before the corner the new route begins at, which is where the run would find the nearest node to it.
      const saved = savedRoute(LOOP, [], { sections: [sectionAt(LOOP.points, [0.64, 0], 'Start'), sectionAt(LOOP.points, [3, 0.5], 'Far'), sectionAt(LOOP.points, [2.5, 1], 'Bottom')] })
      const fromCorner = drive([['both', [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0], [1, 0]]])
      const { active, unplaced } = accepted(libraryOf(saved), resultOf(saved, fromCorner))
      expect(unplaced).toEqual([])
      expect(namesInOrder(active)).toEqual(['Start', 'Far', 'Bottom'])
      startAt0(active)
      // So the next run starts from the same place.
      expect(active.sections?.find((s) => s.name === 'Start')).toMatchObject(place([1, 0]))
    })

    it('goes at metre 0, not at a pass of its spot part way along, behind a stand-in for the start', () => {
      const saved = savedRoute(LOOP, [], { sections: [sectionAt(LOOP.points, [0.64, 0], 'Start'), sectionAt(LOOP.points, [3, 0.5], 'Far'), sectionAt(LOOP.points, [2.5, 1], 'Bottom')] })
      const twice = drive([['both', [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1]]])
      const { active, unplaced } = accepted(libraryOf(saved), resultOf(saved, twice))
      expect(unplaced).toEqual([])
      expect(namesInOrder(active)).toEqual(['Start', 'Far', 'Bottom'])
      startAt0(active)
    })

    // The old loop, with the run begun at Start, down the right-hand lane, as it would be.
    const FROM_START = drive([['both', [3, 0.5], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0], [1, 0], [2, 0], [3, 0], [3, 0.5]]])
    const around = (extra: NamedSection[]) => [
      sectionAt(LOOP.points, [0.5, 0], 'A'),
      sectionAt(LOOP.points, [2.5, 0], 'B'),
      ...extra,
      sectionAt(LOOP.points, [2.5, 1], 'C'),
      sectionAt(LOOP.points, [0.5, 1], 'D'),
      sectionAt(LOOP.points, [0, 0.5], 'E'),
    ]

    it('turns the order round at it when another section just before it keeps it off the old route', () => {
      const sections = around([sectionAt(LOOP.points, [3, 0.4], 'Elm'), sectionAt(LOOP.points, [3, 0.5], 'Start')])
      const saved = savedRoute(LOOP, [], { sections })
      expect(resolved(saved).detached.map((d) => d.section.name)).toEqual(['Start'])
      const { active, unplaced } = accepted(libraryOf(saved), resultOf(saved, FROM_START))
      // Elm is now in the last few metres of the route, where no section goes.
      expect(unplaced).toEqual(['Elm'])
      expect(namesInOrder(active)).toEqual(['Start', 'C', 'D', 'E', 'A', 'B'])
      startAt0(active)
    })

    it('turns it round at the first stored of two called Start, which is the one the run starts at', () => {
      const sections = [sectionAt(LOOP.points, [3, 0.5], 'Start'), ...around([{ ...sectionAt(LOOP.points, [1.5, 0], 'start'), id: 'id-other-start' }])]
      const saved = savedRoute(LOOP, [], { sections })
      const { active, unplaced } = accepted(libraryOf(saved), resultOf(saved, FROM_START))
      expect(unplaced).toEqual([])
      expect(namesInOrder(active)).toEqual(['Start', 'C', 'D', 'E', 'A', 'start', 'B'])
      startAt0(active)
    })

    it('goes at metre 0 even when it had come off the old route, as the run started there all the same', () => {
      const off = place([0.5, -1.5])
      const saved = savedRoute(LOOP, [], { sections: [sectionAt(LOOP.points, [2.5, 0], 'B'), { id: 'id-start', name: 'Start', ...off }] })
      expect(resolved(saved).detached.map((d) => d.section.name)).toEqual(['Start'])
      const { active, unplaced } = accepted(libraryOf(saved), resultOf(saved, LOOP))
      expect(unplaced).toEqual([])
      expect(namesInOrder(active)).toEqual(['Start', 'B'])
      startAt0(active)
    })
  })

  it('gives a section no place in the last few metres of the route, where there would be nothing in it', () => {
    const old = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0], [3, 1]]])
    const saved = savedRoute(old, [], { sections: [sectionAt(old.points, [3, 0], 'Far end')] })
    expect(accepted(libraryOf(saved), resultOf(saved, old)).unplaced).toEqual([])
    const stopsThere = drive([['both', [1, 0], [2, 0], [3, 0]]])
    expect(accepted(libraryOf(saved), resultOf(saved, stopsThere)).unplaced).toEqual(['Far end'])
  })

  it('has no sections key on a route with none', () => {
    const saved = savedRoute(CLOCKWISE)
    const { active } = accepted(libraryOf(saved), resultOf(saved, WIDDERSHINS))
    expect(active).not.toHaveProperty('sections')
  })
})

describe('the street names', () => {
  /** What the map would give for a route's turns. */
  const mapNames = (points: Pt[], name: string): TurnStreet[] => streetQueries(points, routeTurns(points)).flatMap((q, i) => (q ? [{ lat: q.lat, lng: q.lng, out: q.out, name: `${name} ${i}` }] : []))

  it('drops those no turn of the new route uses, and fills the rest from the map, so nothing is left to look up', () => {
    const old = mapNames(CLOCKWISE.points, 'Old')
    const saved = savedRoute(CLOCKWISE, [], { streets: old })
    const { active } = accepted(libraryOf(saved), resultOf(saved, WIDDERSHINS, { streets: mapNames(WIDDERSHINS.points, 'Map') }))
    const turns = routeTurns(active.route.points)
    expect(missingQueries(active.route.points, turns, active.streets ?? [])).toEqual([])
    expect(active.streets?.some((s) => s.name.startsWith('Old'))).toBe(false)
    const named = nameTurns(active.route.points, turns, active.streets ?? [])
    expect(named.filter((t) => t.street).length).toBeGreaterThan(1)
  })

  it('keeps a name found for a turn the new route still makes, and takes the map only for the others', () => {
    const next = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [2, 0], [1, 0], [0, 0]]])
    const saved = savedRoute(CLOCKWISE, [], { streets: mapNames(CLOCKWISE.points, 'Old') })
    const { active } = accepted(libraryOf(saved), resultOf(saved, next, { streets: mapNames(next.points, 'Map') }))
    const names = active.streets?.map((s) => s.name.split(' ')[0]) ?? []
    expect(names).toContain('Old')
    expect(names).toContain('Map')
    expect(missingQueries(next.points, routeTurns(next.points), active.streets ?? [])).toEqual([])
  })

  it('takes a road with no name on the map as an answer', () => {
    const saved = savedRoute(CLOCKWISE)
    const blank = mapNames(WIDDERSHINS.points, '').map((s) => ({ ...s, name: '' }))
    const { active } = accepted(libraryOf(saved), resultOf(saved, WIDDERSHINS, { streets: blank }))
    expect(active.streets).toHaveLength(blank.length)
    expect(missingQueries(WIDDERSHINS.points, routeTurns(WIDDERSHINS.points), active.streets ?? [])).toEqual([])
  })
})

describe('the list of what to load', () => {
  it('stays with the route and goes with the copy, which has one of its own', () => {
    const saved = savedRoute(CLOCKWISE, [], { load: LOAD })
    const { active, copy } = accepted(libraryOf(saved), resultOf(saved, WIDDERSHINS))
    expect(active.load).toEqual(LOAD)
    expect(copy.load).toEqual(LOAD)
    expect(copy.load).not.toBe(active.load)
  })
})

describe('the copy of the old route', () => {
  const STOPS = [stopAt('a', 'bundle', [1, 0], { pathIdx: 1, side: 'left' }), stopAt('b', 'bundle', [2, 1], { pathIdx: 4 })]
  const streets = [{ lat: place([3, 0]).lat, lng: place([3, 0]).lng, out: 180, name: 'Hazel Lane' }]

  it('really is the old route, with all that goes with it, under the name the driver will see', () => {
    const sections = [sectionAt(CLOCKWISE.points, [1, 0], 'Top'), sectionAt(CLOCKWISE.points, [2, 1], 'Bottom')]
    const saved = savedRoute(CLOCKWISE, STOPS, { name: "Sam's Round", sections, streets, bundleOrder: ['b', 'a'], load: LOAD, round: { handledStopIds: ['a'] } })
    const before = structuredClone(saved)
    const { copy, kept, library } = accepted(libraryOf(saved), resultOf(saved, WIDDERSHINS))
    expect(kept.name).toBe("Sam's Round (before optimise)")
    expect(copy.name).toBe(kept.name)
    expect(copy.id).not.toBe(saved.id)
    expect(copy.route).toEqual(before.route)
    expect(copy.sections).toEqual(before.sections)
    expect(copy.streets).toEqual(before.streets)
    expect(copy.bundleOrder).toEqual(before.bundleOrder)
    expect(copy.load).toEqual(before.load)
    expect(copy.updatedAt).toBe(NOW)
    expect(library.routes.map((r) => r.id)).toEqual([saved.id, kept.id])
  })

  it('shares nothing with the route in use', () => {
    const saved = savedRoute(CLOCKWISE, STOPS)
    const { copy, active } = accepted(libraryOf(saved), resultOf(saved, CLOCKWISE))
    expect(copy.route.stops[0]).not.toBe(active.route.stops[0])
    expect(copy.route.points).not.toBe(active.route.points)
  })

  it('stays within the longest name, with the words that say what it is', () => {
    const saved = savedRoute(CLOCKWISE, [], { name: 'n'.repeat(MAX_NAME) })
    const { kept } = accepted(libraryOf(saved), resultOf(saved, WIDDERSHINS))
    expect(kept.name).toHaveLength(MAX_NAME)
    expect(kept.name.endsWith(' (before optimise)')).toBe(true)
  })

  it('takes a name no other route has, so a route optimised twice keeps both', () => {
    const first = savedRoute(CLOCKWISE, [], { name: 'Monday' })
    const once = accepted(libraryOf(first), resultOf(first, WIDDERSHINS))
    const twice = accepted(once.library, resultOf(once.active, CLOCKWISE))
    expect(once.kept.name).toBe('Monday (before optimise)')
    expect(twice.kept.name).toBe('Monday (before optimise 2)')
    expect(twice.library.routes).toHaveLength(3)
  })

  it('stays on the route that really is the old one, when the copy is gone back to and optimised again, and again', () => {
    const SQUARE = drive([['both', [0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [0, 1], [0, 0]]])
    const first = savedRoute(CLOCKWISE, [], { name: 'Monday' })
    const once = accepted(libraryOf(first), resultOf(first, WIDDERSHINS))
    let library = selectRoute(once.library, once.kept.id)
    const twice = accepted(library, resultOf(activeRoute(library), SQUARE))
    expect(twice.kept.name).toBe('Monday (before optimise)')
    expect(twice.copy.route).toEqual(first.route)
    expect(twice.active.name).toBe('Monday 2')
    expect(twice.active.route.points).toEqual(SQUARE.points)
    library = selectRoute(twice.library, twice.kept.id)
    const thrice = accepted(library, resultOf(activeRoute(library), WIDDERSHINS))
    expect(thrice.kept.name).toBe('Monday (before optimise)')
    expect(thrice.copy.route).toEqual(first.route)
    expect(thrice.library.routes.map((r) => r.name)).toEqual(['Monday', 'Monday 2', 'Monday 3', 'Monday (before optimise)'])
    expect(thrice.active.name).toBe('Monday 3')
  })

  it('never puts the label on twice, on a name cut short to take it', () => {
    const first = savedRoute(CLOCKWISE, [], { name: 'n'.repeat(MAX_NAME) })
    const once = accepted(libraryOf(first), resultOf(first, WIDDERSHINS))
    const library = selectRoute(once.library, once.kept.id)
    const twice = accepted(library, resultOf(activeRoute(library), CLOCKWISE))
    expect(twice.kept.name).toBe(once.kept.name)
    expect(twice.active.name).toBe(once.kept.name.replace(' (before optimise)', ''))
    expect(twice.library.routes.filter((r) => r.name.includes('(before')).map((r) => r.id)).toEqual([twice.kept.id])
  })
})

describe('being refused', () => {
  const STOPS = [stopAt('a', 'bundle', [1, 0])]

  it('refuses a result for a route that has since been edited, and changes nothing', () => {
    const saved = savedRoute(CLOCKWISE, STOPS)
    const result = resultOf(saved, WIDDERSHINS)
    const moved = { ...saved, route: { ...saved.route, points: [...saved.route.points, place([0, 2])] } }
    expect(acceptOptimised(libraryOf(moved), result, NOW)).toEqual({ ok: false, reason: STALE_REASON })
  })

  it('refuses one for a route whose bundle order has since changed', () => {
    const saved = savedRoute(CLOCKWISE, STOPS)
    const result = resultOf(saved, WIDDERSHINS)
    const reordered = setBundleOrder(libraryOf(saved), saved.id, ['a'])
    expect(acceptOptimised(reordered, result, NOW).ok).toBe(false)
  })

  it('refuses one when another route has since been put in use', () => {
    const saved = savedRoute(CLOCKWISE, STOPS)
    const other = savedRoute(WIDDERSHINS, [], { id: 'r2', name: 'Other' })
    const library = { routes: [saved, other], activeId: other.id }
    expect(acceptOptimised(library, resultOf(saved, WIDDERSHINS), NOW)).toEqual({ ok: false, reason: STALE_REASON })
  })

  it('refuses a blocked result, with the first reason', () => {
    const saved = savedRoute(CLOCKWISE, STOPS)
    const result = resultOf(saved, WIDDERSHINS, { blocked: ['Elm Lane: 40 m is not thrown at.', 'Another.'] })
    expect(acceptOptimised(libraryOf(saved), result, NOW)).toEqual({ ok: false, reason: 'Elm Lane: 40 m is not thrown at.' })
  })
})

describe('a whole run, accepted', () => {
  const STRETCHES: Stretch[] = [
    ['left', [0, 0], [1, 0], [1, -1], [1, 0]],
    ['left', [1, 0], [2, 0], [2, -1], [3, -1], [3, 0]],
    ['both', [3, 0], [3, 1]],
    ['left', [3, 1], [3, 2], [2, 2], [1, 2], [0, 2]],
    ['both', [0, 2], [0, 1], [1, 1], [2, 1], [3, 1]],
    ['transit', [3, 1], [2, 1], [2, 0], [1, 0]],
    ['both', [1, 0], [1, 1]],
    ['transit', [1, 1], [0, 1]],
  ]
  const WAY = drive(STRETCHES)
  const STOPS: Stop[] = [stopAt('first', 'bundle', [1.5, 0], { side: 'left' }), stopAt('second', 'bundle', [3, 0.5]), stopAt('third', 'bundle', [1.5, 2]), stopAt('ask', 'request', [2, 0.5]), stopAt('quiet', 'nothrow', [2.5, 0], { side: 'right' })]
  const saved = savedRoute(WAY, STOPS, {
    name: 'Sam',
    sections: [sectionAt(WAY.points, [0, 0], 'Start'), sectionAt(WAY.points, [3, 0.5], 'Hazel'), sectionAt(WAY.points, [1.5, 2], 'Main')],
    bundleOrder: ['first', 'second', 'third'],
    load: LOAD,
  })
  const prepared = prepare(saved, osmOf(gridWays()))
  const result = solve(prepared, defaultChoices(prepared.view), QUICK)

  it('gives a route the app can work with at once', () => {
    expect(result.blocked).toEqual([])
    const { active, copy, unplaced } = accepted(libraryOf(saved), result)
    const turns = routeTurns(active.route.points)
    expect(missingQueries(active.route.points, turns, active.streets ?? [])).toEqual([])
    expect(walkList(bundlePasses(active.route), active.bundleOrder ?? []).stranded).toEqual([])
    expect(new Set(active.route.stops.map((s) => s.id))).toEqual(new Set(STOPS.map((s) => s.id)))
    expect(resolved(active).detached).toEqual([])
    expect(namesInOrder(active)).toEqual(['Start', 'Hazel', 'Main'].filter((n) => !unplaced.includes(n)))
    expect(copy.route).toEqual(saved.route)
  })

  it('comes back the same through a backup, both routes and everything with them', () => {
    const { library, active, copy } = accepted(libraryOf(saved), result)
    const parsed = parseBackup(makeBackup(library.routes.map(toBackupRoute)))
    if (!parsed.ok) throw new Error(parsed.error)
    const [back, kept] = parsed.routes
    expect(parsed.routes).toHaveLength(2)
    expect(back.name).toBe(active.name)
    expect(back.route.points).toEqual(active.route.points)
    expect(back.route.sideChanges).toEqual(active.route.sideChanges)
    expect(back.route.stops.map(({ lat: _a, lng: _b, ...s }) => s)).toEqual(active.route.stops.map(({ lat: _a, lng: _b, ...s }) => s))
    expect(back.sections?.map((s) => [s.id, s.name, s.pass ?? 1])).toEqual(active.sections?.map((s) => [s.id, s.name, s.pass ?? 1]))
    expect(back.streets?.map((s) => [s.out, s.name])).toEqual(active.streets?.map((s) => [s.out, s.name]))
    expect(back.bundleOrder).toEqual(active.bundleOrder)
    expect(back.load).toEqual(active.load)
    expect(kept.name).toBe(copy.name)
    expect(kept.bundleOrder).toEqual(copy.bundleOrder)
    expect(kept.load).toEqual(copy.load)
    // What the driver gets from it is the same too.
    expect(missingQueries(back.route.points, routeTurns(back.route.points), back.streets ?? [])).toEqual([])
    expect(resolveSections(back.route.points, back.sections ?? []).list.map((s) => s.name)).toEqual(resolved(active).list.map((s) => s.name))
  })

  it('can be accepted with Keep my bundle order off, and the list then follows the drive', () => {
    const shortest = solve(prepared, { ...defaultChoices(prepared.view), keepOrder: false }, QUICK)
    expect(shortest.bundles.store).toBeNull()
    const { active, copy } = accepted(libraryOf(saved), shortest)
    expect(active).not.toHaveProperty('bundleOrder')
    expect(copy.bundleOrder).toEqual(['first', 'second', 'third'])
  })
})
