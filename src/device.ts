import { useEffect, useRef, useState } from 'react'
import type { Pt } from './types'

export interface Fix extends Pt {
  accuracy: number
  /** The way the phone says it is moving, in degrees clockwise from north, or null when it can't say (standing still, or no course yet). */
  heading: number | null
  /** How fast the phone says it is moving, in metres a second, or null when it can't say. */
  speed: number | null
  /** When the reading was taken, in milliseconds since 1970. */
  time: number
}

/** A GPS reading as the app keeps it. The phone's heading is only worth having while it is really moving, and in range. */
export function fixFrom(
  coords: { latitude: number; longitude: number; accuracy: number; heading?: number | null; speed?: number | null },
  time: number = Date.now(),
): Fix {
  const finite = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n)
  const speed = finite(coords.speed) && coords.speed >= 0 ? coords.speed : null
  const moving = speed !== null && speed >= MIN_HEADING_SPEED
  const heading = moving && finite(coords.heading) && coords.heading >= 0 && coords.heading < 360 ? coords.heading : null
  return { lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy, heading, speed, time }
}

/** Below this speed, in metres a second, the phone's idea of its heading is noise. */
export const MIN_HEADING_SPEED = 1.5

export function useGps(enabled: boolean) {
  const [fix, setFix] = useState<Fix | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (!('geolocation' in navigator)) {
      setError('GPS is not available on this device.')
      return
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setError(null)
        setFix(fixFrom(p.coords, p.timestamp))
      },
      (e) => setError(e.code === 1 ? 'Location permission denied.' : 'Waiting for GPS signal...'),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [enabled])

  return { fix, error }
}

/** Keep the screen on while `enabled`; GPS stops when iOS locks the screen. */
export function useWakeLock(enabled: boolean) {
  const [active, setActive] = useState(false)
  const lock = useRef<WakeLockSentinel | null>(null)

  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return
    let cancelled = false
    const acquire = async () => {
      try {
        const l = await navigator.wakeLock.request('screen')
        if (cancelled) return void l.release()
        lock.current = l
        setActive(true)
        l.addEventListener('release', () => setActive(false))
      } catch {
        setActive(false)
      }
    }
    const onVisible = () => document.visibilityState === 'visible' && acquire()
    acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      lock.current?.release()
    }
  }, [enabled])

  return active
}

/**
 * Whether this is Safari in an ordinary tab on an iPhone or iPad, as opposed to the app added to the Home
 * Screen. The two keep separate routes, so what is restored in one is not there in the other.
 */
export function inSafariTab(nav: { standalone?: boolean } = navigator as Navigator & { standalone?: boolean }): boolean {
  return nav.standalone === false
}
