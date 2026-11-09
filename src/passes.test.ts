import { describe, expect, it, vi } from 'vitest'
import { distanceToPath } from './geo'
import { PASS_OFFSET_M, passNote, passViews } from './passes'
import { repeatSection } from './routeEdit'
import type { Pt, Route } from './types'

/** Every time a section is measured against another: the path measured against, and the point measured. Watched, not changed. */
const asked = vi.hoisted(() => [] as { path: readonly Pt[]; at: Pt }[])
vi.mock('./geo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./geo')>()
  return {
    ...actual,
    pathDistancer: (path: Pt[]) => {
      const measure = actual.pathDistancer(path)
      return (at: Pt) => {
        asked.push({ path, at })
        return measure(at)
      }
    },
  }
})

const pt = (i: number): Pt => ({ lat: 51 + i * 0.001, lng: 0 })
const oneStreet = (): Route => ({
  points: Array.from({ length: 6 }, (_, i) => pt(i)),
  sideChanges: [{ idx: 0, side: 'left' }],
  stops: [],
})

describe('drawing the sections of a route', () => {
  it('draws a route driven once exactly where it was drawn', () => {
    const route = oneStreet()
    const views = passViews(route)
    expect(views).toHaveLength(1)
    expect(views[0].points).toEqual(route.points)
    expect(views[0].repeatOf).toBeNull()
  })

  it('has nothing to draw for a route that is not drawn yet', () => {
    expect(passViews({ points: [], sideChanges: [], stops: [] })).toEqual([])
    expect(passViews({ points: [pt(0)], sideChanges: [], stops: [] })).toEqual([])
  })

  it('draws the way back beside the way out, and says what it repeats', () => {
    const route = repeatSection(oneStreet(), 0, 'back')!
    const [out, back] = passViews(route)
    expect(out.repeatOf).toBeNull()
    expect(out.points).toEqual(route.points.slice(0, 6))
    expect(back.repeatOf).toBe(0)
    expect(back.reversed).toBe(true)
    // Going south, "right" is west: the return pass is drawn on the other side of the road.
    expect(back.points[0].lng).toBeLessThan(0)
    expect(distanceToPath(back.points[2], out.points)).toBeCloseTo(PASS_OFFSET_M, 0)
  })

  it('draws the same way again to the same side of the road as the first pass, further out', () => {
    // Going the same way again means driving back to the start first. On a straight road that link
    // retraces the street, so it counts as a pass too and the third pass is drawn further out.
    const route = repeatSection(oneStreet(), 0, 'again')!
    const views = passViews(route)
    expect(views).toHaveLength(3)
    expect(views[1].reversed).toBe(true)
    const again = views[2]
    expect(again.repeatOf).toBe(0)
    expect(again.reversed).toBe(false)
    expect(again.points[0].lng).toBeGreaterThan(0)
    expect(distanceToPath(again.points[2], views[0].points)).toBeCloseTo(2 * PASS_OFFSET_M, 0)
  })

  it('keeps the sides each pass was given', () => {
    const route = repeatSection(oneStreet(), 0, 'again')!
    expect(passViews(route).map((v) => v.side)).toEqual(['left', 'both', 'right'])
  })

  it('does not treat the next stretch of the same street as a repeat', () => {
    const split: Route = { ...oneStreet(), sideChanges: [{ idx: 0, side: 'left' }, { idx: 3, side: 'right' }] }
    expect(passViews(split).map((v) => v.repeatOf)).toEqual([null, null])
  })

  it('does not treat a different street as a repeat', () => {
    const l: Route = {
      points: [pt(0), pt(3), { lat: 51.003, lng: 0.01 }, { lat: 51.0, lng: 0.01 }],
      sideChanges: [{ idx: 0, side: 'both' }, { idx: 1, side: 'left' }, { idx: 2, side: 'right' }],
      stops: [],
    }
    expect(passViews(l).every((v) => v.repeatOf === null)).toBe(true)
  })

  it('counts passes: a third pass over the same road is drawn further out again', () => {
    let route = repeatSection(oneStreet(), 0, 'back')!
    route = repeatSection(route, 0, 'again')!
    const third = passViews(route).filter((v) => v.repeatOf === 0).pop()!
    const first = passViews(route)[0]
    expect(distanceToPath(third.points[2], first.points)).toBeGreaterThan(PASS_OFFSET_M)
  })

  it('does not measure a section against one too far away to share its ground, and still finds the repeats', () => {
    // A street, 2 km along another road, and a second street driven out and back.
    const far = 0.03
    const route: Route = {
      points: [...Array.from({ length: 6 }, (_, i) => pt(i)), ...Array.from({ length: 6 }, (_, i) => ({ lat: 51.005 - i * 0.001, lng: far })), ...Array.from({ length: 5 }, (_, i) => ({ lat: 51.001 + i * 0.001, lng: far }))],
      sideChanges: [
        { idx: 0, side: 'left' },
        { idx: 5, side: 'transit' },
        { idx: 6, side: 'right' },
        { idx: 11, side: 'both' },
      ],
      stops: [],
    }
    asked.length = 0
    const views = passViews(route)
    expect(views.map((v) => v.repeatOf)).toEqual([null, null, null, 2])
    expect(views[3].reversed).toBe(true)
    const firstStreet = (path: readonly Pt[]) => path.every((p) => p.lng === 0)
    const secondStreet = (at: Pt) => at.lng === far && at.lat < 51.0049
    expect(asked.some((a) => firstStreet(a.path) && secondStreet(a.at))).toBe(false)
    // The road between them touches both, so it is still measured against the first.
    expect(asked.some((a) => firstStreet(a.path))).toBe(true)
  })
})

describe('describing a pass', () => {
  it('says nothing for a section that is the first to drive its road', () => {
    expect(passNote(passViews(oneStreet())[0])).toBe('')
    expect(passNote(undefined)).toBe('')
  })

  it('says which section a pass drives again, and which way', () => {
    const back = passViews(repeatSection(oneStreet(), 0, 'back')!)[1]
    expect(passNote(back)).toBe('back along stretch 1')
    // Driving it again the same way adds a link back to the start first, then the pass itself.
    const [, link, again] = passViews(repeatSection(oneStreet(), 0, 'again')!)
    expect(passNote(link)).toBe('back along stretch 1')
    expect(passNote(again)).toBe('again along stretch 1')
  })

  it('counts sections from one', () => {
    expect(passNote({ repeatOf: 4, reversed: false })).toBe('again along stretch 5')
    expect(passNote({ repeatOf: 0, reversed: true })).toBe('back along stretch 1')
  })
})
