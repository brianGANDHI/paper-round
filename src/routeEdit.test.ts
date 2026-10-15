import { describe, expect, it } from 'vitest'
import { haversine, sideAt } from './geo'
import {
  appendPoint,
  normalizeRoute,
  removeLastPoint,
  removeSplit,
  sections,
  setSectionSide,
  splitAt,
  stopAt,
} from './routeEdit'
import type { Pt, Route } from './types'

// A straight road running north, ~111 m between points.
const pt = (i: number): Pt => ({ lat: 51 + i * 0.001, lng: 0 })
const road = (n: number): Route => ({
  points: Array.from({ length: n }, (_, i) => pt(i)),
  sideChanges: [{ idx: 0, side: 'both' }],
  stops: [],
})

describe('drawing', () => {
  it('builds a route point by point, starting on both sides', () => {
    let r: Route = { points: [], sideChanges: [], stops: [] }
    r = appendPoint(r, pt(0))
    expect(r.sideChanges).toEqual([])
    r = appendPoint(r, pt(1))
    expect(r.points).toHaveLength(2)
    expect(r.sideChanges).toEqual([{ idx: 0, side: 'both' }])
  })

  it('ignores an accidental double tap', () => {
    const r = appendPoint(road(2), { lat: pt(1).lat + 0.00001, lng: 0 })
    expect(r.points).toHaveLength(2)
  })

  it('undo drops the last point, its stretch and stops past the end', () => {
    const r = road(5)
    r.sideChanges = [{ idx: 0, side: 'both' }, { idx: 3, side: 'left' }]
    r.stops = [{ id: 's', pathIdx: 3, type: 'nothrow', ...pt(3) }]
    const u = removeLastPoint(r)
    expect(u.points).toHaveLength(4)
    expect(u.sideChanges).toEqual([{ idx: 0, side: 'both' }])
    expect(u.stops[0].pathIdx).toBe(2)
  })

  it('undo down to nothing leaves a valid empty route', () => {
    const u = removeLastPoint(removeLastPoint(road(2)))
    expect(u.points).toHaveLength(0)
    expect(u.sideChanges).toEqual([])
  })
})

describe('sections', () => {
  const r = road(11)
  r.sideChanges = [{ idx: 0, side: 'both' }, { idx: 4, side: 'left' }, { idx: 8, side: 'right' }]

  it('lists each stretch with its distances', () => {
    const s = sections(r)
    expect(s.map((x) => x.side)).toEqual(['both', 'left', 'right'])
    expect(s.map((x) => [x.idx, x.endIdx])).toEqual([[0, 4], [4, 8], [8, 10]])
    expect(s[0].startM).toBe(0)
    expect(s[1].startM).toBeCloseTo(s[0].endM)
    expect(s[2].endM).toBeGreaterThan(1000)
  })

  it('changes one stretch without touching the others', () => {
    const changes = setSectionSide(r, 1, 'right')
    expect(changes).toEqual([{ idx: 0, side: 'both' }, { idx: 4, side: 'right' }, { idx: 8, side: 'right' }])
  })

  it('merges a stretch into the previous one', () => {
    expect(removeSplit(r, 1)).toEqual([{ idx: 0, side: 'both' }, { idx: 8, side: 'right' }])
  })

  it('never merges the first stretch away', () => {
    expect(removeSplit(r, 0)).toHaveLength(3)
  })
})

describe('splitAt', () => {
  it('adds a point mid-segment and keeps both halves on the same side', () => {
    const r = road(4)
    r.sideChanges = [{ idx: 0, side: 'left' }]
    const s = splitAt(r, { lat: 51.0015, lng: 0.00001 })!
    expect(s.points).toHaveLength(5)
    expect(s.points[2].lat).toBeCloseTo(51.0015, 4)
    expect(sections(s).map((x) => x.side)).toEqual(['left', 'left'])
    expect(sections(s)[1].idx).toBe(2)
    expect(sideAt(s, 1)).toBe('left')
  })

  it('shifts later stretches and stops after the new point', () => {
    const r = road(6)
    r.sideChanges = [{ idx: 0, side: 'both' }, { idx: 3, side: 'right' }]
    r.stops = [
      { id: 'before', pathIdx: 0, type: 'nothrow', ...pt(0.5) },
      { id: 'sameFirst', pathIdx: 1, type: 'nothrow', lat: 51.0012, lng: 0 },
      { id: 'sameSecond', pathIdx: 1, type: 'nothrow', lat: 51.0018, lng: 0 },
      { id: 'after', pathIdx: 4, type: 'bundle', ...pt(4.5) },
    ]
    const s = splitAt(r, { lat: 51.0015, lng: 0 })!
    expect(s.sideChanges).toEqual([
      { idx: 0, side: 'both' },
      { idx: 2, side: 'both' },
      { idx: 4, side: 'right' },
    ])
    const idx = Object.fromEntries(s.stops.map((x) => [x.id, x.pathIdx]))
    expect(idx).toEqual({ before: 0, sameFirst: 1, sameSecond: 2, after: 5 })
  })

  it('reuses an existing point when the tap is on it', () => {
    const s = splitAt(road(4), { lat: pt(2).lat, lng: 0.00001 })!
    expect(s.points).toHaveLength(4)
    expect(sections(s).map((x) => x.idx)).toEqual([0, 2])
  })

  it('refuses a tap away from the route, at the ends, or on an existing split', () => {
    const r = road(4)
    expect(splitAt(r, { lat: 51.0015, lng: 0.01 })).toBeNull()
    expect(splitAt(r, pt(0))).toBeNull()
    expect(splitAt(r, pt(3))).toBeNull()
    const once = splitAt(r, pt(2))!
    expect(splitAt(once, pt(2))).toBeNull()
  })
})

describe('stopAt', () => {
  it('ties a stop to the nearest segment and reports how far off it is', () => {
    const hit = stopAt(road(4), { lat: 51.0025, lng: 0.0002 }, 'nothrow', { label: '12 Oak Road' })!
    expect(hit.stop.pathIdx).toBe(2)
    expect(hit.stop.label).toBe('12 Oak Road')
    expect(hit.stop.qty).toBeUndefined()
    expect(hit.offM).toBeGreaterThan(10)
    expect(hit.offM).toBeLessThan(20)
    expect(haversine(hit.stop, { lat: 51.0025, lng: 0.0002 })).toBe(0)
  })

  it('needs a route', () => {
    expect(stopAt({ points: [], sideChanges: [], stops: [] }, pt(0), 'bundle')).toBeNull()
  })
})

describe('normalizeRoute', () => {
  it('repairs missing and out-of-range data', () => {
    const r = normalizeRoute({
      points: road(3).points,
      sideChanges: [{ idx: 1, side: 'left' }, { idx: 9, side: 'right' }],
      stops: [{ id: 'x', pathIdx: 7, type: 'bundle', ...pt(1) }],
    })
    expect(r.sideChanges).toEqual([{ idx: 0, side: 'both' }, { idx: 1, side: 'left' }])
    expect(r.stops[0].pathIdx).toBe(1)
  })

  it('copes with nothing at all', () => {
    expect(normalizeRoute(null)).toEqual({ points: [], sideChanges: [], stops: [] })
  })
})
