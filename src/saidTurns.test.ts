import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markTurnSaid } from './saidTurns'
import { createSpeaker } from './speech'
import { cueToSay, turnKey } from './transitView'
import type { TurnCue } from './turns'

describe('marking a turn cue said as its words are asked for', () => {
  it('marks it at once, so the next fix does not ask for it again while it waits', () => {
    const said = new Map<number, TurnCue>()
    markTurnSaid(said, 300, 'far', () => false)
    expect(said.get(300)).toBe('far')
  })

  it('takes the mark back when the words are dropped as out of date, to what was said before them', () => {
    const said = new Map<number, TurnCue>([[300, 'far']])
    let stale = false
    const check = markTurnSaid(said, 300, 'near', () => stale)
    expect(said.get(300)).toBe('near')
    stale = true
    expect(check()).toBe(true)
    expect(said.get(300)).toBe('far')
    // Words for a turn nothing had been said of leave none.
    const fresh = markTurnSaid(said, 500, 'far', () => true)
    expect(fresh()).toBe(true)
    expect(said.has(500)).toBe(false)
  })

  it('leaves it while the words are in date, and takes it back if they are out of date by the last look before they start', () => {
    const said = new Map<number, TurnCue>([[300, 'far']])
    let stale = false
    const check = markTurnSaid(said, 300, 'near', () => stale)
    expect(check()).toBe(false)
    expect(said.get(300)).toBe('near')
    // The engine looks again just before the words start, after the tick: out of date by then, they are dropped, and the mark goes back.
    stale = true
    expect(check()).toBe(true)
    expect(said.get(300)).toBe('far')
    // Asked once more, it does nothing more.
    stale = false
    expect(check()).toBe(false)
    expect(said.get(300)).toBe('far')
  })

  it('takes back only its own mark: not one made since by later words, nor one the round took out or made again', () => {
    const said = new Map<number, TurnCue>()
    const far = markTurnSaid(said, 300, 'far', () => true)
    markTurnSaid(said, 300, 'near', () => false)
    expect(far()).toBe(true)
    expect(said.get(300)).toBe('near')
    // Cleared for a fresh start while the words waited: still cleared.
    const cleared = markTurnSaid(said, 400, 'near', () => true)
    said.delete(400)
    expect(cleared()).toBe(true)
    expect(said.has(400)).toBe(false)
    // Taken out and made again by new words of the same cue: the new words' mark stands.
    const old = markTurnSaid(said, 500, 'near', () => true)
    said.delete(500)
    markTurnSaid(said, 500, 'near', () => false)
    expect(old()).toBe(true)
    expect(said.get(500)).toBe('near')
    // Once taken back, asked again it does nothing more.
    const twice = markTurnSaid(said, 600, 'far', () => true)
    twice()
    said.set(600, 'far')
    twice()
    expect(said.get(600)).toBe('far')
  })

  // In these two a cue was said of the turn before the words that are dropped, so taking their mark back would put that cue back.
  it('puts no earlier cue back into marks the round cleared for a fresh start while the words waited', () => {
    // The round clears all its marks for a fresh start (see Round.tsx), and they stay cleared: the earlier cue was said on the round before.
    const said = new Map<number, TurnCue>([[300, 'far']])
    const check = markTurnSaid(said, 300, 'near', () => true)
    said.clear()
    expect(check()).toBe(true)
    expect(said.size).toBe(0)
  })

  it('puts no earlier cue back into a mark the round took out on a rejoin while the words waited', () => {
    // On a rejoin the round takes out the marks near where the route was left, so their turns are said again from the first cue: that one stays
    // out, and the others are left as they are.
    const said = new Map<number, TurnCue>([
      [300, 'far'],
      [900, 'near'],
    ])
    const check = markTurnSaid(said, 300, 'near', () => true)
    said.delete(300)
    expect(check()).toBe(true)
    expect(said.has(300)).toBe(false)
    expect([...said]).toEqual([[900, 'near']])
  })

  it('keeps each map to itself', () => {
    const one = new Map<number, TurnCue>()
    const two = new Map<number, TurnCue>()
    const first = markTurnSaid(one, 300, 'near', () => true)
    markTurnSaid(two, 300, 'near', () => true)
    expect(first()).toBe(true)
    expect([one.has(300), two.get(300)]).toEqual([false, 'near'])
  })
})

interface FakeUtterance {
  text: string
  lang: string
  volume: number
  voice: unknown
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

/**
 * The turn words as the round screen asks for them (see Round.tsx), with the real speaker over a phone that says one thing at a time, a third of a
 * second a word. The car comes up to a U-turn at 300 m a fix a second; the card is up for it or not, as `card` says, and the voice asks for the cue
 * for where it is, marked through `markTurnSaid`, with the words out of date once the card is no longer for the U-turn. A long no-throw row is said
 * at the fix `rowAt`, so the U-turn's last word waits behind it.
 */
async function drive(card: (ahead: number) => boolean, rowAt: number) {
  const heard: string[] = []
  const line: FakeUtterance[] = []
  const next = () => {
    const u = line[0]
    if (!u) return
    setTimeout(() => {
      u.onstart?.()
      setTimeout(
        () => {
          heard.push(u.text)
          line.shift()
          u.onend?.()
          next()
        },
        330 * u.text.split(' ').length,
      )
    }, 100)
  }
  const speaker = createSpeaker<FakeUtterance>({
    speak: (u) => {
      line.push(u)
      if (line.length === 1) next()
    },
    cancel: () => void line.splice(0),
    resume: () => undefined,
    paused: () => false,
    voices: () => [],
    makeUtterance: (text) => ({ text, lang: '', volume: 1, voice: undefined, onstart: null, onend: null, onerror: null }),
    ready: async () => true,
    keepingAlive: () => true,
    tick: () => 0,
    language: () => 'en-AU',
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  const said = new Map<number, TurnCue>()
  const uturn = { at: 300, angle: 180 }
  let nextAt: number | null = null
  for (let along = 80; along <= 300; along += 10) {
    const ahead = uturn.at - along
    if (ahead === rowAt) speaker.say('No throw, 2, 4, 6, 8, 10, 12, and 2 more.', { urgent: true, whole: true, warning: true })
    nextAt = card(ahead) ? uturn.at : null
    const spoken = nextAt === null ? null : cueToSay(uturn, ahead, said.get(turnKey(uturn.at)) ?? null, false)
    if (spoken) speaker.say(spoken.text, { stale: markTurnSaid(said, turnKey(uturn.at), spoken.cue, () => nextAt !== uturn.at) })
    await vi.advanceTimersByTimeAsync(1000)
  }
  await vi.advanceTimersByTimeAsync(10_000)
  return heard.filter((text) => !text.startsWith('No throw'))
}

describe('a U-turn whose card blanks while its last word waits', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says the last word when the card comes back, where it was lost before', async () => {
    // The row is said at 70 m; the last word is asked for at 60 m, behind it, and the card is down from 50 m to 40 m, as on a bend into the court.
    const heard = await drive((ahead) => ahead > 50 || ahead < 40, 70)
    expect(heard).toEqual(['In 200 metres, make a U-turn.', 'Make a U-turn.'])
  })

  it('says it once when the card comes back before its turn, as it is then in date', async () => {
    const heard = await drive((ahead) => ahead !== 50, 70)
    expect(heard).toEqual(['In 200 metres, make a U-turn.', 'Make a U-turn.'])
  })

  it('never says a cue twice, however the card comes and goes', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      // A card that is up or down by a fixed pattern for each seed, and the row at any of the fixes the last word could wait behind.
      const down = new Set(Array.from({ length: 23 }, (_, k) => 220 - 10 * k).filter((a) => ((a * 7919 + seed * 104729) >>> 3) % 3 === 0))
      const heard = await drive((ahead) => !down.has(ahead), 40 + 10 * (seed % 5))
      // The warning says how far, which changes as the car comes on, so it is told by its first words.
      const cues = heard.map((text) => (text.startsWith('In ') ? 'far' : 'near'))
      expect(new Set(cues).size, `seed ${seed}: ${heard.join(' | ')}`).toBe(cues.length)
    }
  })
})
