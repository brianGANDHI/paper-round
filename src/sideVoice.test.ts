import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cumulativeDistances } from './geo'
import {
  createSideCue,
  NO_SIDE_CUE,
  SIDE_BEEP_SECONDS,
  SIDE_LOOKAHEAD_M,
  SIDE_LOOKAHEAD_MAX_M,
  SIDE_LOOKAHEAD_MIN_M,
  SIDE_SETTLE_M,
  SIDE_WORDS,
  sideAtAlong,
  sideLookAheadM,
  sideWords,
  stepSideCue,
  testVoice,
  VOICE_TEST_GAP_MS,
} from './sideVoice'
import { ALERT_SECONDS } from './sound'
import { SIDES, type Pt, type Side, type SideChange } from './types'

/** A road running north through Sydney with a point every 100 m, so a distance along it is just a latitude. */
const M_PER_DEG = (6371000 * Math.PI) / 180
const road: Pt[] = Array.from({ length: 11 }, (_, i) => ({ lat: -33.87 + (i * 100) / M_PER_DEG, lng: 151.2 }))
const cum = cumulativeDistances(road)
const changes = (...c: [number, Side][]): { sideChanges: SideChange[] } => ({ sideChanges: c.map(([idx, side]) => ({ idx, side })) })

describe('the words for a side', () => {
  it('are exactly Port, Starboard, Both and Transit', () => {
    expect(sideWords('left')).toBe('Port')
    expect(sideWords('right')).toBe('Starboard')
    expect(sideWords('both')).toBe('Both')
    expect(sideWords('transit')).toBe('Transit')
    expect(Object.values(SIDE_WORDS).sort()).toEqual(['Both', 'Port', 'Starboard', 'Transit'])
  })

  it('have a word for every side there is', () => {
    for (const side of SIDES) expect(sideWords(side)).toMatch(/^[A-Z][a-z]+$/)
  })
})

describe('how far ahead the side is looked at', () => {
  it('is the usual 15 m when the speed is not known', () => {
    expect(SIDE_LOOKAHEAD_M).toBe(15)
    for (const speed of [null, undefined, NaN, -1, Infinity]) expect(sideLookAheadM(speed)).toBe(SIDE_LOOKAHEAD_M)
  })

  it('is the distance a word takes to say at the speed, with the wait for an alert’s beep, kept between a least and a most', () => {
    // 1.6 s for the word and the lead-in before it, and 0.95 s for the longest beep: 2.55 s of driving.
    expect(sideLookAheadM(5)).toBe(13)
    expect(sideLookAheadM(10)).toBe(26)
    expect(sideLookAheadM(11)).toBe(28)
    expect(sideLookAheadM(12)).toBe(SIDE_LOOKAHEAD_MAX_M)
    expect(sideLookAheadM(14)).toBe(SIDE_LOOKAHEAD_MAX_M)
    expect(sideLookAheadM(0)).toBe(SIDE_LOOKAHEAD_MIN_M)
    expect(sideLookAheadM(3)).toBe(SIDE_LOOKAHEAD_MIN_M)
    expect(sideLookAheadM(40)).toBe(SIDE_LOOKAHEAD_MAX_M)
  })

  it('allows for the longest beep of any alert, a no-throw house’s', () => {
    expect(SIDE_BEEP_SECONDS).toBe(ALERT_SECONDS.nothrow)
    for (const seconds of Object.values(ALERT_SECONDS)) expect(SIDE_BEEP_SECONDS).toBeGreaterThanOrEqual(seconds)
  })
})

describe('the side at a distance along the route', () => {
  // Both for the first 300 m, then Left to 600 m, then Right, then Transit from 900 m.
  const route = changes([0, 'both'], [3, 'left'], [6, 'right'], [9, 'transit'])

  it('is the side of the segment that distance is on', () => {
    expect(sideAtAlong(route, cum, 0)).toBe('both')
    expect(sideAtAlong(route, cum, 299)).toBe('both')
    expect(sideAtAlong(route, cum, 450)).toBe('left')
    expect(sideAtAlong(route, cum, 750)).toBe('right')
    expect(sideAtAlong(route, cum, 950)).toBe('transit')
  })

  it('changes at the point where the side changes, not before it', () => {
    expect(sideAtAlong(route, cum, cum[3] - 0.5)).toBe('both')
    expect(sideAtAlong(route, cum, cum[3])).toBe('left')
    expect(sideAtAlong(route, cum, cum[3] + 0.5)).toBe('left')
  })

  it('takes the first segment before the start and the last past the end', () => {
    expect(sideAtAlong(route, cum, -50)).toBe('both')
    expect(sideAtAlong(route, cum, 5000)).toBe('transit')
  })

  it('does not take a change at the last point of the route for a segment, as there is none', () => {
    expect(sideAtAlong(changes([0, 'both'], [10, 'transit']), cum, 5000)).toBe('both')
  })

  it('is both for a route with no changes, as the route is', () => {
    expect(sideAtAlong(changes(), cum, 500)).toBe('both')
    expect(sideAtAlong(route, [], 500)).toBe('both')
  })
})

describe('the side cue', () => {
  it('says the side at the spot the first time, whatever is ahead', () => {
    expect(stepSideCue(NO_SIDE_CUE, 'left', 'left', 0)).toEqual({ state: { last: 'left', at: 0 }, say: 'left' })
    expect(stepSideCue(NO_SIDE_CUE, 'left', 'right', 0).say).toBe('left')
    expect(stepSideCue(NO_SIDE_CUE, 'transit', 'transit').say).toBe('transit')
  })

  it('says each change once, as the driver comes to it', () => {
    const cue = createSideCue()
    expect(cue.update('left', 'left', 0)).toBe('left')
    expect(cue.update('left', 'left', 40)).toBeNull()
    expect(cue.update('left', 'right', 90)).toBe('right')
    expect(cue.update('left', 'right', 100)).toBeNull()
    expect(cue.update('right', 'right', 115)).toBeNull()
    expect(cue.update('right', 'transit', 200)).toBe('transit')
    expect(cue.update('transit', 'transit', 230)).toBeNull()
  })

  it('never says the same side twice running', () => {
    const cue = createSideCue()
    const said = [0, 10, 20, 30, 40, 50].map((along) => cue.update('both', 'both', along))
    expect(said).toEqual(['both', null, null, null, null, null])
  })

  it('says a side again when it comes back after another', () => {
    const cue = createSideCue()
    const said = [
      cue.update('left', 'left', 0),
      cue.update('left', 'right', 100),
      cue.update('right', 'left', 200),
    ]
    expect(said).toEqual(['left', 'right', 'left'])
  })

  it('says the side at the spot again after a reset: a round started, or skipped to a spot', () => {
    const cue = createSideCue()
    cue.update('left', 'left', 0)
    expect(cue.update('left', 'left', 500)).toBeNull()
    cue.reset()
    expect(cue.last()).toBeNull()
    expect(cue.update('left', 'left', 2000)).toBe('left')
    expect(cue.update('left', 'left', 2100)).toBeNull()
  })

  it('says the side at the spot after a reset, not the one ahead of it', () => {
    const cue = createSideCue()
    cue.update('both', 'both', 0)
    cue.reset()
    expect(cue.update('both', 'left', 300)).toBe('both')
  })

  it('knows the side said last', () => {
    const cue = createSideCue()
    expect(cue.last()).toBeNull()
    cue.update('left', 'left', 0)
    expect(cue.last()).toBe('left')
    cue.update('left', 'transit', 100)
    expect(cue.last()).toBe('transit')
  })

  it('says nothing for a different side that comes within a few metres of the last, which is the position wobbling', () => {
    const cue = createSideCue()
    cue.update('left', 'left', 0)
    expect(cue.update('left', 'right', 100)).toBe('right')
    // Backing off across the change by a few metres, and forward again, is not a change.
    expect(cue.update('left', 'left', 100 - SIDE_SETTLE_M + 1)).toBeNull()
    expect(cue.update('left', 'right', 101)).toBeNull()
    expect(cue.last()).toBe('right')
  })

  it('says a real change that comes soon after another, once the driver is further on', () => {
    const cue = createSideCue()
    cue.update('left', 'left', 0)
    expect(cue.update('left', 'right', 100)).toBe('right')
    expect(cue.update('left', 'left', 100 + SIDE_SETTLE_M)).toBe('left')
  })

  it('says a change after the driver has backed a long way up the route', () => {
    const cue = createSideCue()
    cue.update('left', 'left', 0)
    expect(cue.update('left', 'right', 400)).toBe('right')
    expect(cue.update('left', 'left', 300)).toBe('left')
  })

  it('does not hold a change back for want of a distance', () => {
    const cue = createSideCue()
    cue.update('left', 'left')
    expect(cue.update('left', 'right')).toBe('right')
    expect(cue.update('right', 'left')).toBe('left')
  })

  it('keeps no state in the step: the same state gives the same answer', () => {
    const state = { last: 'left' as Side, at: 0 }
    expect(stepSideCue(state, 'left', 'right', 100)).toEqual(stepSideCue(state, 'left', 'right', 100))
    expect(state).toEqual({ last: 'left', at: 0 })
  })
})

describe('driving a route and saying its sides', () => {
  // Both, Left from 300 m, Right from 600 m, Transit from 900 m, as the round screen asks it at every fix.
  const route = changes([0, 'both'], [3, 'left'], [6, 'right'], [9, 'transit'])
  const drive = (fixEvery: number, speed: number) => {
    const cue = createSideCue()
    const said: { side: Side; at: number }[] = []
    const look = sideLookAheadM(speed)
    for (let along = 0; along <= 1000; along += fixEvery) {
      const side = cue.update(sideAtAlong(route, cum, along), sideAtAlong(route, cum, along + look), along)
      if (side) said.push({ side, at: along })
    }
    return said
  }

  it('says each side once, in order, with the first at the start', () => {
    expect(drive(10, 12).map((s) => s.side)).toEqual(['both', 'left', 'right', 'transit'])
  })

  it('says each change before it is reached, not after', () => {
    for (const [fixEvery, speed] of [[5, 5], [10, 10], [14, 14], [20, 20]] as const) {
      const said = drive(fixEvery, speed)
      const edges = [300, 600, 900]
      said.slice(1).forEach((s, i) => {
        expect(s.at, `${s.side} at ${fixEvery} m fixes`).toBeLessThanOrEqual(edges[i])
        expect(s.at).toBeGreaterThan(edges[i] - sideLookAheadM(speed) - fixEvery)
      })
    }
  })
})

describe('the Test Voice button', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const WORDS = [sideWords('left'), sideWords('right'), sideWords('both')]

  it('says the first side word at once, from the tap', () => {
    const said: string[] = []
    testVoice((word) => said.push(word))
    expect(said).toEqual(WORDS.slice(0, 1))
  })

  it('says each of the three side words in turn, a gap apart, as words of their own', () => {
    const said: string[] = []
    testVoice((word) => said.push(word))
    vi.advanceTimersByTime(VOICE_TEST_GAP_MS - 1)
    expect(said).toEqual(WORDS.slice(0, 1))
    vi.advanceTimersByTime(1)
    expect(said).toEqual(WORDS.slice(0, 2))
    vi.advanceTimersByTime(VOICE_TEST_GAP_MS)
    expect(said).toEqual(WORDS)
    vi.advanceTimersByTime(60_000)
    expect(said).toEqual(WORDS)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('takes its words from the words for a side, so it says what the road will', () => {
    const said: string[] = []
    testVoice((word) => said.push(word))
    vi.advanceTimersByTime(3 * VOICE_TEST_GAP_MS)
    for (const word of said) expect(Object.values(SIDE_WORDS)).toContain(word)
    expect(new Set(said).size).toBe(3)
    expect(said).not.toContain(sideWords('transit'))
  })

  it('stops, with its timers cleared, so no word comes after the screen has gone', () => {
    const said: string[] = []
    const stop = testVoice((word) => said.push(word))
    vi.advanceTimersByTime(VOICE_TEST_GAP_MS)
    expect(said).toHaveLength(2)
    stop()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(60_000)
    expect(said).toHaveLength(2)
  })

  it('can be stopped twice, and after it is over', () => {
    const stop = testVoice(() => undefined)
    vi.advanceTimersByTime(60_000)
    expect(() => {
      stop()
      stop()
    }).not.toThrow()
  })
})
