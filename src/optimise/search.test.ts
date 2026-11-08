import { describe, expect, it } from 'vitest'
import { networkStart } from './network'
import { prepare } from './optimise'
import { buildMatrix, makeProblem, type Matrix, type Problem } from './problem'
import { anneal, makeRng, nearTable, oldSequence, orderedStart } from './search'
import { drive, gridWays, osmOf, savedRoute } from './testNetwork'
import { edgeAt, optionsFor, type World } from './world'

const ROUND = drive([
  ['left', [0, 0], [1, 0], [2, 0], [3, 0]],
  ['both', [3, 0], [3, 1], [2, 1], [1, 1], [0, 1]],
  ['left', [0, 1], [0, 0]],
  ['both', [0, 0], [1, 0], [1, 1]],
  ['transit', [1, 1], [0, 1], [0, 0]],
])

function setUp(): { w: World; pr: Problem; mx: Matrix } {
  const { world: w } = prepare(savedRoute(ROUND), osmOf(gridWays()))
  const pr = makeProblem(w.nodes.length, w.edges, optionsFor(w, { allowed: {}, keepOrder: false }), w.depot)
  return { w, pr, mx: buildMatrix(pr) }
}

const tasksOf = (mx: Matrix, seq: ArrayLike<number>) => Array.from(seq, (i) => mx.taskOf[i])
const cost = (mx: Matrix, seq: Int32Array) => {
  let total = 0
  for (let i = 0; i + 1 < seq.length; i++) total += mx.c[seq[i] * (mx.m + 1) + seq[i + 1]]
  return total
}

describe('makeRng', () => {
  it('gives the same numbers from the same seed', () => {
    const a = makeRng(7)
    const b = makeRng(7)
    for (let i = 0; i < 20; i++) expect(a.next()).toBe(b.next())
  })

  it('keeps its state to itself, so two runs side by side can\'t disturb each other', () => {
    const lone = makeRng(5)
    const expected = [lone.next(), lone.next(), lone.next()]
    const a = makeRng(5)
    const other = makeRng(99)
    const got = [a.next(), (other.next(), a.next()), (other.next(), a.next())]
    expect(got).toEqual(expected)
  })

  it('stays in range', () => {
    const r = makeRng(1)
    for (let i = 0; i < 200; i++) {
      const n = r.next()
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(1)
      expect(r.below(6)).toBeLessThan(6)
    }
  })
})

describe('nearTable', () => {
  it('lists the cheapest arcs after each arc, cheapest first', () => {
    const { mx } = setUp()
    const near = nearTable(mx)
    const W = mx.m + 1
    for (const row of [0, 3, mx.m]) {
      const byCost = Array.from({ length: mx.m }, (_, j) => j).sort((a, b) => mx.c[row * W + a] - mx.c[row * W + b])
      expect(Array.from(near.subarray(row * 12, row * 12 + 12))).toEqual(byCost.slice(0, 12))
    }
  })

  it('fills its rows even with fewer arcs than places', () => {
    const c = Float32Array.from([1e7, 2, 5, 3, 1e7, 4, 1, 1, 0])
    const near = nearTable({ m: 2, arcOf: [0, 1], idxOf: Int32Array.from([0, 1]), taskOf: Int32Array.from([0, 1]), c })
    expect(Array.from(near.subarray(0, 4))).toEqual([1, 0, 1, 0])
  })
})

describe('networkStart', () => {
  it('reaches every task once', () => {
    const { w, pr, mx } = setUp()
    const start = networkStart(pr, mx, w.edges)
    expect(tasksOf(mx, start).sort((a, b) => a - b)).toEqual(pr.tasks.map((t) => t.id))
  })
})

describe('oldSequence', () => {
  it('meets the tasks in the old route\'s order, each the way it drove them', () => {
    const { w, pr, mx } = setUp()
    const seq = oldSequence(pr, mx, w.audit.matched, (p, s) => edgeAt(w.byPiece, p, s), w.edges.length)
    expect(tasksOf(mx, seq).sort((a, b) => a - b)).toEqual(pr.tasks.map((t) => t.id))
    const first = pr.arcs[mx.arcOf[seq[0]]]
    expect(w.edges[first.edge].name).toBe('Ash Street')
    expect(first.dir).toBe(1)
  })
})

describe('orderedStart', () => {
  it('moves only what breaks the order, and leaves the ranks climbing', () => {
    const { pr, mx } = setUp()
    const start = Int32Array.from(pr.tasks.map((t) => mx.idxOf[t.options[0]]))
    const ranks = new Int32Array(pr.tasks.length).fill(-1)
    const a = mx.taskOf[start[0]]
    const b = mx.taskOf[start[3]]
    const c = mx.taskOf[start[6]]
    ranks[c] = 0
    ranks[a] = 1
    ranks[b] = 2
    const out = orderedStart(pr, mx, start, ranks)
    expect(tasksOf(mx, out).sort((x, y) => x - y)).toEqual(pr.tasks.map((t) => t.id))
    const seen = tasksOf(mx, out).filter((t) => ranks[t] >= 0).map((t) => ranks[t])
    expect(seen).toEqual([0, 1, 2])
  })

  it('changes nothing with no ranks to keep', () => {
    const { pr, mx } = setUp()
    const start = Int32Array.from(pr.tasks.map((t) => mx.idxOf[t.options[0]]))
    expect(orderedStart(pr, mx, start, new Int32Array(pr.tasks.length).fill(-1))).toEqual(start)
  })
})

describe('anneal', () => {
  it('never gets worse than where it starts', () => {
    const { pr, mx } = setUp()
    const start = Int32Array.from(pr.tasks.map((t) => mx.idxOf[t.options[0]]))
    const tour = anneal(pr, mx, nearTable(mx), { start, heat: 25, seed: 3, used: (moves) => moves / 20000 })
    expect(tour.cost).toBeLessThanOrEqual(cost(mx, Int32Array.from([mx.m, ...start, mx.m])) + 1e-3)
  })

  it('takes the same course from the same seed and moves', () => {
    const { pr, mx } = setUp()
    const start = Int32Array.from(pr.tasks.map((t) => mx.idxOf[t.options[0]]))
    const near = nearTable(mx)
    const plan = { start, heat: 25, seed: 4, used: (moves: number) => moves / 20000 }
    expect(anneal(pr, mx, near, plan).seq).toEqual(anneal(pr, mx, near, plan).seq)
  })

  it('keeps a kept order, whatever it would save to break it', () => {
    const { pr, mx } = setUp()
    const near = nearTable(mx)
    const start = Int32Array.from(pr.tasks.map((t) => mx.idxOf[t.options[0]]))
    const ranks = new Int32Array(pr.tasks.length).fill(-1)
    start.forEach((j, i) => {
      if (i % 3 === 0) ranks[mx.taskOf[j]] = i
    })
    for (const seed of [1, 2, 3]) {
      const tour = anneal(pr, mx, near, { start, heat: 25, seed, ranks, used: (moves) => moves / 20000 })
      const inOrder = tasksOf(mx, tour.seq.subarray(1, tour.seq.length - 1)).filter((t) => ranks[t] >= 0).map((t) => ranks[t])
      expect(inOrder).toEqual([...inOrder].sort((a, b) => a - b))
    }
  })

  it('stops when the budget says so, however early', () => {
    const { pr, mx } = setUp()
    const start = Int32Array.from(pr.tasks.map((t) => mx.idxOf[t.options[0]]))
    let looks = 0
    const tour = anneal(pr, mx, nearTable(mx), {
      start,
      heat: 4,
      seed: 1,
      used: () => {
        looks++
        return 1
      },
    })
    expect(looks).toBe(1)
    expect(Array.from(tour.seq.subarray(1, tour.seq.length - 1))).toEqual(Array.from(start))
  })
})
