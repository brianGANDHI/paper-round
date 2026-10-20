import { describe, expect, it } from 'vitest'
import { alertable } from './alerts'
import { EXTENT_MERGE_M, EXTENT_MIN_M, sideChangeNote, sideExtents, type ExtentKey } from './driveEdit'
import { occurrences } from './geo'
import { paintMetres, sections, setSectionSide } from './routeEdit'
import type { Pt, Route, Side, Stop } from './types'

// A road running north through Sydney, so that a distance along it is just a latitude.
const ORIGIN: Pt = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
/** The spot `m` metres up the road, and `offsetM` metres east of it. */
const onRoad = (m: number, offsetM = 0): Pt => ({
  lat: ORIGIN.lat + m / M_PER_DEG,
  lng: ORIGIN.lng + offsetM / (M_PER_DEG * Math.cos((ORIGIN.lat * Math.PI) / 180)),
})
/** A route through the road at those distances, with a side on each segment. */
const built = (at: number[], sides: Side[], stops: Stop[] = []): Route => ({
  points: at.map((m) => onRoad(m)),
  sideChanges: sides.map((side, idx) => ({ idx, side })),
  stops,
})
const house = (id: string, m: number, type: Stop['type'] = 'nothrow', offsetM = 10): Stop => ({ id, type, ...onRoad(m, offsetM), pathIdx: 0 })
const turns = (...at: number[]) => at.map((x) => ({ at: x }))

type Found = ReturnType<typeof sideExtents>
/** What was offered, as [key, from, to] to the nearest metre. */
const spans = (f: Found) => f.extents.map((e) => [e.key, Math.round(e.fromM), Math.round(e.toM)])
const keys = (f: Found): ExtentKey[] => f.extents.map((e) => e.key)

/** The same numbers every run: a small seeded random number generator. */
function random(seed: number) {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('how far a change of side can reach, where the driver is', () => {
  // A stretch on the left from 1000 m to 4000 m, with a stretch on both sides before and after it.
  const route = built([0, 1000, 4000, 5000], ['both', 'left', 'both'])
  const oak = { name: 'Oak Estate', startM: 1500, endM: 3200 }

  it('has a least length and a closeness, as the sheet is told', () => {
    expect(EXTENT_MIN_M).toBe(15)
    expect(EXTENT_MERGE_M).toBe(25)
  })

  describe('the worked example', () => {
    const found = sideExtents(route, turns(1900, 2600), [oak], 2300)

    it('offers the street, the way to the turn, the named section, the way to the end and the whole stretch, in that order', () => {
      expect(spans(found)).toEqual([
        ['street', 1900, 2600],
        ['toTurn', 2300, 2600],
        ['section', 1500, 3200],
        ['toStretchEnd', 2300, 4000],
        ['stretch', 1000, 4000],
      ])
    })

    it('says which stretch it is, and the side it has', () => {
      expect(found.stretch?.side).toBe('left')
      expect(found.stretch?.startM).toBeCloseTo(1000, 6)
      expect(found.stretch?.endM).toBeCloseTo(4000, 6)
    })

    it('words each one plainly, and the first by what it reaches', () => {
      expect(found.extents.map((e) => e.label)).toEqual([
        'From the last turn to the next turn',
        'To the next turn',
        'This named section: Oak Estate',
        'To the end of this stretch',
        'The whole stretch',
      ])
    })

    it('gives each one its length, and says the whole stretch is the entire one', () => {
      expect(found.extents.map((e) => e.detail)).toEqual(['700 m', '300 m', '1.7 km', '1.7 km', '3.0 km, the entire left stretch'])
    })

    it('has the exact ends it paints, as numbers', () => {
      expect(found.extents[0].fromM).toBe(1900)
      expect(found.extents[0].toM).toBe(2600)
      expect(found.extents[1].fromM).toBe(2300)
      expect(found.extents[2].fromM).toBe(1500)
      expect(found.extents[2].toM).toBe(3200)
    })
  })

  describe('which stretch the driver is on', () => {
    const secs = sections(route)

    it('is the one they are in', () => {
      expect(sideExtents(route, [], [], 500).stretch?.side).toBe('both')
      expect(sideExtents(route, [], [], 2300).stretch?.side).toBe('left')
      expect(sideExtents(route, [], [], 4500).stretch?.side).toBe('both')
    })

    it('has the start of a stretch belong to that stretch, and the end of one to the next', () => {
      expect(sideExtents(route, [], [], secs[1].startM).stretch?.startM).toBe(secs[1].startM)
      expect(sideExtents(route, [], [], secs[1].startM - 0.01).stretch?.endM).toBe(secs[1].startM)
      expect(sideExtents(route, [], [], secs[1].endM).stretch?.startM).toBe(secs[2].startM)
      expect(sideExtents(route, [], [], secs[1].endM - 0.01).stretch?.startM).toBe(secs[1].startM)
    })

    it('is the last at the end of the route and past it, and the first at the start of it and before it', () => {
      expect(sideExtents(route, [], [], secs[2].endM).stretch?.startM).toBe(secs[2].startM)
      expect(sideExtents(route, [], [], 99999).stretch?.startM).toBe(secs[2].startM)
      expect(sideExtents(route, [], [], 0).stretch?.startM).toBe(0)
      expect(sideExtents(route, [], [], -40).stretch?.startM).toBe(0)
    })

    it('is none for a distance that is not one', () => {
      for (const along of [Number.NaN, Infinity, -Infinity]) expect(sideExtents(route, turns(1900), [oak], along)).toEqual({ stretch: null, extents: [] })
    })

    it('is none for a route with no stretches', () => {
      const none: Route = { points: [], sideChanges: [], stops: [] }
      expect(sideExtents(none, [], [], 0)).toEqual({ stretch: null, extents: [] })
      expect(sideExtents({ ...none, points: [onRoad(0)] }, [], [], 0)).toEqual({ stretch: null, extents: [] })
    })
  })

  describe('kept inside the stretch', () => {
    it('leaves the street out, being the stretch, when the turns are beyond it', () => {
      const found = sideExtents(route, turns(800, 4400), [], 2300)
      expect(spans(found)).toEqual([
        ['toStretchEnd', 2300, 4000],
        ['stretch', 1000, 4000],
      ])
    })

    it('leaves the street out, being the stretch, when there are no turns at all', () => {
      expect(spans(sideExtents(route, [], [], 2300))).toEqual([
        ['toStretchEnd', 2300, 4000],
        ['stretch', 1000, 4000],
      ])
    })

    it('uses a turn inside the stretch on either side of the driver and ignores the ones outside', () => {
      expect(spans(sideExtents(route, turns(500, 1900, 2600, 3400, 4600), [], 2300))[0]).toEqual(['street', 1900, 2600])
      expect(spans(sideExtents(route, turns(500, 1900, 4600), [], 2300))[0]).toEqual(['street', 1900, 4000])
      expect(spans(sideExtents(route, turns(500, 2600, 4600), [], 2300))[0]).toEqual(['street', 1000, 2600])
    })

    it('uses the nearest turns each side, not the first or last', () => {
      expect(spans(sideExtents(route, turns(1100, 1500, 1900, 2600, 3000, 3900), [], 2300))[0]).toEqual(['street', 1900, 2600])
    })

    it('takes a named section only as far as the stretch', () => {
      const wide = { name: 'Whole Estate', startM: 500, endM: 3500 }
      const found = sideExtents(route, turns(1900, 2600), [wide], 2300)
      expect(spans(found)).toEqual([
        ['street', 1900, 2600],
        ['toTurn', 2300, 2600],
        ['section', 1000, 3500],
        ['toStretchEnd', 2300, 4000],
        ['stretch', 1000, 4000],
      ])
      expect(found.extents[2].detail).toBe('2.5 km, just the part of it in this stretch')
      expect(found.extents[2].label).toBe('This named section: Whole Estate')
    })

    it('takes a named section that only runs over one end of the stretch', () => {
      const found = sideExtents(route, turns(1900, 2600), [{ name: 'West End', startM: 200, endM: 2800 }], 2300)
      expect(found.extents[2]).toMatchObject({ key: 'section', label: 'This named section: West End', detail: '1.8 km, just the part of it in this stretch' })
      expect(found.extents[2].fromM).toBeCloseTo(1000, 6)
      expect(found.extents[2].toM).toBe(2800)
      const other = sideExtents(route, turns(1900, 2600), [{ name: 'East End', startM: 2000, endM: 4800 }], 2300)
      expect(other.extents[2]).toMatchObject({ key: 'section', detail: '2.0 km, just the part of it in this stretch' })
      expect(other.extents[2].toM).toBeCloseTo(4000, 6)
    })

    it('does not say a section is cut when it is not, even by a hair', () => {
      expect(sideExtents(route, turns(1900, 2600), [oak], 2300).extents[2].detail).toBe('1.7 km')
      const [, mid] = sections(route)
      const detail = (startM: number, endM: number) => sideExtents(route, turns(1900, 2600), [{ name: 'N', startM, endM }], 2300).extents.find((e) => e.key === 'section')?.detail
      // It starts a hair short of the start of the stretch, or a bit more.
      expect(detail(mid.startM - 0.005, 3000)).toBe('2.0 km')
      expect(detail(mid.startM - 0.05, 3000)).toBe('2.0 km, just the part of it in this stretch')
      // It ends a hair past the end of the stretch, or a bit more.
      expect(detail(1500, mid.endM + 0.005)).toBe('2.5 km')
      expect(detail(1500, mid.endM + 0.05)).toBe('2.5 km, just the part of it in this stretch')
    })
  })

  describe('the named section', () => {
    it('is not offered when there are none, or none is where the driver is', () => {
      expect(keys(sideExtents(route, turns(1900, 2600), [], 2300))).not.toContain('section')
      expect(keys(sideExtents(route, turns(1900, 2600), [{ name: 'Far', startM: 3000, endM: 3500 }], 2300))).not.toContain('section')
      expect(keys(sideExtents(route, turns(1900, 2600), [{ name: 'Behind', startM: 1100, endM: 2200 }], 2300))).not.toContain('section')
    })

    it('starts at the start of a section and stops short of its end', () => {
      expect(keys(sideExtents(route, turns(1900, 2600), [{ name: 'Here', startM: 2300, endM: 3000 }], 2300))).toContain('section')
      expect(keys(sideExtents(route, turns(1900, 2600), [{ name: 'Gone', startM: 1500, endM: 2300 }], 2300))).not.toContain('section')
    })

    it('is the later of two that meet where the driver is', () => {
      const found = sideExtents(route, turns(1900, 2600), [{ name: 'Before', startM: 1500, endM: 2300 }, { name: 'After', startM: 2300, endM: 3200 }], 2300)
      expect(found.extents.find((e) => e.key === 'section')?.label).toBe('This named section: After')
    })

    it('does not offer the lead-in that was never named', () => {
      const lead = { name: 'Start of route', startM: 0, endM: 1500, lead: true }
      expect(keys(sideExtents(route, turns(1900, 2600), [lead], 1200))).not.toContain('section')
      const named = { name: 'Early', startM: 0, endM: 1500, lead: false }
      expect(keys(sideExtents(route, turns(1900, 2600), [named], 1200))).toContain('section')
    })

    it('can be the last, at the very end of the route', () => {
      const end = sections(route)[2].endM
      for (const along of [end, end + 100]) {
        const found = sideExtents(route, [], [{ name: 'Last', startM: 4500, endM: end }], along)
        expect(spans(found)).toEqual([
          ['section', 4500, 5000],
          ['stretch', 4000, 5000],
        ])
      }
    })

    it('can be the last when its end is a hair short of the end of the route, but not when it is a good way short', () => {
      const end = sections(route)[2].endM
      expect(keys(sideExtents(route, [], [{ name: 'Last', startM: 4500, endM: end - 1e-7 }], end))).toContain('section')
      expect(keys(sideExtents(route, [], [{ name: 'Last', startM: 4500, endM: end - 0.1 }], end))).not.toContain('section')
    })

    it('does not run on past its own end when the driver is not at the end of the route', () => {
      expect(keys(sideExtents(route, [], [{ name: 'Mid', startM: 4100, endM: 4500 }], 4500))).not.toContain('section')
    })

    it('is ignored when its numbers are not', () => {
      const junk = [{ name: 'A', startM: Number.NaN, endM: 3000 }, { name: 'B', startM: 1500, endM: Infinity }, { name: 'C', startM: 1500, endM: Number.NaN }, { name: 'D', startM: -Infinity, endM: 3000 }]
      expect(keys(sideExtents(route, turns(1900, 2600), junk, 2300))).not.toContain('section')
    })
  })

  describe('the turns', () => {
    it('are used in any order, and ones that are not places are ignored', () => {
      const a = sideExtents(route, turns(1900, 2600), [], 2300)
      expect(spans(sideExtents(route, turns(2600, 1900, 1900, Number.NaN, Infinity), [], 2300))).toEqual(spans(a))
    })

    it('count a turn right where the driver is as behind them', () => {
      expect(spans(sideExtents(route, turns(2300, 2600), [], 2300))).toEqual([
        ['street', 2300, 2600],
        ['toStretchEnd', 2300, 4000],
        ['stretch', 1000, 4000],
      ])
    })

    it('offer the way to the next turn only when there is one in the stretch', () => {
      // A turn beyond the end of the stretch, or exactly at it, is not in it.
      expect(keys(sideExtents(route, turns(1900, 4600), [], 2300))).not.toContain('toTurn')
      expect(keys(sideExtents(route, turns(1900, sections(route)[1].endM), [], 2300))).not.toContain('toTurn')
      expect(keys(sideExtents(route, turns(1900, 3999), [], 2300))).toContain('toTurn')
      // And a turn behind the driver is not the next.
      expect(keys(sideExtents(route, turns(1900), [], 2300))).not.toContain('toTurn')
    })

    it('count a turn just ahead of the driver as ahead', () => {
      expect(spans(sideExtents(route, turns(2300.01), [], 2300))).toEqual([
        ['street', 1000, 2300],
        ['toStretchEnd', 2300, 4000],
        ['stretch', 1000, 4000],
      ])
    })
  })

  describe('the ones that are left out', () => {
    it('are the ones too short to be worth it, which is under 15 m', () => {
      // The next turn is 15 m ahead, or just under.
      expect(keys(sideExtents(route, turns(2615), [], 2600))).toContain('toTurn')
      expect(keys(sideExtents(route, turns(2614.9), [], 2600))).not.toContain('toTurn')
      // A street of 15 m.
      expect(spans(sideExtents(route, turns(2590, 2605), [], 2600))[0]).toEqual(['street', 2590, 2605])
      expect(spans(sideExtents(route, turns(2590.1, 2605), [], 2600))[0]).not.toEqual(['street', 2590, 2605])
      expect(keys(sideExtents(route, turns(2590.1, 2605), [], 2600))).not.toContain('street')
      // A named section of 15 m.
      expect(keys(sideExtents(route, turns(1900, 2600), [{ name: 'S', startM: 2290, endM: 2305 }], 2300))).toContain('section')
      expect(keys(sideExtents(route, turns(1900, 2600), [{ name: 'S', startM: 2290, endM: 2304.9 }], 2300))).not.toContain('section')
    })

    it('include the way to the end of the stretch when it is long enough, and not when the driver is almost there', () => {
      const secs = sections(route)
      expect(keys(sideExtents(route, turns(1900, 2600), [], secs[1].endM - 20))).toContain('toStretchEnd')
      expect(keys(sideExtents(route, turns(1900, 2600), [], secs[1].endM - 10))).not.toContain('toStretchEnd')
    })

    it('are the ones that nearly repeat an earlier one: both ends within 25 m', () => {
      // The way to the turn is the street, less 25 m at the start.
      expect(keys(sideExtents(route, turns(1900, 2600), [], 1925))).not.toContain('toTurn')
      expect(keys(sideExtents(route, turns(1900, 2600), [], 1925.5))).toContain('toTurn')
      expect(keys(sideExtents(route, turns(1900, 2600), [], 1900))).not.toContain('toTurn')
      // A named section that is the street less 25 m at both ends, or at each end alone, or more.
      const named = (startM: number, endM: number) => sideExtents(route, turns(1900, 2600), [{ name: 'N', startM, endM }], 2300)
      expect(keys(named(1925, 2575))).not.toContain('section')
      expect(keys(named(1875, 2625))).not.toContain('section')
      expect(keys(named(1925, 2574))).toContain('section')
      expect(keys(named(1926, 2575))).toContain('section')
      expect(keys(named(1874, 2625))).toContain('section')
      expect(keys(named(1875, 2626))).toContain('section')
    })

    it('are compared with the ones that are shown, in the order they come', () => {
      // Everything here is the whole of one stretch, which the driver is almost at the start of: the way on is shown and the whole stretch is not.
      const plain = built([0, 500], ['both'])
      expect(spans(sideExtents(plain, [], [], 10))).toEqual([['toStretchEnd', 10, 500]])
      // A little further on, it is not the same.
      expect(spans(sideExtents(plain, [], [], 30))).toEqual([
        ['toStretchEnd', 30, 500],
        ['stretch', 0, 500],
      ])
    })

    it('leave the street out, and keep the whole stretch, when the street is the whole of it', () => {
      const found = sideExtents(route, [], [], 2300)
      expect(keys(found)).toEqual(['toStretchEnd', 'stretch'])
      expect(found.extents[1].detail).toBe('3.0 km, the entire left stretch')
    })
  })

  describe('on a route that is a single segment', () => {
    const one = built([0, 400], ['right'])

    it('offers the way on from where the driver is, and the whole of it', () => {
      expect(spans(sideExtents(one, [], [], 100))).toEqual([
        ['toStretchEnd', 100, 400],
        ['stretch', 0, 400],
      ])
    })

    it('offers the way to a turn in it as well', () => {
      expect(spans(sideExtents(one, turns(250), [], 100))).toEqual([
        ['street', 0, 250],
        ['toTurn', 100, 250],
        ['toStretchEnd', 100, 400],
        ['stretch', 0, 400],
      ])
    })

    it('leaves out the way on when the driver is almost at the end, and the whole of it when they are at the start', () => {
      expect(spans(sideExtents(one, [], [], 395))).toEqual([['stretch', 0, 400]])
      expect(spans(sideExtents(one, [], [], 400))).toEqual([['stretch', 0, 400]])
      expect(spans(sideExtents(one, [], [], 0))).toEqual([['toStretchEnd', 0, 400]])
    })

    it('offers nothing for a segment too short to be worth painting', () => {
      const stub = built([0, 10], ['right'])
      const found = sideExtents(stub, [], [], 5)
      expect(found.extents).toEqual([])
      expect(found.stretch).toMatchObject({ side: 'right' })
    })

    it('offers the segment alone when it is the same length as the least', () => {
      expect(keys(sideExtents(built([0, 15.5], ['left']), [], [], 5))).toEqual(['stretch'])
      expect(keys(sideExtents(built([0, 14.5], ['left']), [], [], 5))).toEqual([])
    })
  })

  describe('at the ends of the route', () => {
    it('starts the street at the start of the route for the first stretch', () => {
      expect(spans(sideExtents(route, turns(600), [], 300))).toEqual([
        ['street', 0, 600],
        ['toTurn', 300, 600],
        ['toStretchEnd', 300, 1000],
        ['stretch', 0, 1000],
      ])
    })

    it('ends the street at the end of the route for the last stretch', () => {
      expect(spans(sideExtents(route, turns(4300), [], 4600))).toEqual([
        ['street', 4300, 5000],
        ['toStretchEnd', 4600, 5000],
        ['stretch', 4000, 5000],
      ])
    })

    it('treats a position past the end of the route as at the end of it', () => {
      const end = sections(route)[2].endM
      // The turns past the end are not behind the driver, whose position is the end.
      expect(spans(sideExtents(route, turns(4300, end + 50), [], end + 100))).toEqual([
        ['street', 4300, 5000],
        ['stretch', 4000, 5000],
      ])
    })

    it('has nothing to go on to at the very end', () => {
      expect(spans(sideExtents(route, turns(4300), [], 5000))).toEqual([
        ['street', 4300, 5000],
        ['stretch', 4000, 5000],
      ])
    })
  })

  describe('worded for the side the stretch has', () => {
    it('says which, for each', () => {
      const entire = (side: Side) =>
        sideExtents(built([0, 1000, 4000, 5000], ['both', side, 'both']), turns(1900, 2600), [oak], 2300).extents.find((e) => e.key === 'stretch')!.detail
      expect(entire('left')).toBe('3.0 km, the entire left stretch')
      expect(entire('right')).toBe('3.0 km, the entire right stretch')
      expect(entire('transit')).toBe('3.0 km, the entire transit stretch')
      // A stretch with the same side as its neighbours is still its own stretch.
      expect(entire('both')).toBe('3.0 km, the entire both-sides stretch')
    })

    it('says it for the whole stretch alone', () => {
      for (const e of sideExtents(route, turns(1900, 2600), [oak], 2300).extents) expect(e.detail.includes('entire'), e.key).toBe(e.key === 'stretch')
    })
  })

  describe('whatever the route and the turns', () => {
    const order: ExtentKey[] = ['street', 'toTurn', 'section', 'toStretchEnd', 'stretch']

    it('only offers what is inside the stretch, around the driver, long enough and different from each other', () => {
      const r = random(11)
      const sides: Side[] = ['both', 'left', 'right', 'transit']
      let offered = 0
      for (let n = 0; n < 400; n++) {
        const count = 2 + Math.floor(r() * 6)
        const at = [0]
        for (let i = 1; i < count; i++) at.push(at[i - 1] + 5 + r() * 900)
        const total = at[at.length - 1]
        const rt = built(at, at.slice(1).map(() => sides[Math.floor(r() * 4)]))
        const tn = Array.from({ length: Math.floor(r() * 8) }, () => ({ at: r() * (total + 200) - 100 }))
        const nm = Array.from({ length: Math.floor(r() * 3) }, (_, i) => {
          const s = r() * total
          return { name: `N${i}`, startM: s, endM: s + r() * total, lead: r() < 0.2 }
        })
        const along = r() * (total + 100) - 50
        const found = sideExtents(rt, tn, nm, along)
        const stretch = found.stretch!
        expect(stretch, `${n}`).not.toBeNull()
        const here = Math.min(Math.max(along, stretch.startM), stretch.endM)
        let last = -1
        found.extents.forEach((e, i) => {
          offered++
          expect(e.fromM, `${n} ${e.key}`).toBeGreaterThanOrEqual(stretch.startM - 1e-9)
          expect(e.toM, `${n} ${e.key}`).toBeLessThanOrEqual(stretch.endM + 1e-9)
          expect(e.toM - e.fromM, `${n} ${e.key}`).toBeGreaterThanOrEqual(EXTENT_MIN_M)
          expect(e.fromM, `${n} ${e.key}`).toBeLessThanOrEqual(here + 1e-9)
          expect(e.toM, `${n} ${e.key}`).toBeGreaterThanOrEqual(here - 1e-9)
          expect(order.indexOf(e.key), `${n}`).toBeGreaterThan(last)
          last = order.indexOf(e.key)
          expect(e.label.length).toBeGreaterThan(0)
          expect(e.detail.length).toBeGreaterThan(0)
          for (const o of found.extents.slice(0, i)) {
            expect(Math.abs(o.fromM - e.fromM) <= EXTENT_MERGE_M && Math.abs(o.toM - e.toM) <= EXTENT_MERGE_M, `${n} ${o.key} ${e.key}`).toBe(false)
          }
          // And each can be painted, as it is.
          expect(paintMetres(rt, e.fromM, e.toM, 'right'), `${n} ${e.key}`).not.toBeNull()
        })
      }
      expect(offered).toBeGreaterThan(400)
    })
  })

  describe('painted, each one changes only the part it says', () => {
    const sideAtMetre = (r: Route, m: number): Side => (sections(r).find((s) => m < s.endM) ?? sections(r).at(-1)!).side
    const found = sideExtents(route, turns(1900, 2600), [oak], 2300)

    for (const key of ['street', 'toTurn', 'section', 'toStretchEnd', 'stretch'] as const) {
      it(`${key}`, () => {
        const e = found.extents.find((x) => x.key === key)!
        const after = paintMetres(route, e.fromM, e.toM, 'right')!
        for (let m = 0; m < 5000; m += 7.3) {
          if (m < e.fromM - 3.5 || m > e.toM + 3.5) expect(sideAtMetre(after, m), `${m}`).toBe(sideAtMetre(route, m))
          else if (m > e.fromM + 3.5 && m < e.toM - 3.5) expect(sideAtMetre(after, m), `${m}`).toBe('right')
        }
      })
    }

    it('and only the whole stretch changes the whole of it', () => {
      for (const e of found.extents) {
        const after = paintMetres(route, e.fromM, e.toM, 'right')!
        const stillLeft = [1020, 1900, 2300, 3000, 3980].some((m) => sideAtMetre(after, m) === 'left')
        expect(stillLeft, e.key).toBe(e.key !== 'stretch')
      }
    })

    it('and the whole stretch is just what changing the side of that section does', () => {
      const whole = found.extents.find((x) => x.key === 'stretch')!
      const after = paintMetres(route, whole.fromM, whole.toM, 'right')!
      expect(after.points).toEqual(route.points)
      expect(after.sideChanges).toEqual(setSectionSide(route, 1, 'right'))
    })
  })
})

describe('what a change of side does to the no-throw houses', () => {
  // The same road, 1000 m of both sides, 3000 m on the left, 1000 m of both sides, with houses beside it.
  const withHouses = (...stops: Stop[]) => built([0, 1000, 4000, 5000], ['both', 'left', 'both'], stops)
  const two = () => withHouses(house('a', 1500), house('b', 2500), house('bundle', 2000, 'bundle'), house('ask', 2100, 'request'))

  it('says how many will stay quiet once the stretch is transit', () => {
    const before = two()
    expect(sideChangeNote(before, paintMetres(before, 1200, 2800, 'transit')!)).toBe('2 no-throw houses will now stay quiet')
    expect(sideChangeNote(before, paintMetres(before, 1400, 1600, 'transit')!)).toBe('1 no-throw house will now stay quiet')
  })

  it('says how many will alert again once the stretch is thrown', () => {
    const quiet = paintMetres(two(), 1200, 2800, 'transit')!
    expect(sideChangeNote(quiet, paintMetres(quiet, 1200, 2800, 'left')!)).toBe('2 no-throw houses will now alert')
    expect(sideChangeNote(quiet, paintMetres(quiet, 2200, 2800, 'both')!)).toBe('1 no-throw house will now alert')
  })

  it('is the other way round going back, which is what undoing is', () => {
    const before = two()
    const after = paintMetres(before, 1200, 2800, 'transit')!
    expect(sideChangeNote(after, before)).toBe('2 no-throw houses will now alert')
  })

  it('says nothing when none changes', () => {
    const before = two()
    expect(sideChangeNote(before, before)).toBeNull()
    // A stretch with no house beside it.
    expect(sideChangeNote(before, paintMetres(before, 3000, 3500, 'transit')!)).toBeNull()
    // Another side that is still thrown.
    expect(sideChangeNote(before, paintMetres(before, 1200, 2800, 'right')!)).toBeNull()
    // Houses that were quiet already.
    const quiet = paintMetres(before, 1200, 2800, 'transit')!
    expect(sideChangeNote(quiet, paintMetres(quiet, 1300, 2700, 'transit')!)).toBeNull()
    // Left to right does not wake the houses either.
    expect(sideChangeNote(before, paintMetres(before, 1200, 2800, 'both')!)).toBeNull()
  })

  it('does not count a bundle drop or a special request, which alert on transit as anywhere', () => {
    const before = withHouses(house('bundle', 2000, 'bundle'), house('ask', 2100, 'request'))
    expect(sideChangeNote(before, paintMetres(before, 1500, 2500, 'transit')!)).toBeNull()
  })

  it('counts the difference, so a house already quiet is not counted again', () => {
    const before = paintMetres(withHouses(house('a', 1500), house('b', 2500), house('c', 3500)), 1400, 1600, 'transit')!
    expect(sideChangeNote(before, paintMetres(before, 1200, 3800, 'transit')!)).toBe('2 no-throw houses will now stay quiet')
  })

  it('does not call a house quiet while it is passed on a stretch that is thrown as well', () => {
    // Up the road on the left and back down it, the house is passed twice.
    const there = built([0, 1000, 0], ['left', 'left'], [house('a', 500)])
    const outOnly = paintMetres(there, 100, 900, 'transit')!
    // Quiet on the way out, not quiet: it alerts on the way back, and the driver is told that is all that changed.
    expect(sideChangeNote(there, outOnly)).toBe('1 no-throw house will now stay quiet on one pass')
    const both = paintMetres(outOnly, 1100, 1900, 'transit')!
    expect(sideChangeNote(outOnly, both)).toBe('1 no-throw house will now stay quiet')
    expect(sideChangeNote(there, both)).toBe('1 no-throw house will now stay quiet')
    expect(sideChangeNote(both, outOnly)).toBe('1 no-throw house will now alert')
  })

  it('does not count a house that is far from the road, which is never quiet', () => {
    const far = withHouses(house('far', 2000, 'nothrow', 90))
    expect(sideChangeNote(far, paintMetres(far, 1200, 2800, 'transit')!)).toBeNull()
  })

  it('says nothing for a route with no houses, or no route', () => {
    const none = built([0, 1000, 4000, 5000], ['both', 'left', 'both'])
    expect(sideChangeNote(none, paintMetres(none, 1200, 2800, 'transit')!)).toBeNull()
    const empty: Route = { points: [], sideChanges: [], stops: [] }
    expect(sideChangeNote(empty, empty)).toBeNull()
  })
})

describe('changing the side as the driver goes, and taking it back', () => {
  const start = (): Route => built([0, 1000, 4000, 5000], ['both', 'left', 'both'], [house('a', 1500), house('b', 2500), house('bundle', 2000, 'bundle')])
  const alerts = (r: Route) => alertable(r, occurrences(r)).map((o) => o.key).sort()

  it('quiets the houses in the stretch and nowhere else, and the old route brings them back', () => {
    const before = start()
    const snapshot = JSON.parse(JSON.stringify(before)) as Route
    const after = paintMetres(before, 1200, 1800, 'transit')!
    expect(alerts(before)).toEqual(['a', 'b', 'bundle'])
    expect(alerts(after)).toEqual(['b', 'bundle'])
    // Undoing is putting the route that was there back, and it was not touched.
    expect(before).toEqual(snapshot)
    expect(alerts(before)).toEqual(['a', 'b', 'bundle'])
    expect(sideChangeNote(before, after)).toBe('1 no-throw house will now stay quiet')
  })

  it('keeps the bundle drop, whatever is painted', () => {
    const after = paintMetres(start(), 1000, 4000, 'transit')!
    expect(alerts(after)).toEqual(['bundle'])
  })
})

describe('a street or a named section that is the whole stretch', () => {
  // A stretch on the left from 1000 m to 4000 m, with a stretch on both sides before and after it.
  const route = built([0, 1000, 4000, 5000], ['both', 'left', 'both'])
  const probes = [1020, 1500, 2300, 3000, 3980]
  const sideAtMetre = (r: Route, m: number): Side => (sections(r).find((s) => m < s.endM) ?? sections(r).at(-1)!).side
  /** What a pick leaves of the stretch as it was: the probes along it that are still on the left. */
  const leftAfter = (found: Found, key: ExtentKey) => {
    const e = found.extents.find((x) => x.key === key)!
    const after = paintMetres(route, e.fromM, e.toM, 'right')!
    return probes.filter((m) => sideAtMetre(after, m) === 'left')
  }

  it('is not called a street between turns when there is no turn in the stretch', () => {
    const found = sideExtents(route, [], [], 2300)
    expect(spans(found)).toEqual([
      ['toStretchEnd', 2300, 4000],
      ['stretch', 1000, 4000],
    ])
    expect(found.extents.map((e) => e.label)).toEqual(['To the end of this stretch', 'The whole stretch'])
    expect(found.extents.map((e) => e.label).join(' ')).not.toContain('turn')
  })

  it('is not called a street when the turns are all beyond the stretch', () => {
    expect(keys(sideExtents(route, turns(800, 4400), [], 2300))).toEqual(['toStretchEnd', 'stretch'])
  })

  it('leaves the whole of the stretch to the one that is called that, whichever way it is reached', () => {
    for (const found of [sideExtents(route, [], [], 2300), sideExtents(route, turns(400, 4400), [], 2300), sideExtents(route, [], [{ name: 'All', startM: 900, endM: 4100 }], 2300)]) {
      for (const e of found.extents) expect(leftAfter(found, e.key).length > 0, e.key).toBe(e.key !== 'stretch')
      expect(keys(found)).toContain('stretch')
    }
  })

  it('has the whole stretch change all of it, which is what it says', () => {
    const found = sideExtents(route, [], [], 2300)
    expect(leftAfter(found, 'stretch')).toEqual([])
    expect(found.extents.find((e) => e.key === 'stretch')?.detail).toBe('3.0 km, the entire left stretch')
  })

  it('takes the ends of the stretch, not the turn a few metres inside it, when that is all the street is', () => {
    // A turn a few metres into the stretch, as where a change of side was put, and no other.
    const found = sideExtents(route, turns(1003), [], 2300)
    expect(spans(found)).toEqual([
      ['toStretchEnd', 2300, 4000],
      ['stretch', 1000, 4000],
    ])
  })

  it('is the whole stretch when it comes within 25 m of both its ends, and a street when it is further from either', () => {
    // The turn behind is 25 m in, or a bit more. The first stretch starts at 0 exactly, so that 25 m is exactly that.
    const first = built([0, 4000, 5000], ['left', 'both'])
    expect(keys(sideExtents(first, turns(25), [], 2300))).toEqual(['toStretchEnd', 'stretch'])
    expect(keys(sideExtents(first, turns(25.5), [], 2300))).toEqual(['street', 'toStretchEnd', 'stretch'])
    expect(keys(sideExtents(route, turns(1025.5), [], 2300))).toEqual(['street', 'toStretchEnd', 'stretch'])
    // The turn ahead is 25 m short of the end, or a bit more. Taken from the stretch, so that 25 m is exactly that.
    const end = sideExtents(route, [], [], 2300).stretch!.endM
    expect(end - (end - 25)).toBe(25)
    expect(keys(sideExtents(route, turns(end - 25), [], 2300))).toEqual(['toTurn', 'stretch'])
    expect(keys(sideExtents(route, turns(end - 25.5), [], 2300))).toEqual(['street', 'toTurn', 'toStretchEnd', 'stretch'])
    expect(keys(sideExtents(route, turns(3974), [], 2300))).toEqual(['street', 'toTurn', 'toStretchEnd', 'stretch'])
    // And both of them, which is the whole stretch with a turn at each end.
    expect(keys(sideExtents(route, turns(1010, 3990), [], 2300))).toEqual(['toTurn', 'stretch'])
  })

  it('is not a street, in what it paints, when it was close to being the whole stretch', () => {
    // 20 m short of the start: the street is left out, and the whole stretch includes those 20 m.
    const found = sideExtents(route, turns(1020), [], 2300)
    expect(spans(found)).toEqual([
      ['toStretchEnd', 2300, 4000],
      ['stretch', 1000, 4000],
    ])
  })

  it('is called the whole stretch, not a named section, when the section is all of it', () => {
    const all = sideExtents(route, turns(1900, 2600), [{ name: 'Everything', startM: 1000, endM: 4000 }], 2300)
    expect(keys(all)).toEqual(['street', 'toTurn', 'toStretchEnd', 'stretch'])
    expect(all.extents.map((e) => e.label)).not.toContain('This named section: Everything')
    // The same when the section is longer than the stretch, so that what is offered is the part of it in the stretch.
    const wide = sideExtents(route, turns(1900, 2600), [{ name: 'Whole Estate', startM: 500, endM: 4500 }], 2300)
    expect(keys(wide)).toEqual(['street', 'toTurn', 'toStretchEnd', 'stretch'])
    expect(wide.extents.map((e) => e.detail).join(' ')).not.toContain('just the part')
    for (const found of [all, wide]) for (const e of found.extents) expect(leftAfter(found, e.key).length > 0, e.key).toBe(e.key !== 'stretch')
  })

  it('is still a named section when it is only most of the stretch', () => {
    // 30 m short of the start of the stretch.
    const found = sideExtents(route, turns(1900, 2600), [{ name: 'Most', startM: 1030, endM: 4000 }], 2300)
    expect(keys(found)).toEqual(['street', 'toTurn', 'section', 'toStretchEnd', 'stretch'])
    // And 25 m short at one end only is the same as the stretch at the other, so it is the stretch.
    expect(keys(sideExtents(route, turns(1900, 2600), [{ name: 'Most', startM: 1025, endM: 3975 }], 2300))).toEqual(['street', 'toTurn', 'toStretchEnd', 'stretch'])
    expect(keys(sideExtents(route, turns(1900, 2600), [{ name: 'Most', startM: 1025, endM: 3974 }], 2300))).toEqual(['street', 'toTurn', 'section', 'toStretchEnd', 'stretch'])
    expect(keys(sideExtents(route, turns(1900, 2600), [{ name: 'Most', startM: 1026, endM: 3975 }], 2300))).toEqual(['street', 'toTurn', 'section', 'toStretchEnd', 'stretch'])
  })

  it('is the whole stretch of a doubled street when a name covers both passes', () => {
    // Up 1200 m and back down, the way back thrown on the right, with a name over all of it.
    const there: Route = { points: [0, 600, 1200, 600, 0].map((m) => onRoad(m)), sideChanges: [{ idx: 0, side: 'left' }, { idx: 2, side: 'right' }], stops: [] }
    const found = sideExtents(there, turns(1200, 1800), [{ name: 'All', startM: 0, endM: 2400 }], 1500)
    expect(found.stretch).toMatchObject({ side: 'right' })
    expect(keys(found)).toEqual(['street', 'toTurn', 'toStretchEnd', 'stretch'])
    expect(found.extents.map((e) => e.label)).not.toContain('This named section: All')
    const whole = found.extents.find((e) => e.key === 'stretch')!
    expect(Math.round(whole.fromM)).toBe(1200)
    expect(Math.round(whole.toM)).toBe(2400)
  })

  it('is the only option on a route of one stretch and one segment, when the driver has nowhere to go on to', () => {
    const one = built([0, 400], ['right'])
    expect(spans(sideExtents(one, [], [], 400))).toEqual([['stretch', 0, 400]])
    expect(spans(sideExtents(one, [], [], 395))).toEqual([['stretch', 0, 400]])
    expect(spans(sideExtents(one, [], [], 100))).toEqual([
      ['toStretchEnd', 100, 400],
      ['stretch', 0, 400],
    ])
  })
})

describe('keeping an option that is only like one that was dropped', () => {
  // Stretch 1000 m to 2045 m, a street between turns at 1010 and 2000, and a named section a little inside it.
  const route = built([0, 1000, 2045, 3000], ['both', 'left', 'both'])
  const found = sideExtents(route, turns(1010, 2000), [{ name: 'N', startM: 1034, endM: 2024 }], 1050)

  it('drops the named section, which is within 25 m of the street at both ends', () => {
    expect(keys(found)).not.toContain('section')
  })

  it('still offers the way to the end of the stretch, which is within 25 m of that section at both ends but not of anything shown', () => {
    expect(spans(found)).toEqual([
      ['street', 1010, 2000],
      ['toTurn', 1050, 2000],
      ['toStretchEnd', 1050, 2045],
      ['stretch', 1000, 2045],
    ])
  })
})

describe('a route with a point that is not a place', () => {
  const lost: Pt = { lat: Number.NaN, lng: 151.2 }

  it('offers nothing, and says there is no stretch, since nothing on it can be painted', () => {
    const route: Route = { points: [onRoad(0), lost, onRoad(500)], sideChanges: [{ idx: 0, side: 'left' }], stops: [] }
    expect(sideExtents(route, [], [], 100)).toEqual({ stretch: null, extents: [] })
    expect(paintMetres(route, 0, 300, 'right')).toBeNull()
  })

  it('offers nothing past it, or before it, though the stretches before it have a length', () => {
    const route: Route = { points: [onRoad(0), onRoad(1000), lost, onRoad(3000)], sideChanges: [{ idx: 0, side: 'left' }, { idx: 1, side: 'right' }], stops: [] }
    for (const along of [0, 600, 1500, 2500]) expect(sideExtents(route, turns(400), [], along), `${along}`).toEqual({ stretch: null, extents: [] })
    expect(paintMetres(route, 100, 600, 'right')).toBeNull()
  })

  it('offers nothing when the route starts or ends at a point that is not a place', () => {
    const first: Route = { points: [lost, onRoad(1000)], sideChanges: [{ idx: 0, side: 'left' }], stops: [] }
    const end: Route = { points: [onRoad(0), onRoad(1000), { lat: Infinity, lng: 151.2 }], sideChanges: [{ idx: 0, side: 'left' }], stops: [] }
    expect(sideExtents(first, [], [], 100)).toEqual({ stretch: null, extents: [] })
    expect(sideExtents(end, [], [], 100)).toEqual({ stretch: null, extents: [] })
  })
})

describe('a house passed more than once', () => {
  /** Up the road 1 km and back down the same line, all on the left, with a no-throw house 10 m off it halfway. */
  const back = (): Route => ({ points: [0, 1000, 0].map((m) => onRoad(m)), sideChanges: [{ idx: 0, side: 'left' }, { idx: 1, side: 'left' }], stops: [house('a', 500)] })
  /** The same, and up it a third time. */
  const third = (): Route => ({ points: [0, 1000, 0, 1000].map((m) => onRoad(m)), sideChanges: [0, 1, 2].map((idx) => ({ idx, side: 'left' as const })), stops: [house('a', 500)] })
  const alerting = (r: Route) => alertable(r, occurrences(r)).map((o) => o.key)

  it('is told to the driver when it stops alerting on one pass, though it alerts on another', () => {
    const before = back()
    const after = paintMetres(before, 100, 900, 'transit')!
    expect(alerting(before)).toEqual(['a', 'a#2'])
    expect(alerting(after)).toEqual(['a#2'])
    expect(sideChangeNote(before, after)).toBe('1 no-throw house will now stay quiet on one pass')
  })

  it('is told to the driver when it alerts on one more pass', () => {
    const quiet = paintMetres(back(), 100, 900, 'transit')!
    expect(sideChangeNote(quiet, back())).toBe('1 no-throw house will now alert on one more pass')
  })

  it('is told for the way back as well as the way out', () => {
    const after = paintMetres(back(), 1100, 1900, 'transit')!
    expect(alerting(after)).toEqual(['a'])
    expect(sideChangeNote(back(), after)).toBe('1 no-throw house will now stay quiet on one pass')
  })

  it('is told once the last pass is quiet that the house is, not that a pass is', () => {
    const out = paintMetres(back(), 100, 900, 'transit')!
    const both = paintMetres(out, 1100, 1900, 'transit')!
    expect(sideChangeNote(out, both)).toBe('1 no-throw house will now stay quiet')
    expect(sideChangeNote(back(), both)).toBe('1 no-throw house will now stay quiet')
    expect(sideChangeNote(both, out)).toBe('1 no-throw house will now alert')
  })

  it('says nothing when the change leaves the passes of every house as they were', () => {
    // Left to right on the way out, a pass that still alerts.
    const before = back()
    expect(sideChangeNote(before, paintMetres(before, 100, 900, 'right')!)).toBeNull()
    // Transit on a part of the road that has no house.
    expect(sideChangeNote(before, paintMetres(before, 100, 300, 'transit')!)).toBeNull()
    expect(sideChangeNote(before, paintMetres(before, 700, 800, 'transit')!)).toBeNull()
  })

  it('counts the houses that lose a pass, and the ones that lose all of them, apart', () => {
    // The same road up and down, then 500 m east along a road of its own, with a house beside each.
    const road: Route = {
      points: [onRoad(0), onRoad(1000), onRoad(0), onRoad(0, 500)],
      sideChanges: [0, 1, 2].map((idx) => ({ idx, side: 'left' as const })),
      stops: [house('a', 500), { id: 'b', type: 'nothrow', ...onRoad(10, 300), pathIdx: 2 }],
    }
    expect(alerting(road)).toEqual(['a', 'a#2', 'b'])
    const outOnly = paintMetres(road, 100, 900, 'transit')!
    const after = paintMetres(outOnly, 2100, 2450, 'transit')!
    expect(sideChangeNote(road, outOnly)).toBe('1 no-throw house will now stay quiet on one pass')
    expect(sideChangeNote(outOnly, after)).toBe('1 no-throw house will now stay quiet')
    expect(sideChangeNote(road, after)).toBe('1 no-throw house will now stay quiet; 1 no-throw house will now stay quiet on one pass')
    expect(sideChangeNote(after, road)).toBe('1 no-throw house will now alert; 1 no-throw house will now alert on one more pass')
  })

  it('counts houses, not passes, when several lose one', () => {
    const route: Route = { ...back(), stops: [house('a', 300), house('b', 500), house('c', 700)] }
    const after = paintMetres(route, 100, 900, 'transit')!
    expect(sideChangeNote(route, after)).toBe('3 no-throw houses will now stay quiet on one pass')
  })

  it('says some passes when a house loses more than one', () => {
    const route = third()
    expect(alerting(route)).toEqual(['a', 'a#2', 'a#3'])
    const one = paintMetres(route, 100, 900, 'transit')!
    expect(sideChangeNote(route, one)).toBe('1 no-throw house will now stay quiet on one pass')
    const two = paintMetres(one, 1100, 1900, 'transit')!
    expect(alerting(two)).toEqual(['a#3'])
    expect(sideChangeNote(route, two)).toBe('1 no-throw house will now stay quiet on some passes')
    expect(sideChangeNote(two, route)).toBe('1 no-throw house will now alert on some more passes')
    expect(sideChangeNote(one, two)).toBe('1 no-throw house will now stay quiet on one pass')
  })

  it('says some passes when only one of several houses loses more than one', () => {
    // Up, down and up again, with a house where the way down is not painted and one where it is.
    const route: Route = { ...third(), stops: [house('a', 300), house('b', 700)] }
    const first = paintMetres(route, 100, 900, 'transit')!
    expect(sideChangeNote(route, first)).toBe('2 no-throw houses will now stay quiet on one pass')
    const both = paintMetres(first, 1100, 1500, 'transit')!
    expect(alerting(both)).toEqual(['a#2', 'a#3', 'b#3'])
    expect(sideChangeNote(first, both)).toBe('1 no-throw house will now stay quiet on one pass')
    expect(sideChangeNote(route, both)).toBe('2 no-throw houses will now stay quiet on some passes')
    expect(sideChangeNote(both, route)).toBe('2 no-throw houses will now alert on some more passes')
    expect(sideChangeNote(both, first)).toBe('1 no-throw house will now alert on one more pass')
  })

  it('leaves out what is not a no-throw house, though the route it is on changes', () => {
    // A bundle drop passed twice, then once, since the road is no longer driven back down.
    const there: Route = { ...back(), stops: [house('x', 500, 'bundle')] }
    const once: Route = { points: [0, 1000].map((m) => onRoad(m)), sideChanges: [{ idx: 0, side: 'left' }], stops: [house('x', 500, 'bundle')] }
    expect(sideChangeNote(there, once)).toBeNull()
    expect(sideChangeNote(once, there)).toBeNull()
  })

  it('does not count a bundle drop or a special request, which alert on any pass', () => {
    const route: Route = { ...back(), stops: [house('x', 500, 'bundle'), house('y', 600, 'request')] }
    expect(sideChangeNote(route, paintMetres(route, 100, 900, 'transit')!)).toBeNull()
  })

  it('does not count a house that is far from the road, which alerts on every pass', () => {
    const route: Route = { ...back(), stops: [house('far', 500, 'nothrow', 90)] }
    expect(sideChangeNote(route, paintMetres(route, 100, 900, 'transit')!)).toBeNull()
  })
})

describe('the first option names what it reaches', () => {
  // A 1000 m road north in three stretches, the middle one 1000 to 3000 m with a corner at 1600 m.
  const point = (m: number) => ({ lat: 51 + m / 111195, lng: 0 })
  const road = { points: [point(0), point(1000), point(3000), point(4000)], sideChanges: [{ idx: 0, side: 'both' as const }, { idx: 1, side: 'left' as const }, { idx: 2, side: 'both' as const }], stops: [] }
  const first = (turnsAt: number[], along: number) => sideExtents(road, turnsAt.map((at) => ({ at })), [], along).extents[0]

  it('is a turn each end when there is one behind and one ahead', () => {
    expect(first([1600, 2400], 2000).label).toBe('From the last turn to the next turn')
  })

  it('starts at the start of the stretch when there is no turn behind the driver', () => {
    const e = first([1600], 1300)
    expect(e.label).toBe('From the start of this stretch to the next turn')
    expect(e.fromM).toBeCloseTo(1000, 0)
    expect(e.toM).toBe(1600)
  })

  it('runs to the end of the stretch when there is no turn ahead of the driver', () => {
    const e = first([1600], 2000)
    expect(e.label).toBe('From the last turn to the end of this stretch')
    expect(e.fromM).toBe(1600)
    expect(e.toM).toBeCloseTo(3000, 0)
  })

  it('is not offered when it would be the whole stretch, which has its own option', () => {
    expect(sideExtents(road, [], [], 2000).extents.map((e) => e.key)).toEqual(['toStretchEnd', 'stretch'])
  })
})
