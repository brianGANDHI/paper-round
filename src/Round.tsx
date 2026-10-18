import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertBanner } from './AlertBanner'
import { alertable, alertRadius, alertSide, ALERT_DISTANCES, approachSide, isAlertDistance, zoneExit, type AlertDistance } from './alerts'
import { SIDE_LABEL, SIDE_PILL } from './colors'
import { useDialogs } from './confirm'
import { alertBundle, alertNoThrow, unlockAudio, useGps, useWakeLock } from './device'
import { plural } from './format'
import {
  alongPath,
  approachingOccurrences,
  bearing,
  byPosition,
  cumulativeDistances,
  haversine,
  occurrences,
  sideAt,
  snapToPath,
  type Occurrence,
} from './geo'
import { Icon } from './Icon'
import { MapView } from './MapView'
import { formatDistance, routeLength } from './routeEdit'
import { loadAlertDistance, loadVoiceTurns, saveAlertDistance, saveVoiceTurns } from './storage'
import { RouteChip, Segmented } from './ui'
import { speak, speechAvailable, stopSpeaking, unlockSpeech } from './speech'
import { TurnCard } from './TurnCard'
import { onTheRoute, routeTurns, turnCue, turnSpeech, upcomingTurn, type TurnCue } from './turns'
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
  /** The same heading for drawing: which side of the road a stop off the route is on depends on it. */
  const [headingDeg, setHeadingDeg] = useState<number | null>(null)
  const { fix, error } = useGps(started)
  const wake = useWakeLock(started)
  const { confirm, choose, dialog } = useDialogs()
  const handled = useMemo(() => new Set(round.handledStopIds), [round])
  // Each time the route passes a stop is a separate warning, so a street driven twice warns on both passes.
  const allOccs = useMemo(() => occurrences(route), [route])
  // A no-throw house on a stretch where nothing is thrown at all has nothing to warn about.
  const occs = useMemo(() => alertable(route, allOccs), [route, allOccs])
  const cum = useMemo(() => cumulativeDistances(route.points), [route.points])

  const [snapIdx, setSnapIdx] = useState(0)
  /** How far along the route the driver is, in metres. */
  const [along, setAlong] = useState(0)
  /** How far the phone is from the route at the latest fix, in metres. Null until there is one. */
  const [routeGap, setRouteGap] = useState<number | null>(null)
  const turns = useMemo(() => routeTurns(route.points), [route.points])
  /** Whether the next turn is said out loud as well as shown. */
  const [voice, setVoice] = useState(loadVoiceTurns)
  /** What has been said about each turn, by how far along the route it is, so each is said once. */
  const saidTurn = useRef(new Map<number, TurnCue>())
  const side = sideAt(route, snapIdx)
  /** How close to a stop its alert shows, as the driver chose it. */
  const [alertDistance, setAlertDistance] = useState(loadAlertDistance)
  const radius = useMemo(() => alertRadius(alertDistance), [alertDistance])
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
      setHeadingDeg(heading.current)
      lastMoved.current = fix
    }
    const snap = snapToPath(fix, route.points, idxRef.current, heading.current)
    if (!snap) return
    idxRef.current = snap.idx
    setSnapIdx(snap.idx)
    setRouteGap(snap.dist)
    const driverAt = alongPath(cum, snap.idx, snap.t)
    setAlong(driverAt)

    // An alert has nothing to tap: it goes when you are away from its stop. Driving on past a stop counts
    // it as done, and backing away from it first lets it alert again when you come back.
    const left = queueRef.current.flatMap((o) => {
      const exit = zoneExit(o, driverAt, radius, fix)
      return exit ? [{ o, exit }] : []
    })
    if (left.length) {
      const gone = new Set(left.map((l) => l.o.key))
      setQueue((q) => q.filter((o) => !gone.has(o.key)))
      for (const l of left) if (l.exit === 'back') seen.current.delete(l.o.key)
      const passed = left.filter((l) => l.exit === 'passed' && !handled.has(l.o.key)).map((l) => l.o.key)
      if (passed.length) onRoundRef.current({ handledStopIds: [...handled, ...passed] })
    }

    const fresh = approachingOccurrences(driverAt, fix, occs, handled, radius, fix.accuracy).filter((o) => !seen.current.has(o.key))
    if (!fresh.length) return
    fresh.forEach((o) => seen.current.add(o.key))
    setQueue((q) => [...q, ...fresh])
    if (fresh.some((o) => o.stop.type === 'nothrow')) alertNoThrow()
    else alertBundle()
  }, [fix, route, handled, occs, cum, radius])

  const current = queue.find((o) => o.stop.type === 'nothrow') ?? queue[0]
  // A stop off the route is met by where the driver is: its distance is how far off it is, and its side is the side it is on
  // as the driver comes up to it. One along the route has a distance and a side along the route.
  const here = current ? byPosition(current, radius) : false
  const ahead = !current ? 0 : here && fix ? haversine(fix, current.stop) : current.at - along
  const currentSide = !current ? null : here ? approachSide(headingDeg, fix, current.stop) : alertSide(route, allOccs, current)

  // The next turn, once it is near, while the phone is on the route and its fix is good enough to say how far along it is.
  const next = fix && onTheRoute(routeGap, fix.accuracy) ? upcomingTurn(turns, along) : null
  const nextAt = next?.turn.at ?? null
  const nextAngle = next?.turn.angle ?? 0
  const nextAhead = next?.ahead ?? 0

  // With the voice on, each turn is said twice: a warning when it comes into view, and the last word as it is reached.
  useEffect(() => {
    if (!voice || nextAt === null) return
    const cue = turnCue(nextAhead, saidTurn.current.get(nextAt) ?? null)
    if (!cue) return
    saidTurn.current.set(nextAt, cue)
    speak(turnSpeech({ at: nextAt, angle: nextAngle }, nextAhead, cue))
  }, [voice, nextAt, nextAngle, nextAhead])
  // Leaving the round ends anything still being said.
  useEffect(() => stopSpeaking, [])

  const changeVoice = (on: boolean) => {
    setVoice(on)
    saveVoiceTurns(on)
    if (!on) return stopSpeaking()
    // Said as the button is tapped, which is also what lets the phone speak later, when a turn comes up. When a
    // turn is due to be said just now, that is what is said, and it is not said again.
    const cue = next ? turnCue(next.ahead, saidTurn.current.get(next.turn.at) ?? null) : null
    if (next && cue) {
      saidTurn.current.set(next.turn.at, cue)
      speak(turnSpeech(next.turn, next.ahead, cue))
    } else {
      speak('Voice directions on')
    }
  }

  const changeAlertDistance = (distance: AlertDistance) => {
    setAlertDistance(distance)
    saveAlertDistance(distance)
  }

  /** On the road: pick another distance without going back to the start screen. */
  const pickDistance = async () => {
    const picked = await choose({
      title: 'Alert Distance',
      message: 'How close to a stop its alert comes up. It goes again once you are further away than this.',
      choices: ALERT_DISTANCES.map((d) => ({ value: String(d), label: `${d} m`, detail: d === alertDistance ? 'Current setting' : undefined })),
    })
    const metres = Number(picked)
    if (picked && isAlertDistance(metres)) changeAlertDistance(metres)
  }

  /** Forget this run's progress, so every special stop counts as not done again. */
  const resetRun = () => {
    seen.current.clear()
    idxRef.current = 0
    heading.current = null
    setHeadingDeg(null)
    lastMoved.current = null
    setSnapIdx(0)
    setAlong(0)
    setRouteGap(null)
    saidTurn.current.clear()
    stopSpeaking()
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
    if (voice) unlockSpeech()
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
            <Segmented
              label="How close to a stop its alert comes up, in metres"
              value={String(alertDistance)}
              options={ALERT_DISTANCES.map((d) => ({ value: String(d), label: String(d) }))}
              onChange={(v) => changeAlertDistance(Number(v) as AlertDistance)}
            />
            <p className="fine">
              In metres. An alert comes up when you are within {alertDistance} m of a stop, and goes by itself once you are further away than that.
            </p>
          </div>
          {speechAvailable() && (
            <div className="alert-setting">
              <div className="brush-label">Turn directions</div>
              <Segmented
                label="Whether the next turn is also said out loud"
                value={voice ? 'voice' : 'arrow'}
                options={[
                  { value: 'arrow', label: 'Arrow only' },
                  { value: 'voice', label: 'Arrow and voice' },
                ]}
                onChange={(v) => changeVoice(v === 'voice')}
              />
              <p className="fine">Turns show as an arrow on the map. The voice says them out loud too.</p>
            </div>
          )}
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
            ahead={ahead}
            side={currentSide}
            waiting={queue.length - 1}
          />
        )}
        <div className="side-pill" style={{ background: SIDE_PILL[side] }}>
          {side === 'transit' && <Icon name="slash" size={22} strokeWidth={2.5} />}
          {(side === 'left' || side === 'both') && <Icon name="arrow-left" size={22} strokeWidth={2.5} />}
          {SIDE_LABEL[side]}
          {(side === 'right' || side === 'both') && <Icon name="arrow-right" size={22} strokeWidth={2.5} />}
        </div>
        {next && <TurnCard key={next.turn.at} turn={next.turn} ahead={next.ahead} />}
      </div>

      <div className="fab-group">
        <button className="fab" data-on={!overview || undefined} aria-label="Follow my location" onClick={() => setOverview(false)}>
          <Icon name="navigation" fill={!overview} />
        </button>
        <button className="fab" data-on={overview || undefined} aria-label="Show whole route" onClick={() => setOverview(true)}>
          <Icon name="map" />
        </button>
        {speechAvailable() && (
          <button className="fab" data-on={voice || undefined} aria-pressed={voice} aria-label="Voice directions" onClick={() => changeVoice(!voice)}>
            <Icon name={voice ? 'volume-2' : 'volume-x'} />
          </button>
        )}
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
                <div className="sub">
                  {fix ? (
                    <button className="status-link" aria-label={`Alerts come up at ${alertDistance} metres. Tap to change.`} onClick={pickDistance}>
                      Alerts at {alertDistance} m
                      <Icon name="chevron-right" size={14} strokeWidth={2.6} />
                    </button>
                  ) : (
                    'Finding your location...'
                  )}
                </div>
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
