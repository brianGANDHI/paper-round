import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LEAD_ID, sectionCalls, sectionNumberPrefix, type ResolvedSection, type SectionCall } from './namedSections'
import { isStartSection } from './optimise/run'
import { SectionBanner } from './SectionBanner'
import { carriedOn, NOTHING_WATCHED, RESUMED_WATCH, SECTION_END_M, SECTION_FASTEST_M_S, SECTION_MOVE_SLACK_M, sectionAgain, sectionRows, sectionSpeech, startedAt, watchSection, type SectionNote, type SectionWatch } from './sectionWatch'

const section = (id: string, startM: number, endM: number, lead = false): ResolvedSection => ({ id, name: `Section ${id}`, startM, endM, lead })
const LIST = [section(LEAD_ID, 0, 500, true), section('a', 500, 1500), section('b', 1500, 3000), section('c', 3000, 4000)]
const routeEnd = 4000
/** How a test section is called: by its number, whichever that is on the list it is in (see the tests of `sectionCalls`), and its name. */
const call = (id: string): SectionCall => ({ id, label: expect.stringMatching(/^Section \d+$/) as unknown as string, name: `Section ${id}`, the: false })
/** What is told, by the sections' ids: c and z are always the last on their routes. */
const note = (ended: string | null, started: string | null): SectionNote => ({
  ended: ended === null ? null : call(ended),
  started: started === null ? null : call(started),
  last: ended !== null && started === null && (ended === 'c' || ended === 'z'),
})

/** One look a second, at each spot in turn, at the given place in the list. */
const drive = (from: SectionWatch, spots: number[], list = LIST, start = from.last?.time ?? 0) => {
  let watch = from
  const notes: unknown[] = []
  spots.forEach((along, i) => {
    const step = watchSection(watch, list, { along, time: start + (i + 1) * 1000, forward: true, routeEnd, over: false })
    watch = step.watch
    if (step.note) notes.push(step.note)
  })
  return { watch, notes }
}
const steps = (from: number, to: number) => Array.from({ length: Math.round(Math.abs(to - from) / 10) + 1 }, (_, i) => from + Math.sign(to - from) * i * 10)
const look = (along: number, time: number, more = {}) => ({ along, time, forward: true, routeEnd, over: false, ...more })

describe('telling where a named section starts and ends', () => {
  it('tells of the first section as the car comes to it, with no end for the part before it, which has no name', () => {
    expect(drive(NOTHING_WATCHED, steps(0, 600)).notes).toEqual([note(null, 'a')])
  })

  it('tells of the end of one and the start of the next together, once each, as the car goes over the line', () => {
    expect(drive(NOTHING_WATCHED, steps(490, 3100)).notes).toEqual([
      note(null, 'a'),
      note('a', 'b'),
      note('b', 'c'),
    ])
  })

  it('tells of the end of the last section at the end of the route, alone', () => {
    const { notes } = drive(RESUMED_WATCH, steps(2990, 3990))
    expect(notes.at(-1)).toEqual(note('c', null))
    expect(notes).toHaveLength(2)
  })

  it('ends the last section only near the end of the route', () => {
    const near = routeEnd - SECTION_END_M
    expect(drive(RESUMED_WATCH, steps(3400, near - 10)).notes).toEqual([])
    expect(drive(RESUMED_WATCH, steps(3400, near)).notes).toEqual([note('c', null)])
  })

  it('ends the section before the last at the line, and the last after it starts, when the last starts near the end of the route', () => {
    const list = [section('a', 0, 3970), section('z', 3970, routeEnd)]
    expect(drive(RESUMED_WATCH, [3900, 3955, 3975, 3985], list).notes).toEqual([
      note('a', 'z'),
      note('z', null),
    ])
  })

  it('keeps the end of the section left when the fix that goes into the last section is already near the end of the route', () => {
    const list = [section('a', 0, 3970), section('z', 3970, routeEnd)]
    expect(drive(RESUMED_WATCH, [3900, 3940, 3975, 3985], list).notes).toEqual([
      note('a', 'z'),
      note('z', null),
    ])
  })

  it('says nothing more for a car going to and fro over a line', () => {
    expect(drive(RESUMED_WATCH, [1480, 1490, 1500, 1510, 1490, 1480, 1500, 1520, 1490, 1510]).notes).toEqual([note('a', 'b')])
  })

  it('says nothing for a car going back into a section', () => {
    const { watch } = drive(RESUMED_WATCH, steps(1490, 1510))
    expect(drive(watch, steps(1510, 1400)).notes).toEqual([])
  })

  it('says nothing for a throw along the route, there or back, and takes up from where the car really is', () => {
    const { watch } = drive(RESUMED_WATCH, steps(490, 600))
    const away = watchSection(watch, LIST, look(3500, 13_000))
    expect([away.note, away.watch]).toEqual([null, watch])
    const back = watchSection(away.watch, LIST, look(620, 14_000))
    expect(back.note).toBeNull()
    expect(drive(back.watch, steps(630, 1510)).notes).toEqual([note('a', 'b')])
  })

  it('weighs a throw against the last look, not the first', () => {
    const { watch } = drive(RESUMED_WATCH, steps(600, 1400))
    expect(watchSection(watch, LIST, look(1400 + SECTION_FASTEST_M_S + SECTION_MOVE_SLACK_M + 1, (watch.last?.time ?? 0) + 1000)).note).toBeNull()
  })

  it('believes as far along the route as the car can have gone in the time, and a little over', () => {
    const { watch } = drive(RESUMED_WATCH, [1490])
    const time = (watch.last?.time ?? 0) + 2000
    const far = 2 * SECTION_FASTEST_M_S + SECTION_MOVE_SLACK_M
    expect(watchSection(watch, LIST, look(1490 + far, time)).note).toEqual(note('a', 'b'))
    expect(watchSection(watch, LIST, look(1491 + far, time)).note).toBeNull()
  })

  it('tells of a move it could not believe as soon as there has been time for it, as after a stretch round a bend', () => {
    const { watch } = drive(RESUMED_WATCH, [1200])
    const early = watchSection(watch, LIST, look(1900, 2000))
    expect(early.note).toBeNull()
    expect(watchSection(early.watch, LIST, look(1910, 20_000)).note).toEqual(note('a', 'b'))
  })

  it('tells over a gap in the fixes, as late as the car is known to have gone over the line', () => {
    const { watch } = drive(RESUMED_WATCH, [1200])
    expect(watchSection(watch, LIST, look(1900, 61_000)).note).toEqual(note('a', 'b'))
  })

  it('does not tell of a line gone over the wrong way, and tells when the car comes over it the right way', () => {
    const { watch } = drive(RESUMED_WATCH, [1400])
    const wrong = watchSection(watch, LIST, look(1530, 20_000, { forward: false }))
    expect([wrong.note, wrong.watch]).toEqual([null, watch])
    const back = watchSection(wrong.watch, LIST, look(1390, 40_000, { forward: false }))
    expect(back.note).toBeNull()
    expect(watchSection(back.watch, LIST, look(1510, 60_000)).note).toEqual(note('a', 'b'))
  })

  it('tells of the section the car is in at the first look after a start or a skip, however far into it', () => {
    expect(drive(NOTHING_WATCHED, [1800]).notes).toEqual([note(null, 'b')])
  })

  it('tells nothing at the first look after Continue Round: the car is carrying on', () => {
    expect(drive(RESUMED_WATCH, [1505, 1510]).notes).toEqual([])
    expect(drive(RESUMED_WATCH, [1400, 1510]).notes).toEqual([note('a', 'b')])
  })

  it('believes the driver at a carry-on, however far on that is, and tells of the section left and the one the car is in', () => {
    const { watch } = drive(RESUMED_WATCH, [600])
    expect(watchSection(carriedOn(watch), LIST, look(3500, 2000)).note).toEqual(note('a', 'c'))
    expect(watchSection(watch, LIST, look(3500, 2000)).note).toBeNull()
  })

  it('goes back to weighing moves after a carry-on', () => {
    const { watch } = drive(RESUMED_WATCH, [600])
    const on = watchSection(carriedOn(watch), LIST, look(700, 2000))
    expect(on.watch.trusted).toBe(false)
    expect(watchSection(on.watch, LIST, look(3500, 3000)).note).toBeNull()
  })

  it('says nothing again after a carry-on in the same section, or going back', () => {
    const { watch } = drive(RESUMED_WATCH, steps(1490, 1510))
    expect(watchSection(carriedOn(watch), LIST, look(1600, 60_000)).note).toBeNull()
    expect(watchSection(carriedOn(watch), LIST, look(800, 60_000)).note).toBeNull()
  })

  it('ends the section the car is in when the round is over, and tells nothing after that', () => {
    const { watch } = drive(RESUMED_WATCH, [1600])
    const over = watchSection(watch, LIST, look(1700, 10_000, { over: true }))
    expect(over.note).toEqual(note('b', null))
    expect(over.watch.last).toEqual(watch.last)
    expect(watchSection(over.watch, LIST, look(3100, 90_000, { over: true })).note).toBeNull()
  })

  it('waits for the car to get to where the round was started or skipped to, as short of it it is on the way there', () => {
    expect(drive(startedAt(1500), [1430, 1490, 1500, 1520]).notes).toEqual([note(null, 'b')])
    expect(drive(startedAt(1500), [1505]).notes).toEqual([note(null, 'b')])
    expect(drive(startedAt(2500), [2420, 2490, 2510]).notes).toEqual([note(null, 'b')])
  })

  it('tells nothing at a round over at the first look, past its last stop', () => {
    const over = watchSection(NOTHING_WATCHED, LIST, look(1700, 1000, { over: true }))
    expect(over.note).toBeNull()
    expect(watchSection(over.watch, LIST, look(1710, 2000, { over: true })).note).toBeNull()
  })

  it('ends the section the car was last taken to be in when the round is over, not where the tracker has it', () => {
    const { watch } = drive(RESUMED_WATCH, [1400])
    expect(watchSection(watch, LIST, look(2800, 5000, { over: true })).note).toEqual(note('a', null))
  })

  it('does not end the last section for a car going the wrong way near the end of the route', () => {
    const { watch } = drive(RESUMED_WATCH, [3900])
    expect(watchSection(watch, LIST, look(3960, 5000, { forward: false })).note).toBeNull()
  })

  it('takes a move back along the route however quick, and weighs the next move from there', () => {
    const { watch } = drive(RESUMED_WATCH, [1400])
    const back = watchSection(watch, LIST, look(600, 2000))
    expect(back.watch.last).toEqual({ id: 'a', along: 600, time: 2000 })
    expect(watchSection(back.watch, LIST, look(1510, 3000)).note).toBeNull()
  })

  it('does not tell again of an end told as the round was over, if the round goes on after all', () => {
    const { watch } = drive(RESUMED_WATCH, [1600])
    const over = watchSection(watch, LIST, look(1700, 10_000, { over: true }))
    expect(watchSection(over.watch, LIST, look(3100, 90_000)).note).toEqual(note(null, 'c'))
  })

  it('does not end the last section on the fix that starts it, with nothing named before it to end', () => {
    const list = [section(LEAD_ID, 0, 3970, true), section('z', 3970, routeEnd)]
    expect(drive(RESUMED_WATCH, [3940, 3975, 3985], list).notes).toEqual([
      note(null, 'z'),
      note('z', null),
    ])
  })

  it('keeps the end of the section left when the last, told before, is come to again near the end of the route', () => {
    const list = [section('y', 0, 3970), section('z', 3970, routeEnd)]
    expect(drive(NOTHING_WATCHED, [3975, 3900, 3975, 3985], list).notes).toEqual([
      note(null, 'z'),
      note('y', null),
      note('z', null),
    ])
  })

  it('says nothing at all for a route with no named sections', () => {
    expect(drive(NOTHING_WATCHED, steps(0, 3990), []).notes).toEqual([])
    expect(watchSection(NOTHING_WATCHED, [], look(100, 1000, { over: true })).note).toBeNull()
  })

  it('leaves the end of a section whose id has gone unsaid, and tells of the start of the one the car is in', () => {
    const { watch } = drive(RESUMED_WATCH, steps(490, 600))
    expect(drive(watch, [610], [section('b', 0, routeEnd)]).notes).toEqual([note(null, 'b')])
  })

  it('says whether the section ended was the last on the route', () => {
    const list = [section('a', 0, 1000), section('b', 1000, routeEnd)]
    const { notes } = drive(RESUMED_WATCH, steps(900, 3990), list)
    expect(notes).toEqual([
      { ended: call('a'), started: call('b'), last: false },
      { ended: call('b'), started: null, last: true },
    ])
    // A round over in a section before the last ends it, and that was not the last.
    const { watch } = drive(RESUMED_WATCH, steps(400, 600), list)
    expect(watchSection(watch, list, look(600, 9000, { over: true })).note).toEqual({ ended: call('a'), started: null, last: false })
  })
})

/** Sections with the names given, one after another along the route, with the part before them unnamed. */
const named = (...names: string[]): ResolvedSection[] => [
  { id: LEAD_ID, name: 'Start of route', startM: 0, endM: 100, lead: true },
  ...names.map((name, i) => ({ id: `s${i}`, name, startM: 100 + i * 100, endM: 200 + i * 100, lead: false })),
]
const calls = (...names: string[]) => [...sectionCalls(named(...names)).values()].map(({ label, name, the }) => ({ label, name, the }))
const callOf = (list: ResolvedSection[], id: string) => sectionCalls(list).get(id) ?? null

describe('calling each named section by its number', () => {
  it('numbers them from 1 in route order, with the name they were given, and gives the part before them no number', () => {
    expect(calls('Oak Estate', 'Beach Road', 'Hill St')).toEqual([
      { label: 'Section 1', name: 'Oak Estate', the: false },
      { label: 'Section 2', name: 'Beach Road', the: false },
      { label: 'Section 3', name: 'Hill St', the: false },
    ])
    expect(sectionCalls(named('Oak Estate')).has(LEAD_ID)).toBe(false)
  })

  it('numbers them as they lie along the route, not as they were added', () => {
    const list = named('Oak Estate', 'Beach Road')
    const swapped = [list[0], { ...list[2], startM: 100, endM: 200 }, { ...list[1], startM: 200, endM: 300 }]
    expect([...sectionCalls(swapped).values()].map((c) => `${c.label} ${c.name}`)).toEqual(['Section 1 Beach Road', 'Section 2 Oak Estate'])
  })

  it('does not count a section named Start or End, and calls it the Start section or the End section, by the rule Optimise Route has for Start', () => {
    expect(calls('Start', 'Oak Estate', 'Beach Road', 'End')).toEqual([
      { label: 'Start section', name: null, the: true },
      { label: 'Section 1', name: 'Oak Estate', the: false },
      { label: 'Section 2', name: 'Beach Road', the: false },
      { label: 'End section', name: null, the: true },
    ])
    for (const name of ['start', 'START', ' Start ', 'sTaRt']) {
      expect(calls(name)[0].label).toBe('Start section')
      expect(isStartSection({ name })).toBe(true)
    }
    for (const name of ['end', 'END', ' End\t']) expect(calls(name)[0].label).toBe('End section')
  })

  it('takes only the first Start and the last End as the start and the end of the round, and numbers any other, with its name', () => {
    expect(calls('Start', 'Oak Estate', 'start', 'End', 'Beach Road', ' END ')).toEqual([
      { label: 'Start section', name: null, the: true },
      { label: 'Section 1', name: 'Oak Estate', the: false },
      { label: 'Section 2', name: 'start', the: false },
      { label: 'Section 3', name: 'End', the: false },
      { label: 'Section 4', name: 'Beach Road', the: false },
      { label: 'End section', name: null, the: true },
    ])
    // A Start that comes after the End is still the start of the round, and the End is still the end.
    expect(calls('Oak Estate', 'End', 'Start').map((c) => c.label)).toEqual(['Section 1', 'End section', 'Start section'])
  })

  it('counts and names every other name as it is, even one with Start or End in it, or a word a plain object has', () => {
    const names = ['Start Two', 'Restart', 'Back End', 'Ending', 'The End', 'Start and End', 'constructor', 'toString']
    expect(calls(...names)).toEqual(names.map((name, i) => ({ label: `Section ${i + 1}`, name, the: false })))
    for (const name of [...names, 'Area Two']) expect(isStartSection({ name })).toBe(false)
  })

  it('does not say a name again that is the number of the section itself, or that number at the start of a longer one', () => {
    expect(calls('Section 1', '2', 'section 3 - Oak Estate', 'SECTION 4: Beach Road', '#5', '6.', 'Section 7 Hill St', 'Section 8 -')).toEqual([
      { label: 'Section 1', name: null, the: false },
      { label: 'Section 2', name: null, the: false },
      { label: 'Section 3', name: 'Oak Estate', the: false },
      { label: 'Section 4', name: 'Beach Road', the: false },
      { label: 'Section 5', name: null, the: false },
      { label: 'Section 6', name: null, the: false },
      { label: 'Section 7', name: 'Hill St', the: false },
      { label: 'Section 8', name: null, the: false },
    ])
  })

  it('takes the number off however it is set apart from the rest of the name, the way a phone types it', () => {
    // Each second on its route. The dash with no spaces is what an iPhone makes of two hyphens.
    for (const name of ['Section 2. Beach Road', 'Section 2 / Beach Road', 'Section 2 | Beach Road', 'Section 2 (Beach Road)', 'Section 2(Beach Road)', 'Section 2—Beach Road', 'Section 2 -Beach Road', 'Section 2:Beach Road', 'Section 2 – Beach Road']) {
      expect(calls('Oak Estate', name)[1]).toEqual({ label: 'Section 2', name: 'Beach Road', the: false })
    }
  })

  it('never calls two sections the same, whatever they were named, and keeps a number that is not theirs as their name', () => {
    for (const names of [
      ['Start', 'Oak', 'Start', 'End', 'end'],
      ['1', 'Shops', '2', '3'],
      ['Oak Estate', 'Section 1'],
      ['Section 2', 'Oak'],
      ['Start', 'Section 1', 'Shops', 'Section 2'],
      ['Section 1', 'Section 1'],
      ['4', '4', 'Section 4', 'section 4 - Oak'],
    ]) {
      const labels = calls(...names).map((c) => c.label)
      expect(new Set(labels).size).toBe(labels.length)
    }
    expect(calls('1', 'Shops', '2', '3')).toEqual([
      { label: 'Section 1', name: null, the: false },
      { label: 'Section 2', name: 'Shops', the: false },
      { label: 'Section 3', name: '2', the: false },
      { label: 'Section 4', name: '3', the: false },
    ])
    expect(calls('Oak Estate', 'Section 1').map((c) => [c.label, c.name])).toEqual([
      ['Section 1', 'Oak Estate'],
      ['Section 2', 'Section 1'],
    ])
  })

  it('puts the number before where a section runs in the lists, when its name does not say it already', () => {
    const list = named('Start', 'Oak Estate', 'Section 2', 'Section 9')
    const all = sectionCalls(list)
    expect(['s0', 's1', 's2', 's3'].map((id) => sectionNumberPrefix(all.get(id)))).toEqual(['', 'Section 1 · ', '', 'Section 3 · '])
    expect(sectionNumberPrefix(undefined)).toBe('')
  })

  it('takes a number that does not stand alone as part of the name, as with a street or an address', () => {
    // Each second on its route, so its own number would be 2.
    for (const name of ['Section 2.5', 'Section 2-3', 'Section 2/3', 'Section 2nd Street', '2 Oak St', 'Section Road', 'Sections 2', 'Sectional Lane', 'Sector 2', 'Section 2B']) {
      expect(calls('Oak Estate', name)[1]).toEqual({ label: 'Section 2', name, the: false })
    }
  })
})

describe('saying where a named section finishes and begins', () => {
  const list = named('Start', 'Oak Estate', 'Beach Road', 'End')
  const [start, oak, beach, end] = ['s0', 's1', 's2', 's3'].map((id) => callOf(list, id))

  it('says the end first, and moves on to the next by its number and its name', () => {
    expect(sectionSpeech({ ended: oak, started: beach, last: false })).toBe('Section 1 finished. Moving on to Section 2, Beach Road.')
    expect(sectionSpeech({ ended: null, started: oak, last: false })).toBe('Section 1 beginning, Oak Estate.')
    expect(sectionSpeech({ ended: beach, started: null, last: false })).toBe('Section 2 finished.')
    expect(sectionSpeech({ ended: beach, started: null, last: true })).toBe('Section 2 finished. That was the last section.')
  })

  it('says the Start section and the End section as the sections they are', () => {
    expect(sectionSpeech({ ended: null, started: start, last: false })).toBe('Start section beginning.')
    expect(sectionSpeech({ ended: start, started: oak, last: false })).toBe('Start section finished. Moving on to Section 1, Oak Estate.')
    expect(sectionSpeech({ ended: beach, started: end, last: false })).toBe('Section 2 finished. Moving on to the End section.')
    expect(sectionSpeech({ ended: end, started: null, last: true })).toBe('End section finished. That was the last section.')
  })

  it('leaves off a stop at the end of a name, which would run into its own', () => {
    const odd = named('Oak Estate.', 'Beach Rd!!', 'Hill St, ')
    expect(sectionSpeech({ ended: null, started: callOf(odd, 's0'), last: false })).toBe('Section 1 beginning, Oak Estate.')
    expect(sectionSpeech({ ended: callOf(odd, 's0'), started: callOf(odd, 's1'), last: false })).toBe('Section 1 finished. Moving on to Section 2, Beach Rd.')
    expect(sectionSpeech({ ended: null, started: callOf(odd, 's2'), last: false })).toBe('Section 3 beginning, Hill St.')
  })

  it('has shorter words to say again after a cut, for the section begun, when there is more than that to say', () => {
    expect(sectionAgain({ ended: oak, started: beach, last: false })).toBe('Section 2 beginning, Beach Road.')
    expect(sectionAgain({ ended: beach, started: end, last: false })).toBe('End section beginning.')
    expect(sectionAgain({ ended: null, started: oak, last: false })).toBeUndefined()
    expect(sectionAgain({ ended: beach, started: null, last: true })).toBeUndefined()
  })

  it('says nothing for nothing to tell', () => {
    expect(sectionSpeech({ ended: null, started: null, last: false })).toBe('')
  })

  it('has the banner say what the voice says, the end over the beginning, each with its name under it', () => {
    expect(sectionRows({ ended: oak, started: beach, last: false })).toEqual([
      { kind: 'ended', title: 'Section 1 finished', lines: ['Oak Estate'] },
      { kind: 'started', title: 'Moving on to Section 2', lines: ['Beach Road'] },
    ])
    expect(sectionRows({ ended: null, started: oak, last: false })).toEqual([{ kind: 'started', title: 'Section 1 beginning', lines: ['Oak Estate'] }])
    expect(sectionRows({ ended: beach, started: null, last: true })).toEqual([{ kind: 'ended', title: 'Section 2 finished', lines: ['Beach Road', 'That was the last section'] }])
    expect(sectionRows({ ended: end, started: null, last: true })).toEqual([{ kind: 'ended', title: 'End section finished', lines: ['That was the last section'] }])
    expect(sectionRows({ ended: beach, started: end, last: false })).toEqual([
      { kind: 'ended', title: 'Section 2 finished', lines: ['Beach Road'] },
      { kind: 'started', title: 'Moving on to the End section', lines: [] },
    ])
  })

  it('shows those words big, the name under them, and tells a screen reader what the voice says', () => {
    const out = renderToStaticMarkup(createElement(SectionBanner, { ended: oak, started: beach, last: false }))
    expect(out.match(/section-row (\w+)/g)).toEqual(['section-row ended', 'section-row started'])
    expect(out).toMatch(/<span class="section-title">Section 1 finished<\/span><span class="section-name">Oak Estate<\/span>/)
    expect(out).toMatch(/<span class="section-title">Moving on to Section 2<\/span><span class="section-name">Beach Road<\/span>/)
    expect(out).toContain('aria-label="Section 1 finished. Moving on to Section 2, Beach Road."')
  })

  it('tells of each section on a drive by its number, from the Start section to the End section', () => {
    const route = [
      { id: 'st', name: 'Start', startM: 0, endM: 1000, lead: false },
      { id: 'oak', name: 'Oak Estate', startM: 1000, endM: 2000, lead: false },
      { id: 'beach', name: 'Beach Road', startM: 2000, endM: 3000, lead: false },
      { id: 'en', name: 'End', startM: 3000, endM: routeEnd, lead: false },
    ]
    const { notes } = drive(NOTHING_WATCHED, steps(0, 3990), route)
    expect(notes.map((n) => sectionSpeech(n as SectionNote))).toEqual([
      'Start section beginning.',
      'Start section finished. Moving on to Section 1, Oak Estate.',
      'Section 1 finished. Moving on to Section 2, Beach Road.',
      'Section 2 finished. Moving on to the End section.',
      'End section finished. That was the last section.',
    ])
  })
})
