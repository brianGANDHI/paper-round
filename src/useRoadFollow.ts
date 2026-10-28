import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { arrivalBearing, canFollow, extendAlongRoads, undoStretch, uturnAvailable, uturnIsOn, type Stretch } from './roads'
import { appendPoint } from './routeEdit'
import type { Pt, Route, Side } from './types'

/** How many stretches of road can be taken back one by one. */
const HISTORY = 50

interface Options {
  route: Route
  /** The side the next stretch is thrown on. */
  side: Side
  /** False once drawing with Follow roads stops, which ends any lookup still running. */
  active: boolean
  onRoute: (route: Route) => void
  onNotice: (message: string | null) => void
}

/**
 * Taps that follow roads. One lookup runs at a time, from the route's last point to the tap, and its
 * result is added to the route when it comes back. Cancel it, change the route, or stop following,
 * and the lookup is abandoned without touching the route.
 *
 * U-turn is a switch for the next tap: the road then leaves the route's last point heading back the way the route
 * arrived, so it turns round there instead of going round the block. It belongs to the end of the route it was switched
 * on at, so it goes off by itself when the tap it was for is added (or drawn straight), and when the end of the route
 * changes by an undo, a deleted or moved point or a cleared route, and when following roads stops. A tap that is
 * cancelled, or that adds nothing, leaves it on.
 */
export function useRoadFollow({ route, side, active, onRoute, onNotice }: Options) {
  /** The tap whose road is being looked up. */
  const [finding, setFinding] = useState<Pt | null>(null)
  const running = useRef<AbortController | null>(null)
  const latest = useRef(route)
  /** What each tap added, newest last, so Undo can take back a whole stretch of road. */
  const history = useRef<Stretch[]>([])
  /** The end of the route when U-turn was switched on, or null while it is off. */
  const [uturnAt, setUturnAt] = useState<Pt | null>(null)
  const uturn = uturnIsOn(uturnAt, route.points, active)
  const canUturn = uturnAvailable(route.points, active)

  // Once the switch has gone off (see above) forget where it was set, or an undo back to that end would switch it on again.
  if (uturnAt && !uturn) setUturnAt(null)

  useLayoutEffect(() => {
    latest.current = route
  })

  const cancel = useCallback(() => {
    running.current?.abort()
    running.current = null
    setFinding(null)
  }, [])

  // A lookup belongs to the route as it was tapped: edit the route, stop following or leave, and it ends.
  useEffect(() => cancel, [route, active, cancel])

  /** A tap on the map while following roads. */
  const tap = (p: Pt) => {
    if (running.current) return
    if (!canFollow(route, p)) {
      // The first point has nothing to follow from, and a tap on the last point adds nothing.
      const next = appendPoint(route, p, side)
      if (next !== route) onRoute(next)
      return
    }
    const lookup = new AbortController()
    running.current = lookup
    setFinding(p)
    const uturnFrom = uturn ? (arrivalBearing(route.points) ?? undefined) : undefined
    extendAlongRoads(route, p, side, { signal: lookup.signal, uturnFrom }).then(
      (done) => {
        // Cancelled, or the route was edited in the meantime: the answer no longer fits it.
        if (running.current !== lookup || latest.current !== route) return
        running.current = null
        setFinding(null)
        if (done.added.length) history.current = [...history.current, { added: done.added, replaced: done.replaced }].slice(-HISTORY)
        if (done.route !== route) onRoute(done.route)
        onNotice(done.notice)
      },
      () => {
        if (running.current === lookup) cancel()
      },
    )
  }

  /**
   * Undo for a route drawn with roads. A lookup in progress is cancelled; otherwise the last tap is taken
   * back whole. False when there is no such tap, and the caller removes the last point as usual.
   */
  const undo = () => {
    if (running.current) {
      cancel()
      return true
    }
    const undone = undoStretch(route, history.current)
    if (!undone) return false
    history.current = undone.history
    onRoute(undone.route)
    onNotice(null)
    return true
  }

  /** Records a stretch added some other way, such as a route by address, so Undo takes it back whole too. */
  const remember = (stretch: Stretch) => {
    history.current = [...history.current, stretch].slice(-HISTORY)
  }

  /** Switch U-turn on for the next tap, or off. Only where it can be asked for, and not while a road is being looked up. */
  const setUturn = (on: boolean) => {
    if (running.current) return
    setUturnAt(on && canUturn ? route.points[route.points.length - 1] : null)
  }

  return { finding, tap, undo, remember, uturn, canUturn, setUturn }
}
