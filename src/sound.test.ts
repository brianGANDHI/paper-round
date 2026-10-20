import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALERT_SECONDS, createSound, TICK_SECONDS } from './sound'

/** A stand-in for the phone's audio: what was played, and what state it is in. */
function fakeAudio(startState = 'running') {
  const log: { freq: number; gain: number; start: number; stop: number }[] = []
  const calls: string[] = []
  const sources: { loop: boolean; started: boolean; stopped: boolean; disconnected: boolean; gain: number; samples: ArrayLike<number> }[] = []
  const ctx = {
    state: startState,
    currentTime: 10,
    sampleRate: 100,
    destination: {},
    resumeBehaviour: 'works' as 'works' | 'stuck' | 'works-after-suspend',
    resume() {
      calls.push('resume')
      if (this.resumeBehaviour === 'works' || (this.resumeBehaviour === 'works-after-suspend' && calls.includes('suspend'))) this.state = 'running'
      return this.resumeBehaviour === 'stuck' ? new Promise<void>(() => {}) : Promise.resolve()
    },
    suspend() {
      calls.push('suspend')
      this.state = 'suspended'
      return Promise.resolve()
    },
    createOscillator() {
      const o = {
        frequency: { value: 0 },
        gainValue: 0,
        connect(g: { gain: { value: number } }) {
          o.gainValue = g.gain.value
          return { connect: () => undefined }
        },
        start(at: number) {
          o.at = at
        },
        stop(at: number) {
          log.push({ freq: o.frequency.value, gain: o.gainValue, start: o.at, stop: at })
        },
        at: 0,
      }
      return o
    },
    createGain() {
      const g = { gain: { value: 0 }, connect: () => ({ connect: () => undefined }) }
      return g
    },
    createBuffer(_channels: number, length: number) {
      const samples = new Float32Array(length)
      return { getChannelData: () => samples, samples }
    },
    createBufferSource() {
      const src = {
        loop: false,
        started: false,
        stopped: false,
        disconnected: false,
        gain: 0,
        samples: [] as ArrayLike<number>,
        buffer: null as null | { samples: ArrayLike<number> },
        connect(g: { gain: { value: number } }) {
          src.gain = g.gain.value
          src.samples = src.buffer?.samples ?? src.samples
          return { connect: () => undefined }
        },
        start() {
          src.started = true
        },
        stop() {
          src.stopped = true
        },
        disconnect() {
          src.disconnected = true
        },
      }
      sources.push(src)
      return src
    },
  }
  return { ctx, log, calls, sources, make: () => ctx as unknown as AudioContext }
}

const noWait = () => Promise.resolve()

afterEach(() => vi.unstubAllGlobals())

describe('the beeps for a stop', () => {
  it('say how long they last, and play each note in turn', () => {
    const { ctx, log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    expect(s.bundle()).toBe(ALERT_SECONDS.bundle)
    expect(log.map((n) => n.freq)).toEqual([880])
    log.length = 0
    expect(s.request()).toBe(ALERT_SECONDS.request)
    expect(log.map((n) => n.freq)).toEqual([660, 880])
    log.length = 0
    expect(s.noThrow()).toBe(ALERT_SECONDS.nothrow)
    expect(log.map((n) => n.freq)).toEqual([440, 440, 440])
    // Each note is scheduled from the audio clock, and the last of a no-throw's three ends as its length says.
    expect(log[0].start).toBe(ctx.currentTime)
    expect(log[2].stop - ctx.currentTime).toBeCloseTo(ALERT_SECONDS.nothrow, 5)
  })

  it('last as long as they are said to, for each kind of stop', () => {
    const { ctx, log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    s.bundle()
    expect(Math.max(...log.map((n) => n.stop)) - ctx.currentTime).toBeCloseTo(ALERT_SECONDS.bundle, 5)
    log.length = 0
    s.request()
    expect(Math.max(...log.map((n) => n.stop)) - ctx.currentTime).toBeCloseTo(ALERT_SECONDS.request, 5)
  })

  it('buzz the phone where it can', () => {
    const { make } = fakeAudio()
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    const s = createSound(make, noWait)
    s.unlock()
    s.bundle()
    s.request()
    s.noThrow()
    expect(vibrate).toHaveBeenCalledTimes(3)
  })

  it('wake the audio up as they go, in case it fell asleep', () => {
    const { ctx, calls, make } = fakeAudio('running')
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    ctx.state = 'suspended'
    calls.length = 0
    s.bundle()
    expect(calls).toContain('resume')
  })

  it('do nothing, and do not throw, before audio is unlocked or where there is none', () => {
    vi.stubGlobal('navigator', {})
    const never = createSound(() => {
      throw new Error('no audio here')
    }, noWait)
    expect(() => {
      never.unlock()
      never.bundle()
      never.request()
      never.noThrow()
      never.tick()
      never.startKeepAlive()
      never.stopKeepAlive()
    }).not.toThrow()
    const early = createSound(fakeAudio().make, noWait)
    expect(() => early.noThrow()).not.toThrow()
  })
})

describe('the tick before a spoken word', () => {
  it('is short and high, and says how long it lasts', () => {
    const { log, make } = fakeAudio()
    const s = createSound(make, noWait)
    s.unlock()
    expect(s.tick()).toBe(TICK_SECONDS)
    expect(log).toHaveLength(1)
    expect(log[0].freq).toBe(1200)
    expect(log[0].stop - log[0].start).toBeCloseTo(TICK_SECONDS, 5)
    expect(log[0].gain).toBeLessThan(0.2)
  })
})

describe('making sure sound can play', () => {
  it('is ready at once when the audio is running', async () => {
    const { calls, make } = fakeAudio('running')
    const s = createSound(make, noWait)
    s.unlock()
    calls.length = 0
    expect(await s.ready()).toBe(true)
    expect(calls).toEqual([])
  })

  it('wakes audio that is asleep', async () => {
    const { ctx, calls, make } = fakeAudio('running')
    const s = createSound(make, noWait)
    s.unlock()
    ctx.state = 'suspended'
    calls.length = 0
    expect(await s.ready()).toBe(true)
    expect(calls).toEqual(['resume'])
  })

  it('stops audio that will not wake and starts it again', async () => {
    const f = fakeAudio('running')
    f.ctx.resumeBehaviour = 'works-after-suspend'
    const s = createSound(f.make, noWait)
    s.unlock()
    f.ctx.state = 'interrupted'
    f.calls.length = 0
    expect(await s.ready()).toBe(true)
    expect(f.calls).toEqual(['resume', 'suspend', 'resume'])
  })

  it('does not wait for a wake-up that never finishes, and says sound is not ready', async () => {
    const f = fakeAudio('suspended')
    f.ctx.resumeBehaviour = 'stuck'
    const s = createSound(f.make, noWait)
    s.unlock()
    f.ctx.state = 'suspended'
    expect(await s.ready()).toBe(false)
  })

  it('is not ready before audio is unlocked', async () => {
    expect(await createSound(fakeAudio().make, noWait).ready()).toBe(false)
  })
})

describe('keeping the audio link open', () => {
  it('plays a quiet looping signal, once', () => {
    const f = fakeAudio()
    const s = createSound(f.make, noWait)
    s.unlock()
    s.startKeepAlive()
    s.startKeepAlive()
    expect(f.sources).toHaveLength(1)
    const [src] = f.sources
    expect(src.started).toBe(true)
    expect(src.loop).toBe(true)
    expect(src.gain).toBeGreaterThan(0)
    expect(src.gain).toBeLessThan(0.005)
    expect(s.keepingAlive()).toBe(true)
    // It is noise, not silence, since some links treat digital silence as nothing to send.
    const samples = Array.from(src.samples)
    expect(samples.some((x) => x !== 0)).toBe(true)
    expect(Math.max(...samples)).toBeLessThanOrEqual(1)
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-1)
  })

  it('stops, and can start again', () => {
    const f = fakeAudio()
    const s = createSound(f.make, noWait)
    s.unlock()
    s.startKeepAlive()
    s.stopKeepAlive()
    expect(f.sources[0].stopped).toBe(true)
    expect(f.sources[0].disconnected).toBe(true)
    expect(s.keepingAlive()).toBe(false)
    s.startKeepAlive()
    expect(f.sources).toHaveLength(2)
    expect(s.keepingAlive()).toBe(true)
  })

  it('does not start before audio is unlocked, and stopping when not started is fine', () => {
    const f = fakeAudio()
    const s = createSound(f.make, noWait)
    s.startKeepAlive()
    expect(f.sources).toHaveLength(0)
    expect(s.keepingAlive()).toBe(false)
    expect(() => s.stopKeepAlive()).not.toThrow()
  })
})

describe('the beeps for being off the route', () => {
  it('are two notes going down, so they are not taken for a special request, whose two go up', () => {
    const { log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    s.offRoute()
    expect(log).toHaveLength(2)
    expect(log[0].freq).toBeGreaterThan(log[1].freq)
    log.length = 0
    s.request()
    expect(log[0].freq).toBeLessThan(log[1].freq)
  })

  it('are loud enough to hear over the road, as loud as the other alerts, and no louder', () => {
    const { log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    s.request()
    const usual = log[0].gain
    log.length = 0
    s.offRoute()
    expect(log).toHaveLength(2)
    for (const n of log) expect(n.gain).toBe(usual)
  })

  it('are in the range a phone speaker can play and a driver can hear', () => {
    const { log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    s.offRoute()
    for (const n of log) {
      expect(n.freq).toBeGreaterThanOrEqual(300)
      expect(n.freq).toBeLessThanOrEqual(2000)
    }
  })

  it('say how long they take, and take that long: the second note starts after the first and ends at the length', () => {
    const { ctx, log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    expect(s.offRoute()).toBe(ALERT_SECONDS.offRoute)
    expect(ALERT_SECONDS.offRoute).toBeGreaterThan(0)
    expect(log[0].start).toBe(ctx.currentTime)
    expect(log[1].start).toBeGreaterThanOrEqual(log[0].stop)
    expect(Math.max(...log.map((n) => n.stop)) - ctx.currentTime).toBeCloseTo(ALERT_SECONDS.offRoute, 5)
  })

  it('take a moment, but not long: the voice waits that long to follow', () => {
    expect(ALERT_SECONDS.offRoute).toBeGreaterThan(0.3)
    expect(ALERT_SECONDS.offRoute).toBeLessThan(1)
    expect(ALERT_SECONDS.offRoute).not.toBe(ALERT_SECONDS.request)
  })

  it('buzz the phone where it can', () => {
    const { make } = fakeAudio()
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    const s = createSound(make, noWait)
    s.unlock()
    s.offRoute()
    expect(vibrate).toHaveBeenCalledTimes(1)
    expect(vibrate.mock.calls[0][0]).not.toEqual([120, 80, 120])
  })

  it('wake the audio up as they go, in case it fell asleep', () => {
    const { ctx, calls, make } = fakeAudio('running')
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    ctx.state = 'suspended'
    calls.length = 0
    s.offRoute()
    expect(calls).toContain('resume')
  })

  it('play nothing, and do not throw, before audio is unlocked or where there is none', () => {
    vi.stubGlobal('navigator', {})
    const f = fakeAudio()
    const early = createSound(f.make, noWait)
    expect(() => early.offRoute()).not.toThrow()
    expect(f.log).toHaveLength(0)
    const never = createSound(() => {
      throw new Error('no audio here')
    }, noWait)
    never.unlock()
    expect(() => never.offRoute()).not.toThrow()
  })

  it('are heard again each time', () => {
    const { log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    s.offRoute()
    s.offRoute()
    expect(log.map((n) => n.freq)).toHaveLength(4)
    expect(log.slice(0, 2)).toEqual(log.slice(2))
  })
})
