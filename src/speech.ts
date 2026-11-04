import { sound } from './sound'

/**
 * Saying things out loud, for the voice directions and the house numbers. It uses the phone's own speech, so it
 * works with no signal. Nothing here throws: where the phone won't speak, what is on the screen still shows.
 *
 * One thing is said at a time. A newer cue replaces one that is still waiting, since on the road only the latest word
 * matters, and an urgent cue breaks in on what is being said. Cues said whole are the exception to both: a queued cue (a short word
 * that must be heard, such as the side now being thrown) and an urgent cue said whole (an alert's words) are never replaced by a
 * newer cue, and an ordinary urgent cue does not break in on them but follows them. They have a rank, by what matters on the road:
 * words that warn of a wrong throw (a no-throw house) and a queued cue first, and the same, then other alerts' words. One asked while
 * one of a lower rank is being said breaks in on it, and the words cut off are said again in full right after it; one asked while one
 * of the same or a higher rank is being said waits, ahead of those waiting of a lower rank and behind those of its own rank asked before
 * it. So a warning and a side word never cut each other off, and are said in the order asked. Words that are out of date by the time
 * their turn comes are left out, but those a queued cue cut off part way only a moment ago are said again all the same, as they waited
 * out no more than a word, the first time only (see `CUT_GRACE_MS`). Before the words, a tick opens the audio link to a car or speaker (or
 * the keep-alive signal already has), because the first part of a sound sent down a link that has gone idle is lost, which is the start
 * of a spoken turn going missing.
 */

/** The wait between the tick and the first word, in milliseconds, so the word starts while the tick is still on the link. */
const LEAD_MS = 120
/** The wait between stopping what is being said and saying the urgent thing that cut it off. */
const CANCEL_GAP_MS = 80
/** The wait between one cue ending and the next, in milliseconds, so the two don't run together. */
const FLUSH_GAP_MS = 200
/** How long a word may take to start before it is tried again, in milliseconds. */
const WATCHDOG_MS = 2500
/** The most cues said whole kept waiting: past this the one that matters least is let go (see `trim` in `createSpeaker`). */
export const QUEUE_MAX = 4

/**
 * How long after a queued cue cuts off the words being said they are said again even if out of date by their turn, in milliseconds. They
 * wait out only that one word, but at speed the car can go by all they name meanwhile, and a request's note or a block's side, begun as
 * the car came up to it, would then never be finished. Past this they are left out when out of date, as any words are. It is given once,
 * at the first such cut: words cut off again by a later queued cue (the side changing again before they are over) are left out if out of
 * date by their turn, so long words are not begun again at every change, ever further behind the car, holding up the alerts after them.
 * Words cut off before they were begun (still waiting out their beep, as when an alert's words and the side word are asked for on one
 * fix) lost nothing, and are not given it then: they keep it for the first cut that takes words from them.
 */
export const CUT_GRACE_MS = 2000

/**
 * The kinds of cue said whole (see `SayOptions`): words that warn of a wrong throw (`warning`), a queued word such as the side now thrown
 * (`queue`), and other alerts' words (`whole`).
 */
type Kind = 'warning' | 'queue' | 'whole'

/**
 * Their ranks, by what matters on the road. Words that stop a wrong throw and a queued word rank first, and the same: the queued word is
 * the side the driver asked to hear at each change, and is a single word, so neither holds the other up for long, and neither cuts the
 * other off. The other alerts' words come after them, as those alerts have their beep and banner as well.
 */
const RANK: Record<Kind, number> = { warning: 1, queue: 1, whole: 0 }

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
  /**
   * Breaks in on what is being said, rather than waiting its turn. On its own it does not break in on a cue said whole (`queue` or
   * `whole`), but is said after it and the cues said whole that wait.
   */
  urgent?: boolean
  /**
   * Said in full and in order: a newer cue never replaces it, and nothing cuts it off (an ordinary urgent cue, or words that warn of a
   * wrong throw, asked while it is said follow it). It waits behind an ordinary cue being said, and behind the queued cues and the warnings
   * (see `warning`) asked before it or being said. It breaks in on an alert's words said whole (see `whole`), which are said again in full
   * right after it, even if out of date by then when that is within `CUT_GRACE_MS` of the first cut by a queued cue once they were begun.
   * For a short word that must be heard as it is asked for, such as the side now thrown.
   */
  queue?: boolean
  /**
   * With urgent: it breaks in on an ordinary cue, as an urgent cue does, but is then said in full: a later ordinary urgent cue waits for
   * it and is said after it. Several that come while it is said are each said, in the order they came (a newer one never replaces one
   * said whole that waits). A queued cue or a warning (see `queue` and `warning`) asked while it is said does break in on it, and it is
   * then said again in full right after, unless it is out of date by then (cut off by a queued cue, only once `CUT_GRACE_MS` has gone by
   * since the first such cut after it was begun). For an alert's words, which the next alert must not cut short; give them `stale` as
   * well, so that when alerts come up faster than they can be said, the words whose turn comes too late are left out.
   */
  whole?: boolean
  /**
   * With urgent and whole: the words warn of a wrong throw (they name a no-throw house). They rank with a queued cue (see `queue`): they
   * break in on another alert's words said whole being said, which are said again in full right after them unless out of date by then,
   * and go before the other alerts' words that wait; but they do not break in on a queued cue or another warning being said, and wait
   * behind those asked before them. A queued cue is a single word, so it holds them up only for a moment.
   */
  warning?: boolean
  /** Asked just before the words start: true when they are out of date by then, such as a turn already made. */
  stale?: () => boolean
  /** Waits at least this long before the words, in milliseconds: a beep that has just started needs time to finish. */
  afterMs?: number
}

interface Cue {
  text: string
  urgent: boolean
  /** Its kind when it is said whole, or null for an ordinary cue. */
  kind: Kind | null
  stale?: () => boolean
  afterMs: number
  /** When it was asked for, so a wait for a beep is counted from then and not from when its turn came. */
  at: number
  /** It has been given the grace for words a queued cue cut off (see `again`), which it is given only once. */
  graced?: boolean
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
  /** The time in milliseconds, for how long a cue has waited. The clock by default. */
  now?: () => number
}

export function createSpeaker<U extends Utterance>(deps: SpeakerDeps<U>) {
  /** Bumped when everything in progress is to be abandoned, so late callbacks from it do nothing. */
  let epoch = 0
  /** A cue is being got ready, said, or waited out. */
  let busy = false
  /** That cue, from when it is taken up until the next is, so an urgent cue knows whether it may break in. */
  let current: Cue | null = null
  /** The utterance being said, held so it isn't lost before it is finished. */
  const held: { current: U | null } = { current: null }
  /** The newest ordinary cue that is waiting its turn. */
  let waiting: Cue | null = null
  /** An ordinary urgent cue that could not break in, as a cue said whole was being said: it is next after the cues said whole that wait. */
  let waitingUrgent: Cue | null = null
  /** The cues said whole that wait: the highest rank first, and in a rank the oldest first. */
  let queued: Cue[] = []
  let watchdog: ReturnType<typeof setTimeout> | null = null
  const now = deps.now ?? (() => Date.now())

  /** Whether a cue's words are out of date now (see `SayOptions.stale`). One whose check fails is taken to be, as it can't be said. */
  const outOfDate = (cue: Cue): boolean => {
    try {
      return cue.stale?.() ?? false
    } catch {
      return true
    }
  }

  /** A cue's rank (see `RANK`): an ordinary cue's is below them all. */
  const rankOf = (cue: Cue): number => (cue.kind ? RANK[cue.kind] : -1)

  /**
   * Puts a cue said whole among those waiting: after those of its rank and higher, so it is said in the order asked. Words that were cut
   * off (`again`) go before those of their rank instead, as they were asked for before them.
   */
  const put = (cue: Cue, again = false) => {
    const rank = rankOf(cue)
    const at = queued.findIndex((q) => (again ? rankOf(q) <= rank : rankOf(q) < rank))
    queued.splice(at < 0 ? queued.length : at, 0, cue)
  }

  /**
   * The words `cut`, which `by` has just cut off, as they are to be said again. Cut off by a queued cue once `begun`, they wait out that
   * one word, so they are not taken to be out of date until `CUT_GRACE_MS` after the cut, and only then by their own check. That grace is
   * given once: cut off by a queued cue again, they keep only what is left of the first. Cut off before they were begun, they keep it.
   */
  const again = (cut: Cue, by: Cue, begun: boolean): Cue => {
    const stale = cut.stale
    // Once only (see `CUT_GRACE_MS`): cut off again, they keep what is left of the first cut's grace and get no more.
    if (by.kind !== 'queue' || !stale || cut.graced) return cut
    // Cut off before a word of them was said (still waiting out their beep, as when an alert comes up on the fix where the side word is
    // asked for), they have lost nothing: they only wait, as if asked after the queued cue, and keep the grace for a cut that takes words
    // from them. Spent here, the side changing again while they are said would leave them out part way, never heard whole.
    if (!begun) return cut
    const cutAt = now()
    return { ...cut, graced: true, stale: () => now() - cutAt > CUT_GRACE_MS && stale() }
  }

  /**
   * Past QUEUE_MAX waiting, lets go of the one that matters least, so a burst does not leave a backlog behind the car: one already out
   * of date, else the oldest of the other alerts' words, else the oldest warning, and a queued cue (the side word, which the driver asked
   * to hear) only when nothing else is waiting.
   */
  const trim = () => {
    while (queued.length > QUEUE_MAX) {
      const drop = queued.find(outOfDate) ?? queued.find((q) => q.kind === 'whole') ?? queued.find((q) => q.kind === 'warning') ?? queued[0]
      queued.splice(queued.indexOf(drop), 1)
    }
  }

  /**
   * The cue to say next: those said whole that wait, by rank and in order, then an urgent one, then the newest ordinary one. Any out of
   * date already are passed over here, so that no gap is left for them: where alerts have come up faster than they can be said, the
   * words for the stop still ahead are not held up by those for the stops gone by.
   */
  const takeNext = (): Cue | null => {
    for (;;) {
      let next = queued.shift() ?? null
      if (!next) {
        next = waitingUrgent
        waitingUrgent = null
      }
      if (!next) {
        next = waiting
        waiting = null
      }
      if (!next || !outOfDate(next)) return next
    }
  }

  const settle = (mine: number) => {
    if (mine !== epoch) return
    held.current = null
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
    const next = takeNext()
    current = next
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
    current = cue
    try {
      if (cue.stale?.()) return settle(mine)
      await deps.ready()
      if (mine !== epoch) return
      let leadMs = LEAD_MS
      // A beep that has just started opens the link as well as a tick would, so there is no tick on top of it.
      if (!deps.keepingAlive() && cue.afterMs === 0) leadMs += deps.tick() * 1000
      // A wait for a beep is counted from when the words were asked for: one that has been waiting its turn has less of it to wait.
      await deps.wait(Math.max(leadMs, cue.afterMs - (now() - cue.at)))
      if (mine !== epoch) return
      if (cue.stale?.()) return settle(mine)
      utter(cue, mine, true)
    } catch {
      settle(mine)
    }
  }

  /** Stops what is being said, or got ready, and says `first` instead, a moment later. */
  const breakIn = (first: Cue) => {
    const mine = ++epoch
    held.current = null
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
    deps.cancel()
    current = first
    void deps.wait(CANCEL_GAP_MS).then(() => {
      if (mine === epoch) void run(first, mine)
    })
  }

  return {
    /**
     * Say it, in its turn: after anything being said, unless urgent. A newer cue replaces one still waiting. A cue said whole (see
     * `SayOptions.queue` and `SayOptions.whole`) is never replaced, and is cut off only by one of a higher rank, after which it is said
     * again in full; an ordinary urgent cue waits for it.
     */
    say(text: string, options: SayOptions = {}) {
      const urgent = options.urgent ?? false
      const whole = urgent && (options.whole ?? false)
      const cue: Cue = {
        text,
        urgent,
        kind: options.queue ? 'queue' : whole ? (options.warning ? 'warning' : 'whole') : null,
        stale: options.stale,
        afterMs: options.afterMs ?? 0,
        at: now(),
      }
      if (!busy) return void run(cue, epoch)
      if (cue.kind && current?.kind) {
        // Both said whole. One that matters more breaks in, and the words it cuts off are said again in full right after it (see
        // `again`); otherwise it waits, ahead of those that matter less and behind those that matter as much asked before it.
        if (rankOf(cue) > rankOf(current)) {
          // Begun once handed to the phone (`held`): until then they are waiting out their beep, the lead-in or the gap after a cue.
          put(again(current, cue, held.current !== null), true)
          put(cue)
          trim()
          breakIn(queued.shift() ?? cue)
        } else {
          put(cue)
          trim()
        }
      } else if (cue.kind) {
        put(cue)
        trim()
        // An alert's words break in on an ordinary cue, as any urgent cue does, after the cues waiting that matter as much or more. A
        // queued cue waits for it.
        if (cue.kind !== 'queue') {
          waiting = null
          breakIn(queued.shift() ?? cue)
        }
      } else if (cue.urgent) {
        // A cue said whole is said in full: the urgent one follows it, and the others that wait.
        if (current?.kind) {
          waitingUrgent = cue
          return
        }
        waiting = null
        // The cues said whole that wait are said first, then it.
        const first = queued.shift() ?? cue
        if (first !== cue) waitingUrgent = cue
        breakIn(first)
      } else {
        waiting = cue
      }
    },
    /** Stop talking, and drop anything waiting to be said. */
    stop() {
      epoch++
      busy = false
      current = null
      held.current = null
      waiting = null
      waitingUrgent = null
      queued = []
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
    now: () => Date.now(),
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
