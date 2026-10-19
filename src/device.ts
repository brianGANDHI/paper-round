import { useEffect, useRef, useState } from 'react'
import type { Pt } from './types'

export interface Fix extends Pt {
  accuracy: number
}

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
        setFix({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy })
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

let audio: AudioContext | null = null

/** Call from a tap handler: iOS only allows audio after a user gesture. */
export function unlockAudio() {
  try {
    audio ??= new (window.AudioContext ?? (window as any).webkitAudioContext)()
    void audio.resume()
  } catch {
    // Audio unavailable; visual alerts still work.
  }
}

function beep(freq: number, start: number, dur: number) {
  if (!audio) return
  const o = audio.createOscillator()
  const g = audio.createGain()
  o.frequency.value = freq
  g.gain.value = 0.3
  o.connect(g).connect(audio.destination)
  o.start(audio.currentTime + start)
  o.stop(audio.currentTime + start + dur)
}

export function alertBundle() {
  beep(880, 0, 0.15)
  navigator.vibrate?.(200)
}

/** A special request: two notes going up, to tell it from a bundle drop's single beep and a no-throw house's three. */
export function alertRequest() {
  beep(660, 0, 0.12)
  beep(880, 0.17, 0.2)
  navigator.vibrate?.([120, 80, 120])
}

/** iOS Safari has no Vibration API, so the sound and red flash carry this alert. */
export function alertNoThrow() {
  beep(440, 0, 0.25)
  beep(440, 0.35, 0.25)
  beep(440, 0.7, 0.25)
  navigator.vibrate?.([300, 150, 300, 150, 300])
}

/**
 * Whether this is Safari in an ordinary tab on an iPhone or iPad, as opposed to the app added to the Home
 * Screen. The two keep separate routes, so what is restored in one is not there in the other.
 */
export function inSafariTab(nav: { standalone?: boolean } = navigator as Navigator & { standalone?: boolean }): boolean {
  return nav.standalone === false
}
