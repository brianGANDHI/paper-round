import { describe, expect, it } from 'vitest'
import { haversine } from './geo'
import {
  ARRIVE_NEAR_M,
  AWAY_M,
  BACK_FIXES,
  BIG_LEAP_M,
  BLIND_GAP_MS,
  BLIND_MPS,
  CARRY_ON_SECONDS,
  carryOnHere,
  guideToLeft,
  LEAP_M,
  OFF_FIXES,
  OFF_MAX_ACCURACY_M,
  OFF_ROUTE_M,
  OFF_SECONDS,
  offRouteSpeech,
  ON_ROUTE_M,
  REJOIN_NEAR_M,
  REJOIN_RUN_M,
  REMIND_MOVE_M,
  REMIND_SECONDS,
  restartWatch,
  RETURN_GIVE_UP_M,
  RUN_GAP_SECONDS,
  startOffRoute,
  startOffWatch,
  stepOffRoute,
  stepWatched,
  takeMeBack,
  unasked,
  watchFix,
  type LeftAt,
  type OffEvent,
  type OffPhase,
  type OffState,
  type OffWatch,
  type RouteFix,
} from './offRoute'
import { advance, makeTrack, offRouteGap, startProgress, type Progress } from './progress'
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

const HERE = spot([0, 0])
const NO_FAR = { fixes: 0, since: null }
/** A state with nothing counted, written out so that the shape the machine keeps is checked as well. */
const BLANK: OffState = { phase: 'on', left: null, followedAt: null, far: NO_FAR, near: 0, nearFrom: null, away: false, remindedAt: null, remindedFrom: null, rejoin: null }
const blank = (over: Partial<OffState> = {}): OffState => ({ ...BLANK, ...over })
/** Where the route was left: 500 metres along. */
const LEFT: LeftAt = { along: 500, furthest: 520, at: spot([0, 500]) }
/** Where the driver came back onto the route, 900 metres further on than where it was left. */
const REJOIN = { along: 1400, furthest: 1400, at: spot([300, 1400]), time: 100_000 }

/** A fix on the route unless it is said to be otherwise: 5 metres out, a good fix, moving. */
const fix = (over: Partial<RouteFix> = {}): RouteFix => ({ time: 0, at: HERE, accuracy: 10, speed: 10, gap: 5, along: 500, furthest: 500, lost: false, ...over })
/** A fix on the route, `along` metres along it. */
const onRoute = (along: number, time: number | null = 0, over: Partial<RouteFix> = {}) => fix({ along, furthest: along, time, ...over })
/** A fix `gap` metres from the route. */
const offBy = (gap: number, time: number | null = 0, over: Partial<RouteFix> = {}) => fix({ gap, time, ...over })
/** A fix on the route `along` metres along it, at the place on a straight route going north that is: so that fixes in turn cover ground. */
const driving = (along: number, time: number | null = 0, over: Partial<RouteFix> = {}) => onRoute(along, time, { at: spot([0, along]), ...over })
/** A car on the route, `n` fixes a second apart from `t0`, 11 metres on from each other, starting `along` metres along it. */
const driveOn = (along: number, n: number, t0 = 11_000, over: Partial<RouteFix> = {}) => run(n, t0, (t, i) => driving(along + 11 * i, t, { furthest: along + 11 * i, ...over }))
/** Where a fix puts the driver, as the machine keeps it. */
const place = (f: RouteFix): LeftAt => ({ along: f.along, furthest: f.furthest, at: f.at })

const state = (phase: OffPhase, over: Partial<OffState> = {}): OffState => ({ ...startOffRoute, phase, ...over })
const ON = state('on', { left: LEFT })
const OFF = state('off', { left: LEFT, remindedAt: 10_000 })
const RETURNING = state('returning', { left: LEFT })
const REJOINED = state('rejoined', { left: LEFT, rejoin: REJOIN })
const PHASES: [string, OffState][] = [
  ['on', ON],
  ['off', OFF],
  ['returning', RETURNING],
  ['rejoined', REJOINED],
]

/** Feed fixes in turn; say where it ended up and what happened at each. */
function play(from: OffState, fixes: RouteFix[]) {
  let now = from
  const events: OffEvent[] = []
  for (const f of fixes) {
    const r = stepOffRoute(now, f)
    now = r.state
    events.push(r.event)
  }
  return { state: now, events, said: events.filter((e) => e !== null) }
}

/** `n` fixes a second apart from `t0`, each made by `make`. */
const run = (n: number, t0: number, make: (time: number, i: number) => RouteFix, every = 1000) => Array.from({ length: n }, (_, i) => make(t0 + i * every, i))

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

describe('the numbers it goes by', () => {
  it('are the agreed ones', () => {
    expect([OFF_ROUTE_M, ON_ROUTE_M, OFF_MAX_ACCURACY_M, OFF_FIXES, OFF_SECONDS, BACK_FIXES, REMIND_SECONDS, REJOIN_NEAR_M, CARRY_ON_SECONDS]).toEqual([50, 40, 40, 3, 4, 2, 30, 150, 60])
  })

  it('include the ones for telling a street crossed from the route rejoined, and a jump from driving', () => {
    expect([REJOIN_RUN_M, RUN_GAP_SECONDS, REMIND_MOVE_M, AWAY_M, LEAP_M, RETURN_GIVE_UP_M]).toEqual([120, 10, 50, 30, 150, 500])
  })

  it('include the ones for a phone unseen for a while, and for the way to where the round starts', () => {
    expect([BLIND_MPS, BLIND_GAP_MS, ARRIVE_NEAR_M]).toEqual([20, 10_000, 100])
  })

  it('start on the route with nothing counted and nowhere left yet', () => {
    expect(startOffRoute).toEqual(BLANK)
  })

  it('are a starting point that cannot be changed by mistake for the next round', () => {
    expect(Object.isFrozen(startOffRoute)).toBe(true)
    expect(Object.isFrozen(startOffRoute.far)).toBe(true)
    expect(Object.isFrozen(startOffWatch)).toBe(true)
  })
})

describe('telling a far fix from a near one', () => {
  const farCount = (f: RouteFix) => stepOffRoute(ON, f).state.far.fixes
  const leftAfter = (f: RouteFix) => stepOffRoute(ON, f).state.left

  it('calls a fix far only when it is more than 50 metres out', () => {
    expect(farCount(offBy(49))).toBe(0)
    expect(farCount(offBy(50))).toBe(0)
    expect(farCount(offBy(50.01))).toBe(1)
    expect(farCount(offBy(51))).toBe(1)
    expect(farCount(offBy(500))).toBe(1)
    expect(farCount(offBy(Infinity))).toBe(1)
  })

  it('wants it more than twice the accuracy out, when that is further than 50', () => {
    for (const [accuracy, edge] of [[40, 80], [36, 72], [30, 60], [26, 52], [25, 50], [10, 50], [0, 50]]) {
      expect(farCount(offBy(edge, 0, { accuracy })), `accuracy ${accuracy} at ${edge}`).toBe(0)
      expect(farCount(offBy(edge + 0.5, 0, { accuracy })), `accuracy ${accuracy} at ${edge + 0.5}`).toBe(1)
    }
  })

  it('calls a fix near up to 40 metres out, and takes the place where the route was left from it', () => {
    const f = fix({ gap: 39, along: 700, furthest: 720, at: spot([4, 700]) })
    expect(leftAfter(f)).toEqual({ along: 700, furthest: 720, at: spot([4, 700]) })
    expect(leftAfter({ ...f, gap: 40 })).toEqual(place(f))
    expect(leftAfter({ ...f, gap: 0 })).toEqual(place(f))
  })

  it('says nothing from a fix between 40 and 50 metres out, but that the driver is not far', () => {
    for (const gap of [40.01, 41, 45, 49, 50]) {
      const after = stepOffRoute(ON, fix({ gap, along: 700, furthest: 700 })).state
      expect(after.left, `gap ${gap}`).toBe(LEFT)
      expect(after.far, `gap ${gap}`).toEqual(NO_FAR)
    }
  })

  it('never calls a fix near while the tracker is holding the driver at their old place, since its gap is for the place it doubts', () => {
    const after = stepOffRoute(ON, fix({ gap: 10, along: 700, furthest: 700, doubt: true })).state
    expect(after.left).toBe(LEFT)
    expect(stepOffRoute(ON, fix({ gap: 10, along: 700, furthest: 700, doubt: false })).state.left?.along).toBe(700)
    // It is a fix like any other for being far.
    expect(farCount(offBy(80, 0, { doubt: true }))).toBe(1)
  })

  it('never calls a lost fix near, whatever its gap says', () => {
    const after = stepOffRoute(ON, fix({ gap: 10, along: 700, furthest: 700, lost: true })).state
    expect(after.left).toBe(LEFT)
    expect(after.far).toEqual(NO_FAR)
  })

  it('goes by the fix itself for a fix that is lost and far', () => {
    expect(farCount(offBy(300, 0, { lost: true }))).toBe(1)
  })

  it('hears nothing from a fix less accurate than 40 metres, in any phase', () => {
    for (const [name, s] of PHASES) {
      for (const f of [offBy(300, 0, { accuracy: 41 }), onRoute(520, 0, { accuracy: 41 }), onRoute(5000, 0, { accuracy: 100 })]) {
        const r = stepOffRoute(s, f)
        expect(r.state, name).toBe(s)
        expect(r.event, name).toBeNull()
      }
    }
  })

  it('hears a fix at 40 metres of accuracy', () => {
    expect(farCount(offBy(300, 0, { accuracy: 40 }))).toBe(1)
    expect(leftAfter(onRoute(700, 0, { accuracy: 40 }))?.along).toBe(700)
  })

  it('hears nothing from an accuracy that is not a real number, or is below nothing', () => {
    for (const accuracy of [NaN, Infinity, -1, -Infinity]) {
      const r = stepOffRoute(ON, offBy(300, 0, { accuracy }))
      expect(r.state, `${accuracy}`).toBe(ON)
      expect(r.event).toBeNull()
    }
  })

  it('hears nothing from a fix whose distance from the route is not a real distance', () => {
    for (const gap of [NaN, -1, -Infinity]) {
      const r = stepOffRoute(ON, offBy(gap))
      expect(r.state, `${gap}`).toBe(ON)
      expect(r.event).toBeNull()
    }
    // It is neither counted nor does it break the run: the third far fix is the fourth fix.
    const counting = play(ON, [offBy(80, 0), offBy(NaN, 1000), offBy(80, 5000), offBy(80, 6000)])
    expect(counting.events).toEqual([null, null, null, 'went-off'])
  })

  it('hears nothing from a near fix whose place along the route is not a number', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(stepOffRoute(ON, onRoute(bad)).state, `${bad}`).toBe(ON)
      expect(stepOffRoute(ON, fix({ along: 700, furthest: bad })).state, `${bad}`).toBe(ON)
    }
  })

  it('is not set back by a near fix whose place is not a real one, since that says nothing', () => {
    const r = play(ON, [offBy(80, 0), onRoute(NaN, 1000), offBy(80, 2000), offBy(80, 4000)])
    expect(r.events).toEqual([null, null, null, 'went-off'])
  })

  it('hears nothing from a near fix whose position is not a real one', () => {
    for (const at of [{ lat: NaN, lng: 0 }, { lat: 0, lng: NaN }, { lat: Infinity, lng: 0 }, { lat: 0, lng: -Infinity }]) {
      expect(stepOffRoute(ON, onRoute(700, 0, { at })).state, JSON.stringify(at)).toBe(ON)
    }
  })

  it('takes a far fix whatever its place along the route is, since that is not used', () => {
    expect(farCount(offBy(80, 0, { along: NaN, furthest: NaN }))).toBe(1)
  })

  it('does not count a fix as far while the phone is going slower than 1.5 metres a second', () => {
    for (const [speed, counts] of [[0, 0], [1.4, 0], [1.49, 0], [1.5, 1], [3, 1], [30, 1], [null, 1], [NaN, 1]] as const) {
      expect(farCount(offBy(80, 0, { speed })), `speed ${speed}`).toBe(counts)
    }
  })

  it('still takes a near fix when the phone is not moving', () => {
    expect(leftAfter(onRoute(700, 0, { speed: 0 }))?.along).toBe(700)
  })
})

describe('going off the route', () => {
  it('takes three far fixes in a row, and four seconds since the first', () => {
    const twoThenThree = play(ON, [offBy(80, 0), offBy(80, 2000), offBy(80, 4000)])
    expect(twoThenThree.events).toEqual([null, null, 'went-off'])
    expect(twoThenThree.state.phase).toBe('off')
  })

  it('does not go off at two far fixes, however long they are apart', () => {
    const r = play(ON, [offBy(80, 0), offBy(80, 6000)])
    expect(r.said).toEqual([])
    expect(r.state.phase).toBe('on')
    expect(r.state.far).toEqual({ fixes: 2, since: 0 })
    expect(play(ON, [offBy(80, 0), offBy(80, 600_000)]).said).toEqual([])
  })

  it('does not take far fixes a long way apart in time for fixes in a row', () => {
    // One old far fix and two fresh ones are not three in a row, and are not four seconds of evidence.
    expect(play(ON, [offBy(80, 0), offBy(80, 600_000), offBy(80, 600_001)]).events).toEqual([null, null, null])
    expect(play(ON, [offBy(80, 0), offBy(80, 60_000), offBy(80, 60_500)]).events).toEqual([null, null, null])
    // The run starts again from the fix that found the pause.
    expect(play(ON, [offBy(80, 0), offBy(80, 600_000)]).state.far).toEqual({ fixes: 1, since: 600_000 })
    // Which is not a reason to start again, while the fixes keep coming.
    expect(play(ON, [offBy(80, 600_000), offBy(80, 602_000), offBy(80, 604_000)]).events).toEqual([null, null, 'went-off'])
  })

  it('allows ten seconds a fix, on average, for a run of far fixes', () => {
    const gap = RUN_GAP_SECONDS * 1000
    expect(play(ON, [offBy(80, 0), offBy(80, gap), offBy(80, gap + 500)]).events).toEqual([null, null, 'went-off'])
    expect(play(ON, [offBy(80, 0), offBy(80, gap + 1), offBy(80, gap + 500)]).events).toEqual([null, null, null])
    // Three fixes: the span is for two gaps.
    expect(play(ON, [offBy(80, 0), offBy(80, 1000), offBy(80, 2 * gap)]).events).toEqual([null, null, 'went-off'])
    expect(play(ON, [offBy(80, 0), offBy(80, 1000), offBy(80, 2 * gap + 1)]).events).toEqual([null, null, null])
  })

  it('does not start again for a run whose times are not there to be compared', () => {
    expect(play(ON, [offBy(80, null), offBy(80, 600_000), offBy(80, 600_001)]).events).toEqual([null, null, 'went-off'])
  })

  it('does not go off at 3.9 seconds, and does at 4', () => {
    expect(play(ON, [offBy(80, 0), offBy(80, 1950), offBy(80, 3900)]).said).toEqual([])
    expect(play(ON, [offBy(80, 0), offBy(80, 1950), offBy(80, 3999)]).said).toEqual([])
    expect(play(ON, [offBy(80, 0), offBy(80, 1950), offBy(80, 4000)]).said).toEqual(['went-off'])
    expect(play(ON, [offBy(80, 1000), offBy(80, 2000), offBy(80, 5000)]).said).toEqual(['went-off'])
  })

  it('goes off at the first far fix that has both the three and the four seconds behind it', () => {
    // Fixes a second apart: the third is only two seconds on, so it is the fifth that completes the four.
    const r = play(ON, run(5, 0, (t) => offBy(80, t)))
    expect(r.events).toEqual([null, null, null, null, 'went-off'])
    // Crowded into the first second, then the four seconds come.
    const crowded = play(ON, [offBy(80, 0), offBy(80, 500), offBy(80, 1000), offBy(80, 3999), offBy(80, 4000)])
    expect(crowded.events).toEqual([null, null, null, null, 'went-off'])
  })

  it('counts the time from the first of the run, not the last fix before it', () => {
    // A near fix at 0 restarts everything: the run begins at 20 s, and 3 s later it is not yet four.
    const r = play(ON, [onRoute(300, 0), offBy(80, 20_000), offBy(80, 21_000), offBy(80, 23_000)])
    expect(r.said).toEqual([])
    expect(r.state.far).toEqual({ fixes: 3, since: 20_000 })
  })

  it('goes off on the fixes alone when a time is missing', () => {
    expect(play(ON, [offBy(80, null), offBy(80, null), offBy(80, null)]).said).toEqual(['went-off'])
    // The first has no time: there is nothing to count the four seconds from.
    expect(play(ON, [offBy(80, null), offBy(80, 1000), offBy(80, 1500)]).said).toEqual(['went-off'])
    // The last has none.
    expect(play(ON, [offBy(80, 0), offBy(80, 1000), offBy(80, null)]).said).toEqual(['went-off'])
    // The middle one has none, and the time between the first and the last is short.
    expect(play(ON, [offBy(80, 0), offBy(80, null), offBy(80, 1000)]).said).toEqual([])
    expect(play(ON, [offBy(80, 0), offBy(80, null), offBy(80, 4000)]).said).toEqual(['went-off'])
  })

  it('treats a time that is not a number as missing', () => {
    expect(play(ON, [offBy(80, NaN), offBy(80, NaN), offBy(80, NaN)]).said).toEqual(['went-off'])
    expect(play(ON, [offBy(80, Infinity), offBy(80, Infinity), offBy(80, Infinity)]).said).toEqual(['went-off'])
  })

  it('does not take a clock that has gone back a long way for a long pause', () => {
    const r = play(ON, [offBy(80, 100_000), offBy(80, 0)])
    expect(r.state.far).toEqual({ fixes: 2, since: 0 })
    expect(play(ON, [offBy(80, 100_000), offBy(80, 0), offBy(80, 4000)]).said).toEqual(['went-off'])
  })

  it('treats a time that goes backwards as no time having passed, and counts on from the earlier time', () => {
    const r = play(ON, [offBy(80, 9000), offBy(80, 5000), offBy(80, 1000)])
    expect(r.said).toEqual([])
    expect(r.state.far).toEqual({ fixes: 3, since: 1000 })
    // It does not wait for the clock to come round to where it was: 4 s from the earlier time is enough.
    expect(play(r.state, [offBy(80, 5000)]).said).toEqual(['went-off'])
    expect(play(r.state, [offBy(80, 4999)]).said).toEqual([])
  })

  it('goes off with the place where the route was left kept, and the reminders starting now', () => {
    const r = play(ON, [onRoute(300, 0, { furthest: 310 }), onRoute(320, 1000, { furthest: 330, at: spot([1, 320]) }), offBy(80, 2000), offBy(80, 4000), offBy(80, 6000)])
    expect(r.events).toEqual([null, null, null, null, 'went-off'])
    expect(r.state).toEqual(blank({ phase: 'off', left: { along: 320, furthest: 330, at: spot([1, 320]) }, remindedAt: 6000, remindedFrom: HERE }))
  })

  it('keeps the place it was left at through fixes between 40 and 50 metres out on the way off', () => {
    const r = play(ON, [onRoute(300, 0), offBy(45, 1000, { along: 340, furthest: 340 }), offBy(80, 2000), offBy(80, 4000), offBy(80, 6000)])
    expect(r.state.left).toEqual({ along: 300, furthest: 300, at: HERE })
  })

  it('starts the run again when a fix in it is not far', () => {
    const nearBetween = play(ON, [offBy(80, 0), offBy(80, 1000), offBy(45, 2000), offBy(80, 3000), offBy(80, 9000)])
    expect(nearBetween.said).toEqual([])
    expect(nearBetween.state.far).toEqual({ fixes: 2, since: 3000 })
    const nearOn = play(ON, [offBy(80, 0), offBy(80, 1000), onRoute(500, 2000), offBy(80, 3000), offBy(80, 9000)])
    expect(nearOn.said).toEqual([])
    expect(nearOn.state.far).toEqual({ fixes: 2, since: 3000 })
    const slow = play(ON, [offBy(80, 0), offBy(80, 1000), offBy(80, 2000, { speed: 1.4 }), offBy(80, 3000), offBy(80, 9000)])
    expect(slow.said).toEqual([])
    expect(slow.state.far.fixes).toBe(2)
  })

  it('is not set back by a fix that says too little', () => {
    const r = play(ON, [offBy(80, 0), offBy(80, 1000, { accuracy: 50 }), onRoute(500, 1500, { accuracy: 60 }), offBy(80, 2000), offBy(80, 5000)])
    expect(r.events).toEqual([null, null, null, null, 'went-off'])
  })

  it('never goes off from a phone that is standing still, however far from the route', () => {
    const r = play(ON, run(300, 0, (t) => offBy(60, t, { speed: 0 })))
    expect(r.said).toEqual([])
    expect(r.state.phase).toBe('on')
    const crawling = play(ON, run(300, 0, (t) => offBy(60, t, { speed: 1.4 })))
    expect(crawling.said).toEqual([])
  })

  it('does go off once the same phone starts moving', () => {
    const r = play(ON, [...run(100, 0, (t) => offBy(60, t, { speed: 0 })), ...run(5, 100_000, (t) => offBy(60, t, { speed: 3 }))])
    expect(r.events.indexOf('went-off')).toBe(100 + 4)
  })

  it('goes off with nowhere to guide back to, when the first fix of all is already far', () => {
    const r = play(startOffRoute, run(5, 0, (t) => offBy(300, t, { lost: true })))
    expect(r.said).toEqual(['went-off'])
    expect(r.state).toMatchObject({ phase: 'off', left: null })
  })

  it('does not go off from fixes near the route, or from a glitch of one far fix', () => {
    expect(play(ON, run(100, 0, (t) => onRoute(500, t))).said).toEqual([])
    const glitch = play(ON, [onRoute(500, 0), onRoute(510, 1000), offBy(90, 2000), onRoute(530, 3000), onRoute(540, 4000)])
    expect(glitch.said).toEqual([])
    expect(glitch.state.phase).toBe('on')
    expect(glitch.state.left?.along).toBe(540)
  })

  it('does not go off from two glitches in a row', () => {
    const glitch = play(ON, [onRoute(500, 0), offBy(90, 1000), offBy(90, 2000), onRoute(530, 3000), onRoute(540, 8000)])
    expect(glitch.said).toEqual([])
  })

  it('refreshes where the route was last followed at every near fix, and nowhere else', () => {
    const r = play(startOffRoute, [onRoute(100, 0), onRoute(110, 1000), offBy(45, 2000, { along: 999, furthest: 999 }), onRoute(125, 3000, { furthest: 126, at: spot([2, 125]) })])
    expect(r.state.left).toEqual({ along: 125, furthest: 126, at: spot([2, 125]) })
    expect(r.state.phase).toBe('on')
  })
})

describe('while off the route', () => {
  /** A fix well off the route, at the place a car going at 10 metres a second has got to by `t`: so that it is going somewhere. */
  const remindFix = (t: number | null, over: Partial<RouteFix> = {}) => offBy(80, t, { at: spot([80, (t ?? 0) / 100]), ...over })

  it('reminds about every 30 seconds, not before', () => {
    expect(stepOffRoute(OFF, remindFix(10_000 + 29_999)).event).toBeNull()
    expect(stepOffRoute(OFF, remindFix(10_000 + 30_000)).event).toBe('remind')
    expect(stepOffRoute(OFF, remindFix(10_000 + 30_001)).event).toBe('remind')
    expect(stepOffRoute(OFF, remindFix(10_000)).event).toBeNull()
  })

  it('counts the 30 seconds from the last reminder, so that they keep coming', () => {
    const r = play(OFF, run(200, 10_000, (t) => remindFix(t)))
    const at = r.events.flatMap((e, i) => (e === 'remind' ? [i] : []))
    expect(at).toEqual([30, 60, 90, 120, 150, 180])
    expect(r.state.remindedAt).toBe(10_000 + 180_000)
    expect(r.state.phase).toBe('off')
  })

  it('counts from the fix it reminded at, not from when it was due', () => {
    const r = play(OFF, [remindFix(45_000), remindFix(74_999), remindFix(75_000)])
    expect(r.events).toEqual(['remind', null, 'remind'])
    expect(r.state.remindedAt).toBe(75_000)
  })

  it('reminds whatever kind of fix comes, so long as it is not near enough to count', () => {
    for (const f of [remindFix(50_000), offBy(45, 50_000), offBy(300, 50_000, { lost: true }), onRoute(500, 50_000, { lost: true })]) {
      expect(stepOffRoute(OFF, f).event).toBe('remind')
    }
    // Except that a phone that says it is going nowhere is left alone.
    expect(stepOffRoute(OFF, offBy(80, 50_000, { speed: 0 })).event).toBeNull()
  })

  it('takes the place of the reminder, and where the driver was, from the fix it reminded at', () => {
    const r = stepOffRoute(OFF, remindFix(50_000))
    expect(r.state.remindedAt).toBe(50_000)
    expect(r.state.remindedFrom).toEqual(spot([80, 500]))
  })

  it('does not remind a phone that is standing still, however long it is parked, and the clock waits for it', () => {
    // 10 minutes in the same place, jittering a little, and saying it is going nowhere.
    const parked = (speed: number | null) => run(600, 40_000, (t, i) => offBy(80, t, { speed, at: spot([80 + (i % 7) - 3, 500 + (i % 5) - 2]) }))
    for (const speed of [0, 1.4, null]) {
      const r = play(state('off', { left: LEFT, remindedAt: 10_000, remindedFrom: spot([80, 500]) }), parked(speed))
      expect(r.said, `speed ${speed}`).toEqual([])
      expect(r.state.remindedAt, `speed ${speed}`).toBe(10_000)
    }
  })

  it('reminds at once when the phone that was parked is on its way again, and then every 30 seconds', () => {
    const parkedState = state('off', { left: LEFT, remindedAt: 10_000, remindedFrom: spot([80, 500]) })
    const r = play(parkedState, [offBy(80, 400_000, { speed: 0 }), offBy(80, 401_000, { speed: 1.4 }), offBy(80, 402_000, { speed: 1.5 }), offBy(80, 403_000, { speed: 10 })])
    expect(r.events).toEqual([null, null, 'remind', null])
    expect(r.state.remindedAt).toBe(402_000)
  })

  it('goes by how far a phone has gone since the last reminder when it does not say how fast: 50 metres, or four times its accuracy', () => {
    const at = state('off', { left: LEFT, remindedAt: 10_000, remindedFrom: spot([80, 500]) })
    const remind = (north: number, accuracy = 10) => stepOffRoute(at, offBy(80, 60_000, { speed: null, accuracy, at: spot([80, 500 + north]) })).event
    expect(remind(49)).toBeNull()
    expect(remind(50.5)).toBe('remind')
    expect(remind(-50.5)).toBe('remind')
    expect(remind(300)).toBe('remind')
    expect(remind(70, 20)).toBeNull()
    expect(remind(79, 20)).toBeNull()
    expect(remind(81, 20)).toBe('remind')
    // A place that is not a real one is no reason to stay quiet.
    expect(stepOffRoute(at, offBy(80, 60_000, { speed: null, at: { lat: NaN, lng: 0 } })).event).toBe('remind')
  })

  it('does not go by how far it has gone when the phone does say how fast it is going', () => {
    const at = state('off', { left: LEFT, remindedAt: 10_000, remindedFrom: spot([80, 500]) })
    expect(stepOffRoute(at, offBy(80, 60_000, { speed: 10, at: spot([80, 500]) })).event).toBe('remind')
    expect(stepOffRoute(at, offBy(80, 60_000, { speed: 0, at: spot([80, 900]) })).event).toBeNull()
  })

  it('reminds a phone going off with nothing noted of where it was, like one that has moved', () => {
    for (const speed of [10, null]) {
      expect(stepOffRoute(state('off', { left: LEFT, remindedAt: 10_000, remindedFrom: null }), offBy(80, 60_000, { speed })).event, `speed ${speed}`).toBe('remind')
    }
  })

  it('does not remind from a fix that says too little', () => {
    expect(stepOffRoute(OFF, remindFix(50_000, { accuracy: 41 })).event).toBeNull()
    expect(stepOffRoute(OFF, onRoute(500, 50_000, { accuracy: 41 })).state).toBe(OFF)
  })

  it('does not remind when a time is missing, or goes backwards', () => {
    expect(stepOffRoute(OFF, remindFix(null)).event).toBeNull()
    expect(stepOffRoute(OFF, remindFix(5000)).event).toBeNull()
    expect(stepOffRoute(OFF, remindFix(NaN)).event).toBeNull()
    const noClock = state('off', { left: LEFT, remindedAt: null })
    expect(stepOffRoute(noClock, remindFix(null)).event).toBeNull()
  })

  it('counts on from an earlier time when the clock goes backwards, rather than waiting for it to come round again', () => {
    const r = stepOffRoute(OFF, remindFix(5000))
    expect(r.state.remindedAt).toBe(5000)
    expect(r.state.near).toBe(0)
    // A reminder due 30 s after the earlier time, though the clock was at 1 000 000.
    const late = state('off', { left: LEFT, remindedAt: 1_000_000 })
    const lost = play(late, run(100, 10_000, (t) => offBy(300, t, { lost: true, at: spot([300, t / 100]) })))
    expect(lost.said.filter((e) => e === 'remind').length).toBe(3)
    expect(lost.events.indexOf('remind')).toBe(30)
  })

  it('starts the clock at the first fix with a time, when it went off without one', () => {
    const noClock = state('off', { left: LEFT, remindedAt: null })
    const first = stepOffRoute(noClock, remindFix(20_000))
    expect(first.event).toBeNull()
    expect(first.state.remindedAt).toBe(20_000)
    expect(stepOffRoute(first.state, remindFix(49_999)).event).toBeNull()
    expect(stepOffRoute(first.state, remindFix(50_000)).event).toBe('remind')
    // It was never reset to nothing by a fix with no time.
    expect(stepOffRoute(first.state, remindFix(null)).state.remindedAt).toBe(20_000)
  })

  it('does not count a fix near the route as far, or take the place from it before it is back', () => {
    const r = stepOffRoute(OFF, onRoute(900, 11_000))
    expect(r.state.left).toBe(LEFT)
    expect(r.state.phase).toBe('off')
    expect(r.state.near).toBe(1)
    expect(r.event).toBeNull()
  })

  it('is back after two near fixes in a row, and takes the place from the second', () => {
    const r = play(OFF, [onRoute(540, 11_000), onRoute(560, 12_000, { furthest: 565, at: spot([1, 560]) })])
    expect(r.events).toEqual([null, 'back'])
    // (Followed from the time of that fix: see `OffState.followedAt`.)
    expect(r.state).toEqual(blank({ left: { along: 560, furthest: 565, at: spot([1, 560]) }, followedAt: 12_000 }))
  })

  it('is back at 39 and 40 metres, and not at 41', () => {
    const back = (gap: number) => play(OFF, [onRoute(520, 11_000, { gap }), onRoute(520, 12_000, { gap })]).state.phase
    expect(back(39)).toBe('on')
    expect(back(40)).toBe('on')
    expect(back(41)).toBe('off')
    expect(back(45)).toBe('off')
  })

  it('is back only if the near fixes are in a row', () => {
    for (const between of [offBy(80, 11_500), offBy(45, 11_500), offBy(80, 11_500, { speed: 0 }), onRoute(520, 11_500, { lost: true }), offBy(300, 11_500, { lost: true })]) {
      const r = play(OFF, [onRoute(520, 11_000), between, onRoute(520, 12_000)])
      expect(r.said, JSON.stringify(between)).toEqual([])
      expect(r.state).toMatchObject({ phase: 'off', near: 1 })
    }
    expect(play(OFF, [onRoute(520, 11_000), offBy(80, 11_500), onRoute(520, 12_000), onRoute(520, 12_500)]).said).toEqual(['back'])
  })

  it('does not lose its count to a fix that says too little', () => {
    const r = play(OFF, [onRoute(520, 11_000), offBy(80, 11_500, { accuracy: 55 }), onRoute(520, 12_000)])
    expect(r.said).toEqual(['back'])
  })

  it('judges where it is back by the place along the route of the fix that completes it', () => {
    expect(play(OFF, [driving(2000, 11_000), driving(520, 12_000)]).events).toEqual([null, 'back'])
    // Elsewhere, 1.5 km on from where the first was: ground enough at once.
    expect(play(OFF, [driving(520, 11_000), driving(2000, 12_000)]).events).toEqual([null, 'rejoined-elsewhere'])
  })

  it('is back when the route is picked up within 150 metres of where it was left, and elsewhere beyond', () => {
    const back = (along: number) => play(OFF, [onRoute(along, 11_000), onRoute(along, 12_000)]).events[1]
    expect(back(500)).toBe('back')
    expect(back(649)).toBe('back')
    expect(back(650)).toBe('back')
    expect(back(651)).toBeNull()
    expect(back(351)).toBe('back')
    expect(back(350)).toBe('back')
    expect(back(349)).toBeNull()
    // Driving on from there, the route is picked up elsewhere.
    const elsewhere = (along: number) => play(OFF, driveOn(along, 14)).said
    expect(elsewhere(651)).toEqual(['rejoined-elsewhere'])
    expect(elsewhere(0)).toEqual(['rejoined-elsewhere'])
    expect(elsewhere(5000)).toEqual(['rejoined-elsewhere'])
    // And driving the other way, from the early side.
    expect(play(OFF, run(14, 11_000, (t, i) => driving(349 - 11 * i, t))).said).toEqual(['rejoined-elsewhere'])
  })

  it('goes by the place left, not by how far the driver had got', () => {
    // The furthest reached is 520, but the place left is 500: 651 is 151 away from it.
    const r = play(OFF, driveOn(651, 14))
    expect(r.said).toEqual(['rejoined-elsewhere'])
  })

  it('keeps the place left and notes where the driver came back, when it is somewhere else', () => {
    const r = play(OFF, run(12, 11_000, (t, i) => driving(1500 + 11 * i, t, { furthest: 1501 + 11 * i })))
    expect(r.events.slice(0, 11).every((e) => e === null)).toBe(true)
    expect(r.events[11]).toBe('rejoined-elsewhere')
    expect(r.state).toEqual(blank({ phase: 'rejoined', left: LEFT, rejoin: { along: 1621, furthest: 1622, at: spot([0, 1621]), time: 22_000 } }))
  })

  it('notes the time of the rejoining as missing when the fix has none', () => {
    const r = play(OFF, run(12, 0, (_, i) => driving(1500 + 11 * i, null)))
    expect(r.state.phase).toBe('rejoined')
    expect(r.state.rejoin?.time).toBeNull()
  })

  it('says it is back rather than remind, when both are due at once', () => {
    // The reminder is due 30 seconds after 10 000: only the second fix is that late.
    const r = play(OFF, [onRoute(520, 39_999), onRoute(520, 40_000)])
    expect(r.events).toEqual([null, 'back'])
    const elsewhere = play(OFF, driveOn(1500, 12, 29_000))
    expect(elsewhere.said).toEqual(['rejoined-elsewhere'])
    expect(elsewhere.events.at(-1)).toBe('rejoined-elsewhere')
  })

  describe('and a street crossed is not a route rejoined', () => {
    /** Near fixes with `metres` between the first and the last, on the way across a street, a second apart. */
    const across = (metres: number, n = 4) => run(n, 11_000, (t, i) => driving(1500 + (metres * i) / (n - 1), t))

    it('wants the fixes near the route to cover 120 metres between the first and the latest', () => {
      expect(play(OFF, across(110)).said).toEqual([])
      expect(play(OFF, across(119.5)).said).toEqual([])
      expect(play(OFF, across(120.5)).said).toEqual(['rejoined-elsewhere'])
      expect(play(OFF, across(300)).said).toEqual(['rejoined-elsewhere'])
    })

    it('keeps counting while they do not, and tells at the first fix that has', () => {
      const r = play(OFF, run(20, 11_000, (t, i) => driving(1500 + 11 * i, t)))
      expect(r.events.indexOf('rejoined-elsewhere')).toBe(11)
      const early = play(OFF, run(11, 11_000, (t, i) => driving(1500 + 11 * i, t)))
      expect(early.said).toEqual([])
      expect(early.state).toMatchObject({ phase: 'off', near: 11, nearFrom: spot([0, 1500]) })
    })

    it('forgets the ground covered when a fix that is not near comes between', () => {
      for (const between of [offBy(45, 15_500, { at: spot([0, 1540]) }), offBy(80, 15_500, { at: spot([0, 1540]) }), onRoute(1540, 15_500, { lost: true, at: spot([0, 1540]) }), offBy(41, 15_500, { at: spot([0, 1540]) })]) {
        const fixes = [...run(4, 11_000, (t, i) => driving(1500 + 10 * i, t)), between, ...run(4, 16_000, (t, i) => driving(1550 + 10 * i, t))]
        const r = play(OFF, fixes)
        expect(r.said, JSON.stringify(between)).toEqual([])
        expect(r.state, JSON.stringify(between)).toMatchObject({ phase: 'off', near: 4, nearFrom: spot([0, 1550]) })
        // And right after it, nothing is being counted.
        expect(play(OFF, [...fixes.slice(0, 4), between]).state, JSON.stringify(between)).toMatchObject({ phase: 'off', near: 0, nearFrom: null })
      }
    })

    it('does not forget it for a fix that says too little', () => {
      const fixes = [...run(6, 11_000, (t, i) => driving(1500 + 10 * i, t)), offBy(80, 17_000, { accuracy: 55 }), ...run(8, 18_000, (t, i) => driving(1560 + 10 * i, t))]
      expect(play(OFF, fixes).said).toEqual(['rejoined-elsewhere'])
    })

    it('does not wait for the ground when it is back where it was left, since that is no street crossed', () => {
      expect(play(OFF, [onRoute(520, 11_000), onRoute(520, 12_000)]).events).toEqual([null, 'back'])
    })

    it('does not wait for the ground when a fix has no place to measure from', () => {
      const noWhere = state('off', { left: LEFT, remindedAt: 10_000, near: 1, nearFrom: null })
      expect(stepOffRoute(noWhere, driving(1500, 12_000)).event).toBe('rejoined-elsewhere')
    })

    it('goes by the straight line, not the road: a long way round that ends nearby is a street crossed', () => {
      const there = spot([0, 1500])
      const r = play(OFF, [driving(1500, 11_000), driving(1700, 12_000, { at: spot([5, 1500]) })])
      expect(haversine(there, spot([5, 1500]))).toBeLessThan(REJOIN_RUN_M)
      expect(r.said).toEqual([])
    })
  })

  it('does not remind on a near fix, since the driver may be back, but at the next fix that is not', () => {
    expect(stepOffRoute(OFF, onRoute(520, 41_000)).event).toBeNull()
    expect(stepOffRoute(OFF, onRoute(520, 41_000)).state.near).toBe(1)
    expect(play(OFF, [onRoute(520, 41_000), onRoute(520, 42_000)]).events).toEqual([null, 'back'])
    // Away again, the reminder that was due comes.
    expect(play(OFF, [onRoute(520, 41_000), offBy(80, 42_000)]).events).toEqual([null, 'remind'])
    // And a driver on the route elsewhere, who is being counted, is told they are back and not that they are off.
    expect(play(OFF, driveOn(1500, 40, 20_000)).said).toEqual(['rejoined-elsewhere'])
  })

  it('counts a near fix after a lost stretch like any other', () => {
    const r = play(OFF, [offBy(300, 11_000, { lost: true }), onRoute(500, 12_000), onRoute(500, 13_000)])
    expect(r.events).toEqual([null, null, 'back'])
  })

  it('is back at once for any place when there was nowhere it was left, since there is nowhere to guide to', () => {
    const lost = state('off', { left: null, remindedAt: 10_000 })
    expect(play(lost, [onRoute(1500, 11_000)]).events).toEqual([null])
    const r = play(lost, [onRoute(1500, 11_000), onRoute(1520, 12_000, { furthest: 1530 })])
    expect(r.events).toEqual([null, 'back'])
    expect(r.state).toEqual(blank({ left: { along: 1520, furthest: 1530, at: HERE }, followedAt: 12_000 }))
    // And it still reminds while it is not.
    expect(stepOffRoute(lost, offBy(80, 40_000)).event).toBe('remind')
  })
})

describe('coming back somewhere else', () => {
  const farFix = (t: number, over: Partial<RouteFix> = {}) => offBy(80, t, over)
  /** Three far fixes with four seconds from the first to the last: going off, as it would from the route. */
  const strayed = (make: (t: number) => RouteFix) => play(REJOINED, [make(103_000), make(105_000), make(107_000)]).said

  it('is on the route again at once when a near fix is within 150 metres of the place left', () => {
    const r = stepOffRoute(REJOINED, onRoute(560, 100_500, { furthest: 570, at: spot([1, 560]) }))
    expect(r.event).toBe('back')
    expect(r.state).toEqual(blank({ left: { along: 560, furthest: 570, at: spot([1, 560]) }, followedAt: 100_500 }))
  })

  it('judges that at 149, 150 and 151 metres either side of the place left', () => {
    const at = (along: number) => stepOffRoute(REJOINED, onRoute(along, 100_500)).event
    expect(at(649)).toBe('back')
    expect(at(650)).toBe('back')
    expect(at(651)).toBeNull()
    expect(at(351)).toBe('back')
    expect(at(350)).toBe('back')
    expect(at(349)).toBeNull()
  })

  it('does not call a fix that is not near back, even at the place left', () => {
    for (const f of [onRoute(500, 100_500, { gap: 41 }), onRoute(500, 100_500, { lost: true }), onRoute(500, 100_500, { gap: 50 }), onRoute(500, 100_500, { doubt: true })]) {
      expect(stepOffRoute(REJOINED, f).event).toBeNull()
    }
  })

  it('goes off again for far fixes that go on, like going off from the route: three in a row, and four seconds', () => {
    const r = play(REJOINED, [farFix(103_000), farFix(104_000), farFix(105_000), farFix(106_000), farFix(107_000)])
    expect(r.events).toEqual([null, null, null, null, 'went-off'])
    expect(r.state).toEqual(blank({ phase: 'off', left: LEFT, remindedAt: 107_000, remindedFrom: HERE }))
    expect(play(REJOINED, [farFix(103_000), farFix(105_000), farFix(107_000)]).said).toEqual(['went-off'])
  })

  it('does not go off again at one far fix, nor two, nor three that come within four seconds', () => {
    // On the route the same fix is nothing; a glitch must not be worse after coming back somewhere else.
    expect(stepOffRoute(ON, offBy(61, 103_000)).event).toBeNull()
    expect(stepOffRoute(REJOINED, offBy(61, 103_000)).event).toBeNull()
    const one = stepOffRoute(REJOINED, farFix(103_000))
    expect(one.event).toBeNull()
    expect(one.state).toEqual({ ...REJOINED, far: { fixes: 1, since: 103_000 } })
    expect(play(REJOINED, [farFix(103_000), farFix(104_000)]).said).toEqual([])
    expect(play(REJOINED, [farFix(103_000), farFix(103_500), farFix(106_999)]).said).toEqual([])
  })

  it('starts counting again when a fix that is not far comes between', () => {
    for (const between of [offBy(45, 104_000), onRoute(1450, 104_000), offBy(80, 104_000, { speed: 0 }), onRoute(1450, 104_000, { lost: true })]) {
      const r = play(REJOINED, [farFix(103_000), between, farFix(105_000), farFix(108_000)])
      expect(r.said, JSON.stringify(between)).toEqual([])
      expect(r.state.far, JSON.stringify(between)).toEqual({ fixes: 2, since: 105_000 })
    }
    // Not for one that says too little.
    expect(play(REJOINED, [farFix(103_000), farFix(104_000, { accuracy: 55 }), farFix(105_000), farFix(107_000)]).said).toEqual(['went-off'])
  })

  it('takes far fixes a long way apart in time for none in a row', () => {
    expect(play(REJOINED, [farFix(103_000), farFix(203_000), farFix(203_500)]).said).toEqual([])
  })

  it('does not go off from a fix that is not far', () => {
    expect(strayed((t) => farFix(t, { speed: 1.4 }))).toEqual([])
    expect(strayed((t) => offBy(50, t))).toEqual([])
    expect(strayed((t) => offBy(45, t))).toEqual([])
    expect(strayed((t) => farFix(t, { accuracy: 41 }))).toEqual([])
    expect(strayed((t) => offBy(80.5, t, { accuracy: 40 }))).toEqual(['went-off'])
    expect(strayed((t) => offBy(80, t, { accuracy: 40 }))).toEqual([])
  })

  it('carries on by itself after 60 seconds on the new part of the route', () => {
    expect(stepOffRoute(REJOINED, onRoute(1650, 100_000 + 59_999)).event).toBeNull()
    const r = stepOffRoute(REJOINED, onRoute(1650, 100_000 + 60_000, { furthest: 1655, at: spot([300, 1650]) }))
    expect(r.event).toBe('carried-on')
    expect(r.state).toEqual(blank({ left: { along: 1650, furthest: 1655, at: spot([300, 1650]) }, followedAt: 160_000 }))
  })

  it('carries on with the next fix after the 60 seconds that is on the route, and not one 40 to 50 metres out', () => {
    const r = play(REJOINED, [fix({ gap: 45, along: 1700, furthest: 1700, time: 200_000 }), onRoute(1710, 201_000)])
    expect(r.events).toEqual([null, 'carried-on'])
    expect(r.state.left?.along).toBe(1710)
    // Where it carries on from is a place on the route, and never one that is 45 metres out.
    expect(r.state.left?.at).toBe(HERE)
    expect(stepOffRoute(REJOINED, fix({ gap: 41, along: 1700, furthest: 1700, time: 200_000 })).event).toBeNull()
    expect(stepOffRoute(REJOINED, fix({ gap: 40, along: 1700, furthest: 1700, time: 200_000 })).event).toBe('carried-on')
  })

  it('does not carry on from a fix at a place the tracker is doubting', () => {
    expect(stepOffRoute(REJOINED, onRoute(1700, 200_000, { doubt: true })).event).toBeNull()
  })

  it('does not carry on a phone that is standing still, however long, but when it is on its way again', () => {
    for (const speed of [0, 1.4]) {
      const r = play(REJOINED, run(100, 160_000, (t, i) => onRoute(1650, t, { speed, at: spot([0, 1650 + (i % 3)]) })))
      expect(r.said, `speed ${speed}`).toEqual([])
      expect(r.state).toBe(REJOINED)
    }
    const r = play(REJOINED, [onRoute(1650, 160_000, { speed: 0 }), onRoute(1650, 500_000, { speed: 1.5 })])
    expect(r.events).toEqual([null, 'carried-on'])
    // A speed that is not said is a phone going somewhere, as everywhere else.
    expect(stepOffRoute(REJOINED, onRoute(1650, 160_000, { speed: null })).event).toBe('carried-on')
  })

  it('does not extend the 60 seconds for fixes that are not near', () => {
    const r = play(REJOINED, [offBy(45, 120_000), offBy(45, 140_000), offBy(45, 159_000), onRoute(1700, 160_000)])
    expect(r.events).toEqual([null, null, null, 'carried-on'])
    // Slow ones, too: a driver who stopped is still on the clock.
    const slow = play(REJOINED, [offBy(80, 130_000, { speed: 0 }), onRoute(1700, 160_000)])
    expect(slow.events).toEqual([null, 'carried-on'])
  })

  it('waits for a fix with a place on the route to carry on from, not a lost one', () => {
    const r = play(REJOINED, [offBy(300, 170_000, { speed: 0, lost: true }), onRoute(1700, 171_000)])
    expect(r.events).toEqual([null, 'carried-on'])
    expect(stepOffRoute(REJOINED, onRoute(NaN, 170_000, { gap: 45 })).event).toBeNull()
    expect(stepOffRoute(REJOINED, onRoute(NaN, 170_000, { gap: 45 })).state).toBe(REJOINED)
  })

  it('does not carry on from a fix that says too little', () => {
    const r = stepOffRoute(REJOINED, onRoute(1700, 200_000, { accuracy: 45 }))
    expect(r.state).toBe(REJOINED)
    expect(r.event).toBeNull()
  })

  it('never carries on by itself while no fix has a time to go by', () => {
    expect(stepOffRoute(REJOINED, onRoute(1700, null)).event).toBeNull()
    expect(stepOffRoute(REJOINED, onRoute(1700, NaN)).event).toBeNull()
    const noTime = state('rejoined', { left: LEFT, rejoin: { ...REJOIN, time: null } })
    expect(play(noTime, run(100, 0, () => onRoute(1700, null))).said).toEqual([])
  })

  it('starts the 60 seconds at the first fix that has a time, when the rejoining had none', () => {
    const noTime = state('rejoined', { left: LEFT, rejoin: { ...REJOIN, time: null } })
    const first = stepOffRoute(noTime, onRoute(1700, 500_000))
    expect(first.event).toBeNull()
    expect(first.state.rejoin).toEqual({ ...REJOIN, time: 500_000 })
    expect(stepOffRoute(first.state, onRoute(1750, 559_999)).event).toBeNull()
    expect(stepOffRoute(first.state, onRoute(1750, 560_000)).event).toBe('carried-on')
    // Many fixes after it, with real times: it carries on, rather than waiting for ever.
    const r = play(noTime, run(200, 1000, (t, i) => onRoute(1700 + i, t)))
    expect(r.events.indexOf('carried-on')).toBe(60)
    // A fix with no time before it starts nothing.
    expect(stepOffRoute(noTime, onRoute(1700, null)).state).toBe(noTime)
  })

  it('counts the 60 seconds from an earlier time when the clock goes backwards, rather than waiting for it to come round again', () => {
    const early = stepOffRoute(REJOINED, onRoute(1700, 40_000))
    expect(early.event).toBeNull()
    expect(early.state.rejoin?.time).toBe(40_000)
    expect(stepOffRoute(early.state, onRoute(1700, 99_999)).event).toBeNull()
    expect(stepOffRoute(early.state, onRoute(1700, 100_000)).event).toBe('carried-on')
    // Fixes that are far count too.
    const far = stepOffRoute(REJOINED, farFix(40_000))
    expect(far.state.rejoin?.time).toBe(40_000)
  })

  it('stays as it is for a near fix far along, and for fixes between 40 and 50 metres', () => {
    for (const f of [onRoute(1450, 101_000), offBy(45, 101_000), offBy(80, 101_000, { speed: 0 })]) {
      const r = stepOffRoute(REJOINED, f)
      expect(r.state).toBe(REJOINED)
      expect(r.event).toBeNull()
    }
  })

  it('is on the route again for a driver who comes back to where it was left, even late', () => {
    expect(stepOffRoute(REJOINED, onRoute(500, 100_000 + 50_000)).event).toBe('back')
    // Back beats carrying on, since the place left is where they are going.
    expect(stepOffRoute(REJOINED, onRoute(500, 100_000 + 70_000)).event).toBe('back')
  })

  it('can be told nothing of the rejoining and still not carry on', () => {
    const noRejoin = state('rejoined', { left: LEFT })
    expect(stepOffRoute(noRejoin, onRoute(1700, 999_999_999)).event).toBeNull()
  })
})

describe('being taken back', () => {
  const farFix = (t: number, over: Partial<RouteFix> = {}) => offBy(80, t, { at: spot([80, t / 100]), ...over })

  it('is quiet while the driver is on the new part of the route and no further from the place left than they have been', () => {
    // Where the driver is 900 metres from the place left, driving round and round.
    const r = play(RETURNING, run(500, 0, (t, i) => onRoute(1400 + (i % 40), t)))
    expect(r.said).toEqual([])
    expect(r.state.phase).toBe('returning')
  })

  it('is quiet while the driver is getting nearer to the place left, however far they started', () => {
    const r = play(RETURNING, run(80, 0, (t, i) => onRoute(5000 - 50 * i, t)))
    expect(r.said).toEqual([])
    expect(r.state.rejoin?.along).toBe(5000 - 50 * 79)
    // And is back when they get there.
    const home = play(r.state, run(5, 100_000, (t, i) => onRoute(1000 - 150 * i, t)))
    expect(home.said).toEqual(['back'])
  })

  it('notes how near to the place left the driver has got on the new part of the route, and when', () => {
    const first = stepOffRoute(RETURNING, onRoute(1400, 1000, { furthest: 1401, at: spot([3, 1400]) }))
    expect(first.event).toBeNull()
    expect(first.state).toEqual(blank({ phase: 'returning', left: LEFT, rejoin: { along: 1400, furthest: 1401, at: spot([3, 1400]), time: 1000 } }))
    // Nearer: noted again. No nearer, or further: left as it is.
    const nearer = stepOffRoute(first.state, onRoute(1300, 2000))
    expect(nearer.state.rejoin).toMatchObject({ along: 1300, time: 2000 })
    expect(stepOffRoute(nearer.state, onRoute(1300, 3000)).state).toBe(nearer.state)
    expect(stepOffRoute(nearer.state, onRoute(1350, 3000)).state).toBe(nearer.state)
    // Nearer from the other side of the place left, too.
    expect(stepOffRoute(first.state, onRoute(-300, 2000)).state.rejoin?.along).toBe(-300)
  })

  it('carries on from where the driver is when they have gone on along the route 500 metres further from the place left than they got', () => {
    const at = (along: number, from: OffState = RETURNING) => play(from, [onRoute(1400, 1000), onRoute(along, 2000, { furthest: along + 1, at: spot([0, along]) })])
    // Where they got to is 900 metres from the place left.
    expect(at(1899).said).toEqual([])
    const r = at(1900)
    expect(r.said).toEqual(['carried-on'])
    expect(r.state).toEqual(blank({ left: { along: 1900, furthest: 1901, at: spot([0, 1900]) }, followedAt: 2000 }))
    // On the early side of it as well.
    expect(at(-401).said).toEqual([])
    expect(play(RETURNING, [onRoute(100, 1000), onRoute(-400, 2000)]).said).toEqual(['carried-on'])
    // It counts from the nearest they got, not from where they began.
    const nearer = play(RETURNING, [onRoute(1400, 1000), onRoute(1100, 2000), onRoute(1599, 3000)])
    expect(nearer.said).toEqual([])
    expect(play(RETURNING, [onRoute(1400, 1000), onRoute(1100, 2000), onRoute(1600, 3000)]).said).toEqual(['carried-on'])
  })

  it('counts from the nearest they got on the early side of the place left, too', () => {
    // 400 metres short of it at nearest; 450 is not 500 further.
    expect(play(RETURNING, [onRoute(100, 1000), onRoute(50, 2000)]).said).toEqual([])
    expect(play(RETURNING, [onRoute(100, 1000), onRoute(-400, 2000)]).said).toEqual(['carried-on'])
    expect(play(RETURNING, [onRoute(100, 1000), onRoute(1400, 2000)]).said).toEqual(['carried-on'])
  })

  it('keeps how near they got through fixes that are not near the route', () => {
    for (const between of [offBy(45, 1500), onRoute(1500, 1500, { lost: true }), offBy(80, 1500, { speed: 0 }), onRoute(1500, 1500, { doubt: true })]) {
      expect(play(RETURNING, [onRoute(1400, 1000), between, onRoute(1899, 2000)]).said, JSON.stringify(between)).toEqual([])
      expect(play(RETURNING, [onRoute(1400, 1000), between, onRoute(1900, 2000)]).said, JSON.stringify(between)).toEqual(['carried-on'])
    }
  })

  it('goes by where they came back onto the route when they were asked, and chose to be taken back', () => {
    const back = takeMeBack(REJOINED)
    expect(back.rejoin).toEqual(REJOIN)
    expect(stepOffRoute(back, onRoute(1899, 150_000)).event).toBeNull()
    expect(stepOffRoute(back, onRoute(1900, 150_000)).event).toBe('carried-on')
  })

  it('carries on whatever the time, since it is about the ground', () => {
    expect(play(RETURNING, [onRoute(1400, null), onRoute(1900, null)]).said).toEqual(['carried-on'])
  })

  it('is back after two near fixes in a row close to the place left', () => {
    const r = play(RETURNING, [onRoute(480, 1000), onRoute(470, 2000, { furthest: 520, at: spot([1, 470]) })])
    expect(r.events).toEqual([null, 'back'])
    expect(r.state).toEqual(blank({ left: { along: 470, furthest: 520, at: spot([1, 470]) }, followedAt: 2000 }))
  })

  it('is back only if it is 150 metres or less from the place left', () => {
    const at = (along: number) => play(RETURNING, [onRoute(along, 1000), onRoute(along, 2000)]).events[1]
    expect(at(650)).toBe('back')
    expect(at(651)).toBeNull()
    expect(at(350)).toBe('back')
    expect(at(349)).toBeNull()
  })

  it('keeps its count through near fixes far along, and does not reset it', () => {
    const r = play(RETURNING, [onRoute(480, 1000), onRoute(1000, 1500), onRoute(490, 2000)])
    expect(r.events).toEqual([null, null, 'back'])
    const first = play(RETURNING, [onRoute(1000, 1500), onRoute(490, 2000)])
    expect(first.state.near).toBe(1)
  })

  it('loses its count to any other fix', () => {
    for (const between of [offBy(45, 1500), offBy(80, 1500, { speed: 0 }), onRoute(500, 1500, { lost: true }), onRoute(500, 1500, { doubt: true })]) {
      const r = play(RETURNING, [onRoute(480, 1000), between, onRoute(490, 2000)])
      expect(r.said, JSON.stringify(between)).toEqual([])
      expect(r.state.near).toBe(1)
    }
  })

  it('does not lose its count to a fix that says too little', () => {
    expect(play(RETURNING, [onRoute(480, 1000), offBy(80, 1500, { accuracy: 50 }), onRoute(490, 2000)]).said).toEqual(['back'])
  })

  it('is off again for far fixes that go on, and then reminds', () => {
    const r = play(RETURNING, [farFix(5000), farFix(6000), farFix(7000), farFix(8000), farFix(9000)])
    expect(r.events).toEqual([null, null, null, null, 'went-off'])
    expect(r.state).toEqual(blank({ phase: 'off', left: LEFT, remindedAt: 9000, remindedFrom: spot([80, 90]) }))
    expect(stepOffRoute(r.state, farFix(35_000)).event).toBeNull()
    expect(stepOffRoute(r.state, farFix(39_000)).event).toBe('remind')
  })

  it('is not off again at one far fix, nor two, nor three that are quick', () => {
    expect(stepOffRoute(RETURNING, farFix(5000)).event).toBeNull()
    expect(stepOffRoute(RETURNING, farFix(5000)).state.far).toEqual({ fixes: 1, since: 5000 })
    expect(play(RETURNING, [farFix(5000), farFix(6000)]).said).toEqual([])
    expect(play(RETURNING, [farFix(5000), farFix(6000), farFix(8999)]).said).toEqual([])
    expect(play(RETURNING, [farFix(5000), farFix(500_000), farFix(500_500)]).said).toEqual([])
  })

  it('starts counting again when a fix that is not far comes between', () => {
    for (const between of [offBy(45, 6000), onRoute(1450, 6000), onRoute(1450, 6000, { lost: true })]) {
      const r = play(RETURNING, [farFix(5000), between, farFix(7000), farFix(9500)])
      expect(r.said, JSON.stringify(between)).toEqual([])
    }
  })

  it('does not go off again from fixes that are not far', () => {
    for (const f of [offBy(50, 5000), offBy(80, 5000, { speed: 1.4 }), offBy(80, 5000, { accuracy: 41 })]) {
      expect(play(RETURNING, [f, { ...f, time: 7000 }, { ...f, time: 9000 }]).said).toEqual([])
    }
  })

  it('never reminds', () => {
    const r = play(RETURNING, run(100, 0, (t) => offBy(45, t)))
    expect(r.said).toEqual([])
  })

  it('is back for any place when there was nowhere it was left', () => {
    const lost = state('returning', { left: null })
    expect(play(lost, [onRoute(5000, 1000), onRoute(5000, 2000)]).events).toEqual([null, 'back'])
  })
})

describe('the driver choosing to carry on from here', () => {
  const here = fix({ along: 1650, furthest: 1660, at: spot([300, 1650]), time: 150_000 })

  it('puts the round on the route again from this place, whatever it was doing', () => {
    for (const [name, s] of PHASES.slice(1)) {
      const busy = { ...s, far: { fixes: 2, since: 5 }, near: 1, nearFrom: HERE, away: true, remindedAt: 9, remindedFrom: HERE, rejoin: REJOIN }
      expect(carryOnHere(busy, here), name).toEqual(blank({ left: place(here) }))
    }
  })

  it('has nothing to do on the route, and gives the same state back', () => {
    expect(carryOnHere(ON, here)).toBe(ON)
    expect(carryOnHere(startOffRoute, here)).toBe(startOffRoute)
  })

  it('does not ask a fix to be accurate, since the driver chose it', () => {
    expect(carryOnHere(REJOINED, { ...here, accuracy: 120 }).left).toEqual(place(here))
  })

  it('takes the place where the driver came back onto the route when this place is not a real one', () => {
    for (const bad of [{ along: NaN }, { furthest: Infinity }, { at: { lat: NaN, lng: 0 } }, { at: { lat: 0, lng: NaN } }]) {
      const r = carryOnHere(REJOINED, { ...here, ...bad })
      expect(r.phase).toBe('on')
      expect(r.left).toEqual({ along: REJOIN.along, furthest: REJOIN.furthest, at: REJOIN.at })
      // With nowhere they came back to, it keeps the place left.
      expect(carryOnHere(OFF, { ...here, ...bad }).left).toBe(LEFT)
    }
  })

  it('takes the furthest reached there as it was, not the place along the route', () => {
    const odd = state('rejoined', { left: LEFT, rejoin: { along: 1400, furthest: 1390, at: spot([300, 1400]), time: 100_000 } })
    expect(carryOnHere(odd, { ...here, lost: true }).left).toEqual({ along: 1400, furthest: 1390, at: spot([300, 1400]) })
  })

  it('does not take a place off the route from a fix that is lost or doubted, but where the driver came back onto it', () => {
    for (const over of [{ lost: true, gap: 300 }, { doubt: true }]) {
      const r = carryOnHere(REJOINED, { ...here, ...over })
      expect(r.phase).toBe('on')
      expect(r.left).toEqual({ along: REJOIN.along, furthest: REJOIN.furthest, at: REJOIN.at })
      expect(carryOnHere(OFF, { ...here, ...over }).left).toBe(LEFT)
    }
  })

  it('works when nothing was left', () => {
    expect(carryOnHere(state('off', { left: null }), here).left).toEqual(place(here))
  })

  it('goes on to be judged from the new place', () => {
    const r = play(carryOnHere(REJOINED, here), [onRoute(1700, 151_000), offBy(80, 152_000), offBy(80, 154_000), offBy(80, 156_000)])
    expect(r.events).toEqual([null, null, null, 'went-off'])
    expect(r.state.left?.along).toBe(1700)
  })
})

describe('the driver choosing to be taken back', () => {
  it('guides to where the route was left, as before', () => {
    for (const [name, s] of PHASES.slice(1)) {
      const busy = { ...s, far: { fixes: 2, since: 5 }, near: 1, nearFrom: HERE, away: true, remindedAt: 9, remindedFrom: HERE, rejoin: REJOIN }
      // Only a driver who has come back onto the route has anywhere they came back to.
      expect(takeMeBack(busy), name).toEqual(blank({ phase: 'returning', left: LEFT, rejoin: name === 'rejoined' ? REJOIN : null }))
    }
  })

  it('has nothing to do on the route, and gives the same state back', () => {
    expect(takeMeBack(ON)).toBe(ON)
    expect(takeMeBack(startOffRoute)).toBe(startOffRoute)
  })

  it('goes back on the route when there is nowhere to be taken back to', () => {
    for (const phase of ['off', 'returning', 'rejoined'] as const) {
      expect(takeMeBack(state(phase, { left: null, near: 1, nearFrom: HERE, away: true, remindedAt: 5, remindedFrom: HERE, rejoin: REJOIN })), phase).toEqual(BLANK)
    }
  })

  it('stops the reminders', () => {
    expect(play(OFF, run(100, 10_000, (t) => offBy(45, t))).said).toContain('remind')
    expect(play(takeMeBack(OFF), run(100, 10_000, (t) => offBy(45, t))).said).toEqual([])
  })

  it('is judged as being taken back from then on', () => {
    const r = play(takeMeBack(REJOINED), [onRoute(1500, 150_000), onRoute(1600, 151_000), onRoute(480, 152_000), onRoute(490, 153_000)])
    expect(r.events).toEqual([null, null, null, 'back'])
  })
})

describe('what the screen keeps beside the machine', () => {
  /** A fix from the phone, as the screen watches every one: when, and how accurate. */
  const raw = (time: number | null | undefined, accuracy = 10) => ({ accuracy, time })
  /** The watch after a fix at each of these times (good ones), from nothing. */
  const after = (...times: number[]) => times.reduce<OffWatch>((w, t) => watchFix(w, raw(t)), startOffWatch)
  /** The jump of the drives above, 1000 m along the route from where it was last followed, at the start of the clock. */
  const FOLLOWED = state('on', { left: LEFT, followedAt: 0 })
  const jumpAt = (time: number) => onRoute(1500, time, { at: spot([100, 520]) })

  describe('taking the phone for unseen', () => {
    it('is not, at the first fix to go by, however late, nor for fixes up to 10 seconds apart', () => {
      expect(after(500_000)).toEqual({ goodAt: 500_000, blind: false, arrived: false })
      expect(after(0, 10_000, 20_000)).toEqual({ goodAt: 20_000, blind: false, arrived: false })
    })

    it('is, once more than 10 seconds have gone without a fix to go by: no fixes at all, as with Safari in the background', () => {
      expect(after(0, 10_001)).toEqual({ goodAt: 10_001, blind: true, arrived: false })
      // And stays so, whatever comes after, until the machine follows the route from a new place.
      expect(after(0, 10_001, 11_001, 12_001).blind).toBe(true)
    })

    it('is, when the fixes in between are too poor to go by (worse than 40 m): to the machine they are none', () => {
      let w = after(0)
      for (let t = 1000; t <= 20_000; t += 1000) w = watchFix(w, raw(t, 41))
      expect(w).toEqual(after(0))
      expect(watchFix(w, raw(21_000)).blind).toBe(true)
      // A fix of 40 m is one to go by.
      let fair = after(0)
      for (let t = 1000; t <= 21_000; t += 1000) fair = watchFix(fair, raw(t, 40))
      expect(fair).toEqual({ goodAt: 21_000, blind: false, arrived: false })
    })

    it('goes by nothing from a fix with no time, or with an accuracy that is not a real one', () => {
      const w = after(0)
      for (const f of [raw(null), raw(undefined), raw(Number.NaN), raw(20_000, Number.NaN), raw(20_000, -1)]) expect(watchFix(w, f), JSON.stringify(f)).toBe(w)
    })

    it('takes a clock gone backwards for no time passed, and goes on from the earlier time', () => {
      expect(after(60_000, 30_000)).toEqual({ goodAt: 30_000, blind: false, arrived: false })
      expect(after(60_000, 30_000, 40_001).blind).toBe(true)
    })

    it('is so for a fix the machine would have been asked about and was not (beside a stop away from the route): the place last followed is not kept up', () => {
      const w = after(0, 1000)
      expect(unasked(w)).toEqual({ ...w, blind: true })
      const blind = unasked(w)
      expect(unasked(blind)).toBe(blind)
      // A minute on, the driver is asked about again, 1000 m on along the route: that is taken up, as after a gap in the fixes.
      const r = stepWatched({ ...blind, arrived: true }, FOLLOWED, jumpAt(60_000), 0)
      expect(r.event).toBeNull()
      expect(r.state.left!.along).toBe(1500)
      expect(stepWatched({ ...w, arrived: true }, FOLLOWED, jumpAt(60_000), 0).state.near).toBe(1)
    })
  })

  describe('asking the machine', () => {
    it('tells it whether the phone was unseen, and so a jump from the place last followed is taken up if the time explains it', () => {
      // (Long since there, at the start of the route.)
      const unseen = { ...after(0, 60_000), arrived: true }
      const r = stepWatched(unseen, FOLLOWED, jumpAt(60_000), 0)
      expect(r.fix).toMatchObject({ blind: true, approaching: false })
      expect(r.event).toBeNull()
      expect(r.state.left!.along).toBe(1500)
      // Without the gap, it is held back.
      expect(stepWatched({ ...after(59_000, 60_000), arrived: true }, FOLLOWED, jumpAt(60_000), 0).state.near).toBe(1)
    })

    it('sees the phone again once the machine follows the route from a new place, and not before', () => {
      const unseen = { ...after(0, 60_000), arrived: true }
      // A fix at a place the tracker is doubting, one that says too little, and one between 40 and 50 m out keep the place last followed: still unseen.
      for (const f of [onRoute(1500, 60_000, { doubt: true }), onRoute(1500, 60_000, { accuracy: 55 }), offBy(45, 60_000)]) {
        const r = stepWatched(unseen, FOLLOWED, f, 0)
        expect(r.state.left, JSON.stringify(f)).toBe(LEFT)
        expect(r.watch, JSON.stringify(f)).toBe(unseen)
      }
      // A jump held back (the time not explaining it) keeps it too.
      const held = stepWatched(unseen, FOLLOWED, jumpAt(30_000), 0)
      expect(held.state.near).toBe(1)
      expect(held.watch.blind).toBe(true)
      // On along the route from a new place: seen.
      const on = stepWatched(unseen, FOLLOWED, onRoute(520, 61_000, { at: spot([0, 520]) }), 0)
      expect(on.state.left!.along).toBe(520)
      expect(on.watch).toEqual({ ...unseen, blind: false })
    })

    it('does not see the phone again for a new place off the route, which is not followed', () => {
      // Back on the route somewhere else, and asked: the place it was left is kept until the driver says, and so is the phone unseen.
      const unseen = { ...after(0, 60_000), arrived: true }
      const r = stepWatched(unseen, state('off', { left: LEFT, near: 1, nearFrom: spot([100, 400]) }), jumpAt(60_000), 0)
      expect(r.event).toBe('rejoined-elsewhere')
      expect(r.watch.blind).toBe(true)
    })

    it('tells it the phone is on its way to where the round starts until it has been on the route within 100 m along it of the spot, going by the fixes before', () => {
      let w = after(0)
      const at = (along: number, over: Partial<RouteFix> = {}) => {
        const r = stepWatched(w, BLANK, onRoute(along, 1000, over), 2200)
        w = r.watch
        return r.fix.approaching
      }
      expect(at(1500)).toBe(true)
      expect(at(2099)).toBe(true)
      expect(w.arrived).toBe(false)
      // The fix that gets there is still on the way (a jump that lands at the spot is the way there): the next is not.
      expect(at(2100)).toBe(true)
      expect(w.arrived).toBe(true)
      expect(at(2100)).toBe(false)
      expect(at(500)).toBe(false)
    })

    it('takes a fix past the spot for being there, and not one that is not on the route', () => {
      expect(stepWatched(startOffWatch, BLANK, onRoute(5000, 1000), 2200).watch.arrived).toBe(true)
      for (const over of [{ lost: true }, { doubt: true }, { gap: 41 }, { gap: 80 }, { accuracy: 41 }]) {
        expect(stepWatched(startOffWatch, BLANK, onRoute(2200, 1000, over), 2200).watch.arrived, JSON.stringify(over)).toBe(false)
      }
    })

    it('is there at once for a round from the start of the route', () => {
      const r = stepWatched(startOffWatch, BLANK, onRoute(5, 1000), 0)
      expect(r.watch.arrived).toBe(true)
    })

    it('gives the same watch back when nothing it keeps has changed', () => {
      const w = { ...after(0, 1000), arrived: true }
      expect(stepWatched(w, FOLLOWED, onRoute(520, 1000, { at: spot([0, 520]) }), 0).watch).toBe(w)
    })
  })

  it('starts again on the way, with nothing followed, for a round started, skipped to or carried on from somewhere, and keeps when the last fix came', () => {
    expect(restartWatch({ goodAt: 30_000, blind: true, arrived: true })).toEqual({ goodAt: 30_000, blind: false, arrived: false })
    expect(restartWatch(startOffWatch)).toEqual(startOffWatch)
  })
})

describe('guiding the driver back', () => {
  const driver = spot([0, 0])
  const target = (xy: [number, number]): LeftAt => ({ along: 0, furthest: 0, at: spot(xy) })

  it('says how far, to the nearest metre', () => {
    expect(guideToLeft(driver, target([0, 100]), null).metres).toBe(100)
    expect(guideToLeft(driver, target([0, 100.4]), null).metres).toBe(100)
    expect(guideToLeft(driver, target([0, 100.6]), null).metres).toBe(101)
    expect(guideToLeft(driver, target([300, 400]), null).metres).toBe(Math.round(haversine(driver, spot([300, 400]))))
    expect(guideToLeft(driver, target([300, 400]), null).metres).toBe(500)
  })

  it('says which way, for the way the phone is heading', () => {
    // The place is 100 metres north of the driver.
    const north = target([0, 100])
    expect(guideToLeft(driver, north, 0).where).toBe('ahead')
    expect(guideToLeft(driver, north, 180).where).toBe('behind')
    expect(guideToLeft(driver, north, 90).where).toBe('on your left')
    expect(guideToLeft(driver, north, 270).where).toBe('on your right')
  })

  it('says on your right for a place to the east of a driver heading north, and on your left for the west', () => {
    expect(guideToLeft(driver, target([100, 0]), 0).where).toBe('on your right')
    expect(guideToLeft(driver, target([-100, 0]), 0).where).toBe('on your left')
    expect(guideToLeft(driver, target([0, -100]), 0).where).toBe('behind')
  })

  it('goes by where the place is, not just which way the phone points', () => {
    const east = target([100, 0])
    expect(guideToLeft(driver, east, 90).where).toBe('ahead')
    expect(guideToLeft(driver, east, 270).where).toBe('behind')
    expect(guideToLeft(driver, east, 180).where).toBe('on your left')
    expect(guideToLeft(driver, east, 0).where).toBe('on your right')
  })

  it('goes by the nearest of the four to a place between them', () => {
    expect(guideToLeft(driver, target([60, 100]), 0).where).toBe('ahead')
    expect(guideToLeft(driver, target([100, 60]), 0).where).toBe('on your right')
    expect(guideToLeft(driver, target([-100, -60]), 0).where).toBe('on your left')
    expect(guideToLeft(driver, target([60, -100]), 0).where).toBe('behind')
  })

  it('does not say which way when the phone cannot say its heading', () => {
    expect(guideToLeft(driver, target([0, 100]), null)).toEqual({ metres: 100, where: null })
    expect(guideToLeft(driver, target([0, 100]), NaN)).toEqual({ metres: 100, where: null })
    expect(guideToLeft(driver, target([0, 100]), Infinity)).toEqual({ metres: 100, where: null })
  })

  it('does not say which way when the driver is on the very spot', () => {
    expect(guideToLeft(driver, target([0, 0]), 90)).toEqual({ metres: 0, where: null })
    expect(guideToLeft(driver, target([0, 0.4]), 90)).toEqual({ metres: 0, where: null })
    expect(guideToLeft(driver, target([0, 0.6]), 0)).toEqual({ metres: 1, where: 'ahead' })
  })

  it('does not say which way for a place that is not a real one, and says no distance rather than not a number', () => {
    expect(guideToLeft(driver, { along: 0, furthest: 0, at: { lat: NaN, lng: 0 } }, 90)).toEqual({ metres: 0, where: null })
    expect(guideToLeft({ lat: NaN, lng: 0 }, target([0, 100]), 0)).toEqual({ metres: 0, where: null })
    expect(guideToLeft({ lat: 0, lng: Infinity }, target([0, 100]), 0).metres).toBe(0)
  })
})

describe('what is said', () => {
  it('has words for each thing that happens', () => {
    expect(offRouteSpeech('went-off')).toBe('Off route.')
    expect(offRouteSpeech('remind')).toBe('Still off route.')
    expect(offRouteSpeech('back')).toBe('Back on route.')
    expect(offRouteSpeech('carried-on')).toBe('Carrying on from here.')
  })

  it('says how far further on the route was picked up', () => {
    expect(offRouteSpeech('rejoined-elsewhere', 800)).toBe('Back on the route, 800 metres further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 810)).toBe('Back on the route, 800 metres further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 830)).toBe('Back on the route, 850 metres further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 160)).toBe('Back on the route, 150 metres further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 99)).toBe('Back on the route, 100 metres further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 94)).toBe('Back on the route, 90 metres further on.')
  })

  it('says earlier on when it was before the place left', () => {
    expect(offRouteSpeech('rejoined-elsewhere', -800)).toBe('Back on the route, 800 metres earlier on.')
    expect(offRouteSpeech('rejoined-elsewhere', -160)).toBe('Back on the route, 150 metres earlier on.')
  })

  it('says kilometres to one decimal from a thousand metres', () => {
    expect(offRouteSpeech('rejoined-elsewhere', 1200)).toBe('Back on the route, 1.2 kilometres further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 1249)).toBe('Back on the route, 1.2 kilometres further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 1250)).toBe('Back on the route, 1.3 kilometres further on.')
    expect(offRouteSpeech('rejoined-elsewhere', -1200)).toBe('Back on the route, 1.2 kilometres earlier on.')
    expect(offRouteSpeech('rejoined-elsewhere', 12_345)).toBe('Back on the route, 12.3 kilometres further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 1949)).toBe('Back on the route, 1.9 kilometres further on.')
  })

  it('says a whole number of kilometres without the point, which a voice reads out as zero', () => {
    expect(offRouteSpeech('rejoined-elsewhere', 1000)).toBe('Back on the route, 1 kilometre further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 1049)).toBe('Back on the route, 1 kilometre further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 1050)).toBe('Back on the route, 1.1 kilometres further on.')
    expect(offRouteSpeech('rejoined-elsewhere', -1000)).toBe('Back on the route, 1 kilometre earlier on.')
    expect(offRouteSpeech('rejoined-elsewhere', 1960)).toBe('Back on the route, 2 kilometres further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 2000)).toBe('Back on the route, 2 kilometres further on.')
    expect(offRouteSpeech('rejoined-elsewhere', -12_000)).toBe('Back on the route, 12 kilometres earlier on.')
  })

  it('says metres up to what is said as a thousand, and then a kilometre, not a thousand metres', () => {
    expect(offRouteSpeech('rejoined-elsewhere', 999)).toBe('Back on the route, 1 kilometre further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 999.9)).toBe('Back on the route, 1 kilometre further on.')
    expect(offRouteSpeech('rejoined-elsewhere', 975)).toBe('Back on the route, 1 kilometre further on.')
    expect(offRouteSpeech('rejoined-elsewhere', -975)).toBe('Back on the route, 1 kilometre earlier on.')
    expect(offRouteSpeech('rejoined-elsewhere', 974)).toBe('Back on the route, 950 metres further on.')
  })

  it('says only that it is back when it does not know how far, or it comes to nothing', () => {
    expect(offRouteSpeech('rejoined-elsewhere')).toBe('Back on the route.')
    expect(offRouteSpeech('rejoined-elsewhere', 0)).toBe('Back on the route.')
    expect(offRouteSpeech('rejoined-elsewhere', 4)).toBe('Back on the route.')
    expect(offRouteSpeech('rejoined-elsewhere', -4)).toBe('Back on the route.')
    expect(offRouteSpeech('rejoined-elsewhere', NaN)).toBe('Back on the route.')
    expect(offRouteSpeech('rejoined-elsewhere', Infinity)).toBe('Back on the route.')
    expect(offRouteSpeech('rejoined-elsewhere', 5)).toBe('Back on the route, 10 metres further on.')
  })

  it('says the same whatever the distance for the others', () => {
    expect(offRouteSpeech('went-off', 5000)).toBe('Off route.')
    expect(offRouteSpeech('remind', -5000)).toBe('Still off route.')
  })
})

describe('doing no harm', () => {
  const fixes: [string, RouteFix][] = [
    ['a near fix', onRoute(520, 50_000)],
    ['a near fix far along', onRoute(1450, 150_000)],
    ['a far fix', offBy(80, 50_000)],
    ['a fix between', offBy(45, 50_000)],
    ['a poor fix', offBy(80, 50_000, { accuracy: 90 })],
    ['a lost fix', offBy(300, 50_000, { lost: true })],
    ['a fix with no time', onRoute(520, null)],
    ['a late fix', onRoute(520, 200_000)],
  ]

  it('never changes what it is given', () => {
    for (const [name, s] of PHASES) {
      for (const [what, f] of fixes) {
        const frozenState = deepFreeze(structuredClone(s))
        const frozenFix = deepFreeze(structuredClone(f))
        expect(() => stepOffRoute(frozenState, frozenFix), `${name} with ${what}`).not.toThrow()
        expect(frozenState).toEqual(s)
        expect(frozenFix).toEqual(f)
      }
    }
    for (const [name, s] of PHASES) {
      const frozenState = deepFreeze(structuredClone(s))
      expect(() => carryOnHere(frozenState, deepFreeze(fix())), name).not.toThrow()
      expect(() => takeMeBack(frozenState), name).not.toThrow()
    }
    expect(() => guideToLeft(deepFreeze(spot([0, 0])), deepFreeze(structuredClone(LEFT)), 90)).not.toThrow()
  })

  it('gives the same answer to the same question', () => {
    for (const [name, s] of PHASES) {
      for (const [what, f] of fixes) expect(stepOffRoute(s, f), `${name} with ${what}`).toEqual(stepOffRoute(structuredClone(s), structuredClone(f)))
    }
  })

  it('gives a new state, not the one it was given, when something changes', () => {
    const r = stepOffRoute(ON, onRoute(700, 1000))
    expect(r.state).not.toBe(ON)
    expect(ON.left).toBe(LEFT)
    expect(r.state.left).not.toBe(LEFT)
  })

  it('copes with a state that has nowhere left, in every phase and for every kind of fix', () => {
    for (const phase of ['on', 'off', 'returning', 'rejoined'] as const) {
      const s = state(phase, { left: null, rejoin: phase === 'rejoined' ? REJOIN : null })
      for (const [what, f] of fixes) {
        expect(() => stepOffRoute(s, f), `${phase} with ${what}`).not.toThrow()
        expect(stepOffRoute(s, f).state.left === null || Number.isFinite(stepOffRoute(s, f).state.left!.along)).toBe(true)
      }
    }
  })

  it('copes with places and distances that are not numbers', () => {
    const awkward = [NaN, Infinity, -Infinity, 0, -5, 1e12]
    for (const [name, s] of PHASES) {
      for (const gap of awkward) {
        for (const along of awkward) {
          for (const lost of [false, true]) {
            const r = stepOffRoute(deepFreeze(structuredClone(s)), fix({ gap, along, furthest: along, lost, time: 50_000 }))
            if (r.state.left) expect(Number.isFinite(r.state.left.along), `${name} ${gap} ${along}`).toBe(true)
            if (r.state.rejoin) expect(Number.isFinite(r.state.rejoin.along), `${name} ${gap} ${along}`).toBe(true)
          }
        }
      }
    }
  })
})

// ---- Drives: a car on a road with a GPS, played through the real tracker and then this machine ----

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

type XY = [number, number]
/** A place to drive through, and how many seconds to stand still there (none, if left out). */
type Waypoint = XY | [number, number, number]

/** How far a spot is from a path, in metres. */
function distToPath(p: XY, path: XY[]): number {
  let best = Infinity
  for (let i = 0; i < path.length - 1; i++) {
    const [ax, ay] = path[i]
    const [bx, by] = path[i + 1]
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / len2))
    best = Math.min(best, Math.hypot(p[0] - (ax + t * (bx - ax)), p[1] - (ay + t * (by - ay))))
  }
  return best
}

interface DriveOptions {
  /** Metres a second: 10 is about 36 km/h. */
  speed?: number
  /** Metres of noise on each fix, in both directions. */
  noise?: number
  /** How much of the last fix's error carries over into the next (0 to 1). */
  carry?: number
  /** What the fix claims its accuracy is, in metres. */
  accuracy?: number
  seed?: number
  headingNoise?: number
  /** Whether the phone gives its course at all. */
  heading?: boolean
  /** The fixes from this one to that one (counting from 0) give a course the wrong way round. */
  flipHeading?: [number, number]
  /** These fixes (counting from 0) are this far out, in the direction given, though they claim to be as accurate as ever. */
  glitch?: { at: number[]; dx: number; dy: number; accuracy?: number }
  time0?: number
  progress?: Progress | null
  /**
   * The round was started (or skipped) this many metres along the route, from `startProgress` there: the machine is only asked once the route
   * is reached, as the Round screen does (REACH_NEAR_M and REACH_RUN_M in Round.tsx): at once on it within 100 metres along it of the start,
   * anywhere else after 200 metres on it. Until then the tracker may find its pass, a long way from where it was put, with nothing said.
   */
  startAt?: number
  state?: OffState
  /** Called after each fix is judged: the driver may press a button, by giving back the state it leaves. */
  act?: (beat: Beat) => OffState | undefined
  /** Called after that, with the progress, and may give back another: what the screen does with it, such as keeping how far the driver has got down. */
  adjust?: (progress: Progress, machine: OffState) => Progress
  /** Instead of driving a path, these exact places, a fix a second: with, as a third number, how fast the phone says it is going there (0 for a stop), or `speed`. */
  exact?: Waypoint[]
  /** The phone never says how fast it is going, moving or not. */
  nullSpeed?: boolean
  /** No fixes at all for the seconds from the first of these to the second (counting from the start of the drive). */
  drop?: [number, number]
  /**
   * Poor fixes for the seconds from the first of these to the second (counted as `drop` counts them): they claim POOR_ACCURACY_M of accuracy and
   * are out by POOR_NOISE_M of noise, which the tracker still takes in but the machine cannot go by.
   */
  poor?: [number, number]
  /** Leave out what the tracker says about holding the driver's old place while it is unsure, as a screen that did not pass it on would. */
  unaware?: boolean
  /** Give the machine the distance to the place the tracker chose (its `gap`), which is not what the screen does, to show what that would do. */
  gap?: 'tracker'
}

interface Beat {
  /** Which fix this is, counting from 0 over the whole drive. */
  i: number
  time: number
  /** Where the car truly is, and how far that is from the route. */
  truth: XY
  out: number
  progress: Progress | null
  /** What the machine was given, if the tracker moved the driver (otherwise it was not asked): with what the watch knows. */
  routeFix: RouteFix | null
  /** What the machine made of it, before any button the driver pressed in answer. */
  state: OffState
  event: OffEvent
  /** What the screen keeps beside the machine (see `OffWatch`), after this fix. */
  watch: OffWatch
}

interface Drive {
  beats: Beat[]
  /** What was said, in order, with the fix it was said at. */
  said: { event: Exclude<OffEvent, null>; beat: Beat }[]
  state: OffState
  progress: Progress | null
  /** The time after the last fix, in milliseconds. */
  clock: number
}

/** What a poor fix claims its accuracy is, and how far out it is, in metres (see `DriveOptions.poor`). */
const POOR_ACCURACY_M = 50
const POOR_NOISE_M = 15

/**
 * Drive a car along `path`, a fix a second, and judge each fix as the Round screen does: every fix kept in the watch, the tracker,
 * and the machine only when the tracker moved the driver (a phone standing still gives back the same progress), told what the
 * watch knows by the same functions the screen uses.
 */
function drive(route: XY[], path: Waypoint[], o: DriveOptions = {}): Drive {
  const { speed = 10, noise = 5, carry = 0.5, seed = 1, headingNoise = 10, heading = true } = o
  const track = makeTrack(route.map(spot))
  const accuracy = o.accuracy ?? Math.max(5, noise * 1.5)
  const r = random(seed)
  const cum = [0]
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]))
  const total = cum[cum.length - 1]
  const where = (s: number): { xy: XY; course: number } => {
    let i = 0
    while (i < path.length - 2 && cum[i + 1] < s) i++
    const t = cum[i + 1] > cum[i] ? Math.min(1, Math.max(0, (s - cum[i]) / (cum[i + 1] - cum[i]))) : 0
    const dx = path[i + 1][0] - path[i][0]
    const dy = path[i + 1][1] - path[i][1]
    return { xy: [path[i][0] + dx * t, path[i][1] + dy * t], course: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360 }
  }
  const exactAt = (i: number): { xy: XY; course: number; pace: number } => {
    const here = o.exact![i]
    const before = o.exact![Math.max(0, i - 1)]
    return { xy: [here[0], here[1]], course: ((Math.atan2(here[0] - before[0], here[1] - before[1]) * 180) / Math.PI + 360) % 360, pace: here[2] ?? speed }
  }
  const waits = path.flatMap((w, i) => (w.length === 3 && w[2] > 0 ? [{ s: cum[i], seconds: w[2] }] : []))

  let progress = o.progress ?? (o.startAt === undefined ? null : startProgress(track, o.startAt))
  let machine = o.state ?? startOffRoute
  // Whether the route has been reached, and where the run on it that counts towards that began (see `startAt`).
  let reached = o.startAt === undefined
  let reachRun: Pt | null = null
  const reaches = (p: Progress): boolean => {
    if (reached) return true
    if (p.lost || p.gap > ON_ROUTE_M || p.accuracy > OFF_MAX_ACCURACY_M) {
      reachRun = null
      return false
    }
    reachRun ??= p.at
    reached = Math.abs(p.along - o.startAt!) <= 100 || haversine(reachRun, p.at) >= 200
    return reached
  }
  // What the screen keeps beside the machine, and where the round starts from (the start of the route, for a round not started part way).
  let watch = startOffWatch
  const from = o.startAt ?? 0
  let clock = o.time0 ?? 0
  let err = [0, 0]
  const beats: Beat[] = []
  const said: Drive['said'] = []
  // The seconds of the drive so far, for `drop` and `poor`.
  let taken = 0
  const inside = (w: [number, number] | undefined) => w !== undefined && taken >= w[0] && taken < w[1]
  const fixAt = (s: number, moving: boolean) => {
    const i = beats.length
    const { xy, course, pace } = o.exact ? exactAt(i) : { ...where(s), pace: speed }
    const going = moving && pace > 0
    const poor = inside(o.poor)
    err = err.map((e) => carry * e + Math.sqrt(1 - carry * carry) * gaussian(r) * (poor ? POOR_NOISE_M : noise))
    const glitching = o.glitch?.at.includes(i)
    const seen: XY = [xy[0] + err[0] + (glitching ? o.glitch!.dx : 0), xy[1] + err[1] + (glitching ? o.glitch!.dy : 0)]
    const claimed = glitching ? (o.glitch!.accuracy ?? accuracy) : poor ? POOR_ACCURACY_M : accuracy
    const gps = { ...spot(seen), accuracy: claimed, time: clock, speed: o.nullSpeed ? null : going ? pace : 0 }
    const flipped = o.flipHeading && i >= o.flipHeading[0] && i <= o.flipHeading[1]
    const hdg = heading && going && pace >= 1.5 && i >= 1 ? (course + (flipped ? 180 : 0) + gaussian(r) * headingNoise + 720) % 360 : null
    // Every fix the phone gives is watched, before the tracker has it.
    watch = watchFix(watch, gps)
    const before = progress
    progress = advance(track, progress, gps, hdg)
    if (progress && progress !== before && o.adjust) progress = o.adjust(progress, machine)
    let routeFix: RouteFix | null = null
    let event: OffEvent = null
    if (progress && progress !== before && reaches(progress)) {
      const p = progress
      // The distance to the nearest part of the route, as the screen gives it, not to the place the tracker chose (which it may be holding).
      routeFix = { time: p.time, at: p.at, accuracy: p.accuracy, speed: gps.speed, gap: o.gap === 'tracker' ? p.gap : offRouteGap(p), along: p.along, furthest: p.furthest, lost: p.lost, doubt: o.unaware ? undefined : p.doubt !== null }
      const step = stepWatched(watch, machine, routeFix, from)
      routeFix = step.fix
      watch = step.watch
      machine = step.state
      event = step.event
    }
    const beat: Beat = { i, time: clock, truth: xy, out: distToPath(xy, route), progress, routeFix, state: machine, event, watch }
    beats.push(beat)
    if (event) said.push({ event, beat })
    const pressed = o.act?.(beat)
    if (pressed) machine = pressed
  }
  if (o.exact) {
    for (let k = 0; k < o.exact.length; k++) {
      taken = k
      fixAt(0, true)
      clock += 1000
    }
    return { beats, said, state: machine, progress, clock }
  }
  for (let s = 0; s <= total; s += speed) {
    // A stretch of time with no fixes at all: the car goes on, and the phone says nothing.
    if (!inside(o.drop)) fixAt(s, true)
    taken++
    clock += 1000
    for (const w of waits) {
      if (w.s >= s && w.s < s + speed) {
        for (let k = 0; k < w.seconds; k++) {
          fixAt(w.s, false)
          clock += 1000
        }
      }
    }
  }
  return { beats, said, state: machine, progress, clock }
}

const events = (d: Drive) => d.said.map((x) => x.event)

/** The first thing said of this kind. */
const first = (d: Drive, event: Exclude<OffEvent, null>) => d.said.find((x) => x.event === event)!.beat
/** How far along the route the driver came back, from where it was left: positive for further on. */
const jump = (b: Beat) => b.state.rejoin!.along - b.state.left!.along
/** How many seconds between two fixes. */
const seconds = (a: Beat, b: Beat) => (b.time - a.time) / 1000
/**
 * The biggest move of the place last followed, along the route beyond the ground between (as the machine measures a jump), that it made
 * without a word, on the route.
 */
function quietLeap(d: Drive): number {
  let worst = 0
  let left: LeftAt | null = null
  for (const b of d.beats) {
    const now = b.state.left
    if (left && now && now !== left && b.state.phase === 'on' && b.event === null) worst = Math.max(worst, Math.abs(now.along - left.along) - haversine(left.at, now.at))
    left = now ?? left
  }
  return worst
}
/** Whether the driver stepped the machine at this fix, with the car a long way from the route (the glitch or the stop did what it was meant to). */
const farFixes = (d: Drive) => d.beats.filter((b) => b.routeFix && b.routeFix.gap > OFF_ROUTE_M).length

const STRAIGHT: XY[] = [[0, 0], [0, 2000]]

describe('driving along the route', () => {
  it('says nothing, whatever the noise, on a straight road', () => {
    for (const noise of [3, 6, 9, 12]) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const d = drive(STRAIGHT, STRAIGHT, { seed, noise })
        expect(events(d), `noise ${noise} seed ${seed}`).toEqual([])
        expect(d.state.phase).toBe('on')
      }
    }
  })

  it('says nothing round corners, with or without the phone giving its heading', () => {
    const zigzag: XY[] = [[0, 0], [0, 400], [300, 400], [300, 800], [0, 800], [0, 1100]]
    for (const heading of [true, false]) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const d = drive(zigzag, zigzag, { seed, noise: 8, heading })
        expect(events(d), `heading ${heading} seed ${seed}`).toEqual([])
      }
    }
  })

  it('keeps the place last followed up to date, so that a wrong turn is judged from where it was made', () => {
    const d = drive(STRAIGHT, [[0, 0], [0, 500]])
    expect(d.state.left!.along).toBeGreaterThan(480)
    expect(d.state.left!.along).toBeLessThan(520)
  })
})

describe('a wrong turn onto a side street, and straight back', () => {
  const path: Waypoint[] = [[0, 0], [0, 400], [300, 400], [0, 400], [0, 1000]]

  it('goes off once it is sure, reminds, and says it is back at the place it was left', () => {
    const d = drive(STRAIGHT, path)
    expect(events(d)).toEqual(['went-off', 'remind', 'back'])
    const off = first(d, 'went-off')
    // Sure takes more than 50 metres, three fixes and four seconds, so a good way up the side street.
    expect(off.out).toBeGreaterThan(55)
    expect(off.out).toBeLessThan(110)
    expect(off.state.left!.along).toBeGreaterThan(380)
    expect(off.state.left!.along).toBeLessThan(420)
    expect(seconds(off, first(d, 'remind'))).toBe(30)
    const back = first(d, 'back')
    expect(back.out).toBeLessThanOrEqual(45)
    expect(d.state.phase).toBe('on')
    expect(d.state.left!.along).toBeGreaterThan(950)
  })

  it('does not wait for the reminder, when the wrong turn is short', () => {
    const d = drive(STRAIGHT, [[0, 0], [0, 400], [120, 400], [0, 400], [0, 1000]])
    expect(events(d)).toEqual(['went-off', 'back'])
  })

  it('does not go off at all for a wrong turn that is not far enough to be sure of', () => {
    expect(events(drive(STRAIGHT, [[0, 0], [0, 400], [40, 450], [0, 500], [0, 1000]]))).toEqual([])
    expect(events(drive(STRAIGHT, [[0, 0], [0, 400], [70, 400], [0, 400], [0, 1000]], { speed: 20 }))).toEqual([])
  })

  it('reminds every 30 seconds for as long as it lasts, and then says it is back', () => {
    const d = drive(STRAIGHT, [[0, 0], [0, 400], [1300, 400], [0, 400], [0, 1000]])
    const names = events(d)
    expect(names[0]).toBe('went-off')
    expect(names.at(-1)).toBe('back')
    const reminders = d.said.filter((x) => x.event === 'remind')
    expect(reminders.length).toBe(8)
    expect(names.slice(1, -1).every((e) => e === 'remind')).toBe(true)
    for (let i = 1; i < reminders.length; i++) expect(seconds(reminders[i - 1].beat, reminders[i].beat)).toBe(30)
    expect(seconds(first(d, 'went-off'), reminders[0].beat)).toBe(30)
  })

  it('works the same way on the other side of the road, and going the other way', () => {
    const d = drive(STRAIGHT, [[0, 0], [0, 400], [-300, 400], [0, 400], [0, 1000]])
    expect(events(d)).toEqual(['went-off', 'remind', 'back'])
    const down = drive([[0, 2000], [0, 0]], [[0, 2000], [0, 1600], [300, 1600], [0, 1600], [0, 1000]])
    expect(events(down)).toEqual(['went-off', 'remind', 'back'])
  })

  it('does the same for any amount of noise a phone is likely to have', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (const noise of [3, 6, 10]) {
        const d = drive(STRAIGHT, path, { seed, noise })
        expect(events(d), `seed ${seed} noise ${noise}`).toEqual(['went-off', 'remind', 'back'])
      }
    }
  })
})

describe('a wrong turn onto a parallel street, and back on the route further on', () => {
  const path: Waypoint[] = [[0, 0], [0, 300], [150, 300], [150, 1000], [0, 1000], [0, 2000]]

  it('goes off, reminds, and asks where the driver stands when it is back 700 metres on', () => {
    const d = drive(STRAIGHT, path)
    expect(events(d)).toEqual(['went-off', 'remind', 'remind', 'rejoined-elsewhere', 'carried-on'])
    const asked = first(d, 'rejoined-elsewhere')
    expect(asked.state.phase).toBe('rejoined')
    expect(asked.out).toBeLessThanOrEqual(45)
    // 700 metres of route were skipped, and 120 more have been driven on the new part, which is what tells it from a street crossed.
    expect(jump(asked)).toBeGreaterThan(780)
    expect(jump(asked)).toBeLessThan(870)
    expect(offRouteSpeech('rejoined-elsewhere', jump(asked))).toMatch(/^Back on the route, (800|850) metres further on\.$/)
  })

  it('does not silently take up the new place: the left one is kept until the driver chooses, or 60 seconds pass', () => {
    const d = drive(STRAIGHT, path)
    const asked = first(d, 'rejoined-elsewhere')
    expect(asked.state.left!.along).toBeLessThan(320)
    const waiting = d.beats.filter((b) => b.i > asked.i && b.time <= asked.time + 59_000)
    expect(waiting.length).toBeGreaterThan(50)
    for (const b of waiting) expect(b.state).toMatchObject({ phase: 'rejoined', left: asked.state.left })
    const carried = first(d, 'carried-on')
    expect(seconds(asked, carried)).toBeGreaterThanOrEqual(60)
    expect(seconds(asked, carried)).toBeLessThanOrEqual(61)
    expect(carried.state.left!.along).toBeGreaterThan(1500)
    expect(d.state.phase).toBe('on')
  })

  it('carries on from the new place when the driver says so, and never asks again', () => {
    const d = drive(STRAIGHT, path, { act: (b) => (b.event === 'rejoined-elsewhere' ? carryOnHere(b.state, b.routeFix!) : undefined) })
    expect(events(d)).toEqual(['went-off', 'remind', 'remind', 'rejoined-elsewhere'])
    expect(d.state.phase).toBe('on')
    expect(d.state.left!.along).toBeGreaterThan(1950)
  })

  it('keeps guiding to where it was left when the driver says to take them back, and stays quiet, until they go on along the route instead', () => {
    const d = drive(STRAIGHT, path, { act: (b) => (b.event === 'rejoined-elsewhere' ? takeMeBack(b.state) : undefined) })
    expect(events(d)).toEqual(['went-off', 'remind', 'remind', 'rejoined-elsewhere', 'carried-on'])
    const asked = first(d, 'rejoined-elsewhere')
    const carried = first(d, 'carried-on')
    const between = d.beats.filter((b) => b.i > asked.i && b.i < carried.i)
    expect(between.length).toBeGreaterThan(40)
    for (const b of between) expect(b.state).toMatchObject({ phase: 'returning', left: asked.state.left })
    // 500 metres on from where they came back, with no nearer to where they left: it carries on from there.
    expect(carried.progress!.along - asked.progress!.along).toBeGreaterThanOrEqual(RETURN_GIVE_UP_M)
    expect(carried.progress!.along - asked.progress!.along).toBeLessThan(RETURN_GIVE_UP_M + 30)
    expect(d.state.phase).toBe('on')
    expect(d.state.left!.along).toBeGreaterThan(1500)
  })

  it('goes the whole way back: off again on the way, asks again at the start, and is back where it was left', () => {
    // A round out and round: a shortcut across the top skips the far end, and the driver goes back for it.
    const u: XY[] = [[0, 0], [0, 1000], [300, 1000], [300, 0]]
    const there: Waypoint[] = [[0, 0], [0, 300], [300, 300], [300, 0], [0, 0], [0, 600]]
    const d = drive(u, there, { act: (b) => (b.event === 'rejoined-elsewhere' && b.state.rejoin!.along > 1500 ? takeMeBack(b.state) : undefined) })
    expect(events(d)).toEqual(['went-off', 'rejoined-elsewhere', 'went-off', 'rejoined-elsewhere', 'back'])
    const [, skipped, , start] = d.said.map((x) => x.beat)
    expect(jump(skipped)).toBeGreaterThan(1500)
    expect(jump(start)).toBeLessThan(-150)
    expect(d.state.phase).toBe('on')
    expect(d.state.left!.along).toBeGreaterThan(500)
  })
})

describe('a wrong turn that comes back earlier on the route', () => {
  it('says the driver is back, so many metres earlier on, and asks', () => {
    const u: XY[] = [[0, 0], [0, 1000], [300, 1000], [300, 0]]
    const d = drive(u, [[0, 0], [0, 1000], [300, 1000], [300, 800], [0, 800], [0, 1000]])
    expect(events(d)).toEqual(['went-off', 'rejoined-elsewhere'])
    const asked = first(d, 'rejoined-elsewhere')
    // 700 metres earlier than where it was left, less the 120 driven on the way along the early part.
    expect(jump(asked)).toBeLessThan(-540)
    expect(jump(asked)).toBeGreaterThan(-620)
    expect(offRouteSpeech('rejoined-elsewhere', jump(asked))).toMatch(/^Back on the route, (550|600) metres earlier on\.$/)
    expect(d.state.phase).toBe('rejoined')
  })
})

describe('a glitch of the phone', () => {
  const along: XY[] = [[0, 0], [0, 1000]]
  // A fix that claims 38 metres of accuracy and is 80 out is believed by the tracker, and is far from the route for the machine.
  const glitch = (at: number[]) => drive(STRAIGHT, along, { glitch: { at, dx: 80, dy: 0, accuracy: 38 } })

  it('is no reason to go off when it is one far fix', () => {
    const d = glitch([25])
    expect(d.beats[25].routeFix!.gap).toBeGreaterThan(70)
    expect(events(d)).toEqual([])
  })

  it('or two, or three in a row that come too quickly to be sure of', () => {
    for (const at of [[25, 26], [25, 26, 27]]) {
      const d = glitch(at)
      expect(farFixes(d), `${at}`).toBeGreaterThanOrEqual(at.length)
      expect(events(d), `${at}`).toEqual([])
    }
  })

  it('is when it goes on for four seconds: then the phone really is somewhere else', () => {
    const d = glitch([25, 26, 27, 28, 29, 30])
    expect(events(d)).toEqual(['went-off', 'back'])
    expect(seconds(d.beats[25], first(d, 'went-off'))).toBe(4)
  })
})

describe('a driver who stops, or crawls, away from the route', () => {
  it('is not off the route while stopped 60 metres away, however long', () => {
    const d = drive(STRAIGHT, [[0, 0], [0, 500], [60, 500, 120], [0, 500], [0, 800]])
    expect(events(d)).toEqual([])
    // The test is not stopped at the first hurdle: the machine was asked about dozens of fixes that far out.
    expect(farFixes(d)).toBeGreaterThan(60)
  })

  it('is not off the route while crawling along 70 metres away, below walking speed', () => {
    const start = drive(STRAIGHT, [[0, 0], [0, 500]]).progress
    const d = drive(STRAIGHT, [[70, 500], [70, 800]], { speed: 1.4, progress: start, state: drive(STRAIGHT, [[0, 0], [0, 500]]).state })
    expect(d.beats.length).toBeGreaterThan(200)
    expect(events(d)).toEqual([])
  })

  it('is off the route once it moves off again along a parallel street', () => {
    const d = drive(STRAIGHT, [[0, 0], [0, 500], [60, 500, 120], [60, 700]])
    expect(events(d)).toEqual(['went-off'])
    const movingOff = d.beats.find((b) => b.truth[0] === 60 && b.truth[1] > 500)!
    expect(seconds(movingOff, first(d, 'went-off'))).toBe(4)
  })
})

describe('a street driven twice', () => {
  const street: XY[] = [[0, 0], [0, 500], [0, 0], [400, 0]]

  it('says nothing for a drive up it and back, whatever the noise, with or without a heading', () => {
    for (const heading of [true, false]) {
      for (const seed of [1, 2, 3, 4]) {
        const d = drive(street, street, { seed, noise: 6, heading })
        expect(events(d), `heading ${heading} seed ${seed}`).toEqual([])
      }
    }
  })

  it('says nothing when the tracker has the driver on the wrong pass, since the driver is on the route', () => {
    // A round started 100 metres up the way back (900 metres on) but driven on the way out. Every place that fits the phone and lies ahead of
    // the tracker's is on the way back, so it keeps to the wrong pass all the way up the street.
    const d = drive(street, [[0, 100], [0, 400]], { startAt: 900 })
    expect(d.beats.length).toBeGreaterThan(25)
    expect(d.beats.every((b) => b.progress!.along > 600), 'the wrong pass is the one it follows').toBe(true)
    expect(events(d)).toEqual([])
  })

  it('leaves the wrong pass of a street at its end once the place it holds has lost touch with the phone, and says nothing', () => {
    // A round started at the way back (700 metres on) but driven on the way out. The tracker starts on the wrong pass, at the foot of the street,
    // where the route goes on along the next street: once the phone is 25 metres up the street, that is no longer where it is, and the way out fits.
    // (The round has not reached the route yet: the tracker was put 300 m from the start, and the car has not gone 200 m on it. A machine asked
    // all along would take the jump back of 950 m, which the phone was on the route for, for a wrong turn onto a street already driven.)
    const d = drive(street, street, { startAt: 700 })
    expect(d.beats.slice(0, 3).every((b) => b.progress!.along > 600), 'it starts on the wrong pass').toBe(true)
    expect(d.beats.slice(8, 40).every((b) => b.progress!.along < 500), 'and has the way out well before the top of the street').toBe(true)
    expect(events(d)).toEqual([])
    expect(events(drive(street, street, { progress: startProgress(makeTrack(street.map(spot)), 700) }))).toContain('rejoined-elsewhere')
  })

  it('judges a wrong turn on the street by the pass the tracker has, so that it is back where it was left', () => {
    const detour: Waypoint[] = [[0, 0], [0, 300], [200, 300], [0, 300], [0, 500], [0, 0], [400, 0]]
    const d = drive(street, detour, { startAt: 700 })
    expect(events(d)).toEqual(['went-off', 'back'])
    // And with the tracker on the right pass.
    expect(events(drive(street, detour))).toEqual(['went-off', 'back'])
  })

  it('stays right when the phone gives its heading the wrong way round for a while on the way back', () => {
    const detour: Waypoint[] = [[0, 0], [0, 300], [200, 300], [0, 300], [0, 500], [0, 0], [400, 0]]
    for (const seed of [1, 2, 3]) {
      const d = drive(street, detour, { seed, flipHeading: [55, 77] })
      expect(events(d), `seed ${seed}`).toEqual(['went-off', 'back'])
    }
  })
})

describe('a route that loops back past its own start', () => {
  const lap: XY[] = [[0, 0], [0, 400], [400, 400], [400, 30], [0, 30], [-300, 30]]
  const toTheStart: Waypoint[] = [[0, 0], [0, 400], [400, 400], [400, 30]]

  it('says nothing for a whole lap, the place near the start included', () => {
    for (const seed of [1, 2, 3]) expect(events(drive(lap, lap, { seed })), `seed ${seed}`).toEqual([])
  })

  it('goes off and is back where it was left, for a wrong turn made near the start', () => {
    const d = drive(lap, [...toTheStart, [100, 30], [100, -200], [100, 30], [-300, 30]])
    expect(events(d)).toEqual(['went-off', 'remind', 'back'])
    expect(first(d, 'went-off').state.left!.along).toBeGreaterThan(1250)
  })

  it('asks, a long way earlier on, when the wrong turn comes back at the start of the lap', () => {
    const d = drive(lap, [...toTheStart, [100, 30], [100, -60], [0, -60], [0, 100], [0, 400]])
    expect(events(d)).toEqual(['went-off', 'rejoined-elsewhere'])
    const asked = first(d, 'rejoined-elsewhere')
    expect(jump(asked)).toBeLessThan(-1300)
    expect(offRouteSpeech('rejoined-elsewhere', jump(asked))).toBe('Back on the route, 1.4 kilometres earlier on.')
  })
})

describe('a round that begins away from the route', () => {
  it('is off the route until it is reached, then back at once, since there is nowhere it was left', () => {
    const d = drive(STRAIGHT, [[600, 200], [0, 200], [0, 1000]])
    expect(events(d)).toEqual(['went-off', 'remind', 'back'])
    expect(first(d, 'went-off').state.left).toBeNull()
    expect(d.state.phase).toBe('on')
    expect(d.state.left).not.toBeNull()
  })
})

describe('a tracker that is unsure where the driver is', () => {
  // The first pass of a route that runs along and back 110 metres over, cut across to the second pass by a street that is not on it.
  const route: XY[] = [[0, 0], [900, 0], [900, 110], [0, 110], [0, 400]]
  const points = (): XY[] => {
    const out: XY[] = []
    for (let x = 0; x <= 168; x += 8) out.push([x, 0])
    out.push([168, 20], [168, 40])
    for (let x = 200; x <= 256; x += 8) out.push([x, 55])
    out.push([264, 71], [264, 79], [264, 87], [264, 95], [264, 103], [264, 111])
    for (let x = 256; x >= 100; x -= 8) out.push([x, 110])
    return out
  }

  it('does not take the fixes it holds at the old place for the driver being back there', () => {
    const d = drive(route, [[0, 0], [1, 1]], { exact: points(), accuracy: 10, noise: 0 })
    // The tracker held the old place (256 metres along) for two fixes while it made up its mind, with the phone 31 and 39 metres from the
    // route: that is not coming back where it was left, and the jump to 1646 that follows must be told, not taken up in silence.
    const held = d.beats.filter((b) => b.progress?.doubt)
    expect(held.length).toBeGreaterThanOrEqual(2)
    expect(held.every((b) => b.progress!.along < 300)).toBe(true)
    expect(events(d)).not.toContain('back')
    expect(events(d)).toContain('rejoined-elsewhere')
    const asked = first(d, 'rejoined-elsewhere')
    expect(asked.progress!.along).toBeGreaterThan(1500)
    expect(asked.state.left!.along).toBeLessThan(300)
  })

  it('would have said it was back, at the old place, without being told that it is holding it', () => {
    const d = drive(route, [[0, 0], [1, 1]], { exact: points(), accuracy: 10, noise: 0, unaware: true })
    expect(events(d)).toContain('back')
    const back = first(d, 'back')
    expect(back.progress!.along).toBeLessThan(300)
    expect(d.beats[back.i + 1].progress!.along).toBeGreaterThan(1500)
  })
})

/** North 300 m to a junction, right round a block `side` m a side and back down to the junction, and on north. */
const block = (side: number): XY[] => [[0, 0], [0, 300], [side, 300], [side, 300 + side], [0, 300 + side], [0, 300], [0, 1500]]

/** A serpentine route: `rungs` streets `width` metres long, `gap` metres apart, joined at alternate ends, the first going east. */
function serpentine(rungs: number, width: number, gap: number): XY[] {
  const out: XY[] = []
  for (let k = 0; k < rungs; k++) out.push(...(k % 2 === 0 ? ([[0, k * gap], [width, k * gap]] as XY[]) : ([[width, k * gap], [0, k * gap]] as XY[])))
  return out
}

describe('a jump along the route that nothing else explains', () => {
  /** On the route, having been 31 metres or more from it since the place last followed. */
  const AWAY = state('on', { left: LEFT, away: true })
  /** Near fixes on a street 100 metres east of the route, driving north: the route's 1000 metres on from where it was last followed. */
  const jumped = (i: number, t: number, over: Partial<RouteFix> = {}) => onRoute(1500 + 11 * i, t, { at: spot([100, 520 + 11 * i]), ...over })

  it('is held back at first, with the place last followed kept', () => {
    const r = stepOffRoute(AWAY, jumped(0, 1000))
    expect(r.event).toBeNull()
    expect(r.state).toEqual({ ...AWAY, near: 1, nearFrom: spot([100, 520]) })
    expect(r.state.left).toBe(LEFT)
  })

  it('takes the start of the run from its first fix, whatever was left in the state before it', () => {
    const r = stepOffRoute({ ...AWAY, near: 0, nearFrom: spot([9, 9]) }, jumped(0, 1000))
    expect(r.state.nearFrom).toEqual(spot([100, 520]))
    const next = stepOffRoute(r.state, jumped(1, 2000))
    expect(next.state.nearFrom).toEqual(spot([100, 520]))
  })

  it('ends a run of far fixes, which a fix on the route does', () => {
    const r = stepOffRoute({ ...AWAY, far: { fixes: 2, since: 500 } }, jumped(0, 1000))
    expect(r.state.far).toEqual(NO_FAR)
  })

  it('is told as a rejoining once the fixes near the route have covered ground, like one after going off', () => {
    const r = play(AWAY, run(14, 1000, (t, i) => jumped(i, t)))
    expect(r.events.indexOf('rejoined-elsewhere')).toBe(11)
    expect(r.said).toEqual(['rejoined-elsewhere'])
    expect(r.state).toEqual(blank({ phase: 'rejoined', left: LEFT, rejoin: { along: 1500 + 11 * 11, furthest: 1500 + 11 * 11, at: spot([100, 520 + 11 * 11]), time: 12_000 } }))
  })

  it('wants 150 metres more along the route than the ground between the two places explains', () => {
    // The place last followed is 100 metres south of where the phone is.
    const at = (along: number) => play(AWAY, [onRoute(along, 1000, { at: spot([0, 600]) }), onRoute(along + 1, 2000, { at: spot([0, 601]) })])
    // 100 metres apart on the ground, so 250 along the route is all driving; one metre more is a jump.
    expect(at(749.5).state.left).toEqual({ along: 750.5, furthest: 750.5, at: spot([0, 601]) })
    expect(at(749.5).state.phase).toBe('on')
    expect(at(750.5).state.left).toBe(LEFT)
    expect(at(750.5).state.near).toBe(2)
    // Behind it, too.
    const behind = (along: number) => stepOffRoute(AWAY, onRoute(along, 1000, { at: spot([0, 400]) }))
    expect(behind(500 - 249.5).state.left?.along).toBe(500 - 249.5)
    expect(behind(500 - 250.5).state.left).toBe(LEFT)
  })

  it('wants it to be more than 150, not 150', () => {
    // Both at the same spot, so that the ground between is nothing.
    expect(stepOffRoute(AWAY, onRoute(650, 1000, { at: LEFT.at })).state.left?.along).toBe(650)
    expect(stepOffRoute(AWAY, onRoute(650.5, 1000, { at: LEFT.at })).state.near).toBe(1)
    expect(stepOffRoute(AWAY, onRoute(350, 1000, { at: LEFT.at })).state.left?.along).toBe(350)
    expect(stepOffRoute(AWAY, onRoute(349.5, 1000, { at: LEFT.at })).state.near).toBe(1)
  })

  it('goes by the ground between the places, not by how far the route goes between them', () => {
    // 1000 metres on, and 1000 metres away on the ground: that is driving.
    expect(stepOffRoute(AWAY, onRoute(1500, 1000, { at: spot([0, 1500]) })).state.left?.along).toBe(1500)
    expect(stepOffRoute(AWAY, onRoute(1500, 1000, { at: spot([0, 1400]) })).state.left?.along).toBe(1500)
  })

  it('is taken up without a word when the driver has not been away from the route, up to 450 metres more than the ground explains', () => {
    // (A court, or a street driven out and back, up to 150 m deep that the driver went by: 300 m of route, and the 150 m any jump wants.)
    expect(BIG_LEAP_M).toBe(450)
    // Both at the same spot, so that the ground between is nothing.
    const r = stepOffRoute(ON, onRoute(950, 1000, { at: LEFT.at }))
    expect(r.event).toBeNull()
    expect(r.state).toEqual(blank({ left: place(onRoute(950, 1000, { at: LEFT.at })), followedAt: 1000 }))
    expect(stepOffRoute(ON, onRoute(50, 1000, { at: LEFT.at })).state.left?.along).toBe(50)
    // 300 m on, and 102 m away on the ground.
    expect(stepOffRoute(ON, onRoute(800, 1000, { at: spot([100, 520]) })).state).toEqual(blank({ left: place(onRoute(800, 1000, { at: spot([100, 520]) })), followedAt: 1000 }))
  })

  it('is held back without the driver having been away from the route when it is bigger than that, and told once it has gone on for some distance', () => {
    // (A turn missed into a loop that comes back to the street, or one onto a street already driven: the phone is on the route all the time.)
    expect(stepOffRoute(ON, onRoute(950.5, 1000, { at: LEFT.at })).state).toEqual({ ...ON, near: 1, nearFrom: LEFT.at })
    expect(stepOffRoute(ON, onRoute(49.5, 1000, { at: LEFT.at })).state).toEqual({ ...ON, near: 1, nearFrom: LEFT.at })
    // 1000 m on, and 102 m away on the ground: as after straying.
    const r = play(ON, run(14, 1000, (t, i) => jumped(i, t)))
    expect(r.events.indexOf('rejoined-elsewhere')).toBe(11)
    expect(r.said).toEqual(['rejoined-elsewhere'])
    expect(r.state).toEqual(blank({ phase: 'rejoined', left: LEFT, rejoin: { along: 1500 + 11 * 11, furthest: 1500 + 11 * 11, at: spot([100, 520 + 11 * 11]), time: 12_000 } }))
  })

  it('goes on, once held back, while it is a jump at all, though no longer as big as that', () => {
    // Up a street already driven, from where the route was last followed, which is 500 m on along the route: the jump back shrinks as the car goes
    // on (it is 500 m less twice the ground covered), and is under 450 m from the second fix on. Told once the fixes have covered 120 m of ground.
    const upAgain = (i: number, t: number) => onRoute(31 * i, t, { at: spot([0, 500 + 31 * i]) })
    const r = play(ON, run(6, 1000, (t, i) => upAgain(i, t)))
    expect(r.events).toEqual([null, null, null, null, 'rejoined-elsewhere', null])
    expect(r.state.rejoin!.along - r.state.left!.along).toBe(31 * 4 - 500)
  })

  it('has nothing to compare with before the route has been followed', () => {
    const r = stepOffRoute(state('on', { left: null, away: true }), jumped(0, 1000))
    expect(r.state.left).toEqual(place(jumped(0, 1000)))
    expect(r.state.near).toBe(0)
  })

  it('is forgotten when the fixes stop being near the route, and the place last followed is kept', () => {
    for (const between of [offBy(45, 3000), offBy(80, 3000), onRoute(1520, 3000, { lost: true }), onRoute(1520, 3000, { doubt: true })]) {
      const r = play(AWAY, [jumped(0, 1000), jumped(1, 2000), between])
      expect(r.said).toEqual([])
      expect(r.state, JSON.stringify(between)).toMatchObject({ phase: 'on', left: LEFT, near: 0, nearFrom: null, away: true })
    }
  })

  it('is forgotten when the tracker goes back to where the route was being followed', () => {
    const r = play(AWAY, [jumped(0, 1000), jumped(1, 2000), onRoute(520, 3000, { at: spot([0, 520]) })])
    expect(r.state).toEqual(blank({ left: place(onRoute(520, 3000, { at: spot([0, 520]) })), followedAt: 3000 }))
  })

  it('does not hold up going off', () => {
    const r = play(AWAY, [jumped(0, 1000), ...run(5, 2000, (t) => offBy(80, t))])
    expect(r.events).toEqual([null, null, null, null, null, 'went-off'])
    expect(r.state.left).toBe(LEFT)
  })

  it('is not held up by a fix that says too little', () => {
    const r = play(AWAY, [...run(6, 1000, (t, i) => jumped(i, t)), offBy(80, 7000, { accuracy: 55 }), ...run(6, 8000, (t, i) => jumped(6 + i, t))])
    expect(r.said).toEqual(['rejoined-elsewhere'])
  })

  describe('made while the phone was unseen', () => {
    /** On the route, last followed at the start of the clock: the jumps below are 1000 m along it from there, 102 m away on the ground. */
    const FOLLOWED = state('on', { left: LEFT, followedAt: 0 })
    const held = (from: OffState) => ({ ...from, near: 1, nearFrom: spot([100, 520]) })

    it('is taken up without a word when the time since the place last followed explains it, at 20 m a second', () => {
      // (The phone in the background, or under poor sky, for a minute: the driver has driven on along the route, and the tracker has followed.)
      const r = stepOffRoute(FOLLOWED, jumped(0, 60_000, { blind: true }))
      expect(r.event).toBeNull()
      expect(r.state).toEqual(blank({ left: place(jumped(0, 60_000)), followedAt: 60_000 }))
      // 1000 m in 50 s is 20 m a second: just explained. A millisecond less is not.
      expect(stepOffRoute(FOLLOWED, jumped(0, 50_000, { blind: true })).state.left).toEqual(place(jumped(0, 50_000)))
      expect(stepOffRoute(FOLLOWED, jumped(0, 49_999, { blind: true })).state).toEqual(held(FOLLOWED))
    })

    it('is held back as ever when the phone was not unseen, whatever the time', () => {
      expect(stepOffRoute(FOLLOWED, jumped(0, 60_000)).state).toEqual(held(FOLLOWED))
      expect(stepOffRoute(FOLLOWED, jumped(0, 60_000, { blind: false })).state).toEqual(held(FOLLOWED))
    })

    it('is held back when the time cannot explain it: 1000 m in 30 s is more than 20 m a second', () => {
      expect(stepOffRoute(FOLLOWED, jumped(0, 30_000, { blind: true })).state).toEqual(held(FOLLOWED))
    })

    it('is held back when it is not known when the place was last followed, or when the fix was taken', () => {
      const unknown = state('on', { left: LEFT })
      expect(stepOffRoute(unknown, jumped(0, 60_000, { blind: true })).state).toEqual(held(unknown))
      expect(stepOffRoute(FOLLOWED, jumped(0, 60_000, { blind: true, time: null })).state).toEqual(held(FOLLOWED))
    })

    it('is held back after straying, and goes on once held, as before: only a jump made on the route all the time is put down to driving it unseen', () => {
      const strayed = { ...FOLLOWED, away: true }
      expect(stepOffRoute(strayed, jumped(0, 60_000, { blind: true })).state).toEqual(held(strayed))
      const going = held(FOLLOWED)
      expect(stepOffRoute(going, jumped(1, 61_000, { blind: true })).state).toEqual({ ...going, near: 2 })
    })
  })

  describe('made on the way to where the round was started, skipped to or carried on from', () => {
    /** Last followed 500 m along the route, and 1100 m further along it 20 m on along the ground: a loop, or a street driven out and back, passed by. */
    const BEFORE = state('on', { left: { along: 500, furthest: 500, at: spot([0, 500]) } })
    const passed = (over: Partial<RouteFix> = {}) => driving(1600, 1000, { at: spot([0, 520]), ...over })

    it('is taken up without a word: it is the tracker following the driver along their own way there', () => {
      const r = stepOffRoute(BEFORE, passed({ approaching: true }))
      expect(r.event).toBeNull()
      expect(r.state).toMatchObject({ phase: 'on', near: 0 })
      expect(r.state.left!.along).toBe(1600)
    })

    it('is held back once the phone has been there', () => {
      expect(stepOffRoute(BEFORE, passed()).state).toMatchObject({ phase: 'on', near: 1, left: BEFORE.left })
      expect(stepOffRoute(BEFORE, passed({ approaching: false })).state.near).toBe(1)
    })

    it('is held back after straying, and goes on once held, as before', () => {
      expect(stepOffRoute({ ...BEFORE, away: true }, passed({ approaching: true })).state).toMatchObject({ near: 1, left: BEFORE.left })
      const going = { ...BEFORE, near: 1, nearFrom: spot([0, 480]) }
      expect(stepOffRoute(going, passed({ approaching: true })).state).toMatchObject({ near: 2, left: BEFORE.left })
    })
  })

  describe('and what counts as having been away from the route', () => {
    const awayAfter = (...fixes: RouteFix[]) => play(ON, fixes).state.away
    it('is a fix more than 30 metres out, whether or not it is near, far, or between', () => {
      expect(awayAfter(onRoute(520, 1000, { gap: 30 }))).toBe(false)
      expect(awayAfter(onRoute(520, 1000, { gap: 31 }))).toBe(true)
      expect(awayAfter(onRoute(520, 1000, { gap: 35 }), onRoute(520, 2000, { gap: 10 }))).toBe(false)
      expect(awayAfter(offBy(45, 1000))).toBe(true)
      expect(awayAfter(offBy(80, 1000))).toBe(true)
      expect(awayAfter(offBy(80, 1000, { speed: 0 }))).toBe(true)
    })

    it('is a fix that is lost, which is a long way from the route', () => {
      expect(awayAfter(onRoute(520, 1000, { gap: 65, lost: true }))).toBe(true)
      expect(awayAfter(offBy(300, 1000, { lost: true }))).toBe(true)
    })

    it('is not a fix called lost with the gap of a place the tracker doubts, a few metres for a street driven twice', () => {
      expect(awayAfter(onRoute(520, 1000, { gap: 5, lost: true }))).toBe(false)
      expect(awayAfter(onRoute(520, 1000, { gap: 30, lost: true }))).toBe(false)
      expect(awayAfter(onRoute(520, 1000, { gap: 31, lost: true }))).toBe(true)
    })

    it('is not a fix at a place the tracker doubts, for which the gap is that of the doubted place', () => {
      expect(awayAfter(onRoute(520, 1000, { gap: 10, doubt: true }))).toBe(false)
      expect(awayAfter(offBy(45, 500), onRoute(520, 1000, { gap: 10, doubt: true }))).toBe(true)
      expect(awayAfter(onRoute(520, 1000, { gap: 35, doubt: true }))).toBe(true)
    })

    it('is kept until a fix on the route, well on it, is taken as the place last followed', () => {
      expect(awayAfter(offBy(45, 1000), onRoute(520, 2000, { gap: 25 }))).toBe(false)
      expect(awayAfter(offBy(45, 1000), onRoute(520, 2000, { gap: 35 }))).toBe(true)
      expect(awayAfter(offBy(45, 1000), offBy(10, 2000, { accuracy: 50 }))).toBe(true)
    })

    it('is not said of a fix that says too little', () => {
      expect(awayAfter(offBy(80, 1000, { accuracy: 55 }))).toBe(false)
    })
  })
})

describe('driving across the route and along it', () => {
  it('finds a cross street between streets of the route that the tracker would have jumped along in silence', () => {
    for (const gap of [100, 120, 140, 180]) {
      for (const speed of [6, 10, 14]) {
        for (const seed of [1, 2, 3, 4]) {
          const route = serpentine(8, 800, gap)
          const across = 200 + 100 * ((seed + gap) % 4)
          const d = drive(route, [[0, 0], [across, 0], [across, gap], [0, gap]], { speed, seed, noise: 5 + (seed % 3) * 3 })
          expect(events(d), `gap ${gap} speed ${speed} seed ${seed}`).toContain('rejoined-elsewhere')
          expect(events(d), `gap ${gap} speed ${speed} seed ${seed}`).not.toContain('back')
          const asked = first(d, 'rejoined-elsewhere')
          expect(Math.abs(jump(asked)), `gap ${gap} speed ${speed} seed ${seed}`).toBeGreaterThan(300)
        }
      }
    }
  })

  it('says nothing for a serpentine followed round, however close the streets and noisy the phone', () => {
    for (const gap of [60, 100, 150, 200]) {
      for (const noise of [6, 10]) {
        for (const speed of [6, 12]) {
          for (const heading of [true, false]) {
            const route = serpentine(8, 600, gap)
            const d = drive(route, route, { speed, noise, heading, seed: gap + noise })
            expect(events(d), `gap ${gap} noise ${noise} speed ${speed} heading ${heading}`).toEqual([])
          }
        }
      }
    }
  })

  it('says nothing for a stretch of fixes missing as the driver follows the route, on streets that are not close', () => {
    for (const gap of [100, 150]) {
      for (const [from, count] of [[20, 10], [40, 20], [55, 30], [70, 60]]) {
        const route = serpentine(6, 500, gap)
        const d = drive(route, route, { speed: 10, noise: 6, seed: 3, drop: [from, from + count] })
        expect(events(d), `gap ${gap} fixes ${from} to ${from + count}`).toEqual([])
      }
    }
  })

  it('says nothing when the phone has no fix, or only poor ones, for a minute or more as the driver follows a winding route', { timeout: 60_000 }, () => {
    // (Safari in the background for a phone call, a screen that locked, or poor sky. When the fixes come back the tracker is 600 m to 2 km further
    // along the route, which on a winding round is a few hundred metres on the ground: before, that was a big jump without straying, and the driver
    // was told they were back on the route further on, and asked whether to carry on from there or be taken back to where the gap began.)
    for (const [rungs, width, gap] of [[10, 200, 80], [8, 300, 100], [6, 500, 100]]) {
      const route = serpentine(rungs, width, gap)
      for (const n of [60, 80, 100, 150, 200]) {
        for (const kind of ['drop', 'poor'] as const) {
          for (const noise of [3, 6, 9]) {
            for (const seed of [1, 2, 3, 4]) {
              for (const heading of [true, false]) {
                const d = drive(route, route, { speed: 10, noise, seed, heading, [kind]: [20, 20 + n] })
                const label = `serpentine(${rungs}, ${width}, ${gap}), ${kind} for ${n} s, noise ${noise}, seed ${seed}, heading ${heading}`
                expect(events(d), label).toEqual([])
                // The machine was told the phone had been unseen; and from 80 s on, the place last followed was moved on by a jump bigger than
                // BIG_LEAP_M without a word: it is that which is not asked about, not something else.
                expect(d.beats.some((b) => b.routeFix?.blind), label).toBe(true)
                if (n >= 80) expect(quietLeap(d), label).toBeGreaterThan(BIG_LEAP_M)
              }
            }
          }
        }
      }
    }
  })

  it('does not tell a street crossed while off the route from a route rejoined, and so does not flip about', () => {
    for (const gap of [200, 300]) {
      for (const speed of [6, 12]) {
        const route = serpentine(6, 800, gap)
        // Straight across two streets of the route, and on along a street that is not on it.
        const d = drive(route, [[0, 0], [300, 0], [300, 2 * gap + 80], [600, 2 * gap + 80]], { speed, seed: 2 })
        expect(events(d).filter((e) => e !== 'remind'), `gap ${gap} speed ${speed}`).toEqual(['went-off'])
      }
    }
  })
})

describe('a driver parked off the route', () => {
  const counts = (d: Drive) => events(d).reduce<Record<string, number>>((all, e) => ({ ...all, [e]: (all[e] ?? 0) + 1 }), {})

  it('is told they are off once, and never reminded while they stay, with the phone saying it is standing still', () => {
    // Up a 200 metre spur, and 10 minutes there.
    for (const seed of [1, 2, 3]) {
      for (const noise of [3, 10]) {
        const d = drive(STRAIGHT, [[0, 0], [0, 500], [200, 500], [200, 500, 600]], { seed, noise })
        expect(counts(d), `seed ${seed} noise ${noise}`).toEqual({ 'went-off': 1 })
      }
    }
  })

  it('is told they are off once, and not reminded, when the phone does not say how fast it is going and has not gone anywhere', () => {
    // Up an 80 metre spur: the phone is 60 or so metres from the route where it goes off, and parks 20 metres on.
    for (const seed of [1, 2, 3]) {
      for (const noise of [3, 8, 15]) {
        const d = drive(STRAIGHT, [[0, 0], [0, 500], [80, 500], [80, 500, 600]], { seed, noise, nullSpeed: true })
        expect(counts(d)['remind'] ?? 0, `seed ${seed} noise ${noise}`).toBe(0)
      }
    }
    // Further up a spur, and parked there, the phone has gone somewhere since it went off: it is reminded, once.
    const d = drive(STRAIGHT, [[0, 0], [0, 500], [300, 500], [300, 500, 600]], { seed: 1, noise: 5, nullSpeed: true })
    expect(counts(d)).toEqual({ 'went-off': 1, remind: 1 })
  })

  it('is reminded again once they are driving again, and still off the route', () => {
    const d = drive(STRAIGHT, [[0, 0], [0, 500], [200, 500], [200, 500, 300], [200, 1000]], { seed: 1, noise: 3 })
    const reminders = d.said.filter((x) => x.event === 'remind')
    expect(reminders.length).toBeGreaterThanOrEqual(2)
    // The last is after they set off again, and not 30 seconds after the one before it, if they were still when that was due.
    const last = reminders.at(-1)!.beat
    expect(last.truth[1]).toBeGreaterThan(520)
  })
})

describe('a phone that is poor but still believed, on the road', () => {
  const LONG: XY[] = [[0, 0], [0, 10_700]]
  /** What is said over a number of drives of 10.7 km along a straight road, with the error of each fix carried over most of the way to the next. */
  const said = (noise: number, accuracy: number, drives: number) => {
    let total = 0
    for (let seed = 1; seed <= drives; seed++) total += events(drive(LONG, LONG, { speed: 12, noise, accuracy, carry: 0.97, seed })).filter((e) => e !== 'back').length
    return total
  }

  it('hardly ever says the driver is off the route, at 26, 32 and 40 metres of accuracy: 214 kilometres each', () => {
    expect(said(16, 26, 20)).toBeLessThanOrEqual(1)
    expect(said(20, 32, 20)).toBeLessThanOrEqual(1)
    expect(said(25, 40, 20)).toBeLessThanOrEqual(1)
  })

  it('says nothing at 19 metres, as it never did', () => {
    expect(said(12, 19, 20)).toBe(0)
  })
})

describe('a court the driver does not drive to its end', () => {
  // The street out 300 m, a court off it `depth` m deep (in along it and out again, the same line), and on along the street.
  const court = (depth: number): XY[] => [[0, 0], [0, 300], [depth, 300], [0, 300], [0, 600]]
  const DEPTHS = [60, 100, 150]
  const ways = (depth: number): [string, Waypoint[]][] => [
    ['does not go in at all, and drives on along the street', [[0, 0], [0, 600]]],
    ['goes in 10 m, and out again', [[0, 0], [0, 300], [10, 300], [7, 297], [0, 297], [0, 600]]],
    ['turns round 40 m short of the end of it', [[0, 0], [0, 300], [depth - 40, 300], [depth - 43, 297], [0, 297], [0, 600]]],
  ]

  it('says nothing, whatever the speed and the GPS error: the car is on the route, though the tracker keeps the junction of the court for a while', { timeout: 30_000 }, () => {
    for (const depth of DEPTHS) {
      for (const [name, path] of ways(depth)) {
        for (const speed of [4, 6, 10]) {
          for (const noise of [3, 6, 9]) {
            for (const seed of [1, 2, 3, 4]) {
              const d = drive(court(depth), path, { speed, noise, seed })
              const label = `${depth} m deep, ${name}, ${speed} m/s, noise ${noise}, seed ${seed}`
              expect(events(d), label).toEqual([])
              // (The car is never more than the width of the turn from the route.)
              expect(Math.max(...d.beats.map((b) => b.out)), label).toBeLessThan(4)
            }
          }
        }
      }
    }
  })

  it('says nothing when the phone gives no course, either', () => {
    for (const depth of DEPTHS) {
      for (const [name, path] of ways(depth)) {
        for (const speed of [4, 10]) {
          for (const seed of [1, 2, 3]) {
            expect(events(drive(court(depth), path, { speed, noise: 6, seed, heading: false })), `${depth} m deep, ${name}, ${speed} m/s, seed ${seed}`).toEqual([])
          }
        }
      }
    }
  })

  it('says nothing for a court driven to its end and out again on the other lane, near or far from the route', () => {
    for (const depth of [30, 60, 100, 150, 250]) {
      for (const lane of [0, 12, 30]) {
        for (const seed of [1, 2]) {
          const path: Waypoint[] = lane === 0 ? court(depth) : [[0, 0], [0, 300], [depth, 300], [depth, 300 + lane], [0, 300 + lane], [0, 300], [0, 600]]
          expect(events(drive(court(depth), path, { seed, noise: 6 })), `${depth} m deep, ${lane} m lane, seed ${seed}`).toEqual([])
        }
      }
    }
  })

  it('is what the machine is given the distance for: with the gap of the place the tracker holds, the car on the street is told to be back on the route further on', () => {
    // The gap of the place held at the junction climbs to 25 m or more for a car on the street, and the machine takes the car for having been away from the route.
    let told = 0
    for (const depth of DEPTHS) {
      for (const speed of [4, 6, 10]) {
        for (const noise of [6, 9]) {
          for (const seed of [1, 2, 3, 4]) {
            const d = drive(court(depth), ways(depth)[0][1], { speed, noise, seed, gap: 'tracker' })
            if (events(d).includes('rejoined-elsewhere')) told++
          }
        }
      }
    }
    expect(told).toBeGreaterThan(0)
  })
})

describe('leaving the route and coming back, on a route with a court on it', () => {
  // The street out 300 m, a court 100 m deep, and on 1700 m more of street.
  const route: XY[] = [[0, 0], [0, 300], [100, 300], [0, 300], [0, 2000]]
  const intoCourt: Waypoint[] = [[0, 0], [0, 300], [100, 300], [97, 297], [0, 297], [0, 1000]]
  const pastCourt: Waypoint[] = [[0, 0], [0, 1000]]

  for (const [name, start] of [['that the car drove to the end of', intoCourt], ['that the car drove past', pastCourt]] as [string, Waypoint[]][]) {
    it(`still says off route, and then back, for a wrong turn onto a side street that is not on it, after a court ${name}`, () => {
      for (const seed of [1, 2, 3]) {
        const d = drive(route, [...start, [300, 1000], [0, 1000], [0, 1800]], { seed })
        expect(events(d), `seed ${seed}`).toEqual(['went-off', 'remind', 'back'])
        // Told it is off when it is, a good way up the side street, and back where it was left, which is on the street beyond the court.
        expect(first(d, 'went-off').out, `seed ${seed}`).toBeGreaterThan(55)
        expect(first(d, 'went-off').state.left!.along, `seed ${seed}`).toBeGreaterThan(1150)
        expect(first(d, 'went-off').state.left!.along, `seed ${seed}`).toBeLessThan(1250)
        expect(d.state.phase).toBe('on')
      }
    })

    it(`still asks where the driver is, for a wrong turn onto a parallel street that comes back onto the route further on, after a court ${name}`, () => {
      for (const seed of [1, 2, 3]) {
        const d = drive(route, [...start.slice(0, -1), [0, 700], [150, 700], [150, 1400], [0, 1400], [0, 1900]], { seed })
        expect(events(d).slice(0, 1), `seed ${seed}`).toEqual(['went-off'])
        expect(events(d), `seed ${seed}`).toContain('rejoined-elsewhere')
        expect(events(d), `seed ${seed}`).not.toContain('back')
        const asked = first(d, 'rejoined-elsewhere')
        expect(asked.state.phase).toBe('rejoined')
        // 700 m of the street were left behind (the court's 200 m of route not among them, if it was not driven), and 120 m or so of the new part driven first.
        expect(jump(asked), `seed ${seed}`).toBeGreaterThan(650)
        // Told only once the phone has covered about REJOIN_RUN_M of ground on the route again (the car's own ground, the phone's being a little out),
        // which a street crossed does not.
        const onAgain = d.beats.find((b) => b.i > first(d, 'went-off').i && b.out <= ON_ROUTE_M && b.truth[0] === 0)!
        expect(haversine(spot(onAgain.truth), spot(asked.truth)), `seed ${seed}`).toBeGreaterThanOrEqual(REJOIN_RUN_M - 35)
        expect(haversine(spot(onAgain.truth), spot(asked.truth)), `seed ${seed}`).toBeLessThan(REJOIN_RUN_M + 50)
      }
    })
  }

  it('still asks where the driver is for a cross street between two streets of the route that skips more than 200 m of it, next to a court', () => {
    // A street across the route 400 m long and 120 m north of a court: the car comes off the street, along a street that is not on the route, and back onto it
    // at the far end of the route's court, a long way along it.
    const folded: XY[] = [[0, 0], [0, 300], [100, 300], [0, 300], [0, 600], [400, 600], [400, 0]]
    for (const seed of [1, 2, 3, 4]) {
      const d = drive(folded, [[0, 0], [0, 300], [100, 300], [0, 300], [0, 450], [400, 450], [400, 200], [400, 0]], { seed })
      expect(events(d), `seed ${seed}`).toContain('rejoined-elsewhere')
      expect(events(d), `seed ${seed}`).not.toContain('back')
    }
  })
})

describe('a turn missed onto another part of the route, with the phone on the route all the time', () => {
  // The car is never away from the route, so only the size of the jump along it tells: more than BIG_LEAP_M beyond the ground between.

  it('asks, further on by the whole loop, when the turn into a loop round a block, which comes back to the street, is missed', { timeout: 30_000 }, () => {
    // (Before, nothing was said: the stops round the block never came up, and the furthest reached went on past them.)
    for (const side of [150, 300]) {
      // (At 14 m/s, a block 150 m a side is told in about half the drives: the tracker can come onto the street beyond the loop in two jumps, by
      // way of the loop's last stretch, which runs down the street, and neither is as big as that.)
      for (const speed of side === 300 ? [6, 10, 14] : [6, 10]) {
        for (const noise of [3, 6, 9]) {
          for (const seed of [1, 2, 3, 4]) {
            for (const heading of [true, false]) {
              const d = drive(block(side), [[0, 0], [0, 1400]], { speed, noise, seed, heading })
              const label = `${side} m a side, ${speed} m/s, noise ${noise}, seed ${seed}, heading ${heading}`
              expect(events(d)[0], label).toBe('rejoined-elsewhere')
              expect(events(d), label).not.toContain('went-off')
              expect(events(d), label).not.toContain('back')
              // Asked once the car has gone on 120 m or so: on the street beyond the loop, that is the loop's 4 sides and a little more. (Without a
              // heading the tracker can have the car on the loop's last stretch for a while, which runs down the street: it is still asked, a side less.)
              expect(jump(first(d, 'rejoined-elsewhere')), label).toBeGreaterThan(2 * side + 100)
              expect(jump(first(d, 'rejoined-elsewhere')), label).toBeLessThan(4 * side + 350)
            }
          }
        }
      }
    }
  })

  it('asks when the driver does not turn into a street driven out and back that is 250 m long', { timeout: 30_000 }, () => {
    const spur: XY[] = [[0, 0], [0, 300], [250, 300], [0, 300], [0, 1200]]
    for (const speed of [6, 10, 14]) {
      for (const noise of [3, 6, 9]) {
        for (const seed of [1, 2, 3, 4]) {
          for (const heading of [true, false]) {
            const d = drive(spur, [[0, 0], [0, 1100]], { speed, noise, seed, heading })
            const label = `${speed} m/s, noise ${noise}, seed ${seed}, heading ${heading}`
            expect(events(d)[0], label).toBe('rejoined-elsewhere')
            expect(jump(first(d, 'rejoined-elsewhere')), label).toBeGreaterThan(500)
            expect(jump(first(d, 'rejoined-elsewhere')), label).toBeLessThan(800)
          }
        }
      }
    }
  })

  it('asks, earlier on, when the car turns onto a street already driven', () => {
    // North up the main street to 600, round a block and back to it at 300, where the route goes on west: the car turns right, up the main street again.
    const route: XY[] = [[0, 0], [0, 600], [300, 600], [300, 300], [0, 300], [-400, 300]]
    for (const speed of [6, 10, 14]) {
      for (const noise of [3, 6, 9]) {
        for (const seed of [1, 2, 3, 4]) {
          for (const heading of [true, false]) {
            const d = drive(route, [[0, 0], [0, 600], [300, 600], [300, 300], [0, 300], [0, 600]], { speed, noise, seed, heading })
            const label = `${speed} m/s, noise ${noise}, seed ${seed}, heading ${heading}`
            expect(events(d), label).toEqual(['rejoined-elsewhere'])
            const asked = first(d, 'rejoined-elsewhere')
            // The place left is the junction, 1500 m along the route; the main street is 300 to 600 m along it.
            expect(asked.state.left!.along, label).toBeGreaterThan(1400)
            expect(jump(asked), label).toBeLessThan(-900)
            expect(offRouteSpeech('rejoined-elsewhere', jump(asked)), label).toMatch(/^Back on the route, .* earlier on\.$/)
          }
        }
      }
    }
  })

  it('still asks when the car stops a while just past the turn it missed: a stop is no gap in the fixes', { timeout: 60_000 }, () => {
    // The phone gives fixes all through the stop, so it is never unseen, and the time stopped does not explain the jump. (Taking the time since the
    // place last followed for the time unseen, whatever came in between, a stop of 30 s 60 to 80 m past the turn into a block 150 m a side
    // explained it, and the driver was not asked.)
    const cells: [number, number, number][] = [[300, 340, 30], [300, 360, 30], [300, 380, 30], [300, 400, 30], [300, 340, 90], [300, 360, 90], [300, 380, 90], [300, 400, 90], [150, 340, 30], [150, 360, 30], [150, 380, 30]]
    for (const [side, y, stop] of cells) {
      for (const speed of [6, 10]) {
        for (const noise of [3, 6, 9]) {
          for (const seed of [1, 2, 3, 4]) {
            for (const heading of [true, false]) {
              const d = drive(block(side), [[0, 0], [0, y, stop], [0, 1400]], { speed, noise, seed, heading })
              const label = `${side} m a side, ${stop} s at ${y} m, ${speed} m/s, noise ${noise}, seed ${seed}, heading ${heading}`
              expect(events(d)[0], label).toBe('rejoined-elsewhere')
              expect(events(d), label).not.toContain('went-off')
              expect(d.beats.some((b) => b.routeFix?.blind), label).toBe(false)
            }
          }
        }
      }
    }
  })

  it('still asks when the phone has no fix for a while as the car misses the turn, if the time cannot explain the jump', { timeout: 60_000 }, () => {
    // Unseen for 10 to 40 s from around the junction, at 10 m/s: the jump along the route is the loop and the street driven since, more than 20 m a
    // second for the time unseen. (Taking any jump made unseen for driving, it was not asked.)
    const cells: [number, [number, number]][] = [[300, [25, 35]], [300, [28, 43]], [300, [30, 50]], [300, [30, 70]], [150, [30, 70]]]
    for (const [side, drop] of cells) {
      for (const noise of [3, 6, 9]) {
        for (const seed of [1, 2, 3, 4]) {
          for (const heading of [true, false]) {
            const d = drive(block(side), [[0, 0], [0, 1400]], { noise, seed, heading, drop })
            const label = `${side} m a side, no fixes from ${drop[0]} to ${drop[1]} s, noise ${noise}, seed ${seed}, heading ${heading}`
            expect(events(d)[0], label).toBe('rejoined-elsewhere')
            expect(events(d), label).not.toContain('went-off')
            expect(first(d, 'rejoined-elsewhere').routeFix!.blind, label).toBe(true)
          }
        }
      }
    }
  })

  it('says nothing for a car that backs up on a street driven out and back, up to 90 m at a brisk reversing pace, and drives on', { timeout: 60_000 }, () => {
    // The tracker puts it on the way back, 1.2 km on, as it backs up, and back on the way out as it drives on (see progress.ts). (With the turn round
    // sure at 30 m along the way back, 40 m and more at 3 to 4 m/s stayed there, and the driver was told they were back on the route further on.)
    /** A fix a second from `from`: on to each spot at so many metres a second, or a stop of so many seconds. */
    const paced = (from: XY, legs: ({ to: XY; speed: number } | { stop: number })[]): Waypoint[] => {
      const out: Waypoint[] = [[...from, 0]]
      let at = from
      for (const leg of legs) {
        if ('stop' in leg) {
          for (let k = 0; k < leg.stop; k++) out.push([...at, 0])
          continue
        }
        const n = Math.max(1, Math.round(Math.hypot(leg.to[0] - at[0], leg.to[1] - at[1]) / leg.speed))
        for (let k = 1; k <= n; k++) out.push([at[0] + ((leg.to[0] - at[0]) * k) / n, at[1] + ((leg.to[1] - at[1]) * k) / n, leg.speed])
        at = leg.to
      }
      return out
    }
    const street: XY[] = [[0, 0], [0, 800], [0, 0], [-300, 0]]
    for (const [metres, speed] of [[9, 3], [12, 3], [20, 3], [12, 4], [20, 4], [40, 3], [50, 4], [70, 3], [70, 4], [90, 3]]) {
      for (const noise of [3, 5]) {
        for (const seed of [1, 2, 3, 4]) {
          const exact = paced([0, 0], [{ to: [0, 200], speed: 8 }, { stop: 3 }, { to: [0, 200 - metres], speed }, { stop: 2 }, { to: [0, 800], speed: 8 }, { to: [0, 0], speed: 8 }, { to: [-300, 0], speed: 8 }])
          const d = drive(street, [[0, 0], [0, 1]], { exact, noise, seed })
          expect(events(d), `${metres} m back at ${speed} m/s, noise ${noise}, seed ${seed}`).toEqual([])
          expect(d.progress!.along).toBeGreaterThan(1250)
        }
      }
    }
  })
})

describe('the way to where the round was started, skipped to or carried on from, along the route itself', () => {
  // The machine is asked once the route is reached, which can be 200 m on it, a long way before the spot (see `startAt`). On the way there the tracker
  // finds its pass, and is put past a loop, or a street driven out and back, that lies before the spot by a jump bigger than BIG_LEAP_M: the driver's
  // own way there. (Before, they were asked whether they were back on the route further on; and left alone, the round carried on from short of the
  // spot, and the stops between that the start had counted as done came up again.)
  it('says nothing of a loop, and a street driven out and back, that lie before where the round was started part way', { timeout: 60_000 }, () => {
    // North up the main street, a loop round a block 150 m a side 300 m up (300 to 900 m along the route), a street of 250 m driven out and back 700 m up
    // (1300 to 1800 along it), and on north: started 2200 m along, 1100 m up.
    const route: XY[] = [[0, 0], [0, 300], [150, 300], [150, 450], [0, 450], [0, 300], [0, 700], [250, 700], [0, 700], [0, 1600]]
    for (const speed of [6, 10, 14]) {
      for (const noise of [3, 6, 9]) {
        for (const seed of [1, 2, 3, 4]) {
          for (const heading of [true, false]) {
            const d = drive(route, [[0, 0], [0, 1500]], { speed, noise, seed, heading, startAt: 2200 })
            const label = `${speed} m/s, noise ${noise}, seed ${seed}, heading ${heading}`
            expect(events(d), label).toEqual([])
            // (The machine was asked before the spot, and moved on past the loop by a jump bigger than that, without a word.)
            expect(quietLeap(d), label).toBeGreaterThan(BIG_LEAP_M)
          }
        }
      }
    }
  })

  it('says nothing of a loop skipped to the far side of, or to the junction it comes back to', { timeout: 60_000 }, () => {
    // (Skipped to while driving 200 m or more before the loop: to the street beyond it, or to the junction where its last stretch comes back to the
    // street, which the fix that gets there is put at by the jump itself.)
    for (const [side, startAt] of [[150, 1350], [150, 930], [300, 1800]]) {
      for (const speed of [6, 10, 14]) {
        for (const noise of [3, 6, 9]) {
          for (const seed of [1, 2, 3, 4]) {
            for (const heading of [true, false]) {
              const d = drive(block(side), [[0, 0], [0, 1400]], { speed, noise, seed, heading, startAt })
              expect(events(d), `${side} m a side, skipped to ${startAt}, ${speed} m/s, noise ${noise}, seed ${seed}, heading ${heading}`).toEqual([])
            }
          }
        }
      }
    }
  })

  it('still asks about a loop missed after the spot, once the phone has been there', { timeout: 60_000 }, () => {
    // A loop round a block 150 m a side 300 m up, skipped on the way, and one 300 m a side 1300 m up (1900 to 3100 m along the route), past the spot
    // 1700 m along it (1100 m up): that turn the car misses.
    const route: XY[] = [[0, 0], [0, 300], [150, 300], [150, 450], [0, 450], [0, 300], [0, 1300], [300, 1300], [300, 1600], [0, 1600], [0, 1300], [0, 2400]]
    for (const speed of [6, 10, 14]) {
      for (const noise of [3, 6, 9]) {
        for (const seed of [1, 2, 3, 4]) {
          for (const heading of [true, false]) {
            const d = drive(route, [[0, 0], [0, 2300]], { speed, noise, seed, heading, startAt: 1700 })
            const label = `${speed} m/s, noise ${noise}, seed ${seed}, heading ${heading}`
            expect(events(d)[0], label).toBe('rejoined-elsewhere')
            expect(events(d), label).not.toContain('went-off')
            // Asked about the second loop, not the first.
            expect(first(d, 'rejoined-elsewhere').state.left!.along, label).toBeGreaterThan(1800)
          }
        }
      }
    }
  })
})
