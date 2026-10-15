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
