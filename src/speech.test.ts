import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSpeaker, pickVoice, say, speechAvailable, stopSpeaking, unlockSpeech, voiceLanguage } from './speech'

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
