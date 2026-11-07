import { describe, expect, it } from 'vitest'
import { aheadOf, alertable, alertRadius, houseRow, isGoneBy, pickCurrent, quietReachFor, roundCounts, zoneExit } from './alerts'
import { bannerBundle, shownSide } from './bannerBlock'
import { barBundle, caughtUp, dropAllowed, missedAmong, missedNotice, restartedRound, restoreBundle, savedRound } from './bundleFlow'
import { bundleList, bundleNameOf, bundleRows, earlierPasses, firstLink, gatedOccurrences, markDropped, nextBundleId, nextInOrder, nextBundleSpeech, notNextAlerts, otherPasses, passStates, rowTotals, wentByUnseen, type BundleRow, type PassStates } from './bundles'
import { approachingOccurrences, byPosition, haversine, keepPlaced, occurrences, POSITION_MAX_ACCURACY_M, type Occurrence } from './geo'
import { OFF_MAX_ACCURACY_M, ON_ROUTE_M, startOffRoute, stepOffRoute, type OffState } from './offRoute'
import { advance, makeTrack, offRouteGap, OUTLIER_ACCURACY_M, startProgress, type Progress } from './progress'
import { continueFrom, slackFor } from './resume'
import { doneNow, heldKeys, holdGoneBy, judgedAt, reachedAt, shownQueue, stepForNext, stepTurnHold, type TurnHold } from './turnHold'
import type { Pt, RoundState, Route, Stop, StopType } from './types'
import { alertWordsStale, planVoice } from './voicePlan'

describe('the bundle drop another stop\'s banner carries', () => {
  const occ = (type: StopType, id: string) => ({ key: id, at: 0, off: 0, stop: { id, type, pathIdx: 0, lat: 0, lng: 0 } }) as Occurrence

  it('is the bundle alert up behind a house or a request', () => {
    const b = occ('bundle', 'b')
    expect(bannerBundle([occ('nothrow', 'h'), b], occ('nothrow', 'h'))).toBe(b)
    expect(bannerBundle([b, occ('request', 'r')], occ('request', 'r'))).toBe(b)
  })

  it('is none on a bundle\'s own banner, with none up, or with no banner', () => {
    const b = occ('bundle', 'b')
    expect(bannerBundle([b], b)).toBeNull()
    expect(bannerBundle([occ('nothrow', 'h')], occ('nothrow', 'h'))).toBeNull()
    expect(bannerBundle([b], undefined)).toBeNull()
  })
})

/*
 * Only the bundle next in the driver's list alerts. These drives play a car with a GPS through the real tracker, off-route machine, passes and alerts,
 * doing with each fix what Round.tsx does in its fix effect, and in its alert effect, which is run again whenever the stops done or the order change.
 */

// A place in Sydney, so the maths is checked away from the equator and the prime meridian.
const ORIGIN = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
const cos = (deg: number) => Math.cos((deg * Math.PI) / 180)

type XY = [number, number]

/** A spot `x` metres east and `y` metres north of the start. */
const spot = ([x, y]: readonly [number, number]): Pt => ({ lat: ORIGIN.lat + y / M_PER_DEG, lng: ORIGIN.lng + x / (M_PER_DEG * cos(ORIGIN.lat)) })

const radius = alertRadius(40)
/** How far from a stop an alert met by where the driver is goes: the alert distance and BACK_OFF_SLACK_M. */
const ZONE_OUT_M = 55

const stop = (id: string, type: StopType, xy: XY): Stop => ({ id, type, pathIdx: 0, label: id, qty: 10, ...spot(xy) })
const bundle = (id: string, xy: XY): Stop => stop(id, 'bundle', xy)

/** Every stretch of the route thrown on both sides. */
const routeOf = (points: XY[], stops: Stop[]): Route => ({ points: points.map(spot), sideChanges: [{ idx: 0, side: 'both' }], stops })

interface Fix {
  x: number
  y: number
  speed: number
  heading: number | null
}

/** The car's fixes, one a second, along a straight line from one spot to another at about `speed`, landing on `to`: not the one at `from`, which is the last of the leg before. */
function line(from: XY, to: XY, speed: number): Fix[] {
  const count = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / speed - 1e-9)
  const heading = ((Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI + 360) % 360
  return Array.from({ length: count }, (_, k) => ({
    x: Math.round((from[0] + ((to[0] - from[0]) * (k + 1)) / count) * 10) / 10,
    y: Math.round((from[1] + ((to[1] - from[1]) * (k + 1)) / count) * 10) / 10,
    speed,
    heading,
  }))
}

/** The legs through these spots, a fix at the first and then at `speed`. */
const legs = (speed: number, ...spots: XY[]): Fix[] => spots.slice(1).flatMap((to, i) => line(spots[i], to, speed))

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
 * A car and the round screen: what it had up, what it told the driver, and the driver's taps. `noise` is GPS error of about this many metres each
 * way, drifting from fix to fix as real error does, and a course out by about 10 degrees.
 */
function car(route: Route, startOrder?: string[], gps: { noise?: number; seed?: number } = {}) {
  const track = makeTrack(route.points)
  const routeEnd = track.cum[track.cum.length - 1]
  const allOccs = occurrences(route)
  const occs = alertable(route, allOccs, quietReachFor(40))
  const names = new Map(bundleList(occs, { handledStopIds: [] }, 0).map((b) => [b.key, b.name]))
  let order = startOrder
  let progress: Progress | null = null
  let machine: OffState = startOffRoute
  let reached = false
  let reachAlong = 0
  let reachRun: Pt | null = null
  let lastStepAt: Pt | null = null
  let restartFrom: number | null = null
  let lastJudged: { reach: number; next: string | null; at: Pt } | null = null
  let round: RoundState = { handledStopIds: [] }
  let queue: Occurrence[] = []
  let turnHold: TurnHold | null = null
  let time = 0
  let phone: Pt | null = null
  let lastDropAt = -Infinity
  const seen = new Set<string>()
  const announced = new Set<string>()
  let held = new Set<string>()
  const beforeDrop = new Map<string, PassStates>()
  /** Every alert that came up, in turn (a beep each), with where the car was and whether it came up by place. */
  const beeps: { key: string; y: number; placed: boolean }[] = []
  const toasts: string[] = []
  const said: string[] = []
  let sheetsClosed = 0
  let voice = true
  let y = 0
  const rand = random(gps.seed ?? 1)
  let err = [0, 0]

  const handledNow = () => new Set(round.handledStopIds)
  const forget = (key: string) => {
    seen.delete(key)
    announced.delete(key)
    held.delete(key)
  }

  /** The alert effect. True when it changed the stops done, which runs it again as the round comes back. */
  const alerts = (p: Progress): boolean => {
    const was = round
    const handled = handledNow()
    const driverAt = p.along
    const pos = p.at
    const nextAtStart = nextBundleId(occs, round, order)
    const notNext = notNextAlerts(queue, nextAtStart)
    for (const o of notNext) forget(o.key)
    const up = notNext.length ? queue.filter((o) => !notNext.includes(o)) : queue
    queue = up
    const step = stepForNext(stepTurnHold(turnHold, p, up, routeEnd), nextAtStart)
    for (const o of step.release) forget(o.key)
    const goodFix = p.accuracy <= OUTLIER_ACCURACY_M
    const left = up.flatMap((o) => {
      const exit = zoneExit(o, judgedAt(o, driverAt, step.hold), radius, p.accuracy <= POSITION_MAX_ACCURACY_M ? pos : undefined)
      if (exit === 'passed' && !goodFix && o.stop.type === 'bundle' && !byPosition(o, radius)) return []
      return exit ? [{ o, exit }] : []
    })
    const gone = new Set(left.map((l) => l.o.key))
    const onRoute = machine.phase === 'on'
    const backOn = machine.phase === 'rejoined'
    const reallyPassed = (o: Occurrence) => onRoute || byPosition(o, radius) || (backOn && o.stop.type === 'bundle')
    let goneBy: Occurrence[] = []
    if (left.length) {
      queue = queue.filter((o) => !gone.has(o.key))
      for (const l of left) if (l.exit === 'back' || (l.exit === 'passed' && !reallyPassed(l.o))) forget(l.o.key)
      goneBy = left.filter((l) => l.exit === 'passed' && !handled.has(l.o.key) && reallyPassed(l.o)).map((l) => l.o)
    }
    const put = holdGoneBy(step.hold, goneBy, radius)
    turnHold = put.hold
    const settled = doneNow(put.now, step.settle, handled, onRoute || backOn, radius)
    let done: ReadonlySet<string> = handled
    if (settled.done.length) {
      const keys = settled.done.map((o) => o.key)
      done = new Set([...handled, ...keys, ...earlierPasses(occs, keys, handled)])
      round = savedRound(round, [...done], round.furthest, round.startM ?? 0, settled.missed)
      if (settled.missed.length) toasts.push(missedNotice(settled.missed.map((key) => names.get(key) ?? 'a bundle drop')))
    }
    if (p.lost && p.time === null) return round !== was
    const reach = reachedAt(p, put.hold)
    const judged = reached && machine.phase === 'on' && machine.near === 0 && !put.hold
    const from = restartFrom
    let unseen: string[] = []
    if (from !== null && !p.lost && goodFix) {
      restartFrom = null
      const ahead = p.along - from
      if (ahead > 0 && ahead < 300) {
        const caught = caughtUp(occs, done, p.along, radius)
        if (caught.length) {
          done = new Set([...done, ...caught])
          round = savedRound(round, [...done], round.furthest, round.startM ?? 0)
        }
      }
    } else if (judged && goodFix && lastJudged && Math.abs(reach - lastJudged.reach) - haversine(lastJudged.at, pos) <= 100) {
      unseen = wentByUnseen(occs, round, order, lastJudged.reach, reach, pos, radius, seen, firstLink(occs, lastJudged.next, settled.missed))
    }
    if (unseen.length) {
      done = new Set([...done, ...unseen, ...earlierPasses(occs, unseen, done)])
      round = savedRound(round, [...done], round.furthest, round.startM ?? 0, unseen)
      toasts.push(missedNotice([...settled.missed, ...unseen].map((key) => names.get(key) ?? 'a bundle drop')))
    }
    const next = nextBundleId(occs, round, order)
    lastJudged = !judged ? null : goodFix ? { reach, next, at: pos } : lastJudged
    const gated = gatedOccurrences(occs, next, done, reach, radius)
    const fresh = approachingOccurrences(driverAt, pos, gated, done, radius, p.accuracy).filter((o) => !seen.has(o.key))
    if (fresh.length) {
      for (const o of fresh) {
        seen.add(o.key)
        beeps.push({ key: o.key, y, placed: o.placed === true })
      }
      queue = [...queue, ...fresh]
      if (fresh.some((o) => o.stop.type === 'bundle')) sheetsClosed++
    }
    if (voice && (fresh.length || held.size)) {
      const plan = planVoice({
        route,
        allOccs,
        occs,
        handled: done,
        radius,
        queue: up.filter((o) => !gone.has(o.key)),
        fresh,
        announced,
        held,
        driver: { idx: p.idx, along: p.along, driven: p.furthest, pos, heading: null },
      })
      for (const key of plan.announce) announced.add(key)
      held = new Set(plan.held)
      if (plan.text && !alertWordsStale(plan.announce, gated, () => progress, radius)()) said.push(plan.text)
    }
    return round !== was
  }
  /** The effect runs again when it changed the stops done, as the round it saved comes back (a few times at most). */
  const run = () => {
    if (!progress) return
    for (let k = 0; k < 3 && alerts(progress); k++);
  }

  /** The fix effect's `weighOff`: reaching the route, then the off-route machine. */
  const weigh = (now: Progress, speed: number, forward: boolean) => {
    if (!reached) {
      const on = !now.lost && now.gap <= ON_ROUTE_M && now.accuracy <= OFF_MAX_ACCURACY_M
      if (!on) {
        reachRun = null
        return
      }
      reachRun ??= now.at
      if (Math.abs(now.along - reachAlong) <= 100 || haversine(reachRun, now.at) >= 200) reached = true
      else return
    }
    const done = handledNow()
    if (occs.some((o) => byPosition(o, radius) && !done.has(o.key) && haversine(now.at, o.stop) <= o.off + radius[o.stop.type] + 60)) return
    const before = machine
    const stepped = stepOffRoute(machine, { time: now.time, at: now.at, accuracy: now.accuracy, speed, gap: offRouteGap(now), along: now.along, furthest: now.furthest, lost: now.lost, doubt: now.doubt !== null })
    machine = stepped.state
    if (stepped.event === 'went-off') {
      const left = machine.left
      const gone: Occurrence[] = []
      for (const o of queue) {
        if (left && !byPosition(o, radius) && o.at < left.along - slackFor(radius)) {
          gone.push(o)
          continue
        }
        forget(o.key)
      }
      queue = []
      if (gone.length) {
        const keys = gone.map((o) => o.key)
        round = savedRound(round, [...done, ...keys, ...earlierPasses(occs, keys, done)], round.furthest, round.startM ?? 0, missedAmong(gone))
        const bundles = gone.filter((o) => o.stop.type === 'bundle')
        if (bundles.length) toasts.push(missedNotice(bundles.map((o) => bundleNameOf(o.stop))))
      }
    }
    if (stepped.event === 'back' && before.left) restartFrom = forward ? before.left.along : null
  }

  const fix = (f: Fix) => {
    y = f.y
    time += 1000
    err = err.map((e) => 0.5 * e + Math.sqrt(0.75) * gaussian(rand) * (gps.noise ?? 0))
    phone = spot([f.x + err[0], f.y + err[1]])
    const course = f.speed >= 1.5 && f.heading !== null ? (f.heading + (gps.noise ? gaussian(rand) * 10 : 0) + 360) % 360 : null
    const before: Progress | null = progress
    const now = advance(track, before, { ...phone, accuracy: 8, time, speed: f.speed }, course)
    if (!now || now === before) return
    progress = now
    const bearing = track.bearings[now.idx] ?? null
    const forward = course === null || bearing === null || Math.abs(((course - bearing + 540) % 360) - 180) <= 110
    const stepped = lastStepAt
    const moving = f.speed >= 1.5 || !stepped || haversine(stepped, now.at) >= 5
    if (now.time !== before?.time && moving) {
      lastStepAt = now.at
      if (roundCounts(occs, handledNow()).finished || now.furthest >= routeEnd - 50) machine = startOffRoute
      else weigh(now, f.speed, forward)
    }
    run()
  }

  /** The screen's restartAt: a start, or a skip while driving, to `metres` along the route. */
  const restart = (metres: number, keepBundles = false) => {
    turnHold = null
    seen.clear()
    announced.clear()
    held.clear()
    queue = []
    const skippedBack = progress !== null && metres < progress.along
    progress = startProgress(track, metres)
    machine = startOffRoute
    reached = false
    reachAlong = metres
    reachRun = null
    lastStepAt = null
    restartFrom = metres > 0 && !skippedBack ? metres : null
    lastJudged = null
    round = restartedRound(round, occs, metres, slackFor(radius), false, keepBundles)
    run()
  }

  /** The screen's dropBundle, for the pass with this key. */
  const dropBundle = (key: string) => {
    const others = otherPasses(occs, key)
    beforeDrop.set(key, passStates(round, [key, ...others]))
    round = markDropped(round, key, others)
    const settled = new Set([key, ...others])
    queue = queue.filter((o) => !settled.has(o.key))
  }

  const rows = (): BundleRow[] => bundleRows(occs, round, order, phone)
  /** The banner: the alert it shows, as `pickCurrent` has it from what is up. */
  const banner = (): Occurrence | undefined => {
    if (!progress) return undefined
    const p = progress
    return pickCurrent(shownQueue(queue, heldKeys(turnHold), p.furthest, p.along, p.at, radius), p.furthest, p.along, p.at, radius)
  }

  return {
    occs,
    allOccs,
    beeps,
    toasts,
    said,
    drive: (fixes: Fix[]) => fixes.forEach(fix),
    /** The driver taps Dropped on the banner, as `dropFromAlert` does. The tone and its seconds are left out. */
    tap() {
      const o = banner()
      if (!o || o.stop.type !== 'bundle') throw new Error('No Dropped button is up')
      if (!dropAllowed(lastDropAt, time)) return
      lastDropAt = time
      dropBundle(o.key)
      const next = nextInOrder(rows())
      if (voice && next) said.push(nextBundleSpeech(next))
      run()
    },
    /** Mark dropped in the list, on the row of this stop. */
    mark(id: string) {
      const key = rows().find((r) => r.id === id)?.markKey
      if (!key) throw new Error(`${id} has no Mark dropped`)
      dropBundle(key)
      run()
    },
    /** Undo, in the bar or the list, on the drop of this stop. */
    undo(id: string) {
      const key = rows().find((r) => r.id === id)?.undoKey
      if (!key) throw new Error(`${id} has no Undo`)
      const before = beforeDrop.get(key)
      beforeDrop.delete(key)
      round = restoreBundle(round, key, before ?? false)
      for (const k of before?.keys() ?? [key]) forget(k)
      run()
    },
    /** A new order from the Bundles list's Reorder. */
    reorder(next: string[]) {
      order = next
      run()
    },
    /** The voice is turned on with an alert up, as `changeVoice` does. */
    voiceOn() {
      voice = true
      const p = progress as Progress
      const showing = queue.filter((o) => !isGoneBy(o, p.furthest, p.along, p.at, radius))
      const plan = planVoice({
        route,
        allOccs,
        occs,
        handled: handledNow(),
        radius,
        queue: showing,
        fresh: showing,
        announced: new Set(),
        held: new Set(),
        driver: { idx: p.idx, along: p.along, driven: p.furthest, pos: p.at, heading: null },
      })
      held = new Set(plan.held)
      if (plan.text) {
        for (const key of plan.announce) announced.add(key)
        if (!alertWordsStale(plan.announce, keepPlaced(occs, showing), () => progress, radius)()) said.push(plan.text)
      }
    },
    voiceOff() {
      voice = false
    },
    restart,
    /** Continue Round, as `begin(false)` does: on from where the round had got to, with nothing done or swept. */
    carryOn() {
      const at = continueFrom(round, allOccs, handledNow())
      reachAlong = at
      progress = startProgress(track, at)
      announced.clear()
      held.clear()
    },
    rows,
    banner,
    /** The next bundle in the list, as the bar has it. */
    next: () => nextInOrder(rows())?.id ?? null,
    bar: () => barBundle(rows()),
    up: () => queue.map((o) => o.key),
    queued: () => queue,
    round: () => round,
    done: () => [...handledNow()].sort(),
    missed: () => [...(round.missed ?? [])].sort(),
    dropped: () => [...(round.dropped ?? [])].sort(),
    status: () => Object.fromEntries(rows().map((r) => [r.id, r.status])),
    phase: () => machine.phase,
    progress: () => progress as Progress,
    finished: () => roundCounts(occs, handledNow()).finished,
    sheetsClosed: () => sheetsClosed,
    /** How far the banner says its stop is, as the screen works it out. */
    ahead(o: Occurrence) {
      const p = progress as Progress
      return aheadOf(o, p.along, p.at, radius)
    },
  }
}

/*
 * The round the driver's list is against: up a street and back down one 40 m east of it. Bundle drops A, B and C are at 200 m, 400 m and 600 m up the
 * first street, on its east side, 32 m from the second: too far for it to pass them (see `PASS_MIN_M`), but close enough for the car to come within the
 * alert distance of them on the way back.
 */
const A = bundle('A', [8, 200])
const B = bundle('B', [8, 400])
const C = bundle('C', [8, 600])
const LOOP: XY[] = [[0, 0], [0, 900], [40, 900], [40, 0]]
const up = (to: number, from = 0) => legs(10, [0, from], [0, to])
const round = (to: number) => legs(10, [0, 700], [0, 900], [40, 900], [40, to])

describe('the bundles in the order of the list, not the order of the route', () => {
  /** The car up the first street to 570 m, with C up, having gone by A and B. */
  const started = () => {
    const c = car(routeOf(LOOP, [A, B, C]), ['C', 'A', 'B'])
    c.drive(up(570))
    return c
  }

  it('has the route reach them as A, B, C and the list say C first', () => {
    const c = started()
    expect(c.occs.map((o) => [o.key, Math.round(o.at)])).toEqual([['A', 200], ['B', 400], ['C', 600]])
    expect(c.rows().map((r) => [r.id, r.status])).toEqual([['C', 'next'], ['A', 'todo'], ['B', 'todo']])
  })

  it('passes a bundle that is not next with no alert, no miss and nothing done: it stays to do', () => {
    const c = car(routeOf(LOOP, [A, B, C]), ['C', 'A', 'B'])
    for (const f of up(520)) {
      c.drive([f])
      expect([f.y, c.up()]).toEqual([f.y, []])
    }
    expect(c.beeps).toEqual([])
    expect(c.said).toEqual([])
    expect(c.toasts).toEqual([])
    expect(c.done()).toEqual([])
    expect(c.missed()).toEqual([])
    expect(c.status()).toEqual({ C: 'next', A: 'todo', B: 'todo' })
    expect(c.bar()?.name).toBe('C')
    expect(c.bar()?.left).toBe(3)
    expect(rowTotals(c.rows()).missed).toBe(0)
  })

  it('does not close a sheet for a bundle that is not next, and does for the next', () => {
    const c = car(routeOf(LOOP, [A, B, C]), ['C', 'A', 'B'])
    c.drive(up(520))
    expect(c.sheetsClosed()).toBe(0)
    c.drive(up(570, 520))
    expect(c.sheetsClosed()).toBe(1)
  })

  it('alerts for the next as it comes up along the route, with its words and a Dropped button', () => {
    const c = started()
    expect(c.beeps).toEqual([{ key: 'C', y: 560, placed: false }])
    expect(c.said).toEqual(['Bundle drop, C, 10 papers.'])
    expect(c.banner()?.key).toBe('C')
  })

  it('makes the following one next when the next is dropped: a bundle behind the car is next, and stays quiet while the car is away from it', () => {
    const c = started()
    c.tap()
    expect(c.dropped()).toEqual(['C'])
    expect(c.next()).toBe('A')
    expect(c.up()).toEqual([])
    expect(c.said.at(-1)).toMatch(/^Next bundle, A, /)
    c.drive(up(880, 570))
    expect(c.beeps.map((b) => b.key)).toEqual(['C'])
    expect(c.done()).toEqual(['C'])
  })

  it('alerts by place for one already passed, once the car comes back within the alert distance, and goes by B on the way without a sound', () => {
    const c = started()
    c.tap()
    c.drive([...up(700, 570), ...round(226)])
    expect(c.up()).toEqual([])
    c.drive(legs(10, [40, 226], [40, 220]))
    const distance = haversine(spot([40, 220]), A)
    expect(distance).toBeLessThanOrEqual(40)
    expect(c.up()).toEqual(['A'])
    expect(c.beeps.at(-1)).toEqual({ key: 'A', y: 220, placed: true })
    expect(c.beeps.map((b) => b.key)).toEqual(['C', 'A'])
    // The words are said, though the stop is behind the car along the route. The banner has it, with its distance in a straight line and a Dropped button.
    expect(c.said.at(-1)).toBe('Bundle drop, A, 10 papers.')
    const shown = c.banner()
    expect(shown?.key).toBe('A')
    expect(c.ahead(shown as Occurrence)).toBeCloseTo(distance, 3)
    expect(isGoneBy(shown as Occurrence, c.progress().furthest, c.progress().along, c.progress().at, radius)).toBe(false)
    c.tap()
    expect(c.dropped()).toEqual(['A', 'C'])
    expect(c.next()).toBe('B')
    expect(c.missed()).toEqual([])
  })

  it('tells which side a bundle met by place is on as the car comes up to it, not as the route passed it', () => {
    const c = started()
    c.tap()
    c.drive([...up(700, 570), ...round(226), ...legs(10, [40, 226], [40, 220])])
    const o = c.banner() as Occurrence
    // Going south, a stop to the west is on the right: the route passed it on its right going north too, so the heading is what is judged on.
    expect(shownSide(routeOf(LOOP, [A, B, C]), c.allOccs, o, radius, 90, spot([40, 220]))).toBe('right')
    expect(shownSide(routeOf(LOOP, [A, B, C]), c.allOccs, o, radius, 270, spot([40, 220]))).toBe('left')
  })

  it('has one met by place missed once it is driven out of its zone, with the alert up until then and a toast, and the next on the list next', () => {
    const c = started()
    c.tap()
    c.drive([...up(700, 570), ...round(226), ...legs(10, [40, 226], [40, 170])])
    expect(haversine(spot([40, 170]), A)).toBeLessThan(ZONE_OUT_M)
    expect(c.up()).toEqual(['A'])
    expect(c.missed()).toEqual([])
    c.drive(legs(10, [40, 170], [40, 150]))
    expect(haversine(spot([40, 150]), A)).toBeGreaterThan(ZONE_OUT_M)
    expect(c.up()).toEqual([])
    expect(c.missed()).toEqual(['A'])
    expect(c.toasts).toEqual(['Missed bundle: A'])
    expect(c.status()).toEqual({ C: 'dropped', A: 'missed', B: 'next' })
    // It can still be marked dropped from the list.
    c.mark('A')
    expect(c.status()).toEqual({ C: 'dropped', A: 'dropped', B: 'next' })
  })

  it('leaves the alert down if the car turns away before the alert distance, and the bundle to do', () => {
    const c = started()
    c.tap()
    // Up to 45 m from A along the street 40 m east, and no nearer.
    c.drive([...up(700, 570), ...round(232), ...legs(10, [40, 232], [40, 240])])
    expect(haversine(spot([40, 232]), A)).toBeGreaterThan(40)
    expect(c.beeps.map((b) => b.key)).toEqual(['C'])
    expect(c.status().A).toBe('next')
  })
})

describe('with no order set the list is route order, so the same rule applies', () => {
  it('alerts for the first to do, and for the one beside it only once it is next', () => {
    const near = bundle('N', [8, 230])
    const c = car(routeOf(LOOP, [A, near, C]))
    c.drive(up(195))
    expect(c.status()).toEqual({ A: 'next', N: 'todo', C: 'todo' })
    expect(c.up()).toEqual(['A'])
    expect(c.beeps.map((b) => b.key)).toEqual(['A'])
    // Driven past with no tap: A is missed, a toast says so, and N, now next and 11 m behind the car, alerts at once along the route.
    c.drive(up(241, 195))
    expect(c.missed()).toEqual(['A'])
    expect(c.toasts).toEqual(['Missed bundle: A'])
    expect(c.status()).toEqual({ A: 'missed', N: 'next', C: 'todo' })
    expect(c.up()).toEqual(['N'])
    expect(c.beeps.at(-1)).toEqual({ key: 'N', y: 241, placed: false })
  })

  it('misses the first still to do when it went by unseen, tells the driver, and moves on down the list', () => {
    const c = car(routeOf(LOOP, [A, B]))
    // The phone has no fix from 150 m to 300 m, so A never alerted.
    c.drive([...up(150), ...up(420, 300)])
    expect(c.beeps.map((b) => b.key)).toEqual(['B'])
    expect(c.missed()).toEqual(['A'])
    expect(c.toasts).toEqual(['Missed bundle: A'])
    expect(c.status()).toEqual({ A: 'missed', B: 'next' })
    expect(c.rows()[0].markKey).toBe('A')
  })
})

describe('a street driven twice is one delivery, whichever pass it is next on', () => {
  // A street 500 m north and back: X at 200 m on the way out and 800 m on the way back, W at 300 m and 700 m.
  const X = bundle('X', [8, 200])
  const W = bundle('W', [8, 300])
  const OUT_BACK: XY[] = [[0, 0], [0, 500], [0, 0]]
  const out = (to: number, from = 0) => legs(10, [0, from], [0, to])
  const back = (to: number, from = 500) => legs(10, [0, from], [0, to])

  it('has each stop on both passes', () => {
    const c = car(routeOf(OUT_BACK, [X, W]))
    expect(c.occs.map((o) => [o.key, Math.round(o.at)])).toEqual([['X', 200], ['W', 300], ['W#2', 700], ['X#2', 800]])
  })

  describe('next on the second pass only', () => {
    const toSecondPass = () => {
      const c = car(routeOf(OUT_BACK, [X, W]), ['W', 'X'])
      c.drive(out(280))
      c.tap()
      return c
    }

    it('passes the first pass with no alert, and a drop of the next settles only its own passes', () => {
      const c = toSecondPass()
      expect(c.beeps.map((b) => b.key)).toEqual(['W'])
      expect(c.done()).toEqual(['W', 'W#2'])
      expect(c.next()).toBe('X')
      expect(c.up()).toEqual([])
    })

    it('alerts along the route on the pass still ahead, not by place, though the first pass is behind the car', () => {
      const c = toSecondPass()
      c.drive([...out(500, 280), ...back(245)])
      expect(c.up()).toEqual([])
      c.drive(back(235, 245))
      expect(c.up()).toEqual(['X#2'])
      expect(c.beeps.at(-1)).toEqual({ key: 'X#2', y: 235, placed: false })
    })

    it('drops the stop there, the pass passed by settled with it', () => {
      const c = toSecondPass()
      c.drive([...out(500, 280), ...back(235)])
      c.tap()
      expect(c.status()).toEqual({ W: 'dropped', X: 'dropped' })
      expect(c.done()).toEqual(['W', 'W#2', 'X', 'X#2'])
    })

    it('misses it once that pass goes by without a drop, counts the first pass gone by too, and so holds up nothing behind it', () => {
      const third = bundle('Z', [8, 100])
      const c = car(routeOf(OUT_BACK, [X, W, third]), ['W', 'X', 'Z'])
      c.drive(out(280))
      c.tap()
      c.drive([...out(500, 280), ...back(150)])
      expect(c.done().filter((key) => key.startsWith('X'))).toEqual(['X', 'X#2'])
      // The pass that went by says what became of the stop: one miss, one toast, and the first pass is neither.
      expect(c.missed()).toEqual(['X#2'])
      expect(c.toasts).toEqual(['Missed bundle: X'])
      expect(c.status()).toEqual({ W: 'dropped', X: 'missed', Z: 'next' })
      expect(rowTotals(c.rows()).missed).toBe(1)
      c.drive(back(130, 150))
      expect(c.up()).toEqual(['Z#2'])
    })

    it('can still mark it dropped once it is missed, and Undo puts it back as it was', () => {
      const c = toSecondPass()
      c.drive([...out(500, 280), ...back(150)])
      c.mark('X')
      expect(c.status()).toEqual({ W: 'dropped', X: 'dropped' })
      c.undo('X')
      expect(c.status()).toEqual({ W: 'dropped', X: 'missed' })
      expect(c.done()).toEqual(['W', 'W#2', 'X', 'X#2'])
    })
  })

  describe('next on the first pass, not dropped, then the second', () => {
    const passed = () => {
      const c = car(routeOf(OUT_BACK, [X, W]), ['X', 'W'])
      c.drive(out(260))
      return c
    }

    it('keeps it next with the second pass to come, holding the rest back, though the first pass went by', () => {
      const c = passed()
      expect(c.missed()).toEqual(['X'])
      expect(c.status()).toEqual({ X: 'next', W: 'todo' })
      c.drive(out(340, 260))
      expect(c.beeps.map((b) => b.key)).toEqual(['X'])
      expect(c.done()).toEqual(['X'])
    })

    it('comes up on the second pass, and a drop there clears the miss', () => {
      const c = passed()
      c.drive([...out(500, 260), ...back(235)])
      expect(c.beeps.map((b) => b.key)).toEqual(['X', 'X#2'])
      expect(c.up()).toEqual(['X#2'])
      c.tap()
      expect(c.status()).toEqual({ X: 'dropped', W: 'next' })
      expect(c.missed()).toEqual([])
    })

    it('is missed for good when the second pass goes by too, and W, with both of its passes to do behind the car, is met by place at its last', () => {
      const c = passed()
      c.drive([...out(500, 260), ...back(150)])
      expect(c.status()).toEqual({ X: 'missed', W: 'next' })
      // Both its passes are behind the car, so the last one alerts when the car goes back near the stop, not the first.
      c.drive(legs(10, [0, 150], [0, 0]))
      const atStop = legs(10, [0, 0], [15, 0], [15, 280])
      c.drive(atStop)
      expect(c.up()).toEqual(['W#2'])
      expect(c.queued()[0].placed).toBe(true)
      c.drive(legs(10, [15, 280], [15, 200]))
      expect(c.missed()).toEqual(['W#2', 'X', 'X#2'])
      expect(c.done()).toEqual(['W', 'W#2', 'X', 'X#2'])
      expect(c.status().W).toBe('missed')
    })
  })
})

describe('when the next bundle changes, the rule follows at once', () => {
  const near = bundle('N', [8, 230])

  describe('a reorder while an alert is up', () => {
    const upFor = () => {
      const c = car(routeOf(LOOP, [A, near]), ['A', 'N'])
      c.drive(up(170))
      return c
    }

    it('takes the alert away without a word: not done, not missed', () => {
      const c = upFor()
      expect(c.up()).toEqual(['A'])
      c.reorder(['N', 'A'])
      expect(c.up()).toEqual([])
      expect(c.done()).toEqual([])
      expect(c.missed()).toEqual([])
      expect(c.toasts).toEqual([])
      expect(c.status()).toEqual({ N: 'next', A: 'todo' })
    })

    it('goes by the bundle taken off the top with no alert or miss, and alerts for the new next', () => {
      const c = upFor()
      c.reorder(['N', 'A'])
      c.drive(up(195, 170))
      expect(c.beeps.map((b) => b.key)).toEqual(['A', 'N'])
      expect(c.banner()?.key).toBe('N')
      c.drive(up(205, 195))
      expect(c.banner()?.key).toBe('N')
      expect(c.missed()).toEqual([])
    })

    it('never counts it as passed, however far on the car is when the order changes', () => {
      const c = upFor()
      c.drive(up(235, 170))
      expect(c.up()).toEqual(['A'])
      c.reorder(['N', 'A'])
      expect(c.up()).toEqual(['N'])
      c.drive(up(245, 235))
      expect(c.up()).toEqual(['N'])
      expect(c.missed()).toEqual([])
      expect(c.done()).toEqual([])
    })

    it('lets it alert again, with a new beep and its words, once it is next again', () => {
      const c = upFor()
      c.reorder(['N', 'A'])
      c.reorder(['A', 'N'])
      expect(c.up()).toEqual(['A'])
      expect(c.beeps.map((b) => b.key)).toEqual(['A', 'A'])
      expect(c.said).toEqual(['Bundle drop, A, 10 papers.', 'Bundle drop, A, 10 papers.'])
    })

    it('alerts straight away for a new next the car is already beside', () => {
      const c = upFor()
      c.drive(up(200, 170))
      expect(c.up()).toEqual(['A'])
      c.reorder(['N', 'A'])
      expect(c.up()).toEqual(['N'])
      expect(c.beeps.at(-1)).toEqual({ key: 'N', y: 200, placed: false })
    })
  })

  describe('a next bundle right beside the car when it becomes next', () => {
    it('alerts at once along the route when the stop is still in its alert window', () => {
      const c = car(routeOf(LOOP, [A, near]), ['A', 'N'])
      c.drive(up(205))
      c.tap()
      expect(c.next()).toBe('N')
      expect(c.up()).toEqual(['N'])
      expect(c.beeps.at(-1)).toEqual({ key: 'N', y: 205, placed: false })
    })

    it('alerts at once by place when it is just behind the car, past where it would alert along the route but within the alert distance', () => {
      const c = car(routeOf(LOOP, [near, A]), ['N', 'A'])
      c.drive(up(230))
      expect(c.up()).toEqual(['N'])
      c.tap()
      expect(c.next()).toBe('A')
      expect(c.up()).toEqual(['A'])
      expect(c.beeps.at(-1)).toEqual({ key: 'A', y: 230, placed: true })
      // Not gone by along the route at once, where it would be missed: the alert stays until the car is out of the stop's zone, at 55 m.
      c.drive(up(250, 230))
      expect(c.up()).toEqual(['A'])
      expect(c.missed()).toEqual([])
      c.drive(up(260, 250))
      expect(c.missed()).toEqual(['A'])
    })

    it('alerts by place at any alert distance the stop falls behind the window of', () => {
      // At 60 m a stop can alert along the route no more than 20 m behind the car: one 30 m behind is in its zone, and must not fall between the two.
      const wide = alertRadius(60)
      const passes = occurrences(routeOf(LOOP, [A])).map((o) => ({ ...o, at: 200 }))
      const gated = gatedOccurrences(passes, 'A', new Set(), 230, wide)
      expect(gated[0].placed).toBe(true)
      expect(approachingOccurrences(230, spot([0, 230]), gated, new Set(), wide, 8).map((o) => o.key)).toEqual(['A'])
      expect(approachingOccurrences(230, spot([0, 230]), passes, new Set(), wide, 8)).toEqual([])
    })
  })

  describe('Undo of a drop', () => {
    it('makes the bundle next again: the alert of the one after it goes without a word, and it alerts again if the car is still at it', () => {
      const c = car(routeOf(LOOP, [A, near]), ['A', 'N'])
      c.drive(up(205))
      c.tap()
      expect(c.up()).toEqual(['N'])
      c.undo('A')
      expect(c.up()).toEqual(['A'])
      expect(c.beeps.map((b) => b.key)).toEqual(['A', 'N', 'A'])
      expect(c.status()).toEqual({ A: 'next', N: 'todo' })
      expect(c.done()).toEqual([])
      expect(c.missed()).toEqual([])
    })

    it('alerts by place when the car has gone on past where it would alert along the route', () => {
      const c = car(routeOf(LOOP, [A, near]), ['A', 'N'])
      c.drive(up(190))
      c.tap()
      c.drive(up(225, 190))
      expect(c.up()).toEqual(['N'])
      c.undo('A')
      expect(c.up()).toEqual(['A'])
      expect(c.beeps.at(-1)).toEqual({ key: 'A', y: 225, placed: true })
    })

    it('leaves the bundle next and quiet when the car has left it, holding the rest back until it is dealt with', () => {
      const c = car(routeOf(LOOP, [A, near, C]), ['A', 'N', 'C'])
      c.drive(up(190))
      c.tap()
      c.mark('N')
      c.drive(up(260, 190))
      c.undo('A')
      expect(c.up()).toEqual([])
      expect(c.next()).toBe('A')
      c.drive(up(640, 260))
      expect(c.beeps.map((b) => b.key)).toEqual(['A'])
      expect(c.status()).toEqual({ A: 'next', N: 'dropped', C: 'todo' })
    })

    it('does not bring up one that is not next: an undone drop of a later bundle stays to do', () => {
      const c = car(routeOf(LOOP, [A, near, C]), ['C', 'A', 'N'])
      c.drive(up(190))
      c.mark('A')
      expect(c.next()).toBe('C')
      c.undo('A')
      expect(c.up()).toEqual([])
      expect(c.status()).toEqual({ C: 'next', A: 'todo', N: 'todo' })
    })
  })

  describe('Mark dropped from the list', () => {
    it('on the next: the alert up for it goes, and the one after it is next', () => {
      const c = car(routeOf(LOOP, [A, near, C]), ['A', 'N', 'C'])
      c.drive(up(170))
      c.mark('A')
      expect(c.up()).toEqual([])
      c.drive(up(200, 170))
      expect(c.up()).toEqual(['N'])
    })

    it('on one further down: nothing changes for the next, and it never alerts', () => {
      const c = car(routeOf(LOOP, [A, near, C]), ['C', 'N', 'A'])
      c.drive(up(100))
      c.mark('N')
      c.drive(up(240, 100))
      expect(c.beeps).toEqual([])
      expect(c.status()).toEqual({ C: 'next', N: 'dropped', A: 'todo' })
    })

    it('on the next when it is a long way off: the bundle after it can alert at once', () => {
      const c = car(routeOf(LOOP, [A, C]), ['C', 'A'])
      c.drive(up(190))
      expect(c.up()).toEqual([])
      c.mark('C')
      expect(c.up()).toEqual(['A'])
      expect(c.beeps).toEqual([{ key: 'A', y: 190, placed: false }])
    })
  })
})

describe('a bundle away from the route, which is met by where the driver is already', () => {
  // D is 75 m east of the street: too far to alert along it at this alert distance.
  const D = bundle('D', [75, 300])
  const STREET: XY[] = [[0, 0], [0, 800]]
  /** Up the street to 280 m, over to 25 m from D, and back to the street. */
  const visit = legs(10, [0, 0], [0, 280], [50, 300])
  const away = legs(10, [50, 300], [0, 330], [0, 400])

  it('is met that way, with no flag of its own', () => {
    const c = car(routeOf(STREET, [D]))
    expect(byPosition(c.occs[0], radius)).toBe(true)
    c.drive(visit)
    expect(c.up()).toEqual(['D'])
    expect(c.queued()[0].placed).toBeUndefined()
    expect(c.beeps.map((b) => [b.key, b.placed])).toEqual([['D', false]])
  })

  it('stays quiet when it is not next, and is not done or missed by the visit', () => {
    const c = car(routeOf(STREET, [C, D]), ['C', 'D'])
    c.drive([...visit, ...away])
    expect(c.beeps).toEqual([])
    expect(c.status()).toEqual({ C: 'next', D: 'todo' })
    expect(c.done()).toEqual([])
  })

  it('leaves the queue without a word on a reorder, like any other', () => {
    const c = car(routeOf(STREET, [C, D]), ['D', 'C'])
    c.drive(visit)
    expect(c.up()).toEqual(['D'])
    c.reorder(['C', 'D'])
    expect(c.up()).toEqual([])
    expect(c.done()).toEqual([])
    expect(c.missed()).toEqual([])
  })

  it('is missed when it is next and is driven away from, and the list moves on', () => {
    const c = car(routeOf(STREET, [C, D]), ['D', 'C'])
    c.drive([...visit, ...away])
    expect(c.missed()).toEqual(['D'])
    expect(c.next()).toBe('C')
  })
})

describe('a skip and a restart', () => {
  it('counts the bundles before the spot as skipped, drops and misses as they were, and the rule goes on from there', () => {
    const c = car(routeOf(LOOP, [A, B, C]), ['C', 'A', 'B'])
    c.drive(up(100))
    c.restart(500)
    expect(c.status()).toEqual({ C: 'next', A: 'skipped', B: 'skipped' })
    c.drive(legs(10, [0, 490], [0, 570]))
    expect(c.up()).toEqual(['C'])
    c.tap()
    expect(c.next()).toBeNull()
    expect(c.bar()?.name).toBe('No bundles left')
  })

  it('brings back a bundle after the spot, which is next again if the list says so, and the ones not next stay quiet', () => {
    const c = car(routeOf(LOOP, [A, B, C]), ['C', 'A', 'B'])
    c.drive(up(570))
    c.tap()
    expect(c.next()).toBe('A')
    c.restart(100)
    expect(c.status()).toEqual({ C: 'next', A: 'todo', B: 'todo' })
    c.drive(legs(10, [0, 100], [0, 520]))
    expect(c.beeps.map((b) => b.key)).toEqual(['C'])
    c.drive(legs(10, [0, 520], [0, 570]))
    expect(c.beeps.map((b) => b.key)).toEqual(['C', 'C'])
  })

  it('forgets everything on a restart from the start, and alerts as a new round', () => {
    const c = car(routeOf(LOOP, [A, B, C]), ['C', 'A', 'B'])
    c.drive(up(570))
    c.tap()
    c.restart(0)
    expect(c.round()).toEqual({ handledStopIds: [] })
    expect(c.status()).toEqual({ C: 'next', A: 'todo', B: 'todo' })
    expect(c.up()).toEqual([])
    c.drive([...up(570)])
    expect(c.beeps.map((b) => b.key)).toEqual(['C', 'C'])
    expect(c.missed()).toEqual([])
  })

  it('takes a queued alert away on a skip, as ever, and lets it come up again', () => {
    const c = car(routeOf(LOOP, [A, B]), ['A', 'B'])
    c.drive(up(170))
    expect(c.up()).toEqual(['A'])
    c.restart(150)
    expect(c.up()).toEqual([])
    c.drive(legs(10, [0, 150], [0, 180]))
    expect(c.up()).toEqual(['A'])
    expect(c.beeps.map((b) => b.key)).toEqual(['A', 'A'])
  })

  it('leaves the bundles to do behind the car as they are on Continue Round, and the next still alerts by place', () => {
    const c = car(routeOf(LOOP, [A, B, C]), ['C', 'A', 'B'])
    c.drive(up(620))
    c.tap()
    c.carryOn()
    expect(c.status()).toEqual({ C: 'dropped', A: 'next', B: 'todo' })
    c.drive([...legs(10, [0, 620], [0, 900], [40, 900], [40, 300]), ...legs(10, [40, 300], [40, 200])])
    expect(c.up()).toEqual(['A'])
    expect(c.queued()[0].placed).toBe(true)
  })
})

describe('the end of the route with a bundle to do', () => {
  // A street 400 m north: B at 300 m first on the list, then A, passed by, at 100 m.
  const A1 = bundle('A', [8, 100])
  const B1 = bundle('B', [8, 300])
  const STREET: XY[] = [[0, 0], [0, 400]]
  const atEnd = () => {
    const c = car(routeOf(STREET, [A1, B1]), ['B', 'A'])
    c.drive(legs(10, [0, 0], [0, 270]))
    c.tap()
    c.drive(legs(10, [0, 270], [0, 400]))
    return c
  }

  it('leaves it to do, not missed or swept: the round is simply not finished', () => {
    const c = atEnd()
    expect(c.status()).toEqual({ B: 'dropped', A: 'next' })
    expect(c.missed()).toEqual([])
    expect(c.done()).toEqual(['B'])
    expect(c.finished()).toBe(false)
    expect(c.bar()?.name).toBe('A')
    expect(c.up()).toEqual([])
  })

  it('can mark it dropped in the list, which finishes the round', () => {
    const c = atEnd()
    c.mark('A')
    expect(c.status()).toEqual({ B: 'dropped', A: 'dropped' })
    expect(c.finished()).toBe(true)
  })

  it('alerts by place if the car goes back to it, past the end of the route', () => {
    const c = atEnd()
    c.drive(legs(10, [0, 400], [30, 400], [30, 130]))
    expect(c.up()).toEqual(['A'])
    expect(c.queued()[0].placed).toBe(true)
    c.tap()
    expect(c.finished()).toBe(true)
  })
})

describe('off the route', () => {
  const A1 = bundle('A', [8, 100])
  const B1 = bundle('B', [8, 400])
  const STREET: XY[] = [[0, 0], [0, 800]]
  /** Up the street, B dropped, A next and behind; then away east of the street and back down it, 32 m from A. */
  const leave = () => {
    const c = car(routeOf(STREET, [A1, B1]), ['B', 'A'])
    c.drive(legs(10, [0, 0], [0, 370]))
    c.tap()
    c.drive(legs(10, [0, 370], [0, 420], [40, 430], [120, 430], [120, 200], [40, 130]))
    return c
  }

  it('alerts by place all the same, with its Dropped button, and takes a drop', () => {
    const c = leave()
    expect(c.phase()).not.toBe('on')
    expect(c.up()).toEqual([])
    c.drive(legs(10, [40, 130], [40, 110]))
    expect(c.up()).toEqual(['A'])
    expect(c.queued()[0].placed).toBe(true)
    c.tap()
    expect(c.status()).toEqual({ B: 'dropped', A: 'dropped' })
  })

  it('counts it missed if it is driven out of its zone, not skipped, so the list can still mark it dropped', () => {
    const c = leave()
    c.drive(legs(10, [40, 130], [40, 110], [120, 110]))
    expect(c.up()).toEqual([])
    expect(c.status().A).toBe('missed')
    expect(c.toasts).toEqual(['Missed bundle: A'])
    expect(c.rows().find((r) => r.id === 'A')?.markKey).toBe('A')
  })

  it('keeps every bundle not next to do through a spell off the route, where the catch-up on coming back sweeps only the houses', () => {
    const house = stop('H', 'nothrow', [8, 240])
    const later = bundle('L', [8, 280])
    const c = car(routeOf(STREET, [A1, later, B1, house]), ['B', 'L', 'A'])
    // Past A, then off the street at 200 m, round the block and back onto it at 300 m, past L and the house.
    c.drive(legs(10, [0, 0], [0, 200], [100, 210], [100, 300], [0, 310], [0, 340]))
    expect(c.progress().along).toBeGreaterThan(300)
    expect(c.status()).toEqual({ B: 'next', L: 'todo', A: 'todo' })
    expect(c.done()).toEqual(['H'])
    expect(c.missed()).toEqual([])
  })

  it('misses the next bundle in the stretch gone round, with a toast, so it has its Mark dropped', () => {
    const later = bundle('L', [8, 280])
    const c = car(routeOf(STREET, [later, B1]))
    c.drive(legs(10, [0, 0], [0, 200], [100, 210], [100, 300], [0, 310], [0, 340]))
    expect(c.status()).toEqual({ L: 'missed', B: 'next' })
    expect(c.toasts).toEqual(['Missed bundle: L'])
    expect(c.rows()[0].markKey).toBe('L')
  })
})

describe('leaving the route with an alert up on the last pass of a street driven twice', () => {
  it('misses it, with its Mark dropped, and counts the first pass gone by with it, so the stop does not hold up the list', () => {
    // X is next on the way back only. The car goes 25 m past it, the alert still up, and turns off the street.
    const route = routeOf([[0, 0], [0, 500], [0, 0]], [bundle('X', [8, 200]), bundle('W', [8, 300]), bundle('Z', [8, 50])])
    const c = car(route, ['W', 'X', 'Z'])
    c.drive(legs(10, [0, 0], [0, 280]))
    c.tap()
    c.drive(legs(10, [0, 280], [0, 500], [0, 175]))
    expect(c.up()).toEqual(['X#2'])
    c.drive(legs(10, [0, 175], [-100, 175]))
    expect(c.phase()).toBe('off')
    expect(c.up()).toEqual([])
    expect(c.done()).toEqual(['W', 'W#2', 'X', 'X#2'])
    expect(c.missed()).toEqual(['X#2'])
    expect(c.toasts).toEqual(['Missed bundle: X'])
    expect(c.status()).toEqual({ W: 'dropped', X: 'missed', Z: 'next' })
    expect(c.rows().find((r) => r.id === 'X')?.markKey).toBe('X#2')
  })
})

describe('a car that backs up along the route to a bundle it has passed', () => {
  // B is first on the list, 90 m past A. The car goes on to 200 m, drops B and backs down the street to A.
  const route = routeOf([[0, 0], [0, 800]], [bundle('A', [8, 100]), bundle('B', [8, 190])])
  const backed = () => {
    const c = car(route, ['B', 'A'])
    c.drive(legs(10, [0, 0], [0, 200]))
    c.tap()
    c.drive(legs(4, [0, 200], [0, 136]))
    return c
  }

  it('meets it by place, with its words, though the street puts it ahead of the car again and the furthest reached is past it', () => {
    const c = backed()
    expect(c.progress().furthest).toBeGreaterThan(190)
    expect(c.up()).toEqual(['A'])
    expect(c.queued()[0].placed).toBe(true)
    expect(c.said.at(-1)).toBe('Bundle drop, A, 10 papers.')
    c.tap()
    expect(c.status()).toEqual({ B: 'dropped', A: 'dropped' })
  })
})

describe('a car that backs up, with the next bundle still to come', () => {
  // A street 300 m north and back, with the bundle at 195 m on the way out and 405 m on the way back. The car stops short of it, backs up, and the
  // tracker puts it on the way back for a while, past both passes.
  const B1 = bundle('B', [8, 195])
  const OUT_BACK: XY[] = [[0, 0], [0, 300], [0, 0]]
  const fixes: Fix[] = [...legs(10, [0, 0], [0, 150]), ...legs(4, [0, 150], [0, 134]), ...legs(5, [0, 134], [0, 294]), ...legs(5, [0, 294], [0, 0])]

  it('does not take the turn the tracker is not sure of to mean the car has driven past it, so the first pass alerts along the route', () => {
    const c = car(routeOf(OUT_BACK, [B1]))
    let flipped = false
    for (const f of fixes) {
      c.drive([f])
      flipped ||= !!c.progress().turned
      if (c.up().length) break
    }
    expect(flipped).toBe(true)
    expect(c.beeps[0]).toMatchObject({ key: 'B', placed: false })
  })

  it('gives it its second chance on the way back when the first pass goes by without a tap', () => {
    const c = car(routeOf(OUT_BACK, [B1]))
    c.drive(fixes)
    expect(c.beeps.map((b) => b.key)).toEqual(['B', 'B#2'])
    expect(c.status()).toEqual({ B: 'missed' })
    expect(c.missed()).toEqual(['B', 'B#2'])
  })

  it('does not meet it by place on the last pass when it becomes next during the turn, though the car is beside it: the turn may be taken back', () => {
    // W, 260 m up, is first on the list. Backing up 25 to 37 m short of B, the car is put on the way back, past both of B's passes, and W is marked dropped.
    const c = car(routeOf(OUT_BACK, [bundle('W', [8, 260]), B1]), ['W', 'B'])
    c.drive(legs(10, [0, 0], [0, 170]))
    c.drive(legs(4, [0, 170], [0, 158]))
    expect(c.progress().turned).toBeTruthy()
    expect(c.progress().along).toBeGreaterThan(405)
    c.mark('W')
    expect(c.next()).toBe('B')
    expect(c.up()).toEqual([])
    // Taken back as the car drives on, it comes up as ever, on the way out, and the way back is still to come.
    c.drive(legs(5, [0, 158], [0, 180]))
    expect(c.progress().turned).toBeFalsy()
    expect(c.beeps).toEqual([expect.objectContaining({ key: 'B', placed: false })])
  })
})

describe('a court at the very end of the route, turned round in, with two bundles in it', () => {
  // The two are 60 m and 80 m in. A turn round can't become sure here (see HOLD_END_M), so all of it is judged at the end of the route.
  const route = routeOf([[0, 0], [0, 150], [0, 0]], [bundle('B', [8, 60]), bundle('C', [8, 80])])
  const c = car(route)
  c.drive([...legs(5, [0, 0], [0, 90]), ...legs(5, [0, 90], [0, 0])])

  it('alerts only for the first, which is missed on both passes', () => {
    expect(c.beeps.map((b) => b.key)).toEqual(['B', 'B#2'])
    expect(c.missed()).toEqual(['B', 'B#2'])
  })

  it('leaves the second to do, as it was driven past while it was not next: the round is not finished, and it is next', () => {
    expect(c.status()).toEqual({ B: 'missed', C: 'next' })
    expect(c.finished()).toBe(false)
  })
})

describe('an alert up by place as the car leaves the route', () => {
  // B is dropped 25 m past A, which is next from then on and comes up by place. The car creeps off the street past A, staying in A's zone.
  const route = routeOf([[0, 0], [0, 800]], [bundle('A', [8, 100]), bundle('B', [8, 130])])
  const away = () => {
    const c = car(route, ['B', 'A'])
    c.drive(legs(10, [0, 0], [0, 125]))
    c.tap()
    expect(c.up()).toEqual(['A'])
    expect(c.queued()[0].placed).toBe(true)
    c.drive(legs(3, [0, 125], [52, 110], [60, 100], [60, 100]))
    return c
  }

  it('goes with the other alerts when the route is left, neither done nor missed, as it is for a place the car has left', () => {
    const c = away()
    expect(c.phase()).toBe('off')
    expect(c.up()).toEqual([])
    expect(c.done()).toEqual(['B'])
    expect(c.missed()).toEqual([])
    expect(c.next()).toBe('A')
  })

  it('comes up again as the car comes back to the stop', () => {
    const c = away()
    c.drive(legs(5, [60, 100], [30, 100]))
    expect(c.up()).toEqual(['A'])
    expect(c.beeps.map((b) => b.key)).toEqual(['B', 'A', 'A'])
  })
})

describe('a drive with a wandering GPS', () => {
  it('goes by the bundles not next in silence, and alerts for each in the order of the list', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const c = car(routeOf(LOOP, [A, B, C]), ['C', 'A', 'B'], { noise: 4, seed })
      c.drive(up(570))
      expect(c.beeps.map((b) => b.key), `seed ${seed}`).toEqual(['C'])
      c.tap()
      c.drive([...up(700, 570), ...round(180)])
      expect(c.beeps.map((b) => b.key), `seed ${seed}`).toEqual(['C', 'A'])
      c.tap()
      expect(c.status(), `seed ${seed}`).toEqual({ C: 'dropped', A: 'dropped', B: 'next' })
      expect(c.missed(), `seed ${seed}`).toEqual([])
    }
  })
})

describe('turning the voice on with an alert up by place', () => {
  it('says it, though the stop is behind the car along the route', () => {
    const near = bundle('N', [8, 230])
    const c = car(routeOf(LOOP, [A, near]), ['N', 'A'])
    c.voiceOff()
    c.drive(up(230))
    c.tap()
    expect(c.queued()[0].placed).toBe(true)
    expect(c.said).toEqual([])
    c.voiceOn()
    expect(c.said).toEqual(['Bundle drop, A, 10 papers.'])
  })
})

describe('a bundle next to a no-throw house and an apartment block', () => {
  it('leaves them alerting as ever, whichever bundle is next', () => {
    const house = stop('H', 'nothrow', [-8, 150])
    const block = stop('K', 'block', [-8, 300])
    const request = stop('R', 'request', [-8, 450])
    const c = car(routeOf(LOOP, [A, B, C, house, block, request]), ['C', 'A', 'B'])
    c.drive(up(520))
    expect(c.beeps.map((b) => b.key)).toEqual(['H', 'K', 'R'])
    expect(c.done()).toEqual(['H', 'K', 'R'])
    expect(c.missed()).toEqual([])
    expect(c.status()).toEqual({ C: 'next', A: 'todo', B: 'todo' })
  })

  it('counts a no-throw row as it always did: the gate takes only bundles out', () => {
    const house = stop('H', 'nothrow', [-8, 150])
    const route = routeOf(LOOP, [A, house])
    const allOccs = occurrences(route)
    const occs = alertable(route, allOccs, quietReachFor(40))
    const gated = gatedOccurrences(occs, null, new Set(), 100, radius)
    expect(gated.map((o) => o.key)).toEqual(['H'])
    expect(houseRow(route, allOccs, gated, new Set(), gated[0], radius).map((o) => o.key)).toEqual(['H'])
  })
})
