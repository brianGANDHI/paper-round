import { describe, expect, it } from 'vitest'
import { alongPath, haversine } from './geo'
import { pushTrail, trailHeading, type TrailPoint } from './heading'
import { advance, makeTrack, rebaseProgress, startProgress, type Progress, type Track } from './progress'
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
  it('is quick even for a route of thousands of points', () => {
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

  it('is right with GPS error that drifts, as real error does', () => {
    holds((seed) => ({ seed, noise: 6, carry: 0.85 }), 60)
  })

  it('is right with a good deal more of it', () => {
    holds((seed) => ({ seed, noise: 12, carry: 0.85 }), 80)
  })

  it('is right through stops, where there is no speed and no course and the position drifts', () => {
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

  it('is right when every thirtieth fix is a glitch 90 to 160 m away', () => {
    holds((seed) => ({ seed, noise: 5, carry: 0.85, spike: { every: 30, metres: [90, 160] } }), 60)
  })

  it('is right at 3 metres a second, which has no course from the phone but a heading from where it has been', () => {
    holds((seed) => ({ seed, noise: 6, carry: 0.85, speed: 3 }), 60)
  })

  it('is right at walking pace along a route that does not double back on itself', () => {
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
