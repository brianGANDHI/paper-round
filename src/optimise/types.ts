import type { Pt, Route, TurnStreet } from '../types'
import type { World } from './world'

/**
 * What the Optimise Route engine takes in and gives back. Everything here but `Prepared.world` is plain data, safe to post from a worker.
 * Sides keep their stored words: `left` is port and `right` is starboard, and the screens say which is which.
 */

export interface OsmNode {
  type: 'node'
  id: number
  lat: number
  lon: number
  tags?: Record<string, string>
}

export interface OsmWay {
  type: 'way'
  id: number
  nodes: number[]
  tags?: Record<string, string>
}

export interface OsmMember {
  type: string
  ref: number
  role: string
}

export interface OsmRelation {
  type: 'relation'
  id: number
  members: OsmMember[]
  tags?: Record<string, string>
}

export type OsmElement = OsmNode | OsmWay | OsmRelation

/** The answer to the one Overpass query: ways, their nodes and the turn restrictions on them. */
export interface OsmData {
  elements: OsmElement[]
  /** When the map's data dates from, as the server says: its `osm3s.timestamp_osm_base`. Left out when it doesn't say. */
  date?: string
}

/** A street as the driver sees it, for "Allow throwing starboard or both". */
export interface StreetChoice {
  /** What `OptimiseChoices.allowed` knows it by. It is not for showing. */
  key: string
  /** Its name, or a short stand-in when the road has none. */
  name: string
  /** How much of it is thrown at, in km of road. */
  km: number
  /** A main road, which is off by default and listed first. */
  main: boolean
  /** The default for this street: on for everything but a main road. */
  allowed: boolean
}

/** One route measured. Before and after are measured by the same code, so the two can be set side by side. */
export interface RouteStats {
  /** The route as drawn, in km. */
  km: number
  /** The route along the roads it matches, in km. A hand-drawn route cuts corners, so this is a little more than `km`. */
  mapKm: number
  /** By road from the route's end back to its start, in km: 0 when it closes. */
  closingKm: number
  /** `mapKm` and `closingKm` together: the figure to compare, as a route that doesn't close still has to get home. */
  closedKm: number
  /** Km of each side as the app reads them, by `sideAt`. `left` is port and `right` is starboard. */
  left: number
  right: number
  both: number
  transit: number
  /** Km of frontage thrown at more than once. */
  twiceKm: number
  /** U-turns as the app reads them, by `routeTurns`. */
  uturns: number
  /** Real changes of side: a row that repeats the side before it is not counted. */
  sideChanges: number
}

/** Where the new route starts and ends. */
export interface StartPoint extends Pt {
  /** The section it comes from, or null when the route has no section called Start and its first point is used. */
  section: string | null
}

/** What a run was based on, so a result can be refused when the route has changed since. See `isStale`. */
export interface BasedOn {
  routeId: string
  updatedAt: number
  fingerprint: string
}

/** A part of the old route that could not be matched to any road. */
export interface UnmatchedPart extends Pt {
  m: number
  /** Whether the old route threw papers along it, in which case Accept is blocked: see `OptimiseResult.blocked`. */
  thrown: boolean
  /** The street at the nearest place the route is on a road, for naming the spot. */
  street: string
}

/** A bundle in the list, for showing. */
export interface BundleName {
  id: string
  name: string
}

/** The plain part of the first step: what the choices screen shows. */
export interface PreparedView {
  basedOn: BasedOn
  start: StartPoint
  /** Main roads first, then the rest by name. */
  streets: StreetChoice[]
  before: RouteStats
  /** The bundles in the driver's list: their own order, or the app's default on the old route. */
  bundles: BundleName[]
  /** Whether that list is one the driver set. */
  bundleOrderSet: boolean
  unmatched: UnmatchedPart[]
  /** Anything else worth a line on the choices screen. */
  notes: string[]
}

/** What the first step produces. The worker keeps it between the two steps; only `view` goes to the screen. */
export interface Prepared {
  view: PreparedView
  world: World
}

/** The driver's choices. */
export interface OptimiseChoices {
  /** By `StreetChoice.key`: may this street be thrown starboard or both? A street left out takes its default. */
  allowed: Record<string, boolean>
  /** Keep the bundle list in its order, which is the default. Off gets the shortest route, and the list then follows the new drive. */
  keepOrder: boolean
}

/**
 * How long the search may take. A worker gives `ms`. A test gives `iterations`, or a `clock` of its own, so that a run takes the same
 * course every time. With the same seed and `iterations`, a run gives the same route.
 */
export interface Budget {
  /** Time for the whole of `solve`, in milliseconds. */
  ms?: number
  /** Where time comes from, in milliseconds. `Date.now` unless given. */
  clock?: () => number
  /** Moves for each stretch of the search, in place of time. */
  iterations?: number
  /** Where the random numbers start. */
  seed?: number
}

export const DEFAULT_BUDGET_MS = 20000

/** How far a step has got: a line for the screen, and how much of the step is done, from 0 to 1. */
export interface ProgressInfo {
  step: string
  done: number
}

export type OnProgress = (progress: ProgressInfo) => void

/** A stretch of street, for a line in a list. */
export interface StreetStretch extends Pt {
  street: string
  m: number
}

/** A stretch the old route threw at and the new one doesn't. */
export interface Gap extends StreetStretch {
  /** At the head of a dead end, where the old line looped round and the new route turns on a point. */
  atHead: boolean
}

/** A road the new route uses that the old one never drove. */
export interface NewRoad {
  street: string
  km: number
}

/** A place the new route turns back where there is no dead end to make it. */
export interface TurnBack extends Pt {
  street: string
  /** How awkward the spot is: `main` touches a main road, `busy` a busier through road, `plain` is a quiet street. */
  level: 'main' | 'busy' | 'plain'
  /** The old route turned back here too, so the driver already does it. */
  alsoToday: boolean
}

/** Something a person should look at on the ground, with its words ready to show. */
export interface WorthChecking extends StreetStretch {
  /** `gap`: the old route threw here and the new one doesn't. `one-side`: thrown on one side only, on a street otherwise thrown on both. */
  kind: 'gap' | 'one-side'
  text: string
}

/** What becomes of the bundle list. */
export interface BundleOutcome {
  /** The list as it stands today. */
  before: BundleName[]
  /** The list as it will read on the new route. */
  after: BundleName[]
  /** Whether the two differ. */
  changed: boolean
  /** Whether the list can be worked down in order along the new route: the kept list with Keep order on, and `before` with it off. */
  fits: boolean
  /** Bundles the new route has no pass of after the one before them in the list. */
  stranded: BundleName[]
  /** What Accept stores as `bundleOrder`: these ids, or null to remove it so the list follows the new drive. */
  store: string[] | null
}

/** All of a finished run. Accept is offered only when `blocked` is empty. */
export interface OptimiseResult {
  /** The new route: it starts and ends exactly on the start, in the app's own rounding, and its side changes follow `sideAt`. */
  route: Pick<Route, 'points' | 'sideChanges'>
  before: RouteStats
  after: RouteStats
  keepOrder: boolean
  /** Stretches the old route threw at and the new one doesn't, longest first. Any of 16 m or more also blocks Accept. */
  gaps: Gap[]
  gapKm: number
  newRoads: NewRoad[]
  newRoadKm: number
  turnBacks: TurnBack[]
  /** Why Accept is blocked, in plain words. Empty when it isn't. */
  blocked: string[]
  notes: string[]
  worthChecking: WorthChecking[]
  bundles: BundleOutcome
  /** Names for the new route's turns, read from the map in hand so no lookups are needed. */
  streets: TurnStreet[]
  basedOn: BasedOn
}
