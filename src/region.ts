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
