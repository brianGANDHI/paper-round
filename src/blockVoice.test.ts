import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alertable, alertRadius, HEAD_PASSED_M, quietReachFor, zoneExit, type AlertDistance } from './alerts'
import { approachingOccurrences, cumulativeDistances, occurrences, sideAt, snapAtDistance, type Occurrence } from './geo'
import { createSideCue, SIDE_WORDS, sideAtAlong, sideLookAheadM, sideWords } from './sideVoice'
import { ALERT_SECONDS } from './sound'
import { createSpeaker } from './speech'
import { alertWordsStale, planVoice, type DriverNow } from './voicePlan'
import type { Pt, Route, Side, SideChange, Stop, StopType } from './types'

/*
 * The voice on the road, as the round screen works it out on every fix and says it: the words for the alerts that have just come up (see
 * `planVoice`), then the side word as the side ahead changes, each after its beep, an alert's words said whole and left out once the
 * car has gone by all they name (see `alertWordsStale`). The real cue, planner and speaker, over a stand-in for the phone that takes a
 * while to say each word and, as Safari does, reports words that are stopped as an error. The car drives at a steady speed with a fix
 * every second.
 */

/** A spot `x` metres east and `y` metres north of a start at 51 degrees north. */
const M_PER_DEG = (6371000 * Math.PI) / 180
const spot = (x: number, y: number): Pt => ({ lat: 51 + y / M_PER_DEG, lng: x / (M_PER_DEG * Math.cos((51 * Math.PI) / 180)) })
/** A road north from the start, 2000 m long, with a point every 100 m. The west is its left. */
const north: Pt[] = Array.from({ length: 21 }, (_, i) => spot(0, i * 100))
const sides = (...c: [number, Side][]): SideChange[] => c.map(([idx, side]) => ({ idx, side }))

const BLOCK = 'Apartment block, Lakeside Apartments, 12 papers, left.'
const block = (y: number): Stop => ({ id: `block ${y}`, type: 'block', pathIdx: 0, ...spot(-15, y), label: 'Lakeside Apartments', qty: 12 })
const house = (number: string, x: number, y: number): Stop => ({ id: number, type: 'nothrow', pathIdx: 0, ...spot(x, y), address: `${number} Oak Road` })

interface FakeUtterance {
  text: string
  lang: string
  volume: number
  voice: unknown
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

/** Words the phone said: when they started and ended, in seconds, where the car was then, in metres along the road, and if they were stopped. */
interface Heard {
  text: string
  start: number
  end: number
  startAt: number
  endAt: number
  cut: boolean
}

/** What was asked to be said, on which fix, and for an alert the stops its words name. */
interface Asked {
  text: string
  along: number
  beep: number
  stops: Occurrence[]
}

/**
 * Drives `route` from `offset` metres to `to` at `speed` metres a second, a fix a second, doing on every fix what the round screen does:
 * the alerts gone by are done, those just come up beep, the alerts' words are asked for, and the side word. `perWord` is how long the
 * phone takes to say a word, in seconds.
 */
async function drive(route: Route, options: { speed: number; to: number; offset?: number; distance?: AlertDistance; perWord?: number }) {
  const { speed, to } = options
  const offset = options.offset ?? 0
  const perWord = options.perWord ?? 0.35
  vi.setSystemTime(0)
  const radius = alertRadius(options.distance ?? 40)
  const allOccs = occurrences(route)
  const occs = alertable(route, allOccs, quietReachFor(options.distance ?? 40))
  const cum = cumulativeDistances(route.points)

  const heard: Heard[] = []
  let saying: { u: FakeUtterance; h: Heard; timer: ReturnType<typeof setTimeout> } | null = null
  let overlaps = 0
  const place = (t: number) => offset + speed * t
  const speaker = createSpeaker<FakeUtterance>({
    speak: (u) => {
      if (saying) overlaps++
      const t = Date.now() / 1000
      const h: Heard = { text: u.text, start: t, end: NaN, startAt: place(t), endAt: NaN, cut: false }
      heard.push(h)
      const timer = setTimeout(() => {
        h.end = Date.now() / 1000
        h.endAt = place(h.end)
        saying = null
        u.onend?.()
      }, u.text.split(/\s+/).length * perWord * 1000)
      saying = { u, h, timer }
      u.onstart?.()
    },
    cancel: () => {
      if (!saying) return
      const { u, h, timer } = saying
      clearTimeout(timer)
      h.end = Date.now() / 1000
      h.endAt = place(h.end)
      h.cut = true
      saying = null
      // Safari reports words that are stopped as an error.
      u.onerror?.()
    },
    resume: () => undefined,
    paused: () => false,
    voices: () => [],
    makeUtterance: (text) => ({ text, lang: '', volume: 1, voice: undefined, onstart: null, onend: null, onerror: null }),
    ready: async () => true,
    keepingAlive: () => false,
    tick: () => 0.06,
    language: () => 'en-AU',
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  })

  const cue = createSideCue()
  const handled = new Set<string>()
  const seen = new Set<string>()
  const announced = new Set<string>()
  let held = new Set<string>()
  let queue: Occurrence[] = []
  let driver: DriverNow | null = null
  const asked: Asked[] = []
  for (let k = 0; place(k) <= to; k++) {
    const along = place(k)
    const { point: pos, idx } = snapAtDistance(route.points, along)!
    driver = { along, furthest: along, at: pos, turned: null }
    const left = queue.filter((o) => zoneExit(o, along, radius, pos))
    for (const o of left) if (zoneExit(o, along, radius, pos) === 'passed') handled.add(o.key)
    queue = queue.filter((o) => !left.includes(o))
    const fresh = approachingOccurrences(along, pos, occs, handled, radius, 8).filter((o) => !seen.has(o.key))
    let beep = 0
    if (fresh.length) {
      for (const o of fresh) seen.add(o.key)
      const has = (type: StopType) => fresh.some((o) => o.stop.type === type)
      beep = has('nothrow') ? ALERT_SECONDS.nothrow : has('request') ? ALERT_SECONDS.request : has('block') ? ALERT_SECONDS.block : ALERT_SECONDS.bundle
    }
    const word = cue.update(sideAt(route, idx), sideAtAlong(route, cum, along + sideLookAheadM(speed)), along)
    if (fresh.length || held.size) {
      const plan = planVoice({ route, allOccs, occs, handled, radius, queue, fresh, announced, held, driver: { idx, along, driven: along, pos } })
      for (const key of plan.announce) announced.add(key)
      held = new Set(plan.held)
      if (plan.text) {
        asked.push({ text: plan.text, along, beep, stops: occs.filter((o) => plan.announce.includes(o.key)) })
        speaker.say(plan.text, { urgent: true, whole: true, warning: plan.noThrow, afterMs: beep * 1000, stale: alertWordsStale(plan.announce, occs, () => driver, radius) })
      }
    }
    // The side word is asked for after the alerts' words of the same fix, as in the round screen's alert effect (src/Round.tsx, where
    // the side word is said after `plan.text`): keep the two in step. A no-throw row that comes up as the side changes, of the same rank,
    // is then said first, and begun before the house; any other alert's words, asked first, are broken in on by the side word at once,
    // before they are begun, which costs them nothing (see `CUT_GRACE_MS`).
    if (word) {
      asked.push({ text: sideWords(word), along, beep, stops: [] })
      speaker.say(sideWords(word), { queue: true, afterMs: beep * 1000, stale: () => cue.last() !== word })
    }
    queue = [...queue, ...fresh]
    await vi.advanceTimersByTimeAsync(1000)
  }
  // The car stops at the end, and the voice finishes what it has to say.
  await vi.advanceTimersByTimeAsync(60_000)
  return { heard, asked, overlaps, idle: !speaker.busy() }
}

/** The words heard in full, and those stopped part way. */
const whole = (heard: Heard[]) => heard.filter((h) => !h.cut).map((h) => h.text)
const cut = (heard: Heard[]) => heard.filter((h) => h.cut).map((h) => h.text)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('an apartment block’s words', () => {
  // Thrown Left, the alert distance 40 m, at 12 m/s: the block comes up at 168 m and is said from 171 m.
  it('give way to a no-throw house that comes up as they are being said, and are said again in full right after the house', async () => {
    const route: Route = { points: north, sideChanges: sides([0, 'left']), stops: [block(200), house('17', -12, 210)] }
    const run = await drive(route, { speed: 12, to: 400 })
    // The house comes up a fix after the block, and its words, a warning, break in on the block's.
    expect(cut(run.heard)).toEqual([BLOCK])
    expect(whole(run.heard)).toEqual(['Left', 'No throw, 17.', BLOCK])
    const [, blockCut, houseHeard, blockAgain] = run.heard
    expect(blockCut.endAt).toBe(run.asked.find((a) => a.text === 'No throw, 17.')?.along)
    // The house is named before the car gets to it, and the block straight after, the car not yet 10 m past it.
    expect(houseHeard.startAt).toBeLessThan(210)
    expect(blockAgain.start - houseHeard.end).toBeLessThan(0.5)
    expect(blockAgain.startAt).toBeLessThan(200 + HEAD_PASSED_M)
    expect(run.overlaps).toBe(0)
  })

  it('are not said again once the car has gone by the block, when the house that broke in on them is named after that', async () => {
    const route: Route = { points: north, sideChanges: sides([0, 'left']), stops: [block(200), house('17', -12, 225)] }
    const run = await drive(route, { speed: 12, to: 400 })
    expect(cut(run.heard)).toEqual([BLOCK])
    expect(whole(run.heard)).toEqual(['Left', 'No throw, 17.'])
    // The house is named before the car gets to it: the warning that stops a wrong throw comes first.
    expect(run.heard[2].startAt).toBeLessThan(225)
    expect(run.idle).toBe(true)
  })

  it('do not cut off a no-throw house’s, when the block comes up as they are being said', async () => {
    const route: Route = { points: north, sideChanges: sides([0, 'left']), stops: [house('17', -12, 200), block(210)] }
    const run = await drive(route, { speed: 12, to: 400 })
    expect(cut(run.heard)).toEqual([])
    expect(whole(run.heard)).toEqual(['Left', 'No throw, 17.', BLOCK])
    expect(run.overlaps).toBe(0)
  })

  it('are said in full when a bundle drop comes up just after', async () => {
    const bundle: Stop = { id: 'coop', type: 'bundle', pathIdx: 0, ...spot(-12, 225), label: 'Co-op', qty: 30 }
    const run = await drive({ points: north, sideChanges: sides([0, 'left']), stops: [block(200), bundle] }, { speed: 12, to: 400 })
    expect(cut(run.heard)).toEqual([])
    expect(whole(run.heard)).toContain(BLOCK)
    expect(whole(run.heard)).toHaveLength(3)
  })

  it('give way to a house that comes up soon after, at any speed, gap or pace of speech, and are said in full unless gone by', { timeout: 60_000 }, async () => {
    for (const perWord of [0.35, 0.45]) {
      for (const speed of [6, 10, 14]) {
        for (let gap = 5; gap <= 45; gap += 5) {
          // On this side with Left thrown, and over the road with both sides thrown.
          for (const [x, side] of [[-12, 'left'], [12, 'both']] as const) {
            const route: Route = { points: north, sideChanges: sides([0, side]), stops: [block(200), house('17', x, 200 + gap)] }
            const run = await drive(route, { speed, to: 330, perWord })
            const label = `${gap} m on ${side === 'left' ? 'this side' : 'over the road'} at ${speed} m/s, ${perWord} s a word`
            const houseHeard = run.heard.filter((h) => h.text.includes('No throw, 17.'))
            // The house's words are said once, never cut off, and begun before the house.
            expect(houseHeard, label).toHaveLength(1)
            expect(houseHeard[0].cut, label).toBe(false)
            expect(houseHeard[0].startAt, label).toBeLessThan(200 + gap)
            // Only the block's words are ever cut off, by the house's coming up, and they are said in full at most once (with the
            // house's, when the two come up on the same fix).
            const blockHeard = run.heard.filter((h) => h.text.includes(BLOCK))
            for (const h of run.heard.filter((x) => x.cut)) expect(h.text, label).toBe(BLOCK)
            expect(blockHeard.filter((h) => !h.cut).length, label).toBeLessThanOrEqual(1)
            // When cut off they are said again in full right after the house, or left out as the car has gone by the block by then.
            if (blockHeard.some((h) => h.cut)) {
              const again = blockHeard.find((h) => h.start > houseHeard[0].start)
              if (again) {
                expect(again.cut, label).toBe(false)
                expect(again.start - houseHeard[0].end, label).toBeLessThan(0.5)
                expect(again.startAt, label).toBeLessThan(200 + HEAD_PASSED_M + speed)
              } else {
                expect(houseHeard[0].endAt + speed * 0.5, label).toBeGreaterThan(200 + HEAD_PASSED_M)
              }
            } else {
              expect(blockHeard, label).toHaveLength(1)
            }
            expect(run.overlaps, label).toBe(0)
          }
        }
      }
    }
  })
})

describe('alerts that come up faster than they can be said', () => {
  // Thrown Left, a stop every 16 m, each said on its own: a special request with a long note, an apartment block, a bundle drop and a
  // no-throw house (64 m apart, so each is a row of its own), over and over. At 14 m/s one comes up about every 1.1 s, and the words
  // for each take from 2 s to 5 s to say.
  const stops: Stop[] = []
  for (let i = 0; i < 24; i++) {
    const y = 300 + 16 * i
    const n = String(301 + 2 * i)
    if (i % 4 === 0) stops.push({ id: n, type: 'request', pathIdx: 0, ...spot(-12, y), address: `${n} Oak Road`, note: 'Leave it under the mat by the side door please' })
    if (i % 4 === 1) stops.push({ id: n, type: 'block', pathIdx: 0, ...spot(-15, y), address: `${n} Oak Road`, qty: 12 })
    if (i % 4 === 2) stops.push({ id: n, type: 'bundle', pathIdx: 0, ...spot(-12, y), address: `${n} Oak Road`, qty: 30 })
    if (i % 4 === 3) stops.push(house(n, -12, y))
  }
  const route: Route = { points: north, sideChanges: sides([0, 'left']), stops }
  const last = 300 + 16 * 23

  it('name every no-throw house before the car gets to it, cut off only the other alerts for it, and keep up with the car', { timeout: 60_000 }, async () => {
    const run = await drive(route, { speed: 14, to: 1000 })
    expect(run.overlaps).toBe(0)
    const alerts = run.asked.filter((a) => a.stops.length)
    expect(alerts).toHaveLength(24)
    // Every house is named, whole, before the car gets to it: a warning is never cut off, nor held up behind another alert.
    const houses = alerts.filter((a) => a.text.startsWith('No throw'))
    expect(houses).toHaveLength(6)
    for (const a of houses) {
      const h = run.heard.find((x) => x.text === a.text)
      expect(h?.cut, a.text).toBe(false)
      expect(h!.startAt, a.text).toBeLessThan(a.stops[0].at)
    }
    // The words cut off are the other alerts', each at the moment a house came up.
    const cuts = run.heard.filter((h) => h.cut)
    expect(cuts.length).toBeGreaterThan(0)
    for (const h of cuts) {
      expect(h.text.startsWith('No throw'), h.text).toBe(false)
      expect(houses.some((a) => a.along === h.endAt), h.text).toBe(true)
    }
    for (const h of run.heard) {
      const a = alerts.find((x) => x.text === h.text)
      if (!a) continue
      // Judged at the fix before the words begin: gone by is 10 m past, and the car goes on for up to a second after that fix.
      const furthest = Math.max(...a.stops.map((o) => o.at))
      expect(h.startAt - furthest, h.text).toBeLessThan(HEAD_PASSED_M + 14)
    }
    // Some had to be left out, but the voice does not fall behind: the last stop is named, and all is over within a few seconds of
    // the car going by it (said in turn, the 24 would take about 80 s, and the last would come some 1000 m on).
    const said = run.heard.filter((h) => alerts.some((a) => a.text === h.text) && !h.cut)
    expect(said.length).toBeLessThan(alerts.length)
    expect(said.map((h) => h.text)).toContain(alerts.at(-1)?.text)
    expect(Math.max(...said.map((h) => h.endAt)) - last).toBeLessThan(40)
    expect(run.idle).toBe(true)
  })
})

describe('a no-throw house after a special request with a long note', () => {
  const NOTE = 'Leave it under the mat by the side door please, not in the letterbox'
  const request: Stop = { id: '301', type: 'request', pathIdx: 0, ...spot(-12, 200), address: '301 Oak Road', note: NOTE }

  it('is named before the house, breaking in on the note, at any speed, gap or pace of speech', { timeout: 60_000 }, async () => {
    let brokeIn = 0
    for (const perWord of [0.35, 0.45]) {
      for (const speed of [8, 10, 12, 14]) {
        for (let gap = 5; gap <= 50; gap += 5) {
          const route: Route = { points: north, sideChanges: sides([0, 'left']), stops: [request, house('17', -12, 200 + gap)] }
          const run = await drive(route, { speed, to: 400, perWord })
          const label = `${gap} m on at ${speed} m/s, ${perWord} s a word`
          const row = run.heard.filter((h) => h.text.includes('No throw, 17.'))
          expect(row, label).toHaveLength(1)
          expect(row[0].cut, label).toBe(false)
          expect(row[0].startAt, label).toBeLessThan(200 + gap)
          // The note is cut off only by the house, and is said again only while the car is not yet well past the request.
          const notes = run.heard.filter((h) => h.text.startsWith('Special request'))
          for (const h of notes.slice(0, -1)) expect(h.cut, label).toBe(true)
          for (const h of notes.slice(1)) expect(h.startAt, label).toBeLessThan(200 + HEAD_PASSED_M + speed)
          if (notes[0]?.cut) brokeIn++
          expect(run.overlaps, label).toBe(0)
        }
      }
    }
    // Most of the time the house came up while the note was being said.
    expect(brokeIn).toBeGreaterThan(40)
  })
})

describe('the side word in a stretch thick with alerts', () => {
  // Thrown Left, then Both from 400 m and Left again from 600 m; a stop every 12 to 24 m from 300 m on, taking turns: a special request
  // with a long note, an apartment block, a bundle drop and, where `houses`, a no-throw house.
  const stretch = (spacing: number, houses: boolean): Route => {
    const stops: Stop[] = []
    let i = 0
    for (let y = 300; y <= 720; y += spacing, i++) {
      const n = String(301 + 2 * i)
      const kind = houses ? i % 4 : i % 3
      if (kind === 0) stops.push({ id: n, type: 'request', pathIdx: 0, ...spot(-12, y), address: `${n} Oak Road`, note: 'Leave it under the mat by the side door please' })
      if (kind === 1) stops.push({ id: n, type: 'block', pathIdx: 0, ...spot(-15, y), address: `${n} Oak Road`, qty: 12 })
      if (kind === 2) stops.push({ id: n, type: 'bundle', pathIdx: 0, ...spot(-12, y), address: `${n} Oak Road`, qty: 30 })
      if (kind === 3) stops.push(house(n, -12, y))
    }
    return { points: north, sideChanges: sides([0, 'left'], [4, 'both'], [6, 'left']), stops }
  }
  const changes: [string, number][] = [
    ['Both', 400],
    ['Left', 600],
  ]

  it('breaks in on the alerts being said, and is done by the change', { timeout: 60_000 }, async () => {
    let cutIn = 0
    for (const speed of [10, 12, 14]) {
      for (const spacing of [12, 15, 18, 21, 24]) {
        const run = await drive(stretch(spacing, false), { speed, to: 900 })
        for (const [word, at] of changes) {
          const label = `${word} at ${speed} m/s, a stop every ${spacing} m`
          const heard = run.heard.filter((h) => h.text === word && h.start * speed > at - 60 && h.start * speed < at + 100)
          expect(heard.map((h) => h.cut), label).toEqual([false])
          expect(heard[0].endAt, label).toBeLessThanOrEqual(at)
        }
        cutIn += run.heard.filter((h) => h.cut).length
        expect(run.overlaps).toBe(0)
      }
    }
    // The side words did break in on alerts being said.
    expect(cutIn).toBeGreaterThan(5)
  })

  it('with no-throw houses among them, is said once in full, before the change or right after a house’s words in the way', { timeout: 60_000 }, async () => {
    for (const speed of [10, 12, 14]) {
      for (const spacing of [12, 15, 18, 21, 24]) {
        const run = await drive(stretch(spacing, true), { speed, to: 900 })
        for (const [word, at] of changes) {
          const label = `${word} at ${speed} m/s, a stop every ${spacing} m`
          const ask = run.asked.find((a) => a.text === word && a.along > at - 40 && a.along <= at)!
          const heard = run.heard.filter((h) => h.text === word && h.start >= ask.along / speed && h.start * speed < at + 100)
          expect(heard.filter((h) => !h.cut), label).toHaveLength(1)
          const said = heard.find((h) => !h.cut)!
          if (said.endAt > at) {
            // Late only behind a no-throw house's words, which were being said or waiting when it was asked, and straight after them.
            const before = run.heard.filter((h) => h.end > ask.along / speed && h.start < said.start && h.text !== word)
            expect(before.length, label).toBeGreaterThan(0)
            for (const h of before) expect(h.text.startsWith('No throw'), label).toBe(true)
            expect(said.start - before.at(-1)!.end, label).toBeLessThan(0.5)
          }
        }
        expect(run.overlaps).toBe(0)
      }
    }
  })
})

describe('a special request’s or an apartment block’s words, with the side changing soon after the stop', () => {
  const NOTE = 'Leave it under the mat by the side door please, not in the letterbox'
  const REQUEST: Stop = { id: '301', type: 'request', pathIdx: 0, ...spot(-12, 200), address: '301 Oak Road', note: NOTE }

  // Thrown Left, then Both from `gap` metres past the stop: the side word, asked a little before the change, comes while the stop's words
  // are being said, and breaks in on them. By the time the side word is over the car may be well past the stop.
  it('are heard whole once, said again right after the side word that broke in on them', { timeout: 60_000 }, async () => {
    let brokeIn = 0
    for (const stop of [REQUEST, block(200)]) {
      for (const perWord of [0.35, 0.45]) {
        for (const speed of [8, 10, 12, 14]) {
          for (let gap = 20; gap <= 40; gap += 5) {
            for (const offset of [0, speed / 2]) {
              const route: Route = { points: [spot(0, 0), spot(0, 200 + gap), spot(0, 2000)], sideChanges: sides([0, 'left'], [1, 'both']), stops: [stop] }
              const run = await drive(route, { speed, to: 330, offset, perWord })
              const label = `${stop.type}, the change ${gap} m on, at ${speed} m/s from ${offset} m, ${perWord} s a word`
              const text = run.asked.find((a) => a.stops.length)!.text
              const words = run.heard.filter((h) => h.text === text)
              expect(whole(words), label).toHaveLength(1)
              const side = run.heard.filter((h) => h.text === 'Both')
              expect(side.map((h) => h.cut), label).toEqual([false])
              expect(side[0].endAt, label).toBeLessThanOrEqual(200 + gap)
              const cutOff = words.filter((h) => h.cut)
              if (cutOff.length) {
                brokeIn++
                // Cut off only by the side word, as it was asked, and said again in full straight after it.
                expect(cutOff, label).toHaveLength(1)
                expect(cutOff[0].endAt, label).toBe(run.asked.find((a) => a.text === 'Both')?.along)
                const again = words.find((h) => !h.cut)!
                expect(again.start, label).toBeGreaterThan(side[0].end)
                expect(again.start - side[0].end, label).toBeLessThan(0.5)
              }
              expect(run.overlaps, label).toBe(0)
            }
          }
        }
      }
    }
    // Most of the time the side word came while the stop's words were being said.
    expect(brokeIn).toBeGreaterThan(80)
  })

  // Thrown Left, then Both and Left by turns every 60 m from just past the request on, and a bundle drop on the left 180 m past it.
  // Each side word breaks in on the note, which takes longer than 60 m to say: it is said again after the first, but not after the next.
  it('are begun at most twice when the side changes again and again, and do not hold up the alerts after them', { timeout: 60_000 }, async () => {
    const bundle: Stop = { id: '41', type: 'bundle', pathIdx: 0, ...spot(-12, 380), address: '41 Oak Road', qty: 30 }
    let cutTwice = 0
    for (const perWord of [0.35, 0.45]) {
      for (const speed of [10, 12, 14]) {
        for (let first = 205; first <= 245; first += 10) {
          const points = [spot(0, 0)]
          const changes: [number, Side][] = [[0, 'left']]
          for (let y = first; y < 900; y += 60) {
            points.push(spot(0, y))
            changes.push([points.length - 1, changes.length % 2 ? 'both' : 'left'])
          }
          points.push(spot(0, 2000))
          const run = await drive({ points, sideChanges: sides(...changes), stops: [REQUEST, bundle] }, { speed, to: 1000, perWord })
          const label = `changes every 60 m from ${first} m, at ${speed} m/s, ${perWord} s a word`
          const notes = run.heard.filter((h) => h.text.startsWith('Special request'))
          expect(notes.length, label).toBeGreaterThan(0)
          expect(notes.length, label).toBeLessThanOrEqual(2)
          // Begun again only while the car is not far past the request, not ever further behind it.
          for (const h of notes) expect(h.startAt, label).toBeLessThan(250)
          if (notes.filter((h) => h.cut).length === 2) cutTwice++
          expect(whole(run.heard), label).toContain('Bundle drop, 41, 30 papers.')
          expect(run.overlaps, label).toBe(0)
        }
      }
    }
    // Most of the time the note was cut off twice, by two side words in turn.
    expect(cutTwice).toBeGreaterThan(15)
  })

  // Thrown Left, then Both from `first` metres and Left again `gap` metres on. Where the request comes up on the fix where Both is asked
  // for, Both, asked after the note as the round screen asks, breaks in on it at once, while the note still waits out its beep: that cuts
  // off no word of it, so the note keeps its grace for the cut that does, when the side changes again while it is being said.
  it('are heard whole when they come up on the fix of a side word, and the side changes again 30 to 120 m on', { timeout: 60_000 }, async () => {
    let sameFix = 0
    let cutByNext = 0
    for (const perWord of [0.35, 0.45]) {
      for (const speed of [8, 10, 12, 14]) {
        for (let first = 150; first <= 230; first += 4) {
          for (const gap of [30, 60, 90, 120]) {
            for (const offset of [0, speed / 2]) {
              const points = [spot(0, 0), spot(0, first), spot(0, first + gap), spot(0, 2000)]
              const route: Route = { points, sideChanges: sides([0, 'left'], [1, 'both'], [2, 'left']), stops: [REQUEST] }
              const run = await drive(route, { speed, to: first + gap + 40, offset, perWord })
              const note = run.asked.find((a) => a.stops.length)
              const both = run.asked.find((a) => a.text === 'Both')
              if (!note || note.along !== both?.along) continue
              sameFix++
              const label = `Both at ${first} m, Left ${gap} m on, at ${speed} m/s from ${offset} m, ${perWord} s a word`
              const words = run.heard.filter((h) => h.text === note.text)
              // Both is said first, whole, before a word of the note; the note is heard whole once, and begun at most twice.
              const side = run.heard.filter((h) => h.text === 'Both')
              expect(side.map((h) => h.cut), label).toEqual([false])
              expect(words[0].start, label).toBeGreaterThan(side[0].end)
              expect(whole(words), label).toHaveLength(1)
              expect(words.length, label).toBeLessThanOrEqual(2)
              if (words[0].cut) {
                // Cut off part way only by Left, as it was asked, and said again in full straight after it, though by then the car may
                // have gone by the request.
                cutByNext++
                const left = run.asked.filter((a) => a.text === 'Left').at(-1)!
                expect(words[0].endAt, label).toBe(left.along)
                const leftHeard = run.heard.find((h) => h.text === 'Left' && h.start > words[0].start)!
                expect(leftHeard.cut, label).toBe(false)
                expect(words[1].start - leftHeard.end, label).toBeLessThan(0.5)
              }
              expect(run.overlaps, label).toBe(0)
            }
          }
        }
      }
    }
    // The note and Both came up on one fix in about one drive in eight, and in most of those Left came while the note was being said.
    expect(sameFix).toBeGreaterThan(120)
    expect(cutByNext).toBeGreaterThan(60)
  })
})

describe('the side word in a street thick with no-throw houses', () => {
  /** A seeded stand-in for chance, so the street is the same on every run. */
  const chance = (seed: number) => {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = Math.imul(a ^ (a >>> 15), a | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const SIDES: Side[] = ['left', 'right', 'both', 'transit']
  /**
   * Houses on both sides every `spacing` metres, a share `noThrow` of them no-throw houses and a share `other` special requests,
   * apartment blocks or bundle drops; the side thrown changes every 100 m, to any other side.
   */
  const street = (seed: number, spacing: number, noThrow: number, other: number): Route => {
    const next = chance(seed * 7919 + spacing)
    const changes: [number, Side][] = [[0, SIDES[Math.floor(next() * 3)]]]
    for (let idx = 1; idx < 20; idx++) {
      const choice = SIDES.filter((s) => s !== changes[idx - 1][1])
      changes.push([idx, choice[Math.floor(next() * choice.length)]])
    }
    const stops: Stop[] = []
    for (let i = 0, y = 10; y < 1990; y += spacing, i++) {
      for (const [x, n] of [[-12, 2 * i + 1], [12, 2 * i + 2]] as const) {
        const at = { pathIdx: 0, ...spot(x, y), address: `${n} Oak Road` }
        const roll = next()
        const kind = Math.floor(next() * 3)
        if (roll < noThrow) stops.push({ id: String(n), type: 'nothrow', ...at })
        else if (roll < noThrow + other && kind === 0) stops.push({ id: String(n), type: 'request', ...at, note: 'Leave it under the mat by the side door please' })
        else if (roll < noThrow + other && kind === 1) stops.push({ id: String(n), type: 'block', ...at, ...spot(x * 1.25, y), qty: 12 })
        else if (roll < noThrow + other) stops.push({ id: String(n), type: 'bundle', ...at, qty: 30 })
      }
    }
    return { points: north, sideChanges: sides(...changes), stops }
  }
  const isSide = (text: string) => Object.values(SIDE_WORDS).includes(text)

  it('waits only for the no-throw rows asked before it, is never cut off by one, and is lost only behind one still said at the next change', { timeout: 60_000 }, async () => {
    let waited = 0
    let heardWhole = 0
    for (const speed of [12, 14]) {
      for (const [spacing, noThrow, other] of [
        [10, 0.25, 0.1],
        [12, 0.4, 0.05],
        [20, 0.5, 0.08],
      ]) {
        for (let seed = 1; seed <= 3; seed++) {
          const run = await drive(street(seed, spacing, noThrow, other), { speed, to: 1990 })
          const label = `seed ${seed}, every ${spacing} m, ${noThrow * 100}% no-throw, at ${speed} m/s`
          expect(run.heard.filter((h) => h.cut && isSide(h.text)), label).toEqual([])
          const asks = run.asked.filter((a) => isSide(a.text))
          const rows = run.asked.filter((a) => a.stops.some((o) => o.stop.type === 'nothrow'))
          for (const [i, ask] of asks.entries()) {
            const t = ask.along / speed
            const until = i + 1 < asks.length ? asks[i + 1].along / speed : Infinity
            const said = run.heard.find((h) => !h.cut && h.text === ask.text && h.start >= t && h.start < until)
            const at = `${ask.text} asked at ${ask.along} m, ${label}`
            if (said) {
              heardWhole++
              // The rows said while it waited were asked before it: none asked after it went first.
              const between = run.heard.filter((h) => h.end > t && h.start < said.start && rows.some((r) => r.text === h.text))
              for (const h of between) expect(run.asked.findIndex((a) => a.text === h.text), at).toBeLessThan(run.asked.indexOf(ask))
              if (between.length) waited++
            } else {
              // Out of date at the next change, while a row asked before it was still being said.
              const holding = run.heard.filter((h) => !h.cut && h.end > until - 0.5 && h.start < until && rows.some((r) => r.text === h.text))
              expect(holding.length, at).toBeGreaterThan(0)
              for (const h of holding) expect(run.asked.findIndex((a) => a.text === h.text), at).toBeLessThan(run.asked.indexOf(ask))
            }
          }
          expect(run.overlaps, label).toBe(0)
        }
      }
    }
    // Nearly every side word was said, and many of them had to wait for a row first.
    expect(heardWhole).toBeGreaterThan(330)
    expect(waited).toBeGreaterThan(20)
  })
})

describe('the side word when an alert beeps on the same fix', () => {
  // Left to 300 m, Right to 500 m, Both to 700 m, then Transit; no-throw houses on both sides every 20 m, which beep on the side thrown.
  const stops: Stop[] = []
  for (let y = 10; y <= 990; y += 20) stops.push(house(String(y), 12, y), house(String(y + 1), -12, y))
  const route: Route = { points: north.slice(0, 11), sideChanges: sides([0, 'left'], [3, 'right'], [5, 'both'], [7, 'transit']), stops }
  const changes: Record<string, number> = { Right: 300, Both: 500, Transit: 700 }

  it('is done by the change, though it waits for the beep to end, wherever the fixes fall', { timeout: 60_000 }, async () => {
    let withBeep = 0
    for (let offset = 0; offset < 12; offset += 1) {
      const run = await drive(route, { speed: 12, offset, to: 760 })
      const words = run.heard.filter((h) => h.text in changes)
      expect(words.map((h) => h.text), `from ${offset} m`).toEqual(['Right', 'Both', 'Transit'])
      for (const h of words) {
        expect(h.cut).toBe(false)
        expect(h.endAt, `${h.text} from ${offset} m`).toBeLessThanOrEqual(changes[h.text])
      }
      withBeep += run.asked.filter((a) => a.text in changes && a.beep > 0).length
    }
    // A no-throw house came up on the fix of the word, and the word waited out its beep, about half the time.
    expect(withBeep).toBeGreaterThan(12)
  })

  it('is begun before the change at a crawl and at 50 km/h too', { timeout: 60_000 }, async () => {
    for (const speed of [6, 14]) {
      for (let offset = 0; offset < speed; offset += speed / 4) {
        const run = await drive(route, { speed, offset, to: 760 })
        const words = run.heard.filter((h) => h.text in changes)
        expect(words.map((h) => h.text)).toEqual(['Right', 'Both', 'Transit'])
        for (const h of words) expect(h.startAt, `${h.text} at ${speed} m/s from ${offset} m`).toBeLessThan(changes[h.text])
      }
    }
  })
})

describe('a no-throw row and a side word asked on the same fix', () => {
  // Thrown Left, then Both from 300 m; a no-throw house on the left (thrown on both sides of the change) a few metres before the change,
  // so the house comes up on about the fix where the side word is asked. The alert distance is 30 m or less, so the row has little time.
  it('say the row first, begun before the house, and the side word straight after it', { timeout: 60_000 }, async () => {
    let sameFix = 0
    for (const distance of [20, 30] as const) {
      for (const perWord of [0.35, 0.45]) {
        for (const speed of [10, 12, 14]) {
          for (let d = -10; d <= -2; d += 2) {
            for (const offset of [0, speed / 2]) {
              const route: Route = { points: [spot(0, 0), spot(0, 300), spot(0, 2000)], sideChanges: sides([0, 'left'], [1, 'both']), stops: [house('17', -12, 300 + d)] }
              const run = await drive(route, { speed, to: 460, offset, perWord, distance })
              const label = `the house ${-d} m before the change, ${distance} m alerts, at ${speed} m/s from ${offset} m, ${perWord} s a word`
              const rowAsk = run.asked.find((a) => a.text === 'No throw, 17.')
              const sideAsk = run.asked.find((a) => a.text === 'Both')
              if (!rowAsk || rowAsk.along !== sideAsk?.along) continue
              sameFix++
              const row = run.heard.filter((h) => h.text === 'No throw, 17.')
              const side = run.heard.filter((h) => h.text === 'Both')
              expect(row.map((h) => h.cut), label).toEqual([false])
              expect(side.map((h) => h.cut), label).toEqual([false])
              expect(row[0].start, label).toBeLessThan(side[0].start)
              expect(side[0].start - row[0].end, label).toBeLessThan(0.5)
              if (distance === 30) expect(row[0].startAt, label).toBeLessThan(300 + d)
              expect(run.overlaps, label).toBe(0)
            }
          }
        }
      }
    }
    // The two came up on one fix in about half the drives.
    expect(sameFix).toBeGreaterThan(40)
  })
})
