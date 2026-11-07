import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALERT_SECONDS, createSound, DROPPED_SECONDS, KEEP_ALIVE_GAIN, OPENER_SECONDS, TICK_SECONDS } from './sound'

/** A stand-in for the phone's audio: what was played, and what state it is in. */
function fakeAudio(startState = 'running') {
  const log: { freq: number; gain: number; start: number; stop: number }[] = []
  const calls: string[] = []
  /** Each change of level scheduled on a gain: how it gets there, the level and when. */
  const levels: { ramp: boolean; value: number; at: number }[] = []
  const sources: { loop: boolean; started: boolean; stopped: boolean; disconnected: boolean; gain: number; samples: ArrayLike<number> }[] = []
  const ctx = {
    state: startState,
    currentTime: 10,
    sampleRate: 100,
    destination: {},
    resumeBehaviour: 'works' as 'works' | 'stuck' | 'works-after-suspend',
    suspendBehaviour: 'works' as 'works' | 'stuck' | 'fails',
    resume() {
      calls.push('resume')
      if (this.resumeBehaviour === 'works' || (this.resumeBehaviour === 'works-after-suspend' && calls.includes('suspend'))) this.state = 'running'
      return this.resumeBehaviour === 'stuck' ? new Promise<void>(() => {}) : Promise.resolve()
    },
    suspend() {
      calls.push('suspend')
      if (this.suspendBehaviour === 'stuck') return new Promise<void>(() => {})
      if (this.suspendBehaviour === 'fails') return Promise.reject(new Error('no'))
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
      const g = {
        gain: {
          value: 0,
          setValueAtTime: (value: number, at: number) => void levels.push({ ramp: false, value, at }),
          linearRampToValueAtTime: (value: number, at: number) => void levels.push({ ramp: true, value, at }),
        },
        connect: () => ({ connect: () => undefined }),
      }
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
  return { ctx, log, calls, levels, sources, make: () => ctx as unknown as AudioContext }
}

const noWait = () => Promise.resolve()

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

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
      never.opener()
      never.nudge()
      never.startKeepAlive()
      never.stopKeepAlive()
    }).not.toThrow()
    expect(never.keepingAlive()).toBe(false)
    const early = createSound(fakeAudio().make, noWait)
    expect(() => early.noThrow()).not.toThrow()
  })
})

describe('the beep for an apartment block', () => {
  const play = (kind: 'bundle' | 'block' | 'request' | 'noThrow' | 'offRoute') => {
    const f = fakeAudio()
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    const s = createSound(f.make, noWait)
    s.unlock()
    const seconds = s[kind]()
    return { seconds, notes: f.log, ctx: f.ctx, vibrate }
  }

  it('is two short notes of the same pitch', () => {
    const { notes } = play('block')
    expect(notes).toHaveLength(2)
    expect(notes[0].freq).toBe(notes[1].freq)
    expect(notes[0].freq).toBeGreaterThanOrEqual(300)
    expect(notes[0].freq).toBeLessThanOrEqual(2000)
  })

  it('is not taken for any other alert: not a bundle drop, a special request, a no-throw house or being off the route', () => {
    const block = play('block').notes
    // A bundle drop's one note, a special request's two going up, a no-throw house's three and the off-route two going down.
    expect(play('bundle').notes).toHaveLength(1)
    expect(play('noThrow').notes).toHaveLength(3)
    const request = play('request').notes
    expect(request[0].freq).toBeLessThan(request[1].freq)
    const off = play('offRoute').notes
    expect(off[0].freq).toBeGreaterThan(off[1].freq)
    expect(block[0].freq).toBe(block[1].freq)
    // And its pitch is not the single beep's, nor the no-throw house's.
    expect(block[0].freq).not.toBe(play('bundle').notes[0].freq)
    expect(block[0].freq).not.toBe(play('noThrow').notes[0].freq)
    const lengths = Object.values(ALERT_SECONDS)
    expect(new Set(lengths).size).toBe(lengths.length)
  })

  it('says how long it takes, and takes that long: the second note starts after the first and ends at the length', () => {
    const { seconds, notes, ctx } = play('block')
    expect(seconds).toBe(ALERT_SECONDS.block)
    expect(notes[0].start).toBe(ctx.currentTime)
    expect(notes[1].start).toBeGreaterThanOrEqual(notes[0].stop)
    expect(Math.max(...notes.map((n) => n.stop)) - ctx.currentTime).toBeCloseTo(ALERT_SECONDS.block, 5)
  })

  it('is short, so the voice that follows is not kept waiting', () => {
    expect(ALERT_SECONDS.block).toBeGreaterThan(ALERT_SECONDS.bundle)
    expect(ALERT_SECONDS.block).toBeLessThan(ALERT_SECONDS.request)
  })

  it('is as loud as the other alerts', () => {
    expect(play('block').notes.map((n) => n.gain)).toEqual(play('request').notes.slice(0, 2).map((n) => n.gain))
  })

  it('buzzes the phone where it can, in a pattern of its own', () => {
    const { vibrate } = play('block')
    expect(vibrate).toHaveBeenCalledTimes(1)
    for (const other of ['bundle', 'request', 'noThrow', 'offRoute'] as const) expect(vibrate.mock.calls[0][0]).not.toEqual(play(other).vibrate.mock.calls[0][0])
  })

  it('wakes the audio up as it goes, in case it fell asleep, and does nothing before audio is unlocked', () => {
    const { ctx, calls, make } = fakeAudio('running')
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    ctx.state = 'suspended'
    calls.length = 0
    s.block()
    expect(calls).toContain('resume')
    const early = fakeAudio()
    const before = createSound(early.make, noWait)
    expect(() => before.block()).not.toThrow()
    expect(early.log).toHaveLength(0)
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

describe('the opener before a spoken word after a silence', () => {
  const play = () => {
    const f = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(f.make, noWait)
    s.unlock()
    return { ...f, s }
  }

  it('lasts about 0.3 s, and says so, where the tick is over in 0.06 s', () => {
    const { log, s } = play()
    expect(OPENER_SECONDS).toBe(0.3)
    expect(s.opener()).toBe(OPENER_SECONDS)
    expect(log).toHaveLength(1)
    expect(log[0].stop - log[0].start).toBeCloseTo(OPENER_SECONDS, 5)
  })

  it('is softer than the tick, and not silence', () => {
    const { log, s } = play()
    s.tick()
    s.opener()
    expect(log[1].gain).toBeGreaterThan(0)
    expect(log[1].gain).toBeLessThan(log[0].gain)
  })

  it('fades in from nothing and back to nothing, so that it starts and ends without a click', () => {
    const { ctx, levels, s } = play()
    s.opener()
    const peak = Math.max(...levels.map((l) => l.value))
    expect(peak).toBeGreaterThan(0)
    expect(levels[0]).toEqual({ ramp: false, value: 0, at: ctx.currentTime })
    expect(levels[1].ramp).toBe(true)
    expect(levels[1].value).toBe(peak)
    expect(levels[1].at).toBeGreaterThan(ctx.currentTime)
    expect(levels.at(-1)?.ramp).toBe(true)
    expect(levels.at(-1)?.value).toBe(0)
    expect(levels.at(-1)?.at).toBeCloseTo(ctx.currentTime + OPENER_SECONDS, 5)
  })

  it('is not taken for an alert: it has a pitch of its own, in the range a phone can play', () => {
    const { log, s } = play()
    s.bundle()
    s.block()
    s.request()
    s.noThrow()
    s.offRoute()
    s.dropped()
    s.tick()
    const others = log.map((n) => n.freq)
    log.length = 0
    s.opener()
    expect(others).not.toContain(log[0].freq)
    expect(log[0].freq).toBeGreaterThanOrEqual(300)
    expect(log[0].freq).toBeLessThanOrEqual(2000)
  })

  it('does not buzz the phone', () => {
    const f = fakeAudio()
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    const s = createSound(f.make, noWait)
    s.unlock()
    s.opener()
    expect(vibrate).not.toHaveBeenCalled()
  })

  it('plays nothing, and does not throw, before audio is unlocked', () => {
    const { log, make } = fakeAudio()
    const s = createSound(make, noWait)
    expect(s.opener()).toBe(0)
    expect(log).toHaveLength(0)
  })
})

describe('sound on audio that fails', () => {
  const alerts: [string, (s: ReturnType<typeof createSound>) => number, number][] = [
    ['a bundle drop', (s) => s.bundle(), ALERT_SECONDS.bundle],
    ['an apartment block', (s) => s.block(), ALERT_SECONDS.block],
    ['a special request', (s) => s.request(), ALERT_SECONDS.request],
    ['a no-throw house', (s) => s.noThrow(), ALERT_SECONDS.nothrow],
    ['being off the route', (s) => s.offRoute(), ALERT_SECONDS.offRoute],
    ['a drop confirmed', (s) => s.dropped(), DROPPED_SECONDS],
  ]
  const unlocked = () => {
    const f = fakeAudio()
    const s = createSound(f.make, noWait, () => 5000)
    s.unlock()
    return { ...f, s }
  }
  const boom = () => {
    throw new Error('no')
  }

  it.each(alerts)('the beep for %s plays, and says how long it lasts, when the audio throws as it is woken', (_name, play, seconds) => {
    vi.stubGlobal('navigator', {})
    const { ctx, log, s } = unlocked()
    ctx.resume = boom
    expect(play(s)).toBe(seconds)
    expect(log.length).toBeGreaterThan(0)
  })

  it.each(alerts)('the beep for %s still says how long it lasts when a note can’t be played, so the words that follow keep their time', (_name, play, seconds) => {
    vi.stubGlobal('navigator', {})
    const { ctx, log, s } = unlocked()
    ctx.createOscillator = boom
    expect(play(s)).toBe(seconds)
    expect(log).toHaveLength(0)
  })

  it.each(alerts)('the beep for %s fails quietly when nothing about the audio works', (_name, play, seconds) => {
    vi.stubGlobal('navigator', {})
    const { ctx, s } = unlocked()
    ctx.resume = boom
    ctx.createOscillator = boom
    expect(play(s)).toBe(seconds)
  })

  it.each(alerts)('%s still buzzes the phone when no note can be played', (_name, play) => {
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    const { ctx, s } = unlocked()
    ctx.resume = boom
    ctx.createOscillator = boom
    play(s)
    expect(vibrate).toHaveBeenCalled()
  })

  it.each(alerts)('the beep for %s leaves no refused wake-up unhandled', (_name, play) => {
    vi.stubGlobal('navigator', {})
    const { ctx, s } = unlocked()
    const refused = Promise.reject(new Error('not now'))
    const handled = vi.spyOn(refused, 'catch')
    ctx.resume = () => refused
    play(s)
    expect(handled).toHaveBeenCalled()
  })

  it.each(['createOscillator', 'createGain'] as const)('a note fails quietly when %s throws', (make) => {
    const { ctx, s } = unlocked()
    ctx[make] = boom
    expect(s.tick()).toBe(0)
    expect(s.lastSound()).toBe(-Infinity)
  })

  it('a note fails quietly when it will not start, and does not count as sound going out', () => {
    const { ctx, s } = unlocked()
    const make = ctx.createOscillator
    ctx.createOscillator = () => ({ ...make(), start: boom })
    expect(s.opener()).toBe(0)
    expect(s.lastSound()).toBe(-Infinity)
  })

  it('the tick and the opener say they lasted no time when they can’t be played, so the words wait for neither', () => {
    const { ctx, s } = unlocked()
    ctx.createOscillator = boom
    expect(s.tick()).toBe(0)
    expect(s.opener()).toBe(0)
  })

  it('the tick says it lasted no time before audio is unlocked', () => {
    const { make } = fakeAudio()
    expect(createSound(make, noWait).tick()).toBe(0)
  })

  it('counts a note played again once the audio works, after one that failed', () => {
    const { ctx, s } = unlocked()
    const make = ctx.createOscillator
    ctx.createOscillator = boom
    s.tick()
    ctx.createOscillator = make
    expect(s.tick()).toBe(TICK_SECONDS)
    expect(s.lastSound()).toBe(5000 + TICK_SECONDS * 1000)
  })
})

describe('when sound last went out', () => {
  it('is never, until something is played', () => {
    const f = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(f.make, noWait, () => 5000)
    s.unlock()
    expect(s.lastSound()).toBe(-Infinity)
    s.bundle()
    expect(s.lastSound()).not.toBe(-Infinity)
  })

  it('is when the sound ends, for beeps, the tick, the opener and the tone for a drop alike', () => {
    vi.stubGlobal('navigator', {})
    const seconds = (play: (s: ReturnType<typeof createSound>) => number) => {
      const f = fakeAudio()
      const s = createSound(f.make, noWait, () => 5000)
      s.unlock()
      const lasts = play(s)
      expect(s.lastSound()).toBeCloseTo(5000 + lasts * 1000, 5)
    }
    seconds((s) => s.bundle())
    seconds((s) => s.block())
    seconds((s) => s.request())
    seconds((s) => s.noThrow())
    seconds((s) => s.offRoute())
    seconds((s) => s.dropped())
    seconds((s) => s.tick())
    seconds((s) => s.opener())
  })

  it('does not count what could not be played, before audio is unlocked', () => {
    const f = fakeAudio()
    const s = createSound(f.make, noWait, () => 5000)
    s.opener()
    s.tick()
    expect(s.lastSound()).toBe(-Infinity)
  })

  it('does not count the keep-alive signal, which says nothing of whether the link has had a real sound', () => {
    const f = fakeAudio()
    const s = createSound(f.make, noWait, () => 5000)
    s.unlock()
    s.startKeepAlive()
    expect(s.lastSound()).toBe(-Infinity)
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

  it('does not wait for a stop that never finishes, and says sound is not ready', async () => {
    const f = fakeAudio('suspended')
    f.ctx.resumeBehaviour = 'stuck'
    f.ctx.suspendBehaviour = 'stuck'
    const s = createSound(f.make, noWait)
    s.unlock()
    f.calls.length = 0
    expect(await s.ready()).toBe(false)
    expect(f.calls).toEqual(['resume', 'suspend', 'resume'])
  })

  it('still tries to wake the audio after a stop that never finishes', async () => {
    const f = fakeAudio('running')
    f.ctx.resumeBehaviour = 'works-after-suspend'
    f.ctx.suspendBehaviour = 'stuck'
    const s = createSound(f.make, noWait)
    s.unlock()
    f.ctx.state = 'interrupted'
    f.calls.length = 0
    expect(await s.ready()).toBe(true)
    expect(f.calls).toEqual(['resume', 'suspend', 'resume'])
  })

  it('still tries to wake the audio after a stop that fails', async () => {
    const f = fakeAudio('running')
    f.ctx.resumeBehaviour = 'works-after-suspend'
    f.ctx.suspendBehaviour = 'fails'
    const s = createSound(f.make, noWait)
    s.unlock()
    f.ctx.state = 'interrupted'
    f.calls.length = 0
    expect(await s.ready()).toBe(true)
    expect(f.calls).toEqual(['resume', 'suspend', 'resume'])
  })

  it('gives up in under a second on audio that neither wakes nor stops, as the words wait on it', async () => {
    vi.useFakeTimers()
    const f = fakeAudio('suspended')
    f.ctx.resumeBehaviour = 'stuck'
    f.ctx.suspendBehaviour = 'stuck'
    const s = createSound(f.make)
    s.unlock()
    let answer: boolean | undefined
    void s.ready().then((sure) => (answer = sure))
    await vi.advanceTimersByTimeAsync(949)
    expect(answer).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toBe(false)
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
    expect(src.gain).toBeLessThan(0.01)
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

describe('the keep-alive signal itself', () => {
  /** The same noise each time, from a small generator with a seed. */
  const steadyNoise = (start: number) => {
    let seed = start
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    })
  }
  /** The signal as a phone would make it, two seconds of it at `rate` samples a second. */
  const signal = (rate: number, seed = 12345) => {
    steadyNoise(seed)
    const f = fakeAudio()
    f.ctx.sampleRate = rate
    const s = createSound(f.make, noWait)
    s.unlock()
    s.startKeepAlive()
    return { samples: Array.from(f.sources[0].samples), gain: f.sources[0].gain }
  }
  const power = (x: number[]) => x.reduce((sum, v) => sum + v * v, 0) / x.length
  const steps = (x: number[]) => x.slice(1).map((v, i) => v - x[i])

  afterEach(() => vi.restoreAllMocks())

  it('peaks about 44 decibels below full scale, where it was 56, which some links take for nothing to send', () => {
    const { samples, gain } = signal(8000)
    expect(gain).toBe(KEEP_ALIVE_GAIN)
    const peak = gain * Math.max(...samples.map(Math.abs))
    expect(20 * Math.log10(peak)).toBeGreaterThan(-46)
    expect(20 * Math.log10(peak)).toBeLessThan(-42)
  })

  it('makes full use of its level: the noise reaches full scale, as the filter alone would leave it far below that', () => {
    const { samples } = signal(8000)
    expect(Math.max(...samples.map(Math.abs))).toBeCloseTo(1, 5)
  })

  it('has the top taken off it, so it sits under the road: each sample is near the last, as in white noise it is not', () => {
    const { samples } = signal(8000)
    // White noise gives 2 here, since neighbouring samples have nothing to do with each other.
    expect(power(steps(samples)) / power(samples)).toBeLessThan(0.6)
  })

  it('is much the same at any sample rate a phone uses', () => {
    for (const rate of [44100, 48000]) {
      const { samples } = signal(rate)
      expect(power(steps(samples)) / power(samples)).toBeLessThan(0.2)
    }
  })

  it('joins up where it loops: the end leads into the start like any two samples, not with a step that would click every two seconds', { timeout: 60_000 }, () => {
    // Noise can do anything once, so this is over a number of runs. Filtered from silence, the join would be about 3 times the usual step.
    const joins = Array.from({ length: 12 }, (_, i) => {
      const { samples } = signal(48000, 1000 + i * 7919)
      return Math.abs(samples[0] - samples[samples.length - 1]) / Math.sqrt(power(steps(samples)))
    })
    expect(joins.reduce((sum, join) => sum + join, 0) / joins.length).toBeLessThan(1.5)
  })

  it('is two seconds long, and stays within full scale', () => {
    const { samples } = signal(8000)
    expect(samples).toHaveLength(16000)
    expect(Math.max(...samples)).toBeLessThanOrEqual(1)
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(-1)
  })
})

describe('whether the signal is keeping the link open', () => {
  const started = () => {
    const f = fakeAudio()
    const s = createSound(f.make, noWait)
    s.unlock()
    s.startKeepAlive()
    return { ...f, s }
  }

  it('it is, with the signal started and the audio running', () => {
    expect(started().s.keepingAlive()).toBe(true)
  })

  it.each(['suspended', 'interrupted', 'closed'])('it is not with the audio %s, as nothing is reaching the link', (state) => {
    const { ctx, s } = started()
    ctx.state = state
    expect(s.keepingAlive()).toBe(false)
  })

  it('it is again once the audio is running', () => {
    const { ctx, s } = started()
    ctx.state = 'interrupted'
    ctx.state = 'running'
    expect(s.keepingAlive()).toBe(true)
  })

  it('it is not with the audio running and no signal started', () => {
    const f = fakeAudio()
    const s = createSound(f.make, noWait)
    s.unlock()
    expect(s.keepingAlive()).toBe(false)
  })
})

describe('nudging audio that has gone to sleep', () => {
  it.each(['interrupted', 'suspended'])('resumes audio that is %s, once for each nudge', (state) => {
    const { ctx, calls, make } = fakeAudio()
    const s = createSound(make, noWait)
    s.unlock()
    ctx.resumeBehaviour = 'stuck'
    ctx.state = state
    calls.length = 0
    s.nudge()
    expect(calls).toEqual(['resume'])
    s.nudge()
    expect(calls).toEqual(['resume', 'resume'])
  })

  it('brings the keep-alive signal back with it, without restarting it', () => {
    const { ctx, sources, make } = fakeAudio()
    const s = createSound(make, noWait)
    s.unlock()
    s.startKeepAlive()
    ctx.state = 'interrupted'
    expect(s.keepingAlive()).toBe(false)
    s.nudge()
    expect(s.keepingAlive()).toBe(true)
    expect(sources).toHaveLength(1)
  })

  it('leaves running audio alone', () => {
    const { calls, make } = fakeAudio('running')
    const s = createSound(make, noWait)
    s.unlock()
    calls.length = 0
    s.nudge()
    expect(calls).toEqual([])
  })

  it('leaves closed audio alone', () => {
    const { ctx, calls, make } = fakeAudio('running')
    const s = createSound(make, noWait)
    s.unlock()
    ctx.state = 'closed'
    calls.length = 0
    s.nudge()
    expect(calls).toEqual([])
  })

  it('does not suspend audio to try to wake it, which is for when something is due to play', () => {
    const { ctx, calls, make } = fakeAudio()
    const s = createSound(make, noWait)
    s.unlock()
    ctx.resumeBehaviour = 'stuck'
    ctx.state = 'interrupted'
    calls.length = 0
    s.nudge()
    expect(calls).not.toContain('suspend')
  })

  it('does nothing, and does not throw, before audio is unlocked or where there is none', () => {
    expect(() => createSound(fakeAudio().make, noWait).nudge()).not.toThrow()
    const never = createSound(() => {
      throw new Error('no audio here')
    }, noWait)
    never.unlock()
    expect(() => never.nudge()).not.toThrow()
  })

  it('swallows a resume that is refused, or that blows up, as a phone in a call may', async () => {
    const f = fakeAudio('suspended')
    const s = createSound(f.make, noWait)
    s.unlock()
    f.ctx.state = 'suspended'
    f.ctx.resume = () => Promise.reject(new Error('not now'))
    expect(() => s.nudge()).not.toThrow()
    // A refusal left unhandled would fail the run.
    await Promise.resolve()
    f.ctx.resume = () => {
      throw new Error('no')
    }
    expect(() => s.nudge()).not.toThrow()
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

describe('the tone that confirms a bundle drop', () => {
  it('is two notes going up, so it is a tick of success and not a warning', () => {
    const { log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    s.dropped()
    expect(log).toHaveLength(2)
    expect(log[0].freq).toBeLessThan(log[1].freq)
  })

  it('is quieter than every alert, which all play at the same level', () => {
    const { log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    s.bundle()
    s.request()
    s.noThrow()
    s.offRoute()
    const alert = Math.min(...log.map((n) => n.gain))
    log.length = 0
    s.dropped()
    for (const n of log) {
      expect(n.gain).toBeGreaterThan(0)
      expect(n.gain).toBeLessThan(alert / 2)
    }
  })

  it('is not a tone an alert already has: not the bundle drop beep, and not the special request notes', () => {
    const { log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    s.request()
    const request = log.map((n) => n.freq)
    s.bundle()
    const bundle = log[2].freq
    log.length = 0
    s.dropped()
    const dropped = log.map((n) => n.freq)
    expect(dropped).not.toContain(bundle)
    for (const f of dropped) expect(request).not.toContain(f)
  })

  it('is in the range a phone speaker can play and a driver can hear', () => {
    const { log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    s.dropped()
    for (const n of log) {
      expect(n.freq).toBeGreaterThanOrEqual(300)
      expect(n.freq).toBeLessThanOrEqual(2000)
    }
  })

  it('says how long it takes, and takes that long: the second note starts after the first ends', () => {
    const { ctx, log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    expect(s.dropped()).toBe(DROPPED_SECONDS)
    expect(log[0].start).toBe(ctx.currentTime)
    expect(log[1].start).toBeGreaterThanOrEqual(log[0].stop)
    expect(Math.max(...log.map((n) => n.stop)) - ctx.currentTime).toBeCloseTo(DROPPED_SECONDS, 5)
  })

  it('is short: quicker than any alert, so a voice that follows it is not kept waiting', () => {
    expect(DROPPED_SECONDS).toBeGreaterThan(0)
    expect(DROPPED_SECONDS).toBeLessThan(Math.min(ALERT_SECONDS.request, ALERT_SECONDS.offRoute, ALERT_SECONDS.nothrow))
  })

  it('buzzes the phone briefly where it can, less than a bundle alert does', () => {
    const { make } = fakeAudio()
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    const s = createSound(make, noWait)
    s.unlock()
    s.bundle()
    const alertBuzz = vibrate.mock.calls[0][0] as number
    vibrate.mockClear()
    s.dropped()
    expect(vibrate).toHaveBeenCalledTimes(1)
    expect(vibrate.mock.calls[0][0]).toBeGreaterThan(0)
    expect(vibrate.mock.calls[0][0]).toBeLessThan(alertBuzz)
  })

  it('wakes the audio up as it goes, in case it fell asleep', () => {
    const { ctx, calls, make } = fakeAudio('running')
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    ctx.state = 'suspended'
    calls.length = 0
    s.dropped()
    expect(calls).toContain('resume')
  })

  it('plays nothing, and does not throw, before audio is unlocked or where there is none', () => {
    vi.stubGlobal('navigator', {})
    const f = fakeAudio()
    const early = createSound(f.make, noWait)
    expect(() => early.dropped()).not.toThrow()
    expect(f.log).toHaveLength(0)
    const never = createSound(() => {
      throw new Error('no audio here')
    }, noWait)
    never.unlock()
    expect(() => never.dropped()).not.toThrow()
  })

  it('is heard again each time', () => {
    const { log, make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    s.dropped()
    s.dropped()
    expect(log).toHaveLength(4)
    expect(log.slice(0, 2)).toEqual(log.slice(2))
  })
})

describe('a buzz that fails', () => {
  const ALERTS = [
    ['bundle', ALERT_SECONDS.bundle],
    ['block', ALERT_SECONDS.block],
    ['request', ALERT_SECONDS.request],
    ['noThrow', ALERT_SECONDS.nothrow],
    ['offRoute', ALERT_SECONDS.offRoute],
    ['dropped', DROPPED_SECONDS],
  ] as const

  it.each(ALERTS)('does not get out of the %s alert, which still plays and says how long it lasts', (kind, seconds) => {
    const { log, make } = fakeAudio()
    const vibrate = vi.fn(() => {
      throw new Error('no')
    })
    vi.stubGlobal('navigator', { vibrate })
    const s = createSound(make, noWait)
    s.unlock()
    expect(s[kind]()).toBe(seconds)
    expect(vibrate).toHaveBeenCalledTimes(1)
    expect(log.length).toBeGreaterThan(0)
  })

  it.each(ALERTS)('is no loss on a phone that has no buzz at all, as for the %s alert on an iPhone', (kind, seconds) => {
    const { make } = fakeAudio()
    vi.stubGlobal('navigator', {})
    const s = createSound(make, noWait)
    s.unlock()
    expect(s[kind]()).toBe(seconds)
  })
})
