import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSideCue, sideWords } from './sideVoice'
import { createSpeaker } from './speech'
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
  /** Left at the start, then a long row of houses is said just before a short Right stretch, with Left again after it. */
  const upTo = async (r: ReturnType<typeof round>) => {
    r.drive('left', 'left', 0)
    await advance(300)
    r.start()
    r.end()
    r.speaker.say(ROW, alert)
    await advance(300)
    r.start()
    // The Right stretch comes up while the row is being said.
    r.drive('left', 'right', 88)
  }

  it('leaves out a side that has changed again while the row was said, and says the side the driver is now on', async () => {
    const r = round()
    await upTo(r)
    // Four seconds on, still in the row, the stretch after it comes up: Left again.
    await advance(4000)
    r.drive('right', 'left', 128)
    r.end()
    await advance(1000)
    r.start()
    r.end()
    await advance(1000)
    // Right, out of date by the time it could be said, is left out: Left is heard again, for the stretch the driver is on.
    expect(r.spoken()).toEqual(['Left', ROW, 'Left'])
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
    expect(r.spoken()).toEqual(['Left', ROW, 'Right', 'Left'])
  })
})

describe('a side word and the alerts said whole around it', () => {
  const ALERT = { urgent: true, whole: true } as const
  const WARNING = { urgent: true, whole: true, warning: true } as const
  const BLOCK = 'Apartment block, Lakeside Apartments, 12 papers, left.'

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
    expect(r.spoken()).toEqual(['Left', 'Right'])
    r.start()
    r.end()
    await advance(400)
    expect(r.spoken()).toEqual(['Left', 'Right', BLOCK])
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
    expect(r.spoken()).toEqual(['Left', 'No throw, 17.'])
    r.start()
    r.end()
    await advance(400)
    expect(r.spoken()).toEqual(['Left', 'No throw, 17.', 'Right'])
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
    expect(r.spoken()).toEqual(['Left', BLOCK, 'Right'])
    // Right is being said when another alert comes up: it waits for Right, after the block and the bundle drop.
    r.start()
    r.speaker.say('Special request, 14.', ALERT)
    for (let i = 0; i < 3; i++) {
      r.end()
      await advance(400)
      r.start()
    }
    expect(r.spoken()).toEqual(['Left', BLOCK, 'Right', BLOCK, 'Bundle drop, Co-op.', 'Special request, 14.'])
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
    // A no-throw row comes up as Right is said, and waits for it; the side changes again while the row is said.
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
    // Right is said whole; the row, then Left, asked after it, then the block's words again in full.
    expect(r.spoken()).toEqual(['Left', BLOCK, 'Right', 'No throw, 17.', 'Left', BLOCK])
    // The only words cut off were the block's, by Right.
    expect(r.cancels()).toBe(1)
  })
})
