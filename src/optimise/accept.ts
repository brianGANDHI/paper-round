import { alertable, firstLeg, opposite, roundCounts } from '../alerts'
import { angleBetween, bearing, haversine, occurrences, passesNear, pathLength, type Occurrence } from '../geo'
import { activeRoute, editActiveRoute, keepCopy, labelledName, normalizeStreets, renameRoute, setActiveSections, setActiveStreets, setBundleOrder } from '../library'
import { anchorAt, ANCHOR_MAX_M, resolveSections, SECTION_GAP_M } from '../namedSections'
import { continueFrom } from '../resume'
import { nearestOnRoute, normalizeRoute } from '../routeEdit'
import { pruneStreets, streetFor } from '../streets'
import { routeTurns } from '../turns'
import type { Library, NamedSection, Pt, Route, SavedRoute, Stop, TurnStreet } from '../types'
import { isStale, isStartSection } from './run'
import type { OptimiseResult } from './types'

/**
 * Accept: the old route kept as it was, and the new one in its place. It is written straight onto the library, with the same functions the
 * screens use. Restoring a backup can't be the way in, as a backup with no bundle order leaves a route's own order alone, and Accept has to be able to take one off.
 */

/** What the copy of the old route says after its name. */
const BEFORE_LABEL = 'before optimise'
/** That label at the end of a name, numbered or not, as `labelledName` writes it: a route called this is a copy Accept kept. */
const LABELLED = new RegExp(` \\(${BEFORE_LABEL}(?: \\d+)?\\)$`)
/** A way along the route is read from a piece at least this long, in metres: anything shorter is no way to speak of, and the rounding of its ends decides it. */
const WAY_MIN_M = 1
/** Past this many degrees apart, two ways along a road are opposite ways along it, as `sameWay` has it. */
const OPPOSITE_DEG = 90

/** Why a result can't be accepted, in plain words. */
export const STALE_REASON = 'The route has changed since this was worked out, so nothing was changed. Run Optimise Route again.'
/**
 * Why Accept changed nothing when the phone would not keep the new route beside the old one. It says to run again, not to try again, as the screen
 * keeps Accept off for a run it has been refused once.
 */
export const NO_ROOM_REASON = 'There is no room left on this phone for both routes, so nothing was changed. Delete a route you no longer need, then run Optimise Route again.'
/** Why Accept changed nothing when the phone keeps nothing at all, as in a private tab, where deleting a route would not help. */
export const NO_SAVE_REASON = "This phone isn't letting the app save, so nothing was changed. Open the app in a normal (not private) tab, then run Optimise Route again."
/** What the screen says before Accept when a round is under way. */
export const ROUND_RESET_WARNING = 'Your round in progress will start over.'

/**
 * Whether a route has a round to carry on, which Accept starts over: there is something left to do, and some of it is done or it has been started or
 * driven some way, as the Round screen has it. A round that was finished keeps what was done until the next one starts, and has nothing to lose.
 * It is as near to that screen as can be without what only the screen knows: a round that reached the end with only bundles left, which the screen
 * starts afresh, is still warned of, which does no harm. It goes through every pass of the route, which takes a long route a moment, so the sheet
 * works it out once rather than on every draw.
 *
 * `reachM` is how far from the route a no-throw house is kept quiet, as on the Round screen: `quietReachFor` the alert distance the driver chose. It has
 * to be the screen's. A house further out than the shortest reach but within the driver's is never alerted for or marked done on a stretch that isn't
 * thrown, so at a shorter reach it would be a stop still to do on a round the screen calls finished.
 */
export function roundInProgress({ route, round }: Pick<SavedRoute, 'route' | 'round'>, reachM: number): boolean {
  const all = occurrences(route)
  const handled = new Set(round.handledStopIds)
  const { remaining, done } = roundCounts(alertable(route, all, reachM), handled)
  return remaining > 0 && (done > 0 || continueFrom(round, all, handled) > 0)
}

/** How Accept went. */
export type AcceptOutcome =
  | {
      ok: true
      library: Library
      /** The copy of the old route: its id, and the name it has in the Routes list. */
      kept: { id: string; name: string }
      /** The named sections that could not be placed on the new route, by name. They stay on the copy of the old route. */
      unplaced: string[]
    }
  | { ok: false; reason: string }

/** The way the route runs along a segment: along it, or the next piece long enough to have a way. */
function wayAlong(points: Pt[], idx: number): number {
  for (let i = idx; i + 1 < points.length; i++) if (haversine(points[i], points[i + 1]) >= WAY_MIN_M) return bearing(points[i], points[i + 1])
  return bearing(points[idx], points[idx + 1] ?? points[idx])
}

/** Each stop's first pass of a route. */
function firstPasses(route: Pick<Route, 'points' | 'stops'>): Map<string, Occurrence> {
  const firsts = new Map<string, Occurrence>()
  for (const o of occurrences(route)) if (!firsts.has(o.stop.id)) firsts.set(o.stop.id, o)
  return firsts
}

/**
 * The stops on the new line, the same stops with the same ids. `pathIdx` is what the app means by it wherever it places a stop: the segment nearest
 * it, whatever pass that is. A side picked by hand is the side as you first drive past (see `firstLeg`), so where the first pass now runs the other way
 * along the road, it swaps: the stop itself hasn't moved.
 */
function movedStops(old: Route, points: Pt[]): Stop[] {
  const picked = old.stops.filter((s) => s.side)
  const was = firstPasses({ points: old.points, stops: picked })
  const now = firstPasses({ points, stops: picked })
  return old.stops.map((stop) => {
    const moved: Stop = { ...stop, pathIdx: nearestOnRoute({ points }, stop)?.idx ?? 0 }
    const before = was.get(stop.id)
    const after = now.get(stop.id)
    if (stop.side && before && after && angleBetween(wayAlong(old.points, firstLeg(before)), wayAlong(points, firstLeg(after))) > OPPOSITE_DEG) moved.side = opposite(stop.side)
    return moved
  })
}

/** A place a section could start on the new route: anchored there, and how far along that is. */
interface Spot {
  section: NamedSection
  at: number
}

/** The places on the new route a section could start: every pass of its spot that is near enough, is `anchorAt` willing, and has road left after it. */
function spotsFor(section: NamedSection, points: Pt[], length: number): Spot[] {
  const spots: Spot[] = []
  for (const pass of passesNear(points, section)) {
    if (pass.off > ANCHOR_MAX_M || pass.at > length - SECTION_GAP_M) continue
    const anchored = anchorAt(points, pass.at, section.name, section.id)
    if (!anchored) continue
    // Found again by its own spot and pass, which is where it will really be: `pass` above is a pass of the old route's spot.
    const again = passesNear(points, anchored)[(anchored.pass ?? 1) - 1]
    if (again) spots.push({ section: anchored, at: again.at })
  }
  return spots.sort((a, b) => a.at - b.at)
}

/**
 * As many of the sections as will go in their order, each `SECTION_GAP_M` or more after the one before, and null for the others. Taking the first place
 * each one fits would let one early section with its only pass near the end of the route push out all those after it, so this finds the most that fit:
 * of those as many, the one that gives the earlier sections a place, each as soon as it can be.
 */
function mostInOrder(options: Spot[][]): (Spot | null)[] {
  const best = options.map((spots) => spots.map(() => ({ count: 1, next: null as [number, number] | null })))
  for (let i = options.length - 1; i >= 0; i--) {
    options[i].forEach((spot, s) => {
      for (let j = i + 1; j < options.length; j++) {
        options[j].forEach((later, l) => {
          if (later.at - spot.at >= SECTION_GAP_M && best[j][l].count + 1 > best[i][s].count) best[i][s] = { count: best[j][l].count + 1, next: [j, l] }
        })
      }
    })
  }
  const picked: (Spot | null)[] = options.map(() => null)
  const most = Math.max(0, ...best.flat().map((b) => b.count))
  const first = best.findIndex((spots) => spots.some((b) => b.count === most))
  if (first < 0) return picked
  for (let at: [number, number] | null = [first, best[first].findIndex((b) => b.count === most)]; at; at = best[at[0]][at[1]].next) picked[at[0]] = options[at[0]][at[1]]
  return picked
}

/**
 * The places on the new route for the section the run started at. The new route was made to start there, so it goes at metre 0, whichever passes
 * of its old spot the new route makes: the depot is the nearest node to the spot, and the route can leave it the other way. Only if it can't be
 * anchored at 0 is it given the places its spot is passed.
 */
function startSpots(section: NamedSection, points: Pt[], length: number): Spot[] {
  const there = anchorAt(points, 0, section.name, section.id)
  return there ? [{ section: there, at: 0 }] : spotsFor(section, points, length)
}

/** Where a section starts on a route when it is placed there on its own, with no other section in the way. Undefined when it lies off the route. */
const startAlone = (points: Pt[], section: NamedSection): number | undefined => resolveSections(points, [section]).list.find((r) => !r.lead)?.startM

/**
 * The named sections on the new route, in their order, each anchored afresh so that no pass number is carried across from the old route, where it
 * meant something else. The new route starts at the section called Start that the run started at (the first one stored, as `startOf` takes it),
 * so that one goes first, and the others follow in their order from where it was on the old route, coming round. It counts even where it could not
 * be placed on the old route, as the run started there all the same. Those that can't go in order, or that lie off the new route, are left off it
 * and named, as are any that already couldn't be placed on the old route: put back at their spots anyway, they would come out scrambled.
 */
function placedSections(saved: SavedRoute, points: Pt[]): { sections: NamedSection[]; unplaced: string[] } {
  const stored = saved.sections ?? []
  const head = stored.find(isStartSection)
  const { list, detached } = resolveSections(saved.route.points, stored)
  const others = list.flatMap((r) => stored.filter((s) => s.id === r.id && s !== head).map((section) => ({ section, at: r.startM })))
  const headAt = head && (list.find((r) => r.id === head.id)?.startM ?? startAlone(saved.route.points, head))
  const from = headAt === undefined ? 0 : Math.max(0, others.findIndex((o) => o.at >= headAt))
  const order = [...(head ? [head] : []), ...[...others.slice(from), ...others.slice(0, from)].map((o) => o.section)]
  const length = pathLength(points)
  const picked = mostInOrder(order.map((s) => (s === head ? startSpots(s, points, length) : spotsFor(s, points, length))))
  return {
    sections: picked.flatMap((p) => (p ? [p.section] : [])),
    unplaced: [...detached.filter((d) => d.section !== head).map((d) => d.section.name), ...order.filter((_, i) => !picked[i]).map((s) => s.name)],
  }
}

/** The sections a new line would leave off, by name, so the results can say so before Accept, which places them the same way. */
export const unplacedSections = (saved: SavedRoute, points: Pt[]): string[] => placedSections(saved, points).unplaced

/** The names kept that the new route's turns still use, and the map's name for every other turn, so no turn is left to look up. */
function namedTurns(points: Pt[], kept: readonly TurnStreet[], found: readonly TurnStreet[]): TurnStreet[] {
  const pruned = pruneStreets(points, routeTurns(points), kept)
  return normalizeStreets([...pruned, ...found.filter((f) => !streetFor(f, f.out, pruned))])
}

/**
 * Puts a finished run into the library: the old route kept as a copy with everything that goes with it, and the route in use changed to the new one, which
 * stays the route in use. It is refused, with nothing changed, if the route has changed since the run started, or if the run says Accept is blocked. The
 * round on the route in use starts over, as it does for any edit: the stops' places along the route are all new. See `roundInProgress` for warning the
 * driver. The copy keeps the round as it was (see `keepCopy`), so going back to it loses nothing.
 *
 * The label goes on the route that really is the old one. A route that is itself a copy Accept kept, gone back to and optimised again, is still the
 * old route, so its copy keeps the name it has, and the route in use, which is new, loses the label.
 */
export function acceptOptimised(library: Library, result: OptimiseResult, now = Date.now()): AcceptOutcome {
  const saved = activeRoute(library)
  if (isStale(saved, result.basedOn)) return { ok: false, reason: STALE_REASON }
  if (result.blocked.length) return { ok: false, reason: result.blocked[0] }
  const plain = saved.name.replace(LABELLED, '')
  const relabel = plain !== saved.name
  const held = keepCopy(library, saved, relabel ? saved.name : labelledName(library, saved.name, BEFORE_LABEL), now)
  const { points, sideChanges } = result.route
  const route = normalizeRoute({ points, sideChanges, stops: movedStops(saved.route, points) })
  const { sections, unplaced } = placedSections(saved, points)
  const streets = namedTurns(points, saved.streets ?? [], result.streets)
  const edited = editActiveRoute(held.library, route, now)
  // An empty order takes the key off, and the app's list then follows the new drive.
  const next = setBundleOrder(setActiveStreets(setActiveSections(edited, sections), streets), saved.id, result.bundles.store ?? [])
  // The name is made one no other route has, as the plain one may be taken by the route this one was kept from.
  return { ok: true, library: relabel ? renameRoute(next, saved.id, plain) : next, kept: { id: held.copy.id, name: held.copy.name }, unplaced }
}
