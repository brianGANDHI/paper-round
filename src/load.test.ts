import { describe, expect, it } from 'vitest'
import {
  addLine,
  changeLine,
  changePapersEach,
  DEFAULT_LOAD,
  linePapers,
  linePapersText,
  loadNumberText,
  loadOf,
  loadRows,
  loadTotals,
  loadWhole,
  MAX_LOAD_LINES,
  MAX_LOAD_NOTE,
  MAX_LOAD_NUMBER,
  normalizeLoad,
  parseLoadNumber,
  removeLine,
  type LoadLine,
  type LoadList,
} from './load'

const line = (id: string, bundles: number, kind: LoadLine['kind'], note?: string): LoadLine => ({ id, bundles, kind, ...(note ? { note } : {}) })
const list = (...lines: LoadLine[]): LoadList => ({ lines, papersEach: { bagged: 25, unwrapped: 50 } })

/** What the rows say, in order: the words and the papers beside them. */
const said = (l: LoadList) => loadRows(l).map((r) => [r.text, r.papers])

describe("the driver's own list", () => {
  it('is 102 bagged on a pallet, 18 bagged and 13 unwrapped, at 25 and 50 papers a bundle', () => {
    expect(DEFAULT_LOAD.lines.map(({ bundles, kind, note }) => [bundles, kind, note])).toEqual([
      [102, 'bagged', '1 pallet'],
      [18, 'bagged', undefined],
      [13, 'unwrapped', undefined],
    ])
    expect(DEFAULT_LOAD.papersEach).toEqual({ bagged: 25, unwrapped: 50 })
  })

  it('reads down exactly as they write it', () => {
    expect(said(DEFAULT_LOAD)).toEqual([
      ['102 bagged · 1 pallet', '2,550'],
      ['+ 18 bagged', '450'],
      ['= 120 bagged', undefined],
      ['+ 13 unwrapped', '650'],
    ])
    expect(loadWhole(DEFAULT_LOAD)).toBe('133 bundles · 3,650 papers all up')
  })

  it('makes one pallet 2,550 papers', () => {
    expect(linePapers(DEFAULT_LOAD.lines[0], DEFAULT_LOAD)).toBe(2550)
  })

  it('adds up', () => {
    expect(loadTotals(DEFAULT_LOAD)).toEqual({ bagged: 120, unwrapped: 13, bundles: 133, papers: 3650 })
  })

  it('has one id for each row, so they are told apart from one showing to the next', () => {
    const ids = loadRows(DEFAULT_LOAD).map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(loadRows(DEFAULT_LOAD).map((r) => r.id)).toEqual(ids)
  })

  it('is left as it is by reading it and editing it', () => {
    const before = structuredClone(DEFAULT_LOAD)
    loadRows(DEFAULT_LOAD)
    loadWhole(DEFAULT_LOAD)
    addLine(DEFAULT_LOAD)
    removeLine(DEFAULT_LOAD, DEFAULT_LOAD.lines[0].id)
    changeLine(DEFAULT_LOAD, DEFAULT_LOAD.lines[0].id, { bundles: 1 })
    changePapersEach(DEFAULT_LOAD, 'bagged', 30)
    expect(DEFAULT_LOAD).toEqual(before)
  })
})

describe('the list a route shows', () => {
  it('is the usual one when the route has none of its own', () => {
    expect(loadOf(undefined)).toBe(DEFAULT_LOAD)
  })

  it('is its own when it has one, even with no lines', () => {
    const own = list(line('a', 3, 'bagged'))
    expect(loadOf(own)).toBe(own)
    const none = list()
    expect(loadOf(none)).toBe(none)
  })
})

describe('other lists', () => {
  it('has no subtotal with a single bagged line', () => {
    expect(said(list(line('a', 10, 'bagged'), line('b', 4, 'unwrapped')))).toEqual([
      ['10 bagged', '250'],
      ['+ 4 unwrapped', '200'],
    ])
  })

  it('has no plus on the first line when there is nothing bagged', () => {
    expect(said(list(line('a', 4, 'unwrapped'), line('b', 2, 'unwrapped')))).toEqual([
      ['4 unwrapped', '200'],
      ['+ 2 unwrapped', '100'],
    ])
  })

  it('does not add up the unwrapped lines by themselves', () => {
    expect(loadRows(list(line('a', 4, 'unwrapped'), line('b', 2, 'unwrapped'))).some((r) => r.subtotal)).toBe(false)
  })

  it('puts the bagged lines first and adds them up, whatever order they were put in', () => {
    expect(said(list(line('u', 2, 'unwrapped'), line('a', 3, 'bagged'), line('b', 4, 'bagged', 'Back seat')))).toEqual([
      ['3 bagged', '75'],
      ['+ 4 bagged · Back seat', '100'],
      ['= 7 bagged', undefined],
      ['+ 2 unwrapped', '100'],
    ])
  })

  it('adds up three bagged lines, and marks only that row as the subtotal', () => {
    const rows = loadRows(list(line('a', 1, 'bagged'), line('b', 2, 'bagged'), line('c', 3, 'bagged')))
    expect(rows.map((r) => r.text)).toEqual(['1 bagged', '+ 2 bagged', '+ 3 bagged', '= 6 bagged'])
    expect(rows.map((r) => !!r.subtotal)).toEqual([false, false, false, true])
  })

  it('has no rows for no lines', () => {
    expect(loadRows(list())).toEqual([])
    expect(loadWhole(list())).toBe('0 bundles · 0 papers all up')
  })

  it('uses the papers in a bundle of the list, not the usual ones', () => {
    const l: LoadList = { lines: [line('a', 4, 'bagged'), line('b', 2, 'unwrapped')], papersEach: { bagged: 30, unwrapped: 40 } }
    expect(said(l)).toEqual([
      ['4 bagged', '120'],
      ['+ 2 unwrapped', '80'],
    ])
    expect(loadWhole(l)).toBe('6 bundles · 200 papers all up')
  })

  it('says one bundle and one paper', () => {
    const l: LoadList = { lines: [line('a', 1, 'bagged')], papersEach: { bagged: 1, unwrapped: 50 } }
    expect(loadWhole(l)).toBe('1 bundle · 1 paper all up')
    expect(linePapersText(l.lines[0], l)).toBe('1 paper')
  })

  it('puts commas in every big figure, whatever the phone is set to', () => {
    const l = list(line('a', 1200, 'bagged'), line('b', 1200, 'bagged'))
    expect(said(l)).toEqual([
      ['1,200 bagged', '30,000'],
      ['+ 1,200 bagged', '30,000'],
      ['= 2,400 bagged', undefined],
    ])
    expect(loadWhole(l)).toBe('2,400 bundles · 60,000 papers all up')
    expect(linePapersText(l.lines[0], l)).toBe('30,000 papers')
  })

  it('shows a line left at 0 as it is, so it can be seen and taken off', () => {
    expect(said(list(line('a', 5, 'bagged'), line('b', 0, 'bagged')))[1]).toEqual(['+ 0 bagged', '0'])
  })
})

describe('what is typed in a number field', () => {
  it('is the number', () => {
    expect(parseLoadNumber('102')).toBe(102)
  })

  it('is 0 when blank, so the sums carry on while it is rubbed out', () => {
    expect(parseLoadNumber('')).toBe(0)
    expect(parseLoadNumber('   ')).toBe(0)
  })

  it('takes a leading 0 away', () => {
    expect(parseLoadNumber('05')).toBe(5)
  })

  it('is 0 for what is not a number, and takes no minus', () => {
    expect(parseLoadNumber('abc')).toBe(0)
    expect(parseLoadNumber('-5')).toBe(0)
  })

  it('stops at the end of the number', () => {
    expect(parseLoadNumber('12a')).toBe(12)
  })

  it('passes over a comma or a space, and stops at a point', () => {
    expect(parseLoadNumber('1,250')).toBe(1250)
    expect(parseLoadNumber('1 250')).toBe(1250)
    expect(parseLoadNumber('12.5')).toBe(12)
  })

  it('reads what the field lets in, which for a pasted 1,250 is its first four characters', () => {
    expect(parseLoadNumber('1,250'.slice(0, String(MAX_LOAD_NUMBER).length))).toBe(125)
  })

  it('goes no higher than the most a field takes, however long', () => {
    expect(parseLoadNumber(String(MAX_LOAD_NUMBER))).toBe(MAX_LOAD_NUMBER)
    expect(parseLoadNumber('10000')).toBe(MAX_LOAD_NUMBER)
    expect(parseLoadNumber('9'.repeat(500))).toBe(MAX_LOAD_NUMBER)
  })

  it('shows 0 as blank and anything else as itself', () => {
    expect(loadNumberText(0)).toBe('')
    expect(loadNumberText(25)).toBe('25')
  })
})

describe('changing a list', () => {
  it('changes one line and leaves the others and the list it was given', () => {
    const given = list(line('a', 1, 'bagged'), line('b', 2, 'unwrapped'))
    const copy = structuredClone(given)
    const next = changeLine(given, 'b', { bundles: 9, kind: 'bagged', note: 'Boot' })
    expect(next.lines).toEqual([line('a', 1, 'bagged'), line('b', 9, 'bagged', 'Boot')])
    expect(given).toEqual(copy)
  })

  it('changes nothing for a line that is not there', () => {
    const given = list(line('a', 1, 'bagged'))
    expect(changeLine(given, 'nope', { bundles: 9 }).lines).toEqual(given.lines)
  })

  it('removes one line', () => {
    const given = list(line('a', 1, 'bagged'), line('b', 2, 'unwrapped'))
    expect(removeLine(given, 'a').lines).toEqual([line('b', 2, 'unwrapped')])
    expect(given.lines).toHaveLength(2)
  })

  it('adds a line at the end with nothing in it, of the same kind as the last', () => {
    const next = addLine(list(line('a', 1, 'bagged'), line('b', 2, 'unwrapped')))
    expect(next.lines).toHaveLength(3)
    expect(next.lines[2]).toMatchObject({ bundles: 0, kind: 'unwrapped' })
    expect(next.lines[2].note).toBeUndefined()
  })

  it('adds a bagged line to an empty list', () => {
    expect(addLine(list()).lines[0]).toMatchObject({ bundles: 0, kind: 'bagged' })
  })

  it('gives each new line an id of its own', () => {
    let l = list()
    for (let i = 0; i < 5; i++) l = addLine(l)
    expect(new Set(l.lines.map((x) => x.id)).size).toBe(5)
    expect(l.lines.every((x) => x.id)).toBe(true)
  })

  it('adds no line to a full list', () => {
    const full = list(...Array.from({ length: MAX_LOAD_LINES }, (_, i) => line(`l${i}`, 1, 'bagged')))
    expect(addLine(full)).toBe(full)
  })

  it('changes the papers in a bundle of one kind and not the other', () => {
    const given = list(line('a', 4, 'bagged'))
    const next = changePapersEach(given, 'bagged', 30)
    expect(next.papersEach).toEqual({ bagged: 30, unwrapped: 50 })
    expect(given.papersEach.bagged).toBe(25)
  })
})

describe('a list read back from storage or a backup', () => {
  const good = () => list(line('a', 102, 'bagged', '1 pallet'), line('b', 13, 'unwrapped'))

  it('is the list that was saved', () => {
    expect(normalizeLoad(JSON.parse(JSON.stringify(good())))).toEqual(good())
  })

  it('is a new list, not the one it was given', () => {
    const given = good()
    const back = normalizeLoad(given)!
    expect(back).not.toBe(given)
    expect(back.lines[0]).not.toBe(given.lines[0])
    expect(back.papersEach).not.toBe(given.papersEach)
  })

  it('is nothing when it is not a list, which makes the route show the usual one', () => {
    for (const junk of [undefined, null, 5, 'list', true, [], {}, { lines: 'a' }, { lines: {} }, { lines: null }, { papersEach: { bagged: 1 } }]) {
      expect(normalizeLoad(junk), JSON.stringify(junk)).toBeUndefined()
    }
  })

  it('keeps a list with no lines: the driver took them all off', () => {
    expect(normalizeLoad(list())).toEqual(list())
  })

  it('is nothing when it had lines and none of them can be read', () => {
    expect(normalizeLoad({ lines: [null, 5, {}, { bundles: 'x', kind: 'bagged' }], papersEach: { bagged: 25, unwrapped: 50 } })).toBeUndefined()
  })

  it('leaves out a line that is damaged and keeps the rest', () => {
    const lines = [line('a', 5, 'bagged'), null, 7, 'x', [], { id: 'c', bundles: 3 }, { id: 'd', bundles: 3, kind: 'pallet' }, { id: 'e', kind: 'bagged' }, line('z', 2, 'unwrapped')]
    expect(normalizeLoad({ lines, papersEach: { bagged: 25, unwrapped: 50 } })!.lines).toEqual([line('a', 5, 'bagged'), line('z', 2, 'unwrapped')])
  })

  it('leaves out a line whose bundles are no number of anything', () => {
    for (const bundles of [-1, NaN, Infinity, -Infinity, '12', null, {}, true]) {
      const back = normalizeLoad({ lines: [line('a', 1, 'bagged'), { id: 'b', bundles, kind: 'bagged' }], papersEach: { bagged: 25, unwrapped: 50 } })!
      expect(back.lines.map((l) => l.id), String(bundles)).toEqual(['a'])
    }
  })

  it('keeps a line of 0', () => {
    expect(normalizeLoad(list(line('a', 0, 'bagged')))!.lines[0].bundles).toBe(0)
  })

  it('makes a number whole, and no bigger than a field takes, so the line can still be seen and put right', () => {
    const back = normalizeLoad({ lines: [{ id: 'a', bundles: 12.7, kind: 'bagged' }, { id: 'b', bundles: 1e9, kind: 'bagged' }], papersEach: { bagged: 25.9, unwrapped: 1e9 } })!
    expect(back.lines.map((l) => l.bundles)).toEqual([12, MAX_LOAD_NUMBER])
    expect(back.papersEach).toEqual({ bagged: 25, unwrapped: MAX_LOAD_NUMBER })
  })

  it('takes the usual number of papers in a bundle when it is missing or damaged, each by itself', () => {
    const papers = (papersEach: unknown) => normalizeLoad({ lines: [], papersEach })!.papersEach
    expect(papers(undefined)).toEqual({ bagged: 25, unwrapped: 50 })
    expect(papers('x')).toEqual({ bagged: 25, unwrapped: 50 })
    expect(papers({ bagged: -1, unwrapped: 'x' })).toEqual({ bagged: 25, unwrapped: 50 })
    expect(papers({ bagged: 30 })).toEqual({ bagged: 30, unwrapped: 50 })
    expect(papers({ unwrapped: 40, bagged: null })).toEqual({ bagged: 25, unwrapped: 40 })
  })

  it('keeps 0 papers in a bundle: it is a number the field can hold', () => {
    expect(normalizeLoad({ lines: [], papersEach: { bagged: 0, unwrapped: 0 } })!.papersEach).toEqual({ bagged: 0, unwrapped: 0 })
  })

  it('keeps no more lines than a list may have', () => {
    const back = normalizeLoad(list(...Array.from({ length: MAX_LOAD_LINES + 50 }, (_, i) => line(`l${i}`, 1, 'bagged'))))!
    expect(back.lines).toHaveLength(MAX_LOAD_LINES)
    expect(back.lines[0].id).toBe('l0')
  })

  it('gives a line with no id, or one taken, an id of its own', () => {
    const lines = [{ bundles: 1, kind: 'bagged' }, { id: '', bundles: 2, kind: 'bagged' }, { id: 7, bundles: 3, kind: 'bagged' }, line('a', 4, 'bagged'), line('a', 5, 'bagged')]
    const back = normalizeLoad({ lines, papersEach: {} })!
    expect(back.lines.map((l) => l.bundles)).toEqual([1, 2, 3, 4, 5])
    expect(back.lines[3].id).toBe('a')
    expect(new Set(back.lines.map((l) => l.id)).size).toBe(5)
    expect(back.lines.every((l) => typeof l.id === 'string' && l.id)).toBe(true)
  })

  it('tidies a note, keeps it short and has no key for a note with nothing in it', () => {
    const notes = (note: unknown) => normalizeLoad({ lines: [{ id: 'a', bundles: 1, kind: 'bagged', note }], papersEach: {} })!.lines[0]
    expect(notes('  1   pallet ').note).toBe('1 pallet')
    expect(notes('x'.repeat(100)).note).toHaveLength(MAX_LOAD_NOTE)
    for (const blank of ['', '   ', 5, null, undefined, {}]) expect('note' in notes(blank), String(blank)).toBe(false)
  })

  it('leaves anything else out of a line', () => {
    const back = normalizeLoad({ lines: [{ id: 'a', bundles: 1, kind: 'bagged', junk: 'x' }], papersEach: {}, junk: 'y' })!
    expect(back).toEqual({ lines: [line('a', 1, 'bagged')], papersEach: { bagged: 25, unwrapped: 50 } })
  })

  it('does not change what it is given', () => {
    const given = { lines: [{ id: 'a', bundles: 1.5, kind: 'bagged', note: ' x ' }, null], papersEach: { bagged: -1 } }
    const copy = structuredClone(given)
    normalizeLoad(given)
    expect(given).toEqual(copy)
  })
})
