import { describe, expect, it } from 'vitest'
import { haversine, occurrences, sideAt } from './geo'
import {
  appendPoint,
  appendPoints,
  defaultRepeatSide,
  deletePoint,
  insertPoint,
  isDuplicateTap,
  movePoint,
  nearestOnRoute,
  normalizeRoute,
  otherSide,
  paintRange,
  paintStretch,
  removeLastPoint,
  removeSplit,
  repeatSection,
  sections,
  setSectionSide,
  splitAt,
  stopAt,
  stopSides,
} from './routeEdit'
import { isSide, SIDES, type Pt, type Route, type Stop } from './types'

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

  it('keeps a side picked by hand for a stop, and drops anything else in its place', () => {
    const stop = (id: string, side: unknown) => ({ id, pathIdx: 0, type: 'nothrow' as const, ...pt(1), side } as Stop)
    const r = normalizeRoute({
      points: road(3).points,
      stops: [stop('a', 'left'), stop('b', 'right'), stop('c', 'both'), stop('d', 'LEFT'), stop('e', 3), stop('f', undefined)],
    })
    expect(r.stops.map((s) => s.side)).toEqual(['left', 'right', undefined, undefined, undefined, undefined])
    // Not even an empty entry is left behind.
    expect(Object.keys(r.stops[2])).not.toContain('side')
    expect(Object.keys(r.stops[5])).not.toContain('side')
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

describe('drawing with a side', () => {
  const empty = (): Route => ({ points: [], sideChanges: [], stops: [] })
  const draw = (sides: (Parameters<typeof appendPoint>[2])[]) =>
    sides.reduce((r, side, i) => appendPoint(r, pt(i), side), empty())

  it('gives the first stretch the chosen side', () => {
    const one = appendPoint(empty(), pt(0), 'left')
    expect(one.sideChanges).toEqual([])
    expect(appendPoint(one, pt(1), 'left').sideChanges).toEqual([{ idx: 0, side: 'left' }])
  })

  it('stays in the same section while the side stays the same', () => {
    expect(draw(['right', 'right', 'right', 'right']).sideChanges).toEqual([{ idx: 0, side: 'right' }])
  })

  it('starts a new section as soon as the side changes', () => {
    const r = draw(['left', 'left', 'left', 'left', 'right', 'right', 'left'])
    expect(r.sideChanges).toEqual([
      { idx: 0, side: 'left' },
      { idx: 3, side: 'right' },
      { idx: 5, side: 'left' },
    ])
    expect(sections(r).map((x) => [x.side, x.idx, x.endIdx])).toEqual([
      ['left', 0, 3],
      ['right', 3, 5],
      ['left', 5, 6],
    ])
  })

  it('takes the side of the new stretch, not of the point before it', () => {
    // The first point has no stretch yet, so the side picked when it is placed does not matter.
    expect(draw(['both', 'left', 'left']).sideChanges).toEqual([{ idx: 0, side: 'left' }])
  })

  it('keeps the old behaviour when no side is given', () => {
    const r = appendPoint(appendPoint(appendPoint(empty(), pt(0)), pt(1)), pt(2))
    expect(r.sideChanges).toEqual([{ idx: 0, side: 'both' }])
  })

  it('carries on from a route that was drawn earlier', () => {
    const existing: Route = { ...road(4), sideChanges: [{ idx: 0, side: 'left' }] }
    expect(appendPoint(existing, pt(4), 'left').sideChanges).toEqual([{ idx: 0, side: 'left' }])
    expect(appendPoint(existing, pt(4), 'right').sideChanges).toEqual([
      { idx: 0, side: 'left' },
      { idx: 3, side: 'right' },
    ])
  })

  it('ignores an accidental double tap', () => {
    const r = draw(['left', 'left'])
    expect(appendPoint(r, { lat: pt(1).lat + 0.00001, lng: 0 }, 'right')).toBe(r)
  })

  it('removes the new section again when the point that started it is undone', () => {
    const r = draw(['left', 'left', 'left', 'right'])
    expect(r.sideChanges).toHaveLength(2)
    expect(removeLastPoint(r).sideChanges).toEqual([{ idx: 0, side: 'left' }])
  })
})

describe('adding several points at once', () => {
  const empty = (): Route => ({ points: [], sideChanges: [], stops: [] })
  const run = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => pt(from + i))

  it('is the same as tapping each point in turn', () => {
    const existing: Route = { ...road(3), sideChanges: [{ idx: 0, side: 'left' }] }
    for (const side of ['left', 'right'] as const) {
      const oneByOne = run(3, 8).reduce((r, p) => appendPoint(r, p, side), existing)
      expect(appendPoints(existing, run(3, 8), side)).toEqual(oneByOne)
    }
  })

  it('starts a single new section where the side changes, however many points follow', () => {
    const existing: Route = { ...road(3), sideChanges: [{ idx: 0, side: 'left' }] }
    const r = appendPoints(existing, run(3, 8), 'right')
    expect(r.points).toHaveLength(9)
    expect(r.sideChanges).toEqual([
      { idx: 0, side: 'left' },
      { idx: 2, side: 'right' },
    ])
  })

  it('stays in the same section when the side is the same', () => {
    const existing: Route = { ...road(3), sideChanges: [{ idx: 0, side: 'left' }] }
    expect(appendPoints(existing, run(3, 8), 'left').sideChanges).toEqual([{ idx: 0, side: 'left' }])
  })

  it('can build a whole route from nothing, thrown on the chosen side', () => {
    const r = appendPoints(empty(), run(0, 4), 'right')
    expect(r.points).toHaveLength(5)
    expect(r.sideChanges).toEqual([{ idx: 0, side: 'right' }])
  })

  it('skips points that sit on the one before, and leaves the route alone if all of them do', () => {
    const r = road(3)
    const nudge = (p: Pt): Pt => ({ lat: p.lat + 0.00001, lng: p.lng })
    expect(appendPoints(r, [nudge(pt(2)), nudge(pt(2))], 'left')).toBe(r)
    expect(appendPoints(r, [nudge(pt(2)), pt(3)], 'both').points).toHaveLength(4)
  })

  it('does nothing for no points', () => {
    const r = road(3)
    expect(appendPoints(r, [], 'left')).toBe(r)
  })
})

describe('taps on the last point', () => {
  it('count as double taps only when they land on it', () => {
    const r = road(3)
    expect(isDuplicateTap(r, { lat: pt(2).lat + 0.00001, lng: 0 })).toBe(true)
    expect(isDuplicateTap(r, pt(3))).toBe(false)
  })

  it('have nothing to double on an empty route', () => {
    expect(isDuplicateTap({ points: [] }, pt(0))).toBe(false)
  })
})

describe('moving a point', () => {
  it('changes only that point', () => {
    const r = road(4)
    const moved = movePoint(r, 2, { lat: 51.5, lng: 0.5 })
    expect(moved.points[2]).toEqual({ lat: 51.5, lng: 0.5 })
    expect(moved.points.filter((_, i) => i !== 2)).toEqual(r.points.filter((_, i) => i !== 2))
    expect(moved.sideChanges).toBe(r.sideChanges)
  })

  it('ignores a point that does not exist', () => {
    const r = road(3)
    expect(movePoint(r, 9, pt(0))).toBe(r)
    expect(movePoint(r, -1, pt(0))).toBe(r)
  })
})

describe('adding a point in the middle', () => {
  const base = (): Route => ({
    ...road(4),
    sideChanges: [{ idx: 0, side: 'left' }, { idx: 2, side: 'right' }],
    stops: [
      { id: 'a', type: 'nothrow', pathIdx: 1, ...pt(1.7) },
      { id: 'b', type: 'nothrow', pathIdx: 2, ...pt(2.5) },
    ],
  })

  it('puts a point halfway along the segment and returns its index', () => {
    const r = insertPoint(base(), 1)!
    expect(r.vertex).toBe(2)
    expect(r.route.points).toHaveLength(5)
    expect(r.route.points[2].lat).toBeCloseTo(51.0015, 6)
  })

  it('keeps both halves on the segment\'s side and moves later sections along', () => {
    const r = insertPoint(base(), 1)!
    expect(r.route.sideChanges).toEqual([
      { idx: 0, side: 'left' },
      { idx: 3, side: 'right' },
    ])
    expect(sections(r.route).map((x) => x.side)).toEqual(['left', 'right'])
  })

  it('moves stops onto the right half', () => {
    const r = insertPoint(base(), 1)!
    expect(r.route.stops.map((s) => [s.id, s.pathIdx])).toEqual([
      ['a', 2], // past the new point, so on the second half
      ['b', 3],
    ])
  })

  it('refuses a segment that does not exist', () => {
    expect(insertPoint(base(), 3)).toBeNull()
    expect(insertPoint(base(), -1)).toBeNull()
  })
})

describe('deleting a point', () => {
  const sixPoints = (): Route => ({
    ...road(6),
    // segments 0-1 left, 2-3 right, 4 both
    sideChanges: [{ idx: 0, side: 'left' }, { idx: 2, side: 'right' }, { idx: 4, side: 'both' }],
  })
  const sides = (r: Route) => sections(r).map((x) => [x.idx, x.side])

  it('closes the route up around a point in the middle of a section', () => {
    const r = deletePoint(road(5), 2)
    expect(r.points).toHaveLength(4)
    expect(r.points[2]).toEqual(pt(3))
    expect(r.sideChanges).toEqual([{ idx: 0, side: 'both' }])
  })

  it('keeps every section when the point sits at a boundary', () => {
    expect(sides(deletePoint(sixPoints(), 2))).toEqual([[0, 'left'], [2, 'right'], [3, 'both']])
  })

  it('lets a one-stretch section disappear when its point goes', () => {
    expect(sides(deletePoint(sixPoints(), 4))).toEqual([[0, 'left'], [2, 'right']])
  })

  it('shortens a section from either end without touching the rest', () => {
    expect(sides(deletePoint(sixPoints(), 3))).toEqual([[0, 'left'], [2, 'right'], [3, 'both']])
    expect(sides(deletePoint(sixPoints(), 1))).toEqual([[0, 'left'], [1, 'right'], [3, 'both']])
  })

  it('can remove the first or the last point', () => {
    const first = deletePoint(sixPoints(), 0)
    expect(first.points).toHaveLength(5)
    expect(sides(first)).toEqual([[0, 'left'], [1, 'right'], [3, 'both']])
    const last = deletePoint(sixPoints(), 5)
    expect(last.points).toHaveLength(5)
    expect(sides(last)).toEqual([[0, 'left'], [2, 'right']])
  })

  it('moves the first section on when its only stretch goes with the first point', () => {
    const r: Route = { ...road(4), sideChanges: [{ idx: 0, side: 'left' }, { idx: 1, side: 'right' }] }
    expect(sides(deletePoint(r, 0))).toEqual([[0, 'right']])
  })

  it('leaves a route with no stretches when only one point is left', () => {
    const r = deletePoint(road(2), 1)
    expect(r.points).toHaveLength(1)
    expect(r.sideChanges).toEqual([])
    expect(deletePoint(r, 0).points).toHaveLength(0)
  })

  it('keeps stops tied to the stretch they were on', () => {
    const r = sixPoints()
    r.stops = [
      { id: 'late', type: 'nothrow', pathIdx: 3, ...pt(3.5) },
      { id: 'gone', type: 'nothrow', pathIdx: 2, ...pt(2.5) },
    ]
    const after = deletePoint(r, 2)
    expect(after.stops.find((s) => s.id === 'late')!.pathIdx).toBe(2)
    expect(after.stops.find((s) => s.id === 'gone')!.pathIdx).toBe(1)
    expect(after.stops.every((s) => s.pathIdx >= 0 && s.pathIdx < after.points.length - 1)).toBe(true)
  })

  it('ignores a point that does not exist', () => {
    const r = road(3)
    expect(deletePoint(r, 7)).toBe(r)
  })

  it('always leaves side changes that fit the route', () => {
    for (let i = 0; i < 6; i++) {
      const r = deletePoint(sixPoints(), i)
      expect(r.sideChanges.every((c) => c.idx >= 0 && c.idx < r.points.length - 1)).toBe(true)
      expect(r.sideChanges[0].idx).toBe(0)
    }
  })
})

describe('painting a stretch of the route', () => {
  const flat = (): Route => ({ ...road(6), sideChanges: [{ idx: 0, side: 'both' }] })

  it('gives part of a section a new side, leaving the rest as it was', () => {
    expect(paintRange(flat(), 1, 3, 'left').sideChanges).toEqual([
      { idx: 0, side: 'both' },
      { idx: 1, side: 'left' },
      { idx: 3, side: 'both' },
    ])
  })

  it('works from the start and to the end of the route', () => {
    expect(paintRange(flat(), 0, 2, 'left').sideChanges).toEqual([
      { idx: 0, side: 'left' },
      { idx: 2, side: 'both' },
    ])
    expect(paintRange(flat(), 3, 5, 'right').sideChanges).toEqual([
      { idx: 0, side: 'both' },
      { idx: 3, side: 'right' },
    ])
  })

  it('replaces the sections inside the stretch and keeps the side after it', () => {
    const r: Route = { ...road(6), sideChanges: [{ idx: 0, side: 'left' }, { idx: 2, side: 'right' }, { idx: 4, side: 'both' }] }
    expect(paintRange(r, 1, 3, 'both').sideChanges).toEqual([
      { idx: 0, side: 'left' },
      { idx: 1, side: 'both' },
      { idx: 3, side: 'right' },
      { idx: 4, side: 'both' },
    ])
  })

  it('can paint the whole route one side', () => {
    const r: Route = { ...road(6), sideChanges: [{ idx: 0, side: 'left' }, { idx: 3, side: 'right' }] }
    expect(paintRange(r, 0, 5, 'left').sideChanges).toEqual([{ idx: 0, side: 'left' }])
  })

  it('does nothing for an empty or backwards stretch', () => {
    const r = flat()
    expect(paintRange(r, 2, 2, 'left')).toBe(r)
    expect(paintRange(r, 3, 1, 'left')).toBe(r)
  })

  describe('beside a stretch that is already the same side', () => {
    it('joins the one before it', () => {
      const r: Route = { ...road(6), sideChanges: [{ idx: 0, side: 'left' }, { idx: 3, side: 'right' }] }
      expect(paintRange(r, 3, 4, 'left').sideChanges).toEqual([
        { idx: 0, side: 'left' },
        { idx: 4, side: 'right' },
      ])
    })

    it('joins the one after it', () => {
      const r: Route = { ...road(6), sideChanges: [{ idx: 0, side: 'right' }, { idx: 3, side: 'left' }] }
      expect(paintRange(r, 1, 3, 'left').sideChanges).toEqual([
        { idx: 0, side: 'right' },
        { idx: 1, side: 'left' },
      ])
    })

    it('joins both, leaving one section', () => {
      const r: Route = { ...road(6), sideChanges: [{ idx: 0, side: 'left' }, { idx: 2, side: 'right' }, { idx: 4, side: 'left' }] }
      expect(paintRange(r, 2, 4, 'left').sideChanges).toEqual([{ idx: 0, side: 'left' }])
    })

    it('treats a corner as the same road', () => {
      const corner: Route = {
        points: [
          { lat: 51, lng: 0 },
          { lat: 51.001, lng: 0 },
          { lat: 51.002, lng: 0 },
          { lat: 51.002, lng: 0.0015 },
          { lat: 51.002, lng: 0.003 },
        ],
        sideChanges: [{ idx: 0, side: 'left' }, { idx: 2, side: 'right' }],
        stops: [],
      }
      expect(paintRange(corner, 2, 3, 'left').sideChanges).toEqual([
        { idx: 0, side: 'left' },
        { idx: 3, side: 'right' },
      ])
    })

    it('keeps the pass apart where the route doubles back', () => {
      // Out along a road and back along it, both passes on the left.
      const outAndBack = repeatSection({ ...road(4), sideChanges: [{ idx: 0, side: 'left' }] }, 0, 'back')!
      expect(outAndBack.sideChanges).toEqual([
        { idx: 0, side: 'left' },
        { idx: 3, side: 'left' },
      ])
      // Painting the start of the way back left must not fold it into the way out. Its end, where
      // the way back carries straight on, does join the rest of that pass.
      expect(paintRange(outAndBack, 3, 5, 'left').sideChanges).toEqual([
        { idx: 0, side: 'left' },
        { idx: 3, side: 'left' },
      ])
    })
  })
})

describe('painting between two taps', () => {
  const street = (): Route => ({ ...road(11), sideChanges: [{ idx: 0, side: 'both' }] })
  const tapAt = (lat: number) => ({ lat, lng: 0.00002 })

  it('adds a point where each tap falls and paints the road between them', () => {
    const r = paintStretch(street(), tapAt(51.0025), tapAt(51.0065), 'left')!
    expect(r.route.points).toHaveLength(13)
    expect([r.from, r.to]).toEqual([3, 8])
    const secs = sections(r.route)
    expect(secs.map((x) => x.side)).toEqual(['both', 'left', 'both'])
    expect(secs[1].startM).toBeCloseTo(2.5 * 111.2, -1)
    expect(secs[1].endM).toBeCloseTo(6.5 * 111.2, -1)
  })

  it('gives the same result whichever end is tapped first', () => {
    const a = paintStretch(street(), tapAt(51.0025), tapAt(51.0065), 'right')!
    const b = paintStretch(street(), tapAt(51.0065), tapAt(51.0025), 'right')!
    expect(b.route).toEqual(a.route)
  })

  it('reuses a point that is already there instead of adding another', () => {
    const r = paintStretch(street(), tapAt(51.002), tapAt(51.006), 'left')!
    expect(r.route.points).toHaveLength(11)
    expect([r.from, r.to]).toEqual([2, 6])
  })

  it('copes with one tap on a point and the other in the middle of a stretch', () => {
    const r = paintStretch(street(), tapAt(51.002), tapAt(51.0065), 'right')!
    expect(r.route.points).toHaveLength(12)
    expect([r.from, r.to]).toEqual([2, 7])
    expect(sections(r.route).map((x) => x.side)).toEqual(['both', 'right', 'both'])
  })

  it('copes with both taps inside the same stretch', () => {
    const r = paintStretch(street(), tapAt(51.0043), tapAt(51.0047), 'left')!
    expect(r.route.points).toHaveLength(13)
    expect([r.from, r.to]).toEqual([5, 6])
    const secs = sections(r.route)
    expect(secs).toHaveLength(3)
    expect(secs[1].endM - secs[1].startM).toBeCloseTo(0.0004 * 111195, -1)
  })

  it('moves stops along with the points that are added', () => {
    const base = street()
    base.stops = [{ id: 's', type: 'nothrow', pathIdx: 7, lat: 51.0075, lng: 0.0002 }]
    const r = paintStretch(base, tapAt(51.0025), tapAt(51.0065), 'left')!
    expect(r.route.stops[0].pathIdx).toBe(9)
  })

  it('leaves the route alone when a tap is nowhere near it, or both are the same place', () => {
    expect(paintStretch(street(), { lat: 51.005, lng: 0.01 }, tapAt(51.002), 'left')).toBeNull()
    expect(paintStretch(street(), tapAt(51.0025), tapAt(51.0025), 'left')).toBeNull()
    expect(paintStretch(street(), tapAt(51.0025), { lat: 51.00251, lng: 0.00002 }, 'left')).toBeNull()
  })

  it('can be limited to one pass when the road is driven twice', () => {
    const twice = repeatSection({ ...road(11), sideChanges: [{ idx: 0, side: 'left' }] }, 0, 'back')!
    const second = sections(twice)[1]
    const r = paintStretch(twice, tapAt(51.0025), tapAt(51.0065), 'right', { from: second.idx, to: second.endIdx })!
    // Painted on the return pass (segments 10 to 19), not the first.
    expect(r.from).toBeGreaterThanOrEqual(second.idx)
    expect(sections(r.route)[0].side).toBe('left')
    expect(sections(r.route).some((x) => x.side === 'right' && x.idx >= second.idx)).toBe(true)
  })
})

describe('finding the nearest part of the route', () => {
  /** 60 points east along one street, then 60 back west along another 30 m to the north. */
  const there = Array.from({ length: 60 }, (_, i) => ({ lat: 51, lng: i * 0.0002 }))
  const back = there.map((q) => ({ lat: 51.00027, lng: q.lng })).reverse()
  const loop: Route = { points: [...there, ...back], sideChanges: [{ idx: 0, side: 'both' }], stops: [] }

  it('looks along the whole route, not just the start of it', () => {
    const tap = { lat: 51.00031, lng: 0.001 }
    const s = nearestOnRoute(loop, tap)!
    expect(s.idx).toBeGreaterThan(60)
    expect(s.dist).toBeLessThan(6)
  })

  it('ties a stop to the street it is on, even when another part of the route is close', () => {
    const hit = stopAt(loop, { lat: 51.00031, lng: 0.001 }, 'nothrow')!
    expect(hit.stop.pathIdx).toBeGreaterThan(60)
  })

  it('can be limited to a range of segments', () => {
    const s = nearestOnRoute(loop, { lat: 51.00031, lng: 0.001 }, { from: 0, to: 59 })!
    expect(s.idx).toBeLessThan(59)
  })
})

describe('transit stretches, where nothing is thrown', () => {
  it('are one of the kinds of stretch a route can have', () => {
    expect(SIDES).toEqual(['both', 'left', 'right', 'transit'])
    expect(isSide('transit')).toBe(true)
    for (const junk of ['Transit', 'none', 'up', '', null, undefined, 3]) expect(isSide(junk)).toBe(false)
  })

  it('start a new section as points are drawn with the transit brush', () => {
    let r = road(1)
    for (let i = 1; i <= 2; i++) r = appendPoint(r, pt(i), 'both')
    for (let i = 3; i <= 4; i++) r = appendPoint(r, pt(i), 'transit')
    r = appendPoint(r, pt(5), 'left')
    expect(r.sideChanges).toEqual([
      { idx: 0, side: 'both' },
      { idx: 2, side: 'transit' },
      { idx: 4, side: 'left' },
    ])
    expect(sideAt(r, 3)).toBe('transit')
  })

  it('can be painted over a stretch, and join the transit next to it', () => {
    const r: Route = { ...road(8), sideChanges: [{ idx: 0, side: 'left' }, { idx: 3, side: 'transit' }, { idx: 6, side: 'right' }] }
    expect(paintRange(r, 1, 3, 'transit').sideChanges).toEqual([
      { idx: 0, side: 'left' },
      { idx: 1, side: 'transit' },
      { idx: 6, side: 'right' },
    ])
  })

  it('can be chosen for a section from the list', () => {
    const r: Route = { ...road(6), sideChanges: [{ idx: 0, side: 'left' }, { idx: 2, side: 'right' }] }
    expect(setSectionSide(r, 1, 'transit')).toEqual([
      { idx: 0, side: 'left' },
      { idx: 2, side: 'transit' },
    ])
  })

  it('stay transit when a section is repeated, rather than swapping like left and right', () => {
    expect(defaultRepeatSide('transit', 'again')).toBe('transit')
    expect(defaultRepeatSide('transit', 'back')).toBe('transit')
    expect(defaultRepeatSide('left', 'again')).toBe('right')
    const r: Route = { ...road(5), sideChanges: [{ idx: 0, side: 'transit' }] }
    expect(repeatSection(r, 0, 'again')!.sideChanges.at(-1)!.side).toBe('transit')
  })

  it('survive tidying saved data, which only drops sides that are not real ones', () => {
    const fixed = normalizeRoute({
      points: road(6).points,
      sideChanges: [{ idx: 0, side: 'transit' }, { idx: 2, side: 'sideways' as never }, { idx: 4, side: 'left' }],
    })
    expect(fixed.sideChanges).toEqual([
      { idx: 0, side: 'transit' },
      { idx: 2, side: 'both' },
      { idx: 4, side: 'left' },
    ])
  })
})

describe('a side to start from when changing part of a section', () => {
  it('swaps left and right', () => {
    expect(otherSide('left')).toBe('right')
    expect(otherSide('right')).toBe('left')
  })

  it('moves both to left, and transit to both', () => {
    expect(otherSide('both')).toBe('left')
    expect(otherSide('transit')).toBe('both')
  })

  it('is never the side it was given', () => {
    for (const side of SIDES) expect(otherSide(side)).not.toBe(side)
  })
})
