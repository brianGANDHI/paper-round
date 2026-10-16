import type { Occurrence } from './geo'
import type { Stop } from './types'

/**
 * How far past a stop the driver can get before its banner clears itself. A no-throw warning is no
 * use once the house is behind you. A bundle drop gets longer, because the car may stop a little way
 * along and the driver needs time to tap Handled.
 */
export const CLEARS_AFTER_M: Record<Stop['type'], number> = { nothrow: 30, bundle: 60 }

/**
 * Whether an alert is still worth showing: its stop is ahead, or only just behind.
 * `driverAt` is how far along the route the driver is, in metres.
 */
export const stillAhead = (o: Occurrence, driverAt: number): boolean => o.at - driverAt >= -CLEARS_AFTER_M[o.stop.type]

/** How far away a stop is, for the banner: "120 m", "Now" when it is right here, "Passed" once it is behind. */
export function aheadText(ahead: number): string {
  if (ahead <= -10) return 'Passed'
  if (ahead < 15) return 'Now'
  return `${Math.round(ahead / 10) * 10} m`
}
