import { describe, expect, it } from 'vitest'
import { pushTrail, trailHeading, type TrailPoint } from './heading'

const M_PER_DEG = (6371000 * Math.PI) / 180
const ORIGIN = { lat: -33.87, lng: 151.2 }
const at = (x: number, y: number, time: number): TrailPoint => ({
  lat: ORIGIN.lat + y / M_PER_DEG,
  lng: ORIGIN.lng + x / (M_PER_DEG * Math.cos((ORIGIN.lat * Math.PI) / 180)),
  time,
})
const trailOf = (...xy: [number, number][]) => xy.reduce<TrailPoint[]>((t, [x, y], i) => pushTrail(t, at(x, y, i * 1000)), [])
const near = (a: number | null, b: number, within: number) => a !== null && Math.abs(((a - b + 540) % 360) - 180) <= within

describe('the way a trail is heading', () => {
  it('is the way from a place well back to where it is now', () => {
    expect(near(trailHeading(trailOf([0, 0], [0, 10], [0, 20], [0, 30], [0, 40]), 5), 0, 1)).toBe(true)
    expect(near(trailHeading(trailOf([0, 0], [10, 0], [20, 0], [30, 0]), 5), 90, 1)).toBe(true)
    expect(near(trailHeading(trailOf([0, 0], [-10, -10], [-20, -20], [-30, -30]), 5), 225, 1)).toBe(true)
  })

  it('has none for a phone standing still, however much it wanders', () => {
    const wander = trailOf([0, 0], [4, -3], [-3, 5], [6, 2], [-5, -4], [2, 6], [-4, 1], [5, -5], [-2, 3])
    expect(trailHeading(wander, 8)).toBeNull()
  })

  it('has none until the phone has moved far enough to be sure', () => {
    expect(trailHeading(trailOf([0, 0], [0, 8], [0, 16], [0, 22]), 5)).toBeNull()
    expect(trailHeading(trailOf([0, 0], [0, 8], [0, 16], [0, 26]), 5)).not.toBeNull()
  })

  it('needs further for a less accurate fix', () => {
    const t = trailOf([0, 0], [0, 15], [0, 30], [0, 45])
    expect(trailHeading(t, 8)).not.toBeNull()
    expect(trailHeading(t, 30)).toBeNull()
    expect(trailHeading([...t, at(0, 60, 4000), at(0, 75, 5000), at(0, 90, 6000)], 30)).not.toBeNull()
  })

  it('has none while the trail turns: a corner, or a U-turn', () => {
    expect(trailHeading(trailOf([0, 0], [0, 10], [0, 20], [10, 20], [20, 20]), 5)).toBeNull()
    expect(trailHeading(trailOf([0, 0], [0, 15], [0, 30], [0, 20], [0, 10]), 5)).toBeNull()
  })

  it('is the way the driver has been going since a U-turn, once that has been far enough', () => {
    expect(near(trailHeading(trailOf([0, 0], [0, 15], [0, 30], [0, 15], [0, 0]), 5), 180, 1)).toBe(true)
  })

  it('is the way since the turn once the trail has run straight again for long enough', () => {
    const t = trailOf([0, 0], [0, 10], [0, 20], [10, 20], [20, 20], [30, 20], [40, 20], [50, 20], [60, 20])
    expect(near(trailHeading(t, 5), 90, 1)).toBe(true)
  })

  it('is near the way the road runs through a trail that is a little off, as a real phone makes', () => {
    const r = [3, -2, 4, -4, 1, 3, -3, 2, -1, 4, -2, 3]
    const t = trailOf(...r.map((e, i) => [e, i * 10] as [number, number]))
    expect(near(trailHeading(t, 8), 0, 15)).toBe(true)
  })

  it('has none for an empty trail', () => {
    expect(trailHeading([], 5)).toBeNull()
    expect(trailHeading(trailOf([0, 0]), 5)).toBeNull()
  })

  it('works across north, where headings wrap round', () => {
    expect(near(trailHeading(trailOf([0, 0], [-3, 10], [-6, 20], [-9, 30], [-12, 40]), 5), 343, 2)).toBe(true)
  })
})

describe('the trail', () => {
  it('forgets places that are old', () => {
    const t = pushTrail(pushTrail([], at(0, 0, 0)), at(0, 10, 61_000))
    expect(t).toHaveLength(1)
    expect(t[0].time).toBe(61_000)
  })

  it('keeps recent places, newest last', () => {
    const t = pushTrail(pushTrail([], at(0, 0, 0)), at(0, 10, 59_000))
    expect(t.map((p) => p.time)).toEqual([0, 59_000])
  })

  it('keeps no more than a few dozen', () => {
    let t: TrailPoint[] = []
    for (let i = 0; i < 100; i++) t = pushTrail(t, at(0, i, i * 100))
    expect(t).toHaveLength(30)
    expect(t[t.length - 1].time).toBe(9900)
  })

  it('does not change the trail it was given', () => {
    const t = trailOf([0, 0], [0, 10])
    const copy = [...t]
    pushTrail(t, at(0, 20, 5000))
    expect(t).toEqual(copy)
  })
})
