import { bearing, haversine, screenPlace } from './geo'
import { spokenMetres } from './turns'
import type { Pt } from './types'

/**
 * Noticing a wrong turn. The tracker (see progress.ts) says where along the route the driver is, and how far the phone is
 * from it, but it does not mind: off the route it goes quiet, and the next piece of route it meets it adopts as the place the
 * driver has got to. This is the part that minds. It watches each fix for the phone being away from the route, says so once it
 * is sure, reminds while it lasts, and says when the driver is back. Coming back at the place the route was left is nothing to
 * remark on; coming back somewhere else, further on or earlier, is the driver's to choose, since carrying on from there skips
 * stops, and going back for them is a decision, not a guess. So is a jump to another part of the route that the tracker made
 * without the phone ever being far enough away to call it off (a cross street between two streets of the route), and a big one
 * that it made with the phone on the route all the time (a turn missed into a loop that comes back to the street, or one onto a
 * street already driven). A court passed by, which the route goes into and out of again, is not that: it is skipped in silence. Nor is
 * a big jump that the phone made unseen (no fix to go by, for a while), if the time since the place last followed can explain it; nor
 * one on the way to where the round was started, skipped to or carried on from, which is the driver's own way there.
 *
 * It is a plain function from one state and one fix to the next state, and what should be told to the driver (if
 * anything), so that a drive can be played through it in a test.
 */

/** Further than this from the route, and further than twice the fix's accuracy, is far from it, in metres. */
export const OFF_ROUTE_M = 50
/** Nearer than this to the route is on it, in metres. */
export const ON_ROUTE_M = 40
/** A fix less accurate than this, in metres, says nothing either way. */
export const OFF_MAX_ACCURACY_M = 40
/** How many fixes in a row far from the route, and how many seconds from the first of them, before the driver is off it. */
export const OFF_FIXES = 3
export const OFF_SECONDS = 4
/** How many fixes in a row near the route, while off it, before the driver is back. */
export const BACK_FIXES = 2
/** How often to remind the driver that they are still off the route, in seconds. */
export const REMIND_SECONDS = 30
/** Back on the route within this many metres along it of where it was left is back where it was left. */
export const REJOIN_NEAR_M = 150
/** How long on the route in a new place, in seconds, before the round carries on from there by itself. */
export const CARRY_ON_SECONDS = 60
/** Back on the route in a new place is only told once the fixes near the route cover this much ground, in metres: more than a street crossed straight. */
export const REJOIN_RUN_M = 120
/** Fixes in a run, far from the route, are at most this many seconds apart on average, or it is not a run. */
export const RUN_GAP_SECONDS = 10
/** A reminder is only given to a phone that doesn't say how fast it is going when it has gone this far, in metres, since the last. */
export const REMIND_MOVE_M = 50
/** Further than this from the route, in metres, is straying: a jump along the route is only believed after some of that. */
export const AWAY_M = 30
/** A move along the route that this many metres exceeds the ground between the two places is a jump, not driving. */
export const LEAP_M = 150
/**
 * A jump bigger than this, in metres (as LEAP_M measures it), is a wrong turn onto another part of the route even when the phone was never away
 * from it: a turn missed into a loop that comes back to the street, or one onto a street already driven. A smaller one is a court, or a street
 * driven out and back, that the driver went by without driving, up to 150 m deep (twice that of route, and the 25 to 35 m the tracker holds
 * its junction for once the car has driven on past it): the driver is on the route all the time, and that is not to be asked about. Nor is a
 * bigger one that the phone made unseen, when the time since the place last followed explains it (see BLIND_MPS), or one on the way to where
 * the round was started, skipped to or carried on from (see `RouteFix.approaching`).
 */
export const BIG_LEAP_M = 2 * 150 + LEAP_M
/**
 * Unseen for a while (see `RouteFix.blind`), the phone may have driven the route at up to this many metres a second (72 km/h) in between: a jump
 * along the route from the place last followed that the time since then explains at this pace is the driver having followed it, not a wrong turn.
 */
export const BLIND_MPS = 20
/** The phone is unseen once no fix it could go by (OFF_MAX_ACCURACY_M or better) has come for more than this many milliseconds. */
export const BLIND_GAP_MS = 10_000
/** On the way to where the round was started, skipped to or carried on from, the phone is there once it is on the route within this many metres along it of that spot, or past it. */
export const ARRIVE_NEAR_M = 100
/** Being taken back, the round carries on from here by itself when the driver is this many metres further from the place left than they got. */
export const RETURN_GIVE_UP_M = 500

/** The phone is going nowhere when it says it is going slower than this, in metres a second (as the tracker has it). */
const MOVING_MPS = 1.5
/** A fix is only far from the route when it is further than this many times its own accuracy, since it can be out by that much. */
const ACCURACY_FACTOR = 2
/** A phone has only gone somewhere when it is further than this many times its own accuracy from where it was, since jitter can carry it that far. */
const JITTER_FACTOR = 4

/** What the machine needs from each fix: the tracker's answer and the fix's own numbers. */
export interface RouteFix {
  /** When the fix was taken, in milliseconds, or null when it doesn't say. */
  time: number | null
  at: Pt
  accuracy: number
  /** How fast the phone says it is going, in metres a second, or null when it can't say. */
  speed: number | null
  /** How far the phone is from the route, in metres. */
  gap: number
  /** How far along the route the tracker puts the driver, in metres, and the furthest reached. */
  along: number
  furthest: number
  /** True when the phone is too far from the route for the tracker to say where along it the driver is. */
  lost: boolean
  /**
   * True while the tracker holds the driver's old place, waiting to be sure of a jump (its `doubt` is not null): `gap` is then
   * the distance of the place it doubts, so the fix is not taken as being on the route. Left out, it is false. (Sent as `lost` instead,
   * it is read the same way: a lost fix with a gap of a few metres can only be this.)
   */
  doubt?: boolean
  /**
   * True when the screen had no fix it could go by (none at all, or none of OFF_MAX_ACCURACY_M or better) for more than BLIND_GAP_MS since the
   * place last followed, or did not ask the machine about one (beside a stop away from the route): the place last followed is stale, and a jump
   * from it that the time since explains (see BLIND_MPS) is the driver having driven the route unseen. Left out, it is false. (See `OffWatch`.)
   */
  blind?: boolean
  /**
   * True on the way to where the round was started, skipped to or carried on from, until the phone has been on the route within ARRIVE_NEAR_M
   * along it of that spot, or past it. A jump along the route bigger than BIG_LEAP_M without straying is then the tracker following the driver's
   * own way there, past a loop or a street driven out and back that lies before the spot: it is taken up without a word. Left out, it is false.
   * (See `OffWatch`.)
   */
  approaching?: boolean
}

export type OffPhase = 'on' | 'off' | 'returning' | 'rejoined'

/** Where the route was last followed, to guide back to. */
export interface LeftAt {
  along: number
  furthest: number
  at: Pt
}

export interface OffState {
  /**
   * On the route; off it; on it again somewhere else and waiting for the driver to say what to do about that
   * ('rejoined'); or being taken back to where it was left ('returning').
   */
  phase: OffPhase
  /** Where the route was last followed (null before the first fix on it). Kept while off. */
  left: LeftAt | null
  /**
   * When the fix that gave the place last followed was taken (ms), on the route: how long the phone has had to drive on from it, unseen. Null
   * when that is not known (a place from a button, or nowhere), and then no jump is put down to that.
   */
  followedAt: number | null
  /** Fixes in a row far from the route, and when the first was (ms), while counting towards 'off'. */
  far: { fixes: number; since: number | null }
  /**
   * Fixes in a row near the route, while off or returning, counting towards 'back'; or, while on the route, near it but a jump along it
   * from where it was last followed. And where the first of those fixes was: the ground they cover is what tells a rejoining from a crossing.
   */
  near: number
  nearFrom: Pt | null
  /** While on the route: whether any fix since the place last followed was away from it (lost, or beyond AWAY_M), which a jump needs unless it is bigger than BIG_LEAP_M. */
  away: boolean
  /** When the driver was last reminded (ms), and where they were, while off. */
  remindedAt: number | null
  remindedFrom: Pt | null
  /**
   * While 'rejoined': where the driver came back onto the route, and when (ms). While 'returning': the nearest to the place left, along
   * the route, that they have got on the new part of it (and when), once they have been on it.
   */
  rejoin: { along: number; furthest: number; at: Pt; time: number | null } | null
}

const noFar: OffState['far'] = Object.freeze({ fixes: 0, since: null })

/** Nothing seen yet: on the route, with nowhere left behind. Shared, so frozen. */
export const startOffRoute: OffState = Object.freeze({ phase: 'on', left: null, followedAt: null, far: noFar, near: 0, nearFrom: null, away: false, remindedAt: null, remindedFrom: null, rejoin: null })

/** What the driver should be told: the moment they went off, a reminder, the moment they are back, back but elsewhere, or that the round carried on by itself. */
export type OffEvent = 'went-off' | 'remind' | 'back' | 'rejoined-elsewhere' | 'carried-on' | null

/**
 * On the route, with the place last followed (whether the fix it came from was away from it, and when it was taken, if that is known).
 * Everything that was being counted is forgotten.
 */
const onAt = (left: LeftAt | null, away = false, time: number | null = null): OffState => ({ ...startOffRoute, left, away, followedAt: time })

/** Off the route, with the place it was left, reminding from `time` and from where the driver is. */
const offFrom = (left: LeftAt | null, time: number | null, at: Pt): OffState => ({ ...startOffRoute, phase: 'off', left, remindedAt: time, remindedFrom: at })

/** Back on the route in a new place, waiting to hear what to do. */
const rejoinedAt = (left: LeftAt | null, here: LeftAt, time: number | null): OffState => ({ ...startOffRoute, phase: 'rejoined', left, rejoin: { ...here, time } })

const real = (n: number) => Number.isFinite(n)

/** The place a fix puts the driver, or null when the tracker's numbers for it are not real. */
function placeOf(fix: RouteFix): LeftAt | null {
  if (!real(fix.along) || !real(fix.furthest) || !real(fix.at.lat) || !real(fix.at.lng)) return null
  return { along: fix.along, furthest: fix.furthest, at: fix.at }
}

/** When a fix was taken, or null when that isn't known. */
const timeOf = (fix: RouteFix): number | null => (typeof fix.time === 'number' && real(fix.time) ? fix.time : null)

/** How many milliseconds from one time to another, none if time went backwards, or null when either is not known. */
const elapsed = (from: number | null, to: number | null): number | null => (from === null || to === null ? null : Math.max(0, to - from))

/** A time something was counted from, once the clock has gone backwards past it: counted from the earlier time, so that it doesn't wait for the clock to catch up. */
const anchored = (from: number | null, now: number | null): number | null => (from !== null && now !== null && now < from ? now : from)

/** Whether the phone is going somewhere: it says it is, or doesn't say. */
const moving = (fix: RouteFix): boolean => fix.speed === null || !(fix.speed < MOVING_MPS)

/**
 * What a fix says about where the phone is. A fix that says too little to go by (poor, or its distance from the route is not
 * a real distance, or it claims to be on the route at a place that is not one) is 'unheard'. 'far' is well away from the route and
 * moving; 'near' is on it; anything else is 'between', such as 40 to 50 metres out, standing still, or a place the tracker is doubting.
 */
type Reading = 'unheard' | 'far' | 'near' | 'between'

function read(fix: RouteFix): Reading {
  const { accuracy, gap } = fix
  if (!(accuracy >= 0 && accuracy <= OFF_MAX_ACCURACY_M) || !(gap >= 0)) return 'unheard'
  if (moving(fix) && gap > Math.max(OFF_ROUTE_M, ACCURACY_FACTOR * accuracy)) return 'far'
  if (!fix.lost && gap <= ON_ROUTE_M) return fix.doubt ? 'between' : placeOf(fix) ? 'near' : 'unheard'
  return 'between'
}

/**
 * Whether a fix is out of the route enough to count as having strayed from it. A phone the tracker has lost is further than that from it;
 * the gap of a place the tracker is merely doubting (whatever the fix is called) is a distance from the place it doubts, and for a street
 * driven twice that is a few metres, so only a gap of its own counts.
 */
const strays = (fix: RouteFix): boolean => fix.gap > AWAY_M

/**
 * Whether the phone is on its way somewhere, as far as a reminder goes: it says it is going, or (when it doesn't say how fast) it has got
 * somewhere new since the last reminder, by more than the error of a fix would carry it.
 */
function going(state: OffState, fix: RouteFix): boolean {
  if (fix.speed !== null) return moving(fix)
  return state.remindedFrom === null || !(haversine(state.remindedFrom, fix.at) < Math.max(REMIND_MOVE_M, JITTER_FACTOR * fix.accuracy))
}

/** Whether a near fix is at the place the route was left, or near enough to it: always, when there is nowhere it was left. */
const nearLeft = (left: LeftAt | null, fix: RouteFix): boolean => left === null || Math.abs(fix.along - left.along) <= REJOIN_NEAR_M

/**
 * How much further along the route a fix is than the ground from the place last followed can explain, in metres (either way along it): more
 * than LEAP_M is a jump, and more than BIG_LEAP_M a big one.
 */
const leap = (left: LeftAt, fix: RouteFix): number => Math.abs(fix.along - left.along) - haversine(left.at, fix.at)

/** Whether the fixes near the route have covered ground enough to be driving along it rather than across it. */
const ranFar = (from: Pt | null, fix: RouteFix): boolean => from === null || !(haversine(from, fix.at) < REJOIN_RUN_M)

/**
 * Whether a move along the route from the place last followed is the driver having driven it unseen (see `RouteFix.blind`): the time since that
 * place was followed explains it, at BLIND_MPS. Not when that time is not known.
 */
function drivenUnseen(state: OffState, fix: RouteFix): boolean {
  const span = elapsed(state.followedAt, timeOf(fix))
  return fix.blind === true && state.left !== null && span !== null && Math.abs(fix.along - state.left.along) <= (span / 1000) * BLIND_MPS
}

/**
 * One more far fix in a run of them, and whether the run is long enough to be off the route. A run whose fixes are far apart in time
 * is not a run (a far fix, a long pause, and two more are not three in a row), so it starts again; and a clock gone backwards
 * counts from the earlier time.
 */
function countFar(run: OffState['far'], time: number | null): { run: OffState['far']; due: boolean } {
  const span = elapsed(run.since, time)
  const fresh = run.fixes === 0 || (span !== null && span > run.fixes * RUN_GAP_SECONDS * 1000)
  const fixes = fresh ? 1 : run.fixes + 1
  const since = fresh ? time : anchored(run.since, time)
  const waited = elapsed(since, time)
  // With no times to go by, the fixes alone will do.
  return { run: { fixes, since }, due: fixes >= OFF_FIXES && (waited === null || waited >= OFF_SECONDS * 1000) }
}

type Step = { state: OffState; event: OffEvent }

/**
 * On the route: count the fixes far from it, and go off when there have been enough, for long enough. A jump along the route after straying
 * (a fix on the route much further along it than the ground from the place last followed explains) is held back like a rejoining: told once it
 * has gone on for some distance, since a street crossed would otherwise be told too, and until then the place last followed is kept. So is a
 * jump bigger than BIG_LEAP_M without straying, and the run it starts goes on to the end, as one after straying does: but not on the way to where
 * the round was started, skipped to or carried on from (`approaching`), nor when the phone was unseen and the time since the place last followed
 * explains it (`blind`), which are the driver's own way along the route.
 */
function stepOn(state: OffState, fix: RouteFix, reading: Reading): Step {
  const time = timeOf(fix)
  if (reading === 'near') {
    const here = placeOf(fix)!
    const jump = state.left ? leap(state.left, fix) : 0
    if (jump > LEAP_M && (state.away || state.near > 0 || (jump > BIG_LEAP_M && !fix.approaching && !drivenUnseen(state, fix)))) {
      const near = state.near + 1
      const nearFrom = state.near === 0 ? fix.at : state.nearFrom
      // (A single fix covers no ground, so this is never the first.)
      if (ranFar(nearFrom, fix)) return { state: rejoinedAt(state.left, here, time), event: 'rejoined-elsewhere' }
      return { state: { ...state, far: noFar, near, nearFrom }, event: null }
    }
    return { state: onAt(here, fix.gap > AWAY_M, time), event: null }
  }
  const away = state.away || strays(fix)
  const quiet = state.far.fixes === 0 && state.near === 0 && away === state.away
  if (reading !== 'far') return { state: quiet ? state : { ...state, far: noFar, near: 0, nearFrom: null, away }, event: null }
  const counted = countFar(state.far, time)
  if (counted.due) return { state: offFrom(state.left, time, fix.at), event: 'went-off' }
  return { state: { ...state, far: counted.run, near: 0, nearFrom: null, away }, event: null }
}

/** Off the route: count the fixes near it, and say when the driver is back, or somewhere else on the route. Otherwise remind now and then. */
function stepOff(state: OffState, fix: RouteFix, reading: Reading): Step {
  const time = timeOf(fix)
  const near = reading === 'near' ? state.near + 1 : 0
  const nearFrom = near === 0 ? null : near === 1 ? fix.at : state.nearFrom
  if (near >= BACK_FIXES) {
    if (nearLeft(state.left, fix)) return { state: onAt(placeOf(fix), false, time), event: 'back' }
    // Somewhere else on the route: not a street crossed, but driven along.
    if (ranFar(nearFrom, fix)) return { state: rejoinedAt(state.left, placeOf(fix)!, time), event: 'rejoined-elsewhere' }
  }
  const since = anchored(state.remindedAt, time)
  const quiet = elapsed(since, time)
  // A phone going nowhere is not reminded, however long: the clock waits, and the reminder comes when it has gone somewhere. Nor is one that
  // is on the route as this is said, since it may be back: the reminder waits to see.
  if (quiet !== null && quiet >= REMIND_SECONDS * 1000 && going(state, fix) && near === 0) return { state: { ...state, near, nearFrom, remindedAt: time, remindedFrom: fix.at }, event: 'remind' }
  // Went off with no time to go by, and one has come: the reminders count from here.
  return { state: { ...state, near, nearFrom, remindedAt: since ?? time }, event: null }
}

/** The clock of a rejoining, once the first fix with a time has come, and once it has gone backwards: counted from the earlier time. */
function clocked(state: OffState, time: number | null): OffState {
  const { rejoin } = state
  if (!rejoin) return state
  const from = rejoin.time === null ? time : anchored(rejoin.time, time)
  return from === rejoin.time ? state : { ...state, rejoin: { ...rejoin, time: from } }
}

/** Back on the route in a new place, waiting to hear what to do: back if they return to where it was left, off again if they stray, on by itself after a while. */
function stepRejoined(state: OffState, fix: RouteFix, reading: Reading): Step {
  const time = timeOf(fix)
  if (reading === 'near' && nearLeft(state.left, fix)) return { state: onAt(placeOf(fix), false, time), event: 'back' }
  const ticking = clocked(state, time)
  if (reading === 'far') {
    const counted = countFar(ticking.far, time)
    if (counted.due) return { state: offFrom(ticking.left, time, fix.at), event: 'went-off' }
    return { state: { ...ticking, far: counted.run }, event: null }
  }
  const calm = ticking.far.fixes === 0 ? ticking : { ...ticking, far: noFar }
  // The clock is of time on the new part of the route, so a fix that is not near doesn't stop it. But the round carries on from
  // a place that is on the route, and from a driver who is going somewhere, so it waits for a fix that has both.
  const driven = elapsed(calm.rejoin?.time ?? null, time)
  if (driven !== null && driven >= CARRY_ON_SECONDS * 1000 && reading === 'near' && moving(fix)) return { state: onAt(placeOf(fix), false, time), event: 'carried-on' }
  return { state: calm, event: null }
}

/**
 * Being taken back to where the route was left: quiet, until the driver is there, or strays. A driver who goes on along the route
 * instead, getting no nearer to the place left, is carried on from where they are.
 */
function stepReturning(state: OffState, fix: RouteFix, reading: Reading): Step {
  const time = timeOf(fix)
  if (reading === 'far') {
    const counted = countFar(state.far, time)
    if (counted.due) return { state: offFrom(state.left, time, fix.at), event: 'went-off' }
    return { state: { ...state, far: counted.run }, event: null }
  }
  const calm = state.far.fixes === 0 ? state : { ...state, far: noFar }
  if (reading === 'near') {
    const here = placeOf(fix)!
    if (nearLeft(state.left, fix)) {
      const near = calm.near + 1
      if (near >= BACK_FIXES) return { state: onAt(here, false, time), event: 'back' }
      return { state: { ...calm, near }, event: null }
    }
    // On the new part of the route, going to where it was left: nothing changes, unless they are getting nowhere.
    const away = Math.abs(fix.along - state.left!.along)
    const closest = calm.rejoin ? Math.abs(calm.rejoin.along - state.left!.along) : null
    if (closest === null || away < closest) return { state: { ...calm, rejoin: { ...here, time } }, event: null }
    if (away - closest >= RETURN_GIVE_UP_M) return { state: onAt(here, false, time), event: 'carried-on' }
    return { state: calm, event: null }
  }
  return { state: calm.near === 0 ? calm : { ...calm, near: 0 }, event: null }
}

/**
 * The next state after a fix, and what to tell the driver. A fix that says too little to go by (see `read`) changes nothing: the
 * same state comes back. The state it is given is never changed.
 */
export function stepOffRoute(state: OffState, fix: RouteFix): { state: OffState; event: OffEvent } {
  const reading = read(fix)
  if (reading === 'unheard') return { state, event: null }
  switch (state.phase) {
    case 'on':
      return stepOn(state, fix, reading)
    case 'off':
      return stepOff(state, fix, reading)
    case 'rejoined':
      return stepRejoined(state, fix, reading)
    case 'returning':
      return stepReturning(state, fix, reading)
    default:
      return { state, event: null }
  }
}

/**
 * The driver chose to carry on from here: the round is on the route again from this place. Nothing to do when it already is. When the
 * fix has no place on the route to give (the phone is lost or the tracker is in doubt), it is where the driver came back onto it.
 */
export function carryOnHere(state: OffState, fix: RouteFix): OffState {
  if (state.phase === 'on') return state
  const here = fix.lost || fix.doubt ? null : placeOf(fix)
  const back = state.rejoin ? { along: state.rejoin.along, furthest: state.rejoin.furthest, at: state.rejoin.at } : null
  return onAt(here ?? back ?? state.left)
}

/** The driver chose to be taken back to where the route was left: keep guiding there. Back on the route if there is nowhere to go back to. */
export function takeMeBack(state: OffState): OffState {
  if (state.phase === 'on') return state
  if (state.left === null) return onAt(null)
  // Where they came back onto the route is where they are nearest, so far, to where it was left.
  return { ...startOffRoute, phase: 'returning', left: state.left, rejoin: state.phase === 'rejoined' ? state.rejoin : null }
}

/**
 * What the Round screen keeps beside the machine's state, from fix to fix, to tell it what a fix alone does not: whether the phone has been
 * unseen since the place last followed (`RouteFix.blind`), and whether it is still on its way to where the round was started, skipped to or
 * carried on from (`RouteFix.approaching`). It is kept by the plain functions below, so that a drive played through the machine in a test keeps
 * it just as the screen does.
 */
export interface OffWatch {
  /** When the last fix that the machine could go by (OFF_MAX_ACCURACY_M or better) was taken, in milliseconds, or null before the first. */
  goodAt: number | null
  /** The phone has been unseen since the place last followed: more than BLIND_GAP_MS without a fix to go by, or a fix the machine was not asked about. */
  blind: boolean
  /** The phone has been on the route within ARRIVE_NEAR_M along it of where the round was started, skipped to or carried on from, or past it. */
  arrived: boolean
}

/** Nothing seen yet, and on the way to where the round starts. Shared, so frozen. */
export const startOffWatch: OffWatch = Object.freeze({ goodAt: null, blind: false, arrived: false })

/**
 * Every fix the phone gives, before the tracker has it, whatever it makes of it (taken in, set aside, or standing still). One the machine could go
 * by, more than BLIND_GAP_MS after the last, leaves the phone unseen since the place last followed, until the machine follows the route from a new
 * place (`stepWatched`): a phone in the background, or under poor sky, has had time to drive on unseen. A fix with no time to go by changes nothing.
 */
export function watchFix(watch: OffWatch, fix: { accuracy: number; time?: number | null }): OffWatch {
  const time = typeof fix.time === 'number' && real(fix.time) ? fix.time : null
  if (time === null || !(fix.accuracy >= 0 && fix.accuracy <= OFF_MAX_ACCURACY_M)) return watch
  const since = elapsed(watch.goodAt, time)
  const blind = watch.blind || (since !== null && since > BLIND_GAP_MS)
  return { ...watch, goodAt: time, blind }
}

/**
 * Ask the machine about a fix, as the Round screen does once the route has been reached, telling it what the watch knows: whether the phone has
 * been unseen, and whether it is still on its way to `from` (how far along the route the round was started, skipped to or carried on from). That
 * goes by the fixes before this one, so that a jump that lands at the spot or past it is taken up as well. The watch comes back with this fix in
 * it: there, once the phone is on the route within ARRIVE_NEAR_M along it of the spot or past it; and seen again, once the machine follows the
 * route from a new place (its doubting fixes, which keep the old place, keep the phone unseen). And the fix as the machine was given it.
 */
export function stepWatched(watch: OffWatch, state: OffState, fix: RouteFix, from: number): { watch: OffWatch; state: OffState; event: OffEvent; fix: RouteFix } {
  const told: RouteFix = { ...fix, blind: watch.blind, approaching: !watch.arrived }
  const step = stepOffRoute(state, told)
  const arrived = watch.arrived || (read(fix) === 'near' && fix.along >= from - ARRIVE_NEAR_M)
  const blind = watch.blind && !(step.state.phase === 'on' && step.state.left !== state.left)
  return { ...step, watch: arrived === watch.arrived && blind === watch.blind ? watch : { ...watch, arrived, blind }, fix: told }
}

/**
 * A fix the machine would have been asked about, and was not (the phone is beside a stop away from the route, on the app's own errand): the place
 * last followed is not kept up to date by it, so the phone is as good as unseen.
 */
export const unasked = (watch: OffWatch): OffWatch => (watch.blind ? watch : { ...watch, blind: true })

/**
 * The round was started, skipped to or carried on from somewhere (the machine starting afresh with it): on the way there, with no place followed
 * yet. When the last fix to go by was taken is the phone's, and is kept.
 */
export const restartWatch = (watch: OffWatch): OffWatch => ({ goodAt: watch.goodAt, blind: false, arrived: false })

/** Which way, as it is said to a driver. */
export type GuideWhere = 'ahead' | 'behind' | 'on your left' | 'on your right'

const WHERE: Record<ReturnType<typeof screenPlace>, GuideWhere> = { top: 'ahead', bottom: 'behind', left: 'on your left', right: 'on your right' }

/**
 * How far it is to where the route was left, to the nearest metre, and which way, for the way the phone is heading (null when
 * it can't say, or when the driver is already there).
 */
export function guideToLeft(driver: Pt, left: LeftAt, heading: number | null): { metres: number; where: GuideWhere | null } {
  const apart = haversine(driver, left.at)
  const metres = real(apart) ? Math.round(apart) : 0
  if (!(metres > 0) || heading === null || !real(heading)) return { metres, where: null }
  return { metres, where: WHERE[screenPlace(bearing(driver, left.at), heading)] }
}

/**
 * What to say aloud for each event. When the route is picked up somewhere else, `deltaM` is how far along the route from where it was left:
 * positive for further on, negative for earlier on.
 */
export function offRouteSpeech(event: Exclude<OffEvent, null>, deltaM = 0): string {
  switch (event) {
    case 'went-off':
      return 'Off route.'
    case 'remind':
      return 'Still off route.'
    case 'back':
      return 'Back on route.'
    case 'carried-on':
      return 'Carrying on from here.'
    case 'rejoined-elsewhere': {
      const metres = real(deltaM) ? Math.abs(deltaM) : 0
      const way = deltaM >= 0 ? 'further on' : 'earlier on'
      const spoken = spokenMetres(metres)
      // A thousand metres or what is said as one: kilometres, to a tenth, and a whole number of them without the point, which a voice reads out.
      if (metres >= 1000 || spoken >= 1000) {
        const km = Math.round(metres / 100) / 10
        return `Back on the route, ${Number.isInteger(km) ? `${km} ${km === 1 ? 'kilometre' : 'kilometres'}` : `${km.toFixed(1)} kilometres`} ${way}.`
      }
      return spoken > 0 ? `Back on the route, ${spoken} metres ${way}.` : 'Back on the route.'
    }
  }
}
