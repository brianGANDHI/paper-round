import { describe, expect, it } from 'vitest'
import { haversine } from '../geo'
import type { Route } from '../types'
import { auditRoute, joinedMissed, missedStretches } from './audit'
import { blockers, defaultChoices, prepare } from './optimise'
import { makeProblem } from './problem'
import { gapsOf } from './report'
import { COVER_GATE_M } from './run'
import { drive, gridWays, osmOf, place, quarteredRoundabout, residential, savedRoute, WAY, type Cell, type Stretch, type WaySpec } from './testNetwork'
import type { Prepared } from './types'
import { optionsFor } from './world'

/*
 * The coverage gate: frontage thrown at today and not on the new route blocks Accept from 16 m, however the map cuts that frontage into pieces. These
 * are made-up streets, and the "new routes" are routes made by hand that leave something out, as the solver never would: the gate is the safety net.
 */

const NO_LIST = { before: [], after: [], changed: false, fits: true, stranded: [], store: null }

/** What a route that is not the solver's would get from the gate: its gaps, the missed stretches each alone, and why Accept would be blocked. */
function gate(p: Prepared, after: Pick<Route, 'points' | 'sideChanges'>) {
  const w = p.world
  const pr = makeProblem(w.nodes.length, w.edges, optionsFor(w, defaultChoices(p.view)), w.depot)
  const audit = auditRoute(w.graph, after, w.banned)
  const gaps = gapsOf(w, pr, audit)
  const alone = missedStretches(w.graph, w.audit.cover, audit.cover)
  return { gaps, alone, why: blockers(w, pr, p.view, after, audit, gaps, NO_LIST, false).filter((b) => /is not thrown at on the new route/.test(b)) }
}

describe('a roundabout lap left out', () => {
  // A roundabout about 9 m across the middle, clockwise as Australia drives them, cut into quarters by the four roads into it.
  const N: Cell = [2, 0.92]
  const E: Cell = [2.08, 1]
  const S: Cell = [2, 1.08]
  const W: Cell = [1.92, 1]
  const NE: Cell = [2.0566, 0.9434]
  const SE: Cell = [2.0566, 1.0566]
  const SW: Cell = [1.9434, 1.0566]
  const NW: Cell = [1.9434, 0.9434]
  const ways: WaySpec[] = [
    { id: 1, cells: [N, NE, E, SE, S, SW, W, NW, N], tags: { highway: 'residential', junction: 'roundabout' } },
    { id: 2, cells: [[0, 1], W], tags: residential('West Road') },
    { id: 3, cells: [N, [2, 0]], tags: residential('North Road') },
    { id: 4, cells: [E, [4, 1]], tags: residential('East Road') },
    { id: 5, cells: [S, [2, 2]], tags: residential('South Road') },
  ]
  // Today the whole lap is thrown at, to port, which is the side away from the island.
  const today = drive([['left', [0, 1], W, NW, N, NE, E, SE, S, SW, W, NW, N, [2, 0]]])
  const p = prepare(savedRoute(today), osmOf(ways))

  it('blocks Accept, though each quarter of it left out is short of the gate', () => {
    const { gaps, alone, why } = gate(p, drive([['left', [0, 1], W, NW, N, [2, 0]]]))
    expect(alone.length).toBeGreaterThanOrEqual(3)
    expect(alone.every((s) => s.len < COVER_GATE_M)).toBe(true)
    expect(gaps[0].m).toBeGreaterThanOrEqual(COVER_GATE_M)
    expect(gaps[0].m).toBeCloseTo(
      alone.reduce((sum, s) => sum + s.len, 0),
      6,
    )
    expect(why).toHaveLength(1)
  })

  it('lets the route thrown as today through', () => {
    expect(gate(p, today).why).toEqual([])
  })
})

describe('a stretch left out across a junction of a roundabout drawn as a way for each quarter', () => {
  // Today throws a short run each side of the north junction, on two ways with no name: the demand keeps them as one stretch, by the same rule.
  const { ways, today, around, at } = quarteredRoundabout()
  const p = prepare(savedRoute(today), osmOf(ways))

  it('blocks Accept for the two runs together, though each alone is short of the gate', () => {
    const { alone, why } = gate(p, drive([['left', [0, 1], at(24)], ['transit', ...around(24, 40).slice(1), [4, 1], [4, 2], [2, 2], [0, 2], [0, 1]]]))
    expect(alone.filter((s) => p.world.graph.pieces[s.piece].roundabout).every((s) => s.len < COVER_GATE_M)).toBe(true)
    expect(why).toHaveLength(1)
  })

  it('lets the route thrown as today through', () => {
    expect(gate(p, today).why).toEqual([])
  })
})

describe('a frontage that side streets cut into short pieces', () => {
  // Long Street, drawn as two ways with the one name, with a lane off it every 13 m or so.
  const nodes: Cell[] = [0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84, 0.96].map((c): Cell => [c, 0])
  const ways: WaySpec[] = [
    { id: 1, cells: nodes.slice(0, 5), tags: residential('Long Street') },
    { id: 2, cells: [...nodes.slice(4), [1.2, 0]], tags: residential('Long Street') },
    ...nodes.slice(1).map((cell, i): WaySpec => ({ id: 10 + i, cells: [cell, [cell[0], 0.3]], tags: residential(`Lane ${i + 1}`) })),
  ]
  const today = drive([['both', [0, 0], [1.2, 0]]])
  const p = prepare(savedRoute(today), osmOf(ways))

  it('blocks Accept for the whole stretch left out, along both ways of the one name', () => {
    const { gaps, alone, why } = gate(p, drive([['both', [0, 0], [0.36, 0]], ['transit', [0.36, 0], [0.84, 0]], ['both', [0.84, 0], [1.2, 0]]]))
    expect(alone.every((s) => s.len < COVER_GATE_M)).toBe(true)
    // One gap each side of the street, each the four pieces between 0.36 and 0.84 of a cell along.
    expect(gaps.map((g) => g.street)).toEqual(['Long Street', 'Long Street'])
    for (const g of gaps) expect(g.m).toBeGreaterThan(45)
    expect(why).toHaveLength(2)
  })

  it('does not join a stretch left out on one side to one on the other side', () => {
    const { gaps, why } = gate(p, drive([['both', [0, 0], [0.36, 0]], ['left', [0.36, 0], [0.48, 0]], ['right', [0.48, 0], [0.6, 0]], ['both', [0.6, 0], [1.2, 0]]]))
    expect(gaps.length).toBeGreaterThanOrEqual(2)
    expect(gaps.every((g) => g.m < COVER_GATE_M)).toBe(true)
    expect(why).toEqual([])
  })

  it('does not join a stretch of the street left out to one of a lane off it', () => {
    const lane = drive([['both', [0, 0], [0.48, 0], [0.48, 0.3]]])
    const q = prepare(savedRoute(lane), osmOf(ways))
    const missed = missedStretches(q.world.graph, q.world.audit.cover, auditRoute(q.world.graph, drive([['both', [0, 0], [0.36, 0]], ['transit', [0.36, 0], [0.48, 0], [0.48, 0.12]], ['both', [0.48, 0.12], [0.48, 0.3]]]), q.world.banned).cover)
    const runs = joinedMissed(q.world.graph, missed)
    const names = (run: typeof missed) => new Set(run.map((s) => q.world.graph.pieces[s.piece].name))
    expect(runs.length).toBeGreaterThan(1)
    for (const run of runs) expect(names(run).size).toBe(1)
  })
})

describe('a street of one name round a corner', () => {
  // Bend Street turns a right angle, with a lane off it at the corner so that the corner is a node.
  const ways: WaySpec[] = [
    { id: 1, cells: [[0, 0], [0.12, 0], [0.12, 0.12]], tags: residential('Bend Street') },
    { id: 2, cells: [[0.12, 0], [0.4, 0]], tags: residential('Corner Lane') },
  ]
  const p = prepare(savedRoute(drive([['left', [0, 0], [0.12, 0], [0.12, 0.12]]])), osmOf(ways))

  it('does not join a stretch left out before the corner to one after it', () => {
    const { gaps, why } = gate(p, drive([['left', [0, 0], [0.04, 0]], ['transit', [0.04, 0], [0.12, 0], [0.12, 0.08]], ['left', [0.12, 0.08], [0.12, 0.12]]]))
    expect(gaps.length).toBeGreaterThanOrEqual(2)
    expect(gaps.every((g) => g.street === 'Bend Street' && g.m < COVER_GATE_M)).toBe(true)
    expect(why).toEqual([])
  })
})

describe('a street that takes another name straight on across a junction', () => {
  // Fig Lane runs north into Ash Street and goes on straight as Ivy Court. Today throws Fig Lane and Ivy Court to port all along, going north, and to
  // starboard as well for 12 m either side of Ash Street: a short run at the end of each, 24 m in all, but on two streets.
  const today = drive([['left', [1, 1], [1, 0.108]], ['both', [1, 0.108], [1, -0.108]], ['left', [1, -0.108], [1, -1]], ['transit', [1, -1], [1, 0], [0, 0], [0, 1], [1, 1]]])
  const leftOut = drive([['left', [1, 1], [1, -1]], ['transit', [1, -1], [1, 0], [0, 0], [0, 1], [1, 1]]])
  const p = prepare(savedRoute(today), osmOf(gridWays()))
  // The same map with the court called Fig Lane too, so that the street goes on under its one name.
  const oneName = prepare(savedRoute(today), osmOf(gridWays().map((w) => (w.id === WAY.ivy ? { ...w, tags: residential('Fig Lane') } : w))))
  /** Metres of the two streets the demand throws at on their east side, which is the starboard going north. */
  const eastThrown = (q: Prepared) => {
    const g = q.world.graph
    return q.world.edges
      .filter((e) => e.name === 'Fig Lane' || e.name === 'Ivy Court')
      .filter((e) => (g.nodes[g.pieces[e.piece].b][1] > g.nodes[g.pieces[e.piece].a][1] ? e.reqR : e.reqL))
      .reduce((sum, e) => sum + e.len, 0)
  }

  it('does not keep the short run each side of the junction as one stretch, as it would on a street of one name', () => {
    expect(eastThrown(oneName)).toBeGreaterThanOrEqual(COVER_GATE_M)
    expect(eastThrown(p)).toBe(0)
  })

  it('does not join the two left out into one gap that blocks Accept, though together they come to the gate', () => {
    const { gaps, alone, why } = gate(p, leftOut)
    expect(alone.every((s) => s.len < COVER_GATE_M)).toBe(true)
    expect(alone.reduce((sum, s) => sum + s.len, 0)).toBeGreaterThanOrEqual(COVER_GATE_M)
    expect(gaps.every((g) => g.m < COVER_GATE_M)).toBe(true)
    expect(why).toEqual([])
    expect(gate(oneName, leftOut).why).toHaveLength(1)
  })
})

describe('a gap across a roundabout with a name on only part of it', () => {
  // The quarter of the ring from the north junction to the east one is named, and the rest is not. Today throws the ring to port from half way along
  // that quarter to the south junction: 17 m or so of the named quarter, then the whole of the next, which is twice as long and has no name.
  const { ways, around, at } = quarteredRoundabout()
  const named = ways.map((w) => (w.id === 1 ? { ...w, tags: { ...w.tags, name: 'Ring Street' } } : w))
  const today = drive([['transit', [0, 1], ...around(24, 36)], ['left', ...around(36, 48).slice(1)], ['transit', ...around(48, 56).slice(1), [0, 1]]])
  const p = prepare(savedRoute(today), osmOf(named))

  it('is named and placed by the piece of it that has a name, though a longer piece has none', () => {
    const { gaps, alone } = gate(p, drive([['transit', [0, 1], ...around(24, 56), [0, 1]]]))
    const g = p.world.graph
    const longest = alone.reduce((a, b) => (b.len > a.len ? b : a))
    expect(g.pieces[longest.piece].name).toBeNull()
    const [gap, ...rest] = gaps
    expect(rest.every((x) => x.m < COVER_GATE_M)).toBe(true)
    expect(gap.m).toBeGreaterThan(longest.len + 10)
    expect(gap.street).toBe('Ring Street')
    expect(haversine(gap, place(at(6)))).toBeLessThan(5)
  })
})

describe('a gap only partly at the head of a court', () => {
  // Dell Court runs east from Cross Road to its head, with two lanes off it that cut it into three pieces: 11 m, 11 m and the last 13 m to the head.
  // Today throws it to port going in, and turns at the head.
  const ways: WaySpec[] = [
    { id: 1, cells: [[0, -0.3], [0, 0], [0, 0.3]], tags: residential('Cross Road') },
    { id: 2, cells: [[0, 0], [0.1, 0], [0.2, 0], [0.32, 0]], tags: residential('Dell Court') },
    { id: 3, cells: [[0.1, 0], [0.1, 0.3]], tags: residential('Lane 1') },
    { id: 4, cells: [[0.2, 0], [0.2, 0.3]], tags: residential('Lane 2') },
  ]
  const p = prepare(savedRoute(drive([['left', [0, 0], [0.32, 0]], ['transit', [0.32, 0], [0, 0]]])), osmOf(ways))
  const gapOf = (after: Pick<Route, 'points' | 'sideChanges'>) => {
    const big = gate(p, after).gaps.filter((g) => g.m >= COVER_GATE_M)
    expect(big).toHaveLength(1)
    return big[0]
  }

  it('is not at the head when under half of it is, though its longest piece is', () => {
    const gap = gapOf(drive([['transit', [0, 0], [0.32, 0], [0, 0]]]))
    expect(gap.m).toBeGreaterThan(30)
    expect(gap.atHead).toBe(false)
  })

  it('is at the head when most of it is', () => {
    const gap = gapOf(drive([['left', [0, 0], [0.1, 0]], ['transit', [0.1, 0], [0.32, 0], [0, 0]]]))
    expect(gap.m).toBeLessThan(26)
    expect(gap.atHead).toBe(true)
  })
})

describe('the runs of missed stretches', () => {
  it('are each stretch alone when none of them meet', () => {
    const ways: WaySpec[] = [{ id: 1, cells: [[0, 0], [1, 0]], tags: residential('Ash Street') }]
    const p = prepare(savedRoute(drive([['both', [0, 0], [1, 0]]])), osmOf(ways))
    const after = drive([['both', [0, 0], [0.3, 0]], ['transit', [0.3, 0], [0.6, 0]], ['both', [0.6, 0], [1, 0]]] as Stretch[])
    const missed = missedStretches(p.world.graph, p.world.audit.cover, auditRoute(p.world.graph, after, []).cover)
    expect(joinedMissed(p.world.graph, missed)).toEqual(missed.map((s) => [s]))
  })
})
