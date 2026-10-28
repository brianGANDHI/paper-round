import { plural } from './format'
import { bearing, byPosition, haversine, LATERAL_SLACK_M, occurrences, sideAt, stopSide, type Occurrence } from './geo'
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

/** Why a no-throw house stays quiet on a pass of the route: nothing is thrown there at all, or it is on the side of the road that isn't thrown. */
export type QuietReason = 'transit' | 'otherSide'

/**
 * How far from the route, in metres, a no-throw house can be and still be kept quiet. A house further than this alerts whatever is
 * thrown, since at the shortest alert distance (`ALERT_DISTANCES[0]`) it already alerts by where the driver is (see `byPosition`),
 * and that has nothing to do with a stretch of the route or a side of its road. So a house is never silenced that would have alerted
 * by position, at any alert distance the driver can choose.
 */
export const QUIET_REACH_M = ALERT_DISTANCES[0] + LATERAL_SLACK_M

/** Whether a stop is too far from the route to be kept quiet for what is thrown along it: see `QUIET_REACH_M`. */
const beyondQuietReach = (o: Pick<Occurrence, 'off'>): boolean => o.off > QUIET_REACH_M

/**
 * Why a no-throw house stays quiet on this pass of the route, or null when it alerts. It stays quiet where nothing is
 * thrown at all (a transit stretch), and where only one side is thrown when the house is on the other side of the road:
 * a house on the left means nothing on a stretch thrown to the right. Where both sides are thrown it alerts. So it does
 * when its side can't be told (better an alert that wasn't needed than a missed house), and when it is further from the
 * route than `QUIET_REACH_M`, where it is on no stretch of the route to speak of and may alert by where the driver is. The
 * side is the one the alert shows (see `alertSide`): as the route passes the house this time, a side picked by hand
 * included, so on a street driven twice the same house can be quiet on one pass and alert on the other. A bundle drop and a
 * special request are never quiet, as they have nothing to do with throwing.
 *
 * `occs` are all the occurrences of the route, not just those that alert, since a side picked by hand is told from the
 * first pass of the stop.
 */
export function quietReason(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], o: Occurrence): QuietReason | null {
  if (o.stop.type !== 'nothrow' || beyondQuietReach(o)) return null
  const thrown = sideAt(route, o.idx)
  if (thrown === 'transit') return 'transit'
  if (thrown === 'both') return null
  const side = alertSide(route, occs, o)
  return side && side !== thrown ? 'otherSide' : null
}

/**
 * The stops worth an alert: those that are not quiet (see `quietReason`). A no-throw house means nothing on a stretch
 * where nothing is thrown at all, nor on the side of the road that isn't thrown, so it stays quiet there, if it is near enough
 * the route for that to be said (`QUIET_REACH_M`). A bundle drop and a special request still alert. Each
 * time the route passes a house is judged on its own, so a house can have some passes that alert and some that don't;
 * the keys are those of `occurrences`, and don't change with which of them alert. `occs` are all the occurrences of the
 * route, and the result keeps their order.
 */
export const alertable = (route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[]): Occurrence[] =>
  occs.filter((o) => quietReason(route, occs, o) === null)

/**
 * How the round stands, counted over the passes that alert (the result of `alertable`) against the keys of the passes done: how many
 * there are, how many are done, how many are left, and whether the round is finished (there is something to do and all of it is done).
 * A pass that stays quiet is not a stop to do, so a house that is quiet on one pass of a street and alerts on the other counts once.
 */
export function roundCounts(occs: readonly Pick<Occurrence, 'key'>[], handled: ReadonlySet<string>): { total: number; done: number; remaining: number; finished: boolean } {
  const total = occs.length
  const remaining = occs.filter((o) => !handled.has(o.key)).length
  return { total, done: total - remaining, remaining, finished: total > 0 && remaining === 0 }
}

/** Whether every time the route passes this stop is on a stretch where nothing is thrown. A stop further from the route than `QUIET_REACH_M` never is, as what is thrown along the route says nothing of it. */
export function onlyInTransit(route: Pick<Route, 'sideChanges'>, occs: Occurrence[], stopId: string): boolean {
  const passes = occs.filter((o) => o.stop.id === stopId)
  return passes.length > 0 && passes.every((o) => !beyondQuietReach(o) && inTransit(route, o))
}

/** For each time the route passes a stop, in route order: why a no-throw house is quiet there, or null where it alerts. */
export function stopQuietReasons(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], stopId: string): (QuietReason | null)[] {
  return occs.filter((o) => o.stop.id === stopId).map((o) => quietReason(route, occs, o))
}

/** The passes in words, "2", "1 and 3", "1, 2 and 3". */
const passList = (passes: number[]): string => (passes.length < 2 ? passes.join('') : `${passes.slice(0, -1).join(', ')} and ${passes[passes.length - 1]}`)

/**
 * What the Stops list says of a no-throw house's alerts, given why it is quiet on each pass of the route (see
 * `stopQuietReasons`). Empty when it alerts on every pass. Quiet on all of them, it says why; quiet on some, it says on which.
 */
export function quietText(reasons: (QuietReason | null)[]): string {
  const quiet = reasons.flatMap((reason, i) => (reason ? [{ reason, pass: i + 1 }] : []))
  if (quiet.length === 0) return ''
  const has = (reason: QuietReason) => quiet.some((q) => q.reason === reason)
  if (quiet.length === reasons.length) {
    if (!has('otherSide')) return 'in transit, so no alert'
    return has('transit') ? 'quiet here: in transit or you throw the other side' : 'quiet here: you throw the other side'
  }
  const why: Record<QuietReason, string> = { transit: 'in transit', otherSide: 'you throw the other side' }
  const parts = (['transit', 'otherSide'] as const)
    .filter(has)
    .map((reason) => {
      const passes = quiet.filter((q) => q.reason === reason).map((q) => q.pass)
      return `${passes.length === 1 ? 'pass' : 'passes'} ${passList(passes)}: ${why[reason]}`
    })
  return `quiet on ${parts.join('; on ')}`
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
 * The alert to show among those queued: among those still ahead (or only just gone by), the nearest no-throw house, or else the
 * nearest of the others; and when everything is gone by, the no-throw house least far behind, or else the other least far behind. A stop
 * the driver has gone by does not outrank one that is still live, whatever it is: a no-throw house just behind must not hide a bundle drop
 * at the wheels, whose Dropped button is the only way to confirm it. `driven` is the furthest the driver has got along the route, which
 * doesn't go back, so a stop the driver has gone by isn't brought back by a wobble in their position.
 *
 * What still waits: a no-throw house that is live is the alert, so a bundle drop shows only while no house is live. One with a house
 * before it shows once that house is gone by (and again once the house's zone is over). One with a house at the same spot or after it
 * is gone by no later than the house is, and from then a house outranks it again, so it shows only until the house comes into range,
 * and not at all for a house at the same spot.
 */
export function pickCurrent(queue: Occurrence[], driven: number, along: number, pos: Pt | null, radius: Record<Stop['type'], number>): Occurrence | undefined {
  const ahead = (o: Occurrence) => aheadOf(o, Math.max(along, driven), pos, radius)
  const nearest = (pool: Occurrence[]) => pool.reduce((a, b) => (ahead(b) < ahead(a) ? b : a))
  const leastBehind = (pool: Occurrence[]) => pool.reduce((a, b) => (ahead(b) > ahead(a) ? b : a))
  const isNoThrow = (o: Occurrence) => o.stop.type === 'nothrow'
  const live = queue.filter((o) => ahead(o) > -HEAD_PASSED_M)
  if (live.length) {
    const houses = live.filter(isNoThrow)
    return nearest(houses.length ? houses : live)
  }
  if (!queue.length) return undefined
  const houses = queue.filter(isNoThrow)
  return leastBehind(houses.length ? houses : queue)
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

/**
 * The ids of the no-throw houses that stay quiet on every time the route passes them (and are passed at least once): on a
 * stretch where nothing is thrown, or on the side of the road that isn't thrown. A house that alerts on any pass isn't one.
 * `occs` are all the occurrences of the route.
 */
export function quietHouseIds(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[]): Set<string> {
  const allQuiet = new Map<string, boolean>()
  for (const o of occs) allQuiet.set(o.stop.id, (allQuiet.get(o.stop.id) ?? true) && quietReason(route, occs, o) !== null)
  return new Set([...allQuiet].filter(([, quiet]) => quiet).map(([id]) => id))
}

/** How many no-throw houses won't alert at all, as they are on transit stretches or on the side of the road that isn't thrown. */
export const quietNoThrows = (route: Pick<Route, 'points' | 'sideChanges' | 'stops'>): number => quietHouseIds(route, occurrences(route)).size

/** What to tell the driver about no-throw houses that will stay quiet. Empty when there are none. */
export function quietNote(count: number): string {
  if (count === 0) return ''
  return count === 1
    ? "1 no-throw house won't alert: it is on a transit stretch, or on the side you don't throw."
    : `${count} no-throw houses won't alert: they are on transit stretches, or on the side you don't throw.`
}

/** The side a stop is on for each time the route passes it, in route order. */
export function stopRoadSides(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], stopId: string): (RoadSide | null)[] {
  return occs.filter((o) => o.stop.id === stopId).map((o) => alertSide(route, occs, o))
}

/**
 * The no-throw houses among `added` whose side of the road can't be told, in a route that includes them. A house that is
 * quiet on a transit stretch is not asked about, as it never alerts. One whose side can't be told alerts wherever it is
 * thrown (see `quietReason`), so the side is only for what the alert shows.
 */
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
