import { describe, expect, it } from 'vitest'
import { distanceToPath, haversine, occurrences, sideAt } from './geo'
import {
  appendPoint,
  appendPoints,
  cleanAddress,
  cleanLabel,
  cleanNote,
  defaultRepeatSide,
  deletedNote,
  deletePoint,
  deleteSection,
  deleteWarning,
  houseNumber,
  insertPoint,
  isDuplicateTap,
  looksLikeAddress,
  MAX_ADDRESS,
  MAX_LABEL,
  MAX_NOTE,
  MAX_QTY,
  movePoint,
  nearestOnRoute,
  normalizeRoute,
  otherSide,
  PAINT_MIN_M,
  paintMetres,
  paintRange,
  paintStretch,
  parseQty,
  qtyProblem,
  removeLastPoint,
  removeSplit,
  repeatSection,
  routeLength,
  sections,
  setSectionSide,
  splitAt,
  stopAt,
  stopDetail,
  stopFields,
  stopIncomplete,
  stopName,
  stopSides,
  stopWhere,
  updateStop,
  withoutNumber,
} from './routeEdit'
import { isSide, SIDES, type Pt, type Route, type Side, type Stop } from './types'

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
  it('keeps the name and the address it is given, apart from each other', () => {
    const hit = stopAt(road(6), { lat: 51.0025, lng: 0.0002 }, 'bundle', { label: "Joe's Cafe", address: '12 Oak Road', qty: 12 })!
    expect(hit.stop).toMatchObject({ type: 'bundle', label: "Joe's Cafe", address: '12 Oak Road', qty: 12 })
    const bare = stopAt(road(6), { lat: 51.0025, lng: 0.0002 }, 'nothrow')!
    expect('label' in bare.stop).toBe(false)
    expect('address' in bare.stop).toBe(false)
  })

  it('ties a stop to the nearest segment and reports how far off it is', () => {
    const hit = stopAt(road(4), { lat: 51.0025, lng: 0.0002 }, 'nothrow', { label: '12 Oak Road' })!
    expect(hit.stop.pathIdx).toBe(2)
    expect(hit.stop.label).toBe('12 Oak Road')
    expect(hit.stop.qty).toBeUndefined()
    expect(hit.offM).toBeGreaterThan(10)
    expect(hit.offM).toBeLessThan(20)
    expect(haversine(hit.stop, { lat: 51.0025, lng: 0.0002 })).toBe(0)
  })

  it('keeps the note of a special request, and has none when none is given', () => {
    const hit = stopAt(road(6), { lat: 51.0025, lng: 0.0002 }, 'request', { address: '23 Oak Road', note: 'Blue gate' })!
    expect(hit.stop).toMatchObject({ type: 'request', address: '23 Oak Road', note: 'Blue gate' })
    const bare = stopAt(road(6), { lat: 51.0025, lng: 0.0002 }, 'request')!
    expect('note' in bare.stop).toBe(false)
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

  it('keeps a special request and its note as they were saved', () => {
    const r = normalizeRoute({
      points: road(3).points,
      stops: [{ id: 'q', pathIdx: 0, type: 'request', ...pt(1), address: '23 Oak Road', note: 'Blue gate' }],
    })
    expect(r.stops[0]).toMatchObject({ type: 'request', address: '23 Oak Road', note: 'Blue gate' })
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

describe('deleting a section', () => {
  // Nine points running north: A is points 0 to 3, B is 3 to 5 and C is 5 to 8.
  const three = (sides: [Side, Side, Side] = ['left', 'right', 'both']): Route => ({
    points: Array.from({ length: 9 }, (_, i) => pt(i)),
    sideChanges: [
      { idx: 0, side: sides[0] },
      { idx: 3, side: sides[1] },
      { idx: 5, side: sides[2] },
    ],
    stops: [],
  })
  const STEP_M = haversine(pt(0), pt(1))

  it('takes a section off the start, and the route begins where the next one did', () => {
    const d = deleteSection(three(), 0)!
    expect(d.where).toBe('start')
    expect(d.line).toBe(false)
    expect(d.route.points).toEqual(three().points.slice(3))
    expect(d.route.sideChanges).toEqual([
      { idx: 0, side: 'right' },
      { idx: 2, side: 'both' },
    ])
    expect(d.meters).toBeCloseTo(3 * STEP_M, 3)
  })

  it('takes a section off the end, and the route ends where the one before did', () => {
    const d = deleteSection(three(), 2)!
    expect(d.where).toBe('end')
    expect(d.line).toBe(false)
    expect(d.route.points).toEqual(three().points.slice(0, 6))
    expect(d.route.sideChanges).toEqual([
      { idx: 0, side: 'left' },
      { idx: 3, side: 'right' },
    ])
    expect(d.meters).toBeCloseTo(3 * STEP_M, 3)
  })

  it('joins the ends of a gap in the middle with a straight line of transit', () => {
    const d = deleteSection(three(), 1)!
    expect(d.where).toBe('middle')
    expect(d.line).toBe(true)
    // Point 4 is gone, so point 3 now runs straight to point 5.
    expect(d.route.points).toEqual([...three().points.slice(0, 4), ...three().points.slice(5)])
    expect(d.route.sideChanges).toEqual([
      { idx: 0, side: 'left' },
      { idx: 3, side: 'transit' },
      { idx: 4, side: 'both' },
    ])
    expect(d.meters).toBeCloseTo(2 * STEP_M, 3)
  })

  it('lets a transit section before the gap carry on over the line', () => {
    const d = deleteSection(three(['transit', 'right', 'both']), 1)!
    expect(d.route.sideChanges).toEqual([
      { idx: 0, side: 'transit' },
      { idx: 4, side: 'both' },
    ])
  })

  it('lets a transit section after the gap start on the line', () => {
    const d = deleteSection(three(['left', 'right', 'transit']), 1)!
    expect(d.route.sideChanges).toEqual([
      { idx: 0, side: 'left' },
      { idx: 3, side: 'transit' },
    ])
  })

  it('keeps transit sections either side of the gap as they are, with the line in the one before', () => {
    const d = deleteSection(three(['transit', 'right', 'transit']), 1)!
    expect(d.route.sideChanges).toEqual([
      { idx: 0, side: 'transit' },
      { idx: 4, side: 'transit' },
    ])
  })

  it('needs no line when the section was a loop that ended where it began', () => {
    const north = (n: number): Pt => ({ lat: 51 + n * 0.001, lng: 0 })
    const loop: Route = {
      // A: 0 to 3 north. B: out east, up, and back to the point it started from. C: north again.
      points: [north(0), north(1), north(2), north(3), { lat: north(3).lat, lng: 0.002 }, { lat: north(4).lat, lng: 0.002 }, north(3), north(4), north(5)],
      sideChanges: [
        { idx: 0, side: 'left' },
        { idx: 3, side: 'right' },
        { idx: 6, side: 'both' },
      ],
      stops: [],
    }
    const d = deleteSection(loop, 1)!
    expect(d.line).toBe(false)
    // The point where the loop ended is dropped as it is the one it began at: no zero-length stretch is left.
    expect(d.route.points).toEqual([north(0), north(1), north(2), north(3), north(4), north(5)])
    expect(d.route.sideChanges).toEqual([
      { idx: 0, side: 'left' },
      { idx: 3, side: 'both' },
    ])
    for (let i = 0; i < d.route.points.length - 1; i++) expect(haversine(d.route.points[i], d.route.points[i + 1])).toBeGreaterThan(50)
  })

  it('will not delete the only section, which is clearing the route, or one that is not there', () => {
    expect(deleteSection(road(5), 0)).toBeNull()
    expect(deleteSection(three(), 3)).toBeNull()
    expect(deleteSection(three(), -1)).toBeNull()
    expect(deleteSection({ points: [], sideChanges: [], stops: [] }, 0)).toBeNull()
  })

  it('leaves the route it was given alone', () => {
    const before = three()
    const copy = structuredClone(before)
    deleteSection(before, 1)
    deleteSection(before, 0)
    deleteSection(before, 2)
    expect(before).toEqual(copy)
  })

  it('always leaves a route that is valid and one connected line, whichever section goes', () => {
    // A zigzag of five sections, each of two or three stretches, with transit among them.
    const zig: Route = {
      points: Array.from({ length: 13 }, (_, i) => ({ lat: 51 + i * 0.001, lng: (i % 2) * 0.001 })),
      sideChanges: [
        { idx: 0, side: 'left' },
        { idx: 2, side: 'transit' },
        { idx: 5, side: 'right' },
        { idx: 7, side: 'both' },
        { idx: 10, side: 'transit' },
      ],
      stops: [],
    }
    const total = routeLength(zig.points)
    const count = sections(zig).length
    for (let i = 0; i < count; i++) {
      const d = deleteSection(zig, i)!
      expect(normalizeRoute(d.route), `section ${i}`).toEqual(d.route)
      // Every stretch of what is left belongs to one section or another, and the first section starts at the start.
      const secs = sections(d.route)
      expect(secs[0].idx).toBe(0)
      expect(secs[secs.length - 1].endIdx).toBe(d.route.points.length - 1)
      // The line, if any, replaces the section by the shortest way between the ends it left.
      const sec = sections(zig)[i]
      const closed = d.where === 'middle' ? haversine(zig.points[sec.idx], zig.points[sec.endIdx]) : 0
      expect(routeLength(d.route.points), `section ${i}`).toBeCloseTo(total - d.meters + (d.line ? closed : 0), 3)
      // The ends of the route are the same unless the section at that end was the one deleted.
      if (d.where !== 'start') expect(d.route.points[0]).toEqual(zig.points[0])
      if (d.where !== 'end') expect(d.route.points[d.route.points.length - 1]).toEqual(zig.points[zig.points.length - 1])
    }
  })

  describe('with stops', () => {
    // A stop `east` metres to the east of point `i`, about as far east as a house sits.
    const stop = (id: string, i: number, east = 20, extra: Partial<Stop> = {}): Stop => ({
      id,
      lat: pt(i).lat,
      lng: east / (111320 * Math.cos((51 * Math.PI) / 180)),
      type: 'nothrow',
      pathIdx: Math.min(i, 7),
      ...extra,
    })
    const withStops = (stops: Stop[], base = three()): Route => ({ ...base, stops })

    it('removes the stops along the section, and says which', () => {
      const r = withStops([stop('a', 1), stop('b', 4), stop('c', 7)])
      const d = deleteSection(r, 1)!
      expect(d.removed.map((s) => s.id)).toEqual(['b'])
      expect(d.route.stops.map((s) => s.id)).toEqual(['a', 'c'])
    })

    it('removes them even though the line that closes the gap runs right past them', () => {
      // The road is straight, so the line from point 3 to point 5 runs through the middle of the deleted section.
      const d = deleteSection(withStops([stop('b', 4, 5)]), 1)!
      expect(d.line).toBe(true)
      expect(d.removed.map((s) => s.id)).toEqual(['b'])
    })

    it('keeps a stop that is beside the part of the route next to the section', () => {
      // Ten metres east of point 3, where the sections A and B meet: close to the end of A, which stays.
      const r = withStops([stop('j', 3, 10)])
      expect(deleteSection(r, 1)!.removed).toEqual([])
      expect(deleteSection(r, 0)!.removed).toEqual([])
      expect(deleteSection(r, 0)!.route.stops).toHaveLength(1)
    })

    it('keeps a stop that is along the section but also close to the road next to it, whichever side', () => {
      // 24 m from where A ends, but already on B's first stretch; and 24 m from where C starts, on B's last.
      const nearBefore = { ...stop('before', 3, 10), lat: pt(3).lat + 0.0002 }
      const nearAfter = { ...stop('after', 5, 10), lat: pt(5).lat - 0.0002 }
      const d = deleteSection(withStops([nearBefore, nearAfter]), 1)!
      expect(d.removed).toEqual([])
      expect(d.route.stops.map((s) => s.id)).toEqual(['before', 'after'])
    })

    it('keeps a stop on a road another pass still drives', () => {
      // Out along a street and back: the stop is passed twice, so deleting either pass leaves it a road.
      const north = (n: number): Pt => ({ lat: 51 + n * 0.001, lng: 0 })
      const out: Route = {
        points: [0, 1, 2, 3, 4, 3, 2, 1, 0].map(north),
        sideChanges: [
          { idx: 0, side: 'left' },
          { idx: 4, side: 'right' },
        ],
        stops: [stop('s', 2)],
      }
      for (const index of [0, 1]) {
        const d = deleteSection(out, index)!
        expect(d.removed, `section ${index}`).toEqual([])
        expect(d.route.stops).toHaveLength(1)
      }
    })

    it('leaves alone stops that were far from the route anyway, and are not along the section', () => {
      // One out beyond the section that comes after the one deleted, and one out beyond the section before it.
      const r = withStops([stop('farBefore', 1, 500), stop('farAfter', 7, 500)])
      const d = deleteSection(r, 1)!
      expect(d.removed).toEqual([])
      expect(d.route.stops.map((s) => s.id)).toEqual(['farBefore', 'farAfter'])
    })

    it('keeps a stop that is off the route, even when the section deleted is the nearest part of it', () => {
      // 500 m and 70 m east of point 4, in the middle of the section deleted. A stop 50 m east is still along it.
      const r = withStops([stop('far', 4, 500), stop('off', 4, 70), stop('along', 4, 50)])
      const d = deleteSection(r, 1)!
      expect(d.removed.map((s) => s.id)).toEqual(['along'])
      expect(d.route.stops.map((s) => s.id)).toEqual(['far', 'off'])
    })

    it('does not count a stop that is off the route among those a deletion warns about', () => {
      const r = withStops([stop('far', 4, 500), stop('along', 4, 20)])
      expect(deleteWarning(deleteSection(r, 1)!)).toContain('1 stop along it')
    })

    it('keeps each stop that is left tied to the nearest stretch of the new route', () => {
      // 'c' is halfway between points 7 and 8, which are points 4 and 5 once the first three are gone.
      const r = withStops([stop('a', 1), { ...stop('c', 7), lat: pt(7).lat + 0.0005 }, stop('d', 6)])
      const d = deleteSection(r, 0)!
      expect(d.removed.map((s) => s.id)).toEqual(['a'])
      for (const s of d.route.stops) expect(s.pathIdx).toBe(nearestOnRoute(d.route, s)!.idx)
      expect(d.route.stops.find((s) => s.id === 'c')!.pathIdx).toBe(4)
    })

    it('keeps everything else about a stop as it was', () => {
      const keeper = stop('c', 7, 20, { label: '7 Elm St', qty: 3, type: 'bundle', side: 'left' })
      const d = deleteSection(withStops([keeper]), 0)!
      expect(d.route.stops[0]).toEqual({ ...keeper, pathIdx: d.route.stops[0].pathIdx })
    })

    it('has nothing to remove when there are no stops', () => {
      expect(deleteSection(three(), 1)!.removed).toEqual([])
    })
  })

  describe('what is said about it', () => {
    const base = (): Route => ({
      points: Array.from({ length: 9 }, (_, i) => pt(i)),
      sideChanges: [
        { idx: 0, side: 'left' },
        { idx: 3, side: 'right' },
        { idx: 5, side: 'both' },
      ],
      stops: [],
    })
    const stops = (n: number): Stop[] =>
      Array.from({ length: n }, (_, i) => ({ id: `s${i}`, lat: pt(4).lat, lng: 0.0003, type: 'nothrow' as const, pathIdx: 3 }))

    it('says how much is removed from the start of the route, or from the end of it', () => {
      expect(deleteWarning(deleteSection(base(), 0)!)).toBe('This removes 334 m from the start of your route.')
      expect(deleteWarning(deleteSection(base(), 2)!)).toBe('This removes 334 m from the end of your route.')
    })

    it('says the ends are joined with transit when a gap is closed, and that it can be redrawn', () => {
      expect(deleteWarning(deleteSection(base(), 1)!)).toBe(
        'This removes 222 m of your route. Its two ends are joined by a straight transit line, which you can redraw afterwards.',
      )
    })

    it('counts the stops that go with it', () => {
      const r = { ...base(), stops: stops(2) }
      expect(deleteWarning(deleteSection(r, 1)!)).toContain('222 m of your route and the 2 stops along it.')
      expect(deleteWarning(deleteSection({ ...base(), stops: stops(1) }, 1)!)).toContain('and the 1 stop along it.')
    })

    it('says nothing about a line when the ends already met', () => {
      const d = { ...deleteSection(base(), 1)!, line: false }
      expect(deleteWarning(d)).toBe('This removes 222 m of your route.')
      expect(deletedNote(d, 1)).not.toContain('transit')
    })

    it('says afterwards which section went, how much, and what came with it', () => {
      expect(deletedNote(deleteSection(base(), 0)!, 0)).toBe('Deleted section 1: 334 m.')
      expect(deletedNote(deleteSection({ ...base(), stops: stops(3) }, 1)!, 1)).toBe(
        'Deleted section 2: 222 m and 3 stops. Its ends are joined by a straight transit line.',
      )
    })
  })
})

describe('naming a stop and saying how many papers it gets', () => {
  const bundle = (extra: Partial<Stop> = {}): Stop => ({ id: 'b', type: 'bundle', lat: 51.0015, lng: 0.0003, pathIdx: 1, ...extra })
  const house = (extra: Partial<Stop> = {}): Stop => ({ id: 'h', type: 'nothrow', lat: 51.0035, lng: 0.0003, pathIdx: 3, ...extra })
  const request = (extra: Partial<Stop> = {}): Stop => ({ id: 'r', type: 'request', lat: 51.0025, lng: 0.0003, pathIdx: 2, ...extra })
  const withStops = (...stops: Stop[]): Route => ({ ...road(6), stops })

  describe('a name as it was typed', () => {
    it('tidies the spaces and keeps what was written', () => {
      expect(cleanLabel("  Joe's   Cafe ")).toBe("Joe's Cafe")
      expect(cleanLabel('Hartley & Sons\t14 High St')).toBe('Hartley & Sons 14 High St')
    })

    it('is nothing when it is blank', () => {
      for (const blank of ['', '   ', '\n\t']) expect(cleanLabel(blank)).toBeUndefined()
    })

    it('is kept to a length an alert can show', () => {
      expect(cleanLabel('x'.repeat(200))).toHaveLength(MAX_LABEL)
      expect(cleanLabel('x'.repeat(MAX_LABEL))).toHaveLength(MAX_LABEL)
    })

    it('counts the length of what is kept, not of the spaces in front of it, and does not end on a space', () => {
      expect(cleanLabel('   ' + 'x'.repeat(100))).toHaveLength(MAX_LABEL)
      expect(cleanLabel('x'.repeat(MAX_LABEL - 1) + ' ' + 'y'.repeat(10))).toBe('x'.repeat(MAX_LABEL - 1))
    })
  })

  describe('a note as it was typed', () => {
    it('is tidied like a name, and nothing when blank', () => {
      expect(cleanNote('  Blue   gate,\n deliver by hand ')).toBe('Blue gate, deliver by hand')
      for (const blank of ['', '   ', '\n\t']) expect(cleanNote(blank)).toBeUndefined()
    })

    it('is kept short enough to read at a glance, and no longer than an address', () => {
      expect(cleanNote('x'.repeat(300))).toHaveLength(MAX_NOTE)
      expect(cleanNote('x'.repeat(MAX_NOTE))).toHaveLength(MAX_NOTE)
      expect(MAX_NOTE).toBe(60)
      expect(MAX_NOTE).toBeLessThanOrEqual(MAX_ADDRESS)
    })
  })

  describe('an address as it was typed', () => {
    it('is tidied like a name, and nothing when blank', () => {
      expect(cleanAddress('  12   Oak Road,\n Lewes ')).toBe('12 Oak Road, Lewes')
      for (const blank of ['', '  ', '\n']) expect(cleanAddress(blank)).toBeUndefined()
    })

    it('is allowed to be longer than a name, but not without limit', () => {
      expect(MAX_ADDRESS).toBeGreaterThan(MAX_LABEL)
      expect(cleanAddress('x'.repeat(500))).toHaveLength(MAX_ADDRESS)
      expect(cleanAddress('x'.repeat(MAX_LABEL + 10))).toHaveLength(MAX_LABEL + 10)
    })
  })

  describe('telling an address from a name', () => {
    it('reads a house number followed by words as an address', () => {
      for (const address of ['12 Oak Road', '12 Oak Road, Lewes', '  12 Oak Road ', '12A Oak Road', '3/12 Oak Road', '12-14 Oak Road', '3b/12-14 Oak Rd']) {
        expect(looksLikeAddress(address), address).toBe(true)
      }
    })

    it('does not read a number and a word that is not a street as an address', () => {
      for (const name of ['24 Hour Pharmacy', '7 Day Cafe', '5 Star Motel', '2 Minute Noodles', '24 hours Fitness']) {
        expect(looksLikeAddress(name), name).toBe(false)
      }
      // But a street whose name only starts with one of those words is still an address.
      for (const address of ['24 Hourglass Road', '5 Starling Street', '7 Dayton Avenue']) expect(looksLikeAddress(address), address).toBe(true)
    })

    it('leaves names alone, including ones that start with a number', () => {
      for (const name of ["Joe's Cafe", '7-Eleven', '1st Choice Pharmacy', 'No. 14', '14', '12', '', 'Corner Kiosk', 'Unit 3', "Joe's Cafe at 12 Oak Road"]) {
        expect(looksLikeAddress(name), name).toBe(false)
      }
    })
  })

  describe('the name and address to offer when a stop is edited', () => {
    it('offers what the stop has', () => {
      expect(stopFields({ label: "Joe's Cafe", address: '12 Oak Road' })).toEqual({ name: "Joe's Cafe", address: '12 Oak Road' })
      expect(stopFields({ label: "Joe's Cafe" })).toEqual({ name: "Joe's Cafe", address: '' })
      expect(stopFields({ address: '12 Oak Road' })).toEqual({ name: '', address: '12 Oak Road' })
      expect(stopFields({})).toEqual({ name: '', address: '' })
    })

    it('offers an old stop whose only name is a typed address as its address', () => {
      expect(stopFields({ label: '12 Oak Road, Lewes' })).toEqual({ name: '', address: '12 Oak Road, Lewes' })
    })

    it('does not move a name once the stop has an address of its own, whatever the name looks like', () => {
      expect(stopFields({ label: '12 Oak Road', address: '12 Oak Road, Lewes' })).toEqual({ name: '12 Oak Road', address: '12 Oak Road, Lewes' })
    })
  })

  describe('how many papers, as it was typed', () => {
    it('is a whole number from 1 up', () => {
      expect(parseQty('12')).toBe(12)
      expect(parseQty(' 7 ')).toBe(7)
      expect(parseQty('007')).toBe(7)
      expect(parseQty('1')).toBe(1)
      expect(parseQty(String(MAX_QTY))).toBe(MAX_QTY)
    })

    it('is nothing for anything else', () => {
      for (const bad of ['', '  ', '0', '-3', '12.5', '1e3', '12 papers', 'abc', '+5', String(MAX_QTY + 1), '99999999999999999999']) {
        expect(parseQty(bad), JSON.stringify(bad)).toBeUndefined()
      }
    })

    it('has a problem to report only for something that was typed and is not an amount', () => {
      expect(qtyProblem('')).toBeNull()
      expect(qtyProblem('   ')).toBeNull()
      expect(qtyProblem('12')).toBeNull()
      expect(qtyProblem(String(MAX_QTY))).toBeNull()
      for (const bad of ['0', '-3', '12.5', 'abc', String(MAX_QTY + 1)]) expect(qtyProblem(bad), bad).toContain(`1 to ${MAX_QTY}`)
    })
  })

  describe('what a stop is called, and what it gets, in a list', () => {
    it('uses the name, or the address when there is no name, or says what kind of stop it is', () => {
      expect(stopName(bundle({ label: "Joe's Cafe" }))).toBe("Joe's Cafe")
      expect(stopName(bundle({ label: "Joe's Cafe", address: '12 Oak Road' }))).toBe("Joe's Cafe")
      expect(stopName(bundle({ address: '12 Oak Road' }))).toBe('12 Oak Road')
      expect(stopName(bundle())).toBe('Bundle drop')
      expect(stopName(house())).toBe('No-throw house')
    })

    it('shows the address under the name only when there is both, since with no name the address is the name', () => {
      expect(stopWhere(bundle({ label: "Joe's Cafe", address: '12 Oak Road' }))).toBe('12 Oak Road')
      expect(stopWhere(bundle({ address: '12 Oak Road' }))).toBeNull()
      expect(stopWhere(bundle({ label: "Joe's Cafe" }))).toBeNull()
      expect(stopWhere(bundle())).toBeNull()
    })

    it('says how many papers a bundle drop gets, or that no amount is set', () => {
      expect(stopDetail(bundle({ qty: 12 }))).toBe('12 papers')
      expect(stopDetail(bundle({ qty: 1 }))).toBe('1 paper')
      expect(stopDetail(bundle())).toBe('no amount set')
      expect(stopDetail(house())).toBe('No-throw')
    })

    it('calls a special request by its address, or says what it is, and tells it by its note', () => {
      expect(stopName(request({ address: '23 Oak Road' }))).toBe('23 Oak Road')
      expect(stopName(request())).toBe('Special request')
      expect(stopDetail(request({ note: 'Blue gate' }))).toBe('Blue gate')
      expect(stopDetail(request())).toBe('no note set')
    })

    it('points out a bundle drop with no amount and a special request with no note, and nothing else', () => {
      expect(stopIncomplete(bundle())).toBe(true)
      expect(stopIncomplete(bundle({ qty: 3 }))).toBe(false)
      expect(stopIncomplete(request())).toBe(true)
      expect(stopIncomplete(request({ note: 'Blue gate' }))).toBe(false)
      expect(stopIncomplete(house())).toBe(false)
    })
  })

  describe('changing them', () => {
    it('gives a bundle drop a name and an amount', () => {
      const r = updateStop(withStops(bundle()), 'b', { label: "Joe's Cafe", qty: 12 })
      expect(r.stops[0]).toMatchObject({ id: 'b', label: "Joe's Cafe", qty: 12 })
    })

    it('takes off what is left out, so blank means none', () => {
      const r = updateStop(withStops(bundle({ label: "Joe's Cafe", qty: 12 })), 'b', { label: "Joe's Cafe" })
      expect(r.stops[0].qty).toBeUndefined()
      expect('qty' in r.stops[0]).toBe(false)
      const none = updateStop(withStops(bundle({ label: "Joe's Cafe", qty: 12 })), 'b', {})
      expect('label' in none.stops[0]).toBe(false)
      expect('qty' in none.stops[0]).toBe(false)
    })

    it('gives a no-throw house a name but never an amount', () => {
      const r = updateStop(withStops(house()), 'h', { label: 'Mrs Smith', qty: 5 })
      expect(r.stops[0]).toMatchObject({ id: 'h', label: 'Mrs Smith' })
      expect('qty' in r.stops[0]).toBe(false)
    })

    it('gives either kind of stop an address of its own, apart from its name', () => {
      const r = updateStop(withStops(bundle(), house()), 'b', { label: "Joe's Cafe", address: '12 Oak Road, Lewes', qty: 12 })
      expect(r.stops[0]).toMatchObject({ label: "Joe's Cafe", address: '12 Oak Road, Lewes', qty: 12 })
      const h = updateStop(r, 'h', { address: '9 Elm Street' })
      expect(h.stops[1]).toMatchObject({ address: '9 Elm Street' })
      expect('label' in h.stops[1]).toBe(false)
    })

    it('changes the name without touching the address, and the other way round, when both are passed', () => {
      const start = withStops(bundle({ label: 'Old', address: '1 Old Road', qty: 3 }))
      const r = updateStop(start, 'b', { label: 'New', address: '1 Old Road', qty: 3 })
      expect(r.stops[0]).toMatchObject({ label: 'New', address: '1 Old Road', qty: 3 })
      const s = updateStop(start, 'b', { label: 'Old', address: '2 New Road', qty: 3 })
      expect(s.stops[0]).toMatchObject({ label: 'Old', address: '2 New Road' })
    })

    it('takes the address off when it is left out', () => {
      const r = updateStop(withStops(bundle({ label: 'Name', address: '1 Road', qty: 3 })), 'b', { label: 'Name', qty: 3 })
      expect('address' in r.stops[0]).toBe(false)
    })

    it('gives a special request a note and an address, but never an amount', () => {
      const r = updateStop(withStops(request()), 'r', { address: '23 Oak Road', note: 'Blue gate', qty: 5 })
      expect(r.stops[0]).toMatchObject({ id: 'r', address: '23 Oak Road', note: 'Blue gate' })
      expect('qty' in r.stops[0]).toBe(false)
    })

    it('takes the note off a special request when it is left out, so blank means none', () => {
      const r = updateStop(withStops(request({ address: '23 Oak Road', note: 'Blue gate' })), 'r', { address: '23 Oak Road' })
      expect('note' in r.stops[0]).toBe(false)
      expect(r.stops[0].address).toBe('23 Oak Road')
    })

    it('gives a note only to a special request', () => {
      const b = updateStop(withStops(bundle()), 'b', { label: 'Cafe', qty: 3, note: 'Blue gate' })
      const h = updateStop(withStops(house()), 'h', { label: 'Mrs Smith', note: 'Blue gate' })
      expect('note' in b.stops[0]).toBe(false)
      expect('note' in h.stops[0]).toBe(false)
    })

    it('changes nothing else about the stop, or any other stop', () => {
      const keep = bundle({ label: 'Old', qty: 3, side: 'left', pathIdx: 2 })
      const other = house({ label: 'Next door', pathIdx: 4 })
      const before = withStops(keep, other)
      const r = updateStop(before, 'b', { label: 'New', qty: 9 })
      expect(r.stops[0]).toEqual({ ...keep, label: 'New', qty: 9 })
      expect(r.stops[1]).toBe(other)
      expect(r.points).toBe(before.points)
      expect(r.sideChanges).toBe(before.sideChanges)
    })

    it('is the same route when there is no such stop', () => {
      const route = withStops(bundle())
      expect(updateStop(route, 'nope', { label: 'x', qty: 1 })).toBe(route)
    })

    it('leaves the route it was given alone', () => {
      const route = withStops(bundle({ label: 'Old', qty: 3 }))
      const copy = structuredClone(route)
      updateStop(route, 'b', { label: 'New', qty: 9 })
      expect(route).toEqual(copy)
    })
  })
})

describe('the house number to look for', () => {
  it('is the number an address starts with', () => {
    expect(houseNumber({ address: '12 Oak Road' })).toBe('12')
    expect(houseNumber({ address: '  12 Oak Road, Lewes ' })).toBe('12')
    expect(houseNumber({ address: '12a Oak Road' })).toBe('12A')
    expect(houseNumber({ address: '3/12 Oak Road' })).toBe('3/12')
    expect(houseNumber({ address: '12-14 High Street' })).toBe('12-14')
    expect(houseNumber({ address: '3b/12-14 High Street' })).toBe('3B/12-14')
    expect(houseNumber({ address: '1204 Mulgoa Road' })).toBe('1204')
  })

  it('skips a unit, a flat or a shop in front of it', () => {
    expect(houseNumber({ address: 'Unit 3, 12 Oak Road' })).toBe('12')
    expect(houseNumber({ address: 'Shop 4, 120 High Street, Lewes' })).toBe('120')
    expect(houseNumber({ address: 'Flat 2, 7B Elm Street' })).toBe('7B')
    expect(houseNumber({ address: 'unit 12/3, 45 King St' })).toBe('45')
  })

  it('shows the letters of a number in capitals, whichever way they were typed', () => {
    expect(houseNumber({ address: 'unit 3, 12a Oak Road' })).toBe('12A')
    expect(houseNumber({ address: 'lot 7a Smith Road' })).toBe('7A')
    expect(houseNumber({ address: '12a Oak Road' })).toBe('12A')
    expect(houseNumber({ label: 'no. 14b' })).toBe('14B')
  })

  it('reads a lot number, or a number that says it is one', () => {
    expect(houseNumber({ address: 'Lot 7 Smith Road' })).toBe('7')
    expect(houseNumber({ address: 'No. 14' })).toBe('14')
    expect(houseNumber({ address: 'No 14 Oak Road' })).toBe('14')
    expect(houseNumber({ address: '#14' })).toBe('14')
    expect(houseNumber({ address: 'Number 9, Elm Street' })).toBe('9')
  })

  it('comes from the address before the name', () => {
    expect(houseNumber({ label: 'No. 5', address: '12 Oak Road' })).toBe('12')
    expect(houseNumber({ label: "Joe's Cafe", address: '12 Oak Road' })).toBe('12')
  })

  it('comes from the name when the address has no number', () => {
    expect(houseNumber({ label: 'No. 14', address: 'Oak Road, Lewes' })).toBe('14')
    expect(houseNumber({ label: '14', address: 'Oak Road' })).toBe('14')
  })

  it('comes from a name only when it says it is a number, is one, or is an address typed as the name', () => {
    for (const [name, number] of [['14', '14'], ['14a', '14A'], ['No. 14', '14'], ['#14', '14'], ['14 Oak Road', '14'], ['14 Oak Road, Lewes', '14']] as const) {
      expect(houseNumber({ label: name }), name).toBe(number)
    }
    for (const name of ["Joe's Cafe", '7-Eleven', '24 Hour Pharmacy', '1st Choice Pharmacy', 'Corner Kiosk', '5 Star Motel', '']) {
      expect(houseNumber({ label: name }), name).toBeNull()
    }
  })

  it('is nothing when there is none', () => {
    expect(houseNumber({})).toBeNull()
    expect(houseNumber({ address: '' })).toBeNull()
    expect(houseNumber({ address: 'Oak Road, Lewes' })).toBeNull()
    expect(houseNumber({ address: 'Unit 3' })).toBeNull()
  })
})

describe('text with the house number taken off the front', () => {
  it('leaves the rest of an address', () => {
    expect(withoutNumber('12 Oak Road, Lewes', '12')).toBe('Oak Road, Lewes')
    expect(withoutNumber('12A Oak Road', '12A')).toBe('Oak Road')
    expect(withoutNumber('3/12 High Street', '3/12')).toBe('High Street')
    expect(withoutNumber('12-14 High Street', '12-14')).toBe('High Street')
    expect(withoutNumber('  12,  Oak Road ', '12')).toBe('Oak Road')
  })

  it('goes by the number in capitals, as it is shown, whatever was typed', () => {
    expect(withoutNumber('12a Oak Road', '12A')).toBe('Oak Road')
  })

  it('leaves text that does not start with the number as it was', () => {
    expect(withoutNumber('Unit 3, 12 Oak Road', '12')).toBe('Unit 3, 12 Oak Road')
    expect(withoutNumber("Joe's Cafe", '12')).toBe("Joe's Cafe")
    expect(withoutNumber('120 Oak Road', '12')).toBe('120 Oak Road')
    expect(withoutNumber('12th Street', '12')).toBe('12th Street')
  })

  it('leaves text that is only the number, so there is still something to show', () => {
    expect(withoutNumber('14', '14')).toBe('14')
    expect(withoutNumber('14,', '14')).toBe('14,')
  })

  it('leaves everything when there is no number', () => {
    expect(withoutNumber('12 Oak Road', null)).toBe('12 Oak Road')
  })
})

describe('painting a stretch by how far along the route it is', () => {
  /** Metres between two neighbouring points of `road`. */
  const M = 111.1949266
  const flat = (): Route => ({ ...road(11), sideChanges: [{ idx: 0, side: 'both' }] })
  /** The latitude `m` metres along `road`. */
  const lat = (m: number) => 51 + m / (M * 1000)
  const sidesOf = (r: Route) => sections(r).map((s) => s.side)
  /** The side in force `m` metres along the route. */
  const sideAtMetre = (r: Route, m: number): Side => (sections(r).find((s) => m < s.endM) ?? sections(r).at(-1)!).side
  const house = (id: string, m: number, pathIdx: number, type: Stop['type'] = 'nothrow', lng = 0.00003): Stop => ({ id, type, lat: lat(m), lng, pathIdx })

  it('gives the stretch a section of its own, leaving the sides either end of it as they were', () => {
    const r = paintMetres(flat(), 250, 640, 'left')!
    expect(r.points).toHaveLength(13)
    expect(r.sideChanges).toEqual([{ idx: 0, side: 'both' }, { idx: 3, side: 'left' }, { idx: 7, side: 'both' }])
    const mid = sections(r)[1]
    expect(mid.startM).toBeCloseTo(250, 1)
    expect(mid.endM).toBeCloseTo(640, 1)
  })

  it('leaves the road where it was: the same line and the same length', () => {
    const before: Route = {
      points: [{ lat: 51, lng: 0 }, { lat: 51.001, lng: 0.0004 }, { lat: 51.0022, lng: 0.0003 }, { lat: 51.003, lng: 0.0011 }, { lat: 51.0041, lng: 0.0011 }],
      sideChanges: [{ idx: 0, side: 'both' }],
      stops: [],
    }
    const total = routeLength(before.points)
    const after = paintMetres(before, 40, total - 55, 'right')!
    expect(after.points).toHaveLength(before.points.length + 2)
    expect(Math.abs(routeLength(after.points) - total)).toBeLessThan(0.01)
    for (const p of after.points) expect(distanceToPath(p, before.points)).toBeLessThan(0.01)
    // Every point that was there is still there, in the same order.
    expect(after.points.filter((p) => before.points.some((q) => q.lat === p.lat && q.lng === p.lng))).toEqual(before.points)
  })

  it('is the same edit as painting between two taps on the same spots', () => {
    const tap = (m: number) => ({ lat: lat(m), lng: 0 })
    const byTap = paintStretch(flat(), tap(250), tap(640), 'left')!.route
    const byMetres = paintMetres(flat(), 250, 640, 'left')!
    expect(byMetres.sideChanges).toEqual(byTap.sideChanges)
    expect(byMetres.points).toHaveLength(byTap.points.length)
    byMetres.points.forEach((p, i) => expect(haversine(p, byTap.points[i])).toBeLessThan(0.01))
  })

  it('does not change the route it was given', () => {
    const base = flat()
    base.stops = [house('a', 300, 2)]
    const snapshot = JSON.stringify(base)
    paintMetres(base, 250, 640, 'left')
    expect(JSON.stringify(base)).toBe(snapshot)
  })

  describe('where the new points go', () => {
    it('reuses a point that is within 3 metres instead of adding another beside it', () => {
      const r = paintMetres(flat(), 2 * M + 2, 5 * M - 2.9, 'left')!
      expect(r.points).toEqual(flat().points)
      expect(r.sideChanges).toEqual([{ idx: 0, side: 'both' }, { idx: 2, side: 'left' }, { idx: 5, side: 'both' }])
    })

    it('adds one when the nearest point is further than that, whichever side of it the end falls', () => {
      const after = paintMetres(flat(), 2 * M + 3.1, 5 * M, 'left')!
      expect(after.points).toHaveLength(12)
      expect(after.sideChanges).toEqual([{ idx: 0, side: 'both' }, { idx: 3, side: 'left' }, { idx: 6, side: 'both' }])
      const before = paintMetres(flat(), 2 * M, 5 * M - 3.1, 'left')!
      expect(before.points).toHaveLength(12)
      expect(before.sideChanges).toEqual([{ idx: 0, side: 'both' }, { idx: 2, side: 'left' }, { idx: 5, side: 'both' }])
    })

    it('starts the section at the point it reused, which can be a couple of metres from where it was asked for', () => {
      const r = paintMetres(flat(), 2 * M + 2.5, 6 * M, 'left')!
      expect(sections(r)[1].startM).toBeCloseTo(2 * M, 3)
    })

    it('does not add any when the road is dense with points', () => {
      const dense: Route = {
        points: Array.from({ length: 300 }, (_, i) => ({ lat: 51 + (i * 2) / (M * 1000), lng: 0 })),
        sideChanges: [{ idx: 0, side: 'both' }],
        stops: [],
      }
      const r = paintMetres(dense, 100.7, 400.2, 'left')!
      expect(r.points).toHaveLength(300)
      const mid = sections(r)[1]
      expect(Math.abs(mid.startM - 100.7)).toBeLessThanOrEqual(3)
      expect(Math.abs(mid.endM - 400.2)).toBeLessThanOrEqual(3)
      expect(sections(r)).toHaveLength(3)
    })

    it('starts at the very beginning and ends at the very end without adding a point there', () => {
      const start = paintMetres(flat(), 0, 300, 'left')!
      expect(start.points).toHaveLength(12)
      expect(start.sideChanges).toEqual([{ idx: 0, side: 'left' }, { idx: 3, side: 'both' }])
      const total = routeLength(flat().points)
      const end = paintMetres(flat(), total - 300, total, 'left')!
      expect(end.points).toHaveLength(12)
      expect(end.sideChanges).toEqual([{ idx: 0, side: 'both' }, { idx: 8, side: 'left' }])
      // Exactly at the ends of the route, the points that are there are the ones used.
      expect(end.points[11]).toEqual(flat().points[10])
    })

    it('copes with a pair of points that are the same place', () => {
      const doubled: Route = { points: [pt(0), pt(1), pt(2), pt(2), pt(3), pt(4)], sideChanges: [{ idx: 0, side: 'both' }], stops: [] }
      const r = paintMetres(doubled, 1.5 * M, 3.5 * M, 'left')!
      expect(sidesOf(r)).toEqual(['both', 'left', 'both'])
      expect(Math.abs(routeLength(r.points) - routeLength(doubled.points))).toBeLessThan(0.01)
      const mid = sections(r)[1]
      expect(mid.startM).toBeCloseTo(1.5 * M, 1)
      expect(mid.endM).toBeCloseTo(3.5 * M, 1)
      // Starting right at the doubled point reuses one of the two.
      const at = paintMetres(doubled, 2 * M, 3.5 * M, 'right')!
      expect(at.points).toHaveLength(7)
      expect(sections(at)[1].startM).toBeCloseTo(2 * M, 1)
    })
  })

  describe('the stops along the road', () => {
    it('move with the points that are added, each staying with its stretch of road', () => {
      const base = flat()
      base.stops = [
        house('a', 1.5 * M, 1),
        house('b', 233, 2), // before the first new point, at 250 m
        house('c', 311, 2), // after it
        house('d', 500, 4),
        house('e', 634, 5), // before the second new point, at 640 m
        house('f', 656, 5), // after it
        house('g', 945, 8),
      ]
      const r = paintMetres(base, 250, 640, 'left')!
      expect(r.stops.map((s) => s.pathIdx)).toEqual([1, 2, 3, 5, 6, 7, 10])
      for (const s of r.stops) expect(s.pathIdx, s.id).toBe(nearestOnRoute(r, s)!.idx)
    })

    it('stay with their stretch when both new points fall in the same segment', () => {
      // Segment 4 runs from 445 m to 556 m, and the new points go in at 470 m and 530 m.
      const base = flat()
      base.stops = [house('before', 466, 4), house('between', 500, 4), house('after', 545, 4)]
      const r = paintMetres(base, 470, 530, 'left')!
      expect(r.points).toHaveLength(13)
      expect(r.stops.map((s) => s.pathIdx)).toEqual([4, 5, 6])
      for (const s of r.stops) expect(s.pathIdx, s.id).toBe(nearestOnRoute(r, s)!.idx)
    })

    it('keep their stretch the same way when painting between two taps', () => {
      const base = flat()
      base.stops = [house('before', 466, 4), house('between', 500, 4), house('after', 545, 4)]
      const r = paintStretch(base, { lat: lat(470), lng: 0 }, { lat: lat(530), lng: 0 }, 'left')!.route
      expect(r.stops.map((s) => s.pathIdx)).toEqual([4, 5, 6])
    })
  })

  describe('over a whole section', () => {
    const three = (): Route => ({ ...road(11), sideChanges: [{ idx: 0, side: 'both' }, { idx: 4, side: 'left' }, { idx: 8, side: 'right' }] })

    it('is what changing the side of that section does, with no point added', () => {
      const r = three()
      const secs = sections(r)
      let tried = 0
      for (const s of secs) {
        for (const side of SIDES) {
          if ([secs[s.index - 1]?.side, secs[s.index + 1]?.side].includes(side)) continue
          const painted = paintMetres(r, s.startM, s.endM, side)!
          expect(painted.points, `${s.index} ${side}`).toEqual(r.points)
          expect(painted.sideChanges, `${s.index} ${side}`).toEqual(setSectionSide(r, s.index, side))
          tried++
        }
      }
      expect(tried).toBeGreaterThanOrEqual(8)
    })

    it('joins the sections either side when they are the side it was given', () => {
      const r: Route = { ...road(11), sideChanges: [{ idx: 0, side: 'left' }, { idx: 3, side: 'right' }, { idx: 7, side: 'left' }] }
      const mid = sections(r)[1]
      const painted = paintMetres(r, mid.startM, mid.endM, 'left')!
      expect(painted.sideChanges).toEqual([{ idx: 0, side: 'left' }])
      expect(painted.points).toEqual(r.points)
    })

    it('joins the one before it, from its start to part way', () => {
      const r: Route = { ...road(11), sideChanges: [{ idx: 0, side: 'left' }, { idx: 3, side: 'right' }, { idx: 7, side: 'left' }] }
      const painted = paintMetres(r, 3 * M, 5 * M, 'left')!
      expect(painted.points).toEqual(r.points)
      expect(painted.sideChanges).toEqual([{ idx: 0, side: 'left' }, { idx: 5, side: 'right' }, { idx: 7, side: 'left' }])
    })

    it('can cross several sections, taking the place of the ones it covers', () => {
      const painted = paintMetres(three(), 300, 900, 'transit')!
      expect(sidesOf(painted)).toEqual(['both', 'transit', 'right'])
      const mid = sections(painted)[1]
      expect(mid.startM).toBeCloseTo(300, 1)
      expect(mid.endM).toBeCloseTo(900, 1)
    })
  })

  describe('painting it again', () => {
    it('is the same route the second time', () => {
      const once = paintMetres(flat(), 250, 640, 'left')!
      expect(paintMetres(once, 250, 640, 'left')).toEqual(once)
    })

    it('puts the sides back with another coat, though the points stay', () => {
      const once = paintMetres(flat(), 250, 640, 'left')!
      const back = paintMetres(once, 250, 640, 'both')!
      expect(back.sideChanges).toEqual([{ idx: 0, side: 'both' }])
      expect(back.points).toEqual(once.points)
    })

    it('can be a different stretch in the one before', () => {
      const once = paintMetres(flat(), 250, 640, 'left')!
      const more = paintMetres(once, 400, 900, 'right')!
      expect(sidesOf(more)).toEqual(['both', 'left', 'right', 'both'])
      expect(sections(more)[1].endM).toBeCloseTo(400, 1)
    })
  })

  describe('when there is nothing to paint', () => {
    it('refuses a stretch shorter than the least worth painting, and takes one of exactly that', () => {
      expect(PAINT_MIN_M).toBe(15)
      expect(paintMetres(flat(), 250, 264.9, 'left')).toBeNull()
      expect(paintMetres(flat(), 250, 265, 'left')).not.toBeNull()
    })

    it('refuses an empty or backwards stretch', () => {
      expect(paintMetres(flat(), 300, 300, 'left')).toBeNull()
      expect(paintMetres(flat(), 640, 250, 'left')).toBeNull()
    })

    it('refuses numbers that are not distances', () => {
      expect(paintMetres(flat(), Number.NaN, 640, 'left')).toBeNull()
      expect(paintMetres(flat(), 250, Number.NaN, 'left')).toBeNull()
      expect(paintMetres(flat(), Number.NaN, Number.NaN, 'left')).toBeNull()
    })

    it('refuses a route with no length', () => {
      const none: Route = { points: [], sideChanges: [], stops: [] }
      expect(paintMetres(none, 0, 100, 'left')).toBeNull()
      expect(paintMetres({ ...none, points: [pt(0)] }, 0, 100, 'left')).toBeNull()
      expect(paintMetres({ points: [pt(0), pt(0)], sideChanges: [{ idx: 0, side: 'both' }], stops: [] }, 0, 100, 'left')).toBeNull()
    })

    it('refuses a side that is not one', () => {
      expect(paintMetres(flat(), 250, 640, 'up' as unknown as Side)).toBeNull()
      expect(paintMetres(flat(), 250, 640, undefined as unknown as Side)).toBeNull()
    })

    it('counts only the part that is on the route', () => {
      const total = routeLength(flat().points)
      expect(paintMetres(flat(), total - 5, total + 100, 'left')).toBeNull()
      expect(paintMetres(flat(), -100, 5, 'left')).toBeNull()
      expect(paintMetres(flat(), -500, 100000, 'left')!.sideChanges).toEqual([{ idx: 0, side: 'left' }])
      expect(paintMetres(flat(), -Infinity, Infinity, 'left')!.sideChanges).toEqual([{ idx: 0, side: 'left' }])
      const tail = paintMetres(flat(), total - 20, total + 100, 'left')!
      expect(tail.sideChanges).toEqual([{ idx: 0, side: 'both' }, { idx: 10, side: 'left' }])
    })
  })

  describe('on a route with one segment', () => {
    const one = (): Route => ({ points: [pt(0), pt(1)], sideChanges: [{ idx: 0, side: 'both' }], stops: [] })

    it('splits the segment into three', () => {
      const r = paintMetres(one(), 30, 80, 'left')!
      expect(r.points).toHaveLength(4)
      expect(sidesOf(r)).toEqual(['both', 'left', 'both'])
      expect(sections(r)[1].startM).toBeCloseTo(30, 1)
      expect(sections(r)[1].endM).toBeCloseTo(80, 1)
    })

    it('paints the whole of it without adding a point', () => {
      const r = paintMetres(one(), 0, M, 'right')!
      expect(r.points).toEqual(one().points)
      expect(r.sideChanges).toEqual([{ idx: 0, side: 'right' }])
    })

    it('paints from the start, or to the end', () => {
      expect(paintMetres(one(), 0, 50, 'left')!.sideChanges).toEqual([{ idx: 0, side: 'left' }, { idx: 1, side: 'both' }])
      expect(paintMetres(one(), 50, M, 'left')!.sideChanges).toEqual([{ idx: 0, side: 'both' }, { idx: 1, side: 'left' }])
    })

    it('refuses what is under the least worth painting, and a segment that is itself too short', () => {
      expect(paintMetres(one(), 0, 14, 'left')).toBeNull()
      const stub: Route = { points: [pt(0), { lat: lat(10), lng: 0 }], sideChanges: [{ idx: 0, side: 'both' }], stops: [] }
      expect(paintMetres(stub, 0, 10, 'left')).toBeNull()
    })
  })

  describe('on a street driven twice', () => {
    /** Up 1.1 km and back down the very same line, both passes on the left. */
    const twice = (): Route => repeatSection({ ...road(11), sideChanges: [{ idx: 0, side: 'left' }] }, 0, 'back')!
    const turnAround = routeLength(road(11).points)

    it('has two passes with a section each', () => {
      expect(twice().sideChanges).toEqual([{ idx: 0, side: 'left' }, { idx: 10, side: 'left' }])
      expect(twice().points).toHaveLength(21)
    })

    it('paints the way back and leaves the way out alone', () => {
      const r = paintMetres(twice(), 1500, 1900, 'right')!
      expect(sidesOf(r)).toEqual(['left', 'left', 'right', 'left'])
      expect(r.sideChanges.slice(0, 2)).toEqual([{ idx: 0, side: 'left' }, { idx: 10, side: 'left' }])
      const secs = sections(r)
      expect(secs[2].startM).toBeCloseTo(1500, 1)
      expect(secs[2].endM).toBeCloseTo(1900, 1)
      for (let m = 0; m < turnAround - 1; m += 20) expect(sideAtMetre(r, m)).toBe('left')
    })

    it('paints the way out and leaves the way back alone', () => {
      const r = paintMetres(twice(), 200, 600, 'right')!
      expect(sidesOf(r)).toEqual(['left', 'right', 'left', 'left'])
      for (let m = turnAround + 1; m < 2 * turnAround; m += 20) expect(sideAtMetre(r, m)).toBe('left')
    })

    it('does not run the way back into the way out when the stretch starts at the turn', () => {
      const r = paintMetres(twice(), turnAround, turnAround + 300, 'left')!
      expect(r.sideChanges).toEqual([{ idx: 0, side: 'left' }, { idx: 10, side: 'left' }])
    })

    it('does not run the way out into the way back when the stretch ends at the turn', () => {
      const r = paintMetres(twice(), turnAround - 300, turnAround, 'left')!
      // A point went in before the turn, so the turn is one point later.
      expect(r.sideChanges).toEqual([{ idx: 0, side: 'left' }, { idx: 11, side: 'left' }])
    })

    it('keeps the turn between them when both passes end up the same side', () => {
      const r: Route = { ...twice(), sideChanges: [{ idx: 0, side: 'left' }, { idx: 10, side: 'right' }] }
      const up = paintMetres(r, turnAround - 300, turnAround, 'right')!
      // The end of the way out is now right, as is the way back: still two sections, split at the turn.
      expect(up.sideChanges).toEqual([{ idx: 0, side: 'left' }, { idx: 8, side: 'right' }, { idx: 11, side: 'right' }])
      const down = paintMetres(r, turnAround, turnAround + 300, 'left')!
      expect(down.sideChanges).toEqual([{ idx: 0, side: 'left' }, { idx: 10, side: 'left' }, { idx: 13, side: 'right' }])
    })

    it('painting the whole of the way back is what changing that section does', () => {
      const secs = sections(twice())
      const r = paintMetres(twice(), secs[1].startM, secs[1].endM, 'right')!
      expect(r.sideChanges).toEqual(setSectionSide(twice(), 1, 'right'))
      expect(r.points).toEqual(twice().points)
    })

    describe('with stops beside it', () => {
      const houses = (): Stop[] => [51.0023, 51.0055, 51.0077].map((l, i): Stop => ({ id: `h${i}`, type: i === 1 ? 'bundle' : 'nothrow', lat: l, lng: 0.00008, pathIdx: 0 }))
      const withHouses = (): Route => ({ ...twice(), stops: houses() })
      const keyed = (r: Route) => occurrences(r).map((o) => [o.key, o.at] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1))

      it('meets every stop at the same places, with the same keys, as before', () => {
        const before = keyed(withHouses())
        expect(before.map((x) => x[0])).toEqual(['h0', 'h0#2', 'h1', 'h1#2', 'h2', 'h2#2'])
        const after = keyed(paintMetres(withHouses(), 1500, 1900, 'right')!)
        expect(after.map((x) => x[0])).toEqual(before.map((x) => x[0]))
        after.forEach((x, i) => expect(Math.abs(x[1] - before[i][1]), x[0]).toBeLessThan(0.01))
      })

      it('keeps the keys, and the places to within the grid the road is walked in, wherever the stretch is', () => {
        const before = keyed(withHouses())
        const total = 2 * turnAround
        for (let from = 0; from < total - 20; from += 137) {
          for (const length of [16, 60, 400, 1500]) {
            const r = paintMetres(withHouses(), from, from + length, 'right')
            if (!r) continue
            const after = keyed(r)
            expect(after.map((x) => x[0]), `${from} ${length}`).toEqual(before.map((x) => x[0]))
            after.forEach((x, i) => expect(Math.abs(x[1] - before[i][1]), `${from} ${length} ${x[0]}`).toBeLessThan(3))
          }
        }
      })

      it('meets a stop that is off the road once, as before', () => {
        const base = withHouses()
        base.stops = [...base.stops, { id: 'far', type: 'nothrow', lat: 51.004, lng: 0.0004, pathIdx: 0 }]
        const before = occurrences(base).map((o) => o.key).sort()
        const after = occurrences(paintMetres(base, 100, 700, 'transit')!).map((o) => o.key).sort()
        expect(after).toEqual(before)
      })

      describe('near the end of a dead end', () => {
        const total = 2 * turnAround
        /** A no-throw house a couple of metres off the line, `back` metres short of where the road turns round. */
        const near = (back: number): Route => ({ ...twice(), stops: [house('end', turnAround - back, 0)] })
        /** How far up the road a place is, whichever pass it is on. */
        const upTheRoad = (at: number) => Math.min(at, total - at)
        const painted = (base: Route, run: (from: number, r: Route) => void) => {
          for (let from = 0; from < total - 20; from += 53) {
            const r = paintMetres(base, from, from + 20, 'transit')
            if (r) run(from, r)
          }
        }

        it('is met once within 30 m of the turn, both passes going by it as one', () => {
          for (const back of [5, 15, 25]) expect(occurrences(near(back)).map((o) => o.key), `${back}`).toEqual(['end'])
        })

        it('keeps its key and its place on the road, wherever the stretch is, though which pass it is met on can change', () => {
          // The two passes are the same distance from it, so the one that is nearer on the grid the road is walked in
          // is the one it is met on, and that grid moves with any point added, here as by adding one by hand.
          for (const back of [5, 15, 25]) {
            const base = near(back)
            const [was] = occurrences(base)
            painted(base, (from, r) => {
              const after = occurrences(r)
              expect(after.map((o) => o.key), `${back} ${from}`).toEqual(['end'])
              expect(Math.abs(upTheRoad(after[0].at) - upTheRoad(was.at)), `${back} ${from}`).toBeLessThan(3)
            })
          }
        })

        it('keeps the pass it is met on, and the place, when it is a good way short of the turn', () => {
          for (const back of [60, 100, 300]) {
            const base = near(back)
            const was = occurrences(base)
            expect(was.map((o) => o.key), `${back}`).toEqual(['end', 'end#2'])
            painted(base, (from, r) => {
              const after = occurrences(r)
              expect(after.map((o) => o.key), `${back} ${from}`).toEqual(['end', 'end#2'])
              after.forEach((o, i) => {
                expect(Math.abs(o.at - was[i].at), `${back} ${from} ${o.key}`).toBeLessThan(3)
                expect(o.at < turnAround, `${back} ${from} ${o.key}`).toBe(i === 0)
              })
            })
          }
        })
      })
    })
  })

  describe('changing only the stretch asked for', () => {
    it('leaves every part of the route outside it as it was, and paints every part inside', () => {
      const base: Route = { ...road(11), sideChanges: [{ idx: 0, side: 'both' }, { idx: 4, side: 'left' }, { idx: 8, side: 'right' }] }
      const total = routeLength(base.points)
      let painted = 0
      for (let from = 0; from < total - 30; from += 41) {
        for (const length of [15, 40, 150, 500, 900]) {
          for (const side of SIDES) {
            const r = paintMetres(base, from, from + length, side)
            if (!r) continue
            painted++
            for (let m = 0; m < total; m += 3.7) {
              if (m < from - 3.5 || m > from + length + 3.5) expect(sideAtMetre(r, m), `${from} ${length} ${side} at ${m}`).toBe(sideAtMetre(base, m))
              else if (m > from + 3.5 && m < from + length - 3.5) expect(sideAtMetre(r, m), `${from} ${length} ${side} at ${m}`).toBe(side)
            }
            expect(Math.abs(routeLength(r.points) - total)).toBeLessThan(0.01)
          }
        }
      }
      expect(painted).toBeGreaterThan(100)
    })
  })

  describe('with sides that mean nothing is thrown', () => {
    it('paints transit like any other side', () => {
      const r = paintMetres(flat(), 250, 640, 'transit')!
      expect(sidesOf(r)).toEqual(['both', 'transit', 'both'])
      expect(sideAt(r, 3)).toBe('transit')
      expect(sideAt(r, 2)).toBe('both')
    })
  })
})
