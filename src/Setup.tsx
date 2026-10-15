import { useEffect, useRef, useState } from 'react'
import { SIDE_COLOR } from './colors'
import { haversine, sideAt, simplify, snapToPath } from './geo'
import { useGps } from './device'
import { MapView } from './MapView'
import type { Pt, Route, Side, Stop } from './types'

type Mode = 'view' | 'bundle' | 'nothrow' | Side

interface Props {
  route: Route
  onChange: (r: Route) => void
}

const MIN_STEP_M = 5
const MAX_ACCURACY_M = 30
const SIMPLIFY_M = 3

let nextId = 0
const newId = () => `${Date.now().toString(36)}${(nextId++).toString(36)}`

export function Setup({ route, onChange }: Props) {
  const [mode, setMode] = useState<Mode>('view')
  const [recording, setRecording] = useState(false)
  const [trace, setTrace] = useState<Pt[]>([])
  const { fix, error } = useGps(true)
  const lastRef = useRef<Pt | null>(null)

  useEffect(() => {
    if (!recording || !fix || fix.accuracy > MAX_ACCURACY_M) return
    if (lastRef.current && haversine(lastRef.current, fix) < MIN_STEP_M) return
    lastRef.current = { lat: fix.lat, lng: fix.lng }
    setTrace((t) => [...t, { lat: fix.lat, lng: fix.lng }])
  }, [fix, recording])

  const startTrace = () => {
    if (route.points.length && !confirm('Re-tracing replaces the route, its stops and sides. Continue?')) return
    lastRef.current = null
    setTrace([])
    setMode('view')
    setRecording(true)
  }

  const stopTrace = () => {
    setRecording(false)
    const points = simplify(trace, SIMPLIFY_M)
    if (points.length < 2) return
    onChange({ points, sideChanges: [{ idx: 0, side: 'both' }], stops: [] })
    setTrace([])
  }

  const addStop = (p: Pt, type: Stop['type']) => {
    const snap = snapToPath(p, route.points)
    if (!snap || snap.dist > 40) return alert('Tap closer to the route.')
    let qty: number | undefined
    if (type === 'bundle') {
      const q = prompt('Bundle quantity (optional)', '')
      if (q === null) return
      qty = Number.parseInt(q, 10) || undefined
    }
    const label = prompt(type === 'bundle' ? 'Name (optional)' : 'House / name (optional)', '')
    if (label === null) return
    onChange({
      ...route,
      stops: [...route.stops, { id: newId(), ...p, pathIdx: snap.idx, type, qty, label: label || undefined }],
    })
  }

  const setSide = (p: Pt, side: Side) => {
    const snap = snapToPath(p, route.points)
    if (!snap || snap.dist > 40) return alert('Tap closer to the route.')
    const rest = route.sideChanges.filter((c) => c.idx !== snap.idx)
    onChange({ ...route, sideChanges: [...rest, { idx: snap.idx, side }].sort((a, b) => a.idx - b.idx) })
  }

  const onTap = (p: Pt) => {
    if (mode === 'bundle' || mode === 'nothrow') addStop(p, mode)
    else if (mode === 'both' || mode === 'left' || mode === 'right') setSide(p, mode)
  }

  const markHere = (type: Stop['type']) => {
    if (fix) addStop(fix, type)
  }

  const removeStop = (id: string) => onChange({ ...route, stops: route.stops.filter((s) => s.id !== id) })

  const shown: Route = recording ? { ...route, points: trace, sideChanges: [], stops: [] } : route
  const hasRoute = route.points.length > 1

  return (
    <div className="screen">
      <MapView route={shown} position={fix} follow={recording} bottomFrac={0.45} onTap={onTap} />
      <div className="panel">
        {error && <p className="warn">{error}</p>}
        {recording ? (
          <>
            <p>Drive your round. {trace.length} points recorded.</p>
            <button className="big" onClick={stopTrace}>Stop and save route</button>
          </>
        ) : (
          <>
            <button className="big" onClick={startTrace}>{hasRoute ? 'Re-trace route' : 'Trace route'}</button>
            {hasRoute && (
              <>
                <div className="chips">
                  {(['view', 'bundle', 'nothrow'] as const).map((m) => (
                    <button key={m} className={mode === m ? 'chip on' : 'chip'} onClick={() => setMode(m)}>
                      {m === 'view' ? 'Browse' : m === 'bundle' ? '+ Bundle' : '+ No-throw'}
                    </button>
                  ))}
                </div>
                <div className="chips">
                  {(['both', 'left', 'right'] as const).map((s) => (
                    <button
                      key={s}
                      className={mode === s ? 'chip on' : 'chip'}
                      style={{ borderColor: SIDE_COLOR[s] }}
                      onClick={() => setMode(s)}
                    >
                      Side from tap: {s}
                    </button>
                  ))}
                </div>
                <p className="hint">
                  {mode === 'view'
                    ? 'Choose a tool, then tap the route on the map.'
                    : mode === 'bundle' || mode === 'nothrow'
                      ? 'Tap the map where the stop is, or mark your GPS position:'
                      : 'Tap the route where this delivery side begins. It applies until the next change.'}
                </p>
                {(mode === 'bundle' || mode === 'nothrow') && (
                  <button className="chip" disabled={!fix} onClick={() => markHere(mode)}>Mark here (GPS)</button>
                )}
                <ul className="list">
                  {route.stops.map((s) => (
                    <li key={s.id}>
                      <span className={s.type === 'bundle' ? 'dot blue' : 'dot red'} />
                      {s.type === 'bundle' ? `Bundle${s.qty ? ` x${s.qty}` : ''}` : 'No-throw'}
                      {s.label ? `: ${s.label}` : ''} <em>({sideAt(route, s.pathIdx)})</em>
                      <button className="x" aria-label="Delete stop" onClick={() => removeStop(s.id)}>×</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
