import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { canFollow, extendAlongRoads, undoStretch, type Stretch } from './roads'
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
 */
export function useRoadFollow({ route, side, active, onRoute, onNotice }: Options) {
  /** The tap whose road is being looked up. */
  const [finding, setFinding] = useState<Pt | null>(null)
  const running = useRef<AbortController | null>(null)
  const latest = useRef(route)
  /** What each tap added, newest last, so Undo can take back a whole stretch of road. */
  const history = useRef<Stretch[]>([])

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
    extendAlongRoads(route, p, side, { signal: lookup.signal }).then(
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

  return { finding, tap, undo, remember }
}
