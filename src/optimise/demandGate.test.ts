import { describe, expect, it, vi } from 'vitest'
import type { Route } from '../types'
import { coverOf, edgesOf, emptyCover } from './demand'
import { buildGraph, type Graph } from './graph'
import { matchRoute, samplesOf } from './match'
import { COVER_GATE_M } from './run'
import { drive, osmOf, place, residential } from './testNetwork'

/*
 * The demand keeps two short runs either side of a node as one stretch when together they come to the coverage gate's length, because the gate
 * joins the same two runs into one gap and blocks Accept from that length. Here the gate is moved, and the demand has to move with it: it once had
 * a length of its own that only happened to be the same.
 */

vi.mock('./run', async (importOriginal) => ({ ...(await importOriginal<typeof import('./run')>()), COVER_GATE_M: 30 }))

describe('the demand and a coverage gate of another length', () => {
  /** Long Street, cut in two by a side street half way along, thrown to port, and on both sides for 12 m either side of the side street: 24 m. */
  const g = buildGraph(
    osmOf([
      { id: 1, cells: [[0, 0], [1, 0]], tags: residential('Long Street') },
      { id: 2, cells: [[1, 0], [2, 0]], tags: residential('Long Street') },
      { id: 3, cells: [[1, 0], [1, 1]], tags: residential('Side Street') },
    ]),
    { lat0: place([0, 0]).lat, lng0: place([0, 0]).lng },
  )
  const route = drive([['left', [0, 0], [0.892, 0]], ['both', [0.892, 0], [1.108, 0]], ['left', [1.108, 0], [2, 0]]])
  /** Metres of the street's south side the demand throws at: the starboard going east, which only the 24 m round the side street had. */
  const southThrown = (graph: Graph, r: Pick<Route, 'points' | 'sideChanges'>) => {
    const samples = samplesOf(graph, r.points, r.sideChanges)
    const cover = emptyCover(graph)
    coverOf(graph, samples, matchRoute(graph, samples), cover)
    return edgesOf(graph, cover).edges.filter((e) => e.name === 'Long Street' && e.reqR).reduce((sum, e) => sum + e.len, 0)
  }

  it('drops two short runs that come to less than the gate, though they would be a stretch at 16 m', () => {
    expect(COVER_GATE_M).toBe(30)
    expect(southThrown(g, route)).toBe(0)
  })
})
