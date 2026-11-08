import { angleBetween, bearing, cumulativeDistances, distToSegment, haversine, project } from './geo'
import type { Pt } from './types'

/**
 * Where the driver has got to along the route, kept honestly from one GPS fix to the next.
 *
 * Working out the nearest part of the route to each fix on its own can't tell the passes of a street driven
 * twice apart, since they lie on the same line. So every fix is judged against where the driver was a moment ago:
 * a spot that is much further on than the phone can have moved, or behind it, counts against it; so does a spot
 * where the route runs the opposite way to the one the phone is heading. A jump somewhere else is only believed
 * once the phone has been seen driving along it several fixes in a row, whether it comes from a place the driver
 * was at or from being lost, since being near a place says nothing of being on it. A fix too far from the route to say
 * anything leaves the position where it was. A driver who turns round, in a court or at the end of a street, is put on the way back
 * once the phone has been heading against the way out for a few fixes, however short of the route's own turning
 * point they turned (and where that is close by, as a U-turn drawn on the spot is, once it has been heading along the
 * way back for two fixes); but only for sure once they have gone 100 m along it, since a car backing up on the way out
 * (past a house, say) heads against it too, and then drives on along it. A fix that is poor, a repeat of one already
 * seen, or further from the last than a car can have gone is set aside, and a phone standing still doesn't move at
 * all, since its jitter would otherwise flip it between the passes of a street driven twice.
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
  /** How far the phone is from the place the tracker has put the driver, in metres: the distance to the stretch it chose, which is not always the nearest part of the route. */
  gap: number
  /**
   * How far the phone is from the nearest part of the route anywhere, in metres. Unlike `gap` it does not depend on the place chosen, so a tracker
   * that keeps its old place (at the junction of a court, while the car drives on along the street) does not make a phone on the route look away from it.
   */
  offBy: number
  /** The fix this came from, how accurate it was and when (in milliseconds), to tell how far the phone has moved since, and how fast. */
  at: Pt
  accuracy: number
  time: number | null
  /** When the latest fix looked at was taken, even if it was set aside, so that the same one coming again is not counted again. */
  seen: number | null
  /** True when the phone is too far from the route to say where along it the driver is. */
  lost: boolean
  /** True when it is lost from a place the driver was really at, which `along` still is: not a round started part way, or begun away from the route. */
  left?: boolean
  /**
   * A jump to somewhere else along the route that has been seen but is not yet believed: where, how many fixes in a row, and where along the route
   * and where on the ground the run of them began, to tell a phone driving along that place from one only going by it (see DOUBT_RUN_M).
   */
  doubt: { along: number; fixes: number; from?: number; start?: Pt } | null
  /** How many fixes in a row have had the phone moving but the driver going backwards along the route (or against its heading), which they can't be. */
  backward: number
  /** How many fixes in a row have been set aside as further from the last than a car can have gone. */
  outliers: number
  /** The last few places along the route, so that the furthest reached lags a fix or two behind and can't be poisoned by a pass guessed wrong for just that long. */
  recent: number[]
  /**
   * A turn round onto the way back that is not sure yet: where along the route the driver was put from, and where to (the place on the way
   * back that fitted the phone best then, which on a route with points every few metres can be a little on from where they were put). A car
   * that backs up on the way out of a street driven out and back (past a house, by up to about 90 m at a brisk reversing pace) heads against
   * the way out just as one that has turned round does, and goes on along the way back as it reverses, so until the driver has gone
   * TURN_SURE_M (100 m) along the way back the furthest reached is held, and driving on against the way back, or being put back at or before
   * where the driver was put from, undoes it. Left out (or null), there is none.
   *
   * `skip` marks the move on at once past the junction of a court (see `advance`), which is held the same way: a car put on the street beyond
   * the court may only have missed the turn into it, and back up or turn round and come back to it, and the court's stops are then to come up
   * as it drives them, not to count as gone by. The run of fixes going back undoes it only back to about where it was made from, the junction.
   */
  turned?: { from: number; to: number; skip?: boolean } | null
  /**
   * How many fixes in a row the phone has been heading out along the way back where the route itself turns round close by (a U-turn drawn as
   * a box, the end of a short court: see FOLD_M), or along the route a little after it, the first with the phone fitting it best (see `advance`):
   * from the second the driver is put there, if they are not already. Left out, none.
   */
  folding?: number
  /** Where along the route the turn round that `folding` counts for is, in metres: a count goes on only along its own way back. */
  foldAt?: number
}

/**
 * How far the phone is from the route, as the off-route machine (offRoute.ts) is to have it: the distance to the nearest part of the route,
 * not to the place the tracker chose. Where the route doubles back the tracker can hold its old place (the junction of a court) while the
 * car drives on along the street, so `gap` climbs for a phone that is on the route all the time, and the driver would be told they were away
 * from it and then that they were back, further on. (Never more than `gap`; the smaller of the two is taken in case of a position built by hand.)
 */
export const offRouteGap = (p: Pick<Progress, 'gap' | 'offBy'>): number => Math.min(p.gap, p.offBy)

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
/**
 * A jump is only believed from a phone driving along the place doubted, since being near a place says nothing of being on it: a car going up to a
 * stop set back from the street and back, or across a street it has yet to drive, is near that street for many fixes, and where the route drives
 * the street twice it is in reach of the later pass as much as of the earlier one. A moving phone says so by its heading: within about 45 degrees of
 * the way the place runs (DRIVEN_ON_SHARE), or the run of sightings starts again. One crawling, too slow for a heading to mean much, says so by how
 * far along the place it has got for the ground it has covered, once it has gone this far from where the run began, in metres.
 */
const DOUBT_RUN_M = 10
/** A phone further than this from the place doubted, in metres (or twice its accuracy, if more), is not on it, whichever way it is going: it is on a road beside it. */
const DOUBT_FIT_M = 40
/** The furthest reached only moves on while the phone is this near the route, in metres. */
const FURTHEST_GAP_M = 30
/** No car moves faster than this, in metres a second: how far the phone can have moved between two fixes is capped by it. */
const MAX_SPEED = 40
/** A fix that implies going faster than this, in metres a second, is a glitch, if it claims to be accurate. */
const OUTLIER_SPEED = 30
/** A fix claiming to be better than this, in metres, can be a glitch. */
export const OUTLIER_ACCURACY_M = 30
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
/**
 * A phone has moved on, as far as going backwards along the route is concerned, when it has moved further than its accuracy since the last fix.
 * At court speeds, 3 to 8 metres a second, a fix a second moves it less than that, so one that says how fast it is going counts as well when it
 * is going at least this fast, in metres a second. Its position wanders as much as it moves there, so this is only believed when its heading
 * doesn't say it is going the way the stretch runs, within ALIGNED_DEG degrees (the position falling back along the route is then the wander,
 * not the driver reversing).
 */
const STEP_SPEED = 2
const ALIGNED_DEG = 90
/**
 * The phone's heading is against the stretch the driver is put on when it is more than this many degrees from the way that runs. The route runs
 * the opposite way there, so the driver has turned round, as in a court or at the end of a street, and the pass guessed is the way out, not the way back.
 */
const AGAINST_DEG = 120
/**
 * A heading is only believed to be against the stretch when the phone is going at least this fast, in metres a second: below that a phone's
 * course is not to be relied on (a phone that doesn't say how fast it is going has moved more than STILL_M, or been set aside, by now).
 */
const AGAINST_SPEED = 3
/** The best-fitting place is the one to doubt, rather than the cheapest, when that has lost touch with the phone: further than this from it, in metres, or this much more than its accuracy... */
const LOST_TOUCH_M = 25
const LOST_TOUCH_EXTRA_M = 10
/** ...and the best fit is within this of it, in metres. */
const GOOD_FIT_M = 15
/**
 * ...and the phone is lined up with the held place along the stretch it fits: this share of its distance from the held place, at least,
 * lies along that stretch (within about 45 degrees of it). A car past the junction of a court, or up from the foot of a wrong pass, is ahead
 * along the stretch it fits; a fix dragged sideways toward a parallel stretch (multipath by trees or buildings, for a few seconds) is beside it.
 */
const DRIVEN_ON_SHARE = 0.7
/**
 * A turn round onto the way back (see `Progress.turned`) is sure once the driver has gone this far along the way back, in metres: a car
 * that backed up on the way out (past a house, by up to about 90 m at a brisk reversing pace), and then drove on, comes back to the way out
 * before that. Reversing on after the flip moves the driver along the way back just as a real turn round does, so this has to be more than
 * the car may back up. The furthest reached is held for all of it: it never goes back, so a hold shorter than the undo would leave it a
 * kilometre on, at the way back, once the turn was undone.
 */
const TURN_SURE_M = 100
/**
 * Where the route itself turns round close by (a U-turn drawn as a box, or the end of a short court), its way back runs back over its way in:
 * the two passes are within FOLD_M metres of each other (a box is 5 m across), running within FOLD_DEG degrees of opposite ways, and no more
 * than FOLD_ROUTE_M metres of route apart (in to where the route turns round, and back). A car that turns round there, short of where the route
 * does, is level on the way back with where it was on the way in, and has not driven the route in between: after U-turn here a few metres into
 * a side street, the box goes on 26 m or more past the corner, so the way back is 45 to 75 m along the route from the car, and the cost of
 * moving that far kept the driver on the road before the corner (a fit by heading only 40 to 60 degrees out, which never counts as going back)
 * and then at the corner itself, while the car drove 30 to 80 m up the road out. So moving there costs what it would without that route (see
 * `advance`), for a phone heading the way the way back runs (or the road a little after it), within FOLD_HEADING_DEG degrees, and going at
 * STILL_SPEED (1.5 m/s, from which the phone gives a course) or more, and the driver is put on it within a fix or two of the car turning round,
 * not after the run of fixes heading against the way in that a car turning round far from where the route does needs (and that a side street
 * a few metres long has no room for). (Not AGAINST_SPEED, as for that run: a car that has turned round slows to 1 to 3 m/s to give way at the
 * junction, and one going on up the road the way it came was then held at the corner while it drove 30 to 80 m up it, in 7 to 13% of those
 * drives.) A car backing up heads that way too, but where the route turns round 100 m or more on (a street driven out and back, a deep court)
 * the two passes are too far apart along it for this. Like any turn round it is not sure until TURN_SURE_M along the way back.
 */
const FOLD_M = 8
const FOLD_DEG = 30
const FOLD_ROUTE_M = 90
const FOLD_HEADING_DEG = 60
/** Fixes in a row the phone has to be heading that way, before the driver is put on the way back (see `Progress.folding`). */
const FOLD_FIXES = 2
/** How far apart along the route two places that turn round can be and be the same turn round, in metres (see `Progress.foldAt`). */
const FOLD_TIP_M = 10

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

/** Where a candidate place is, in the track's local metres. */
const pointOn = (xy: Track['xy'], c: Pick<Candidate, 'idx' | 't'>): [number, number] => [xy[c.idx][0] + c.t * (xy[c.idx + 1][0] - xy[c.idx][0]), xy[c.idx][1] + c.t * (xy[c.idx + 1][1] - xy[c.idx][1])]

/** The position at `along` metres: where a round that is carried on, or started part way, begins. The driver is not on the route yet. */
export function startProgress(track: Track, along: number): Progress {
  const { points, cum } = track
  const a = Math.min(Math.max(0, along), cum[cum.length - 1] ?? 0)
  let idx = 0
  while (idx < points.length - 2 && cum[idx + 1] <= a) idx++
  const span = (cum[idx + 1] ?? cum[idx]) - cum[idx]
  const t = span > 0 ? (a - cum[idx]) / span : 0
  const at = points[idx] && points[idx + 1] ? { lat: points[idx].lat + (points[idx + 1].lat - points[idx].lat) * t, lng: points[idx].lng + (points[idx + 1].lng - points[idx].lng) * t } : (points[0] ?? { lat: 0, lng: 0 })
  return { idx, t, along: a, furthest: a, gap: 0, offBy: 0, at, accuracy: 0, time: null, seen: null, lost: true, doubt: null, backward: 0, outliers: 0, recent: [] }
}

/** A position this close, in metres, to the joint between two stretches could be on either, as when a point is added in the route. */
const JOINT_M = 0.05

/**
 * The same position on a route that has had points added to it, with the same line: the stretch it is on is numbered
 * differently now, so which one and how far along it are worked out afresh from how far along the route it is, which
 * the points did not change. Everything else about it is kept, including a position that is lost. At a joint between
 * two stretches it is on whichever one the fix itself is nearer, and on the later when neither is. A route with no
 * stretches has nothing to work out against, and gives the position back.
 */
export function rebaseProgress(track: Track, prev: Progress): Progress {
  const { points, cum, xy, refLat } = track
  const segs = points.length - 1
  if (segs < 1) return prev
  const along = prev.along
  let idx = 0
  while (idx < segs - 1 && cum[idx + 1] <= along) idx++
  const fix = project(prev.at, refLat)
  const near = (i: number) => distToSegment(fix, xy[i], xy[i + 1]).dist
  const joined = (i: number) => i >= 0 && i < segs && cum[i + 1] > cum[i] && along >= cum[i] - JOINT_M && along <= cum[i + 1] + JOINT_M
  const on = [idx - 1, idx, idx + 1].filter((i) => i === idx || joined(i)).reduce((a, b) => (near(b) <= near(a) ? b : a))
  const span = cum[on + 1] - cum[on]
  return { ...prev, idx: on, t: span > 0 ? Math.min(1, Math.max(0, (along - cum[on]) / span)) : 0 }
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

  // Too far from the route to say anything: the driver is where they were, and the next fix on the route starts afresh. (Afresh knows of no
  // turn round, so one that was not sure is not held for any more. Left within TURN_SURE_M of the end of the route, where the way back runs
  // out before it could be sure, it is the driver going home from the end of the round, having turned round short of the route's own turn:
  // the furthest reached goes on to where they were, or the round would never be taken for over, and leaving it would be leaving the route.)
  const stayLost = (doubt: Progress['doubt']): Progress => ({
    idx: prev?.idx ?? nearest.idx,
    t: prev?.t ?? nearest.t,
    along: prev?.along ?? nearest.along,
    furthest: prev?.turned && cum[cum.length - 1] - prev.along < TURN_SURE_M ? Math.max(prev.furthest, prev.along) : (prev?.furthest ?? 0),
    gap: nearest.dist,
    offBy: nearest.dist,
    at: fix,
    accuracy: fix.accuracy,
    time,
    seen: time,
    lost: true,
    left: !!prev && (!prev.lost || !!prev.left),
    doubt,
    backward: 0,
    outliers: 0,
    recent: [],
  })
  if (!cands.length) return stayLost(null)

  const backSlack = BACK_SLACK_M + accuracy
  const forwardSlack = moved + 2 * accuracy + SLACK_M
  const going = fix.speed === null || fix.speed === undefined || fix.speed >= STILL_SPEED
  const fresh = !prev || prev.lost
  // With nothing to go by the round is taken to be at its start, so the earliest pass of a place is the likely one.
  const prior = prev ? prev.along : 0
  /** What moving `delta` metres along the route costs. */
  const moveCost = (delta: number) =>
    (fresh ? AHEAD_COST * Math.max(0, delta) : PACE_COST * Math.abs(delta - moved) + (delta > forwardSlack ? STRAY_COST * (delta - forwardSlack) : 0)) +
    (prev && delta < -backSlack ? STRAY_COST * (-delta - backSlack) : 0)
  for (const c of cands) c.cost += moveCost(c.along - prior)
  const byFit = cands.reduce((a, b) => (b.geo < a.geo ? b : a))
  // Where the route turns round close by (see FOLD_M), a car that turned round short of where the route does has not driven the route from the
  // place level with it on the way in, round to the way back: a place on the way back, or on the route a little after it (the road out, round a
  // corner just behind a U-turn), costs what it would with that much less route to it, for a phone heading the way it runs. Only from the second
  // fix in a row, the first with the place that fits the phone best (by distance and heading) on the way back itself, or a little after it with
  // the phone not heading on the way of the stretch the driver is put on (the end of a way back that a straight tap took across to the junction).
  // So a course wrong for one fix (the wrong way round, near the end of a street driven out and back) does not turn the driver round; nor does
  // a phone at the junction of a short court going on along the road: it is as level with the road after the court, and may be heading near
  // enough the way back of a court at 120 degrees or more to the road, but it fits the road better, or is going on the way it was, and is as
  // likely to turn in as to go by, so it is held at the junction as ever. (Not on a fresh start, which has no place to move from.)
  // The count is of one turn round: the one it began at. Another close by begins a count of its own, and has to pass the same test to: a count
  // begun as the car turned round with the route at the end of a street went on up the way back, and at a court 46 m on, which came into reach
  // while the street's way back still was, a fix a few metres past the junction was put on the road after the court, 90 m on, at once.
  /** Each place on a later pass, a place level with it on an earlier one that runs the other way, and where the turn round between them is. */
  const levels: { c: Candidate; e: Candidate; tip: number }[] = []
  /** For each place the phone is heading along, on the way back of a turn round `near` picks or a little after it, the least it costs with the route skipped, and that turn round. */
  const skipping = (near: (tip: number) => boolean): Map<Candidate, { cost: number; tip: number }> => {
    const out = new Map<Candidate, { cost: number; tip: number }>()
    for (const d of heading !== null && levels.length ? cands : []) {
      if (angleBetween(bearings[d.idx], heading!) > FOLD_HEADING_DEG) continue
      for (const { c, e, tip } of levels) {
        if (!near(tip) || prior >= tip || d.along < c.along || d.along - c.along > FOLD_ROUTE_M) continue
        const cost = d.geo + moveCost(e.along - prior + d.along - c.along)
        if (cost < (out.get(d)?.cost ?? Infinity)) out.set(d, { cost, tip })
      }
    }
    return out
  }
  /** The turn round the phone is first found heading out along the way back of, if it is. */
  let foundAt: number | null = null
  if (prev && !fresh && heading !== null && (fix.speed === null || fix.speed === undefined || fix.speed >= STILL_SPEED)) {
    // (The places are in order along the route. The turn round is halfway between the two along it, the same all down a way back.)
    for (let k = 0; k < cands.length; k++) {
      const c = cands[k]
      const [cx, cy] = pointOn(xy, c)
      for (let j = k - 1; j >= 0 && c.along - cands[j].along <= FOLD_ROUTE_M; j--) {
        const e = cands[j]
        if (e.along >= c.along || angleBetween(bearings[e.idx], bearings[c.idx]) < 180 - FOLD_DEG) continue
        const [ex, ey] = pointOn(xy, e)
        if (Math.hypot(ex - cx, ey - cy) <= FOLD_M) levels.push({ c, e, tip: (c.along + e.along) / 2 })
      }
    }
    const fitSkipped = skipping(() => true).get(byFit)
    if (fitSkipped && (levels.some(({ c }) => c === byFit) || angleBetween(bearings[prev.idx], heading) > FOLD_HEADING_DEG)) foundAt = fitSkipped.tip
  }
  const sameTurn = (at: number | undefined) => (tip: number) => at !== undefined && Math.abs(tip - at) <= FOLD_TIP_M
  const counting = (prev?.folding ?? 0) > 0 ? prev?.foldAt : undefined
  const goesOn = counting !== undefined && (foundAt !== null ? sameTurn(counting)(foundAt) : skipping(sameTurn(counting)).size > 0)
  const folding = goesOn ? (prev?.folding ?? 0) + 1 : foundAt !== null ? 1 : 0
  const foldAt = goesOn ? counting : foundAt !== null ? foundAt : undefined
  /** The places that cost less for the route skipped. */
  const folded = new Set<Candidate>()
  if (folding >= FOLD_FIXES) {
    for (const [d, { cost }] of skipping(sameTurn(foldAt))) {
      if (cost < d.cost) {
        d.cost = cost
        folded.add(d)
      }
    }
  }
  const byCost = cands.reduce((a, b) => (b.cost < a.cost ? b : a))

  // The cheapest place is the one the driver was at, held on to by the cost of moving. Where the route doubles back (a court, a street
  // driven twice) it can have lost touch with the phone, which has driven on past the junction along the street: the place that fits the
  // phone is then the one to doubt, and in time to believe (or, not far on, to take at once: see below), since the cheapest would be held until
  // it left reach altogether. (Only when the phone is lined up with the held place along the stretch it fits, not beside it: a fix dragged a few
  // seconds sideways, toward a stretch beside the street that the route drives later the same way, would otherwise move the driver there, and
  // the furthest reached with them, for good. Lined up either way: the cheapest place can be ahead of the phone on that line, as the corner of
  // a loop that the route comes back down the street from is, for a car that missed the turn into it.)
  const [hx, hy] = pointOn(xy, byCost)
  const ux = xy[byFit.idx + 1][0] - xy[byFit.idx][0]
  const uy = xy[byFit.idx + 1][1] - xy[byFit.idx][1]
  const drivenOn = Math.abs((p[0] - hx) * ux + (p[1] - hy) * uy) / (Math.hypot(ux, uy) || 1) >= DRIVEN_ON_SHARE * byCost.dist
  const lostTouch = prev && !fresh && byCost.dist > Math.max(LOST_TOUCH_M, accuracy + LOST_TOUCH_EXTRA_M) && byFit.dist <= GOOD_FIT_M && byFit !== byCost && drivenOn
  // Coming back from being lost, with a jump being doubted (see below) that fits the phone far better than the place that has come into reach near
  // where the driver left, the jump stays the one to judge: that place is only cheap for being near.
  const lastStep = prev ? haversine(prev.at, fix) : 0
  const stillDoubted = fresh && prev?.doubt && Math.abs(prev.doubt.along - byFit.along) <= DOUBT_NEAR_M + lastStep && byFit.geo + RECOVERY_MARGIN < byCost.geo
  const jump = lostTouch || stillDoubted ? byFit : byCost
  let pick = byCost
  let doubt: Progress['doubt'] = null
  // Whether the driver was moved on at once from a place that lost touch with the phone (see below).
  let skippedOn = false
  // Coming back from being lost, a place further from where the driver left the route than the phone is from it is a jump like any other: they have
  // not driven the route to it, so it is doubted until the phone is driving along it, and the driver stays lost meanwhile. Taken at once, as the only
  // place in reach at that moment, it was the later pass of the street the phone was coming back to: the two lines a few metres apart, the later one
  // came into reach a fix or two before the other, and the driver was put kilometres on, with the furthest reached gone with them for the round.
  const left = prev?.lost && prev.left ? pointOn(xy, prev) : null
  /** How far the phone now is from the place it was lost from, in metres. */
  const away = left && Math.hypot(p[0] - left[0], p[1] - left[1])
  if (prev && (!fresh || away !== null)) {
    const delta = jump.along - prev.along
    /** Whether moving to this place is a move along the route much bigger than the phone's own, which is not believed at once: the driver stays where they were until the phone has been seen driving along it (see DOUBT_RUN_M). */
    const leaps = (c: Candidate) => c.along - prev.along > forwardSlack + (away ?? 0) + JUMP_M || c.along - prev.along < -(backSlack + (away ?? 0) + JUMP_M)
    /** How the phone's heading lines up with this place: 1 going the way it runs, -1 against it, 0 across it. Taken to go with it where that can't be told: no heading at all, or too slow for one to mean much. */
    const linedUp = (c: Candidate) => (going && heading !== null ? Math.cos((angleBetween(bearings[c.idx], heading) * Math.PI) / 180) : 1)
    const goesWith = (c: Candidate) => linedUp(c) >= DRIVEN_ON_SHARE
    // (Where the cheapest place runs against the phone and the one that fits it runs with it, it is that one that can come to be believed: a car that
    // missed the turn into a loop back down the street it is on was held until it had gone by the whole of the loop's way down.)
    const place = leaps(jump) && !goesWith(jump) && leaps(byFit) && goesWith(byFit) ? byFit : jump
    if (leaps(place)) {
      const before = prev.doubt !== null && Math.abs(prev.doubt.along - place.along) <= DOUBT_NEAR_M + (prev.lost ? lastStep : moved) ? prev.doubt : null
      const ground = before?.start ? haversine(before.start, fix) : 0
      // Whether the phone is driving along it: near enough to be on it, and by its heading, or crawling, too slow for a heading to mean much, by how far
      // along it it has got, either way, for the ground it has covered. Null till that can be said; and till the phone has gone TURN_SURE_M against the way
      // it runs, since the driver follows the route forwards, but one who has come back onto a later street the wrong way round is on it all the same,
      // and is to be asked.
      const driving =
        place.dist > Math.max(DOUBT_FIT_M, 2 * accuracy)
          ? false
          : !going
            ? ground < DOUBT_RUN_M
              ? null
              : Math.abs(place.along - (before?.from ?? place.along)) >= DRIVEN_ON_SHARE * ground
            : goesWith(place) || (linedUp(place) <= -DRIVEN_ON_SHARE ? (ground >= TURN_SURE_M ? true : null) : false)
      const run = driving === false ? null : before
      const fixes = (run?.fixes ?? 0) + 1
      if (fixes < DOUBT_FIXES || !driving) {
        doubt = { along: place.along, fixes, from: run?.from ?? place.along, start: run?.start ?? fix }
        if (away !== null) return stayLost(doubt)
        pick = { idx: prev.idx, t: prev.t, along: prev.along, dist: place.dist, geo: place.geo, cost: place.cost }
      } else {
        pick = place
      }
    } else if (lostTouch && delta > 0) {
      // A smaller move on, from a place that has lost touch with the phone to the one that fits it, is taken at once: the car has gone on past
      // the junction of a court 20 to 60 m deep, with the street beyond it 40 to 120 m on along the route. The cost of moving that far held the
      // junction until it was out of reach, 50 to 60 m past it, and the driver was then put past the houses just beyond, which never came up.
      // (It is a turn round not sure yet: see below.)
      pick = jump
      skippedOn = true
    }
  }
  // The driver follows the route forwards. Moving on while the position goes back along it, fix after fix, means the wrong pass of a
  // street driven twice was guessed: take the nearest place ahead that fits instead. A fix counts as going back in two ways. The position
  // falls back along the route by half the accuracy while the phone has moved on: further than its accuracy, or, for a phone that says how
  // fast it is going, at court speeds, where a fix a second moves it less than that (unless its heading says it is going the way the stretch
  // runs, when the fall is only the position wandering). Or the phone's heading is against the stretch, which needs no movement along the
  // route at all: a driver crawling round the end of a court, or in a three-point turn, would otherwise be kept on the way out for a long
  // way, since the way back is further along the route the earlier they turned.
  let backward = 0
  // A phone that says it has stopped is only jittering, which is not the driver going back.
  if (prev && !fresh && going) {
    const speed = typeof fix.speed === 'number' ? fix.speed : null
    const way = heading === null ? null : angleBetween(bearings[pick.idx], heading)
    const stepped = moved > accuracy || (speed !== null && speed >= STEP_SPEED && !(way !== null && way <= ALIGNED_DEG))
    const against = way !== null && (speed === null || speed >= AGAINST_SPEED) && way > AGAINST_DEG
    if ((stepped && pick.along - prev.along < -accuracy / 2) || against) backward = prev.backward + 1
  }
  // A turn round that is not sure yet (see `Progress.turned`): a fresh start knows of none.
  let turned = prev && !fresh ? (prev.turned ?? null) : null
  let undone = false
  // (Not for a driver who has been put further along the stretch than they were three fixes ago, by more than the error of a fix: that is
  // going forwards on it, and a heading that is wrong for a fix or two does not turn them round.)
  if (prev && backward >= BACKWARD_FIXES && !(pick.along - (prev.recent[0] ?? prev.along) > accuracy)) {
    const bestFit = byFit.geo + RECOVERY_MARGIN
    // (Never one that runs against the phone's heading: a heading that is against every pass, as a glitch of the phone's would be, moves nothing.)
    const fits = (c: Candidate) => c.geo <= bestFit && (heading === null || angleBetween(bearings[c.idx], heading) <= AGAINST_DEG)
    let to = cands.filter((c) => c.along >= prev.along && fits(c)).sort((a, b) => a.along - b.along)[0]
    let undo = false
    // Nothing ahead fits, just after a turn round that is not sure: the car only backed up on the way out, and is driving on along it,
    // against the way back. It goes back to the way out, as near as where it was put from as the slack, the phone's own movement and how far
    // the driver has gone along the way back since the flip, either way, allow: a car that went on reversing after the flip (which moves it on
    // along the way back, as a real turn round would) is that much further back along the way out. (After the move on past the junction of a
    // court, no further on than the junction: a car backing up to it along the street heads as near the way the court's way back runs as the
    // way its way in does, and was put on the way back, past the court's stops, before it had turned in.)
    if (!to && turned) {
      const skip = turned.skip
      const low = turned.from - backSlack - Math.abs(turned.to - prev.along) - moved
      const high = skip ? turned.from + backSlack : Infinity
      // (And then only to a place that has not lost touch with the phone, as the junction had when the move on was taken: a car that went by the
      // court and backs up a few metres on the street 50 to 80 m beyond, for a house just passed or to park, fits the junction there by its
      // heading, and was put back at it: the court's house came up again, the street's alerts went, and the next house a few metres on was
      // passed before it came up. `turned` is read once, as it is not narrowed inside the filter.)
      const back = cands
        .filter((c) => c.along < prev.along && c.along >= low && c.along <= high && (!skip || c.dist <= Math.max(LOST_TOUCH_M, accuracy + LOST_TOUCH_EXTRA_M)) && fits(c))
        .sort((a, b) => a.geo - b.geo)[0]
      if (back) {
        to = back
        undo = true
      }
    }
    if (to) {
      // How far the driver has gone along the way back is counted from the place on it that fits the phone best, not from `to`, the earliest
      // that fits: on a route drawn with points along it that can be the end of an earlier stretch, up to a stretch short of where the car is
      // (over 30 m, with a point every 40 m), and the next fix jumps that much along the way back, so a car backing up 80 to 90 m was sure to
      // have turned round. (Only up to twice RECOVERY_MARGIN on, at most, and on a stretch running within a right angle of the way `to`'s does,
      // not one round a turn of the route: a phone with no heading can be put a few metres on along the way out, which fits as well, and the way
      // back that fits it best is then a kilometre further on, where the turn round would never be sure.)
      const earliest = to.along
      const best = undo
        ? to
        : cands
            .filter((c) => c.along >= earliest && c.along <= earliest + 2 * RECOVERY_MARGIN && angleBetween(bearings[c.idx], bearings[to.idx]) <= ALIGNED_DEG && fits(c))
            .reduce((a, b) => (b.geo < a.geo ? b : a), to)
      turned = undo ? null : { from: prev.along, to: best.along }
      undone = undo
      pick = to
      backward = 0
    }
  }
  // Put on the way back where the route turns round close by (see FOLD_M): a turn round like any other, not sure yet, since a car backing up
  // there heads the same way. (Not one just undone, back on the way out.)
  if (prev && !fresh && !turned && !undone && folded.has(pick)) turned = { from: prev.along, to: pick.along }
  // So is being put by cost alone on a later pass that runs against the one the driver was on, further on than the phone can have moved. Within
  // about 45 m of where the route turns round (the end of a street driven out and back, the tip of a deep court) the way back is only 40 to 90 m on,
  // and on the first fix of a car backing up there, heading against the way out, it is the cheapest place, with neither the run of fixes going back
  // nor the fold: unless it is a turn round not sure yet, the alerts that were up count as gone by (the house just ahead is never alerted, the
  // bundle just behind is missed) while the car only reverses a few metres.
  // (Against the stretch the driver came up, too, if they are put at the very start of the next. At the junction of a stub at the end of a street driven out
  // and back, a car backing up is held at the stub's first point, and the way back, believed once it has lost touch, is only at right angles to the stub:
  // with no turn round to hold them, the alerts up went by, and a line 200 m on along the way back told of a section the car had never reached.)
  else if (prev && !fresh && !turned && !undone && pick.along - prev.along > forwardSlack && (angleBetween(bearings[pick.idx], bearings[prev.idx]) > AGAINST_DEG || (prev.idx > 0 && prev.along - cum[prev.idx] <= JOINT_M && angleBetween(bearings[pick.idx], bearings[prev.idx - 1]) > AGAINST_DEG))) turned = { from: prev.along, to: pick.along }
  // So is the move on at once past the junction of a court (see above). A car that missed the turn into the court and stopped 25 to 45 m up the
  // street, to back up or turn round and come back to it, is put on the street beyond the court there; with nothing to doubt, the court's alerts
  // that were up counted as gone by (the no-throw house in it done, never alerted as the car drove in; the bundle drop missed). Held, they
  // come up again as the car drives the court, once the run of fixes going back (or the cost alone: see below) puts it back at the junction;
  // and for a car that has gone by, the turn is sure 100 m on, as any is, with the furthest reached held till then.
  else if (prev && !fresh && !turned && !undone && skippedOn) turned = { from: prev.along, to: pick.along, skip: true }
  // And put back by cost alone at or before where a turn round not sure yet was made from (a car that backed up and drove on, taken back by the
  // jump or the junction rather than by the run of fixes going back), the turn is undone, so the stops of the way back put by meanwhile come up
  // again when the car really drives them. (Only for a turn that moved the driver on further than the phone can have moved: the run of fixes going
  // back also sets turns a metre or two long on the very pass the driver is on, and one of those is no turn to undo.) So it is for being put back
  // anywhere TURN_SURE_M or more short of where the turn put them: a turn is sure that far past it, and this far short of it the driver is not on that
  // way back at all. Thrown 4 km on by a turn and put straight back a few metres past where it was made from, the driver was neither, and the
  // turn stood until they had driven all the way to it: kilometres with the furthest reached held, the stops going by put by, and no tell.
  else if (turned && turned === prev?.turned && turned.to - turned.from > forwardSlack && (pick.along <= turned.from + accuracy || pick.along <= turned.to - TURN_SURE_M)) turned = null
  if (turned && pick.along - turned.to >= TURN_SURE_M) turned = null
  // The furthest reached only follows what the last few fixes agree on, so a pass guessed wrong for a fix or two can't push it on; nor a turn
  // round that is not sure yet, which may be undone.
  const recent = [...(prev?.recent ?? []), pick.along].slice(-RECENT)
  const furthest = !turned && pick.dist <= FURTHEST_GAP_M ? Math.max(prev?.furthest ?? 0, Math.min(...recent)) : (prev?.furthest ?? 0)
  return { idx: pick.idx, t: pick.t, along: pick.along, furthest, gap: pick.dist, offBy: nearest.dist, at: fix, accuracy: fix.accuracy, time, seen: time, lost: false, doubt, backward, outliers: 0, recent, turned, folding, foldAt }
}
