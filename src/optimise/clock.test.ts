import { describe, expect, it } from 'vitest'
import { wakingClock } from './clock'

/** A clock that reads each of `times` in turn. */
const reading = (...times: number[]) => {
  let i = 0
  return () => times[Math.min(i++, times.length - 1)]
}

describe('wakingClock', () => {
  it('goes by the clock it reads while the steps are short', () => {
    const clock = wakingClock(reading(100, 200, 4900))
    expect(clock()).toBe(200)
    expect(clock()).toBe(4900)
  })

  it('leaves out a step over 5 s, however long', () => {
    const clock = wakingClock(reading(0, 1000, 601000, 601500))
    expect(clock()).toBe(1000)
    expect(clock()).toBe(1000)
    expect(clock()).toBe(1500)
  })

  it('keeps a step of just 5 s', () => {
    const clock = wakingClock(reading(0, 5000, 10001, 10002))
    expect(clock()).toBe(5000)
    expect(clock()).toBe(5000)
    expect(clock()).toBe(5001)
  })

  it('leaves out each such step, and goes on from where it was', () => {
    const clock = wakingClock(reading(0, 10, 60010, 60020, 120020, 120030))
    expect([clock(), clock(), clock(), clock(), clock()]).toEqual([10, 10, 20, 20, 30])
  })
})
