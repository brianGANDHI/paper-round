import { byPosition, haversine, type Occurrence } from './geo'
import { AWAY_M, BIG_LEAP_M, BLIND_MPS, LEAP_M, OFF_MAX_ACCURACY_M, ON_ROUTE_M, type LeftAt, type OffState } from './offRoute'
import { offRouteGap, type Progress } from './progress'
import type { StopType } from './types'

/*
 * A trip to a stop that is away from the route is the app's own errand, and not leaving the route: the off-route machine is not asked about the
 * fixes of it (see `unasked` in offRoute.ts). Nor is the drive back to the route once the stop is done, which is part of the same trip. When the
 * trip is over the machine is told where the phone was last on the route, and whether it has since come back onto it somewhere else, which is
 * asked about as it is after any time off the route.
 */

/** A stop that is away from the route is being visited, not left for, within how far off the route it is, its alert distance and this much, in metres. */
export const OFF_ROUTE_STOP_M = 60

/** Where the phone was on the route, and when that was (null when that isn't known). */
export interface OnRouteAt {
  left: LeftAt
  time: number | null
}

/** A visit to stops away from the route, as far as it has gone. */
export interface StopVisit {
  /** The stops the phone has been beside since it was last on the route (their ids): one done since is still being visited, on the drive back from it. */
  ids: ReadonlySet<string>
  /** Whether the last fix seen was beside one of them: a visit is going on. */
  beside: boolean
  /** Where the phone was last on the route: a good fix on it (see `onRoute`), or where a visit came back to it (see `stepVisit`). */
  lastOn: OnRouteAt | null
  /** Whether the last fix seen was a good one on the route: it takes two in a row to end a visit, as it does to be back on the route. */
  onBefore: boolean
  /**
   * When fixes of a visit had the phone away from the route, the first and the last of them, until it is known where the visit came back to the
   * route: good fixes beyond AWAY_M or lost, and poor ones too far from the route for their error to put the phone on it.
   */
  away: { first: number | null; last: number | null } | null
  /** Where the phone left the route, when the visit has come back to it somewhere else since (see `stepVisit`). */
  backFrom: OnRouteAt | null
}

/** No visit, and nothing known of the route yet. */
export const noVisit: StopVisit = Object.freeze({ ids: new Set<string>(), beside: false, lastOn: null, onBefore: false, away: null, backFrom: null })

/** What the machine is to be told when a visit is over: where the phone was last on the route, and whether it has come back onto it somewhere else since. */
export interface VisitEnd {
  left: LeftAt
  time: number | null
  elsewhere: boolean
}

export interface VisitStep {
  visit: StopVisit
  /** Whether the fix is part of a visit, which the off-route machine is not asked about. */
  beside: boolean
  /** When this fix ends a visit, what the machine is to be told before it is asked about the fix (see `visitOver`). */
  ended: VisitEnd | null
}

/**
 * A good fix on the route: as good as the off-route machine needs (see OFF_MAX_ACCURACY_M), near the place the tracker has the phone at (not only
 * near some part of the route), and not a jump the tracker is still weighing up (`doubt`).
 */
const onRoute = (now: Progress): boolean => !now.lost && now.doubt === null && now.accuracy <= OFF_MAX_ACCURACY_M && now.gap <= ON_ROUTE_M

/** A fix that has the phone away from the route: a good one beyond AWAY_M of it, or lost, or a poor one further from it than its error and ON_ROUTE_M. */
const awayFrom = (now: Progress): boolean =>
  now.accuracy <= OFF_MAX_ACCURACY_M ? now.lost || offRouteGap(now) > AWAY_M : offRouteGap(now) - now.accuracy > ON_ROUTE_M

/** How many milliseconds from one time to another, none if time went backwards or either is not known. */
const span = (from: number | null, to: number | null): number => (from === null || to === null ? 0 : Math.max(0, to - from))

/**
 * How far along the route the phone is, when the tracker has it near a place on the route: the place it is weighing up a jump to, if any. Null when
 * it is not near the place the tracker has (only near some other part of the route), or lost with no place in mind.
 */
function nearAlong(now: Progress): number | null {
  if (!(now.gap <= ON_ROUTE_M)) return null
  if (now.doubt) return now.doubt.along
  return now.lost ? null : now.along
}

/**
 * One more fix taken in, once the route has been reached: one weighed for leaving the route, or one with the phone standing still, which is not, but
 * is the phone seen where it is, so that time stood still is not time unseen. It is beside a stop away from the route (one placed by where the phone
 * is, see `byPosition`) when within how far off the route the stop is, its alert distance and OFF_ROUTE_STOP_M of it, and the stop is not done yet,
 * or is one the phone has been visiting since it was last on the route. Two good fixes on the route in a row end the visit (one could be a parked
 * phone's fix wandering towards the road), so leaving the route again near a stop that is done is leaving the route; so does a fix beside none of them.
 */
export function stepVisit(visit: StopVisit, now: Progress, occs: readonly Occurrence[], handled: ReadonlySet<string>, radius: Record<StopType, number>): VisitStep {
  let { ids, lastOn, away, backFrom } = visit
  const on = onRoute(now)
  const near = nearAlong(now)
  if (away && near !== null && lastOn) {
    // Near the route again after a visit took the phone away from it. A move along the route from where it left that the ground between explains is
    // coming back there; and so is a jump the time unseen could explain, at a good fix on the route, since the phone may have driven it unseen. Unseen
    // is between being on the route and the first fix away from it, and between the last away from it and this one: the visit itself was off the
    // route. A jump it can't explain is coming back somewhere else, until a later fix near the route has the phone back where it left after all (the
    // first fix near it can be on another pass of the street, or a poor one): the machine is told at the end of the visit.
    const moved = Math.abs(near - lastOn.left.along)
    const jumps = moved - haversine(lastOn.left.at, now.at) > LEAP_M
    // (Once a fix has come back somewhere else, the time since it is not time unseen: the phone has been near the route all along.)
    const unseen = span(lastOn.time, away.first) + span(away.last, now.time)
    if (jumps && (backFrom !== null || moved > (unseen / 1000) * BLIND_MPS)) backFrom = lastOn
    else if (!jumps || on) {
      backFrom = null
      away = null
      lastOn = { left: { along: near, furthest: now.furthest, at: now.at }, time: now.time }
    }
  }
  // A good fix on the route is where the phone was last on it, but not while it is still to be known where a visit came back to the route, nor
  // when, during a visit, it is a jump along the route bigger than BIG_LEAP_M beyond the ground between: a turn missed onto another part of the route,
  // which the machine, not asked meanwhile, would have held (see `stepOn`). It is given the place before the jump at the end of the visit, and asks.
  const leapt = visit.beside && lastOn !== null && Math.abs(now.along - lastOn.left.along) - haversine(lastOn.left.at, now.at) > BIG_LEAP_M
  if (on && !away && !leapt) lastOn = { left: { along: now.along, furthest: now.furthest, at: now.at }, time: now.time }
  if (on && visit.onBefore) ids = noVisit.ids
  const beside = occs.filter((o) => byPosition(o, radius) && (!handled.has(o.key) || ids.has(o.stop.id)) && haversine(now.at, o.stop) <= o.off + radius[o.stop.type] + OFF_ROUTE_STOP_M)
  if (!beside.length) {
    const ended: VisitEnd | null = visit.beside && lastOn ? { left: (backFrom ?? lastOn).left, time: (backFrom ?? lastOn).time, elsewhere: backFrom !== null } : null
    return { visit: { ids: noVisit.ids, beside: false, lastOn, onBefore: on, away: null, backFrom: null }, beside: false, ended }
  }
  // A fix of the phone away from the route, beside a stop, is the visit's time off the route.
  if (near === null && awayFrom(now)) away = { first: away ? away.first : now.time, last: now.time }
  // Every stop beside the phone is kept, not just one: two up the same drive, or one not done yet beside the one being visited, would otherwise take the
  // visit over, and the drive back past the first would be leaving the route.
  const kept = beside.every((o) => ids.has(o.stop.id)) ? ids : new Set([...ids, ...beside.map((o) => o.stop.id)])
  return { visit: { ids: kept, beside: true, lastOn, onBefore: on, away, backFrom }, beside: true, ended: null }
}

/**
 * A fix of the phone standing where the tracker last put it, which the tracker leaves there and says nothing new of (see `standsStill`): the phone
 * is seen where it was, so time stood still beside a stop, away from the route or on it, is not time unseen.
 */
export function stillSeen(visit: StopVisit, time: number | null): StopVisit {
  if (!visit.beside || time === null) return visit
  const { away, lastOn } = visit
  if (away) return away.last !== null && away.last >= time ? visit : { ...visit, away: { ...away, last: time } }
  return visit.onBefore && lastOn && !(lastOn.time !== null && lastOn.time >= time) ? { ...visit, lastOn: { ...lastOn, time } } : visit
}

/**
 * The off-route machine told that a visit is over (see `VisitStep.ended`), before it is asked about the fix that ends it. It was not asked about the
 * visit, so its place is from before it: it is given the place the phone was last on the route at, and, when the visit came back to the route
 * somewhere else, told that the phone has been away, so the jump is asked about as one after any straying is, and the driver can be taken back to
 * where they left it. Only while it has the phone on the route; otherwise it is as it was. So is a machine holding a jump (one visit can end
 * as the car comes onto another street of the route, and the next begin before it has gone far enough along it to be asked): it goes on with it.
 */
export function visitOver(state: OffState, ended: VisitEnd | null): OffState {
  if (!ended || state.phase !== 'on') return state
  if (ended.elsewhere) return { ...state, left: ended.left, followedAt: ended.time, away: true }
  return state.near > 0 ? state : { ...state, left: ended.left, followedAt: ended.time }
}
