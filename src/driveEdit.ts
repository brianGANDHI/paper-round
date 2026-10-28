import { alertable } from './alerts'
import { plural } from './format'
import { occurrences } from './geo'
import { formatDistance, PAINT_MIN_M, sections } from './routeEdit'
import type { Turn } from './turns'
import type { Route, Side } from './types'

/**
 * Changing the side that is thrown while driving. The driver is on a stretch of road with one side, and means to
 * change only the part they are driving, not the whole stretch. These are the parts they can pick from, and what
 * to tell them about the change before it is made.
 */

/** How far a change of side can reach: the street, up to the turn, a named section, up to the end of the stretch, or all of it. */
export type ExtentKey = 'street' | 'toTurn' | 'section' | 'toStretchEnd' | 'stretch'

/** One thing the driver can pick: the metres along the route it covers, and how to put it to them. */
export interface SideExtent {
  key: ExtentKey
  fromM: number
  toM: number
  /** What it is called in a list. */
  label: string
  /** How long it is, and for the whole stretch that it is all of it. */
  detail: string
}

/** Stretches shorter than this, in metres, are not offered: they are not worth the choice, and cannot be painted. */
export const EXTENT_MIN_M = PAINT_MIN_M
/** A stretch whose two ends are both this close, in metres, to those of one offered before it is the same choice, and is left out. */
export const EXTENT_MERGE_M = 25
/** Two distances this close, in metres, are the same place: a float of difference between two sums of the same road. */
const SAME_M = 0.01

/** How a side reads in "the entire ... stretch". */
const SIDE_WORD: Record<Side, string> = { both: 'both-sides', left: 'left', right: 'right', transit: 'transit' }

/** A named part of the route, as the driver is told of it: where it starts and ends along the route. The lead-in before the first name is not one the driver gave a name to. */
export interface NamedSpan {
  name: string
  startM: number
  endM: number
  lead?: boolean
}

/**
 * What the driver can change the side of, at `along` metres along the route. `stretch` is the stretch of one
 * side that they are on (null when the route has none, or has no length, or `along` is not a distance), and the
 * choices are all inside it, in this order: the street (from the last turn to the next), the way to the next turn
 * (when there is one in the stretch), the named section they are in, the way to the end of the stretch, and the
 * whole stretch. A turn right where the driver is counts as behind them. The ones shorter than `EXTENT_MIN_M` are
 * left out, and so is any that is the same as one before it, going by `EXTENT_MERGE_M` at both ends. A street or a
 * named section that fills the stretch (within `EXTENT_MERGE_M` of both ends of it) is left out too, since that is
 * the whole stretch and nothing else is called by that name: there is no turn to speak of when the street is the
 * stretch, and the whole stretch is only ever changed by choosing "The whole stretch". Every one can be painted
 * with `paintMetres` as it stands.
 */
export function sideExtents(
  route: Route,
  turns: readonly Pick<Turn, 'at'>[],
  named: readonly NamedSpan[],
  along: number,
): { stretch: { startM: number; endM: number; side: Side } | null; extents: SideExtent[] } {
  const stretches = sections(route)
  if (!stretches.length || !Number.isFinite(along)) return { stretch: null, extents: [] }
  const routeEnd = stretches[stretches.length - 1].endM
  // A point that is not a place leaves the route with no length, and nothing on it can be painted.
  if (!Number.isFinite(routeEnd)) return { stretch: null, extents: [] }
  // The start of a stretch belongs to it and the end to the next, except the last, which has the end of the route too.
  const { startM, endM, side } = stretches.find((s) => along < s.endM) ?? stretches[stretches.length - 1]
  const here = Math.min(Math.max(along, startM), endM)

  // A turn that is not a distance is neither behind nor ahead, since nothing compares with it.
  const at = turns.map((t) => t.at)
  const last = at.reduce((far, x) => (x <= here && x > far ? x : far), startM)
  const next = at.reduce((soon, x) => (x > here && x < soon ? x : soon), Infinity)
  const turnAhead = next < endM

  // A section that reaches the end of the route has the end of it too.
  const section = named.find(
    (n) => !n.lead && Number.isFinite(n.startM) && Number.isFinite(n.endM) && n.startM <= here && (here < n.endM || n.endM >= routeEnd - SAME_M),
  )

  const length = (fromM: number, toM: number) => formatDistance(toM - fromM)
  // What reaches both ends of the stretch is all of it, so the street or the section that does is the whole stretch, which has its own place below.
  const fills = (fromM: number, toM: number) => Math.abs(fromM - startM) <= EXTENT_MERGE_M && Math.abs(toM - endM) <= EXTENT_MERGE_M
  const candidates: SideExtent[] = []
  const streetEnd = turnAhead ? next : endM
  if (!fills(last, streetEnd)) {
    // Worded by what it reaches: a turn each end, or the end of the stretch where there is no turn behind the driver or ahead of them.
    const label = `${last > startM ? 'From the last turn' : 'From the start of this stretch'} to ${turnAhead ? 'the next turn' : 'the end of this stretch'}`
    candidates.push({ key: 'street', fromM: last, toM: streetEnd, label, detail: length(last, streetEnd) })
  }
  if (turnAhead) candidates.push({ key: 'toTurn', fromM: here, toM: next, label: 'To the next turn', detail: length(here, next) })
  if (section) {
    const fromM = Math.max(startM, section.startM)
    const toM = Math.min(endM, section.endM)
    const cut = section.startM < startM - SAME_M || section.endM > endM + SAME_M
    if (!fills(fromM, toM)) {
      candidates.push({
        key: 'section',
        fromM,
        toM,
        label: `This named section: ${section.name}`,
        detail: `${length(fromM, toM)}${cut ? ', just the part of it in this stretch' : ''}`,
      })
    }
  }
  candidates.push(
    { key: 'toStretchEnd', fromM: here, toM: endM, label: 'To the end of this stretch', detail: length(here, endM) },
    { key: 'stretch', fromM: startM, toM: endM, label: 'The whole stretch', detail: `${length(startM, endM)}, the entire ${SIDE_WORD[side]} stretch` },
  )

  const extents: SideExtent[] = []
  for (const c of candidates) {
    // Written so that a length that is not a number is left out too.
    if (!(c.toM - c.fromM >= EXTENT_MIN_M)) continue
    if (extents.some((e) => Math.abs(e.fromM - c.fromM) <= EXTENT_MERGE_M && Math.abs(e.toM - c.toM) <= EXTENT_MERGE_M)) continue
    extents.push(c)
  }
  return { stretch: { startM, endM, side }, extents }
}

/** How many times each no-throw house alerts: once for every pass of it that is not quiet. A house that never alerts has no entry. */
function alertsByHouse(route: Route): Map<string, number> {
  const counts = new Map<string, number>()
  for (const o of alertable(route, occurrences(route))) {
    if (o.stop.type === 'nothrow') counts.set(o.stop.id, (counts.get(o.stop.id) ?? 0) + 1)
  }
  return counts
}

/** What a change of side does to the no-throw houses, in words, and whether any of it is houses going quiet. */
function sideChangeWords(before: Route, after: Route): { note: string; quiets: boolean } | null {
  const noun = (n: number) => plural(n, 'no-throw house', 'no-throw houses')
  const was = alertsByHouse(before)
  const now = alertsByHouse(after)
  // The houses that alerted somewhere and now never do, and the houses that now alert and never did.
  let quieter = 0
  let louder = 0
  // The houses that keep some of their alerts but lose or gain others. One that loses all of them, or had none, is counted above.
  const fewer: number[] = []
  const more: number[] = []
  for (const [id, b] of was) {
    const a = now.get(id) ?? 0
    if (a === 0) quieter++
    else if (a < b) fewer.push(b - a)
    else if (a > b) more.push(a - b)
  }
  for (const id of now.keys()) if (!was.has(id)) louder++

  const notes: string[] = []
  if (quieter) notes.push(`${noun(quieter)} will now stay quiet`)
  if (louder) notes.push(`${noun(louder)} will now alert`)
  if (fewer.length) notes.push(`${noun(fewer.length)} will now stay quiet on ${fewer.every((n) => n === 1) ? 'one pass' : 'some passes'}`)
  if (more.length) notes.push(`${noun(more.length)} will now alert on ${more.every((n) => n === 1) ? 'one more pass' : 'some more passes'}`)
  return notes.length ? { note: notes.join('; '), quiets: quieter > 0 || fewer.length > 0 } : null
}

/**
 * What a change of side does to the no-throw houses, for telling the driver: how many will now stay quiet (a no-throw
 * house means nothing where nothing is thrown, nor on the side of the road that is not thrown), and how many will alert
 * again, going from `before` to `after`. One change can do both: a stretch changed from Left to Right quiets the houses on
 * its left and wakes the ones on its right, and those are counted apart, each house on its own, not as a net number. A
 * house on a street that is driven more than once can lose or gain an alert on one pass and still have the others, and
 * those are counted apart too, as houses that stay quiet or alert on a pass. Null when it makes no difference.
 */
export const sideChangeNote = (before: Route, after: Route): string | null => sideChangeWords(before, after)?.note ?? null

/** Said after houses go quiet, for a driver who has not met the rule. */
const QUIET_REASON = 'A no-throw house only alerts on a side you throw.'

/**
 * `sideChangeNote` as sentences for a notice: with its full stop, and when houses go quiet the reason (they are on the side that
 * is not thrown, or on transit). Empty when the change makes no difference to the houses.
 */
export function sideChangeSentence(before: Route, after: Route): string {
  const words = sideChangeWords(before, after)
  return words ? `${words.note}.${words.quiets ? ` ${QUIET_REASON}` : ''}` : ''
}
