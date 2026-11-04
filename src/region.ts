import type { Pt } from './types'

/** Where the map opens until it knows where you are or where your route is. */
export const AUSTRALIA = {
  center: { lat: -25.27, lng: 133.78 },
  /** Used only for the first frame; the map then fits `bounds`. */
  zoom: 4,
  /** South-west and north-east corners of the country, Tasmania included. */
  bounds: [
    { lat: -43.8, lng: 112.9 },
    { lat: -10, lng: 153.9 },
  ] satisfies Pt[],
  /** Nominatim viewbox (left,top,right,bottom) that nudges searches toward Australia. */
  viewbox: '112.5,-9,154.5,-44.5',
}

/** Traffic keeps to the left: true for Australia, the only region the app has. */
export const DRIVES_ON_LEFT = true

/**
 * Which way round a U-turn goes on this region's roads, as the sign of its angle (positive is to the right): to the right where traffic
 * keeps left, so the car crosses to the far side of the road and comes back on its own side. It is the way a U-turn is drawn
 * (`localUturn`) and the way one that doubles straight back along its own line is read (`routeTurns`), where the line itself gives no side.
 */
export const UTURN_WAY: 1 | -1 = DRIVES_ON_LEFT ? 1 : -1
