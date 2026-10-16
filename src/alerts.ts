import type { Occurrence } from './geo'
import type { Stop } from './types'

/** How close you have to be to a stop before its banner shows, which the driver can change before a round. */
export type AlertDistance = 'close' | 'normal' | 'far'

export const ALERT_DISTANCES: { value: AlertDistance; label: string }[] = [
  { value: 'close', label: 'Close' },
  { value: 'normal', label: 'Normal' },
  { value: 'far', label: 'Far' },
]

export const DEFAULT_ALERT_DISTANCE: AlertDistance = 'normal'

/**
 * The zone around a stop, in metres, in which its banner shows: from this far before it until this
 * far past it. A bundle drop gets more room than a no-throw house, as the car has to stop for it.
 */
export const ALERT_RADIUS: Record<AlertDistance, Record<Stop['type'], number>> = {
  close: { nothrow: 25, bundle: 40 },
  normal: { nothrow: 40, bundle: 60 },
  far: { nothrow: 70, bundle: 100 },
}

/** Backing away only ends a banner this far outside the zone, so GPS jitter at its edge can't set it off again and again. */
export const BACK_OFF_SLACK_M = 15

/** Which way a stop's zone was left: on past the stop, or back the way the driver came. */
export type ZoneExit = 'passed' | 'back'

/**
 * Whether the driver has left a stop's zone, and which way. Null while still inside it.
 * `driverAt` is how far along the route the driver is, in metres.
 */
export function zoneExit(o: Occurrence, driverAt: number, radius: Record<Stop['type'], number>): ZoneExit | null {
  const ahead = o.at - driverAt
  const r = radius[o.stop.type]
  if (ahead < -r) return 'passed'
  if (ahead > r + BACK_OFF_SLACK_M) return 'back'
  return null
}

/** How far away a stop is, for the banner: "40 m", "Now" when it is right here, "Passed" once it is behind. */
export function aheadText(ahead: number): string {
  if (ahead <= -10) return 'Passed'
  if (ahead < 15) return 'Now'
  return `${Math.round(ahead / 10) * 10} m`
}
