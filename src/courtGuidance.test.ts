import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bearing } from './geo'
import { guidedTurn } from './guidance'
import { pushTrail, trailHeading, type TrailPoint } from './heading'
import { advance, makeTrack, type Progress } from './progress'
import { extendAlongRoads, rate } from './roads'
import { appendPoint } from './routeEdit'
import { cueToSay, guidanceToShow, turnKey } from './transitView'
import { onTheRoute, routeTurns, TURN_PASSED_M, turnKind, type Turn, type TurnCue } from './turns'
import type { Pt, Route } from './types'

/**
 * The turns of a short court on the round screen, fix by fix, as the driver sees and hears them. `routeTurns` reads a court 8 to 16 m deep as
 * the turn in, the U-turn at its end and the turn out, 8 to 16 m apart. The route is drawn as the drawing screen draws it with Follow roads on
 * (a tap on the end of the court, then one on the road further on or back the way it came, through `extendAlongRoads` with the road service
 * stood in for), and a car drives it a fix a second: up the road, into the court, round at its end and out. Each fix goes through what Round
 * does with one: the tracker (`advance`, with the phone's course, or the trail's heading when it has none), whether the phone is on the route
 * (`onTheRoute`), the card (`guidanceToShow`, with what is behind the driver for good going by the furthest reached), the turn it is for
 * (`guidedTurn`) and what the voice says of it (`cueToSay`, with what has been said kept by `turnKey`).
 *
 * What must come out is the turn in, then the U-turn, then the turn out, on the card and in the voice; the U-turn said before the car turns
 * round; and nothing of the first two once the turn out is up. The turn card used to keep the turn in up until the car was 15 m past it, so a car
 * crawling through a court with no course never saw or heard the U-turn, and in a court at an angle the heading kept the turn in, then brought
 * the U-turn back after the turn out, on the road.
 */

// A place in Sydney, so the maths is checked away from the equator and the prime meridian.
const ORIGIN: Pt = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
const rad = (deg: number) => (deg * Math.PI) / 180

/** A place in the driver's own frame: [metres to the right of the way the road first heads, metres ahead of the start]. */
type Spot = readonly [number, number]

/** The same place on the map, for a road that heads `h` degrees clockwise from north. */
const spot = (h: number, [x, y]: Spot): Pt => {
  const east = x * Math.cos(rad(h)) + y * Math.sin(rad(h))
  const north = -x * Math.sin(rad(h)) + y * Math.cos(rad(h))
  return { lat: ORIGIN.lat + north / M_PER_DEG, lng: ORIGIN.lng + east / (M_PER_DEG * Math.cos(rad(ORIGIN.lat))) }
}

/** Places along the lines through these, one at least every `step` metres. */
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

/** What the road service answers for a drive through these places: a point every 20 m or so, six-figure coordinates, longitude first. */
const answer = (h: number, ...xy: Spot[]) => ({
  code: 'Ok',
  routes: [
    {
      distance: 0,
      duration: 60,
      geometry: {
        type: 'LineString',
        coordinates: dense(20, ...xy).map((s) => {
          const p = spot(h, s)
          return [Number(p.lng.toFixed(6)), Number(p.lat.toFixed(6))]
        }),
      },
    },
  ],
})

/** Draws a route as the screen does with Follow roads on: the first tap a point of its own, and each road after it a lookup from the end of the route. */
async function draw(h: number, ...roads: Spot[][]): Promise<Route> {
  const answers = roads.map((road) => answer(h, ...road))
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      const next = answers.shift()
      if (!next) throw new Error('unexpected request')
      return Promise.resolve(new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } }))
    }),
  )
  let route: Route = appendPoint({ points: [], sideChanges: [], stops: [] }, spot(h, roads[0][0]), 'both')
  for (const road of roads) {
    const done = await extendAlongRoads(route, spot(h, road[road.length - 1]), 'both')
    expect(done.notice).toBeNull()
    route = done.route
  }
  return route
}

/** How far up the road the route starts before the court, in metres: far enough for the turn in to come into view (200 m) on the way. */
const LEAD_M = 400

/** A court off the road and the drive through it. */
interface Court {
  /** Degrees off the road, to the right (`side` 1) or the left (-1), and how deep it is, in metres. */
  angle: number
  depth: number
  side: 1 | -1
  /** Whether the car goes on up the road afterwards, or back the way it came. */
  on: boolean
  /** The way the road heads, in degrees clockwise from north. */
  h: number
  /** How much more road there is at the start, in metres: it moves where the court falls on the 5 m pieces the route is read in. */
  start: number
  route: Route
  /** What the route reads as: the turn in, the U-turn and the turn out. */
  turns: Turn[]
  /** The car's way, along the route's own line, a place every metre or so, and how far along it each is. */
  path: Spot[]
  cum: number[]
  /** How far along its way the car turns into the court, and turns round at its end, in metres. */
  turnIn: number
  reversal: number
}

const ANGLES = [55, 60, 90, 120, 125]
const DEPTHS = [8, 10, 12, 16]
const HEADINGS = [0, 100, 215, 300]

/**
 * Every court, drawn once: each angle and depth, to either side, left the way the car goes on or back, with the road heading four ways, and
 * the court falling a quarter of a 5 m piece further on with each.
 */
let COURTS: Court[] = []

beforeEach(() => {
  rate.minGapMs = 0
})
afterEach(() => {
  vi.unstubAllGlobals()
})
beforeAll(async () => {
  rate.minGapMs = 0
  const all: Court[] = []
  for (const angle of ANGLES) {
    for (const depth of DEPTHS) {
      for (const side of [1, -1] as const) {
        for (const on of [true, false]) {
          for (const [k, h] of HEADINGS.entries()) {
            const start = k * 1.25
            const end: Spot = [side * depth * Math.sin(rad(angle)), depth * Math.cos(rad(angle))]
            const away: Spot = [0, on ? 150 : -LEAD_M + 200]
            // The road up to the court and into it, then the court straight back out and on (or back): the road service runs back out of the court from its end.
            const route = await draw(h, [[0, -LEAD_M - start], [0, 0], end], [end, [0, 0], away])
            vi.unstubAllGlobals()
            const turns = routeTurns(route.points)
            const path = [...dense(1, [0, -LEAD_M - start], [0, 0], end), ...dense(1, end, [0, 0], away).slice(1)]
            const cum = path.map(() => 0)
            for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
            all.push({ angle, depth, side, on, h, start, route, turns, path, cum, turnIn: LEAD_M + start, reversal: LEAD_M + start + depth })
          }
        }
      }
    }
  }
  COURTS = all
}, 60_000)

/** A seeded random number generator, so a drive is the same every time. */
function random(seed: number) {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const gaussian = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())

/** How the car is driven. */
interface Car {
  /** Its speed in the court, from 8 m before the turn in to 8 m after the turn out, in metres a second: 6 on the road. Under 1.5 the phone gives no course. */
  court: number
  seed: number
  /**
   * 'phone': where the app puts it, from fixes 3 m out (the error carried over from fix to fix), as Round does. 'exact': where it really is,
   * along the route and with the way it is really going (none while crawling), to try the card and the voice on their own.
   */
  tracker: 'phone' | 'exact'
}

/** What the driver was shown and told on a drive. */
interface Drive {
  /** The turns the card was for, by their place in the court's three, each time it changed to another (a card for no turn is left out). */
  cards: number[]
  /** What the voice said, in order: of which of the three, the words, and how far along its way the car was. */
  said: { turn: number; text: string; s: number }[]
}

/** Drives the car through the court a fix a second, and gives what the card showed and the voice said, as Round has them (see the top). */
function drive(c: Court, car: Car): Drive {
  const track = makeTrack(c.route.points)
  const routeEnd = track.cum[track.cum.length - 1]
  const truth = c.path.map((s) => spot(c.h, s))
  const fromIn = c.turnIn - 8
  const toOut = c.reversal + c.depth + 8
  const r = random(car.seed * 7919 + c.h)
  let err = [0, 0]
  let progress: Progress | null = null
  let trail: TrailPoint[] = []
  let headingDeg: number | null = null
  let furthest = 0
  const saidTurn = new Map<number, TurnCue>()
  const cards: number[] = []
  const said: Drive['said'] = []
  const length = c.cum[c.cum.length - 1]
  let s = 0
  let i = 0
  for (let clock = 0; s < length; clock += 1000) {
    const here = s
    const speed = here >= fromIn && here <= toOut ? car.court : 6
    s += speed
    while (c.cum[i + 1] < here) i++
    const t = (here - c.cum[i]) / (c.cum[i + 1] - c.cum[i])
    const pos = { lat: truth[i].lat + (truth[i + 1].lat - truth[i].lat) * t, lng: truth[i].lng + (truth[i + 1].lng - truth[i].lng) * t }
    const going = bearing(truth[i], truth[i + 1])
    let along = here
    if (car.tracker === 'exact') {
      furthest = Math.max(furthest, here)
      headingDeg = speed >= 1.5 ? going : null
    } else {
      err = err.map((e) => 0.6 * e + 0.8 * gaussian(r) * 3)
      const fix = { lat: pos.lat + err[1] / M_PER_DEG, lng: pos.lng + err[0] / (M_PER_DEG * Math.cos(rad(ORIGIN.lat))), accuracy: 5, time: clock, speed }
      // The phone's course, 10 degrees out, while it is going fast enough to have one, and the trail's heading otherwise, as Round has it.
      const course = speed >= 1.5 ? (going + gaussian(r) * 10 + 360) % 360 : trailHeading(trail, fix.accuracy)
      const now = advance(track, progress, fix, course)
      // A fix the tracker set aside, or one that left the car where it was, changes nothing on the screen.
      if (!now || now === progress) continue
      progress = now
      trail = pushTrail(trail, { lat: now.at.lat, lng: now.at.lng, time: now.time ?? clock })
      headingDeg = course
      if (!onTheRoute(now.gap, now.accuracy, now.lost)) continue
      along = now.along
      furthest = now.furthest
    }
    const guidance = guidanceToShow(c.turns, { onTrack: true, transit: false, along, routeEnd, heading: headingDeg, after: furthest - TURN_PASSED_M, reached: furthest })
    const guided = guidance ? guidedTurn(guidance) : null
    if (!guided) continue
    const which = c.turns.indexOf(guided.turn)
    if (cards[cards.length - 1] !== which) cards.push(which)
    const spoken = cueToSay(guided.turn, guided.ahead, saidTurn.get(turnKey(guided.turn.at)) ?? null, false)
    if (spoken) {
      saidTurn.set(turnKey(guided.turn.at), spoken.cue)
      said.push({ turn: which, text: spoken.text, s: here })
    }
  }
  return { cards, said }
}

/** What went wrong on a drive, as words: nothing when the card and the voice went turn in, U-turn, turn out, with the U-turn said before the car turned round. */
function faults(c: Court, d: Drive): string[] {
  const out: string[] = []
  if (d.cards.join() !== '0,1,2') out.push(`cards ${d.cards.join(' ')}`)
  if (d.said.map((w) => w.turn).join() !== '0,0,1,2') out.push(`said ${d.said.map((w) => w.text).join(' | ')}`)
  const uturn = d.said.find((w) => w.turn === 1)
  if (!uturn) out.push('no U-turn said')
  else if (uturn.s >= c.reversal) out.push(`U-turn said ${Math.round(uturn.s - c.reversal)} m after turning round`)
  return out
}

/** Whether anything of the turn in or the U-turn was shown or said after the turn out was. */
function afterTheTurnOut(d: Drive): boolean {
  const card = d.cards.indexOf(2)
  const word = d.said.findIndex((w) => w.turn === 2)
  return (card >= 0 && d.cards.slice(card).some((k) => k !== 2)) || (word >= 0 && d.said.slice(word).some((w) => w.turn !== 2))
}

const label = (c: Court) => `${c.angle} deg ${c.depth} m ${c.side > 0 ? 'right' : 'left'} ${c.on ? 'on' : 'back'} h${c.h}`

/** How a set of drives went. */
interface Tally {
  drives: number
  /** Drives with nothing wrong (see `faults`). */
  right: number
  /** Drives in which the U-turn was said before the car turned round. */
  inTime: number
  /** Drives in which the turn in or the U-turn was shown or said after the turn out was. */
  afterOut: number
  /** The first few drives with something wrong, and what. */
  wrong: string[]
}

/** Drives the car through each of these courts once for each seed, and counts how it went. */
function tally(courts: Court[], car: Omit<Car, 'seed'>, seeds: number[]): Tally {
  const t: Tally = { drives: 0, right: 0, inTime: 0, afterOut: 0, wrong: [] }
  for (const c of courts) {
    for (const seed of seeds) {
      const d = drive(c, { ...car, seed })
      const f = faults(c, d)
      const uturn = d.said.find((w) => w.turn === 1)
      t.drives++
      if (!f.length) t.right++
      else if (t.wrong.length < 5) t.wrong.push(`${label(c)} seed ${seed}: ${f.join('; ')}`)
      if (uturn && uturn.s < c.reversal) t.inTime++
      if (afterTheTurnOut(d)) t.afterOut++
    }
  }
  return t
}

const SEEDS = [1, 2, 3, 4]

describe('the turns of a short court, as the round shows and says them', () => {
  it('reads every court as the turn in, the U-turn and the turn out', () => {
    expect(COURTS).toHaveLength(ANGLES.length * DEPTHS.length * 2 * 2 * HEADINGS.length)
    for (const c of COURTS) {
      const read = c.turns.map((t) => turnKind(t.angle))
      expect(read, label(c)).toHaveLength(3)
      expect(read[1], label(c)).toBe('uturn')
      expect(Math.sign(c.turns[0].angle), label(c)).toBe(c.side)
    }
  })

  it('shows and says them in order, the U-turn before the car turns round and nothing after the turn out, where the car is known exactly, crawling or at 3 to 6 m/s', { timeout: 60_000 }, () => {
    // Crawling, the phone has no heading, and the turn in used to be up until the car was 15 m past it, so the U-turn came after the car had turned
    // round, or not at all. At speed, in a court 60 degrees or less off the road, or 120 or more, the heading kept the turn in up through the court,
    // and on the road again brought the U-turn back after the turn out.
    for (const court of [1.2, 3, 4.5, 6]) {
      const t = tally(COURTS, { court, tracker: 'exact' }, [1])
      expect(t.wrong, `${court} m/s`).toEqual([])
      expect(t).toMatchObject({ drives: COURTS.length, right: COURTS.length, inTime: COURTS.length, afterOut: 0 })
    }
  })

  it('does the same nearly every time for a car tracked from its fixes, as the round has it, at 3 to 6 m/s', { timeout: 60_000 }, () => {
    // Measured: in order with the U-turn in time in 96 to 97% of drives at each speed (it was 43 to 57%); the U-turn said in time in 97 to 99%
    // (85 to 92%); and the turn in or the U-turn after the turn out in 0.2 to 1.2% (13 to 28%). What is left is the tracker's: a fix that puts
    // the car on the road past the court for a moment as it comes to the corner (the road out of the court meets the road in there), so the turn out
    // is said first; one that puts it back in the court on the road after it; and in an 8 m court at 6 m/s no fix inside it before it turns round.
    for (const court of [3, 4.5, 6]) {
      const t = tally(COURTS, { court, tracker: 'phone' }, SEEDS)
      const why = `${court} m/s: ${JSON.stringify(t)}`
      expect(t.drives).toBe(COURTS.length * SEEDS.length)
      expect(t.right / t.drives, why).toBeGreaterThanOrEqual(0.94)
      expect(t.inTime / t.drives, why).toBeGreaterThanOrEqual(0.95)
      expect(t.afterOut / t.drives, why).toBeLessThanOrEqual(0.02)
    }
  })

  it('says the U-turn in time far more often for a car crawling through with no course, and seldom anything after the turn out', { timeout: 60_000 }, () => {
    // A phone going under 1.5 m/s is taken to be standing still until it has moved 6 m, so the tracker moves on in steps of about that, and in a court
    // 8 to 12 m deep it may have the car past the U-turn, or round it, by its first step in. Measured: the U-turn said before the car turns round in
    // 57% of drives (17.5% before), from 34% at 8 m to 88% at 16 m; and the turn in or the U-turn after the turn out in 5.5% (14.7%).
    const t = tally(COURTS, { court: 1.2, tracker: 'phone' }, SEEDS)
    const why = JSON.stringify(t)
    expect(t.inTime / t.drives, why).toBeGreaterThanOrEqual(0.5)
    expect(t.afterOut / t.drives, why).toBeLessThanOrEqual(0.08)
  })
})
