import { describe, expect, it } from 'vitest'
import {
  ANCHOR_MAX_FRAC,
  ANCHOR_MIN_FRAC,
  bottomCover,
  counterRotation,
  DOT_CLEARANCE_PX,
  DRIVEN_STEP_M,
  drivenCut,
  drivenShare,
  followZoom,
  HEADING_DEADBAND_DEG,
  HEADING_UP_FRAC,
  headingUpFrac,
  headingUpLayout,
  holdHeading,
  isAhead,
  norm360,
  shortest,
  smoothHeading,
  STREET_ZOOM,
  TOUCH_STALE_MS,
  USER_INPUT_MS,
  userInput,
} from './mapHeading'

/** What share of the way to a new heading the map goes in a gap of `dt` seconds, as the spec gives it. */
const share = (dt: number) => 1 - Math.exp(-dt / 1.2)

describe('keeping a heading within a circle', () => {
  it('leaves 0 up to 360 alone and wraps the rest', () => {
    expect(norm360(0)).toBe(0)
    expect(norm360(359.5)).toBe(359.5)
    expect(norm360(360)).toBe(0)
    expect(norm360(370)).toBe(10)
    expect(norm360(-10)).toBe(350)
    expect(norm360(-370)).toBe(350)
    expect(norm360(725)).toBe(5)
  })

  it('has no negative zero and never reaches 360', () => {
    expect(Object.is(norm360(-0), 0)).toBe(true)
    expect(Object.is(norm360(-360), 0)).toBe(true)
    expect(norm360(-1e-20)).toBeLessThan(360)
    expect(norm360(359.9999999)).toBeLessThan(360)
    for (let d = -1500; d <= 1500; d += 7.3) {
      expect(norm360(d)).toBeGreaterThanOrEqual(0)
      expect(norm360(d)).toBeLessThan(360)
    }
  })

  it('keeps the same direction, whatever the number of turns', () => {
    for (const d of [0, 1, 90.5, 179.9, 180, 270, 359.9]) {
      for (const turns of [-3, -1, 1, 4]) expect(norm360(d + 360 * turns)).toBeCloseTo(d, 6)
    }
  })
})

describe('the short way round between two headings', () => {
  it('is the signed turn, which crosses north the short way', () => {
    expect(shortest(350, 10)).toBe(20)
    expect(shortest(10, 350)).toBe(-20)
    expect(shortest(90, 100)).toBe(10)
    expect(shortest(100, 90)).toBe(-10)
    expect(shortest(123, 123)).toBe(0)
  })

  it('takes the turn straight back as plus 180, not minus', () => {
    expect(shortest(0, 180)).toBe(180)
    expect(shortest(180, 0)).toBe(180)
    expect(shortest(90, 270)).toBe(180)
  })

  it('works on headings that are unwrapped', () => {
    expect(shortest(370, 20)).toBeCloseTo(10)
    expect(shortest(-10, 350)).toBe(0)
    expect(shortest(725, 5)).toBe(0)
  })

  it('is never beyond 180 either way, and never exactly minus 180', () => {
    for (let a = -400; a <= 800; a += 37) {
      for (let b = -400; b <= 800; b += 41) {
        expect(shortest(a, b)).toBeGreaterThan(-180)
        expect(shortest(a, b)).toBeLessThanOrEqual(180)
      }
    }
  })

  it('lands on the second heading when added to the first, and reverses when the two are swapped', () => {
    for (let a = -400; a <= 800; a += 29) {
      for (let b = -400; b <= 800; b += 31) {
        const d = shortest(a, b)
        const miss = Math.abs(shortest(a + d, b))
        expect(miss).toBeLessThan(1e-9)
        if (Math.abs(d) < 179.999) expect(shortest(b, a)).toBeCloseTo(-d, 9)
      }
    }
  })

  it('splits a turn of just under and just over a half circle either side of it', () => {
    expect(shortest(0, 179.9)).toBeCloseTo(179.9, 9)
    expect(shortest(0, 180.1)).toBeCloseTo(-179.9, 9)
    expect(shortest(180.1, 0)).toBeCloseTo(179.9, 9)
  })
})

describe('smoothing the map heading', () => {
  it('is the new heading when there was none before', () => {
    expect(smoothHeading(null, 123, 1)).toBe(123)
  })

  it('holds still for a change smaller than the phone can tell from noise', () => {
    expect(smoothHeading(100, 100 + HEADING_DEADBAND_DEG - 0.1, 1)).toBe(100)
    expect(smoothHeading(100, 100 - HEADING_DEADBAND_DEG + 0.1, 1)).toBe(100)
    expect(smoothHeading(100, 100, 1)).toBe(100)
  })

  it('moves at a change of exactly the dead band', () => {
    expect(smoothHeading(100, 100 + HEADING_DEADBAND_DEG, 1)).toBeGreaterThan(100)
    expect(smoothHeading(100, 100 - HEADING_DEADBAND_DEG, 1)).toBeLessThan(100)
  })

  it('moves at a change just past that', () => {
    expect(smoothHeading(100, 100 + HEADING_DEADBAND_DEG + 0.1, 1)).toBeGreaterThan(100)
    expect(smoothHeading(100, 100 - HEADING_DEADBAND_DEG - 0.1, 1)).toBeLessThan(100)
  })

  it('goes part of the way at a time, and gets there', () => {
    const one = smoothHeading(0, 40, 1)
    expect(one).toBeGreaterThan(0)
    expect(one).toBeLessThan(40)
    let h = 0
    for (let i = 0; i < 12; i++) h = smoothHeading(h, 40, 1)
    expect(Math.abs(h - 40)).toBeLessThanOrEqual(HEADING_DEADBAND_DEG)
  })

  it('goes further when the fixes are further apart', () => {
    expect(smoothHeading(0, 40, 3)).toBeGreaterThan(smoothHeading(0, 40, 0.5))
  })

  it('treats a gap shorter or longer than a fix can be as the limits, and a bad one as a second', () => {
    expect(smoothHeading(0, 40, 0)).toBeCloseTo(smoothHeading(0, 40, 0.2), 9)
    expect(smoothHeading(0, 40, -5)).toBeCloseTo(smoothHeading(0, 40, 0.2), 9)
    expect(smoothHeading(0, 40, 99)).toBeCloseTo(smoothHeading(0, 40, 3), 9)
    expect(smoothHeading(0, 40, NaN)).toBeCloseTo(smoothHeading(0, 40, 1), 9)
  })

  it('takes a gap that is endless as the longest a fix can be, and one that is endlessly back in time as the shortest', () => {
    expect(smoothHeading(0, 40, Infinity)).toBeCloseTo(smoothHeading(0, 40, 3), 9)
    expect(smoothHeading(0, 40, -Infinity)).toBeCloseTo(smoothHeading(0, 40, 0.2), 9)
  })

  it('is moved by exactly the share the spec gives for a gap: 1 - exp(-gap / 1.2) of the way', () => {
    // Worked by hand: 15 percent after 0.2 s, 57 percent after 1 s, 92 percent after 3 s.
    expect(smoothHeading(0, 40, 0.2)).toBeCloseTo(40 * 0.1535183, 5)
    expect(smoothHeading(0, 40, 1)).toBeCloseTo(40 * 0.5654018, 5)
    expect(smoothHeading(0, 40, 3)).toBeCloseTo(40 * 0.917915, 5)
    expect(smoothHeading(100, 120, 1)).toBeCloseTo(100 + 20 * share(1), 9)
    expect(smoothHeading(100, 80, 1)).toBeCloseTo(100 - 20 * share(1), 9)
  })

  it('does not change what a gap does between the limits: 0.19 is 0.2, 0.21 is more, 2.99 is less than 3, 3.01 is 3', () => {
    const at = (dt: number) => smoothHeading(0, 40, dt)
    expect(at(0.19)).toBeCloseTo(at(0.2), 12)
    expect(at(0.21)).toBeGreaterThan(at(0.2))
    expect(at(2.99)).toBeLessThan(at(3))
    expect(at(3.01)).toBeCloseTo(at(3), 12)
    let last = -1
    for (let dt = 0.2; dt <= 3; dt += 0.1) {
      expect(at(dt)).toBeGreaterThanOrEqual(last)
      last = at(dt)
    }
  })

  it('counts a turn of more than 60 degrees as a corner, and one of exactly 60 as an ordinary turn', () => {
    const dt = 0.2
    expect(smoothHeading(0, 60, dt)).toBeCloseTo(60 * share(dt), 9)
    expect(smoothHeading(0, 60.5, dt)).toBeCloseTo(60.5 * 0.8, 9)
    expect(smoothHeading(0, -60, dt)).toBeCloseTo(-60 * share(dt), 9)
    expect(smoothHeading(0, -60.5, dt)).toBeCloseTo(-60.5 * 0.8, 9)
    expect(smoothHeading(300, 0, dt)).toBeCloseTo(300 + 60 * share(dt), 9)
    expect(smoothHeading(299, 0, dt)).toBeCloseTo(299 + 61 * 0.8, 9)
  })

  it('catches up with a corner by 80 percent at least, and by more when the gap is long enough to give more', () => {
    for (const dt of [0.2, 0.5, 1]) expect(smoothHeading(0, 90, dt)).toBeCloseTo(90 * 0.8, 9)
    expect(smoothHeading(0, 90, 3)).toBeCloseTo(90 * share(3), 9)
    expect(smoothHeading(0, 180, 1)).toBeCloseTo(180 * 0.8, 9)
    expect(smoothHeading(0, -120, 0.2)).toBeCloseTo(-120 * 0.8, 9)
  })

  it('holds still for a change under the dead band whichever side of north it is on', () => {
    expect(smoothHeading(359, 1, 1)).toBe(359)
    expect(smoothHeading(1, 359, 1)).toBe(1)
    expect(smoothHeading(725, 6, 1)).toBe(725)
    expect(smoothHeading(-350, 10, 1)).toBe(-350)
    expect(smoothHeading(0, 2.4, 1)).toBe(0)
    expect(smoothHeading(0, 357.6, 1)).toBe(0)
  })

  it('moves at a change of just over the dead band on either side of north', () => {
    expect(smoothHeading(359, 2, 1)).toBeCloseTo(359 + 3 * share(1), 9)
    expect(smoothHeading(2, 359, 1)).toBeCloseTo(2 - 3 * share(1), 9)
    expect(smoothHeading(0, 2.5, 1)).toBeCloseTo(2.5 * share(1), 9)
    expect(smoothHeading(0, 357.5, 1)).toBeCloseTo(-2.5 * share(1), 9)
  })

  it('works from a heading that has gone round more than once', () => {
    // 725 is the same way as 5, and -725 the same as 355, and -710 the same as 10.
    expect(smoothHeading(725, 20, 1)).toBeCloseTo(725 + 15 * share(1), 9)
    expect(smoothHeading(-725, 10, 1)).toBeCloseTo(-725 + 15 * share(1), 9)
    expect(smoothHeading(-710, 350, 1)).toBeCloseTo(-710 - 20 * share(1), 9)
  })

  it('turns a straight about-turn the same way every time, rather than flipping', () => {
    expect(smoothHeading(0, 180, 1)).toBeGreaterThan(0)
    expect(smoothHeading(180, 0, 1)).toBeGreaterThan(180)
    expect(smoothHeading(90, 270, 1)).toBeGreaterThan(90)
  })

  it('goes on climbing across north, from 350 to 10 to 30, instead of falling back', () => {
    let h = 350
    const seen = [h]
    const settle = (target: number) => {
      for (let i = 0; i < 40; i++) {
        const next = smoothHeading(h, target, 1)
        if (next === h) return
        h = next
        seen.push(h)
      }
      throw new Error('never settled')
    }
    settle(10)
    expect(h).toBeGreaterThan(360)
    expect(h).toBeGreaterThan(370 - HEADING_DEADBAND_DEG)
    expect(h).toBeLessThanOrEqual(370)
    settle(30)
    expect(h).toBeGreaterThan(390 - HEADING_DEADBAND_DEG)
    expect(h).toBeLessThanOrEqual(390)
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1])
      expect(seen[i] - seen[i - 1]).toBeLessThanOrEqual(180)
    }
    expect(seen[0]).toBe(350)
  })

  it('goes on falling across north the other way, from 10 to 350 to 330', () => {
    let h = 10
    const seen = [h]
    for (const target of [350, 330]) {
      for (let i = 0; i < 40; i++) {
        const next = smoothHeading(h, target, 1)
        if (next === h) break
        h = next
        seen.push(h)
      }
    }
    expect(h).toBeLessThan(-30 + HEADING_DEADBAND_DEG)
    expect(h).toBeGreaterThanOrEqual(-30)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThan(seen[i - 1])
  })

  it('never overshoots the heading it is going to, and always gets closer', () => {
    for (let prev = -730; prev <= 730; prev += 23) {
      for (let target = 0; target < 360; target += 19) {
        for (const dt of [0.2, 1, 3]) {
          const next = smoothHeading(prev, target, dt)
          const before = shortest(prev, target)
          const after = shortest(next, target)
          if (Math.abs(before) < HEADING_DEADBAND_DEG) {
            expect(next).toBe(prev)
            continue
          }
          expect(Math.abs(after)).toBeLessThan(Math.abs(before))
          // Same side as before, so it never swings past the target.
          expect(Math.sign(after) === Math.sign(before) || Math.abs(after) < 1e-9).toBe(true)
          // The change made is the short way round, so a transition that follows it never spins.
          expect(Math.abs(next - prev)).toBeLessThanOrEqual(180)
          expect(Math.sign(next - prev)).toBe(Math.sign(before))
        }
      }
    }
  })

  it('settles on a steady course and then holds exactly', () => {
    let h = 200
    for (let i = 0; i < 40; i++) h = smoothHeading(h, 20, 1)
    expect(Math.abs(shortest(h, 20))).toBeLessThan(HEADING_DEADBAND_DEG)
    expect(smoothHeading(h, 20, 1)).toBe(h)
    expect(smoothHeading(h, 20, 3)).toBe(h)
  })

  it('does not take a heading from a target that is not a number', () => {
    expect(smoothHeading(100, NaN, 1)).toBe(100)
    expect(smoothHeading(725, Infinity, 1)).toBe(725)
    expect(smoothHeading(-30, -Infinity, 1)).toBe(-30)
  })

  it('starts again from the target when what it had before is not a number', () => {
    expect(smoothHeading(NaN, 90, 1)).toBe(90)
    expect(smoothHeading(Infinity, 90, 1)).toBe(90)
    expect(smoothHeading(-Infinity, 450, 1)).toBe(450)
  })

  it('gives the target as it is, without wrapping it, when there is nothing before', () => {
    expect(smoothHeading(null, 0, 1)).toBe(0)
    expect(smoothHeading(null, 359.99, 0)).toBe(359.99)
    expect(smoothHeading(null, 400, 1)).toBe(400)
    expect(smoothHeading(null, -20, 1)).toBe(-20)
  })

  it('catches up quickly with a corner, even when the fixes are close together', () => {
    const slow = smoothHeading(0, 40, 0.2)
    const corner = smoothHeading(0, 90, 0.2)
    expect(corner / 90).toBeGreaterThan(slow / 40)
    expect(corner).toBeGreaterThanOrEqual(0.8 * 90 - 1e-9)
  })

  it('goes the short way across north without wrapping what it keeps', () => {
    const up = smoothHeading(350, 10, 1)
    expect(up).toBeGreaterThan(350)
    expect(up).toBeLessThan(370)
    const down = smoothHeading(10, 350, 1)
    expect(down).toBeLessThan(10)
    expect(down).toBeGreaterThan(-10)
  })

  it('keeps going the same way past 360, so what follows it never spins backwards', () => {
    let h: number | null = 340
    const seen = [h]
    for (const course of [350, 0, 10, 20, 30, 40]) {
      h = smoothHeading(h, course, 1)
      seen.push(h)
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    expect(seen[seen.length - 1]).toBeGreaterThan(360)
  })

  it('never moves by more than the turn needed, in either direction', () => {
    for (const [from, to] of [[0, 170], [170, 0], [350, 175], [10, 190], [200, 20]] as const) {
      const next = smoothHeading(from, to, 3)
      expect(Math.abs(next - from)).toBeLessThanOrEqual(Math.abs(shortest(from, to)) + 1e-9)
    }
  })

  it('is no more affected by noise around a steady heading than the dead band lets through', () => {
    let h: number | null = null
    const noise = [0, 2, -2, 1, -1, 2, -2, 0, 1, -1]
    for (const n of noise) h = smoothHeading(h, 90 + n, 1)
    expect(h).toBe(90)
  })
})

describe('the heading the map is turned to next', () => {
  it('smooths a course in', () => {
    expect(holdHeading(null, 90, null, 1)).toBe(90)
    expect(holdHeading(80, 90, null, 1)).toBe(smoothHeading(80, 90, 1))
  })

  it('prefers a course to the way the route runs', () => {
    expect(holdHeading(null, 90, 10, 1)).toBe(90)
    expect(holdHeading(80, 200, 10, 1)).toBe(smoothHeading(80, 200, 1))
  })

  it('holds what it has when there is no course, which is what keeps it still at a red light', () => {
    expect(holdHeading(123.4, null, 10, 1)).toBe(123.4)
    expect(holdHeading(450, null, null, 5)).toBe(450)
  })

  it('starts from the way the route runs when it has nothing else', () => {
    expect(holdHeading(null, null, 47, 1)).toBe(47)
  })

  it('has nothing, so the map stays north up, until there is something', () => {
    expect(holdHeading(null, null, null, 1)).toBeNull()
  })

  it('sets aside a course or a route bearing that is not a number', () => {
    expect(holdHeading(null, NaN, null, 1)).toBeNull()
    expect(holdHeading(70, NaN, null, 1)).toBe(70)
    expect(holdHeading(null, null, NaN, 1)).toBeNull()
    expect(holdHeading(null, NaN, 33, 1)).toBe(33)
    expect(holdHeading(null, Infinity, null, 1)).toBeNull()
  })

  it('takes a course of 0 as a course, not as nothing', () => {
    expect(holdHeading(null, 0, 120, 1)).toBe(0)
    expect(holdHeading(350, 0, 120, 1)).toBeCloseTo(350 + 10 * share(1), 9)
    expect(holdHeading(10, 0, 120, 1)).toBeCloseTo(10 - 10 * share(1), 9)
  })

  it('takes a heading held of 0 as a heading, not as nothing, so the route never takes its place', () => {
    expect(holdHeading(0, null, 120, 1)).toBe(0)
  })

  it('takes a route bearing of 0 as a bearing', () => {
    expect(holdHeading(null, null, 0, 1)).toBe(0)
  })

  it('starts from the route bearing exactly as given, without wrapping it', () => {
    expect(holdHeading(null, null, 359.5, 1)).toBe(359.5)
    expect(holdHeading(null, null, 400, 1)).toBe(400)
    expect(holdHeading(null, null, -20, 1)).toBe(-20)
  })

  it('goes on from a route bearing the short way when the first course comes', () => {
    const seed = holdHeading(null, null, 350, 1)
    const next = holdHeading(seed, 20, null, 1) as number
    expect(next).toBeGreaterThan(350)
    expect(next).toBeLessThan(380)
    expect(next).toBeCloseTo(350 + 30 * share(1), 9)
  })

  it('takes every combination of what it has the way the rules give it', () => {
    // [held, course, route] -> what comes out. Course first, then what is held, then the route, then nothing.
    const cases: [number | null, number | null, number | null, number | null][] = [
      [null, null, null, null],
      [null, null, 50, 50],
      [null, 90, null, 90],
      [null, 90, 50, 90],
      [200, null, null, 200],
      [200, null, 50, 200],
      [200, 190, null, smoothHeading(200, 190, 1)],
      [200, 190, 50, smoothHeading(200, 190, 1)],
    ]
    for (const [held, course, route, expected] of cases) expect(holdHeading(held, course, route, 1)).toBe(expected)
  })

  it('leaves a change of less than the dead band alone, so a steady course holds the map still', () => {
    expect(holdHeading(100, 101.5, null, 1)).toBe(100)
    expect(holdHeading(100, 98.5, 300, 1)).toBe(100)
    expect(holdHeading(358, 0, null, 1)).toBe(358)
  })

  it('takes the short way across north, and keeps the value unwrapped', () => {
    const up = holdHeading(350, 10, null, 1)
    expect(up).toBeGreaterThan(350)
    expect(up).toBeLessThan(370)
    const down = holdHeading(10, 350, null, 1)
    expect(down).toBeLessThan(10)
    expect(down).toBeGreaterThan(-10)
  })

  it('passes the gap between fixes on, so a longer gap goes further', () => {
    expect(holdHeading(80, 120, null, 3)).toBeGreaterThan(holdHeading(80, 120, null, 0.5) as number)
    expect(holdHeading(80, 120, null, 0)).toBeCloseTo(smoothHeading(80, 120, 0.2), 12)
    expect(holdHeading(80, 120, null, 99)).toBeCloseTo(smoothHeading(80, 120, 3), 12)
    expect(holdHeading(80, 120, null, NaN)).toBeCloseTo(smoothHeading(80, 120, 1), 12)
  })

  it('does not use the gap when it is only holding or seeding', () => {
    for (const dt of [NaN, -3, 0, 1, 1e9]) {
      expect(holdHeading(77, null, 10, dt)).toBe(77)
      expect(holdHeading(null, null, 10, dt)).toBe(10)
      expect(holdHeading(null, null, null, dt)).toBeNull()
    }
  })

  it('is started again from the course or the route when what it held is not a number', () => {
    expect(holdHeading(NaN, 90, 10, 1)).toBe(90)
    expect(holdHeading(NaN, null, 10, 1)).toBe(10)
    expect(holdHeading(NaN, null, null, 1)).toBeNull()
    expect(holdHeading(Infinity, 90, null, 1)).toBe(90)
  })

  it('treats a missing value, as plain JavaScript might hand it over, as nothing', () => {
    const none = undefined as unknown as null
    expect(holdHeading(none, none, none, 1)).toBeNull()
    expect(holdHeading(80, none, none, 1)).toBe(80)
    expect(holdHeading(none, none, 20, 1)).toBe(20)
    expect(holdHeading(none, 15, 20, 1)).toBe(15)
  })

  it('only ever gives back null or a real number, whatever it is given', () => {
    const held = [null, 0, NaN, 10, 370, -50, Infinity]
    const courses = [null, NaN, 0, 90, 359.9, Infinity, -Infinity]
    const routes = [null, NaN, 0, 200, -Infinity]
    const gaps = [NaN, -1, 0, 1, 10, Infinity]
    const real = (n: number | null) => n !== null && Number.isFinite(n)
    for (const h of held) {
      for (const c of courses) {
        for (const r of routes) {
          for (const dt of gaps) {
            const out = holdHeading(h, c, r, dt)
            if (real(h) || real(c) || real(r)) expect(real(out)).toBe(true)
            else expect(out).toBeNull()
          }
        }
      }
    }
  })

  it('walks through a drive: the way the route runs, still at the lights, a course, a stop, then a turn across north', () => {
    let m = holdHeading(null, null, 350, 1)
    expect(m).toBe(350)
    m = holdHeading(m, null, 350, 1)
    expect(m).toBe(350)
    m = holdHeading(m, null, null, 1)
    expect(m).toBe(350)
    // Driving off, a little east of the route's bearing: the map eases round to it and settles.
    for (let i = 0; i < 30; i++) m = holdHeading(m, 12, 350, 1)
    expect(m as number).toBeGreaterThan(360)
    expect(Math.abs(shortest(m as number, 12))).toBeLessThan(HEADING_DEADBAND_DEG)
    const settled = m
    // Stopped: the phone has no course, and the map stays where it is.
    for (let i = 0; i < 10; i++) m = holdHeading(m, null, 350, 1)
    expect(m).toBe(settled)
    // Round a corner to the left, across north the other way.
    const before = m as number
    for (let i = 0; i < 30; i++) m = holdHeading(m, 280, 350, 1)
    expect(m as number).toBeLessThan(before)
    expect(Math.abs(shortest(m as number, 280))).toBeLessThan(HEADING_DEADBAND_DEG)
  })
})

describe('the layout of a map turned about the driver', () => {
  it('puts the driver 70 percent of the way down, in the middle across', () => {
    const { ax, ay } = headingUpLayout(393, 852)
    expect(ax).toBeCloseTo(196.5)
    expect(ay).toBeCloseTo(596.4)
  })

  it('is a square big enough to cover a 393 by 852 screen at every angle', () => {
    expect(headingUpLayout(393, 852).s).toBe(1256)
    expect(headingUpLayout(393, 740).s).toBe(1110)
  })

  it('covers the screen at every angle for any size', () => {
    for (const [w, h] of [[320, 568], [375, 667], [390, 844], [430, 932], [852, 393], [1024, 768]] as const) {
      for (const frac of [0.5, 0.6, 0.7, 0.8]) {
        const { ax, ay, s } = headingUpLayout(w, h, frac)
        // Every corner of the screen is within half the square's side of the anchor, so none is uncovered whichever way it turns.
        for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) expect(Math.hypot(cx - ax, cy - ay)).toBeLessThanOrEqual(s / 2)
        expect(Number.isInteger(s)).toBe(true)
        expect(s % 2).toBe(0)
      }
    }
  })

  it('moves the anchor with the fraction, and a lower anchor needs a bigger square', () => {
    expect(headingUpLayout(393, 852, 0.5).ay).toBeCloseTo(426)
    expect(headingUpLayout(393, 852, 0.8).s).toBeGreaterThan(headingUpLayout(393, 852, 0.6).s)
  })

  it('takes 70 percent unless told otherwise', () => {
    expect(headingUpLayout(320, 568)).toEqual(headingUpLayout(320, 568, 0.7))
  })

  it('has the driver in the middle across, whatever the width', () => {
    for (const w of [1, 2, 320, 393, 430, 852, 1024]) expect(headingUpLayout(w, 600).ax).toBe(w / 2)
  })

  it('gives the square worked out by hand for the phones in use', () => {
    // [width, height, anchor x, anchor y, square]
    const phones: [number, number, number, number, number][] = [
      [393, 852, 196.5, 596.4, 1256],
      [393, 740, 196.5, 518, 1110],
      [320, 568, 160, 397.6, 858],
      [375, 667, 187.5, 466.9, 1008],
      [430, 932, 215, 652.4, 1374],
    ]
    for (const [w, h, ax, ay, s] of phones) {
      const got = headingUpLayout(w, h)
      expect(got.ax).toBeCloseTo(ax, 6)
      expect(got.ay).toBeCloseTo(ay, 6)
      expect(got.s).toBe(s)
    }
  })

  it('has the driver 70 percent of the way across when the phone is on its side, and a square of its own', () => {
    const { ax, ay, s } = headingUpLayout(852, 393)
    expect(ax).toBe(426)
    expect(ay).toBeCloseTo(275.1, 6)
    expect(s).toBe(1016)
    // On its side the far side is left and right: the longer way, 426 across, decides it, not the 275 down.
    expect(s / 2).toBeGreaterThanOrEqual(Math.hypot(426, 275.1))
    expect(s / 2 - Math.hypot(426, 275.1)).toBeLessThan(1)
  })

  it('is not the same square for a screen and the same screen on its side', () => {
    expect(headingUpLayout(393, 852).s).not.toBe(headingUpLayout(852, 393).s)
  })

  it('works out the extremes of where the driver can be put', () => {
    // At the very top or the very bottom the far corners are a whole screen away: the same square either way.
    expect(headingUpLayout(393, 852, 0)).toMatchObject({ ax: 196.5, ay: 0, s: 1750 })
    expect(headingUpLayout(393, 852, 1)).toMatchObject({ ax: 196.5, ay: 852, s: 1750 })
    // In the middle is the smallest square there can be.
    expect(headingUpLayout(393, 852, 0.5)).toMatchObject({ ax: 196.5, ay: 426, s: 940 })
  })

  it('needs the same square for an anchor the same distance from the top as another is from the bottom', () => {
    expect(headingUpLayout(393, 852, 0.3).s).toBe(headingUpLayout(393, 852, 0.7).s)
    expect(headingUpLayout(393, 852, 0.2).s).toBe(headingUpLayout(393, 852, 0.8).s)
    expect(headingUpLayout(393, 852, 0.1).s).toBe(headingUpLayout(393, 852, 0.9).s)
  })

  it('is the smallest in the middle and grows as the driver goes either way from it', () => {
    let last = headingUpLayout(393, 852, 0.5).s
    for (let frac = 0.55; frac <= 1.0001; frac += 0.05) {
      const s = headingUpLayout(393, 852, frac).s
      expect(s).toBeGreaterThanOrEqual(last)
      last = s
    }
    last = headingUpLayout(393, 852, 0.5).s
    for (let frac = 0.45; frac >= -0.0001; frac -= 0.05) {
      const s = headingUpLayout(393, 852, frac).s
      expect(s).toBeGreaterThanOrEqual(last)
      last = s
    }
  })

  it('still covers the screen with the driver off the screen, up or down', () => {
    for (const frac of [-0.5, -0.01, 1.01, 1.5]) {
      const { ax, ay, s } = headingUpLayout(393, 852, frac)
      expect(ay).toBeCloseTo(852 * frac, 6)
      for (const [cx, cy] of [[0, 0], [393, 0], [0, 852], [393, 852]]) expect(Math.hypot(cx - ax, cy - ay)).toBeLessThanOrEqual(s / 2)
    }
  })

  it('has no square at all for a screen that is not laid out yet, not a bad number', () => {
    expect(headingUpLayout(0, 0)).toEqual({ ax: 0, ay: 0, s: 0 })
    const flat = headingUpLayout(393, 0)
    expect(flat.ax).toBe(196.5)
    expect(flat.ay).toBe(0)
    expect(flat.s).toBe(394)
    const thin = headingUpLayout(0, 852)
    expect(thin.ax).toBe(0)
    expect(thin.s).toBe(1194)
  })

  it('covers the whole screen at every angle it can be turned to, checked by turning it', () => {
    for (const [w, h] of [[393, 852], [393, 740], [320, 568], [852, 393]] as const) {
      const { ax, ay, s } = headingUpLayout(w, h)
      for (let deg = 0; deg < 360; deg += 1) {
        const r = (deg * Math.PI) / 180
        for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) {
          // Where that corner of the screen falls on the square once the square is turned by deg about the driver.
          const x = cx - ax
          const y = cy - ay
          const u = x * Math.cos(r) + y * Math.sin(r)
          const v = -x * Math.sin(r) + y * Math.cos(r)
          expect(Math.abs(u)).toBeLessThanOrEqual(s / 2 + 1e-9)
          expect(Math.abs(v)).toBeLessThanOrEqual(s / 2 + 1e-9)
        }
      }
    }
  })

  it('is the smallest such square, to within a pixel or two', () => {
    for (const [w, h] of [[393, 852], [393, 740], [320, 568], [852, 393], [375, 667], [430, 932], [100, 100]] as const) {
      const { ax, ay, s } = headingUpLayout(w, h)
      const far = Math.max(...[[0, 0], [w, 0], [0, h], [w, h]].map(([cx, cy]) => Math.hypot(cx - ax, cy - ay)))
      // The farthest corner reaches the edge of a square turned to the right angle, so any square with less than that
      // for its half side would leave it bare: this one has no more than a pixel to spare.
      expect(s / 2).toBeGreaterThanOrEqual(far)
      expect(s / 2 - far).toBeLessThan(1)
    }
  })
})

describe('turning a label back', () => {
  it('is the heading, so the label comes out upright, and nothing when there is none', () => {
    expect(counterRotation(35)).toBe(35)
    expect(counterRotation(370)).toBe(370)
    expect(counterRotation(null)).toBe(0)
    expect(counterRotation(0)).toBe(0)
  })

  it('keeps a heading below 0 or past 360 as it is, as the map does, so the label turns the same way', () => {
    expect(counterRotation(-20)).toBe(-20)
    expect(counterRotation(725)).toBe(725)
    expect(counterRotation(359.5)).toBe(359.5)
  })

  it('is no turn at all for a heading that is not a number', () => {
    expect(counterRotation(NaN)).toBe(0)
    expect(counterRotation(Infinity)).toBe(0)
    expect(counterRotation(-Infinity)).toBe(0)
    expect(counterRotation(undefined as unknown as null)).toBe(0)
  })

  it('cancels the turn of the map, so label and map together come to nothing', () => {
    for (const heading of [null, 0, 35, 180, 359, 370, -20]) expect((-(heading ?? 0) + counterRotation(heading)) % 360).toBeCloseTo(0, 9)
  })
})

describe('how much of the map a panel along the bottom covers', () => {
  it('is the pixels of a bar of a set height', () => {
    expect(bottomCover(852, undefined, 90)).toBe(90)
    expect(bottomCover(0, undefined, 56)).toBe(56)
  })

  it('is the share of the height for a sheet that grows with the screen', () => {
    expect(bottomCover(800, 0.16)).toBeCloseTo(128)
    expect(bottomCover(852, 0.45)).toBeCloseTo(383.4)
  })

  it('is whichever covers more when it is given both ways', () => {
    expect(bottomCover(800, 0.1, 200)).toBe(200)
    expect(bottomCover(800, 0.5, 90)).toBe(400)
  })

  it('is nothing when nothing is said', () => {
    expect(bottomCover(852)).toBe(0)
    expect(bottomCover(852, undefined, undefined)).toBe(0)
  })

  it('counts anything that is not a positive number as nothing, and never gives a negative or a NaN', () => {
    for (const bad of [-1, NaN, Infinity, -Infinity]) {
      expect(bottomCover(800, bad)).toBe(0)
      expect(bottomCover(800, undefined, bad)).toBe(0)
      expect(bottomCover(800, bad, bad)).toBe(0)
    }
    // A bad height leaves a pixel bar as it is and a share of nothing as nothing.
    expect(bottomCover(NaN, 0.5, 70)).toBe(70)
    expect(bottomCover(NaN, 0.5)).toBe(0)
    expect(bottomCover(-10, 0.5)).toBe(0)
    // One bad value does not spoil the other.
    expect(bottomCover(800, NaN, 60)).toBe(60)
    expect(bottomCover(800, 0.25, NaN)).toBe(200)
  })

  it('grows with the height for a share and not for a bar', () => {
    expect(bottomCover(1000, 0.2)).toBeGreaterThan(bottomCover(500, 0.2))
    expect(bottomCover(1000, undefined, 60)).toBe(bottomCover(500, undefined, 60))
  })
})

describe('where the driver dot sits above a bar along the bottom', () => {
  /** [width, height, what covers the bottom]: a slim bar of about 56 px, with the safe area on a phone that has one. */
  const phones: [number, number, number][] = [
    [393, 852, 56 + 34],
    [430, 932, 56 + 34],
    [390, 844, 56 + 34],
    [375, 667, 56],
    [320, 568, 56],
    [393, 660, 56],
  ]

  it('is 70 percent of the way down when nothing is known about what covers the bottom, as it was', () => {
    expect(HEADING_UP_FRAC).toBe(0.7)
    expect(headingUpFrac(852, null)).toBe(0.7)
    expect(headingUpFrac(0, 90)).toBe(0.7)
    expect(headingUpFrac(-5, 90)).toBe(0.7)
    expect(headingUpFrac(NaN, 90)).toBe(0.7)
    expect(headingUpFrac(852, NaN)).toBe(0.7)
    expect(headingUpFrac(852, Infinity)).toBe(0.7)
  })

  it('is as low as it can be and still clear the bar by the room the dot needs', () => {
    // 852 - 90 - 72 = 690 pixels down.
    expect(headingUpFrac(852, 90) * 852).toBeCloseTo(690, 6)
    // 667 - 56 - 72 = 539.
    expect(headingUpFrac(667, 56) * 667).toBeCloseTo(539, 6)
    for (const [, h, cover] of phones) {
      const ay = headingUpFrac(h, cover) * h
      expect(h - cover - ay).toBeGreaterThanOrEqual(DOT_CLEARANCE_PX - 1e-9)
    }
  })

  it('leaves the dot clear of its own halo and well clear of the bar on every phone in use', () => {
    for (const [, h, cover] of phones) {
      const ay = headingUpFrac(h, cover) * h
      // The dot has a halo 22 px round it.
      expect(ay + 22).toBeLessThan(h - cover)
    }
  })

  it('is lower than the old 70 percent for a slim bar, so more of the screen is road ahead', () => {
    for (const [, h, cover] of phones) expect(headingUpFrac(h, cover)).toBeGreaterThan(0.7)
  })

  it('goes higher the more is covered', () => {
    let last = Infinity
    for (let cover = 0; cover <= 600; cover += 20) {
      const f = headingUpFrac(852, cover)
      expect(f).toBeLessThanOrEqual(last)
      last = f
    }
    expect(headingUpFrac(852, 200)).toBeLessThan(headingUpFrac(852, 90))
  })

  it('is kept between halfway and the lowest allowed, whatever is covered', () => {
    expect(headingUpFrac(852, 0)).toBe(ANCHOR_MAX_FRAC)
    expect(headingUpFrac(852, 5)).toBe(ANCHOR_MAX_FRAC)
    expect(headingUpFrac(852, 800)).toBe(ANCHOR_MIN_FRAC)
    expect(headingUpFrac(852, 1e6)).toBe(ANCHOR_MIN_FRAC)
    for (const h of [200, 393, 568, 852, 1200]) {
      for (const cover of [-50, 0, 30, 90, 300, 900, 5000]) {
        const f = headingUpFrac(h, cover)
        expect(f).toBeGreaterThanOrEqual(ANCHOR_MIN_FRAC)
        expect(f).toBeLessThanOrEqual(ANCHOR_MAX_FRAC)
      }
    }
  })

  it('treats a negative cover as none', () => {
    expect(headingUpFrac(852, -40)).toBe(headingUpFrac(852, 0))
  })

  it('is sized by what covers the bottom of the map, as a bar or as a share of it', () => {
    // 0.16 of 852 is 136 px, which is more than a bar: the dot goes higher than it does for the bar.
    const asShare = headingUpFrac(852, bottomCover(852, 0.16))
    const asBar = headingUpFrac(852, bottomCover(852, undefined, 90))
    expect(asShare).toBeLessThan(asBar)
    expect(asShare * 852).toBeCloseTo(852 - 0.16 * 852 - DOT_CLEARANCE_PX, 6)
  })

  it('still lays out a square that covers every corner of the screen at any angle', () => {
    for (const [w, h, cover] of phones) {
      const { ax, ay, s } = headingUpLayout(w, h, headingUpFrac(h, cover))
      for (const [cx, cy] of [[0, 0], [w, 0], [0, h], [w, h]]) expect(Math.hypot(cx - ax, cy - ay)).toBeLessThanOrEqual(s / 2)
      expect(ax).toBe(w / 2)
      // As low as the bar allows, but no lower than the highest share a dot is allowed to go to.
      expect(ay).toBeCloseTo(Math.min(h * ANCHOR_MAX_FRAC, h - cover - DOT_CLEARANCE_PX), 6)
    }
    for (const cover of [0, 40, 90, 200, 400, 900]) {
      const { ax, ay, s } = headingUpLayout(393, 852, headingUpFrac(852, cover))
      for (const [cx, cy] of [[0, 0], [393, 0], [0, 852], [393, 852]]) expect(Math.hypot(cx - ax, cy - ay)).toBeLessThanOrEqual(s / 2)
    }
  })
})

describe('the zoom the map follows the driver at', () => {
  it('is street level when following starts afresh and the map is further out', () => {
    expect(STREET_ZOOM).toBe(17)
    expect(followZoom(16, true)).toBe(17)
    expect(followZoom(13, true)).toBe(17)
    expect(followZoom(4.5, true)).toBe(17)
  })

  it('does not take a closer zoom from the driver even when following starts afresh', () => {
    expect(followZoom(17, true)).toBe(17)
    expect(followZoom(18, true)).toBe(18)
    expect(followZoom(19, true)).toBe(19)
  })

  it('never changes the zoom for a fix after that, whether the driver zoomed in or out', () => {
    for (const zoom of [3, 12, 14, 15.5, 16, 17, 18, 19]) expect(followZoom(zoom, false)).toBe(zoom)
  })

  it('keeps the driver zoom through a run of fixes (the bug was that zooming out came straight back to 17)', () => {
    let street = true
    let zoom = 16
    const fix = () => {
      zoom = followZoom(zoom, street)
      street = false
    }
    fix()
    expect(zoom).toBe(17)
    // The driver zooms out to see where to turn.
    zoom = 14
    for (let i = 0; i < 30; i++) fix()
    expect(zoom).toBe(14)
    // And in, further than street level.
    zoom = 19
    fix()
    expect(zoom).toBe(19)
  })

  it('goes back to street level after the view of the whole route, and only then', () => {
    let street = true
    let zoom = 16
    const fix = () => {
      zoom = followZoom(zoom, street)
      street = false
    }
    fix()
    zoom = 15
    fix()
    expect(zoom).toBe(15)
    // The whole route is fitted (that is our zoom, so the next follow brings it back in).
    zoom = 13
    street = true
    fix()
    expect(zoom).toBe(17)
    zoom = 15
    fix()
    expect(zoom).toBe(15)
  })
})

describe('telling the driver moves of the map from the app own', () => {
  it('is not the driver with no input at all, even at time zero', () => {
    const input = userInput()
    expect(input.active(0)).toBe(false)
    expect(input.active(1e9)).toBe(false)
    expect(input.touching(0)).toBe(false)
  })

  it('is the driver while a finger is down, however still it is held', () => {
    const input = userInput()
    input.touch(1, 1000)
    expect(input.active(1000)).toBe(true)
    expect(input.active(1000 + USER_INPUT_MS + 1)).toBe(true)
    expect(input.active(1000 + TOUCH_STALE_MS - 1)).toBe(true)
  })

  it('stays the driver for a moment after the finger lifts (the zoom snaps after the fingers are up), and then it is not', () => {
    const input = userInput()
    input.touch(1, 0)
    input.touch(0, 100)
    expect(input.active(100)).toBe(true)
    expect(input.active(100 + USER_INPUT_MS - 1)).toBe(true)
    expect(input.active(100 + USER_INPUT_MS)).toBe(false)
    expect(input.active(5000)).toBe(false)
  })

  it('is a touch that has ended when its end was missed, once it has said nothing for a while', () => {
    const input = userInput()
    input.touch(2, 0)
    expect(input.touching(TOUCH_STALE_MS - 1)).toBe(true)
    expect(input.touching(TOUCH_STALE_MS)).toBe(false)
    expect(input.active(TOUCH_STALE_MS)).toBe(false)
  })

  it('is kept alive by a finger that is moving', () => {
    const input = userInput()
    input.touch(2, 0)
    input.touch(2, 4000)
    expect(input.touching(8000)).toBe(true)
    expect(input.active(8000)).toBe(true)
    input.touch(0, 8500)
    expect(input.touching(8500)).toBe(false)
  })

  it('has a finger touching with one finger or more, and not with none', () => {
    const input = userInput()
    expect(input.touching(0)).toBe(false)
    input.touch(1, 0)
    expect(input.touching(10)).toBe(true)
    input.touch(2, 20)
    expect(input.touching(30)).toBe(true)
    input.touch(1, 60)
    expect(input.touching(70)).toBe(true)
    // Lifted: the driver for a moment more, but nothing is touching.
    input.touch(0, 80)
    expect(input.touching(90)).toBe(false)
    expect(input.active(90)).toBe(true)
  })

  it('counts a wheel turn or a key as the driver for a moment, but not as a finger on the map', () => {
    const input = userInput()
    input.input(1000)
    expect(input.active(1000)).toBe(true)
    expect(input.active(1000 + USER_INPUT_MS - 1)).toBe(true)
    expect(input.active(1000 + USER_INPUT_MS)).toBe(false)
    expect(input.touching(1000)).toBe(false)
  })

  it('does not let a wheel turn end a finger that is still down', () => {
    const input = userInput()
    input.touch(2, 0)
    input.input(100)
    expect(input.touching(200)).toBe(true)
  })

  it('takes the fingers on the screen as a count: fractions round down, and nonsense means none', () => {
    const input = userInput()
    input.touch(2.9, 0)
    expect(input.touching(1)).toBe(true)
    input.touch(0.9, 2)
    expect(input.touching(3)).toBe(false)
    input.touch(NaN, 4)
    expect(input.touching(5)).toBe(false)
    input.touch(-3, 6)
    expect(input.touching(7)).toBe(false)
    input.touch(Infinity, 8)
    expect(input.touching(9)).toBe(false)
  })

  it('keeps one record for each map', () => {
    const a = userInput()
    const b = userInput()
    a.touch(2, 0)
    expect(a.touching(1)).toBe(true)
    expect(b.touching(1)).toBe(false)
    expect(b.active(1)).toBe(false)
  })

  it('does not take a zoom of the app own as the driver when their last touch was a while ago', () => {
    // The first follow zooms in to street level some time after the driver last touched the map.
    const input = userInput()
    input.touch(1, 0)
    input.touch(0, 50)
    expect(input.active(50 + 5000)).toBe(false)
  })
})

describe('the part of the route already driven', () => {
  it('is cut in steps of 10 metres', () => {
    expect(DRIVEN_STEP_M).toBe(10)
    expect(drivenCut(0)).toBe(0)
    expect(drivenCut(9.99)).toBe(0)
    expect(drivenCut(10)).toBe(10)
    expect(drivenCut(1234)).toBe(1230)
    expect(drivenCut(1239.9)).toBe(1230)
  })

  it('does not move between fixes within a step, so the line is not redrawn at every fix', () => {
    const cuts = new Set([1231, 1233.5, 1236, 1239.99].map(drivenCut))
    expect(cuts.size).toBe(1)
  })

  it('is nothing when there is no driving, and for a distance that is not a number', () => {
    expect(drivenCut(undefined)).toBeUndefined()
    expect(drivenCut(NaN)).toBeUndefined()
    expect(drivenCut(Infinity)).toBeUndefined()
    expect(drivenCut(-Infinity)).toBeUndefined()
  })

  it('is the start of the route for a distance below it, never a negative cut', () => {
    expect(drivenCut(-5)).toBe(0)
    expect(Object.is(drivenCut(-5), 0)).toBe(true)
    expect(drivenCut(-0.1)).toBe(0)
  })

  it('shares out a section: none of it before a cut that is at or before its start, all of it after its end', () => {
    expect(drivenShare(0, 100, 300)).toBe(0)
    expect(drivenShare(100, 100, 300)).toBe(0)
    expect(drivenShare(200, 100, 300)).toBe(0.5)
    expect(drivenShare(250, 100, 300)).toBe(0.75)
    expect(drivenShare(300, 100, 300)).toBe(1)
    expect(drivenShare(5000, 100, 300)).toBe(1)
  })

  it('counts a section with no length as all driven, and never goes outside 0 to 1', () => {
    expect(drivenShare(0, 50, 50)).toBe(1)
    expect(drivenShare(100, 80, 40)).toBe(1)
    for (const cut of [-100, 0, 55, 100, 1e6]) {
      const share = drivenShare(cut, 50, 150)
      expect(share).toBeGreaterThanOrEqual(0)
      expect(share).toBeLessThanOrEqual(1)
    }
  })

  it('has an arrow ahead until the driver has passed it, and with no driving all of them', () => {
    expect(isAhead(500, undefined)).toBe(true)
    expect(isAhead(500, 0)).toBe(true)
    expect(isAhead(500, 490)).toBe(true)
    expect(isAhead(500, 500)).toBe(true)
    expect(isAhead(500, 510)).toBe(false)
    expect(isAhead(0, 10)).toBe(false)
  })

  it('leaves off the arrows already driven, and keeps the ones to come, in order', () => {
    const arrows = [75, 225, 375, 525, 675].map((routeM) => ({ routeM }))
    const cut = drivenCut(400)
    expect(arrows.filter((a) => isAhead(a.routeM, cut)).map((a) => a.routeM)).toEqual([525, 675])
    expect(arrows.filter((a) => isAhead(a.routeM, drivenCut(undefined))).length).toBe(5)
    expect(arrows.filter((a) => isAhead(a.routeM, drivenCut(10000))).length).toBe(0)
  })

  it('splits a road driven twice so that the pass still to come is all ahead while the first is all driven', () => {
    // Down a street (0 to 300 m) and back along it (300 to 600 m), the driver half way back.
    const cut = drivenCut(450)
    expect(drivenShare(cut as number, 0, 300)).toBe(1)
    expect(drivenShare(cut as number, 300, 600)).toBe(0.5)
    // At the start of the way back nothing of it is driven yet, though the way down is.
    const atTurn = drivenCut(300)
    expect(drivenShare(atTurn as number, 0, 300)).toBe(1)
    expect(drivenShare(atTurn as number, 300, 600)).toBe(0)
  })
})
