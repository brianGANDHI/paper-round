import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertOverlay } from './AlertOverlay'
import { SIDE_LABEL, SIDE_PILL } from './colors'
import { useConfirm } from './confirm'
import { alertBundle, alertNoThrow, unlockAudio, useGps, useWakeLock } from './device'
import { approachingStops, sideAt, snapToPath } from './geo'
import { Icon } from './Icon'
import { MapView } from './MapView'
import { formatDistance, routeLength } from './routeEdit'
import type { RoundState, Route, Stop } from './types'

interface Props {
  route: Route
  round: RoundState
  onRound: (r: RoundState) => void
  onGoSetup: () => void
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function Round({ route, round, onRound, onGoSetup }: Props) {
  const [started, setStarted] = useState(false)
  const [overview, setOverview] = useState(false)
  // Alerts wait their turn so a bundle prompt can never hide a no-throw warning.
  const [queue, setQueue] = useState<Stop[]>([])
  const seen = useRef(new Set<string>())
  const idxRef = useRef(0)
  const { fix, error } = useGps(started)
  const wake = useWakeLock(started)
  const { confirm, dialog } = useConfirm()
  const handled = useMemo(() => new Set(round.handledStopIds), [round])

  const [snapIdx, setSnapIdx] = useState(0)
  const side = sideAt(route, snapIdx)

  useEffect(() => {
    if (!fix) return
    const snap = snapToPath(fix, route.points, idxRef.current)
    if (!snap) return
    idxRef.current = snap.idx
    setSnapIdx(snap.idx)
    const fresh = approachingStops(fix, snap.idx, route.stops, handled).filter((s) => !seen.current.has(s.id))
    if (!fresh.length) return
    fresh.forEach((s) => seen.current.add(s.id))
    setQueue((q) => [...q, ...fresh])
    if (fresh.some((s) => s.type === 'nothrow')) alertNoThrow()
    else alertBundle()
  }, [fix, route, handled])

  const current = queue.find((s) => s.type === 'nothrow') ?? queue[0]
  const drop = (id: string) => setQueue((q) => q.filter((s) => s.id !== id))

  const markHandled = (id: string) => {
    onRound({ handledStopIds: [...round.handledStopIds, id] })
    drop(id)
  }

  const reset = async () => {
    const ok = await confirm({
      title: 'Reset Round?',
      message: 'Every special stop will count as not done, so you can start the round again.',
      confirmLabel: 'Reset',
      destructive: true,
    })
    if (!ok) return
    seen.current.clear()
    idxRef.current = 0
    setSnapIdx(0)
    setQueue([])
    onRound({ handledStopIds: [] })
  }

  if (route.points.length < 2) {
    return (
      <div className="screen plain">
        <div className="hero">
          <div className="hero-icon muted">
            <Icon name="map" size={42} strokeWidth={1.7} />
          </div>
          <h1>No Route Yet</h1>
          <p>Draw your round on the map in Setup. You don't need to drive it first.</p>
          <button className="btn primary" onClick={onGoSetup}>
            Go to Setup
          </button>
        </div>
      </div>
    )
  }

  const total = route.stops.length
  const remaining = route.stops.filter((s) => !handled.has(s.id)).length

  if (!started) {
    const done = total - remaining
    return (
      <div className="screen plain">
        <div className="hero">
          <div className="hero-icon">
            <Icon name="navigation" size={42} strokeWidth={1.7} fill />
          </div>
          <h1>Ready to Deliver</h1>
          <p>
            {formatDistance(routeLength(route.points))} · {plural(total, 'special stop', 'special stops')}
            {done > 0 && ` · ${done} done`}
          </p>
          <p className="fine">
            You'll only be alerted for bundle drops and no‑throw houses. Keep the phone unlocked and mounted, because GPS pauses when the screen is off.
          </p>
          <button
            className="btn primary block"
            onClick={() => {
              unlockAudio()
              setStarted(true)
            }}
          >
            Start Round
          </button>
          {done > 0 && (
            <button className="btn plain danger" onClick={reset}>
              Reset Round
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
                <div className="sub">Every special stop is handled.</div>
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

      {current && (
        <AlertOverlay stop={current} waiting={queue.length - 1} onHandled={() => markHandled(current.id)} onDismiss={() => drop(current.id)} />
      )}
      {dialog}
    </div>
  )
}
