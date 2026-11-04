import { createElement, useState } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quietReason } from './alerts'
import { bearing, haversine, cumulativeDistances, occurrences, sideAt, stopSide } from './geo'
import { UTURN_WAY } from './region'
import { rate, undoStretch } from './roads'
import { RouteTab } from './RouteTab'
import { appendPoints, sections } from './routeEdit'
import { pointAt } from './turns'
import type { Pt, Route, Side, Stop } from './types'
import { useRoadFollow } from './useRoadFollow'
import {
  canDrawUturn,
  drawUturn,
  endHeading,
  endsWithUturn,
  HEADING_BASE_M,
  lastCornerBack,
  localUturn,
  MIN_LEG_M,
  UTURN_ACROSS_M,
  UTURN_ADDED_NOTICE,
  UTURN_BEHIND_M,
  UTURN_CLEAR_M,
  UTURN_RUN_M,
  UTURN_SIDE_NOTICE,
  UTURN_SNAP_CLEAR_M,
  uturnBehind,
  uturnHereNotice,
  uturnRun,
  withUturn,
} from './uturnShape'

/**
 * The U-turn drawn on the spot: where its points go, which way the route is heading when it is drawn, how far on it starts when a corner
 * is just behind, what side it is thrown on and what Undo takes off. How it reads as a turn and how the round tracks it are in uturnRoute.test.ts.
 */

// A place in Sydney, so the maths is checked away from the equator and the prime meridian.
const ORIGIN: Pt = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
const rad = (deg: number) => (deg * Math.PI) / 180

/** A place in the driver's own frame: [metres to the right of the way the route first heads, metres ahead of the start]. */
type Spot = readonly [number, number]

/** The same place on the map, for a route whose first stretch heads `h` degrees clockwise from north, from `origin`. */
const spot = (h: number, [x, y]: Spot, origin: Pt = ORIGIN): Pt => {
  const east = x * Math.cos(rad(h)) + y * Math.sin(rad(h))
  const north = -x * Math.sin(rad(h)) + y * Math.cos(rad(h))
  return { lat: origin.lat + north / M_PER_DEG, lng: origin.lng + east / (M_PER_DEG * Math.cos(rad(origin.lat))) }
}

/** Where a point is in the frame of a route heading `h` from `origin`: the opposite of `spot`. */
const inFrame = (h: number, p: Pt, origin: Pt = ORIGIN): Spot => {
  const east = (p.lng - origin.lng) * M_PER_DEG * Math.cos(rad(origin.lat))
  const north = (p.lat - origin.lat) * M_PER_DEG
  return [east * Math.cos(rad(h)) - north * Math.sin(rad(h)), east * Math.sin(rad(h)) + north * Math.cos(rad(h))]
}

/** Points along the road through these places, one at least every `step` metres. */
function dense(step: number, ...xy: Spot[]): Spot[] {
  const out: Spot[] = [xy[0]]
  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1]
    const [bx, by] = xy[i]
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step))
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n])
  }
  return out
}

const EMPTY: Route = { points: [], sideChanges: [], stops: [] }
/** A route through these places (a heading of `h`), thrown on `side`. */
const routeOf = (h: number, spots: Spot[], side: Side = 'both', origin: Pt = ORIGIN): Route => appendPoints(EMPTY, spots.map((s) => spot(h, s, origin)), side)

/** Ways the route can head: every ten degrees. */
const HEADINGS = Array.from({ length: 36 }, (_, i) => i * 10)

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
/** How far apart two compass headings are, in degrees. */
const apart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)

describe('how big the U-turn is', () => {
  it('goes on 6 m, across 5 m and back 8 m behind the end', () => {
    expect(UTURN_RUN_M).toBe(6)
    expect(UTURN_ACROSS_M).toBe(5)
    expect(UTURN_BEHIND_M).toBe(8)
    expect(HEADING_BASE_M).toBe(12)
    expect(UTURN_CLEAR_M).toBe(26)
  })
})

describe('the way the route is heading at its end', () => {
  it('is none for a route with no way: nothing, one point, or points that are all the same place', () => {
    const a = spot(0, [0, 0])
    expect(endHeading([])).toBeNull()
    expect(endHeading([a])).toBeNull()
    expect(endHeading([a, { ...a }])).toBeNull()
    expect(endHeading([a, spot(0, [0, 0.4])])).toBeNull()
    expect(canDrawUturn([])).toBe(false)
    expect(canDrawUturn([a])).toBe(false)
    expect(canDrawUturn([a, spot(0, [0, 0.4])])).toBe(false)
    expect(canDrawUturn([a, spot(0, [0, 3])])).toBe(true)
  })

  it('is the way a straight road runs, whichever way that is and however it is drawn', () => {
    for (const h of HEADINGS) {
      for (const route of [[[0, 0], [0, 100]], dense(20, [0, 0], [0, 300]), dense(2, [0, 0], [0, 40])] as Spot[][]) {
        const heading = endHeading(route.map((s) => spot(h, s)))!
        expect(apart(heading, h), `${h}`).toBeLessThan(0.1)
      }
    }
  })

  it('is measured over the last 12 m, not the last piece, which is short or follows a bend', () => {
    for (const h of [0, 90, 215]) {
      for (const last of [2, 6, 20, 60]) {
        // 200 m, then a bend of 25 degrees to the right, then `last` m.
        const end = spot(h, [0, 200])
        const bent: Pt = spot(h + 25, [0, last], end)
        const route = [...dense(20, [0, 0], [0, 200]).map((s) => spot(h, s)), bent]
        const heading = endHeading(route)!
        if (last >= HEADING_BASE_M) expect(apart(heading, h + 25), `${h} ${last}`).toBeLessThan(0.2)
        else {
          // Part of the last 12 m is the road before the bend: between the two ways, and nearer the new one the longer the last piece.
          expect(apart(heading, h)).toBeGreaterThan(0.5)
          expect(apart(heading, h + 25)).toBeGreaterThan(0.5)
          expect(apart(heading, h) + apart(heading, h + 25)).toBeCloseTo(25, 0)
        }
      }
    }
    // The last piece alone points 45 degrees off the road, which the chord does not.
    const end = spot(0, [0, 200])
    const diagonal = [...dense(20, [0, 0], [0, 200]).map((s) => spot(0, s)), spot(45, [0, 2], end)]
    expect(apart(bearing(diagonal[diagonal.length - 2], diagonal[diagonal.length - 1]), 45)).toBeLessThan(0.1)
    expect(apart(endHeading(diagonal)!, 45)).toBeGreaterThan(8)
  })

  it('is the bearing from the point 12 m back along the route to its end, wherever the points of the route are', () => {
    const wiggly: Pt[] = [spot(0, [0, 0])]
    // A route of uneven pieces, some a metre or two and some long, bending about.
    const pieces: [number, number][] = [[10, 40], [35, 3], [80, 1.5], [10, 25], [-40, 4], [-40, 7], [20, 90], [95, 2], [95, 2.5], [95, 5]]
    let at = wiggly[0]
    for (const [h, m] of pieces) {
      at = spot(h, [0, m], at)
      wiggly.push(at)
    }
    for (let n = 2; n <= wiggly.length; n++) {
      const part = wiggly.slice(0, n)
      const cum = cumulativeDistances(part)
      const total = cum[cum.length - 1]
      const expected = bearing(pointAt(part, cum, Math.max(0, total - HEADING_BASE_M)), part[part.length - 1])
      const got = endHeading(part)
      // A corner far enough back to have a leg of its own sets the way (see below); otherwise it is the chord.
      if (lastCornerBack(part) === null || lastCornerBack(part)! >= HEADING_BASE_M || lastCornerBack(part)! < MIN_LEG_M) {
        expect(apart(got!, expected), `${n} points`).toBeLessThan(0.05)
      }
    }
  })

  it('is the whole route when it is shorter than that', () => {
    for (const h of HEADINGS) {
      const route = [spot(h, [0, 0]), spot(h, [0.5, 6])]
      expect(apart(endHeading(route)!, bearing(route[0], route[1]))).toBeLessThan(0.01)
    }
  })

  it('is the way of the last leg, not across the corner, when a corner of 40 degrees or more is 3 m or more before the end', () => {
    for (const h of [0, 120, 275]) {
      for (const turn of [-1, 1]) {
        for (const leg of [3.5, 6, 8, 11]) {
          // 150 m, a corner of 90 degrees, then `leg` m: the chord across the corner would point 30 degrees or more off the leg.
          const corner = spot(h, [0, 150])
          const route = [...dense(20, [0, 0], [0, 150]).map((s) => spot(h, s)), spot(h + 90 * turn, [0, leg], corner)]
          expect(apart(endHeading(route)!, h + 90 * turn), `${h} ${turn} ${leg}`).toBeLessThan(0.2)
        }
      }
    }
  })

  it('is the chord over the last 12 m when the corner is closer than that to the end: the last piece is too short to be a way', () => {
    const corner = spot(0, [0, 150])
    const route = [...dense(20, [0, 0], [0, 150]).map((s) => spot(0, s)), spot(90, [0, MIN_LEG_M - 1], corner)]
    const heading = endHeading(route)!
    // 10 m of the road and 2 m after the corner: a little way round from the road, a long way short of the last piece.
    expect(apart(heading, 0)).toBeGreaterThan(5)
    expect(apart(heading, 0)).toBeLessThan(20)
    expect(apart(heading, 90)).toBeGreaterThan(60)
  })

  it('is the way of the last piece that is a place of its own when the route comes back to the place it ends', () => {
    // 10 m north and then back to within half a metre of the start: from the start to the end is no way at all.
    const start = spot(0, [0, 0])
    const route = [start, spot(0, [0, 10]), spot(0, [0.3, 0.2])]
    expect(apart(endHeading(route)!, 180)).toBeLessThan(5)
  })
})

describe('the last corner of the route', () => {
  /** The route: 100 m north, a corner of `degrees` (positive right) and then `after` m, with a point every `step` m round the corner if it is rounded. */
  const cornerRoute = (h: number, degrees: number, after: number): Pt[] => {
    const corner = spot(h, [0, 100])
    return [...dense(25, [0, 0], [0, 100]).map((s) => spot(h, s)), spot(h + degrees, [0, after], corner)]
  }

  it('is none on a straight road or on a road that only curves', () => {
    expect(lastCornerBack(routeOf(0, dense(20, [0, 0], [0, 200])).points)).toBeNull()
    // 5 degrees every 3 m for 60 m: 100 degrees in all, but never 40 within 10 m.
    let at: Pt = spot(0, [0, 0])
    const curve: Pt[] = [at]
    for (let i = 0; i < 20; i++) {
      at = spot(i * 5, [0, 3], at)
      curve.push(at)
    }
    expect(lastCornerBack(curve)).toBeNull()
    expect(lastCornerBack([])).toBeNull()
    expect(lastCornerBack([spot(0, [0, 0]), spot(0, [0, 9])])).toBeNull()
  })

  it('is how far before the end a corner is, to the left or the right, whichever way the road runs', () => {
    for (const h of HEADINGS) {
      for (const degrees of [-90, -45, 45, 90, 120]) {
        for (const after of [3, 8, 14, 20]) {
          const back = lastCornerBack(cornerRoute(h, degrees, after))
          expect(back, `${h} ${degrees} ${after}`).not.toBeNull()
          expect(near(back!, after, 0.05), `${h} ${degrees} ${after}: ${back}`).toBe(true)
        }
      }
    }
  })

  it('is none for a bend of under 40 degrees, and none beyond 26 m', () => {
    expect(lastCornerBack(cornerRoute(0, 35, 8))).toBeNull()
    expect(lastCornerBack(cornerRoute(0, 90, UTURN_CLEAR_M + 3))).toBeNull()
    expect(lastCornerBack(cornerRoute(0, 90, UTURN_CLEAR_M - 1))).not.toBeNull()
  })

  it('finds a corner rounded off by the road service as one place: its bends added up, nearest the end', () => {
    // A corner of 90 degrees in three bends of 30, a couple of metres apart, then 10 m on.
    let at: Pt = spot(0, [0, 100])
    const pts: Pt[] = [...dense(25, [0, 0], [0, 100]).map((s) => spot(0, s))]
    for (const heading of [30, 60, 90]) {
      at = spot(heading, [0, 2], at)
      pts.push(at)
    }
    pts.push(spot(90, [0, 10], at))
    const back = lastCornerBack(pts)
    // The point where the last of the three bends is, 10 m before the end.
    expect(back).not.toBeNull()
    expect(near(back!, 10, 0.1)).toBe(true)
  })

  it('does not count a zigzag, whose bends cancel, as a corner', () => {
    // 25 degrees to the right and back, over and over, 4 m apart: never 40 degrees one way.
    const zigzag = dense(25, [0, 0], [0, 100]).map((s) => spot(0, s))
    for (const heading of [25, 0, 25, 0, 25, 0]) zigzag.push(spot(heading, [0, 4], zigzag[zigzag.length - 1]))
    expect(lastCornerBack(zigzag)).toBeNull()
    // Two of the bends the same way within 10 m are a corner, though.
    const corner = dense(25, [0, 0], [0, 100]).map((s) => spot(0, s))
    for (const heading of [25, 50, 50]) corner.push(spot(heading, [0, 4], corner[corner.length - 1]))
    expect(near(lastCornerBack(corner)!, 4, 0.05)).toBe(true)
  })

  it('looks only at the end of a long route, and finds the same corner as on a short one', () => {
    // 4 km of road with a point every 4 m, with a bend of 90 degrees 100 m from the end of it and a corner 8 m before the end.
    const long = routeOf(0, [...dense(4, [0, 0], [0, 4000]), ...dense(4, [0, 4000], [100, 4000]).slice(1), [100, 4008]]).points
    expect(long.length).toBeGreaterThan(1000)
    expect(near(lastCornerBack(long)!, 8, 0.05)).toBe(true)
    expect(near(lastCornerBack(long.slice(-6))!, 8, 0.05)).toBe(true)
    expect(apart(endHeading(long)!, 0)).toBeLessThan(0.1)
    expect(near(uturnRun(long), UTURN_CLEAR_M - 8, 0.05)).toBe(true)
  })

  it('takes the nearest to the end of two corners', () => {
    const route = routeOf(0, [[0, 0], [0, 100], [60, 100], [60, 112]]).points
    expect(near(lastCornerBack(route)!, 12, 0.1)).toBe(true)
  })
})

describe('how far on the U-turn starts to turn', () => {
  const afterCorner = (after: number, degrees = 90): Pt[] => {
    const corner = spot(0, [0, 100])
    return [...dense(25, [0, 0], [0, 100]).map((s) => spot(0, s)), spot(degrees, [0, after], corner)]
  }

  it('is 6 m on an ordinary road', () => {
    expect(uturnRun(routeOf(0, dense(20, [0, 0], [0, 200])).points)).toBe(UTURN_RUN_M)
    expect(uturnRun(afterCorner(40))).toBe(UTURN_RUN_M)
  })

  it('is further on the nearer a corner is, to put 26 m between the corner and where it starts to turn', () => {
    for (const after of [3.5, 5, 8, 10, 14]) {
      expect(near(uturnRun(afterCorner(after)), UTURN_CLEAR_M - after, 0.05), `${after}`).toBe(true)
      // A corner the other way makes no difference to how far on.
      expect(near(uturnRun(afterCorner(after, -90)), UTURN_CLEAR_M - after, 0.05), `${after} left`).toBe(true)
    }
  })

  it('is 6 m again once the corner is 20 m or more back', () => {
    expect(uturnRun(afterCorner(20))).toBeCloseTo(UTURN_RUN_M, 6)
    expect(uturnRun(afterCorner(19.9))).toBeCloseTo(6.1, 1)
    expect(uturnRun(afterCorner(24))).toBe(UTURN_RUN_M)
  })
})

describe('the three points of the U-turn', () => {
  it('go on 6 m, across 5 m to the right and back 14 m, which is 8 m behind the end, whichever way the road runs', () => {
    for (const h of HEADINGS) {
      const route = routeOf(h, dense(20, [0, 0], [0, 300]))
      const end = route.points[route.points.length - 1]
      const [a, b, c] = localUturn(route.points)!.map((p) => inFrame(h, p, end))
      expect(a[0]).toBeCloseTo(0, 1)
      expect(a[1]).toBeCloseTo(UTURN_RUN_M, 1)
      expect(b[0]).toBeCloseTo(UTURN_ACROSS_M, 1)
      expect(b[1]).toBeCloseTo(UTURN_RUN_M, 1)
      expect(c[0]).toBeCloseTo(UTURN_ACROSS_M, 1)
      expect(c[1]).toBeCloseTo(-UTURN_BEHIND_M, 1)
    }
  })

  it('turn to the right by default, as traffic keeping left does, and to the left when asked', () => {
    expect(UTURN_WAY).toBe(1)
    const route = routeOf(40, dense(20, [0, 0], [0, 300]))
    const end = route.points[route.points.length - 1]
    const dflt = localUturn(route.points)!.map((p) => inFrame(40, p, end))
    const right = localUturn(route.points, 1)!.map((p) => inFrame(40, p, end))
    const left = localUturn(route.points, -1)!.map((p) => inFrame(40, p, end))
    expect(dflt).toEqual(right)
    expect(right[1][0]).toBeGreaterThan(0)
    expect(left[1][0]).toBeCloseTo(-right[1][0], 3)
    expect(left[2][0]).toBeCloseTo(-right[2][0], 3)
    expect(left[0][1]).toBeCloseTo(right[0][1], 3)
  })

  it('are the same size anywhere on the map, in metres', () => {
    for (const origin of [{ lat: -12.46, lng: 130.84 }, { lat: -33.87, lng: 151.2 }, { lat: -42.88, lng: 147.33 }, { lat: -10.6, lng: 142.5 }]) {
      for (const h of [0, 63, 180, 291]) {
        const route = routeOf(h, dense(20, [0, 0], [0, 200]), 'both', origin)
        const [a, b, c] = localUturn(route.points)!
        const end = route.points[route.points.length - 1]
        expect(haversine(end, a)).toBeCloseTo(6, 1)
        expect(haversine(a, b)).toBeCloseTo(5, 1)
        expect(haversine(b, c)).toBeCloseTo(14, 1)
        expect(haversine(end, c)).toBeCloseTo(Math.hypot(5, 8), 1)
      }
    }
  })

  it('can be made a different size, and start further on when a corner is just behind', () => {
    const route = routeOf(0, dense(20, [0, 0], [0, 200]))
    const end = route.points[route.points.length - 1]
    const [a, b, c] = localUturn(route.points, 1, { run: 9, across: 3, behind: 4 })!.map((p) => inFrame(0, p, end))
    expect(a[1]).toBeCloseTo(9, 1)
    expect(b[0]).toBeCloseTo(3, 1)
    expect(c[1]).toBeCloseTo(-4, 1)
    // 4 m after a square corner off a straight road: it starts 22 m on to clear the corner, and the way back stops 2 m past the end (see below), so it goes
    // on 6 m more, to 28 m, for a way back of 26 m.
    const cornered = routeOf(0, [[0, 0], [0, 100], [4, 100]])
    const there = cornered.points[cornered.points.length - 1]
    const [a2, b2, c2] = localUturn(cornered.points)!.map((p) => inFrame(90, p, there))
    expect(uturnRun(cornered.points)).toBeCloseTo(22, 1)
    expect(a2[1]).toBeCloseTo(28, 1)
    expect(c2[1]).toBeCloseTo(2, 1)
    expect(b2[1] - c2[1]).toBeCloseTo(UTURN_CLEAR_M, 1)
    // A run or a way back given is drawn as it is, with nothing made longer.
    const [a3, , c3] = localUturn(cornered.points, 1, { run: 22 })!.map((p) => inFrame(90, p, there))
    expect(a3[1]).toBeCloseTo(22, 1)
    expect(c3[1]).toBeCloseTo(2, 1)
    const [a4, , c4] = localUturn(cornered.points, 1, { behind: 2 })!.map((p) => inFrame(90, p, there))
    expect(a4[1]).toBeCloseTo(22, 1)
    expect(c4[1]).toBeCloseTo(-2, 1)
  })

  /** A road north to 200 m, then round a corner `angle` degrees to the right (`turn` 1) or left into a side street, and `back` m along it to the end, heading `h`. */
  const intoSideStreet = (h: number, angle: number, turn: 1 | -1, back: number): Route =>
    routeOf(h, [[0, 0], [0, 100], [0, 200], [back * Math.sin(rad(turn * angle)), 200 + back * Math.cos(rad(turn * angle))]])

  it('end short of 8 m behind after a corner off a straight road just before the end: 6 m or more from that road\'s line, so the road service puts it on the side street, and the box goes on further to keep the way back 26 m', () => {
    expect(UTURN_SNAP_CLEAR_M).toBe(1)
    let short = 0
    for (const h of [0, 37, 90, 200, 315]) {
      for (const angle of [60, 75, 90, 105, 120, 135]) {
        for (const turn of [1, -1] as const) {
          for (const back of [3.5, 4, 5, 6, 8, 10, 12, 14, 16, 20]) {
            const route = intoSideStreet(h, angle, turn, back)
            const end = route.points[route.points.length - 1]
            const [a, b, c] = localUturn(route.points)!
            const label = `${h} ${angle} ${turn} ${back}`
            // The road before the corner is the line x = 0 in this frame.
            expect(Math.abs(inFrame(h, c)[0]), label).toBeGreaterThanOrEqual(UTURN_ACROSS_M + UTURN_SNAP_CLEAR_M - 0.01)
            // The way back ends where `uturnBehind` says, never further behind than 8 m.
            const run = uturnRun(route.points)
            const behind = uturnBehind(route.points, endHeading(route.points)!, 1, run, UTURN_ACROSS_M)
            expect(behind, label).toBeLessThanOrEqual(UTURN_BEHIND_M)
            expect(haversine(b, c) - haversine(end, a), label).toBeCloseTo(behind, 1)
            if (behind < UTURN_BEHIND_M) {
              // Stopped short, the box goes on far enough for a way back of 26 m (and never less far than the run): a turn out of the street, tapped next, is clear of it.
              short++
              expect(haversine(end, a), label).toBeCloseTo(Math.max(run, UTURN_CLEAR_M - behind), 1)
              expect(haversine(b, c), label).toBeGreaterThanOrEqual(UTURN_CLEAR_M - 0.01)
            } else {
              expect(haversine(end, a), label).toBeCloseTo(run, 1)
            }
            // And it is still known as a U-turn drawn on the spot, which the road for the next tap is drawn on from.
            expect(endsWithUturn(drawUturn(route, 'both')!.route.points), label).toBe(true)
          }
        }
      }
    }
    // Most of these stop short; a corner 14 m or more back mostly does not.
    expect(short).toBeGreaterThan(5 * 6 * 2 * 6)
    expect(short).toBeLessThan(5 * 6 * 2 * 10)
    // A square corner 4 m back: the way back stops 2 m past the end, 6 m along the side street from the road before it, and 5 m to the side. The box goes
    // 28 m on past the end, 32 m along the side street, so the way back is 26 m.
    const [a, , c] = localUturn(intoSideStreet(0, 90, 1, 4).points)!.map((p) => inFrame(0, p))
    expect(c[0]).toBeCloseTo(6, 1)
    expect(c[1]).toBeCloseTo(200 - UTURN_ACROSS_M, 1)
    expect(a[0]).toBeCloseTo(32, 1)
    expect(a[1]).toBeCloseTo(200, 1)
  })

  it('end 8 m behind as before on a straight road, after a corner far enough back, or after a road that is no straight line, and wherever asked', () => {
    const behindOf = (points: Pt[]) => uturnBehind(points, endHeading(points)!, 1, uturnRun(points), UTURN_ACROSS_M)
    for (const h of [0, 37, 90, 200, 315]) {
      const straight = routeOf(h, dense(20, [0, 0], [0, 300])).points
      expect(behindOf(straight)).toBe(UTURN_BEHIND_M)
      // A square corner more than 14 m back: 8 m behind is 6 m or more along the side street already.
      for (const back of [14.5, 16, 20, 25]) expect(behindOf(intoSideStreet(h, 90, 1, back).points), `${h} ${back}`).toBe(UTURN_BEHIND_M)
      // The button pressed twice: the corner just behind is the first U-turn's, and the road into it is the piece across, which has no line of its own.
      const first = drawUturn(routeOf(h, dense(20, [0, 0], [0, 300])), 'both')!
      expect(behindOf(first.route.points), `${h}`).toBe(UTURN_BEHIND_M)
      // A size given is the size drawn.
      const cornered = intoSideStreet(h, 90, 1, 4).points
      const end = cornered[cornered.length - 1]
      const [, , c] = localUturn(cornered, 1, { behind: UTURN_BEHIND_M })!.map((p) => inFrame(h + 90, p, end))
      expect(c[1], `${h}`).toBeCloseTo(-UTURN_BEHIND_M, 1)
    }
  })

  it('are none where the route has no way', () => {
    expect(localUturn([])).toBeNull()
    expect(localUturn([spot(0, [0, 0])])).toBeNull()
    expect(localUturn([spot(0, [0, 0]), spot(0, [0, 0.5])])).toBeNull()
  })
})

describe('the route with the U-turn on it', () => {
  const OUT = dense(20, [0, 0], [0, 300])

  it('has the three points on the end of it, and nothing else changed', () => {
    const route = routeOf(30, OUT)
    const shape = localUturn(route.points)!
    const next = withUturn(route, shape, 'both')
    expect(next.points).toEqual([...route.points, ...shape])
    expect(next.stops).toEqual(route.stops)
  })

  it('draws the whole of it and says which points it added', () => {
    const route = routeOf(30, OUT)
    const drawn = drawUturn(route, 'left')!
    expect(drawn.added).toEqual(localUturn(route.points))
    expect(drawn.route.points).toEqual([...route.points, ...drawn.added])
    expect(drawUturn(EMPTY, 'both')).toBeNull()
    expect(drawUturn(routeOf(0, [[0, 0]]), 'both')).toBeNull()
  })

  it('is thrown on the side being drawn from the turn on, and the run on past the end stays with the pass just driven', () => {
    const cases: [Side, Side][] = [['right', 'left'], ['left', 'right'], ['both', 'left'], ['right', 'transit'], ['transit', 'both'], ['left', 'both']]
    for (const [was, now] of cases) {
      const route = routeOf(0, OUT, was)
      const next = drawUturn(route, now)!.route
      const secs = sections(next)
      const segs = next.points.length - 1
      // The turn is the second of the three new segments: the first is the run on, which keeps the side already there.
      expect(sideAt(next, segs - 3), `${was} ${now} run on`).toBe(was)
      expect(sideAt(next, segs - 2), `${was} ${now} across`).toBe(now)
      expect(sideAt(next, segs - 1), `${was} ${now} back`).toBe(now)
      expect(secs[secs.length - 1].side).toBe(now)
    }
  })

  it('is one section with the road already thrown on that side: right out, right back covers both sides of the street', () => {
    for (const side of ['right', 'left', 'both', 'transit'] as const) {
      const route = routeOf(0, OUT, side)
      const next = drawUturn(route, side)!.route
      expect(next.sideChanges).toEqual(route.sideChanges)
      expect(sections(next)).toHaveLength(1)
    }
  })

  it('starts a new section at the turn, not at the old end, when the side changes: out right, back left splits at 306 m', () => {
    const route = routeOf(0, OUT, 'right')
    const next = drawUturn(route, 'left')!.route
    const secs = sections(next)
    expect(secs.map((s) => s.side)).toEqual(['right', 'left'])
    expect(secs[0].startM).toBe(0)
    expect(secs[1].startM).toBeCloseTo(300 + UTURN_RUN_M, 1)
    expect(secs[1].endM).toBeCloseTo(300 + UTURN_RUN_M + UTURN_ACROSS_M + UTURN_RUN_M + UTURN_BEHIND_M, 1)
  })

  it('mirrors the sides of a street driven out and back: a house is on the right on the way out and the left on the way back', () => {
    // 300 m north, thrown right out and right back; a no-throw house on the east side, which is the right of the way out and the left of the way back.
    const at = spot(0, [12, 150])
    const house: Stop = { id: 'h', type: 'nothrow', lat: at.lat, lng: at.lng, pathIdx: 7 }
    const turned = drawUturn(routeOf(0, OUT, 'right'), 'right')!.route
    // The road resumes from the end of the U-turn and runs back down the other side.
    const c = inFrame(0, turned.points[turned.points.length - 1])
    const full: Route = { ...appendPoints(turned, dense(20, c, [c[0], 100]).slice(1).map((s) => spot(0, s)), 'right'), stops: [house] }
    expect(sections(full)).toHaveLength(1)
    const occs = occurrences(full)
    expect(occs).toHaveLength(2)
    expect(occs.map((o) => stopSide(full.points, o.idx, house))).toEqual(['right', 'left'])
    // Thrown right on both passes, the house is passed with the window open on the way out and is the other side on the way back.
    expect(occs.map((o) => quietReason(full, occs, o))).toEqual([null, 'otherSide'])
  })

  it('is taken off again, all three points at once, and the route is as it was, for every side', () => {
    const stop: Stop = { id: 's', type: 'bundle', lat: spot(0, [12, 290]).lat, lng: spot(0, [12, 290]).lng, pathIdx: 14 }
    for (const was of ['right', 'left', 'both', 'transit'] as const) {
      for (const now of ['right', 'left', 'both', 'transit'] as const) {
        const route: Route = { ...routeOf(70, OUT, was), stops: [{ ...stop, lat: spot(70, [12, 290]).lat, lng: spot(70, [12, 290]).lng }] }
        const drawn = drawUturn(route, now)!
        const undone = undoStretch(drawn.route, [{ added: drawn.added, replaced: null }])
        expect(undone, `${was} ${now}`).not.toBeNull()
        expect(undone!.route, `${was} ${now}`).toEqual(route)
        expect(undone!.history).toEqual([])
      }
    }
  })

  it('is known again at the end of the route, exactly, and nothing else is', () => {
    const route = routeOf(30, OUT)
    const drawn = drawUturn(route, 'both')!
    expect(endsWithUturn(drawn.route.points)).toBe(true)
    // Another drawn straight after it, and the route saved and loaded again.
    expect(endsWithUturn(drawUturn(drawn.route, 'both')!.route.points)).toBe(true)
    expect(endsWithUturn(JSON.parse(JSON.stringify(drawn.route.points)) as Pt[])).toBe(true)
    // Not the route before it, one drawn the other way round or of another size, nor one with a point moved by a centimetre, or a point before it moved.
    expect(endsWithUturn(route.points)).toBe(false)
    expect(endsWithUturn([...route.points, ...localUturn(route.points, -1)!])).toBe(false)
    expect(endsWithUturn([...route.points, ...localUturn(route.points, 1, { across: 4 })!])).toBe(false)
    const nudge = (points: Pt[], i: number): Pt[] => points.map((p, k) => (k === i ? { ...p, lng: p.lng + 1e-7 } : p))
    expect(endsWithUturn(nudge(drawn.route.points, drawn.route.points.length - 1))).toBe(false)
    expect(endsWithUturn(nudge(drawn.route.points, drawn.route.points.length - 5))).toBe(false)
    // Nor a route too short to have one.
    expect(endsWithUturn([])).toBe(false)
    expect(endsWithUturn(drawn.added)).toBe(false)
  })

  it('is taken off the whole way even when a U-turn was drawn after another', () => {
    const route = routeOf(0, OUT, 'both')
    const first = drawUturn(route, 'both')!
    const second = drawUturn(first.route, 'both')!
    expect(second.route.points).toHaveLength(route.points.length + 6)
    const undone = undoStretch(second.route, [{ added: first.added, replaced: null }, { added: second.added, replaced: null }])!
    expect(undone.route).toEqual(first.route)
    expect(undoStretch(undone.route, undone.history)!.route).toEqual(route)
  })
})

describe('what the driver is told', () => {
  it('says the U-turn is drawn and to tap where the road goes next', () => {
    expect(UTURN_ADDED_NOTICE).toBe('U-turn added. Tap where the road goes next.')
    for (const side of ['both', 'transit'] as const) expect(uturnHereNotice(side)).toBe(UTURN_ADDED_NOTICE)
  })

  it('adds that Left and Right are as you drive when the brush is Left or Right', () => {
    expect(UTURN_SIDE_NOTICE).toBe('Left and Right are as you drive, so after the U-turn this is the other side of the street.')
    for (const side of ['left', 'right'] as const) expect(uturnHereNotice(side)).toBe(`${UTURN_ADDED_NOTICE} ${UTURN_SIDE_NOTICE}`)
  })
})

describe('the hook behind the U-turn here button', () => {
  beforeEach(() => {
    rate.minGapMs = 0
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  type Roads = ReturnType<typeof useRoadFollow>

  /** The hook as the drawing screen has it, rendered once on the server: what it gives back and what it told the screen. */
  function mount(route: Route, opts: { side?: Side; active?: boolean } = {}) {
    const told = { routes: [] as Route[], notices: [] as (string | null)[] }
    const held: Roads[] = []
    function Probe({ keep }: { keep: (roads: Roads) => void }) {
      keep(
        useRoadFollow({
          route,
          side: opts.side ?? 'both',
          active: opts.active ?? false,
          onRoute: (r) => told.routes.push(r),
          onNotice: (m) => told.notices.push(m),
        }),
      )
      return null
    }
    renderToStaticMarkup(createElement(Probe, { keep: (roads: Roads) => held.push(roads) }))
    return { roads: held[0], told }
  }

  const road = routeOf(25, dense(20, [0, 0], [0, 300]), 'both')

  it('offers a U-turn here whenever the route has a way it is heading, with Follow roads on or off', () => {
    for (const active of [true, false]) {
      const { roads } = mount(road, { active })
      expect(roads.canUturnHere, `${active}`).toBe(true)
      // The U-turn along the road needs Follow roads, as it did.
      expect(roads.canUturn, `${active}`).toBe(active)
    }
  })

  it('offers none where there is no way to turn back along', () => {
    for (const points of [[], [spot(0, [0, 0])], [spot(0, [0, 0]), spot(0, [0, 0.3])]]) {
      const { roads, told } = mount({ ...EMPTY, points })
      expect(roads.canUturnHere).toBe(false)
      roads.uturnHere()
      expect(told.routes).toEqual([])
      expect(told.notices).toEqual([])
    }
  })

  it('draws the U-turn at once, with Follow roads off, and says so', () => {
    const { roads, told } = mount(road, { active: false })
    roads.uturnHere()
    expect(told.routes).toHaveLength(1)
    expect(told.routes[0]).toEqual(drawUturn(road, 'both')!.route)
    expect(told.routes[0].points).toHaveLength(road.points.length + 3)
    expect(told.notices).toEqual([UTURN_ADDED_NOTICE])
  })

  it('draws it on the side being drawn, and says what Left and Right mean now when that is Left or Right', () => {
    for (const side of ['left', 'right'] as const) {
      const { roads, told } = mount(road, { side })
      roads.uturnHere()
      expect(told.routes[0]).toEqual(drawUturn(road, side)!.route)
      expect(told.notices).toEqual([uturnHereNotice(side)])
      expect(told.notices[0]).toContain(UTURN_SIDE_NOTICE)
    }
  })

  it('is taken back whole by Undo: all three points, and the route is as it was', () => {
    const stop: Stop = { id: 'b', type: 'bundle', lat: spot(25, [10, 280]).lat, lng: spot(25, [10, 280]).lng, pathIdx: 14 }
    const start: Route = { ...routeOf(25, dense(20, [0, 0], [0, 300]), 'right'), stops: [stop] }
    // A render that draws the U-turn, and then (the route having changed, as the screen does it) takes it back. The hook is the same one through both: a state
    // change while rendering makes the component run again with what it was told, and its refs, where the stretches Undo takes back are kept, stay.
    const seen: { route: Route; undone: boolean[] } = { route: start, undone: [] }
    function Probe() {
      const [step, setStep] = useState(0)
      const roads = useRoadFollow({
        route: seen.route,
        side: 'left',
        active: false,
        onRoute: (r) => {
          seen.route = r
        },
        onNotice: () => undefined,
      })
      if (step === 0) {
        roads.uturnHere()
        setStep(1)
      } else if (step === 1) {
        // The U-turn is on the route now, as Setup would have it.
        seen.undone.push(seen.route.points.length === start.points.length + 3)
        seen.undone.push(roads.undo())
        setStep(2)
      }
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    expect(seen.undone).toEqual([true, true])
    expect(seen.route).toEqual(start)
  })

  it('needs no road service: it asks for nothing', () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const { roads } = mount(road, { active: true })
    roads.uturnHere()
    expect(f).not.toHaveBeenCalled()
  })

  it('gives up a road lookup that is still running, so its answer cannot land on a route it was not for', async () => {
    const asked: AbortSignal[] = []
    const f = vi.fn((_url: string, init?: RequestInit) => {
      asked.push(init!.signal!)
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    })
    vi.stubGlobal('fetch', f)
    const { roads, told } = mount(road, { active: true })
    roads.tap(spot(25, [60, 200]))
    // Let the request go out.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f).toHaveBeenCalledTimes(1)
    roads.uturnHere()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked[0].aborted).toBe(true)
    expect(told.routes).toHaveLength(1)
    // And the lookup is no longer taking the screen: a tap can start a new one.
    roads.tap(spot(25, [80, 200]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f).toHaveBeenCalledTimes(2)
  })
})

describe('the U-turn buttons on the drawing screen', () => {
  const route = routeOf(0, dense(20, [0, 0], [0, 200]), 'both')
  const props = (extra: Partial<Parameters<typeof RouteTab>[0]> = {}): Parameters<typeof RouteTab>[0] => ({
    route,
    recording: false,
    tracePoints: 0,
    drawing: true,
    brush: 'both',
    onBrush: () => undefined,
    follow: false,
    onFollow: () => undefined,
    finding: false,
    canUturnHere: true,
    onUturnHere: () => undefined,
    canUturn: false,
    uturn: false,
    onUturn: () => undefined,
    onAddress: () => undefined,
    selectedPoint: null,
    onDeletePoint: () => undefined,
    gpsError: null,
    onDraw: () => undefined,
    onDone: () => undefined,
    onUndo: () => undefined,
    onClear: () => undefined,
    onRecord: () => undefined,
    onStopRecord: () => undefined,
    onFind: () => undefined,
    onNext: () => undefined,
    streets: [],
    onStreets: () => undefined,
    ...extra,
  })
  const html = (extra: Partial<Parameters<typeof RouteTab>[0]> = {}) => renderToStaticMarkup(createElement(RouteTab, props(extra)))
  /** The opening tag of the button with this label, or null when there is none. */
  const button = (out: string, label: string): string | null => {
    const at = out.indexOf(`${label}</button>`)
    if (at < 0) return null
    return out.slice(out.lastIndexOf('<button', at), out.indexOf('>', out.lastIndexOf('<button', at)) + 1)
  }

  it('has a U-turn here button with Follow roads off, and no U-turn along the road', () => {
    const out = html()
    expect(button(out, 'U-turn here')).not.toBeNull()
    expect(button(out, 'U-turn along the road')).toBeNull()
    expect(out).not.toContain('aria-pressed="false" title="Makes the road')
  })

  it('has both with Follow roads on, the one along the road a switch', () => {
    const out = html({ follow: true, canUturn: true })
    expect(button(out, 'U-turn here')).not.toBeNull()
    const along = button(out, 'U-turn along the road')!
    expect(along).toContain('aria-pressed="false"')
    expect(button(html({ follow: true, canUturn: true, uturn: true }), 'U-turn along the road')).toContain('aria-pressed="true"')
    // Here first: it is the one that always works.
    expect(out.indexOf('U-turn here')).toBeLessThan(out.indexOf('U-turn along the road'))
  })

  it('has neither where the route has no way it is heading', () => {
    const out = html({ canUturnHere: false, canUturn: false })
    expect(out).not.toContain('U-turn')
  })

  it('cannot be pressed while a road is being looked up', () => {
    const idle = html({ follow: true, canUturn: true })
    expect(button(idle, 'U-turn here')).not.toContain('disabled')
    expect(button(idle, 'U-turn along the road')).not.toContain('disabled')
    const busy = html({ follow: true, canUturn: true, finding: true })
    expect(button(busy, 'U-turn here')).toContain('disabled')
    expect(button(busy, 'U-turn along the road')).toContain('disabled')
  })

  it('is not on the screen when the route is not being drawn', () => {
    expect(html({ drawing: false })).not.toContain('U-turn here')
  })

  it('says what it does', () => {
    expect(html()).toContain('Draws a U-turn at the end of your route.')
  })
})
