export interface Pt {
  lat: number
  lng: number
}

/**
 * What is thrown along a stretch of the route: both sides, the left, the right, or nothing at all.
 * Transit is only driving, such as between the places papers are delivered.
 */
export const SIDES = ['both', 'left', 'right', 'transit'] as const
export type Side = (typeof SIDES)[number]
export const isSide = (v: unknown): v is Side => SIDES.some((s) => s === v)
/** A bundle drop, a house that doesn't want a paper thrown, or a special request: somewhere that needs something done by hand. */
export type StopType = 'bundle' | 'nothrow' | 'request'

/** Side applies from `idx` along the path until the next change. */
export interface SideChange {
  idx: number
  side: Side
}

export interface Stop extends Pt {
  id: string
  /** Index of the nearest path segment start. */
  pathIdx: number
  type: StopType
  qty?: number
  /** For a special request, what to do there: "Blue gate, deliver by hand". */
  note?: string
  /** What the place is called, such as the name of a business. */
  label?: string
  /** Where it is, as an address to read. The stop's position on the map is its own latitude and longitude. */
  address?: string
  /**
   * Which side of the road the stop is on, as you first drive past it, when it was picked by hand
   * because the map can't say or has it wrong. Going the other way it swaps.
   */
  side?: 'left' | 'right'
}

export interface Route {
  points: Pt[]
  sideChanges: SideChange[]
  stops: Stop[]
}

export interface RoundState {
  handledStopIds: string[]
  /** The furthest the round has got along the route, in metres, kept so that carrying on later starts from there. */
  furthest?: number
  /** Where along the route, in metres, the round was started or last skipped to, so that carrying on later starts from there. */
  startM?: number
  /**
   * The bundle drops the driver confirmed with "Dropped", by the same keys as `handledStopIds`. Always a subset of the stops done
   * and never also in `missed`: see `reconcile` in bundles.ts. Left out when there are none, and by rounds saved before it existed.
   */
  dropped?: string[]
  /**
   * The bundle drops the driver drove past with no confirmation, by the same keys. A subset of the stops done, apart from `dropped`.
   * A bundle done that is in neither was skipped over (by skipping ahead, carrying on from a spot, or catching up). Left out when none.
   */
  missed?: string[]
}

/**
 * A named part of the route, from a spot on it to the next such spot (or the end), such as the name of a street or an estate.
 * It is held by where the spot is on the map and which pass of that spot it is, not by an index along the route, so it
 * stays put when the route is edited.
 */
export interface NamedSection {
  id: string
  name: string
  lat: number
  lng: number
  /** Which time the route goes by this spot, 1 for the first. Left out for the first. */
  pass?: number
}

/**
 * The name of the street a turn leads into, found once from the map data and kept: the turn is held by where it is and
 * the way it leaves, in whole degrees clockwise from north, so it is still found after the route is edited. An empty
 * name means it was looked up and the road has none.
 */
export interface TurnStreet {
  lat: number
  lng: number
  out: number
  name: string
}

/** A route kept on the phone, with its own progress through the current run. */
export interface SavedRoute {
  id: string
  name: string
  route: Route
  round: RoundState
  /** When the route itself was last changed, in ms since 1970. 0 when unknown. */
  updatedAt: number
  /** The route's named parts, if any have been given names. Kept beside the route so editing the route never drops them. */
  sections?: NamedSection[]
  /** The street names of the route's turns, if looked up. Kept beside the route for the same reason. */
  streets?: TurnStreet[]
}

/** Everything saved on the phone: every route, and which one is in use. */
export interface Library {
  routes: SavedRoute[]
  activeId: string
}
