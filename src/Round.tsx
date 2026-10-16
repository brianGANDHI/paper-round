import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertBanner } from './AlertBanner'
import { ALERT_DISTANCES, ALERT_RADIUS, zoneExit, type AlertDistance } from './alerts'
import { SIDE_LABEL, SIDE_PILL } from './colors'
import { useDialogs } from './confirm'
import { alertBundle, alertNoThrow, unlockAudio, useGps, useWakeLock } from './device'
import { plural } from './format'
import {
  alongPath,
  approachingOccurrences,
  bearing,
  cumulativeDistances,
  haversine,
  occurrences,
  sideAt,
  snapToPath,
  stopSide,
  type Occurrence,
} from './geo'
import { Icon } from './Icon'
import { MapView } from './MapView'
import { formatDistance, routeLength } from './routeEdit'
import { loadAlertDistance, saveAlertDistance } from './storage'
import { RouteChip, Segmented } from './ui'
import type { Pt, RoundState, Route } from './types'

/** The phone must move this far before its direction of travel is worked out again, so GPS jitter doesn't turn it. */
const HEADING_MIN_M = 8

interface Props {
  route: Route
  round: RoundState
  /** Name of the route in use, shown so the wrong round isn't run by mistake. */
  routeName: string
  onRound: (r: RoundState) => void
  onGoSetup: () => void
  onGoRoutes: () => void
}

export function Round({ route, round, routeName, onRound, onGoSetup, onGoRoutes }: Props) {
  const [started, setStarted] = useState(false)
  const [overview, setOverview] = useState(false)
  // Alerts wait their turn so a bundle prompt can never hide a no-throw warning.
  const [queue, setQueue] = useState<Occurrence[]>([])
  const seen = useRef(new Set<string>())
  const idxRef = useRef(0)
  const lastMoved = useRef<Pt | null>(null)
  const heading = useRef<number | null>(null)
  const { fix, error } = useGps(started)
  const wake = useWakeLock(started)
  const { confirm, dialog } = useDialogs()
  const handled = useMemo(() => new Set(round.handledStopIds), [round])
  // Each time the route passes a stop is a separate warning, so a street driven twice warns on both passes.
  const occs = useMemo(() => occurrences(route), [route])
  const cum = useMemo(() => cumulativeDistances(route.points), [route.points])

  const [snapIdx, setSnapIdx] = useState(0)
  /** How far along the route the driver is, in metres. */
  const [along, setAlong] = useState(0)
  const side = sideAt(route, snapIdx)
  /** How close to a stop its alert shows, as the driver chose it. */
  const [alertDistance, setAlertDistance] = useState(loadAlertDistance)
  const radius = ALERT_RADIUS[alertDistance]
  // The effect below reads what is showing, and the latest way to save progress, without re-running for them.
  const queueRef = useRef(queue)
  const onRoundRef = useRef(onRound)
  useLayoutEffect(() => {
    queueRef.current = queue
    onRoundRef.current = onRound
  })

  useEffect(() => {
    if (!fix) return
    // Which way the phone is heading tells a return pass from the first, which lie on the same road.
    if (!lastMoved.current) lastMoved.current = fix
    else if (haversine(lastMoved.current, fix) >= HEADING_MIN_M) {
      heading.current = bearing(lastMoved.current, fix)
      lastMoved.current = fix
    }
    const snap = snapToPath(fix, route.points, idxRef.current, heading.current)
    if (!snap) return
    idxRef.current = snap.idx
    setSnapIdx(snap.idx)
    const driverAt = alongPath(cum, snap.idx, snap.t)
    setAlong(driverAt)

    // An alert has nothing to tap: it goes when you are away from its stop. Driving on past a stop counts
    // it as done, and backing away from it first lets it alert again when you come back.
    const left = queueRef.current.flatMap((o) => {
      const exit = zoneExit(o, driverAt, radius)
      return exit ? [{ o, exit }] : []
    })
    if (left.length) {
      const gone = new Set(left.map((l) => l.o.key))
      setQueue((q) => q.filter((o) => !gone.has(o.key)))
      for (const l of left) if (l.exit === 'back') seen.current.delete(l.o.key)
      const passed = left.filter((l) => l.exit === 'passed' && !handled.has(l.o.key)).map((l) => l.o.key)
      if (passed.length) onRoundRef.current({ handledStopIds: [...handled, ...passed] })
    }

    const fresh = approachingOccurrences(driverAt, fix, occs, handled, radius).filter((o) => !seen.current.has(o.key))
    if (!fresh.length) return
    fresh.forEach((o) => seen.current.add(o.key))
    setQueue((q) => [...q, ...fresh])
    if (fresh.some((o) => o.stop.type === 'nothrow')) alertNoThrow()
    else alertBundle()
  }, [fix, route, handled, occs, cum, radius])

  const current = queue.find((o) => o.stop.type === 'nothrow') ?? queue[0]
  const currentSide = current ? stopSide(route.points, current.idx, current.stop) : null

  const changeAlertDistance = (distance: AlertDistance) => {
    setAlertDistance(distance)
    saveAlertDistance(distance)
  }

  /** Forget this run's progress, so every special stop counts as not done again. */
  const resetRun = () => {
    seen.current.clear()
    idxRef.current = 0
    heading.current = null
    lastMoved.current = null
    setSnapIdx(0)
    setAlong(0)
    setQueue([])
    onRound({ handledStopIds: [] })
  }

  const reset = async () => {
    const ok = await confirm({
      title: 'Reset Round?',
      message: 'Every special stop will count as not done, so you can start the round again.',
      confirmLabel: 'Reset',
      destructive: true,
    })
    if (ok) resetRun()
  }

  /** `fresh` starts a new run; otherwise an unfinished run carries on where it stopped. */
  const begin = (fresh: boolean) => {
    if (fresh) resetRun()
    unlockAudio()
    setStarted(true)
  }

  if (route.points.length < 2) {
    return (
      <div className="screen plain">
        <div className="hero">
          <div className="hero-icon muted">
            <Icon name="map" size={42} strokeWidth={1.7} />
          </div>
          <h1>No Route Yet</h1>
          <RouteChip name={routeName} onClick={onGoRoutes} />
          <p>Draw this route on the map in Setup. You don't need to drive it first.</p>
          <button className="btn primary" onClick={onGoSetup}>
            Go to Setup
          </button>
        </div>
      </div>
    )
  }

  const total = occs.length
  const remaining = occs.filter((o) => !handled.has(o.key)).length
  const done = total - remaining
  const finished = total > 0 && remaining === 0
  const partial = done > 0 && remaining > 0

  if (!started) {
    return (
      <div className="screen plain">
        <div className="hero">
          <div className="hero-icon">
            <Icon name="navigation" size={42} strokeWidth={1.7} fill />
          </div>
          <h1>Ready to Deliver</h1>
          <RouteChip name={routeName} onClick={onGoRoutes} />
          <p>
            {formatDistance(routeLength(route.points))} · {plural(total, 'special stop', 'special stops')}
            {partial && ` · ${done} of ${total} done`}
          </p>
          {finished && <p className="fine">Your last round is finished, so this will start a new one.</p>}
          <p className="fine">
            You'll only be alerted for bundle drops and no‑throw houses. Keep the phone unlocked and mounted, because GPS pauses when the screen is off.
          </p>
          <div className="alert-setting">
            <div className="brush-label">Alert distance</div>
            <Segmented label="How close to a stop its alert shows" value={alertDistance} options={ALERT_DISTANCES} onChange={changeAlertDistance} />
            <p className="fine">
              No-throw houses at {radius.nothrow} m, bundle drops at {radius.bundle} m. Alerts clear by themselves once you are away from the stop.
            </p>
          </div>
          {partial ? (
            <>
              <button className="btn primary block" onClick={() => begin(false)}>
                Continue Round
              </button>
              <button className="btn plain" onClick={() => begin(true)}>
                Start Over
              </button>
            </>
          ) : (
            <button className="btn primary block" onClick={() => begin(finished)}>
              {finished ? 'Start New Round' : 'Start Round'}
            </button>
          )}
        </div>
        {dialog}
      </div>
    )
  }

  const warning = error ?? (!wake ? 'Keep the phone awake so GPS keeps updating.' : null)

  return (
    <div className="screen">
      <MapView route={route} position={fix} handled={handled} follow={!overview} fitPosition bottomFrac={0.16} />

      <div className="map-top">
        {/* Across the top, with the side pill below it, so the map and the side stay in view. */}
        {current && (
          <AlertBanner
            key={current.key}
            stop={current.stop}
            pass={Number(current.key.split('#')[1] ?? 1)}
            ahead={current.at - along}
            side={currentSide}
            waiting={queue.length - 1}
          />
        )}
        <div className="side-pill" style={{ background: SIDE_PILL[side] }}>
          {side !== 'right' && <Icon name="arrow-left" size={22} strokeWidth={2.5} />}
          {SIDE_LABEL[side]}
          {side !== 'left' && <Icon name="arrow-right" size={22} strokeWidth={2.5} />}
        </div>
      </div>

      <div className="fab-group">
        <button className="fab" data-on={!overview || undefined} aria-label="Follow my location" onClick={() => setOverview(false)}>
          <Icon name="navigation" fill={!overview} />
        </button>
        <button className="fab" data-on={overview || undefined} aria-label="Show whole route" onClick={() => setOverview(true)}>
          <Icon name="map" />
        </button>
      </div>

      <div className="status-card">
        <div className="status-main">
          {remaining === 0 ? (
            <>
              <div className="dot-check" style={{ color: 'var(--green)' }}>
                <Icon name="check" size={34} strokeWidth={3} />
              </div>
              <div className="grow">
                <div className="status-title">All done</div>
                <div className="sub">Every special stop is behind you.</div>
              </div>
            </>
          ) : (
            <>
              <div className="big-number">{remaining}</div>
              <div className="grow">
                <div className="status-title">{remaining === 1 ? 'special stop left' : 'special stops left'}</div>
                <div className="sub">{fix ? 'Alerts appear as you approach.' : 'Finding your location...'}</div>
              </div>
            </>
          )}
          <button className="btn plain small" onClick={reset}>
            Reset
          </button>
        </div>
        {warning && (
          <div className="status-warn">
            <Icon name="alert" size={16} />
            <span>{warning}</span>
          </div>
        )}
      </div>

      {dialog}
    </div>
  )
}
