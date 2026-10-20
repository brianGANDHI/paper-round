import { sound } from './sound'

/**
 * Saying things out loud, for the voice directions and the house numbers. It uses the phone's own speech, so it
 * works with no signal. Nothing here throws: where the phone won't speak, what is on the screen still shows.
 *
 * One thing is said at a time. A newer cue replaces one that is still waiting, since on the road only the latest word
 * matters, and an urgent cue breaks in on what is being said. Before the words, a tick opens the audio link to a car
 * or speaker (or the keep-alive signal already has), because the first part of a sound sent down a link that has gone
 * idle is lost, which is the start of a spoken turn going missing.
 */

/** The wait between the tick and the first word, in milliseconds, so the word starts while the tick is still on the link. */
const LEAD_MS = 120
/** The wait between stopping what is being said and saying the urgent thing that cut it off. */
const CANCEL_GAP_MS = 80
/** The wait between one cue ending and the next, in milliseconds, so the two don't run together. */
const FLUSH_GAP_MS = 200
/** How long a word may take to start before it is tried again, in milliseconds. */
const WATCHDOG_MS = 2500

/** Whether this browser can speak at all. */
export function speechAvailable(): boolean {
  return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'
}

/** English, in the phone's own kind of English where it has one, so distances are said the way they are written here. */
export function voiceLanguage(): string {
  const lang = typeof navigator === 'undefined' ? '' : navigator.language
  return /^en\b/i.test(lang) ? lang : 'en-AU'
}

/** The voice to use for a language: one for exactly that, or else one for the same language elsewhere, or none (the phone's own choice). */
export function pickVoice<V extends { lang: string; localService?: boolean }>(voices: V[], lang: string): V | undefined {
  const same = (a: string, b: string) => a.replace('_', '-').toLowerCase() === b.toLowerCase()
  const primary = lang.split(/[-_]/)[0].toLowerCase()
  const exact = voices.filter((v) => same(v.lang, lang))
  const near = voices.filter((v) => v.lang.split(/[-_]/)[0].toLowerCase() === primary)
  // One that is on the phone starts faster than one it has to fetch.
  const best = (list: V[]) => list.find((v) => v.localService) ?? list[0]
  return best(exact) ?? best(near)
}

export interface SayOptions {
  /** Breaks in on what is being said, rather than waiting its turn. */
  urgent?: boolean
  /** Asked just before the words start: true when they are out of date by then, such as a turn already made. */
  stale?: () => boolean
  /** Waits at least this long before the words, in milliseconds: a beep that has just started needs time to finish. */
  afterMs?: number
}

interface Cue {
  text: string
  urgent: boolean
  stale?: () => boolean
  afterMs: number
}

type Utterance = { lang: string; volume: number; voice: unknown; onstart: unknown; onend: unknown; onerror: unknown }

export interface SpeakerDeps<U extends Utterance> {
  speak: (u: U) => void
  cancel: () => void
  resume: () => void
  paused: () => boolean
  voices: () => { lang: string; localService?: boolean }[]
  makeUtterance: (text: string) => U
  /** Makes sure sound can play. */
  ready: () => Promise<boolean>
  /** Whether a signal is already keeping the link open. */
  keepingAlive: () => boolean
  /** Plays the opening tick, and says how long it lasts, in seconds. */
  tick: () => number
  language: () => string
  wait: (ms: number) => Promise<void>
}

export function createSpeaker<U extends Utterance>(deps: SpeakerDeps<U>) {
  /** Bumped when everything in progress is to be abandoned, so late callbacks from it do nothing. */
  let epoch = 0
  /** A cue is being got ready, said, or waited out. */
  let busy = false
  /** The utterance being said, held so it isn't lost before it is finished. */
  const held: { current: U | null } = { current: null }
  let waiting: Cue | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null

  const settle = (mine: number) => {
    if (mine !== epoch) return
    held.current = null
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
    const next = waiting
    waiting = null
    if (!next) {
      busy = false
      return
    }
    void deps.wait(FLUSH_GAP_MS).then(() => {
      if (mine === epoch) void run(next, mine)
    })
  }

  function voiced(u: U): U {
    u.lang = deps.language()
    const voice = pickVoice(deps.voices(), u.lang)
    if (voice) u.voice = voice
    return u
  }

  function utter(cue: Cue, mine: number, retry: boolean) {
    const u = voiced(deps.makeUtterance(cue.text))
    let started = false
    u.onstart = () => {
      started = true
      if (watchdog) clearTimeout(watchdog)
      watchdog = null
    }
    u.onend = () => settle(mine)
    // Safari reports a cancelled word as an error, not as an end.
    u.onerror = () => settle(mine)
    held.current = u
    try {
      if (deps.paused()) deps.resume()
      deps.speak(u)
    } catch {
      settle(mine)
      return
    }
    watchdog = setTimeout(() => {
      if (started || mine !== epoch) return
      deps.cancel()
      if (!retry) return settle(mine)
      void deps.wait(CANCEL_GAP_MS).then(() => {
        if (mine === epoch) utter(cue, mine, false)
      })
    }, WATCHDOG_MS)
  }

  async function run(cue: Cue, mine: number): Promise<void> {
    busy = true
    try {
      if (cue.stale?.()) return settle(mine)
      await deps.ready()
      if (mine !== epoch) return
      let leadMs = LEAD_MS
      // A beep that has just started opens the link as well as a tick would, so there is no tick on top of it.
      if (!deps.keepingAlive() && cue.afterMs === 0) leadMs += deps.tick() * 1000
      await deps.wait(Math.max(leadMs, cue.afterMs))
      if (mine !== epoch) return
      if (cue.stale?.()) return settle(mine)
      utter(cue, mine, true)
    } catch {
      settle(mine)
    }
  }

  return {
    /** Say it, in its turn: after anything being said, unless urgent. A newer cue replaces one still waiting. */
    say(text: string, options: SayOptions = {}) {
      const cue: Cue = { text, urgent: options.urgent ?? false, stale: options.stale, afterMs: options.afterMs ?? 0 }
      if (!busy) {
        void run(cue, epoch)
      } else if (cue.urgent) {
        const mine = ++epoch
        waiting = null
        held.current = null
        if (watchdog) clearTimeout(watchdog)
        watchdog = null
        deps.cancel()
        void deps.wait(CANCEL_GAP_MS).then(() => {
          if (mine === epoch) void run(cue, mine)
        })
      } else {
        waiting = cue
      }
    },
    /** Stop talking, and drop anything waiting to be said. */
    stop() {
      epoch++
      busy = false
      held.current = null
      waiting = null
      if (watchdog) clearTimeout(watchdog)
      watchdog = null
      deps.cancel()
    },
    /** A silent word, said straight away from a tap: iOS only lets a page speak once it has. */
    unlock() {
      const u = voiced(deps.makeUtterance('Ready'))
      u.volume = 0
      deps.speak(u)
    },
    /** Whether anything is being got ready or said, or waiting. */
    busy: () => busy,
  }
}

/** The phone's own speech, and its sound. The globals are read when used, so a browser without them is simply silent. */
function browserSpeaker() {
  return createSpeaker<SpeechSynthesisUtterance>({
    speak: (u) => speechSynthesis.speak(u),
    cancel: () => speechSynthesis.cancel(),
    resume: () => speechSynthesis.resume(),
    paused: () => speechSynthesis.paused,
    voices: () => speechSynthesis.getVoices(),
    makeUtterance: (text) => new SpeechSynthesisUtterance(text),
    ready: () => sound.ready(),
    keepingAlive: () => sound.keepingAlive(),
    tick: () => sound.tick(),
    language: voiceLanguage,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
}

let speaker: ReturnType<typeof browserSpeaker> | null = null
const shared = () => (speaker ??= browserSpeaker())

/** Say it, in its turn. Does nothing where the phone can't speak. */
export function say(text: string, options?: SayOptions): void {
  if (!speechAvailable()) return
  try {
    shared().say(text, options)
  } catch {
    // The phone won't speak.
  }
}

/** Stop talking, and drop anything waiting to be said. */
export function stopSpeaking(): void {
  if (!speechAvailable() || !speaker) return
  try {
    speaker.stop()
  } catch {
    // Nothing to stop.
  }
}

/** Call from a tap handler: iOS only lets a page speak after a tap, so a word said silently here lets the later ones through. */
export function unlockSpeech(): void {
  if (!speechAvailable()) return
  try {
    shared().unlock()
  } catch {
    // The phone won't speak.
  }
}
