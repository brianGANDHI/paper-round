import { describe, expect, it } from 'vitest'
import { sideAt } from '../geo'
import type { Side, SideChange } from '../types'
import { assignSides, buildRoute, smoothSides, tidySides } from './build'
import { prepare } from './optimise'
import { makeProblem, type Leg, type Problem } from './problem'
import { drive, gridWays, osmOf, savedRoute, type Stretch } from './testNetwork'
import { optionsFor, type World } from './world'

function setUp(stretches: Stretch[]) {
  const { world: w } = prepare(savedRoute(drive(stretches)), osmOf(gridWays()))
  const pr = makeProblem(w.nodes.length, w.edges, optionsFor(w, { allowed: {}, keepOrder: false }), w.depot)
  return { w, pr }
}

/** The legs along a list of street names, each edge of the street that way round. */
const legs = (w: World, pr: Problem, list: [string, 1 | -1][]): Leg[] =>
  list.map(([name, dir]) => ({ arc: pr.arcs.find((a) => a.dir === dir && w.edges[a.edge].name === name && w.edges[a.edge].driven > 0)?.id as number, serves: true }))

describe('assignSides', () => {
  it('puts a side on a pass that has it to port, though another pass comes first', () => {
    const { w, pr } = setUp([['left', [1, 0], [0, 0]], ['transit', [0, 0], [0, 1], [1, 1], [1, 0]], ['transit', [1, 0], [0, 0]]])
    // Ash Street's first block needs its south side, which is on the left going west.
    const run = legs(w, pr, [['Ash Street', 1], ['Ash Street', -1]])
    expect(assignSides(pr, run, w.edges)).toEqual(['transit', 'left'])
  })

  it('throws both from the one pass of a street that needs both', () => {
    const { w, pr } = setUp([['both', [0, 0], [1, 0]]])
    expect(assignSides(pr, legs(w, pr, [['Ash Street', 1]]), w.edges)).toEqual(['both'])
  })

  it('throws each side to port when the street is driven both ways', () => {
    const { w, pr } = setUp([['both', [0, 0], [1, 0]]])
    expect(assignSides(pr, legs(w, pr, [['Ash Street', 1], ['Ash Street', -1]]), w.edges)).toEqual(['left', 'left'])
  })

  it('falls back on starboard when no pass has the side to port', () => {
    const { w, pr } = setUp([['right', [0, 0], [1, 0]]])
    expect(assignSides(pr, legs(w, pr, [['Ash Street', 1]]), w.edges)).toEqual(['right'])
  })

  it('gives a street with nothing to throw at transit', () => {
    const { w, pr } = setUp([['transit', [0, 0], [1, 0]]])
    expect(assignSides(pr, legs(w, pr, [['Ash Street', 1]]), w.edges)).toEqual(['transit'])
  })
})

describe('smoothSides', () => {
  /** Hand-made arcs of given lengths on one edge each, all with something to throw at unless the side is listed as empty. */
  function fake(lengths: number[], needs: boolean[] = lengths.map(() => true)) {
    const arcs = lengths.map((len, id) => ({ id, edge: id, from: id, to: id + 1, len, rev: -1, dir: 1 as const, way: id, main: false, busy: false, weight: len }))
    const edges = lengths.map((len, id) => ({ id, u: id, v: id + 1, pts: [], len, name: null, highway: 'residential', oneway: 0 as const, piece: id, reqL: needs[id], reqR: false, beforeL: 0, beforeR: 0, driven: 1 }))
    const run: Leg[] = lengths.map((_, id) => ({ arc: id, serves: true }))
    const pr = { arcs } as unknown as Problem
    return { pr, run, edges }
  }

  const smooth = (lengths: number[], sides: Side[], needs?: boolean[]) => {
    const { pr, run, edges } = fake(lengths, needs)
    return smoothSides(pr, run, edges, sides)
  }

  it('lets a run of both swallow a short side between two of them', () => {
    expect(smooth([100, 20, 100], ['both', 'left', 'both'])).toEqual(['both', 'both', 'both'])
  })

  it('lets a run swallow a short transit, so the voice doesn\'t say a new side every few seconds', () => {
    expect(smooth([100, 20, 100], ['left', 'transit', 'left'])).toEqual(['left', 'left', 'left'])
  })

  it('never takes anything away: a short side can\'t become a side that doesn\'t throw there', () => {
    expect(smooth([100, 20, 100], ['left', 'right', 'left'])).toEqual(['left', 'right', 'left'])
    expect(smooth([100, 20, 100], ['transit', 'left', 'transit'])).toEqual(['transit', 'left', 'transit'])
  })

  it('leaves a stretch of side long enough alone', () => {
    expect(smooth([100, 30, 100], ['both', 'left', 'both'])).toEqual(['both', 'left', 'both'])
  })

  it('lets a longer run of plain transit with nothing to throw at go, up to 60 m', () => {
    expect(smooth([100, 50, 100], ['left', 'transit', 'left'], [true, false, true])).toEqual(['left', 'left', 'left'])
    expect(smooth([100, 50, 100], ['left', 'transit', 'left'])).toEqual(['left', 'transit', 'left'])
    expect(smooth([100, 70, 100], ['left', 'transit', 'left'], [true, false, true])).toEqual(['left', 'transit', 'left'])
  })

  it('adds up a run over its arcs, so that short arcs of one side aren\'t taken for a short run', () => {
    const lengths = [60, 20, 20, 60, 12, 60]
    expect(smooth(lengths, ['both', 'left', 'left', 'both', 'transit', 'both'])).toEqual(['both', 'left', 'left', 'both', 'both', 'both'])
  })

  describe('with a road the driver turned off', () => {
    const offRoad = (e: { id: number }) => e.id !== 1
    const smoothOff = (sides: Side[]) => {
      const { pr, run, edges } = fake([100, 24, 100], [true, false, true])
      return smoothSides(pr, run, edges, sides, offRoad)
    }

    it('keeps starboard off it, as transit', () => {
      expect(smoothOff(['both', 'transit', 'both'])).toEqual(['both', 'transit', 'both'])
    })

    it('keeps starboard off it, as port', () => {
      expect(smoothOff(['both', 'left', 'both'])).toEqual(['both', 'left', 'both'])
    })

    it('still lets port run over it', () => {
      expect(smoothOff(['left', 'transit', 'left'])).toEqual(['left', 'left', 'left'])
    })

    it('leaves alone a stretch that has starboard there already', () => {
      expect(smoothOff(['both', 'right', 'both'])).toEqual(['both', 'both', 'both'])
    })
  })

  it('leaves no run under the 15 m the app will paint where a neighbour can take it', () => {
    const lengths = [60, 6, 6, 60, 12, 60]
    const out = smooth(lengths, ['both', 'left', 'left', 'both', 'right', 'both'])
    expect(new Set(out)).toEqual(new Set(['both']))
  })
})

describe('tidySides', () => {
  it('leaves a clean list alone', () => {
    const rows: SideChange[] = [{ idx: 0, side: 'left' }, { idx: 3, side: 'both' }]
    expect(tidySides(rows, 5)).toEqual(rows)
  })

  it('merges a row that repeats the side before it', () => {
    expect(tidySides([{ idx: 0, side: 'left' }, { idx: 2, side: 'left' }, { idx: 3, side: 'both' }], 5)).toEqual([{ idx: 0, side: 'left' }, { idx: 3, side: 'both' }])
  })

  it('takes the later of two rows at one index, as sideAt does', () => {
    const rows: SideChange[] = [{ idx: 0, side: 'left' }, { idx: 2, side: 'right' }, { idx: 2, side: 'both' }]
    expect(tidySides(rows, 5)).toEqual([{ idx: 0, side: 'left' }, { idx: 2, side: 'both' }])
    for (let i = 0; i < 5; i++) expect(sideAt({ sideChanges: tidySides(rows, 5) }, i)).toBe(sideAt({ sideChanges: rows }, i))
  })

  it('drops a row that a dropped row was all that kept apart from the one before', () => {
    expect(tidySides([{ idx: 0, side: 'left' }, { idx: 1, side: 'right' }, { idx: 1, side: 'left' }], 5)).toEqual([{ idx: 0, side: 'left' }])
  })

  it('drops a row with no segment to apply to', () => {
    expect(tidySides([{ idx: 0, side: 'left' }, { idx: 5, side: 'both' }], 5)).toEqual([{ idx: 0, side: 'left' }])
  })
})

describe('buildRoute', () => {
  it('rounds every point to 6 decimal places as it is added, so that nothing is checked on points that won\'t be kept', () => {
    const { w, pr } = setUp([['left', [0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]])
    const run = legs(w, pr, [['Ash Street', 1], ['Fig Lane', 1], ['Birch Street', -1], ['Elm Lane', -1]])
    const { points } = buildRoute(w.graph, pr, run, w.edges, assignSides(pr, run, w.edges))
    for (const p of points) {
      expect(Number(p.lat.toFixed(6))).toBe(p.lat)
      expect(Number(p.lng.toFixed(6))).toBe(p.lng)
    }
  })

  it('has no two points the same side by side, and rows that follow sideAt', () => {
    const { w, pr } = setUp([['left', [0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]])
    const run = legs(w, pr, [['Ash Street', 1], ['Fig Lane', 1], ['Birch Street', -1], ['Elm Lane', -1]])
    const sides: Side[] = ['left', 'both', 'both', 'transit']
    const { points, sideChanges } = buildRoute(w.graph, pr, run, w.edges, sides)
    for (let i = 1; i < points.length; i++) expect(points[i]).not.toEqual(points[i - 1])
    expect(sideChanges[0].idx).toBe(0)
    expect(sideChanges.map((c) => c.side)).toEqual(['left', 'both', 'transit'])
    for (let i = 1; i < sideChanges.length; i++) expect(sideChanges[i].idx).toBeGreaterThan(sideChanges[i - 1].idx)
    expect(sideChanges[sideChanges.length - 1].idx).toBeLessThan(points.length - 1)
    expect(sideAt({ sideChanges }, sideChanges[1].idx - 1)).toBe('left')
    expect(sideAt({ sideChanges }, sideChanges[1].idx)).toBe('both')
  })
})
