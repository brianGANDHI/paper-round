import { plural } from './format'
import { bearing, byPosition, haversine, occurrences, sideAt, stopSide, type Occurrence } from './geo'
import { houseNumber, MAX_STOP_OFFSET_M, withoutNumber } from './routeEdit'
import type { Pt, Route, Stop } from './types'

/** How near a stop you have to be, in metres, for its alert to come up. The driver picks one of these. */
export const ALERT_DISTANCES = [10, 20, 30, 40, 50, 60] as const

export type AlertDistance = (typeof ALERT_DISTANCES)[number]

export const DEFAULT_ALERT_DISTANCE: AlertDistance = 40

export const isAlertDistance = (v: unknown): v is AlertDistance => ALERT_DISTANCES.some((d) => d === v)

/**
 * The zone around a stop in which its banner shows: from this far before it until this far past it,
 * for either kind of stop.
 */
export const alertRadius = (distance: AlertDistance): Record<Stop['type'], number> => ({ nothrow: distance, bundle: distance, request: distance })

/** Backing away only ends a banner this far outside the zone, so GPS jitter at its edge can't set it off again and again. */
export const BACK_OFF_SLACK_M = 15

/** Which way a stop's zone was left: on past the stop, or back the way the driver came. */
export type ZoneExit = 'passed' | 'back'

/**
 * Whether the driver has left a stop's zone, and which way. Null while still inside it.
 * `driverAt` is how far along the route the driver is, in metres.
 *
 * A stop that is off the route has no way along the route to be passed or backed away from. Its zone is the
 * ground around it, and it counts as done once the driver, at `pos`, has been in it and is out of it again.
 */
export function zoneExit(o: Occurrence, driverAt: number, radius: Record<Stop['type'], number>, pos?: Pt): ZoneExit | null {
  const r = radius[o.stop.type]
  if (byPosition(o, radius)) return pos && haversine(pos, o.stop) > r + BACK_OFF_SLACK_M ? 'passed' : null
  const ahead = o.at - driverAt
  if (ahead < -r) return 'passed'
  if (ahead > r + BACK_OFF_SLACK_M) return 'back'
  return null
}

/** How far away a stop is, for the banner: "40 m", "Now" when it is right here, "Passed" once it is behind. */
export function aheadText(ahead: number): string {
  if (ahead <= -10) return 'Passed'
  if (ahead < 15) return 'Now'
  return `${Math.round(ahead / 10) * 10} m`
}

/**
 * What the banner for a stop says: the kind of stop, its name (what it was called, or else its address, or else a
 * line that says what to do), the address to show under a name when it has both, the house number to look for, and
 * for a bundle drop with an amount how many papers. Papers and number are null when there is none. The number is
 * taken off the front of the name and address, as it is shown on its own.
 *
 * A special request is told by its note, which is what has to be done there, so the note is the line and has the
 * room. The address goes under it only when there is no house number to show on the plate instead.
 */
export function alertText(stop: Stop): { title: string; name: string; address: string | null; papers: string | null; number: string | null } {
  const noThrow = stop.type === 'nothrow'
  const number = houseNumber(stop)
  if (stop.type === 'request') {
    return {
      title: 'Special Request',
      name: stop.note ?? withoutNumber(stop.address ?? 'Special request ahead.', number),
      address: stop.note && !number ? (stop.address ?? null) : null,
      papers: null,
      number,
    }
  }
  return {
    title: noThrow ? 'No Throw' : 'Bundle Drop',
    // The number is on a plate of its own, so it is left off the front of the lines beside it.
    name: withoutNumber(stop.label ?? stop.address ?? (noThrow ? 'This house does not want a paper.' : 'Bundle stop ahead.'), number),
    address: stop.label && stop.address ? withoutNumber(stop.address, number) : null,
    papers: !noThrow && stop.qty ? plural(stop.qty, 'paper', 'papers') : null,
    number,
  }
}

/** A house number as it is said: "3/12" is "3 slash 12", "12-14" is "12 to 14", and "12A" has its letter said by itself. */
export function spokenNumber(number: string): string {
  return number
    .replace(/\//g, ' slash ')
    .replace(/-/g, ' to ')
    .replace(/(\d)([A-Z])\b/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The most houses of a row that are said by number: a driver can't follow a longer list by ear. */
export const SPOKEN_ROW_MAX = 6

/** What is said to name a stop: its house number, or else what it is called, or nothing when it has neither. */
export function spokenName(s: Stop): string | null {
  const number = houseNumber(s)
  return number ? spokenNumber(number) : (s.label ?? s.address ?? null)
}

/**
 * What to say for alerts that have just come up, and which of them it covers. A row of no-throw houses is said
 * once, all together, the first time any of it comes up: as many of its numbers as are said (the rest are "and N
 * more"), and only those are counted as said, so the rest are said when the driver gets near them. Every other stop is
 * said on its own. `rowOf` gives the row a house is in.
 */
export function planSpeech(
  fresh: Occurrence[],
  rowOf: (first: Occurrence) => Occurrence[],
  announced: ReadonlySet<string>,
): { text: string; announce: string[] } {
  const parts: string[] = []
  const announce: string[] = []
  const covered = new Set<string>()
  for (const first of fresh.filter((o) => o.stop.type === 'nothrow').sort((a, b) => a.at - b.at)) {
    if (announced.has(first.key) || covered.has(first.key)) continue
    const row = rowOf(first)
    for (const o of row) covered.add(o.key)
    let said = 0
    let upTo = 0
    row.forEach((o, i) => {
      if (spokenName(o.stop) !== null && said < SPOKEN_ROW_MAX) {
        said++
        upTo = i + 1
      }
    })
    announce.push(...row.slice(0, Math.max(upTo, 1)).map((o) => o.key))
    parts.push(alertSpeech(row.map((o) => o.stop)))
  }
  for (const o of fresh) if (o.stop.type !== 'nothrow') parts.push(alertSpeech([o.stop]))
  return { text: parts.join(' '), announce }
}

/**
 * What is said when an alert comes up: the kind of stop, then the house number to look for (or what the stop is called,
 * if it has no number), and for a bundle drop how many papers and for a special request its note. For a row of no-throw
 * houses, all their numbers, in order. `stops` is one stop, or a row of no-throw houses.
 */
export function alertSpeech(stops: Stop[]): string {
  const first = stops[0]
  if (!first) return ''
  const name = spokenName
  if (first.type === 'nothrow') {
    const named = stops.map(name).filter((n): n is string => n !== null)
    const said = named.slice(0, SPOKEN_ROW_MAX)
    const more = named.length - said.length
    const list = said.join(', ')
    return `No throw${list ? `, ${list}` : ''}${more > 0 ? `, and ${more} more` : ''}.`
  }
  const who = name(first)
  if (first.type === 'request') return `Special request${who ? `, ${who}` : ''}.${first.note ? ` ${first.note}.` : ''}`
  return `Bundle drop${who ? `, ${who}` : ''}${first.qty ? `, ${plural(first.qty, 'paper', 'papers')}` : ''}.`
}

/** Whether the route runs the same way along two of its segments, as opposed to back the other way. */
export function sameWay(points: { lat: number; lng: number }[], i: number, j: number): boolean {
  const a = points[i]
  const b = points[i + 1]
  const c = points[j]
  const d = points[j + 1]
  if (!a || !b || !c || !d) return true
  const turn = Math.abs(((bearing(a, b) - bearing(c, d) + 540) % 360) - 180)
  return turn <= 90
}

export type RoadSide = 'left' | 'right'

const opposite = (side: RoadSide): RoadSide => (side === 'left' ? 'right' : 'left')

/**
 * Which side of the road a stop is on as the route passes it this time: the left or right of the way
 * you are driving. A side picked by hand wins, and swaps on a pass the other way along the street.
 * Otherwise it is worked out from where the stop sits beside the route. A no-throw house right on
 * the line falls back to the side the route throws on there, since that is the side it matters on.
 * Null when none of these can say.
 */
export function alertSide(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], o: Occurrence): RoadSide | null {
  const picked = o.stop.side
  if (picked) {
    if (o.key === o.stop.id) return picked
    const first = occs.find((x) => x.key === o.stop.id)
    return !first || sameWay(route.points, first.idx, o.idx) ? picked : opposite(picked)
  }
  const beside = stopSide(route.points, o.idx, o.stop)
  if (beside) return beside
  if (o.stop.type === 'nothrow') {
    const thrown = sideAt(route, o.idx)
    if (thrown === 'left' || thrown === 'right') return thrown
  }
  return null
}

/** Whether the route is only being driven, with nothing thrown, where it passes this stop. */
export const inTransit = (route: Pick<Route, 'sideChanges'>, o: Occurrence): boolean => sideAt(route, o.idx) === 'transit'

/** Whether a stop is off the route: too far from it to be along it, as stops placed on the map used to have to be. */
export const isOffRoute = (o: Pick<Occurrence, 'off'>): boolean => o.off > MAX_STOP_OFFSET_M

/**
 * The stops worth an alert. A no-throw house means nothing on a stretch where nothing is thrown at all,
 * so it stays quiet there. A bundle drop still alerts, as it has nothing to do with throwing. A stop off
 * the route is on no stretch of it, so it is never quiet for that.
 */
export const alertable = (route: Pick<Route, 'sideChanges'>, occs: Occurrence[]): Occurrence[] =>
  occs.filter((o) => !(o.stop.type === 'nothrow' && !isOffRoute(o) && inTransit(route, o)))

/** Whether every time the route passes this stop is on a stretch where nothing is thrown. A stop off the route never is. */
export function onlyInTransit(route: Pick<Route, 'sideChanges'>, occs: Occurrence[], stopId: string): boolean {
  const passes = occs.filter((o) => o.stop.id === stopId)
  return passes.length > 0 && passes.every((o) => !isOffRoute(o) && inTransit(route, o))
}

/** Whether a stop is off the route, going by every time the route passes it. */
export const stopOffRoute = (occs: Occurrence[], stopId: string): boolean => occs.some((o) => o.stop.id === stopId && isOffRoute(o))

/** What to tell the driver about stops just added that are off the route. Empty when none is. */
export function offRouteNote(offsM: number[]): string {
  const far = offsM.filter((m) => m > MAX_STOP_OFFSET_M)
  if (far.length === 0) return ''
  return far.length === 1
    ? `It is ${Math.round(far[0])} m from your route, so its alert comes up by where you are, whenever you are within the alert distance of it.`
    : `${far.length} of them are off your route, so their alerts come up by where you are, whenever you are within the alert distance of them.`
}

/** Dead ahead or dead behind is within this many degrees of the way you are heading, and has no side. */
const NO_SIDE_DEG = 15

/**
 * Which side of the road a stop is on as you come up to it: the left or right of the way you are heading. For
 * a stop off the route, which has no road of the route's to be beside. Null when there is no heading yet or
 * the stop is straight ahead or behind.
 */
export function approachSide(heading: number | null, pos: Pt | null, stop: Pt): RoadSide | null {
  if (heading === null || !pos) return null
  const turn = ((bearing(pos, stop) - heading + 540) % 360) - 180
  if (Math.abs(turn) < NO_SIDE_DEG || Math.abs(turn) > 180 - NO_SIDE_DEG) return null
  return turn > 0 ? 'right' : 'left'
}

/** No-throw houses are in a row when each is no further than this, in metres along the route, from the one before. */
export const ROW_GAP_M = 60
/** The most houses shown as one row: more than a driver can read at a glance. */
export const ROW_MAX = 12
/** A row reaches no further ahead than this, in metres along the route: houses further on can't be seen from the first. */
export const ROW_SPAN_M = 250

/**
 * The no-throw houses in a row with `first`, in the order the route reaches them, starting with `first`: each no more
 * than ROW_GAP_M further on than the one before, on the same side of the road, the route going the same way past
 * both (so a row doesn't carry on round a U-turn, to the houses on the way back), not yet done, and within ROW_SPAN_M
 * of the first. `occs` are the alertable occurrences in route order. Only a no-throw house on the route has a row: a
 * bundle drop, a special request and a stop that alerts by where the driver is each stand alone.
 */
export function houseRow(
  route: Pick<Route, 'points' | 'sideChanges'>,
  allOccs: Occurrence[],
  occs: Occurrence[],
  handled: ReadonlySet<string>,
  first: Occurrence,
  radius: Record<Stop['type'], number>,
): Occurrence[] {
  if (first.stop.type !== 'nothrow' || byPosition(first, radius)) return [first]
  const side = alertSide(route, allOccs, first)
  const row = [first]
  for (const o of occs) {
    const last = row[row.length - 1]
    if (o.at < first.at || o.key === first.key) continue
    if (o.at - last.at > ROW_GAP_M || o.at - first.at > ROW_SPAN_M) break
    if (o.stop.type !== 'nothrow' || handled.has(o.key) || byPosition(o, radius)) continue
    if (!sameWay(route.points, last.idx, o.idx)) break
    const here = alertSide(route, allOccs, o)
    if (side && here && side !== here) continue
    row.push(o)
    if (row.length >= ROW_MAX) break
  }
  return row
}

/** How far ahead of the driver a queued stop is, in metres, negative once it is behind. One met by where the driver is, not along the route, is as far from them as it is. */
export function aheadOf(o: Occurrence, along: number, pos: Pt | null, radius: Record<Stop['type'], number>): number {
  return byPosition(o, radius) && pos ? haversine(pos, o.stop) : o.at - along
}

/** A stop along the route counts as gone by once the driver is this far past it, in metres, and the alert moves on to the next. */
export const HEAD_PASSED_M = 10

/**
 * The alert to show among those queued: the nearest no-throw house still ahead, or else the nearest of the others, and
 * when everything is behind, the one least far behind. `driven` is the furthest the driver has got along the route,
 * which doesn't go back, so a stop the driver has gone by isn't brought back by a wobble in their position.
 */
export function pickCurrent(queue: Occurrence[], driven: number, along: number, pos: Pt | null, radius: Record<Stop['type'], number>): Occurrence | undefined {
  const nothrow = queue.filter((o) => o.stop.type === 'nothrow')
  const pool = nothrow.length ? nothrow : queue
  const ahead = (o: Occurrence) => aheadOf(o, Math.max(along, driven), pos, radius)
  const live = pool.filter((o) => ahead(o) > -HEAD_PASSED_M)
  if (live.length) return live.reduce((a, b) => (ahead(b) < ahead(a) ? b : a))
  return pool.length ? pool.reduce((a, b) => (ahead(b) > ahead(a) ? b : a)) : undefined
}

/** Whether a stop in the queue has been gone by, for counting those that are waiting. */
export const isGoneBy = (o: Occurrence, driven: number, along: number, pos: Pt | null, radius: Record<Stop['type'], number>): boolean =>
  aheadOf(o, Math.max(along, driven), pos, radius) <= -HEAD_PASSED_M

/**
 * How a row of houses is laid out in the banner: how many plates fit on a line, then whether it takes one line or two,
 * and when even two are not enough, all but one place of them show and the last says how many more there are.
 */
export function platesLayout(count: number, perLine: number, maxLines = 2): { shown: number; more: number; lines: number } {
  if (count <= perLine) return { shown: count, more: 0, lines: 1 }
  if (count <= perLine * maxLines) return { shown: count, more: 0, lines: Math.ceil(count / perLine) }
  const shown = perLine * maxLines - 1
  return { shown, more: count - shown, lines: maxLines }
}

/** What a house shows on its plate: its number, or if it has none the start of what it is called (marked as a name), or a dot. */
export function plateText(stop: Stop): { text: string; named: boolean } {
  const number = houseNumber(stop)
  if (number) return { text: number, named: false }
  const name = (stop.label ?? stop.address ?? '').trim()
  if (!name) return { text: '\u2022', named: false }
  return { text: name.length > 5 ? `${name.slice(0, 4).trimEnd()}\u2026` : name, named: true }
}

/** How many no-throw houses sit on transit stretches, where they won't alert. */
export function quietNoThrows(route: Pick<Route, 'points' | 'sideChanges' | 'stops'>): number {
  const occs = occurrences(route)
  return route.stops.filter((s) => s.type === 'nothrow' && onlyInTransit(route, occs, s.id)).length
}

/** What to tell the driver about no-throw houses that will stay quiet. Empty when there are none. */
export function quietNote(count: number): string {
  if (count === 0) return ''
  return count === 1
    ? "1 no-throw house is on a transit stretch, so it won't alert."
    : `${count} no-throw houses are on transit stretches, so they won't alert.`
}

/** The side a stop is on for each time the route passes it, in route order. */
export function stopRoadSides(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], stopId: string): (RoadSide | null)[] {
  return occs.filter((o) => o.stop.id === stopId).map((o) => alertSide(route, occs, o))
}

/** The no-throw houses among `added` whose side of the road can't be told, in a route that includes them. */
export function stopsWithoutSide(route: Pick<Route, 'points' | 'sideChanges' | 'stops'>, added: Stop[]): Stop[] {
  const occs = occurrences(route)
  return added.filter(
    (s) => s.type === 'nothrow' && !onlyInTransit(route, occs, s.id) && stopRoadSides(route, occs, s.id).every((side) => side === null),
  )
}

/** What to tell the driver when that many houses were added without a side. Empty when there are none. */
export function sideNote(count: number): string {
  if (count === 0) return ''
  return count === 1
    ? "Which side of the road it is on couldn't be told, so tap Set side on it in the list."
    : `Which side of the road ${count} of them are on couldn't be told, so tap Set side on each in the list.`
}
