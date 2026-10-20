import { describe, expect, it } from 'vitest'
import { passesAt, passLabel } from './passChoice'
import type { Pt } from './types'

// A road about 560 m long going north, driven up and then straight back down it.
const OUT_AND_BACK: Pt[] = [{ lat: 51, lng: 0 }, { lat: 51.005, lng: 0 }, { lat: 51, lng: 0 }]
const ONCE: Pt[] = [{ lat: 51, lng: 0 }, { lat: 51.005, lng: 0 }]
const spot = { lat: 51.002, lng: 0.00005 }

describe('the times the route goes by a spot', () => {
  it('is once for a road driven once', () => {
    expect(passesAt(ONCE, spot)).toHaveLength(1)
  })

  it('is twice for a road driven out and back, in route order', () => {
    const passes = passesAt(OUT_AND_BACK, spot)
    expect(passes).toHaveLength(2)
    expect(passes[0].at).toBeLessThan(passes[1].at)
  })

  it('is only those within the stretch asked about', () => {
    // The first stretch is the way up (points 0 to 1) and the second the way back (points 1 to 2).
    expect(passesAt(OUT_AND_BACK, spot, { idx: 0, endIdx: 1 })).toHaveLength(1)
    expect(passesAt(OUT_AND_BACK, spot, { idx: 1, endIdx: 2 })).toHaveLength(1)
    expect(passesAt(OUT_AND_BACK, spot, { idx: 0, endIdx: 1 })[0].idx).toBe(0)
    expect(passesAt(OUT_AND_BACK, spot, { idx: 1, endIdx: 2 })[0].idx).toBe(1)
  })

  it('is both when the stretch is the whole route', () => {
    expect(passesAt(OUT_AND_BACK, spot, { idx: 0, endIdx: 2 })).toHaveLength(2)
  })

  it('is none for a route with no length', () => {
    expect(passesAt([], spot)).toEqual([])
  })
})

describe('what a time through is called', () => {
  it('says which time it is and how far along the route', () => {
    expect(passLabel(0, 250)).toEqual({ label: 'The first time through', detail: '250 m along the route' })
    expect(passLabel(1, 1400)).toEqual({ label: 'The second time through', detail: '1.4 km along the route' })
    expect(passLabel(2, 10).label).toBe('The third time through')
  })

  it('keeps counting past the words it has', () => {
    expect(passLabel(5, 10).label).toBe('The 6th time through')
  })
})
