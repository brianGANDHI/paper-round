import { tidyText } from './namedSections'
import { newStopId } from './routeEdit'
import type { LoadKind, LoadLine, LoadList } from './types'

export type { LoadKind, LoadLine, LoadList } from './types'

/**
 * What the driver loads before the round: how many bundles of each kind, and the papers they come to. It is kept with the route
 * (`SavedRoute.load`), shown on the start screen and changed there (LoadCard.tsx). None of this knows about the round itself.
 */

/** The biggest number a field takes, bundles or papers in a bundle. No van carries more, and it keeps the figures short enough to show. */
export const MAX_LOAD_NUMBER = 9999
/** The most lines a list keeps, so damaged data can't fill the phone. */
export const MAX_LOAD_LINES = 30
/** The longest note a line keeps. */
export const MAX_LOAD_NOTE = 40

/** The driver's own list, which every route shows until it has one of its own. Never changed: edits make a new list. */
export const DEFAULT_LOAD: LoadList = {
  lines: [
    { id: 'pallet', bundles: 102, kind: 'bagged', note: '1 pallet' },
    { id: 'bagged', bundles: 18, kind: 'bagged' },
    { id: 'unwrapped', bundles: 13, kind: 'unwrapped' },
  ],
  papersEach: { bagged: 25, unwrapped: 50 },
}

/** The list a route shows: its own, or the usual one. */
export const loadOf = (load: LoadList | undefined): LoadList => load ?? DEFAULT_LOAD

/** A whole number as the driver reads it: 2,550. Always with a comma, whatever the phone's language, as on their own list. */
const figure = (n: number): string => n.toLocaleString('en-AU')

/** How many papers a line comes to. */
export const linePapers = (line: Pick<LoadLine, 'bundles' | 'kind'>, list: Pick<LoadList, 'papersEach'>): number => line.bundles * list.papersEach[line.kind]

/** A line's papers as shown beside it in the editor: "2,550 papers". */
export const linePapersText = (line: Pick<LoadLine, 'bundles' | 'kind'>, list: Pick<LoadList, 'papersEach'>): string => {
  const papers = linePapers(line, list)
  return `${figure(papers)} ${papers === 1 ? 'paper' : 'papers'}`
}

export interface LoadTotals {
  /** Bundles of each kind. */
  bagged: number
  unwrapped: number
  /** Bundles of both kinds. */
  bundles: number
  papers: number
}

/** What a list adds up to. */
export function loadTotals(list: LoadList): LoadTotals {
  const totals: LoadTotals = { bagged: 0, unwrapped: 0, bundles: 0, papers: 0 }
  for (const line of list.lines) {
    totals[line.kind] += line.bundles
    totals.bundles += line.bundles
    totals.papers += linePapers(line, list)
  }
  return totals
}

/** A row of the list as it is shown. */
export interface LoadRow {
  /** Stays the same from one showing to the next. */
  id: string
  /** The bundles, as "102 bagged · 1 pallet" or "+ 18 bagged", or the bagged bundles added up, as "= 120 bagged". */
  text: string
  /** The papers it comes to, as "2,550". A row that adds up has none, as the whole gives them. */
  papers?: string
  /** True for the row that adds up the bagged bundles. */
  subtotal?: boolean
}

/**
 * The list as the driver writes it down: the bagged lines, what they add up to when there are two or more, then the unwrapped lines.
 * Each line after the very first has a plus. They stay in their kinds whatever order the lines were put in, so the sum reads down.
 */
export function loadRows(list: LoadList): LoadRow[] {
  const ofKind = (kind: LoadKind) => list.lines.filter((l) => l.kind === kind)
  const bagged = ofKind('bagged')
  const unwrapped = ofKind('unwrapped')
  const row = (line: LoadLine, first: boolean): LoadRow => ({
    id: line.id,
    text: `${first ? '' : '+ '}${figure(line.bundles)} ${line.kind}${line.note ? ` · ${line.note}` : ''}`,
    papers: figure(linePapers(line, list)),
  })
  const rows = bagged.map((l, i) => row(l, i === 0))
  if (bagged.length > 1) rows.push({ id: '=', text: `= ${figure(loadTotals(list).bagged)} bagged`, subtotal: true })
  rows.push(...unwrapped.map((l, i) => row(l, i === 0 && !bagged.length)))
  return rows
}

/** The whole of it, under the rows: "133 bundles · 3,650 papers all up". */
export function loadWhole(list: LoadList): string {
  const { bundles, papers } = loadTotals(list)
  return `${figure(bundles)} ${bundles === 1 ? 'bundle' : 'bundles'} · ${figure(papers)} ${papers === 1 ? 'paper' : 'papers'} all up`
}

/**
 * What a number field holds as a number: a whole number from 0 up to `MAX_LOAD_NUMBER`. A blank field is 0, so the sums carry on while the
 * old figure is rubbed out, and so is one with no number in it. A comma or a space is passed over and a point ends the number, but this
 * reads only what the field lets in, which is four characters: a 1,250 pasted into one reaches here as 1,25.
 */
export function parseLoadNumber(text: string): number {
  const digits = /^\d+/.exec(text.replace(/[,\s]/g, ''))
  return digits ? Math.min(Number(digits[0]), MAX_LOAD_NUMBER) : 0
}

/** What a number field shows: 0 is left blank, to show the field's own grey 0, so the next digit typed is not put after a 0. */
export const loadNumberText = (n: number): string => (n ? String(n) : '')

/** The list with a line changed. A note is kept as it is typed here (see `normalizeLoad`). */
export const changeLine = (list: LoadList, id: string, change: Partial<Omit<LoadLine, 'id'>>): LoadList => ({
  ...list,
  lines: list.lines.map((l) => (l.id === id ? { ...l, ...change } : l)),
})

/** The list without a line. */
export const removeLine = (list: LoadList, id: string): LoadList => ({ ...list, lines: list.lines.filter((l) => l.id !== id) })

/** The list with a new line at the end, of the same kind as the one before it since lines of a kind tend to go together. Full, it is as it was. */
export function addLine(list: LoadList): LoadList {
  if (list.lines.length >= MAX_LOAD_LINES) return list
  return { ...list, lines: [...list.lines, { id: newStopId(), bundles: 0, kind: list.lines.at(-1)?.kind ?? 'bagged' }] }
}

/** The list with a new number of papers in a bundle of a kind. */
export const changePapersEach = (list: LoadList, kind: LoadKind, papers: number): LoadList => ({ ...list, papersEach: { ...list.papersEach, [kind]: papers } })

/** A number read back from storage or a backup: whole, and no bigger than a field takes. Null when it is not a number of anything. */
const wholeNumber = (raw: unknown): number | null => (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.min(Math.trunc(raw), MAX_LOAD_NUMBER) : null)

const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null

/** A line read back, or null when it can't be told how many or what kind. An id that is missing or taken gets a new one. */
function normalizeLine(raw: unknown, taken: Set<string>): LoadLine | null {
  if (!isRecord(raw)) return null
  const bundles = wholeNumber(raw.bundles)
  const { kind, note } = raw
  if (bundles === null || (kind !== 'bagged' && kind !== 'unwrapped')) return null
  const id = typeof raw.id === 'string' && raw.id && !taken.has(raw.id) ? raw.id : newStopId()
  taken.add(id)
  const said = typeof note === 'string' ? tidyText(note, MAX_LOAD_NOTE) : ''
  return { id, bundles, kind, ...(said ? { note: said } : {}) }
}

/**
 * A list as it is kept: made safe to use when it is read back from storage or a backup, and tidied when it is saved, which is the only
 * place a note is tidied as a space at the end of a word has to last while the rest of it is typed. A line that is damaged is left out
 * and the rest are kept, and a number of papers in a bundle that is damaged is the usual one. Undefined when there is nothing usable,
 * which makes the route show the usual list: anything that is not a list, or one that had lines of which none could be read. A list with
 * no lines to begin with is the driver's: the route loads nothing.
 */
export function normalizeLoad(raw: unknown): LoadList | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.lines)) return undefined
  const taken = new Set<string>()
  const lines: LoadLine[] = []
  for (const item of raw.lines) {
    if (lines.length >= MAX_LOAD_LINES) break
    const line = normalizeLine(item, taken)
    if (line) lines.push(line)
  }
  if (raw.lines.length && !lines.length) return undefined
  const papers = isRecord(raw.papersEach) ? raw.papersEach : {}
  return {
    lines,
    papersEach: {
      bagged: wholeNumber(papers.bagged) ?? DEFAULT_LOAD.papersEach.bagged,
      unwrapped: wholeNumber(papers.unwrapped) ?? DEFAULT_LOAD.papersEach.unwrapped,
    },
  }
}
