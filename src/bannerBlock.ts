import { aheadOf, alertSide, approachSide, isGoneBy, type RoadSide } from './alerts'
import { byPosition, type Occurrence } from './geo'
import type { Pt, Route, Stop } from './types'

/*
 * What the alert banner at the top of the round shows besides the stop it is for, kept apart from the screen so it can be tested. An
 * apartment block's banner is the one place on the round where its number of papers shows (the voice is off unless the driver turns it
 * on). Every other live stop outranks it (see `pickCurrent`): a no-throw house's banner is what stops a paper going to the wrong house, a
 * bundle drop's has the Dropped button that is the only way to confirm it, and a special request's has what to do there. So a block near
 * one of them would be hidden for as long as that stop is live, and one at the same spot never shown. While any other stop is the banner,
 * a block still to come is shown in it too, as a strip of its own, and the other banner is never hidden for it.
 */

/**
 * The side of the road a stop is shown and said on: as the route passes it (see `alertSide`), or for one met by where the driver is (see
 * `byPosition`) as the driver at `pos`, heading `heading`, comes up to it (see `approachSide`). Null when it can't be told.
 */
export function shownSide(
  route: Pick<Route, 'points' | 'sideChanges'>,
  allOccs: Occurrence[],
  o: Occurrence,
  radius: Record<Stop['type'], number>,
  heading: number | null,
  pos: Pt | null,
): RoadSide | null {
  return byPosition(o, radius) ? approachSide(heading, pos, o.stop) : alertSide(route, allOccs, o)
}

/**
 * The apartment block to show inside the banner of another stop: while `current` (the alert showing, see `pickCurrent`) is a no-throw
 * house, a bundle drop or a special request, the nearest block in the queue that the driver has not gone by (see `isGoneBy`). Null when the
 * banner is a block's own, when there is none, or when no such block is queued. With the block's own banner while nothing else is live,
 * its papers are on screen from when it comes up until it is gone by, wherever the other stops are. `driven`, `along` and `pos` are as
 * `pickCurrent` takes them.
 */
export function bannerBlock(
  queue: readonly Occurrence[],
  current: Occurrence | undefined,
  driven: number,
  along: number,
  pos: Pt | null,
  radius: Record<Stop['type'], number>,
): Occurrence | null {
  if (!current || current.stop.type === 'block') return null
  const ahead = (o: Occurrence) => aheadOf(o, Math.max(along, driven), pos, radius)
  const blocks = queue.filter((o) => o.stop.type === 'block' && !isGoneBy(o, driven, along, pos, radius))
  return blocks.length ? blocks.reduce((a, b) => (ahead(b) < ahead(a) ? b : a)) : null
}

/**
 * The bundle drop to carry in the banner of another stop: while `current` (the alert showing, see `pickCurrent`) is not a bundle's, the bundle alert in the queue, gone by or not. A live
 * no-throw house is always the alert, so a bundle at the same spot as one would never get its banner, and its Dropped button is the only way to confirm it: without it a driver who did
 * everything right has it counted missed, and on a street driven again it stays next and holds up every bundle after it. Null when there is none, or the banner is a bundle's own.
 */
export const bannerBundle = (queue: readonly Occurrence[], current: Occurrence | undefined): Occurrence | null =>
  !current || current.stop.type === 'bundle' ? null : (queue.find((o) => o.stop.type === 'bundle') ?? null)

/**
 * How many alerts are waiting behind the banner, for its badge: the stops in the queue that it does not show (`shown`: the row of houses
 * it is for, and a block or a bundle drop shown in it), leaving out those the driver has gone by, which are only waiting to go.
 */
export function bannerWaiting(
  queue: readonly Occurrence[],
  shown: readonly Pick<Occurrence, 'key'>[],
  driven: number,
  along: number,
  pos: Pt | null,
  radius: Record<Stop['type'], number>,
): number {
  const keys = new Set(shown.map((o) => o.key))
  return queue.filter((o) => !keys.has(o.key) && !isGoneBy(o, driven, along, pos, radius)).length
}
