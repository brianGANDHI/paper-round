import { plural } from './format'
import { bearing, occurrences, sideAt, stopSide, type Occurrence } from './geo'
import type { Route, Stop } from './types'

/** How near a stop you have to be, in metres, for its alert to come up. The driver picks one of these. */
export const ALERT_DISTANCES = [10, 20, 30, 40, 50, 60] as const

export type AlertDistance = (typeof ALERT_DISTANCES)[number]

export const DEFAULT_ALERT_DISTANCE: AlertDistance = 40

export const isAlertDistance = (v: unknown): v is AlertDistance => ALERT_DISTANCES.some((d) => d === v)

/**
 * The zone around a stop in which its banner shows: from this far before it until this far past it,
 * for either kind of stop.
 */
export const alertRadius = (distance: AlertDistance): Record<Stop['type'], number> => ({ nothrow: distance, bundle: distance })

/** Backing away only ends a banner this far outside the zone, so GPS jitter at its edge can't set it off again and again. */
export const BACK_OFF_SLACK_M = 15

/** Which way a stop's zone was left: on past the stop, or back the way the driver came. */
export type ZoneExit = 'passed' | 'back'

/**
 * Whether the driver has left a stop's zone, and which way. Null while still inside it.
 * `driverAt` is how far along the route the driver is, in metres.
 */
export function zoneExit(o: Occurrence, driverAt: number, radius: Record<Stop['type'], number>): ZoneExit | null {
  const ahead = o.at - driverAt
  const r = radius[o.stop.type]
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
 * What the banner for a stop says: the kind of stop, its name (what it was called, or a line that says what to do
 * when it was given no name) and, for a bundle drop with an amount, how many papers. Papers is null for anything else.
 */
export function alertText(stop: Stop): { title: string; name: string; papers: string | null } {
  const noThrow = stop.type === 'nothrow'
  return {
    title: noThrow ? 'No Throw' : 'Bundle Drop',
    name: stop.label ?? (noThrow ? 'This house does not want a paper.' : 'Bundle stop ahead.'),
    papers: !noThrow && stop.qty ? plural(stop.qty, 'paper', 'papers') : null,
  }
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

/**
 * The stops worth an alert. A no-throw house means nothing on a stretch where nothing is thrown at all,
 * so it stays quiet there. A bundle drop still alerts, as it has nothing to do with throwing.
 */
export const alertable = (route: Pick<Route, 'sideChanges'>, occs: Occurrence[]): Occurrence[] =>
  occs.filter((o) => !(o.stop.type === 'nothrow' && inTransit(route, o)))

/** Whether every time the route passes this stop is on a stretch where nothing is thrown. */
export function onlyInTransit(route: Pick<Route, 'sideChanges'>, occs: Occurrence[], stopId: string): boolean {
  const passes = occs.filter((o) => o.stop.id === stopId)
  return passes.length > 0 && passes.every((o) => inTransit(route, o))
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
