import { describe, expect, it } from 'vitest'
import { LEAD_ID, type ResolvedSection } from './namedSections'
import { carriedOn, NOTHING_WATCHED, RESUMED_WATCH, SECTION_END_M, SECTION_FASTEST_M_S, SECTION_MOVE_SLACK_M, sectionSpeech, startedAt, watchSection, type SectionWatch } from './sectionWatch'

const section = (id: string, startM: number, endM: number, lead = false): ResolvedSection => ({ id, name: `Section ${id}`, startM, endM, lead })
const LIST = [section(LEAD_ID, 0, 500, true), section('a', 500, 1500), section('b', 1500, 3000), section('c', 3000, 4000)]
const routeEnd = 4000

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
    expect(drive(NOTHING_WATCHED, steps(0, 600)).notes).toEqual([{ ended: null, started: 'Section a' }])
  })

  it('tells of the end of one and the start of the next together, once each, as the car goes over the line', () => {
    expect(drive(NOTHING_WATCHED, steps(490, 3100)).notes).toEqual([
      { ended: null, started: 'Section a' },
      { ended: 'Section a', started: 'Section b' },
      { ended: 'Section b', started: 'Section c' },
    ])
  })

  it('tells of the end of the last section at the end of the route, alone', () => {
    const { notes } = drive(RESUMED_WATCH, steps(2990, 3990))
    expect(notes.at(-1)).toEqual({ ended: 'Section c', started: null })
    expect(notes).toHaveLength(2)
  })

  it('ends the last section only near the end of the route', () => {
    const near = routeEnd - SECTION_END_M
    expect(drive(RESUMED_WATCH, steps(3400, near - 10)).notes).toEqual([])
    expect(drive(RESUMED_WATCH, steps(3400, near)).notes).toEqual([{ ended: 'Section c', started: null }])
  })

  it('ends the section before the last at the line, and the last after it starts, when the last starts near the end of the route', () => {
    const list = [section('a', 0, 3970), section('z', 3970, routeEnd)]
    expect(drive(RESUMED_WATCH, [3900, 3955, 3975, 3985], list).notes).toEqual([
      { ended: 'Section a', started: 'Section z' },
      { ended: 'Section z', started: null },
    ])
  })

  it('keeps the end of the section left when the fix that goes into the last section is already near the end of the route', () => {
    const list = [section('a', 0, 3970), section('z', 3970, routeEnd)]
    expect(drive(RESUMED_WATCH, [3900, 3940, 3975, 3985], list).notes).toEqual([
      { ended: 'Section a', started: 'Section z' },
      { ended: 'Section z', started: null },
    ])
  })

  it('says nothing more for a car going to and fro over a line', () => {
    expect(drive(RESUMED_WATCH, [1480, 1490, 1500, 1510, 1490, 1480, 1500, 1520, 1490, 1510]).notes).toEqual([{ ended: 'Section a', started: 'Section b' }])
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
    expect(drive(back.watch, steps(630, 1510)).notes).toEqual([{ ended: 'Section a', started: 'Section b' }])
  })

  it('weighs a throw against the last look, not the first', () => {
    const { watch } = drive(RESUMED_WATCH, steps(600, 1400))
    expect(watchSection(watch, LIST, look(1400 + SECTION_FASTEST_M_S + SECTION_MOVE_SLACK_M + 1, (watch.last?.time ?? 0) + 1000)).note).toBeNull()
  })

  it('believes as far along the route as the car can have gone in the time, and a little over', () => {
    const { watch } = drive(RESUMED_WATCH, [1490])
    const time = (watch.last?.time ?? 0) + 2000
    const far = 2 * SECTION_FASTEST_M_S + SECTION_MOVE_SLACK_M
    expect(watchSection(watch, LIST, look(1490 + far, time)).note).toEqual({ ended: 'Section a', started: 'Section b' })
    expect(watchSection(watch, LIST, look(1491 + far, time)).note).toBeNull()
  })

  it('tells of a move it could not believe as soon as there has been time for it, as after a stretch round a bend', () => {
    const { watch } = drive(RESUMED_WATCH, [1200])
    const early = watchSection(watch, LIST, look(1900, 2000))
    expect(early.note).toBeNull()
    expect(watchSection(early.watch, LIST, look(1910, 20_000)).note).toEqual({ ended: 'Section a', started: 'Section b' })
  })

  it('tells over a gap in the fixes, as late as the car is known to have gone over the line', () => {
    const { watch } = drive(RESUMED_WATCH, [1200])
    expect(watchSection(watch, LIST, look(1900, 61_000)).note).toEqual({ ended: 'Section a', started: 'Section b' })
  })

  it('does not tell of a line gone over the wrong way, and tells when the car comes over it the right way', () => {
    const { watch } = drive(RESUMED_WATCH, [1400])
    const wrong = watchSection(watch, LIST, look(1530, 20_000, { forward: false }))
    expect([wrong.note, wrong.watch]).toEqual([null, watch])
    const back = watchSection(wrong.watch, LIST, look(1390, 40_000, { forward: false }))
    expect(back.note).toBeNull()
    expect(watchSection(back.watch, LIST, look(1510, 60_000)).note).toEqual({ ended: 'Section a', started: 'Section b' })
  })

  it('tells of the section the car is in at the first look after a start or a skip, however far into it', () => {
    expect(drive(NOTHING_WATCHED, [1800]).notes).toEqual([{ ended: null, started: 'Section b' }])
  })

  it('tells nothing at the first look after Continue Round: the car is carrying on', () => {
    expect(drive(RESUMED_WATCH, [1505, 1510]).notes).toEqual([])
    expect(drive(RESUMED_WATCH, [1400, 1510]).notes).toEqual([{ ended: 'Section a', started: 'Section b' }])
  })

  it('believes the driver at a carry-on, however far on that is, and tells of the section left and the one the car is in', () => {
    const { watch } = drive(RESUMED_WATCH, [600])
    expect(watchSection(carriedOn(watch), LIST, look(3500, 2000)).note).toEqual({ ended: 'Section a', started: 'Section c' })
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
    expect(over.note).toEqual({ ended: 'Section b', started: null })
    expect(over.watch.last).toEqual(watch.last)
    expect(watchSection(over.watch, LIST, look(3100, 90_000, { over: true })).note).toBeNull()
  })

  it('waits for the car to get to where the round was started or skipped to, as short of it it is on the way there', () => {
    expect(drive(startedAt(1500), [1430, 1490, 1500, 1520]).notes).toEqual([{ ended: null, started: 'Section b' }])
    expect(drive(startedAt(1500), [1505]).notes).toEqual([{ ended: null, started: 'Section b' }])
    expect(drive(startedAt(2500), [2420, 2490, 2510]).notes).toEqual([{ ended: null, started: 'Section b' }])
  })

  it('tells nothing at a round over at the first look, past its last stop', () => {
    const over = watchSection(NOTHING_WATCHED, LIST, look(1700, 1000, { over: true }))
    expect(over.note).toBeNull()
    expect(watchSection(over.watch, LIST, look(1710, 2000, { over: true })).note).toBeNull()
  })

  it('ends the section the car was last taken to be in when the round is over, not where the tracker has it', () => {
    const { watch } = drive(RESUMED_WATCH, [1400])
    expect(watchSection(watch, LIST, look(2800, 5000, { over: true })).note).toEqual({ ended: 'Section a', started: null })
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
    expect(watchSection(over.watch, LIST, look(3100, 90_000)).note).toEqual({ ended: null, started: 'Section c' })
  })

  it('does not end the last section on the fix that starts it, with nothing named before it to end', () => {
    const list = [section(LEAD_ID, 0, 3970, true), section('z', 3970, routeEnd)]
    expect(drive(RESUMED_WATCH, [3940, 3975, 3985], list).notes).toEqual([
      { ended: null, started: 'Section z' },
      { ended: 'Section z', started: null },
    ])
  })

  it('keeps the end of the section left when the last, told before, is come to again near the end of the route', () => {
    const list = [section('y', 0, 3970), section('z', 3970, routeEnd)]
    expect(drive(NOTHING_WATCHED, [3975, 3900, 3975, 3985], list).notes).toEqual([
      { ended: null, started: 'Section z' },
      { ended: 'Section y', started: null },
      { ended: 'Section z', started: null },
    ])
  })

  it('says nothing at all for a route with no named sections', () => {
    expect(drive(NOTHING_WATCHED, steps(0, 3990), []).notes).toEqual([])
    expect(watchSection(NOTHING_WATCHED, [], look(100, 1000, { over: true })).note).toBeNull()
  })

  it('leaves the end of a section whose id has gone unsaid, and tells of the start of the one the car is in', () => {
    const { watch } = drive(RESUMED_WATCH, steps(490, 600))
    expect(drive(watch, [610], [section('b', 0, routeEnd)]).notes).toEqual([{ ended: null, started: 'Section b' }])
  })

  it('says the end first', () => {
    expect(sectionSpeech({ ended: 'Oak Estate', started: 'Beach Road' })).toBe('End of Oak Estate. Start of Beach Road.')
    expect(sectionSpeech({ ended: 'Oak Estate', started: null })).toBe('End of Oak Estate.')
    expect(sectionSpeech({ ended: null, started: 'Beach Road' })).toBe('Start of Beach Road.')
  })
})
