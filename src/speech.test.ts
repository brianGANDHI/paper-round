import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COLD_MS,
  createSpeaker,
  CUT_GRACE_MS,
  END_ALLOW_MS,
  END_WORD_MS,
  LEAD_IN,
  LEAD_IN_ALLOW_MS,
  pickVoice,
  QUEUE_MAX,
  say,
  speechAvailable,
  stopSpeaking,
  unlockSpeech,
  voiceLanguage,
  WATCHDOG_MS,
} from './speech'

interface FakeUtterance {
  text: string
  lang: string
  volume: number
  voice: unknown
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

/** A stand-in for the phone's speech and sound: what happened, in order, and a way to play the part of the phone. */
function fake(options: { keepAlive?: boolean; voices?: { lang: string; localService?: boolean; name?: string }[]; readyResult?: boolean; readyMs?: number } = {}) {
  const log: string[] = []
  const said: FakeUtterance[] = []
  const state = {
    paused: false,
    keepAlive: options.keepAlive ?? false,
    throwOnSpeak: false,
    /** How many more lots of words the phone reports as failed the moment they are handed over. */
    failAsHanded: 0,
    /** It throws as well, having reported that. */
    throwAfterFail: false,
    throwOnMake: false,
  }
  const speaker = createSpeaker<FakeUtterance>({
    speak: (u) => {
      if (state.throwOnSpeak) throw new Error('no')
      log.push(`speak ${u.text}`)
      said.push(u)
      if (state.failAsHanded > 0) {
        state.failAsHanded--
        u.onerror?.()
        if (state.throwAfterFail) throw new Error('no')
      }
    },
    cancel: () => void log.push('cancel'),
    resume: () => void log.push('resume'),
    paused: () => state.paused,
    voices: () => options.voices ?? [],
    makeUtterance: (text) => {
      if (state.throwOnMake) throw new Error('no')
      return { text, lang: '', volume: 1, voice: undefined, onstart: null, onend: null, onerror: null }
    },
    ready: async () => {
      log.push('ready')
      if (options.readyMs) await new Promise((resolve) => setTimeout(resolve, options.readyMs))
      return options.readyResult ?? true
    },
    keepingAlive: () => state.keepAlive,
    tick: () => {
      log.push('tick')
      return 0.06
    },
    language: () => 'en-GB',
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  /** The phone starts saying the latest word, and later finishes it. */
  const start = () => said.at(-1)?.onstart?.()
  const end = () => said.at(-1)?.onend?.()
  return { speaker, log, said, state, start, end }
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('saying something', () => {
  it('ticks first, then says the words a moment later, so the audio link is open for them', async () => {
    const { speaker, log } = fake()
    speaker.say('In 200 metres, turn left.')
    await advance(0)
    expect(log).toEqual(['ready', 'tick'])
    await advance(170)
    expect(log).toEqual(['ready', 'tick'])
    await advance(20)
    expect(log).toEqual(['ready', 'tick', 'speak In 200 metres, turn left.'])
  })

  it('skips the tick when a signal is already keeping the link open, and starts sooner', async () => {
    const { speaker, log } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(100)
    expect(log).toEqual(['ready'])
    await advance(30)
    expect(log).toEqual(['ready', 'speak Turn left.'])
  })

  it('says the words in the phone’s kind of English, with a voice for it when there is one', async () => {
    const voices = [
      { lang: 'en-US', localService: true, name: 'US' },
      { lang: 'en-GB', localService: false, name: 'GB online' },
      { lang: 'en-GB', localService: true, name: 'GB on the phone' },
    ]
    const { speaker, said } = fake({ voices })
    speaker.say('Turn left.')
    await advance(300)
    expect(said[0].lang).toBe('en-GB')
    expect(said[0].voice).toBe(voices[2])
  })

  it('leaves the voice to the phone when it has none for the language', async () => {
    const { speaker, said } = fake({ voices: [{ lang: 'fr-FR', localService: true }] })
    speaker.say('Turn left.')
    await advance(300)
    expect(said[0].voice).toBeUndefined()
  })

  it('does not tick over a beep that has just started, which opens the link itself', async () => {
    const { speaker, log } = fake()
    speaker.say('No throw, 14.', { afterMs: 400 })
    await advance(500)
    expect(log).toEqual(['ready', 'speak No throw, 14.'])
  })

  it('waits out a beep that has just started before the words', async () => {
    const { speaker, log } = fake({ keepAlive: true })
    speaker.say('No throw, 14.', { afterMs: 950 })
    await advance(900)
    expect(log).toEqual(['ready'])
    await advance(60)
    expect(log).toEqual(['ready', 'speak No throw, 14.'])
  })

  it('wakes speech that has been paused, before saying anything', async () => {
    const { speaker, log, state } = fake({ keepAlive: true })
    state.paused = true
    speaker.say('Turn left.')
    await advance(300)
    expect(log).toEqual(['ready', 'resume', 'speak Turn left.'])
  })

  it('says it even when sound would not wake', async () => {
    const { speaker, log } = fake({ keepAlive: true, readyResult: false })
    speaker.say('Turn left.')
    await advance(300)
    expect(log).toContain('speak Turn left.')
  })

  it('is busy from the moment it is asked until the words end', async () => {
    const { speaker, start, end } = fake({ keepAlive: true })
    expect(speaker.busy()).toBe(false)
    speaker.say('Turn left.')
    expect(speaker.busy()).toBe(true)
    await advance(300)
    start()
    expect(speaker.busy()).toBe(true)
    end()
    expect(speaker.busy()).toBe(false)
  })
})

describe('one thing at a time', () => {
  it('lets the words being said finish, and then says what was asked in the meantime', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    start()
    speaker.say('Second.')
    await advance(1000)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak First.'])
    end()
    await advance(150)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak First.'])
    // A little gap, then the lead-in, then the next.
    await advance(250)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak First.', 'speak Second.'])
  })

  it('says only the newest of several that wait, since the older are out of date', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    start()
    speaker.say('Second.')
    speaker.say('Third.')
    speaker.say('Fourth.')
    end()
    await advance(1000)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak First.', 'speak Fourth.'])
  })

  it('breaks in with an urgent word, stopping the one being said', async () => {
    const { speaker, log, start } = fake({ keepAlive: true })
    speaker.say('A turn.')
    await advance(300)
    start()
    speaker.say('No throw, 14.', { urgent: true })
    expect(log.at(-1)).toBe('cancel')
    await advance(60)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak A turn.'])
    await advance(200)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak A turn.', 'speak No throw, 14.'])
  })

  it('drops an ordinary word that was waiting when it breaks in', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('A turn.')
    await advance(300)
    start()
    speaker.say('Older.')
    speaker.say('No throw, 14.', { urgent: true })
    await advance(400)
    start()
    end()
    await advance(1000)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak A turn.', 'speak No throw, 14.'])
  })

  it('ignores the end of the words it broke in on, which arrives late', async () => {
    const { speaker, log, said, start } = fake({ keepAlive: true })
    speaker.say('A turn.')
    await advance(300)
    start()
    const old = said[0]
    speaker.say('Urgent.', { urgent: true })
    speaker.say('Waits.')
    old.onerror?.()
    old.onend?.()
    await advance(300)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak A turn.', 'speak Urgent.'])
    // Urgent is still being said, and what waits comes after it, not on top of it.
    expect(speaker.busy()).toBe(true)
  })

  it('goes on to what is waiting when the words fail part way', async () => {
    const { speaker, log, said, start } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    start()
    speaker.say('Second.')
    said[0].onerror?.()
    await advance(600)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak First.', 'speak Second.'])
  })

  it('drops words that are out of date by the time they are due, and is free again', async () => {
    const { speaker, log } = fake({ keepAlive: true })
    let out = false
    speaker.say('Turn left.', { stale: () => out })
    out = true
    await advance(500)
    expect(log).not.toContain('speak Turn left.')
    expect(speaker.busy()).toBe(false)
  })

  it('does not tick for words that are already out of date', async () => {
    const { speaker, log } = fake()
    speaker.say('Turn left.', { stale: () => true })
    await advance(500)
    expect(log).toEqual([])
  })

  it('drops words that went out of date while waiting for the audio', async () => {
    const { speaker, log } = fake({ keepAlive: true })
    let out = false
    speaker.say('Turn left.', { stale: () => out })
    await advance(50)
    out = true
    await advance(500)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual([])
    expect(speaker.busy()).toBe(false)
  })

  it('goes on to the next when the words it was about to say are out of date', async () => {
    const { speaker, log, start } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    start()
    let out = false
    speaker.say('Old.', { stale: () => out })
    out = true
    speaker.say('New.')
    await advance(1000)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak First.'])
  })
})

describe('queued words, such as the side now being thrown', () => {
  const spoken = (log: string[]) => log.filter((l) => l.startsWith('speak'))

  it('are said straight away when nothing is being said', async () => {
    const { speaker, log } = fake({ keepAlive: true })
    speaker.say('Starboard', { queue: true })
    await advance(200)
    expect(spoken(log)).toEqual(['speak Starboard'])
  })

  it('are not cut off by an urgent word, which is said as they end', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Starboard', { queue: true })
    await advance(200)
    start()
    speaker.say('No throw, 24, 28.', { urgent: true })
    await advance(1000)
    expect(log).not.toContain('cancel')
    expect(spoken(log)).toEqual(['speak Starboard'])
    end()
    await advance(150)
    expect(spoken(log)).toEqual(['speak Starboard'])
    await advance(250)
    expect(spoken(log)).toEqual(['speak Starboard', 'speak No throw, 24, 28.'])
    expect(log).not.toContain('cancel')
  })

  it('are said first when an urgent word is asked for at the very same moment', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Port', { queue: true })
    speaker.say('No throw, 14.', { urgent: true, afterMs: 600 })
    await advance(200)
    expect(spoken(log)).toEqual(['speak Port'])
    start()
    end()
    await advance(500)
    expect(spoken(log)).toEqual(['speak Port', 'speak No throw, 14.'])
    expect(log).not.toContain('cancel')
  })

  it('wait their turn behind an urgent word that is already being got ready', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('No throw, 14.', { urgent: true })
    speaker.say('Port', { queue: true })
    await advance(200)
    expect(spoken(log)).toEqual(['speak No throw, 14.'])
    start()
    end()
    await advance(500)
    expect(spoken(log)).toEqual(['speak No throw, 14.', 'speak Port'])
  })

  it('are said in order, and no newer word replaces one', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    start()
    speaker.say('Port', { queue: true })
    speaker.say('Transit', { queue: true })
    speaker.say('Older.')
    speaker.say('Newer.')
    for (let i = 0; i < 3; i++) {
      end()
      await advance(400)
      start()
    }
    end()
    await advance(400)
    expect(spoken(log)).toEqual(['speak First.', 'speak Port', 'speak Transit', 'speak Newer.'])
  })

  it('are said before the urgent word that broke in on an ordinary one, which follows them', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('In 200 metres, turn left.')
    await advance(300)
    start()
    speaker.say('Starboard', { queue: true })
    speaker.say('No throw, 24.', { urgent: true })
    // The ordinary word is broken in on, as an urgent word does, but the queued one is said before the urgent one.
    expect(log.at(-1)).toBe('cancel')
    await advance(300)
    expect(spoken(log)).toEqual(['speak In 200 metres, turn left.', 'speak Starboard'])
    start()
    end()
    await advance(400)
    expect(spoken(log)).toEqual(['speak In 200 metres, turn left.', 'speak Starboard', 'speak No throw, 24.'])
  })

  it('leave only the newest urgent word to follow them, and an ordinary word after that', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Starboard', { queue: true })
    await advance(200)
    start()
    speaker.say('No throw, 14.', { urgent: true })
    speaker.say('No throw, 16.', { urgent: true })
    speaker.say('In 60 metres, turn left.')
    end()
    await advance(400)
    start()
    end()
    await advance(400)
    expect(spoken(log)).toEqual(['speak Starboard', 'speak No throw, 16.', 'speak In 60 metres, turn left.'])
  })

  it('keep only the newest few when more are asked for than can be said', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    start()
    const sides = ['Port', 'Starboard', 'Both', 'Transit', 'Port', 'Starboard']
    for (const side of sides) speaker.say(side, { queue: true })
    end()
    for (let i = 0; i < sides.length; i++) {
      await advance(400)
      start()
      end()
    }
    await advance(400)
    expect(spoken(log)).toEqual(['speak First.', ...sides.slice(-QUEUE_MAX).map((w) => `speak ${w}`)])
  })

  it('are dropped when they are out of date by the time they are due', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    start()
    let out = false
    speaker.say('Port', { queue: true, stale: () => out })
    speaker.say('Starboard', { queue: true })
    out = true
    end()
    await advance(400)
    start()
    end()
    await advance(400)
    expect(spoken(log)).toEqual(['speak First.', 'speak Starboard'])
  })

  it('are forgotten, with the urgent word that waits for them, when speech is stopped', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Starboard', { queue: true })
    await advance(200)
    start()
    speaker.say('Port', { queue: true })
    speaker.say('No throw, 14.', { urgent: true })
    speaker.stop()
    expect(speaker.busy()).toBe(false)
    await advance(2000)
    expect(spoken(log)).toEqual(['speak Starboard'])
    // Nor do they come back after the next word that is said.
    speaker.say('Turn left.')
    await advance(300)
    start()
    await advance(300)
    expect(spoken(log)).toEqual(['speak Starboard', 'speak Turn left.'])
    end()
    await advance(1000)
    expect(spoken(log)).toEqual(['speak Starboard', 'speak Turn left.'])
  })

  it('are forgotten, with an urgent word that waits for them, when speech is stopped and the stop is followed by words', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Starboard', { queue: true })
    await advance(200)
    start()
    speaker.say('No throw, 14.', { urgent: true })
    speaker.stop()
    speaker.say('Turn left.')
    await advance(300)
    start()
    end()
    await advance(1000)
    expect(spoken(log)).toEqual(['speak Starboard', 'speak Turn left.'])
  })

  it('are said before an urgent word that was asked for after them', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Starboard', { queue: true })
    await advance(200)
    start()
    speaker.say('Port', { queue: true })
    speaker.say('No throw, 14.', { urgent: true })
    end()
    await advance(400)
    start()
    end()
    await advance(400)
    expect(spoken(log)).toEqual(['speak Starboard', 'speak Port', 'speak No throw, 14.'])
  })

  it('are not cut off by an urgent word in the gap between the word before them and them', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('In 200 metres, turn left.')
    await advance(300)
    start()
    speaker.say('Starboard', { queue: true })
    end()
    // 'Starboard' is next, and is about to start.
    await advance(50)
    speaker.say('No throw, 14.', { urgent: true })
    expect(log).not.toContain('cancel')
    await advance(300)
    expect(spoken(log)).toEqual(['speak In 200 metres, turn left.', 'speak Starboard'])
    start()
    end()
    await advance(400)
    expect(spoken(log)).toEqual(['speak In 200 metres, turn left.', 'speak Starboard', 'speak No throw, 14.'])
    expect(log).not.toContain('cancel')
  })

  it('leave it free for the next word once they are said', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Starboard', { queue: true })
    await advance(200)
    start()
    end()
    expect(speaker.busy()).toBe(false)
    speaker.say('No throw, 14.', { urgent: true })
    await advance(300)
    expect(spoken(log)).toEqual(['speak Starboard', 'speak No throw, 14.'])
    expect(log).not.toContain('cancel')
  })
})

describe('an alert’s words, said whole', () => {
  const spoken = (log: string[]) => log.filter((l) => l.startsWith('speak'))
  const BLOCK = 'Apartment block, Lakeside Apartments, 12 papers, port.'

  it('are not cut off by the next alert, which is said right after them', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say(BLOCK, { urgent: true, whole: true })
    await advance(300)
    start()
    speaker.say('No throw, 17.', { urgent: true })
    await advance(2000)
    expect(log.slice(log.indexOf(`speak ${BLOCK}`))).not.toContain('cancel')
    end()
    // The gap between words, then the lead-in.
    await advance(200 + 120)
    expect(spoken(log).at(-1)).toBe('speak No throw, 17.')
    expect(spoken(log)).toEqual([`speak ${BLOCK}`, 'speak No throw, 17.'])
  })

  it('still break in on a turn being said, as any urgent words do', async () => {
    const { speaker, log, start } = fake({ keepAlive: true })
    speaker.say('In 200 metres, turn left.')
    await advance(300)
    start()
    speaker.say(BLOCK, { urgent: true, whole: true })
    expect(log.at(-1)).toBe('cancel')
    await advance(300)
    expect(spoken(log)).toEqual(['speak In 200 metres, turn left.', `speak ${BLOCK}`])
  })

  it('have every alert that comes while they are said follow them, in the order they came', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say(BLOCK, { urgent: true, whole: true })
    await advance(300)
    start()
    speaker.say('No throw, 17.', { urgent: true, whole: true })
    speaker.say('Bundle drop, Co-op, 12 papers.', { urgent: true, whole: true })
    for (let i = 0; i < 3; i++) {
      end()
      await advance(400)
      start()
    }
    expect(spoken(log)).toEqual([`speak ${BLOCK}`, 'speak No throw, 17.', 'speak Bundle drop, Co-op, 12 papers.'])
    expect(log).not.toContain('cancel')
  })

  it('are not cut off while they still wait for their beep, before they start', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say(BLOCK, { urgent: true, whole: true, afterMs: 270 })
    await advance(100)
    // The house comes up while the block's words still wait out its beep.
    speaker.say('No throw, 17.', { urgent: true, whole: true, afterMs: 950 })
    await advance(300)
    expect(spoken(log)).toEqual([`speak ${BLOCK}`])
    start()
    end()
    await advance(1000)
    expect(spoken(log)).toEqual([`speak ${BLOCK}`, 'speak No throw, 17.'])
    expect(log).not.toContain('cancel')
  })

  it('cut off no alert being said, which they follow', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('No throw, 17.', { urgent: true, whole: true })
    await advance(300)
    start()
    speaker.say(BLOCK, { urgent: true, whole: true })
    expect(log).not.toContain('cancel')
    end()
    await advance(400)
    expect(spoken(log)).toEqual(['speak No throw, 17.', `speak ${BLOCK}`])
  })

  it('are broken in on by a side word, and said again in full right after it, before the alert that waits for them', async () => {
    const { speaker, log, said, start, end } = fake({ keepAlive: true })
    speaker.say(BLOCK, { urgent: true, whole: true })
    await advance(300)
    start()
    speaker.say('Bundle drop, Co-op.', { urgent: true, whole: true })
    speaker.say('Starboard', { queue: true })
    expect(log.at(-1)).toBe('cancel')
    // Safari reports the words cut off as an error, which comes late and is not taken for the end of the side word.
    said[0].onerror?.()
    await advance(300)
    expect(spoken(log)).toEqual([`speak ${BLOCK}`, 'speak Starboard'])
    // An alert that comes while the side word is said follows it, after the words it cut off and the alert that waited for them.
    start()
    speaker.say('Special request, 14.', { urgent: true, whole: true })
    for (let i = 0; i < 3; i++) {
      end()
      await advance(400)
      start()
    }
    expect(spoken(log)).toEqual([`speak ${BLOCK}`, 'speak Starboard', `speak ${BLOCK}`, 'speak Bundle drop, Co-op.', 'speak Special request, 14.'])
    // The only words cut off were the first saying of the block's.
    expect(log.filter((l) => l === 'cancel')).toHaveLength(1)
  })

  it('are left out when they are out of date by their turn, and the next is said with no gap left for them', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    const gone = new Set<string>()
    const say = (text: string) => speaker.say(text, { urgent: true, whole: true, stale: () => gone.has(text) })
    say('Special request, 301. Leave it under the mat.')
    await advance(300)
    start()
    say('Special request, 303. Leave it under the mat.')
    say('Special request, 305. Leave it under the mat.')
    say('No throw, 17.')
    // By the end of the first, the car has gone by the next two.
    gone.add('Special request, 303. Leave it under the mat.')
    gone.add('Special request, 305. Leave it under the mat.')
    end()
    // One gap between words and the lead-in, as after any words: none for the two left out.
    await advance(200 + 120)
    expect(spoken(log)).toEqual(['speak Special request, 301. Leave it under the mat.', 'speak No throw, 17.'])
    start()
    end()
    await advance(2000)
    expect(spoken(log)).toHaveLength(2)
    expect(speaker.busy()).toBe(false)
  })

  it('that wait are let go past the most kept, the oldest first', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say(BLOCK, { urgent: true, whole: true })
    await advance(300)
    start()
    const houses = ['No throw, 1.', 'No throw, 3.', 'No throw, 5.', 'No throw, 7.', 'No throw, 9.', 'No throw, 11.']
    for (const h of houses) speaker.say(h, { urgent: true, whole: true })
    for (let i = 0; i < houses.length; i++) {
      end()
      await advance(400)
      start()
    }
    // The newest QUEUE_MAX wait to follow.
    expect(spoken(log)).toEqual([`speak ${BLOCK}`, ...houses.slice(-QUEUE_MAX).map((h) => `speak ${h}`)])
  })

  it('are forgotten, with the alerts that wait for them, when speech is stopped', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say(BLOCK, { urgent: true, whole: true })
    await advance(300)
    start()
    speaker.say('No throw, 17.', { urgent: true, whole: true })
    speaker.say('No throw, 19.', { urgent: true, whole: true })
    speaker.stop()
    expect(speaker.busy()).toBe(false)
    speaker.say('Turn left.')
    await advance(300)
    start()
    end()
    await advance(2000)
    expect(spoken(log)).toEqual([`speak ${BLOCK}`, 'speak Turn left.'])
  })
})

describe('the cues said whole, by what matters on the road', () => {
  const spoken = (log: string[]) => log.filter((l) => l.startsWith('speak'))
  const BLOCK = 'Apartment block, Lakeside Apartments, 12 papers, port.'
  const ALERT = { urgent: true, whole: true } as const
  const WARNING = { urgent: true, whole: true, warning: true } as const
  /** The phone ends the words being said, and starts the next a while later: `times` over. */
  const sayOn = async (f: ReturnType<typeof fake>, times: number) => {
    for (let i = 0; i < times; i++) {
      f.end()
      await advance(400)
      f.start()
    }
  }

  it('a warning breaks in on an alert said whole, which is said again in full right after it, with no beep to wait out again', async () => {
    const f = fake({ keepAlive: true })
    f.speaker.say(BLOCK, { ...ALERT, afterMs: 270 })
    await advance(400)
    f.start()
    f.speaker.say('No throw, 17.', { ...WARNING, afterMs: 950 })
    expect(f.log.at(-1)).toBe('cancel')
    // The warning waits out its own beep.
    await advance(900)
    expect(spoken(f.log)).toEqual([`speak ${BLOCK}`])
    await advance(100)
    expect(spoken(f.log)).toEqual([`speak ${BLOCK}`, 'speak No throw, 17.'])
    f.start()
    f.end()
    // The gap between words and the lead-in, and not the block's beep again: it was asked for long before.
    await advance(200 + 120)
    expect(spoken(f.log)).toEqual([`speak ${BLOCK}`, 'speak No throw, 17.', `speak ${BLOCK}`])
    f.start()
    f.end()
    await advance(2000)
    // The block's words are said again whole: the whole text, not cut off this time.
    expect(f.said.at(-1)?.text).toBe(BLOCK)
    expect(f.log.filter((l) => l === 'cancel')).toHaveLength(1)
    expect(f.speaker.busy()).toBe(false)
  })

  it('a warning does not break in on a side word being said, but follows it', async () => {
    const f = fake({ keepAlive: true })
    f.speaker.say('Starboard', { queue: true })
    await advance(200)
    f.start()
    f.speaker.say('No throw, 17.', WARNING)
    await advance(1000)
    expect(f.log).not.toContain('cancel')
    await sayOn(f, 1)
    f.end()
    await advance(1000)
    expect(spoken(f.log)).toEqual(['speak Starboard', 'speak No throw, 17.'])
    expect(f.log).not.toContain('cancel')
  })

  it('a side word asked on the same fix as a warning, after it, is said right after it', async () => {
    const f = fake({ keepAlive: true })
    // The round screen asks for the alert's words first, then the side word, so a no-throw row is begun before the house; both wait out
    // the beep.
    f.speaker.say('No throw, 17.', { ...WARNING, afterMs: 950 })
    f.speaker.say('Port', { queue: true, afterMs: 950 })
    await advance(1000)
    expect(spoken(f.log)).toEqual(['speak No throw, 17.'])
    f.start()
    f.end()
    // The gap between words and the lead-in: the beep was waited out with the row.
    await advance(200 + 120)
    expect(spoken(f.log)).toEqual(['speak No throw, 17.', 'speak Port'])
    expect(f.log).not.toContain('cancel')
  })

  it('a warning and a side word are said in the order asked, whichever is being said, and neither cuts the other off', async () => {
    const f = fake({ keepAlive: true })
    f.speaker.say('In 200 metres, turn left.')
    await advance(300)
    f.start()
    // The warning breaks in on the turn; the side words and the warning after it wait, each behind those asked before it.
    f.speaker.say('No throw, 1.', WARNING)
    await advance(300)
    f.start()
    f.speaker.say('Port', { queue: true })
    f.speaker.say('No throw, 3.', WARNING)
    f.speaker.say('Starboard', { queue: true })
    await sayOn(f, 3)
    f.end()
    await advance(1000)
    expect(spoken(f.log)).toEqual(['speak In 200 metres, turn left.', 'speak No throw, 1.', 'speak Port', 'speak No throw, 3.', 'speak Starboard'])
    // Only the turn was cut off.
    expect(f.log.filter((l) => l === 'cancel')).toHaveLength(1)
  })

  it('no cue breaks in on one of the same rank: it follows it', async () => {
    for (const [first, second, options] of [
      ['No throw, 17.', 'No throw, 21.', WARNING],
      ['Port', 'Starboard', { queue: true }],
      [BLOCK, 'Bundle drop, Co-op.', ALERT],
    ] as const) {
      const f = fake({ keepAlive: true })
      f.speaker.say(first, options)
      await advance(300)
      f.start()
      f.speaker.say(second, options)
      await advance(1000)
      expect(f.log, first).not.toContain('cancel')
      await sayOn(f, 1)
      f.end()
      await advance(1000)
      expect(spoken(f.log), first).toEqual([`speak ${first}`, `speak ${second}`])
    }
  })

  it('no cue breaks in on a warning: a side word and an alert asked while it is said follow it, the side word first', async () => {
    const f = fake({ keepAlive: true })
    f.speaker.say('No throw, 17.', WARNING)
    await advance(300)
    f.start()
    f.speaker.say(BLOCK, ALERT)
    f.speaker.say('Starboard', { queue: true })
    await advance(1000)
    expect(f.log).not.toContain('cancel')
    await sayOn(f, 2)
    f.end()
    await advance(1000)
    expect(spoken(f.log)).toEqual(['speak No throw, 17.', 'speak Starboard', `speak ${BLOCK}`])
  })

  it('those that wait go by rank, a warning and a side word being of one rank, and in a rank in the order asked', async () => {
    const f = fake({ keepAlive: true })
    f.speaker.say('No throw, 1.', WARNING)
    await advance(300)
    f.start()
    f.speaker.say('Special request, 2.', ALERT)
    f.speaker.say('Port', { queue: true })
    f.speaker.say('Bundle drop, 3.', ALERT)
    f.speaker.say('No throw, 4.', WARNING)
    await sayOn(f, 4)
    f.end()
    await advance(1000)
    expect(f.log).not.toContain('cancel')
    expect(spoken(f.log)).toEqual(['speak No throw, 1.', 'speak Port', 'speak No throw, 4.', 'speak Special request, 2.', 'speak Bundle drop, 3.'])
  })

  it('words cut off that are out of date by their turn are not said again', async () => {
    const f = fake({ keepAlive: true })
    let gone = false
    f.speaker.say(BLOCK, { ...ALERT, stale: () => gone })
    await advance(300)
    f.start()
    f.speaker.say('No throw, 17.', WARNING)
    await advance(300)
    f.start()
    // By the end of the warning, the car has gone by the block.
    gone = true
    f.end()
    await advance(2000)
    expect(spoken(f.log)).toEqual([`speak ${BLOCK}`, 'speak No throw, 17.'])
    expect(f.speaker.busy()).toBe(false)
  })

  it('words a side word cut off are said again right after it though out of date by then, as they waited out only that word', async () => {
    const f = fake({ keepAlive: true })
    let gone = false
    f.speaker.say(BLOCK, { ...ALERT, stale: () => gone })
    await advance(300)
    f.start()
    f.speaker.say('Both', { queue: true })
    expect(f.log.at(-1)).toBe('cancel')
    await advance(300)
    f.start()
    // As the side word is said, the car goes by the block.
    gone = true
    f.end()
    await advance(200 + 120)
    expect(spoken(f.log)).toEqual([`speak ${BLOCK}`, 'speak Both', `speak ${BLOCK}`])
    f.start()
    f.end()
    await advance(1000)
    expect(f.log.filter((l) => l === 'cancel')).toHaveLength(1)
    expect(f.speaker.busy()).toBe(false)
  })

  it('words a side word cut off are left out when out of date once CUT_GRACE_MS has gone by since the cut', async () => {
    const f = fake({ keepAlive: true })
    let gone = false
    f.speaker.say(BLOCK, { ...ALERT, stale: () => gone })
    await advance(300)
    f.start()
    f.speaker.say('Both', { queue: true })
    await advance(300)
    f.start()
    // A no-throw row comes up as the side word is said: it follows the side word, ahead of the block's words, and takes a while.
    f.speaker.say('No throw, 17, 19, 21, 23.', WARNING)
    gone = true
    await sayOn(f, 1)
    await advance(CUT_GRACE_MS)
    f.end()
    await advance(2000)
    expect(spoken(f.log)).toEqual([`speak ${BLOCK}`, 'speak Both', 'speak No throw, 17, 19, 21, 23.'])
    expect(f.speaker.busy()).toBe(false)
  })

  describe('words a side word cut off, said again and cut off by the next side word', () => {
    const NOTE = 'Special request, 301. Leave it under the mat by the side door please, not in the letterbox.'
    /** The note is cut off by Both, and the car goes by the request as Both is said; the note is said again all the same, and begun. */
    const upToAgain = async () => {
      const f = fake({ keepAlive: true })
      const car = { gone: false }
      f.speaker.say(NOTE, { ...ALERT, stale: () => car.gone })
      await advance(300)
      f.start()
      f.speaker.say('Both', { queue: true })
      await advance(300)
      f.start()
      car.gone = true
      f.end()
      await advance(200 + 120)
      expect(spoken(f.log)).toEqual([`speak ${NOTE}`, 'speak Both', `speak ${NOTE}`])
      f.start()
      return f
    }

    it('are left out once out of date: the grace is given once, and is not given again at the second cut', async () => {
      const f = await upToAgain()
      // Past the grace of the first cut, the side changes again before the note is over.
      await advance(CUT_GRACE_MS)
      f.speaker.say('Port', { queue: true })
      expect(f.log.at(-1)).toBe('cancel')
      await advance(300)
      f.start()
      f.end()
      await advance(2000)
      // Not begun a third time, ever further behind the car.
      expect(spoken(f.log)).toEqual([`speak ${NOTE}`, 'speak Both', `speak ${NOTE}`, 'speak Port'])
      expect(f.speaker.busy()).toBe(false)
    })

    it('are said again while the grace of the first cut lasts', async () => {
      const f = await upToAgain()
      await advance(100)
      f.speaker.say('Port', { queue: true })
      await advance(300)
      f.start()
      f.end()
      await advance(200 + 120)
      expect(spoken(f.log)).toEqual([`speak ${NOTE}`, 'speak Both', `speak ${NOTE}`, 'speak Port', `speak ${NOTE}`])
    })

    it('are given the grace at the first cut that takes words from them, when the first side word broke in before they were begun', async () => {
      const f = fake({ keepAlive: true })
      const car = { gone: false }
      // On one fix, as the round screen asks: the note, which waits out its beep, then Both, which breaks in on it before it is begun.
      f.speaker.say(NOTE, { ...ALERT, afterMs: 370, stale: () => car.gone })
      f.speaker.say('Both', { queue: true, afterMs: 370 })
      await advance(700)
      expect(spoken(f.log)).toEqual(['speak Both'])
      f.start()
      f.end()
      await advance(200 + 120)
      expect(spoken(f.log)).toEqual(['speak Both', `speak ${NOTE}`])
      f.start()
      // The note is said for longer than the grace a cut on the fix it was asked for would have left it; the car goes by the request,
      // and the side changes again.
      await advance(CUT_GRACE_MS)
      car.gone = true
      f.speaker.say('Port', { queue: true })
      expect(f.log.at(-1)).toBe('cancel')
      await advance(300)
      f.start()
      f.end()
      await advance(200 + 120)
      // Cut off part way for the first time, it is given the grace now, and said again in full.
      expect(spoken(f.log)).toEqual(['speak Both', `speak ${NOTE}`, 'speak Port', `speak ${NOTE}`])
      f.start()
      // Once only: cut off again once that grace is over, it is left out.
      await advance(CUT_GRACE_MS)
      f.speaker.say('Both', { queue: true })
      await advance(300)
      f.start()
      f.end()
      await advance(2000)
      expect(spoken(f.log)).toEqual(['speak Both', `speak ${NOTE}`, 'speak Port', `speak ${NOTE}`, 'speak Both'])
      expect(f.speaker.busy()).toBe(false)
    })
  })

  it('a warning or an alert breaks in on a turn being said, behind a side word that waits for the turn', async () => {
    for (const [alert, options, order] of [
      ['No throw, 17.', WARNING, ['Starboard', 'No throw, 17.']],
      [BLOCK, ALERT, ['Starboard', BLOCK]],
    ] as const) {
      const f = fake({ keepAlive: true })
      f.speaker.say('In 200 metres, turn left.')
      await advance(300)
      f.start()
      // A side word waits for an ordinary word being said, as before.
      f.speaker.say('Starboard', { queue: true })
      expect(f.log).not.toContain('cancel')
      f.speaker.say(alert, options)
      expect(f.log.at(-1)).toBe('cancel')
      await advance(300)
      await sayOn(f, 1)
      f.end()
      await advance(1000)
      expect(spoken(f.log), alert).toEqual(['speak In 200 metres, turn left.', ...order.map((w) => `speak ${w}`)])
    }
  })

  it('a turn that waits for an alert is kept when a side word breaks in on the alert, and is said after them', async () => {
    const f = fake({ keepAlive: true })
    f.speaker.say(BLOCK, ALERT)
    await advance(300)
    f.start()
    f.speaker.say('In 200 metres, turn left.')
    f.speaker.say('Starboard', { queue: true })
    await advance(300)
    await sayOn(f, 2)
    f.end()
    await advance(1000)
    expect(spoken(f.log)).toEqual([`speak ${BLOCK}`, 'speak Starboard', `speak ${BLOCK}`, 'speak In 200 metres, turn left.'])
  })

  it('an ordinary urgent word still breaks in on none of them, and follows those that wait', async () => {
    const f = fake({ keepAlive: true })
    f.speaker.say(BLOCK, ALERT)
    await advance(300)
    f.start()
    f.speaker.say('No throw, 17.', WARNING)
    await advance(300)
    f.start()
    f.speaker.say('Off the route.', { urgent: true })
    await sayOn(f, 2)
    f.end()
    await advance(1000)
    expect(spoken(f.log)).toEqual([`speak ${BLOCK}`, 'speak No throw, 17.', `speak ${BLOCK}`, 'speak Off the route.'])
    // Only the block was cut off, by the warning.
    expect(f.log.filter((l) => l === 'cancel')).toHaveLength(1)
  })

  describe('past the most kept waiting', () => {
    it('let go of the alerts, the oldest first, and keep the side word waiting', async () => {
      const f = fake({ keepAlive: true })
      f.speaker.say('No throw, 1.', WARNING)
      await advance(300)
      f.start()
      f.speaker.say('Both', { queue: true })
      const alerts = ['Special request, 2.', 'Apartment block, 3.', 'Bundle drop, 5.', 'Special request, 7.', 'Bundle drop, 9.', 'Apartment block, 11.']
      for (const a of alerts) f.speaker.say(a, ALERT)
      await sayOn(f, QUEUE_MAX)
      f.end()
      await advance(1000)
      expect(spoken(f.log)).toEqual(['speak No throw, 1.', 'speak Both', ...alerts.slice(-(QUEUE_MAX - 1)).map((a) => `speak ${a}`)])
    })

    it('let go of words already out of date before any others', async () => {
      const f = fake({ keepAlive: true })
      f.speaker.say('No throw, 1.', WARNING)
      await advance(300)
      f.start()
      f.speaker.say('Both', { queue: true })
      f.speaker.say('Special request, 2.', ALERT)
      let gone = false
      f.speaker.say('Apartment block, 3.', { ...ALERT, stale: () => gone })
      f.speaker.say('Bundle drop, 5.', ALERT)
      // The car goes by the block, and one more is asked for than are kept: the block's words go, and not the oldest.
      gone = true
      f.speaker.say('Special request, 7.', ALERT)
      await sayOn(f, QUEUE_MAX)
      f.end()
      await advance(1000)
      expect(spoken(f.log)).toEqual(['speak No throw, 1.', 'speak Both', 'speak Special request, 2.', 'speak Bundle drop, 5.', 'speak Special request, 7.'])
    })

    it('let go of the oldest warning before the side word, which keeps its place ahead of the warnings asked after it', async () => {
      const f = fake({ keepAlive: true })
      f.speaker.say('No throw, 1.', WARNING)
      await advance(300)
      f.start()
      f.speaker.say('Both', { queue: true })
      const houses = ['No throw, 3.', 'No throw, 5.', 'No throw, 7.', 'No throw, 9.']
      for (const h of houses) f.speaker.say(h, WARNING)
      await sayOn(f, QUEUE_MAX)
      f.end()
      await advance(1000)
      expect(spoken(f.log)).toEqual(['speak No throw, 1.', 'speak Both', ...houses.slice(1).map((h) => `speak ${h}`)])
    })
  })
})

describe('waiting for a beep that came with the words', () => {
  it('is counted from when the words were asked for, so words that waited their turn do not wait the beep out again', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Starboard', { queue: true })
    await advance(200)
    start()
    // A beep of 600 ms came with these words, which had to wait for 'Starboard' to be said.
    speaker.say('No throw, 14.', { urgent: true, afterMs: 600 })
    await advance(1000)
    end()
    // The gap between words and then the lead-in, but not the 600 ms of beep on top.
    await advance(200 + 150)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak Starboard', 'speak No throw, 14.'])
  })

  it('still waits the whole beep out when there is nothing in the way', async () => {
    const { speaker, log } = fake({ keepAlive: true })
    speaker.say('No throw, 14.', { afterMs: 600 })
    await advance(500)
    expect(log).toEqual(['ready'])
    await advance(150)
    expect(log).toEqual(['ready', 'speak No throw, 14.'])
  })
})

describe('words that never start', () => {
  it('are tried again once, after stopping them', async () => {
    const { speaker, log } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(300)
    expect(log.filter((l) => l.startsWith('speak'))).toHaveLength(1)
    // The words were said at 120 ms and had 4000 ms to start.
    expect(WATCHDOG_MS).toBe(4000)
    await advance(3700)
    expect(log).not.toContain('cancel')
    await advance(130)
    expect(log.at(-1)).toBe('cancel')
    await advance(100)
    expect(log.filter((l) => l.startsWith('speak'))).toHaveLength(2)
  })

  it('are given up on after that, leaving it free for the next', async () => {
    const { speaker, log } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(300 + 4100 + 100 + 4100)
    expect(log.filter((l) => l.startsWith('speak'))).toHaveLength(2)
    expect(speaker.busy()).toBe(false)
  })

  it('are left alone once they have started, for as long as words like them can take (see the words that never end)', async () => {
    const { speaker, log, start } = fake({ keepAlive: true })
    speaker.say('A long one.')
    await advance(300)
    start()
    await advance(END_ALLOW_MS + 3 * END_WORD_MS - 1)
    expect(log.filter((l) => l.startsWith('speak'))).toHaveLength(1)
    expect(log).not.toContain('cancel')
  })

  it('do not hold things up when the phone throws on speaking', async () => {
    const { speaker, log, state } = fake({ keepAlive: true })
    state.throwOnSpeak = true
    speaker.say('Broken.')
    await advance(300)
    expect(speaker.busy()).toBe(false)
    state.throwOnSpeak = false
    speaker.say('Fine.')
    await advance(300)
    expect(log).toContain('speak Fine.')
  })
})

describe('stopping', () => {
  it('stops the words, and forgets what was waiting', async () => {
    const { speaker, log, start } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    start()
    speaker.say('Second.')
    speaker.stop()
    expect(log.at(-1)).toBe('cancel')
    expect(speaker.busy()).toBe(false)
    await advance(2000)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak First.'])
  })

  it('drops words that were about to be said', async () => {
    const { speaker, log } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(50)
    speaker.stop()
    await advance(2000)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual([])
  })

  it('drops words that were waiting on the audio to wake, and makes no tick for them', async () => {
    const { speaker, log } = fake({ readyMs: 300 })
    speaker.say('Turn left.')
    await advance(100)
    speaker.stop()
    await advance(2000)
    expect(log).not.toContain('tick')
    expect(log.filter((l) => l.startsWith('speak'))).toEqual([])
  })

  it('can be spoken to again afterwards', async () => {
    const { speaker, log } = fake({ keepAlive: true })
    speaker.say('One.')
    speaker.stop()
    speaker.say('Two.')
    await advance(300)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak Two.'])
  })
})

describe('unlocking speech on a tap', () => {
  it('says a silent word straight away, in the same language', () => {
    const { speaker, said } = fake()
    speaker.unlock()
    expect(said).toHaveLength(1)
    expect(said[0].volume).toBe(0)
    expect(said[0].lang).toBe('en-GB')
  })
})

describe('choosing a voice', () => {
  const v = (lang: string, localService?: boolean) => ({ lang, localService, name: `${lang}${localService ? ' local' : ''}` })

  it('takes one for exactly the language, on the phone where there is a choice', () => {
    const voices = [v('en-US', true), v('en-AU'), v('en-AU', true)]
    expect(pickVoice(voices, 'en-AU')).toBe(voices[2])
  })

  it('takes one for the same language elsewhere when none is for that place', () => {
    const voices = [v('fr-FR', true), v('en-US'), v('en-GB', true)]
    expect(pickVoice(voices, 'en-AU')).toBe(voices[2])
  })

  it('reads a language written with an underscore, as some phones do, and in any case', () => {
    const voices = [v('en_AU', true), v('en-gb')]
    expect(pickVoice(voices, 'en-AU')).toBe(voices[0])
    expect(pickVoice(voices, 'EN-GB')).toBe(voices[1])
  })

  it('takes none when there is none for the language at all', () => {
    expect(pickVoice([v('fr-FR'), v('de-DE')], 'en-AU')).toBeUndefined()
    expect(pickVoice([], 'en-AU')).toBeUndefined()
  })

  it('does not take a language that merely starts with the same letters', () => {
    expect(pickVoice([v('eng-XX')], 'en-AU')).toBeUndefined()
  })
})

describe('the phone and its language', () => {
  it('speaks the phone’s English', () => {
    vi.stubGlobal('navigator', { language: 'en-GB' })
    expect(voiceLanguage()).toBe('en-GB')
  })

  it('speaks Australian English when the phone is set to another language', () => {
    vi.stubGlobal('navigator', { language: 'fr-FR' })
    expect(voiceLanguage()).toBe('en-AU')
  })

  it('does not take English for a language that only starts with the same letters', () => {
    vi.stubGlobal('navigator', { language: 'eng-XX' })
    expect(voiceLanguage()).toBe('en-AU')
  })
})

describe('on the phone', () => {
  function stubPhone() {
    const spoken: string[] = []
    class Words {
      lang = ''
      volume = 1
      text: string
      constructor(text: string) {
        this.text = text
      }
    }
    vi.stubGlobal('navigator', { language: 'en-GB' })
    vi.stubGlobal('SpeechSynthesisUtterance', Words)
    vi.stubGlobal('speechSynthesis', {
      paused: false,
      cancel: () => spoken.push('cancel'),
      resume: () => undefined,
      getVoices: () => [],
      speak: (w: Words) => spoken.push(w.text),
    })
    return spoken
  }

  it('is available when the phone has speech, and not when it has none', () => {
    stubPhone()
    expect(speechAvailable()).toBe(true)
    vi.unstubAllGlobals()
    expect(speechAvailable()).toBe(false)
  })

  it('is not available when the phone can say words but has no way to make them', () => {
    vi.stubGlobal('speechSynthesis', { speak: () => undefined })
    expect(speechAvailable()).toBe(false)
  })

  it('says what it is asked, with no audio at all to open the link', async () => {
    const spoken = stubPhone()
    say('Turn left.')
    await advance(500)
    expect(spoken).toContain('Turn left.')
    stopSpeaking()
  })

  it('says a silent word to unlock, and can be stopped', async () => {
    const spoken = stubPhone()
    unlockSpeech()
    expect(spoken).toEqual(['Ready'])
    stopSpeaking()
    expect(spoken.at(-1)).toBe('cancel')
  })

  it('does nothing, and does not throw, where there is no speech', () => {
    expect(() => {
      say('Turn left.')
      stopSpeaking()
      unlockSpeech()
    }).not.toThrow()
  })

  it('does not throw when the phone refuses to speak', async () => {
    vi.stubGlobal('navigator', { language: 'en-GB' })
    vi.stubGlobal('SpeechSynthesisUtterance', class {})
    vi.stubGlobal('speechSynthesis', {
      paused: false,
      getVoices: () => [],
      resume: () => undefined,
      cancel: () => {
        throw new Error('no')
      },
      speak: () => {
        throw new Error('no')
      },
    })
    expect(() => {
      say('Turn left.')
      unlockSpeech()
    }).not.toThrow()
    await advance(500)
    expect(() => stopSpeaking()).not.toThrow()
  })
})

/**
 * A stand-in for the phone's speech as it behaves on the road: it says what it is handed in turn, taking a moment to start each and then
 * a while over it, and stopping it drops all it holds and a moment later reports each as an error, as Safari does. `state.hang` makes the
 * next words handed to it never start, never end, or fail when they should start. It notes anything no phone should be asked to do in
 * `state.wrong`.
 */
function phone(
  options: {
    keepAlive?: boolean
    leadIn?: boolean
    opener?: boolean
    startMs?: number
    leadMs?: number
    wordMs?: number
    voices?: { lang: string; localService?: boolean }[]
    readyResult?: boolean
    /** The audio is asleep until it is made ready, and the keep-alive signal with it. */
    asleep?: boolean
  } = {},
) {
  const { startMs = 20, leadMs = 300, wordMs = 350 } = options
  const log: string[] = []
  const handed: FakeUtterance[] = []
  const state = {
    keepAlive: options.keepAlive ?? true,
    hang: null as 'start' | 'end' | 'fail' | null,
    /** Stopping it reports the errors there and then, not a moment later. */
    errorAtOnce: false,
    lastSound: -Infinity,
    throwOnLead: false,
    throwOnCancel: false,
    /** Making sound ready fails: by throwing on the spot, or by its promise failing. */
    readyFails: null as 'throws' | 'rejects' | null,
    /** The tick and the opener throw. */
    throwOnSound: false,
    wrong: [] as string[],
  }
  /** What the phone holds, the one it is on first. */
  let line: FakeUtterance[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const isWords = (u: FakeUtterance) => u.text !== LEAD_IN.text && u.text !== 'Ready'
  const lengthOf = (u: FakeUtterance) => (u.text === LEAD_IN.text ? leadMs : u.text.split(/\s+/).length * wordMs)
  const next = () => {
    const u = line[0]
    if (!u) return
    const hang = isWords(u) ? state.hang : null
    if (hang) state.hang = null
    if (hang === 'start') return
    timer = setTimeout(() => {
      if (hang === 'fail') {
        log.push(`fail ${u.text}`)
        line.shift()
        u.onerror?.()
        next()
        return
      }
      log.push(`start ${u.text}`)
      u.onstart?.()
      if (hang === 'end') return
      timer = setTimeout(() => {
        log.push(`end ${u.text}`)
        line.shift()
        u.onend?.()
        next()
      }, lengthOf(u))
    }, startMs)
  }
  const speaker = createSpeaker<FakeUtterance>({
    speak: (u) => {
      if (state.throwOnLead && u.text === LEAD_IN.text) throw new Error('no')
      if (isWords(u) && line.some(isWords)) state.wrong.push(`${u.text} handed over while ${line.find(isWords)?.text} was not over`)
      const last = handed.at(-1)
      if (last?.text === LEAD_IN.text && line.includes(last) && line.at(-1) === last && !isWords(u)) state.wrong.push(`${u.text} came between a lead-in and its words`)
      log.push(`hand ${u.text}`)
      handed.push(u)
      line.push(u)
      if (line.length === 1) next()
    },
    cancel: () => {
      log.push('cancel')
      if (timer) clearTimeout(timer)
      timer = null
      const dropped = line
      line = []
      if (state.throwOnCancel) throw new Error('no')
      if (state.errorAtOnce) dropped.forEach((u) => u.onerror?.())
      else setTimeout(() => dropped.forEach((u) => u.onerror?.()), 5)
    },
    resume: () => undefined,
    paused: () => false,
    voices: () => options.voices ?? [],
    makeUtterance: (text) => ({ text, lang: '', volume: 1, voice: undefined, onstart: null, onend: null, onerror: null }),
    ready: () => {
      if (state.readyFails === 'throws') throw new Error('no')
      if (state.readyFails === 'rejects') return Promise.reject(new Error('no'))
      if (options.asleep) state.keepAlive = true
      return Promise.resolve(options.readyResult ?? true)
    },
    keepingAlive: () => state.keepAlive,
    tick: () => {
      if (state.throwOnSound) throw new Error('no')
      log.push('tick')
      state.lastSound = Date.now() + 60
      return 0.06
    },
    ...(options.opener && {
      opener: () => {
        if (state.throwOnSound) throw new Error('no')
        log.push('opener')
        state.lastSound = Date.now() + 300
        return 0.3
      },
    }),
    lastSound: () => state.lastSound,
    ...(options.leadIn !== false && { leadIn: LEAD_IN }),
    language: () => 'en-GB',
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  return {
    speaker,
    log,
    handed,
    state,
    /** What was handed to the phone, in order. */
    texts: () => handed.map((u) => u.text),
    /** What the phone held, as far as it had got. */
    holds: () => line.map((u) => u.text),
    /** The words the phone started saying, leaving out the lead-ins and the silent word. */
    words: () => log.filter((l) => l.startsWith('start ') && l !== `start ${LEAD_IN.text}` && l !== 'start Ready').map((l) => l.slice('start '.length)),
  }
}

const UH = LEAD_IN.text
const LONG = 'One two three four five six seven eight'
const BLOCK = 'Apartment block, Lakeside Apartments, 12 papers, port.'
const WHOLE = { urgent: true, whole: true } as const
const WARNING = { urgent: true, whole: true, warning: true } as const

/*
 * With a word of 350 ms, a lead-in of 300 ms and 20 ms for each to start, words asked for at 0 with the link kept open are handed to the
 * phone at 120 ms. The lead-in starts at 140 and ends at 440, and the words start at 460.
 */
describe('the lead-in before words after a silence', () => {
  it('is handed to the phone just ahead of the words, very quietly, in the same language and voice', async () => {
    const voices = [{ lang: 'en-GB', localService: true }]
    const p = phone({ voices })
    p.speaker.say('Turn left.')
    await advance(119)
    expect(p.texts()).toEqual([])
    await advance(1)
    expect(p.texts()).toEqual([UH, 'Turn left.'])
    const [lead, words] = p.handed
    expect(lead.volume).toBe(LEAD_IN.volume)
    expect(lead.volume).toBeGreaterThan(0)
    expect(lead.volume).toBeLessThanOrEqual(0.05)
    expect(words.volume).toBe(1)
    expect(lead.lang).toBe(words.lang)
    expect(lead.voice).toBe(voices[0])
    expect(words.voice).toBe(voices[0])
  })

  it('is not the end of anything: the voice is busy until the words end, and they follow it', async () => {
    const p = phone()
    p.speaker.say('Turn left.')
    await advance(445)
    expect(p.log).toContain(`end ${UH}`)
    expect(p.words()).toEqual([])
    expect(p.speaker.busy()).toBe(true)
    await advance(20)
    expect(p.words()).toEqual(['Turn left.'])
    await advance(700)
    expect(p.speaker.busy()).toBe(false)
  })

  it('is not said for a cue right after another, as the phone is awake', async () => {
    const p = phone()
    p.speaker.say('First.')
    p.speaker.say('Second.', { queue: true })
    await advance(3000)
    expect(p.texts()).toEqual([UH, 'First.', 'Second.'])
    expect(p.words()).toEqual(['First.', 'Second.'])
  })

  it('is counted from when the phone last spoke, not from when it started, so long words keep it awake to their end', async () => {
    const p = phone()
    p.speaker.say(LONG)
    // They start at 460 and end at 3260.
    await advance(3300)
    expect(p.speaker.busy()).toBe(false)
    await advance(1700)
    p.speaker.say('Next.')
    // Handed over at 5120, 1860 ms after the words ended.
    await advance(200)
    expect(p.texts()).toEqual([UH, LONG, 'Next.'])
  })

  it('comes back once the phone has been quiet for longer than COLD_MS', async () => {
    const p = phone()
    p.speaker.say(LONG)
    await advance(3300 + COLD_MS - 100)
    p.speaker.say('Next.')
    await advance(200)
    expect(p.texts()).toEqual([UH, LONG, UH, 'Next.'])
  })

  it('is judged when the words are handed over, after any wait for a beep', async () => {
    const p = phone()
    p.speaker.say(LONG)
    // 1500 ms after the words end, a no-throw house's beep starts, and its words wait 950 ms for it.
    await advance(3260 + 1500)
    p.speaker.say('No throw, 14.', { urgent: true, afterMs: 950 })
    await advance(1000)
    expect(p.texts()).toEqual([UH, LONG, UH, 'No throw, 14.'])
  })

  it('leads in the words that follow a beep as well: the beep goes by another way than the words, and opens less of it', async () => {
    const p = phone({ keepAlive: false, opener: true })
    p.speaker.say('No throw, 14.', { urgent: true, afterMs: 950 })
    await advance(1000)
    expect(p.texts()).toEqual([UH, 'No throw, 14.'])
    expect(p.log).not.toContain('opener')
    expect(p.log).not.toContain('tick')
  })

  it('is said with the keep-alive signal running, which reaches the link but not the phone’s speech', async () => {
    const p = phone({ keepAlive: true })
    p.speaker.say('Turn left.')
    await advance(200)
    expect(p.texts()).toEqual([UH, 'Turn left.'])
  })

  it('is left out, and the words said, when the phone will not take it', async () => {
    const p = phone()
    p.state.throwOnLead = true
    p.speaker.say('Turn left.')
    await advance(1000)
    expect(p.texts()).toEqual(['Turn left.'])
    expect(p.words()).toEqual(['Turn left.'])
  })

  it('holds up nothing by failing: the words are still to come', async () => {
    const p = phone()
    p.speaker.say('Turn left.')
    await advance(150)
    p.handed[0].onerror?.()
    expect(p.speaker.busy()).toBe(true)
    await advance(2000)
    expect(p.words()).toEqual(['Turn left.'])
  })

  it('wakes nothing when it fails, as no sound got through', async () => {
    const p = phone({ leadMs: 300 })
    p.speaker.say('Turn left.')
    await advance(130)
    // It fails before it starts, and then the words are stopped by something else before they start.
    p.handed[0].onerror?.()
    p.speaker.say('No throw, 14.', { urgent: true })
    await advance(300)
    expect(p.texts()).toEqual([UH, 'Turn left.', UH, 'No throw, 14.'])
  })

  it('counts when it has been said to its end, so words broken in on just after it give the next none', async () => {
    const p = phone({ startMs: 100 })
    p.speaker.say('A turn.')
    // Handed over at 120: it starts at 220 and ends at 520, and the words would start at 620.
    await advance(560)
    expect(p.log).toContain(`end ${UH}`)
    p.speaker.say('No throw, 14.', { urgent: true })
    await advance(300)
    expect(p.texts()).toEqual([UH, 'A turn.', 'No throw, 14.'])
  })
})

describe('words stopped while their lead-in is being said', () => {
  it('leave nothing behind: the phone and the speaker drop both, and what breaks in has a lead-in of its own', async () => {
    const p = phone()
    p.speaker.say('A turn.')
    await advance(300)
    expect(p.holds()).toEqual([UH, 'A turn.'])
    p.speaker.say('No throw, 14.', { urgent: true })
    expect(p.log.at(-1)).toBe('cancel')
    expect(p.holds()).toEqual([])
    expect(p.speaker.holding()).toEqual([])
    // Safari's late errors for the two end nothing that is going on now.
    await advance(10)
    expect(p.speaker.busy()).toBe(true)
    await advance(190)
    expect(p.texts()).toEqual([UH, 'A turn.', UH, 'No throw, 14.'])
    await advance(1500)
    expect(p.words()).toEqual(['No throw, 14.'])
    expect(p.speaker.busy()).toBe(false)
  })

  it('wake nothing by a late end from their lead-in, and that end does not let go of the lead-in that came after it', async () => {
    const p = phone()
    p.speaker.say('A turn.')
    await advance(300)
    const stopped = p.handed[0]
    p.speaker.say('No throw, 14.', { urgent: true })
    // The end of the lead-in that was stopped arrives after all, before what broke in has been got ready.
    stopped.onend?.()
    await advance(200)
    expect(p.texts()).toEqual([UH, 'A turn.', UH, 'No throw, 14.'])
    // And again, once the next lead-in is in the phone's hands.
    const next = p.handed[2]
    stopped.onend?.()
    expect(p.speaker.holding()).toContain(next)
  })

  it('wake nothing, however far the lead-in got: what it was there to carry through may not have got through', async () => {
    const p = phone({ leadMs: 2000 })
    p.speaker.say('A turn.')
    // The lead-in has been going for 1800 ms when it is stopped.
    await advance(1940)
    p.speaker.say('No throw, 14.', { urgent: true })
    await advance(300)
    expect(p.texts().filter((t) => t === UH)).toHaveLength(2)
  })

  it('are not taken to have begun: words that lost nothing get no grace for being cut off', async () => {
    const p = phone()
    let out = false
    p.speaker.say(BLOCK, { ...WHOLE, stale: () => out })
    await advance(300)
    p.speaker.say('Starboard', { queue: true })
    // By the end of the side word, the car has gone by what they name.
    out = true
    await advance(5000)
    expect(p.words()).toEqual(['Starboard'])
  })

  it('are begun once the lead-in is over: words cut off by a side word then have the grace', async () => {
    const p = phone()
    let out = false
    p.speaker.say(BLOCK, { ...WHOLE, stale: () => out })
    await advance(600)
    expect(p.words()).toEqual([BLOCK])
    p.speaker.say('Starboard', { queue: true })
    out = true
    await advance(5000)
    expect(p.words()).toEqual([BLOCK, 'Starboard', BLOCK])
  })

  it('are forgotten by stopping, with their lead-in, and the words after that have one of their own', async () => {
    const p = phone()
    p.speaker.say('A turn.')
    await advance(300)
    p.speaker.stop()
    expect(p.speaker.busy()).toBe(false)
    expect(p.holds()).toEqual([])
    expect(p.speaker.holding()).toEqual([])
    await advance(100)
    expect(p.speaker.busy()).toBe(false)
    p.speaker.say('Next.')
    await advance(1500)
    expect(p.texts()).toEqual([UH, 'A turn.', UH, 'Next.'])
    expect(p.words()).toEqual(['Next.'])
  })
})

describe('words stopped once they have started', () => {
  it('count as the phone speaking up to then, so what breaks in has no lead-in', async () => {
    const p = phone()
    p.speaker.say(LONG)
    await advance(2000)
    p.speaker.say('No throw, 14.', { urgent: true })
    await advance(300)
    expect(p.texts()).toEqual([UH, LONG, 'No throw, 14.'])
  })

  it('count up to when they were stopped, not when they started', async () => {
    const p = phone()
    p.speaker.say(LONG)
    // Started at 460, and stopped at 3000: a cue 1800 ms after that is not after a silence.
    await advance(3000)
    p.speaker.stop()
    await advance(1700)
    p.speaker.say('Next.')
    await advance(200)
    expect(p.texts()).toEqual([UH, LONG, 'Next.'])
  })
})

describe('a stale cue', () => {
  it('says no lead-in when it is out of date before anything is done', async () => {
    const p = phone()
    p.speaker.say('Turn left.', { stale: () => true })
    await advance(500)
    expect(p.texts()).toEqual([])
    expect(p.speaker.busy()).toBe(false)
  })

  it('says no lead-in when it goes out of date during the wait before it', async () => {
    const p = phone()
    let out = false
    p.speaker.say('Turn left.', { stale: () => out })
    await advance(50)
    out = true
    await advance(500)
    expect(p.texts()).toEqual([])
    expect(p.speaker.busy()).toBe(false)
  })

  it('that was waiting leaves no lead-in for it, and what follows has one as it needs one', async () => {
    const p = phone()
    p.speaker.say(LONG)
    await advance(500)
    p.speaker.say('Old.', { queue: true, stale: () => true })
    p.speaker.say('New.', { queue: true })
    await advance(5000)
    expect(p.texts()).toEqual([UH, LONG, 'New.'])
  })
})

describe('words that never start, with a lead-in', () => {
  it('have longer to start, as they wait for it, and the start of the lead-in does not count as theirs', async () => {
    const p = phone()
    p.state.hang = 'start'
    p.speaker.say('Turn left.')
    await advance(120 + WATCHDOG_MS + LEAD_IN_ALLOW_MS - 1)
    expect(p.log).toContain(`start ${UH}`)
    expect(p.log).not.toContain('cancel')
    await advance(1)
    expect(p.log.at(-1)).toBe('cancel')
  })

  it('have only the usual time with no lead-in before them', async () => {
    const p = phone()
    p.speaker.say('First.')
    await advance(900)
    p.state.hang = 'start'
    p.speaker.say('Second.')
    await advance(120 + WATCHDOG_MS - 1)
    expect(p.texts()).toEqual([UH, 'First.', 'Second.'])
    expect(p.log).not.toContain('cancel')
    await advance(1)
    expect(p.log.at(-1)).toBe('cancel')
  })

  it('are tried again with a lead-in, as the phone is still cold, and the late errors of the two stopped do not end the try', async () => {
    const p = phone()
    p.state.hang = 'start'
    p.speaker.say('Turn left.')
    await advance(120 + WATCHDOG_MS + LEAD_IN_ALLOW_MS)
    expect(p.speaker.holding()).toEqual([])
    expect(p.holds()).toEqual([])
    await advance(10)
    expect(p.speaker.busy()).toBe(true)
    expect(p.log.filter((l) => l === 'cancel')).toHaveLength(1)
    await advance(70)
    expect(p.texts()).toEqual([UH, 'Turn left.', UH, 'Turn left.'])
    await advance(1100)
    expect(p.words()).toEqual(['Turn left.'])
    expect(p.speaker.busy()).toBe(false)
  })

  it('are not said beside what follows them when tried again: the late error is not taken for their end', async () => {
    const p = phone()
    p.state.hang = 'start'
    p.speaker.say('First.')
    await advance(200)
    p.speaker.say('Second.', { queue: true })
    await advance(8000)
    expect(p.state.wrong).toEqual([])
    expect(p.words()).toEqual(['First.', 'Second.'])
  })

  it('are left out of the second try when they have gone out of date, and the lead-in with them', async () => {
    const p = phone()
    let out = false
    p.state.hang = 'start'
    p.speaker.say('Turn left.', { stale: () => out })
    await advance(200)
    out = true
    await advance(WATCHDOG_MS + LEAD_IN_ALLOW_MS + 200)
    expect(p.texts()).toEqual([UH, 'Turn left.'])
    expect(p.speaker.busy()).toBe(false)
  })

  it('go on to what waits when they are left out of the second try', async () => {
    const p = phone()
    let out = false
    p.state.hang = 'start'
    p.speaker.say('Turn left.', { stale: () => out })
    await advance(200)
    p.speaker.say('Starboard', { queue: true })
    out = true
    await advance(WATCHDOG_MS + LEAD_IN_ALLOW_MS + 1500)
    expect(p.words()).toEqual(['Starboard'])
  })

  it('do not take the late start of words given up on for the start of the second try', async () => {
    const { speaker, said, log } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(120 + WATCHDOG_MS + 80)
    expect(said).toHaveLength(2)
    said[0].onstart?.()
    await advance(WATCHDOG_MS)
    expect(log.filter((l) => l === 'cancel')).toHaveLength(2)
    expect(speaker.busy()).toBe(false)
  })

  it('are tried again with what breaks in going first, when something does', async () => {
    const p = phone()
    p.state.hang = 'start'
    p.speaker.say('Turn left.', WHOLE)
    // In the gap before the second try, a side word comes.
    await advance(120 + WATCHDOG_MS + LEAD_IN_ALLOW_MS + 40)
    p.speaker.say('Starboard', { queue: true })
    await advance(3000)
    expect(p.words()).toEqual(['Starboard', 'Turn left.'])
    expect(p.state.wrong).toEqual([])
  })
})

describe('words the phone reports as failed before they start', () => {
  const spoken = (log: string[]) => log.filter((l) => l.startsWith('speak'))
  const cancels = (log: string[]) => log.filter((l) => l === 'cancel')

  it('are stopped and tried again a moment later, as words that never start are', async () => {
    const { speaker, log, said, start, end } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(300)
    said[0].onerror?.()
    expect(log.at(-1)).toBe('cancel')
    expect(speaker.busy()).toBe(true)
    await advance(79)
    expect(spoken(log)).toHaveLength(1)
    await advance(1)
    expect(spoken(log)).toEqual(['speak Turn left.', 'speak Turn left.'])
    start()
    end()
    expect(speaker.busy()).toBe(false)
  })

  it('come before what waits behind them: a warning that fails is not lost to the side word after it', async () => {
    const p = phone()
    p.state.hang = 'fail'
    p.speaker.say('No throw, 17.', WARNING)
    await advance(50)
    p.speaker.say('Port', { queue: true })
    await advance(3000)
    expect(p.words()).toEqual(['No throw, 17.', 'Port'])
    expect(p.state.wrong).toEqual([])
    expect(p.speaker.busy()).toBe(false)
  })

  it('are tried only once more: failing again they are given up on, and what waits is said', async () => {
    const { speaker, log, said } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    speaker.say('Second.')
    said[0].onerror?.()
    await advance(100)
    said[1].onerror?.()
    expect(cancels(log)).toHaveLength(2)
    await advance(400)
    expect(spoken(log)).toEqual(['speak First.', 'speak First.', 'speak Second.'])
  })

  it('leave it free once given up on, with no timer left running', async () => {
    const { speaker, said } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(300)
    said[0].onerror?.()
    await advance(100)
    said[1].onerror?.()
    expect(speaker.busy()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('get no third try when the second never starts', async () => {
    const { speaker, log, said } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(300)
    said[0].onerror?.()
    await advance(80 + WATCHDOG_MS - 1)
    expect(cancels(log)).toHaveLength(1)
    await advance(1)
    expect(cancels(log)).toHaveLength(2)
    await advance(1000)
    expect(spoken(log)).toHaveLength(2)
    expect(speaker.busy()).toBe(false)
  })

  it('get no third try when they fail on the second try of words that never started', async () => {
    const { speaker, log, said } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(120 + WATCHDOG_MS + 80)
    expect(spoken(log)).toHaveLength(2)
    said[1].onerror?.()
    await advance(1000)
    expect(spoken(log)).toHaveLength(2)
    expect(speaker.busy()).toBe(false)
  })

  it('are left out of the second try when they have gone out of date, and what waits goes on', async () => {
    const { speaker, log, said } = fake({ keepAlive: true })
    let out = false
    speaker.say('Turn left.', { stale: () => out })
    await advance(300)
    speaker.say('Keep going.')
    said[0].onerror?.()
    out = true
    await advance(400)
    expect(spoken(log)).toEqual(['speak Turn left.', 'speak Keep going.'])
  })

  it('are tried again once, however many times the failure is reported', async () => {
    const { speaker, log, said } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(300)
    said[0].onerror?.()
    said[0].onerror?.()
    await advance(40)
    said[0].onerror?.()
    await advance(200)
    expect(spoken(log)).toHaveLength(2)
    expect(cancels(log)).toHaveLength(1)
    expect(speaker.busy()).toBe(true)
  })

  it('do not take a report of the first try, come late, for the second try failing', async () => {
    const { speaker, log, said, start, end } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(300)
    said[0].onerror?.()
    await advance(100)
    said[0].onerror?.()
    await advance(100)
    expect(spoken(log)).toHaveLength(2)
    expect(cancels(log)).toHaveLength(1)
    start()
    end()
    expect(speaker.busy()).toBe(false)
  })

  it('do not take the late start of the words that failed for the start of the second try', async () => {
    const { speaker, log, said } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(300)
    said[0].onerror?.()
    await advance(80)
    said[0].onstart?.()
    await advance(WATCHDOG_MS)
    expect(cancels(log)).toHaveLength(2)
    expect(speaker.busy()).toBe(false)
  })

  it('do not go on to what waits at a late end of the words that failed: only one lot goes to the phone', async () => {
    const { speaker, log, said } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    speaker.say('Second.')
    said[0].onerror?.()
    said[0].onend?.()
    await advance(600)
    expect(spoken(log)).toEqual(['speak First.', 'speak First.'])
  })

  it('are tried again with a lead-in when the phone is still cold, as nothing got through, and the late errors of the two stopped do nothing', async () => {
    const p = phone()
    p.speaker.say('Turn left.')
    await advance(130)
    p.handed[1].onerror?.()
    expect(p.speaker.holding()).toEqual([])
    expect(p.holds()).toEqual([])
    await advance(79)
    expect(p.texts()).toEqual([UH, 'Turn left.'])
    await advance(1)
    expect(p.texts()).toEqual([UH, 'Turn left.', UH, 'Turn left.'])
    await advance(1500)
    expect(p.words()).toEqual(['Turn left.'])
    expect(p.state.wrong).toEqual([])
    expect(p.speaker.busy()).toBe(false)
  })

  it('are tried again with no lead-in once theirs has been said, as the phone has just spoken', async () => {
    const p = phone()
    p.state.hang = 'fail'
    p.speaker.say('Turn left.')
    await advance(1500)
    expect(p.log).toContain('fail Turn left.')
    expect(p.texts()).toEqual([UH, 'Turn left.', 'Turn left.'])
    expect(p.words()).toEqual(['Turn left.'])
  })

  it('have the longer time to start on a second try with a lead-in, as words with one do', async () => {
    const p = phone()
    p.speaker.say('Turn left.')
    await advance(130)
    p.state.hang = 'start'
    p.handed[1].onerror?.()
    await advance(80 + WATCHDOG_MS + LEAD_IN_ALLOW_MS - 1)
    expect(cancels(p.log)).toHaveLength(1)
    await advance(1)
    expect(cancels(p.log)).toHaveLength(2)
    expect(p.speaker.busy()).toBe(false)
  })

  it('leave no lead-in with the phone when they are given up on before it is over', async () => {
    const p = phone()
    p.speaker.say('Turn left.')
    await advance(130)
    p.handed[1].onerror?.()
    await advance(90)
    p.handed[3].onerror?.()
    expect(p.speaker.holding()).toEqual([])
    expect(p.holds()).toEqual([])
    expect(p.speaker.busy()).toBe(false)
  })

  it('are tried again with what breaks in going first, when something does', async () => {
    const p = phone()
    p.speaker.say('Turn left.', WHOLE)
    await advance(130)
    p.handed[1].onerror?.()
    await advance(40)
    p.speaker.say('Starboard', { queue: true })
    await advance(3000)
    expect(p.words()).toEqual(['Starboard', 'Turn left.'])
    expect(p.state.wrong).toEqual([])
  })

  it('are forgotten when speech is stopped before the second try', async () => {
    const { speaker, log, said } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(300)
    said[0].onerror?.()
    await advance(40)
    speaker.stop()
    await advance(300)
    expect(spoken(log)).toHaveLength(1)
    expect(speaker.busy()).toBe(false)
  })

  it('can fail as they are handed over, on a phone that reports it then, and only the second try is watched', async () => {
    const { speaker, log, state, start, end } = fake({ keepAlive: true })
    state.failAsHanded = 1
    speaker.say('Turn left.')
    await advance(300)
    expect(spoken(log)).toHaveLength(2)
    expect(cancels(log)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    start()
    end()
    expect(vi.getTimerCount()).toBe(0)
    expect(speaker.busy()).toBe(false)
  })

  it('leave it free when they fail as they are handed over each time', async () => {
    const { speaker, log, state } = fake({ keepAlive: true })
    state.failAsHanded = 2
    speaker.say('Turn left.')
    await advance(300)
    expect(spoken(log)).toHaveLength(2)
    expect(speaker.busy()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('are not gone on from twice when the phone reports them failed and throws as well: only one lot goes to the phone', async () => {
    const { speaker, log, state } = fake({ keepAlive: true })
    state.failAsHanded = 1
    state.throwAfterFail = true
    speaker.say('First.')
    speaker.say('Second.')
    await advance(800)
    expect(spoken(log)).toEqual(['speak First.', 'speak First.'])
  })

  it('go on to what waits when the second try can’t be made, and leave it free', async () => {
    const { speaker, log, said, state } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    speaker.say('Second.')
    state.throwOnMake = true
    said[0].onerror?.()
    await advance(80)
    state.throwOnMake = false
    await advance(400)
    expect(spoken(log)).toEqual(['speak First.', 'speak Second.'])
  })
})

describe('a second try that has come too late', () => {
  const NO_THROW = 'No throw, 17.'
  /** How many times the words have been handed to the phone. */
  const tries = (p: ReturnType<typeof phone>) => p.texts().filter((t) => t === NO_THROW).length
  /** Up to the moment the first try is given up on and stopped: the second, if there is one, comes a moment after this. */
  const toFailure = async (p: ReturnType<typeof phone>) => {
    for (let waited = 0; waited < 10_000 && !p.log.includes('cancel'); waited += 10) await advance(10)
    expect(p.log).toContain('cancel')
    expect(tries(p)).toBe(1)
  }

  // The two ways to a second try: the phone says the words failed, or says nothing and the timer runs out.
  describe.each([
    ['the phone reports them as failed', 'fail'],
    ['the phone never starts them', 'start'],
  ] as const)('when %s', (_, hang) => {
    it('is left out when the check says so, and what waits behind it is said', async () => {
      const p = phone()
      p.state.hang = hang
      p.speaker.say(NO_THROW, { ...WARNING, retryStale: () => true })
      p.speaker.say('Port', { queue: true })
      await advance(20_000)
      expect(tries(p)).toBe(1)
      expect(p.words()).toEqual(['Port'])
      expect(p.state.wrong).toEqual([])
      expect(p.speaker.busy()).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('goes ahead while the check says it has not', async () => {
      const p = phone()
      p.state.hang = hang
      p.speaker.say(NO_THROW, { ...WARNING, retryStale: () => false })
      await advance(20_000)
      expect(tries(p)).toBe(2)
      expect(p.words()).toEqual([NO_THROW])
      expect(p.speaker.busy()).toBe(false)
    })

    it('is judged when the second try would start, as the car moves on in the wait before it', async () => {
      const p = phone()
      let level = false
      p.state.hang = hang
      p.speaker.say(NO_THROW, { ...WARNING, retryStale: () => level })
      await toFailure(p)
      level = true
      await advance(20_000)
      expect(tries(p)).toBe(1)
      expect(p.speaker.busy()).toBe(false)
    })

    it('counts as too late when the check itself fails, and the voice carries on', async () => {
      const p = phone()
      p.state.hang = hang
      p.speaker.say(NO_THROW, {
        ...WARNING,
        retryStale: () => {
          throw new Error('no')
        },
      })
      p.speaker.say('Port', { queue: true })
      await advance(20_000)
      expect(tries(p)).toBe(1)
      expect(p.words()).toEqual(['Port'])
      expect(p.speaker.busy()).toBe(false)
    })

    it('still answers to the words being out of date, whatever this check says', async () => {
      const p = phone()
      let out = false
      p.state.hang = hang
      p.speaker.say(NO_THROW, { ...WARNING, stale: () => out, retryStale: () => false })
      await toFailure(p)
      out = true
      await advance(20_000)
      expect(tries(p)).toBe(1)
      expect(p.speaker.busy()).toBe(false)
    })
  })

  it('does not touch a first try: words the check calls too late are said, and it is not asked', async () => {
    const p = phone()
    const retryStale = vi.fn(() => true)
    p.speaker.say(NO_THROW, { ...WARNING, retryStale })
    await advance(5000)
    expect(p.words()).toEqual([NO_THROW])
    expect(retryStale).not.toHaveBeenCalled()
  })

  it('does not touch a first try that has waited its turn behind other words', async () => {
    const p = phone()
    const retryStale = vi.fn(() => true)
    p.speaker.say(BLOCK, WHOLE)
    await advance(700)
    p.speaker.say('Port', { queue: true })
    p.speaker.say(NO_THROW, { ...WARNING, retryStale })
    await advance(20_000)
    expect(p.words()).toContain(NO_THROW)
    expect(retryStale).not.toHaveBeenCalled()
  })

  it('is not asked about words that start and then fail, which are over and get no second try', async () => {
    const { speaker, said, start } = fake({ keepAlive: true })
    const retryStale = vi.fn(() => false)
    speaker.say(NO_THROW, { ...WARNING, retryStale })
    await advance(300)
    start()
    said[0].onerror?.()
    await advance(1000)
    expect(said).toHaveLength(1)
    expect(retryStale).not.toHaveBeenCalled()
  })

  it('goes with words a side word cut off, and the grace they have for being out of date does not cover it', async () => {
    const p = phone()
    let gone = false
    p.speaker.say(BLOCK, { ...WHOLE, stale: () => gone, retryStale: () => true })
    await advance(1000)
    expect(p.words()).toEqual([BLOCK])
    p.speaker.say('Port', { queue: true })
    gone = true
    await advance(300)
    expect(p.words()).toEqual([BLOCK, 'Port'])
    // Said again after the side word, within their grace, and this time the phone fails them: that is their one failed start, and there is no try after it.
    p.state.hang = 'fail'
    await advance(CUT_GRACE_MS - 600)
    expect(p.log).toContain(`fail ${BLOCK}`)
    await advance(20_000)
    expect(p.texts().filter((t) => t === BLOCK)).toHaveLength(2)
    expect(p.speaker.busy()).toBe(false)
  })
})

describe('words stopped here, which Safari reports as failed', () => {
  const spoken = (log: string[]) => log.filter((l) => l.startsWith('speak'))
  const cancels = (log: string[]) => log.filter((l) => l === 'cancel')

  it('are not tried again when what broke in on them is being said, and it is left alone', async () => {
    const { speaker, log, said, start, end } = fake({ keepAlive: true })
    speaker.say('A turn.')
    await advance(300)
    speaker.say('Urgent.', { urgent: true })
    await advance(300)
    said[0].onerror?.()
    await advance(WATCHDOG_MS - 500)
    expect(spoken(log)).toEqual(['speak A turn.', 'speak Urgent.'])
    expect(cancels(log)).toHaveLength(1)
    start()
    end()
    expect(speaker.busy()).toBe(false)
  })

  it('are not tried again when the error comes in the gap before what broke in', async () => {
    const { speaker, log, said } = fake({ keepAlive: true })
    speaker.say('A turn.')
    await advance(300)
    speaker.say('Urgent.', { urgent: true })
    await advance(10)
    said[0].onerror?.()
    await advance(500)
    expect(spoken(log)).toEqual(['speak A turn.', 'speak Urgent.'])
    expect(cancels(log)).toHaveLength(1)
  })

  it('are not tried again after a stop, which is the end of them', async () => {
    const { speaker, log, said } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(300)
    speaker.stop()
    said[0].onerror?.()
    await advance(WATCHDOG_MS * 2)
    expect(spoken(log)).toHaveLength(1)
    expect(cancels(log)).toHaveLength(1)
    expect(speaker.busy()).toBe(false)
  })

  it('are not tried again when the phone reports the error as it is being stopped, before the stop is over', async () => {
    const p = phone()
    p.state.errorAtOnce = true
    p.speaker.say('Turn left.')
    await advance(130)
    p.speaker.stop()
    await advance(WATCHDOG_MS * 2)
    expect(p.texts()).toEqual([UH, 'Turn left.'])
    expect(cancels(p.log)).toHaveLength(1)
    expect(p.speaker.busy()).toBe(false)
  })

  it('are not taken for a second failure when stopping words that failed reports them again at once', async () => {
    const p = phone()
    p.state.errorAtOnce = true
    p.speaker.say('Turn left.')
    await advance(130)
    p.handed[1].onerror?.()
    await advance(1500)
    expect(p.texts()).toEqual([UH, 'Turn left.', UH, 'Turn left.'])
    expect(cancels(p.log)).toHaveLength(1)
    expect(p.words()).toEqual(['Turn left.'])
  })

  it('are said once more in their turn when cut off before they began, with nothing added for the late error', async () => {
    const p = phone()
    p.speaker.say('Turn left.', WHOLE)
    await advance(130)
    p.speaker.say('Starboard', { queue: true })
    await advance(3000)
    expect(p.words()).toEqual(['Starboard', 'Turn left.'])
    expect(p.texts().filter((t) => t === 'Turn left.')).toHaveLength(2)
    expect(p.state.wrong).toEqual([])
  })
})

describe('words the phone reports as failed part way', () => {
  it('are not said again: they have been heard in part, and what waits goes on', async () => {
    const { speaker, log, said, start } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    speaker.say('Second.')
    start()
    said[0].onerror?.()
    expect(log).not.toContain('cancel')
    await advance(400)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak First.', 'speak Second.'])
  })

  it('leave it free with nothing waiting, and the words after them need no lead-in, as the phone has just spoken', async () => {
    const p = phone()
    p.state.hang = 'end'
    p.speaker.say('Turn left.')
    await advance(500)
    expect(p.words()).toEqual(['Turn left.'])
    p.handed[1].onerror?.()
    expect(p.speaker.busy()).toBe(false)
    expect(p.texts()).toEqual([UH, 'Turn left.'])
    p.speaker.say('Keep going.')
    await advance(200)
    expect(p.texts()).toEqual([UH, 'Turn left.', 'Keep going.'])
  })
})

describe('the silent word from a tap', () => {
  it('wakes nothing, so the first words after it still have a lead-in', async () => {
    const p = phone()
    p.speaker.unlock()
    expect(p.handed[0].volume).toBe(0)
    await advance(400)
    expect(p.log).toContain('end Ready')
    p.speaker.say('Voice on')
    await advance(200)
    expect(p.texts()).toEqual(['Ready', UH, 'Voice on'])
  })

  it('leaves the words asked for just after it to follow it, and they have longer to start for the lead-in', async () => {
    const p = phone()
    p.speaker.unlock()
    p.speaker.say('Voice on')
    await advance(2000)
    expect(p.texts()).toEqual(['Ready', UH, 'Voice on'])
    expect(p.words()).toEqual(['Voice on'])
    expect(p.log).not.toContain('cancel')
  })

  it('is held until it is over, and has no lead-in of its own', async () => {
    const p = phone()
    p.speaker.unlock()
    expect(p.speaker.holding()).toEqual([p.handed[0]])
    expect(p.texts()).toEqual(['Ready'])
    await advance(400)
    expect(p.speaker.holding()).toEqual([])
  })

  it('is let go if it is stopped', async () => {
    const p = phone()
    p.speaker.unlock()
    p.speaker.stop()
    await advance(10)
    expect(p.speaker.holding()).toEqual([])
  })
})

describe('what is held so the phone does not lose it', () => {
  it('is the lead-in and the words from when they are handed over, the lead-in until it is over, and the words until they are', async () => {
    const p = phone()
    p.speaker.say('Turn left.')
    await advance(120)
    expect(p.speaker.holding()).toEqual(p.handed)
    await advance(330)
    expect(p.speaker.holding()).toEqual([p.handed[1]])
    await advance(800)
    expect(p.speaker.holding()).toEqual([])
  })

  it('lets go of the lead-in too when the words fail before it is over, and holds nothing until they are tried again', async () => {
    const p = phone()
    p.speaker.say('Turn left.')
    await advance(130)
    p.handed[1].onerror?.()
    expect(p.speaker.holding()).toEqual([])
    expect(p.speaker.busy()).toBe(true)
    await advance(80)
    expect(p.speaker.holding()).toEqual(p.handed.slice(2))
  })

  it('lets go of a lead-in whose end never came once the words start', async () => {
    const said: FakeUtterance[] = []
    const speaker = createSpeaker<FakeUtterance>({
      speak: (u) => void said.push(u),
      cancel: () => undefined,
      resume: () => undefined,
      paused: () => false,
      voices: () => [],
      makeUtterance: (text) => ({ text, lang: '', volume: 1, voice: undefined, onstart: null, onend: null, onerror: null }),
      ready: async () => true,
      keepingAlive: () => true,
      tick: () => 0,
      leadIn: LEAD_IN,
      language: () => 'en-GB',
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })
    speaker.say('Turn left.')
    await advance(120)
    expect(speaker.holding()).toEqual(said)
    said[1].onstart?.()
    expect(speaker.holding()).toEqual([said[1]])
  })
})

describe('after a silence with nothing keeping the link open', () => {
  const cold = (opts: Parameters<typeof phone>[0] = {}) => phone({ keepAlive: false, opener: true, ...opts })

  it('a soft opener goes first, not the tick, and the words wait about 0.7 s for the link', async () => {
    const p = cold()
    p.speaker.say('Turn left.')
    await advance(0)
    expect(p.log).toEqual(['opener'])
    await advance(690)
    expect(p.texts()).toEqual([])
    await advance(20)
    expect(p.texts()).toEqual([UH, 'Turn left.'])
    expect(p.log).not.toContain('tick')
  })

  it('it is only the tick when the phone has spoken within COLD_MS, though the last beep or opener is long gone', async () => {
    const p = cold()
    p.speaker.say(LONG)
    p.speaker.say('Second.', { queue: true })
    await advance(6000)
    expect(p.words()).toEqual([LONG, 'Second.'])
    expect(p.log.filter((l) => l === 'opener' || l === 'tick')).toEqual(['opener', 'tick'])
  })

  it('it is only the tick when a beep has gone out within COLD_MS, as the link is open', async () => {
    const p = cold()
    p.state.lastSound = Date.now() - 1000
    p.speaker.say('Turn left.')
    await advance(200)
    expect(p.log.filter((l) => l === 'opener' || l === 'tick')).toEqual(['tick'])
    expect(p.texts()).toEqual([UH, 'Turn left.'])
  })

  it('the opener is back once a beep has been over for longer than COLD_MS', async () => {
    const p = cold()
    p.state.lastSound = Date.now() - COLD_MS - 1
    p.speaker.say('Turn left.')
    await advance(0)
    expect(p.log).toEqual(['opener'])
  })

  it('neither goes on top of a beep that has just started, which opens the link itself', async () => {
    const p = cold()
    p.speaker.say('No throw, 14.', { urgent: true, afterMs: 400 })
    await advance(500)
    expect(p.log.filter((l) => l === 'opener' || l === 'tick')).toEqual([])
  })

  it('neither is played while the signal is keeping the link open', async () => {
    const p = cold({ keepAlive: true })
    p.speaker.say('Turn left.')
    await advance(200)
    expect(p.log.filter((l) => l === 'opener' || l === 'tick')).toEqual([])
  })

  it('the opener is played when the signal was asleep, though making sound ready wakes it: the link was not being kept open', async () => {
    const p = cold({ keepAlive: false, asleep: true })
    p.speaker.say('Turn left.')
    await advance(0)
    expect(p.state.keepAlive).toBe(true)
    expect(p.log).toEqual(['opener'])
    await advance(690)
    expect(p.texts()).toEqual([])
    await advance(20)
    expect(p.texts()).toEqual([UH, 'Turn left.'])
  })

  it('the tick stands in for the opener when there is none, and the signal was asleep', async () => {
    const p = phone({ keepAlive: false, asleep: true })
    p.speaker.say('Turn left.')
    await advance(0)
    expect(p.log).toEqual(['tick'])
  })

  it('neither is played on audio that would not wake, and the words do not wait for what can’t be heard', async () => {
    const p = cold({ readyResult: false })
    p.speaker.say('Turn left.')
    await advance(120)
    expect(p.log.filter((l) => l === 'opener' || l === 'tick')).toEqual([])
    expect(p.texts()).toEqual([UH, 'Turn left.'])
  })

  it('the opener is not played again for words that break in on its lead-in, as it has only just gone out', async () => {
    const p = cold()
    p.speaker.say('A turn.')
    await advance(800)
    p.speaker.say('No throw, 14.', { urgent: true })
    await advance(400)
    expect(p.log.filter((l) => l === 'opener' || l === 'tick')).toEqual(['opener', 'tick'])
    expect(p.texts()).toEqual([UH, 'A turn.', UH, 'No throw, 14.'])
  })
})

describe('sound that fails, which the words do not need', () => {
  const played = (log: string[]) => log.filter((l) => l === 'opener' || l === 'tick')

  it.each(['throws', 'rejects'] as const)('the words go, with nothing played first and no wait for it, when making sound ready %s', async (how) => {
    const p = phone({ keepAlive: false, opener: true })
    p.state.readyFails = how
    p.speaker.say('Turn left.')
    await advance(119)
    expect(p.texts()).toEqual([])
    await advance(1)
    expect(p.texts()).toEqual([UH, 'Turn left.'])
    expect(played(p.log)).toEqual([])
    await advance(1500)
    expect(p.words()).toEqual(['Turn left.'])
    expect(p.speaker.busy()).toBe(false)
  })

  it.each([
    ['tick', { opener: false }],
    ['opener', { opener: true }],
  ])('the words go, with no wait for it, when the %s can’t be played', async (_name, opts) => {
    const p = phone({ keepAlive: false, ...opts })
    p.state.throwOnSound = true
    p.speaker.say('Turn left.')
    await advance(119)
    expect(p.texts()).toEqual([])
    await advance(1)
    expect(p.texts()).toEqual([UH, 'Turn left.'])
    await advance(1500)
    expect(p.words()).toEqual(['Turn left.'])
    expect(p.speaker.busy()).toBe(false)
  })

  it('the words still wait out a beep that has just started', async () => {
    const p = phone({ keepAlive: false, opener: true })
    p.state.readyFails = 'rejects'
    p.speaker.say('No throw, 14.', { ...WARNING, afterMs: 950 })
    await advance(949)
    expect(p.texts()).toEqual([])
    await advance(1)
    expect(p.texts()).toEqual([UH, 'No throw, 14.'])
  })

  it('what waits behind the words is said after them', async () => {
    const p = phone({ keepAlive: false, opener: true })
    p.state.readyFails = 'throws'
    p.state.throwOnSound = true
    p.speaker.say('No throw, 17.', WARNING)
    p.speaker.say('Starboard', { queue: true })
    await advance(3000)
    expect(p.words()).toEqual(['No throw, 17.', 'Starboard'])
    expect(p.speaker.busy()).toBe(false)
    expect(p.state.wrong).toEqual([])
  })

  it('words stopped stay stopped, though making sound ready fails after they were', async () => {
    const p = phone({ keepAlive: false, opener: true })
    p.state.readyFails = 'rejects'
    p.speaker.say('Turn left.')
    p.speaker.stop()
    await advance(1000)
    expect(p.texts()).toEqual([])
    expect(p.speaker.busy()).toBe(false)
  })
})

describe('words that never end', () => {
  /** Handed over at 120: 'No throw, 17.' starts at 460 and is allowed 3 s and 1.2 s for each of its 3 words. */
  const ALLOWED = END_ALLOW_MS + 3 * END_WORD_MS

  it('are given about 3 s and 1.2 s a word', () => {
    expect(END_ALLOW_MS).toBe(3000)
    expect(END_WORD_MS).toBe(1200)
  })

  it('are taken to be over once they have had far longer than they could take, and what waits is said', async () => {
    const p = phone()
    p.state.hang = 'end'
    p.speaker.say('No throw, 17.', WARNING)
    await advance(460)
    expect(p.words()).toEqual(['No throw, 17.'])
    p.speaker.say('Bundle drop, Co-op.', WHOLE)
    await advance(ALLOWED - 1)
    expect(p.log).not.toContain('cancel')
    await advance(1)
    expect(p.log.at(-1)).toBe('cancel')
    await advance(1500)
    expect(p.words()).toEqual(['No throw, 17.', 'Bundle drop, Co-op.'])
    expect(p.state.wrong).toEqual([])
  })

  it('do not leave the voice silent when no cue can break in on them', async () => {
    const p = phone()
    p.state.hang = 'end'
    p.speaker.say(BLOCK, WHOLE)
    await advance(500)
    // An ordinary urgent cue can't break in on words said whole: nothing but the timer frees it.
    p.speaker.say('Turn left now.', { urgent: true })
    await advance(END_ALLOW_MS + 7 * END_WORD_MS)
    await advance(1000)
    expect(p.words()).toEqual([BLOCK, 'Turn left now.'])
    expect(p.speaker.busy()).toBe(true)
    await advance(2000)
    expect(p.speaker.busy()).toBe(false)
  })

  it('leave it free when nothing waits, and count as the phone speaking until they were stopped', async () => {
    const p = phone()
    p.state.hang = 'end'
    p.speaker.say('No throw, 17.', WARNING)
    await advance(460 + ALLOWED)
    expect(p.speaker.busy()).toBe(false)
    expect(p.speaker.holding()).toEqual([])
    await advance(1000)
    p.speaker.say('Next.')
    await advance(200)
    expect(p.texts()).toEqual([UH, 'No throw, 17.', 'Next.'])
  })

  it('get time by how many words they are, a long row of houses more than a side word', async () => {
    const row = 'No throw, 2, 4, 6, 8, 10, 12, and 2 more.'
    const p = phone()
    p.state.hang = 'end'
    p.speaker.say(row, WARNING)
    await advance(460 + END_ALLOW_MS + 11 * END_WORD_MS - 1)
    expect(p.log).not.toContain('cancel')
    await advance(1)
    expect(p.log.at(-1)).toBe('cancel')
  })

  it('are not cut off in a long row of four-figure numbers, each of which takes as long to say as several words', async () => {
    // Said in full, with a pause at each comma, it takes about 13 s, and it counts as only 11 words.
    const row = 'No throw, 1202, 1204, 1206, 1208, 1210, 1212, and 3 more.'
    const p = phone({ wordMs: 1200 })
    p.speaker.say(row, WARNING)
    await advance(460 + 11 * 1200 + 1)
    expect(p.log).toContain(`end ${row}`)
    expect(p.log).not.toContain('cancel')
    expect(p.speaker.busy()).toBe(false)
  })

  it('still go on as soon as the phone does report their end, without being stopped', async () => {
    const p = phone()
    p.speaker.say('No throw, 17.', WARNING)
    await advance(460 + 3 * 350 + 1)
    expect(p.speaker.busy()).toBe(false)
    await advance(ALLOWED * 2)
    expect(p.log).not.toContain('cancel')
  })

  it('do not stop the next words: the time for those that ended goes with them', async () => {
    const p = phone()
    p.speaker.say('First.')
    p.speaker.say('One two three four five six seven eight nine ten eleven twelve', { queue: true })
    // 'First.' started at 460 and would have run out at 4660; the long words run from about 1150 to 5350.
    await advance(4500)
    expect(p.log).not.toContain('cancel')
    await advance(2000)
    expect(p.log).not.toContain('cancel')
    expect(p.speaker.busy()).toBe(false)
  })

  it('do not stop what broke in on them: the time for what is stopped goes with it', async () => {
    const p = phone()
    p.speaker.say('A turn now.')
    await advance(500)
    // 'A turn now.' started at 460 and would have run out at 7060; what breaks in on it runs from about 720 to 7720.
    p.speaker.say('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty', { urgent: true })
    await advance(7000)
    expect(p.log.filter((l) => l === 'cancel')).toHaveLength(1)
  })

  it('are forgotten when speech is stopped, with their time', async () => {
    const p = phone()
    p.state.hang = 'end'
    p.speaker.say('No throw, 17.', WARNING)
    await advance(500)
    p.speaker.stop()
    await advance(10)
    expect(vi.getTimerCount()).toBe(0)
    expect(p.log.filter((l) => l === 'cancel')).toHaveLength(1)
  })

  it('do not take the late start of words stopped for the start of the next', async () => {
    const { speaker, said, log } = fake({ keepAlive: true })
    speaker.say('A turn.')
    await advance(120)
    speaker.say('No throw, 14.', { urgent: true })
    await advance(200)
    expect(said).toHaveLength(2)
    said[0].onstart?.()
    // No start has been heard from the words now in hand, so they are still watched for one.
    await advance(WATCHDOG_MS)
    expect(log.filter((l) => l === 'cancel')).toHaveLength(2)
  })

  it('go on, and do not throw from a timer, when the phone will not even be stopped', async () => {
    const p = phone()
    p.state.hang = 'end'
    p.state.throwOnCancel = true
    p.speaker.say('No throw, 17.', WARNING)
    p.speaker.say('Starboard', { queue: true })
    await advance(460 + ALLOWED + 10)
    expect(p.speaker.holding()).toEqual([])
    await advance(1000)
    expect(p.words()).toEqual(['No throw, 17.', 'Starboard'])
  })
})

describe('the end of words reported twice', () => {
  it('is taken once, so the second report does not start the next cue beside the first', async () => {
    const { speaker, log, said, start, end } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    start()
    speaker.say('Port', { queue: true })
    speaker.say('Transit', { queue: true })
    end()
    said[0].onerror?.()
    end()
    await advance(1000)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak First.', 'speak Port'])
  })
})

describe('the order of cues with a lead-in before them', () => {
  it('a side word breaks in on an alert’s words as before, and they are said again in full, before the alert that waits', async () => {
    const p = phone()
    p.speaker.say(BLOCK, WHOLE)
    await advance(600)
    p.speaker.say('Bundle drop, Co-op.', WHOLE)
    p.speaker.say('Starboard', { queue: true })
    await advance(8000)
    expect(p.words()).toEqual([BLOCK, 'Starboard', BLOCK, 'Bundle drop, Co-op.'])
    expect(p.log.filter((l) => l === 'cancel')).toHaveLength(1)
  })

  it('nothing breaks in on a warning while its lead-in is said: a side word and an alert follow it, the side word first', async () => {
    const p = phone()
    p.speaker.say('No throw, 17.', WARNING)
    await advance(300)
    p.speaker.say('Bundle drop, Co-op.', WHOLE)
    p.speaker.say('Starboard', { queue: true })
    await advance(5000)
    expect(p.words()).toEqual(['No throw, 17.', 'Starboard', 'Bundle drop, Co-op.'])
    expect(p.log).not.toContain('cancel')
  })

  it('an ordinary urgent cue does not break in on a cue said whole during its lead-in, but follows it', async () => {
    const p = phone()
    p.speaker.say(BLOCK, WHOLE)
    await advance(300)
    p.speaker.say('Turn left now.', { urgent: true })
    await advance(6000)
    expect(p.words()).toEqual([BLOCK, 'Turn left now.'])
    expect(p.log).not.toContain('cancel')
  })

  it('a newer ordinary cue still replaces one that waits, during the lead-in', async () => {
    const p = phone()
    p.speaker.say('First.')
    await advance(300)
    p.speaker.say('Second.')
    p.speaker.say('Third.')
    await advance(3000)
    expect(p.words()).toEqual(['First.', 'Third.'])
  })
})

describe('whatever comes up on the road', () => {
  /** The same run every time: a small generator with a seed, so a failure can be looked at. */
  const generator = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  it('never has two lots of words with the phone, nor a lead-in without its words, and always comes back to rest', { timeout: 60_000 }, async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const random = generator(seed)
      const p = phone({ keepAlive: random() < 0.5, opener: random() < 0.5, wordMs: 100 + random() * 300, leadMs: 100 + random() * 300, startMs: random() * 400 })
      const words = ['Port', 'Starboard', 'Turn left soon.', 'No throw, 17.', BLOCK]
      for (let step = 0; step < 40; step++) {
        const text = `${words[Math.floor(random() * words.length)]} ${step}`
        const roll = random()
        const stale = random() < 0.2 ? () => random() < 0.5 : undefined
        const afterMs = random() < 0.3 ? 950 : 0
        if (roll < 0.25) p.speaker.say(text, { stale, afterMs })
        else if (roll < 0.4) p.speaker.say(text, { urgent: true, stale, afterMs })
        else if (roll < 0.6) p.speaker.say(text, { ...WHOLE, stale, afterMs })
        else if (roll < 0.75) p.speaker.say(text, { ...WARNING, stale, afterMs })
        else if (roll < 0.92) p.speaker.say(text, { queue: true, stale, afterMs })
        else if (roll < 0.96) p.speaker.unlock()
        else p.speaker.stop()
        const glitch = random()
        if (glitch < 0.08) p.state.hang = 'start'
        else if (glitch < 0.16) p.state.hang = 'end'
        else if (glitch < 0.24) p.state.hang = 'fail'
        await advance(random() < 0.3 ? random() * 200 : random() * 3000)
      }
      p.state.hang = null
      await advance(120_000)
      expect({ seed, wrong: p.state.wrong }).toEqual({ seed, wrong: [] })
      expect({ seed, busy: p.speaker.busy(), held: p.speaker.holding().length, timers: vi.getTimerCount() }).toEqual({ seed, busy: false, held: 0, timers: 0 })
    }
  })
})

describe('on the phone, after a silence', () => {
  it('says a very quiet lead-in just ahead of the words, and stopping drops them', async () => {
    const spoken: { text: string; volume: number }[] = []
    class Words {
      lang = ''
      volume = 1
      text: string
      constructor(text: string) {
        this.text = text
      }
    }
    vi.stubGlobal('navigator', { language: 'en-GB' })
    vi.stubGlobal('SpeechSynthesisUtterance', Words)
    vi.stubGlobal('speechSynthesis', {
      paused: false,
      cancel: () => undefined,
      resume: () => undefined,
      getVoices: () => [],
      speak: (w: Words) => spoken.push(w),
    })
    say('Turn left.')
    await advance(500)
    expect(spoken.map((w) => w.text)).toEqual([LEAD_IN.text, 'Turn left.'])
    expect(spoken[0].volume).toBe(LEAD_IN.volume)
    stopSpeaking()
  })
})

describe('the phone’s speech with the phone’s own sound', () => {
  /** The app's real speech and sound, new for each test, over a stand-in for the phone: what was played, by pitch, and what was said. */
  async function realThing() {
    vi.useRealTimers()
    vi.resetModules()
    const notes: number[] = []
    const spoken: string[] = []
    const ctx = {
      state: 'running',
      currentTime: 0,
      sampleRate: 8000,
      destination: {},
      resume() {
        this.state = 'running'
        return Promise.resolve()
      },
      suspend() {
        this.state = 'suspended'
        return Promise.resolve()
      },
      createOscillator: () => ({ frequency: { value: 0 }, connect: () => ({ connect: () => undefined }), start: () => undefined, stop: () => undefined }),
      createGain: () => ({
        gain: { value: 0, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined },
        connect: () => ({ connect: () => undefined }),
      }),
      createBuffer: (_channels: number, length: number) => {
        const samples = new Float32Array(length)
        return { getChannelData: () => samples }
      },
      createBufferSource: () => ({ loop: false, buffer: null, connect: () => ({ connect: () => undefined }), start: () => undefined, stop: () => undefined, disconnect: () => undefined }),
    }
    const make = ctx.createOscillator
    ctx.createOscillator = () => {
      const o = make()
      o.start = () => void notes.push(o.frequency.value)
      return o
    }
    const handed: { onerror?: () => void }[] = []
    class Words {
      lang = ''
      volume = 1
      text: string
      onerror?: () => void
      constructor(text: string) {
        this.text = text
      }
    }
    vi.stubGlobal('window', {
      AudioContext: class {
        constructor() {
          return ctx
        }
      },
    })
    vi.stubGlobal('navigator', { language: 'en-GB' })
    vi.stubGlobal('SpeechSynthesisUtterance', Words)
    vi.stubGlobal('speechSynthesis', {
      paused: false,
      cancel: () => undefined,
      resume: () => undefined,
      getVoices: () => [],
      speak: (w: Words) => {
        spoken.push(w.text)
        handed.push(w)
      },
    })
    const { sound, TICK_SECONDS, OPENER_SECONDS } = await import('./sound')
    const speech = await import('./speech')
    vi.useFakeTimers()
    sound.unlock()
    return { ctx, notes, spoken, handed, sound, speech, TICK_SECONDS, OPENER_SECONDS }
  }

  afterEach(() => vi.resetModules())

  it('needs nothing before the words with the signal running but the lead-in, which starts sooner', async () => {
    const { notes, spoken, sound, speech } = await realThing()
    sound.startKeepAlive()
    speech.say('Turn left.')
    await advance(120)
    expect(notes).toEqual([])
    expect(spoken).toEqual([LEAD_IN.text, 'Turn left.'])
    speech.stopSpeaking()
    sound.stopKeepAlive()
  })

  it.each(['suspended', 'interrupted'])('takes a signal whose audio is %s for no signal, and opens the link itself', async (state) => {
    const { ctx, notes, spoken, sound, speech } = await realThing()
    sound.startKeepAlive()
    ctx.state = state
    speech.say('Turn left.')
    await advance(0)
    // The audio is awake again now, and the signal with it, but it was not when the words were asked for.
    expect(ctx.state).toBe('running')
    expect(sound.keepingAlive()).toBe(true)
    expect(notes).toHaveLength(1)
    await advance(690)
    expect(spoken).toEqual([])
    await advance(20)
    expect(spoken).toEqual([LEAD_IN.text, 'Turn left.'])
    speech.stopSpeaking()
    sound.stopKeepAlive()
  })

  it('plays the opener, not the tick, with no signal after a silence, and only the tick soon after a beep', async () => {
    const { notes, spoken, sound, speech } = await realThing()
    speech.say('Turn left.')
    await advance(0)
    const [opener] = notes
    await advance(800)
    expect(spoken).toEqual([LEAD_IN.text, 'Turn left.'])
    speech.stopSpeaking()
    notes.length = 0
    // Well after that opener, a beep goes out with no words to follow it, and a second later a word is due.
    await advance(5000)
    sound.bundle()
    await advance(1000)
    notes.length = 0
    speech.say('Keep left.')
    await advance(0)
    expect(notes).toHaveLength(1)
    expect(notes[0]).not.toBe(opener)
    speech.stopSpeaking()
  })

  it('says the words, a second late at most, when the audio will neither wake nor stop', async () => {
    const { ctx, notes, spoken, speech } = await realThing()
    ctx.state = 'interrupted'
    ctx.resume = () => new Promise<void>(() => {})
    ctx.suspend = () => new Promise<void>(() => {})
    speech.say('Turn left.')
    await advance(1069)
    expect(spoken).toEqual([])
    await advance(1)
    expect(spoken).toEqual([LEAD_IN.text, 'Turn left.'])
    expect(notes).toEqual([])
    speech.stopSpeaking()
  })

  it('says the words when the audio throws as it is woken', async () => {
    const { ctx, notes, spoken, speech } = await realThing()
    ctx.state = 'interrupted'
    ctx.resume = () => {
      throw new Error('no')
    }
    speech.say('Turn left.')
    await advance(120)
    expect(spoken).toEqual([LEAD_IN.text, 'Turn left.'])
    expect(notes).toEqual([])
    speech.stopSpeaking()
  })

  it('says the words, with no wait for what was not played, when the audio can’t play a note', async () => {
    const { ctx, spoken, speech } = await realThing()
    ctx.createOscillator = () => {
      throw new Error('no')
    }
    speech.say('Turn left.')
    await advance(120)
    expect(spoken).toEqual([LEAD_IN.text, 'Turn left.'])
    speech.stopSpeaking()
  })

  it('says the words again when the phone reports them failed', async () => {
    const { spoken, handed, sound, speech } = await realThing()
    sound.startKeepAlive()
    speech.say('Turn left.')
    await advance(120)
    handed[1].onerror?.()
    await advance(80)
    expect(spoken).toEqual([LEAD_IN.text, 'Turn left.', LEAD_IN.text, 'Turn left.'])
    speech.stopSpeaking()
    sound.stopKeepAlive()
  })
})
