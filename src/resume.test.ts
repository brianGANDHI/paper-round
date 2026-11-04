import { describe, expect, it } from 'vitest'
import { alertable } from './alerts'
import { markDropped, otherPasses } from './bundles'
import { approachingOccurrences, handledUpTo, occurrences, type Occurrence } from './geo'
import { advance, makeTrack, startProgress } from './progress'
import { continueFrom, handledForResume, normalizeCourtLegs, RESUME_SLACK_M, sameCourtLegs, skippedBy, slackFor, withCourtLegs } from './resume'
import { appendPoints } from './routeEdit'
import { upcomingTurn, type Turn } from './turns'
import type { Pt, RoundState, Stop } from './types'
import { drawUturn } from './uturnShape'

const M_PER_DEG = (6371000 * Math.PI) / 180
/** A spot `x` metres east and `y` metres north of a start in Sydney. */
const spot = (x: number, y: number): Pt => ({ lat: -33.87 + y / M_PER_DEG, lng: 151.2 + x / (M_PER_DEG * Math.cos((-33.87 * Math.PI) / 180)) })

const occ = (key: string, at: number, off = 0): Occurrence => ({
  key,
  stop: { id: key.split('#')[0], type: 'nothrow', pathIdx: 0, lat: 0, lng: 0 },
  idx: 0,
  at,
  off,
})
const round = (extra: Partial<RoundState> = {}): RoundState => ({ handledStopIds: [], ...extra })

describe('how much slack a resume gives', () => {
  it('is 15 metres, the same as a turn right at the wheels', () => {
    expect(RESUME_SLACK_M).toBe(15)
  })
})

describe('the stops to count as done when carrying on part way along', () => {
  const occs = [occ('a', 100), occ('b', 250), occ('c', 400), occ('d', 400.5), occ('e', 900)]

  it('is none for no stops, and none from the start of the route', () => {
    expect(handledForResume([], 500)).toEqual([])
    expect(handledForResume(occs, 0)).toEqual([])
    expect(handledForResume(occs, -100)).toEqual([])
  })

  it('is every stop before the place, in the order given', () => {
    expect(handledForResume(occs, 500)).toEqual(['a', 'b', 'c', 'd'])
    expect(handledForResume([...occs].reverse(), 500)).toEqual(['d', 'c', 'b', 'a'])
    expect(handledForResume(occs, 5000)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('keeps a stop within 15 metres before the place live, and counts one further back as done', () => {
    // At 400 and 400.5 against a place at 415: the first is exactly 15 back, the second 14.5.
    expect(handledForResume(occs, 415)).toEqual(['a', 'b'])
    expect(handledForResume(occs, 415.01)).toEqual(['a', 'b', 'c'])
    expect(handledForResume(occs, 414.99)).toEqual(['a', 'b'])
    expect(handledForResume(occs, 415.51)).toEqual(['a', 'b', 'c', 'd'])
    expect(handledForResume([occ('x', 85)], 100)).toEqual([])
    expect(handledForResume([occ('x', 84)], 100)).toEqual(['x'])
    expect(handledForResume([occ('x', 84.9)], 100)).toEqual(['x'])
    expect(handledForResume([occ('x', 85.1)], 100)).toEqual([])
  })

  it('keeps a stop at the place itself, and ones beyond it, live', () => {
    expect(handledForResume([occ('x', 100)], 100)).toEqual([])
    expect(handledForResume([occ('x', 100.5), occ('y', 5000)], 100)).toEqual([])
  })

  it('is exactly the stops before the place: going further back makes the later ones live again', () => {
    const later = handledForResume(occs, 500)
    const earlier = handledForResume(occs, 300)
    expect(earlier).toEqual(['a', 'b'])
    expect(later).toEqual(expect.arrayContaining(earlier))
    expect(later.filter((k) => !earlier.includes(k))).toEqual(['c', 'd'])
  })

  it('counts everything done for a place beyond the route, and nothing for one that is not a number', () => {
    expect(handledForResume(occs, Infinity)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(handledForResume(occs, NaN)).toEqual([])
    expect(handledForResume(occs, -Infinity)).toEqual([])
  })

  it('does not change the stops it is given', () => {
    const copy = structuredClone(occs)
    handledForResume(occs, 500)
    expect(occs).toEqual(copy)
  })
})

describe('carrying on a street driven twice', () => {
  // Up the road to 600 m and straight back, with a stop beside it halfway: met at 300 and again at 900.
  const points = [spot(0, 0), spot(0, 600), spot(0, 0)]
  const stop: Stop = { id: 'house', type: 'nothrow', pathIdx: 0, ...spot(8, 300) }
  const occs = occurrences({ points, stops: [stop] })

  it('is met twice, keyed by the first pass and the second', () => {
    expect(occs.map((o) => o.key)).toEqual(['house', 'house#2'])
    expect(occs[0].at).toBeCloseTo(300, 0)
    expect(occs[1].at).toBeCloseTo(900, 0)
  })

  it('marks only the first pass when carrying on in the second, and nothing when carrying on in the first', () => {
    expect(handledForResume(occs, 800)).toEqual(['house'])
    expect(handledForResume(occs, 905)).toEqual(['house'])
    expect(handledForResume(occs, 600)).toEqual(['house'])
    expect(handledForResume(occs, 100)).toEqual([])
    expect(handledForResume(occs, 305)).toEqual([])
  })

  it('marks both only once carrying on past the second', () => {
    expect(handledForResume(occs, occs[1].at + RESUME_SLACK_M + 1)).toEqual(['house', 'house#2'])
    expect(handledForResume(occs, occs[1].at + RESUME_SLACK_M - 1)).toEqual(['house'])
  })

  it('makes the second pass live again, and not the first, when moving back from past it to between', () => {
    const past = handledForResume(occs, 1100)
    const between = handledForResume(occs, 600)
    expect(past).toEqual(['house', 'house#2'])
    expect(between).toEqual(['house'])
  })

  it('alerts for the second pass of the stop, and not the first, when carrying on between the two', () => {
    const handled = new Set(handledForResume(occs, 700))
    const driver = spot(0, 300)
    // The driver is on the way back, at the stop.
    const alerts = approachingOccurrences(occs[1].at, driver, occs, handled)
    expect(alerts.map((o) => o.key)).toEqual(['house#2'])
    // Carried on from the start, it is the first pass that is due at this spot on the way out.
    expect(approachingOccurrences(occs[0].at, driver, occs, new Set(handledForResume(occs, 0))).map((o) => o.key)).toEqual(['house'])
  })

  it('has a stop off the route alert on the first pass not done, going by where the driver is', () => {
    // 140 m from the road: too far to be met along it, so it alerts by where the driver is, one pass at a time.
    const far: Stop = { id: 'far', type: 'nothrow', pathIdx: 0, ...spot(140, 300) }
    const farOccs = occurrences({ points, stops: [far] })
    expect(farOccs.map((o) => o.key)).toEqual(['far', 'far#2'])
    expect(farOccs[0].off).toBeGreaterThan(130)
    const here = spot(140, 300)
    const alertFor = (m: number) => approachingOccurrences(m, here, farOccs, new Set(handledForResume(farOccs, m))).map((o) => o.key)
    expect(alertFor(100)).toEqual(['far'])
    expect(alertFor(600)).toEqual(['far#2'])
    expect(alertFor(1300)).toEqual([])
  })
})

describe('where a round that is carried on picks up', () => {
  const occs = [occ('a', 100), occ('b', 250), occ('c', 400)]
  const none = new Set<string>()

  it('is the start for a round with nothing done and no place', () => {
    expect(continueFrom(round(), occs, none)).toBe(0)
    expect(continueFrom(round(), [], none)).toBe(0)
  })

  it('is the place it was started or skipped to, when that is furthest', () => {
    expect(continueFrom(round({ startM: 700, furthest: 200 }), occs, new Set(['b']))).toBe(700)
  })

  it('is the furthest it got, when that is furthest', () => {
    expect(continueFrom(round({ startM: 100, furthest: 650 }), occs, new Set(['b']))).toBe(650)
  })

  it('is the last stop done, when that is furthest', () => {
    expect(continueFrom(round({ startM: 100, furthest: 200 }), occs, new Set(['a', 'c']))).toBe(400)
  })

  it('counts a stop done wherever it is in the list, and a street driven twice by the pass done', () => {
    const doubled = [occ('x', 100), occ('x#2', 800)]
    expect(continueFrom(round(), doubled, new Set(['x']))).toBe(100)
    expect(continueFrom(round(), doubled, new Set(['x#2']))).toBe(800)
    expect(continueFrom(round(), doubled, new Set(['x', 'x#2']))).toBe(800)
  })

  it('is each of them alone when the others are not set', () => {
    expect(continueFrom(round({ startM: 300 }), occs, none)).toBe(300)
    expect(continueFrom(round({ furthest: 300 }), occs, none)).toBe(300)
    expect(continueFrom(round(), occs, new Set(['b']))).toBe(250)
  })

  it('agrees with the stops done as the rest of the app counts them', () => {
    const handled = new Set(['a', 'b'])
    expect(continueFrom(round(), occs, handled)).toBe(handledUpTo(occs, handled))
  })

  it('ignores a place that is not a sensible number', () => {
    for (const junk of [NaN, -5, -Infinity, 0]) expect(continueFrom(round({ startM: junk, furthest: junk }), occs, none), String(junk)).toBe(0)
    expect(continueFrom(round({ startM: Infinity }), occs, none)).toBe(0)
    expect(continueFrom({ handledStopIds: [], startM: '500' as unknown as number }, occs, none)).toBe(0)
    expect(continueFrom({ handledStopIds: [], furthest: null as unknown as number, startM: 120 }, occs, none)).toBe(120)
  })

  it('ignores keys of stops that are not on the route', () => {
    expect(continueFrom(round(), occs, new Set(['zzz', 'a#2']))).toBe(0)
  })

  it('does not look at the list of ids kept in the round itself, only at the set it is given', () => {
    expect(continueFrom(round({ handledStopIds: ['c'] }), occs, none)).toBe(0)
  })

  it('does not change what it is given', () => {
    const copy = structuredClone(occs)
    continueFrom(round({ startM: 3 }), occs, new Set(['a']))
    expect(occs).toEqual(copy)
  })
})

describe("where a round that is carried on picks up, after a house at the head of a court closed with 'U-turn here'", () => {
  // Up 200 m thrown right, the U-turn (on 6 m, across 5 m to the right, back 14 m) and the road back down from 180 m, thrown right. The house
  // on the east is on the right going in and nearest the way back, where it is on the left; the one on the west is the other way about.
  const turned = drawUturn(appendPoints({ points: [], sideChanges: [], stops: [] }, [spot(0, 0), spot(0, 100), spot(0, 200)], 'right'), 'right')!.route
  const east: Stop = { id: 'e', type: 'nothrow', pathIdx: 0, ...spot(12, 185) }
  const west: Stop = { id: 'w', type: 'nothrow', pathIdx: 0, ...spot(-12, 190) }
  const route = { ...appendPoints(turned, [spot(0, 180), spot(0, 0)], 'right'), stops: [east, west] }
  const allOccs = occurrences(route)
  const occs = alertable(route, allOccs)

  it('is where the way in passes a house done there, not the way back it is nearest', () => {
    const [e] = allOccs.filter((o) => o.stop.id === 'e')
    expect(e.at).toBeGreaterThan(220)
    expect(occs.find((o) => o.key === 'e')?.at).toBeCloseTo(185, 0)
    expect(continueFrom(round(), allOccs, new Set(['e']))).toBeCloseTo(185, 0)
    expect(continueFrom(round(), occs, new Set(['e']))).toBeCloseTo(185, 0)
  })

  it('is no further than the way in for a house done on the way back, which it cannot tell apart, so nothing still to do going in is passed over', () => {
    expect(occs.find((o) => o.key === 'w')?.at).toBeGreaterThan(220)
    expect(continueFrom(round(), allOccs, new Set(['w']))).toBeCloseTo(190, 0)
    expect(continueFrom(round(), occs, new Set(['w']))).toBeCloseTo(190, 0)
  })

  it('counts a house before a place it is started from as done by where it alerts', () => {
    // From the turn at 200 m: the east house was thrown going in, so it is done; the west one is on the way back, still to come.
    expect(handledForResume(occs, 200)).toEqual(['e'])
  })
})

describe('where a round that is carried on picks up, when bundle drops were marked dropped', () => {
  const bundleOcc = (key: string, at: number): Occurrence => ({
    key,
    stop: { id: key.split('#')[0], type: 'bundle', pathIdx: 0, lat: 0, lng: 0, qty: 10 },
    idx: 0,
    at,
    off: 0,
  })
  const house = (key: string, at: number): Occurrence => occ(key, at)
  // A route of 5 km. The driver has got to about 700 m. The garage is 4 km further on, and the shop is passed at 1000 m and again at 4000 m.
  const occs = [house('h1', 300), bundleOcc('shop', 1000), bundleOcc('shop#2', 4000), bundleOcc('garage', 4500)]
  const doneNow = (r: RoundState) => new Set(r.handledStopIds)
  const at700: RoundState = { handledStopIds: ['h1'], furthest: 700 }

  it('does not jump to a bundle marked dropped from the list 4 km ahead', () => {
    const marked = markDropped(at700, 'garage')
    expect(continueFrom(marked, occs, doneNow(marked))).toBe(700)
  })

  it('does not jump to the other pass of a stop dropped on one pass, which the drop marks done', () => {
    const marked = markDropped({ handledStopIds: ['h1'], furthest: 1100 }, 'shop', otherPasses(occs, 'shop'))
    expect(marked.handledStopIds).toContain('shop#2')
    expect(continueFrom(marked, occs, doneNow(marked))).toBe(1100)
    // The same from the second pass: the first, behind, is done too and says nothing more.
    const second = markDropped({ handledStopIds: ['h1'], furthest: 700 }, 'shop#2', otherPasses(occs, 'shop#2'))
    expect(continueFrom(second, occs, doneNow(second))).toBe(700)
  })

  it('goes by how far the round got for a bundle dropped on the spot, which is kept every hundred metres', () => {
    const marked = markDropped({ handledStopIds: ['h1'], furthest: 4500 }, 'garage')
    expect(continueFrom(marked, occs, doneNow(marked))).toBe(4500)
  })

  it('still goes by a bundle that was driven past without being dropped, and by a house', () => {
    expect(continueFrom({ handledStopIds: ['garage'], missed: ['garage'], furthest: 700 }, occs, new Set(['garage']))).toBe(4500)
    expect(continueFrom({ handledStopIds: ['h1', 'garage'], dropped: ['shop'], furthest: 0 }, occs, new Set(['h1', 'garage']))).toBe(4500)
  })

  it('still goes by the last stop done when the bundles dropped are further back', () => {
    const r: RoundState = { handledStopIds: ['shop', 'h1'], dropped: ['shop'] }
    expect(continueFrom(r, occs, doneNow(r))).toBe(300)
  })

  it('ignores a drop of another stop, and a stop with no drop', () => {
    const r: RoundState = { handledStopIds: ['h1', 'shop#2'], dropped: ['garage'] }
    expect(continueFrom(r, occs, doneNow(r))).toBe(4000)
  })

  it('keeps the tracker where the driver is: the turns and the faded road after the drop are not 4 km out', () => {
    const points = [spot(0, 0), spot(0, 5000)]
    const track = makeTrack(points)
    const marked = markDropped(at700, 'garage')
    const start = startProgress(track, continueFrom(marked, occs, doneNow(marked)))
    expect(start.furthest).toBe(700)
    let progress = start
    for (const [i, y] of [800, 830].entries()) progress = advance(track, progress, { ...spot(0, y), accuracy: 8, time: 5000 * (i + 1), speed: 6 }, null)!
    expect(progress.along).toBeGreaterThan(820)
    expect(progress.furthest).toBeLessThan(900)
  })
})

describe('an apartment block, which is done by being passed and is never dropped', () => {
  const blockOcc = (key: string, at: number): Occurrence => ({
    key,
    stop: { id: key.split('#')[0], type: 'block', pathIdx: 0, lat: 0, lng: 0, qty: 12 },
    idx: 0,
    at,
    off: 0,
  })
  const occs = [occ('h1', 300), blockOcc('flats', 1000), occ('h2', 1500)]

  it('is done when the round carries on from past it, and live when from before it', () => {
    expect(handledForResume(occs, 1100)).toEqual(['h1', 'flats'])
    expect(handledForResume(occs, 1010)).toEqual(['h1'])
    expect(handledForResume(occs, 1015.01)).toEqual(['h1', 'flats'])
  })

  it('counts among the stops that skipping gives up, until it is done', () => {
    expect(skippedBy(occs, new Set(), 1100)).toBe(2)
    expect(skippedBy(occs, new Set(['flats']), 1100)).toBe(1)
  })

  it('says where the round got to, like a house: the last stop done, whatever it is', () => {
    expect(continueFrom({ handledStopIds: ['h1', 'flats'] }, occs, new Set(['h1', 'flats']))).toBe(1000)
    expect(continueFrom({ handledStopIds: ['h1'] }, occs, new Set(['h1']))).toBe(300)
  })
})

describe('what skipping ahead gives up', () => {
  const occs = [occ('a', 100), occ('b', 250), occ('c', 400), occ('d', 900)]

  it('is how many stops not yet done lie before the place, short of the slack', () => {
    expect(skippedBy(occs, new Set(), 500)).toBe(3)
    expect(skippedBy(occs, new Set(), 5000)).toBe(4)
    expect(skippedBy(occs, new Set(), 300)).toBe(2)
  })

  it('is none from the start, and none when going back', () => {
    expect(skippedBy(occs, new Set(), 0)).toBe(0)
    expect(skippedBy(occs, new Set(), -50)).toBe(0)
    expect(skippedBy([], new Set(), 500)).toBe(0)
  })

  it('leaves out the stops already done', () => {
    expect(skippedBy(occs, new Set(['a', 'c']), 500)).toBe(1)
    expect(skippedBy(occs, new Set(['a', 'b', 'c', 'd']), 5000)).toBe(0)
    expect(skippedBy(occs, new Set(['unknown']), 500)).toBe(3)
  })

  it('has the same edge as carrying on: a stop 15 metres back is not given up, one more is', () => {
    expect(skippedBy([occ('x', 85)], new Set(), 100)).toBe(0)
    expect(skippedBy([occ('x', 84.9)], new Set(), 100)).toBe(1)
    expect(skippedBy([occ('x', 85.1)], new Set(), 100)).toBe(0)
  })

  it('counts each pass of a street driven twice on its own', () => {
    const doubled = [occ('x', 100), occ('x#2', 800)]
    expect(skippedBy(doubled, new Set(), 500)).toBe(1)
    expect(skippedBy(doubled, new Set(['x']), 500)).toBe(0)
    expect(skippedBy(doubled, new Set(), 900)).toBe(2)
  })

  it('is what carrying on would mark as done, less what already is', () => {
    const done = new Set(['a'])
    const marked = handledForResume(occs, 500)
    expect(skippedBy(occs, done, 500)).toBe(marked.filter((k) => !done.has(k)).length)
  })

  it('is nothing for a place that is not a number', () => {
    expect(skippedBy(occs, new Set(), NaN)).toBe(0)
  })
})

describe('carrying on part way, with the rest of the app', () => {
  // Up the road 600 m and back over the same line.
  const points = [spot(0, 0), spot(0, 600), spot(0, 0)]
  const track = makeTrack(points)

  it('keeps the driver on the pass carried on from, rather than the first pass that lies on the same line', () => {
    const from = 900
    let progress = startProgress(track, from)
    // The phone is on the way back, a little past 900 m, whichever way it faces.
    for (const [i, y] of [290, 285, 280, 275].entries()) {
      progress = advance(track, progress, { ...spot(0, y), accuracy: 8, time: 1000 * (i + 1), speed: 6 }, null)!
      expect(progress.along, `fix ${i}`).toBeGreaterThan(from - 20)
    }
  })

  it('keeps the driver on the first pass when carried on from there', () => {
    const from = 100
    let progress = startProgress(track, from)
    for (const [i, y] of [110, 120, 130, 140].entries()) {
      progress = advance(track, progress, { ...spot(0, y), accuracy: 8, time: 1000 * (i + 1), speed: 6 }, null)!
      expect(progress.along, `fix ${i}`).toBeLessThan(from + 100)
    }
  })

  it('hides the turns behind the place carried on from, apart from one right at the wheels', () => {
    const turns = [{ at: 300, angle: 90, heading: 0 } as Turn, { at: 1200, angle: -90, heading: 90 } as Turn]
    const from = 330
    const seen = (along: number) => upcomingTurn(turns, along, { after: from - RESUME_SLACK_M })?.turn.at ?? null
    // The turn at 300 is more than 15 behind 330, so it stays behind however the position wanders.
    expect(seen(330)).toBeNull()
    expect(seen(290)).toBeNull()
    // One 15 metres behind, or less, is not hidden: it is still at the wheels.
    expect(upcomingTurn(turns, 310, { after: 310 - RESUME_SLACK_M })?.turn.at).toBe(300)
    expect(upcomingTurn(turns, 320, { after: 320 - RESUME_SLACK_M })).toBeNull()
  })
})

describe('how far before a place a stop is still ahead, for the alert distances in use', () => {
  const occ = (key: string, at: number) => ({ key, stop: { id: key, type: 'nothrow' as const, pathIdx: 0, lat: 0, lng: 0 }, idx: 0, at, off: 0 })
  const occs = [occ('a', 488), occ('b', 495), occ('c', 480)]

  it('is the usual slack for any alert distance of 15 metres or more', () => {
    expect(slackFor({ bundle: 40, nothrow: 40, request: 40, block: 40 })).toBe(RESUME_SLACK_M)
    expect(slackFor({ bundle: 15, nothrow: 15, request: 15, block: 15 })).toBe(RESUME_SLACK_M)
    expect(slackFor({ bundle: 60, nothrow: 20, request: 30, block: 25 })).toBe(RESUME_SLACK_M)
  })

  it('is the smallest alert zone when that is smaller, so no stop is left neither done nor alerting', () => {
    expect(slackFor({ bundle: 10, nothrow: 10, request: 10, block: 10 })).toBe(10)
    expect(slackFor({ bundle: 40, nothrow: 12, request: 40, block: 40 })).toBe(12)
  })

  it('counts the alert zone of an apartment block among them, since it alerts like the others', () => {
    expect(slackFor({ bundle: 40, nothrow: 40, request: 40, block: 11 })).toBe(11)
    expect(slackFor({ bundle: 40, nothrow: 40, request: 40, block: 12 })).toBe(12)
    expect(slackFor({ bundle: 40, nothrow: 40, request: 40, block: 16 })).toBe(RESUME_SLACK_M)
  })

  it('moves the line a stop must be behind a place to count as done', () => {
    // Against a place at 500: with a 10 metre slack the stops at 488 and 480 are done, 495 is still ahead. With 15, only 480 is.
    expect(handledForResume(occs, 500, 10)).toEqual(['a', 'c'])
    expect(handledForResume(occs, 500, 15)).toEqual(['c'])
    expect(handledForResume(occs, 500)).toEqual(['c'])
  })

  it('does the same for what skipping gives up', () => {
    expect(skippedBy(occs, new Set(), 500, 10)).toBe(2)
    expect(skippedBy(occs, new Set(), 500)).toBe(1)
  })
})

describe('what a change of side made of the passes at the head of a court, kept with the round', () => {
  it('is read back from storage as it was kept, the entries that say out or ahead and nothing else', () => {
    const kept = { W: 'out', 'E#2': 'ahead' } as const
    expect(normalizeCourtLegs(JSON.parse(JSON.stringify(kept)))).toEqual(kept)
    expect(normalizeCourtLegs({ W: 'out', E: 'done', F: 1, G: null, H: ['ahead'] })).toEqual({ W: 'out' })
  })

  it('is none for a round saved before it was kept, and for anything that is not a set of entries', () => {
    for (const raw of [undefined, null, 'out', 3, true, ['out'], [['W', 'out']]]) expect(normalizeCourtLegs(raw), JSON.stringify(raw)).toEqual({})
  })

  it('never lets a key reach the prototype', () => {
    const read = normalizeCourtLegs(JSON.parse('{"__proto__":"out","constructor":"ahead"}'))
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype)
    expect(Object.entries(read)).toEqual([
      ['__proto__', 'out'],
      ['constructor', 'ahead'],
    ])
  })

  it('is kept with the round in place of what it had, and the key left out when there is none', () => {
    const before = round({ handledStopIds: ['E'], furthest: 300, courtLegs: { X: 'ahead' } })
    expect(withCourtLegs(before, { W: 'out' })).toEqual({ handledStopIds: ['E'], furthest: 300, courtLegs: { W: 'out' } })
    for (const none of [{}, undefined]) {
      const after = withCourtLegs(before, none)
      expect(after).toEqual({ handledStopIds: ['E'], furthest: 300 })
      expect('courtLegs' in after).toBe(false)
    }
    // What it is given is not changed, nor kept as the same object.
    const legs = { W: 'out' } as const
    expect(withCourtLegs(before, legs).courtLegs).not.toBe(legs)
    expect(before.courtLegs).toEqual({ X: 'ahead' })
  })

  it('says the same as another with the same entries, none at all being the same as an empty set', () => {
    expect(sameCourtLegs(undefined, {})).toBe(true)
    expect(sameCourtLegs({ W: 'out', E: 'ahead' }, { E: 'ahead', W: 'out' })).toBe(true)
    expect(sameCourtLegs({ W: 'out' }, { W: 'ahead' })).toBe(false)
    expect(sameCourtLegs({ W: 'out' }, {})).toBe(false)
    expect(sameCourtLegs(undefined, { W: 'out' })).toBe(false)
    expect(sameCourtLegs({ W: 'out' }, { W: 'out', E: 'out' })).toBe(false)
  })

  it('does not move where a round that is carried on picks up', () => {
    const occs = [occ('A', 100), occ('W', 285)]
    const plain = round({ handledStopIds: ['A'], furthest: 300 })
    expect(continueFrom(withCourtLegs(plain, { W: 'out' }), occs, new Set(['A']))).toBe(continueFrom(plain, occs, new Set(['A'])))
  })
})
