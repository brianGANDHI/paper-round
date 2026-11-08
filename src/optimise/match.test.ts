import { describe, expect, it } from 'vitest'
import { sideAt } from '../geo'
import type { SideChange } from '../types'
import { buildGraph, dist, toXY } from './graph'
import { matchRoute, samplesOf } from './match'
import { drive, gridWays, osmOf, place } from './testNetwork'

const origin = { lat0: place([0, 0]).lat, lng0: place([0, 0]).lng }
const graph = () => buildGraph(osmOf(gridWays()), origin)

describe('samplesOf', () => {
  const route = drive([['left', [0, 0], [1, 0]], ['both', [1, 0], [1, 1]], ['transit', [1, 1], [0, 1]]])

  it('reads sides as sideAt does, from every row on, with the last row of an index winning', () => {
    const rows: SideChange[] = [{ idx: 1, side: 'right' }, { idx: 0, side: 'left' }, { idx: 1, side: 'transit' }]
    for (const s of samplesOf(origin, route.points, rows).slice(0, -1)) expect(s.side).toBe(sideAt({ sideChanges: rows }, s.seg))
  })

  it('is both before the first row, as sideAt is', () => {
    const rows: SideChange[] = [{ idx: 1, side: 'left' }]
    expect(samplesOf(origin, route.points, rows)[0].side).toBe('both')
  })

  it('walks the route in steps of no more than 8 m and ends on its last point', () => {
    const samples = samplesOf(origin, route.points, route.sideChanges)
    for (let i = 1; i < samples.length; i++) expect(dist(samples[i - 1].at, samples[i].at)).toBeLessThanOrEqual(8.01)
    expect(samples[samples.length - 1].at).toEqual(toXY(origin, route.points[route.points.length - 1]))
  })

  it('skips a segment with no length, so the side it had stays out of the count', () => {
    const p = place([0, 0])
    const q = place([1, 0])
    const samples = samplesOf(origin, [p, p, q], [{ idx: 0, side: 'left' }, { idx: 1, side: 'right' }])
    expect(samples.every((s) => s.side === 'right')).toBe(true)
  })
})

describe('matchRoute', () => {
  it('puts a clean route on the streets it drives, the way it drives them', () => {
    const g = graph()
    const route = drive([['left', [0, 0], [1, 0], [2, 0]], ['left', [2, 0], [2, 1]], ['left', [2, 1], [1, 1], [0, 1]]])
    const samples = samplesOf(g, route.points, route.sideChanges)
    const matched = matchRoute(g, samples)
    expect(matched.every((m) => m.piece >= 0)).toBe(true)
    const names = new Set(matched.map((m) => g.pieces[m.piece].name))
    expect(names).toEqual(new Set(['Ash Street', 'Gum Lane', 'Birch Street']))
    const mid = matched[Math.floor(matched.length / 6)]
    expect(g.pieces[mid.piece].name).toBe('Ash Street')
    expect(mid.dir).toBe(1)
    const end = matched[matched.length - 3]
    expect(g.pieces[end.piece].name).toBe('Birch Street')
    expect(end.dir).toBe(-1)
  })

  it('finds the road under a line drawn a few metres off it', () => {
    const g = graph()
    const nudge = (p: { lat: number; lng: number }) => ({ lat: p.lat + 0.00004, lng: p.lng })
    const points = [place([0, 0]), place([1, 0]), place([2, 0])].map(nudge)
    const matched = matchRoute(g, samplesOf(g, points, [{ idx: 0, side: 'left' }]))
    expect(matched.every((m) => m.piece >= 0 && g.pieces[m.piece].name === 'Ash Street')).toBe(true)
  })

  it('leaves a stretch with no road near it on no road', () => {
    const g = graph()
    const points = [place([0, -3]), place([0.5, -3]), place([1, -3])]
    expect(matchRoute(g, samplesOf(g, points, [{ idx: 0, side: 'left' }])).every((m) => m.piece < 0)).toBe(true)
  })

  it('tells the two passes of a street driven out and back apart by their way', () => {
    const g = graph()
    const route = drive([['left', [0, 0], [1, 0], [0, 0]]])
    const samples = samplesOf(g, route.points, route.sideChanges)
    const matched = matchRoute(g, samples)
    expect(matched[5].dir).toBe(1)
    expect(matched[matched.length - 5].dir).toBe(-1)
  })
})
