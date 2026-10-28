import { describe, expect, it } from 'vitest'
import { cumulativeDistances, simplify } from './geo'
import { ROAD_SIMPLIFY_M } from './roads'
import {
  arrowShape,
  MIN_TURN_DEG,
  onTheRoute,
  pointAt,
  routeTurns,
  spokenDistance,
  spokenMetres,
  TURN_HALF_M,
  TURN_KM_M,
  TURN_NEAR_M,
  TURN_SHOW_M,
  turnAheadText,
  turnCue,
  turnKind,
  turnSpeech,
  TURN_HEADING_TOLERANCE,
  TURN_PASSED_M,
  turnWords,
  UTURN_CORNER_DEG,
  UTURN_GAP_M,
  UTURN_MAX_DEG,
  UTURN_MIN_DEG,
  upcomingTurn,
  type Turn,
  type TurnCue,
} from './turns'
import type { Pt } from './types'

// A place in Sydney, so the maths is checked away from the equator and the prime meridian.
const ORIGIN = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
const sin = (deg: number) => Math.sin((deg * Math.PI) / 180)
const cos = (deg: number) => Math.cos((deg * Math.PI) / 180)

/** A spot `x` metres east and `y` metres north of the start. */
const spot = ([x, y]: readonly [number, number]): Pt => ({
  lat: ORIGIN.lat + y / M_PER_DEG,
  lng: ORIGIN.lng + x / (M_PER_DEG * cos(ORIGIN.lat)),
})

/** A route that goes through these spots (metres east and north of the start): points only where they are, like one drawn by tapping. */
const through = (...xy: [number, number][]): Pt[] => xy.map(spot)

type Move = { straight: number } | { turn: number; radius: number }

/**
 * A route driven from the start heading north: along a straight, or round a bend (positive to the right,
 * negative to the left) of that radius. A point every `step` metres, like one that follows the roads.
 */
function drive(moves: Move[], step = 5, wobble = 0): Pt[] {
  let x = 0
  let y = 0
  let h = 0
  const out: [number, number][] = [[x, y]]
  const push = (px: number, py: number) => {
    // Nudge every other point across the road, to stand in for a route that isn't perfectly smooth.
    const side = out.length % 2 ? wobble : -wobble
    out.push([px + side * cos(h), py - side * sin(h)])
  }
  for (const m of moves) {
    if ('straight' in m) {
      const n = Math.max(1, Math.round(m.straight / step))
      for (let i = 1; i <= n; i++) push(x + ((m.straight * i) / n) * sin(h), y + ((m.straight * i) / n) * cos(h))
      x += m.straight * sin(h)
      y += m.straight * cos(h)
    } else {
      const s = Math.sign(m.turn)
      const around = [x + s * m.radius * cos(h), y - s * m.radius * sin(h)]
      const n = Math.max(1, Math.ceil(((Math.abs(m.turn) * Math.PI) / 180) * m.radius / step))
      for (let i = 1; i <= n; i++) {
        const heading = h + (s * Math.abs(m.turn) * i) / n
        push(around[0] - s * m.radius * cos(heading), around[1] + s * m.radius * sin(heading))
      }
      const end = h + m.turn
      x = around[0] - s * m.radius * cos(end)
      y = around[1] + s * m.radius * sin(end)
      h = end
    }
  }
  return out.map(spot)
}

const near = (a: number, b: number, within: number) => Math.abs(a - b) <= within

/** A turn made by hand, `half` metres either side of where it is. */
const turnAt = (at: number, angle: number, heading: number, half = 0): Turn => ({ at, from: at - half, to: at + half, angle, heading })

describe('finding the turns in a route', () => {
  it('finds none in a straight road, however it is drawn', () => {
    expect(routeTurns(through([0, 0], [0, 100], [0, 300], [0, 500]))).toEqual([])
    expect(routeTurns(drive([{ straight: 500 }]))).toEqual([])
    expect(routeTurns(through([0, 0], [0, 500]))).toEqual([])
  })

  it('has none for a route too short to turn', () => {
    expect(routeTurns([])).toEqual([])
    expect(routeTurns(through([0, 0]))).toEqual([])
    expect(routeTurns(through([0, 0], [0, 4], [3, 4]))).toEqual([])
  })

  it('finds a corner to the right, where it is, and how far it turns', () => {
    const turns = routeTurns(through([0, 0], [0, 200], [200, 200]))
    expect(turns).toHaveLength(1)
    expect(near(turns[0].at, 200, 3)).toBe(true)
    expect(near(turns[0].angle, 90, 2)).toBe(true)
  })

  it('finds a corner to the left as a negative angle', () => {
    const turns = routeTurns(through([0, 0], [0, 200], [-200, 200]))
    expect(turns).toHaveLength(1)
    expect(near(turns[0].at, 200, 3)).toBe(true)
    expect(near(turns[0].angle, -90, 2)).toBe(true)
  })

  it('finds the same corner in a route with a point every 5 m', () => {
    const turns = routeTurns(drive([{ straight: 200 }, { turn: 90, radius: 0.001 }, { straight: 200 }]))
    expect(turns).toHaveLength(1)
    expect(near(turns[0].at, 200, 4)).toBe(true)
    expect(near(turns[0].angle, 90, 3)).toBe(true)
  })

  it('finds a corner that is rounded off, in the middle of the round', () => {
    const turns = routeTurns(drive([{ straight: 190 }, { turn: 90, radius: 10 }, { straight: 190 }], 2))
    expect(turns).toHaveLength(1)
    // The 90 degrees bend over 16 m of arc, from 190 m to about 206 m.
    expect(near(turns[0].at, 198, 4)).toBe(true)
    expect(near(turns[0].angle, 90, 3)).toBe(true)
  })

  it('finds a curve tight enough to be a corner', () => {
    const turns = routeTurns(drive([{ straight: 150 }, { turn: -90, radius: 30 }, { straight: 150 }]))
    expect(turns).toHaveLength(1)
    expect(near(turns[0].angle, -90, 5)).toBe(true)
    expect(near(turns[0].at, 150 + 47 / 2, 8)).toBe(true)
  })

  it('does not call a long gentle curve a turn, however far round it goes', () => {
    expect(routeTurns(drive([{ straight: 100 }, { turn: 90, radius: 100 }, { straight: 100 }]))).toEqual([])
    expect(routeTurns(drive([{ straight: 100 }, { turn: -120, radius: 150 }, { straight: 100 }]))).toEqual([])
  })

  it('finds a bend that is only part way, and not one that is slighter than that', () => {
    const bear = routeTurns(through([0, 0], [0, 200], [150, 340]))
    expect(bear).toHaveLength(1)
    expect(near(bear[0].angle, 47, 2)).toBe(true)
    expect(routeTurns(through([0, 0], [0, 200], [70, 360]))).toEqual([])
    expect(MIN_TURN_DEG).toBe(40)
  })

  it('finds a hairpin as a turn right round', () => {
    const turns = routeTurns(through([0, 0], [0, 200], [0, 0]))
    expect(turns).toHaveLength(1)
    expect(near(turns[0].at, 200, 3)).toBe(true)
    expect(Math.abs(turns[0].angle)).toBeGreaterThanOrEqual(175)
  })

  it('finds a U-turn made of two corners close together as one turn', () => {
    // Up one side of a median and back down the other, 8 m across.
    const turns = routeTurns(through([0, 0], [0, 200], [8, 200], [8, 0]))
    expect(turns).toHaveLength(1)
    expect(near(turns[0].at, 204, 4)).toBe(true)
    expect(near(turns[0].angle, 180, 4)).toBe(true)
  })

  it('keeps a dog-leg as two turns, left and then right', () => {
    const turns = routeTurns(through([0, 0], [0, 200], [-30, 200], [-30, 400]))
    expect(turns).toHaveLength(2)
    expect(near(turns[0].angle, -90, 3)).toBe(true)
    expect(near(turns[1].angle, 90, 3)).toBe(true)
    expect(near(turns[0].at, 200, 3)).toBe(true)
    expect(near(turns[1].at, 230, 3)).toBe(true)
  })

  it('makes one turn of two bends close together the same way, as a corner drawn with a short cut across it', () => {
    // 45 degrees right, 15 m on, and 45 degrees right again.
    const turns = routeTurns(through([0, 0], [0, 100], [10.6, 110.6], [110.6, 110.6]))
    expect(turns).toHaveLength(1)
    expect(near(turns[0].angle, 90, 3)).toBe(true)
    expect(near(turns[0].at, 107, 5)).toBe(true)
  })

  it('keeps two corners with a straight between them as two turns, even when it is short', () => {
    const turns = routeTurns(through([0, 0], [0, 200], [-20, 200], [-20, 400]))
    expect(turns.map((x) => Math.round(x.angle / 10) * 10)).toEqual([-90, 90])
  })

  it('makes one turn of a swing there is no straight in, as far as it leaves you turned', () => {
    // Into a roundabout, round it, and out: the first exit turns you left, the third right, the second not at all.
    const roundabout = (round: number) =>
      routeTurns(drive([{ straight: 100 }, { turn: -90, radius: 8 }, { turn: round, radius: 20 }, { turn: -90, radius: 8 }, { straight: 100 }]))
    const first = roundabout(90)
    expect(first).toHaveLength(1)
    expect(near(first[0].angle, -90, 8)).toBe(true)
    const third = roundabout(270)
    expect(third).toHaveLength(1)
    expect(near(third[0].angle, 90, 8)).toBe(true)
    expect(roundabout(180)).toEqual([])
  })

  it('finds nothing in a chicane, or a jog too short to have a straight in it', () => {
    expect(routeTurns(drive([{ straight: 100 }, { turn: 60, radius: 30 }, { turn: -60, radius: 30 }, { straight: 100 }]))).toEqual([])
    expect(routeTurns(through([0, 0], [0, 200], [8, 200], [8, 400]))).toEqual([])
  })

  it('finds nothing in a loop that comes out heading the way it went in', () => {
    expect(routeTurns(drive([{ straight: 100 }, { turn: 360, radius: 25 }, { straight: 100 }]))).toEqual([])
  })

  it('finds each turn in a route with several, in order along it', () => {
    const route = through([0, 0], [0, 100], [150, 100], [150, 300], [20, 300], [20, 420])
    const turns = routeTurns(route)
    const cum = cumulativeDistances(route)
    expect(turns).toHaveLength(4)
    expect(turns.map((t) => Math.round(t.angle / 10) * 10)).toEqual([90, -90, -90, 90])
    for (const [i, t] of turns.entries()) expect(near(t.at, cum[i + 1], 3)).toBe(true)
    expect(turns.map((t) => t.at)).toEqual([...turns.map((t) => t.at)].sort((a, b) => a - b))
  })

  it('still finds a turn in a route that is not quite smooth', () => {
    const turns = routeTurns(drive([{ straight: 150 }, { turn: 90, radius: 30 }, { straight: 150 }], 5, 0.4))
    expect(turns).toHaveLength(1)
    expect(near(turns[0].angle, 90, 25)).toBe(true)
  })

  it('does not find turns in a straight road that is not quite smooth', () => {
    expect(routeTurns(drive([{ straight: 400 }], 5, 0.5))).toEqual([])
  })

  it('says which way the route heads as it comes up to each turn', () => {
    const turns = routeTurns(through([0, 0], [0, 200], [200, 200], [200, 0]))
    expect(turns).toHaveLength(2)
    // North, then east, then south.
    expect(near(turns[0].heading, 0, 5)).toBe(true)
    expect(near(turns[1].heading, 90, 5)).toBe(true)
  })

  it('says it for a turn that is rounded off, and in the other half of the compass', () => {
    const turns = routeTurns(drive([{ straight: 150 }, { turn: -90, radius: 15 }, { straight: 150 }, { turn: -90, radius: 15 }, { straight: 100 }]))
    expect(turns).toHaveLength(2)
    expect(near(turns[0].heading, 0, 8)).toBe(true)
    expect(near(turns[1].heading, 270, 8)).toBe(true)
  })

  it('works the same for a route in the northern hemisphere', () => {
    const route: Pt[] = [
      { lat: 51, lng: -0.1 },
      { lat: 51.002, lng: -0.1 },
      { lat: 51.002, lng: -0.0971 },
    ]
    const turns = routeTurns(route)
    expect(turns).toHaveLength(1)
    expect(near(turns[0].angle, 90, 2)).toBe(true)
  })
})

describe('where a turn starts and ends', () => {
  it('has the same place for the start, the end and the middle of a corner drawn with a point on it', () => {
    const [t] = routeTurns(through([0, 0], [0, 200], [200, 200]))
    expect(t.from).toBe(200)
    expect(t.to).toBe(200)
    expect(t.at).toBe(200)
  })

  it('puts the middle of a turn halfway between its start and its end, exactly', () => {
    const route = drive([{ straight: 150 }, { turn: 90, radius: 15 }, { straight: 150 }, { turn: -90, radius: 25 }, { straight: 100 }])
    const turns = routeTurns(route)
    expect(turns).toHaveLength(2)
    for (const t of turns) expect(t.at).toBe((t.from + t.to) / 2)
  })

  it('starts and ends a rounded corner where the road swings round', () => {
    const [t] = routeTurns(drive([{ straight: 190 }, { turn: 90, radius: 10 }, { straight: 190 }], 2))
    // The 90 degrees bend is 16 m of arc, from 190 m to about 206 m.
    expect(near(t.from, 190, 2.5)).toBe(true)
    expect(near(t.to, 205, 2.5)).toBe(true)
    expect(t.to).toBeGreaterThan(t.from)
    expect(t.from).toBeLessThanOrEqual(t.at)
    expect(t.to).toBeGreaterThanOrEqual(t.at)
  })

  it('spans the whole of a roundabout, which is one turn', () => {
    const turns = routeTurns(drive([{ straight: 100 }, { turn: -90, radius: 8 }, { turn: 270, radius: 20 }, { turn: -90, radius: 8 }, { straight: 100 }]))
    expect(turns).toHaveLength(1)
    // 12.6 m in, 94 m round and 12.6 m out: from 100 m to about 219 m.
    expect(near(turns[0].from, 100, 2.5)).toBe(true)
    expect(near(turns[0].to, 219, 2.5)).toBe(true)
  })

  it('is on the route in steps of 5 m, the way the route is walked', () => {
    const turns = routeTurns(drive([{ straight: 150 }, { turn: 90, radius: 15 }, { straight: 150 }, { turn: -90, radius: 25 }, { straight: 100 }], 3))
    for (const t of turns) {
      expect(t.from % 5).toBe(0)
      expect(t.to % 5).toBe(0)
    }
  })

  it('keeps the turns of a route apart: one ends before the next starts', () => {
    const turns = routeTurns(through([0, 0], [0, 200], [-20, 200], [-20, 400], [100, 400], [100, 0]))
    expect(turns.length).toBeGreaterThanOrEqual(4)
    for (const [i, t] of turns.entries()) {
      expect(t.from).toBeLessThanOrEqual(t.to)
      if (i > 0) expect(turns[i - 1].to).toBeLessThan(t.from)
    }
  })

  it('covers a U-turn made of two corners close together', () => {
    const [t] = routeTurns(through([0, 0], [0, 200], [8, 200], [8, 0]))
    expect(t.from).toBe(200)
    expect(t.to).toBe(210)
    expect(t.at).toBe(205)
  })

  it('still gives the same middle as before', () => {
    const route = through([0, 0], [0, 100], [150, 100], [150, 300], [20, 300], [20, 420])
    const cum = cumulativeDistances(route)
    for (const [i, t] of routeTurns(route).entries()) expect(near(t.at, cum[i + 1], 3)).toBe(true)
  })
})

describe('the point a distance along the route', () => {
  const route = through([0, 0], [0, 100], [100, 100])
  const cum = cumulativeDistances(route)
  const length = cum[cum.length - 1]
  const metres = (a: Pt, b: Pt) => Math.hypot((b.lat - a.lat) * M_PER_DEG, (b.lng - a.lng) * M_PER_DEG * cos(ORIGIN.lat))

  it('is the start at 0 and the end at the length', () => {
    expect(pointAt(route, cum, 0)).toEqual(route[0])
    expect(pointAt(route, cum, length)).toEqual(route[2])
  })

  it('is on the segment it falls on, in proportion', () => {
    expect(metres(pointAt(route, cum, 50), spot([0, 50]))).toBeLessThan(0.1)
    expect(metres(pointAt(route, cum, 150), spot([50, 100]))).toBeLessThan(0.1)
  })

  it('is the corner at the corner', () => {
    expect(metres(pointAt(route, cum, cum[1]), route[1])).toBeLessThan(0.001)
  })

  it('stays on the route past either end', () => {
    expect(pointAt(route, cum, -20)).toEqual(route[0])
    expect(pointAt(route, cum, length + 20)).toEqual(route[2])
  })

  it('copes with a point repeated, and with a single point', () => {
    const twice = [route[0], route[1], route[1], route[2]]
    expect(metres(pointAt(twice, cumulativeDistances(twice), 100), route[1])).toBeLessThan(0.1)
    expect(pointAt([route[0]], [0], 10)).toEqual(route[0])
  })

  it('copes with the route ending in a point repeated', () => {
    const doubled = [route[0], route[1], route[1]]
    const doubledCum = cumulativeDistances(doubled)
    expect(pointAt(doubled, doubledCum, 150)).toEqual(route[1])
    expect(pointAt(doubled, doubledCum, doubledCum[2])).toEqual(route[1])
    expect(pointAt([route[0], route[0]], [0, 0], 5)).toEqual(route[0])
  })
})

describe('the turn to show', () => {
  const turns: Turn[] = [turnAt(100, 90, 0), turnAt(400, -90, 90)]

  it('is the next turn, once it is near enough to be worth showing', () => {
    expect(upcomingTurn(turns, 0)).toEqual({ turn: turns[0], ahead: 100 })
    expect(upcomingTurn(turns, 60)).toEqual({ turn: turns[0], ahead: 40 })
  })

  it('is nothing while the next one is far off', () => {
    expect(upcomingTurn(turns, 120)).toBeNull()
    expect(upcomingTurn(turns, 299)).toEqual({ turn: turns[1], ahead: 101 })
    expect(upcomingTurn(turns, 200)).toEqual({ turn: turns[1], ahead: 200 })
    expect(upcomingTurn(turns, 199)).toBeNull()
    expect(TURN_SHOW_M).toBe(200)
  })

  it('leaves out a turn the route comes up to the other way to the way the phone is heading', () => {
    // A street driven out and back has a turn at the same place for each way along it.
    const both: Turn[] = [turnAt(100, 90, 0), turnAt(160, -90, 180)]
    expect(upcomingTurn(both, 90, { heading: 0 })?.turn).toBe(both[0])
    expect(upcomingTurn(both, 90, { heading: 180 })?.turn).toBe(both[1])
  })

  it('goes by the heading within a margin, whichever way round the compass', () => {
    const north: Turn[] = [turnAt(100, 90, 355)]
    expect(upcomingTurn(north, 50, { heading: 5 })).not.toBeNull()
    expect(upcomingTurn(north, 50, { heading: 355 - TURN_HEADING_TOLERANCE + 1 })).not.toBeNull()
    expect(upcomingTurn(north, 50, { heading: 355 - TURN_HEADING_TOLERANCE - 1 })).toBeNull()
    expect(upcomingTurn(north, 50, { heading: (355 + TURN_HEADING_TOLERANCE + 1) % 360 })).toBeNull()
    expect(upcomingTurn(north, 50, { heading: 180 })).toBeNull()
  })

  it('does not go by the heading when the phone has none', () => {
    const turn: Turn[] = [turnAt(100, 90, 0)]
    expect(upcomingTurn(turn, 50, { heading: null })).not.toBeNull()
    expect(upcomingTurn(turn, 50)).not.toBeNull()
  })

  it('never brings back a turn already passed, however the position wanders', () => {
    expect(upcomingTurn(turns, 90, { after: 100 - TURN_PASSED_M })?.turn).toBe(turns[0])
    expect(upcomingTurn(turns, 90, { after: 100 })?.turn).toBeUndefined()
    expect(upcomingTurn(turns, 250, { after: 100 })?.turn).toBe(turns[1])
    // The position has slipped back to before the first turn, but the driver is known to have been past it.
    expect(upcomingTurn(turns, 60, { after: 300 })).toBeNull()
  })

  it('stays on a turn a little past it, and then moves on', () => {
    expect(upcomingTurn(turns, 112)?.turn).toBe(turns[0])
    expect(upcomingTurn(turns, 115)?.turn).toBe(turns[0])
    expect(upcomingTurn(turns, 116)).toBeNull()
    expect(upcomingTurn(turns, 250)?.turn).toBe(turns[1])
  })

  it('is nothing once the last turn is behind, or when there are none', () => {
    expect(upcomingTurn(turns, 500)).toBeNull()
    expect(upcomingTurn([], 0)).toBeNull()
  })

  it('looks as far ahead as it is asked to, 200 m unless told otherwise', () => {
    expect(upcomingTurn(turns, 0, { range: 100 })).toEqual({ turn: turns[0], ahead: 100 })
    expect(upcomingTurn(turns, 0, { range: 99 })).toBeNull()
    expect(upcomingTurn(turns, 0, { range: TURN_SHOW_M })).toEqual(upcomingTurn(turns, 0))
    expect(upcomingTurn(turns, 120, { range: 500 })).toEqual({ turn: turns[1], ahead: 280 })
    expect(upcomingTurn(turns, 120, { range: 279 })).toBeNull()
    expect(upcomingTurn(turns, 120, { range: Infinity })).toEqual({ turn: turns[1], ahead: 280 })
  })

  it('holds a turn to 60 degrees of the heading unless told another margin', () => {
    const turn: Turn[] = [turnAt(100, 90, 0)]
    expect(TURN_HEADING_TOLERANCE).toBe(60)
    expect(upcomingTurn(turn, 50, { heading: 60 })).not.toBeNull()
    expect(upcomingTurn(turn, 50, { heading: 61 })).toBeNull()
    expect(upcomingTurn(turn, 50, { heading: 100, tolerance: 120 })).not.toBeNull()
    expect(upcomingTurn(turn, 50, { heading: 120, tolerance: 120 })).not.toBeNull()
    expect(upcomingTurn(turn, 50, { heading: 121, tolerance: 120 })).toBeNull()
    expect(upcomingTurn(turn, 50, { heading: 100, tolerance: 30 })).toBeNull()
    expect(upcomingTurn(turn, 50, { heading: 30, tolerance: 30 })).not.toBeNull()
  })

  it('holds a turn to the margin at any distance, so one a long way off can be held to a wide one', () => {
    const far: Turn[] = [turnAt(1000, 90, 0)]
    // 500 m ahead, 100 degrees off: out by the usual margin, in by a wide one.
    expect(upcomingTurn(far, 500, { heading: 100, range: Infinity })).toBeNull()
    expect(upcomingTurn(far, 500, { heading: 100, range: Infinity, tolerance: 120 })).toEqual({ turn: far[0], ahead: 500 })
    expect(upcomingTurn(far, 500, { heading: 121, range: Infinity, tolerance: 120 })).toBeNull()
    // And one just in range, whichever side of 200 m.
    expect(upcomingTurn(far, 800, { heading: 100, tolerance: 120 })).toEqual({ turn: far[0], ahead: 200 })
    expect(upcomingTurn(far, 800, { heading: 100 })).toBeNull()
    // A margin is taken by the turn that is found, not the first one in the list: a nearer turn the heading is against is stepped over.
    const two: Turn[] = [turnAt(600, 90, 250), turnAt(900, -90, 0)]
    expect(upcomingTurn(two, 0, { heading: 100, range: Infinity, tolerance: 120 })).toEqual({ turn: two[1], ahead: 900 })
    expect(upcomingTurn(two, 0, { heading: 100, range: Infinity, tolerance: 160 })).toEqual({ turn: two[0], ahead: 600 })
  })

  it('still skips the other way along a street, and turns already passed, however far it looks', () => {
    const both: Turn[] = [turnAt(100, 90, 0), turnAt(5000, -90, 180)]
    expect(upcomingTurn(both, 90, { heading: 180, range: Infinity })?.turn).toBe(both[1])
    expect(upcomingTurn(both, 90, { heading: 180, range: 1000 })).toBeNull()
    expect(upcomingTurn(both, 90, { after: 100, range: Infinity })?.turn).toBe(both[1])
    expect(upcomingTurn(both, 6000, { range: Infinity })).toBeNull()
  })

  it('gives back the very turn it was given, with anything else it carries', () => {
    const named = [{ ...turnAt(100, 90, 0), street: 'Oak Road' }]
    expect(upcomingTurn(named, 0)?.turn).toBe(named[0])
    expect(upcomingTurn(named, 0)?.turn.street).toBe('Oak Road')
  })

  it('says how far away it is', () => {
    expect(turnAheadText(0)).toBe('Now')
    expect(turnAheadText(-8)).toBe('Now')
    expect(turnAheadText(14.9)).toBe('Now')
    expect(turnAheadText(15)).toBe('20 m')
    expect(turnAheadText(44)).toBe('40 m')
    expect(turnAheadText(45)).toBe('50 m')
    expect(turnAheadText(196)).toBe('200 m')
  })
})

describe('whether to trust where the phone is along the route', () => {
  it('does while it is on the route and the fix is good', () => {
    expect(onTheRoute(0, 5)).toBe(true)
    expect(onTheRoute(40, 5)).toBe(true)
    expect(onTheRoute(40, 16)).toBe(true)
  })

  it('does not once it is further from the route than that', () => {
    expect(onTheRoute(40.1, 5)).toBe(false)
    expect(onTheRoute(120, 5)).toBe(false)
  })

  it('lets a poor fix be further from the route, since it can be out by that much, up to a point', () => {
    expect(onTheRoute(60, 25)).toBe(true)
    expect(onTheRoute(62.6, 25)).toBe(false)
    expect(onTheRoute(100, 40)).toBe(true)
    expect(onTheRoute(160, 65)).toBe(true)
    expect(onTheRoute(163, 65)).toBe(false)
  })

  it('does not once the fix is too poor to go by at all', () => {
    expect(onTheRoute(5, 65)).toBe(true)
    expect(onTheRoute(5, 65.1)).toBe(false)
    expect(onTheRoute(5, 120)).toBe(false)
  })

  it('does not when the phone is too far from the route to say where along it the driver is', () => {
    expect(onTheRoute(5, 5, true)).toBe(false)
    expect(onTheRoute(5, 5, false)).toBe(true)
  })

  it('does not before there is a fix to go by', () => {
    expect(onTheRoute(null, 5)).toBe(false)
  })
})

describe('what to call a turn', () => {
  it('goes by how far it turns the heading, the same either way round', () => {
    for (const sign of [1, -1]) {
      expect(turnKind(sign * 40)).toBe('bear')
      expect(turnKind(sign * 69.9)).toBe('bear')
      expect(turnKind(sign * 70)).toBe('turn')
      expect(turnKind(sign * 129.9)).toBe('turn')
      expect(turnKind(sign * 130)).toBe('sharp')
      expect(turnKind(sign * 164.9)).toBe('sharp')
      expect(turnKind(sign * 165)).toBe('uturn')
      expect(turnKind(sign * 180)).toBe('uturn')
    }
  })

  it('has words for the card and words to say', () => {
    expect(turnWords(90)).toEqual({ label: 'Turn right', spoken: 'turn right' })
    expect(turnWords(-90)).toEqual({ label: 'Turn left', spoken: 'turn left' })
    expect(turnWords(50)).toEqual({ label: 'Bear right', spoken: 'bear right' })
    expect(turnWords(-50)).toEqual({ label: 'Bear left', spoken: 'bear left' })
    expect(turnWords(140)).toEqual({ label: 'Sharp right', spoken: 'turn sharp right' })
    expect(turnWords(-140)).toEqual({ label: 'Sharp left', spoken: 'turn sharp left' })
    expect(turnWords(180)).toEqual({ label: 'U-turn', spoken: 'make a U-turn' })
    expect(turnWords(-175)).toEqual({ label: 'U-turn', spoken: 'make a U-turn' })
  })
})

describe('when to speak', () => {
  it('warns when a turn comes into view, then says it again at the turn', () => {
    expect(turnCue(200, null)).toBe('far')
    expect(turnCue(150, 'far')).toBeNull()
    expect(turnCue(TURN_NEAR_M + 1, 'far')).toBeNull()
    expect(turnCue(TURN_NEAR_M, 'far')).toBe('near')
    expect(turnCue(20, 'near')).toBeNull()
    expect(turnCue(-5, 'near')).toBeNull()
  })

  it('says only the last word for a turn first seen when it is already near', () => {
    expect(turnCue(40, null)).toBe('near')
    expect(turnCue(0, null)).toBe('near')
  })

  it('says nothing about a turn that is not shown yet', () => {
    expect(turnCue(201, null)).toBeNull()
    expect(turnCue(500, null)).toBeNull()
  })

  it('says the last word from 60 m, and not before', () => {
    expect(turnCue(75, 'far')).toBeNull()
    expect(turnCue(61, 'far')).toBeNull()
    expect(turnCue(60, 'far')).toBe('near')
    expect(turnCue(75, null)).toBe('far')
  })

  it('does not warn again for a turn it has already said the last word for, if the driver is back further off', () => {
    expect(turnCue(150, 'near')).toBeNull()
    expect(turnCue(61, 'near')).toBeNull()
  })

  it('says each thing once through a whole approach', () => {
    const said: string[] = []
    let last: TurnCue | null = null
    for (let ahead = 200; ahead >= -10; ahead -= 10) {
      const cue = turnCue(ahead, last)
      if (cue) {
        said.push(cue)
        last = cue
      }
    }
    expect(said).toEqual(['far', 'near'])
  })

  it('says distances in round numbers', () => {
    expect(spokenMetres(12)).toBe(10)
    expect(spokenMetres(64)).toBe(60)
    expect(spokenMetres(92)).toBe(90)
    expect(spokenMetres(95)).toBe(100)
    expect(spokenMetres(100)).toBe(100)
    expect(spokenMetres(124)).toBe(100)
    expect(spokenMetres(130)).toBe(150)
    expect(spokenMetres(175)).toBe(200)
    expect(spokenMetres(199)).toBe(200)
  })

  it('has words for each', () => {
    const right = { angle: 90 }
    expect(turnSpeech(right, 190, 'far')).toBe('In 200 metres, turn right.')
    expect(turnSpeech(right, 78, 'far')).toBe('In 80 metres, turn right.')
    expect(turnSpeech(right, 40, 'near')).toBe('Turn right.')
    expect(turnSpeech({ angle: -50 }, 120, 'far')).toBe('In 100 metres, bear left.')
    expect(turnSpeech({ angle: -50 }, 30, 'near')).toBe('Bear left.')
    expect(turnSpeech({ angle: 150 }, 30, 'near')).toBe('Turn sharp right.')
    expect(turnSpeech({ angle: 180 }, 150, 'far')).toBe('In 150 metres, make a U-turn.')
    expect(turnSpeech({ angle: 180 }, 20, 'near')).toBe('Make a U-turn.')
  })

  it('says which street it leads into, at the end, when that is known', () => {
    const left = { angle: -90, street: 'Oak Road' }
    expect(turnSpeech(left, 190, 'far')).toBe('In 200 metres, turn left onto Oak Road.')
    expect(turnSpeech(left, 40, 'near')).toBe('Turn left onto Oak Road.')
    expect(turnSpeech({ angle: 50, street: 'Elm Street' }, 120, 'far')).toBe('In 100 metres, bear right onto Elm Street.')
    expect(turnSpeech({ angle: 50, street: 'Elm Street' }, 30, 'near')).toBe('Bear right onto Elm Street.')
    expect(turnSpeech({ angle: 150, street: 'Elm Street' }, 30, 'near')).toBe('Turn sharp right onto Elm Street.')
    expect(turnSpeech({ angle: 180, street: 'Elm Street' }, 150, 'far')).toBe('In 150 metres, make a U-turn onto Elm Street.')
  })

  it('says exactly what it said before when there is no street, however that is given', () => {
    for (const street of [undefined, null, '', '   ']) {
      expect(turnSpeech({ angle: -90, street }, 190, 'far')).toBe('In 200 metres, turn left.')
      expect(turnSpeech({ angle: -90, street }, 40, 'near')).toBe('Turn left.')
      expect(turnSpeech({ angle: -90, street }, 40, 'near')).not.toMatch(/onto|unnamed/)
    }
  })

  it('says a street the way it is said, not the way it is written', () => {
    expect(turnSpeech({ angle: 90, street: 'Oak Rd' }, 40, 'near')).toBe('Turn right onto Oak Road.')
    expect(turnSpeech({ angle: 90, street: 'Oak Road / Rue du Chene' }, 190, 'far')).toBe('In 200 metres, turn right onto Oak Road.')
    expect(turnSpeech({ angle: 90, street: '  Elm   Street ' }, 40, 'near')).toBe('Turn right onto Elm Street.')
  })

  it('says a street whose last word is a name every object has as it is written', () => {
    // The name comes from the server: its last word must not be looked up as if it were a plain word in a table.
    expect(turnSpeech({ angle: 90, street: 'Oak Constructor' }, 40, 'near')).toBe('Turn right onto Oak Constructor.')
    expect(turnSpeech({ angle: 90, street: 'Oak constructor' }, 190, 'far')).toBe('In 200 metres, turn right onto Oak constructor.')
    expect(turnSpeech({ angle: -90, street: 'Oak __proto__' }, 40, 'near')).toBe('Turn left onto Oak __proto__.')
    expect(turnSpeech({ angle: -90, street: 'Oak toString' }, 40, 'near')).toBe('Turn left onto Oak toString.')
  })
})

describe('long-range cues, for a driver on a stretch of transit', () => {
  it('has the two extra cues at a kilometre and at half of that, before the others', () => {
    expect(TURN_KM_M).toBe(1000)
    expect(TURN_HALF_M).toBe(500)
    expect(turnCue(1000, null, true)).toBe('km')
    expect(turnCue(551, null, true)).toBe('km')
    expect(turnCue(500, null, true)).toBe('half')
    expect(turnCue(226, null, true)).toBe('half')
    expect(turnCue(TURN_SHOW_M, null, true)).toBe('far')
    expect(turnCue(TURN_NEAR_M + 1, null, true)).toBe('far')
    expect(turnCue(TURN_NEAR_M, null, true)).toBe('near')
  })

  it('changes over a little past 500 m and 200 m, where the words for the distance change, so no two cues say the same distance', () => {
    expect(turnCue(540, null, true)).toBe('half')
    expect(turnCue(549.9, null, true)).toBe('half')
    expect(turnCue(550, null, true)).toBe('km')
    expect(turnCue(215, null, true)).toBe('far')
    expect(turnCue(224.9, null, true)).toBe('far')
    expect(turnCue(225, null, true)).toBe('half')
    // Past the half cue's own switch, nothing is repeated.
    expect(turnCue(499, 'half', true)).toBeNull()
    // The cue for each distance says a different distance, from every place a turn can first be met.
    const said = (ahead: number) => {
      const cue = turnCue(ahead, null, true)
      return cue ? spokenDistance(ahead) : null
    }
    expect(said(530)).toBe('500 metres')
    expect(said(215)).toBe('200 metres')
    for (let first = 70; first <= 1000; first += 0.5) {
      const heard: string[] = []
      let cue: TurnCue | null = null
      for (let ahead = first; ahead > 20; ahead -= 7) {
        const next = turnCue(ahead, cue, true)
        if (!next) continue
        cue = next
        if (next !== 'near') heard.push(spokenDistance(ahead))
      }
      expect(new Set(heard).size, `first met at ${first} m: ${heard.join(', ')}`).toBe(heard.length)
    }
  })

  it('says nothing about a turn further than a kilometre', () => {
    expect(turnCue(1001, null, true)).toBeNull()
    expect(turnCue(5000, null, true)).toBeNull()
    expect(turnCue(1001, 'km', true)).toBeNull()
  })

  it('gives none of the new cues unless asked, so off transit nothing changes', () => {
    for (const ahead of [201, 500, 501, 1000, 3000]) {
      expect(turnCue(ahead, null)).toBeNull()
      expect(turnCue(ahead, null, false)).toBeNull()
    }
    expect(turnCue(200, null, false)).toBe('far')
    expect(turnCue(60, null, false)).toBe('near')
  })

  it('goes km, half, far, near, each once, and never back', () => {
    const said: TurnCue[] = []
    let last: TurnCue | null = null
    for (let ahead = 1100; ahead >= -10; ahead -= 10) {
      const cue = turnCue(ahead, last, true)
      if (cue) {
        said.push(cue)
        last = cue
      }
    }
    expect(said).toEqual(['km', 'half', 'far', 'near'])
  })

  it('says each once even when the fixes jump over a whole range at speed', () => {
    const said: TurnCue[] = []
    let last: TurnCue | null = null
    for (const ahead of [1040, 960, 830, 410, 120, 20]) {
      const cue = turnCue(ahead, last, true)
      if (cue) {
        said.push(cue)
        last = cue
      }
    }
    expect(said).toEqual(['km', 'half', 'far', 'near'])
    // And a jump straight over two of them gives only the one for where the driver is now.
    expect(turnCue(450, 'km', true)).toBe('half')
    expect(turnCue(150, 'km', true)).toBe('far')
    expect(turnCue(40, 'half', true)).toBe('near')
  })

  it('never gives an earlier cue once a later one has been given, if the driver is back further off', () => {
    expect(turnCue(900, 'km', true)).toBeNull()
    expect(turnCue(900, 'half', true)).toBeNull()
    expect(turnCue(450, 'half', true)).toBeNull()
    expect(turnCue(300, 'far', true)).toBeNull()
    expect(turnCue(100, 'far', true)).toBeNull()
    expect(turnCue(600, 'near', true)).toBeNull()
    expect(turnCue(100, 'near', true)).toBeNull()
  })

  it('gives the cue for where a turn is when it is first met part way in', () => {
    expect(turnCue(700, null, true)).toBe('km')
    expect(turnCue(300, null, true)).toBe('half')
    expect(turnCue(120, null, true)).toBe('far')
    expect(turnCue(40, null, true)).toBe('near')
  })

  it('carries on with the usual cues when the driver leaves transit part way, and not again for what was said', () => {
    // Warned at a kilometre in transit; the stretch ends, so the 200 m rule is the only one now.
    expect(turnCue(900, 'km')).toBeNull()
    expect(turnCue(500, 'half')).toBeNull()
    expect(turnCue(200, 'km')).toBe('far')
    expect(turnCue(200, 'half')).toBe('far')
    expect(turnCue(50, 'half')).toBe('near')
  })

  it('leaves the rounding of a distance in metres as it was, since the off-route words go by it too', () => {
    expect(spokenMetres(499)).toBe(500)
    expect(spokenMetres(540)).toBe(550)
    expect(spokenMetres(974)).toBe(950)
    expect(spokenMetres(975)).toBe(1000)
    expect(spokenMetres(1249)).toBe(1250)
  })

  it('says a distance in words, in kilometres from a kilometre on', () => {
    expect(spokenDistance(80)).toBe('80 metres')
    expect(spokenDistance(190)).toBe('200 metres')
    expect(spokenDistance(250)).toBe('250 metres')
    expect(spokenDistance(499)).toBe('500 metres')
    expect(spokenDistance(500)).toBe('500 metres')
    expect(spokenDistance(540)).toBe('500 metres')
    expect(spokenDistance(560)).toBe('600 metres')
    expect(spokenDistance(700)).toBe('700 metres')
    expect(spokenDistance(949)).toBe('900 metres')
    expect(spokenDistance(950)).toBe('1 kilometre')
    expect(spokenDistance(990)).toBe('1 kilometre')
    expect(spokenDistance(1000)).toBe('1 kilometre')
    expect(spokenDistance(1249)).toBe('1 kilometre')
    expect(spokenDistance(1250)).toBe('1.5 kilometres')
    expect(spokenDistance(1500)).toBe('1.5 kilometres')
    expect(spokenDistance(1800)).toBe('2 kilometres')
    expect(spokenDistance(2000)).toBe('2 kilometres')
    expect(spokenDistance(3200)).toBe('3 kilometres')
  })

  it('has words for the long cues, with and without a street', () => {
    const left = { angle: -90, street: 'Oak Road' }
    expect(turnSpeech(left, 1000, 'km')).toBe('In 1 kilometre, turn left onto Oak Road.')
    expect(turnSpeech(left, 985, 'km')).toBe('In 1 kilometre, turn left onto Oak Road.')
    expect(turnSpeech(left, 500, 'half')).toBe('In 500 metres, turn left onto Oak Road.')
    expect(turnSpeech(left, 480, 'half')).toBe('In 500 metres, turn left onto Oak Road.')
    expect(turnSpeech({ angle: 90 }, 1000, 'km')).toBe('In 1 kilometre, turn right.')
    expect(turnSpeech({ angle: 90 }, 500, 'half')).toBe('In 500 metres, turn right.')
    expect(turnSpeech({ angle: 180 }, 500, 'half')).toBe('In 500 metres, make a U-turn.')
    expect(turnSpeech({ angle: -50, street: 'Elm St' }, 1000, 'km')).toBe('In 1 kilometre, bear left onto Elm Street.')
  })

  it('says a turn first met a little over a kilometre off as the distance it is', () => {
    expect(turnSpeech({ angle: 90 }, 700, 'km')).toBe('In 700 metres, turn right.')
  })

  it('says the last word the same whatever came before it', () => {
    expect(turnSpeech({ angle: -90, street: 'Oak Road' }, 40, 'near')).toBe('Turn left onto Oak Road.')
  })
})

describe('U-turns, however they are drawn', () => {
  /** A route that passes through these spots (metres east and north of the start) with a point at least every `step` metres, like one that follows the roads. */
  const dense = (step: number, ...xy: [number, number][]): Pt[] => {
    const out: [number, number][] = [xy[0]]
    for (let i = 1; i < xy.length; i++) {
      const [ax, ay] = xy[i - 1]
      const [bx, by] = xy[i]
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step))
      for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n])
    }
    return out.map(spot)
  }

  /** A route of straight legs, each given as the way it heads (degrees clockwise from north) and how long it is. */
  const legs = (...moves: [number, number][]): Pt[] => {
    let x = 0
    let y = 0
    const out: [number, number][] = [[0, 0]]
    for (const [heading, length] of moves) {
      x += length * sin(heading)
      y += length * cos(heading)
      out.push([x, y])
    }
    return out.map(spot)
  }

  /** The one turn a route has, which is a U-turn the way given (1 right, -1 left, 0 for either: an exact reversal has no side). */
  function oneUturn(route: Pt[], way: 1 | -1 | 0 = 1): Turn {
    const turns = routeTurns(route)
    expect(turns).toHaveLength(1)
    expect(turnKind(turns[0].angle)).toBe('uturn')
    if (way !== 0) expect(Math.sign(turns[0].angle)).toBe(way)
    expect(Math.abs(turns[0].angle)).toBeLessThanOrEqual(180)
    expect(turns[0].at).toBe((turns[0].from + turns[0].to) / 2)
    return turns[0]
  }

  it('has the thresholds it joins by', () => {
    expect(UTURN_GAP_M).toBe(30)
    expect(UTURN_MIN_DEG).toBe(150)
    expect(UTURN_MAX_DEG).toBe(225)
    expect(UTURN_CORNER_DEG).toBe(70)
  })

  it('counts a corner as what the card calls a turn, not a bear', () => {
    expect(turnKind(UTURN_CORNER_DEG)).toBe('turn')
    expect(turnKind(UTURN_CORNER_DEG - 0.1)).toBe('bear')
  })

  describe('an exact reversal at a point', () => {
    it('is found where it is, sparse or dense', () => {
      for (const route of [through([0, 0], [0, 200], [0, 0]), dense(5, [0, 0], [0, 200], [0, 0]), dense(12, [0, 0], [0, 200], [0, 0])]) {
        const t = oneUturn(route, 0)
        expect(near(t.at, 200, 3)).toBe(true)
        expect(near(t.heading, 0, 1)).toBe(true)
      }
    })

    it('is found where it is when the reversal is not on a multiple of 5 m, in any direction', () => {
      for (const at of [201, 203.7, 226.3]) {
        expect(near(oneUturn(through([0, 0], [0, at], [0, 0]), 0).at, at, 3)).toBe(true)
        // The same road laid out heading east, and heading south-west.
        expect(near(oneUturn(through([0, 0], [at, 0], [0, 0]), 0).at, at, 3)).toBe(true)
        const d = at / Math.SQRT2
        expect(near(oneUturn(through([0, 0], [-d, -d], [0, 0]), 0).at, at, 3)).toBe(true)
      }
    })

    it('is found when the way back is a few degrees off the way out, because it was tapped by hand', () => {
      for (const back of [[3, 0], [10, 0], [-10, 20], [25, 50]] as [number, number][]) {
        // Which side it turns to is the side the way back is drawn on.
        const t = oneUturn(through([0, 0], [0, 200], back), back[0] > 0 ? 1 : -1)
        expect(near(t.at, 200, 3)).toBe(true)
        expect(Math.abs(t.angle)).toBeGreaterThanOrEqual(165)
      }
    })

    it('is found on a road that goes on afterwards, as a U-turn and then the next corner', () => {
      const turns = routeTurns(through([0, 0], [0, 200], [0, 0], [0, -150], [150, -150]))
      expect(turns.map((t) => turnKind(t.angle))).toEqual(['uturn', 'turn'])
      expect(near(turns[0].at, 200, 3)).toBe(true)
      expect(near(turns[1].at, 550, 6)).toBe(true)
      expect(near(turns[1].angle, -90, 3)).toBe(true)
    })

    it('is found in both directions on a road driven out and back with a U-turn at each end', () => {
      const turns = routeTurns(through([0, 0], [0, 200], [0, 0], [0, 200]))
      expect(turns).toHaveLength(2)
      expect(turns.map((t) => turnKind(t.angle))).toEqual(['uturn', 'uturn'])
      expect(near(turns[0].at, 200, 3)).toBe(true)
      expect(near(turns[1].at, 400, 3)).toBe(true)
      // Out heading north, back heading south: a driver heading north is for the first, one heading south for the second.
      expect(near(turns[0].heading, 0, 1)).toBe(true)
      expect(near(turns[1].heading, 180, 1)).toBe(true)
    })
  })

  describe('a hairpin of two corners a few metres apart', () => {
    it('is one U-turn to the right', () => {
      for (const across of [2, 3, 4, 6, 8, 10, 14]) {
        const t = oneUturn(through([0, 0], [0, 200], [across, 200], [across, 0]))
        expect(near(t.at, 200 + across / 2, 6)).toBe(true)
        expect(near(t.angle, 180, 4)).toBe(true)
      }
    })

    it('is one U-turn to the left, drawn the other way', () => {
      for (const across of [2, 4, 8, 14]) {
        const t = oneUturn(through([0, 0], [0, 200], [-across, 200], [-across, 0]), -1)
        expect(near(t.at, 200 + across / 2, 6)).toBe(true)
        expect(near(t.angle, -180, 4)).toBe(true)
      }
    })

    it('is one U-turn with rounded corners and a point every couple of metres', () => {
      for (const way of [1, -1] as const) {
        for (const across of [0, 4, 10]) {
          oneUturn(drive([{ straight: 150 }, { turn: way * 90, radius: 6 }, { straight: across }, { turn: way * 90, radius: 6 }, { straight: 150 }], 2), way)
        }
      }
    })

    it('goes the way round it went when the corners add up to a little over a half turn', () => {
      // 95 degrees each: wrapped on its own that is 190, or 170 to the left.
      for (const gap of [0, 8, 20]) {
        oneUturn(drive([{ straight: 100 }, { turn: 95, radius: 4 }, { straight: gap }, { turn: 95, radius: 4 }, { straight: 100 }], 1), 1)
        oneUturn(drive([{ straight: 100 }, { turn: -95, radius: 4 }, { straight: gap }, { turn: -95, radius: 4 }, { straight: 100 }], 1), -1)
      }
    })
  })

  describe('the way back drawn on the other side of the road', () => {
    it('is one U-turn whatever the width of the median, up to about 30 m', () => {
      for (const across of [5, 12, 16, 20, 25, 28, 30]) {
        for (const route of [through([0, 0], [0, 200], [across, 200], [across, 0]), dense(5, [0, 0], [0, 200], [across, 200], [across, 0])]) {
          const t = oneUturn(route)
          expect(t.from).toBeLessThanOrEqual(205)
          expect(t.to).toBeGreaterThanOrEqual(200 + across - 5)
          expect(near(t.at, 200 + across / 2, 7)).toBe(true)
          expect(near(t.angle, 180, 4)).toBe(true)
        }
      }
    })

    it('is one U-turn to the left as well', () => {
      for (const across of [12, 20, 30]) {
        const t = oneUturn(through([0, 0], [0, 200], [-across, 200], [-across, 0]), -1)
        expect(near(t.at, 200 + across / 2, 7)).toBe(true)
      }
    })

    it('is one U-turn when the way back is on the left of the way out and it crosses over on a slant', () => {
      oneUturn(through([0, 0], [0, 200], [20, 208], [20, 0]))
      oneUturn(through([0, 0], [0, 200], [-20, 208], [-20, 0]), -1)
      oneUturn(through([0, 0], [0, 200], [15, 215], [15, 0]))
    })

    it('is one U-turn when the piece across starts with a bend too slight to be a turn of its own', () => {
      // 25 degrees, 25 m on a slant, then 155 degrees round: neither is a half turn, together they are.
      const route = legs([0, 200], [25, 25], [180, 222])
      const t = oneUturn(route)
      expect(t.angle).toBeCloseTo(180, 0)
      expect(near(t.from, 200, 5)).toBe(true)
    })

    it('keeps the heading it was coming up to the first corner with, and the middle between its ends', () => {
      const t = oneUturn(through([0, 0], [0, 200], [20, 200], [20, 0]))
      expect(near(t.heading, 0, 1)).toBe(true)
      expect(t.at).toBe((t.from + t.to) / 2)
      expect(t.from).toBeLessThan(t.to)
    })

    it('is not a U-turn when the way back is a block away', () => {
      for (const across of [45, 60, 100]) {
        const turns = routeTurns(through([0, 0], [0, 200], [across, 200], [across, 0]))
        expect(turns.map((t) => Math.round(t.angle / 10) * 10)).toEqual([90, 90])
        expect(turns.map((t) => turnKind(t.angle))).toEqual(['turn', 'turn'])
      }
    })
  })

  describe('a loop round a block', () => {
    it('is four ordinary turns, not a U-turn', () => {
      for (const side of [60, 100, 150]) {
        // Right at the top of the road, right again, right again, and right back onto the road, which goes on.
        const turns = routeTurns(through([0, 0], [0, 200], [side, 200], [side, 200 - side], [0, 200 - side], [0, 400]))
        expect(turns.map((t) => Math.round(t.angle / 10) * 10)).toEqual([90, 90, 90, 90])
        expect(turns.some((t) => turnKind(t.angle) === 'uturn')).toBe(false)
      }
    })

    it('is four ordinary turns with rounded corners', () => {
      const turns = routeTurns(
        drive([{ straight: 100 }, { turn: 90, radius: 8 }, { straight: 54 }, { turn: 90, radius: 8 }, { straight: 54 }, { turn: 90, radius: 8 }, { straight: 54 }, { turn: 90, radius: 8 }, { straight: 100 }], 3),
      )
      expect(turns).toHaveLength(4)
      expect(turns.every((t) => turnKind(t.angle) === 'turn')).toBe(true)
    })
  })

  describe('a road that curves round', () => {
    /** How the app thins a route: a route that follows the roads to this tolerance (see `ROAD_SIMPLIFY_M`), a recorded one to 3 m (Setup.tsx). */
    const THINNINGS = [ROAD_SIMPLIFY_M, 3]
    /** Where the curve starts along the road in front of it: not a multiple of 5 m, so the route's pieces fall differently on its points. */
    const LEADS = [200, 203, 207]
    /** The turns that are sharp or a U-turn: there must be none for a road that only curves. */
    const sharpOnes = (route: Pt[]) => routeTurns(route).filter((t) => Math.abs(t.angle) >= 130)
    const describeTurns = (route: Pt[]) => routeTurns(route).map((t) => `${turnKind(t.angle)} ${Math.round(t.angle)} at ${Math.round(t.at)}`)

    it('is never a U-turn or a sharp turn for a half circle too gentle to be a corner, however the route is thinned', () => {
      for (const way of [1, -1]) {
        for (const radius of [80, 100, 120, 150, 200]) {
          for (const lead of LEADS) {
            const road = drive([{ straight: lead }, { turn: way * 180, radius }, { straight: 200 }], 5)
            for (const route of [road, ...THINNINGS.map((m) => simplify(road, m))]) {
              expect(describeTurns(route).filter((t) => /^(uturn|sharp)/.test(t)), `${way} ${radius} ${lead}`).toEqual([])
            }
          }
        }
      }
    })

    it('is neither for a loop ramp or a spiral, a sweep of 270 or 360 degrees', () => {
      for (const way of [1, -1]) {
        for (const sweep of [210, 240, 270, 300, 330, 360]) {
          for (const radius of [90, 100, 120]) {
            for (const lead of LEADS) {
              const road = drive([{ straight: lead }, { turn: way * sweep, radius }, { straight: 200 }], 5)
              for (const route of [road, ...THINNINGS.map((m) => simplify(road, m))]) {
                expect(describeTurns(route).filter((t) => /^(uturn|sharp)/.test(t)), `${way} ${sweep} ${radius} ${lead}`).toEqual([])
              }
            }
          }
        }
      }
    })

    it('is neither for a curve drawn by hand with a point every 25 to 35 m', () => {
      for (const way of [1, -1]) {
        for (const radius of [100, 140, 200]) {
          for (const step of [25, 30, 35]) {
            for (const lead of LEADS) {
              const route = drive([{ straight: lead }, { turn: way * 180, radius }, { straight: 200 }], step)
              expect(sharpOnes(route), `${way} ${radius} ${step} ${lead}`).toEqual([])
            }
          }
        }
      }
    })

    it('is not a U-turn when it comes straight after a corner (a street leaving a crescent), or just before one', () => {
      for (const way of [1, -1]) {
        for (const radius of [90, 120, 160]) {
          for (const gap of [0, 10, 25]) {
            for (const sweep of [90, 120, 150, 180]) {
              for (const lead of LEADS) {
                const into = drive([{ straight: lead }, { turn: way * 90, radius: 0.001 }, { straight: gap }, { turn: way * sweep, radius }, { straight: 200 }], 5)
                const out = drive([{ straight: lead }, { turn: way * sweep, radius }, { straight: gap }, { turn: way * 90, radius: 0.001 }, { straight: 200 }], 5)
                for (const road of [into, out]) {
                  for (const route of [road, ...THINNINGS.map((m) => simplify(road, m))]) {
                    expect(sharpOnes(route), `${way} ${radius} ${gap} ${sweep} ${lead}: ${describeTurns(route).join(', ')}`).toEqual([])
                  }
                }
              }
            }
          }
        }
      }
    })

    it('keeps the corner that comes before it, as a turn', () => {
      for (const road of [drive([{ straight: 203 }, { turn: 90, radius: 0.001 }, { turn: 180, radius: 100 }, { straight: 200 }], 5)]) {
        for (const route of [road, ...THINNINGS.map((m) => simplify(road, m))]) {
          const [corner] = routeTurns(route)
          expect(turnKind(corner.angle)).toBe('turn')
          expect(near(corner.at, 203, 15)).toBe(true)
        }
      }
    })

    it('is still a U-turn when it is tight enough to be one, a half circle on a radius of up to 25 m', () => {
      for (const way of [1, -1]) {
        for (const radius of [15, 20, 25]) {
          for (const lead of LEADS) {
            const road = drive([{ straight: lead }, { turn: way * 180, radius }, { straight: 200 }], 5)
            for (const route of [road, ...THINNINGS.map((m) => simplify(road, m))]) {
              const turns = routeTurns(route)
              expect(turns.map((t) => turnKind(t.angle)), `${way} ${radius} ${lead}`).toEqual(['uturn'])
              expect(Math.sign(turns[0].angle)).toBe(way)
            }
          }
        }
      }
    })

    it('is still found as the two corners of a U-turn when they are rounded off and the route is thinned', () => {
      for (const way of [1, -1] as const) {
        for (const radius of [3, 6, 10, 15]) {
          for (const across of [0, 8, 16, 24]) {
            for (const lead of [200, 203]) {
              const road = drive([{ straight: lead }, { turn: way * 90, radius }, { straight: across }, { turn: way * 90, radius }, { straight: 200 }], 5)
              for (const route of [road, ...THINNINGS.map((m) => simplify(road, m))]) oneUturn(route, way)
            }
          }
        }
      }
    })

    it('needs a sharp corner among a string of bends to be a U-turn: four bends of 45 degrees are four bears', () => {
      const turns = routeTurns(legs([0, 200], [45, 25], [90, 25], [135, 25], [180, 200]))
      expect(turns.map((t) => Math.round(t.angle))).toEqual([45, 45, 45, 45])
      expect(turns.map((t) => turnKind(t.angle))).toEqual(['bear', 'bear', 'bear', 'bear'])
    })

    it('needs one of 70 degrees, not 60: three bends of 60 degrees, as far apart, are three bears', () => {
      expect(routeTurns(legs([0, 200], [60, 25], [120, 25], [180, 200])).map((t) => Math.round(t.angle))).toEqual([60, 60, 60])
      // And with a bend of 70 in it they are joined.
      const joined = routeTurns(legs([0, 200], [70, 25], [130, 25], [190, 200]))
      expect(joined).toHaveLength(1)
      expect(turnKind(joined[0].angle)).toBe('uturn')
    })

    it('counts a corner as 70 degrees within a short stretch, not 70 degrees in all', () => {
      // 20 degrees at each of five points 15 m apart, 100 degrees in all over 60 m, then a corner of 30: the bends are a road curving, not a corner.
      const curving = legs([0, 200], [20, 15], [40, 15], [60, 15], [80, 15], [100, 15], [130, 200])
      expect(sharpOnes(curving)).toEqual([])
    })

    it('does not join a stretch of curve to a corner after it, however much they add up to', () => {
      // Three bends of 15 degrees 15 m apart (45 degrees over 30 m, no more than 30 degrees within 20 m), then a corner of 110, as near as a U-turn needs.
      const route = legs([0, 200], [15, 15], [30, 15], [45, 25], [155, 200])
      const turns = routeTurns(route)
      expect(turns.map((t) => turnKind(t.angle))).toEqual(['bear', 'turn'])
      expect(turns.map((t) => Math.round(t.angle))).toEqual([45, 110])
    })

    it('does not join a stretch of curve to a corner before it either', () => {
      const route = legs([0, 200], [110, 25], [125, 15], [140, 15], [155, 200])
      const turns = routeTurns(route)
      expect(turns.map((t) => turnKind(t.angle))).toEqual(['turn', 'bear'])
      expect(turns.map((t) => Math.round(t.angle))).toEqual([110, 45])
    })

    it('joins the same bends once they are a sharp corner, the 45 degrees being the corner and not a curve', () => {
      // The same shape with the three bends of 15 degrees made one bend of 45 at a point: a corner, so it joins the corner after it.
      const turns = routeTurns(legs([0, 200], [45, 25], [155, 200]))
      expect(turns).toHaveLength(1)
      expect(turnKind(turns[0].angle)).toBe('sharp')
    })

    it('calls a bend a slight one up to 40 degrees, the least that is a turn of its own', () => {
      // A piece across slanted so that it takes a bend of 35 to start with, then 145 to come back: a U-turn.
      const t = oneUturn(legs([0, 200], [35, 25], [180, 200]))
      expect(t.angle).toBeCloseTo(180, 0)
      // And a bend of 45 is a turn of its own, which is joined to the one after it just the same.
      oneUturn(legs([0, 200], [45, 25], [180, 200]))
    })

    it('does not start a U-turn with a slight bend that is one of a run of bends, a road curving, 30 m or less apart', () => {
      // 30, 30 and then a corner of 130, the bends 30 m apart: 160 in all, but the second 30 is the road still curving.
      const curving = routeTurns(legs([0, 200], [30, 30], [60, 30], [190, 200]))
      expect(curving.map((t) => Math.round(t.angle))).toEqual([130])
      // The same with 35 m between the first two: the second is a slight bend on its own, before the corner, and is joined to it.
      const alone = routeTurns(legs([0, 200], [30, 35], [60, 30], [190, 200]))
      expect(alone).toHaveLength(1)
      expect(alone[0].angle).toBeCloseTo(160, 0)
    })

    it('does count a slight bend that follows one the other way, a wobble, as its own', () => {
      const turns = routeTurns(legs([0, 200], [-30, 30], [0, 30], [130, 200]))
      expect(turns).toHaveLength(1)
      expect(turns[0].angle).toBeCloseTo(160, 0)
    })

    it('allows one slight bend in a U-turn but not two', () => {
      // A corner of 125 and a bend of 15 add up to 140: not enough. 125 and 30 make 155, and join.
      expect(routeTurns(legs([0, 200], [125, 20], [155, 200])).map((t) => turnKind(t.angle))).toEqual(['sharp'])
      // Two bends of 15 after the corner of 125 make 155 as well, but two slight bends are a curve: only the corner is a turn.
      const two = routeTurns(legs([0, 200], [125, 20], [140, 20], [155, 200]))
      expect(two.map((t) => Math.round(t.angle))).toEqual([125])
      expect(two.map((t) => turnKind(t.angle))).toEqual(['turn'])
    })
  })

  describe('things that are close together but are not a U-turn', () => {
    it('keeps a dog-leg, left then right, as two turns however short it is', () => {
      for (const across of [8, 20, 28]) {
        const turns = routeTurns(through([0, 0], [0, 200], [-across, 200], [-across, 400]))
        expect(turns.length).toBeLessThanOrEqual(2)
        expect(turns.some((t) => turnKind(t.angle) === 'uturn')).toBe(false)
      }
      expect(routeTurns(through([0, 0], [0, 200], [-28, 200], [-28, 400]))).toHaveLength(2)
    })

    it('keeps two turns the same way as two when together they are well short of a U-turn', () => {
      // 60 degrees, 20 m, 60 degrees: 120 in all.
      const turns = routeTurns(legs([0, 200], [60, 20], [120, 200]))
      expect(turns).toHaveLength(2)
      expect(turns.map((t) => Math.round(t.angle))).toEqual([60, 60])
    })

    it('joins turns that add up to 150 degrees, and not ones that add up to less', () => {
      expect(routeTurns(legs([0, 200], [74, 20], [148, 200]))).toHaveLength(2)
      const joined = routeTurns(legs([0, 200], [76, 20], [152, 200]))
      expect(joined).toHaveLength(1)
      expect(joined[0].angle).toBeCloseTo(152, 0)
      // Not quite a half turn, so it is called what it is.
      expect(turnKind(joined[0].angle)).toBe('sharp')
    })

    it('does not join turns that add up to well beyond a U-turn, such as going on round', () => {
      // 120 degrees, 20 m, 120 degrees: 240.
      const turns = routeTurns(legs([0, 200], [120, 20], [240, 200]))
      expect(turns).toHaveLength(2)
      expect(turns.map((t) => Math.round(t.angle))).toEqual([120, 120])
    })

    it('joins turns that add up to a little over a half turn, and calls it a U-turn', () => {
      const t = oneUturn(legs([0, 200], [100, 20], [200, 200]))
      expect(t.angle).toBe(180)
    })

    it('leaves a U-turn alone when another turn the same way follows soon after', () => {
      // A U-turn, then 20 m on a turn of 45 degrees the same way: 215 in all, which is within what would be joined.
      const turns = routeTurns(legs([0, 200], [170, 20], [215, 200]))
      expect(turns).toHaveLength(2)
      expect(turns.map((t) => turnKind(t.angle))).toEqual(['uturn', 'bear'])
      expect(turns[0].angle).toBeCloseTo(170, 0)
    })

    it('does not add a bend the other way into a U-turn', () => {
      // 120 right, 45 left, 90 right, each 25 m apart: they add up to 165 but not all the same way.
      const turns = routeTurns(legs([0, 200], [120, 25], [75, 25], [165, 200]))
      expect(turns.map((t) => Math.round(t.angle))).toEqual([120, -45, 90])
    })

    it('joins the first two of three corners the same way that are all close together, and leaves the third', () => {
      const turns = routeTurns(legs([0, 200], [90, 20], [180, 20], [270, 200]))
      expect(turns).toHaveLength(2)
      expect(turnKind(turns[0].angle)).toBe('uturn')
      expect(near(turns[0].at, 210, 6)).toBe(true)
      expect(near(turns[1].angle, 90, 3)).toBe(true)
      expect(turns[0].to).toBeLessThan(turns[1].from)
    })

    it('joins three smaller turns that add up to a U-turn', () => {
      const t = oneUturn(legs([0, 200], [60, 15], [120, 15], [180, 200]))
      expect(near(t.angle, 180, 2)).toBe(true)
    })

    it('does not join turns with a stretch between them longer than a U-turn needs', () => {
      const wide = routeTurns(through([0, 0], [0, 200], [UTURN_GAP_M + 20, 200], [UTURN_GAP_M + 20, 0]))
      expect(wide).toHaveLength(2)
      // Nor one a little longer than that: 36 m across is two turns, 30 m across is one.
      expect(routeTurns(through([0, 0], [0, 200], [UTURN_GAP_M + 6, 200], [UTURN_GAP_M + 6, 0]))).toHaveLength(2)
      expect(routeTurns(through([0, 0], [0, 200], [UTURN_GAP_M, 200], [UTURN_GAP_M, 0]))).toHaveLength(1)
    })

    it('finds the U-turn and the turns before and after it, in order', () => {
      const route = through([0, 0], [0, 200], [150, 200], [150, 400], [170, 400], [170, 100])
      const turns = routeTurns(route)
      expect(turns.map((t) => turnKind(t.angle))).toEqual(['turn', 'turn', 'uturn'])
      for (const [i, t] of turns.entries()) if (i > 0) expect(turns[i - 1].to).toBeLessThan(t.from)
      expect(turns[2].angle).toBeGreaterThan(0)
    })
  })
})

describe('the arrow for a turn', () => {
  it('goes straight up for no turn, with its head at the top', () => {
    expect(arrowShape(0)).toEqual({ shaft: 'M24 44V26L24 12', head: '33,12 15,12 24,4' })
  })

  it('bends right for a right turn and left for a left turn, the same distance each way', () => {
    expect(arrowShape(90)).toEqual({ shaft: 'M24 44V26L38 26', head: '38,35 38,17 46,26' })
    expect(arrowShape(-90)).toEqual({ shaft: 'M24 44V26L10 26', head: '10,17 10,35 2,26' })
  })

  it('bends by the angle, so a bear is gentler than a turn and a sharp turn goes back on itself', () => {
    expect(arrowShape(45)).toEqual({ shaft: 'M24 44V26L33.9 16.1', head: '40.3,22.5 27.5,9.7 39.6,10.4' })
    const sharp = arrowShape(150).shaft
    expect(sharp).toBe('M24 44V26L31 38.1')
  })

  it('is the same U for a U-turn whichever way, to be flipped for the left', () => {
    expect(arrowShape(180)).toEqual(arrowShape(-170))
    expect(arrowShape(180).shaft).toBe('M18 44V20A6 6 0 0 1 30 20V32')
  })
})
