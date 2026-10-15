import { useEffect, useMemo, useRef, useState } from 'react'
import { SIDE_COLOR } from './colors'
import { alertBundle, alertNoThrow, unlockAudio, useGps, useWakeLock } from './device'
import { approachingStops, sideAt, snapToPath } from './geo'
import { MapView } from './MapView'
import type { RoundState, Route, Stop } from './types'

interface Props {
  route: Route
  round: RoundState
  onRound: (r: RoundState) => void
}

const SIDE_TEXT = { both: 'BOTH SIDES', left: 'LEFT SIDE', right: 'RIGHT SIDE' } as const

export function Round({ route, round, onRound }: Props) {
  const [started, setStarted] = useState(false)
  const [overview, setOverview] = useState(false)
  // Alerts wait their turn so a bundle prompt can never hide a no-throw warning.
  const [queue, setQueue] = useState<Stop[]>([])
  const seen = useRef(new Set<string>())
  const idxRef = useRef(0)
  const { fix, error } = useGps(started)
  const wake = useWakeLock(started)
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

  const reset = () => {
    if (!confirm('Reset the round to the start?')) return
    seen.current.clear()
    idxRef.current = 0
    setSnapIdx(0)
    setQueue([])
    onRound({ handledStopIds: [] })
  }

  if (route.points.length < 2) return <div className="screen center"><p>Trace your route in Setup first.</p></div>

  if (!started) {
    return (
      <div className="screen center">
        <button
          className="big"
          onClick={() => {
            unlockAudio()
            setStarted(true)
          }}
        >
          Start round
        </button>
        <p className="hint">Keep the phone unlocked and the screen on while you drive.</p>
        <button className="chip" onClick={reset}>Reset round</button>
      </div>
    )
  }

  const remaining = route.stops.filter((s) => !handled.has(s.id)).length

  return (
    <div className="screen">
      <MapView
        route={route}
        position={fix}
        handled={handled}
        follow={!overview}
        fitPosition
        bottomFrac={0.12}
      />
      <div className="badge" style={{ background: SIDE_COLOR[side] }}>{SIDE_TEXT[side]}</div>
      {(error || !wake) && <div className="warn top">{error ?? 'Screen may lock: keep the phone awake.'}</div>}
      <div className="panel slim">
        <span>{remaining} special stop{remaining === 1 ? '' : 's'} left</span>
        <span className="chips">
          <button className="chip" onClick={() => setOverview((o) => !o)}>{overview ? 'Follow me' : 'Whole route'}</button>
          <button className="chip" onClick={reset}>Reset</button>
        </span>
      </div>
      {current && (
        <div className={current.type === 'nothrow' ? 'overlay red' : 'overlay blue'}>
          {current.type === 'nothrow' ? (
            <>
              <h1>NO THROW</h1>
              <p>{current.label ?? 'This house does not want the paper.'}</p>
            </>
          ) : (
            <>
              <h1>BUNDLE DROP</h1>
              {current.qty && <p className="qty">{current.qty}</p>}
              <p>{current.label ?? 'Bundle stop ahead'}</p>
            </>
          )}
          <button className="big" onClick={() => markHandled(current.id)}>Handled</button>
          <button className="chip light" onClick={() => drop(current.id)}>Dismiss</button>
          {queue.length > 1 && <p className="more">{queue.length - 1} more waiting</p>}
        </div>
      )}
    </div>
  )
}
