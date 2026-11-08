import { describe, expect, it } from 'vitest'
import { alongPath, haversine } from './geo'
import { pushTrail, trailHeading, type TrailPoint } from './heading'
import { advance, makeTrack, offRouteGap, rebaseProgress, startProgress, type Progress, type Track } from './progress'
import { paintMetres } from './routeEdit'
import { routeTurns, TURN_SHOW_M, upcomingTurn } from './turns'
import type { Pt, Route } from './types'

// A place in Sydney, so the maths is checked away from the equator and the prime meridian.
const ORIGIN = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
const cos = (deg: number) => Math.cos((deg * Math.PI) / 180)

/** A spot `x` metres east and `y` metres north of the start. */
const spot = ([x, y]: readonly [number, number]): Pt => ({
  lat: ORIGIN.lat + y / M_PER_DEG,
  lng: ORIGIN.lng + x / (M_PER_DEG * cos(ORIGIN.lat)),
})
const through = (...xy: [number, number][]): Pt[] => xy.map(spot)
const east = (m: number) => m / (M_PER_DEG * cos(ORIGIN.lat))
const north = (m: number) => m / M_PER_DEG

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

/** Where the driver truly is after `s` metres, and the way they are heading. */
function truth(track: Track, s: number): { pos: Pt; heading: number } {
  const { points, cum, bearings } = track
  let i = 0
  while (i < points.length - 2 && cum[i + 1] < s) i++
  const t = Math.min(1, Math.max(0, (s - cum[i]) / (cum[i + 1] - cum[i])))
  return {
    pos: { lat: points[i].lat + (points[i + 1].lat - points[i].lat) * t, lng: points[i].lng + (points[i + 1].lng - points[i].lng) * t },
    heading: bearings[i],
  }
}

interface Step {
  s: number
  progress: Progress
  /** The heading the phone gave at this fix, if any. */
  heading: number | null
}

interface DriveOptions {
  /** Metres a second: 10 is about 36 km/h. */
  speed?: number
  /** Metres between fixes, which with the speed is how often they come: by default one a second. */
  step?: number
  /** Metres of noise on each fix, in both directions. */
  noise?: number
  /** How much of the last fix's error carries over into the next, as real GPS error does (0 to 1). */
  carry?: number
  /** The phone's heading is wrong by about this many degrees. */
  headingNoise?: number
  /** How many of the first fixes have no heading, as just after the phone starts to move. */
  blind?: number
  from?: number
  to?: number
  seed?: number
  start?: Progress | null
  /** Whether to give the phone's heading at all. */
  heading?: boolean
  /** Whether, with no course from the phone, the heading is worked out from where it has been, as the app does. On unless the course is all there is. */
  trail?: boolean
  /** When the first fix is, in milliseconds. */
  time0?: number
  /** The driver stops for this many seconds when they reach these distances along the route: fixes keep coming, with no speed and no heading. */
  dwells?: { at: number; seconds: number }[]
  /** Every so many fixes is a spike, this many metres off (between the two) in a random direction, though it claims to be as accurate as ever. */
  spike?: { every: number; metres: [number, number] }
}

/**
 * Drive along a track and say where the tracker thinks the driver is after each fix. A real phone only gives a heading
 * (its course) while it is moving fast enough, and its error drifts rather than jumping, so those are what is made.
 */
function drive(track: Track, o: DriveOptions = {}): Step[] {
  const { speed = 10, noise = 5, carry = 0, headingNoise = 12, blind = 1, seed = 1, heading = true } = o
  const step = o.step ?? speed
  const seconds = step / speed
  const r = random(seed)
  const end = o.to ?? track.cum[track.cum.length - 1]
  const dwells = [...(o.dwells ?? [])].sort((a, b) => a.at - b.at)
  let progress: Progress | null = o.start ?? null
  let trail: TrailPoint[] = []
  const out: Step[] = []
  let k = 0
  let clock = o.time0 ?? 0
  let err = [0, 0]
  const fixAt = (s: number, moving: boolean) => {
    const { pos, heading: h } = truth(track, s)
    err = err.map((e) => carry * e + Math.sqrt(1 - carry * carry) * gaussian(r) * noise)
    let dx = err[0]
    let dy = err[1]
    if (o.spike && k % o.spike.every === o.spike.every - 1) {
      const [lo, hi] = o.spike.metres
      const m = lo + r() * (hi - lo)
      const a = r() * 2 * Math.PI
      dx += m * Math.sin(a)
      dy += m * Math.cos(a)
    }
    const fix = {
      lat: pos.lat + north(dy),
      lng: pos.lng + east(dx),
      accuracy: Math.max(5, noise * 1.5),
      time: clock,
      speed: moving ? speed : 0,
    }
    const course = heading && moving && speed >= 1.5 && k >= blind ? (h + gaussian(r) * headingNoise + 360) % 360 : null
    const hdg = course ?? (heading && o.trail !== false ? trailHeading(trail, fix.accuracy) : null)
    const before = progress
    progress = advance(track, progress, fix, hdg)
    if (!progress) throw new Error('no progress')
    if (progress !== before) trail = pushTrail(trail, { lat: progress.at.lat, lng: progress.at.lng, time: progress.time ?? clock })
    out.push({ s, progress, heading: hdg })
    k++
  }
  for (let s = o.from ?? 0; s <= end; s += step) {
    fixAt(s, true)
    clock += seconds * 1000
    for (const d of dwells) {
      if (d.at >= s && d.at < s + step) {
        for (let i = 0; i < d.seconds; i++) {
          fixAt(Math.min(end, d.at), false)
          clock += 1000
        }
      }
    }
  }
  return out
}

/** How far out the tracker is, at worst, over the steps that count. */
const worstError = (steps: Step[], skip: (s: number) => boolean = () => false) =>
  Math.max(...steps.filter((x) => !skip(x.s)).map((x) => Math.abs(x.progress.along - x.s)))

describe('following a route driven once', () => {
  const track = makeTrack(through([0, 0], [0, 400], [300, 400], [300, 800]))

  it('stays within a few metres of the truth, through the corners', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const steps = drive(track, { seed })
      expect(worstError(steps)).toBeLessThan(25)
    }
  })

  it('only ever moves on, in the furthest it has reached', () => {
    const steps = drive(track, { noise: 8 })
    for (let i = 1; i < steps.length; i++) expect(steps[i].progress.furthest).toBeGreaterThanOrEqual(steps[i - 1].progress.furthest)
    expect(steps.at(-1)!.progress.furthest).toBeGreaterThan(track.cum.at(-1)! - 30)
  })

  it('has the phone on the route, with no doubt about where it is', () => {
    const steps = drive(track)
    expect(steps.every((x) => !x.progress.lost && x.progress.gap < 25)).toBe(true)
    expect(steps.at(-1)!.progress.doubt).toBeNull()
  })

  it('works with no heading at all', () => {
    expect(worstError(drive(track, { heading: false }))).toBeLessThan(25)
  })

  it('has nothing to go on for a route with no stretches', () => {
    expect(advance(makeTrack([]), null, { ...spot([0, 0]), accuracy: 5 }, null)).toBeNull()
    expect(advance(makeTrack(through([0, 0])), null, { ...spot([0, 0]), accuracy: 5 }, null)).toBeNull()
  })
})

describe('a street driven out and back along the very same line', () => {
  // Out 300 m, a U-turn, and back 300 m on exactly the same ground.
  const track = makeTrack(through([0, 0], [0, 300], [0, 0]))
  const nearTurn = (s: number) => Math.abs(s - 300) < 40

  it('tells the way out from the way back at every fix, whatever the noise', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const steps = drive(track, { seed, noise: 6 })
      for (const x of steps) {
        if (nearTurn(x.s)) continue
        expect(x.progress.along < 300, `seed ${seed} at ${x.s}: ${x.progress.along}`).toBe(x.s < 300)
      }
      expect(worstError(steps, nearTurn)).toBeLessThan(40)
    }
  })

  it('does so even when the phone has no heading', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const steps = drive(track, { seed, heading: false })
      // With no heading the turn itself is ambiguous for a few fixes, until the driver is clear of it.
      for (const x of steps) if (Math.abs(x.s - 300) >= 70) expect(x.progress.along < 300, `seed ${seed} at ${x.s}`).toBe(x.s < 300)
    }
  })

  it('does so with a wrong-ish heading, up to a right angle out', () => {
    for (const seed of [1, 2, 3]) {
      const steps = drive(track, { seed, headingNoise: 45 })
      for (const x of steps) if (!nearTurn(x.s)) expect(x.progress.along < 300).toBe(x.s < 300)
    }
  })

  it('keeps to the way back when the driver slows to a stop in the middle of it', () => {
    // Fixes pile up in one place, jittering, as at a red light.
    const r = random(7)
    let progress: Progress | null = drive(track, { to: 440 }).at(-1)!.progress
    for (let k = 0; k < 40; k++) {
      const { pos } = truth(track, 450)
      progress = advance(track, progress, { lat: pos.lat + north(gaussian(r) * 7), lng: pos.lng + east(gaussian(r) * 7), accuracy: 10 }, null)!
      expect(progress.along).toBeGreaterThan(400)
    }
  })

  it('does not hop to the way back while still on the way out, when it is a short street', () => {
    const short = makeTrack(through([0, 0], [0, 60], [0, 0]))
    for (const seed of [1, 2, 3, 4, 5]) {
      const steps = drive(short, { seed, step: 5, noise: 4 })
      for (const x of steps) if (Math.abs(x.s - 60) > 20) expect(x.progress.along < 60, `seed ${seed} at ${x.s}`).toBe(x.s < 60)
    }
  })
})

describe('the same lap driven twice, the same way round', () => {
  // Two laps of a square block: the second lies exactly on the first, and heading is no help.
  const lap = [[0, 0], [200, 0], [200, 200], [0, 200]] as [number, number][]
  const track = makeTrack(through(...lap, ...lap, [0, 0]))

  it('knows which lap it is on', () => {
    for (const seed of [1, 2, 3]) {
      const steps = drive(track, { seed })
      expect(worstError(steps)).toBeLessThan(45)
      expect(steps.at(-1)!.progress.along).toBeGreaterThan(1500)
    }
  })
})

describe('a route that crosses itself', () => {
  // A figure of eight: the two crossings are the same place.
  const track = makeTrack(through([0, 0], [200, 200], [0, 200], [200, 0], [0, 0]))

  it('follows the line through the crossing, not the other one', () => {
    for (const seed of [1, 2, 3, 4]) {
      const steps = drive(track, { seed })
      expect(worstError(steps)).toBeLessThan(40)
    }
  })
})

describe('starting part way along', () => {
  const track = makeTrack(through([0, 0], [0, 300], [0, 0]))

  it('takes the way back when told that is where the round was up to', () => {
    const start = startProgress(track, 400)
    const steps = drive(track, { from: 420, to: 560, start, heading: false })
    for (const x of steps) expect(x.progress.along).toBeGreaterThan(380)
  })

  it('takes the way back when the phone heading says so, with nothing else to go on', () => {
    const steps = drive(track, { from: 420, to: 560, blind: 0, headingNoise: 5 })
    for (const x of steps.slice(3)) expect(x.progress.along).toBeGreaterThan(380)
  })

  it('puts the driver at the start of the route, with the round at its start', () => {
    const steps = drive(track, { from: 0, to: 100, start: startProgress(track, 0) })
    expect(worstError(steps)).toBeLessThan(25)
  })

  it('starts the furthest reached at the spot the round was started from', () => {
    const start = startProgress(track, 250)
    expect(start).toMatchObject({ along: 250, furthest: 250, lost: true, doubt: null })
    expect(start.idx).toBe(0)
    expect(start.t).toBeCloseTo(250 / 300, 2)
  })

  it('keeps a start past the end, or before the beginning, on the route', () => {
    expect(startProgress(track, 10000).along).toBeCloseTo(track.cum.at(-1)!, 5)
    expect(startProgress(track, -5).along).toBe(0)
  })

  it('corrects itself when it first guessed the wrong way, once the heading is known', () => {
    // The first fixes are on the way back, but with no heading and nothing to go on the way out is as good a guess.
    const steps = drive(track, { from: 420, to: 590, blind: 5, headingNoise: 5, seed: 3 })
    expect(steps.at(-1)!.progress.along).toBeGreaterThan(400)
    const settled = steps.findIndex((x) => x.progress.along > 380)
    expect(settled).toBeLessThan(12)
  })
})

describe('a fix that cannot be right', () => {
  const track = makeTrack(through([0, 0], [0, 600]))
  let clock = 0
  /** A fix on the route after `s` metres, a second after the last, as from a phone that is moving. */
  const clean = (s: number) => ({ ...truth(track, s).pos, accuracy: 5, time: (clock += 1000), speed: 10 })
  const at = (xy: [number, number], seconds = 1) => ({ ...spot(xy), accuracy: 5, time: (clock += seconds * 1000), speed: 10 })

  it('is too far from the route to say anything, and leaves the driver where they were', () => {
    const before = advance(track, null, clean(200), 0)!
    // Nearest to a part of the route well beyond where the driver was, which is no reason to think they are there.
    const far = advance(track, before, at([300, 450], 60), 0)!
    expect(far.lost).toBe(true)
    expect(far.along).toBe(before.along)
    expect(far.idx).toBe(before.idx)
    expect(far.furthest).toBe(before.furthest)
    expect(far.gap).toBeGreaterThan(250)
  })

  it('is on the route when it is only a little way from it, and not when it is further than the fix could be out', () => {
    const near = advance(track, null, at([45, 200]), 0)!
    expect(near.lost).toBe(false)
    expect(near.gap).toBeGreaterThan(40)
    expect(near.gap).toBeLessThan(50)
    const far = advance(track, null, at([70, 200]), 0)!
    expect(far.lost).toBe(true)
  })

  it('carries straight on afterwards, without a jump', () => {
    let p = advance(track, null, clean(200), 0)!
    p = advance(track, p, at([300, 200], 30), 0)!
    expect(p.lost).toBe(true)
    p = advance(track, p, clean(215), 0)!
    expect(p.lost).toBe(false)
    expect(Math.abs(p.along - 215)).toBeLessThan(3)
  })

  it('starts afresh when the driver comes back to the route after leaving it, wherever that is', () => {
    let p = advance(track, null, clean(100), 0)!
    p = advance(track, p, at([400, 150], 30), 0)!
    expect(p.lost).toBe(true)
    p = advance(track, p, clean(500), 0)!
    expect(p.lost).toBe(false)
    expect(Math.abs(p.along - 500)).toBeLessThan(3)
    expect(p.furthest).toBeGreaterThan(490)
  })

  it('does not move the furthest reached for fixes that are on the route only just, however many', () => {
    let p = advance(track, null, clean(100), 0)!
    // Drifting away from the route to 45 m off it, and on along it.
    for (const xy of [[15, 110], [30, 120], [45, 130], [45, 140], [45, 150], [45, 160], [45, 170]] as [number, number][]) p = advance(track, p, at(xy), 0)!
    expect(p.along).toBeGreaterThan(150)
    expect(p.furthest).toBeLessThan(115)
  })

  it('takes the accuracy into account: a poor fix can be further from the route and still on it', () => {
    const p = advance(track, null, { ...spot([-70, 200]), accuracy: 40 }, 0)!
    expect(p.lost).toBe(false)
    const q = advance(track, null, { ...spot([-70, 200]), accuracy: 5 }, 0)!
    expect(q.lost).toBe(true)
  })

  describe('one that was already seen', () => {
    it('changes nothing, however many times it comes', () => {
      let p = advance(track, null, clean(100), 0)!
      p = advance(track, p, clean(110), 0)!
      const again = { ...truth(track, 110).pos, accuracy: 5, time: p.time!, speed: 10 }
      expect(advance(track, p, again, 0)).toBe(p)
      expect(advance(track, p, { ...again, time: p.time! - 500 }, 0)).toBe(p)
    })

    it('does not add up to a belief in a jump by being counted again and again', () => {
      let p = advance(track, null, clean(100), 0)!
      p = advance(track, p, clean(110), 0)!
      const stray = { ...truth(track, 520).pos, accuracy: 5, time: (clock += 1000), speed: 10 }
      const first = advance(track, p, stray, 0)!
      for (let i = 0; i < 5; i++) expect(advance(track, first, stray, 0)).toBe(first)
      expect(first.along).toBe(p.along)
      expect(first.outliers).toBe(1)
    })
  })

  describe('one that is too poor to go by', () => {
    it('is ignored, so the driver stays where they were', () => {
      const p = advance(track, null, clean(100), 0)!
      expect(advance(track, p, { ...truth(track, 110).pos, accuracy: 66, time: (clock += 1000), speed: 10 }, 0)).toBe(p)
    })

    it('is not good enough to start from', () => {
      expect(advance(track, null, { ...truth(track, 100).pos, accuracy: 120, time: 1000 }, 0)).toBeNull()
    })

    it('is used when it is only just good enough', () => {
      const p = advance(track, null, clean(100), 0)!
      const q = advance(track, p, { ...truth(track, 110).pos, accuracy: 65, time: (clock += 1000), speed: 10 }, 0)!
      expect(q).not.toBe(p)
      expect(q.along).toBeGreaterThan(105)
    })
  })

  describe('one that is further from the last than a car can have gone', () => {
    it('is set aside, and the next fix carries on from where the driver was', () => {
      let p = advance(track, null, clean(100), 0)!
      p = advance(track, p, clean(110), 0)!
      const glitch = advance(track, p, clean(450), 0)!
      expect(glitch.along).toBe(p.along)
      expect(glitch.furthest).toBe(p.furthest)
      expect(glitch.outliers).toBe(1)
      expect(glitch.at).toBe(p.at)
      const back = advance(track, glitch, clean(130), 0)!
      expect(Math.abs(back.along - 130)).toBeLessThan(3)
      expect(back.outliers).toBe(0)
    })

    it('is set aside twice, and believed the third time, since the driver really did go that far', () => {
      let p = advance(track, null, clean(100), 0)!
      p = advance(track, p, clean(110), 0)!
      let q = advance(track, p, clean(450), 0)!
      q = advance(track, q, clean(460), 0)!
      expect(q.outliers).toBe(2)
      expect(q.along).toBe(p.along)
      q = advance(track, q, clean(470), 0)!
      expect(q.outliers).toBe(0)
      expect(q.doubt).not.toBeNull()
    })

    it('is let through when it says it is not accurate, since a poor fix can be that far out', () => {
      let p = advance(track, null, clean(100), 0)!
      p = advance(track, p, clean(110), 0)!
      const q = advance(track, p, { ...truth(track, 160).pos, accuracy: 40, time: (clock += 1000), speed: 10 }, 0)!
      expect(q.outliers).toBe(0)
    })

    it('is not set aside when the driver was not on the route to begin with', () => {
      const lost = advance(track, null, at([300, 200]), 0)!
      expect(lost.lost).toBe(true)
      const found = advance(track, lost, clean(500), 0)!
      expect(found.lost).toBe(false)
      expect(found.outliers).toBe(0)
    })
  })

  describe('a phone that is standing still', () => {
    it('stays where it was put, however much it jitters', () => {
      const p = advance(track, null, clean(100), 0)!
      const r = random(5)
      for (let i = 0; i < 40; i++) {
        const pos = truth(track, 100).pos
        const q = advance(track, p, { lat: pos.lat + north(gaussian(r) * 1.5), lng: pos.lng + east(gaussian(r) * 1.5), accuracy: 8, time: (clock += 1000), speed: 0 }, null)
        expect(q).toBe(p)
      }
    })

    it('does so when it cannot say how fast it is going', () => {
      const p = advance(track, null, clean(100), 0)!
      const pos = truth(track, 103).pos
      expect(advance(track, p, { ...pos, accuracy: 5, time: (clock += 1000) }, null)).toBe(p)
    })

    it('stays put for a move of just under the jitter, and not for one just over', () => {
      const p = advance(track, null, clean(100), 0)!
      const pos = (m: number) => ({ ...truth(track, 100 + m).pos, accuracy: 8, time: (clock += 1000), speed: 0 })
      expect(advance(track, p, pos(5.8), null)).toBe(p)
      expect(advance(track, p, pos(6.4), null)).not.toBe(p)
    })

    it('moves again once it has gone further than the jitter', () => {
      const p = advance(track, null, clean(100), 0)!
      const q = advance(track, p, { ...truth(track, 125).pos, accuracy: 5, time: (clock += 1000), speed: 0 }, null)!
      expect(q).not.toBe(p)
      expect(q.along).toBeGreaterThan(120)
    })

    it('does not stay put when it says it is moving, however little it has moved', () => {
      const p = advance(track, null, clean(100), 0)!
      const q = advance(track, p, { ...truth(track, 103).pos, accuracy: 5, time: (clock += 1000), speed: 3 }, 0)!
      expect(q).not.toBe(p)
    })
  })

  describe('a jump to another part of the route', () => {
    // A street out 60 m, across 80 m and back: the way back is too far from the way out to be mistaken for it, but a long way along the route.
    const hairpin = makeTrack(through([0, 0], [0, 60], [80, 60], [80, 0]))
    let t = 0
    const onHairpin = (xy: [number, number], seconds = 1) => ({ ...spot(xy), accuracy: 5, time: (t += seconds * 1000), speed: 15 })

    it('is believed at once when it is not much more than the phone moved', () => {
      let p = advance(hairpin, null, onHairpin([0, 5]), 0)!
      p = advance(hairpin, p, onHairpin([0, 10]), 0)!
      // Across to the way back, 80 m by the phone in four seconds, and 180 m further on along the route.
      p = advance(hairpin, p, onHairpin([80, 10], 4), null)!
      expect(Math.round(p.along)).toBe(60 + 80 + 50)
      expect(p.doubt).toBeNull()
    })

    // The same, but with the way back a long way along: a street out 300 m.
    const long = makeTrack(through([0, 0], [0, 300], [80, 300], [80, 0]))
    const onLong = (xy: [number, number], seconds = 1) => ({ ...spot(xy), accuracy: 5, time: (t += seconds * 1000), speed: 15 })

    it('is held at first, and believed once it has been seen again and again over some distance, as when a shortcut was taken', () => {
      let p = advance(long, null, onLong([0, 100]), 0)!
      p = advance(long, p, onLong([0, 110]), 0)!
      // Across to the way back, which is 80 m by the phone and about 460 m further along the route, and then on along it.
      const seen: number[] = []
      for (const [i, xy] of ([[80, 110], [80, 100], [80, 90], [80, 80], [80, 70]] as [number, number][]).entries()) {
        p = advance(long, p, onLong(xy, i === 0 ? 4 : 1), 180)!
        seen.push(Math.round(p.along))
      }
      expect(seen[0]).toBe(110)
      expect(seen[1]).toBe(110)
      expect(seen[2]).toBeGreaterThan(500)
      expect(p.along).toBeGreaterThan(500)
      expect(p.doubt).toBeNull()
    })

    it('is not believed for standing still by the other street', () => {
      let p = advance(long, null, onLong([0, 100]), 0)!
      p = advance(long, p, onLong([0, 110]), 0)!
      for (let i = 0; i < 10; i++) p = advance(long, p, { ...spot([80, 112]), accuracy: 5, time: (t += i === 0 ? 4000 : 1000), speed: 0 }, null)!
      expect(p.along).toBeLessThan(150)
    })
  })

  describe('the furthest reached', () => {
    it('follows the driver on, a couple of fixes behind', () => {
      let p: Progress | null = null
      for (const s of [100, 110, 120, 130, 140, 150]) p = advance(track, p, clean(s), 0)
      expect(p!.along).toBeCloseTo(150, 0)
      expect(p!.furthest).toBeCloseTo(130, 0)
    })
  })
})

describe('when the two passes fit the fix equally and the driver is still', () => {
  const track = makeTrack(through([0, 0], [0, 300], [0, 0]))

  it('does not take a stop for the driver going backwards, however it jitters', () => {
    // A street driven out and back twice, and the tracker on the way out, with two fixes of going back along it behind it.
    const four = makeTrack(through([0, 0], [0, 300], [0, 0], [0, 300], [0, 0]))
    let p: Progress = { ...startProgress(four, 285), lost: false, at: spot([0, 285]) }
    for (const [i, y] of [270, 255].entries()) p = advance(four, p, { ...spot([0, y]), accuracy: 5, time: 1000 + i * 1000, speed: 10 }, null)!
    expect(p.backward).toBe(2)
    // Then it stops, the position still drifting back, which it would have to be going on to be sure.
    p = advance(four, p, { ...spot([0, 240]), accuracy: 5, time: 4000, speed: 0 }, null)!
    expect(p.backward).toBe(0)
    expect(p.along).toBeLessThan(285)
  })

  it('takes the pass that is ahead of where the driver was rather than the one behind it', () => {
    // At the turn at the end of the street, then a fix 30 m down the street from it, the phone not having moved at all by its own account.
    const atTurn = advance(track, null, { ...spot([0, 300]), accuracy: 5, time: 1000 }, null)!
    const still = { ...atTurn, at: spot([0, 270]) }
    const p = advance(track, still, { ...spot([0, 270]), accuracy: 5, time: 2000, speed: 5 }, null)!
    expect(p.along).toBeGreaterThan(300)
  })

  it('goes on to the nearest pass ahead when it has been going backwards, and not to one much further on', () => {
    // A street driven out and back twice: four passes over the same line.
    const four = makeTrack(through([0, 0], [0, 300], [0, 0], [0, 300], [0, 0]))
    let p: Progress = { ...startProgress(four, 285), lost: false, at: spot([0, 285]) }
    // The driver is on the way back, but the tracker thinks they are still on the way out and going backwards.
    for (const [i, y] of [270, 255, 240, 225].entries()) {
      p = advance(four, p, { ...spot([0, y]), accuracy: 5, time: 2000 + i * 1000 }, null)!
    }
    // The nearest pass ahead of 285 is the way back, around 300 + (300 - 225) = 375, not the second way out or back.
    expect(p.along).toBeGreaterThan(330)
    expect(p.along).toBeLessThan(450)
  })
})

describe('where the driver is, on a bigger route', () => {
  it('is quick even for a route of thousands of points', { timeout: 60_000 }, () => {
    const pts: Pt[] = Array.from({ length: 6000 }, (_, i) => spot([Math.sin(i / 40) * 80, i * 5]))
    const track = makeTrack(pts)
    const started = Date.now()
    let p: Progress | null = null
    for (let s = 0; s < 3000; s += 10) {
      const { pos } = truth(track, s)
      p = advance(track, p, { ...pos, accuracy: 5 }, null)
    }
    expect(Date.now() - started).toBeLessThan(2000)
    expect(haversine(p!.at, truth(track, 2990).pos)).toBeLessThan(2)
  })
})

describe('which turn is shown on a street driven twice', () => {
  /** What should be shown after `s` metres: the next turn not yet passed, near enough to be worth showing. */
  const expected = (turns: ReturnType<typeof routeTurns>, s: number) => {
    const turn = turns.find((t) => t.at - s >= -15)
    return turn && turn.at - s <= TURN_SHOW_M ? turn : null
  }

  /** Drive the route and, at every fix, compare the turn shown with the one being driven to, and how far out the tracker is. */
  function check(points: Pt[], seeds: number[], options: DriveOptions | ((seed: number, length: number) => DriveOptions) = {}, maxError = 70) {
    const track = makeTrack(points)
    const turns = routeTurns(points)
    expect(turns.length).toBeGreaterThan(1)
    let compared = 0
    for (const seed of seeds) {
      const steps = drive(track, { seed, ...(typeof options === 'function' ? options(seed, track.cum.at(-1)!) : options) })
      for (const x of steps) {
        expect(Math.abs(x.progress.along - x.s), `seed ${seed} at ${x.s}: along ${x.progress.along}`).toBeLessThan(maxError)
        const shown = upcomingTurn(turns, x.progress.along, { heading: x.heading, after: x.progress.furthest - 15 })
        // Close to where one turn gives way to the next, either answer is right.
        const nearEdge = turns.some((t) => Math.abs(t.at - x.s) < 35 || Math.abs(t.at - x.s - 15) < 35 || Math.abs(t.at - x.s - TURN_SHOW_M) < 35)
        if (nearEdge) continue
        const want = expected(turns, x.s)
        compared++
        // Never one from further on in the route than the one being driven to, which is what a mix-up between passes shows.
        if (shown) expect(shown.turn.at, `seed ${seed} at ${x.s}`).toBeLessThanOrEqual((want?.at ?? -Infinity) + 1)
        expect(shown?.turn.at ?? null, `seed ${seed} at ${x.s}`).toBe(want?.at ?? null)
      }
    }
    expect(compared).toBeGreaterThan(50)
  }

  it('shows each turn of a spur street in turn, out and back along the same line', () => {
    // Up the main road, right into a spur, to its end, back along the spur, and right again onto the main road.
    check(through([0, 0], [0, 300], [250, 300], [0, 300], [0, 600]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('does so for a spur so short that the turn back out comes up within sight of the turn in', () => {
    check(through([0, 0], [0, 300], [90, 300], [0, 300], [0, 600]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { noise: 4, step: 5 })
  })

  it('does so for a street driven down and straight back, with a turn at each end of it', () => {
    check(through([0, 0], [0, 200], [400, 200], [400, 100], [400, 200], [0, 200], [0, 500]), [1, 2, 3, 4, 5, 6])
  })

  it('does so with no heading from the phone at all, once the driver is clear of the turns', () => {
    check(through([0, 0], [0, 300], [250, 300], [0, 300], [0, 600]), [1, 2, 3], { heading: false, noise: 4 })
  })
})

describe('driving as a phone really does', () => {
  // GPS error that drifts rather than jumps, stops at lights and houses with the course lost, and now and then a fix that is just wrong.
  const routes: [string, Pt[]][] = [
    ['a spur', through([0, 0], [0, 300], [250, 300], [0, 300], [0, 600])],
    ['a short spur', through([0, 0], [0, 300], [90, 300], [0, 300], [0, 600])],
    ['a street driven down and back', through([0, 0], [0, 200], [400, 200], [400, 100], [400, 200], [0, 200], [0, 500])],
    ['an out and back', through([0, 0], [0, 400], [0, 0], [300, 0])],
    ['carriageways 20 m apart', through([0, 0], [0, 400], [20, 400], [20, 0], [300, 0])],
    ['two laps of a block', through([0, 0], [200, 0], [200, 200], [0, 200], [0, 0], [200, 0], [200, 200], [0, 200], [0, 0])],
    ['a figure of eight', through([0, 0], [200, 200], [0, 200], [200, 0], [0, 0])],
  ]
  const expected = (turns: ReturnType<typeof routeTurns>, s: number) => {
    const turn = turns.find((t) => t.at - s >= -15)
    return turn && turn.at - s <= TURN_SHOW_M ? turn : null
  }
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

  /** At every fix of drives with these options: the tracker is within `maxError` of the truth, and the turn shown is the one being driven to. */
  function holds(options: (seed: number, length: number) => DriveOptions, maxError: number) {
    for (const [name, points] of routes) {
      const track = makeTrack(points)
      const turns = routeTurns(points)
      for (const seed of seeds) {
        for (const x of drive(track, { seed, ...options(seed, track.cum.at(-1)!) })) {
          expect(Math.abs(x.progress.along - x.s), `${name}, seed ${seed}, at ${x.s}`).toBeLessThan(maxError)
          const edge = turns.some((t) => Math.abs(t.at - x.s) < 35 || Math.abs(t.at - x.s - 15) < 35 || Math.abs(t.at - x.s - TURN_SHOW_M) < 35)
          if (edge) continue
          const shown = upcomingTurn(turns, x.progress.along, { heading: x.heading, after: x.progress.furthest - 15 })
          expect(shown?.turn.at ?? null, `${name}, seed ${seed}, at ${x.s}`).toBe(expected(turns, x.s)?.at ?? null)
        }
      }
    }
  }

  it('is right with GPS error that drifts, as real error does', { timeout: 60_000 }, () => {
    holds((seed) => ({ seed, noise: 6, carry: 0.85 }), 60)
  })

  it('is right with a good deal more of it', { timeout: 60_000 }, () => {
    holds((seed) => ({ seed, noise: 12, carry: 0.85 }), 80)
  })

  it('is right through stops, where there is no speed and no course and the position drifts', { timeout: 60_000 }, () => {
    holds(
      (seed, length) => ({
        seed,
        noise: 5,
        carry: 0.85,
        dwells: [0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((f, i) => ({ at: Math.floor(length * f), seconds: 5 + ((seed + i * 7) % 21) })),
      }),
      60,
    )
  })

  it('is right when every thirtieth fix is a glitch 90 to 160 m away', { timeout: 60_000 }, () => {
    holds((seed) => ({ seed, noise: 5, carry: 0.85, spike: { every: 30, metres: [90, 160] } }), 60)
  })

  it('is right at 3 metres a second, which has no course from the phone but a heading from where it has been', { timeout: 60_000 }, () => {
    holds((seed) => ({ seed, noise: 6, carry: 0.85, speed: 3 }), 60)
  })

  it('is right at walking pace along a route that does not double back on itself', { timeout: 60_000 }, () => {
    const track = makeTrack(through([0, 0], [0, 300], [300, 300], [300, 600]))
    for (const seed of seeds) {
      const steps = drive(track, { seed, noise: 6, carry: 0.85, speed: 1.2 })
      for (const x of steps) expect(Math.abs(x.progress.along - x.s), `seed ${seed} at ${x.s}`).toBeLessThan(60)
    }
  })
})

describe('a position carried over to a route that has had points added', () => {
  /** Up 400 m, east 300 m, up 400 m more. */
  const corner = (): Route => ({ points: through([0, 0], [0, 400], [300, 400], [300, 800]), sideChanges: [{ idx: 0, side: 'both' }], stops: [] })
  const where = (track: Track, idx: number, t: number): Pt => {
    const a = track.points[idx]
    const b = track.points[idx + 1]
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }
  }
  /** A driver on the route `s` metres along, as the tracker would have them on a first fix. */
  const driverAt = (track: Track, s: number): Progress => advance(track, null, { ...truth(track, s).pos, accuracy: 5, time: 1000, speed: 10 }, truth(track, s).heading)!
  /** The tracker's position on the new route, and whether it is the same place and the same distance as before. */
  const samePlace = (before: Track, after: Track, prev: Progress, next: Progress) => {
    expect(alongPath(after.cum, next.idx, next.t)).toBeCloseTo(prev.along, 1)
    expect(haversine(where(after, next.idx, next.t), where(before, prev.idx, prev.t))).toBeLessThan(0.01)
  }

  it('is still the same distance along, and the same place, when points went in before it', () => {
    const before = makeTrack(corner().points)
    const prev = driverAt(before, 520)
    const edited = paintMetres(corner(), 100, 300, 'left')!
    expect(edited.points).toHaveLength(6)
    const after = makeTrack(edited.points)
    const next = rebaseProgress(after, prev)
    expect(next.idx).toBe(prev.idx + 2)
    samePlace(before, after, prev, next)
  })

  it('does not point at the stretch it used to, which is now another one', () => {
    const before = makeTrack(corner().points)
    const prev = driverAt(before, 520)
    const after = makeTrack(paintMetres(corner(), 100, 300, 'left')!.points)
    // Without it, the old numbers put the driver 200 m back, on the stretch the new points were put into.
    expect(Math.abs(alongPath(after.cum, prev.idx, prev.t) - prev.along)).toBeGreaterThan(100)
    expect(Math.abs(alongPath(after.cum, rebaseProgress(after, prev).idx, rebaseProgress(after, prev).t) - prev.along)).toBeLessThan(0.1)
  })

  it('keeps its stretch and place when points went in after it', () => {
    const before = makeTrack(corner().points)
    const prev = driverAt(before, 120)
    const after = makeTrack(paintMetres(corner(), 600, 760, 'left')!.points)
    const next = rebaseProgress(after, prev)
    expect(next.idx).toBe(prev.idx)
    expect(next.t).toBeCloseTo(prev.t, 6)
    samePlace(before, after, prev, next)
  })

  it('finds the right part of the stretch when the points went into that very stretch', () => {
    const before = makeTrack(corner().points)
    // The stretch from 400 m to 700 m is cut at 450 m and 600 m.
    const after = makeTrack(paintMetres(corner(), 450, 600, 'left')!.points)
    for (const [s, idx, t] of [
      [430, 1, 0.6],
      [450, 2, 0],
      [520, 2, 70 / 150],
      [650, 3, 0.5],
    ] as const) {
      const prev = driverAt(before, s)
      const next = rebaseProgress(after, prev)
      expect(next.idx, `at ${s}`).toBe(idx)
      expect(next.t, `at ${s}`).toBeCloseTo(t, 3)
      samePlace(before, after, prev, next)
    }
  })

  it('keeps everything else about it: how far it has got, how sure it is, when it was and what it saw', () => {
    const before = makeTrack(corner().points)
    const steps = drive(before, { to: 520, noise: 6, carry: 0.85, seed: 3 })
    const prev = steps.at(-1)!.progress
    const next = rebaseProgress(makeTrack(paintMetres(corner(), 100, 300, 'left')!.points), prev)
    expect(next).toEqual({ ...prev, idx: next.idx, t: next.t })
    expect(next.furthest).toBe(prev.furthest)
    expect(next.along).toBe(prev.along)
    expect(next.recent).toEqual(prev.recent)
    expect(next.at).toBe(prev.at)
    expect(next.time).toBe(prev.time)
    expect(next.seen).toBe(prev.seen)
  })

  it('keeps the doubt, the backward and outlier counts and the gap of one that is unsure', () => {
    const before = makeTrack(corner().points)
    const prev: Progress = { ...driverAt(before, 520), gap: 31.5, doubt: { along: 700, fixes: 2 }, backward: 2, outliers: 1, accuracy: 18, furthest: 540 }
    const next = rebaseProgress(makeTrack(paintMetres(corner(), 100, 300, 'left')!.points), prev)
    expect(next).toMatchObject({ gap: 31.5, doubt: { along: 700, fixes: 2 }, backward: 2, outliers: 1, accuracy: 18, furthest: 540, lost: false })
  })

  it('keeps a position that is lost where it was, with the fix it came from', () => {
    const before = makeTrack(corner().points)
    const prev = startProgress(before, 250)
    const after = makeTrack(paintMetres(corner(), 100, 300, 'left')!.points)
    const next = rebaseProgress(after, prev)
    expect(next).toMatchObject({ along: 250, furthest: 250, lost: true, gap: 0, doubt: null, recent: [] })
    expect(next.at).toBe(prev.at)
    // The route is now cut at 100 m and 300 m, so 250 m is three quarters of the way along its second stretch.
    expect(next.idx).toBe(1)
    expect(next.t).toBeCloseTo(0.75, 6)
    samePlace(before, after, prev, next)
  })

  it('keeps a lost position that is a long way from the route', () => {
    const before = makeTrack(corner().points)
    const prev: Progress = { ...driverAt(before, 520), lost: true, gap: 900, at: spot([5000, 5000]) }
    const after = makeTrack(paintMetres(corner(), 100, 300, 'left')!.points)
    const next = rebaseProgress(after, prev)
    expect(next).toEqual({ ...prev, idx: next.idx, t: next.t })
    samePlace(before, after, prev, next)
  })

  it('is at the start of the first stretch at the start of the route, and the end of the last at its end', () => {
    const after = makeTrack(paintMetres(corner(), 100, 300, 'left')!.points)
    const start = rebaseProgress(after, startProgress(makeTrack(corner().points), 0))
    expect([start.idx, start.t, start.along]).toEqual([0, 0, 0])
    const total = after.cum.at(-1)!
    const end = rebaseProgress(after, startProgress(makeTrack(corner().points), total))
    expect(end.idx).toBe(after.points.length - 2)
    expect(end.t).toBe(1)
    expect(end.along).toBeCloseTo(total, 6)
  })

  it('stays on the route when the distance is beyond either end of it, without changing the distance', () => {
    const after = makeTrack(corner().points)
    const prev = startProgress(after, 400)
    const past = rebaseProgress(after, { ...prev, along: 5000 })
    expect([past.idx, past.t, past.along]).toEqual([2, 1, 5000])
    const back = rebaseProgress(after, { ...prev, along: -30 })
    expect([back.idx, back.t, back.along]).toEqual([0, 0, -30])
  })

  it('has nothing to go by on a route with no stretches, and gives the position back', () => {
    const prev = startProgress(makeTrack(corner().points), 250)
    expect(rebaseProgress(makeTrack([]), prev)).toBe(prev)
    expect(rebaseProgress(makeTrack(through([0, 0])), prev)).toBe(prev)
  })

  it('does not change the position it was given', () => {
    const before = makeTrack(corner().points)
    const prev = driverAt(before, 520)
    const snapshot = JSON.stringify(prev)
    rebaseProgress(makeTrack(paintMetres(corner(), 100, 300, 'left')!.points), prev)
    expect(JSON.stringify(prev)).toBe(snapshot)
  })

  it('gives the same position again if it is done again', () => {
    const after = makeTrack(paintMetres(corner(), 100, 300, 'left')!.points)
    const once = rebaseProgress(after, driverAt(makeTrack(corner().points), 520))
    expect(rebaseProgress(after, once)).toEqual(once)
  })

  it('changes nothing about a position on the route it was found on', () => {
    const track = makeTrack(corner().points)
    for (const x of drive(track, { noise: 6, carry: 0.85, seed: 2 })) {
      const next = rebaseProgress(track, x.progress)
      expect({ ...next, idx: 0, t: 0 }).toEqual({ ...x.progress, idx: 0, t: 0 })
      expect(alongPath(track.cum, next.idx, next.t)).toBeCloseTo(x.progress.along, 6)
      expect(haversine(where(track, next.idx, next.t), where(track, x.progress.idx, x.progress.t))).toBeLessThan(0.01)
    }
  })

  describe('at the joint between two stretches', () => {
    // The corner is at 400 m.
    const track = makeTrack(through([0, 0], [0, 400], [300, 400], [300, 800]))
    const at = (xy: [number, number]): Progress => ({ ...startProgress(track, 400), at: spot(xy) })

    it('is on whichever stretch the fix itself is nearer', () => {
      const before = rebaseProgress(track, at([0, 395]))
      expect(before.idx).toBe(0)
      expect(before.t).toBeCloseTo(1, 9)
      const past = rebaseProgress(track, at([5, 400]))
      expect(past.idx).toBe(1)
      expect(past.t).toBeCloseTo(0, 9)
    })

    it('is on the later one when the fix is no nearer either', () => {
      const exact = rebaseProgress(track, at([0, 400]))
      expect([exact.idx, exact.t]).toEqual([1, 0])
      const aside = rebaseProgress(track, at([-30, 400]))
      expect([aside.idx, aside.t]).toEqual([1, 0])
    })

    it('goes by the fix only for a position that is within a few centimetres of the joint', () => {
      const near = (m: number): Progress => ({ ...startProgress(track, m), at: spot([5, 400]) })
      // Just short of the corner, by less than the width of the joint: either stretch, and the fix is on the second.
      expect(rebaseProgress(track, near(399.99)).idx).toBe(1)
      expect(rebaseProgress(track, near(399.99)).t).toBe(0)
      // Further back, it is plainly on the first, whatever the fix says.
      expect(rebaseProgress(track, near(399.9)).idx).toBe(0)
      expect(rebaseProgress(track, near(399.9)).t).toBeCloseTo(0.9998, 3)
      // Just past, the same way round.
      const past = (m: number): Progress => ({ ...startProgress(track, m), at: spot([0, 395]) })
      expect(rebaseProgress(track, past(400.01)).idx).toBe(0)
      expect(rebaseProgress(track, past(400.01)).t).toBe(1)
      expect(rebaseProgress(track, past(400.1)).idx).toBe(1)
    })

    it('does not change which stretch a position is on when the fix is not at a joint', () => {
      // 200 m is half way along the first stretch, and the fix is nearer the second.
      const mid: Progress = { ...startProgress(track, 200), at: spot([250, 800]) }
      expect(rebaseProgress(track, mid).idx).toBe(0)
      expect(rebaseProgress(track, mid).t).toBeCloseTo(0.5, 9)
      // 600 m is a third of the way along the second, and the fix is nearer the first.
      const later: Progress = { ...startProgress(track, 600), at: spot([0, 200]) }
      expect(rebaseProgress(track, later).idx).toBe(1)
      expect(rebaseProgress(track, later).t).toBeCloseTo(2 / 3, 3)
    })

    it('never lands on a stretch with no length', () => {
      const dup = makeTrack(through([0, 0], [0, 100], [0, 100], [0, 200]))
      for (const m of [0, 50, 99.99, 100, 100.01, 150, 200]) {
        const next = rebaseProgress(dup, startProgress(dup, m))
        expect(next.idx, `${m}`).not.toBe(1)
        expect(next.t).toBeGreaterThanOrEqual(0)
        expect(next.t).toBeLessThanOrEqual(1)
        expect(alongPath(dup.cum, next.idx, next.t)).toBeCloseTo(m, 1)
      }
      // Even when the fix is right on the doubled point, which is as near that stretch as any.
      for (const m of [99.99, 100, 100.01]) {
        const next = rebaseProgress(dup, { ...startProgress(dup, m), at: spot([0, 100]) })
        expect(next.idx, `${m}`).not.toBe(1)
      }
    })

    it('is on the stretch after a doubled point when the position is right at it', () => {
      const dup = makeTrack(through([0, 0], [0, 100], [0, 100], [0, 200]))
      const next = rebaseProgress(dup, { ...startProgress(dup, dup.cum[1]), at: spot([0, 100]) })
      expect([next.idx, next.t]).toEqual([2, 0])
    })

    it('copes with a stretch with no length at the very end, being at its start', () => {
      const dup = makeTrack(through([0, 0], [0, 100], [0, 100]))
      const next = rebaseProgress(dup, startProgress(dup, dup.cum[2]))
      expect([next.idx, next.t]).toEqual([1, 0])
      expect(alongPath(dup.cum, next.idx, next.t)).toBeCloseTo(100, 6)
    })
  })

  describe('on a street driven out and back along the very same line', () => {
    const out = (): Route => ({ points: through([0, 0], [0, 300], [0, 0]), sideChanges: [{ idx: 0, side: 'left' }, { idx: 1, side: 'left' }], stops: [] })

    it('is on the pass it was on, whichever pass the points were added to', () => {
      const before = makeTrack(out().points)
      const wayOut = startProgress(before, 120)
      const wayBack = startProgress(before, 480)
      for (const [from, to] of [[50, 90], [200, 280], [350, 420], [500, 560], [20, 580]] as const) {
        const edited = paintMetres(out(), from, to, 'right')!
        const after = makeTrack(edited.points)
        const a = rebaseProgress(after, wayOut)
        const b = rebaseProgress(after, wayBack)
        expect(alongPath(after.cum, a.idx, a.t), `${from}-${to}`).toBeCloseTo(120, 1)
        expect(alongPath(after.cum, b.idx, b.t), `${from}-${to}`).toBeCloseTo(480, 1)
        // The way out heads north and the way back south.
        expect(after.bearings[a.idx], `${from}-${to}`).toBeCloseTo(0, 3)
        expect(after.bearings[b.idx], `${from}-${to}`).toBeCloseTo(180, 3)
      }
    })

    it('is on the pass it was on, with the fix on that pass', () => {
      const before = makeTrack(out().points)
      const prev = driverAt(before, 450)
      expect(prev.along).toBeGreaterThan(400)
      const after = makeTrack(paintMetres(out(), 100, 200, 'right')!.points)
      const next = rebaseProgress(after, prev)
      expect(after.bearings[next.idx]).toBeCloseTo(180, 3)
      expect(alongPath(after.cum, next.idx, next.t)).toBeCloseTo(prev.along, 1)
    })
  })

  describe('wherever the points go', () => {
    it('is always the same distance along and the same place', () => {
      const route = corner()
      const before = makeTrack(route.points)
      let checked = 0
      for (let from = 0; from < 1080; from += 53) {
        for (const length of [15, 70, 333, 900]) {
          const edited = paintMetres(route, from, from + length, 'right')
          if (!edited) continue
          const after = makeTrack(edited.points)
          for (let s = 0; s <= 1100; s += 37) {
            const prev = startProgress(before, s)
            const next = rebaseProgress(after, prev)
            expect(next.idx).toBeGreaterThanOrEqual(0)
            expect(next.idx).toBeLessThan(after.points.length - 1)
            expect(next.t).toBeGreaterThanOrEqual(0)
            expect(next.t).toBeLessThanOrEqual(1)
            expect(Math.abs(alongPath(after.cum, next.idx, next.t) - s), `${from} ${length} ${s}`).toBeLessThan(0.05)
            expect(haversine(where(after, next.idx, next.t), where(before, prev.idx, prev.t)), `${from} ${length} ${s}`).toBeLessThan(0.05)
            checked++
          }
        }
      }
      expect(checked).toBeGreaterThan(500)
    })
  })
})

// ---- A car that does not drive the route: turns round short of its turning point, passes a court, and so on ----

/** A spot `x` metres to the right of, and `y` metres ahead along, a heading of `h` degrees from north: so that a street is not lined up with the axes. */
const framed = (h: number) => ([x, y]: readonly [number, number]): Pt => spot([x * cos(h) + y * Math.sin((h * Math.PI) / 180), -x * Math.sin((h * Math.PI) / 180) + y * cos(h)])

/** Spots no more than `step` metres apart along the polyline through these. */
function dense(step: number, ...xy: [number, number][]): [number, number][] {
  const out: [number, number][] = [xy[0]]
  for (let i = 1; i < xy.length; i++) {
    const n = Math.max(1, Math.ceil(Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]) / step))
    for (let k = 1; k <= n; k++) out.push([xy[i - 1][0] + ((xy[i][0] - xy[i - 1][0]) * k) / n, xy[i - 1][1] + ((xy[i][1] - xy[i - 1][1]) * k) / n])
  }
  return out
}

interface CarOptions {
  /** Metres a second after this many metres of the car's own path. */
  speed?: (s: number) => number
  /** Metres of error on each fix, in both directions, and how much of the last fix's error carries over into the next (0 to 1). */
  noise?: number
  carry?: number
  seed?: number
  /** Whether the phone gives its course (as it does at 1.5 metres a second or more); otherwise only the heading worked out from where it has been. */
  course?: boolean
  /** The chance that a course is wrong by 180 degrees. */
  flip?: number
}

interface CarStep {
  /** Metres the car has gone. */
  s: number
  progress: Progress
  heading: number | null
  /** How fast the car is going, in metres a second. */
  speed: number
}

/**
 * Drive a car along `path` (which is not the route being tracked: it may turn round short of it, or pass a court on the way) and say
 * where the tracker thinks the driver is after each fix. The phone is as a real one is: its error drifts, its course comes with the
 * speed, and the app falls back on the way the phone has been going when it has none.
 */
function driveCar(track: Track, path: Pt[], o: CarOptions = {}): CarStep[] {
  const { noise = 6, carry = 0.6, seed = 1, course = true, flip = 0 } = o
  const car = makeTrack(path)
  const total = car.cum[car.cum.length - 1]
  const r = random(seed)
  const speedAt = o.speed ?? (() => 10)
  let progress = null as Progress | null
  let trail: TrailPoint[] = []
  let err = [0, 0]
  let clock = 0
  let k = 0
  const out: CarStep[] = []
  for (let s = 0; s <= total; ) {
    const v = Math.max(0.2, speedAt(s))
    const { pos, heading: h } = truth(car, s)
    err = err.map((e) => carry * e + Math.sqrt(1 - carry * carry) * gaussian(r) * noise)
    const fix = { lat: pos.lat + north(err[1]), lng: pos.lng + east(err[0]), accuracy: Math.max(5, noise * 1.5), time: clock, speed: v >= 1.5 ? v : 0.3 }
    const reversed = flip > 0 && r() < flip ? 180 : 0
    const given = course && v >= 1.5 && k >= 1 ? (h + reversed + gaussian(r) * 15 + 360) % 360 : null
    const heading = given ?? trailHeading(trail, fix.accuracy)
    const before = progress
    progress = advance(track, progress, fix, heading)
    if (!progress) throw new Error('no progress')
    if (progress !== before) trail = pushTrail(trail, { lat: progress.at.lat, lng: progress.at.lng, time: progress.time ?? clock })
    out.push({ s, progress, heading, speed: v })
    k++
    s += v
    clock += 1000
  }
  return out
}

describe('how far the phone is from the route, wherever the driver is put on it', () => {
  // Out the main street 300 m, a court 60 m deep (120 m of route in and out), and on along the street.
  const court = makeTrack(through([0, 0], [0, 300], [60, 300], [0, 300], [0, 600]))
  const street = through([0, 0], [0, 600])

  it('is the distance to the nearest part of the route, where the tracker holds the junction of a court while the car has driven on past it', () => {
    const at = (xy: [number, number], seconds: number) => ({ ...spot(xy), accuracy: 5, time: seconds * 1000, speed: 10 })
    let p = advance(court, null, at([0, 296], 1), 0)!
    p = advance(court, p, at([0, 300], 2), 0)!
    // 22 m up the street 2 seconds later, on the route all the time. The street beyond the court is 142 m further along the route than the
    // junction, more than a phone that has moved 22 m explains, so the junction is still the cheapest place: but it is 22 m from the phone. (Once
    // it is more than 25 m from it, the street beyond is taken: see 'the junction of a court that the car drives past'.)
    p = advance(court, p, at([0, 322], 4), 0)!
    expect(p.along).toBeCloseTo(300, 0)
    expect(p.doubt).toBeNull()
    expect(p.gap).toBeGreaterThan(20)
    expect(p.offBy).toBeLessThan(2)
    expect(offRouteGap(p)).toBe(p.offBy)
  })

  it('is small for a car driving on past the court, though the gap of the junction the tracker holds climbs', () => {
    for (const seed of [1, 2, 3, 4]) {
      const steps = driveCar(court, street, { noise: 3, carry: 0, seed, speed: () => 5 })
      const held = steps.filter((x) => x.s > 310 && x.s < 335)
      expect(held.length).toBeGreaterThan(3)
      expect(Math.max(...held.map((x) => x.progress.gap)), `seed ${seed}`).toBeGreaterThan(18)
      for (const x of held) expect(x.progress.offBy, `seed ${seed} at ${x.s}`).toBeLessThan(8)
    }
  })

  it('is as far as the phone is from the route when it is too far to say where along it the driver is', () => {
    const far = advance(court, advance(court, null, { ...spot([0, 100]), accuracy: 5, time: 1000, speed: 10 }, 0), { ...spot([300, 450]), accuracy: 5, time: 61_000, speed: 10 }, 0)!
    expect(far.lost).toBe(true)
    expect(far.offBy).toBeGreaterThan(200)
    expect(far.offBy).toBe(far.gap)
  })

  it('is 0 for a position a round is started from, and stays the same when points are added to the route', () => {
    expect(startProgress(court, 250).offBy).toBe(0)
    const driving = advance(court, null, { ...spot([30, 200]), accuracy: 5, time: 1000, speed: 10 }, 0)!
    expect(driving.offBy).toBeGreaterThan(25)
    expect(rebaseProgress(court, driving).offBy).toBe(driving.offBy)
  })

  it('is never more than the distance to the place chosen, and is what the off-route machine is given', () => {
    expect(offRouteGap({ gap: 47, offBy: 2 })).toBe(2)
    expect(offRouteGap({ gap: 3, offBy: 3 })).toBe(3)
    // (Built by hand it could be the other way round: the smaller is taken.)
    expect(offRouteGap({ gap: 3, offBy: 9 })).toBe(3)
    for (const seed of [1, 2, 3]) {
      for (const x of driveCar(court, street, { seed, noise: 12, carry: 0.7 })) expect(x.progress.offBy, `seed ${seed} at ${x.s}`).toBeLessThanOrEqual(x.progress.gap + 1e-9)
    }
  })
})

describe('a car that turns round short of where the route turns', () => {
  type Court = 'a plain end' | 'a bulb of 8 m' | 'a bulb of 12 m' | 'a U-turn drawn as a box'
  const COURTS: Court[] = ['a plain end', 'a bulb of 8 m', 'a bulb of 12 m', 'a U-turn drawn as a box']
  const frame = framed(120)

  /** The street 300 m out, then the end of it as a court is drawn, then the way back down the same line. */
  function routeOf(court: Court): Pt[] {
    const out = dense(20, [0, 0], [0, 300])
    const back = (from: [number, number]) => dense(20, from, [0, 0]).slice(1)
    if (court === 'a plain end') return [...out, ...back([0, 300])].map(frame)
    // (The U-turn that the drawing makes: 6 m on, 5 m across, 8 m back, and the road goes on down the middle.)
    if (court === 'a U-turn drawn as a box') return [...out, ...([[0, 306], [5, 306], [5, 292]] as [number, number][]), ...back([0, 292])].map(frame)
    // A ring round which the route goes clockwise, and out again.
    const radius = court === 'a bulb of 8 m' ? 8 : 12
    const n = Math.max(12, Math.round((2 * Math.PI * radius) / 4))
    const ring = Array.from({ length: n }, (_, k): [number, number] => [radius * Math.cos(-Math.PI / 2 - (2 * Math.PI * (k + 1)) / n), 300 + radius + radius * Math.sin(-Math.PI / 2 - (2 * Math.PI * (k + 1)) / n)])
    return [...out, ...ring, ...back([0, 300])].map(frame)
  }

  /** The car: up the left lane, round in a half ellipse 4 m deep at `turnAt` metres up the street, and back down the other lane. Where the turn is, in metres along its path. */
  function carOf(turnAt: number): { path: Pt[]; mid: number } {
    const lane = 1.8
    const up = dense(5, [-lane, 0], [-lane, turnAt])
    const arc = Array.from({ length: 8 }, (_, k): [number, number] => [-lane * Math.cos((Math.PI * (k + 1)) / 8), turnAt + 4 * Math.sin((Math.PI * (k + 1)) / 8)])
    const path = [...up, ...arc, ...dense(5, [lane, turnAt], [lane, 0]).slice(1)].map(frame)
    return { path, mid: makeTrack(path).cum[up.length - 1] + 8 }
  }

  /** Crawling at 1 m/s for `crawl` metres round the turn, then speeding up by 0.3 m/s for every metre, to `top`. */
  const crawling = (mid: number, crawl: number, top: number) => (s: number) => Math.min(top, 1 + Math.max(0, Math.abs(s - mid) - crawl / 2) * 0.3)

  /** How far past the turn the tracker was last on the way out, in metres, or null if it never was once the car was `beyond` m past the turn. */
  function lagOf(court: Court, early: number, crawl: number, o: { seed: number; noise?: number; top?: number; beyond: number; course?: boolean }): number | null {
    const car = carOf(300 - early)
    const steps = driveCar(makeTrack(routeOf(court)), car.path, { seed: o.seed, noise: o.noise, course: o.course, speed: crawling(car.mid, crawl, o.top ?? 10) })
    // (Still on the way out is a place that is short of where the car turned, 300 - early m along, give or take a fix: the way back is further along than that.)
    const wrong = steps.filter((x) => x.s > car.mid + o.beyond + crawl / 2 && x.progress.along < 300 - early + 2)
    return wrong.length ? wrong[wrong.length - 1].s - car.mid : null
  }

  // The car crawls through a turn (a three-point turn, or a U-turn in a court). The way back is far along the route from the way out: by twice the
  // distance the car turned short of the route's own turning point, and the length of the court, so the tracker does not swing to it of its own accord.
  for (const court of COURTS) {
    it(`is on the way back 25 m after the turn, on ${court}, turned 0 to 45 m short, crawling or not`, { timeout: 30_000 }, () => {
      for (const early of [0, 10, 20, 30, 45]) {
        for (const crawl of [0, 6, 12, 18]) {
          let wrongRuns = 0
          let worst = 0
          for (let seed = 1; seed <= 12; seed++) {
            const lag = lagOf(court, early, crawl, { seed, beyond: 25 })
            if (lag !== null) {
              wrongRuns++
              worst = Math.max(worst, lag)
            }
          }
          // (Every cell, bar one: a bulb of 12 m when the car turns where the street ends, with 12 m of crawl, which in 2 runs in 30 is a fix or two late.)
          const allowed = court === 'a bulb of 12 m' && early === 0 && crawl === 12 ? 2 : 0
          expect(wrongRuns, `${court}, ${early} m short, ${crawl} m crawl: ${worst} m after`).toBeLessThanOrEqual(allowed)
          if (allowed) expect(worst).toBeLessThanOrEqual(36)
        }
      }
    })
  }

  it('is on the way back 70 m after the turn at 3, 6 and 10 metres a second, with GPS error of 4, 9 and 15 metres', { timeout: 30_000 }, () => {
    for (const court of COURTS) {
      for (const early of [20, 30, 45]) {
        for (const noise of [4, 9, 15]) {
          for (const top of [3, 6, 10]) {
            for (let seed = 1; seed <= 3; seed++) {
              const lag = lagOf(court, early, 12, { seed, noise, top, beyond: 70 })
              expect(lag, `${court}, ${early} m short, noise ${noise}, ${top} m/s, seed ${seed}`).toBeNull()
            }
          }
        }
      }
    }
  })

  it('is on the way back within three fixes of the phone giving a course again, however far short of the end of the street the car turned', () => {
    for (const court of ['a plain end', 'a bulb of 8 m'] as Court[]) {
      for (const early of [20, 30, 45]) {
        for (let seed = 1; seed <= 8; seed++) {
          const car = carOf(300 - early)
          const steps = driveCar(makeTrack(routeOf(court)), car.path, { seed, speed: crawling(car.mid, 12, 10) })
          // The phone's course is believed from 3 metres a second, which the car reaches a few metres after the crawl.
          const back = steps.findIndex((x) => x.s > car.mid + 6 && x.speed >= 3)
          expect(back, `${court}, ${early} m short, seed ${seed}`).toBeGreaterThan(0)
          expect(steps[back + 3].progress.along, `${court}, ${early} m short, seed ${seed}`).toBeGreaterThan(300 - early + 2)
        }
      }
    }
  })

  it('is on the way back within 160 m of the turn with no course from the phone, which only the way it has been going tells (it was up to 270 m)', () => {
    for (const court of ['a plain end', 'a bulb of 8 m'] as Court[]) {
      for (const early of [20, 30, 45]) {
        for (const crawl of [0, 12]) {
          for (let seed = 1; seed <= 8; seed++) {
            const lag = lagOf(court, early, crawl, { seed, beyond: 25, course: false })
            expect(lag ?? 0, `${court}, ${early} m short, ${crawl} m crawl, seed ${seed}`).toBeLessThanOrEqual(160)
          }
        }
      }
    }
  })
})

describe('when the driver is on the way out and has turned round', () => {
  // Out 300 m and back along the very same line: the way out heads north, the way back south.
  const track = makeTrack(through([0, 0], [0, 300], [0, 0]))
  type Over = { speed?: number | null; heading?: number | null; accuracy?: number }
  /** The tracker on the way out at 200 m with the car there at 10 m/s, then the car's fixes one a second: `ys` metres north, with this speed and heading each. */
  function fixes(ys: number[], over: Over = {}): Progress[] {
    let p = advance(track, null, { ...spot([0, 190]), accuracy: 5, time: 0, speed: 10 }, 0)!
    p = advance(track, p, { ...spot([0, 200]), accuracy: 5, time: 1000, speed: 10 }, 0)!
    expect(p.along).toBeCloseTo(200, 0)
    const out: Progress[] = []
    for (const [i, y] of ys.entries()) {
      p = advance(track, p, { ...spot([0, y]), accuracy: over.accuracy ?? 8, time: 2000 + i * 1000, speed: over.speed === undefined ? 4 : over.speed }, over.heading === undefined ? 180 : over.heading)!
      out.push(p)
    }
    return out
  }
  const onWayBack = (p: Progress) => p.along > 300

  describe('and the phone says it is heading against the way out', () => {
    it('is put on the way back at the third fix, though the phone has moved less than its accuracy and a fix', () => {
      const [a, b, c] = fixes([195, 190, 185])
      // (4 to 5 m a fix, with a fix claiming 8 m: the old rule wanted more than that.)
      expect([a.backward, b.backward]).toEqual([1, 2])
      expect(a.along).toBeLessThan(300)
      expect(b.along).toBeLessThan(300)
      expect(onWayBack(c)).toBe(true)
      expect(c.along).toBeCloseTo(600 - 185, -1)
      expect(c.backward).toBe(0)
    })

    it('does so for a heading more than 120 degrees against it, and not for one less', () => {
      expect(onWayBack(fixes([197, 194, 191], { heading: 121 })[2])).toBe(true)
      const short = fixes([197, 194, 191], { heading: 119 })
      expect(onWayBack(short[2])).toBe(false)
      expect(short.map((p) => p.backward)).toEqual([0, 0, 0])
    })

    it('does so for a phone going at 3 metres a second or more, and not slower, where the course is not to be relied on', () => {
      // (3 m a fix: not the fall of half the accuracy that the position needs to be going back by itself.)
      expect(onWayBack(fixes([197, 194, 191], { speed: 3 })[2])).toBe(true)
      const slow = fixes([197, 194, 191], { speed: 2.9 })
      expect(onWayBack(slow[2])).toBe(false)
      expect(slow.map((p) => p.backward)).toEqual([0, 0, 0])
    })

    it('does so for a phone that does not say how fast it is going, once it has moved far enough not to be taken for standing still', () => {
      expect(onWayBack(fixes([193, 186, 179], { speed: null })[2])).toBe(true)
    })

    it('does not count a phone that says it has stopped, though its heading is against it', () => {
      const stopped = fixes([197, 194, 191, 188], { speed: 1 })
      expect(stopped.every((p) => p.backward === 0 && !onWayBack(p))).toBe(true)
    })

    it('is not turned round by a heading that is wrong, while the driver goes on along the way out', () => {
      // A course reversed for five fixes in a row, with the car going on north at 10 m a fix: put on 30 m further than three fixes ago.
      const driving = fixes([210, 220, 230, 240, 250], { speed: 10 })
      expect(driving.every((p) => !onWayBack(p))).toBe(true)
      expect(driving.at(-1)!.along).toBeCloseTo(250, 0)
      expect(driving.at(-1)!.backward).toBeGreaterThanOrEqual(3)
    })

    it('moves nothing when the heading is against every stretch there is, as on a street with no way back', () => {
      const oneWay = makeTrack(dense(20, [0, 0], [0, 600]).map(framed(0)))
      let p = advance(oneWay, null, { ...spot([0, 390]), accuracy: 5, time: 0, speed: 10 }, 0)!
      p = advance(oneWay, p, { ...spot([0, 400]), accuracy: 5, time: 1000, speed: 10 }, 0)!
      // The car goes back down the street, 6 m a fix, with its heading (rightly) south: there is no stretch for the driver to be put on that runs that way,
      // though there are places a little further on than where they were (the next point of the street), which they must not be pinned to.
      for (let i = 1; i <= 8; i++) p = advance(oneWay, p, { ...spot([0, 400 - 6 * i]), accuracy: 8, time: 1000 + i * 1000, speed: 6 }, 180)!
      expect(p.backward).toBeGreaterThanOrEqual(3)
      // The driver is where the phone is, not held where they were.
      expect(p.along).toBeCloseTo(352, -1)
    })
  })

  describe('and is not yet sure of it, since a car backing up heads against the way out as well', () => {
    /** The car's next fixes, one a second after `p`'s: `ys` metres north, at 4 m/s, with this heading. */
    const then = (p: Progress, ys: number[], heading: number): Progress[] => {
      const out: Progress[] = []
      for (const y of ys) {
        p = advance(track, p, { ...spot([0, y]), accuracy: 8, time: (p.seen ?? p.time!) + 1000, speed: 4 }, heading)!
        out.push(p)
      }
      return out
    }

    /** Backing up (or going down the way back) 5 m a fix, from 195 m north to 75 m. */
    const backing = () => fixes(Array.from({ length: 25 }, (_, k) => 195 - 5 * k))

    it('keeps the furthest reached where it was until the driver has gone 100 m along the way back, and is sure of it from then on', () => {
      const back = backing()
      // Put on the way back at the third fix, from where the driver was put a fix before.
      expect(back[2].turned).toEqual({ from: back[1].along, to: back[2].along })
      // (The way back starts 300 m along the route: 415 m along it is 185 m north.)
      expect(back[2].along).toBeCloseTo(415, 0)
      // Up to 100 m along the way back (85 m north, give or take the rounding): not sure yet, and the furthest reached held.
      for (const p of back.slice(2, 23)) {
        expect(p.turned, `${p.along}`).not.toBeNull()
        expect(p.furthest, `${p.along}`).toBeLessThan(205)
      }
      expect(back[22].along).toBeCloseTo(515, 0)
      // 105 m along it: sure, and the furthest reached catches up, two fixes behind as ever.
      expect(back[23].along).toBeCloseTo(520, 0)
      expect(back[23].turned).toBeNull()
      expect(back[23].furthest).toBeCloseTo(510, 0)
    })

    it('goes back to the way out when the car drives on along it, against the way back, and keeps the furthest reached where it was', () => {
      // Backed up 15 m at 4 m/s, and on north again.
      const [, , turned] = fixes([195, 190, 185])
      expect(turned.along).toBeGreaterThan(300)
      const on = then(turned, [189, 194, 199, 204, 209, 214], 0)
      // Against the way back for three fixes, as it was against the way out: and back on the way out at the third, near where the car is.
      expect(on.map((p) => p.backward).slice(0, 2)).toEqual([1, 2])
      expect(on[2].along).toBeCloseTo(199, -1)
      expect(on[2].turned).toBeNull()
      for (const p of on.slice(3)) expect(p.along, `${p.along}`).toBeLessThan(300)
      for (const p of [turned, ...on]) expect(p.furthest).toBeLessThan(215)
    })

    it('goes back to the way out after backing up 60 m at 4 m/s, a fix at a time along the way back, and keeps the furthest reached where it was', () => {
      // (Before, 30 m along the way back was sure: the furthest reached went on to it, a kilometre on for a longer street, and with nothing to undo
      // the driver slid on down the way back as the car drove on along the way out.)
      const back = fixes(Array.from({ length: 16 }, (_, k) => 195 - 4 * k))
      expect(back.at(-1)!.along).toBeCloseTo(465, 0)
      expect(back.at(-1)!.turned).not.toBeNull()
      const on = then(back.at(-1)!, Array.from({ length: 12 }, (_, k) => 139 + 4 * k), 0)
      // Back on the way out at the third fix forward, where the car is (147 m north): 60 m short of where it was put from, which the undo allows
      // since the driver went on along the way back after the flip.
      expect(Math.abs(on[2].along - 147)).toBeLessThan(10)
      expect(on[2].turned).toBeNull()
      for (const p of on.slice(3)) expect(p.along, `${p.along}`).toBeLessThan(300)
      for (const p of [...back, ...on]) expect(p.furthest, `${p.along}`).toBeLessThan(205)
    })

    it('does not undo a turn round the driver has gone 100 m along: the heading against every pass then moves nothing, as before', () => {
      const back = backing()
      expect(back.at(-1)!.turned).toBeNull()
      const on = then(back.at(-1)!, [79, 84, 89, 94], 0)
      expect(on.every((p) => p.along > 300)).toBe(true)
    })

    it('knows of no turn round on a fresh start, or after the phone was too far from the route', () => {
      const [, , turned] = fixes([195, 190, 185])
      expect(turned.turned).not.toBeNull()
      const lost = advance(track, turned, { ...spot([400, 185]), accuracy: 8, time: turned.time! + 60_000, speed: 4 }, 0)!
      expect(lost.lost).toBe(true)
      // (185 m from the end of the route, the furthest reached is still held: see below.)
      expect(lost.furthest).toBe(turned.furthest)
      const again = advance(track, lost, { ...spot([0, 186]), accuracy: 8, time: turned.time! + 120_000, speed: 4 }, 0)!
      expect(again.turned).toBeNull()
      expect(startProgress(track, 100).turned).toBeUndefined()
    })

    it('lets the furthest reached go on to where the driver was when they leave the route near its end, on a turn round that could not be sure', () => {
      // The route ends 150 m down the way back of a street 300 m long. Turned round 50 m short of its end and driven back to the end of the route, the
      // driver has gone 85 m along the way back: not sure, and the furthest reached held. Leaving the route there is going home from the end of the
      // round. (Held, the furthest reached never came within 50 m of the end: the round was not taken for over, and leaving it was leaving the route.)
      const ending = makeTrack(through([0, 0], [0, 300], [0, 150]))
      let p: Progress | null = null
      let time = 0
      const go = (xy: [number, number], speed: number, heading: number): Progress => (p = advance(ending, p, { ...spot(xy), accuracy: 8, time: (time += 1000), speed }, heading)!)
      for (let y = 0; y <= 250; y += 10) go([0, y], 10, 0)
      for (const y of [245, 240, 235]) go([0, y], 4, 180)
      let at = go([0, 230], 5, 180)
      expect(at.turned).not.toBeNull()
      for (let y = 225; y >= 150; y -= 5) at = go([0, y], 5, 180)
      expect(at.along).toBeCloseTo(450, 0)
      expect(at.turned).not.toBeNull()
      expect(at.furthest).toBeLessThan(255)
      // Off to the west: still in reach of the route for a while, and held.
      for (let x = -8; x >= -56; x -= 8) at = go([x, 150], 8, 270)
      expect(at.lost).toBe(false)
      expect(at.furthest).toBeLessThan(255)
      // Out of reach: the furthest reached is where the driver left, at the end.
      at = go([-64, 150], 8, 270)
      expect(at.lost).toBe(true)
      expect(at.furthest).toBeCloseTo(450, 0)
    })
  })

  describe('and the phone says how fast it is going, with no heading to go by', () => {
    it('is put on the way back at the third fix, for a phone moving 6 to 7 m a fix with a fix claiming 8 m', () => {
      const [a, b, c] = fixes([193, 186, 179], { heading: null, speed: 6 })
      expect([a.backward, b.backward]).toEqual([1, 2])
      expect(onWayBack(c)).toBe(true)
    })

    it('is not, for a phone that does not say how fast it is going: that has to move further than its accuracy', () => {
      const silent = fixes([193, 186, 179], { heading: null, speed: null })
      expect(silent.map((p) => p.backward)).toEqual([0, 0, 0])
      expect(silent.every((p) => !onWayBack(p))).toBe(true)
      // Further than that it is.
      expect(onWayBack(fixes([188, 176, 164], { heading: null, speed: null })[2])).toBe(true)
    })

    it('is not for a phone going at under 2 m a second', () => {
      expect(fixes([193, 186, 179], { heading: null, speed: 1.9 }).map((p) => p.backward)).toEqual([0, 0, 0])
      expect(fixes([193, 186, 179], { heading: null, speed: 2 }).map((p) => p.backward)).toEqual([1, 2, 0])
    })

    it('needs the position to fall back by half the accuracy at each fix', () => {
      // 3 m back a fix, for a fix claiming 8 m: less than the 4 m wanted.
      expect(fixes([197, 194, 191], { heading: null, speed: 6 }).map((p) => p.backward)).toEqual([0, 0, 0])
    })

    it('is not so when the heading says the phone is going the way the stretch runs: the position is only wandering', () => {
      // The same fixes, with a heading north (the way the way out runs) and without any: only the second is put on the way back.
      const forwards = fixes([193, 186, 179], { heading: 0, speed: 6 })
      expect(forwards.map((p) => p.backward)).toEqual([0, 0, 0])
      expect(forwards.every((p) => !onWayBack(p))).toBe(true)
      expect(onWayBack(fixes([193, 186, 179], { heading: null, speed: 6 })[2])).toBe(true)
    })

    it('is so for a heading a little more than a right angle from the stretch, and not for one at a right angle', () => {
      expect(onWayBack(fixes([193, 186, 179], { heading: 100, speed: 6 })[2])).toBe(true)
      expect(fixes([193, 186, 179], { heading: 90, speed: 6 }).map((p) => p.backward)).toEqual([0, 0, 0])
    })
  })
})

describe('a phone whose course is sometimes wrong', () => {
  // The route as the app draws it, a point every 20 m or so.
  const outAndBack = makeTrack(dense(20, [0, 0], [0, 300], [0, 0]).map(framed(30)))
  const laps = makeTrack(dense(20, [0, 0], [200, 0], [200, 200], [0, 200], [0, 0], [200, 0], [200, 200], [0, 200], [0, 0]).map(framed(30)))

  /** How many fixes, of all those of 25 drives at 4 m/s, put the driver more than 60 m from where they truly are, and the worst error. */
  function farFixes(track: Track, flip: number) {
    let far = 0
    let all = 0
    let worst = 0
    for (let seed = 1; seed <= 25; seed++) {
      for (const x of driveCar(track, track.points, { speed: () => 4, flip, seed })) {
        const error = Math.abs(x.progress.along - x.s)
        all++
        if (error > 60) far++
        worst = Math.max(worst, error)
      }
    }
    return { far, all, worst }
  }

  it('is as well followed as before on a street driven out and back, when 1 course in 20 is the wrong way round', { timeout: 30_000 }, () => {
    const clean = farFixes(outAndBack, 0)
    expect(clean.far).toBe(0)
    const flawed = farFixes(outAndBack, 0.05)
    expect(flawed.all).toBeGreaterThan(3500)
    // (Before the heading counted for going back, 5 of 3775 fixes; a course that is wrong for three fixes in a row is rare, and the position
    // must not be going on along the stretch for it to turn the driver round.)
    expect(flawed.far).toBeLessThanOrEqual(10)
    expect(flawed.worst).toBeLessThan(150)
  })

  it('is no worse followed than before when 1 course in 7 is the wrong way round', { timeout: 30_000 }, () => {
    const flawed = farFixes(outAndBack, 0.15)
    // (Before: 91 of 3775 fixes, up to 596 m out; the stretch driven out and back cannot be told from the heading alone.)
    expect(flawed.far).toBeLessThan(100)
    expect(flawed.worst).toBeLessThan(400)
  })

  it('stays on the lap it is on, a lap of a block driven twice the same way round', { timeout: 30_000 }, () => {
    for (const flip of [0.05, 0.15]) {
      const flawed = farFixes(laps, flip)
      expect(flawed.all).toBeGreaterThan(9000)
      expect(flawed.far, `${flip}`).toBeLessThanOrEqual(5)
    }
  })
})

describe('a phone that moves less than its accuracy a fix', () => {
  // The tracker must not hop to another pass of a route just because the position wanders: not at court speeds with the fix claiming 18 to 22 metres.
  const laps = makeTrack(dense(20, [0, 0], [200, 0], [200, 200], [0, 200], [0, 0], [200, 0], [200, 200], [0, 200], [0, 0]).map(framed(30)))
  const eight = makeTrack(dense(20, [0, 0], [200, 200], [0, 200], [200, 0], [0, 0]).map(framed(30)))
  const carriageways = makeTrack(dense(20, [0, 0], [0, 400], [20, 400], [20, 0], [300, 0]).map(framed(30)))

  it('keeps to the lap, the crossing and the carriageway it is on, at 3 to 5 metres a second, with error of 12 to 15 metres', { timeout: 30_000 }, () => {
    for (const [name, track] of [['two laps', laps], ['a figure of eight', eight], ['two carriageways', carriageways]] as const) {
      let worst = 0
      for (const noise of [12, 15]) {
        for (const speed of [3, 5]) {
          for (let seed = 1; seed <= 8; seed++) {
            for (const x of driveCar(track, track.points, { speed: () => speed, noise, carry: 0.7, seed })) worst = Math.max(worst, Math.abs(x.progress.along - x.s))
          }
        }
      }
      // (Counting a phone as moving on at 2 m a second whatever its heading, the tracker hopped to the next lap: 800 m out.)
      expect(worst, name).toBeLessThan(150)
    }
  })
})

describe('the junction of a court that the car drives past', () => {
  const court = (depth: number) => makeTrack(through([0, 0], [0, 300], [depth, 300], [0, 300], [0, 600]))
  const street = through([0, 0], [0, 600])

  it('is let go of once it has lost touch with the phone: the street beyond it is doubted for two fixes, then believed', () => {
    for (const depth of [100, 150]) {
      for (let seed = 1; seed <= 6; seed++) {
        const steps = driveCar(court(depth), street, { noise: 3, carry: 0, seed, speed: () => 5 })
        const doubted = steps.filter((x) => x.progress.doubt !== null)
        expect(doubted.map((x) => x.progress.doubt!.fixes), `${depth} m deep, seed ${seed}`).toEqual([1, 2])
        // The place doubted is the street beyond the court: the court is in and out again, 2 x depth of route.
        for (const x of doubted) {
          expect(x.progress.doubt!.along).toBeGreaterThan(300 + 2 * depth - 10)
          expect(x.progress.along).toBeLessThan(310)
        }
        // It starts when the junction is 25 m or more behind the phone, and the jump is believed at the third fix, 10 m on: not 60 m on, when the junction is out of reach.
        expect(doubted[0].s - 300, `${depth} m deep, seed ${seed}`).toBeGreaterThan(15)
        expect(doubted[0].s - 300, `${depth} m deep, seed ${seed}`).toBeLessThan(35)
        for (const x of steps.filter((y) => y.s >= 345)) expect(x.progress.along, `${depth} m deep, seed ${seed} at ${x.s}`).toBeGreaterThan(300 + 2 * depth + 40 - 10)
      }
    }
  })

  it('is let go of at once, with no doubt, for a court shallow enough that the jump is not much more than the phone itself explains', () => {
    // 30 and 45 m deep are 60 and 90 m of route in and out. Held by the cost of moving, the junction was let go of only once it was out of reach,
    // 55 to 60 m on, and the houses on the street just beyond the court were jumped over: now the street beyond is taken as soon as the junction has
    // lost touch with the phone, 25 to 30 m on.
    for (const depth of [30, 45]) {
      for (let seed = 1; seed <= 6; seed++) {
        const steps = driveCar(court(depth), street, { noise: 3, carry: 0, seed, speed: () => 5 })
        const label = `${depth} m deep, seed ${seed}`
        expect(steps.every((x) => x.progress.doubt === null), label).toBe(true)
        for (const x of steps.filter((y) => y.s >= 335)) expect(Math.abs(x.progress.along - (x.s + 2 * depth)), `${label} at ${x.s}`).toBeLessThan(25)
      }
    }
  })

  it('is not let go of for a phone that fits no place: on a street 40 m from the route, the junction is held while it is in reach', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const steps = driveCar(court(100), through([-40, 0], [-40, 600]), { noise: 3, carry: 0, seed, speed: () => 5 })
      // (Nothing is within 15 m of the phone, so there is nothing to doubt in the junction's place until the junction is out of reach, 45 m on.)
      expect(steps.filter((x) => x.s < 335 && x.progress.doubt !== null), `seed ${seed}`).toEqual([])
      expect(steps.filter((x) => x.s > 280 && x.s < 335).every((x) => x.progress.offBy > 30), `seed ${seed}`).toBe(true)
    }
  })

  it('is kept while the phone is within reach of it: a car that has gone into the court and is coming out', () => {
    // 100 m deep: in 70 m, round, and out again, up the street. Never doubted on the way, and the way back is where the driver is put.
    const path = through([0, 0], [0, 300], [70, 300], [70, 302], [0, 302], [0, 600])
    for (let seed = 1; seed <= 6; seed++) {
      const steps = driveCar(court(100), path, { noise: 3, carry: 0, seed, speed: () => 5 })
      const back = steps.filter((x) => x.s > 300 + 70 + 25 && x.s < 300 + 70 + 70 - 10)
      expect(back.length).toBeGreaterThan(5)
      for (const x of back) expect(x.progress.along, `seed ${seed} at ${x.s}`).toBeGreaterThan(300 + 100)
    }
  })
})

/** A leg of a car's drive: on to a spot (metres east and north of the start) at so many metres a second, or a stop of so many seconds. */
type Leg = { to: [number, number]; speed: number } | { stop: number }

interface LegStep {
  /** Where the car truly is, which way it is going (null while it is stopped) and how fast. */
  xy: [number, number]
  course: number | null
  speed: number
  progress: Progress
}

/**
 * Drive a car from `from` along `legs`, a fix a second, and say where the tracker thinks the driver is after each. The phone is as a real one is:
 * its error drifts, it says how fast it is going to within about 0.3 m/s (and next to nothing while stopped), and it gives its course only at
 * 1.5 m/s or more, to within about 10 degrees (the course of a car backing up is the way it goes); the app falls back on the way it has been going.
 * With `heading` false there is no heading at all, neither the phone's nor the way it has been going; with `course` false the phone gives no
 * course of its own, and there is only the way it has been going.
 */
function driveLegs(track: Track, from: [number, number], legs: Leg[], o: { noise: number; seed: number; heading?: boolean; course?: boolean }): LegStep[] {
  const r = random(o.seed)
  const truths: { xy: [number, number]; course: number | null; speed: number }[] = [{ xy: from, course: null, speed: 0 }]
  let at = from
  for (const leg of legs) {
    if ('stop' in leg) {
      for (let i = 0; i < leg.stop; i++) truths.push({ xy: at, course: null, speed: 0 })
      continue
    }
    const [dx, dy] = [leg.to[0] - at[0], leg.to[1] - at[1]]
    const n = Math.max(1, Math.round(Math.hypot(dx, dy) / leg.speed))
    const course = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
    for (let i = 1; i <= n; i++) truths.push({ xy: [at[0] + (dx * i) / n, at[1] + (dy * i) / n], course, speed: Math.hypot(dx, dy) / n })
    at = leg.to
  }
  let err = [0, 0]
  let progress: Progress | null = null
  let trail: TrailPoint[] = []
  return truths.map(({ xy, course, speed }, k) => {
    err = err.map((e) => 0.5 * e + Math.sqrt(0.75) * gaussian(r) * o.noise)
    const said = speed > 0 ? Math.max(0, speed + gaussian(r) * 0.3) : Math.abs(gaussian(r) * 0.2)
    const fix = { ...spot([xy[0] + err[0], xy[1] + err[1]]), accuracy: Math.max(5, o.noise * 1.5), time: k * 1000, speed: said }
    const given = course !== null && said >= 1.5 ? (course + gaussian(r) * 10 + 720) % 360 : null
    const before = progress
    progress = advance(track, progress, fix, o.heading === false ? null : ((o.course === false ? null : given) ?? trailHeading(trail, fix.accuracy)))
    if (!progress) throw new Error('no progress')
    if (progress !== before) trail = pushTrail(trail, { lat: progress.at.lat, lng: progress.at.lng, time: progress.time ?? k * 1000 })
    return { xy, course, speed, progress }
  })
}

describe('a car that backs up on the way out, and drives on', () => {
  // The car overshoots a house, backs up to it at a reversing pace, stops, and drives on: its course while it backs up is against the way out, as
  // that of a car that has turned round is. It is put on the way back for a while, which is undone as it drives on along the way out.
  // (Before, it was put on the way back for good: every stop on the rest of the way out was missed, and the furthest reached was a kilometre ahead.
  // Up to 90 m back at a brisk 3 to 4 m/s: reversing on after the flip moves the driver on along the way back, as a real turn round does, and with
  // a turn round sure at 30 m along it, 30 to 90 m back at that pace was still put on the way back for good.)
  const CELLS: [number, number][] = [
    [9, 3], [12, 3], [20, 3], [12, 4], [20, 4], [6, 2], [10, 2], [20, 2], [10, 2.5], [20, 2.5],
    [30, 3], [40, 3], [40, 4], [50, 3], [50, 4], [70, 3], [70, 4], [80, 3], [80, 4], [90, 3], [90, 4], [50, 2.5], [70, 2.5],
  ]
  const COURT_CELLS: [number, number][] = [[10, 3], [20, 3], [30, 3], [10, 4], [20, 4], [10, 2], [20, 2], [30, 2.5], [40, 3], [50, 3], [50, 4], [70, 3], [70, 4], [50, 2.5], [70, 2.5]]

  /**
   * How the drive went once the car drove on: how far out the tracker was at the fix it is to be back on the way out by (`by` fixes after the first
   * going forward: the third, unless said), and at worst after that while the car is `inside` the stretch looked at; and how far the furthest
   * reached ever was beyond the furthest the car had truly got.
   */
  function judge(steps: LegStep[], wayOut: (xy: [number, number]) => number, forward: number, inside: (xy: [number, number]) => boolean, by = 2) {
    // The first fix of the car going forward again, after it backed up.
    const reversed = steps.findIndex((x) => x.course !== null && angleOf(x.course, forward) > 90)
    const on = steps.findIndex((x, k) => k > reversed && x.course === forward)
    const after = steps.slice(on + by).filter((x) => x.course === forward && inside(x.xy))
    let got = 0
    let ahead = -Infinity
    for (const x of steps) {
      got = Math.max(got, wayOut(x.xy))
      ahead = Math.max(ahead, x.progress.furthest - got)
    }
    return { back: Math.abs(steps[on + by].progress.along - wayOut(steps[on + by].xy)), worst: Math.max(...after.map((x) => Math.abs(x.progress.along - wayOut(x.xy)))), ahead }
  }

  /** A street driven out and back, and a court 200 m deep off a street 300 m out: their corners. */
  const STREET: [number, number][] = [[0, 0], [0, 800], [0, 0], [-300, 0]]
  const COURT: [number, number][] = [[0, 0], [0, 300], [200, 300], [0, 300], [0, 600]]
  /** The route through these corners, with a point every `every` metres along it, or none. */
  const drawn = (corners: [number, number][], every = 0) => makeTrack((every ? dense(every, ...corners) : corners).map(spot))
  /** The car on the street: `from` m out (200 unless given), back up `metres`, and on to the end of the way out. */
  const onStreet = (street: Track, metres: number, speed: number, o: { noise: number; seed: number; heading?: boolean }, from = 200) =>
    driveLegs(street, [0, 0], [{ to: [0, from], speed: 8 }, { stop: 3 }, { to: [0, from - metres], speed }, { stop: 2 }, { to: [0, 800], speed: 8 }], o)
  const judgeStreet = (steps: LegStep[], by?: number) => judge(steps, ([, y]) => y, 0, ([, y]) => y < 770, by)
  /** The car in the court: 100 m in, back up `metres`, and on to its end. The way in is 300 m along the route plus how far in the car is. */
  const inCourt = (court: Track, metres: number, speed: number, o: { noise: number; seed: number }, by?: number) =>
    judge(driveLegs(court, [0, 0], [{ to: [0, 300], speed: 8 }, { to: [100, 300], speed: 5 }, { stop: 3 }, { to: [100 - metres, 300], speed }, { stop: 2 }, { to: [200, 300], speed: 5 }], o), ([x, y]) => (x > 0 ? 300 + x : y), 90, ([x]) => x > 0 && x < 190, by)
  const angleOf = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)

  it('is back on the way out of a street driven out and back by the third fix forward, and stays on it, with the furthest reached never past where the car got', { timeout: 30_000 }, () => {
    // (Past by no more than the error of a fix: up to 15 m. Before, the tracker was put 1.2 km on, at the way back, and kept there.)
    const street = drawn(STREET)
    for (const [metres, speed] of CELLS) {
      for (const noise of [3, 5]) {
        for (let seed = 1; seed <= 6; seed++) {
          const j = judgeStreet(onStreet(street, metres, speed, { noise, seed }))
          const label = `${metres} m back at ${speed} m/s, noise ${noise}, seed ${seed}`
          expect(j.back, label).toBeLessThan(25)
          expect(j.worst, label).toBeLessThan(25)
          expect(j.ahead, label).toBeLessThan(15)
        }
      }
    }
  })

  it('does so on a street drawn with a point every 5, 10 or 20 m, as tapped and road-snapped routes are, by the fourth fix forward', { timeout: 60_000 }, () => {
    // (The earliest place on the way back that fits the phone can be the end of a stretch up to 30 m short of where the car is. Counting how far
    // along the way back the driver has gone from there, the next fix jumped that much on, and 80 to 90 m back at 3 to 4 m/s was put on the way
    // back for good in up to 12 drives of 12. Backed up a short way, under 20 m, the tracker can be back on the way out a fix later than on a
    // street with no points along it.)
    for (const every of [5, 10, 20]) {
      const street = drawn(STREET, every)
      for (const [metres, speed] of CELLS) {
        for (const noise of [3, 5]) {
          for (let seed = 1; seed <= 6; seed++) {
            const j = judgeStreet(onStreet(street, metres, speed, { noise, seed }), 3)
            const label = `a point every ${every} m, ${metres} m back at ${speed} m/s, noise ${noise}, seed ${seed}`
            expect(j.back, label).toBeLessThan(25)
            expect(j.worst, label).toBeLessThan(25)
            expect(j.ahead, label).toBeLessThan(15)
          }
        }
      }
    }
  })

  it('does so on a street drawn with a point only every 40 m, wherever along a stretch the car backs up from', { timeout: 60_000 }, () => {
    // (The earliest place on the way back that fits the phone can then be the end of a stretch more than 30 m short of where the car is, and how far
    // along the way back the driver had gone was counted from the best fit no more than 30 m on from it, which was still short of the car: backed up
    // 70 to 90 m from 10 or 20 m along a stretch, the turn round was sure, and the driver was put on the way back for good, over a kilometre on, in
    // 15 of these 1380 drives. Now it is counted from the best fit up to 60 m on, along the way back and not round a turn of the route.)
    const street = drawn(STREET, 40)
    for (const from of [200, 210, 220, 230, 300]) {
      for (const [metres, speed] of CELLS) {
        for (const noise of [3, 5]) {
          for (let seed = 1; seed <= 6; seed++) {
            const j = judgeStreet(onStreet(street, metres, speed, { noise, seed }, from), 3)
            const label = `from ${from} m, ${metres} m back at ${speed} m/s, noise ${noise}, seed ${seed}`
            expect(j.back, label).toBeLessThan(25)
            expect(j.worst, label).toBeLessThan(25)
            expect(j.ahead, label).toBeLessThan(15)
          }
        }
      }
    }
  })

  it('does so in a court, backing up on the way in', { timeout: 30_000 }, () => {
    // The court 200 m deep, off a street 300 m out: the way in is 300 m along the route plus how far in the car is.
    const court = drawn(COURT)
    for (const [metres, speed] of COURT_CELLS) {
      for (const noise of [3, 5]) {
        for (let seed = 1; seed <= 6; seed++) {
          const j = inCourt(court, metres, speed, { noise, seed })
          const label = `${metres} m back at ${speed} m/s, noise ${noise}, seed ${seed}`
          expect(j.back, label).toBeLessThan(25)
          expect(j.worst, label).toBeLessThan(25)
          expect(j.ahead, label).toBeLessThan(15)
        }
      }
    }
  })

  it('does so in a court drawn with a point every 5 or 10 m, by the fourth fix forward', { timeout: 60_000 }, () => {
    for (const every of [5, 10]) {
      const court = drawn(COURT, every)
      for (const [metres, speed] of COURT_CELLS) {
        for (const noise of [3, 5]) {
          for (let seed = 1; seed <= 6; seed++) {
            const j = inCourt(court, metres, speed, { noise, seed }, 3)
            const label = `a point every ${every} m, ${metres} m back at ${speed} m/s, noise ${noise}, seed ${seed}`
            expect(j.back, label).toBeLessThan(25)
            expect(j.worst, label).toBeLessThan(25)
            expect(j.ahead, label).toBeLessThan(15)
          }
        }
      }
    }
  })

  it('is put on the way back only as a turn round not sure yet, near where the route turns round as anywhere else, and is back on the way out as it drives on', { timeout: 60_000 }, () => {
    // Within about 45 m of the end of a street driven out and back, or of the tip of a deep court, the way back level with the car is only 40 to 90 m
    // on along the route, and on the first fix of the car backing up, heading against the way out, it was the cheapest place by cost alone: the
    // driver was put there with no turn round to doubt, as a car that had driven there, and every stop in between was gone by.
    const cases: { name: string; track: Track; legs: (from: number, metres: number, speed: number) => Leg[]; froms: number[]; wayOut: (xy: [number, number]) => number; forward: number; inside: (xy: [number, number]) => boolean }[] = [
      {
        name: 'street',
        track: drawn([[0, 0], [0, 300], [0, 0], [-300, 0]]),
        legs: (from, metres, speed) => [{ to: [0, from], speed: 8 }, { stop: 1 }, { to: [0, from - metres], speed }, { stop: 1 }, { to: [0, 297], speed: 5 }],
        froms: [255, 265, 275],
        wayOut: ([, y]) => y,
        forward: 0,
        inside: ([, y]) => y < 290,
      },
      {
        name: 'court',
        track: drawn(COURT),
        legs: (from, metres, speed) => [{ to: [0, 300], speed: 8 }, { to: [from, 300], speed: 5 }, { stop: 1 }, { to: [from - metres, 300], speed }, { stop: 1 }, { to: [197, 300], speed: 5 }],
        froms: [160, 170],
        wayOut: ([x, y]) => (x > 0 ? 300 + x : y),
        forward: 90,
        inside: ([x]) => x > 0 && x < 190,
      },
    ]
    /** The drives put on the way back with no turn round, and those not back on the way out as they drive on, or with the furthest reached past the car. */
    const unturned: string[] = []
    const bad: string[] = []
    let n = 0
    for (const c of cases) {
      for (const from of c.froms) {
        for (const [metres, speed] of [[6, 3], [12, 4], [20, 4]] as [number, number][]) {
          for (const noise of [3, 5]) {
            for (let seed = 1; seed <= 6; seed++) {
              const steps = driveLegs(c.track, [0, 0], c.legs(from, metres, speed), { noise, seed })
              const label = `${c.name}, from ${from} m, ${metres} m back at ${speed} m/s, noise ${noise}, seed ${seed}`
              n++
              // Wherever the car is put on the way back (beyond where the route turns round), before it gets there, it is as a turn round not sure yet.
              const tip = c.wayOut(c.name === 'street' ? [0, 300] : [200, 300])
              if (steps.some((x) => x.progress.along > tip + 5 && !x.progress.turned)) unturned.push(label)
              const j = judge(steps, c.wayOut, c.forward, c.inside, 3)
              if (!(j.back < 25 && j.worst < 25 && j.ahead < 15)) bad.push(label)
            }
          }
        }
      }
    }
    expect(n).toBe(5 * 3 * 12)
    // Before, 150 of these 180 drives were put there with no turn round, and in 133 the furthest reached went on 50 to 105 m past where the car had
    // got, or the car was not back on the way out by the fourth fix forward. Still so in one court drive, at each pace: the car stood with its fix
    // 16 m on, and the first fix backing up was put 35 m on from there, no further than the phone can have moved by the slack for a fix claiming 7.5 m
    // (see `advance`), which counts as driving there; the furthest reached then follows it 51 to 71 m on.
    const left = ['6 m back at 3 m/s', '12 m back at 4 m/s', '20 m back at 4 m/s'].map((m) => `court, from 170 m, ${m}, noise 5, seed 6`)
    expect(unturned).toEqual(left)
    expect(bad).toEqual(left)
  })

  it('never has the furthest reached a kilometre on for a phone with no course of its own, on a street with points along it', { timeout: 60_000 }, () => {
    // A turn round not sure yet is undone when the driver is put back at or before where it was made from, but only one that moved them on further
    // than the phone can have moved. Going by the way it has been going alone, a phone that backs up and drives on can be left on the way back
    // (as before: up to 6 of 12 drives here), heading against it, and the run of fixes going back then sets turns a metre or two long on that very
    // pass, fix after fix; undoing those let the furthest reached follow the driver, there, a kilometre past where the car was, in 1 to 6 of 12.
    for (const every of [5, 10]) {
      const street = drawn(STREET, every)
      for (const [metres, speed] of [[40, 4], [70, 4], [90, 3], [90, 4]] as [number, number][]) {
        for (const from of [200, 300]) {
          for (const noise of [3, 5]) {
            for (let seed = 1; seed <= 6; seed++) {
              const legs: Leg[] = [{ to: [0, from], speed: 8 }, { stop: 3 }, { to: [0, from - metres], speed }, { stop: 2 }, { to: [0, 800], speed: 8 }, { to: [0, 0], speed: 8 }, { to: [-300, 0], speed: 8 }]
              const steps = driveLegs(street, [0, 0], legs, { noise, seed, course: false })
              // (On the way out, to the end of the street: from there on the way back is driven.)
              let got = 0
              let ahead = -Infinity
              for (const x of steps.slice(0, steps.findIndex((y) => y.xy[1] >= 800))) {
                got = Math.max(got, x.xy[1])
                ahead = Math.max(ahead, x.progress.furthest - got)
              }
              expect(ahead, `a point every ${every} m, ${metres} m back at ${speed} m/s from ${from} m, noise ${noise}, seed ${seed}`).toBeLessThan(15)
            }
          }
        }
      }
    }
  })

  it('is not left unsure of a turn round for the rest of the way out, for a phone with no heading at all on a street with points along it', { timeout: 30_000 }, () => {
    // With no heading, a car backing up is put a few metres on along the way out, which fits as well as the way back: how far along the way back
    // the driver has gone is then counted from there, not from the way back that fits best, a kilometre on, where the turn round would never be sure
    // and every stop on the rest of the way out would be held over it (see turnHold.ts).
    for (const every of [5, 10]) {
      const street = drawn(STREET, every)
      for (const [metres, speed] of [[40, 3], [70, 4], [90, 3], [90, 4]] as [number, number][]) {
        for (const seed of [1, 2, 3]) {
          const steps = onStreet(street, metres, speed, { noise: 3, seed, heading: false })
          const label = `a point every ${every} m, ${metres} m back at ${speed} m/s, seed ${seed}`
          expect(steps.some((x) => x.progress.turned), label).toBe(true)
          for (const x of steps.filter((y) => y.course === 0 && y.xy[1] > 300 && y.xy[1] < 770)) {
            expect(x.progress.turned ?? null, `${label}, ${x.xy[1]} m up`).toBeNull()
            expect(Math.abs(x.progress.along - x.xy[1]), `${label}, ${x.xy[1]} m up`).toBeLessThan(25)
          }
        }
      }
    }
  })
})

describe('a fix dragged sideways for a few seconds toward a stretch beside the street, which the route drives later the same way', () => {
  // North up a street, round, and later north again up a service road `apart` m east of it (with a point every `every` m up the first street, as a
  // route from the road service has, or none). Multipath by trees or buildings drags the fix east toward it for a few seconds, and back.
  const routeOf = (apart: number, every: number) => {
    const first: [number, number][] = every ? Array.from({ length: 600 / every }, (_, k): [number, number] => [0, k * every]) : [[0, 0]]
    return makeTrack(through(...first, [0, 600], [200, 600], [200, -50], [apart, -50], [apart, 600], [apart, 900]))
  }

  /** How far ahead of the car the furthest reached ever is, and how far the driver is put from it at the end, for a drift of `metres` east over `fixes` fixes (ramped up and down over `ramp` more). */
  function drift(o: { apart: number; every: number; metres: number; fixes: number; ramp: number; accuracy: number; speed: number | null; parked: boolean; course: boolean; seed: number }) {
    const track = routeOf(o.apart, o.every)
    const r = random(o.seed)
    const v = 8
    // Moving: up the street at `speed`, the drift starting 240 m up. Parked: up to 300 m at 8 m/s, 40 s there (the drift 10 s in), and on.
    const pace = o.parked ? v : o.speed!
    const total = o.parked ? 90 : Math.floor(560 / pace)
    const start = o.parked ? 300 / v + 10 : Math.ceil(240 / pace)
    let err = [0, 0]
    let p: Progress | null = null
    let trail: TrailPoint[] = []
    let ahead = -Infinity
    let end = 0
    for (let k = 0; k < total; k++) {
      const arrive = 300 / v
      const parked = o.parked && k > arrive && k <= arrive + 40
      const y = !o.parked ? pace * k : k <= arrive ? v * k : parked ? 300 : 300 + v * (k - arrive - 40)
      const i = k - start
      const east = i < 0 ? 0 : i < o.ramp ? (o.metres * (i + 1)) / (o.ramp + 1) : i < o.ramp + o.fixes ? o.metres : i < 2 * o.ramp + o.fixes ? o.metres * (1 - (i - o.ramp - o.fixes + 1) / (o.ramp + 1)) : 0
      err = err.map((e) => 0.5 * e + Math.sqrt(0.75) * gaussian(r) * 3)
      const going = parked ? Math.abs(gaussian(r) * 0.2) : Math.max(0, pace + gaussian(r) * 0.3)
      const fix = { ...spot([east + err[0], y + err[1]]), accuracy: o.accuracy, time: k * 1000, speed: o.parked && o.speed === null ? null : going }
      const course = o.course && going >= 1.5 ? (gaussian(r) * 10 + 720) % 360 : null
      const before: Progress | null = p
      p = advance(track, p, fix, course ?? trailHeading(trail, fix.accuracy))
      if (!p) throw new Error('no progress')
      if (p !== before) trail = pushTrail(trail, { lat: p.at.lat, lng: p.at.lng, time: p.time ?? k * 1000 })
      ahead = Math.max(ahead, p.furthest - y)
      end = Math.abs(p.along - y)
    }
    return { ahead, end }
  }

  it('does not move the driver to that stretch: three fixes 28 m out, toward a service road 35 m away', () => {
    // (Before, the fixes fitted the service road within 15 m, and the place on the street had lost touch with them: the driver was put on the service
    // road, 1.6 km on, and the furthest reached stayed there for the rest of the round.)
    const track = routeOf(35, 0)
    let p: Progress | null = null
    for (let k = 0; k < 60; k++) {
      const east = k >= 30 && k < 33 ? 28 : 0
      p = advance(track, p, { ...spot([east, 8 * k]), accuracy: 10, time: k * 1000, speed: 8 }, 0)!
      expect(p.furthest, `fix ${k}`).toBeLessThan(8 * k + 1)
      expect(p.along, `fix ${k}`).toBeLessThan(8 * k + 20)
    }
    expect(p!.along).toBeCloseTo(8 * 59, -1)
  })

  it('keeps the driver on the street, moving or parked, with or without a course, the drift sudden or ramped, on a route with points or without', { timeout: 30_000 }, () => {
    let drives = 0
    for (const apart of [20, 35, 45]) {
      for (const metres of [28, 38]) {
        for (const fixes of [3, 6]) {
          for (const ramp of [0, 2]) {
            for (const every of [0, 10, 25]) {
              const ways = [
                ...[5, 8, 14].flatMap((speed) => [true, false].map((course) => ({ speed, course, parked: false }))),
                { speed: 0, course: false, parked: true },
                { speed: null, course: false, parked: true },
              ]
              for (const way of ways) {
                const accuracy = [5, 10, 20][drives % 3]
                const seed = 1 + (drives % 4)
                const { ahead, end } = drift({ apart, every, metres, fixes, ramp, accuracy, seed, ...way })
                const label = `${apart} m apart, ${metres} m for ${fixes} fixes (ramp ${ramp}), a point every ${every} m, ${way.parked ? `parked, speed ${way.speed}` : `${way.speed} m/s, course ${way.course}`}, accuracy ${accuracy}`
                expect(ahead, label).toBeLessThan(10)
                expect(end, label).toBeLessThan(20)
                drives++
              }
            }
          }
        }
      }
    }
    expect(drives).toBe(576)
  })
})

describe('a car that misses the turn into a loop the route comes back to the street from', () => {
  // North up the street to a junction 300 m up, right round a block 150 m a side and back down to the junction, then on north: the car goes straight on.
  // Where the loop's last stretch joins the street, 150 m up from the junction, is on the line of the street ahead of the car: it is not where the car is.
  const loop = makeTrack(through([0, 0], [0, 300], [150, 300], [150, 450], [0, 450], [0, 300], [0, 1500]))

  it('is put from the junction onto the street beyond the loop, not on the loop where its last stretch joins the street ahead of the car', () => {
    for (const speed of [6, 8, 10, 12, 14]) {
      for (const accuracy of [5, 9, 14]) {
        let p: Progress | null = null
        let y = 0
        for (let k = 0; k * speed <= 700; k++) {
          y = k * speed
          p = advance(loop, p, { ...spot([0, y]), accuracy, time: k * 1000, speed }, 0)!
          // (The junction is 300 m along the route, and the street beyond the loop is 600 m further along it than the street before it.)
          expect(p.along <= 301 || p.along >= 900, `${speed} m/s, accuracy ${accuracy}, ${y} m up: ${p.along}`).toBe(true)
        }
        expect(p!.along).toBeCloseTo(600 + y, -1)
      }
    }
  })
})

describe('a car that turns round where the route itself turns round close by', () => {
  // North up a road, right into a side street at 300 m, and U-turn here `back` m along it, then out again and on north. The U-turn is drawn as a box
  // that goes on 26 m or more past the corner (see uturnShape.ts), so for a square corner 3.5 to 12 m back the route turns round 32 m along the side
  // street, 5 m across, and its way back ends 6 m along: with Follow roads on the road out is drawn on from the box's first point, straight back down
  // the side street; with it off, a tap at the junction is a straight line to it from the end of the box.
  const routeOf = (back: number, drawnOn: boolean): Track =>
    makeTrack(through([0, 0], [0, 300], [back, 300], [32, 300], ...((drawnOn ? [[6, 300]] : [[32, 295], [6, 295]]) as [number, number][]), [0, 300], [0, 450]))

  /**
   * The car, keeping left: up the road at 8 m/s, into the side street at 3 m/s to `further` m past where the route ended, round in a half ellipse 4 m
   * deep at 1 m/s, out and right, and on up the road. Its way, how fast it goes along it, and how far along it it turns round, in metres.
   */
  function carOf(back: number, further: number): { path: Pt[]; speed: (s: number) => number; mid: number } {
    const end = back + further
    const arc = Array.from({ length: 7 }, (_, k): [number, number] => [end + 4 * Math.sin((Math.PI * (k + 1)) / 8), 300 + 1.8 * Math.cos((Math.PI * (k + 1)) / 8)])
    const into = dense(1, [-1.8, 0], [-1.8, 301.8], [end, 301.8])
    const xy = [...into, ...arc, ...dense(1, [end, 298.2], [-1.8, 298.2], [-1.8, 440])]
    const car = makeTrack(xy.map(spot))
    const [from, to] = [car.cum[into.length - 1], car.cum[into.length + arc.length]]
    const [corner, out] = [car.cum[dense(1, [-1.8, 0], [-1.8, 301.8]).length - 1], to + end + 1.8]
    return { path: xy.map(spot), speed: (s) => (s >= from && s <= to ? 1 : s >= corner - 6 && s <= out + 6 ? 3 : 8), mid: (from + to) / 2 }
  }

  it('is put on the way back as it heads out, after U-turn here a few metres into a side street, and is never left at the corner', { timeout: 30_000 }, () => {
    // The way back level with the car is 45 to 60 m along the route from it, and the cost of that kept the driver on the road before the corner (a fit
    // 40 to 60 degrees out by heading, which never counts as going back), then at the corner itself while the car drove up the road out, until the
    // corner was out of reach, 60 m on: the turn in stayed on the card, and a house on the road out was never come to. (In 4 of these 192 drives;
    // uturnRoute.test.ts has the round's own count, at 90 and 120 degrees.)
    for (const drawnOn of [true, false]) {
      // How far along the route the road out is, past the corner.
      const outAt = drawnOn ? 332 + 32 : 332 + 5 + 26 + Math.hypot(6, 5)
      for (const back of [4, 5, 8, 12]) {
        const track = routeOf(back, drawnOn)
        for (const further of [0, 8]) {
          for (const noise of [3, 5]) {
            for (let seed = 1; seed <= 6; seed++) {
              const car = carOf(back, further)
              const where = makeTrack(car.path)
              const steps = driveCar(track, car.path, { noise, seed, speed: car.speed })
              const label = `${drawnOn ? 'drawn on' : 'straight taps'}, ${back} m back, ${further} m further, noise ${noise}, seed ${seed}`
              for (const x of steps.filter((y) => y.s > car.mid + 25)) {
                const y = (truth(where, x.s).pos.lat - ORIGIN.lat) * M_PER_DEG
                if (y > 305 && y < 430) expect(Math.abs(x.progress.along - (outAt + y - 300)), `${label}, ${y.toFixed(0)} m up`).toBeLessThan(25)
              }
            }
          }
        }
      }
    }
  })

  /** Fixes along these places, `speed` m/s and heading `heading` from each, a second apart, exact, after the driver was put at `start`. */
  function fixes(track: Track, start: Progress | null, legs: { at: [number, number]; speed: number; heading: number }[], t0: number): Progress[] {
    const out: Progress[] = []
    let p = start
    legs.forEach(({ at, speed, heading }, k) => {
      p = advance(track, p, { ...spot(at), accuracy: 5, time: t0 + k * 1000, speed }, heading)!
      out.push(p)
    })
    return out
  }
  /** Up the road to 294 m, a fix every 8 m: the driver is on the road before the corner, as a fix during the crawl round can leave them. */
  const upTheRoad = (track: Track) => fixes(track, null, [...Array.from({ length: 12 }, (_, k) => 200 + 8 * k), 294].map((y) => ({ at: [0, y] as [number, number], speed: 8, heading: 0 })), 0)

  it('is put on the way back by the second fix heading out of the side street, not the first, as a turn round not sure yet, and then on along the road out', () => {
    for (const drawnOn of [true, false]) {
      const track = routeOf(4, drawnOn)
      const outAt = drawnOn ? 332 + 32 : 332 + 5 + 26 + Math.hypot(6, 5)
      const before = upTheRoad(track).at(-1)!
      expect(before.along).toBeCloseTo(294, 0)
      const out = { speed: 3, heading: 270 }
      const [first, second, corner, ...road] = fixes(track, before, [{ at: [4, 298], ...out }, { at: [1, 298], ...out }, { at: [-1.8, 302], speed: 3, heading: 315 }, ...[310, 318, 326, 334].map((y) => ({ at: [-1.8, y] as [number, number], speed: 8, heading: 0 }))], 13_000)
      const label = drawnOn ? 'drawn on' : 'straight taps'
      // (One fix heading out may be a course the wrong way round: see 'a phone whose course is sometimes wrong'.)
      expect(first.along, label).toBeLessThan(300)
      expect(first.folding, label).toBe(1)
      // The place on the way back level with the car, 1 m along the side street: it was 63 m on along the route from where the driver had been put.
      expect(second.along, label).toBeGreaterThan(332 + 25)
      expect(second.along, label).toBeLessThan(outAt)
      expect(second.turned, label).toEqual({ from: first.along, to: second.along })
      expect(second.furthest, label).toBeLessThanOrEqual(before.along)
      for (const [k, p] of [corner, ...road].entries()) expect(Math.abs(p.along - (outAt + [2, 10, 18, 26, 34][k])), `${label}, ${k}`).toBeLessThan(5)
    }
  })

  it('takes the course of a phone going at 1.5 m/s or more for it, as a car slowing to give way at the junction is, and none below that', () => {
    // (Not only from 3 m/s, as for the run of fixes heading against the way in: a car that slowed to 2 m/s at the junction, and went on up the
    // road the way it came, was held at the corner while it drove 30 to 80 m up it. Below 1.5 m/s the phone gives no course: the screen goes by
    // the way it has been going instead, here the way out of the side street, and the fold does not.)
    for (const drawnOn of [true, false]) {
      const track = routeOf(4, drawnOn)
      const outAt = drawnOn ? 332 + 32 : 332 + 5 + 26 + Math.hypot(6, 5)
      for (const speed of [1.5, 2, 2.9, 1.4]) {
        const label = `${drawnOn ? 'drawn on' : 'straight taps'}, ${speed} m/s`
        const out = { speed, heading: 270 }
        if (speed < 1.5) {
          // (Fixes 7 to 8 m apart, as a crawling phone's wander can put them, so that neither is taken for standing still: the fold's own speed is
          // what leaves the driver on the road before the corner.)
          const crawl = fixes(track, upTheRoad(track).at(-1)!, [{ at: [5, 298], ...out }, { at: [-2.5, 298], ...out }], 13_000)
          crawl.forEach((p, k) => {
            expect(p.time, `${label}, ${k}`).toBe(13_000 + 1000 * k)
            expect(p.along, `${label}, ${k}`).toBeLessThan(300)
            expect(p.folding, `${label}, ${k}`).toBe(0)
          })
          continue
        }
        const [first, second, third] = fixes(track, upTheRoad(track).at(-1)!, [{ at: [4.5, 298], ...out }, { at: [2.5, 298], ...out }, { at: [0.5, 298], ...out }], 13_000)
        expect(first.along, label).toBeLessThan(300)
        expect(second.along, label).toBeGreaterThan(332 + 25)
        expect(second.along, label).toBeLessThan(outAt)
        expect(second.turned, label).toEqual({ from: first.along, to: second.along })
        expect(third.along, label).toBeGreaterThanOrEqual(second.along)
      }
    }
  })

  it('is not put on a pass running the other way that is not level with the car: the far side of a block 30 m across, round the end of the street', () => {
    // Up the street, across 30 m at its end and back down the next street: a car that turns round 20 m short of the end of the first heads the way
    // the second runs, which is 50 m on along the route, but 30 m away. It is left to the run of fixes heading against the way out, as ever.
    const track = makeTrack(through([0, 0], [0, 300], [30, 300], [30, 0]))
    const up = fixes(track, null, Array.from({ length: 11 }, (_, k) => ({ at: [0, 200 + 8 * k] as [number, number], speed: 8, heading: 0 })), 0)
    const back = fixes(track, up.at(-1)!, [277, 274].map((y) => ({ at: [0, y] as [number, number], speed: 3, heading: 180 })), 11_000)
    for (const p of back) expect(p.along).toBeLessThan(300)
  })
})

describe('a court just after the route turns round', () => {
  // Down a street to its end and back up it, then a few dozen metres on a court 42 m deep, and on up the street: as routes with many courts drive
  // them. The turn round at the end of the street started a count of fixes heading out along a way back (see `Progress.folding`), and the count
  // went on while any way back was in reach. At the court's junction it was still going, so a fix a few metres past the junction was put on the
  // street after the court, 90 m on, as if the car had turned round short in it: the U-turn card went, and the turn after the court was told instead.
  // 30 m on, the street's own turn round was enough by itself: the road after the court was within the 90 m of route a skip round it can reach, and
  // a driver already past a turn round was skipped round it again from where they were. A count is now of one turn round, and skips only a driver
  // short of it.
  for (const gap of [46, 30]) {
    describe(`${gap} m on`, () => {
      const track = makeTrack(through([0, 200], [0, 0], [0, gap], [42, gap], [0, gap], [0, 200]))
      /** Where the route is at the court's junction on the way in, its tip, and the junction on the way out. */
      const junction = 200 + gap
      const tip = junction + 42
      const out = tip + 42
      type Leg = { at: [number, number]; speed: number; heading: number }
      const play = (legs: Leg[]): Progress[] => {
        let p: Progress | null = null
        return legs.map(({ at, speed, heading }, k) => (p = advance(track, p, { ...spot(at), accuracy: 5, time: k * 1000, speed }, heading)!))
      }
      /** Down the street, round at its end with the route, and back up to 3 m short of the court's junction. */
      const toTheCourt: Leg[] = [
        ...Array.from({ length: 24 }, (_, k): Leg => ({ at: [0, 196 - 8 * k], speed: 8, heading: 180 })),
        { at: [0, 5], speed: 3, heading: 180 },
        { at: [0, 1], speed: 2.5, heading: 0 },
        { at: [0, 4], speed: 2.5, heading: 0 },
        ...Array.from({ length: Math.floor((gap - 13) / 7) + 1 }, (_, k): Leg => ({ at: [0, 10 + 7 * k], speed: 7, heading: 0 })),
        { at: [0, gap - 3], speed: 4.5, heading: 2 },
      ]
      /** A fix 5.6 m past the junction, the car 3 m short of it. */
      const past: Leg = { at: [0.3, gap + 5.6], speed: 4.5, heading: 7 }

      it('is not put past the court by a fix a few metres past its junction', () => {
        const steps = play([...toTheCourt, past])
        const [atJunction, beyond] = steps.slice(-2)
        // The street's count began as the car turned round with the route at its end, and was over once the car was past it.
        expect(steps.some((p) => p.folding === 1 && Math.abs(p.foldAt! - 200) < 5)).toBe(true)
        expect(atJunction.along).toBeCloseTo(junction - 3, 0)
        expect(atJunction.folding ?? 0).toBe(0)
        expect(beyond.along).toBeLessThan(junction + 10)
        expect(beyond.turned ?? null).toBeNull()
        expect(beyond.folding ?? 0).toBe(0)
        // And into the court, along its way in.
        const into = play([...toTheCourt, past, ...[6, 13, 20].map((x): Leg => ({ at: [x, gap + 0.5], speed: 4.5, heading: 90 }))])
        for (const [k, x] of [6, 13, 20].entries()) expect(Math.abs(into[into.length - 3 + k].along - (junction + x)), `${x} m in`).toBeLessThan(5)
      })

      it('counts the court as a turn round of its own, and puts a car that turns round 4 or 12 m into it on the way back', () => {
        for (const depth of [4, 12]) {
          const ins = depth === 4 ? [2, 4] : [2, 7, 12]
          const outs = depth === 4 ? [3, 1] : [11, 8, 3]
          const steps = play([
            ...toTheCourt,
            ...ins.map((x): Leg => ({ at: [x, gap], speed: 4, heading: 90 })),
            ...outs.map((x, k): Leg => ({ at: [x, gap], speed: 2 + k, heading: 270 })),
          ])
          const back = steps.slice(-outs.length)
          // Not the street's count going on: the court begins one of its own, and the fold rule works there as anywhere.
          expect(back[0].folding, `${depth} m in`).toBe(1)
          expect(Math.abs(back[0].foldAt! - tip), `${depth} m in`).toBeLessThan(5)
          const last = back.at(-1)!
          expect(Math.abs(last.along - (out - outs.at(-1)!)), `${depth} m in`).toBeLessThan(5)
          expect(last.turned, `${depth} m in`).not.toBeNull()
        }
      })

      it('stays within 25 m of the car driving the route through the court, with GPS noise', { timeout: 30_000 }, () => {
        for (let seed = 1; seed <= 40; seed++) {
          for (const noise of [3, 4]) {
            const steps = drive(track, { speed: 5, noise, carry: 0.8, seed })
            for (const x of steps.filter((y) => y.s > 150 && y.s < out + 40)) expect(Math.abs(x.progress.along - x.s), `seed ${seed}, noise ${noise}, at ${x.s} m`).toBeLessThan(25)
          }
        }
      })
    })
  }
})

describe('a car that leaves the route and comes back: being near a place is not being on it', () => {
  interface Fix {
    x: number
    y: number
    speed: number
    heading: number
  }
  /** The car's fixes, one a second, along a straight line at about `speed`, landing on `to`. */
  const line = (from: [number, number], to: [number, number], speed: number): Fix[] => {
    const count = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / speed - 1e-9)
    const heading = ((Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI + 360) % 360
    return Array.from({ length: count }, (_, k) => ({ x: from[0] + ((to[0] - from[0]) * (k + 1)) / count, y: from[1] + ((to[1] - from[1]) * (k + 1)) / count, speed, heading }))
  }
  const still = (at: [number, number], seconds: number): Fix[] => Array.from({ length: seconds }, () => ({ x: at[0], y: at[1], speed: 0, heading: 0 }))
  /** Each fix played through the tracker, with a course as a phone gives one (none under 1.5 m/s), and `noise` metres of error that drifts. */
  function play(track: Track, fixes: Fix[], { noise = 0, seed = 1, course = true }: { noise?: number; seed?: number; course?: boolean } = {}): Progress[] {
    const r = random(seed)
    let err = [0, 0]
    let p: Progress | null = null
    const out: Progress[] = []
    fixes.forEach((f, k) => {
      err = err.map((e) => 0.7 * e + Math.sqrt(1 - 0.7 * 0.7) * gaussian(r) * noise)
      p = advance(track, p, { ...spot([f.x + err[0], f.y + err[1]]), accuracy: Math.max(8, noise * 1.5), time: k * 1000, speed: f.speed }, course && f.speed >= 1.5 ? f.heading : null)
      out.push(p!)
    })
    return out
  }

  // East along a street to x = 1500, round, and along the same street again the same way, `apart` m north of the first pass, as a road drawn twice by hand is.
  const twice = (apart: number) => makeTrack(through([0, 0], [1500, 0], [1500, 500], [-200, 500], [-200, apart], [1500, apart], [1500, -600]))
  /** Up the street to x = 900, straight up to a stop `out` m north of it, a while there, back down, and on along the street. */
  const visit = (out: number, speed: number, dwell = 0): Fix[] => [
    ...line([0, 0], [900, 0], 10),
    ...line([900, 0], [900, out], speed),
    ...still([900, out], dwell),
    ...line([900, out], [900, 0], speed),
    ...line([900, 0], [1200, 0], 10),
  ]
  /** That the driver was on the first pass all along, and got where the car did. */
  const stayedOnFirstPass = (steps: Progress[], label: string) => {
    expect(Math.max(...steps.map((p) => p.along)), label).toBeLessThan(1300)
    expect(steps.at(-1)!.furthest, label).toBeLessThan(1300)
    expect(steps.at(-1)!.along, label).toBeGreaterThan(1150)
    expect(steps.at(-1)!.furthest, label).toBeGreaterThan(1150)
    expect(steps.at(-1)!.lost, label).toBe(false)
  }

  it('comes back to the pass it left, not the later one a few metres nearer the stop, at any speed, for any wait', () => {
    // 85 m out and back, 57.4 m from the later pass and 62.1 m from the one it left at the first fix in reach: the later pass was the only place there
    // was. The driver was put 2.9 km on, with the furthest reached gone with them for the round.
    for (const speed of [1, 1.5, 2, 3, 4, 5, 7, 10]) {
      for (const dwell of [0, 30, 120]) {
        for (const short of [5, 20, 30, 35]) stayedOnFirstPass(play(twice(4.7), visit(90 - short, speed, dwell)), `${speed} m/s, ${dwell} s, ${short} m short`)
      }
    }
  })

  it('comes back to the pass it left through the error of real fixes', () => {
    for (let seed = 1; seed <= 12; seed++) {
      for (const speed of [1, 2, 5]) stayedOnFirstPass(play(twice(4.7), visit(85, speed, 30), { noise: 5, seed }), `seed ${seed}, ${speed} m/s`)
    }
  })

  it('is not put on a street it only goes across, on the way to a stop beyond it and on the way back', () => {
    // The later pass is 40 m north: at the stop the phone is out of reach of the pass it left, and 45 m from that one, for as long as it stays.
    for (const speed of [1, 2, 3, 5, 10]) {
      for (const dwell of [0, 30]) stayedOnFirstPass(play(twice(40), visit(85, speed, dwell)), `${speed} m/s, ${dwell} s`)
    }
  })

  it('is not put on a street it only drives beside, the way it runs, too far off to be on it', () => {
    // Up off the street and along a road 50 m north of the later pass: heading its way, in reach of it, and out of reach of the pass it left.
    const steps = play(twice(50), [...line([0, 0], [900, 0], 10), ...line([900, 0], [900, 100], 5), ...line([900, 100], [1100, 100], 10), ...line([1100, 100], [1100, 0], 5), ...line([1100, 0], [1200, 0], 10)])
    stayedOnFirstPass(steps, 'beside the later pass')
    expect(steps.some((p) => p.doubt !== null)).toBe(true)
  })

  it('holds the place it left until then, with no furthest reached on the street it goes across', () => {
    const steps = play(twice(40), visit(85, 3, 30))
    const held = steps.filter((p) => p.doubt !== null)
    expect(held.length).toBeGreaterThan(0)
    for (const p of held) expect(p.along).toBeLessThan(910)
    expect(Math.max(...steps.map((p) => p.furthest))).toBeLessThan(1210)
  })

  // East along a street, north up the end of it, and back west along the next street, 500 m north.
  const uAround = makeTrack(through([0, 0], [1000, 0], [1000, 500], [0, 500]))
  const across = (speed: number): Fix[] => [...line([0, 0], [300, 0], 10), ...line([300, 0], [300, 500], speed)]

  it('believes a cut across to a later street once the phone is driving along it, the way it runs, and not while it comes up to it', () => {
    for (const speed of [3, 10]) {
      const drive = [...across(speed), ...line([300, 500], [200, 500], speed)]
      const steps = play(uAround, drive)
      const reached = across(speed).length
      for (const p of steps.slice(0, reached)) expect(p.along, `${speed} m/s`).toBeLessThan(310)
      const on = steps.findIndex((p) => p.along > 1500)
      // (The corner is the first fix of the run, or a fix before it, and two more make three.)
      expect(on - reached, `${speed} m/s`).toBeLessThan(3)
      expect(steps.at(-1)!.along, `${speed} m/s`).toBeGreaterThan(2000)
      expect(steps.at(-1)!.lost).toBe(false)
    }
  })

  it('believes one down a later street the wrong way only once the phone has gone 100 m along it', () => {
    const steps = play(uAround, [...across(10), ...line([300, 500], [700, 500], 10)])
    const reached = across(10).length
    const on = steps.findIndex((p) => p.along > 1500)
    expect(on).toBeGreaterThan(reached + 8)
    expect(on).toBeLessThan(reached + 13)
    expect(steps.at(-1)!.along).toBeLessThan(1900)
    expect(steps.at(-1)!.along).toBeGreaterThan(1700)
  })

  it('comes back at once where the ground the phone has covered explains how far along the route it is', () => {
    // Off the street 100 m and round a block 300 m long, back onto the street further on: the driver has covered that ground, so there is nothing to doubt.
    const track = makeTrack(through([0, 0], [1000, 0]))
    const steps = play(track, [...line([0, 0], [300, 0], 10), ...line([300, 0], [300, -100], 10), ...line([300, -100], [600, -100], 10), ...line([600, -100], [600, 0], 10)])
    const back = steps.findIndex((p, k) => k > 0 && steps[k - 1].lost && !p.lost)
    expect(steps.slice(0, back).some((p) => p.doubt !== null)).toBe(false)
    expect(steps[back].along).toBeGreaterThan(590)
    expect(steps[back].along).toBeLessThan(610)
  })

  it('puts a car that missed the turn into a loop on the street beyond, not on the way down of the loop that runs against it', () => {
    // Round a block 300 m a side and back down the street to the junction: once the car is a little past the junction the way down is the cheaper place to
    // go, and it can't be driven the way the car is going, so the place doubted is the one that goes with the car. (Held until that had gone by, or 100 m.)
    const track = makeTrack(through([0, 0], [0, 300], [300, 300], [300, 600], [0, 600], [0, 300], [0, 1500]))
    for (let seed = 1; seed <= 12; seed++) {
      const steps = play(track, line([0, 0], [0, 800], 10), { noise: 6, seed })
      const on = steps.findIndex((p) => p.along > 1500)
      expect(steps.filter((p) => p.along > 610 && p.along < 1490), `seed ${seed}`).toEqual([])
      expect(on, `seed ${seed}`).toBeLessThan(40)
    }
  })

  it('takes up a round started part way at once, wherever the phone comes onto the route: there is no place it left to doubt from', () => {
    // At the start of the street coming back, a long way on from the spot started from and right by it on the ground, heading across it.
    const track = makeTrack(through([0, 0], [1000, 0], [1000, 100], [0, 100]))
    const p = advance(track, startProgress(track, 100), { ...spot([100, 140]), accuracy: 8, time: 1000, speed: 10 }, 0)!
    expect(p).toMatchObject({ lost: false, doubt: null })
    expect(p.along).toBeGreaterThan(1990)
  })

  it('holds a car backing up from the junction of a stub at the end of a street out and back: the way back is a turn round not sure yet', () => {
    // Held at the stub's first point, which runs at right angles to the way back, not against it: the turn must still be doubted, and taken back as the car drives on.
    const track = makeTrack(through([0, 0], [0, 840], [120, 840], [0, 840], [0, 0], [500, 0]))
    const up = line([0, 0], [0, 838], 6)
    const steps = play(track, [...up, ...line([0, 838], [0, 798], 3), ...still([0, 798], 3), ...line([0, 798], [0, 835], 6)])
    const backing = steps.slice(up.length)
    const put = backing.filter((p) => p.along > 1000)
    expect(put.length).toBeGreaterThan(0)
    for (const p of put) {
      expect(p.turned?.from).toBeCloseTo(840, 3)
      expect(p.furthest).toBeLessThan(845)
    }
    expect(steps.at(-1)!.along).toBeLessThan(900)
    expect(steps.at(-1)!.turned ?? null).toBeNull()
    expect(steps.at(-1)!.furthest).toBeLessThan(845)
  })

  it('undoes a turn round once it has been put back well short of where the turn put it, not only at or before where it was made from', () => {
    // Thrown far on by a turn not sure yet, and put back a little way past where it was made from: it is on neither, and the turn must not stand until
    // the car has driven all the way to it, with the furthest reached held for all of that.
    const track = makeTrack(through([0, 0], [6000, 0]))
    const driving = play(track, line([0, 0], [500, 0], 10))
    const thrown: Progress = { ...driving.at(-1)!, turned: { from: 400, to: 4400 } }
    const steps: Progress[] = []
    let p = thrown
    for (let k = 1; k <= 30; k++) {
      p = advance(track, p, { ...spot([500 + 10 * k, 0]), accuracy: 8, time: (driving.length + k) * 1000, speed: 10 }, 90)!
      steps.push(p)
    }
    expect(steps[0].turned).toBeNull()
    expect(steps.at(-1)!.along).toBeGreaterThan(780)
    expect(steps.at(-1)!.furthest).toBeGreaterThan(760)
  })

  it('keeps a turn round that is sure to come, with the driver put a little short of where it put them', () => {
    const track = makeTrack(through([0, 0], [6000, 0]))
    const driving = play(track, line([0, 0], [500, 0], 10))
    const turned = { from: 300, to: 550 }
    const p = advance(track, { ...driving.at(-1)!, turned }, { ...spot([505, 0]), accuracy: 8, time: (driving.length + 1) * 1000, speed: 5 }, 90)!
    expect(p.turned).toEqual(turned)
  })

  it('is lost from a place it was at only once it has been on the route: a round that begins away from it has none', () => {
    const track = makeTrack(through([0, 0], [1000, 0]))
    const steps = play(track, line([500, 200], [500, 0], 10))
    expect(steps[0]).toMatchObject({ lost: true, left: false })
    expect(steps.at(-1)!.lost).toBe(false)
    const again = advance(track, steps.at(-1)!, { ...spot([500, 100]), accuracy: 8, time: 100_000, speed: 10 }, 0)
    expect(again).toMatchObject({ lost: true, left: true })
    expect(advance(track, again, { ...spot([500, 110]), accuracy: 8, time: 101_000, speed: 10 }, 0)).toMatchObject({ lost: true, left: true })
    expect(startProgress(track, 200).left).toBeUndefined()
  })
})
