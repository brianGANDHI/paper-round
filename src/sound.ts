/**
 * Sounds: the beeps that go with a stop's alert, the quiet tone that confirms a bundle drop, the tick that opens the
 * audio link before a spoken word, and a near-silent signal that keeps that link open.
 *
 * A phone sending sound to a car or a speaker over Bluetooth lets the link go idle between sounds, and the first
 * fraction of a second of the next one is lost while it wakes: the start of a spoken turn goes missing. Waiting
 * doesn't help, since nothing is sent while waiting. Something has to be sent first.
 */

/** How long each stop alert's beeps last, in seconds: the voice waits this long to follow one. */
export const ALERT_SECONDS = { bundle: 0.15, request: 0.37, nothrow: 0.95, offRoute: 0.4 } as const

/** How long the tone that confirms a bundle drop lasts, in seconds. */
export const DROPPED_SECONDS = 0.18

/** How loud that tone is: well under the alerts' 0.3, since it answers a tap and is not asking for attention. */
const DROPPED_GAIN = 0.1

/** How loud the keep-alive signal is: about 56 decibels below full scale, which is quiet enough not to be heard. */
const KEEP_ALIVE_GAIN = 0.0015

/** How long the tick before a spoken word lasts, in seconds. */
export const TICK_SECONDS = 0.06

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createSound(makeContext: () => AudioContext, sleep: (ms: number) => Promise<void> = sleepFor) {
  let ctx: AudioContext | null = null
  let keep: AudioBufferSourceNode | null = null

  /** Call from a tap handler: iOS only allows audio after a user gesture. */
  function unlock() {
    try {
      ctx ??= makeContext()
      void ctx.resume()
    } catch {
      // Audio unavailable; visual alerts still work.
    }
  }

  /**
   * Make sure sound can play, and say whether it can. iOS lets the audio context fall asleep, or stick "interrupted",
   * and a beep or a tick scheduled on it then never sounds. Waking it again is not always quick, so it waits only a little.
   */
  async function ready(): Promise<boolean> {
    const c = ctx
    if (!c) return false
    // Read afresh each time: the state changes under us, and iOS has one ("interrupted") the standard doesn't.
    const running = () => (c.state as string) === 'running'
    if (running()) return true
    const wake = () => Promise.race([c.resume().catch(() => undefined), sleep(250)])
    await wake()
    if (!running()) {
      // Resuming sometimes never finishes; stopping it first, and trying again a moment later, usually gets it going.
      await c.suspend().catch(() => undefined)
      await sleep(200)
      await wake()
    }
    return running()
  }

  function beep(freq: number, start: number, dur: number, gain = 0.3) {
    if (!ctx) return
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.value = freq
    g.gain.value = gain
    o.connect(g).connect(ctx.destination)
    o.start(ctx.currentTime + start)
    o.stop(ctx.currentTime + start + dur)
  }

  /** Each alert says how long it lasts, in seconds. */
  function bundle(): number {
    void ctx?.resume()
    beep(880, 0, 0.15)
    navigator.vibrate?.(200)
    return ALERT_SECONDS.bundle
  }

  /** A special request: two notes going up, to tell it from a bundle drop's single beep and a no-throw house's three. */
  function request(): number {
    void ctx?.resume()
    beep(660, 0, 0.12)
    beep(880, 0.17, 0.2)
    navigator.vibrate?.([120, 80, 120])
    return ALERT_SECONDS.request
  }

  /** Off the route: two notes going down, to tell it from a special request's two going up. Says how long it takes, in seconds. */
  function offRoute(): number {
    void ctx?.resume()
    beep(784, 0, 0.12)
    beep(523, 0.18, 0.22)
    navigator.vibrate?.([150, 80, 250])
    return ALERT_SECONDS.offRoute
  }

  /**
   * A bundle drop was confirmed: a quick tick of two notes going up, short and quiet, to say the tap was taken. Higher and softer than
   * a special request's two notes, so it is not taken for an alert. Says how long it takes, in seconds.
   */
  function dropped(): number {
    void ctx?.resume()
    beep(988, 0, 0.07, DROPPED_GAIN)
    beep(1319, 0.09, 0.09, DROPPED_GAIN)
    navigator.vibrate?.(40)
    return DROPPED_SECONDS
  }

  /** iOS Safari has no Vibration API, so the sound and red flash carry this alert. */
  function noThrow(): number {
    void ctx?.resume()
    beep(440, 0, 0.25)
    beep(440, 0.35, 0.25)
    beep(440, 0.7, 0.25)
    navigator.vibrate?.([300, 150, 300, 150, 300])
    return ALERT_SECONDS.nothrow
  }

  /** A short tick, to open the audio link just before a spoken word. Says how long it lasts, in seconds. */
  function tick(): number {
    beep(1200, 0, TICK_SECONDS, 0.12)
    return TICK_SECONDS
  }

  /** Start the near-silent signal, from a tap. It keeps the link to a car or speaker open between sounds. */
  function startKeepAlive() {
    if (!ctx || keep) return
    try {
      const rate = ctx.sampleRate
      const buffer = ctx.createBuffer(1, rate * 2, rate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
      const source = ctx.createBufferSource()
      const gain = ctx.createGain()
      source.buffer = buffer
      source.loop = true
      gain.gain.value = KEEP_ALIVE_GAIN
      source.connect(gain).connect(ctx.destination)
      source.start()
      keep = source
    } catch {
      // No keep-alive; the tick before each word is the next best thing.
    }
  }

  function stopKeepAlive() {
    try {
      keep?.stop()
      keep?.disconnect()
    } catch {
      // Already stopped.
    }
    keep = null
  }

  return { unlock, ready, bundle, request, noThrow, offRoute, dropped, tick, startKeepAlive, stopKeepAlive, keepingAlive: () => keep !== null }
}

/** The sound of the app, on the phone's own audio. */
export const sound = createSound(() => new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)())
