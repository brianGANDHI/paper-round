import { describe, expect, it } from 'vitest'
import { alertable, alertRadius, houseRow, keepAlertsAhead, pickCurrent, quietReachFor, roundCounts, zoneExit } from './alerts'
import { bannerWaiting } from './bannerBlock'
import { restartedRound, savedRound } from './bundleFlow'
import { markDropped, otherPasses } from './bundles'
import { approachingOccurrences, byPosition, haversine, occurrences, type Occurrence } from './geo'
import { OFF_MAX_ACCURACY_M, ON_ROUTE_M, startOffRoute, stepOffRoute, type OffPhase, type OffState } from './offRoute'
import { advance, makeTrack, offRouteGap, startProgress, type Progress } from './progress'
import { slackFor } from './resume'
import { doneNow, endTurnHold, heldKeys, HOLD_END_M, holdGoneBy, holdLeftBehind, judgedAt, NOTHING_HELD, shownQueue, stepTurnHold, type TurnHold } from './turnHold'
import type { Pt, RoundState, Route, Stop, StopType } from './types'

// A place in Sydney, so the maths is checked away from the equator and the prime meridian.
const ORIGIN = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
const cos = (deg: number) => Math.cos((deg * Math.PI) / 180)

type XY = [number, number]

/** A spot `x` metres east and `y` metres north of the start. */
const spot = ([x, y]: readonly [number, number]): Pt => ({ lat: ORIGIN.lat + y / M_PER_DEG, lng: ORIGIN.lng + x / (M_PER_DEG * cos(ORIGIN.lat)) })

const radius = alertRadius(40)

const stop = (id: string, type: StopType, xy: XY): Stop => ({ id, type, pathIdx: 0, ...spot(xy) })

/** A pass of a stop as the queue has it, `at` metres along the route, `off` metres from it. */
const occ = (key: string, type: StopType, at: number, off = 8): Occurrence => ({ key, stop: stop(key.split('#')[0], type, [off, at]), idx: 0, at, off })

const hold = (over: Partial<TurnHold> = {}): TurnHold => ({ from: 192, to: 412, held: new Set(['B', 'H']), deferred: [], ended: false, ...over })

describe('the hold over a turn round that is not sure yet', () => {
  const B = occ('B', 'bundle', 195)
  const H = occ('H', 'nothrow', 225)
  const B2 = occ('B#2', 'bundle', 405)
  const H2 = occ('H#2', 'nothrow', 375)
  const turned = { from: 192, to: 412 }

  it('starts with the turn round, holding the alerts that are up then', () => {
    expect(stepTurnHold(null, { along: 200, turned: null }, [B, H], 600)).toEqual({ hold: null, settle: [], release: [] })
    const step = stepTurnHold(null, { along: 412, turned }, [B, H], 600)
    expect(step.hold).toEqual({ from: 192, to: 412, held: new Set(['B', 'H']), deferred: [], ended: false })
    expect(step.settle).toEqual([])
    expect(step.release).toEqual([])
    // (A position from before `turned` was kept, or a fresh start, has none.)
    expect(stepTurnHold(null, { along: 412 }, [B, H], 600).hold).toBeNull()
  })

  it('stays the same hold, the very same, from fix to fix while the turn and the alerts held are', () => {
    const first = stepTurnHold(null, { along: 412, turned }, [B, H], 600).hold
    // An alert that comes up meanwhile (the way back's own) is not held.
    const next = stepTurnHold(first, { along: 416, turned }, [B, H, B2], 600)
    expect(next.hold).toBe(first)
    expect(heldKeys(next.hold)).toBe(heldKeys(first))
  })

  it('lets go of a held alert that is no longer up, so that if it comes up again it is judged as any other', () => {
    const next = stepTurnHold(hold(), { along: 416, turned }, [H, B2], 600)
    expect(next.hold?.held).toEqual(new Set(['H']))
  })

  it('ends when the turn is undone, and the stops put by are to come again', () => {
    const step = stepTurnHold(hold({ deferred: [H2] }), { along: 199, turned: null }, [B, H], 600)
    expect(step).toEqual({ hold: null, settle: [], release: [H2] })
  })

  it('ends when the turn is sure, or the tracker starts afresh, with the driver at or past where it put them: the stops put by are done', () => {
    expect(stepTurnHold(hold({ deferred: [H2] }), { along: 512, turned: null }, [B, H], 600)).toEqual({ hold: null, settle: [H2], release: [] })
    // (A fix too far from the route to say anything keeps the place the driver had, and no turn round.)
    expect(stepTurnHold(hold({ deferred: [H2] }), { along: 412 }, [B, H], 600).settle).toEqual([H2])
  })

  it('ends when another turn round further on takes its place, and holds afresh for that one', () => {
    const step = stepTurnHold(hold({ deferred: [H2] }), { along: 470, turned: { from: 450, to: 470 } }, [B, H, B2], 900)
    expect(step.settle).toEqual([H2])
    expect(step.hold).toEqual({ from: 450, to: 470, held: new Set(['B', 'H', 'B#2']), deferred: [], ended: false })
  })

  it('takes the turn to stand once the driver is put on the way back within HOLD_END_M of the end of the route, which leaves no room for it to be sure', () => {
    const end = 412 + HOLD_END_M + 1
    expect(stepTurnHold(hold({ deferred: [H2] }), { along: 412, turned }, [B, H], end).hold?.ended).toBe(false)
    const step = stepTurnHold(hold({ deferred: [H2] }), { along: 412, turned }, [B, H], end - 1)
    expect(step.settle).toEqual([H2])
    expect(step.hold).toEqual({ from: 192, to: 412, held: NOTHING_HELD, deferred: [], ended: true })
    // And it is not held again for as long as the turn lasts, wherever the driver goes; when it does end, there is nothing left to settle.
    const later = stepTurnHold(step.hold, { along: 300, turned }, [B, H], end - 1)
    expect(later.hold).toBe(step.hold)
    expect(stepTurnHold(step.hold, { along: 300, turned: null }, [B, H], end - 1)).toEqual({ hold: null, settle: [], release: [] })
  })

  it('judges a held alert where the driver was put from, and every other where the driver is', () => {
    expect(judgedAt(H, 412, hold())).toBe(192)
    expect(judgedAt(B2, 412, hold())).toBe(412)
    expect(judgedAt(H, 412, null)).toBe(412)
    expect(judgedAt(H, 412, hold({ held: NOTHING_HELD, ended: true }))).toBe(412)
    // So the house still to come is neither passed nor backed away from, though the driver is put 187 m past it.
    expect(zoneExit(H, judgedAt(H, 412, hold()), radius)).toBeNull()
    expect(zoneExit(H, 412, radius)).toBe('passed')
  })

  it('puts by a stop along the route gone by while it holds, and leaves one met by where the phone is to be done now', () => {
    const away = occ('A', 'nothrow', 380, 120)
    expect(byPosition(away, radius)).toBe(true)
    const before = hold({ deferred: [B2] })
    const put = holdGoneBy(before, [H2, away], radius)
    expect(put.now).toEqual([away])
    expect(put.hold?.deferred).toEqual([B2, H2])
    expect(before.deferred).toEqual([B2])
    expect(holdGoneBy(null, [H2, away], radius)).toEqual({ hold: null, now: [H2, away] })
    const ended = hold({ held: NOTHING_HELD, ended: true })
    expect(holdGoneBy(ended, [H2], radius)).toEqual({ hold: ended, now: [H2] })
  })

  it('keeps the stops done now and those put by over a turn that stood in one go, the bundles among them missed', () => {
    const K2 = occ('K#2', 'nothrow', 415)
    // B#2 was put by and is gone by again (it is not), H#2 is done already: each is kept once.
    const { done, missed } = doneNow([B], [B2, H2, K2, B2], new Set(['H#2']), true)
    expect(done.map((o) => o.key)).toEqual(['B', 'B#2', 'K#2'])
    expect(missed).toEqual(['B', 'B#2'])
    // Off the route a bundle just gone by is skipped, not missed; one put by was gone by on the route, and is missed.
    expect(doneNow([B], [B2], new Set(), false).missed).toEqual(['B#2'])
    expect(doneNow([], [], new Set(), true)).toEqual({ done: [], missed: [] })
  })

  it('on a restart, takes the turn as it stands: put on the way back, the stops put by and the held alerts gone by are done', () => {
    expect(endTurnHold(null, 450, [B, H], radius)).toEqual([])
    expect(endTurnHold(hold({ deferred: [B2] }), 300, [B, H], radius)).toEqual([])
    // At 450 B and H are gone by; B#2 is up but not held, and a held house still in its zone is not gone by.
    const near = occ('N', 'nothrow', 430)
    expect(endTurnHold(hold({ deferred: [B2], held: new Set(['B', 'H', 'N']) }), 450, [B, H, near, H2], radius)).toEqual([B2, B, H])
    expect(endTurnHold(hold({ held: NOTHING_HELD, ended: true }), 450, [B, H], radius)).toEqual([])
  })

  it('leaves the alerts held that the driver, put on the way back, has gone by out of what the banner shows, and leaves the queue as it is with none', () => {
    const queue = [B, H, B2]
    expect(shownQueue(queue, NOTHING_HELD, 192, 412, null, radius)).toBe(queue)
    expect(shownQueue(queue, heldKeys(null), 192, 412, null, radius)).toBe(queue)
    expect(shownQueue(queue, heldKeys(hold()), 192, 412, null, radius)).toEqual([B2])
    // The banner would otherwise fall back on the house, the least far behind, as passed.
    expect(pickCurrent(queue.slice(0, 2), 192, 412, null, radius)?.key).toBe('H')
    expect(pickCurrent(shownQueue(queue.slice(0, 2), heldKeys(hold()), 192, 412, null, radius), 192, 412, null, radius)).toBeUndefined()
    expect(heldKeys(hold({ held: NOTHING_HELD, ended: true }))).toBe(NOTHING_HELD)
  })

  it('still shows a held alert the driver is at, as a house at the turn-round of a court is, on both legs of the one pass', () => {
    // A court 120 m deep, turned round 10 m short of its end: put on the way back at 130 m from 110 m, with the house at the end up.
    const tip = occ('T', 'nothrow', 125)
    const at = hold({ from: 110, to: 130, held: new Set(['T']) })
    expect(shownQueue([tip], heldKeys(at), 110, 130, null, radius)).toEqual([tip])
    expect(shownQueue([tip], heldKeys(at), 110, 135, null, radius)).toEqual([])
  })

  it('puts by a stop a change of the route leaves behind the driver only by where the turn put them, and leaves one behind where it put them from to be done now', () => {
    const slack = slackFor(radius)
    const far = occ('F', 'nothrow', 192 - slack - 1)
    const near = occ('N', 'nothrow', 192 - slack)
    const away = occ('A', 'nothrow', 380, 120)
    const before = hold({ deferred: [B2] })
    const put = holdLeftBehind(before, [far, near, H2, away], slack, radius)
    expect(put.now).toEqual([far, away])
    expect(put.hold?.deferred).toEqual([B2, near, H2])
    expect(put.hold?.held).toBe(before.held)
    expect(before.deferred).toEqual([B2])
    // Nothing to put by: the very same hold.
    expect(holdLeftBehind(before, [far, away], slack, radius)).toEqual({ hold: before, now: [far, away] })
    expect(holdLeftBehind(before, [far], slack, radius).hold).toBe(before)
    expect(holdLeftBehind(null, [near, H2], slack, radius)).toEqual({ hold: null, now: [near, H2] })
    const ended = hold({ held: NOTHING_HELD, ended: true })
    expect(holdLeftBehind(ended, [near, H2], slack, radius)).toEqual({ hold: ended, now: [near, H2] })
  })
})

describe('a change of the throw side while a turn round is not sure yet', () => {
  // A street 300 m north and back, thrown Left both ways, with two houses on its east side, at 100 m and 230 m: quiet on the way out (east is on
  // the right going north) and alerting on the way back. The way out is then changed to Right, so both start to alert on it as well.
  const X = stop('X', 'nothrow', [8, 230])
  const Y = stop('Y', 'nothrow', [8, 100])
  const was: Route = { points: ([[0, 0], [0, 300], [0, 0]] as XY[]).map(spot), sideChanges: [{ idx: 0, side: 'left' }], stops: [X, Y] }
  const now: Route = { ...was, sideChanges: [{ idx: 0, side: 'right' }, { idx: 1, side: 'left' }] }
  const reach = quietReachFor(40)
  const all = occurrences(now)
  const before = alertable(was, occurrences(was), reach)
  const after = alertable(now, all, reach)
  const byKey = new Map(after.map((o) => [o.key, o]))
  /** What the round screen does with the change (its effect on the passes that alert), with the driver put `along` the route. */
  const sweep = (along: number, h: TurnHold | null) => {
    const behind = keepAlertsAhead(now, all, before, after, along, radius).done.map((key) => byKey.get(key)!)
    return holdLeftBehind(h, behind, slackFor(radius), radius)
  }
  // A car that backed up at 200 m on the way out, which the tracker has put on the way back, at 400 m, for now.
  const backed = hold({ from: 200, to: 400, held: NOTHING_HELD })

  it('starts the houses alerting on the way out (as alertable has it)', () => {
    expect(before.map((o) => o.key)).toEqual(['X#2', 'Y#2'])
    expect(after.map((o) => [o.key, Math.round(o.at)])).toEqual([
      ['Y', 100],
      ['X', 230],
      ['X#2', 370],
      ['Y#2', 500],
    ])
  })

  it('counts both done at once with no turn round to doubt, as the driver put at 400 m is past them', () => {
    expect(sweep(400, null).now.map((o) => o.key)).toEqual(['Y', 'X'])
  })

  it('puts by the house the turn alone put the driver past, and counts done the one they had gone by before it', () => {
    const put = sweep(400, backed)
    expect(put.now.map((o) => o.key)).toEqual(['Y'])
    expect(put.hold?.deferred.map((o) => o.key)).toEqual(['X'])
  })

  it('has the house still to come when the turn is undone, and done when it is sure', () => {
    const put = sweep(400, backed)
    // Undone: back on the way out at 205 m, where the house comes up as the car drives on.
    expect(stepTurnHold(put.hold, { along: 205, turned: null }, [], 600).release.map((o) => o.key)).toEqual(['X'])
    expect(approachingOccurrences(205, spot([0, 205]), after, new Set(['Y']), radius, 8).map((o) => o.key)).toContain('X')
    // Sure: 100 m along the way back.
    const sure = stepTurnHold(put.hold, { along: 500, turned: null }, [], 600)
    expect(sure.settle.map((o) => o.key)).toEqual(['X'])
    expect(doneNow([], sure.settle, new Set(['Y']), true)).toEqual({ done: [byKey.get('X')], missed: [] })
  })
})

// ---- Drives: a car with a GPS, through the real tracker, off-route machine and alerts, as the round screen does ----

/** Spots no more than `step` metres apart along the polyline through these. */
function dense(step: number, ...xy: XY[]): XY[] {
  const out: XY[] = [xy[0]]
  for (let i = 1; i < xy.length; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]) / step))
    for (let k = 1; k <= n; k++) out.push([xy[i - 1][0] + ((xy[i][0] - xy[i - 1][0]) * k) / n, xy[i - 1][1] + ((xy[i][1] - xy[i - 1][1]) * k) / n])
  }
  return out
}

/**
 * A fix of the car on a street that runs north, `y` metres up it, going `speed` metres a second (0 for standing still), north or south;
 * `x` metres east of it, if not on it, and claiming `accuracy` metres, if not 8.
 */
interface Fix {
  x?: number
  accuracy?: number
  y: number
  speed: number
  heading: number | null
}

/** The car's fixes, one a second, from `from` metres north to `to` at `speed`: not the one at `from`, which is the last of the leg before. */
function go(from: number, to: number, speed: number): Fix[] {
  const way = to >= from ? 1 : -1
  const count = Math.floor(Math.abs(to - from) / speed + 1e-9)
  return Array.from({ length: count }, (_, k) => ({ y: Math.round((from + way * speed * (k + 1)) * 10) / 10, speed, heading: way > 0 ? 0 : 180 }))
}

/** The same, east or west along a street `y` metres north, from `from` metres east to `to` (as into a court off a street that runs north). */
const goEast = (y: number, from: number, to: number, speed: number): Fix[] => go(from, to, speed).map((f) => ({ x: f.y, y, speed, heading: f.heading === 0 ? 90 : 270 }))

/** Standing still at `y` for `seconds`: the phone says it is going nowhere and has no course. */
const stand = (y: number, seconds: number, x?: number): Fix[] => Array.from({ length: seconds }, () => ({ x, y, speed: 0, heading: null }))

/** What the round screen has after a fix. */
interface Beat {
  i: number
  /** Where the car truly is, and which way it is going. */
  x: number
  y: number
  heading: number | null
  progress: Progress
  phase: OffPhase
  /** The keys of the alerts up, and of those held over a turn round. */
  queue: string[]
  held: ReadonlySet<string>
  /**
   * What the banner shows (`pickCurrent` over what is shown), and what it would show over every alert up; and the count of those waiting,
   * and what it would be with the alerts held taken out of the queue altogether.
   */
  current: string | undefined
  unheld: string | undefined
  waiting: number
  waitingUnheld: number
  handled: ReadonlySet<string>
  round: RoundState
}

interface Ride {
  beats: Beat[]
  /** Each bundle drop missed, with where the car was when it was kept so (the screen tells the driver then). */
  missed: { key: string; y: number }[]
  occs: Occurrence[]
}

interface RideOptions {
  /** After a fix, the driver may tap Dropped on the banner: the key it is for, or nothing. */
  tap?: (b: Beat) => string | undefined
  /** After this fix (counting from 0) the driver skips to this many metres along the route. */
  skip?: { after: number; metres: number }
  /** Leave the alerts held in what the banner shows, as a screen that did not leave them out would. */
  showHeld?: boolean
  /** GPS error of about this many metres each way, drifting from fix to fix as real error does, and a course out by about 10 degrees. */
  noise?: number
  seed?: number
}

/** The same noise every run: a small seeded random number generator. */
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

/**
 * Drive `fixes` on `route`, a fix a second claiming 8 m, and do with each what Round.tsx does: the tracker, then (for a fix it took in) the
 * off-route machine, as the fix effect does, and the alert effect, run again when the stops done change; then what the banner shows.
 */
function ride(route: Route, fixes: Fix[], o: RideOptions = {}): Ride {
  const track = makeTrack(route.points)
  const routeEnd = track.cum[track.cum.length - 1]
  const allOccs = occurrences(route)
  const occs = alertable(route, allOccs, quietReachFor(40))
  let progress: Progress | null = null
  let machine: OffState = startOffRoute
  let reached = false
  let reachAlong = 0
  let reachRun: Pt | null = null
  let lastStepAt: Pt | null = null
  let restartFrom: number | null = null
  let round: RoundState = { handledStopIds: [] }
  let queue: Occurrence[] = []
  const seen = new Set<string>()
  let turnHold: TurnHold | null = null
  const missed: Ride['missed'] = []
  const beats: Beat[] = []
  let y = 0
  const rand = random(o.seed ?? 1)
  let err = [0, 0]
  const handledNow = () => new Set(round.handledStopIds)
  /** Keeps the round as `saveRound` does, noting each bundle newly missed. */
  const save = (round0: RoundState, next: RoundState) => {
    const was = new Set(round0.missed ?? [])
    for (const key of next.missed ?? []) if (!was.has(key)) missed.push({ key, y })
    round = next
  }

  /** The alert effect, for the progress there is. True when it changed the stops done, which runs it again. */
  const alerts = (p: Progress): boolean => {
    const handled = handledNow()
    const driverAt = p.along
    const pos = p.at
    const step = stepTurnHold(turnHold, p, queue, routeEnd)
    let hold = step.hold
    // (Round.tsx forgets them as said and held for the voice as well.)
    for (const back of step.release) seen.delete(back.key)
    const left = queue.flatMap((q) => {
      const exit = zoneExit(q, judgedAt(q, driverAt, hold), radius, pos)
      return exit ? [{ o: q, exit }] : []
    })
    const gone = new Set(left.map((l) => l.o.key))
    queue = queue.filter((q) => !gone.has(q.key))
    const onRoute = machine.phase === 'on'
    for (const l of left) if (l.exit === 'back' || (l.exit === 'passed' && !onRoute && !byPosition(l.o, radius))) seen.delete(l.o.key)
    const goneBy = left.filter((l) => l.exit === 'passed' && !handled.has(l.o.key) && (onRoute || byPosition(l.o, radius))).map((l) => l.o)
    const put = holdGoneBy(hold, goneBy, radius)
    hold = put.hold
    turnHold = hold
    const { done, missed: missedKeys } = doneNow(put.now, step.settle, handled, onRoute)
    if (done.length) save(round, savedRound(round, [...handled, ...done.map((d) => d.key)], undefined, 0, missedKeys))
    if (p.lost && p.time === null) return done.length > 0
    let doneNowSet = handled
    if (restartFrom !== null && !p.lost) {
      const from = restartFrom
      restartFrom = null
      const ahead = p.along - from
      if (ahead > 0 && ahead < 300) {
        const caught = occs.filter((c) => !handled.has(c.key) && !byPosition(c, radius) && c.at < p.along - slackFor(radius)).map((c) => c.key)
        if (caught.length) {
          doneNowSet = new Set([...handled, ...caught])
          save(round, savedRound(round, [...doneNowSet], undefined, 0))
        }
      }
    }
    const fresh = approachingOccurrences(driverAt, pos, occs, doneNowSet, radius, p.accuracy).filter((f) => !seen.has(f.key))
    for (const f of fresh) seen.add(f.key)
    queue = [...queue, ...fresh]
    return done.length > 0
  }
  /** The effect runs again when it changed the stops done, as the round it saved comes back (a few times at most). */
  const runAlerts = (p: Progress) => {
    let again = alerts(p)
    for (let k = 0; k < 2 && again; k++) again = alerts(p)
  }

  for (const [i, f] of fixes.entries()) {
    y = f.y
    err = err.map((e) => 0.5 * e + Math.sqrt(0.75) * gaussian(rand) * (o.noise ?? 0))
    const gps = { ...spot([(f.x ?? 0) + err[0], f.y + err[1]]), accuracy: f.accuracy ?? 8, time: i * 1000, speed: f.speed }
    const course = f.speed >= 1.5 && f.heading !== null ? (f.heading + (o.noise ? gaussian(rand) * 10 : 0) + 360) % 360 : null
    const before: Progress | null = progress
    const now = advance(track, before, gps, course)
    if (now && now !== before) {
      progress = now
      // The fix effect: the off-route machine, for a fix that moved the phone, once the route is reached and until the round is over.
      const moving = f.speed >= 1.5 || !lastStepAt || haversine(lastStepAt, now.at) >= 5
      if (now.time !== before?.time && moving) {
        lastStepAt = now.at
        if (roundCounts(occs, handledNow()).finished || now.furthest >= routeEnd - 50) {
          machine = startOffRoute
        } else {
          if (!reached) {
            const on = !now.lost && now.gap <= ON_ROUTE_M && now.accuracy <= OFF_MAX_ACCURACY_M
            if (!on) reachRun = null
            else {
              reachRun ??= now.at
              if (Math.abs(now.along - reachAlong) <= 100 || haversine(reachRun, now.at) >= 200) reached = true
            }
          }
          if (reached) {
            const reading = { time: now.time, at: now.at, accuracy: now.accuracy, speed: f.speed, gap: offRouteGap(now), along: now.along, furthest: now.furthest, lost: now.lost, doubt: now.doubt !== null }
            machine = stepOffRoute(machine, reading).state
          }
        }
      }
      runAlerts(now)
    }
    if (!progress) continue
    const p = progress
    const handled = handledNow()
    const held = heldKeys(turnHold)
    const shown = o.showHeld ? queue : shownQueue(queue, held, p.furthest, p.along, p.at, radius)
    const current = pickCurrent(shown, p.furthest, p.along, p.at, radius)
    const row = current ? houseRow(route, allOccs, occs, handled, current, radius) : []
    const free = queue.filter((q) => !held.has(q.key))
    const beat: Beat = {
      i,
      x: f.x ?? 0,
      y: f.y,
      heading: f.heading,
      progress: p,
      phase: machine.phase,
      queue: queue.map((q) => q.key),
      held,
      current: current?.key,
      unheld: pickCurrent(queue, p.furthest, p.along, p.at, radius)?.key,
      waiting: bannerWaiting(shown, row, p.furthest, p.along, p.at, radius),
      waitingUnheld: bannerWaiting(free, row, p.furthest, p.along, p.at, radius),
      handled,
      round,
    }
    beats.push(beat)
    const tapped = o.tap?.(beat)
    if (tapped) {
      // The screen's dropBundle: the pass and the other passes of its stop are done and dropped, and their alerts go.
      const others = otherPasses(occs, tapped)
      save(round, markDropped(round, tapped, others))
      const settled = new Set([tapped, ...others])
      queue = queue.filter((q) => !settled.has(q.key))
      runAlerts(p)
    }
    if (o.skip?.after === i) {
      // The screen's restartAt(metres, true): a turn round not sure yet is taken as it stands, then the spot decides the stops.
      const handled0 = handledNow()
      const ended = doneNow([], endTurnHold(turnHold, p.along, queue, radius), handled0, true)
      if (ended.done.length) save(round, savedRound(round, [...handled0, ...ended.done.map((e) => e.key)], undefined, 0, ended.missed))
      turnHold = null
      seen.clear()
      queue = []
      const metres = o.skip.metres
      progress = startProgress(track, metres)
      machine = startOffRoute
      reached = false
      reachAlong = metres
      reachRun = null
      lastStepAt = null
      restartFrom = metres
      save(round, restartedRound(round, occs, metres, slackFor(radius)))
      runAlerts(progress)
    }
  }
  return { beats, missed, occs }
}

/** Every stretch of the route thrown on both sides. */
const routeOf = (points: XY[], stops: Stop[]): Route => ({ points: points.map(spot), sideChanges: [{ idx: 0, side: 'both' }], stops })

/** What the screen had at the fixes after the `i`th with the car going north, or south. */
const northFrom = (r: Ride, i: number) => r.beats.filter((b) => b.i > i && b.heading === 0)
const southFrom = (r: Ride, i: number) => r.beats.filter((b) => b.i > i && b.heading === 180)

describe('a car that backs up on a street driven out and back, with alerts up, and drives on', () => {
  // A street 300 m north and back, thrown both sides, with a bundle drop at 195 m on the right and a no-throw house at 225 m on the left.
  const B = stop('B', 'bundle', [8, 195])
  const H = stop('H', 'nothrow', [-8, 225])
  // North at 10 m/s to 200 m, where both alerts are up; back 16 m at 4 m/s; then on north at 5 m/s past both, to the end of the street, and back.
  const fixes = [{ y: 0, speed: 10, heading: 0 }, ...go(0, 200, 10), ...go(200, 184, 4), ...go(184, 294, 5), ...go(294, 0, 5)]
  const reversed = fixes.findIndex((f) => f.y === 184)

  for (const [name, points] of [
    ['with no points but its ends', [[0, 0], [0, 300], [0, 0]]],
    ['drawn with a point every 10 m', dense(10, [0, 0], [0, 300], [0, 0])],
  ] as [string, XY[]][]) {
    describe(name, () => {
      const r = ride(routeOf(points, [B, H]), fixes)
      const at = (y: number, heading: number) => r.beats.find((b) => b.y === y && b.heading === heading && b.i > reversed)!

      it('is put on the way back for a while, and then back on the way out (as the tracker does)', () => {
        const turned = r.beats.filter((b) => b.progress.turned)
        expect(turned.length).toBeGreaterThan(0)
        expect(turned.every((b) => b.progress.along > 300)).toBe(true)
        expect(at(204, 0).progress.along).toBeLessThan(300)
        expect(r.beats.every((b) => b.phase === 'on')).toBe(true)
      })

      it('keeps both alerts up all through the backing up, so that neither goes and comes back (beeping, and said again)', () => {
        for (const key of ['B', 'H']) {
          const up = r.beats.filter((b) => b.queue.includes(key)).map((b) => b.i)
          expect(up[0], key).toBeLessThan(reversed - 4)
          expect(up.at(-1), key).toBeGreaterThan(reversed + 3)
          expect(up.at(-1)! - up[0] + 1, key).toBe(up.length)
        }
      })

      it('keeps the no-throw house up as the car drives on past it, and does it only once past', () => {
        for (const b of northFrom(r, reversed).filter((n) => n.y >= 199 && n.y <= 264)) expect(b.queue, `${b.y}`).toContain('H')
        // The banner is the house, as the car comes up to it and is beside it.
        for (const b of northFrom(r, reversed).filter((n) => n.y >= 204 && n.y <= 229)) expect(b.current, `${b.y}`).toBe('H')
        const done = r.beats.find((b) => b.handled.has('H'))!
        expect(done.heading).toBe(0)
        expect(done.y).toBeGreaterThanOrEqual(265)
      })

      it('misses the bundle drop only once the car has driven on past it, and only once', () => {
        expect(r.missed.filter((m) => m.key === 'B')).toHaveLength(1)
        const missed = r.missed.find((m) => m.key === 'B')!
        expect(missed.y).toBeGreaterThanOrEqual(235)
        expect(r.beats.find((b) => b.handled.has('B'))!.i).toBeGreaterThan(at(234, 0).i)
      })

      it('alerts for the house again on the way back, which the backing up did not count as done', () => {
        const passing = at(224, 180)
        expect(passing.queue).toContain('H#2')
        expect(passing.current).toBe('H#2')
      })
    })
  }
})

describe('a car that backs up on a street driven out and back, as a phone really sees it', () => {
  // The street of before, backed up 12 to 20 m at 3 or 4 m/s, with GPS error of 3 or 5 m that drifts, and a course out by about 10 degrees.
  const B = stop('B', 'bundle', [8, 195])
  const H = stop('H', 'nothrow', [-8, 225])
  const CELLS: [number, number][] = [[12, 4], [16, 4], [20, 4], [12, 3], [16, 3]]

  it('has the no-throw house up as the car drives on past it, every time, and misses the bundle only once back on the way out', { timeout: 60_000 }, () => {
    for (const points of [[[0, 0], [0, 300], [0, 0]], dense(10, [0, 0], [0, 300], [0, 0])] as XY[][]) {
      for (const [back, pace] of CELLS) {
        for (const noise of [3, 5]) {
          for (let seed = 1; seed <= 6; seed++) {
            const name = `${points.length} points, ${back} m at ${pace} m/s, noise ${noise}, seed ${seed}`
            const fixes = [{ y: 0, speed: 10, heading: 0 }, ...go(0, 200, 10), ...go(200, 200 - back, pace), ...go(200 - back, 295, 5), ...go(295, 0, 5)]
            const reversing = fixes.findIndex((f, k) => k > 0 && f.heading === 180)
            const r = ride(routeOf(points, [B, H]), fixes, { noise, seed })
            // (Put on the way back for a while: the drive is one the hold is for.)
            expect(r.beats.some((b) => b.progress.turned && b.i < reversing + 10), name).toBe(true)
            const north = northFrom(r, reversing)
            expect(north.some((b) => b.y >= 212 && b.y <= 232 && b.current === 'H'), name).toBe(true)
            const missed = r.beats.find((b) => b.round.missed?.includes('B'))!
            expect(missed.heading, name).toBe(0)
            expect(missed.progress.turned, name).toBeNull()
            expect(missed.progress.along, name).toBeGreaterThan(195 + 40)
            expect(r.beats.some((b) => b.heading === 180 && b.i > reversing + 20 && b.y >= 215 && b.y <= 235 && b.queue.includes('H#2')), name).toBe(true)
          }
        }
      }
    }
  })
})

describe('a car that backs up in a court with a house alerting ahead, and drives on into it', () => {
  // A court 120 m deep, drawn with a point every 10 m, and a no-throw house 75 m in on the left.
  const route = routeOf(dense(10, [0, 0], [0, 120], [0, 0]), [stop('H', 'nothrow', [-8, 75])])
  const fixes = [{ y: 0, speed: 6, heading: 0 }, ...go(0, 42, 6), ...go(42, 31.5, 3.5), ...go(31.5, 116.5, 5), ...go(116.5, 1.5, 5), ...stand(1.5, 5)]
  const reversed = fixes.findIndex((f) => f.y === 31.5)
  const r = ride(route, fixes)

  it('keeps the house up all through the backing up, so that it does not go and come back', () => {
    const up = r.beats.filter((b) => b.queue.includes('H')).map((b) => b.i)
    expect(up[0]).toBeLessThan(reversed - 2)
    expect(r.beats[up.at(-1)!].y).toBeGreaterThan(110)
    expect(up.at(-1)! - up[0] + 1).toBe(up.length)
  })

  it('has the house up as the car passes it going in, and again coming out', () => {
    expect(r.beats.some((b) => b.progress.turned && b.i <= reversed + 3)).toBe(true)
    const goingIn = northFrom(r, reversed).find((b) => b.y === 76.5)!
    expect(goingIn.queue).toContain('H')
    expect(goingIn.current).toBe('H')
    const comingOut = southFrom(r, reversed).find((b) => b.y === 76.5)!
    expect(comingOut.queue).toContain('H#2')
    expect(comingOut.current).toBe('H#2')
  })

  it('counts both passes done by the end, and the round finished', () => {
    const last = r.beats.at(-1)!
    expect([...last.handled].sort()).toEqual(['H', 'H#2'])
    expect(roundCounts(r.occs, last.handled).finished).toBe(true)
    expect(last.held.size).toBe(0)
  })
})

describe('a car that backs up near where the route turns round, with alerts up, and drives on', () => {
  // Within about 45 m of the end of a street driven out and back, or of the tip of a deep court, the way back level with the car is only 40 to 90 m
  // on along the route, and on the first fix of a car backing up there, heading against the way out, it was the cheapest place by cost alone. The
  // driver was put there with no turn round to doubt, so the alerts that were up counted as gone by: the no-throw house just ahead, which alerts on
  // one leg only so near the end, was never alerted, and the bundle drop just behind was missed while the car reversed to it: in 23 or 24 of the
  // 24 drives of each case here. Now that is a turn round not sure yet, and the alerts are held.
  const NOISE: [number, number][] = [3, 5].flatMap((noise) => [1, 2, 3, 4, 5, 6].map((seed): [number, number] => [noise, seed]))

  /** How a drive went wrong: put on the way back with no turn round, the house never up as the car goes on to it, the bundle missed before it is driven past again, or told of leaving the route. */
  interface Wrong {
    unturned: string[]
    silent: string[]
    early: string[]
    off: string[]
  }

  /**
   * The drives, on each of `routes` at each noise, that went wrong: the car reverses from the `from`th fix; `onward` is a fix going on after it,
   * `house` one where the house is to be up, and `pastBundle` one that has driven on past the bundle drop again (only after that may it be missed).
   */
  function backUps(routes: XY[][], stops: Stop[], fixes: Fix[], from: number, onward: (b: Beat) => boolean, house: (b: Beat) => boolean, pastBundle: (b: Beat) => boolean): Wrong {
    const wrong: Wrong = { unturned: [], silent: [], early: [], off: [] }
    for (const points of routes) {
      for (const [noise, seed] of NOISE) {
        const r = ride(routeOf(points, stops), fixes, { noise, seed })
        const name = `${points.length} points, noise ${noise}, seed ${seed}`
        const going = (b: Beat) => b.i > from && onward(b)
        if (!r.beats.some((b) => b.i > from && b.i < from + 6 && b.progress.turned)) wrong.unturned.push(name)
        if (!r.beats.some((b) => going(b) && house(b) && b.queue.includes('H'))) wrong.silent.push(name)
        const passed = r.beats.find((b) => going(b) && pastBundle(b))!
        const missed = r.beats.find((b) => b.round.missed?.includes('B'))
        if (missed && missed.i < passed.i) wrong.early.push(name)
        if (r.beats.some((b) => b.phase !== 'on')) wrong.off.push(name)
      }
    }
    return wrong
  }

  it('on a street 300 m out and back: backed up 12 m at 4 m/s from 265 m, between a bundle drop 5 m behind and a house 10 m ahead', { timeout: 60_000 }, () => {
    const stops = [stop('B', 'bundle', [8, 260]), stop('H', 'nothrow', [-8, 275])]
    const fixes = [{ y: 0, speed: 10, heading: 0 }, ...go(0, 200, 10), ...go(200, 265, 5), ...go(265, 253, 4), ...stand(253, 1), ...go(253, 298, 5), ...go(298, 3, 5)]
    const from = fixes.findIndex((f) => f.heading === 180)
    const forward = fixes.findIndex((f) => f.y === 258)
    const routes: XY[][] = [[[0, 0], [0, 300], [0, 0]], dense(10, [0, 0], [0, 300], [0, 0])]
    const wrong = backUps(routes, stops, fixes, from, (b) => b.i >= forward && b.heading === 0, (b) => b.y >= 260 && b.y <= 276, (b) => b.y > 260)
    expect(wrong).toEqual({ unturned: [], silent: [], early: [], off: [] })
  })

  it('in a court 200 m deep: backed up 12 m at 4 m/s from 170 m in, between a bundle drop 5 m behind and a house 10 m ahead', { timeout: 60_000 }, () => {
    // The court runs east off a street north, 300 m up it; the route goes in, round at the end, out and on north.
    const stops = [stop('B', 'bundle', [165, 308]), stop('H', 'nothrow', [180, 292])]
    const fixes = [{ y: 0, speed: 8, heading: 0 }, ...go(0, 296, 8), ...goEast(300, 0, 170, 5), ...stand(300, 3, 170), ...goEast(300, 170, 158, 4), ...stand(300, 1, 158), ...goEast(300, 158, 198, 5), ...goEast(300, 198, 3, 5), ...go(300, 588, 8)]
    const from = fixes.findIndex((f) => f.heading === 270)
    const forward = fixes.findIndex((f) => f.x === 163)
    const court: XY[] = [[0, 0], [0, 300], [200, 300], [0, 300], [0, 600]]
    const wrong = backUps([court, dense(10, ...court)], stops, fixes, from, (b) => b.i >= forward && b.heading === 90, (b) => b.x >= 165 && b.x <= 181, (b) => b.x > 165)
    // (In one drive the fix the car starts backing up at is put 43 m on, on the way back, which is no further than the phone can have moved by
    // the slack for a fix claiming 8 m: as before, nothing doubts that, so the house just ahead is gone by and the bundle just behind is missed.)
    const once = '101 points, noise 5, seed 5'
    expect(wrong).toEqual({ unturned: [], silent: [once], early: [once], off: [] })
  })

  it('in a court drawn with points along it, backed up 80 m: the way back passes that came up meanwhile alert when the car really drives them', { timeout: 60_000 }, () => {
    // The court of before, with a point every 5 m and a no-throw house 140 m in. The car drives in to 100 m, backs up 80 m, and drives on in to the
    // end and out. Put on the way back as it reverses, it reaches the way back's end at the junction, and is taken back onto the way in by the jump
    // there, not by the run of fixes going back: the turn round stayed, so the house's pass of the way back, put by as gone by while the car
    // reversed past it, never came up when the car drove out past it (2 of these 12 drives at 3 m/s, 3 at 4 m/s, besides the one below). Now
    // being put back there undoes the turn.
    const court = dense(5, [0, 0], [0, 300], [200, 300], [0, 300], [0, 600])
    for (const pace of [3, 4]) {
      const inAgain: Fix[] = [{ y: 0, speed: 8, heading: 0 }, ...go(0, 296, 8), ...goEast(300, 0, 100, 5), ...stand(300, 3, 100), ...goEast(300, 100, 20, pace), ...stand(300, 2, 20), ...goEast(300, 20, 200, 5)]
      const fixes = [...inAgain, ...goEast(300, 200, 0, 5), ...go(300, 588, 8)]
      const silent: string[] = []
      for (const [noise, seed] of NOISE) {
        const r = ride(routeOf(court, [stop('H', 'nothrow', [140, 292])]), fixes, { noise, seed })
        if (!r.beats.some((b) => b.i >= inAgain.length && b.x >= 139 && b.x <= 160 && b.queue.includes('H#2'))) silent.push(`noise ${noise}, seed ${seed}`)
        expect(r.beats.at(-1)!.handled, `${pace} m/s, noise ${noise}, seed ${seed}`).toEqual(new Set(['H', 'H#2']))
      }
      // (In one drive the car backs up so near the junction that the tracker is put on the street beyond it, 100 m along the way back from where
      // the turn put it: the turn round is then sure, and the stops it put by are done.)
      expect(silent, `${pace} m/s`).toEqual(['noise 5, seed 6'])
    }
  })
})

describe('a car that goes on past the junction of a court on the route', () => {
  it('comes to the no-throw houses on the street 35 and 45 m beyond the junction, for a court 30 or 45 m deep, going at 6 or 10 m/s', { timeout: 60_000 }, () => {
    // The tracker held the junction, by the cost of moving 60 to 90 m on along the route to the street beyond, until it was out of reach 55 to 60 m
    // on, and then put the driver past the houses just beyond it: they never came up in 81 of these 96 cases. Now the street beyond is taken once
    // the junction has lost touch with the phone, 25 to 35 m on.
    const never: string[] = []
    const late: string[] = []
    for (const depth of [30, 45]) {
      const route = routeOf([[0, 0], [0, 300], [depth, 300], [0, 300], [0, 600]], [stop('P', 'nothrow', [8, 335]), stop('Q', 'nothrow', [-8, 345])])
      for (const speed of [6, 10]) {
        const fixes = [{ y: 0, speed, heading: 0 }, ...go(0, 590, speed)]
        for (const [noise, seed] of [3, 5].flatMap((n) => [1, 2, 3, 4, 5, 6].map((k) => [n, k]))) {
          const r = ride(route, fixes, { noise, seed })
          for (const [id, y] of [['P', 335], ['Q', 345]] as [string, number][]) {
            const keys = r.occs.filter((o) => o.stop.id === id).map((o) => o.key)
            const up = r.beats.find((b) => b.queue.some((key) => keys.includes(key)))
            const name = `${depth} m deep, ${speed} m/s, noise ${noise}, seed ${seed}: ${id}`
            if (!up) never.push(name)
            else if (up.y > y) late.push(name)
          }
        }
      }
    }
    expect(never).toEqual([])
    // (Twice a fix still within 25 m of the junction held it a fix longer, and the house 35 m on came up as the car drew level with it, a metre past.)
    expect(late).toEqual(['30 m deep, 6 m/s, noise 5, seed 2: P', '45 m deep, 6 m/s, noise 5, seed 2: P'])
  })

  it('comes to a no-throw house on the street 25 m beyond the junction, on the banner, going at 6, 10 or 14 m/s', { timeout: 60_000 }, () => {
    // The street beyond is taken 25 to 35 m past the junction, about level with the house, as a turn round not sure yet. The house has a pass
    // level with the junction as well (the nearest place to it on the street before the court is that street's end), which is up as the car
    // comes along the street, and is held then; its pass on the street beyond comes up beside it. One or the other is the banner as the car
    // comes to the house, in every drive. (So it was before the move was a turn round not sure yet: the pass level with the junction was done
    // then, as gone by, and the other came up.)
    const silent: string[] = []
    for (const depth of [30, 45]) {
      for (const points of [[[0, 0], [0, 300], [depth, 300], [0, 300], [0, 600]], dense(10, [0, 0], [0, 300], [depth, 300], [0, 300], [0, 600])] as XY[][]) {
        const route = routeOf(points, [stop('M', 'nothrow', [-8, 325])])
        for (const speed of [6, 10, 14]) {
          const fixes = [{ y: 0, speed, heading: 0 }, ...go(0, 590, speed)]
          for (const [noise, seed] of [3, 5].flatMap((n) => [1, 2, 3, 4, 5, 6].map((k) => [n, k]))) {
            const r = ride(route, fixes, { noise, seed })
            const keys = r.occs.filter((o) => o.stop.id === 'M').map((o) => o.key)
            expect(keys, `${depth} m deep`).toHaveLength(2)
            if (!r.beats.some((b) => b.y >= 310 && b.y <= 325 && keys.includes(b.current ?? ''))) silent.push(`${depth} m deep, ${points.length} points, ${speed} m/s, noise ${noise}, seed ${seed}`)
          }
        }
      }
    }
    expect(silent).toEqual([])
  })

  it('keeps the court off the banner, and the next house up, when it backs up a few metres on the street 50 to 70 m beyond and drives on', { timeout: 60_000 }, () => {
    // The car goes by a court 45 m deep at 8 m/s and stops 50, 60 or 70 m up the street beyond, a no-throw house 6 m behind it and another 10 m
    // ahead; it backs up 8, 12 or 20 m at 3 m/s, for the house just passed or to park, and drives on. The undo of the move on past the junction
    // let in the junction itself, 40 m and more behind the car, which fits a phone heading south: the car was put back there, the court's house
    // or bundle drop came back on the banner (in 95 of these 108 drives), and the house ahead, its alert gone, was passed before it came up
    // again (in 9). Now that undo is only to a place that has not lost touch with the phone.
    const depth = 45
    const corners: XY[] = [[0, 0], [0, 300], [depth, 300], [0, 300], [0, 600]]
    const wrong: string[] = []
    for (const past of [50, 60, 70]) {
      const at = 300 + past
      const stops = [stop('N', 'nothrow', [Math.round(depth / 2), 292]), stop('B', 'bundle', [depth - 6, 308]), stop('M1', 'nothrow', [-8, at - 6]), stop('M2', 'nothrow', [-8, at + 10])]
      for (const back of [8, 12, 20]) {
        const by: Fix[] = [{ y: 0, speed: 8, heading: 0 }, ...go(0, at, 8), ...stand(at, 2)]
        // (A fix a second, as near 3 m/s as the distance allows, the phone saying 3 m/s.)
        const reverse: Fix[] = [...go(at, at - back, back / Math.round(back / 3)).map((f) => ({ ...f, speed: 3 })), ...stand(at - back, 1)]
        const fixes = [...by, ...reverse, ...go(at - back, 590, 8)]
        const on = by.length + reverse.length
        for (const [noise, seed] of [3, 5].flatMap((n) => [1, 2, 3, 4, 5, 6].map((k) => [n, k]))) {
          const r = ride(routeOf(corners, stops), fixes, { noise, seed })
          const court = r.occs.filter((o) => o.stop.id === 'N' || o.stop.id === 'B').map((o) => o.key)
          const house = r.occs.filter((o) => o.stop.id === 'M2').map((o) => o.key)
          const bad: string[] = []
          if (r.beats.some((b) => b.y >= 335 && court.includes(b.current ?? ''))) bad.push('court on the banner')
          if (!r.beats.some((b) => b.i >= on && b.y <= at + 10 && b.queue.some((key) => house.includes(key)))) bad.push('house silent')
          if (bad.length) wrong.push(`${past} m past, back ${back} m, noise ${noise}, seed ${seed}: ${bad.join(', ')}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })
})

describe('a car that misses the turn into a court on the route, and comes back to it', () => {
  // The street north, with a court `depth` m deep running east off it 300 m up, which the route drives in, round at its end, out and on north:
  // a no-throw house half way in on the right, a bundle drop 6 m short of its end on the left, and a no-throw house on the street 75 m past the
  // junction. The car misses the turn at 10 m/s and stops 35 m up the street; it backs up to the junction at 3 m/s, or turns round on the street
  // and drives back to it; then it drives the court, out, and on north.
  //
  // The tracker took the street beyond the court at once, at the first fix that had lost touch with the junction, 25 to 35 m past it, with no turn
  // round to doubt: the court's alerts that were up counted as gone by, so the house was done and never alerted as the car drove in, the bundle drop
  // was missed before the car got to it, and the furthest reached was put past the court while the car was in it: in all of these 96 drives. Now
  // that move is a turn round not sure yet, and the alerts are held until the car is put back at the junction.
  const NOISE: [number, number][] = [3, 5].flatMap((noise) => [1, 2, 3, 4, 5, 6].map((seed): [number, number] => [noise, seed]))

  /** The car's fixes, and the first of them in the court. */
  function drive(depth: number, how: 'reverse' | 'uturn'): { fixes: Fix[]; into: number } {
    const by: Fix[] = [{ y: -5, speed: 10, heading: 0 }, ...go(-5, 335, 10), ...stand(335, 2)]
    const back: Fix[] =
      how === 'reverse'
        ? [...go(335, 302, 3), ...stand(302, 1)]
        : [{ x: 2.5, y: 337.5, speed: 2, heading: 45 }, { x: 5, y: 338, speed: 2, heading: 135 }, ...go(338, 303, 5).map((f) => ({ ...f, x: 5 })), ...stand(303, 1, 5)]
    const into = by.length + back.length
    const from = how === 'reverse' ? 0 : 5
    return { fixes: [...by, ...back, ...goEast(300, from, depth - 5, 5), ...stand(300, 2, depth - 5), ...goEast(300, depth - 5, 0, 5), ...go(300, 590, 8)], into }
  }

  it('has the house in the court up as the car drives in, and misses the bundle drop only after that, for a court 30 or 45 m deep', { timeout: 60_000 }, () => {
    const wrong: string[] = []
    for (const depth of [30, 45]) {
      const corners: XY[] = [[0, 0], [0, 300], [depth, 300], [0, 300], [0, 600]]
      const stops = [stop('N', 'nothrow', [Math.round(depth / 2), 292]), stop('B', 'bundle', [depth - 6, 308]), stop('K', 'nothrow', [-8, 375])]
      for (const points of [corners, dense(10, ...corners)]) {
        for (const how of ['reverse', 'uturn'] as const) {
          const { fixes, into } = drive(depth, how)
          const out = into + fixes.slice(into).findIndex((f) => f.heading === 0)
          for (const [noise, seed] of NOISE) {
            const r = ride(routeOf(points, stops), fixes, { noise, seed })
            const name = `${depth} m deep, ${points.length} points, ${how}, noise ${noise}, seed ${seed}`
            const house = r.occs.filter((o) => o.stop.id === 'N').map((o) => o.key)
            const before = r.beats.filter((b) => b.i < into)
            const inCourt = r.beats.filter((b) => b.i >= into && b.i < out)
            const bad: string[] = []
            // (Put on the street beyond as a turn round not sure yet: the drive is one the hold is for.)
            if (!before.some((b) => b.progress.turned?.skip)) bad.push('not held')
            if (before.some((b) => house.some((key) => b.handled.has(key)))) bad.push('house done')
            if (!inCourt.some((b) => b.queue.some((key) => house.includes(key)))) bad.push('house silent')
            if (before.some((b) => b.round.missed?.includes('B'))) bad.push('bundle missed')
            if (!inCourt.some((b) => b.queue.includes('B'))) bad.push('bundle silent')
            if (inCourt.some((b) => b.progress.furthest > 300 + 2 * depth)) bad.push('furthest past the court')
            if (!r.beats.some((b) => b.i >= out && b.y >= 360 && b.y <= 375 && b.queue.includes('K'))) bad.push('street house silent')
            if (!roundCounts(r.occs, r.beats.at(-1)!.handled).finished) bad.push('unfinished')
            if (bad.length) wrong.push(`${name}: ${bad.join(', ')}`)
          }
        }
      }
    }
    // (On the 30 m court drawn with a point every 10 m, the car still coming back down the street, 10 to 15 m from the junction, can be put on the
    // court's way back there by the cost alone, a few fixes after it was put back at the junction, the way in and the way back being level and both
    // across its heading: the house is then passed, and the bundle drop too in four. With the street beyond never taken at once, 17 of these 24
    // drives lost the house, and 3 of those on the court drawn with its corners only.)
    expect(wrong).toEqual([
      '30 m deep, 67 points, reverse, noise 3, seed 4: house done, house silent, bundle silent',
      '30 m deep, 67 points, reverse, noise 5, seed 4: house done, house silent, bundle silent, furthest past the court',
      '30 m deep, 67 points, uturn, noise 3, seed 2: house done, house silent, bundle missed, bundle silent',
      '30 m deep, 67 points, uturn, noise 3, seed 6: house done, house silent',
      '30 m deep, 67 points, uturn, noise 5, seed 1: house done, house silent, bundle missed, bundle silent',
      '30 m deep, 67 points, uturn, noise 5, seed 6: house done, house silent, furthest past the court',
    ])
  })
})

describe('a car that really turns round part way down a street driven out and back', () => {
  // The street of before, with a no-throw house at 185 m on the left as well. The car turns round at 200 m and drives back out.
  const K = stop('K', 'nothrow', [-8, 185])
  const B = stop('B', 'bundle', [8, 195])
  const H = stop('H', 'nothrow', [-8, 225])
  const route = routeOf([[0, 0], [0, 300], [0, 0]], [K, B, H])
  const fixes = [{ y: 0, speed: 10, heading: 0 }, ...go(0, 200, 10), ...go(200, 0, 4)]
  const r = ride(route, fixes)
  const flip = r.beats.findIndex((b) => b.progress.turned)
  const sure = r.beats.findIndex((b, i) => i > flip && !b.progress.turned)

  it('holds the alerts that were up until the turn is sure, about 100 m along the way back, and then counts them done', () => {
    expect(flip).toBeGreaterThan(0)
    expect(sure).toBeGreaterThan(flip)
    const turned = r.beats[flip].progress.turned!
    expect(r.beats[sure].progress.along - turned.to).toBeGreaterThanOrEqual(100)
    expect(r.beats[sure].progress.along - turned.to).toBeLessThan(110)
    for (const b of r.beats.slice(flip, sure)) {
      expect([b.handled.has('K'), b.handled.has('B'), b.handled.has('H')], `${b.y}`).toEqual([false, false, false])
      expect([...b.held].sort(), `${b.y}`).toEqual(['B', 'H', 'K'])
    }
    expect(['K', 'B', 'H'].every((key) => r.beats[sure].handled.has(key))).toBe(true)
    expect(r.beats[sure].held.size).toBe(0)
  })

  it('misses the bundle drop once, when the turn is sure, and the pass of it on the way back as that is driven past', () => {
    expect(r.missed.filter((m) => m.key === 'B')).toEqual([{ key: 'B', y: r.beats[sure].y }])
    expect(r.missed.map((m) => m.key).sort()).toEqual(['B', 'B#2'])
  })

  it('alerts for the passes of the way back as the car drives it, and counts them done', () => {
    // (The house is the banner, the bundle waits behind it, counted.)
    expect(r.beats[flip].queue).toEqual(expect.arrayContaining(['K#2', 'B#2']))
    expect(r.beats[flip].current).toBe('K#2')
    expect(r.beats[flip].waiting).toBe(1)
    for (const key of ['B#2', 'K#2']) expect(r.beats.at(-1)!.handled.has(key), key).toBe(true)
  })

  it('never shows the alerts held, nor counts them as waiting, while the car drives the way back', () => {
    for (const b of r.beats.slice(flip, sure + 1)) {
      expect(['K', 'B', 'H'], `${b.y}`).not.toContain(b.current)
      expect(b.waiting, `${b.y}`).toBe(b.waitingUnheld)
    }
    expect(r.beats.slice(flip, sure).some((b) => b.current === undefined)).toBe(true)
    // Without leaving them out, the banner would show a house held, as passed, for most of the 100 m (whenever nothing of the way back is up).
    const shown = ride(route, fixes, { showHeld: true })
    expect(shown.beats.slice(flip, sure).filter((b) => b.current === 'H' || b.current === 'K').length).toBeGreaterThan(5)
  })

  it('does not miss the bundle drop when the driver taps Dropped on its alert on the way back, before the turn is sure', () => {
    // (Without the house at 185 m, whose pass of the way back would be the banner.)
    const tapped = ride(routeOf([[0, 0], [0, 300], [0, 0]], [B, H]), fixes, { tap: (b) => (b.current === 'B#2' ? 'B#2' : undefined) })
    const at = tapped.beats.findIndex((b) => b.current === 'B#2')
    expect(tapped.beats[at].progress.turned).not.toBeNull()
    expect(tapped.beats[at].held).toEqual(new Set(['B', 'H']))
    expect(tapped.missed).toEqual([])
    const last = tapped.beats.at(-1)!
    expect(last.round.dropped).toEqual(['B#2'])
    expect(last.progress.turned).toBeNull()
    expect(['B', 'H', 'B#2'].every((key) => last.handled.has(key))).toBe(true)
  })

  it('takes the turn to stand when the tracker loses the route and starts afresh, which can no longer undo it', () => {
    // At 140 m north, past B#2 and K#2, one fix 400 m off the street (claiming 40 m, so it is not set aside as a glitch), too far to say
    // anything; then back on it.
    const at = r.beats.find((b) => b.y === 140 && b.heading === 180)!.i
    const lost = ride(route, [...fixes.slice(0, at), { ...fixes[at], x: 400, accuracy: 40 }, ...fixes.slice(at + 1)])
    const b = lost.beats[at]
    expect(b.progress.lost).toBe(true)
    expect(b.progress.turned).toBeUndefined()
    expect(['K', 'B', 'H', 'K#2', 'B#2'].every((key) => b.handled.has(key))).toBe(true)
    expect(b.held.size).toBe(0)
    expect(lost.missed).toEqual([
      { key: 'B', y: 140 },
      { key: 'B#2', y: 140 },
    ])
  })

  it('takes a turn not sure yet as it stands when the driver skips on, so the bundles driven past are missed and nothing is left held', () => {
    // At 148 m north the car has passed B#2 (405 m along) and K#2 (415 m) on the way back, before the turn is sure: the driver skips to 480 m.
    const after = r.beats.find((b) => b.y === 148)!
    expect(after.progress.turned).not.toBeNull()
    const skipped = ride(route, fixes, { skip: { after: after.i, metres: 480 } })
    expect(skipped.missed.map((m) => m.key).sort()).toEqual(['B', 'B#2'])
    const last = skipped.beats.at(-1)!
    expect(['K', 'B', 'H', 'K#2', 'B#2'].every((key) => last.handled.has(key))).toBe(true)
    expect(last.round.missed?.sort()).toEqual(['B', 'B#2'])
    expect(skipped.beats.filter((b) => b.i > after.i).every((b) => b.held.size === 0)).toBe(true)
  })
})

describe('a turn round that can never be sure, as the route ends before 100 m of the way back', () => {
  // A court 150 m deep at the very end of the route, with bundle drops 60 m and 80 m in on the right. The car turns round at 90 m without
  // dropping either, drives out to where the route ends and stops there: there is not 100 m of the way back left to be sure of the turn on.
  const route = routeOf([[0, 0], [0, 150], [0, 0]], [stop('B', 'bundle', [8, 60]), stop('C', 'bundle', [8, 80])])
  const fixes = [{ y: 0, speed: 5, heading: 0 }, ...go(0, 90, 5), ...go(90, 0, 5), ...stand(0, 20)]
  const r = ride(route, fixes)
  const last = r.beats.at(-1)!

  it('takes the turn to stand once the driver is near the end, so every stop is done and the round finished', () => {
    // (The turn is still not sure as far as the tracker goes.)
    expect(last.progress.turned).not.toBeNull()
    expect([...last.handled].sort()).toEqual(['B', 'B#2', 'C', 'C#2'])
    expect(roundCounts(r.occs, last.handled).finished).toBe(true)
    expect(last.queue).toEqual([])
    expect(last.held.size).toBe(0)
  })

  it('tells of the bundle drops missed, on both legs, before the car is out of the court', () => {
    expect(r.missed.map((m) => m.key).sort()).toEqual(['B', 'B#2', 'C', 'C#2'])
    for (const m of r.missed) expect(m.y, m.key).toBeGreaterThan(0)
  })

  it('holds the alerts up at the turn until then, and puts by the pass of the way back gone by before it, so none goes as passed too soon', () => {
    const flip = r.beats.findIndex((b) => b.progress.turned)
    expect(r.beats[flip].held).toEqual(new Set(['B', 'C']))
    expect(r.beats[flip].handled.size).toBe(0)
    // C#2, 220 m along, comes up and is gone by 40 m on, before the end: put by, neither up nor done, until it is done with the rest 20 m
    // from the end.
    const ended = r.beats.findIndex((b) => b.handled.size > 0)
    expect(r.beats[ended].progress.along).toBeGreaterThanOrEqual(300 - HOLD_END_M)
    const up = r.beats.slice(flip, ended).filter((b) => b.queue.includes('C#2'))
    expect(up.length).toBeGreaterThan(0)
    const putBy = r.beats.slice(up.at(-1)!.i + 1, ended)
    expect(putBy.length).toBeGreaterThan(0)
    for (const b of putBy) expect([b.queue.includes('C#2'), b.handled.has('C#2')], `${b.y}`).toEqual([false, false])
    expect(r.beats[ended].handled.has('C#2')).toBe(true)
  })
})



