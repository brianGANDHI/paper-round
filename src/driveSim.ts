import { angleBetween, distToSegment, haversine } from './geo'
import { pushTrail, trailHeading, type TrailPoint } from './heading'
import { advance, makeTrack, startProgress, type GpsFix, type Progress, type Track } from './progress'
import type { Pt } from './types'

/*
 * A drive made up for the tests: a car going along a route as a real one does, and the fixes a phone in it gives, fed to the tracker the way the
 * round screen feeds them. Used by the tests only (nothing in the app imports it). The route is laid out in metres east and north of a made-up
 * place, so no real street is in it.
 */

/** A made-up place, in Sydney, so the maths is checked away from the equator. Not anywhere on a real round. */
export const SIM_ORIGIN: Pt = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
const cosd = (deg: number) => Math.cos((deg * Math.PI) / 180)

/** A spot `x` metres east and `y` metres north of the made-up place. */
export const spot = ([x, y]: readonly [number, number], origin: Pt = SIM_ORIGIN): Pt => ({
  lat: origin.lat + y / M_PER_DEG,
  lng: origin.lng + x / (M_PER_DEG * cosd(origin.lat)),
})
/** A line through these spots, with a point every `every` metres along it if asked (as a route snapped to the roads has). */
export function lineThrough(xy: [number, number][], every = 0): Pt[] {
  if (!every) return xy.map((p) => spot(p))
  const out: [number, number][] = []
  for (let i = 0; i < xy.length - 1; i++) {
    const [ax, ay] = xy[i]
    const [bx, by] = xy[i + 1]
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / every))
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n])
  }
  out.push(xy[xy.length - 1])
  return out.map((p) => spot(p))
}

/** The same noise every run: a small seeded random number generator, and a normal one from it. */
export function random(seed: number) {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const gaussian = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())

export interface SimOptions {
  /** How fast the car goes between corners and stops, in metres a second. */
  speed: number
  /** GPS error, in metres in each direction: it drifts from one fix to the next (see `carry`) rather than jumping. */
  sigma: number
  /** The accuracy the phone claims, in metres. */
  accuracy: number
  /** How wrong the phone's course is, about, in degrees. */
  headingNoise: number
  /** How much of each fix's error carries over to the next, 0 to 1. */
  carry?: number
  /** Stopping for `stopFor` seconds after every `stopEvery` seconds of driving, slowing down to it and pulling away after, as at houses and lights. */
  stopEvery?: number
  stopFor?: number
  /** Corners driven round in a curve this many metres either side of the corner, slowing for them, rather than turned on the spot. */
  round?: number
  seed: number
  /** Where along the route to start and finish, in metres. */
  from?: number
  to?: number
}

/** What happened at one fix: where the car really was along the route, what the phone said, and where the tracker put it. */
export interface SimStep {
  time: number
  /** How far along the route the car really was, in metres. */
  s: number
  fix: GpsFix & { heading: number | null }
  course: number | null
  progress: Progress
  /** Where the fix itself points along the stretch of route the car is really on, in metres: how far along the street the GPS error alone puts it. */
  fixAlong: number
  /** Whether the tracker took this fix in (a phone standing still, or a fix set aside, leaves the position as it was). */
  taken: boolean
}

const ACCEL = 1.5

/** Where the car is at `s` metres along the route, going round a corner in a curve when asked, and the way it is heading. */
function placeOn(track: SimTrack, s: number, round: number): { xy: [number, number]; heading: number } {
  const { cum, xy } = track
  const end = cum[cum.length - 1]
  const at = (d: number): [number, number] => {
    const a = Math.min(Math.max(0, d), end)
    let i = 0
    while (i < xy.length - 2 && cum[i + 1] < a) i++
    const span = cum[i + 1] - cum[i] || 1
    const t = Math.min(1, Math.max(0, (a - cum[i]) / span))
    return [xy[i][0] + (xy[i + 1][0] - xy[i][0]) * t, xy[i][1] + (xy[i + 1][1] - xy[i][1]) * t]
  }
  const pos = (d: number): [number, number] => {
    if (round > 0) {
      // The nearest corner within `round` of here, cut as a curve from `round` before it to `round` after (not a turn round on the spot).
      for (const v of track.corners) {
        if (Math.abs(d - v.at) >= round || v.angle >= 150) continue
        const p0 = at(v.at - round)
        const p1 = at(v.at)
        const p2 = at(v.at + round)
        const u = (d - (v.at - round)) / (2 * round)
        return [0, 1].map((k) => (1 - u) * (1 - u) * p0[k] + 2 * u * (1 - u) * p1[k] + u * u * p2[k]) as [number, number]
      }
    }
    return at(d)
  }
  const here = pos(s)
  const a = pos(s - 0.75)
  const b = pos(s + 0.75)
  return { xy: here, heading: (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI + 360 }
}

type SimTrack = Track & { corners: { at: number; angle: number }[] }

/** A track with its corners found, for driving round them. */
export function simTrack(points: Pt[]): SimTrack {
  const track = makeTrack(points)
  const corners: { at: number; angle: number }[] = []
  for (let i = 1; i < track.bearings.length; i++) {
    const angle = angleBetween(track.bearings[i - 1], track.bearings[i])
    if (angle > 25) corners.push({ at: track.cum[i], angle })
  }
  return { ...track, corners }
}

/** How fast the car can be going at `s`, slowing for the corners ahead and behind it (a turn round, almost to a stop). */
function cornerSpeed(track: SimTrack, s: number, speed: number, round: number): number {
  let v = speed
  for (const c of track.corners) {
    const slow = c.angle >= 150 ? 1.2 : c.angle > 60 ? Math.min(speed, round ? 6 : 4) : Math.min(speed, 9)
    v = Math.min(v, Math.sqrt(slow * slow + 2 * ACCEL * Math.abs(s - c.at)))
  }
  return v
}

/**
 * Drives the route as a car does, a fix a second, and gives each fix to the tracker as the round screen does: the phone's own course while it has
 * one (it gives none below 1.5 m/s), or else the way it has been going, worked out from the fixes taken in before (see heading.ts).
 */
export function simDrive(track: SimTrack, o: SimOptions, feed: Feed = appFeed): SimStep[] {
  const r = random(o.seed)
  const carry = o.carry ?? 0.9
  const round = o.round ?? 0
  const end = Math.min(o.to ?? Infinity, track.cum[track.cum.length - 1])
  let s = o.from ?? 0
  let time = 1_700_000_000_000 + o.seed * 1000
  let err: [number, number] = [gaussian(r) * o.sigma, gaussian(r) * o.sigma]
  let driving = 0
  /** Where the next stop is, and for how much longer the car stays stopped once it is there. */
  let stopAt: number | null = null
  let stopped = 0
  let v = 0
  // A drive begun part way is a round started from there (see `startProgress`).
  let state: FeedState = { progress: o.from ? startProgress(track, o.from) : null, trail: [] }
  const out: SimStep[] = []
  while (s < end) {
    if (stopped > 0) {
      stopped--
      v = 0
    } else {
      let target = cornerSpeed(track, s, o.speed, round)
      if (o.stopEvery && stopAt === null && driving >= o.stopEvery) stopAt = s + (v * v) / (2 * ACCEL) + 1
      if (stopAt !== null) target = Math.min(target, Math.sqrt(2 * ACCEL * Math.max(0, stopAt - s)))
      // Pull away no faster than the car can.
      const next = Math.min(target, v + ACCEL)
      const stepTo = s + Math.max(0.3, (v + next) / 2)
      if (stopAt !== null && stepTo >= stopAt - 0.5) {
        s = Math.min(stopAt, end)
        v = 0
        stopAt = null
        stopped = o.stopFor ?? 6
        driving = 0
      } else {
        s = Math.min(stepTo, end)
        v = next
        driving++
      }
    }
    time += 1000
    const { xy, heading } = placeOn(track, s, round)
    err = [carry * err[0] + Math.sqrt(1 - carry * carry) * gaussian(r) * o.sigma, carry * err[1] + Math.sqrt(1 - carry * carry) * gaussian(r) * o.sigma]
    const at = { x: xy[0] + err[0], y: xy[1] + err[1] }
    const reported = v === 0 ? 0 : Math.max(0, v + gaussian(r) * 0.3)
    const fix = {
      lat: at.y / M_PER_DEG,
      lng: at.x / (M_PER_DEG * cosd(track.refLat)),
      accuracy: o.accuracy,
      time,
      speed: reported,
      heading: reported >= 1.5 ? (heading + gaussian(r) * o.headingNoise + 720) % 360 : null,
    }
    const was = state.progress
    const fed = feed(track, state, fix)
    state = fed.state
    if (!state.progress) throw new Error('no progress')
    out.push({ time, s, fix, course: fed.course, progress: state.progress, fixAlong: ownPass(track, s, heading, [at.x, at.y]), taken: state.progress !== was })
  }
  return out
}

/** Where a spot is along the pass the car is on at `s` (the stretches within 60 m of it running its way, not another pass of the same street), in metres. */
function ownPass(track: Track, s: number, heading: number, p: [number, number]): number {
  const { cum, xy, bearings } = track
  let best = s
  let bestDist = Infinity
  for (let i = 0; i < bearings.length; i++) {
    if (cum[i] > s + 60 || cum[i + 1] < s - 60 || angleBetween(bearings[i], heading % 360) > 100) continue
    const { dist, t } = distToSegment(p, xy[i], xy[i + 1])
    if (dist < bestDist) {
      bestDist = dist
      best = cum[i] + t * (cum[i + 1] - cum[i])
    }
  }
  return best
}

/** What the round screen keeps between fixes for the tracker: the position, and where the phone has been, for a heading when it gives none. */
export interface FeedState {
  progress: Progress | null
  trail: TrailPoint[]
}
export type Feed = (track: Track, state: FeedState, fix: GpsFix & { heading: number | null; time: number }) => { state: FeedState; course: number | null }

/** A fix given to the tracker as the round screen gives it (Round.tsx). */
export const appFeed: Feed = (track, state, fix) => {
  const course = fix.heading ?? trailHeading(state.trail, fix.accuracy)
  const now = advance(track, state.progress, fix, course)
  if (!now || now === state.progress) return { state, course }
  return { state: { progress: now, trail: pushTrail(state.trail, { lat: now.at.lat, lng: now.at.lng, time: now.time ?? fix.time }) }, course }
}

/** A spell of fixes the tracker had far from where the car really was along the route. */
export interface Spell {
  /** Along the route, where the car really was when it began, and how far out the tracker was at worst (ahead plus, behind minus). */
  s: number
  worst: number
  seconds: number
  fixes: number
}

export interface SimScore {
  fixes: number
  /** Fixes on the route (not lost) with the tracker this far or more from the truth along the route. */
  wrong: number
  /**
   * Of those, the ones the fix itself explains: the tracker is where the fix points, on the pass the car is on, the GPS error alone that far along the street
   * (or where the last fix it took in pointed, kept while the phone stands still).
   */
  explained: number
  /** The spells of the others: the tracker on another pass, or somewhere the fix does not point. */
  spells: Spell[]
  /** The worst the tracker was out along the route, either way, in metres, over fixes not lost. */
  worst: number
  /** How far past where the car really was the furthest reached ever got, in metres. */
  furthestAhead: number
  /** How far past both where the car was and where the fixes had pointed (three in a row, as the furthest reached lags) it ever got, in metres. */
  furthestUnexplained: number
  lost: number
}

/** How a drive went: the fixes the tracker had more than `limit` metres from where the car really was along the route, in spells. */
export function score(steps: SimStep[], limit = 50): SimScore {
  const spells: Spell[] = []
  let open: Spell | null = null
  let start = 0
  let wrong = 0
  let explained = 0
  let worst = 0
  let furthestAhead = -Infinity
  let furthestUnexplained = -Infinity
  let pointed = -Infinity
  let lost = 0
  /** Where the last fix the tracker took in pointed: it keeps that place while the phone stands still. */
  let lastTaken: number | null = null
  steps.forEach((x, k) => {
    if (x.taken) lastTaken = x.fixAlong
    furthestAhead = Math.max(furthestAhead, x.progress.furthest - x.s)
    pointed = Math.max(pointed, Math.min(...steps.slice(Math.max(0, k - 2), k + 1).map((y) => y.fixAlong)))
    furthestUnexplained = Math.max(furthestUnexplained, x.progress.furthest - Math.max(x.s, pointed))
    if (x.progress.lost) {
      lost++
      return
    }
    const e = x.progress.along - x.s
    worst = Math.max(worst, Math.abs(e))
    if (Math.abs(e) >= limit) wrong++
    if (Math.abs(e) >= limit && (Math.abs(x.progress.along - x.fixAlong) < EXPLAINED_M || (lastTaken !== null && Math.abs(x.progress.along - lastTaken) < EXPLAINED_M))) {
      explained++
      open = null
    } else if (Math.abs(e) >= limit) {
      if (!open) {
        open = { s: x.s, worst: e, seconds: 0, fixes: 0 }
        start = x.time
        spells.push(open)
      }
      if (Math.abs(e) > Math.abs(open.worst)) open.worst = e
      open.fixes++
      open.seconds = (x.time - start) / 1000 + 1
    } else open = null
  })
  return { fixes: steps.length, wrong, explained, spells, worst, furthestAhead, furthestUnexplained, lost }
}

/** The tracker is where the fix points when it is this close to it along the route, in metres. */
const EXPLAINED_M = 20

/** Places along the route (in metres) where it comes back within 25 m of where it was at least 150 m of route before: a fold, or a street used again. */
export function reusedPlaces(track: Track, spacing = 300): number[] {
  const { cum, xy } = track
  const out: number[] = []
  const n = xy.length
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < j; i++) {
      if (cum[j] - cum[i] < 150) break
      if (Math.hypot(xy[i][0] - xy[j][0], xy[i][1] - xy[j][1]) < 25) {
        if (!out.length || cum[j] - out[out.length - 1] > spacing) out.push(cum[j])
        break
      }
    }
  }
  return out
}

/** Made-up routes that fold back on themselves or drive a street twice, in metres east and north. */
export const FOLDING_ROUTES: Record<string, [number, number][]> = {
  /** A street with a court off it, driven in to the end and back out, and on along the street. */
  'a court out and back': [
    [0, 0],
    [0, 200],
    [140, 200],
    [0, 200],
    [0, 450],
  ],
  /** A dead-end street 300 m long, out and back, then on round the corner. */
  'a dead end out and back': [
    [0, 0],
    [300, 0],
    [0, 0],
    [0, -250],
  ],
  /** A block driven twice the same way round, then away. */
  'a block driven twice': [
    [0, 0],
    [220, 0],
    [220, 160],
    [0, 160],
    [0, 0],
    [220, 0],
    [220, 160],
    [0, 160],
    [0, 0],
    [-200, 0],
  ],
  /** A street driven east, a loop round to its start, and the same street east again, then on. */
  'a street twice the same way': [
    [0, 0],
    [400, 0],
    [400, 200],
    [-120, 200],
    [-120, 0],
    [0, 0],
    [400, 0],
    [400, -220],
  ],
  /** Up one street and back down another 35 m beside it, then the first street again further on (a laneway and its street). */
  'two streets side by side': [
    [0, 0],
    [0, 300],
    [35, 300],
    [35, 0],
    [200, 0],
    [200, -150],
    [0, -150],
    [0, 0],
    [0, 300],
    [-150, 300],
  ],
  /** A street driven out, a loop of other streets, and the street driven back the other way: the two passes far apart along the route. */
  'a street back the other way after a loop': [
    [0, 0],
    [350, 0],
    [350, 200],
    [600, 200],
    [600, 400],
    [350, 400],
    [350, 200],
    [350, 0],
    [0, 0],
    [0, 200],
  ],
}

export const foldingTrack = (name: string, every = 0) => simTrack(lineThrough(FOLDING_ROUTES[name], every))


/** A move along the route between two fixes the tracker took in, bigger than a car can have made (see TRACK_SPEED in progress.ts). */
export interface Jump {
  /** When, in milliseconds, and from where to where along the route, in metres. */
  time: number
  from: number
  to: number
  /** The time since the fix before, in seconds, and how far the phone moved on the ground in it, in metres. */
  seconds: number
  ground: number
  /**
   * How it came about: 'confirmed', a place out of the window seen for long enough; 'turn', a turn round or a move on past a court, held as not sure
   * yet (the furthest reached waits); 'other', anything else, which should not happen.
   */
  kind: 'confirmed' | 'turn' | 'other'
}

/**
 * A drive kept with Record this round (see driveLog.ts), played through the tracker as the round screen plays it: where the tracker puts the driver
 * now, the jumps along the route it makes, and how many fixes it puts more than 50 m from where the tracker of the day did.
 */
export function replayDrive(file: { route: Pt[]; fixes: (GpsFix & { heading: number | null; time: number; match?: { along: number; lost: boolean } | null })[] }): {
  steps: { time: number; progress: Progress; was: { along: number; lost: boolean } | null }[]
  jumps: Jump[]
  differ: number
} {
  const track = makeTrack(file.route)
  // (Begun where the tracker of the day first had the driver, as a round carried on from there is: a drive can begin part way round.)
  const first = file.fixes.find((f) => f.match && !f.match.lost)?.match
  let state: FeedState = { progress: first ? startProgress(track, first.along) : null, trail: [] }
  const steps: { time: number; progress: Progress; was: { along: number; lost: boolean } | null }[] = []
  const jumps: Jump[] = []
  let differ = 0
  for (const fix of file.fixes) {
    const before = state.progress
    state = appFeed(track, state, fix).state
    const now = state.progress
    if (!now) continue
    steps.push({ time: fix.time, progress: now, was: fix.match ?? null })
    if (fix.match && !fix.match.lost && !now.lost && Math.abs(fix.match.along - now.along) > 50) differ++
    if (!before || now === before || before.lost || now.lost || before.time === null || now.time === null) continue
    const seconds = Math.max(0, (now.time - before.time) / 1000)
    const delta = now.along - before.along
    const accuracy = Math.max(5, fix.accuracy)
    // (Back as far as anywhere the driver was put lately, or the furthest reached, is within it: a step on that was wrong, undone.)
    const low = Math.min(before.along, before.furthest, ...(before.lately ?? [])) - before.along
    if (delta <= 25 * seconds + 2 * accuracy + 40 && delta >= low - (15 + accuracy)) continue
    const doubted = !!before.doubt && Math.abs(before.doubt.along - now.along) <= 40 + haversine(before.at, now.at) + 10
    jumps.push({ time: fix.time, from: before.along, to: now.along, seconds, ground: haversine(before.at, now.at), kind: now.turned || before.turned ? 'turn' : doubted ? 'confirmed' : 'other' })
  }
  return { steps, jumps, differ }
}
