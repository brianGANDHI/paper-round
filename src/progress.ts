import { angleBetween, bearing, cumulativeDistances, distToSegment, haversine, project } from './geo'
import type { Pt } from './types'

/**
 * Where the driver has got to along the route, kept honestly from one GPS fix to the next.
 *
 * Working out the nearest part of the route to each fix on its own can't tell the passes of a street driven
 * twice apart, since they lie on the same line. So every fix is judged against where the driver was a moment ago:
 * a spot that is much further on than the phone can have moved, or behind it, counts against it; so does a spot
 * where the route runs the opposite way to the one the phone is heading. A jump somewhere else is only believed
 * once it has been seen several fixes in a row, and a fix too far from the route to say anything leaves the
 * position where it was. A fix that is poor, a repeat of one already seen, or further from the last than a car
 * can have gone is set aside, and a phone standing still doesn't move at all, since its jitter would otherwise
 * flip it between the passes of a street driven twice.
 */

/** A route prepared for tracking: its points, how far along each is, and the way each stretch heads. */
export interface Track {
  points: Pt[]
  /** Metres along the route to each point. */
  cum: number[]
  /** The way each stretch heads, in degrees clockwise from north. */
  bearings: number[]
  /** Each point in local metres, for measuring distances. */
  xy: [number, number][]
  refLat: number
}

export function makeTrack(points: Pt[]): Track {
  const refLat = points[0]?.lat ?? 0
  return {
    points,
    cum: cumulativeDistances(points),
    bearings: points.slice(0, -1).map((p, i) => bearing(p, points[i + 1])),
    xy: points.map((p) => project(p, refLat)),
    refLat,
  }
}

export interface Progress {
  /** The stretch of the route the driver is on, and how far along it: 0 at its start, 1 at its end. */
  idx: number
  t: number
  /** How far along the route, in metres. */
  along: number
  /** The furthest the driver has got along the route, in metres. It never goes back. */
  furthest: number
  /** How far the phone is from the route, in metres. */
  gap: number
  /** The fix this came from, how accurate it was and when (in milliseconds), to tell how far the phone has moved since, and how fast. */
  at: Pt
  accuracy: number
  time: number | null
  /** When the latest fix looked at was taken, even if it was set aside, so that the same one coming again is not counted again. */
  seen: number | null
  /** True when the phone is too far from the route to say where along it the driver is. */
  lost: boolean
  /** A jump to somewhere else along the route that has been seen but is not yet believed: where, and how many fixes in a row. */
  doubt: { along: number; fixes: number } | null
  /** How many fixes in a row have had the phone moving but the driver going backwards along the route, which they can't be. */
  backward: number
  /** How many fixes in a row have been set aside as further from the last than a car can have gone. */
  outliers: number
  /** The last few places along the route, so that the furthest reached lags a fix or two behind and can't be poisoned by a pass guessed wrong for just that long. */
  recent: number[]
}

/** What a fix is: where, how accurate, when, and how fast the phone says it is going (null when it can't say). */
export interface GpsFix extends Pt {
  accuracy: number
  time?: number
  speed?: number | null
}

/** A stretch further than this from the fix, in metres (or three times its accuracy), is not where the driver is. */
const REACH_M = 60
/** What a stretch running the opposite way to the phone's heading costs, in metres of distance (half that at right angles). */
const HEADING_COST_M = 50
/** How far on, past how far the phone has moved and its accuracy, is still believable, in metres. */
const SLACK_M = 20
/** How far behind, plus the accuracy, is still jitter rather than going back, in metres. */
const BACK_SLACK_M = 15
/**
 * The driver follows the route forwards, so how far they have got should match how far the phone has moved. What
 * each metre of difference costs. On a street driven out and back the two passes are the same line and fit the fix
 * equally well; this is what tells them apart, since only one has the driver moving on rather than back.
 */
const PACE_COST = 0.25
/** What each metre further on than the phone can have moved, or further behind, costs. */
const STRAY_COST = 0.6
/** With nothing to go by, or after being lost, the nearest spot ahead of the last one is preferred: what each metre of distance costs. */
const AHEAD_COST = 0.1
/** A move along the route bigger than the phone's own movement by this much, in metres, needs confirming. */
const JUMP_M = 100
/** The place to go to when the driver has been going backwards must fit the fix and heading within this much of the best fit, in metres of cost. */
const RECOVERY_MARGIN = 30
/** Fixes in a row a jump has to be seen for, before it is believed. */
const DOUBT_FIXES = 3
/** Fixes in a row of the phone moving while the driver goes backwards along the route, before that is taken to be a wrong guess. */
const BACKWARD_FIXES = 3
/** Two sightings of a jump are the same one when they are this close along the route, in metres, plus how far the phone moved. */
const DOUBT_NEAR_M = 40
/** The furthest reached only moves on while the phone is this near the route, in metres. */
const FURTHEST_GAP_M = 30
/** No car moves faster than this, in metres a second: how far the phone can have moved between two fixes is capped by it. */
const MAX_SPEED = 40
/** A fix that implies going faster than this, in metres a second, is a glitch, if it claims to be accurate. */
const OUTLIER_SPEED = 30
/** A fix claiming to be better than this, in metres, can be a glitch. */
const OUTLIER_ACCURACY_M = 30
/** After this many in a row set aside, the next is believed: the driver really did go that far, as when coming out of a tunnel. */
const OUTLIER_MAX = 2
/** A fix less accurate than this, in metres, says too little to go by. */
export const MAX_ACCURACY_M = 65
/** The phone is standing still when it says it is going slower than this, in metres a second, or can't say. */
const STILL_SPEED = 1.5
/** And it has moved less than this, in metres, from the fix it was last put at (or 0.7 times its accuracy, if more). */
const STILL_M = 6
/** How many places the furthest reached lags behind. */
const RECENT = 3
interface Candidate {
  idx: number
  t: number
  along: number
  dist: number
  /** Distance, plus what disagreeing with the phone's heading costs. */
  geo: number
  /** That, plus what disagreeing with where the driver has been costs. */
  cost: number
}

/** The position at `along` metres: where a round that is carried on, or started part way, begins. The driver is not on the route yet. */
export function startProgress(track: Track, along: number): Progress {
  const { points, cum } = track
  const a = Math.min(Math.max(0, along), cum[cum.length - 1] ?? 0)
  let idx = 0
  while (idx < points.length - 2 && cum[idx + 1] <= a) idx++
  const span = (cum[idx + 1] ?? cum[idx]) - cum[idx]
  const t = span > 0 ? (a - cum[idx]) / span : 0
  const at = points[idx] && points[idx + 1] ? { lat: points[idx].lat + (points[idx + 1].lat - points[idx].lat) * t, lng: points[idx].lng + (points[idx + 1].lng - points[idx].lng) * t } : (points[0] ?? { lat: 0, lng: 0 })
  return { idx, t, along: a, furthest: a, gap: 0, at, accuracy: 0, time: null, seen: null, lost: true, doubt: null, backward: 0, outliers: 0, recent: [] }
}

/**
 * The driver's progress after a fix. `prev` is the progress before it (from `startProgress` for a round started
 * part way, or null for one with nothing to go by), `heading` the way the phone is going, in degrees clockwise
 * from north, or null when it can't say.
 */
export function advance(track: Track, prev: Progress | null, fix: GpsFix, heading: number | null): Progress | null {
  const { points, cum, bearings, xy, refLat } = track
  const segs = points.length - 1
  if (segs < 1) return null
  const time = fix.time ?? null
  // A fix that says too little, or one already seen (or older), changes nothing.
  if (fix.accuracy > MAX_ACCURACY_M) return prev
  if (prev && time !== null && (prev.seen ?? prev.time) !== null && time <= (prev.seen ?? prev.time)!) return prev
  if (prev && !prev.lost) {
    // A fix further from the last than a car can have gone, claiming to be accurate, is a glitch: it is set aside, a couple of
    // times, and believed only if it keeps on.
    if (prev.time !== null && time !== null && prev.outliers < OUTLIER_MAX && fix.accuracy <= OUTLIER_ACCURACY_M) {
      const seconds = Math.max(0.5, (time - prev.time) / 1000)
      if (haversine(prev.at, fix) / seconds > OUTLIER_SPEED) return { ...prev, outliers: prev.outliers + 1, seen: time }
    }
    // A phone standing still stays where it was put, however it jitters.
    if ((fix.speed === null || fix.speed === undefined || fix.speed < STILL_SPEED) && haversine(prev.at, fix) < Math.max(STILL_M, 0.7 * fix.accuracy)) return prev
  }
  const p = project(fix, refLat)
  const accuracy = Math.max(5, fix.accuracy)
  // How far the phone has moved since the last fix, but no more than a car could have in the time between them.
  let moved = prev && !prev.lost ? haversine(prev.at, fix) : 0
  if (prev && time !== null && prev.time !== null) moved = Math.min(moved, MAX_SPEED * Math.max(0.2, (time - prev.time) / 1000) + 2 * accuracy)
  const reach = Math.max(REACH_M, 3 * accuracy)

  const cands: Candidate[] = []
  let nearest: Candidate | null = null
  for (let i = 0; i < segs; i++) {
    const { dist, t } = distToSegment(p, xy[i], xy[i + 1])
    const along = cum[i] + t * (cum[i + 1] - cum[i])
    if (!nearest || dist < nearest.dist) nearest = { idx: i, t, along, dist, geo: dist, cost: dist }
    if (dist > reach) continue
    let geo = dist
    if (heading !== null) geo += (HEADING_COST_M * (1 - Math.cos((angleBetween(bearings[i], heading) * Math.PI) / 180))) / 2
    cands.push({ idx: i, t, along, dist, geo, cost: geo })
  }
  if (!nearest) return null

  // Too far from the route to say anything: the driver is where they were, and the next fix on the route starts afresh.
  if (!cands.length) {
    return {
      idx: prev?.idx ?? nearest.idx,
      t: prev?.t ?? nearest.t,
      along: prev?.along ?? nearest.along,
      furthest: prev?.furthest ?? 0,
      gap: nearest.dist,
      at: fix,
      accuracy: fix.accuracy,
      time,
      seen: time,
      lost: true,
      doubt: null,
      backward: 0,
      outliers: 0,
      recent: [],
    }
  }

  const backSlack = BACK_SLACK_M + accuracy
  const forwardSlack = moved + 2 * accuracy + SLACK_M
  const fresh = !prev || prev.lost
  // With nothing to go by the round is taken to be at its start, so the earliest pass of a place is the likely one.
  const prior = prev ? prev.along : 0
  for (const c of cands) {
    const delta = c.along - prior
    if (fresh) c.cost += AHEAD_COST * Math.max(0, delta)
    else c.cost += PACE_COST * Math.abs(delta - moved) + (delta > forwardSlack ? STRAY_COST * (delta - forwardSlack) : 0)
    if (prev && delta < -backSlack) c.cost += STRAY_COST * (-delta - backSlack)
  }
  const byCost = cands.reduce((a, b) => (b.cost < a.cost ? b : a))
  const byFit = cands.reduce((a, b) => (b.geo < a.geo ? b : a))

  let pick = byCost
  let doubt: Progress['doubt'] = null
  if (prev && !fresh) {
    const delta = byCost.along - prev.along
    // A move along the route much bigger than the phone's own is not believed at once: the driver stays where they were
    // until it has been seen fix after fix.
    if (delta > forwardSlack + JUMP_M || delta < -(backSlack + JUMP_M)) {
      const before = prev.doubt !== null && Math.abs(prev.doubt.along - byCost.along) <= DOUBT_NEAR_M + moved ? prev.doubt : null
      const fixes = (before?.fixes ?? 0) + 1
      if (fixes < DOUBT_FIXES) {
        doubt = { along: byCost.along, fixes }
        pick = { idx: prev.idx, t: prev.t, along: prev.along, dist: byCost.dist, geo: byCost.geo, cost: byCost.cost }
      }
    }
  }
  // The driver follows the route forwards. Moving on while the position goes back along it, fix after fix, means the
  // wrong pass of a street driven twice was guessed: take the nearest place ahead that fits instead.
  let backward = 0
  // A phone that says it has stopped is only jittering, which is not the driver going back.
  const going = fix.speed === null || fix.speed === undefined || fix.speed >= STILL_SPEED
  if (prev && !fresh && going && moved > accuracy && pick.along - prev.along < -accuracy / 2) backward = prev.backward + 1
  if (prev && backward >= BACKWARD_FIXES) {
    const bestFit = byFit.geo + RECOVERY_MARGIN
    const ahead = cands.filter((c) => c.along >= prev.along && c.geo <= bestFit).sort((a, b) => a.along - b.along)[0]
    if (ahead) {
      pick = ahead
      backward = 0
    }
  }
  // The furthest reached only follows what the last few fixes agree on, so a pass guessed wrong for a fix or two can't push it on.
  const recent = [...(prev?.recent ?? []), pick.along].slice(-RECENT)
  const furthest = pick.dist <= FURTHEST_GAP_M ? Math.max(prev?.furthest ?? 0, Math.min(...recent)) : (prev?.furthest ?? 0)
  return { idx: pick.idx, t: pick.t, along: pick.along, furthest, gap: pick.dist, at: fix, accuracy: fix.accuracy, time, seen: time, lost: false, doubt, backward, outliers: 0, recent }
}
