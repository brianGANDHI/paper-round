import { afterEach, describe, expect, it, vi } from 'vitest'
import { cumulativeDistances, haversine, sideAt } from '../geo'
import { routeTurns, turnKind } from '../turns'
import type { Route, SavedRoute, Stop } from '../types'
import { auditRoute, missedStretches, ON_MAP_GATE_M, onMapCheck, routeStats, sideKm } from './audit'
import { bundlePasses, walkList } from './list'
import { blockers, defaultChoices, fingerprintOf, isStale, keepOrderNote, mapAgeNote, offMapNote, prepare, solve } from './optimise'
import { makeProblem } from './problem'
import { gapsOf } from './report'
import { COVER_GATE_M } from './run'
import { drive, gridWays, mainRoad, osmOf, place, quarteredRoundabout, residential, savedRoute, stopAt, turnRule, WAY, type Cell, type Stretch, type WaySpec } from './testNetwork'
import type { Budget, OptimiseChoices, OptimiseResult, OsmData, Prepared } from './types'
import { closingKm, optionsFor, secondPassCuts, startOf, type PlacedVisit } from './world'

const QUICK: Budget = { iterations: 4000, seed: 1 }

/** Through most of the grid in a poor order, and not back to where it began. */
const LONG_WAY = drive([
  ['left', [0, 0], [1, 0], [1, -1], [1, 0]],
  ['left', [1, 0], [2, 0], [2, -1], [3, -1], [3, 0]],
  ['both', [3, 0], [3, 1]],
  ['left', [3, 1], [3, 2], [2, 2], [1, 2], [0, 2]],
  ['both', [0, 2], [0, 1], [1, 1], [2, 1], [3, 1]],
  ['transit', [3, 1], [2, 1], [2, 0], [1, 0]],
  ['both', [1, 0], [1, 1]],
  ['transit', [1, 1], [0, 1]],
])

const STOPS: Stop[] = [
  stopAt('first', 'bundle', [1.5, 0]),
  stopAt('second', 'bundle', [3, 0.5]),
  stopAt('third', 'bundle', [1.5, 2]),
  stopAt('ask', 'request', [2, 0.5]),
  stopAt('flats', 'block', [0, 1.5]),
  stopAt('quiet', 'nothrow', [2.5, 0]),
]

const roadNames = (r: Pick<Route, 'points' | 'sideChanges'>, p: Prepared) => {
  const g = p.world.graph
  const a = auditRoute(g, r, p.world.banned)
  return { audit: a, names: new Set(a.matched.map((m) => (m.piece >= 0 ? g.pieces[m.piece].name : null))) }
}

/**
 * The choices the screen starts a run with. Keep my bundle order is on for a route with two bundles or more, and off for one with fewer, as the
 * screen only offers it from two: so a run here on a route with no bundles, or one, is the shortest search, as it would be in the app.
 */
const defaults = (p: Prepared): OptimiseChoices => defaultChoices(p.view)
const shortest = (p: Prepared): OptimiseChoices => ({ ...defaultChoices(p.view), keepOrder: false })

describe('a whole run', () => {
  const prepared = prepare(savedRoute(LONG_WAY, STOPS), osmOf(gridWays()))
  const result = solve(prepared, defaults(prepared), QUICK)
  const again = solve(prepared, shortest(prepared), QUICK)

  it('offers Accept', () => {
    expect(result.blocked).toEqual([])
    expect(again.blocked).toEqual([])
  })

  it('throws at every side the old route did, by a fresh audit of the finished points', () => {
    for (const r of [result, again]) {
      const after = auditRoute(prepared.world.graph, r.route, prepared.world.banned)
      const gaps = missedStretches(prepared.world.graph, prepared.world.audit.cover, after.cover)
      expect(gaps.filter((g) => g.len >= COVER_GATE_M)).toEqual([])
      expect(after.offRoad).toBe(0)
      expect(after.wrongWay).toBe(0)
      expect(after.bannedTurns).toBe(0)
    }
  })

  it('closes exactly on the start', () => {
    for (const r of [result, again]) {
      const { points } = r.route
      expect(points[points.length - 1]).toEqual(points[0])
      expect(r.after.closingKm).toBe(0)
      expect(r.after.closedKm).toBeCloseTo(r.after.mapKm, 6)
    }
  })

  it('starts at the node nearest the start', () => {
    expect(haversine(result.route.points[0], place([0, 0]))).toBeLessThan(0.2)
  })

  it('rounds to 6 places before anything is measured', () => {
    for (const p of result.route.points) {
      expect(Number(p.lat.toFixed(6))).toBe(p.lat)
      expect(Number(p.lng.toFixed(6))).toBe(p.lng)
    }
    expect(result.after.km).toBeCloseTo(sideKm(result.route).km, 9)
  })

  it('gives side rows that sideAt reads as they are meant: sorted, a row at 0, none repeating', () => {
    const rows = result.route.sideChanges
    expect(rows[0].idx).toBe(0)
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].idx).toBeGreaterThan(rows[i - 1].idx)
      expect(rows[i].side).not.toBe(rows[i - 1].side)
    }
    expect(rows[rows.length - 1].idx).toBeLessThan(result.route.points.length - 1)
  })

  it('keeps every bundle, request and block on the route', () => {
    for (const r of [result, again]) {
      const stops = STOPS.filter((s) => s.type !== 'nothrow')
      for (const s of stops) expect(bundlePasses({ points: r.route.points, stops: [{ ...s, type: 'bundle' }] }).length).toBeGreaterThan(0)
      const near = (s: Stop) => Math.min(...r.route.points.map((p, i) => (i ? distanceToSegment(s, r.route.points[i - 1], p) : Infinity)))
      for (const s of stops) expect(near(s)).toBeLessThan(15)
    }
  })

  it('never throws starboard or both on a main road', () => {
    const { audit } = roadNames(result.route, prepared)
    const g = prepared.world.graph
    audit.matched.forEach((m, k) => {
      if (m.piece >= 0 && g.pieces[m.piece].name === 'Main Road') expect(['left', 'transit']).toContain(audit.samples[k].side)
    })
  })

  it('stays off a private way the old route never used', () => {
    expect(roadNames(result.route, prepared).names.has('Quince Lane')).toBe(false)
    expect(roadNames(again.route, prepared).names.has('Quince Lane')).toBe(false)
  })

  it('never turns back at a node on a main road', () => {
    expect(result.turnBacks.filter((t) => t.level === 'main')).toEqual([])
    expect(again.turnBacks.filter((t) => t.level === 'main')).toEqual([])
  })

  it('gets shorter than the old route, even with the bundle order held', () => {
    expect(result.after.closedKm).toBeLessThan(result.before.closedKm)
    expect(again.after.closedKm).toBeLessThanOrEqual(result.after.closedKm + 1e-9)
  })

  it('takes the same course every time from the same seed and moves', () => {
    expect(solve(prepared, defaults(prepared), QUICK).route).toEqual(result.route)
  })

  it('leaves what was prepared as it was, so other choices can be run on it', () => {
    const edges = JSON.stringify(prepared.world.edges)
    const before = JSON.stringify(prepared.view)
    solve(prepared, shortest(prepared), QUICK)
    expect(JSON.stringify(prepared.world.edges)).toBe(edges)
    expect(JSON.stringify(prepared.view)).toBe(before)
  })

  it('gives results that can be posted from a worker', () => {
    expect(() => structuredClone(result)).not.toThrow()
    expect(() => structuredClone(prepared.view)).not.toThrow()
  })

  it('names the new route\'s turns from the map', () => {
    expect(result.streets.length).toBeGreaterThan(5)
    expect(result.streets.filter((s) => s.name).length).toBeGreaterThan(result.streets.length / 2)
    expect(result.streets.every((s) => Number.isFinite(s.out) && s.out >= 0 && s.out < 360)).toBe(true)
  })

  it('tells how far it has got', () => {
    const seen: number[] = []
    solve(prepared, defaults(prepared), QUICK, (p) => seen.push(p.done))
    expect(seen[0]).toBe(0)
    expect(seen[seen.length - 1]).toBe(1)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })
})

function distanceToSegment(s: { lat: number; lng: number }, a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toXY = (p: { lat: number; lng: number }) => [(p.lng - a.lng) * 96000, (p.lat - a.lat) * 111000]
  const [px, py] = toXY(s)
  const [bx, by] = toXY(b)
  const l2 = bx * bx + by * by
  const t = l2 ? Math.max(0, Math.min(1, (px * bx + py * by) / l2)) : 0
  return Math.hypot(px - t * bx, py - t * by)
}

describe('stats', () => {
  const closed = drive([['left', [0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]])

  it('measures before and after by the same code', () => {
    const p = prepare(savedRoute(LONG_WAY, STOPS), osmOf(gridWays()))
    const a = auditRoute(p.world.graph, LONG_WAY, p.world.banned)
    expect(p.view.before).toEqual(routeStats(LONG_WAY, a, closingKm(p.world)))
  })

  it('counts U-turns as routeTurns does', () => {
    const p = prepare(savedRoute(LONG_WAY), osmOf(gridWays()))
    const r = solve(p, defaults(p), QUICK)
    expect(r.after.uturns).toBe(routeTurns(r.route.points).filter((t) => turnKind(t.angle) === 'uturn').length)
    expect(p.view.before.uturns).toBe(routeTurns(LONG_WAY.points).filter((t) => turnKind(t.angle) === 'uturn').length)
  })

  it('adds up side km by sideAt to the route as drawn', () => {
    const { km, left, right, both, transit } = sideKm(LONG_WAY)
    expect(left + right + both + transit).toBeCloseTo(km, 9)
    const cum = cumulativeDistances(LONG_WAY.points)
    let port = 0
    for (let i = 0; i + 1 < cum.length; i++) if (sideAt(LONG_WAY, i) === 'left') port += cum[i + 1] - cum[i]
    expect(left).toBeCloseTo(port / 1000, 9)
  })

  it('counts real side changes, not rows', () => {
    const rows = { ...closed, sideChanges: [{ idx: 0, side: 'left' as const }, { idx: 1, side: 'left' as const }, { idx: 2, side: 'both' as const }] }
    const p = prepare(savedRoute(rows), osmOf(gridWays()))
    expect(p.view.before.sideChanges).toBe(1)
  })

  it('adds the way home to a route that doesn\'t close', () => {
    const p = prepare(savedRoute(LONG_WAY), osmOf(gridWays()))
    const { before } = p.view
    expect(before.closingKm).toBeGreaterThan(0.1)
    expect(before.closingKm).toBeLessThan(0.15)
    expect(before.closedKm).toBeCloseTo(before.mapKm + before.closingKm, 9)
  })

  it('adds nothing to a route that closes', () => {
    expect(prepare(savedRoute(closed), osmOf(gridWays())).view.before.closingKm).toBe(0)
  })

  it('counts a street thrown at twice as thrown twice', () => {
    const twice = drive([['left', [0, 0], [1, 0], [2, 0], [3, 0]], ['transit', [3, 0], [3, 1], [0, 1], [0, 0]], ['left', [0, 0], [1, 0]], ['transit', [1, 0], [1, 1], [0, 1], [0, 0]]])
    expect(prepare(savedRoute(twice), osmOf(gridWays())).view.before.twiceKm).toBeGreaterThan(0.09)
    expect(prepare(savedRoute(closed), osmOf(gridWays())).view.before.twiceKm).toBe(0)
  })
})

describe('the street list', () => {
  const p = prepare(savedRoute(LONG_WAY), osmOf(gridWays()))

  it('lists main roads first and off, and everything else on', () => {
    const [first, ...rest] = p.view.streets
    expect(first).toMatchObject({ name: 'Main Road', main: true, allowed: false })
    expect(rest.every((s) => !s.main && s.allowed)).toBe(true)
  })

  it('gives each street its km and a key of its own', () => {
    const main = p.view.streets[0]
    expect(main.km).toBeCloseTo(0.332, 1)
    expect(new Set(p.view.streets.map((s) => s.key)).size).toBe(p.view.streets.length)
  })

  it('takes a street as main if any of it is, by name', () => {
    const ways: WaySpec[] = [
      { id: 1, cells: [[0, 0], [1, 0]], tags: mainRoad('Long Road') },
      { id: 2, cells: [[1, 0], [2, 0]], tags: residential('Long Road') },
      { id: 3, cells: [[2, 0], [2, 1], [0, 1], [0, 0]], tags: residential('Back Road') },
    ]
    const q = prepare(savedRoute(drive([['left', [0, 0], [1, 0], [2, 0]], ['left', [2, 0], [2, 1], [0, 1], [0, 0]]])), osmOf(ways))
    expect(q.view.streets.find((s) => s.name === 'Long Road')).toMatchObject({ main: true, allowed: false })
  })

  it('runs with a street turned off as with a main road, throwing it to port only', () => {
    const route = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0]], ['both', [3, 0], [3, 1], [2, 1], [1, 1], [0, 1]], ['both', [0, 1], [0, 0]]])
    const q = prepare(savedRoute(route), osmOf(gridWays()))
    const choices = defaults(q)
    choices.allowed['Ash Street'] = false
    const r = solve(q, choices, QUICK)
    expect(r.blocked).toEqual([])
    const { audit } = roadNames(r.route, q)
    const g = q.world.graph
    audit.matched.forEach((m, k) => {
      if (m.piece >= 0 && g.pieces[m.piece].name === 'Ash Street') expect(['left', 'transit']).toContain(audit.samples[k].side)
    })
    expect(r.after.closedKm).toBeGreaterThan(solve(q, defaults(q), QUICK).after.closedKm)
  })

  it('reports a one-way that forces a side to starboard', () => {
    const ways: WaySpec[] = [
      { id: 1, cells: [[0, 0], [1, 0]], tags: { ...mainRoad('One Road'), oneway: 'yes' } },
      { id: 2, cells: [[1, 0], [1, 1], [0, 1], [0, 0]], tags: residential('Back Way') },
    ]
    const q = prepare(savedRoute(drive([['right', [0, 0], [1, 0]], ['left', [1, 0], [1, 1], [0, 1], [0, 0]]])), osmOf(ways))
    const r = solve(q, defaults(q), QUICK)
    expect(r.notes.join(' ')).toMatch(/One Road: \d+ m can only be thrown from the starboard side/)
    expect(r.blocked).toEqual([])
  })
})

describe('the bundle list', () => {
  /**
   * Round the block with every side on the starboard. Driven the other way round they would all be to port, so the shortest run turns the
   * loop round, and the bundles with it.
   */
  const LOOP = drive([['right', [0, 0], [1, 0], [2, 0], [3, 0]], ['right', [3, 0], [3, 1]], ['right', [3, 1], [2, 1], [1, 1], [0, 1]], ['right', [0, 1], [0, 0]]])
  const STOPS2 = [stopAt('east', 'bundle', [1.5, 0]), stopAt('west', 'bundle', [1.5, 1])]
  const prepared = prepare(savedRoute(LOOP, STOPS2), osmOf(gridWays()))
  const kept = solve(prepared, defaults(prepared), QUICK)
  const free = solve(prepared, shortest(prepared), QUICK)
  const order = (r: OptimiseResult) => walkList(bundlePasses({ points: r.route.points, stops: STOPS2 }), ['east', 'west'])

  it('holds the order with keep order on, and says so', () => {
    expect(kept.bundles.fits).toBe(true)
    expect(order(kept).stranded).toEqual([])
    expect(kept.bundles.changed).toBe(false)
    expect(kept.blocked).toEqual([])
  })

  it('can break it with keep order off, and then the list follows the new drive', () => {
    expect(order(free).stranded).toEqual(['west'])
    expect(free.bundles.changed).toBe(true)
    expect(free.bundles.after.map((b) => b.id)).toEqual(['west', 'east'])
    expect(free.bundles.store).toBeNull()
    expect(free.blocked).toEqual([])
  })

  it('does not need to write the list down when the new drive reaches the bundles in that order of itself', () => {
    expect(kept.bundles.store).toBeNull()
  })

  it('pays for holding the order', () => {
    expect(free.after.closedKm).toBeLessThanOrEqual(kept.after.closedKm + 1e-9)
  })

  it('takes a list the driver set as it is, and writes it down', () => {
    const q = prepare(savedRoute(LOOP, STOPS2, { bundleOrder: ['west', 'east'] }), osmOf(gridWays()))
    expect(q.view.bundleOrderSet).toBe(true)
    expect(q.view.bundles.map((b) => b.id)).toEqual(['west', 'east'])
    const r = solve(q, defaults(q), QUICK)
    expect(r.bundles.fits).toBe(true)
    expect(r.bundles.store).toEqual(['west', 'east'])
    expect(walkList(bundlePasses({ points: r.route.points, stops: STOPS2 }), ['west', 'east']).stranded).toEqual([])
  })

  it('walks the list by passes, not by where stops are stored', () => {
    const misleading = STOPS2.map((s, i) => ({ ...s, pathIdx: 5 - i }))
    const q = prepare(savedRoute(LOOP, misleading), osmOf(gridWays()))
    expect(q.view.bundles.map((b) => b.id)).toEqual(['east', 'west'])
  })

  it('holds two bundles on one stretch to the way they were passed', () => {
    const near = [stopAt('east', 'bundle', [1.3, 0]), stopAt('west', 'bundle', [1.7, 0])]
    const q = prepare(savedRoute(LOOP, near), osmOf(gridWays()))
    const r = solve(q, defaults(q), QUICK)
    expect(r.blocked).toEqual([])
    expect(walkList(bundlePasses({ points: r.route.points, stops: near }), ['east', 'west']).stranded).toEqual([])
  })

  /** Once along the one-way and home round the block. */
  const ONE_WAY_ONCE = drive([['left', [2, 0], [2, -1], [3, -1], [3, 0]], ['left', [3, 0], [3, 1], [2, 1], [2, 0]]])

  it('keeps a list today\'s route strands, by coming round again, when each bundle has a stretch of its own', () => {
    // Both bundles are on the one-way, which today's route drives once: the list wants the further one first.
    const stops = [stopAt('near', 'bundle', [2.3, -1]), stopAt('far', 'bundle', [2.7, -1])]
    expect(walkList(bundlePasses({ points: ONE_WAY_ONCE.points, stops }), ['far', 'near']).stranded).toEqual(['near'])
    const q = prepare(savedRoute(ONE_WAY_ONCE, stops, { bundleOrder: ['far', 'near'] }), osmOf(gridWays()))
    const r = solve(q, defaults(q), QUICK)
    expect(r.blocked).toEqual([])
    expect(r.bundles.fits).toBe(true)
    expect(walkList(bundlePasses({ points: r.route.points, stops }), ['far', 'near']).stranded).toEqual([])
  })

  it('blocks Accept with a plain reason when the list can\'t fit, and keep order off gets past it', () => {
    // Two bundles at the one spot on the one-way, which is driven once, and the list puts one on the next street between them.
    const stops = [stopAt('first', 'bundle', [2.5, -1]), stopAt('between', 'bundle', [3, 0.5]), stopAt('last', 'bundle', [2.5, -1])]
    const q = prepare(savedRoute(ONE_WAY_ONCE, stops, { bundleOrder: ['first', 'between', 'last'] }), osmOf(gridWays()))
    const r = solve(q, defaults(q), QUICK)
    expect(r.bundles.fits).toBe(false)
    expect(r.bundles.stranded.map((b) => b.id)).toEqual(['last'])
    expect(r.blocked.join(' ')).toMatch(/bundle list doesn't fit this route.*last/)
    const off = solve(q, shortest(q), QUICK)
    expect(off.blocked).toEqual([])
    expect(off.bundles.after.map((b) => b.id)).toEqual(['first', 'last', 'between'])
    expect(off.bundles.store).toBeNull()
  })
})

describe('a court driven in and straight back out', () => {
  // Round the block by way of Ivy Court: in to its head and straight back out, which passes a bundle near the mouth twice, close together along the
  // route. The list takes it on the way in, before the one near the head. The way out is drawn once back over the way in, and once with a point part way
  // along it, so that its samples fall between those of the way in, nearer the bundle than any of them.
  const outAndBack = (back: Cell[]) => drive([['left', [0, 0], [1, 0], [1, -1], ...back, [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0]]])
  const stops = [stopAt('mouth', 'bundle', [1.04, -0.21]), stopAt('head', 'bundle', [1.04, -0.8])]
  const drawn: [string, Cell[]][] = [['back over the same points', []], ['back with a point part way', [[1, -0.45]]]]

  for (const [how, back] of drawn) {
    describe(`with the way out drawn ${how}`, () => {
      const q = prepare(savedRoute(outAndBack(back), stops), osmOf(gridWays()))
      const g = q.world.graph

      it('gives each bundle the way round of the pass the list takes it on, the way in', () => {
        expect(q.world.order.map((b) => b.id)).toEqual(['mouth', 'head'])
        // The court runs north from the mouth, and north is up in the graph's own metres.
        const goesIn = (v: PlacedVisit) => (v.dir === 1) === (g.nodes[g.pieces[v.piece].b][1] > g.nodes[g.pieces[v.piece].a][1])
        expect((q.world.visits as PlacedVisit[]).map(goesIn)).toEqual([true, true])
      })

      it('keeps the order in one trip up the court, as today does', () => {
        const r = solve(q, defaults(q), QUICK)
        expect(r.keepOrder).toBe(true)
        expect(r.blocked).toEqual([])
        expect(r.after.closedKm).toBeLessThan(r.before.closedKm + 0.02)
        expect(r.after.uturns).toBeLessThanOrEqual(r.before.uturns)
      })
    })
  }
})

describe('a main road driven out and back, turning part way along it', () => {
  // Round the block, then along Main Road and straight back, turning in the middle of it, which passes a bundle on it twice. A visit on a main road keeps
  // today's way round, which for this bundle is going east, on the pass the list takes it on. The way back is drawn with a point part way along it, so
  // that its samples fall between those of the way out, nearer the bundle than any of them.
  const route = drive([['left', [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 2]], ['transit', [0, 2], [1.5, 2], [0.95, 2], [0, 2]], ['left', [0, 2], [0, 1], [0, 0]]])
  const onMain = stopAt('main', 'bundle', [0.25, 2])
  const q = prepare(savedRoute(route, [stopAt('ash', 'bundle', [1.5, 0]), onMain]), osmOf(gridWays()))
  /** Which way the new route goes each time it passes the bundle on Main Road. */
  const ways = ({ route: { points } }: OptimiseResult) => bundlePasses({ points, stops: [onMain] }).map((o) => (points[o.idx + 1].lng > points[o.idx].lng ? 'east' : 'west'))

  it('passes the bundle going east, as today, with keep order on or off', () => {
    expect(q.world.order.map((b) => b.id)).toEqual(['ash', 'main'])
    for (const choices of [defaults(q), shortest(q)]) {
      const r = solve(q, choices, QUICK)
      expect(r.blocked).toEqual([])
      expect(ways(r)).toEqual(['east'])
      expect(r.after.closedKm).toBeLessThan(r.before.closedKm)
    }
  })
})

describe('two bundles on one stretch with another between them in the list', () => {
  /** Twice along the street east, with a loop round the block between. */
  const twice = drive([
    ['left', [0, 0], [1, 0], [2, 0], [3, 0]],
    ['both', [3, 0], [3, 1], [2, 1], [1, 1], [0, 1]],
    ['left', [0, 1], [0, 0]],
    ['transit', [0, 0], [1, 0], [2, 0]],
  ])
  const list = ['a', 'b', 'c']
  const run = (stops: Stop[]) => {
    const q = prepare(savedRoute(twice, stops, { bundleOrder: list }), osmOf(gridWays()))
    return { q, r: solve(q, defaults(q), QUICK) }
  }

  it('gives each its own pass, as the old route did', () => {
    const stops = [stopAt('a', 'bundle', [1.2, 0]), stopAt('b', 'bundle', [3, 0.5]), stopAt('c', 'bundle', [1.8, 0])]
    expect(walkList(bundlePasses({ points: twice.points, stops }), list).stranded).toEqual([])
    const { r } = run(stops)
    expect(r.blocked).toEqual([])
    expect(r.bundles.fits).toBe(true)
    expect(walkList(bundlePasses({ points: r.route.points, stops }), list).stranded).toEqual([])
  })

  it('cuts a street no more than it has to', () => {
    const between = run([stopAt('a', 'bundle', [1.2, 0]), stopAt('b', 'bundle', [3, 0.5]), stopAt('c', 'bundle', [1.8, 0])]).q.world
    const beside = prepare(savedRoute(twice, [stopAt('a', 'bundle', [1.2, 0]), stopAt('c', 'bundle', [1.8, 0]), stopAt('b', 'bundle', [3, 0.5])], { bundleOrder: ['a', 'c', 'b'] }), osmOf(gridWays())).world
    expect(between.edges.length).toBe(beside.edges.length + 1)
    expect(between.edges.filter((e) => e.name === 'Ash Street').reduce((a, e) => a + e.len, 0)).toBeCloseTo(beside.edges.filter((e) => e.name === 'Ash Street').reduce((a, e) => a + e.len, 0), 3)
  })

  it('leaves two bundles at the one spot to the honest block, with no cut that does nothing', () => {
    const { q, r } = run([stopAt('a', 'bundle', [1.5, 0]), stopAt('b', 'bundle', [3, 0.5]), stopAt('c', 'bundle', [1.5, 0])])
    expect(q.world.edges.filter((e) => e.name === 'Ash Street').length).toBe(3)
    expect(r.blocked.join(' ')).toMatch(/bundle list doesn't fit this route/)
  })

  it('gives three bundles on one stretch a pass each when the list takes them out of their order along it', () => {
    // Round the block three times the same way. The list takes the far one on the first lap, the near one on the second, and the one between on the
    // third, after one on the next street.
    const lap: Stretch[] = [['left', [0, 0], [1, 0], [2, 0], [3, 0]], ['left', [3, 0], [3, 1], [2, 1], [1, 1], [0, 1]], ['left', [0, 1], [0, 0]]]
    const thrice = drive([...lap, ...lap, ...lap])
    const stops = [stopAt('r0', 'bundle', [1.9, 0]), stopAt('r1', 'bundle', [1.1, 0]), stopAt('r2', 'bundle', [2.5, 1]), stopAt('r3', 'bundle', [1.3, 0])]
    const order = ['r0', 'r1', 'r2', 'r3']
    expect(walkList(bundlePasses({ points: thrice.points, stops }), order).stranded).toEqual([])
    const q = prepare(savedRoute(thrice, stops, { bundleOrder: order }), osmOf(gridWays()))
    const r = solve(q, defaults(q), QUICK)
    expect(r.blocked).toEqual([])
    expect(r.bundles.fits).toBe(true)
    expect(walkList(bundlePasses({ points: r.route.points, stops }), order).stranded).toEqual([])
  })
})

describe('where a stretch is cut for the bundle list', () => {
  const at = (rank: number, s: number, dir: 1 | -1 = 1): PlacedVisit => ({ edge: 7, dir, rank, piece: 3, s })
  const cellsOf = (visits: PlacedVisit[]) => [...(secondPassCuts(visits).get(3) ?? [])].sort((a, b) => a - b)

  it('cuts between bundles next to each other along the stretch that are not next to each other in the list', () => {
    expect(cellsOf([at(0, 20), at(2, 60)])).toEqual([10])
    expect(cellsOf([at(0, 20), at(1, 60)])).toEqual([])
  })

  it('cuts between two in the list driven past the wrong way round, so the second has a pass after the first', () => {
    expect(cellsOf([at(0, 60), at(1, 20)])).toEqual([10])
  })

  it('goes along the stretch the way it is driven', () => {
    expect(cellsOf([at(0, 60, -1), at(1, 20, -1)])).toEqual([])
    expect(cellsOf([at(0, 20, -1), at(1, 60, -1)])).toEqual([10])
  })

  it('cuts every gap three bundles need at once, whatever order the list has them in', () => {
    // Along the stretch: the list's second, its fourth, then its first.
    expect(cellsOf([at(0, 90), at(1, 10), at(3, 30)])).toEqual([5, 15])
  })

  it('leaves bundles passed each way, those with no place in the list, and those at the one spot alone', () => {
    expect(cellsOf([at(0, 20), at(2, 60, -1)])).toEqual([])
    expect(cellsOf([at(0, 20), at(-1, 40), at(1, 60)])).toEqual([])
    expect(cellsOf([at(0, 40), at(2, 40)])).toEqual([])
  })
})

describe('the acceptance test', () => {
  const route = drive([
    ['both', [0, 0], [1, 0], [2, 0], [3, 0]],
    ['both', [3, 0], [3, 1], [2, 1], [1, 1], [0, 1]],
    ['both', [0, 1], [0, 0]],
  ])
  const p = prepare(savedRoute(route, [stopAt('drop', 'bundle', [2.5, 1])]), osmOf(gridWays()))
  const w = p.world
  const pr = makeProblem(w.nodes.length, w.edges, optionsFor(w, defaults(p)), w.depot)
  const noList = { before: [], after: [], changed: false, fits: true, stranded: [], store: null }
  const short = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0]], ['transit', [3, 0], [0, 0]]])

  it('blocks Accept for a stretch of 16 m or more that is no longer thrown at, by its street name', () => {
    const after = auditRoute(w.graph, short, w.banned)
    const gaps = gapsOf(w, pr, after)
    expect(gaps.some((g) => g.street === 'Birch Street' && g.m >= COVER_GATE_M)).toBe(true)
    const why = blockers(w, pr, p.view, short, after, gaps, noList, false)
    expect(why.join(' ')).toMatch(/Birch Street: \d+ m that is thrown at today is not thrown at/)
  })

  it('blocks Accept for a closed road the old route never drove', () => {
    const lane = drive([['both', [1, 0], [2, 1], [2, 0], [1, 0]]])
    const after = auditRoute(w.graph, lane, w.banned)
    expect(blockers(w, pr, p.view, lane, after, [], noList, false).join(' ')).toMatch(/uses Quince Lane/)
  })

  it('blocks Accept for a stop left off the route', () => {
    const after = auditRoute(w.graph, short, w.banned)
    expect(blockers(w, pr, p.view, short, after, [], noList, false).join(' ')).toMatch(/drop is no longer on the route/)
  })

  it('blocks Accept for a route that doesn\'t close', () => {
    const open = drive([['both', [0, 0], [1, 0]]])
    expect(blockers(w, pr, p.view, open, auditRoute(w.graph, open, w.banned), [], noList, false).join(' ')).toMatch(/doesn't end where it starts/)
  })

  it('blocks Accept for a route against a one-way or through a banned turn', () => {
    const against = drive([['left', [3, 0], [3, -1], [2, -1], [2, 0], [3, 0]]])
    expect(auditRoute(w.graph, against, w.banned).wrongWay).toBeGreaterThan(0)
    const osm = osmOf(gridWays(), [], [turnRule(1, 'no_left_turn', WAY.birch, [1, 1], WAY.fig)])
    const q = prepare(savedRoute(route), osm)
    const turning = drive([['left', [0, 1], [1, 1], [1, 2]]])
    const a = auditRoute(q.world.graph, turning, q.world.banned)
    expect(a.bannedTurns).toBe(1)
    expect(blockers(q.world, pr, q.view, turning, a, [], noList, false).join(' ')).toMatch(/turn the map bans/)
  })

  describe('the walk along the map', () => {
    /** A divided road, its two sides about 10 m apart and one-way, joined at the ends. The match can slide a stretch of one onto the other. */
    const divided: WaySpec[] = [
      { id: 1, cells: [[0, 0], [1, 0], [2, 0]], tags: { ...residential('East Road'), oneway: 'yes' } },
      { id: 2, cells: [[2, 0], [2, 0.09], [1, 0.09], [0, 0.09], [0, 0]], tags: { ...residential('West Road'), oneway: 'yes' } },
    ]
    const round = drive([['left', [0, 0], [1, 0], [2, 0], [2, 0.09], [1, 0.09], [0, 0.09], [0, 0]]])
    const backwards = drive([['left', [2, 0], [1, 0], [0, 0], [0, 0.09], [1, 0.09], [2, 0.09], [2, 0]]])
    const q = prepare(savedRoute(round), osmOf(divided))
    const prQ = makeProblem(q.world.nodes.length, q.world.edges, optionsFor(q.world, defaults(q)), q.world.depot)
    const why = (r: Pick<Route, 'points' | 'sideChanges'>) => blockers(q.world, prQ, q.view, r, auditRoute(q.world.graph, r, []), [], noList, false).join(' ')

    it('catches a route against a one-way that the match slides onto the road beside it', () => {
      expect(auditRoute(q.world.graph, backwards, []).wrongWay).toBe(0)
      expect(onMapCheck(q.world.graph, backwards.points).wrongWayM).toBeGreaterThan(200)
      expect(why(backwards)).toMatch(/against a one-way/)
    })

    it('leaves the same road driven the right way alone', () => {
      expect(onMapCheck(q.world.graph, round.points)).toEqual({ offRoadM: 0, wrongWayM: 0 })
      expect(why(round)).toBe('')
    })

    it('catches a route moved off the road by less than the match forgives', () => {
      const solved = solve(p, defaults(p), QUICK).route
      expect(solved.points.length).toBeGreaterThan(2)
      expect(onMapCheck(w.graph, solved.points)).toEqual({ offRoadM: 0, wrongWayM: 0 })
      const moved = { ...solved, points: solved.points.map((pt) => ({ ...pt, lat: pt.lat + 0.000135 })) }
      expect(auditRoute(w.graph, moved, w.banned).offRoad).toBe(0)
      expect(onMapCheck(w.graph, moved.points).offRoadM).toBeGreaterThan(100)
      expect(blockers(w, pr, p.view, moved, auditRoute(w.graph, moved, w.banned), [], noList, false).join(' ')).toMatch(/leaves the roads on the map/)
    })

    it('never holds a hand-drawn old route to it', () => {
      const hand = { ...route, points: route.points.map((pt) => ({ ...pt, lat: pt.lat + 0.00005 })) }
      const near = prepare(savedRoute(hand), osmOf(gridWays()))
      expect(onMapCheck(near.world.graph, hand.points).offRoadM).toBeGreaterThan(100)
      expect(solve(near, defaults(near), QUICK).blocked).toEqual([])
    })

    it('blocks at 2 m, and lets a smaller slip go', () => {
      const [first, ...rest] = round.points
      const spur = (m: number) => {
        const at = place([0.5, 0])
        return { ...round, points: [first, at, { ...at, lat: at.lat + m / 111195 }, at, ...rest] }
      }
      expect(ON_MAP_GATE_M).toBe(2)
      expect(onMapCheck(q.world.graph, spur(0.5).points).offRoadM).toBeCloseTo(1, 1)
      expect(why(spur(0.5))).toBe('')
      expect(onMapCheck(q.world.graph, spur(1.5).points).offRoadM).toBeCloseTo(3, 1)
      expect(why(spur(1.5))).toMatch(/leaves the roads on the map/)
    })
  })

  it('leaves out a roundabout\'s island, where nothing can be thrown at', () => {
    const ring: [number, number][] = [[1, 0], [1.2, 0.2], [1, 0.4], [0.8, 0.2], [1, 0]]
    const ways: WaySpec[] = [
      { id: 1, cells: [[0, 0.2], [0.8, 0.2]], tags: residential('In Road') },
      { id: 2, cells: ring, tags: { highway: 'residential', junction: 'roundabout' } },
      { id: 3, cells: [[1.2, 0.2], [2, 0.2]], tags: residential('Out Road') },
    ]
    const there = drive([['both', [0, 0.2], [0.8, 0.2], [1, 0], [1.2, 0.2], [2, 0.2]], ['both', [2, 0.2], [1.2, 0.2], [1, 0.4], [0.8, 0.2], [0, 0.2]]])
    const q = prepare(savedRoute(there), osmOf(ways))
    const r = solve(q, defaults(q), QUICK)
    expect(r.blocked).toEqual([])
    const ringPieces = new Set(q.world.graph.pieces.filter((x) => x.roundabout).map((x) => x.id))
    const gaps = missedStretches(q.world.graph, q.world.audit.cover, auditRoute(q.world.graph, r.route, []).cover)
    expect(gaps.filter((g) => ringPieces.has(g.piece) && g.side === 1)).toEqual([])
  })

  it('reports a part of the route on no road and goes on when it is only driven', () => {
    const off = drive([['left', [0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], ['transit', [0, 0], [-2, 0], [-2, 1]], ['transit', [-2, 1], [0, 1]], ['left', [0, 1], [0, 0]]])
    const q = prepare(savedRoute(off), osmOf(gridWays()))
    expect(q.view.unmatched.length).toBeGreaterThan(0)
    expect(q.view.unmatched.every((u) => !u.thrown)).toBe(true)
    const r = solve(q, defaults(q), QUICK)
    expect(r.blocked).toEqual([])
    expect(r.notes.join(' ')).toMatch(/isn't on any road|aren't on any road/)
  })

  it('blocks Accept when a part on no road was thrown at', () => {
    const off = drive([['left', [0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], ['left', [0, 0], [-2, 0], [-2, 1]], ['transit', [-2, 1], [0, 1]], ['left', [0, 1], [0, 0]]])
    const q = prepare(savedRoute(off), osmOf(gridWays()))
    expect(q.view.unmatched.some((u) => u.thrown)).toBe(true)
    expect(solve(q, defaults(q), QUICK).blocked.join(' ')).toMatch(/isn't on any road on the map/)
  })

  it('reports streets it can\'t reach instead of failing', () => {
    const ways: WaySpec[] = [
      { id: 1, cells: [[0, 0], [1, 0]], tags: residential('Near Road') },
      { id: 2, cells: [[3, 0], [4, 0]], tags: residential('Far Road') },
    ]
    const q = prepare(savedRoute(drive([['left', [0, 0], [1, 0], [0, 0]], ['transit', [0, 0], [3, 0]], ['left', [3, 0], [4, 0], [3, 0]]])), osmOf(ways))
    expect(solve(q, defaults(q), QUICK).blocked.join(' ')).toMatch(/Far Road can't be reached/)
  })

  it('says so when there is nothing to optimise', () => {
    const q = prepare(savedRoute(drive([['transit', [0, 0], [1, 0]]])), osmOf(gridWays()))
    const r = solve(q, defaults(q), QUICK)
    expect(r.blocked.join(' ')).toMatch(/nothing to optimise/)
    expect(r.route.points).toEqual(q.world.route.points)
  })
})

describe('a stretch thrown across a side street', () => {
  const ways: WaySpec[] = [
    { id: 1, cells: [[0, 0], [1, 0], [2, 0]], tags: residential('Long Street') },
    { id: 2, cells: [[1, 0], [1, 1], [0, 1], [0, 0]], tags: residential('Back Street') },
    { id: 3, cells: [[2, 0], [2, 1], [1, 1]], tags: residential('Far Street') },
  ]
  /** Port all along, and both sides for 12 m either side of the side street. */
  const route = drive([
    ['left', [0, 0], [0.892, 0]],
    ['both', [0.892, 0], [1.108, 0]],
    ['left', [1.108, 0], [2, 0]],
    ['transit', [2, 0], [2, 1], [1, 1], [0, 1], [0, 0]],
  ])
  const q = prepare(savedRoute(route), osmOf(ways))
  const r = solve(q, defaults(q), QUICK)

  it('still throws it, as the one stretch it is on the ground', () => {
    expect(r.blocked).toEqual([])
    expect(r.gaps.filter((g) => haversine(g, place([1, 0])) < 30)).toEqual([])
  })
})

describe('a stretch thrown across a junction of a roundabout drawn as a way for each quarter', () => {
  // Two short runs, one each side of the junction, on ways with no name: the coverage gate joins them, so the demand has to keep them for the solver.
  // A bundle on the way in and one on the way home, so that Keep my bundle order is on by default, as the screen would have it.
  const { ways, today } = quarteredRoundabout()
  const q = prepare(savedRoute(today, [stopAt('in', 'bundle', [1, 1]), stopAt('home', 'bundle', [3, 2])]), osmOf(ways))

  it('is thrown on the new route, and nothing blocks Accept, either way', () => {
    expect(defaults(q).keepOrder).toBe(true)
    for (const choices of [defaults(q), shortest(q)]) {
      const r = solve(q, choices, QUICK)
      expect(r.blocked).toEqual([])
      expect(r.gaps.filter((g) => g.m >= COVER_GATE_M)).toEqual([])
    }
  })
})

describe('where it starts', () => {
  const closed = drive([['left', [0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]])

  it('uses the route\'s first point when there is no section called Start', () => {
    expect(startOf(savedRoute(closed))).toEqual({ ...place([0, 0]), section: null })
  })

  it('uses the section called Start, in any case and with spaces round it', () => {
    const sections = [{ id: 's1', name: 'Beach', ...place([1, 0]) }, { id: 's2', name: ' START ', ...place([1, 1]) }]
    expect(startOf(savedRoute(closed, [], { sections }))).toEqual({ ...place([1, 1]), section: ' START ' })
  })

  it('starts and ends the new route there', () => {
    const sections = [{ id: 's2', name: 'Start', ...place([1, 1]) }]
    const q = prepare(savedRoute(closed, [], { sections }), osmOf(gridWays()))
    expect(q.view.start.section).toBe('Start')
    const r = solve(q, defaults(q), QUICK)
    expect(r.blocked).toEqual([])
    const { points } = r.route
    expect(points[0]).toEqual(points[points.length - 1])
    expect(haversine(points[0], place([1, 1]))).toBeLessThan(0.2)
  })
})

describe('a Start part way round', () => {
  const ways: WaySpec[] = [
    { id: 1, cells: [[0, 0], [4, 0]], tags: residential('North Road') },
    { id: 2, cells: [[4, 0], [4, 1], [4, 2]], tags: residential('East Road') },
    { id: 3, cells: [[4, 2], [0, 2]], tags: residential('South Road') },
    { id: 4, cells: [[0, 2], [0, 0]], tags: residential('West Road') },
    { id: 5, cells: [[4, 1], [5, 1]], tags: residential('Cross Road') },
  ]
  const ring = drive([['left', [0, 0], [4, 0], [4, 1], [4, 2], [0, 2], [0, 0]]])
  const stops = [stopAt('a', 'bundle', [1, 0]), stopAt('b', 'bundle', [3, 0]), stopAt('c', 'bundle', [4, 1.5]), stopAt('d', 'bundle', [2, 2]), stopAt('e', 'bundle', [0, 1])]
  const sectionAt = (cell: Cell) => [{ id: 's', name: 'Start', ...place(cell) }]
  const named = (list: { id: string }[]) => list.map((b) => b.id)
  const prepared = prepare(savedRoute(ring, stops, { sections: sectionAt([4, 1]) }), osmOf(ways))

  it('works a list the driver never set round from the start', () => {
    const r = solve(prepared, defaults(prepared), QUICK)
    const free = solve(prepared, shortest(prepared), QUICK)
    expect(r.blocked).toEqual([])
    expect(r.bundles.fits).toBe(true)
    expect(r.after.closedKm).toBeLessThan(free.after.closedKm + 0.02)
    expect(r.after.closedKm).toBeLessThan(r.before.closedKm + 0.02)
    expect(r.notes).toEqual([])
  })

  it('shows the list as it stands today, and the new one as following the drive', () => {
    const { bundles } = solve(prepared, defaults(prepared), QUICK)
    expect(named(prepared.view.bundles)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(named(bundles.before)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(named(bundles.after)).toEqual(['c', 'd', 'e', 'a', 'b'])
    expect(bundles.changed).toBe(true)
    expect(bundles.store).toBeNull()
  })

  it('reads the fit of today\'s list, not the kept one, with keep order off', () => {
    const r = solve(prepared, shortest(prepared), QUICK)
    expect(named(r.bundles.stranded)).toEqual(walkList(bundlePasses({ points: r.route.points, stops }), ['a', 'b', 'c', 'd', 'e']).stranded)
    expect(r.bundles.fits).toBe(false)
  })

  it('leaves a list the driver set as it is', () => {
    const q = prepare(savedRoute(ring, stops, { sections: sectionAt([4, 1]), bundleOrder: ['a', 'b', 'c', 'd', 'e'] }), osmOf(ways))
    const r = solve(q, defaults(q), QUICK)
    expect(named(q.world.order)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(named(r.bundles.after)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(r.bundles.store).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(r.bundles.changed).toBe(false)
  })

  it('starts the search from the start, with a driver\'s list as without one', () => {
    // With no time to search, the route is the search's first order.
    const some = stops.filter((s) => s.id === 'd' || s.id === 'e')
    const q = prepare(savedRoute(ring, some, { sections: sectionAt([4, 1]), bundleOrder: ['d', 'e'] }), osmOf(ways))
    expect(solve(q, defaults(q), { ms: 0 }).after.closedKm).toBeLessThan(q.view.before.closedKm + 0.02)
    expect(solve(prepared, defaults(prepared), { ms: 0 }).after.closedKm).toBeLessThan(prepared.view.before.closedKm + 0.02)
  })

  describe('with Keep my bundle order off', () => {
    // The ring driven round one way and then back round the other, with a bundle on East Road. Today it is first passed going south, on the first lap;
    // read round from a Start on the bottom of the ring, it is first passed going north, on the second.
    const twice = drive([['left', [0, 0], [2, 0], [4, 0], [4, 1], [4, 2], [2, 2], [0, 2], [0, 1], [0, 0], [0, 1], [0, 2], [2, 2], [4, 2], [4, 1], [4, 0], [2, 0], [0, 0]]])
    const twiceStops = [stopAt('a', 'bundle', [1, 0]), stopAt('x', 'bundle', [4, 1.5]), stopAt('d', 'bundle', [3, 2])]
    const today = prepare(savedRoute(twice, twiceStops), osmOf(ways))
    const fromEnd = prepare(savedRoute(twice, twiceStops, { sections: sectionAt([1, 2]) }), osmOf(ways))
    // Starboard off on East Road, so the bundle on it is held to its way round.
    const crossOff = (p: Prepared, keepOrder: boolean): OptimiseChoices => ({ allowed: { ...defaultChoices(p.view).allowed, 'East Road': false }, keepOrder })
    /** Where each kept stop is and which way round, as the search is held to it, with no regard to how the streets are cut into edges. */
    const held = (p: Prepared, keepOrder: boolean) =>
      optionsFor(p.world, crossOff(p, keepOrder))
        .visits.map((v) => {
          const { piece, s } = v as PlacedVisit
          return `${piece}:${Math.round(s)}:${v.dir}`
        })
        .sort()

    it('holds each bundle to the way round it is passed today, not to a later pass that the list read round from Start takes', () => {
      expect(fromEnd.world.startSample).toBeGreaterThan(0)
      expect(held(fromEnd, false)).toEqual(held(today, false))
      // Keep my bundle order does take the later pass, as the list from Start meets the bundle there.
      expect(held(fromEnd, true)).not.toEqual(held(today, true))
    })

    it('finds a route all the same, with the bundle on its way round of today', () => {
      const r = solve(fromEnd, crossOff(fromEnd, false), QUICK)
      expect(r.blocked).toEqual([])
      expect(r.after.closedKm).toBeLessThan(solve(today, crossOff(today, false), QUICK).after.closedKm + 0.02)
    })
  })

  it('changes nothing for a route with no such section', () => {
    const plain = prepare(savedRoute(ring, stops), osmOf(ways))
    const atFirst = prepare(savedRoute(ring, stops, { sections: sectionAt([0, 0]) }), osmOf(ways))
    expect(plain.world.startSample).toBe(0)
    expect(atFirst.world.startSample).toBe(0)
    expect(named(plain.world.order)).toEqual(named(plain.world.list))
    expect(plain.world.visits).toEqual(atFirst.world.visits)
    const r = solve(plain, defaults(plain), QUICK)
    expect(solve(atFirst, defaults(atFirst), QUICK).route).toEqual(r.route)
    expect(r.bundles.changed).toBe(false)
    expect(r.bundles.store).toBeNull()
  })
})

describe('what holding the list costs', () => {
  it('names a list that does not fit today\'s route, and the way out', () => {
    expect(keepOrderNote(4, 16, 0)).toBe("4 of your 16 bundles can't be reached in list order on today's route. Turn off Keep my bundle order to get the shortest route.")
  })

  it('names a kept route that comes out longer than today', () => {
    expect(keepOrderNote(0, 16, 2.53)).toBe('Your 16 bundles are kept in list order. This route comes out 2.5 km longer than today. Turn off Keep my bundle order to get the shortest route.')
  })

  it('says both when both are so', () => {
    expect(keepOrderNote(4, 16, 29.8)).toBe("4 of your 16 bundles can't be reached in list order on today's route. This route comes out 29.8 km longer than today. Turn off Keep my bundle order to get the shortest route.")
  })

  it('says nothing when it fits and costs nothing to speak of, or there is no order to hold', () => {
    expect(keepOrderNote(0, 16, 0)).toBeNull()
    expect(keepOrderNote(0, 16, -3)).toBeNull()
    expect(keepOrderNote(0, 16, 0.04)).toBeNull()
    expect(keepOrderNote(0, 1, 2)).toBeNull()
    expect(keepOrderNote(0, 0, 2)).toBeNull()
  })

  /** Round the block, past two bundles on the one-way that is driven once: the list wants the further one first. */
  const route = drive([['left', [2, 0], [2, -1], [3, -1], [3, 0]], ['left', [3, 0], [3, 1], [2, 1], [2, 0]]])
  const stops = [stopAt('near', 'bundle', [2.3, -1]), stopAt('far', 'bundle', [2.7, -1])]

  it('adds that to a run with a list the old route can\'t be driven in', () => {
    const q = prepare(savedRoute(route, stops, { bundleOrder: ['far', 'near'] }), osmOf(gridWays()))
    expect(solve(q, defaults(q), QUICK).notes.join(' ')).toMatch(/1 of your 2 bundles can't be reached in list order on today's route/)
  })

  it('adds nothing with keep order off, or for a list that fits', () => {
    const q = prepare(savedRoute(route, stops, { bundleOrder: ['far', 'near'] }), osmOf(gridWays()))
    expect(solve(q, shortest(q), QUICK).notes).toEqual([])
    const fits = prepare(savedRoute(route, stops), osmOf(gridWays()))
    expect(solve(fits, defaults(fits), QUICK).notes).toEqual([])
  })

  it('adds that to a kept run that comes out longer than today', () => {
    const round = drive([['both', [0, 0], [1, 0], [2, 0], [3, 0]], ['both', [3, 0], [3, 1], [2, 1], [1, 1], [0, 1]], ['both', [0, 1], [0, 0]]])
    const q = prepare(savedRoute(round, [stopAt('one', 'bundle', [1.5, 0]), stopAt('two', 'bundle', [1.5, 1])]), osmOf(gridWays()))
    const choices = defaults(q)
    choices.allowed['Ash Street'] = false
    const r = solve(q, choices, QUICK)
    expect(r.after.closedKm).toBeGreaterThan(r.before.closedKm + 0.05)
    expect(r.notes.join(' ')).toMatch(/Your 2 bundles are kept in list order\. This route comes out \d+\.\d km longer than today\. Turn off Keep my bundle order/)
  })
})

describe('messages', () => {
  it('says a route off the map is off the map, and not that nothing is thrown at', () => {
    const far = drive([['left', [20, 20], [21, 20], [22, 20], [22, 21]]])
    const q = prepare(savedRoute(far), osmOf(gridWays()))
    const r = solve(q, defaults(q), QUICK)
    expect(r.blocked).toEqual(["The part of today's route that is thrown at isn't on any road on the map, so there is nothing to optimise."])
  })

  it('calls a part of the route on no road short only when it is', () => {
    expect(offMapNote([{ m: 10 }])).toBe("1 short part of today's route isn't on any road on the map.")
    expect(offMapNote([{ m: 10 }, { m: 12 }])).toBe("2 short parts of today's route aren't on any road on the map.")
    expect(offMapNote([{ m: COVER_GATE_M }])).toBe("1 part of today's route isn't on any road on the map.")
    expect(offMapNote([{ m: 10 }, { m: 500 }])).toBe("2 parts of today's route aren't on any road on the map.")
    expect(offMapNote([])).toBeNull()
  })

  it('puts a kept list whose only drive needs a banned turn down to the list, with the way past it', () => {
    const ways: WaySpec[] = [
      { id: 1, cells: [[0, 0], [1, 0]], tags: residential('West Street') },
      { id: 2, cells: [[1, 0], [2, 0]], tags: residential('East Street') },
    ]
    const there = drive([['left', [1, 0], [0, 0], [1, 0], [2, 0], [1, 0]]])
    const stops = [stopAt('one', 'bundle', [0.5, 0]), stopAt('two', 'bundle', [1.5, 0])]
    const q = prepare(savedRoute(there, stops, { bundleOrder: ['one', 'two'] }), osmOf(ways, [], [turnRule(1, 'no_straight_on', 1, [1, 0], 2)]))
    expect(() => solve(q, defaults(q), QUICK)).toThrow(/bundle list can't be kept.*Turn off Keep my bundle order/)
    expect(solve(q, shortest(q), QUICK).blocked).toEqual([])
  })
})

describe('the driver\'s switch against the smoothing', () => {
  /** Two one-way streets thrown on both sides, staggered across 24 m of main road, and a way back. */
  const ways: WaySpec[] = [
    { id: 1, cells: [[0, 0], [1, 0]], tags: { ...residential('West Street'), oneway: 'yes' } },
    { id: 2, cells: [[1, -1], [1, 0], [1, 0.22], [1, 1]], tags: mainRoad('Main Road') },
    { id: 3, cells: [[1, 0.22], [2, 0.22]], tags: { ...residential('East Street'), oneway: 'yes' } },
    { id: 4, cells: [[2, 0.22], [2, 2], [0, 2], [0, 0]], tags: residential('Back Road') },
  ]
  const route = drive([['both', [0, 0], [1, 0]], ['transit', [1, 0], [1, 0.22]], ['both', [1, 0.22], [2, 0.22]], ['transit', [2, 0.22], [2, 2], [0, 2], [0, 0]]])

  it('keeps starboard off a main road that is turned off, though the streets either side have both', () => {
    const q = prepare(savedRoute(route), osmOf(ways))
    const r = solve(q, shortest(q), QUICK)
    expect(r.blocked).toEqual([])
    const g = q.world.graph
    const { audit } = roadNames(r.route, q)
    const sides = audit.samples.filter((_, k) => audit.matched[k].piece >= 0 && g.pieces[audit.matched[k].piece].name === 'Main Road').map((x) => x.side)
    expect(sides.filter((x) => x === 'transit').length).toBeGreaterThanOrEqual(2)
    expect(sides.filter((x) => x === 'both' || x === 'right').length).toBeLessThanOrEqual(1)
  })
})

describe('the audit\'s turns', () => {
  const count = (ways: WaySpec[], rules: ReturnType<typeof turnRule>[], route: Pick<Route, 'points' | 'sideChanges'>) => {
    const q = prepare(savedRoute(route), osmOf(ways, [], rules))
    return auditRoute(q.world.graph, route, q.world.banned).bannedTurns
  }

  describe('a rule from a way back onto itself', () => {
    const rules = [turnRule(1, 'no_u_turn', WAY.fig, [1, 1], WAY.fig)]

    it('sees a route turn back there', () => {
      expect(count(gridWays(), rules, drive([['left', [0, 0], [1, 0], [1, 1], [1, 0], [2, 0]]]))).toBe(1)
    })

    it('does not count passing straight through', () => {
      expect(count(gridWays(), rules, drive([['left', [0, 0], [1, 0], [1, 1], [1, 2], [2, 2]]]))).toBe(0)
    })

    it('does not count turning back anywhere else along the piece', () => {
      expect(count(gridWays(), rules, drive([['left', [0, 0], [1, 0], [1, 0.5], [1, 0], [2, 0]]]))).toBe(0)
    })
  })

  describe('the two ends of a route, on a node with a rule at it', () => {
    /** A plain straight street, made of two ways that meet at the node, in either order. */
    const street = (west: number, east: number): WaySpec[] => {
      const ways: WaySpec[] = [
        { id: west, cells: [[0, 0], [1, 0]], tags: residential('West Part') },
        { id: east, cells: [[1, 0], [2, 0]], tags: residential('East Part') },
      ]
      return west < east ? ways : [...ways].reverse()
    }

    for (const [west, east] of [[1, 2], [2, 1]]) {
      it(`does not count a route starting at the node, ways ${west} and ${east}`, () => {
        expect(count(street(west, east), [turnRule(1, 'no_straight_on', west, [1, 0], east)], drive([['left', [1, 0], [2, 0]]]))).toBe(0)
        expect(count(street(west, east), [turnRule(1, 'no_straight_on', east, [1, 0], west)], drive([['left', [1, 0], [0, 0]]]))).toBe(0)
      })

      it(`does not count a route ending at the node, ways ${west} and ${east}`, () => {
        expect(count(street(west, east), [turnRule(1, 'no_straight_on', west, [1, 0], east)], drive([['left', [0, 0], [1, 0]]]))).toBe(0)
        expect(count(street(west, east), [turnRule(1, 'no_straight_on', east, [1, 0], west)], drive([['left', [2, 0], [1, 0]]]))).toBe(0)
      })

      it(`still counts driving through it, ways ${west} and ${east}`, () => {
        expect(count(street(west, east), [turnRule(1, 'no_straight_on', west, [1, 0], east)], drive([['left', [0, 0], [1, 0], [2, 0]]]))).toBe(1)
      })
    }

    it('still counts a real turn just after the start', () => {
      const rules = [turnRule(1, 'no_left_turn', WAY.birch, [1, 1], WAY.fig)]
      expect(count(gridWays(), rules, drive([['left', [0.97, 1], [1, 1], [1, 0]]]))).toBe(1)
    })
  })
})

describe('where a run can start from', () => {
  const ways: WaySpec[] = [...gridWays(), { id: 50, cells: [[0, 0], [-0.4, 0]], tags: { ...residential('Sink Street'), oneway: 'yes' } }, { id: 51, cells: [[-0.6, -0.4], [0, -0.4]], tags: residential('Stray Road') }]
  const round = drive([['left', [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0]]])
  const from = (cell: Cell) => prepare(savedRoute(round, [], { sections: [{ id: 's', name: 'Start', ...place(cell) }] }), osmOf(ways))

  it('steps off the tip of a one-way that leads nowhere', () => {
    const q = from([-0.4, 0])
    expect(solve(q, defaults(q), QUICK).blocked).toEqual([])
  })

  it('steps off a stray bit of road that joins nothing', () => {
    const q = from([-0.6, -0.4])
    const r = solve(q, defaults(q), QUICK)
    expect(r.blocked).toEqual([])
    expect(r.route.points[0]).toEqual(r.route.points[r.route.points.length - 1])
  })

  it('takes the plain nearest node when the round can be driven from it', () => {
    const q = from([1, 1])
    expect(haversine(solve(q, defaults(q), QUICK).route.points[0], place([1, 1]))).toBeLessThan(0.2)
  })

  it('still says what can\'t be reached when no node near serves it all', () => {
    const cut: WaySpec[] = [
      { id: 1, cells: [[0, 0], [1, 0]], tags: residential('Near Road') },
      { id: 2, cells: [[3, 0], [4, 0]], tags: residential('Far Road') },
    ]
    const q = prepare(savedRoute(drive([['left', [0, 0], [1, 0], [0, 0]], ['transit', [0, 0], [3, 0]], ['left', [3, 0], [4, 0], [3, 0]]])), osmOf(cut))
    expect(solve(q, defaults(q), QUICK).blocked.join(' ')).toMatch(/Far Road can't be reached/)
  })
})

describe('a road with only a number', () => {
  const ways: WaySpec[] = [
    { id: 1, cells: [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], tags: { highway: 'secondary', ref: '12' } },
    { id: 2, cells: [[1, 0], [2, 0]], tags: { highway: 'residential', name: 'Plain Street', ref: '99' } },
  ]
  const q = prepare(savedRoute(drive([['left', [0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], ['left', [0, 0], [1, 0], [2, 0], [1, 0]]])), osmOf(ways))

  it('reads as a road and not a bare number', () => {
    expect(q.view.streets.map((s) => s.name)).toContain('Road 12')
    expect(q.view.streets.map((s) => s.name)).not.toContain('12')
  })

  it('goes by its name when it has one', () => {
    expect(q.view.streets.map((s) => s.name)).toContain('Plain Street')
  })
})

describe('an old map', () => {
  const NOW = Date.UTC(2030, 5, 1)
  const daysAgo = (days: number) => new Date(NOW - days * 86400000).toISOString()

  it('says how old a map is when it is well behind', () => {
    expect(mapAgeNote(daysAgo(61), NOW)).toBe("This map is about 2 months old, so a road that has changed since won't show on it.")
    expect(mapAgeNote(daysAgo(365), NOW)).toMatch(/about 12 months old/)
  })

  it('says nothing of a map that is recent, undated, or dated in a way it can\'t read', () => {
    expect(mapAgeNote(daysAgo(59), NOW)).toBeNull()
    expect(mapAgeNote(daysAgo(-1), NOW)).toBeNull()
    expect(mapAgeNote(undefined, NOW)).toBeNull()
    expect(mapAgeNote('', NOW)).toBeNull()
    expect(mapAgeNote('soon', NOW)).toBeNull()
  })

  it('goes on the choices screen and into the results', () => {
    const old = prepare(savedRoute(LONG_WAY), { ...osmOf(gridWays()), date: '2019-03-01T00:00:00Z' })
    expect(old.view.notes.join(' ')).toMatch(/This map is about \d+ months old/)
    expect(solve(old, defaults(old), QUICK).notes.join(' ')).toMatch(/This map is about \d+ months old/)
  })

  it('adds nothing for a map with a recent date, or none', () => {
    expect(prepare(savedRoute(LONG_WAY), { ...osmOf(gridWays()), date: new Date().toISOString() }).view.notes).toEqual([])
    expect(prepare(savedRoute(LONG_WAY), osmOf(gridWays())).view.notes).toEqual([])
  })
})

describe('the phone going to sleep', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** A clock that ticks at each read, and jumps ten minutes at one of them. */
  const ticking = (jumpAt: number) => {
    let now = 1000
    let reads = 0
    return () => {
      now += 20
      if (reads++ === jumpAt) now += 600000
      return now
    }
  }

  it('leaves the time asleep out of the search, so it gets the moves of a normal run', () => {
    const p = prepare(savedRoute(LONG_WAY, STOPS), osmOf(gridWays()))
    const reads = (clock: () => number) => {
      let n = 0
      solve(p, defaults(p), { ms: 2000, seed: 1, clock: () => (n++, clock()) })
      return n
    }
    const normal = reads(ticking(-1))
    expect(normal).toBeGreaterThan(50)
    expect(Math.abs(reads(ticking(normal >> 1)) - normal)).toBeLessThanOrEqual(3)
    expect(Math.abs(reads(ticking(3)) - normal)).toBeLessThanOrEqual(3)
  })

  it('still gives a route shorter than the old one when it wakes before the search has begun', () => {
    const p = prepare(savedRoute(LONG_WAY, STOPS), osmOf(gridWays()))
    const r = solve(p, defaults(p), { ms: 2000, seed: 1, clock: ticking(2) })
    expect(r.blocked).toEqual([])
    expect(r.after.closedKm).toBeLessThan(r.before.closedKm)
  })

  it('leaves the time asleep out of the measured match, so the reserve doesn\'t eat the search', () => {
    const { lat, lng } = place([0, 0])
    const stretch = drive([['left', [0, 0], [3, 0], [3, 2], [0, 2], [0, 0]], ['left', [0, 0], [3, 0], [3, 2], [0, 2], [0, 0]], ['left', [0, 0], [3, 0], [3, 2], [0, 2], [0, 0]]])
    expect({ lat, lng }).toEqual(stretch.points[0])
    let now = 1000
    let reads = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 1
      if (reads++ === 2) now += 600000
      return now
    })
    expect(prepare(savedRoute(stretch), osmOf(gridWays())).world.matchMs).toBeLessThan(5000)
  })

  it('counts a slow table as time, and not as the phone asleep', () => {
    // Enough streets for the table to report as it goes, and each report here is a phone taking 3 s over that part of it.
    const across: WaySpec[] = [0, 1, 2, 3, 4, 5].map((row) => ({ id: 100 + row, cells: [0, 1, 2, 3, 4, 5].map((c): Cell => [c, row]), tags: residential(`Row ${row}`) }))
    const down: WaySpec[] = [0, 1, 2, 3, 4, 5].map((col) => ({ id: 200 + col, cells: [0, 1, 2, 3, 4, 5].map((r): Cell => [col, r]), tags: residential(`Column ${col}`) }))
    const snake: Cell[] = [0, 1, 2, 3, 4, 5].flatMap((row) => (row % 2 ? [[5, row], [4, row], [3, row], [2, row], [1, row], [0, row]] : [[0, row], [1, row], [2, row], [3, row], [4, row], [5, row]]) as Cell[])
    const q = prepare(savedRoute(drive([['left', ...snake]])), osmOf([...across, ...down]))
    let now = 0
    let reads = 0
    const clock = () => {
      reads++
      now += 20
      return now
    }
    const tell = (info: { step: string }) => {
      if (info.step === 'Working out the ways between streets') now += 3000
    }
    solve(q, defaults(q), { ms: 5000, seed: 1, clock }, tell)
    expect(now).toBeGreaterThan(6000)
    expect(reads).toBeLessThan(40)
  })

  it('keeps a slow match as long as it really was', () => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => (now += 900))
    const stretch = drive([['left', [0, 0], [3, 0], [3, 2], [0, 2], [0, 0]], ['left', [0, 0], [3, 0], [3, 2], [0, 2], [0, 0]], ['left', [0, 0], [3, 0], [3, 2], [0, 2], [0, 0]]])
    expect(prepare(savedRoute(stretch), osmOf(gridWays())).world.matchMs).toBeGreaterThan(900)
  })
})

describe('the budget', () => {
  const p = prepare(savedRoute(LONG_WAY, STOPS), osmOf(gridWays()))

  it('goes by a clock it is given', () => {
    let now = 0
    let calls = 0
    const clock = () => {
      calls++
      now += 50
      return now
    }
    const r = solve(p, defaults(p), { ms: 5000, clock, seed: 1 })
    expect(r.blocked).toEqual([])
    expect(calls).toBeLessThan(2000)
  })

  it('keeps room to finish, in step with how fast this phone ran the match', () => {
    const slowPhone = { ...p, world: { ...p.world, matchMs: 1000 } }
    const reads = (ms: number) => {
      let now = 0
      let n = 0
      solve(slowPhone, defaults(slowPhone), {
        ms,
        seed: 1,
        clock: () => {
          n++
          now += 1
          return now
        },
      })
      return n
    }
    expect(reads(3200)).toBeLessThan(10)
    expect(reads(3700)).toBeGreaterThan(100)
  })

  it('still gives a route that works with no time to search', () => {
    expect(solve(p, defaults(p), { ms: 0 }).blocked).toEqual([])
  })

  it('gets no worse for the moves it is given', () => {
    const little = solve(p, shortest(p), { iterations: 200, seed: 1 })
    const more = solve(p, shortest(p), { iterations: 20000, seed: 1 })
    expect(more.after.closedKm).toBeLessThanOrEqual(little.after.closedKm + 0.05)
  })
})

describe('the choices a run starts from', () => {
  const bundles = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, name: `Bundle ${i}` }))

  it('keep the bundle order only for two bundles or more, as the screen offers it only then, and one alone has no order to keep', () => {
    for (const n of [0, 1]) expect(defaultChoices({ streets: [], bundles: bundles(n) }).keepOrder).toBe(false)
    for (const n of [2, 5]) expect(defaultChoices({ streets: [], bundles: bundles(n) }).keepOrder).toBe(true)
  })

  it('have each street at its own default', () => {
    const streets = [
      { key: 'Main Road', name: 'Main Road', km: 1, main: true, allowed: false },
      { key: 'Elm Street', name: 'Elm Street', km: 1, main: false, allowed: true },
    ]
    expect(defaultChoices({ streets, bundles: [] }).allowed).toEqual({ 'Main Road': false, 'Elm Street': true })
  })
})

describe('staleness', () => {
  const saved: SavedRoute = savedRoute(LONG_WAY, STOPS)
  const { basedOn } = prepare(saved, osmOf(gridWays())).view

  it('knows its own route', () => {
    expect(isStale(saved, basedOn)).toBe(false)
    expect(basedOn).toMatchObject({ routeId: 'r1', updatedAt: 1 })
  })

  it('spots a changed point, side, stop or bundle order', () => {
    const { route } = saved
    expect(isStale({ ...saved, route: { ...route, points: route.points.slice(1) } }, basedOn)).toBe(true)
    expect(isStale({ ...saved, route: { ...route, sideChanges: [{ idx: 0, side: 'both' }] } }, basedOn)).toBe(true)
    expect(isStale({ ...saved, route: { ...route, stops: route.stops.slice(1) } }, basedOn)).toBe(true)
    expect(isStale({ ...saved, bundleOrder: ['first'] }, basedOn)).toBe(true)
  })

  it('spots another route, and ignores a change that touches nothing Accept replaces', () => {
    expect(isStale({ ...saved, id: 'r2' }, basedOn)).toBe(true)
    expect(isStale({ ...saved, name: 'Renamed' }, basedOn)).toBe(false)
    const touched: SavedRoute = { ...saved, updatedAt: 9 }
    expect(fingerprintOf(touched)).toBe(fingerprintOf(saved))
  })
})

describe('bad input', () => {
  it('says plainly when a route is too short', () => {
    expect(() => prepare(savedRoute({ points: [place([0, 0])], sideChanges: [] }), osmOf(gridWays()))).toThrow(/too short/)
  })

  it('says plainly when the map has no roads', () => {
    const empty: OsmData = { elements: [] }
    expect(() => prepare(savedRoute(LONG_WAY), empty)).toThrow(/no roads/)
  })
})
