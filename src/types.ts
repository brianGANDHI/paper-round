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
}

/** A route kept on the phone, with its own progress through the current run. */
export interface SavedRoute {
  id: string
  name: string
  route: Route
  round: RoundState
  /** When the route itself was last changed, in ms since 1970. 0 when unknown. */
  updatedAt: number
}

/** Everything saved on the phone: every route, and which one is in use. */
export interface Library {
  routes: SavedRoute[]
  activeId: string
}
