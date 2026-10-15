export interface Pt {
  lat: number
  lng: number
}

export type Side = 'both' | 'left' | 'right'
export type StopType = 'bundle' | 'nothrow'

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
  label?: string
}

export interface Route {
  points: Pt[]
  sideChanges: SideChange[]
  stops: Stop[]
}

export interface RoundState {
  handledStopIds: string[]
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
