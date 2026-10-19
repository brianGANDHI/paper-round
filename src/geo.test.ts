import { describe, expect, it } from 'vitest'
import {
  alongPath,
  approachingOccurrences,
  byPosition,
  cumulativeDistances,
  distanceToPath,
  haversine,
  occurrences,
  POSITION_MAX_ACCURACY_M,
  offsetPath,
  sideAt,
  simplify,
  snapToPath,
  snapWithin,
  stopSide,
  type Occurrence,
} from './geo'
import type { Pt, Stop } from './types'

// ~111 m per 0.001 deg latitude. A straight north-south road.
const road: Pt[] = Array.from({ length: 11 }, (_, i) => ({ lat: 51 + i * 0.001, lng: 0 }))

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

/** A straight road north (11 points, about 111 m apart), then the same road south again. */
const outAndBack: Pt[] = [...road, ...road.slice(0, -1).reverse()]
const stopOnStreet = (id: string, lat: number, type: Stop['type'] = 'nothrow'): Stop => ({
  id,
  type,
  lat,
  lng: 0.0002, // about 14 m east of the road
  pathIdx: 0,
})

describe('a position on a road driven twice', () => {
  it('carries on along the pass it is on', () => {
    expect(snapToPath({ lat: 51.0035, lng: 0 }, outAndBack, 3)!.idx).toBe(3)
  })

  it('moves to the return pass after the turn, not back to the first', () => {
    // At the far end the driver turns round; the road is the same, but the way on is the return pass.
    const s = snapToPath({ lat: 51.0075, lng: 0 }, outAndBack, 9)!
    expect(s.idx).toBe(12)
    expect(s.point.lat).toBeCloseTo(51.0075, 4)
  })

  it('stays on the first pass while driving it, even though the return pass is just as close', () => {
    const s = snapToPath({ lat: 51.0045, lng: 0 }, outAndBack, 4)!
    expect(s.idx).toBe(4)
  })

  it('uses the direction of travel to pick the return pass straight after the turn', () => {
    // Just past the far end, heading south: the road is the same as the first pass, but this is the way back.
    const here = { lat: 51.0095, lng: 0 }
    expect(snapToPath(here, outAndBack, 9, 180)!.idx).toBe(10)
    expect(snapToPath(here, outAndBack, 9, 0)!.idx).toBe(9)
  })

  it('does the same when each pass is a single long segment', () => {
    const sparse: Pt[] = [{ lat: 51, lng: 0 }, { lat: 51.01, lng: 0 }, { lat: 51, lng: 0 }]
    const here = { lat: 51.007, lng: 0 }
    expect(snapToPath(here, sparse, 0, 0)!.idx).toBe(0)
    expect(snapToPath(here, sparse, 0, 180)!.idx).toBe(1)
  })

  it('ignores the direction when there is none yet, and never lets it pull a position off the road', () => {
    expect(snapToPath({ lat: 51.0035, lng: 0 }, road, 0, null)!.idx).toBe(3)
    // Heading the wrong way along a road driven once still snaps to that road.
    expect(snapToPath({ lat: 51.0035, lng: 0 }, road, 3, 180)!.idx).toBe(3)
  })

  it('can be asked about one pass only', () => {
    const tap = { lat: 51.0055, lng: 0.00001 }
    expect(snapWithin(tap, outAndBack, 0, 10)!.idx).toBe(5)
    expect(snapWithin(tap, outAndBack, 10, 20)!.idx).toBe(14)
  })
})

describe('along the route', () => {
  it('measures distance from the start, down to a point inside a segment', () => {
    const cum = cumulativeDistances(road)
    expect(alongPath(cum, 0, 0)).toBe(0)
    expect(alongPath(cum, 2, 0.5)).toBeCloseTo((cum[2] + cum[3]) / 2)
    expect(alongPath(cum, 10, 0)).toBeCloseTo(cum[10])
  })
})

describe('stops met along the route', () => {
  it('gives a stop on a route driven once a single occurrence, keyed by its id', () => {
    const occs = occurrences({ points: road, stops: [stopOnStreet('a', 51.0055)] })
    expect(occs).toHaveLength(1)
    expect(occs[0].key).toBe('a')
    expect(occs[0].idx).toBe(5)
  })

  it('gives a stop on a street driven twice an occurrence for each pass, in route order', () => {
    const occs = occurrences({ points: outAndBack, stops: [stopOnStreet('a', 51.0055)] })
    expect(occs.map((o) => [o.key, o.idx])).toEqual([
      ['a', 5],
      ['a#2', 14],
    ])
    expect(occs[1].at).toBeGreaterThan(occs[0].at)
  })

  it('counts a stop at the turning point once, because the two passes meet there', () => {
    const occs = occurrences({ points: outAndBack, stops: [stopOnStreet('end', 51.0099)] })
    expect(occs).toHaveLength(1)
  })

  it("doesn't count a street that merely runs close by as another pass", () => {
    // A second street 80 m away is much farther than the stop's own street.
    const l: Pt[] = [...road, { lat: 51.01, lng: 0.0011 }, { lat: 51.0, lng: 0.0011 }]
    const occs = occurrences({ points: l, stops: [stopOnStreet('a', 51.0055)] })
    expect(occs).toHaveLength(1)
  })

  it('has nothing to say without a route or stops', () => {
    expect(occurrences({ points: [], stops: [stopOnStreet('a', 51)] })).toEqual([])
    expect(occurrences({ points: road, stops: [] })).toEqual([])
  })
})

describe('stops on a road driven twice when it was drawn with only a few points', () => {
  // The road drawn as one long straight segment out and one back, so the passes meet at the far end.
  const sparse: Pt[] = [{ lat: 51, lng: 0 }, { lat: 51.01, lng: 0 }, { lat: 51, lng: 0 }]

  it('finds both passes even though each is a single segment', () => {
    const occs = occurrences({ points: sparse, stops: [stopOnStreet('mid', 51.005)] })
    expect(occs.map((o) => o.key)).toEqual(['mid', 'mid#2'])
    expect(occs[1].at - occs[0].at).toBeGreaterThan(1000)
  })

  it('finds both passes when the stop sits exactly on a point of the road', () => {
    const withMiddle: Pt[] = [{ lat: 51, lng: 0 }, { lat: 51.005, lng: 0 }, { lat: 51.01, lng: 0 }, { lat: 51.005, lng: 0 }, { lat: 51, lng: 0 }]
    const occs = occurrences({ points: withMiddle, stops: [stopOnStreet('on', 51.005)] })
    expect(occs.map((o) => o.key)).toEqual(['on', 'on#2'])
  })

  it('still counts a stop at the far end once', () => {
    expect(occurrences({ points: sparse, stops: [stopOnStreet('end', 51.0099)] })).toHaveLength(1)
  })

  it('still counts a stop on a road driven once, however long its segments', () => {
    const once: Pt[] = [{ lat: 51, lng: 0 }, { lat: 51.01, lng: 0 }]
    expect(occurrences({ points: once, stops: [stopOnStreet('only', 51.005)] })).toHaveLength(1)
  })
})

describe('approaching a stop on a street driven twice', () => {
  const route = { points: outAndBack, stops: [stopOnStreet('a', 51.0055), stopOnStreet('b', 51.0021, 'bundle')] }
  const occs = occurrences(route)
  const cum = cumulativeDistances(outAndBack)
  /** What the driver sees at `lat` on pass 1 (south = false) or pass 2 (south = true). */
  const at = (lat: number, south: boolean) => {
    const idx = south ? 10 + Math.floor((51.01 - lat) / 0.001) : Math.floor((lat - 51) / 0.001)
    const frac = south ? ((51.01 - lat) % 0.001) / 0.001 : ((lat - 51) % 0.001) / 0.001
    return alongPath(cum, idx, frac)
  }
  const keys = (list: { key: string }[]) => list.map((o) => o.key)
  const pos = (lat: number) => ({ lat, lng: 0 })

  it("doesn't warn until the stop is within the alert distance ahead", () => {
    expect(keys(approachingOccurrences(at(51.0035, false), pos(51.0035), occs, new Set()))).toEqual([])
    expect(keys(approachingOccurrences(at(51.0047, false), pos(51.0047), occs, new Set()))).toEqual(['a'])
  })

  it("doesn't warn about the return pass while still driving the first", () => {
    // Just past the stop on the way out: it is right beside the driver, but this pass is done with it.
    const found = approachingOccurrences(at(51.0062, false), pos(51.0062), occs, new Set(['a']))
    expect(keys(found)).not.toContain('a#2')
  })

  it('warns again on the way back, even though the first pass was handled', () => {
    const found = approachingOccurrences(at(51.0063, true), pos(51.0063), occs, new Set(['a']))
    expect(keys(found)).toEqual(['a#2'])
  })

  it('leaves out stops that are handled', () => {
    expect(keys(approachingOccurrences(at(51.0047, false), pos(51.0047), occs, new Set(['a'])))).toEqual([])
  })

  it('forgives a stop just behind the driver, but not one well behind', () => {
    const one = occurrences({ points: road, stops: [stopOnStreet('x', 51.005)] })
    const stopAt = one[0].at
    expect(approachingOccurrences(stopAt + 10, pos(51.0051), one, new Set())).toHaveLength(1)
    expect(approachingOccurrences(stopAt + 60, pos(51.0055), one, new Set())).toHaveLength(0)
  })

  it('warns for a bundle drop from farther away than for a no-throw house', () => {
    // Both are 133 m ahead: inside a bundle drop's 150 m, outside a no-throw's 100 m.
    const pair = occurrences({ points: outAndBack, stops: [stopOnStreet('bundle', 51.0021, 'bundle'), stopOnStreet('house', 51.0021)] })
    const found = approachingOccurrences(at(51.0009, false), pos(51.0009), pair, new Set())
    expect(keys(found)).toEqual(['bundle'])
  })

  it('warns for a special request from as far away as for a bundle drop', () => {
    const pair = occurrences({ points: outAndBack, stops: [stopOnStreet('request', 51.0021, 'request'), stopOnStreet('house', 51.0021)] })
    const found = approachingOccurrences(at(51.0009, false), pos(51.0009), pair, new Set())
    expect(keys(found)).toEqual(['request'])
  })
})

describe('drawing a pass beside the road it repeats', () => {
  const east = (m: number) => m / 70050 // degrees of longitude in m metres, at this latitude

  it("shifts a path to the right of the way it's heading", () => {
    const shifted = offsetPath(road, 10)
    for (const [i, q] of shifted.entries()) {
      expect(q.lat).toBeCloseTo(road[i].lat, 6)
      expect(q.lng - road[i].lng).toBeCloseTo(east(10), 6)
    }
  })

  it('puts the return pass on the other side of the same road', () => {
    const back = [...road].reverse()
    const shifted = offsetPath(back, 10)
    expect(shifted[0].lng - back[0].lng).toBeCloseTo(-east(10), 6)
  })

  it('shifts left for a negative amount, and leaves a path alone for none', () => {
    expect(offsetPath(road, -10)[3].lng).toBeLessThan(road[3].lng)
    expect(offsetPath(road, 0)).toBe(road)
  })

  it('keeps a corner joined without spiking outwards', () => {
    const corner: Pt[] = [
      { lat: 51, lng: 0 },
      { lat: 51.001, lng: 0 },
      { lat: 51.001, lng: 0.001 },
    ]
    const shifted = offsetPath(corner, 10)
    const fromCorner = haversine(shifted[1], corner[1])
    expect(fromCorner).toBeGreaterThanOrEqual(10)
    expect(fromCorner).toBeLessThanOrEqual(20)
  })

  it('copes with repeated points and with too few points', () => {
    const dupes: Pt[] = [road[0], road[0], road[1]]
    expect(() => offsetPath(dupes, 5)).not.toThrow()
    expect(offsetPath([road[0]], 5)).toHaveLength(1)
  })

  it('measures how far a position is from a path', () => {
    expect(distanceToPath({ lat: 51.0055, lng: 0.0002 }, road)).toBeCloseTo(14, 0)
    expect(distanceToPath({ lat: 51, lng: 0 }, [])).toBe(Infinity)
  })
})

describe('which side of the road a stop is on', () => {
  // The road runs north, so a stop at a positive longitude is to its east. 0.0001 degrees of
  // longitude is about 7 m here.
  const beside = (lat: number, lng: number): Pt => ({ lat, lng })
  const south = [...road].reverse()

  it('is the right for a stop to the east of a road heading north, and the left for one to the west', () => {
    expect(stopSide(road, 4, beside(51.0045, 0.0002))).toBe('right')
    expect(stopSide(road, 4, beside(51.0045, -0.0002))).toBe('left')
  })

  it('swaps when the same road is driven the other way', () => {
    // Reversed, segment 5 runs from 51.005 down to 51.004.
    expect(stopSide(south, 5, beside(51.0045, 0.0002))).toBe('left')
    expect(stopSide(south, 5, beside(51.0045, -0.0002))).toBe('right')
  })

  it('goes by the heading of the road, so for one heading east the north side is the left', () => {
    const east = Array.from({ length: 5 }, (_, i) => ({ lat: 51, lng: i * 0.001 }))
    expect(stopSide(east, 2, beside(51.0001, 0.0025))).toBe('left')
    expect(stopSide(east, 2, beside(50.9999, 0.0025))).toBe('right')
  })

  it('says nothing for a stop on the line of the road itself', () => {
    expect(stopSide(road, 4, beside(51.0045, 0))).toBeNull()
    // 1.4 m off is still on the line, 4.9 m off is beside it.
    expect(stopSide(road, 4, beside(51.0045, 0.00002))).toBeNull()
    expect(stopSide(road, 4, beside(51.0045, 0.00007))).toBe('right')
  })

  it('uses the segment it is given at a corner', () => {
    // North for 100 m, then east. The stop is inside the turn: east of the first leg, south of the second.
    const corner: Pt[] = [
      { lat: 51, lng: 0 },
      { lat: 51.0009, lng: 0 },
      { lat: 51.0009, lng: 0.0014 },
    ]
    const inside = beside(51.0007, 0.0001)
    expect(stopSide(corner, 0, inside)).toBe('right')
    expect(stopSide(corner, 1, inside)).toBe('right')
    // Outside the turn it is on the left of both.
    const outside = beside(51.0011, -0.0001)
    expect(stopSide(corner, 0, outside)).toBe('left')
    expect(stopSide(corner, 1, outside)).toBe('left')
  })

  it('has no answer without a segment to go by', () => {
    const stop = beside(51.0045, 0.0002)
    expect(stopSide(road, 10, stop)).toBeNull()
    expect(stopSide(road, -1, stop)).toBeNull()
    expect(stopSide([], 0, stop)).toBeNull()
    expect(stopSide([road[0], road[0]], 0, stop)).toBeNull()
  })
})

describe('a small alert zone', () => {
  const stop: Stop = { id: 's', type: 'nothrow', pathIdx: 0, lat: 51.005, lng: 0 }
  const o: Occurrence = { key: 's', stop, idx: 4, at: 500, off: 0 }
  const here: Pt = { lat: 51.005, lng: 0 }
  const zone = (m: number) => ({ nothrow: m, bundle: m, request: m })

  it('does not alert for a stop already further behind than the zone reaches', () => {
    // 15 m past the stop: inside a zone of 20 m or more, outside one of 10 m.
    expect(approachingOccurrences(515, here, [o], new Set(), zone(10))).toHaveLength(0)
    expect(approachingOccurrences(515, here, [o], new Set(), zone(20))).toHaveLength(1)
  })

  it('still alerts for a stop just behind, within the zone', () => {
    expect(approachingOccurrences(510, here, [o], new Set(), zone(10))).toHaveLength(1)
    expect(approachingOccurrences(511, here, [o], new Set(), zone(10))).toHaveLength(0)
  })

  it('alerts only once the stop is within the zone ahead', () => {
    expect(approachingOccurrences(489, here, [o], new Set(), zone(10))).toHaveLength(0)
    expect(approachingOccurrences(491, here, [o], new Set(), zone(10))).toHaveLength(1)
  })
})

describe('the throw side along a route with transit in it', () => {
  it('is transit from where that stretch starts until the next change', () => {
    const r = { sideChanges: [{ idx: 0, side: 'both' as const }, { idx: 3, side: 'transit' as const }, { idx: 6, side: 'left' as const }] }
    expect([0, 2, 3, 5, 6, 9].map((i) => sideAt(r, i))).toEqual(['both', 'both', 'transit', 'transit', 'left', 'left'])
  })
})

describe('how far a stop is from the route', () => {
  const east = (m: number) => m / 70050 // degrees of longitude in m metres, at this latitude

  it('is given with every occurrence of a stop, as the distance to the nearest part of the route', () => {
    const near = occurrences({ points: road, stops: [{ ...stopOnStreet('a', 51.0055), lng: east(14) }] })
    expect(near[0].off).toBeCloseTo(14, 0)
    const far = occurrences({ points: road, stops: [{ ...stopOnStreet('b', 51.0055), lng: east(250) }] })
    expect(far[0].off).toBeCloseTo(250, 0)
  })

  it('is the same for each pass of a street driven twice', () => {
    const passes = occurrences({ points: outAndBack, stops: [{ ...stopOnStreet('a', 51.0055), lng: east(14) }] })
    expect(passes).toHaveLength(2)
    expect(passes[0].off).toBe(passes[1].off)
  })

  it('is zero for a stop on the line of the route', () => {
    expect(occurrences({ points: road, stops: [{ ...stopOnStreet('a', 51.0055), lng: 0 }] })[0].off).toBeCloseTo(0, 3)
  })
})

describe('stops that are met by where the driver is, not along the route', () => {
  const east = (m: number) => m / 70050
  const zone = (m: number) => ({ nothrow: m, bundle: m, request: m })
  const stopAtOff = (id: string, lat: number, offM: number, type: Stop['type'] = 'bundle'): Stop => ({
    id,
    type,
    pathIdx: 0,
    lat,
    lng: east(offM),
  })
  const keys = (list: { key: string }[]) => list.map((o) => o.key)

  it('are those further from the route than the alert distance and the slack beside it', () => {
    const [near, far] = occurrences({ points: road, stops: [stopAtOff('n', 51.005, 60), stopAtOff('f', 51.005, 80)] }).sort((a, b) => a.off - b.off)
    // 40 m zone: the route brings the driver near enough to a stop up to 70 m away.
    expect(byPosition(near, zone(40))).toBe(false)
    expect(byPosition(far, zone(40))).toBe(true)
    // A bigger zone reaches the further stop from the route too, and a smaller one lets go of the nearer.
    expect(byPosition(far, zone(60))).toBe(false)
    expect(byPosition(near, zone(10))).toBe(true)
  })

  it('go by the zone of their own kind of stop', () => {
    const [o] = occurrences({ points: road, stops: [stopAtOff('f', 51.005, 80)] })
    expect(byPosition(o, { nothrow: 60, bundle: 40, request: 40 })).toBe(true)
    expect(byPosition({ ...o, stop: { ...o.stop, type: 'nothrow' } }, { nothrow: 60, bundle: 40, request: 40 })).toBe(false)
  })

  it('alert when the driver is within the alert distance of them, wherever the driver is along the route', () => {
    const occs = occurrences({ points: road, stops: [stopAtOff('f', 51.005, 120)] })
    // 30 m from the stop, whether the driver is far from the part of the route it is beside or right at it.
    const close = { lat: 51.005, lng: east(150) }
    expect(keys(approachingOccurrences(1500, close, occs, new Set(), zone(40)))).toEqual(['f'])
    expect(keys(approachingOccurrences(0, close, occs, new Set(), zone(40)))).toEqual(['f'])
    expect(keys(approachingOccurrences(occs[0].at, close, occs, new Set(), zone(40)))).toEqual(['f'])
    // 50 m from it is outside the zone, wherever along the route the driver is.
    const outside = { lat: 51.005, lng: east(170) }
    expect(approachingOccurrences(0, outside, occs, new Set(), zone(40))).toHaveLength(0)
    expect(approachingOccurrences(occs[0].at, outside, occs, new Set(), zone(40))).toHaveLength(0)
  })

  it('do not alert further away than the alert distance, even for a driver on the route level with them', () => {
    const occs = occurrences({ points: road, stops: [stopAtOff('f', 51.005, 120)] })
    // On the road, level with the stop: 120 m away.
    expect(approachingOccurrences(occs[0].at, { lat: 51.005, lng: 0 }, occs, new Set(), zone(40))).toHaveLength(0)
    // 41 m away is outside a 40 m zone, and 39 m is inside it.
    expect(approachingOccurrences(occs[0].at, { lat: 51.005, lng: east(120 - 41) }, occs, new Set(), zone(40))).toHaveLength(0)
    expect(approachingOccurrences(occs[0].at, { lat: 51.005, lng: east(120 - 39) }, occs, new Set(), zone(40))).toHaveLength(1)
  })

  it('leave stops that are done alone', () => {
    const occs = occurrences({ points: road, stops: [stopAtOff('f', 51.005, 120)] })
    expect(approachingOccurrences(0, { lat: 51.005, lng: east(120) }, occs, new Set(['f']), zone(40))).toHaveLength(0)
  })

  it('are met one pass at a time, in order, when the route goes by them more than once', () => {
    const occs = occurrences({ points: outAndBack, stops: [stopAtOff('f', 51.005, 90)] })
    expect(keys(occs)).toEqual(['f', 'f#2'])
    const here = { lat: 51.005, lng: east(90) }
    expect(keys(approachingOccurrences(0, here, occs, new Set(), zone(40)))).toEqual(['f'])
    expect(keys(approachingOccurrences(0, here, occs, new Set(['f']), zone(40)))).toEqual(['f#2'])
    expect(keys(approachingOccurrences(0, here, occs, new Set(['f', 'f#2']), zone(40)))).toEqual([])
  })

  it('ignore a fix that is too uncertain to say the driver is near', () => {
    const occs = occurrences({ points: road, stops: [stopAtOff('f', 51.005, 120)] })
    const here = { lat: 51.005, lng: east(120) }
    expect(approachingOccurrences(0, here, occs, new Set(), zone(40), POSITION_MAX_ACCURACY_M)).toHaveLength(1)
    expect(approachingOccurrences(0, here, occs, new Set(), zone(40), POSITION_MAX_ACCURACY_M + 1)).toHaveLength(0)
  })

  it('leave stops along the route to the route, so a fix that is not good is no reason to miss them', () => {
    const occs = occurrences({ points: road, stops: [{ ...stopOnStreet('a', 51.005), lng: east(14) }] })
    expect(approachingOccurrences(occs[0].at - 20, { lat: 51.0048, lng: 0 }, occs, new Set(), zone(40), 500)).toHaveLength(1)
  })

  it('come with the nearest first, among stops of both kinds', () => {
    const occs = occurrences({
      points: road,
      stops: [stopAtOff('far', 51.005, 100), { ...stopAtOff('near', 51.0052, 100), type: 'nothrow' }],
    })
    const here = { lat: 51.0051, lng: east(100) }
    expect(keys(approachingOccurrences(0, here, occs, new Set(), zone(40)))).toEqual(['far', 'near'])
  })
})
