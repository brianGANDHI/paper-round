import { passesNear, type PathPass } from './geo'
import { formatDistance } from './routeEdit'
import type { Pt } from './types'

/**
 * Each time the route goes by a spot, within one stretch of it when `within` is given (the first and last points of the
 * stretch). More than one means a road driven more than once there, so a tap on it doesn't say which time is meant.
 */
export function passesAt(points: Pt[], spot: Pt, within?: { idx: number; endIdx: number }): PathPass[] {
  return passesNear(points, spot).filter((p) => !within || (p.idx >= within.idx && p.idx < within.endIdx))
}

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth']

/** What to call a pass in a list of the times the route goes by a spot: the time it is, and how far along the route it is. */
export function passLabel(n: number, at: number): { label: string; detail: string } {
  return { label: `The ${ORDINAL[n] ?? `${n + 1}th`} time through`, detail: `${formatDistance(at)} along the route` }
}
