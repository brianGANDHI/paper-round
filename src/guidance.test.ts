import { describe, expect, it } from 'vitest'
import {
  compassLabel,
  compassName,
  continueText,
  distanceText,
  guidedTurn,
  routeEndsText,
  straightText,
  TRANSIT_HEADING_TOLERANCE,
  transitGuidance,
  type TransitGuidance,
} from './guidance'
import { bearing, cumulativeDistances } from './geo'
import {
  pointAt,
  routeTurns,
  TURN_HEADING_TOLERANCE,
  TURN_PASSED_M,
  TURN_SHOW_M,
  turnCue,
  turnSpeech,
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

/** A route that goes through these spots (metres east and north of the start), with a point at least every `step` metres, like one that follows the roads. */
function route(step: number, ...xy: [number, number][]): Pt[] {
  const out: [number, number][] = [xy[0]]
  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1]
    const [bx, by] = xy[i]
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step))
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n])
  }
  return out.map(spot)
}

type Move = { straight: number } | { turn: number; radius: number }

/**
 * A route driven from the start heading north: along a straight, or round a bend (positive to the right, negative to the left)
 * of that radius, with a point every `step` metres.
 */
function arcs(moves: Move[], step = 5): Pt[] {
  let x = 0
  let y = 0
  let h = 0
  const out: [number, number][] = [[x, y]]
  for (const m of moves) {
    if ('straight' in m) {
      const n = Math.max(1, Math.round(m.straight / step))
      for (let i = 1; i <= n; i++) out.push([x + ((m.straight * i) / n) * sin(h), y + ((m.straight * i) / n) * cos(h)])
      x += m.straight * sin(h)
      y += m.straight * cos(h)
    } else {
      const s = Math.sign(m.turn)
      const around = [x + s * m.radius * cos(h), y - s * m.radius * sin(h)]
      const n = Math.max(1, Math.ceil((((Math.abs(m.turn) * Math.PI) / 180) * m.radius) / step))
      for (let i = 1; i <= n; i++) {
        const heading = h + (s * Math.abs(m.turn) * i) / n
        out.push([around[0] - s * m.radius * cos(heading), around[1] + s * m.radius * sin(heading)])
      }
      const end = h + m.turn
      x = around[0] - s * m.radius * cos(end)
      y = around[1] + s * m.radius * sin(end)
      h = end
    }
  }
  return out.map(spot)
}

/** A turn made by hand. */
const turnAt = (at: number, angle: number, heading: number): Turn => ({ at, from: at, to: at, angle, heading })

describe('the compass heading', () => {
  it('names the eight points of the compass', () => {
    const points: [number, string][] = [
      [0, 'N'],
      [45, 'NE'],
      [90, 'E'],
      [135, 'SE'],
      [180, 'S'],
      [225, 'SW'],
      [270, 'W'],
      [315, 'NW'],
    ]
    for (const [deg, label] of points) expect(compassLabel(deg)).toBe(label)
  })

  it('gives each point 45 degrees, centred on itself, and rounds up on the boundary', () => {
    expect(compassLabel(22.4)).toBe('N')
    expect(compassLabel(22.5)).toBe('NE')
    expect(compassLabel(67.4)).toBe('NE')
    expect(compassLabel(67.5)).toBe('E')
    expect(compassLabel(157.4)).toBe('SE')
    expect(compassLabel(157.5)).toBe('S')
    expect(compassLabel(292.4)).toBe('W')
    expect(compassLabel(292.5)).toBe('NW')
    expect(compassLabel(337.4)).toBe('NW')
    expect(compassLabel(337.5)).toBe('N')
    expect(compassLabel(359.9)).toBe('N')
    expect(compassLabel(-0.1)).toBe('N')
  })

  it('takes any number of degrees round the circle', () => {
    expect(compassLabel(360)).toBe('N')
    expect(compassLabel(450)).toBe('E')
    expect(compassLabel(720 + 225)).toBe('SW')
    expect(compassLabel(-90)).toBe('W')
    expect(compassLabel(-45)).toBe('NW')
    expect(compassLabel(-360 - 135)).toBe('SW')
  })

  it('has nothing to say for a heading that is not a number', () => {
    expect(compassLabel(Number.NaN)).toBe('')
    expect(compassLabel(Infinity)).toBe('')
    expect(compassName(Number.NaN)).toBe('')
  })

  it('has the same points in words, for a screen reader', () => {
    expect(compassName(0)).toBe('north')
    expect(compassName(45)).toBe('north-east')
    expect(compassName(100)).toBe('east')
    expect(compassName(135)).toBe('south-east')
    expect(compassName(185)).toBe('south')
    expect(compassName(230)).toBe('south-west')
    expect(compassName(270)).toBe('west')
    expect(compassName(-45)).toBe('north-west')
  })
})

describe('what to tell a driver in transit', () => {
  const turns: Turn[] = [turnAt(1000, 90, 0), turnAt(3000, -90, 90)]
  const end = 5000

  it('says to carry on to the next turn, however far off, with that turn to come', () => {
    expect(transitGuidance(turns, 0, end)).toEqual({ kind: 'straight', ahead: 1000, then: turns[0] })
    expect(transitGuidance(turns, 250, end)).toEqual({ kind: 'straight', ahead: 750, then: turns[0] })
    expect(transitGuidance(turns, 1100, end)).toEqual({ kind: 'straight', ahead: 1900, then: turns[1] })
  })

  it('looks as far as the turn is, not just a few hundred metres', () => {
    expect(transitGuidance([turnAt(40000, 90, 0)], 0, 50000)).toEqual({ kind: 'straight', ahead: 40000, then: expect.objectContaining({ at: 40000 }) })
  })

  it('shows the turn as a turn once it is within 200 m, the same as anywhere on the route', () => {
    expect(transitGuidance(turns, 800, end)).toEqual({ kind: 'turn', turn: turns[0], ahead: 200 })
    expect(transitGuidance(turns, 900, end)).toEqual({ kind: 'turn', turn: turns[0], ahead: 100 })
    expect(transitGuidance(turns, 999, end)).toEqual({ kind: 'turn', turn: turns[0], ahead: 1 })
    expect(TURN_SHOW_M).toBe(200)
  })

  it('is a straight a metre further out than that', () => {
    expect(transitGuidance(turns, 799, end)).toEqual({ kind: 'straight', ahead: 201, then: turns[0] })
  })

  it('stays on a turn a little past it, and then moves on to the straight after it', () => {
    expect(transitGuidance(turns, 1010, end)).toEqual({ kind: 'turn', turn: turns[0], ahead: -10 })
    expect(transitGuidance(turns, 1000 + TURN_PASSED_M, end).kind).toBe('turn')
    expect(transitGuidance(turns, 1000 + TURN_PASSED_M + 1, end)).toEqual({ kind: 'straight', ahead: 3000 - 1016, then: turns[1] })
  })

  it('agrees with upcomingTurn about every turn that is near, so the turn card is the same in transit', () => {
    const many = [turnAt(100, 90, 0), turnAt(160, -90, 180), turnAt(400, 60, 90), turnAt(900, -120, 270)]
    for (let along = 0; along <= 1000; along += 7) {
      for (const heading of [null, 0, 90, 180, 270]) {
        for (const after of [-Infinity, 120, 500]) {
          const near200 = upcomingTurn(many, along, { heading, after })
          const g = transitGuidance(many, along, 1200, { heading, after })
          if (near200) expect(g).toEqual({ kind: 'turn', ...near200 })
        }
      }
    }
  })

  it('shows a turn card only for a turn that is near, and a straight only for one that is not', () => {
    const many = [turnAt(100, 90, 0), turnAt(160, -90, 180), turnAt(400, 60, 90), turnAt(900, -120, 270)]
    for (let along = 0; along <= 1000; along += 7) {
      for (const heading of [null, 0, 45, 90, 135, 180, 225, 270]) {
        for (const after of [-Infinity, 120, 500]) {
          const g = transitGuidance(many, along, 1200, { heading, after })
          if (g.kind === 'turn') {
            expect(g.ahead).toBeLessThanOrEqual(TURN_SHOW_M)
            expect(g.ahead).toBeCloseTo(g.turn.at - along)
            expect(g.turn.at).toBeGreaterThan(after)
          } else if (g.then) {
            expect(g.ahead).toBeGreaterThan(TURN_SHOW_M)
            expect(g.ahead).toBeCloseTo(g.then.at - along)
            expect(g.then.at).toBeGreaterThan(after)
          }
        }
      }
    }
  })

  it('carries on to the end of the route when there is no turn left, and says how far that is', () => {
    expect(transitGuidance([], 0, 800)).toEqual({ kind: 'straight', ahead: 800, then: null })
    expect(transitGuidance([], 300, 800)).toEqual({ kind: 'straight', ahead: 500, then: null })
    expect(transitGuidance(turns, 3100, end)).toEqual({ kind: 'straight', ahead: 1900, then: null })
  })

  it('is never a negative distance to the end, even a little past it', () => {
    expect(transitGuidance([], 810, 800)).toEqual({ kind: 'straight', ahead: 0, then: null })
    expect(transitGuidance(turns, 5000, end)).toEqual({ kind: 'straight', ahead: 0, then: null })
  })

  it('goes by the way the phone is heading, so a turn for the other way along a street is not the next', () => {
    const both: Turn[] = [turnAt(1000, 90, 0), turnAt(1060, -90, 180)]
    expect(transitGuidance(both, 0, end, { heading: 0 })).toEqual({ kind: 'straight', ahead: 1000, then: both[0] })
    expect(transitGuidance(both, 0, end, { heading: 180 })).toEqual({ kind: 'straight', ahead: 1060, then: both[1] })
    expect(transitGuidance(both, 0, end, { heading: null })).toEqual({ kind: 'straight', ahead: 1000, then: both[0] })
    expect(transitGuidance(both, 0, end)).toEqual({ kind: 'straight', ahead: 1000, then: both[0] })
  })

  it('carries on to a turn for the other way along the street rather than say the route ends, when it is the only one left', () => {
    expect(transitGuidance([turnAt(1000, 90, 0)], 0, end, { heading: 180 })).toEqual({ kind: 'straight', ahead: 1000, then: expect.objectContaining({ at: 1000 }) })
    expect(transitGuidance([turnAt(100, 90, 0)], 0, end, { heading: 180 })).toEqual({ kind: 'turn', turn: expect.objectContaining({ at: 100 }), ahead: 100 })
  })

  it('goes by the heading within a margin, whichever way round the compass', () => {
    const north: Turn[] = [turnAt(1000, 90, 355), turnAt(1500, -90, 175)]
    // Heading north, the turn for north is the next; heading south, the one for south is.
    expect(transitGuidance(north, 0, end, { heading: 5 })).toEqual({ kind: 'straight', ahead: 1000, then: north[0] })
    expect(transitGuidance(north, 0, end, { heading: 180 })).toEqual({ kind: 'straight', ahead: 1500, then: north[1] })
  })

  it('holds a turn further than 200 m off to a wide margin of the heading: only one coming up the other way is set aside', () => {
    const here: Turn[] = [turnAt(1000, 90, 0), turnAt(1500, -90, 180)]
    expect(TRANSIT_HEADING_TOLERANCE).toBe(120)
    expect(TRANSIT_HEADING_TOLERANCE).toBeGreaterThan(TURN_HEADING_TOLERANCE)
    // The first turn comes up heading north. The phone can be 120 degrees off that and it is still the next turn...
    for (const heading of [0, 61, 100, 120, 240, 300]) expect(transitGuidance(here, 0, end, { heading }), `${heading}`).toEqual({ kind: 'straight', ahead: 1000, then: here[0] })
    // ...and not 121 degrees off, when the next one is for the way it is heading.
    for (const heading of [121, 150, 180, 239]) expect(transitGuidance(here, 0, end, { heading }), `${heading}`).toEqual({ kind: 'straight', ahead: 1500, then: here[1] })
  })

  it('holds a turn within 200 m to the usual 60 degrees when a later one agrees, as upcomingTurn does', () => {
    const here: Turn[] = [turnAt(100, 90, 0), turnAt(160, -90, 180)]
    expect(transitGuidance(here, 0, end, { heading: 60 })).toEqual({ kind: 'turn', turn: here[0], ahead: 100 })
    expect(transitGuidance(here, 0, end, { heading: 180 })).toEqual({ kind: 'turn', turn: here[1], ahead: 160 })
    expect(transitGuidance(here, 0, end, { heading: 130 })).toEqual({ kind: 'turn', turn: here[1], ahead: 160 })
    // The first turn is 100 degrees off the heading, which the transit margin allows but the usual one does not: the second, which agrees, is the one.
    const second: Turn[] = [turnAt(100, 90, 0), turnAt(160, -90, 100)]
    expect(transitGuidance(second, 0, end, { heading: 100 })).toEqual({ kind: 'turn', turn: second[1], ahead: 160 })
  })

  it('prefers a close turn the heading is part against to a later one that agrees only when the later one is not near too', () => {
    // 100 m and 250 m ahead; the heading agrees with the second, which is not near enough to show, and is part against the first, which is.
    const two: Turn[] = [turnAt(100, 90, 0), turnAt(250, -90, 100)]
    expect(transitGuidance(two, 0, end, { heading: 100 })).toEqual({ kind: 'turn', turn: two[0], ahead: 100 })
  })

  it('does not set aside a turn that is close because the heading is only part against it, for a later one far off', () => {
    // A corner 100 m ahead and the next 3 km on, the phone heading 70 degrees off the way the road comes up to the first (a roundabout, a slip road).
    const two: Turn[] = [turnAt(1007, 90, 0), turnAt(4017, -90, 90)]
    for (const heading of [null, 0, 61, 70, 100, 120]) expect(transitGuidance(two, 907, 6000, { heading }), `${heading}`).toEqual({ kind: 'turn', turn: two[0], ahead: 100 })
    // Once the heading is the other way altogether, it is the one that comes up that way.
    expect(transitGuidance(two, 907, 6000, { heading: 180 })).toEqual({ kind: 'straight', ahead: 3110, then: two[1] })
    // As soon as it is more than 200 m off it is the later turn that is the straight's, as before, if only the first is wrong for the heading.
    expect(transitGuidance(two, 700, 6000, { heading: 0 })).toEqual({ kind: 'straight', ahead: 307, then: two[0] })
  })

  it('never says the route ends while a turn is left ahead, whatever the heading', () => {
    const many = [turnAt(100, 90, 0), turnAt(1100, -90, 90), turnAt(4000, 90, 0)]
    for (let along = -10; along <= 4000; along += 13) {
      for (let heading = 0; heading < 360; heading += 15) {
        const g = transitGuidance(many, along, 6000, { heading })
        const left = many.some((t) => t.at - along >= -TURN_PASSED_M)
        if (left) expect(g.kind === 'turn' || g.then !== null, `${along} ${heading}`).toBe(true)
        else expect(g).toEqual({ kind: 'straight', ahead: Math.max(0, 6000 - along), then: null })
      }
    }
  })

  it('says the route ends only when no turn is left, not even a turn the other way along the road', () => {
    expect(transitGuidance([turnAt(100, 90, 0)], 200, end, { heading: 180 })).toEqual({ kind: 'straight', ahead: 4800, then: null })
    expect(transitGuidance([turnAt(100, 90, 0)], 0, end, { heading: 180, after: 100 })).toEqual({ kind: 'straight', ahead: end, then: null })
  })

  it('does not put a turn for the way the phone is heading behind one that is not, when it is as near', () => {
    // The one for the other way along the street is first by place, but the driver is going the other way.
    const both: Turn[] = [turnAt(100, 90, 0), turnAt(130, -90, 180)]
    expect(transitGuidance(both, 50, end, { heading: 180 })).toEqual({ kind: 'turn', turn: both[1], ahead: 80 })
  })

  it('never brings back a turn already passed, however the position wanders', () => {
    expect(transitGuidance(turns, 900, end, { after: 1000 })).toEqual({ kind: 'straight', ahead: 2100, then: turns[1] })
    // The driver is known to have got to 985 m, so the turn at 1000 m is still ahead of that.
    expect(transitGuidance(turns, 900, end, { after: 1000 - TURN_PASSED_M }).kind).toBe('turn')
    expect(transitGuidance(turns, 900, end, { after: 999 })).toEqual({ kind: 'turn', turn: turns[0], ahead: 100 })
    expect(transitGuidance(turns, 100, end, { after: 3000 })).toEqual({ kind: 'straight', ahead: 4900, then: null })
  })

  it('gives back the very turn it was given, with the street it carries', () => {
    const named = [{ ...turnAt(1000, 90, 0), street: 'Oak Road' }]
    const far = transitGuidance(named, 0, end)
    expect(far.kind === 'straight' && far.then).toBe(named[0])
    expect(far.kind === 'straight' && far.then?.street).toBe('Oak Road')
    const close = transitGuidance(named, 900, end)
    expect(close.kind === 'turn' && close.turn).toBe(named[0])
  })

  it('does not change the turns it is given', () => {
    const before = JSON.stringify(turns)
    transitGuidance(turns, 500, end, { heading: 0, after: 0 })
    expect(JSON.stringify(turns)).toBe(before)
  })
})

describe('the turn the voice speaks of', () => {
  const turns: Turn[] = [turnAt(1000, 90, 0)]

  it('is the turn itself when it is near', () => {
    expect(guidedTurn(transitGuidance(turns, 900, 5000))).toEqual({ turn: turns[0], ahead: 100 })
  })

  it('is the turn after the straight, at the distance of the straight', () => {
    expect(guidedTurn(transitGuidance(turns, 0, 5000))).toEqual({ turn: turns[0], ahead: 1000 })
  })

  it('is nothing when the straight runs to the end of the route', () => {
    expect(guidedTurn(transitGuidance(turns, 1500, 5000))).toBeNull()
    expect(guidedTurn(transitGuidance([], 0, 5000))).toBeNull()
  })
})

describe('the lines of the card', () => {
  it('writes a distance to the nearest 10 m under 100 m and 50 m under a kilometre', () => {
    expect(distanceText(0)).toBe('0 m')
    expect(distanceText(14)).toBe('10 m')
    expect(distanceText(95)).toBe('100 m')
    expect(distanceText(99)).toBe('100 m')
    expect(distanceText(124)).toBe('100 m')
    expect(distanceText(126)).toBe('150 m')
    expect(distanceText(201)).toBe('200 m')
    expect(distanceText(830)).toBe('850 m')
    expect(distanceText(800)).toBe('800 m')
    expect(distanceText(949)).toBe('950 m')
  })

  it('writes a distance of a kilometre or more in kilometres, to a tenth under ten', () => {
    expect(distanceText(1000)).toBe('1 km')
    expect(distanceText(1040)).toBe('1 km')
    expect(distanceText(1050)).toBe('1.1 km')
    expect(distanceText(1500)).toBe('1.5 km')
    expect(distanceText(3200)).toBe('3.2 km')
    expect(distanceText(3249)).toBe('3.2 km')
    expect(distanceText(9949)).toBe('9.9 km')
    expect(distanceText(9951)).toBe('10 km')
  })

  it('writes a distance over ten kilometres to the whole kilometre', () => {
    expect(distanceText(10000)).toBe('10 km')
    expect(distanceText(12400)).toBe('12 km')
    expect(distanceText(12600)).toBe('13 km')
    expect(distanceText(40000)).toBe('40 km')
  })

  it('writes a distance a little short of a kilometre as a kilometre, never 1000 m', () => {
    expect(distanceText(975)).toBe('1 km')
    expect(distanceText(999)).toBe('1 km')
    expect(distanceText(974)).toBe('950 m')
  })

  it('copes with a distance that is negative or not a number', () => {
    expect(distanceText(-30)).toBe('0 m')
    expect(distanceText(Number.NaN)).toBe('0 m')
  })

  it('says to continue, with how far', () => {
    expect(continueText(3200)).toBe('Continue 3.2 km')
    expect(continueText(850)).toBe('Continue 850 m')
    expect(continueText(1000)).toBe('Continue 1 km')
  })

  it('says when the route ends, with how far, and that it is here when it is', () => {
    expect(routeEndsText(800)).toBe('Route ends in 800 m')
    expect(routeEndsText(2400)).toBe('Route ends in 2.4 km')
    expect(routeEndsText(15)).toBe('Route ends in 20 m')
    expect(routeEndsText(14)).toBe('Route ends here')
    expect(routeEndsText(0)).toBe('Route ends here')
  })

  it('puts the turn and the street under the line to continue', () => {
    const left = turnAt(1000, -90, 0)
    expect(straightText({ ahead: 3200, then: left }, 'Oak Road')).toEqual({ title: 'Continue 3.2 km', then: 'Then turn left onto Oak Road' })
    expect(straightText({ ahead: 3200, then: turnAt(1000, 50, 0) }, 'Elm Street')).toEqual({ title: 'Continue 3.2 km', then: 'Then bear right onto Elm Street' })
    expect(straightText({ ahead: 400, then: turnAt(1000, 140, 0) }, 'Elm Street').then).toBe('Then turn sharp right onto Elm Street')
    expect(straightText({ ahead: 400, then: turnAt(1000, 180, 0) }, 'Elm Street').then).toBe('Then make a U-turn onto Elm Street')
  })

  it('leaves out the street when it is not known, and never says onto nothing', () => {
    for (const street of [undefined, null, '', '   ']) {
      const text = straightText({ ahead: 3200, then: turnAt(1000, 90, 0) }, street)
      expect(text).toEqual({ title: 'Continue 3.2 km', then: 'Then turn right' })
    }
    expect(straightText({ ahead: 3200, then: turnAt(1000, 90, 0) })).toEqual({ title: 'Continue 3.2 km', then: 'Then turn right' })
  })

  it('says the route ends, with nothing after it, when there is no turn', () => {
    expect(straightText({ ahead: 800, then: null })).toEqual({ title: 'Route ends in 800 m', then: null })
    expect(straightText({ ahead: 800, then: null }, 'Oak Road')).toEqual({ title: 'Route ends in 800 m', then: null })
    expect(straightText({ ahead: 5, then: null }).title).toBe('Route ends here')
  })

  it('writes the street as it is given, the whole name, for the card', () => {
    expect(straightText({ ahead: 900, then: turnAt(1000, -90, 0) }, '  Oak Road / Rue du Chene ').then).toBe('Then turn left onto Oak Road / Rue du Chene')
  })
})

describe('driving a stretch of transit', () => {
  /**
   * Drives the route from the start with a fix every `step` metres, the phone heading along the route, and gives
   * what the driver is told (the kind of card each time it changes) and what the voice says.
   */
  function drive(points: Pt[], step: number) {
    const turns = routeTurns(points)
    const cum = cumulativeDistances(points)
    const end = cum[cum.length - 1]
    const said: string[] = []
    const kinds: string[] = []
    const sayings = new Map<number, TurnCue>()
    for (let along = 0; along < end - 5; along += step) {
      const heading = bearing(pointAt(points, cum, along), pointAt(points, cum, along + 5))
      const g: TransitGuidance = transitGuidance(turns, along, end, { heading })
      if (kinds.at(-1) !== g.kind) kinds.push(g.kind)
      const t = guidedTurn(g)
      if (!t) continue
      const cue = turnCue(t.ahead, sayings.get(t.turn.at) ?? null, true)
      if (!cue) continue
      sayings.set(t.turn.at, cue)
      said.push(turnSpeech(t.turn, t.ahead, cue))
    }
    return { turns, said, kinds }
  }

  it('warns at a kilometre, 500 m, 200 m and at the turn, once each, on a long road with a corner', () => {
    const { turns, said, kinds } = drive(route(50, [0, 0], [0, 3000], [-2000, 3000]), 25)
    expect(turns).toHaveLength(1)
    expect(said).toEqual(['In 1 kilometre, turn left.', 'In 500 metres, turn left.', 'In 200 metres, turn left.', 'Turn left.'])
    // Carry on to the corner, then the corner, then carry on to the end of the route.
    expect(kinds).toEqual(['straight', 'turn', 'straight'])
  })

  it('says it all the same at motorway speed, a fix every 30 m', () => {
    const { said } = drive(route(50, [0, 0], [0, 3000], [2000, 3000]), 30)
    expect(said).toHaveLength(4)
    expect(said[0]).toBe('In 1 kilometre, turn right.')
    expect(said[3]).toBe('Turn right.')
  })

  it('warns of a U-turn the same way', () => {
    const { turns, said } = drive(route(50, [0, 0], [0, 2500], [20, 2500], [20, 0]), 25)
    expect(turns).toHaveLength(1)
    expect(said).toEqual(['In 1 kilometre, make a U-turn.', 'In 500 metres, make a U-turn.', 'In 200 metres, make a U-turn.', 'Make a U-turn.'])
  })

  it('warns of each turn on the way, a road with two corners, the second after the first is behind', () => {
    const { turns, said, kinds } = drive(route(50, [0, 0], [0, 2000], [1500, 2000], [1500, 4000]), 25)
    expect(turns).toHaveLength(2)
    expect(said).toEqual([
      'In 1 kilometre, turn right.',
      'In 500 metres, turn right.',
      'In 200 metres, turn right.',
      'Turn right.',
      'In 1 kilometre, turn left.',
      'In 500 metres, turn left.',
      'In 200 metres, turn left.',
      'Turn left.',
    ])
    expect(kinds).toEqual(['straight', 'turn', 'straight', 'turn', 'straight'])
  })

  it('starts with the cue for where a turn is when it is already in view at the start', () => {
    const { said } = drive(route(50, [0, 0], [0, 600], [400, 600]), 20)
    expect(said).toEqual(['In 600 metres, turn right.', 'In 500 metres, turn right.', 'In 200 metres, turn right.', 'Turn right.'])
  })

  it('has no cue at all on a road with no turn, and carries on to the end of the route', () => {
    const { said, kinds, turns } = drive(route(50, [0, 0], [0, 4000]), 25)
    expect(turns).toEqual([])
    expect(said).toEqual([])
    expect(kinds).toEqual(['straight'])
  })

  it('tells the way to a corner beyond a long gentle curve, with the phone heading along the road, not "route ends"', () => {
    // North 1500 m, a curve of 90 degrees on a radius of 150 m (too gentle to be a turn), east 2000 m, then the corner.
    const points = arcs([{ straight: 1500 }, { turn: 90, radius: 150 }, { straight: 2000 }, { turn: 90, radius: 0.001 }, { straight: 1000 }])
    const turns = routeTurns(points)
    expect(turns).toHaveLength(1)
    const cum = cumulativeDistances(points)
    const end = cum[cum.length - 1]
    // The phone is heading north, and the corner comes up heading east: 90 degrees off, as the road bends in between.
    const g = transitGuidance(turns, 500, end, { heading: 0 })
    expect(g.kind).toBe('straight')
    expect(g.kind === 'straight' && g.then).toBe(turns[0])
    expect(g.kind === 'straight' && Math.abs(g.ahead - (turns[0].at - 500)) < 1e-6).toBe(true)
    expect(g.kind === 'straight' && straightText(g).title).toBe('Continue 3.2 km')
  })

  it('warns of that corner on the way, once each, whatever the heading is along the curve', () => {
    const points = arcs([{ straight: 1500 }, { turn: 90, radius: 150 }, { straight: 2000 }, { turn: -90, radius: 0.001 }, { straight: 1000 }])
    const { turns, said, kinds } = drive(points, 25)
    expect(turns).toHaveLength(1)
    expect(said).toEqual(['In 1 kilometre, turn left.', 'In 500 metres, turn left.', 'In 200 metres, turn left.', 'Turn left.'])
    expect(kinds).toEqual(['straight', 'turn', 'straight'])
  })

  it('counts the distance to the end of the route down as the driver goes', () => {
    const end = 4000
    const asked = [0, 1000, 3200, 3990, 4000].map((along) => transitGuidance([], along, end))
    expect(asked.map((g) => (g.kind === 'straight' ? g.ahead : -1))).toEqual([4000, 3000, 800, 10, 0])
  })
})
