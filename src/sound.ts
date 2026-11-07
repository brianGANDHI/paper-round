/**
 * Sounds: the beeps that go with a stop's alert, the quiet tone that confirms a bundle drop, the tick and the soft opener that open the
 * audio link before a spoken word, and a near-silent signal that keeps that link open.
 *
 * A phone sending sound to a car or a speaker over Bluetooth lets the link go idle between sounds, and the first
 * fraction of a second of the next one is lost while it wakes: the start of a spoken turn goes missing. Waiting
 * doesn't help, since nothing is sent while waiting. Something has to be sent first.
 */

/** How long each stop alert's beeps last, in seconds: the voice waits this long to follow one. */
export const ALERT_SECONDS = { bundle: 0.15, block: 0.27, request: 0.37, nothrow: 0.95, offRoute: 0.4 } as const

/** How long the tone that confirms a bundle drop lasts, in seconds. */
export const DROPPED_SECONDS = 0.18

/** How loud that tone is: well under the alerts' 0.3, since it answers a tap and is not asking for attention. */
const DROPPED_GAIN = 0.1

/**
 * How loud the keep-alive signal is at its peak: about 44 decibels below full scale. It was 56, which a car's silence gate or the
 * Bluetooth codec could take for nothing to send. This is still not heard in a moving car, as it is low down, where the road is loudest.
 */
export const KEEP_ALIVE_GAIN = 0.006

/** Where the filter over the keep-alive noise starts to take the top off it, in hertz: low enough to sit under the road's rumble. */
const KEEP_ALIVE_CUTOFF_HZ = 400

/** How long the tick before a spoken word lasts, in seconds. */
export const TICK_SECONDS = 0.06

/** How long the opener before a spoken word lasts, in seconds: long enough for a link that has gone idle to wake on it, as a tick is not. */
export const OPENER_SECONDS = 0.3

/** How loud the opener is: well under the tick's 0.12, as it is longer, and comes before every word after a silence. */
const OPENER_GAIN = 0.05

/** The pitch of the opener, in hertz: low and soft, and not the pitch of any alert. */
const OPENER_HZ = 330

/** How long the opener takes to fade in and out, in seconds, so that it does not start with a click. */
const OPENER_FADE_SECONDS = 0.05

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Fills `data` with noise put through a one-pole low-pass filter, scaled so that its peak is 1. The filter goes round the noise twice and
 * only the second time is kept, so that the end of the buffer leads into its start: it loops, and a step there would be a click every time.
 */
function fillRumble(data: Float32Array, rate: number) {
  const noise = Float32Array.from(data, () => Math.random() * 2 - 1)
  const pull = 1 - Math.exp((-2 * Math.PI * KEEP_ALIVE_CUTOFF_HZ) / rate)
  let level = 0
  for (const x of noise) level += pull * (x - level)
  let peak = 0
  for (let i = 0; i < data.length; i++) {
    level += pull * (noise[i] - level)
    data[i] = level
    peak = Math.max(peak, Math.abs(level))
  }
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] /= peak
}

export function createSound(makeContext: () => AudioContext, sleep: (ms: number) => Promise<void> = sleepFor, now: () => number = () => Date.now()) {
  let ctx: AudioContext | null = null
  let keep: AudioBufferSourceNode | null = null
  /** When the last beep, tick or opener ends or ended, by the clock in milliseconds: see `lastSound`. */
  let lastOut = -Infinity

  /** Whether the audio is running now. Read afresh each time: the state changes under us, and iOS has one ("interrupted") the standard doesn't. */
  const running = (c: AudioContext | null) => (c?.state as string) === 'running'

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
    if (running(c)) return true
    const wake = () => Promise.race([c.resume().catch(() => undefined), sleep(250)])
    await wake()
    if (!running(c)) {
      // Resuming sometimes never finishes; stopping it first, and trying again a moment later, usually gets it going. Stopping can stick
      // the same way, and the voice waits on this, so it is given no longer than a resume is.
      await Promise.race([c.suspend().catch(() => undefined), sleep(250)])
      await sleep(200)
      await wake()
    }
    return running(c)
  }

  /**
   * Tries, without waiting, to bring back audio that has gone to sleep while nothing was being played. A call or Siri stops it, and with
   * it the keep-alive signal, and nothing else would bring it back until the next word was due, by when the link has gone idle. For
   * calling on every fix: it does nothing unless the audio is asleep, and it can't always work, as iOS may hold on to the audio for a while.
   */
  function nudge() {
    const c = ctx
    if (!c || !['interrupted', 'suspended'].includes(c.state)) return
    try {
      c.resume().catch(() => undefined)
    } catch {
      // It stays asleep; `ready` tries harder when there is something to play.
    }
  }

  /** Plays a note, and says whether it could. It never throws: the alerts are called from the round's screen, where nothing would catch it. */
  function beep(freq: number, start: number, dur: number, gain = 0.3, fade = 0): boolean {
    if (!ctx) return false
    try {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      const at = ctx.currentTime + start
      o.frequency.value = freq
      g.gain.value = gain
      if (fade > 0) {
        g.gain.setValueAtTime(0, at)
        g.gain.linearRampToValueAtTime(gain, at + fade)
        g.gain.setValueAtTime(gain, at + dur - fade)
        g.gain.linearRampToValueAtTime(0, at + dur)
      }
      o.connect(g).connect(ctx.destination)
      o.start(at)
      o.stop(at + dur)
      lastOut = Math.max(lastOut, now() + (start + dur) * 1000)
      return true
    } catch {
      // No note; visual alerts still work, and the words that follow.
      return false
    }
  }

  /** Wakes the audio as an alert goes off, in case it fell asleep. Like `beep`, it never throws. */
  function wakeForAlert() {
    try {
      ctx?.resume().catch(() => undefined)
    } catch {
      // It stays asleep, and the beep is not heard.
    }
  }

  /** Buzzes the phone where it can. Like `beep`, it never throws: a buzz that fails must not take the alert's words and banner with it. */
  function buzz(pattern: VibratePattern) {
    try {
      navigator.vibrate?.(pattern)
    } catch {
      // No buzz; the beep and the banner still went out.
    }
  }

  /** Each alert says how long it lasts, in seconds, played or not, so the words that follow it keep their time. */
  function bundle(): number {
    wakeForAlert()
    beep(880, 0, 0.15)
    buzz(200)
    return ALERT_SECONDS.bundle
  }

  /**
   * An apartment block: two short notes of the same pitch, a little lower than a bundle drop's single beep, to tell it from that, from a
   * special request's two going up and from a no-throw house's three low ones. A block has nothing to tap, unlike a bundle drop, so the
   * driver can tell by ear which it is.
   */
  function block(): number {
    wakeForAlert()
    beep(740, 0, 0.1)
    beep(740, 0.17, 0.1)
    buzz([100, 70, 100])
    return ALERT_SECONDS.block
  }

  /** A special request: two notes going up, to tell it from a bundle drop's single beep and a no-throw house's three. */
  function request(): number {
    wakeForAlert()
    beep(660, 0, 0.12)
    beep(880, 0.17, 0.2)
    buzz([120, 80, 120])
    return ALERT_SECONDS.request
  }

  /** Off the route: two notes going down, to tell it from a special request's two going up. Says how long it takes, in seconds. */
  function offRoute(): number {
    wakeForAlert()
    beep(784, 0, 0.12)
    beep(523, 0.18, 0.22)
    buzz([150, 80, 250])
    return ALERT_SECONDS.offRoute
  }

  /**
   * A bundle drop was confirmed: a quick tick of two notes going up, short and quiet, to say the tap was taken. Higher and softer than
   * a special request's two notes, so it is not taken for an alert. Says how long it takes, in seconds.
   */
  function dropped(): number {
    wakeForAlert()
    beep(988, 0, 0.07, DROPPED_GAIN)
    beep(1319, 0.09, 0.09, DROPPED_GAIN)
    buzz(40)
    return DROPPED_SECONDS
  }

  /** iOS Safari has no Vibration API, so the sound and red flash carry this alert. */
  function noThrow(): number {
    wakeForAlert()
    beep(440, 0, 0.25)
    beep(440, 0.35, 0.25)
    beep(440, 0.7, 0.25)
    buzz([300, 150, 300, 150, 300])
    return ALERT_SECONDS.nothrow
  }

  /** A short tick, to open the audio link just before a spoken word. Says how long it lasts, in seconds: none if it was not played. */
  function tick(): number {
    return beep(1200, 0, TICK_SECONDS, 0.12) ? TICK_SECONDS : 0
  }

  /**
   * A soft low note with a fade at each end, to open a link nothing has been sent down for a while, where the keep-alive signal is off or
   * asleep: a tick is over before such a link has woken. Says how long it lasts, in seconds: none if it was not played.
   */
  function opener(): number {
    return beep(OPENER_HZ, 0, OPENER_SECONDS, OPENER_GAIN, OPENER_FADE_SECONDS) ? OPENER_SECONDS : 0
  }

  /** Start the near-silent signal, from a tap. It keeps the link to a car or speaker open between sounds. */
  function startKeepAlive() {
    if (!ctx || keep) return
    try {
      const rate = ctx.sampleRate
      const buffer = ctx.createBuffer(1, rate * 2, rate)
      fillRumble(buffer.getChannelData(0), rate)
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

  return {
    unlock,
    ready,
    nudge,
    bundle,
    block,
    request,
    noThrow,
    offRoute,
    dropped,
    tick,
    opener,
    startKeepAlive,
    stopKeepAlive,
    /** Whether the signal is keeping the link open now: it has been started, and the audio it plays on is running, not stopped by a call or Siri. */
    keepingAlive: () => keep !== null && running(ctx),
    /** When a beep, tick or opener last went out, by the clock in milliseconds: one still playing counts to when it ends. */
    lastSound: () => lastOut,
  }
}

/** The sound of the app, on the phone's own audio. */
export const sound = createSound(() => new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)())
