import { describe, expect, it } from 'vitest'
import { passesNear, pathLength } from '../geo'
import { anchorAt, resolveSections, type ResolvedSection } from '../namedSections'
import { RESUMED_WATCH, startedAt, watchSection, type SectionNote, type SectionWatch } from '../sectionWatch'
import type { Library, NamedSection, Pt, Route, SavedRoute } from '../types'
import { acceptOptimised } from './accept'
import { defaultChoices, prepare, solve } from './optimise'
import { basedOnOf } from './run'
import { drive, gridWays, osmOf, place, savedRoute, type Cell } from './testNetwork'
import type { OptimiseResult, RouteStats } from './types'

/*
 * The banners for the named sections on a route Accept has just put in use. The banners go by the sections as they lie on the route in use, so what
 * matters is that Accept leaves those in order from Start, and that a section it couldn't place gives no banner on the new route at all, as the
 * results say. All the streets are made up.
 */

const STATS: RouteStats = { km: 1, mapKm: 1, closingKm: 0, closedKm: 1, left: 1, right: 0, both: 0, transit: 0, twiceKm: 0, uturns: 0, sideChanges: 0 }

/** A finished run with nothing to report, for these points. */
const resultOf = (saved: SavedRoute, route: Pick<Route, 'points' | 'sideChanges'>): OptimiseResult => ({
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
  bundles: { before: [], after: [], changed: false, fits: true, stranded: [], store: null },
  streets: [],
  basedOn: basedOnOf(saved),
})

/** A section starting at the first pass of a cell of a route. */
function sectionAt(points: Pt[], cell: Cell, name: string): NamedSection {
  const [pass] = passesNear(points, place(cell))
  const section = anchorAt(points, pass.at, name, `id-${name.toLowerCase()}`)
  if (!section) throw new Error(`no section at ${name}`)
  return section
}

/** Accept, and the route it leaves in use and the copy it keeps. */
function accept(saved: SavedRoute, result: OptimiseResult) {
  const library: Library = { routes: [saved], activeId: saved.id }
  const outcome = acceptOptimised(library, result, 1000)
  if (!outcome.ok) throw new Error(outcome.reason)
  const active = outcome.library.routes.find((r) => r.id === saved.id) as SavedRoute
  const copy = outcome.library.routes.find((r) => r.id === outcome.kept.id) as SavedRoute
  return { active, copy, unplaced: outcome.unplaced }
}

/** The sections as the Round screen has them for a route. */
const resolvedOn = (r: SavedRoute) => resolveSections(r.route.points, r.sections ?? [])

/** Each section's start at metre 0 or after the one before, and running to the next one's start, the last to the end of the route. */
function expectInOrder(list: readonly ResolvedSection[], length: number) {
  list.forEach((s, i) => {
    expect(s.endM).toBeGreaterThan(s.startM)
    expect(s.endM).toBeCloseTo(list[i + 1]?.startM ?? length, 6)
  })
}

/**
 * What the banners say on a drive along the whole of a route from where it starts, a fix every 5 m at 10 m/s, with the phone going back 10 m over each
 * line between two sections and on again, as it can at a line. `watch` is how the round began: started, or carried on.
 */
function bannersOn(points: Pt[], list: readonly ResolvedSection[], watch: SectionWatch = startedAt(0)) {
  const routeEnd = pathLength(points)
  const notes: SectionNote[] = []
  let time = 0
  const look = (along: number, forward: boolean) => {
    time += 500
    const step = watchSection(watch, list, { along, time, forward, routeEnd, over: false })
    watch = step.watch
    if (step.note) notes.push(step.note)
  }
  const lines = new Set(list.slice(1).map((s) => Math.round(s.startM / 5) * 5))
  for (let along = 0; along <= routeEnd; along += 5) {
    look(along, true)
    if (lines.has(along)) {
      look(along - 10, false)
      look(along, true)
    }
  }
  return {
    started: notes.flatMap((n) => (n.started === null ? [] : [n.started])),
    ended: notes.flatMap((n) => (n.ended === null ? [] : [n.ended])),
    told: notes.flatMap((n) => [n.started, n.ended]).filter((name): name is string => name !== null),
  }
}

describe('the section banners on the route Accept puts in use', () => {
  // Round two blocks, the bottom one out to the main road, with Start part way down the right-hand lane.
  const OLD = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2], [2, 2], [2, 1], [1, 1], [0, 1], [0, 0]]])
  const SECTIONS = [
    sectionAt(OLD.points, [0.5, 0], 'Top'),
    sectionAt(OLD.points, [2.5, 0], 'Corner'),
    sectionAt(OLD.points, [3, 0.5], 'Start'),
    sectionAt(OLD.points, [2.5, 2], 'Main'),
    sectionAt(OLD.points, [1.5, 1], 'Middle'),
    sectionAt(OLD.points, [0, 0.5], 'Lane'),
    // Well off both routes, so it could not be placed even on the old one.
    { id: 'id-loose', name: 'Loose', ...place([1.5, -1.5]) },
  ]
  const SAVED = savedRoute(OLD, [], { name: 'Monday', sections: SECTIONS })
  // From Start round the top block, leaving out the main road, where the Main section is.
  const NEW = drive([['both', [3, 0.5], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0], [1, 0], [2, 0], [3, 0], [3, 0.5]]])
  const { active, copy, unplaced } = accept(SAVED, resultOf(SAVED, NEW))
  const { list } = resolvedOn(active)

  it('has the sections it placed in order from Start, which is at metre 0, and none it could not place', () => {
    expect(unplaced).toEqual(['Loose', 'Main'])
    expect(list.map((s) => s.name)).toEqual(['Start', 'Middle', 'Lane', 'Top', 'Corner'])
    expect(list[0]).toMatchObject({ name: 'Start', startM: 0, lead: false })
    expectInOrder(list, pathLength(active.route.points))
    expect(resolvedOn(active).detached).toEqual([])
  })

  it('tells where each section it placed starts and ends, once each, in order, and nothing of those it could not place', () => {
    const { started, ended, told } = bannersOn(active.route.points, list)
    expect(started).toEqual(['Start', 'Middle', 'Lane', 'Top', 'Corner'])
    expect(ended).toEqual(['Start', 'Middle', 'Lane', 'Top', 'Corner'])
    for (const name of unplaced) expect(told).not.toContain(name)
  })

  it('tells nothing of the section the round is carried on in, and the rest as they come, as on any route', () => {
    const { started } = bannersOn(active.route.points, list, RESUMED_WATCH)
    expect(started).toEqual(['Middle', 'Lane', 'Top', 'Corner'])
  })

  it('leaves every section on the copy of the old route, so the ones it could not place still have their banners there', () => {
    expect(copy.sections).toEqual(SECTIONS)
    const there = resolvedOn(copy)
    // The old route starts before its first section, so a stand-in with no banner covers that part.
    expect(there.list.filter((s) => !s.lead).map((s) => s.name)).toEqual(['Top', 'Corner', 'Start', 'Main', 'Middle', 'Lane'])
    expect(bannersOn(copy.route.points, there.list).started).toContain('Main')
  })
})

describe('the section banners on a route the engine found, from a Start part way round', () => {
  const OLD = drive([
    ['left', [0, 0], [1, 0], [1, -1], [1, 0]],
    ['left', [1, 0], [2, 0], [2, -1], [3, -1], [3, 0]],
    ['both', [3, 0], [3, 1]],
    ['left', [3, 1], [3, 2], [2, 2], [1, 2], [0, 2]],
    ['both', [0, 2], [0, 1], [1, 1], [2, 1], [3, 1]],
    ['transit', [3, 1], [2, 1], [2, 0], [1, 0]],
    ['both', [1, 0], [1, 1]],
    ['transit', [1, 1], [0, 1]],
  ])
  const SECTIONS = [
    sectionAt(OLD.points, [1, -0.5], 'Court'),
    sectionAt(OLD.points, [3, 0.5], 'Start'),
    sectionAt(OLD.points, [1.5, 2], 'Main'),
    sectionAt(OLD.points, [0, 1.5], 'Elm'),
    { id: 'id-loose', name: 'Loose', ...place([2.5, -2.5]) },
  ]
  const SAVED = savedRoute(OLD, [], { sections: SECTIONS })
  const prepared = prepare(SAVED, osmOf(gridWays()))

  for (const keepOrder of [true, false]) {
    it(`has them in order from Start at metre 0, and tells each start once, in order, and nothing of the rest, with Keep my bundle order ${keepOrder ? 'on' : 'off'}`, () => {
      const result = solve(prepared, { ...defaultChoices(prepared.view), keepOrder }, { iterations: 4000, seed: 1 })
      expect(result.blocked).toEqual([])
      const { active, unplaced } = accept(SAVED, result)
      const { list, detached } = resolvedOn(active)
      expect(detached).toEqual([])
      expect(list[0]).toMatchObject({ name: 'Start', startM: 0, lead: false })
      expectInOrder(list, pathLength(active.route.points))
      expect(unplaced).toContain('Loose')
      // Some besides Start go on, so the banners have lines to tell.
      expect(list.length).toBeGreaterThan(2)
      expect(new Set([...list.map((s) => s.name), ...unplaced])).toEqual(new Set(SECTIONS.map((s) => s.name)))
      const { started, told } = bannersOn(active.route.points, list)
      expect(started).toEqual(list.map((s) => s.name))
      for (const name of unplaced) expect(told).not.toContain(name)
    })
  }
})
