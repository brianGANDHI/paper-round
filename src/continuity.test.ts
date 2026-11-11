import { describe, expect, it } from 'vitest'
import { driveJson, parseDrive, type DriveEntry } from './driveLog'
import { FOLDING_ROUTES, foldingTrack, lineThrough, replayDrive, score, simDrive, simTrack, spot, type SimOptions, type SimScore } from './driveSim'
import { advance, makeTrack, type GpsFix, type Progress } from './progress'

/*
 * Progress along the route stays continuous where the route folds back on itself or drives a street twice: the tracker does not put the driver on
 * another pass of the street. Drives made up as a phone really gives them (see driveSim.ts): a fix a second, GPS error that drifts, a course from the
 * phone only at 1.5 m/s or more, stops and corners.
 *
 * What is measured is the tracker's own doing. GPS error alone can put a fix 50 m or more along a street from the car (at 10 to 15 m of error in each
 * direction, near a corner, a fix 30 m off the street is nearer the next one), and then the right place for the driver is where the fix points, on
 * the pass the car is on: those fixes are counted apart (`explained`), and the tracker is held to being within 50 m of the car at every other fix.
 */

const SPEEDS = [3, 7, 13]
/** GPS error in each direction, and the accuracy the phone claims with it (as the reported tests did: 15 m claimed for 15 m of error). */
const ERRORS: [number, number][] = [
  [5, 8],
  [10, 15],
  [15, 15],
]
const HEADING_NOISE = [6, 12, 20]
const SEEDS = [1, 2, 3]

interface Run {
  route: string
  every: number
  o: SimOptions
  score: SimScore
}

/** Every made-up route, with corners only and with a point every 10 m, at every speed, error, stop-start or not and sharp or round corners. */
function runAll(sigma: number): Run[] {
  const runs: Run[] = []
  for (const route of Object.keys(FOLDING_ROUTES)) {
    for (const every of [0, 10]) {
      const track = foldingTrack(route, every)
      for (const speed of SPEEDS)
        for (const [s, accuracy] of ERRORS.filter(([s]) => s === sigma))
          for (const stop of [false, true])
            for (const round of [0, 10])
              for (const seed of SEEDS) {
                const o: SimOptions = {
                  speed,
                  sigma: s,
                  accuracy,
                  headingNoise: HEADING_NOISE[(seed + speed) % HEADING_NOISE.length],
                  stopEvery: stop ? 30 : undefined,
                  stopFor: 6,
                  round,
                  seed: seed * 7919 + speed * 31 + s * 17 + (stop ? 3 : 0) + round + every * 101,
                }
                runs.push({ route, every, o, score: score(simDrive(track, o)) })
              }
    }
  }
  return runs
}

const label = (r: Run) => `${r.route}${r.every ? ` (a point every ${r.every} m)` : ''}, ${r.o.speed} m/s, error ${r.o.sigma} m, ${r.o.stopEvery ? 'stop-start' : 'steady'}${r.o.round ? ', round corners' : ''}, seed ${r.o.seed}`

describe('progress along a route that folds back on itself stays continuous', () => {
  it('has the routes it is driven on: out and back to a court and a dead end, a block twice, a street twice the same way, streets side by side', () => {
    expect(Object.keys(FOLDING_ROUTES)).toEqual(['a court out and back', 'a dead end out and back', 'a block driven twice', 'a street twice the same way', 'two streets side by side', 'a street back the other way after a loop'])
  })

  for (const sigma of [5, 10]) {
    it(`never puts the driver on another pass, with GPS error of ${sigma} m: within 50 m of the car at every fix but where the fix itself is further`, { timeout: 120_000 }, () => {
      const runs = runAll(sigma)
      expect(runs.length).toBe(6 * 2 * 3 * 2 * 2 * 3)
      for (const r of runs) {
        expect(r.score.spells, label(r)).toEqual([])
        // (Every fix on the route is within 50 m of the car, or where the fix itself points: those are the only ones over.)
        expect(r.score.wrong, label(r)).toBe(r.score.explained)
        // The furthest reached is never 30 m past both the car and where the last three fixes all pointed (it follows them, a fix or two behind).
        expect(r.score.furthestUnexplained, label(r)).toBeLessThan(30)
        if (sigma === 5) {
          expect(r.score.wrong, label(r)).toBe(0)
          expect(r.score.furthestAhead, label(r)).toBeLessThan(50)
        }
      }
    })
  }

  it('slips no more than 100 m, for no more than 5 s, with GPS error of 15 m that the phone claims is 15 m', { timeout: 120_000 }, () => {
    // (Here a fix is often 30 m off the street for several seconds: nearer the street round the next corner, or one beside it. Before the window, in
    // these same 1,296 drives the tracker put the driver on another pass 8 times, once 1,306 m on for 10 s, and once 346 m back for 9 s. Now 4 times,
    // none over 70 m or 4 s: held back at a corner while the fixes said the car was round it, or on for a fix.)
    const runs = runAll(15)
    const spells = runs.flatMap((r) => r.score.spells.map((s) => ({ ...s, run: label(r) })))
    for (const s of spells) {
      expect(Math.abs(s.worst), s.run).toBeLessThan(100)
      expect(s.seconds, s.run).toBeLessThanOrEqual(5)
    }
    expect(spells.length).toBeLessThanOrEqual(4)
    for (const r of runs) expect(r.score.furthestUnexplained, label(r)).toBeLessThan(30)
  })
})

/** A fix at `x` metres east and `y` north of the made-up place, `t` seconds in. */
const at = (xy: [number, number], t: number, o: Partial<GpsFix> = {}): GpsFix => ({ ...spot(xy), accuracy: 8, time: 1_000_000 + t * 1000, speed: 8, ...o })
/** Fixes played through the tracker, each with its heading. */
function play(track: ReturnType<typeof makeTrack>, fixes: [GpsFix, number | null][], start: Progress | null = null): Progress[] {
  const out: Progress[] = []
  let p = start
  for (const [f, h] of fixes) {
    p = advance(track, p, f, h)
    if (!p) throw new Error('no progress')
    out.push(p)
  }
  return out
}
/** Up a street north at 8 m/s, a fix a second, to `to` metres up. */
const upTo = (to: number, x = 0): [GpsFix, number | null][] => Array.from({ length: Math.floor(to / 8) }, (_, k) => [at([x, 8 * (k + 1)], k + 1), 0])

describe('the window of where the driver can have got to', () => {
  // A street north 300 m, across 35 m and back down a street beside it: the two run the other way, 35 m apart, and the place on the second level with
  // a place on the first is 2 x (300 - y) + 35 m on along the route.
  const beside = makeTrack(lineThrough([[0, 0], [0, 300], [35, 300], [35, -200]], 10))

  it('keeps the driver on the street they are on while it is in reach, though fixes nearer the street beside it, heading its way, come for a while', () => {
    const steps = play(beside, [...upTo(200), ...Array.from({ length: 8 }, (_, k): [GpsFix, number | null] => [at([30, 200 + 2 * k], 26 + k, { speed: 2 }), 180])])
    // (The street beside is 235 m on here. The best place on the street the car is on stays within 35 m of the phone, so nothing outside the window is a place.)
    for (const p of steps) expect(p.along).toBeLessThan(260)
    expect(Math.max(...steps.map((p) => p.furthest))).toBeLessThan(260)
  })

  it('takes a place outside it only once nothing in it is on the route, and the place has been seen for 4 fixes over 5 s', () => {
    // Up a street, across 80 m and back down the next: the car cuts across at 100 m up, to a place 480 m on along the route, and drives down it.
    const far = makeTrack(lineThrough([[0, 0], [0, 300], [80, 300], [80, -200]], 10))
    const across: [GpsFix, number | null][] = Array.from({ length: 9 }, (_, k) => [at([8 * (k + 1), 100], 13 + k), 90])
    const down: [GpsFix, number | null][] = Array.from({ length: 8 }, (_, k) => [at([80, 100 - 8 * (k + 1)], 22 + k), 180])
    const onDown = play(far, [...upTo(100), ...across, ...down]).slice(-8)
    // Held at first, the place doubted, then believed at the fifth fix down it, 5 s after it was first seen, as the car came up to the street: the window's
    // best place, back on the street the car left, is 70 m or more off by then. (It was believed at the second.)
    expect(onDown.map((p) => p.along > 400)).toEqual([false, false, false, false, true, true, true, true])
    for (const p of onDown.slice(0, 4)) {
      expect(p.along).toBeLessThan(140)
      expect(p.doubt).not.toBeNull()
    }
  })

  it('moves a poor fix within it, but never out of it, and never the furthest reached on', () => {
    const steps = play(beside, [...upTo(100), ...Array.from({ length: 10 }, (_, k): [GpsFix, number | null] => [at([35, 100 - 8 * (k + 1)], 13 + k, { accuracy: 40 }), 180])])
    for (const p of steps.slice(-10)) {
      expect(p.along).toBeLessThan(200)
      expect(p.furthest).toBeLessThanOrEqual(steps[11].furthest)
    }
    // A poor fix on the street the car is on still moves it.
    const on = play(beside, [...upTo(100), [at([0, 112], 13, { accuracy: 40 }), 0]])
    expect(on.at(-1)!.along).toBeGreaterThan(105)
    expect(on.at(-1)!.furthest).toBe(on.at(-2)!.furthest)
  })

  it('takes no heading from a phone going slower than 1.5 m/s: one worked out from a stop picks no place', () => {
    // A court 30 m deep, in and out along the same line. Stopped 24 m in, the phone's wander gives a heading back out of it, the way the court's way
    // out runs, 12 m on along the route: that pass fits the heading, the way in does not, and both fit the fix. The way in is where the car is.
    const court = makeTrack(lineThrough([[0, 0], [0, 100], [30, 100], [0, 100], [0, 200]], 5))
    const into: [GpsFix, number | null][] = Array.from({ length: 7 }, (_, k) => [at([3 * (k + 1), 100], 14 + k, { speed: 3 }), 90])
    const steps = play(court, [...upTo(96), [at([0, 100], 13, { speed: 3 }), 45], ...into, [at([24, 106.5], 21, { speed: 0.5 }), 270]])
    expect(steps.at(-1)!.along).toBeLessThan(100 + 27)
    // (The same fix with the phone's own course, at 1.5 m/s or more, is believed: the car has turned round.)
    expect(play(court, [...upTo(96), [at([0, 100], 13, { speed: 3 }), 45], ...into, [at([24, 106.5], 21, { speed: 2 }), 270]]).at(-1)!.along).toBeGreaterThan(130)
  })

  it('still turns the driver round onto a way back that passes level with them, but not onto a street 35 m beside the one they are on', () => {
    const outAndBack = makeTrack(lineThrough([[0, 0], [0, 400], [0, -100]], 10))
    // Turned round 250 m up: heading back down the same street, it is put on the way back, 300 m on along the route.
    const turned = play(outAndBack, [...upTo(250), ...Array.from({ length: 8 }, (_, k): [GpsFix, number | null] => [at([0, 250 - 8 * (k + 1)], 32 + k), 180])])
    expect(turned.at(-1)!.along).toBeGreaterThan(400)
    // On the street beside, heading down it, a fix on the street the car is on 35 m away is no turn round: it is held, and doubted.
    const beside2 = play(beside, [...upTo(150), ...Array.from({ length: 4 }, (_, k): [GpsFix, number | null] => [at([0, 150 - 4 * (k + 1)], 19 + k, { speed: 4 }), 180])])
    for (const p of beside2.slice(-4)) expect(p.along).toBeLessThan(200)
  })
})

describe('a drive kept with Record this round, played back', () => {
  it('gives the fixes back from its file, and the tracker makes no jump it has not seen for long enough, with GPS error of 10 m', () => {
    const track = simTrack(lineThrough(FOLDING_ROUTES['a street twice the same way'], 10))
    const steps = simDrive(track, { speed: 5, sigma: 10, accuracy: 15, headingNoise: 12, stopEvery: 30, stopFor: 6, seed: 7 })
    const entries: DriveEntry[] = steps.map((x) => ({ fix: { ...x.fix, speed: x.fix.speed ?? null, time: x.time }, match: null }))
    const file = parseDrive(driveJson({ id: 'x', routeName: 'Made up', startedAt: steps[0].time, route: track.points }, entries))
    expect(file).not.toBeNull()
    expect(file!.fixes.length).toBe(steps.length)
    expect(file!.route.length).toBe(track.points.length)
    const replay = replayDrive(file!)
    expect(replay.steps.length).toBe(steps.length)
    expect(replay.jumps.filter((j) => j.kind === 'other')).toEqual([])
    // Played back, it is where it was when the drive was made up (the fixes are kept to 7 places, a centimetre).
    for (const [k, x] of replay.steps.entries()) expect(Math.abs(x.progress.along - steps[k].progress.along)).toBeLessThan(1)
  })

  it('is not a drive file when it is something else', () => {
    expect(parseDrive('')).toBeNull()
    expect(parseDrive('{"app":"paper-round","kind":"backup"}')).toBeNull()
    expect(parseDrive('{"app":"paper-round","kind":"drive","route":[],"fixes":[{"lat":1}]}')!.fixes).toEqual([])
  })
})
