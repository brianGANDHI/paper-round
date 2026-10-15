import { describe, expect, it } from 'vitest'
import { haversine, occurrences, sideAt } from './geo'
import {
  appendPoint,
  defaultRepeatSide,
  normalizeRoute,
  removeLastPoint,
  removeSplit,
  repeatSection,
  sections,
  setSectionSide,
  splitAt,
  stopAt,
  stopSides,
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

describe('which side a repeated pass starts on', () => {
  it('keeps the label coming back, which covers the other side of the street', () => {
    expect(defaultRepeatSide('left', 'back')).toBe('left')
    expect(defaultRepeatSide('right', 'back')).toBe('right')
  })

  it('flips the label going the same way again', () => {
    expect(defaultRepeatSide('left', 'again')).toBe('right')
    expect(defaultRepeatSide('right', 'again')).toBe('left')
  })

  it('stays on both sides for both', () => {
    expect(defaultRepeatSide('both', 'back')).toBe('both')
    expect(defaultRepeatSide('both', 'again')).toBe('both')
  })
})

describe('driving a section again', () => {
  const oneWay = (): Route => ({ ...road(5), sideChanges: [{ idx: 0, side: 'left' }] })

  it('adds the way back as a new section that carries on from where the route ends', () => {
    const r = repeatSection(oneWay(), 0, 'back')!
    expect(r.points).toHaveLength(9)
    expect(r.points[8].lat).toBeCloseTo(pt(0).lat, 6)
    expect(r.points[4]).toEqual(pt(4))
    expect(r.points[5].lat).toBeCloseTo(pt(3).lat, 6)
    expect(sections(r).map((x) => [x.idx, x.side])).toEqual([
      [0, 'left'],
      [4, 'left'],
    ])
  })

  it('goes back along the road the opposite way round', () => {
    const r = repeatSection(oneWay(), 0, 'back')!
    const [first, second] = sections(r)
    expect(first.endM).toBeCloseTo(second.startM)
    expect(second.endM - second.startM).toBeCloseTo(first.endM - first.startM, 0)
    expect(r.points.slice(4).map((q) => q.lat)).toEqual([...r.points.slice(0, 5).map((q) => q.lat)].reverse())
  })

  it('adds the same way again, with the other label, after a link from the end back to the start', () => {
    const r = repeatSection(oneWay(), 0, 'again')!
    expect(r.points).toHaveLength(10)
    expect(sections(r).map((x) => [x.idx, x.side])).toEqual([
      [0, 'left'],
      [4, 'both'],
      [5, 'right'],
    ])
    // The link is the first segment added: from where the route ended back to the start of the section.
    expect(r.points[4]).toEqual(pt(4))
    expect(r.points[5]).toEqual(pt(0))
    expect(r.points[9]).toEqual(pt(4))
  })

  it('can repeat any section, not only the last, linking back to it', () => {
    const base: Route = { ...road(7), sideChanges: [{ idx: 0, side: 'both' }, { idx: 3, side: 'right' }] }
    const r = repeatSection(base, 0, 'back')!
    expect(sections(r).map((x) => x.side)).toEqual(['both', 'right', 'both', 'both'])
    expect(r.points.length).toBeGreaterThan(base.points.length)
  })

  it('leaves the original points, stops and sides as they were', () => {
    const base = oneWay()
    base.stops = [{ id: 'a', type: 'nothrow', pathIdx: 2, ...pt(2.5) }]
    const r = repeatSection(base, 0, 'back')!
    expect(r.points.slice(0, 5)).toEqual(base.points)
    expect(r.stops).toEqual(base.stops)
    expect(r.sideChanges[0]).toEqual({ idx: 0, side: 'left' })
  })

  it('copies points instead of sharing them with the original', () => {
    const r = repeatSection(oneWay(), 0, 'again')!
    expect(r.points[5]).not.toBe(r.points[0])
  })

  it('refuses a section that does not exist, or a route with nothing to repeat', () => {
    expect(repeatSection(oneWay(), 3, 'back')).toBeNull()
    expect(repeatSection(road(1), 0, 'back')).toBeNull()
  })
})

describe('splitting the pass you mean', () => {
  const twice = () => repeatSection({ ...road(11), sideChanges: [{ idx: 0, side: 'left' }] }, 0, 'back')!
  const tap = { lat: 51.0055, lng: 0.00001 }

  it('splits the first pass when the tap is not limited, since both lie under it', () => {
    const s = splitAt(twice(), tap)!
    expect(sections(s).map((x) => x.idx)).toEqual([0, 6, 11])
  })

  it('splits the return pass when told to look only there', () => {
    const r = twice()
    const second = sections(r)[1]
    const s = splitAt(r, tap, { from: second.idx, to: second.endIdx })!
    const idx = sections(s).map((x) => x.idx)
    expect(idx[0]).toBe(0)
    expect(idx[1]).toBe(10)
    expect(idx[2]).toBeGreaterThan(10)
  })
})

describe('the sides a stop is passed on', () => {
  it('lists each side the stop is thrown to, without repeats', () => {
    const base: Route = { ...road(11), sideChanges: [{ idx: 0, side: 'left' }] }
    base.stops = [{ id: 's', type: 'nothrow', pathIdx: 5, lat: 51.0055, lng: 0.0002 }]
    const out = repeatSection(base, 0, 'back')! // out along the road, then back along it
    const twice: Route = { ...out, sideChanges: setSectionSide(out, 1, 'right') }
    expect(occurrences(twice)).toHaveLength(2)
    expect(stopSides(twice, occurrences(twice), 's')).toEqual(['left', 'right'])
    expect(stopSides(out, occurrences(out), 's')).toEqual(['left'])
  })

  it('gives one side for a stop passed once, and nothing for an unknown stop', () => {
    const base: Route = { ...road(11), sideChanges: [{ idx: 0, side: 'right' }] }
    base.stops = [{ id: 's', type: 'bundle', pathIdx: 5, lat: 51.0055, lng: 0.0002 }]
    expect(stopSides(base, occurrences(base), 's')).toEqual(['right'])
    expect(stopSides(base, occurrences(base), 'nope')).toEqual([])
  })
})
