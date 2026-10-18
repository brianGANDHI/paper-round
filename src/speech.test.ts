import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { speak, speechAvailable, stopSpeaking, unlockSpeech } from './speech'

/** A stand-in for the phone's speech: what it was asked to say, and whether it was busy when asked. */
function fakeSpeech(busy: { speaking?: boolean; pending?: boolean } = {}) {
  const said: { text: string; lang: string; volume: number }[] = []
  const calls: string[] = []
  class Words {
    lang = ''
    volume = 1
    text: string
    constructor(text: string) {
      this.text = text
    }
  }
  vi.stubGlobal('SpeechSynthesisUtterance', Words)
  vi.stubGlobal('speechSynthesis', {
    speaking: busy.speaking ?? false,
    pending: busy.pending ?? false,
    cancel: () => void calls.push('cancel'),
    speak: (w: Words) => {
      calls.push('speak')
      said.push({ text: w.text, lang: w.lang, volume: w.volume })
    },
  })
  return { said, calls }
}

afterEach(() => vi.unstubAllGlobals())

describe('speaking', () => {
  beforeEach(() => vi.stubGlobal('navigator', { language: 'en-GB' }))

  it('is available when the phone has speech, and not when it has none', () => {
    fakeSpeech()
    expect(speechAvailable()).toBe(true)
    vi.unstubAllGlobals()
    expect(speechAvailable()).toBe(false)
  })

  it('is not available when the phone can say words but has no way to make them', () => {
    vi.stubGlobal('speechSynthesis', { speaking: false, pending: false, cancel: () => {}, speak: () => {} })
    expect(speechAvailable()).toBe(false)
  })

  it('says the words, in the phone’s kind of English', () => {
    const { said } = fakeSpeech()
    speak('In 200 metres, turn left.')
    expect(said).toEqual([{ text: 'In 200 metres, turn left.', lang: 'en-GB', volume: 1 }])
  })

  it('says Australian English when the phone is set to another language', () => {
    vi.stubGlobal('navigator', { language: 'fr-FR' })
    const { said } = fakeSpeech()
    speak('Turn left.')
    expect(said[0].lang).toBe('en-AU')
  })

  it('does not take English for a language that only starts with the same letters', () => {
    vi.stubGlobal('navigator', { language: 'eng-XX' })
    const { said } = fakeSpeech()
    speak('Turn left.')
    expect(said[0].lang).toBe('en-AU')
  })

  it('drops what is still being said, so the newest word is the one heard', () => {
    const { calls } = fakeSpeech({ speaking: true })
    speak('Turn right.')
    expect(calls).toEqual(['cancel', 'speak'])
    const waiting = fakeSpeech({ pending: true })
    speak('Turn right.')
    expect(waiting.calls).toEqual(['cancel', 'speak'])
  })

  it('does not cut off anything when nothing is being said', () => {
    const { calls } = fakeSpeech()
    speak('Turn right.')
    expect(calls).toEqual(['speak'])
  })

  it('stops talking when told to', () => {
    const { calls } = fakeSpeech()
    stopSpeaking()
    expect(calls).toEqual(['cancel'])
  })

  it('says a word silently to unlock speech on a tap', () => {
    const { said } = fakeSpeech()
    unlockSpeech()
    expect(said).toHaveLength(1)
    expect(said[0].volume).toBe(0)
  })

  it('does nothing, and does not throw, where there is no speech', () => {
    expect(() => {
      speak('Turn left.')
      stopSpeaking()
      unlockSpeech()
    }).not.toThrow()
  })

  it('does not throw when the phone refuses to speak', () => {
    vi.stubGlobal('SpeechSynthesisUtterance', class {})
    vi.stubGlobal('speechSynthesis', {
      speaking: false,
      pending: false,
      cancel: () => {
        throw new Error('no')
      },
      speak: () => {
        throw new Error('no')
      },
    })
    expect(() => {
      speak('Turn left.')
      stopSpeaking()
      unlockSpeech()
    }).not.toThrow()
  })
})
