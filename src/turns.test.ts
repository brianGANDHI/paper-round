import { describe, expect, it } from 'vitest'
import { cumulativeDistances } from './geo'
import {
  arrowShape,
  MIN_TURN_DEG,
  onTheRoute,
  pointAt,
  routeTurns,
  spokenMetres,
  TURN_NEAR_M,
  TURN_SHOW_M,
  turnAheadText,
  turnCue,
  turnKind,
  turnSpeech,
  TURN_HEADING_TOLERANCE,
  TURN_PASSED_M,
  turnWords,
  upcomingTurn,
  type Turn,
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
    let last: 'far' | 'near' | null = null
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
