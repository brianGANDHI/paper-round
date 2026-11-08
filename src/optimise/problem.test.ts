import { describe, expect, it } from 'vitest'
import type { Route } from '../types'
import { coverOf, dropIslands, edgesOf, emptyCover, type Edge } from './demand'
import { bannedTurns, buildGraph, type Graph } from './graph'
import { matchRoute, samplesOf } from './match'
import { arcDijkstra, buildMatrix, expand, FRESH_ROAD_FACTOR, makeProblem, NO_UTURN_M, BUSY_UTURN_M, UTURN_M, STARBOARD_BIAS, type Options, type Problem, type Visit } from './problem'
import { drive, gridWays, mainRoad, osmOf, place, residential, turnRule, WAY, type Cell, type WaySpec } from './testNetwork'

const origin = { lat0: place([0, 0]).lat, lng0: place([0, 0]).lng }

function setup(ways: WaySpec[], route: Pick<Route, 'points' | 'sideChanges'>) {
  const g = buildGraph(osmOf(ways), origin)
  const samples = samplesOf(g, route.points, route.sideChanges)
  const cover = emptyCover(g)
  coverOf(g, samples, matchRoute(g, samples), cover)
  const { nodes, edges } = edgesOf(g, cover)
  dropIslands(g, edges)
  return { g, nodes, edges }
}

const optionsOf = (g: Graph, extra: Partial<Options> = {}): Options => ({
  allow: () => true,
  may: (e) => e.driven > 0 || g.pieces[e.piece].open,
  main: (e) => e.highway === 'secondary',
  busy: (e) => e.highway === 'tertiary',
  way: (e) => g.pieces[e.piece].way,
  weight: (e) => (e.driven > 0 ? 1 : FRESH_ROAD_FACTOR),
  banned: [],
  visits: [],
  keepOrder: false,
  rightBias: 0,
  ...extra,
})

const edgeNamed = (edges: Edge[], name: string) => edges.find((e) => e.name === name && (e.reqL || e.reqR)) ?? (edges.find((e) => e.name === name) as Edge)
const nodeAt = (g: Graph, cell: Cell) => {
  const { lat, lng } = place(cell)
  const x = (lng - origin.lng0) * (Math.PI / 180) * Math.cos(origin.lat0 * (Math.PI / 180)) * 6371000
  const y = (lat - origin.lat0) * (Math.PI / 180) * 6371000
  return g.nodes.findIndex((n) => Math.hypot(n[0] - x, n[1] - y) < 1)
}

/** The cost and the arcs of the cheapest way from standing on one arc to having finished another. */
function pathBetween(pr: Problem, from: number, to: number) {
  const d = new Float64Array(pr.arcs.length)
  const pre = new Int32Array(pr.arcs.length)
  arcDijkstra(pr, from, -1, d, pre)
  const arcs: number[] = []
  for (let a = to; a !== -1 && a !== from; a = pre[a]) arcs.unshift(a)
  return { cost: d[to], arcs }
}

const arcOf = (pr: Problem, e: Edge, dir: 1 | -1) => pr.arcs.find((a) => a.edge === e.id && a.dir === dir)?.id as number

describe('dead ends', () => {
  it('does not take the join between two stretches of a one-way for one', () => {
    const ways: WaySpec[] = [
      { id: 1, cells: [[0, 0], [2, 0]], tags: { ...mainRoad('One Road'), oneway: 'yes' } },
      { id: 2, cells: [[2, 0], [2, 1], [0, 1], [0, 0]], tags: residential('Back Way') },
    ]
    // Thrown one way along the first half and both ways along the second, so that a node of its own joins the two stretches.
    const { g, nodes, edges } = setup(ways, drive([['left', [0, 0], [1, 0]], ['both', [1, 0], [2, 0]], ['transit', [2, 0], [2, 1], [0, 1], [0, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g), 0)
    const [first] = edges.filter((e) => e.name === 'One Road')
    expect(pr.out[first.v]).toHaveLength(1)
    expect(pr.deadEnd[first.v]).toBe(0)
    expect(pr.uturnAt[first.v]).toBe(NO_UTURN_M)
  })

  it('still takes the end of a street driven both ways as one', () => {
    const { g, nodes, edges } = setup(gridWays(), drive([['left', [1, 0], [1, -1], [1, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g), 0)
    expect(pr.deadEnd[nodeAt(g, [1, -1])]).toBe(1)
  })
})

describe('tasks', () => {
  const route = drive([['left', [0, 0], [1, 0], [2, 0]], ['transit', [2, 0], [2, 1]], ['right', [2, 1], [1, 1], [0, 1]]])

  it('gives an allowed street one task that either way serves', () => {
    const { g, nodes, edges } = setup(gridWays(), route)
    const pr = makeProblem(nodes.length, edges, optionsOf(g), 0)
    const ash = edgeNamed(edges, 'Ash Street')
    const tasks = pr.tasks.filter((t) => t.edge === ash.id)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].options).toHaveLength(2)
  })

  it('gives a street where it is not allowed one driven task per side, with that side to port', () => {
    const both = drive([['left', [0, 0], [1, 0]], ['transit', [1, 0], [1, 1], [0, 1], [0, 0]], ['right', [0, 0], [1, 0]]])
    const { g, nodes, edges } = setup(gridWays(), both)
    const pr = makeProblem(nodes.length, edges, optionsOf(g, { allow: () => false }), 0)
    const ash = edgeNamed(edges, 'Ash Street')
    expect(ash.reqL && ash.reqR).toBe(true)
    const tasks = pr.tasks.filter((t) => t.edge === ash.id)
    expect(tasks).toHaveLength(2)
    expect(tasks.every((t) => t.options.length === 1)).toBe(true)
    expect(tasks.map((t) => pr.arcs[t.options[0]].dir).sort()).toEqual([-1, 1])
  })

  it('drives a side needed on one side the way that has it to port', () => {
    const { g, nodes, edges } = setup(gridWays(), drive([['right', [0, 0], [1, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g, { allow: () => false }), 0)
    const ash = edgeNamed(edges, 'Ash Street')
    expect(ash.reqR).toBe(true)
    const [t] = pr.tasks.filter((x) => x.edge === ash.id)
    expect(pr.arcs[t.options[0]].dir).toBe(-1)
    expect(pr.forced).toEqual([])
  })

  it('makes do with the one pass of a one-way and reports it', () => {
    const ways: WaySpec[] = [
      { id: 1, cells: [[0, 0], [1, 0]], tags: { ...mainRoad('One Road'), oneway: 'yes' } },
      { id: 2, cells: [[1, 0], [1, 1], [0, 1], [0, 0]], tags: residential('Back Way') },
    ]
    const { g, nodes, edges } = setup(ways, drive([['right', [0, 0], [1, 0]], ['transit', [1, 0], [1, 1], [0, 1], [0, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g, { allow: (e) => e.name !== 'One Road' }), 0)
    const road = edgeNamed(edges, 'One Road')
    const [t] = pr.tasks.filter((x) => x.edge === road.id)
    expect(pr.arcs[t.options[0]].dir).toBe(1)
    expect(pr.forced.map((f) => f.edge)).toEqual([road.id])
  })

  it('can only go the way a one-way runs, even when the street is allowed', () => {
    const route2 = drive([['left', [2, 0], [2, -1], [3, -1], [3, 0]], ['transit', [3, 0], [2, 0]]])
    const { g, nodes, edges } = setup(gridWays(), route2)
    const pr = makeProblem(nodes.length, edges, optionsOf(g), nodeAt(g, [2, 0]))
    for (const e of edges.filter((x) => x.name === 'Juniper Way')) expect(pr.arcs.filter((a) => a.edge === e.id).map((a) => a.dir)).toEqual([1])
  })

  it('makes no task of a street with nothing to throw at and no stop', () => {
    const { g, nodes, edges } = setup(gridWays(), route)
    const pr = makeProblem(nodes.length, edges, optionsOf(g), 0)
    const gum = edgeNamed(edges, 'Gum Lane')
    expect(gum.driven).toBeGreaterThan(0)
    expect(pr.tasks.some((t) => t.edge === gum.id)).toBe(false)
  })
})

describe('visits', () => {
  const route = drive([['left', [0, 0], [1, 0]], ['transit', [1, 0], [1, 1], [0, 1], [0, 0]]])

  it('makes a stretch with a stop on it a task, either way round where the street is allowed', () => {
    const { g, nodes, edges } = setup(gridWays(), route)
    const fig = edgeNamed(edges, 'Fig Lane')
    const visits: Visit[] = [{ edge: fig.id, dir: 1, rank: -1 }]
    const pr = makeProblem(nodes.length, edges, optionsOf(g, { visits }), 0)
    const t = pr.tasks[pr.visitTask[0]]
    expect(t.edge).toBe(fig.id)
    expect(t.options).toHaveLength(2)
  })

  it('holds it to today\'s way round where the street is not allowed', () => {
    const { g, nodes, edges } = setup(gridWays(), route)
    const fig = edgeNamed(edges, 'Fig Lane')
    const pr = makeProblem(nodes.length, edges, optionsOf(g, { allow: () => false, visits: [{ edge: fig.id, dir: 1, rank: -1 }] }), 0)
    const t = pr.tasks[pr.visitTask[0]]
    expect(t.options).toEqual([arcOf(pr, fig, 1)])
  })

  it('shares a task with the street\'s own, rather than making two', () => {
    const { g, nodes, edges } = setup(gridWays(), route)
    const ash = edgeNamed(edges, 'Ash Street')
    const pr = makeProblem(nodes.length, edges, optionsOf(g, { visits: [{ edge: ash.id, dir: -1, rank: 0 }] }), 0)
    expect(pr.tasks.filter((t) => t.edge === ash.id)).toHaveLength(1)
  })

  it('holds a stretch with two bundles to the way they were passed, as the other way reaches them in the wrong order', () => {
    const { g, nodes, edges } = setup(gridWays(), route)
    const ash = edgeNamed(edges, 'Ash Street')
    const visits: Visit[] = [{ edge: ash.id, dir: 1, rank: 0 }, { edge: ash.id, dir: 1, rank: 1 }]
    const pr = makeProblem(nodes.length, edges, optionsOf(g, { visits, keepOrder: true }), 0)
    expect(pr.tasks.filter((t) => t.edge === ash.id).map((t) => t.options)).toEqual([[arcOf(pr, ash, 1)]])
    expect(makeProblem(nodes.length, edges, optionsOf(g, { visits }), 0).tasks.filter((t) => t.edge === ash.id)[0].options).toHaveLength(2)
  })

  it('gives bundles passed going each way a pass each way', () => {
    const { g, nodes, edges } = setup(gridWays(), route)
    const ash = edgeNamed(edges, 'Ash Street')
    const visits: Visit[] = [{ edge: ash.id, dir: 1, rank: 0 }, { edge: ash.id, dir: -1, rank: 1 }]
    const pr = makeProblem(nodes.length, edges, optionsOf(g, { visits, keepOrder: true }), 0)
    expect(pr.tasks.filter((t) => t.edge === ash.id)).toHaveLength(2)
    expect(pr.visitTask[0]).not.toBe(pr.visitTask[1])
  })
})

describe('costs', () => {
  it('charges a turn back on a plain street what a turn back costs', () => {
    const { g, nodes, edges } = setup(gridWays(), drive([['left', [0, 0], [1, 0], [2, 0], [3, 0]], ['left', [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g), 0)
    expect(pr.uturnAt[nodeAt(g, [1, 0])]).toBe(UTURN_M)
  })

  it('puts a turn back out of the question at any node touching a main road', () => {
    const { g, nodes, edges } = setup(gridWays(), drive([['left', [1, 0], [1, 1], [1, 2]], ['transit', [1, 2], [2, 2], [2, 1], [2, 0], [1, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g), nodeAt(g, [1, 0]))
    const at = nodeAt(g, [1, 2])
    expect(pr.uturnAt[at]).toBe(NO_UTURN_M)
    // Down the last block of a side street to the main road and back up it: round the block beats turning back at the junction.
    const fig = edges.filter((e) => e.name === 'Fig Lane' && (e.u === at || e.v === at))[0]
    const down = pr.arcs.find((a) => a.edge === fig.id && a.to === at)?.id as number
    const up = pr.arcs.find((a) => a.edge === fig.id && a.from === at)?.id as number
    const { arcs } = pathBetween(pr, down, up)
    expect(arcs[0]).not.toBe(up)
    expect(arcs.length).toBeGreaterThan(1)
  })

  it('still lets a true dead end on a main road be turned in', () => {
    const ways: WaySpec[] = [{ id: 1, cells: [[0, 0], [1, 0]], tags: mainRoad('Stub Road') }]
    const { g, nodes, edges } = setup(ways, drive([['left', [0, 0], [1, 0], [0, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g), 0)
    const end = nodeAt(g, [1, 0])
    expect(pr.deadEnd[end]).toBe(1)
    expect(pr.uturnAt[end]).toBe(UTURN_M)
  })

  it('makes a turn back at a junction with a busier road worth avoiding', () => {
    const ways: WaySpec[] = [...gridWays().filter((w) => w.id !== WAY.ash), { id: WAY.ash, cells: [[0, 0], [1, 0], [2, 0], [3, 0]], tags: { highway: 'tertiary', name: 'Ash Street' } }]
    const { g, nodes, edges } = setup(ways, drive([['left', [0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g), 0)
    expect(pr.uturnAt[nodeAt(g, [1, 0])]).toBe(BUSY_UTURN_M)
  })

  it('makes a road the old route never drove dearer, and leaves the length as it is', () => {
    const { g, nodes, edges } = setup(gridWays(), drive([['left', [0, 0], [1, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g), 0)
    const fresh = edgeNamed(edges, 'Hazel Lane')
    const arc = pr.arcs.find((a) => a.edge === fresh.id) as Problem['arcs'][number]
    expect(arc.len).toBeCloseTo(fresh.len, 6)
    expect(arc.weight).toBeCloseTo(fresh.len * FRESH_ROAD_FACTOR, 6)
  })

  it('charges a one-sided street driven with its side to starboard, one way only', () => {
    const { g, nodes, edges } = setup(gridWays(), drive([['left', [0, 0], [1, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g, { rightBias: STARBOARD_BIAS }), 0)
    const ash = edgeNamed(edges, 'Ash Street')
    expect(pr.bias[arcOf(pr, ash, 1)]).toBe(0)
    expect(pr.bias[arcOf(pr, ash, -1)]).toBeCloseTo(ash.len * STARBOARD_BIAS, 6)
  })

  it('leaves a street thrown both ways out of that, as neither way is worse', () => {
    const { g, nodes, edges } = setup(gridWays(), drive([['both', [0, 0], [1, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g, { rightBias: STARBOARD_BIAS }), 0)
    const ash = edgeNamed(edges, 'Ash Street')
    expect(pr.bias[arcOf(pr, ash, 1)]).toBe(0)
    expect(pr.bias[arcOf(pr, ash, -1)]).toBe(0)
  })
})

describe('banned turns', () => {
  const route = drive([['left', [0, 1], [1, 1], [2, 1]], ['left', [2, 1], [2, 0], [1, 0], [1, 1], [0, 1]]])

  it('never takes a banned turn, going round instead', () => {
    const osm = osmOf(gridWays(), [], [turnRule(1, 'no_left_turn', WAY.birch, [1, 1], WAY.fig)])
    const g = buildGraph(osm, origin)
    const { banned } = bannedTurns(g, osm)
    const samples = samplesOf(g, route.points, route.sideChanges)
    const cover = emptyCover(g)
    coverOf(g, samples, matchRoute(g, samples), cover)
    const { nodes, edges } = edgesOf(g, cover)
    const pr = makeProblem(nodes.length, edges, optionsOf(g, { banned }), 0)
    const via = nodeAt(g, [1, 1])
    const into = pr.arcs.find((a) => a.to === via && a.way === WAY.birch && a.dir === 1)?.id as number
    const out = pr.arcs.find((a) => a.from === via && a.way === WAY.fig && a.dir === 1)?.id as number
    const free = makeProblem(nodes.length, edges, optionsOf(g), 0)
    expect(pathBetween(free, into, out).arcs).toEqual([out])
    const { arcs, cost } = pathBetween(pr, into, out)
    expect(arcs.length).toBeGreaterThan(1)
    expect(cost).toBeLessThan(Infinity)
    for (let i = 1; i < arcs.length; i++) expect([pr.arcs[arcs[i - 1]].way, pr.arcs[arcs[i]].to]).not.toEqual([WAY.birch, nodeAt(g, [1, 2])])
  })

  it('reads a rule through a way as one it can\'t use, and says so', () => {
    const osm = osmOf(gridWays(), [], [{ type: 'relation', id: 9, tags: { type: 'restriction', restriction: 'no_u_turn' }, members: [{ type: 'way', ref: 1, role: 'from' }, { type: 'way', ref: 5, role: 'via' }, { type: 'way', ref: 2, role: 'to' }] }])
    expect(bannedTurns(buildGraph(osm, origin), osm)).toEqual({ banned: [], unread: 1 })
  })

  /** A rule with more than one way to come from or go to, which a `no_entry` or `no_exit` often has. */
  const rule = (restriction: string, from: number[], to: number[]) => {
    const made = turnRule(1, restriction, from[0], [1, 0], to[0])
    return { ...made, members: [...made.members, ...from.slice(1).map((ref) => ({ type: 'way', ref, role: 'from' })), ...to.slice(1).map((ref) => ({ type: 'way', ref, role: 'to' }))] }
  }

  it('bans a turn from every way a rule comes from', () => {
    const osm = osmOf(gridWays(), [], [rule('no_entry', [WAY.ash, WAY.ivy], [WAY.fig])])
    const { banned, unread } = bannedTurns(buildGraph(osm, origin), osm)
    expect(banned.map((t) => t.from).sort((a, b) => a - b)).toEqual([WAY.ash, WAY.ivy])
    expect(banned.every((t) => t.to === WAY.fig)).toBe(true)
    expect(unread).toBe(0)
  })

  it('bans a turn onto every way a rule goes to', () => {
    const osm = osmOf(gridWays(), [], [rule('no_exit', [WAY.fig], [WAY.ash, WAY.ivy])])
    const { banned, unread } = bannedTurns(buildGraph(osm, origin), osm)
    expect(banned.map((t) => t.to).sort((a, b) => a - b)).toEqual([WAY.ash, WAY.ivy])
    expect(banned.every((t) => t.from === WAY.fig)).toBe(true)
    expect(unread).toBe(0)
  })

  it('takes "only" from every way a rule comes from', () => {
    const osm = osmOf(gridWays(), [], [rule('only_straight_on', [WAY.ash, WAY.ivy], [WAY.fig])])
    const { banned } = bannedTurns(buildGraph(osm, origin), osm)
    expect(new Set(banned.map((t) => t.from))).toEqual(new Set([WAY.ash, WAY.ivy]))
    expect(new Set(banned.filter((t) => t.from === WAY.ivy).map((t) => t.to))).toEqual(new Set([WAY.ash, WAY.ivy, WAY.quince]))
    expect(banned.some((t) => t.to === WAY.fig)).toBe(false)
  })

  it('counts a rule with nothing to come from or go to as one it can\'t use', () => {
    const made = turnRule(1, 'no_entry', WAY.ash, [1, 0], WAY.fig)
    const osm = osmOf(gridWays(), [], [{ ...made, members: made.members.filter((m) => m.role !== 'to') }])
    expect(bannedTurns(buildGraph(osm, origin), osm)).toEqual({ banned: [], unread: 1 })
  })

  it('turns "only straight on" into a ban on every other way out', () => {
    const osm = osmOf(gridWays(), [], [turnRule(1, 'only_straight_on', WAY.birch, [1, 1], WAY.birch)])
    const g = buildGraph(osm, origin)
    const { banned } = bannedTurns(g, osm)
    expect(banned.map((t) => t.to).sort()).toEqual([WAY.fig])
    expect(banned[0].from).toBe(WAY.birch)
  })

  it('takes a rule from a way back onto itself as a ban on turning back, not on going straight on', () => {
    const osm = osmOf(gridWays(), [], [turnRule(1, 'no_u_turn', WAY.birch, [1, 1], WAY.birch)])
    const g = buildGraph(osm, origin)
    const { banned } = bannedTurns(g, osm)
    const r = drive([['left', [0, 1], [1, 1], [2, 1]]])
    const samples = samplesOf(g, r.points, r.sideChanges)
    const cover = emptyCover(g)
    coverOf(g, samples, matchRoute(g, samples), cover)
    const { nodes, edges } = edgesOf(g, cover)
    const pr = makeProblem(nodes.length, edges, optionsOf(g, { banned }), 0)
    const via = nodeAt(g, [1, 1])
    const into = pr.arcs.find((a) => a.to === via && a.way === WAY.birch)?.id as number
    const straight = pr.arcs.find((a) => a.from === via && a.way === WAY.birch && a.dir === 1)?.id as number
    expect(pathBetween(pr, into, straight).arcs).toEqual([straight])
    expect(pathBetween(pr, into, pr.arcs[into].rev).arcs).not.toEqual([pr.arcs[into].rev])
  })
})

describe('allowed roads', () => {
  const route = drive([['left', [1, 0], [1, 1], [2, 1], [2, 0], [1, 0]]])

  it('gives a private way the old route never drove no arcs at all', () => {
    const { g, nodes, edges } = setup(gridWays(), route)
    const pr = makeProblem(nodes.length, edges, optionsOf(g), nodeAt(g, [1, 0]))
    const lane = edgeNamed(edges, 'Quince Lane')
    expect(pr.arcs.some((a) => a.edge === lane.id)).toBe(false)
  })

  it('keeps a private way the old route did drive', () => {
    const { g, nodes, edges } = setup(gridWays(), drive([['left', [1, 0], [2, 1], [2, 0], [1, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g), nodeAt(g, [1, 0]))
    expect(pr.arcs.some((a) => a.edge === edgeNamed(edges, 'Quince Lane').id)).toBe(true)
  })

  it('treats a gate on a public road the same way', () => {
    const osm = osmOf(gridWays(), [[1, 1]])
    const g = buildGraph(osm, origin)
    for (const p of g.pieces.filter((x) => x.name === 'Fig Lane' || x.name === 'Birch Street')) {
      const touches = p.pts.some((q) => Math.hypot(q[0] - g.nodes[nodeAt(g, [1, 1])][0], q[1] - g.nodes[nodeAt(g, [1, 1])][1]) < 1)
      expect(p.open).toBe(!touches)
    }
    expect(g.pieces.filter((p) => p.name === 'Ash Street').every((p) => p.open)).toBe(true)
  })

  it('leaves a cattle grid open, as it stops nobody', () => {
    const osm = osmOf([{ id: 1, cells: [[0, 0], [1, 0]], tags: residential('Ash Street') }])
    for (const e of osm.elements) if (e.type === 'node') e.tags = { barrier: 'cattle_grid' }
    expect(buildGraph(osm, origin).pieces[0].open).toBe(true)
  })

  it('reports a stretch that can\'t be reached, rather than failing', () => {
    const ways: WaySpec[] = [
      { id: 1, cells: [[0, 0], [1, 0]], tags: residential('Near Road') },
      { id: 2, cells: [[3, 0], [4, 0]], tags: residential('Far Road') },
    ]
    const { g, nodes, edges } = setup(ways, drive([['left', [0, 0], [1, 0], [0, 0]], ['transit', [0, 0], [3, 0]], ['left', [3, 0], [4, 0], [3, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g), nodeAt(g, [0, 0]))
    expect(pr.unreachable.map((u) => edges[u.edge].name)).toEqual(['Far Road'])
    expect(pr.tasks.every((t) => edges[t.edge].name === 'Near Road')).toBe(true)
  })
})

describe('the cost table and the drive', () => {
  it('gives a drive that joins up from the depot and back to it', () => {
    const { g, nodes, edges } = setup(gridWays(), drive([['left', [0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g), 0)
    const mx = buildMatrix(pr)
    const seq = Int32Array.from([mx.m, ...pr.tasks.map((t) => mx.idxOf[t.options[0]]), mx.m])
    const run = expand(pr, mx, seq)
    expect(pr.arcs[run[0].arc].from).toBe(0)
    expect(pr.arcs[run[run.length - 1].arc].to).toBe(0)
    for (let i = 1; i < run.length; i++) expect(pr.arcs[run[i].arc].from).toBe(pr.arcs[run[i - 1].arc].to)
    expect(run.filter((r) => r.serves)).toHaveLength(pr.tasks.length)
  })

  it('leaves each arc\'s own length out of the cost of going on to it', () => {
    const { g, nodes, edges } = setup(gridWays(), drive([['left', [0, 0], [1, 0], [2, 0]]]))
    const pr = makeProblem(nodes.length, edges, optionsOf(g), 0)
    const mx = buildMatrix(pr)
    const [a, b] = pr.arcs.filter((x) => x.way === WAY.ash && x.dir === 1 && pr.tasks.some((t) => t.options.includes(x.id)))
    expect(mx.c[mx.idxOf[a.id] * (mx.m + 1) + mx.idxOf[b.id]]).toBeCloseTo(0, 3)
  })
})
