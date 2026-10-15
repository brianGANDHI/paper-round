import { describe, expect, it } from 'vitest'
import { approachingStops, haversine, sideAt, simplify, snapToPath } from './geo'
import type { Pt, Stop } from './types'

// ~111 m per 0.001 deg latitude. A straight north-south road.
const road: Pt[] = Array.from({ length: 11 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 }))

const stop = (id: string, pathIdx: number, type: Stop['type']): Stop => ({
  id,
  pathIdx,
  type,
  lat: road[pathIdx].lat,
  lng: 0,
})

describe('simplify', () => {
  it('drops collinear points', () => {
    expect(simplify(road, 2)).toHaveLength(2)
  })
  it('keeps a real corner', () => {
    const l = [...road.slice(0, 5), { lat: 51.004, lng: 0.002 }, { lat: 51.004, lng: 0.004 }]
    expect(simplify(l, 2).length).toBeGreaterThan(2)
  })
})

describe('snapToPath', () => {
  it('finds the nearest segment', () => {
    const s = snapToPath({ lat: 51.0035, lng: 0.00005 }, road)!
    expect(s.idx).toBe(3)
    expect(s.dist).toBeLessThan(10)
  })
  it('prefers the segment ahead on an out-and-back road', () => {
    const loop = [...road, ...road.slice().reverse()]
    const s = snapToPath({ lat: 51.0055, lng: 0 }, loop, 4)!
    expect(s.idx).toBe(5)
  })
})

describe('sideAt', () => {
  const r = {
    sideChanges: [
      { idx: 0, side: 'both' as const },
      { idx: 4, side: 'left' as const },
      { idx: 8, side: 'right' as const },
    ],
  }
  it('uses the latest change at or before idx', () => {
    expect(sideAt(r, 2)).toBe('both')
    expect(sideAt(r, 4)).toBe('left')
    expect(sideAt(r, 9)).toBe('right')
  })
  it('defaults to both', () => {
    expect(sideAt({ sideChanges: [] }, 3)).toBe('both')
  })
})

describe('approachingStops', () => {
  const stops = [stop('a', 3, 'bundle'), stop('b', 6, 'nothrow')]
  it('alerts within radius only', () => {
    expect(approachingStops(road[2], 2, stops, new Set())).toHaveLength(1)
    expect(approachingStops(road[0], 0, stops, new Set())).toHaveLength(0)
  })
  it('ignores handled stops', () => {
    expect(approachingStops(road[3], 3, stops, new Set(['a']))).toHaveLength(0)
  })
  it('ignores stops already passed', () => {
    expect(approachingStops({ lat: 51.0035, lng: 0 }, 8, stops, new Set())).toHaveLength(0)
  })
  it('haversine sanity', () => {
    expect(haversine(road[0], road[1])).toBeGreaterThan(105)
    expect(haversine(road[0], road[1])).toBeLessThan(117)
  })
})
