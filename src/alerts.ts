import { plural } from './format'
import { bearing, byPosition, haversine, LATERAL_SLACK_M, occurrences, placedZone, sideAt, stopSide, type Occurrence } from './geo'
import { slackFor } from './resume'
import { houseNumber, MAX_STOP_OFFSET_M, withoutNumber } from './routeEdit'
import { sideWords } from './sideVoice'
import type { CourtLeg, Pt, Route, Side, Stop } from './types'

/** How near a stop you have to be, in metres, for its alert to come up. The driver picks one of these. */
export const ALERT_DISTANCES = [10, 20, 30, 40, 50, 60] as const

export type AlertDistance = (typeof ALERT_DISTANCES)[number]

export const DEFAULT_ALERT_DISTANCE: AlertDistance = 40

export const isAlertDistance = (v: unknown): v is AlertDistance => ALERT_DISTANCES.some((d) => d === v)

/**
 * The zone around a stop in which its banner shows: from this far before it until this far past it,
 * for every kind of stop.
 */
export const alertRadius = (distance: AlertDistance): Record<Stop['type'], number> => ({ nothrow: distance, bundle: distance, request: distance, block: distance })

/** Backing away only ends a banner this far outside the zone, so GPS jitter at its edge can't set it off again and again. */
export const BACK_OFF_SLACK_M = 15

/** Which way a stop's zone was left: on past the stop, or back the way the driver came. */
export type ZoneExit = 'passed' | 'back'

/**
 * Whether the driver has left a stop's zone, and which way. Null while still inside it.
 * `driverAt` is how far along the route the driver is, in metres.
 *
 * A stop that is off the route has no way along the route to be passed or backed away from. Its zone is the
 * ground around it (see `placedZone`), and it counts as done once the driver, at `pos`, has been in it and is out of it again. Leave `pos`
 * out for a fix too poor to say where the driver is: one bad fix must not take an alert down, and count a bundle missed with the car parked at it.
 */
export function zoneExit(o: Occurrence, driverAt: number, radius: Record<Stop['type'], number>, pos?: Pt): ZoneExit | null {
  const r = radius[o.stop.type]
  if (byPosition(o, radius)) return pos && haversine(pos, o.stop) > placedZone(o, radius) + BACK_OFF_SLACK_M ? 'passed' : null
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
 *
 * An apartment block is told as 'Apartment block', with its papers (how many to throw there) as the amount, like a bundle drop's.
 * Which side of the road it is on is not here, as the banner is given that (see `alertSide`).
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
  if (stop.type === 'block') {
    return {
      title: 'Apartment block',
      // With no name or address the line says what to do there, as the title already says what it is.
      name: withoutNumber(stop.label ?? stop.address ?? 'Throw its papers here.', number),
      address: stop.label && stop.address ? withoutNumber(stop.address, number) : null,
      papers: stop.qty ? plural(stop.qty, 'paper', 'papers') : null,
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
 * said on its own. `rowOf` gives the row a house is in, and `sideOf` the side of the road a stop is on (said for an apartment block,
 * see `alertSpeech`; a stop it gives no side for is said without one).
 */
export function planSpeech(
  fresh: Occurrence[],
  rowOf: (first: Occurrence) => Occurrence[],
  announced: ReadonlySet<string>,
  sideOf?: (o: Occurrence) => RoadSide | null,
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
  for (const o of fresh) if (o.stop.type !== 'nothrow') parts.push(alertSpeech([o.stop], sideOf?.(o) ?? null))
  return { text: parts.join(' '), announce }
}

/**
 * What is said when an alert comes up: the kind of stop, then the house number to look for (or what the stop is called,
 * if it has no number), and for a bundle drop how many papers and for a special request its note. For a row of no-throw
 * houses, all their numbers, in order. `stops` is one stop, or a row of no-throw houses.
 *
 * An apartment block is told with how many papers to throw there and then which side of the road it is on, which is `side` (left out
 * when it can't be told, and for every other kind of stop): "Apartment block, 12 papers, port." With no count it is "Apartment block, port."
 */
export function alertSpeech(stops: Stop[], side: RoadSide | null = null): string {
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
  if (first.type === 'block') return `Apartment block${who ? `, ${who}` : ''}${first.qty ? `, ${plural(first.qty, 'paper', 'papers')}` : ''}${side ? `, ${sideWords(side).toLowerCase()}` : ''}.`
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

export const opposite = (side: RoadSide): RoadSide => (side === 'left' ? 'right' : 'left')

/** One leg of a pass less than this much further along the route than the other, in metres, does not come first: at the very tip of a turn-round the two meet. */
const EARLIER_M = 1

/**
 * The leg of a stop's first pass that the route reaches first: the one a side picked by hand is the side of. At the turn-round of a court that is
 * the way in, though the way back can be the leg nearest the house (and so the one `occurrences` gives it as `idx`), as it is beside the U-turn
 * the app draws. A leg less than `EARLIER_M` sooner does not count as first, so at the very tip of an exact reversal, where the legs meet, the
 * pass's own leg is.
 */
export const firstLeg = (first: Pick<Occurrence, 'idx' | 'alt' | 'altAt' | 'at'>): number =>
  first.alt !== undefined && (first.altAt ?? Infinity) < first.at - EARLIER_M ? first.alt : first.idx

/**
 * The side of the road a stop is on as the route passes it along segment `idx`: see `alertSide`, which says which segment that is. A side
 * picked by hand is the side as you drive past the stop the first time, so it is told against the leg of the stop's first pass (in `occs`)
 * that the route reaches first (see `firstLeg`), never against `o.idx`, and `alertable` can put a house at a turn-round on the other leg of its pass.
 */
function sideOnLeg(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], o: Occurrence, idx: number): RoadSide | null {
  const picked = o.stop.side
  if (picked) {
    const first = occs.find((x) => x.key === o.stop.id)
    if (!first) return picked
    return sameWay(route.points, firstLeg(first), idx) ? picked : opposite(picked)
  }
  const beside = stopSide(route.points, idx, o.stop)
  if (beside) return beside
  if (o.stop.type === 'nothrow') {
    const thrown = sideAt(route, idx)
    if (thrown === 'left' || thrown === 'right') return thrown
  }
  return null
}

/**
 * Which side of the road a stop is on as the route passes it this time: the left or right of the way
 * you are driving. A side picked by hand wins, and swaps on a pass the other way along the street.
 * Otherwise it is worked out from where the stop sits beside the route. A no-throw house right on
 * the line falls back to the side the route throws on there, since that is the side it matters on.
 * Null when none of these can say.
 *
 * A no-throw house at the turn-round of a court is passed on both legs by the one pass (see `Occurrence.alt`). It is on the left of one
 * leg and the right of the other. The side is that of the leg its alert is for (see `alertLeg`), so the alert shows the side thrown.
 *
 * `occs` are all the occurrences of the route, as `occurrences` gives them, since a side picked by hand is told from the first pass of the
 * stop; `o` can be one of them, the same pass as `alertable` gives it, or as `keepAlertsAhead` keeps it on the leg ahead of the driver.
 */
export function alertSide(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], o: Occurrence): RoadSide | null {
  return sideOnLeg(route, occs, o, alertLeg(route, occs, o))
}

/**
 * Which leg of the route a no-throw house's alert is for, on this pass: the segment the pass is on (`o.idx`), unless the house is at the
 * turn-round of a court (see `Occurrence.alt`) and is thrown on the other leg only, or on both and the other comes first along the route.
 * The house is quiet only when it is quiet on both legs (see `quietReason`), and its alert must come before the driver is beside it where
 * a paper would be thrown at it, so it is timed and shown on that leg: thrown right both ways, a house on the right going in that is
 * nearer the way back is still told of on the way in. Every other stop, and a house that alerts on neither leg, keeps `o.idx`. The leg
 * is the same whether the pass is as `occurrences` gives it or as `alertable` gives it, put on that leg. A pass `keepAlertsAhead` kept on the
 * leg ahead of the driver has no other leg, so it is that one.
 */
function alertLeg(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], o: Occurrence): number {
  if (o.alt === undefined || o.stop.type !== 'nothrow' || legReason(route, occs, o, o.alt) !== null) return o.idx
  return legReason(route, occs, o, o.idx) !== null || (o.altAt ?? o.at) < o.at - EARLIER_M ? o.alt : o.idx
}

/** Whether the route is only being driven, with nothing thrown, where it passes this stop. */
export const inTransit = (route: Pick<Route, 'sideChanges'>, o: Occurrence): boolean => sideAt(route, o.idx) === 'transit'

/** Whether a stop is off the route: too far from it to be along it, as stops placed on the map used to have to be. */
export const isOffRoute = (o: Pick<Occurrence, 'off'>): boolean => o.off > MAX_STOP_OFFSET_M

/** Why a no-throw house stays quiet on a pass of the route: nothing is thrown there at all, or it is on the side of the road that isn't thrown. */
export type QuietReason = 'transit' | 'otherSide'

/**
 * How far from the route, in metres, a no-throw house can be and still be kept quiet, at the shortest alert distance
 * (`ALERT_DISTANCES[0]`). A house further than this alerts whatever is thrown, since it already alerts by where the driver is (see
 * `byPosition`), and that has nothing to do with a stretch of the route or a side of its road. This is the reach the functions below
 * take when they are not given one; the reach for the alert distance the driver chose is `quietReachFor`.
 */
export const QUIET_REACH_M = ALERT_DISTANCES[0] + LATERAL_SLACK_M

/**
 * How far from the route a no-throw house can be and still be kept quiet, at an alert distance: the distance at which the house is met
 * by where the driver is instead of along the route (see `byPosition`). Any house met along the route is judged by its stretch and side, so
 * a house that is quiet is never one that would alert by position, at any alert distance the driver can choose, and a house 40 to 70 m
 * back from the road is no longer voiced on the side that isn't thrown, nor all through a transit stretch.
 */
export const quietReachFor = (distance: AlertDistance): number => distance + LATERAL_SLACK_M

/** Whether a stretch of the route is thrown, and which side the stop is on, for one leg of the route past a no-throw house: why it is quiet there, or null when it alerts. */
function legReason(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], o: Occurrence, idx: number): QuietReason | null {
  const thrown = sideAt(route, idx)
  if (thrown === 'transit') return 'transit'
  if (thrown === 'both') return null
  const side = sideOnLeg(route, occs, o, idx)
  return side && side !== thrown ? 'otherSide' : null
}

/**
 * Why a no-throw house stays quiet on this pass of the route, or null when it alerts. It stays quiet where nothing is
 * thrown at all (a transit stretch), and where only one side is thrown when the house is on the other side of the road:
 * a house on the left means nothing on a stretch thrown to the right. Where both sides are thrown it alerts. So it does
 * when its side can't be told (better an alert that wasn't needed than a missed house), and when it is further from the
 * route than `reachM` (`quietReachFor` the alert distance; `QUIET_REACH_M` when none is given), where it is met by where the driver is
 * rather than along a stretch of the route. The side is the one the alert shows (see `alertSide`): as the route passes the house this
 * time, a side picked by hand included, so on a street driven twice the same house can be quiet on one pass and alert on the other.
 * A bundle drop, a special request and an apartment block are never quiet, as they have nothing to do with what is thrown.
 *
 * A house at the turn-round of a court is passed on both legs by one pass (see `Occurrence.alt`) and is quiet only when it is quiet on
 * both: on the way in it is on the right and on the way out the left, so thrown right on both it must alert, once.
 *
 * `occs` are all the occurrences of the route, not just those that alert, since a side picked by hand is told from the
 * first pass of the stop.
 */
export function quietReason(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], o: Occurrence, reachM: number = QUIET_REACH_M): QuietReason | null {
  if (o.stop.type !== 'nothrow' || o.off > reachM) return null
  const reason = legReason(route, occs, o, o.idx)
  if (reason === null || o.alt === undefined) return reason
  return legReason(route, occs, o, o.alt) === null ? null : reason
}

/**
 * The stops worth an alert: those that are not quiet (see `quietReason`). A no-throw house means nothing on a stretch
 * where nothing is thrown at all, nor on the side of the road that isn't thrown, so it stays quiet there, if it is near enough
 * the route for that to be said (`reachM`, see `quietReachFor`). A bundle drop, a special request and an apartment block still alert. Each
 * time the route passes a house is judged on its own, so a house can have some passes that alert and some that don't;
 * the keys are those of `occurrences`, and don't change with which of them alert. `occs` are all the occurrences of the
 * route, and the result is in route order.
 *
 * A no-throw house at the turn-round of a court is passed on both legs by one pass, and its alert is for the leg it is thrown on, the first
 * of them when it is thrown on both (see `alertLeg`). That need not be the leg nearest it, which is the one `occurrences` gives, so here the
 * pass is put on that leg: `idx` and `at` are the leg's, and `alt` and `altAt` the other's. Everything that times an alert from `at` (its
 * zone, the banner's distance, the voice, the round's catch-up and a start part way) then times it where the paper would be thrown.
 */
export function alertable(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], reachM: number = QUIET_REACH_M): Occurrence[] {
  return occs
    .filter((o) => quietReason(route, occs, o, reachM) === null)
    .map((o) => (o.alt === undefined || alertLeg(route, occs, o) === o.idx ? o : { ...o, idx: o.alt, at: o.altAt ?? o.at, alt: o.idx, altAt: o.at }))
    .sort((a, b) => a.at - b.at)
}

/**
 * The passes to alert for after the route changes part way through a round, and the keys of those to count as done. A change of throw side
 * can move a no-throw house's alert from one leg of its pass at the turn-round of a court to the other (see `alertLeg`): thrown right both
 * ways, a house on the left going in alerts on the way back; changed to Both at the tip, it is thrown on both legs and `alertable` times it
 * on the first, which the car has gone by. Its key is the same, so it would count as neither done nor new, never come up, and leave the
 * round unfinished, though the car is still to pass it on the way back with its side thrown.
 *
 * `before` are the passes that alerted until now (as they were in use: this result, the last time), `occs` those `alertable` gives for
 * the route as it is now, `along` how far along the route the driver is (where they are now, not the furthest they got: a driver who has
 * backed up passes the legs from there again), and `radius` the alert zones. A pass whose alert is now on a leg the driver has passed, and
 * that also alerts on the other leg of its pass (see `quietReason`), which they have not passed, is kept on that leg, unless its alert was
 * on a leg already behind them before (it was done there, or can still come up): `idx` and `at` are that leg's, and it has no `alt`, as
 * the leg gone by has no more to tell of (so its side is that leg's too, see `alertSide`). So it is for one whose alert moved there from a
 * leg they had not passed, and for one that did not alert before: one left out (see below) that a change throws on both legs again, one
 * that was quiet, and one of a stretch that was transit, which the car is still to pass with its side thrown. Every other pass is as
 * `occs` has it, and the result is in route order.
 *
 * `done` are the keys of the passes whose alert is now further behind the driver than the slack for the zones (see `slackFor`), and was
 * not before, with no leg ahead that they alert on: a pass that did not alert before (as a stop that starts to alert behind the car counts
 * as done), and one whose alert moved there. Being behind the car, neither would come up again, so the round could never finish without
 * them. Those already done are left to the caller. A pass met by where the driver is (see `byPosition`) has no leg and is neither.
 *
 * A no-throw house of either kind whose other leg the driver has not passed, but that is quiet on that leg (see `quietReason`), is left out
 * of the result instead of being done: the car is still to pass it there, but with its side not thrown, so it has nothing to tell of. Left
 * out, it does not hold up the round (see `roundCounts`); counted done, it would stay done, and a later change that throws that leg again
 * (taking the change back with Undo, or changing the side back) would have it never come up, though the car passes it with its side
 * thrown. Left out, it comes back with that change as a pass that did not alert before, and alerts on that leg ahead of the car, whether
 * the change throws it there alone or on the leg gone by too (as changing the side back from the last turn on does at the tip, which
 * leaves the way in as it is). One with both legs behind the driver is done.
 *
 * Given its own result as `occs` it gives the same again, so the passes can be worked out where the route changes and the keys done where
 * they are counted. What it made of the passes is kept with the round (see `courtLegsOf`), and goes on from there when the round is carried
 * on after the round screen was left (see `resumedLegs`).
 */
export function keepAlertsAhead(
  route: Pick<Route, 'points' | 'sideChanges'>,
  allOccs: Occurrence[],
  before: readonly Pick<Occurrence, 'key' | 'at'>[],
  occs: Occurrence[],
  along: number,
  radius: Record<Stop['type'], number>,
): { occs: Occurrence[]; done: string[] } {
  const was = new Map(before.map((o) => [o.key, o.at]))
  const goneBy = along - slackFor(radius)
  const done: string[] = []
  const kept = occs.flatMap((o) => {
    if (byPosition(o, radius)) return [o]
    const prev = was.get(o.key)
    // Not only a pass whose alert moved: one that did not alert before is still to be passed on the leg ahead, with its side thrown there.
    const legAhead =
      (prev === undefined || prev >= along) &&
      o.at < along &&
      o.stop.type === 'nothrow' &&
      o.alt !== undefined &&
      o.altAt !== undefined &&
      o.altAt >= along &&
      legReason(route, allOccs, o, o.alt) === null
    if (legAhead) {
      const { alt, altAt, ...pass } = o
      return [{ ...pass, idx: alt as number, at: altAt as number }]
    }
    if (o.at < goneBy && (prev === undefined || prev >= goneBy)) {
      // Quiet on the leg still ahead, it has nothing to tell of now, but the car has yet to pass it there. So it is left out, not done:
      // counted done, a change that throws that leg again (an Undo) would find it done, and the car would pass it in silence.
      const quietAhead =
        o.stop.type === 'nothrow' && o.alt !== undefined && o.altAt !== undefined && o.altAt >= along && legReason(route, allOccs, o, o.alt) !== null
      if (quietAhead) return []
      done.push(o.key)
    }
    return [o]
  })
  return { occs: kept.sort((a, b) => a.at - b.at), done }
}

/**
 * What a change of side part way through the round made of the passes at the head of a court, by key, to be kept with the round (see
 * `RoundState.courtLegs`): `out` for a pass that `keepAlertsAhead` left out, and `ahead` for one it kept on the leg ahead of the driver.
 * `fresh` are the passes as `alertable` gives them for the route as it is, and `occs` those the round alerts for, which `keepAlertsAhead`
 * (or `resumedLegs`) made of them. Every other pass is as `fresh` has it, and has no entry. It holds nothing of where the driver was, so
 * nothing has to be worked out again from where they are when the round is carried on: `resumedLegs` puts the passes back from it.
 */
export function courtLegsOf(fresh: readonly Occurrence[], occs: readonly Occurrence[]): Record<string, CourtLeg> {
  const inUse = new Map(occs.map((o) => [o.key, o]))
  const legs = fresh.flatMap((o): [string, CourtLeg][] => {
    const now = inUse.get(o.key)
    if (!now) return [[o.key, 'out']]
    return now.idx !== o.idx || now.at !== o.at ? [[o.key, 'ahead']] : []
  })
  // Built as entries, so no key (not even "__proto__") can reach the object's prototype.
  return Object.fromEntries(legs)
}

/**
 * The passes the round alerts for once the round screen was left or the app reloaded, for the start screen and for *Continue Round*: `fresh`
 * (as `alertable` gives them for the route as it is), with what a change of side part way through the round made of the passes at the head
 * of a court put back as it was kept with the round (`legs`, see `courtLegsOf`). A house left out is left out again, and one kept on the leg
 * ahead of the driver is kept there, with no other leg, as `keepAlertsAhead` keeps it. Nothing is worked out from where the driver is, nor
 * from where the round carries on from: the passes are as they were when the screen was left, wherever the car is when the round is carried
 * on, so a house the car has not yet passed after the place carried on from alerts as it would. A later change of side finds them as it
 * would have without the screen being left, so taking the change back still brings a house left out back on the leg ahead. The first fix
 * on the route after *Continue Round* then puts a house the driver is between the two legs of, which alerts on the leg ahead, there (see
 * `legsOnResume`).
 *
 * An entry is followed only while it still fits the pass: `out` for a no-throw house met along the route (see `byPosition`) whose alert is
 * on the earlier leg of its pass and that is quiet on the later one, and `ahead` for one thrown on the later one. One that does not (the
 * route or the alert distance changed since, or the route no longer has that pass) is let go, and the pass is as `fresh` has it. With
 * nothing to follow it gives `fresh` itself.
 */
export function resumedLegs(
  route: Pick<Route, 'points' | 'sideChanges'>,
  allOccs: Occurrence[],
  fresh: Occurrence[],
  legs: Readonly<Record<string, CourtLeg>> | undefined,
  radius: Record<Stop['type'], number>,
): Occurrence[] {
  const marks = new Map(Object.entries(legs ?? {}))
  let followed = false
  const kept = fresh.flatMap((o) => {
    const mark = marks.get(o.key)
    const later = o.stop.type === 'nothrow' && !byPosition(o, radius) && o.alt !== undefined && o.altAt !== undefined && o.altAt > o.at
    if (!mark || !later) return [o]
    const quiet = legReason(route, allOccs, o, o.alt as number) !== null
    if (quiet !== (mark === 'out')) return [o]
    followed = true
    if (quiet) return []
    const { alt, altAt, ...pass } = o
    return [{ ...pass, idx: alt as number, at: altAt as number }]
  })
  return followed ? kept.sort((a, b) => a.at - b.at) : fresh
}

/**
 * The passes the round alerts for from the first fix on the route after *Continue Round*, worked out once, at that fix: `occs` (as
 * `resumedLegs` gave them), with a no-throw house at the head of a court whose two legs the driver is between put on the leg ahead. A house
 * thrown on both legs of its pass is timed on the first (see `alertable`). Carried on after the car has gone by it there, whether it was
 * up when the screen was left or not (left on the way in, carried on past the tip), it would never come up again: the car would pass it
 * coming back with its side thrown and no alert, and the round could not finish.
 *
 * `handled` are the keys of the passes done, `along` how far along the route that fix puts the driver, and `radius` the alert zones. A pass
 * is moved only when it is not done, is met along the route (see `byPosition`), its alert is on a leg more than the slack for the zones
 * (see `slackFor`) behind the driver (one less far behind can still come up there), and the other leg of its pass is at or ahead of them
 * and it alerts there (see `quietReason`). Its `idx` and `at` are then that leg's, and it has no `alt`, as `keepAlertsAhead` keeps a pass
 * on the leg ahead (and as `courtLegsOf` keeps it with the round).
 *
 * It only ever moves a pass onto a leg still ahead where it alerts. It never leaves one out or counts one done, as the fix may be beside a
 * later street of the route, not where the car is: a house there, thrown going in only, that the car has yet to reach must still come up.
 * So a fix anywhere but between the two legs of a court changes nothing. With nothing moved it gives `occs` itself.
 */
export function legsOnResume(
  route: Pick<Route, 'points' | 'sideChanges'>,
  allOccs: Occurrence[],
  occs: Occurrence[],
  handled: ReadonlySet<string>,
  along: number,
  radius: Record<Stop['type'], number>,
): Occurrence[] {
  const behind = along - slackFor(radius)
  let moved = false
  const kept = occs.map((o) => {
    const legAhead =
      !handled.has(o.key) &&
      o.stop.type === 'nothrow' &&
      !byPosition(o, radius) &&
      o.alt !== undefined &&
      o.altAt !== undefined &&
      o.at < behind &&
      along <= o.altAt &&
      legReason(route, allOccs, o, o.alt) === null
    if (!legAhead) return o
    moved = true
    const { alt, altAt, ...pass } = o
    return { ...pass, idx: alt as number, at: altAt as number }
  })
  return moved ? kept.sort((a, b) => a.at - b.at) : occs
}

/**
 * Whether the voice may name this stop now, given the side thrown where the driver is (`thrownNow`, the side at the driver's own place on
 * the route, not at the stop). The beep and the banner come up early, as the safety warning; the words wait. A no-throw house on the route
 * is said only once the side thrown where the driver is includes the side the house is on: never on a transit stretch, and on a Port or
 * Starboard stretch only for a house on that side, so the houses of the stretch after a change of side wait until the driver is on it. Both
 * covers either side, and a house whose side can't be told is said, to be safe. A house met by where the driver is (see `byPosition`) is
 * said whatever is thrown, as it is on no stretch of the route. A bundle drop, a special request and an apartment block are always said.
 */
export function voiceable(route: Pick<Route, 'points' | 'sideChanges'>, allOccs: Occurrence[], o: Occurrence, thrownNow: Side, radius: Record<Stop['type'], number>): boolean {
  if (o.stop.type !== 'nothrow' || byPosition(o, radius)) return true
  if (thrownNow === 'transit') return false
  if (thrownNow === 'both') return true
  const side = alertSide(route, allOccs, o)
  return !side || side === thrownNow
}

/**
 * How the round stands, counted over the passes that alert (the result of `alertable`, or of `keepAlertsAhead` after a change part way
 * through a round) against the keys of the passes done: how many there are, how many are done, how many are left, and whether the round is
 * finished (there is something to do and all of it is done). A pass that stays quiet is not a stop to do, so a house that is quiet on one
 * pass of a street and alerts on the other counts once, and neither is a house at the head of a court that `keepAlertsAhead` leaves out.
 */
export function roundCounts(occs: readonly Pick<Occurrence, 'key'>[], handled: ReadonlySet<string>): { total: number; done: number; remaining: number; finished: boolean } {
  const total = occs.length
  const remaining = occs.filter((o) => !handled.has(o.key)).length
  return { total, done: total - remaining, remaining, finished: total > 0 && remaining === 0 }
}

/** Whether every time the route passes this stop is on a stretch where nothing is thrown. A stop further from the route than `reachM` never is, as what is thrown along the route says nothing of it. */
export function onlyInTransit(route: Pick<Route, 'sideChanges'>, occs: Occurrence[], stopId: string, reachM: number = QUIET_REACH_M): boolean {
  const passes = occs.filter((o) => o.stop.id === stopId)
  return passes.length > 0 && passes.every((o) => o.off <= reachM && inTransit(route, o))
}

/** For each time the route passes a stop, in route order: why a no-throw house is quiet there, or null where it alerts. */
export function stopQuietReasons(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], stopId: string, reachM: number = QUIET_REACH_M): (QuietReason | null)[] {
  return occs.filter((o) => o.stop.id === stopId).map((o) => quietReason(route, occs, o, reachM))
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

/**
 * What to tell the driver about stops just added that are off the route (more than `MAX_STOP_OFFSET_M` from it), given how far each is
 * from it. Empty when none is. One further than `reachM` (`quietReachFor` the alert distance in use; `QUIET_REACH_M` when none is given) is
 * met by where the driver is (see `byPosition`), so its alert comes up whenever they are within the alert distance of it. One nearer than
 * that is marked off the route in the list all the same, but its alert still comes up along the route as the driver goes past it, with
 * the side of the road it is on, which can be set in the list: it is told so, not that it comes up by where they are. With some of each,
 * each kind has a sentence of its own.
 */
export function offRouteNote(offsM: number[], reachM: number = QUIET_REACH_M): string {
  const off = offsM.filter((m) => m > MAX_STOP_OFFSET_M)
  const byWhere = off.filter((m) => m > reachM)
  const along = off.filter((m) => m <= reachM)
  // With both kinds a lone one of either is 'one', as 'it' would not say which.
  const one = byWhere.length > 0 && along.length > 0 ? 'One is' : 'It is'
  const parts: string[] = []
  if (byWhere.length === 1) parts.push(`${one} ${Math.round(byWhere[0])} m from your route, so its alert comes up by where you are, whenever you are within the alert distance of it.`)
  else if (byWhere.length > 1) parts.push(`${byWhere.length} of them are off your route, so their alerts come up by where you are, whenever you are within the alert distance of them.`)
  if (along.length === 1) {
    parts.push(`${one} ${Math.round(along[0])} m from your route, so the list marks it off the route, but its alert still comes up as you drive past it, with the side it is on, which you can set in the list.`)
  } else if (along.length > 1) {
    parts.push(
      `${along.length} of them are more than ${MAX_STOP_OFFSET_M} m from your route, so the list marks them off the route, but their alerts still come up as you drive past them, with the side each is on, which you can set in the list.`,
    )
  }
  return parts.join(' ')
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
 * nearest bundle drop or special request, or else the nearest apartment block; and when everything is gone by, the no-throw house least
 * far behind, or else the other least far behind. A stop the driver has gone by does not outrank one that is still live, whatever it is: a
 * no-throw house just behind must not hide a bundle drop at the wheels, whose Dropped button is the only way to confirm it. `driven` is the
 * furthest the driver has got along the route, which doesn't go back, so a stop the driver has gone by isn't brought back by a wobble in
 * their position.
 *
 * An apartment block gives way to every other live stop, as it is shown in their banners (see `bannerBlock`): so it never hides a bundle
 * drop's Dropped button or a special request's note, and its papers are on screen all the same.
 *
 * What still waits: a no-throw house that is live is the alert, so a bundle drop shows only while no house is live. One with a house
 * before it shows once that house is gone by (and again once the house's zone is over). One with a house at the same spot or after it
 * is gone by no later than the house is, and from then a house outranks it again, so it shows only until the house comes into range,
 * and not at all for a house at the same spot. While it waits, the banner showing carries its Dropped button (see `bannerBundle`).
 */
export function pickCurrent(queue: Occurrence[], driven: number, along: number, pos: Pt | null, radius: Record<Stop['type'], number>): Occurrence | undefined {
  const ahead = (o: Occurrence) => aheadOf(o, Math.max(along, driven), pos, radius)
  const nearest = (pool: Occurrence[]) => pool.reduce((a, b) => (ahead(b) < ahead(a) ? b : a))
  const leastBehind = (pool: Occurrence[]) => pool.reduce((a, b) => (ahead(b) > ahead(a) ? b : a))
  const isNoThrow = (o: Occurrence) => o.stop.type === 'nothrow'
  const live = queue.filter((o) => ahead(o) > -HEAD_PASSED_M)
  if (live.length) {
    const houses = live.filter(isNoThrow)
    if (houses.length) return nearest(houses)
    const others = live.filter((o) => o.stop.type !== 'block')
    return nearest(others.length ? others : live)
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
export function quietHouseIds(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], reachM: number = QUIET_REACH_M): Set<string> {
  const allQuiet = new Map<string, boolean>()
  for (const o of occs) allQuiet.set(o.stop.id, (allQuiet.get(o.stop.id) ?? true) && quietReason(route, occs, o, reachM) !== null)
  return new Set([...allQuiet].filter(([, quiet]) => quiet).map(([id]) => id))
}

/** How many no-throw houses won't alert at all, as they are on transit stretches or on the side of the road that isn't thrown. */
export const quietNoThrows = (route: Pick<Route, 'points' | 'sideChanges' | 'stops'>, reachM: number = QUIET_REACH_M): number =>
  quietHouseIds(route, occurrences(route), reachM).size

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
 * For each time the route passes a stop, in route order: whether the side the list would show for it (see `stopRoadSides`) is only a
 * guess. That is a no-throw house sitting on the line of the road (see `stopSide`) with no side picked by hand: its alert takes it to be on
 * the side that is thrown there, since that is the side it matters on, but the map can't say which side of the road it is on. The list
 * must not show that as the house's own side: on a Port or Starboard stretch, as on Both, it asks for a side to be set. Any other kind of stop
 * has no side to show when it can't be told, so it is never a guess.
 *
 * It is judged on the leg whose side the list shows, the one the alert is for (see `alertLeg`): a house at the head of a court a metre or two
 * from the way back of the U-turn the app draws, but well to one side of the way in it alerts on, has a side that is no guess. `occs` are
 * all the occurrences of the route.
 */
export function sideGuessed(route: Pick<Route, 'points' | 'sideChanges'>, occs: Occurrence[], stopId: string): boolean[] {
  return occs
    .filter((o) => o.stop.id === stopId)
    .map((o) => o.stop.type === 'nothrow' && !o.stop.side && stopSide(route.points, alertLeg(route, occs, o), o.stop) === null)
}

/**
 * The no-throw houses and apartment blocks among `added` whose side of the road can't be told, in a route that includes them. A house that
 * is quiet on a transit stretch is not asked about, as it never alerts. One whose side can't be told alerts wherever it is
 * thrown (see `quietReason`), so the side is only for what the alert shows. An apartment block's side is said with its alert as well as
 * shown, so one on the line of the road is asked about too, except on a stretch that is only transit, like a house.
 */
export function stopsWithoutSide(route: Pick<Route, 'points' | 'sideChanges' | 'stops'>, added: Stop[], reachM: number = QUIET_REACH_M): Stop[] {
  const occs = occurrences(route)
  return added.filter(
    (s) =>
      (s.type === 'nothrow' || s.type === 'block') && !onlyInTransit(route, occs, s.id, reachM) && stopRoadSides(route, occs, s.id).every((side) => side === null),
  )
}

/** What to tell the driver when that many houses were added without a side. Empty when there are none. */
export function sideNote(count: number): string {
  if (count === 0) return ''
  return count === 1
    ? "Which side of the road it is on couldn't be told, so tap Set side on it in the list."
    : `Which side of the road ${count} of them are on couldn't be told, so tap Set side on each in the list.`
}
