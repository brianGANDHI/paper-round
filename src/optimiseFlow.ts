import { SIDE_SHORT } from './colors'
import { STALE_REASON } from './optimise/accept'
import type { OptimiseFailure } from './optimise/protocol'
import { COVER_GATE_M, defaultChoices, hasBundleOrder } from './optimise/run'
import type { BundleName, Gap, OptimiseChoices, OptimiseResult, PreparedView, ProgressInfo, RouteStats, StartPoint, StreetChoice, TurnBack, UnmatchedPart, WorthChecking } from './optimise/types'
import { formatDistance } from './routeEdit'
import type { Side } from './types'

/*
 * What the Optimise Route sheet does and says, kept apart from the sheet so it can be tested: the steps it goes through, in one pure function
 * that says what each thing that happens does to them, and the words and figures each step shows. The sheet itself only draws these and
 * talks to the worker. Nothing here touches the saved route, so however a run ends short of Accept, the route is as it was.
 */

/** What can be done after a step failed: fetch the map again, go back to the choices, or nothing but close. */
export type Recovery = 'try-again' | 'start-again' | 'choices' | 'none'

/** The results of a run, on the screen. */
export interface ResultsState {
  step: 'results'
  view: PreparedView
  choices: OptimiseChoices
  result: OptimiseResult
  /** The sections that can't go on the new route, by name. Null until they have been worked out, which is left until the results are up. */
  unplaced: string[] | null
  /** Accept has been tapped and is being done. */
  accepting: boolean
  /** Why Accept said no, which it can when the route changed just before the tap. */
  refused: string | null
  /** The whole of the Worth Checking list is showing, not only the longest few of each kind. */
  allChecks: boolean
}

/** The choices, on the screen. */
export interface ChoicesState {
  step: 'choices'
  view: PreparedView
  choices: OptimiseChoices
  /** Every street is listed, not only the main roads and those kept in view. */
  allStreets: boolean
  /**
   * The other streets that were off as the step came up, by key, which stay listed while the rest are folded away, so a street turned off is never out
   * of sight. It is fixed for the step, so a street switched back on doesn't vanish from under the finger.
   */
  pinned: readonly string[]
}

export type OptimiseState =
  | { step: 'intro' }
  | { step: 'fetching'; progress: ProgressInfo | null }
  | ChoicesState
  | { step: 'solving'; view: PreparedView; choices: OptimiseChoices; progress: ProgressInfo | null }
  | ResultsState
  | { step: 'accepted'; kept: string; unplaced: string[] }
  | { step: 'failed'; message: string; recovery: Exclude<Recovery, 'choices'> }
  /** A run that failed keeps the choices it was given, so they are there to go back to. */
  | { step: 'failed'; message: string; recovery: 'choices'; view: PreparedView; choices: OptimiseChoices }

export type OptimiseEvent =
  /** Start, or Try Again: the map is being fetched. */
  | { type: 'start' }
  | { type: 'progress'; progress: ProgressInfo }
  | { type: 'prepared'; view: PreparedView }
  | { type: 'failed'; kind: OptimiseFailure; message: string }
  /** Cancel, while something is running. */
  | { type: 'cancel' }
  | { type: 'keep-order'; on: boolean }
  | { type: 'street'; key: string; on: boolean }
  | { type: 'show-all-streets' }
  | { type: 'run' }
  | { type: 'solved'; result: OptimiseResult }
  | { type: 'placed'; unplaced: string[] }
  /** Change Choices, or Back to Choices. */
  | { type: 'back' }
  | { type: 'show-all-checks' }
  | { type: 'accept' }
  | { type: 'accepted'; kept: string; unplaced: string[] }
  | { type: 'refused'; reason: string }

export const FIRST_STEP: OptimiseState = { step: 'intro' }

/**
 * After a failed fetch: a Try Again helps when the network or the server was the trouble, and when the worker broke, as Try Again starts a new one
 * from nothing. Told to start again, it starts again. A map with no roads, or a route that can't be worked on, would only come out the same.
 */
function afterFetch(kind: OptimiseFailure): Exclude<Recovery, 'choices'> {
  if (kind === 'offline' || kind === 'busy' || kind === 'crashed') return 'try-again'
  return kind === 'not-ready' ? 'start-again' : 'none'
}

// Whether the choices offer Keep my bundle order goes by the same rule as the choices a run starts from, so it is the engine's.
export { hasBundleOrder }

/** The choices step as it comes up, with the other streets folded away but for those that are off. */
function choosing(view: PreparedView, choices: OptimiseChoices): ChoicesState {
  const pinned = view.streets.filter((s) => !s.main && !streetOn(choices, s)).map((s) => s.key)
  return { step: 'choices', view, choices, allStreets: false, pinned }
}

/**
 * The next state, given what has happened. Each thing counts only at the step it belongs to, and anything else leaves the state as it was: the worker
 * can have a last word on its way out, a step can be cancelled just as it finishes, and a second tap can land on a button that has gone.
 */
export function advance(state: OptimiseState, event: OptimiseEvent): OptimiseState {
  switch (event.type) {
    case 'start':
      if (state.step === 'intro' || (state.step === 'failed' && (state.recovery === 'try-again' || state.recovery === 'start-again'))) return { step: 'fetching', progress: null }
      return state
    case 'progress':
      return state.step === 'fetching' || state.step === 'solving' ? { ...state, progress: event.progress } : state
    case 'prepared':
      return state.step === 'fetching' ? choosing(event.view, defaultChoices(event.view)) : state
    case 'failed':
      // A step that was told to stop has stopped: that is no failure, and the state has already moved on.
      if (event.kind === 'cancelled') return state
      if (state.step === 'fetching') return { step: 'failed', message: event.message, recovery: afterFetch(event.kind) }
      if (state.step !== 'solving') return state
      if (event.kind === 'not-ready') return { step: 'failed', message: event.message, recovery: 'start-again' }
      return { step: 'failed', message: event.message, recovery: 'choices', view: state.view, choices: state.choices }
    case 'cancel':
      if (state.step === 'fetching') return FIRST_STEP
      return state.step === 'solving' ? choosing(state.view, state.choices) : state
    case 'keep-order':
      return state.step === 'choices' ? { ...state, choices: { ...state.choices, keepOrder: event.on } } : state
    case 'street':
      return state.step === 'choices' ? { ...state, choices: { ...state.choices, allowed: { ...state.choices.allowed, [event.key]: event.on } } } : state
    case 'show-all-streets':
      return state.step === 'choices' ? { ...state, allStreets: true } : state
    case 'run':
      return state.step === 'choices' ? { step: 'solving', view: state.view, choices: state.choices, progress: null } : state
    case 'solved':
      return state.step === 'solving' ? { step: 'results', view: state.view, choices: state.choices, result: event.result, unplaced: null, accepting: false, refused: null, allChecks: false } : state
    case 'placed':
      return state.step === 'results' ? { ...state, unplaced: event.unplaced } : state
    case 'back':
      if ((state.step === 'results' && !state.accepting) || (state.step === 'failed' && state.recovery === 'choices')) return choosing(state.view, state.choices)
      return state
    case 'show-all-checks':
      return state.step === 'results' ? { ...state, allChecks: true } : state
    case 'accept':
      return state.step === 'results' && !state.accepting && state.unplaced && !state.result.blocked.length ? { ...state, accepting: true, refused: null } : state
    case 'accepted':
      return state.step === 'results' && state.accepting ? { step: 'accepted', kept: event.kept, unplaced: event.unplaced } : state
    case 'refused':
      return state.step === 'results' && state.accepting ? { ...state, accepting: false, refused: event.reason } : state
  }
}

/** Whether the sheet can be closed: not while Accept is being written. */
export const canClose = (state: OptimiseState): boolean => !(state.step === 'results' && state.accepting)

/**
 * Whether a tap beside the sheet, or Escape, closes it, as they do other sheets. Not where it would throw away a run, or what was chosen for one: a
 * run that failed keeps its choices to go back to. Close in the sheet's head is for leaving on purpose, and it works at every step.
 */
export const closesOnTapBeside = (state: OptimiseState): boolean =>
  state.step === 'intro' || state.step === 'accepted' || (state.step === 'failed' && state.recovery !== 'choices')

/** How long after a step comes up a tap on its foot is taken for the second half of a double tap made on the step before, in ms. */
export const TAP_THROUGH_MS = 350

/**
 * Whether a tap on the foot came too soon after its step came up to be meant for it. The foot's buttons sit in the same place from one step to the
 * next, so the second tap of a double tap would land on a button the driver hasn't seen yet: Cancel just after Start, or Find My Route just after Cancel.
 */
export const tooSoon = (sinceStepMs: number): boolean => sinceStepMs < TAP_THROUGH_MS

/** Whether Accept can be tapped, and if not, why not, in plain words. */
export function acceptGate(state: ResultsState, stale: boolean): { ready: boolean; why: string[] } {
  const why = [...new Set([...(state.refused ? [state.refused] : []), ...(stale ? [STALE_REASON] : []), ...state.result.blocked])]
  return { ready: !why.length && !!state.unplaced && !state.accepting, why }
}

/** A length with its unit, to the tenth of a km: the search moves the figures by more than that from one run to the next. */
export const km = (n: number): string => `${n.toFixed(1)} km`

/** The heading over a step that is running. */
export const WORKING_TITLE = { fetching: 'Getting the map', solving: 'Finding your route' } as const
export const WORKING_HINT = { fetching: 'This can take a minute or two when the map service is busy.', solving: 'This takes about 20 seconds.' } as const

/** What a running step is waiting on, for when the worker's word for it only says the title again. */
const WORKING_WAIT = { fetching: 'Asking the map service', solving: '' } as const

/** The line under a running step's title: what the worker says it is doing, but never the title over again. */
export function workingLine(which: keyof typeof WORKING_TITLE, progress: ProgressInfo | null): string {
  if (!progress) return 'Starting'
  return progress.step.toLowerCase() === WORKING_TITLE[which].toLowerCase() ? WORKING_WAIT[which] : progress.step
}

export interface StartLine {
  title: string
  note: string
}

/** Where the route starts and ends, saying which of the two it is. */
export const startLine = (start: StartPoint): StartLine =>
  start.section !== null
    ? { title: start.section, note: 'The new route starts and ends at this section.' }
    : { title: "The route's first point", note: 'No section is called Start, so the new route starts and ends here.' }

export const keepOrderNote = (on: boolean): string => (on ? 'Your bundles stay in your order.' : 'Gets the shortest route. Your bundle list then follows the new drive.')

/** A length in metres under a km and in km from there, so that a short street or new road doesn't read as "0.0 km", which looks like nothing at all. */
export const length = (kmLong: number): string => formatDistance(kmLong * 1000)

/** What a street's row says under its name. */
export const streetNote = (street: Pick<StreetChoice, 'km' | 'main'>): string => (street.main ? `Main road · ${length(street.km)}` : length(street.km))

/** Whether a street is switched on: a street the choices don't mention has its default, as the engine reads it. */
export const streetOn = (choices: OptimiseChoices, street: Pick<StreetChoice, 'key' | 'allowed'>): boolean => choices.allowed[street.key] ?? street.allowed

/** The parts of today's route thrown at that aren't on the map and will keep Accept off, said before the run, as they will whatever it finds. One line for each street. */
export const unmatchedLines = (parts: readonly UnmatchedPart[]): string[] => [
  ...new Set(parts.filter((p) => p.thrown && p.m >= COVER_GATE_M).map((p) => `Part of today's route near ${p.street} isn't on any road on the map, so Accept will stay off.`)),
]

/** Fewer streets than this to fold away are all listed: a line to say they are on would save next to nothing. */
const FOLD_STREETS = 9

export interface StreetGroup {
  label: string
  streets: StreetChoice[]
  /** How many more streets of the group are on and not listed, until Show All. */
  moreOn: number
}

/**
 * The streets as the choices screen groups them: the main roads, then the rest. A round can have well over a hundred other streets, all on, so
 * until Show All they are a count, but for any in `pinned` (see `ChoicesState`) and any that are off, which are listed so a street that is off can
 * always be seen, and every street in the count is on.
 */
export function streetGroups(streets: readonly StreetChoice[], shown: Pick<ChoicesState, 'allStreets' | 'pinned' | 'choices'>): StreetGroup[] {
  const others = streets.filter((s) => !s.main)
  const kept = others.filter((s) => shown.pinned.includes(s.key) || !streetOn(shown.choices, s))
  const folded = !shown.allStreets && others.length - kept.length >= FOLD_STREETS
  const listed = folded ? kept : others
  const groups = [
    { label: 'Main roads', streets: streets.filter((s) => s.main), moreOn: 0 },
    { label: 'Other streets', streets: listed, moreOn: others.length - listed.length },
  ]
  return groups.filter((g) => g.streets.length || g.moreOn)
}

/** The row that stands in for the streets folded away. */
export const moreOnText = (count: number): string => (count === 1 ? '1 other street is on' : `${count} other streets are on`)

export interface StatRow {
  label: string
  /** The side the row is the km of, for its colour on the map. */
  side?: Side
  before: string
  after: string
}

/**
 * Today and the new route, side by side. The totals are of the route driven back to its start, so a route that ends elsewhere is fairly compared,
 * and so is transit: the new route's own transit takes in its way back, so today's takes in the way back too.
 */
export function statRows(before: RouteStats, after: RouteStats): StatRow[] {
  const sideRow = (side: Side, read: (s: RouteStats) => number): StatRow => ({ label: SIDE_SHORT[side], side, before: km(read(before)), after: km(read(after)) })
  return [
    { label: 'Total', before: km(before.closedKm), after: km(after.closedKm) },
    sideRow('left', (s) => s.left),
    sideRow('right', (s) => s.right),
    sideRow('both', (s) => s.both),
    sideRow('transit', (s) => s.transit + s.closingKm),
    { label: 'Thrown twice', before: km(before.twiceKm), after: km(after.twiceKm) },
    { label: 'U-turns', before: String(before.uturns), after: String(after.uturns) },
    { label: 'Side changes', before: String(before.sideChanges), after: String(after.sideChanges) },
  ]
}

/** How much shorter the new route is, in km, to the tenth the screen shows: lengths that read the same are the same to the driver. */
const savedKm = (before: RouteStats, after: RouteStats): number => Number((before.closedKm - after.closedKm).toFixed(1))

/** The line over the figures. A route kept to the bundle order that comes out longer says it is that, so the switch can be seen as the way out. */
export function savingText(before: RouteStats, after: RouteStats, keepOrder: boolean): string {
  const saved = savedKm(before, after)
  if (saved > 0) return `${km(saved)} shorter than today`
  if (saved === 0) return 'About the same length as today'
  return keepOrder ? `${km(-saved)} longer than today, keeping your bundle order` : `${km(-saved)} longer than today`
}

/** Whether the notes of a run go up under the line over the figures: a route kept to the bundle order that comes out longer, where they say why and what to do. */
export const notesFirst = ({ before, after, keepOrder }: Pick<OptimiseResult, 'before' | 'after' | 'keepOrder'>): boolean => keepOrder && savedKm(before, after) < 0

/** A difference less than this, in km, is none as far as any figure on the screen can tell. */
const CLOSES_KM = 0.05

/**
 * Why today's column doesn't add up as the driver might expect, in one note: its total and transit take in the way back to the start where the route
 * doesn't close, and its total is measured along the roads, where its sides and transit are measured along the line as drawn.
 */
export function closingNote(before: RouteStats): string | null {
  const notes: string[] = []
  if (before.closingKm >= CLOSES_KM) notes.push(`Today's total and transit include ${km(before.closingKm)} back to the start.`)
  const drawn = before.km - before.mapKm
  if (Math.abs(drawn) >= CLOSES_KM) {
    notes.push(`Today's total is measured along the roads, and its sides and transit along your line as drawn, which comes to about ${km(Math.abs(drawn))} ${drawn < 0 ? 'less' : 'more'}.`)
  }
  return notes.length ? notes.join(' ') : null
}

const TURN_PLACE: Record<TurnBack['level'], string> = { main: 'On a main road', busy: 'On a busy road', plain: 'On a quiet street' }
const TURN_ORDER: TurnBack['level'][] = ['main', 'busy', 'plain']

export interface TurnBackRow {
  street: string
  note: string
}

/** Where the new route turns back with no dead end to make it: the most awkward first, and of those, the ones the driver doesn't do today. */
export function turnBackRows(turns: readonly TurnBack[]): TurnBackRow[] {
  const rank = (t: TurnBack) => TURN_ORDER.indexOf(t.level) * 2 + (t.alsoToday ? 1 : 0)
  return [...turns].sort((a, b) => rank(a) - rank(b)).map((t) => ({ street: t.street, note: t.alsoToday ? `${TURN_PLACE[t.level]}, as you do today` : TURN_PLACE[t.level] }))
}

/** What becomes of the driver's bundle list: a line about it, and the list itself when it has changed. */
export function bundleSummary({ bundles, keepOrder }: Pick<OptimiseResult, 'bundles' | 'keepOrder'>): { note: string; order: BundleName[] } | null {
  // No list, nothing to say. A list that doesn't fit is told as the reason Accept is blocked.
  if (!bundles.before.length || (keepOrder && !bundles.fits)) return null
  if (bundles.changed) return { note: 'Your bundle list will follow the new drive.', order: bundles.after }
  return { note: 'Your bundle order stays as it is.', order: [] }
}

/** Less than this in all, in km, reads as none on the screen. */
const GAP_MIN_KM = 0.05

/** All the stretches the new route doesn't throw at, in a line. They are measured coarsely, so it is only ever "about". */
export function gapNote(gaps: readonly Pick<Gap, 'm' | 'atHead'>[], gapKm: number): string | null {
  if (gapKm < GAP_MIN_KM) return null
  const atHeads = gaps.reduce((sum, g) => sum + (g.atHead ? g.m : 0), 0)
  const where = atHeads * 2 > gaps.reduce((sum, g) => sum + g.m, 0) ? ', mostly at the ends of courts where it turns on a point' : ''
  return `About ${km(gapKm)} thrown at today isn't thrown at on the new route${where}.`
}

/** How much of the Worth Checking list shows at first: it can run to dozens of lines. */
export const SHOWN_CHECKS = 8

/**
 * The Worth Checking list, the stretches the new route stops throwing at first, each kind longest first. Until Show All it is the longest few of each
 * kind, half and half, the one filling in where the other runs short: the one-sided stretches are the same whatever the run, and are all longer than
 * any stretch the new route leaves, so longest first alone would show only those.
 */
export function shownChecks(checks: readonly WorthChecking[], all: boolean): readonly WorthChecking[] {
  const gaps = checks.filter((c) => c.kind === 'gap')
  const oneSided = checks.filter((c) => c.kind !== 'gap')
  if (all) return [...gaps, ...oneSided]
  const half = SHOWN_CHECKS / 2
  const gapCount = Math.min(gaps.length, Math.max(half, SHOWN_CHECKS - oneSided.length))
  return [...gaps.slice(0, gapCount), ...oneSided.slice(0, SHOWN_CHECKS - gapCount)]
}

/** How the driver is told, afterwards, where the old route went. */
export const keptText = (kept: string): string => `Your old route is kept as “${kept}” in the Routes list. Tap it there to go back to it.`

/**
 * What becomes of the named sections Accept can't place, before Accept and after it. The Round screen goes by the sections of the route in use, so on
 * the new route there is no banner where one starts or ends, and it isn't there to start a round from: only the copy of the old route has them.
 */
export const unplacedNote = (accepted: boolean): string =>
  `${accepted ? 'They are' : 'They stay'} on the old route only. The new route won't show their banners or offer them as a place to start.`
