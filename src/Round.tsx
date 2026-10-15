import { useEffect, useMemo, useRef, useState } from 'react'
import { alertBundle, alertNoThrow, unlockAudio, useGps, useWakeLock } from './device'
import { approachingStops, sideAt, snapToPath } from './geo'
import { MapView, SIDE_COLOR } from './MapView'
import type { RoundState, Route, Stop } from './types'

interface Props {
  route: Route
  round: RoundState
  onRound: (r: RoundState) => void
}

const SIDE_TEXT = { both: 'BOTH SIDES', left: 'LEFT SIDE', right: 'RIGHT SIDE' } as const

export function Round({ route, round, onRound }: Props) {
  const [started, setStarted] = useState(false)
  const [alerted, setAlerted] = useState<Stop | null>(null)
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
    const next = approachingStops(fix, snap.idx, route.stops, handled).find((s) => !seen.current.has(s.id))
    if (!next) return
    seen.current.add(next.id)
    setAlerted(next)
    if (next.type === 'bundle') alertBundle()
    else alertNoThrow()
  }, [fix, route, handled])

  const markHandled = (id: string) => {
    onRound({ handledStopIds: [...round.handledStopIds, id] })
    setAlerted(null)
  }

  const reset = () => {
    if (!confirm('Reset the round to the start?')) return
    seen.current.clear()
    idxRef.current = 0
    setSnapIdx(0)
    setAlerted(null)
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
      <MapView route={route} position={fix} handled={handled} follow />
      <div className="badge" style={{ background: SIDE_COLOR[side] }}>{SIDE_TEXT[side]}</div>
      {(error || !wake) && <div className="warn top">{error ?? 'Screen may lock: keep the phone awake.'}</div>}
      <div className="panel slim">
        <span>{remaining} special stop{remaining === 1 ? '' : 's'} left</span>
        <button className="chip" onClick={reset}>Reset</button>
      </div>
      {alerted && (
        <div className={alerted.type === 'nothrow' ? 'overlay red' : 'overlay blue'}>
          {alerted.type === 'nothrow' ? (
            <>
              <h1>NO THROW</h1>
              <p>{alerted.label ?? 'This house does not want the paper.'}</p>
            </>
          ) : (
            <>
              <h1>BUNDLE DROP</h1>
              {alerted.qty && <p className="qty">{alerted.qty}</p>}
              <p>{alerted.label ?? 'Bundle stop ahead'}</p>
            </>
          )}
          <button className="big" onClick={() => markHandled(alerted.id)}>Handled</button>
          <button className="chip light" onClick={() => setAlerted(null)}>Dismiss</button>
        </div>
      )}
    </div>
  )
}
