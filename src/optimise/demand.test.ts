import { describe, expect, it } from 'vitest'
import type { Pt, Route } from '../types'
import { CELL_M, coverOf, dropIslands, edgesOf, emptyCover, islandSide, tidy, type Edge } from './demand'
import { buildGraph, type Graph } from './graph'
import { matchRoute, samplesOf } from './match'
import { drive, gridWays, osmOf, place, quarteredRoundabout, residential } from './testNetwork'

const origin = { lat0: place([0, 0]).lat, lng0: place([0, 0]).lng }

function demandOf(g: Graph, route: Pick<Route, 'points' | 'sideChanges'>) {
  const samples = samplesOf(g, route.points, route.sideChanges)
  const cover = emptyCover(g)
  const driven = coverOf(g, samples, matchRoute(g, samples), cover)
  return { cover, driven, ...edgesOf(g, cover) }
}

const named = (edges: Edge[], name: string) => edges.filter((e) => e.name === name)

/** Ash Street is drawn west to east, so its left as drawn is its north side. */
describe('absolute sides', () => {
  const g = buildGraph(osmOf(gridWays()), origin)
  const thrown = (route: Pick<Route, 'points' | 'sideChanges'>) => named(demandOf(g, route).edges, 'Ash Street').filter((e) => e.reqL || e.reqR)

  it('takes port going the way the street is drawn as its left', () => {
    const [e] = thrown(drive([['left', [0, 0], [1, 0]]]))
    expect(e.reqL).toBe(true)
    expect(e.reqR).toBe(false)
  })

  it('takes port going against it as its right', () => {
    const [e] = thrown(drive([['left', [1, 0], [0, 0]]]))
    expect(e.reqL).toBe(false)
    expect(e.reqR).toBe(true)
  })

  it('takes starboard as the other side each way', () => {
    expect(thrown(drive([['right', [0, 0], [1, 0]]]))[0].reqR).toBe(true)
    expect(thrown(drive([['right', [1, 0], [0, 0]]]))[0].reqL).toBe(true)
  })

  it('takes both as both', () => {
    const [e] = thrown(drive([['both', [0, 0], [1, 0]]]))
    expect(e.reqL && e.reqR).toBe(true)
  })

  it('adds a street driven both ways up to both sides, each thrown once', () => {
    const route = drive([['left', [0, 0], [1, 0], [2, 0]], ['transit', [2, 0], [2, 1], [3, 1], [3, 0]], ['left', [3, 0], [2, 0], [1, 0], [0, 0]]])
    const { edges, cover } = demandOf(g, route)
    const street = named(edges, 'Ash Street').filter((e) => g.pieces[e.piece].a === g.pieces[named(edges, 'Ash Street')[0].piece].a)
    expect(street[0].reqL && street[0].reqR).toBe(true)
    expect(street[0].beforeL).toBe(1)
    expect(street[0].beforeR).toBe(1)
    expect(Math.max(...cover[street[0].piece].drive[0])).toBe(1)
    expect(Math.max(...cover[street[0].piece].drive[1])).toBe(1)
  })

  it('needs nothing of a street driven in transit, but knows it was driven', () => {
    const [e] = named(demandOf(g, drive([['transit', [0, 0], [1, 0]]])).edges, 'Ash Street').filter((x) => x.driven > 0)
    expect(e.reqL || e.reqR).toBe(false)
  })

  it('leaves a street the route never touched undriven and not needed', () => {
    const [e] = named(demandOf(g, drive([['left', [0, 0], [1, 0]]])).edges, 'Hazel Lane')
    expect(e.driven).toBe(0)
    expect(e.reqL || e.reqR).toBe(false)
  })
})

describe('cutting a street where its need changes', () => {
  const g = buildGraph(osmOf([{ id: 1, cells: [[0, 0], [4, 0]], tags: residential('Long Street') }]), origin)

  it('makes an edge for each stretch with its own need, joined at a new node', () => {
    const route = drive([['left', [0, 0], [2, 0]], ['both', [2, 0], [4, 0]]])
    const { edges, nodes } = demandOf(g, route)
    expect(edges).toHaveLength(2)
    expect(edges[0].reqR).toBe(false)
    expect(edges[1].reqR).toBe(true)
    expect(edges[0].v).toBe(edges[1].u)
    expect(nodes.length).toBe(g.nodes.length + 1)
    expect(edges[0].pts[edges[0].pts.length - 1]).toEqual(edges[1].pts[0])
  })

  it('keeps the whole length of the piece across its edges', () => {
    const route = drive([['left', [0, 0], [2, 0]], ['both', [2, 0], [4, 0]]])
    const total = demandOf(g, route).edges.reduce((a, e) => a + e.len, 0)
    expect(total).toBeCloseTo(g.pieces[0].len, 3)
  })
})

describe('closed roads', () => {
  const g = buildGraph(osmOf(gridWays()), origin)
  const lane = g.pieces.find((p) => p.name === 'Quince Lane') as Graph['pieces'][number]
  const edgesWith = (cells: number) => {
    const cover = emptyCover(g)
    for (let i = 0; i < cells; i++) cover[lane.id].drive[0][i] = 1
    return edgesOf(g, cover).edges.filter((e) => e.name === 'Quince Lane')
  }
  const all = emptyCover(g)[lane.id].drive[0].length

  it('does not take the match nibbling at the mouth of a closed road as driving it', () => {
    const edges = edgesWith(2)
    expect(edges).toHaveLength(1)
    expect(edges[0].driven).toBe(0)
  })

  it('only counts a closed road as driven as far as it was', () => {
    const edges = edgesWith(Math.floor(all / 2))
    expect(edges).toHaveLength(2)
    expect(edges[0].driven).toBe(1)
    expect(edges[1].driven).toBe(0)
  })

  it('keeps a closed road driven all the way in one piece', () => {
    const edges = edgesWith(all)
    expect(edges).toHaveLength(1)
    expect(edges[0].driven).toBe(1)
  })

  it('makes no such cut in a public road, which any leg may use', () => {
    const ash = g.pieces.find((p) => p.name === 'Ash Street') as Graph['pieces'][number]
    const cover = emptyCover(g)
    cover[ash.id].drive[0][0] = 1
    expect(edgesOf(g, cover).edges.filter((e) => e.piece === ash.id)).toHaveLength(1)
  })
})

describe('tidy', () => {
  const cells = (text: string) => Uint16Array.from([...text].map(Number))
  const shown = (on: boolean[]) => on.map((x) => (x ? '1' : '0')).join('')

  it('fills a slip between two runs', () => {
    expect(shown(tidy(cells('1111100111111')))).toBe('1111111111111')
  })

  it('takes a run that all but reaches an end to it', () => {
    expect(shown(tidy(cells('0011111111111')))).toBe('1111111111111')
  })

  it('drops a short run at an end, which is the match nibbling at a junction', () => {
    expect(shown(tidy(cells('1100000000000')))).toBe('0000000000000')
  })

  it('leaves a wide gap and a run in the middle alone', () => {
    expect(shown(tidy(cells('0000011111000000000')))).toBe('0000011111000000000')
    expect(shown(tidy(cells('1111100000000011111')))).toBe('1111100000000011111')
  })

  it('leaves an untouched piece untouched', () => {
    expect(shown(tidy(cells('00000000')))).toBe('00000000')
  })

  it('keeps a short run at an end it is told to keep, and only there', () => {
    expect(shown(tidy(cells('1100000000000'), true, false))).toBe('1100000000000')
    expect(shown(tidy(cells('0000000000011'), true, false))).toBe('0000000000000')
    expect(shown(tidy(cells('0000000000011'), false, true))).toBe('0000000000011')
  })
})

describe('a stretch thrown across a side street', () => {
  /** A street cut in two by a side street half way along: thrown at to port, and on both sides for a while either side of the junction. */
  const street = (second: [number, number][]) => [
    { id: 1, cells: [[0, 0], [1, 0]] as [number, number][], tags: residential('Long Street') },
    { id: 2, cells: second, tags: residential('Long Street') },
    { id: 3, cells: [[1, 0], [1, 1]] as [number, number][], tags: residential('Side Street') },
  ]
  /** How far along the first and second parts, in cells of the map, the street is thrown on both sides. */
  const thrown = (before: number, after: number) => drive([['left', [0, 0], [1 - before, 0]], ['both', [1 - before, 0], [1 + after, 0]], ['left', [1 + after, 0], [2, 0]]])
  const sideMetres = (g: Graph, edges: Edge[], pick: (e: Edge, drawnOn: boolean) => boolean) => {
    const east = (e: Edge) => g.nodes[g.pieces[e.piece].a][0] <= g.nodes[g.pieces[e.piece].b][0]
    return named(edges, 'Long Street').filter((e) => pick(e, east(e))).reduce((a, e) => a + e.len, 0)
  }
  const south = (g: Graph, edges: Edge[]) => sideMetres(g, edges, (e, drawnOn) => (drawnOn ? e.reqR : e.reqL))

  it('keeps a short run on each side of the junction when together they make a real stretch', () => {
    const g = buildGraph(osmOf(street([[1, 0], [2, 0]])), origin)
    expect(south(g, demandOf(g, thrown(0.108, 0.108)).edges)).toBeGreaterThan(20)
  })

  it('finds the same side of the road on a street drawn back towards the junction', () => {
    const g = buildGraph(osmOf(street([[2, 0], [1, 0]])), origin)
    expect(south(g, demandOf(g, thrown(0.108, 0.108)).edges)).toBeGreaterThan(20)
  })

  it('still takes a nibble beside a long run as a nibble', () => {
    const g = buildGraph(osmOf(street([[1, 0], [2, 0]])), origin)
    const metres = south(g, demandOf(g, thrown(0.108, 0.5)).edges)
    expect(metres).toBeGreaterThan(50)
    expect(metres).toBeLessThan(60)
  })

  it('does not join two nibbles too short to be a stretch', () => {
    const g = buildGraph(osmOf(street([[1, 0], [2, 0]])), origin)
    expect(south(g, demandOf(g, thrown(0.04, 0.04)).edges)).toBe(0)
  })

  it('does not join a run to a side street', () => {
    const g = buildGraph(osmOf(street([[1, 0], [2, 0]])), origin)
    const round = drive([['left', [0, 0], [0.892, 0]], ['both', [0.892, 0], [1, 0], [1, 0.108]], ['left', [1, 0.108], [1, 1]]])
    expect(sideMetres(g, demandOf(g, round).edges, (e) => e.reqL && e.reqR)).toBe(0)
  })
})

describe('roundabouts', () => {
  /** A ring the way cars go round it here, clockwise from above with the island on the driver's right, and a road in and a road out. */
  const ring = [[1, 0], [1.2, 0.2], [1, 0.4], [0.8, 0.2], [1, 0]] as [number, number][]
  const g = buildGraph(osmOf([
    { id: 1, cells: [[0, 0.2], [0.8, 0.2]], tags: residential('In Road') },
    { id: 2, cells: ring, tags: { highway: 'residential', junction: 'roundabout' } },
    { id: 3, cells: [[1.2, 0.2], [2, 0.2]], tags: residential('Out Road') },
  ]), origin)
  const ringOf = (e: Edge) => g.pieces[e.piece].roundabout

  it('is one-way without saying so', () => {
    expect(g.pieces.filter((p) => p.roundabout).every((p) => p.oneway === 1)).toBe(true)
  })

  it('has its island on the right of a ring drawn the way it runs', () => {
    expect(islandSide({ roundabout: true, oneway: 1 }, 1)).toBe(true)
    expect(islandSide({ roundabout: true, oneway: 1 }, 0)).toBe(false)
    expect(islandSide({ roundabout: true, oneway: -1 }, 0)).toBe(true)
    expect(islandSide({ roundabout: false, oneway: 1 }, 1)).toBe(false)
  })

  it('drops the island side and keeps the kerb side', () => {
    const route = drive([['both', [0, 0.2], [0.8, 0.2], [1, 0], [1.2, 0.2], [2, 0.2]]])
    const { edges } = demandOf(g, route)
    const before = edges.filter(ringOf).filter((e) => e.reqL || e.reqR)
    expect(before.some((e) => e.reqR)).toBe(true)
    expect(dropIslands(g, edges)).toBeGreaterThan(0)
    const after = edges.filter(ringOf).filter((e) => e.reqL || e.reqR)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((e) => e.reqL && !e.reqR)).toBe(true)
  })
})

describe('a stretch thrown across a junction of a roundabout drawn as a way for each quarter', () => {
  const { ways, today } = quarteredRoundabout()
  const g = buildGraph(osmOf(ways), origin)

  it('keeps the short run either side of the junction, kerb side, as one stretch, whatever the ways are called', () => {
    const ring = demandOf(g, today).edges.filter((e) => g.pieces[e.piece].roundabout && (e.reqL || e.reqR))
    // One run at the end of the quarter before the junction and one at the start of the quarter after it, each on its own way with no name.
    expect(new Set(ring.map((e) => g.pieces[e.piece].way)).size).toBe(2)
    expect(ring.every((e) => g.pieces[e.piece].name === null && e.reqL && !e.reqR)).toBe(true)
    expect(ring.reduce((sum, e) => sum + e.len, 0)).toBeGreaterThan(16)
  })

  it('still drops a run too short to be a stretch with the one across the junction', () => {
    const { ways: short, today: nibble } = quarteredRoundabout(1)
    const h = buildGraph(osmOf(short), origin)
    expect(demandOf(h, nibble).edges.filter((e) => h.pieces[e.piece].roundabout && (e.reqL || e.reqR))).toEqual([])
  })
})

describe('coverOf', () => {
  it('counts a road once for a pass, however the samples fall in its cells', () => {
    const g = buildGraph(osmOf(gridWays()), origin)
    const { cover, driven } = demandOf(g, drive([['left', [0, 0], [1, 0]]]))
    const piece = g.pieces.find((p) => p.name === 'Ash Street' && p.a === 0) as Graph['pieces'][number]
    expect(Math.max(...cover[piece.id].count[0])).toBe(1)
    expect(driven).toBeCloseTo(piece.len, 0)
    expect(CELL_M).toBe(4)
  })

  it('does not add a road to a sample on no road', () => {
    const g = buildGraph(osmOf(gridWays()), origin)
    const far: Pt[] = [place([0, -3]), place([1, -3])]
    const samples = samplesOf(g, far, [{ idx: 0, side: 'left' }])
    expect(coverOf(g, samples, matchRoute(g, samples), emptyCover(g))).toBe(0)
  })
})
