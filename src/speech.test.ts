import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSpeaker, CUT_GRACE_MS, pickVoice, QUEUE_MAX, say, speechAvailable, stopSpeaking, unlockSpeech, voiceLanguage } from './speech'

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
  const state = { paused: false, keepAlive: options.keepAlive ?? false, throwOnSpeak: false }
  const speaker = createSpeaker<FakeUtterance>({
    speak: (u) => {
      if (state.throwOnSpeak) throw new Error('no')
      log.push(`speak ${u.text}`)
      said.push(u)
    },
    cancel: () => void log.push('cancel'),
    resume: () => void log.push('resume'),
    paused: () => state.paused,
    voices: () => options.voices ?? [],
    makeUtterance: (text) => ({ text, lang: '', volume: 1, voice: undefined, onstart: null, onend: null, onerror: null }),
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

  it('goes on to what is waiting when the words fail, as a cancelled word does in Safari', async () => {
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
    speaker.say('Right', { queue: true })
    await advance(200)
    expect(spoken(log)).toEqual(['speak Right'])
  })

  it('are not cut off by an urgent word, which is said as they end', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Right', { queue: true })
    await advance(200)
    start()
    speaker.say('No throw, 24, 28.', { urgent: true })
    await advance(1000)
    expect(log).not.toContain('cancel')
    expect(spoken(log)).toEqual(['speak Right'])
    end()
    await advance(150)
    expect(spoken(log)).toEqual(['speak Right'])
    await advance(250)
    expect(spoken(log)).toEqual(['speak Right', 'speak No throw, 24, 28.'])
    expect(log).not.toContain('cancel')
  })

  it('are said first when an urgent word is asked for at the very same moment', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Left', { queue: true })
    speaker.say('No throw, 14.', { urgent: true, afterMs: 600 })
    await advance(200)
    expect(spoken(log)).toEqual(['speak Left'])
    start()
    end()
    await advance(500)
    expect(spoken(log)).toEqual(['speak Left', 'speak No throw, 14.'])
    expect(log).not.toContain('cancel')
  })

  it('wait their turn behind an urgent word that is already being got ready', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('No throw, 14.', { urgent: true })
    speaker.say('Left', { queue: true })
    await advance(200)
    expect(spoken(log)).toEqual(['speak No throw, 14.'])
    start()
    end()
    await advance(500)
    expect(spoken(log)).toEqual(['speak No throw, 14.', 'speak Left'])
  })

  it('are said in order, and no newer word replaces one', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    start()
    speaker.say('Left', { queue: true })
    speaker.say('Transit', { queue: true })
    speaker.say('Older.')
    speaker.say('Newer.')
    for (let i = 0; i < 3; i++) {
      end()
      await advance(300)
      start()
    }
    end()
    await advance(300)
    expect(spoken(log)).toEqual(['speak First.', 'speak Left', 'speak Transit', 'speak Newer.'])
  })

  it('are said before the urgent word that broke in on an ordinary one, which follows them', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('In 200 metres, turn left.')
    await advance(300)
    start()
    speaker.say('Right', { queue: true })
    speaker.say('No throw, 24.', { urgent: true })
    // The ordinary word is broken in on, as an urgent word does, but the queued one is said before the urgent one.
    expect(log.at(-1)).toBe('cancel')
    await advance(300)
    expect(spoken(log)).toEqual(['speak In 200 metres, turn left.', 'speak Right'])
    start()
    end()
    await advance(400)
    expect(spoken(log)).toEqual(['speak In 200 metres, turn left.', 'speak Right', 'speak No throw, 24.'])
  })

  it('leave only the newest urgent word to follow them, and an ordinary word after that', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Right', { queue: true })
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
    expect(spoken(log)).toEqual(['speak Right', 'speak No throw, 16.', 'speak In 60 metres, turn left.'])
  })

  it('keep only the newest few when more are asked for than can be said', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('First.')
    await advance(300)
    start()
    const sides = ['Left', 'Right', 'Both', 'Transit', 'Left', 'Right']
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
    speaker.say('Left', { queue: true, stale: () => out })
    speaker.say('Right', { queue: true })
    out = true
    end()
    await advance(400)
    start()
    end()
    await advance(400)
    expect(spoken(log)).toEqual(['speak First.', 'speak Right'])
  })

  it('are forgotten, with the urgent word that waits for them, when speech is stopped', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Right', { queue: true })
    await advance(200)
    start()
    speaker.say('Left', { queue: true })
    speaker.say('No throw, 14.', { urgent: true })
    speaker.stop()
    expect(speaker.busy()).toBe(false)
    await advance(2000)
    expect(spoken(log)).toEqual(['speak Right'])
    // Nor do they come back after the next word that is said.
    speaker.say('Turn left.')
    await advance(300)
    start()
    await advance(300)
    expect(spoken(log)).toEqual(['speak Right', 'speak Turn left.'])
    end()
    await advance(1000)
    expect(spoken(log)).toEqual(['speak Right', 'speak Turn left.'])
  })

  it('are forgotten, with an urgent word that waits for them, when speech is stopped and the stop is followed by words', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Right', { queue: true })
    await advance(200)
    start()
    speaker.say('No throw, 14.', { urgent: true })
    speaker.stop()
    speaker.say('Turn left.')
    await advance(300)
    start()
    end()
    await advance(1000)
    expect(spoken(log)).toEqual(['speak Right', 'speak Turn left.'])
  })

  it('are said before an urgent word that was asked for after them', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Right', { queue: true })
    await advance(200)
    start()
    speaker.say('Left', { queue: true })
    speaker.say('No throw, 14.', { urgent: true })
    end()
    await advance(400)
    start()
    end()
    await advance(400)
    expect(spoken(log)).toEqual(['speak Right', 'speak Left', 'speak No throw, 14.'])
  })

  it('are not cut off by an urgent word in the gap between the word before them and them', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('In 200 metres, turn left.')
    await advance(300)
    start()
    speaker.say('Right', { queue: true })
    end()
    // 'Right' is next, and is about to start.
    await advance(50)
    speaker.say('No throw, 14.', { urgent: true })
    expect(log).not.toContain('cancel')
    await advance(300)
    expect(spoken(log)).toEqual(['speak In 200 metres, turn left.', 'speak Right'])
    start()
    end()
    await advance(400)
    expect(spoken(log)).toEqual(['speak In 200 metres, turn left.', 'speak Right', 'speak No throw, 14.'])
    expect(log).not.toContain('cancel')
  })

  it('leave it free for the next word once they are said', async () => {
    const { speaker, log, start, end } = fake({ keepAlive: true })
    speaker.say('Right', { queue: true })
    await advance(200)
    start()
    end()
    expect(speaker.busy()).toBe(false)
    speaker.say('No throw, 14.', { urgent: true })
    await advance(300)
    expect(spoken(log)).toEqual(['speak Right', 'speak No throw, 14.'])
    expect(log).not.toContain('cancel')
  })
})

describe('an alert’s words, said whole', () => {
  const spoken = (log: string[]) => log.filter((l) => l.startsWith('speak'))
  const BLOCK = 'Apartment block, Lakeside Apartments, 12 papers, left.'

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
    speaker.say('Right', { queue: true })
    expect(log.at(-1)).toBe('cancel')
    // Safari reports the words cut off as an error, which comes late and is not taken for the end of the side word.
    said[0].onerror?.()
    await advance(300)
    expect(spoken(log)).toEqual([`speak ${BLOCK}`, 'speak Right'])
    // An alert that comes while the side word is said follows it, after the words it cut off and the alert that waited for them.
    start()
    speaker.say('Special request, 14.', { urgent: true, whole: true })
    for (let i = 0; i < 3; i++) {
      end()
      await advance(400)
      start()
    }
    expect(spoken(log)).toEqual([`speak ${BLOCK}`, 'speak Right', `speak ${BLOCK}`, 'speak Bundle drop, Co-op.', 'speak Special request, 14.'])
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
  const BLOCK = 'Apartment block, Lakeside Apartments, 12 papers, left.'
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
    f.speaker.say('Right', { queue: true })
    await advance(200)
    f.start()
    f.speaker.say('No throw, 17.', WARNING)
    await advance(1000)
    expect(f.log).not.toContain('cancel')
    await sayOn(f, 1)
    f.end()
    await advance(1000)
    expect(spoken(f.log)).toEqual(['speak Right', 'speak No throw, 17.'])
    expect(f.log).not.toContain('cancel')
  })

  it('a side word asked on the same fix as a warning, after it, is said right after it', async () => {
    const f = fake({ keepAlive: true })
    // The round screen asks for the alert's words first, then the side word, so a no-throw row is begun before the house; both wait out
    // the beep.
    f.speaker.say('No throw, 17.', { ...WARNING, afterMs: 950 })
    f.speaker.say('Left', { queue: true, afterMs: 950 })
    await advance(1000)
    expect(spoken(f.log)).toEqual(['speak No throw, 17.'])
    f.start()
    f.end()
    // The gap between words and the lead-in: the beep was waited out with the row.
    await advance(200 + 120)
    expect(spoken(f.log)).toEqual(['speak No throw, 17.', 'speak Left'])
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
    f.speaker.say('Left', { queue: true })
    f.speaker.say('No throw, 3.', WARNING)
    f.speaker.say('Right', { queue: true })
    await sayOn(f, 3)
    f.end()
    await advance(1000)
    expect(spoken(f.log)).toEqual(['speak In 200 metres, turn left.', 'speak No throw, 1.', 'speak Left', 'speak No throw, 3.', 'speak Right'])
    // Only the turn was cut off.
    expect(f.log.filter((l) => l === 'cancel')).toHaveLength(1)
  })

  it('no cue breaks in on one of the same rank: it follows it', async () => {
    for (const [first, second, options] of [
      ['No throw, 17.', 'No throw, 21.', WARNING],
      ['Left', 'Right', { queue: true }],
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
    f.speaker.say('Right', { queue: true })
    await advance(1000)
    expect(f.log).not.toContain('cancel')
    await sayOn(f, 2)
    f.end()
    await advance(1000)
    expect(spoken(f.log)).toEqual(['speak No throw, 17.', 'speak Right', `speak ${BLOCK}`])
  })

  it('those that wait go by rank, a warning and a side word being of one rank, and in a rank in the order asked', async () => {
    const f = fake({ keepAlive: true })
    f.speaker.say('No throw, 1.', WARNING)
    await advance(300)
    f.start()
    f.speaker.say('Special request, 2.', ALERT)
    f.speaker.say('Left', { queue: true })
    f.speaker.say('Bundle drop, 3.', ALERT)
    f.speaker.say('No throw, 4.', WARNING)
    await sayOn(f, 4)
    f.end()
    await advance(1000)
    expect(f.log).not.toContain('cancel')
    expect(spoken(f.log)).toEqual(['speak No throw, 1.', 'speak Left', 'speak No throw, 4.', 'speak Special request, 2.', 'speak Bundle drop, 3.'])
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
      f.speaker.say('Left', { queue: true })
      expect(f.log.at(-1)).toBe('cancel')
      await advance(300)
      f.start()
      f.end()
      await advance(2000)
      // Not begun a third time, ever further behind the car.
      expect(spoken(f.log)).toEqual([`speak ${NOTE}`, 'speak Both', `speak ${NOTE}`, 'speak Left'])
      expect(f.speaker.busy()).toBe(false)
    })

    it('are said again while the grace of the first cut lasts', async () => {
      const f = await upToAgain()
      await advance(100)
      f.speaker.say('Left', { queue: true })
      await advance(300)
      f.start()
      f.end()
      await advance(200 + 120)
      expect(spoken(f.log)).toEqual([`speak ${NOTE}`, 'speak Both', `speak ${NOTE}`, 'speak Left', `speak ${NOTE}`])
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
      f.speaker.say('Left', { queue: true })
      expect(f.log.at(-1)).toBe('cancel')
      await advance(300)
      f.start()
      f.end()
      await advance(200 + 120)
      // Cut off part way for the first time, it is given the grace now, and said again in full.
      expect(spoken(f.log)).toEqual(['speak Both', `speak ${NOTE}`, 'speak Left', `speak ${NOTE}`])
      f.start()
      // Once only: cut off again once that grace is over, it is left out.
      await advance(CUT_GRACE_MS)
      f.speaker.say('Both', { queue: true })
      await advance(300)
      f.start()
      f.end()
      await advance(2000)
      expect(spoken(f.log)).toEqual(['speak Both', `speak ${NOTE}`, 'speak Left', `speak ${NOTE}`, 'speak Both'])
      expect(f.speaker.busy()).toBe(false)
    })
  })

  it('a warning or an alert breaks in on a turn being said, behind a side word that waits for the turn', async () => {
    for (const [alert, options, order] of [
      ['No throw, 17.', WARNING, ['Right', 'No throw, 17.']],
      [BLOCK, ALERT, ['Right', BLOCK]],
    ] as const) {
      const f = fake({ keepAlive: true })
      f.speaker.say('In 200 metres, turn left.')
      await advance(300)
      f.start()
      // A side word waits for an ordinary word being said, as before.
      f.speaker.say('Right', { queue: true })
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
    f.speaker.say('Right', { queue: true })
    await advance(300)
    await sayOn(f, 2)
    f.end()
    await advance(1000)
    expect(spoken(f.log)).toEqual([`speak ${BLOCK}`, 'speak Right', `speak ${BLOCK}`, 'speak In 200 metres, turn left.'])
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
    speaker.say('Right', { queue: true })
    await advance(200)
    start()
    // A beep of 600 ms came with these words, which had to wait for 'Right' to be said.
    speaker.say('No throw, 14.', { urgent: true, afterMs: 600 })
    await advance(1000)
    end()
    // The gap between words and then the lead-in, but not the 600 ms of beep on top.
    await advance(200 + 150)
    expect(log.filter((l) => l.startsWith('speak'))).toEqual(['speak Right', 'speak No throw, 14.'])
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
    // The words were said at 120 ms and had 2500 ms to start.
    await advance(2330)
    expect(log.at(-1)).toBe('cancel')
    await advance(100)
    expect(log.filter((l) => l.startsWith('speak'))).toHaveLength(2)
  })

  it('are given up on after that, leaving it free for the next', async () => {
    const { speaker, log } = fake({ keepAlive: true })
    speaker.say('Turn left.')
    await advance(300 + 2600 + 100 + 2600)
    expect(log.filter((l) => l.startsWith('speak'))).toHaveLength(2)
    expect(speaker.busy()).toBe(false)
  })

  it('are left alone once they have started, however long they take', async () => {
    const { speaker, log, start } = fake({ keepAlive: true })
    speaker.say('A long one.')
    await advance(300)
    start()
    await advance(10000)
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
