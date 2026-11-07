import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSideCue, sideLookAheadM, sideWords, testVoice, VOICE_TEST_GAP_MS } from './sideVoice'
import { COLD_MS, createSpeaker, LEAD_IN } from './speech'
import type { Side } from './types'

/*
 * The side words as the round screen says them, with the real cue and the real speaker over a stand-in for the phone's speech: each
 * change of the side thrown is asked for once, and said as a queued word that is dropped if it is out of date by the time it can be
 * said (the side has changed again since). A long no-throw row being said holds them up, as it warns of a wrong throw; any other
 * alert's words being said are broken in on, and said again in full after the side word. An alert that comes up while one is waiting
 * or being said follows it, whole, a no-throw row included: a side word and a row are said in the order asked, and neither cuts the
 * other off. On a fix where both come up, the round screen asks for the alerts' words first, then the side word.
 */

interface FakeUtterance {
  text: string
  lang: string
  volume: number
  voice: unknown
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

function round() {
  const said: FakeUtterance[] = []
  let cancels = 0
  const speaker = createSpeaker<FakeUtterance>({
    speak: (u) => void said.push(u),
    cancel: () => void cancels++,
    resume: () => undefined,
    paused: () => false,
    voices: () => [],
    makeUtterance: (text) => ({ text, lang: '', volume: 1, voice: undefined, onstart: null, onend: null, onerror: null }),
    ready: async () => true,
    keepingAlive: () => false,
    tick: () => 0.06,
    language: () => 'en-AU',
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  const cue = createSideCue()
  /** The driver comes to `along` metres with the side `here` where they are and `ahead` a few metres on: the change is said, as the round screen says it. */
  const drive = (here: Side, ahead: Side, along: number) => {
    const word = cue.update(here, ahead, along)
    if (word) speaker.say(sideWords(word), { queue: true, stale: () => cue.last() !== word })
  }
  /** The phone starts saying the latest word, and later finishes it. */
  const start = () => said.at(-1)?.onstart?.()
  const end = () => said.at(-1)?.onend?.()
  return { speaker, said, drive, start, end, spoken: () => said.map((u) => u.text), cancels: () => cancels }
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)
const ROW = 'No throw, 2, 4, 6, 8, 10, 12, and 2 more.'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// The round screen says a no-throw row as a warning (see `SayOptions.warning`); as a plain urgent word, as before, the side words are the same.
describe.each([
  ['said as a warning', { urgent: true, whole: true, warning: true }],
  ['said as an urgent word', { urgent: true }],
] as const)('the side words behind a long alert %s', (_, alert) => {
  /** Port at the start, then a long row of houses is said just before a short Starboard stretch, with Port again after it. */
  const upTo = async (r: ReturnType<typeof round>) => {
    r.drive('left', 'left', 0)
    await advance(300)
    r.start()
    r.end()
    r.speaker.say(ROW, alert)
    await advance(300)
    r.start()
    // The Starboard stretch comes up while the row is being said.
    r.drive('left', 'right', 88)
  }

  it('leaves out a side that has changed again while the row was said, and says the side the driver is now on', async () => {
    const r = round()
    await upTo(r)
    // Four seconds on, still in the row, the stretch after it comes up: Port again.
    await advance(4000)
    r.drive('right', 'left', 128)
    r.end()
    await advance(1000)
    r.start()
    r.end()
    await advance(1000)
    // Starboard, out of date by the time it could be said, is left out: Port is heard again, for the stretch the driver is on.
    expect(r.spoken()).toEqual(['Port', ROW, 'Port'])
  })

  it('says each change, in order, when the row is over before the side changes again', async () => {
    const r = round()
    await upTo(r)
    r.end()
    await advance(1000)
    r.start()
    r.end()
    r.drive('right', 'left', 128)
    await advance(1000)
    expect(r.spoken()).toEqual(['Port', ROW, 'Starboard', 'Port'])
  })
})

describe('a side word and the alerts said whole around it', () => {
  const ALERT = { urgent: true, whole: true } as const
  const WARNING = { urgent: true, whole: true, warning: true } as const
  const BLOCK = 'Apartment block, Lakeside Apartments, 12 papers, port.'

  it('is said before an alert that comes up on the same fix, breaking in before its words begin, and is not cut off by it', async () => {
    const r = round()
    r.drive('left', 'left', 0)
    await advance(300)
    r.start()
    r.end()
    // On one fix: an apartment block comes up, and the side ahead changes (the alert's words are asked for first, as the round screen does).
    r.speaker.say(BLOCK, { ...ALERT, afterMs: 270 })
    r.drive('left', 'right', 90)
    await advance(400)
    // The block's words, still waiting out their beep, were not begun.
    expect(r.spoken()).toEqual(['Port', 'Starboard'])
    r.start()
    r.end()
    await advance(400)
    expect(r.spoken()).toEqual(['Port', 'Starboard', BLOCK])
  })

  it('follows a no-throw row that comes up on the same fix, as the row is asked for first, and is said right after it', async () => {
    const r = round()
    r.drive('left', 'left', 0)
    await advance(300)
    r.start()
    r.end()
    // On one fix, as the round screen asks: the row, then the side word. The row warns of a wrong throw at a house just ahead, and the
    // side word, of its rank, waits for it rather than hold it up.
    r.speaker.say('No throw, 17.', { ...WARNING, afterMs: 950 })
    r.drive('left', 'right', 90)
    await advance(1100)
    expect(r.spoken()).toEqual(['Port', 'No throw, 17.'])
    r.start()
    r.end()
    await advance(400)
    expect(r.spoken()).toEqual(['Port', 'No throw, 17.', 'Starboard'])
    expect(r.cancels()).toBe(0)
  })

  it('asked while an alert is said, breaks in on it: the alert is said again in full right after it, then the alert that came up meanwhile', async () => {
    const r = round()
    r.drive('left', 'left', 0)
    await advance(300)
    r.start()
    r.end()
    r.speaker.say(BLOCK, ALERT)
    await advance(300)
    r.start()
    r.speaker.say('Bundle drop, Co-op.', ALERT)
    r.drive('left', 'right', 90)
    await advance(300)
    expect(r.spoken()).toEqual(['Port', BLOCK, 'Starboard'])
    // Starboard is being said when another alert comes up: it waits for Starboard, after the block and the bundle drop.
    r.start()
    r.speaker.say('Special request, 14.', ALERT)
    for (let i = 0; i < 3; i++) {
      r.end()
      await advance(400)
      r.start()
    }
    expect(r.spoken()).toEqual(['Port', BLOCK, 'Starboard', BLOCK, 'Bundle drop, Co-op.', 'Special request, 14.'])
  })

  it('is not cut off by a no-throw row that comes up as it is said: the row follows it, then the next change, then the alert it broke in on', async () => {
    const r = round()
    r.drive('left', 'left', 0)
    await advance(300)
    r.start()
    r.end()
    r.speaker.say(BLOCK, ALERT)
    await advance(300)
    r.start()
    r.drive('left', 'right', 90)
    await advance(300)
    r.start()
    // A no-throw row comes up as Starboard is said, and waits for it; the side changes again while the row is said.
    r.speaker.say('No throw, 17.', WARNING)
    await advance(300)
    r.drive('right', 'left', 128)
    for (let i = 0; i < 3; i++) {
      r.end()
      await advance(400)
      r.start()
    }
    r.end()
    await advance(1000)
    // Starboard is said whole; the row, then Port, asked after it, then the block's words again in full.
    expect(r.spoken()).toEqual(['Port', BLOCK, 'Starboard', 'No throw, 17.', 'Port', BLOCK])
    // The only words cut off were the block's, by Starboard.
    expect(r.cancels()).toBe(1)
  })
})

/** The phone's speech as it is on the road, one thing at a time: a moment to start each, and a while to say it, which `onHeard` is told of. */
function phoneSpeaking(options: { keepAlive: boolean; onHeard?: (text: string, start: number, end: number) => void }) {
  const line: FakeUtterance[] = []
  const said: string[] = []
  const lastSound = { at: -Infinity }
  const next = () => {
    const u = line[0]
    if (!u) return
    const quiet = u.text === LEAD_IN.text
    setTimeout(() => {
      const start = Date.now()
      u.onstart?.()
      setTimeout(
        () => {
          options.onHeard?.(u.text, start, Date.now())
          line.shift()
          u.onend?.()
          next()
        },
        quiet ? 350 : 600,
      )
    }, 150)
  }
  const speaker = createSpeaker<FakeUtterance>({
    speak: (u) => {
      said.push(u.text)
      line.push(u)
      if (line.length === 1) next()
    },
    cancel: () => void line.splice(0),
    resume: () => undefined,
    paused: () => false,
    voices: () => [],
    makeUtterance: (text) => ({ text, lang: '', volume: 1, voice: undefined, onstart: null, onend: null, onerror: null }),
    ready: async () => true,
    keepingAlive: () => options.keepAlive,
    tick: () => {
      lastSound.at = Date.now() + 60
      return 0.06
    },
    opener: () => {
      lastSound.at = Date.now() + 300
      return 0.3
    },
    lastSound: () => lastSound.at,
    leadIn: LEAD_IN,
    language: () => 'en-AU',
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  return { speaker, said }
}

describe('a side word with the lead-in before it, as the car comes up to the change', () => {
  /** Drives a steady `speed` at a fix a second, first fix `offset` metres along, and says when the side word, for a change at 500 m, ends. */
  const endOfWord = async (speed: number, offset: number, keepAlive: boolean) => {
    vi.setSystemTime(0)
    const change = 500
    let heardAt = NaN
    const word = sideWords('right')
    const { speaker } = phoneSpeaking({ keepAlive, onHeard: (text, _, end) => void (text === word && (heardAt = end)) })
    const cue = createSideCue()
    cue.update('left', 'left', 0)
    for (let s = 0; offset + speed * s < change; s++) {
      const along = offset + speed * s
      const said = cue.update('left', along + sideLookAheadM(speed) >= change ? 'right' : 'left', along)
      if (said) speaker.say(sideWords(said), { queue: true, stale: () => cue.last() !== said })
      await advance(1000)
    }
    await advance(5000)
    return { end: heardAt, reachedAt: ((change - offset) / speed) * 1000 }
  }

  // Town speeds, up to where the look-ahead reaches its most. From 12 m/s it can't allow for all of it, whatever the seconds are.
  describe.each([5, 8, 10])('at %d m/s', (speed) => {
    it('is over before the side changes, however the fixes fall', { timeout: 60_000 }, async () => {
      for (let phase = 0; phase < 1; phase += 0.1) {
        const { end, reachedAt } = await endOfWord(speed, 100 + phase * speed, true)
        expect(end).toBeLessThan(reachedAt)
      }
    })
  })
})

describe('the Test Voice button, through the speaker', () => {
  /** Runs the test to its end: each word as the speaker gets it, with what the phone was handed. */
  const run = async (keepAlive: boolean) => {
    const { speaker, said } = phoneSpeaking({ keepAlive })
    const words = [sideWords('left'), sideWords('right'), sideWords('both')]
    testVoice((word) => speaker.say(word, { queue: true }))
    await advance(3 * VOICE_TEST_GAP_MS)
    return { said, words }
  }

  it('is more than COLD_MS apart once a word is said, so that the words are each a single word after a silence', () => {
    // At most a tick, the lead-in and the word, as the phone here takes them.
    const longest = 700 + 150 + 350 + 150 + 600
    expect(VOICE_TEST_GAP_MS - longest).toBeGreaterThan(COLD_MS)
  })

  it('tries each word after a silence with the signal running: each has its lead-in', async () => {
    const { said, words } = await run(true)
    expect(said).toEqual(words.flatMap((w) => [LEAD_IN.text, w]))
  })

  it('tries each word after a silence with no signal running: each has its lead-in', async () => {
    const { said, words } = await run(false)
    expect(said).toEqual(words.flatMap((w) => [LEAD_IN.text, w]))
  })
})
