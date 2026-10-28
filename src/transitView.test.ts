import { describe, expect, it } from 'vitest'
import { guidedTurn, straightText } from './guidance'
import { cueToSay, guidanceToShow, straightCard, turnKey, turnTo, type GuidanceContext } from './transitView'
import { routeTurns, TURN_PASSED_M, turnCue, turnSpeech, type Turn, type TurnCue } from './turns'
import type { Pt } from './types'

// A place in Sydney, so the maths is checked away from the equator and the prime meridian.
const ORIGIN = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
const cos = (deg: number) => Math.cos((deg * Math.PI) / 180)

/** A spot `x` metres east and `y` metres north of the start. */
const spot = ([x, y]: readonly [number, number]): Pt => ({
  lat: ORIGIN.lat + y / M_PER_DEG,
  lng: ORIGIN.lng + x / (M_PER_DEG * cos(ORIGIN.lat)),
})

/** A route through these spots (metres east and north of the start), with a point at least every `step` metres, like one that follows the roads. */
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

/** A turn made by hand. */
const turnAt = (at: number, angle: number, heading: number): Turn & { street: string | null } => ({ at, from: at, to: at, angle, heading, street: null })

/** A driver on the route, on a good fix, on a stretch of transit unless told otherwise. */
const ctx = (along: number, over: Partial<GuidanceContext> = {}): GuidanceContext => ({
  onTrack: true,
  transit: true,
  along,
  routeEnd: 6000,
  heading: null,
  after: -Infinity,
  ...over,
})

describe('where a turn is kept', () => {
  it('is the metre it is at, so a turn an edit moves a fraction is not new', () => {
    expect(turnKey(1000)).toBe(1000)
    expect(turnKey(1000.4)).toBe(1000)
    expect(turnKey(1000.6)).toBe(1001)
  })
})

describe('the card to show', () => {
  const turns = [turnAt(1000, -90, 90), turnAt(3000, 90, 0)]

  it('is nothing while the driver is not on the route, on a stretch of transit or off it, even with a turn right here', () => {
    expect(guidanceToShow(turns, ctx(990, { onTrack: false }))).toBeNull()
    expect(guidanceToShow(turns, ctx(990, { onTrack: false, transit: false }))).toBeNull()
    expect(guidanceToShow(turns, ctx(0, { onTrack: false }))).toBeNull()
    expect(guidanceToShow([], ctx(0, { onTrack: false }))).toBeNull()
  })

  describe('anywhere but a stretch of transit', () => {
    it('is the next turn once it is within 200 m, and nothing before', () => {
      expect(guidanceToShow(turns, ctx(0, { transit: false }))).toBeNull()
      expect(guidanceToShow(turns, ctx(799, { transit: false }))).toBeNull()
      expect(guidanceToShow(turns, ctx(800, { transit: false }))).toEqual({ kind: 'turn', turn: turns[0], ahead: 200 })
      expect(guidanceToShow(turns, ctx(990, { transit: false }))).toEqual({ kind: 'turn', turn: turns[0], ahead: 10 })
    })

    it('keeps the turn up until the driver is 15 m through it, and then looks to the next', () => {
      expect(guidanceToShow(turns, ctx(1000 + TURN_PASSED_M, { transit: false }))).toEqual({ kind: 'turn', turn: turns[0], ahead: -TURN_PASSED_M })
      expect(guidanceToShow(turns, ctx(1000 + TURN_PASSED_M + 1, { transit: false }))).toBeNull()
    })

    it('is never the straight card, however long the way to the next turn or to the end of the route', () => {
      expect(guidanceToShow(turns, ctx(1500, { transit: false }))).toBeNull()
      expect(guidanceToShow(turns, ctx(3500, { transit: false }))).toBeNull()
      expect(guidanceToShow([], ctx(0, { transit: false }))).toBeNull()
    })

    it('counts the heading and what is behind the driver, as it always did', () => {
      const both = [turnAt(1000, -90, 0), turnAt(1060, 90, 180)]
      expect(guidanceToShow(both, ctx(900, { transit: false, heading: 180 }))).toEqual({ kind: 'turn', turn: both[1], ahead: 160 })
      expect(guidanceToShow(both, ctx(900, { transit: false, heading: 0 }))).toEqual({ kind: 'turn', turn: both[0], ahead: 100 })
      expect(guidanceToShow(both, ctx(900, { transit: false, after: 1000 }))).toEqual({ kind: 'turn', turn: both[1], ahead: 160 })
    })
  })

  describe('on a stretch of transit', () => {
    it('is the next turn at any distance: a straight that leads to it', () => {
      expect(guidanceToShow(turns, ctx(0))).toEqual({ kind: 'straight', ahead: 1000, then: turns[0] })
      expect(guidanceToShow(turns, ctx(1200))).toEqual({ kind: 'straight', ahead: 1800, then: turns[1] })
      expect(guidanceToShow([turnAt(40000, 90, 0)], ctx(0, { routeEnd: 50000 }))).toEqual({ kind: 'straight', ahead: 40000, then: expect.objectContaining({ at: 40000 }) })
    })

    it('is the turn card once the turn is within 200 m, as anywhere', () => {
      expect(guidanceToShow(turns, ctx(799))?.kind).toBe('straight')
      expect(guidanceToShow(turns, ctx(800))).toEqual({ kind: 'turn', turn: turns[0], ahead: 200 })
      expect(guidanceToShow(turns, ctx(990))).toEqual(guidanceToShow(turns, ctx(990, { transit: false })))
      expect(guidanceToShow(turns, ctx(1000 + TURN_PASSED_M))).toEqual({ kind: 'turn', turn: turns[0], ahead: -TURN_PASSED_M })
    })

    it('is how far to the end of the route when no turn is left', () => {
      expect(guidanceToShow(turns, ctx(3100))).toEqual({ kind: 'straight', ahead: 2900, then: null })
      expect(guidanceToShow([], ctx(0))).toEqual({ kind: 'straight', ahead: 6000, then: null })
      expect(guidanceToShow([], ctx(6000))).toEqual({ kind: 'straight', ahead: 0, then: null })
    })

    it('goes by the way the phone is heading, and never brings back a turn already passed', () => {
      const both = [turnAt(1000, -90, 0), turnAt(1060, 90, 180)]
      expect(guidanceToShow(both, ctx(0, { heading: 180 }))).toEqual({ kind: 'straight', ahead: 1060, then: both[1] })
      expect(guidanceToShow(both, ctx(0, { heading: 0 }))).toEqual({ kind: 'straight', ahead: 1000, then: both[0] })
      expect(guidanceToShow(turns, ctx(900, { after: 1000 }))).toEqual({ kind: 'straight', ahead: 2100, then: turns[1] })
    })

    it('holds a turn far off to a wide margin of the heading, so a road that bends on the way to it does not lose it', () => {
      // A road that curves 90 degrees in 1200 m (a bend of 7.5 degrees every 100 m, too gentle to be a turn), a corner of 90 to the left,
      // and later a corner to the right that comes up heading north, the way the phone is heading on the first stretch.
      const heading = (h: number): [number, number] => [Math.sin((h * Math.PI) / 180), Math.cos((h * Math.PI) / 180)]
      const xy: [number, number][] = [[0, 0]]
      for (let i = 0; i <= 12; i++) {
        const [dx, dy] = heading(i * 7.5)
        xy.push([xy[i][0] + 100 * dx, xy[i][1] + 100 * dy])
      }
      const [x, y] = xy[13]
      xy.push([x + 2000, y], [x + 2000, y + 1500], [x + 3000, y + 1500])
      const road = routeTurns(route(50, ...xy))
      expect(road.map((t) => Math.round(t.angle / 10) * 10)).toEqual([-90, 90])
      const end = 5000
      // Driving along the first stretch, heading north, the first corner comes up heading east: 90 degrees off, which is far more than 60, but it is the next turn.
      for (const h of [0, 20, 45, 90, 120]) {
        const g = guidanceToShow(road, ctx(300, { heading: h, routeEnd: end }))
        expect(g?.kind, `${h}`).toBe('straight')
        expect(g?.kind === 'straight' && g.then, `${h}`).toBe(road[0])
      }
      // A heading more than 120 degrees off the first corner is set aside for the next that agrees, and it is never "route ends" while a turn is left.
      const behind = guidanceToShow(road, ctx(300, { heading: 280, routeEnd: end }))
      expect(behind?.kind === 'straight' && behind.then).toBe(road[1])
      for (let h = 0; h < 360; h += 15) {
        const g = guidanceToShow(road, ctx(300, { heading: h, routeEnd: end }))
        expect(g?.kind === 'straight' && g.then, `${h}`).not.toBeNull()
      }
    })

    it('keeps a close turn the heading is only part against, rather than the next one far off', () => {
      const two = [turnAt(1007, 90, 0), turnAt(4017, -90, 90)]
      expect(guidanceToShow(two, ctx(907, { heading: 70, routeEnd: 6000 }))).toEqual({ kind: 'turn', turn: two[0], ahead: 100 })
      expect(guidanceToShow(two, ctx(907, { heading: 130, routeEnd: 6000 }))).toEqual({ kind: 'straight', ahead: 3110, then: two[1] })
    })

    it('is as it was off transit: the usual 60 degrees, and nothing for a turn more than 200 m off', () => {
      const two = [turnAt(1007, 90, 0), turnAt(4017, -90, 90)]
      expect(guidanceToShow(two, ctx(907, { transit: false, heading: 70, routeEnd: 6000 }))).toBeNull()
      expect(guidanceToShow(two, ctx(907, { transit: false, heading: 60, routeEnd: 6000 }))).toEqual({ kind: 'turn', turn: two[0], ahead: 100 })
      expect(guidanceToShow(two, ctx(300, { transit: false, heading: 90, routeEnd: 6000 }))).toBeNull()
    })

    it('gives back the very turn it was given, with the street it leads into', () => {
      const named = [{ ...turnAt(2000, -90, 90), street: 'Oak Road' }]
      const far = guidanceToShow(named, ctx(0))
      expect(far?.kind === 'straight' && far.then).toBe(named[0])
      expect(far?.kind === 'straight' && far.then?.street).toBe('Oak Road')
      const near = guidanceToShow(named, ctx(1900))
      expect(near?.kind === 'turn' && near.turn).toBe(named[0])
    })
  })

  it('is a straight only where the side is transit: the same place, the same turns, two answers', () => {
    expect(guidanceToShow(turns, ctx(300, { transit: true }))?.kind).toBe('straight')
    expect(guidanceToShow(turns, ctx(300, { transit: false }))).toBeNull()
  })
})

describe('what the voice says', () => {
  const oak = { angle: -90, street: 'Oak Road' }

  it('says what the turn cue says, in the words of the turn', () => {
    for (const ahead of [900, 450, 150, 40]) {
      const cue = turnCue(ahead, null, true) as TurnCue
      expect(cueToSay(oak, ahead, null, true)).toEqual({ cue, text: turnSpeech(oak, ahead, cue) })
    }
  })

  it('has the long cues only for a driver in transit', () => {
    expect(cueToSay(oak, 900, null, true)).toEqual({ cue: 'km', text: 'In 900 metres, turn left onto Oak Road.' })
    expect(cueToSay(oak, 1000, null, true)).toEqual({ cue: 'km', text: 'In 1 kilometre, turn left onto Oak Road.' })
    expect(cueToSay(oak, 500, null, true)).toEqual({ cue: 'half', text: 'In 500 metres, turn left onto Oak Road.' })
    expect(cueToSay(oak, 900, null, false)).toBeNull()
    expect(cueToSay(oak, 1000, null, false)).toBeNull()
    expect(cueToSay(oak, 500, null, false)).toBeNull()
    expect(cueToSay(oak, 5000, null, true)).toBeNull()
  })

  it('has the same two cues as ever anywhere else: 200 m, and then within 60 m', () => {
    expect(cueToSay(oak, 200, null, false)).toEqual({ cue: 'far', text: 'In 200 metres, turn left onto Oak Road.' })
    expect(cueToSay(oak, 60, null, false)).toEqual({ cue: 'near', text: 'Turn left onto Oak Road.' })
    expect(cueToSay(oak, 60, 'far', false)?.cue).toBe('near')
    expect(cueToSay(oak, 100, 'far', false)).toBeNull()
  })

  it('only goes on: a cue already said, or an earlier one, is not said again', () => {
    expect(cueToSay(oak, 900, 'km', true)).toBeNull()
    expect(cueToSay(oak, 900, 'half', true)).toBeNull()
    expect(cueToSay(oak, 450, 'half', true)).toBeNull()
    expect(cueToSay(oak, 450, 'far', true)).toBeNull()
    expect(cueToSay(oak, 450, 'km', true)?.cue).toBe('half')
  })

  it('says a turn with no street on its own, never onto nothing', () => {
    expect(cueToSay({ angle: 90 }, 1000, null, true)?.text).toBe('In 1 kilometre, turn right.')
    expect(cueToSay({ angle: 90, street: null }, 40, null, true)?.text).toBe('Turn right.')
  })
})

/**
 * A drive along the route with the voice on, the way the round screen does it: at each fix the card is worked out, the cue for the
 * turn it leads to is looked up against what has been said, and what is said is kept. Returns the words said.
 */
function drive(points: Pt[], from: number, to: number, options: { transit?: boolean; offBetween?: [number, number]; said?: Map<number, TurnCue> } = {}): string[] {
  const named = routeTurns(points).map((t) => ({ ...t, street: 'Oak Road' }))
  const said = options.said ?? new Map<number, TurnCue>()
  const spoken: string[] = []
  const end = to + 1000
  for (let along = from; along <= to; along += 10) {
    const off = options.offBetween && along >= options.offBetween[0] && along < options.offBetween[1]
    const g = guidanceToShow(named, { onTrack: !off, transit: options.transit ?? true, along, routeEnd: end, heading: null, after: -Infinity })
    const guided = g ? guidedTurn(g) : null
    if (!guided) continue
    const key = turnKey(guided.turn.at)
    const now = cueToSay({ angle: guided.turn.angle, street: guided.turn.street }, guided.ahead, said.get(key) ?? null, options.transit ?? true)
    if (!now) continue
    said.set(key, now.cue)
    spoken.push(now.text)
  }
  return spoken
}

describe('a drive with the voice on', () => {
  // Five kilometres east, then a left turn.
  const points = route(50, [0, 0], [5000, 0], [5000, 3000])
  const turns = routeTurns(points)

  it('finds the one turn the drive is about', () => {
    expect(turns).toHaveLength(1)
    expect(turns[0].angle).toBeLessThan(-80)
    expect(turns[0].at).toBeGreaterThan(4990)
    expect(turns[0].at).toBeLessThan(5010)
  })

  it('on a stretch of transit says the turn at a kilometre, 500 m, 200 m and within 60 m, once each and in order', () => {
    expect(drive(points, 0, 5000)).toEqual([
      'In 1 kilometre, turn left onto Oak Road.',
      'In 500 metres, turn left onto Oak Road.',
      'In 200 metres, turn left onto Oak Road.',
      'Turn left onto Oak Road.',
    ])
  })

  it('anywhere else says only the usual two', () => {
    expect(drive(points, 0, 5000, { transit: false })).toEqual(['In 200 metres, turn left onto Oak Road.', 'Turn left onto Oak Road.'])
  })

  it('says a turn first met part way in only for where it is, not every cue it missed', () => {
    const at700 = drive(points, 4300, 5000)
    expect(at700).toHaveLength(4)
    expect(at700[0]).toMatch(/^In (6|7)\d0 metres, turn left onto Oak Road\.$/)
    expect(drive(points, 4600, 5000)).toEqual(['In 400 metres, turn left onto Oak Road.', 'In 200 metres, turn left onto Oak Road.', 'Turn left onto Oak Road.'])
    expect(drive(points, 4850, 5000)).toEqual(['In 150 metres, turn left onto Oak Road.', 'Turn left onto Oak Road.'])
    expect(drive(points, 4960, 5000)).toEqual(['Turn left onto Oak Road.'])
  })

  it('says nothing for a turn that is a long way off', () => {
    expect(drive(points, 0, 3900)).toEqual([])
  })

  it('says nothing while the driver is off the route, and carries on where it left off when they are back', () => {
    // Off the route from 4200 to 4600 m: the cue at 500 m and the one at 1 km (already said) are not said again, and nothing is said between.
    const spokenBefore = new Map<number, TurnCue>()
    const first = drive(points, 0, 4190, { said: spokenBefore })
    expect(first).toEqual(['In 1 kilometre, turn left onto Oak Road.'])
    const during = drive(points, 4200, 4590, { offBetween: [4200, 4600], said: spokenBefore })
    expect(during).toEqual([])
    const after = drive(points, 4600, 5000, { said: spokenBefore })
    expect(after).toEqual(['In 400 metres, turn left onto Oak Road.', 'In 200 metres, turn left onto Oak Road.', 'Turn left onto Oak Road.'])
  })

  it('is said again from the start after the turns said are forgotten, as when a skip or the way back puts them away', () => {
    const said = new Map<number, TurnCue>()
    expect(drive(points, 0, 5000, { said })).toHaveLength(4)
    expect(drive(points, 0, 5000, { said })).toEqual([])
    said.clear()
    expect(drive(points, 4850, 5000, { said })).toHaveLength(2)
  })

  it('does not blurt the long cues when transit begins close to the turn', () => {
    // The first fix on the stretch, 150 m from the turn: one cue for where it is, and then the last word.
    expect(drive(points, 4850, 5000, { transit: true })).toEqual(['In 150 metres, turn left onto Oak Road.', 'Turn left onto Oak Road.'])
  })

  it('never speaks of the end of the route: with no turn left there is nothing to say', () => {
    expect(drive(points, 5100, 7000)).toEqual([])
  })
})

describe('the straight card', () => {
  const left = turnAt(3000, -90, 0)
  const right = turnAt(3000, 90, 0)

  it('splits "Continue 3.2 km" into the small line and the big one', () => {
    const card = straightCard({ ahead: 3200, then: left })
    expect(card.lead).toBe('Continue')
    expect(card.value).toBe('3.2 km')
    expect(card.label).toBe('Continue 3.2 km, then turn left')
  })

  it('names the street the turn leads into, and says what the turn is when there is none', () => {
    expect(straightCard({ ahead: 3200, then: left }, 'Oak Road').thenText).toBe('Oak Road')
    expect(straightCard({ ahead: 3200, then: left }, 'Oak Road').label).toBe('Continue 3.2 km, then turn left onto Oak Road')
    expect(straightCard({ ahead: 3200, then: right }).thenText).toBe('Turn right')
    expect(straightCard({ ahead: 3200, then: left }, null).thenText).toBe('Turn left')
    expect(straightCard({ ahead: 3200, then: left }, '   ').thenText).toBe('Turn left')
    expect(straightCard({ ahead: 3200, then: left }, '   ').label).toBe('Continue 3.2 km, then turn left')
    expect(straightCard({ ahead: 3200, then: turnAt(3000, 175, 0) }).thenText).toBe('U-turn')
    expect(straightCard({ ahead: 3200, then: turnAt(3000, 45, 0) }).thenText).toBe('Bear right')
  })

  it('trims the street, as the rest of the card does', () => {
    expect(straightCard({ ahead: 3200, then: left }, '  Oak Road ').thenText).toBe('Oak Road')
  })

  it('writes the distance the way the rest of the guidance does', () => {
    expect(straightCard({ ahead: 250, then: left }).value).toBe('250 m')
    expect(straightCard({ ahead: 1040, then: left }).value).toBe('1 km')
    expect(straightCard({ ahead: 12400, then: left }).value).toBe('12 km')
    expect(straightCard({ ahead: 975, then: left }).value).toBe('1 km')
  })

  it('says how far it is to the end of the route when no turn is left', () => {
    const card = straightCard({ ahead: 800, then: null })
    expect(card).toEqual({ lead: 'Route ends in', value: '800 m', thenText: null, label: 'Route ends in 800 m' })
    expect(straightCard({ ahead: 800, then: null }, 'Oak Road').thenText).toBeNull()
  })

  it('says the route ends here when it does', () => {
    expect(straightCard({ ahead: 3, then: null })).toEqual({ lead: 'Route ends', value: 'Here', thenText: null, label: 'Route ends here' })
    expect(straightCard({ ahead: 0, then: null }).label).toBe('Route ends here')
    expect(straightCard({ ahead: 14.9, then: null }).value).toBe('Here')
    expect(straightCard({ ahead: 15, then: null })).toEqual({ lead: 'Route ends in', value: '20 m', thenText: null, label: 'Route ends in 20 m' })
  })

  it('has a lead and a value that make the title the rest of the app writes', () => {
    for (const straight of [
      { ahead: 3200, then: left },
      { ahead: 250, then: right },
      { ahead: 9951, then: left },
      { ahead: 800, then: null },
      { ahead: 4, then: null },
    ]) {
      const card = straightCard(straight)
      expect(`${card.lead} ${card.value}`.toLowerCase()).toBe(straightText(straight).title.toLowerCase())
    }
  })
})

describe('the heading badge turning', () => {
  it('is turned to the heading at the start', () => {
    expect(turnTo(Number.NaN, 90)).toBe(90)
  })

  it('goes straight to a heading that is a turn away', () => {
    expect(turnTo(10, 40)).toBe(40)
    expect(turnTo(40, 10)).toBe(10)
    expect(turnTo(0, 179)).toBe(179)
  })

  it('goes the short way round past north, in either direction', () => {
    expect(turnTo(350, 10)).toBe(370)
    expect(turnTo(10, 350)).toBe(-10)
    expect(turnTo(370, 350)).toBe(350)
    expect(turnTo(-10, 10)).toBe(10)
  })

  it('goes the short way round from an angle that has already gone past a full turn', () => {
    expect(turnTo(725, 10)).toBeCloseTo(730)
    expect(turnTo(-350, 355)).toBeCloseTo(-365)
  })

  it('goes the way it is nearer when the heading is half a turn away', () => {
    expect(Math.abs(turnTo(0, 180))).toBe(180)
    expect(turnTo(90, 270)).toBe(270)
  })

  it('stays put for the heading it is at already, whatever the number of turns', () => {
    expect(turnTo(90, 90)).toBe(90)
    expect(turnTo(450, 90)).toBe(450)
    expect(turnTo(-270, 90)).toBe(-270)
    expect(turnTo(90.01, 90)).toBe(90.01)
  })

  it('leaves it where it is for a heading that is not a number', () => {
    expect(turnTo(90, Number.NaN)).toBe(90)
    expect(turnTo(90, Infinity)).toBe(90)
  })

  it('follows a drive round a corner past north without ever turning the long way', () => {
    let shown = 340
    for (const heading of [350, 0, 10, 20, 10, 0, 350, 340]) {
      const next = turnTo(shown, heading)
      expect(Math.abs(next - shown)).toBeLessThanOrEqual(20)
      shown = next
    }
    expect((((shown % 360) + 360) % 360)).toBeCloseTo(340)
  })
})
