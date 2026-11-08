import { describe, expect, it } from 'vitest'
import { pathLength } from '../geo'
import { bundlePasses, byFirstPass, driverList, otherVisits, walkList } from './list'
import { drive, place, stopAt, type Cell } from './testNetwork'

const ids = (cells: [string, Cell][]) => cells.map(([id, cell]) => stopAt(id, 'bundle', cell))

/** Along a street to its end and back: every stop on it is passed on the way out and on the way back. */
const outAndBack = drive([['left', [0, 0], [1, 0], [2, 0], [3, 0], [2, 0], [1, 0], [0, 0]]]).points

describe('driverList', () => {
  const points = drive([['left', [0, 0], [1, 0], [2, 0], [3, 0]]]).points
  const stops = ids([['far', [2.5, 0]], ['near', [0.5, 0]], ['mid', [1.5, 0]]])

  it('reads the order the route first reaches each bundle when the driver has set none', () => {
    expect(driverList({ points, stops }, undefined).map((b) => b.id)).toEqual(['near', 'mid', 'far'])
  })

  it('goes by first pass and not by stored place on the route', () => {
    const misplaced = stops.map((s, i) => ({ ...s, pathIdx: 2 - i }))
    expect(driverList({ points, stops: misplaced }, undefined).map((b) => b.id)).toEqual(['near', 'mid', 'far'])
  })

  it('takes the driver\'s own order, with bundles not in it after, in route order', () => {
    expect(driverList({ points, stops }, ['far']).map((b) => b.id)).toEqual(['far', 'near', 'mid'])
  })

  it('leaves out stale ids and every other kind of stop', () => {
    const more = [...stops, stopAt('house', 'nothrow', [1, 0]), stopAt('ask', 'request', [1, 0])]
    expect(driverList({ points, stops: more }, ['gone', 'mid']).map((b) => b.id)).toEqual(['mid', 'near', 'far'])
  })

  it('gives the name the app gives', () => {
    expect(driverList({ points, stops }, ['far'])[0].name).toBe('far')
  })
})

describe('walkList', () => {
  const stops = ids([['a', [1.5, 0]], ['b', [2.5, 0]]])
  const passes = bundlePasses({ points: outAndBack, stops })

  it('finds every pass of a stop on a street driven twice', () => {
    expect(passes.filter((o) => o.stop.id === 'a')).toHaveLength(2)
  })

  it('takes each bundle\'s first pass when the list runs with the route', () => {
    const { picks, stranded } = walkList(passes, ['a', 'b'])
    expect(stranded).toEqual([])
    expect((picks.get('a') as (typeof passes)[number]).key).toBe('a')
    expect((picks.get('b') as (typeof passes)[number]).key).toBe('b')
  })

  it('takes a later pass for a bundle listed after one further on, which is all that keeps the list working', () => {
    const { picks, stranded } = walkList(passes, ['b', 'a'])
    expect(stranded).toEqual([])
    expect((picks.get('b') as (typeof passes)[number]).key).toBe('b')
    expect((picks.get('a') as (typeof passes)[number]).key).toBe('a#2')
  })

  it('strands a bundle with no pass after the one before it', () => {
    const oneWay = bundlePasses({ points: drive([['left', [0, 0], [1, 0], [2, 0], [3, 0]]]).points, stops })
    expect(walkList(oneWay, ['b', 'a']).stranded).toEqual(['a'])
  })

  it('carries on after a stranded bundle from where it had got to', () => {
    const three = ids([['a', [0.5, 0]], ['b', [1.5, 0]], ['c', [2.5, 0]]])
    const oneWay = bundlePasses({ points: drive([['left', [0, 0], [1, 0], [2, 0], [3, 0]]]).points, stops: three })
    const { stranded, picks } = walkList(oneWay, ['b', 'a', 'c'])
    expect(stranded).toEqual(['a'])
    expect(picks.has('c')).toBe(true)
  })

  it('lets two bundles at one spot share it', () => {
    const same = [stopAt('a', 'bundle', [1.5, 0]), stopAt('b', 'bundle', [1.5, 0])]
    const oneWay = bundlePasses({ points: drive([['left', [0, 0], [1, 0], [2, 0], [3, 0]]]).points, stops: same })
    expect(walkList(oneWay, ['a', 'b']).stranded).toEqual([])
    expect(walkList(oneWay, ['b', 'a']).stranded).toEqual([])
  })
})

describe('otherVisits', () => {
  it('keeps requests and blocks, as bundles have the list and no-throw houses need no stop', () => {
    const stops = [stopAt('b', 'bundle', [0, 0]), stopAt('h', 'nothrow', [0, 0]), stopAt('r', 'request', [0, 0]), stopAt('k', 'block', [0, 0])]
    expect(otherVisits(stops).map((s) => s.id)).toEqual(['r', 'k'])
  })
})

describe('place', () => {
  it('keeps the test streets where they say', () => {
    expect(place([0, 0])).toEqual({ lat: -30, lng: 150 })
  })
})

describe('a drive that begins part way along', () => {
  const stops = ids([['near', [0.5, 0]], ['mid', [1.5, 0]], ['far', [2.5, 0]]])
  const passes = bundlePasses({ points: outAndBack, stops })
  const named = (list: string[]) => list.map((id) => ({ id, name: id }))
  /** From part of the way back, past the far bundle's second pass and short of the middle one's, coming round to the route's first point. */
  const total = pathLength(outAndBack)
  const from = 0.68 * total
  const around = (at: number) => (at >= from ? at - from : at + total - from)

  it('lists the bundles by the first pass that drive makes', () => {
    const first = byFirstPass(named(['near', 'mid', 'far']), passes, (o) => around(o.at))
    expect(first.map((b) => b.id)).toEqual(['mid', 'near', 'far'])
  })

  it('reads the same as the route\'s own order from the route\'s first point', () => {
    expect(byFirstPass(named(['far', 'near', 'mid']), passes, (o) => o.at).map((b) => b.id)).toEqual(['near', 'mid', 'far'])
  })

  it('walks a list by where that drive puts each pass', () => {
    const inOrder = [...passes].sort((a, b) => around(a.at) - around(b.at))
    const at = (o: { at: number }) => around(o.at)
    const walk = walkList(inOrder, ['mid', 'near', 'far'], at)
    expect(walk.stranded).toEqual([])
    expect(at(walk.picks.get('near') as { at: number })).toBeGreaterThan(at(walk.picks.get('mid') as { at: number }))
    expect(walkList(passes, ['mid', 'near', 'far']).stranded).toEqual(['far'])
  })
})
