import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertBanner } from './AlertBanner'
import { aheadOf, alertable, alertRadius, alertSide, ALERT_DISTANCES, approachSide, houseRow, isAlertDistance, isGoneBy, pickCurrent, planSpeech, zoneExit, type AlertDistance } from './alerts'
import { SIDE_PILL, SIDE_SHORT } from './colors'
import { useDialogs } from './confirm'
import { useGps, useWakeLock } from './device'
import { plural } from './format'
import { approachingOccurrences, byPosition, handledUpTo, occurrences, sideAt, type Occurrence } from './geo'
import { pushTrail, trailHeading, type TrailPoint } from './heading'
import { Icon } from './Icon'
import { MapView } from './MapView'
import { advance, makeTrack, startProgress, type Progress } from './progress'
import { formatDistance, routeLength } from './routeEdit'
import { loadAlertDistance, loadKeepAudioAwake, loadVoiceTurns, saveAlertDistance, saveKeepAudioAwake, saveVoiceTurns } from './storage'
import { RouteChip, Segmented } from './ui'
import { sound } from './sound'
import { say, speechAvailable, stopSpeaking, unlockSpeech } from './speech'
import { TurnCard } from './TurnCard'
import { onTheRoute, routeTurns, TURN_PASSED_M, turnCue, turnSpeech, upcomingTurn, type TurnCue } from './turns'
import type { RoundState, Route } from './types'

/** The furthest reached is kept with the round this many metres at a time. */
const SAVE_EVERY_M = 100

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
  /** Where the phone has been, for a heading when it has no course of its own. Only fixes that were believed are in it. */
  const trail = useRef<TrailPoint[]>([])
  /** Which way the phone is heading, if it can say: which pass of a street is being driven, which side a stop off the route is on, and the turn that comes up depend on it. */
  const [headingDeg, setHeadingDeg] = useState<number | null>(null)
  const { fix, error } = useGps(started)
  const wake = useWakeLock(started)
  const { confirm, choose, dialog } = useDialogs()
  const handled = useMemo(() => new Set(round.handledStopIds), [round])
  // Each time the route passes a stop is a separate warning, so a street driven twice warns on both passes.
  const allOccs = useMemo(() => occurrences(route), [route])
  // A no-throw house on a stretch where nothing is thrown at all has nothing to warn about.
  const occs = useMemo(() => alertable(route, allOccs), [route, allOccs])
  const track = useMemo(() => makeTrack(route.points), [route.points])
  /** Where the driver has got to along the route, judged against where they were a moment ago. Null until the round has begun. */
  const [progress, setProgress] = useState<Progress | null>(null)
  const progressRef = useRef<Progress | null>(null)
  /** The furthest reached that has been saved with the round, in metres. */
  const savedFurthest = useRef(round.furthest ?? 0)
  /** How far along the route the driver is, and the furthest they have got (what is behind it is drawn faded), in metres. */
  const along = progress?.along ?? 0
  const driven = progress?.furthest ?? 0
  const snapIdx = progress?.idx ?? 0
  const turns = useMemo(() => routeTurns(route.points), [route.points])
  /** Whether the next turn is said out loud as well as shown. */
  const [voice, setVoice] = useState(loadVoiceTurns)
  /** Whether a near-silent signal keeps the audio link to a car or speaker open while the voice is on. */
  const [keepAudio, setKeepAudio] = useState(loadKeepAudioAwake)
  /** What has been said about each turn, by how far along the route it is, so each is said once. */
  const saidTurn = useRef(new Map<number, TurnCue>())
  /** The alerts already said out loud, by occurrence, so a row of houses is said once, not house by house. */
  const announced = useRef(new Set<string>())
  const voiceRef = useRef(voice)
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
    voiceRef.current = voice
  })

  // Each fix moves the driver along the route. Which way the phone is heading tells a return pass from the first, which lie on the
  // same road: it is the phone's own course while that is there (only while it is really moving), and otherwise the way it has
  // been going over the last few dozen metres, if that is clear. A fix that was set aside, or seen before, changes nothing.
  useEffect(() => {
    if (!fix) return
    const course = fix.heading ?? trailHeading(trail.current, fix.accuracy)
    const before = progressRef.current
    const now = advance(track, before, fix, course)
    if (!now || now === before) return
    progressRef.current = now
    trail.current = pushTrail(trail.current, { lat: now.at.lat, lng: now.at.lng, time: now.time ?? fix.time })
    setHeadingDeg(course)
    setProgress(now)
  }, [fix, track])

  // The furthest reached is kept with the round a hundred metres at a time, so that carrying on later starts from there.
  useEffect(() => {
    if (!progress) return
    const far = Math.floor(progress.furthest / SAVE_EVERY_M) * SAVE_EVERY_M
    if (far <= savedFurthest.current) return
    savedFurthest.current = far
    onRoundRef.current({ handledStopIds: [...handled], furthest: far })
  }, [progress, handled])

  // What the driver is near. This runs for every move of the driver, and when the stops done, the route or the distance change.
  useEffect(() => {
    if (!progress) return
    const driverAt = progress.along
    const pos = progress.at

    // An alert has nothing to tap: it goes when you are away from its stop. Driving on past a stop counts
    // it as done, and backing away from it first lets it alert again when you come back.
    const left = queueRef.current.flatMap((o) => {
      const exit = zoneExit(o, driverAt, radius, pos)
      return exit ? [{ o, exit }] : []
    })
    if (left.length) {
      const gone = new Set(left.map((l) => l.o.key))
      setQueue((q) => q.filter((o) => !gone.has(o.key)))
      for (const l of left) {
        if (l.exit !== 'back') continue
        seen.current.delete(l.o.key)
        announced.current.delete(l.o.key)
      }
      const passed = left.filter((l) => l.exit === 'passed' && !handled.has(l.o.key)).map((l) => l.o.key)
      if (passed.length) onRoundRef.current({ handledStopIds: [...handled, ...passed], ...(savedFurthest.current > 0 ? { furthest: savedFurthest.current } : {}) })
    }

    const fresh = approachingOccurrences(driverAt, pos, occs, handled, radius, progress.accuracy).filter((o) => !seen.current.has(o.key))
    if (!fresh.length) return
    fresh.forEach((o) => seen.current.add(o.key))
    setQueue((q) => [...q, ...fresh])
    const beepSeconds = fresh.some((o) => o.stop.type === 'nothrow') ? sound.noThrow() : fresh.some((o) => o.stop.type === 'request') ? sound.request() : sound.bundle()
    if (!voiceRef.current) return
    // With the voice on, the house numbers are said once the beep is over: a row of no-throw houses all together, the first time any of it comes up.
    const plan = planSpeech(fresh, (first) => houseRow(route, allOccs, occs, handled, first, radius), announced.current)
    for (const key of plan.announce) announced.current.add(key)
    if (plan.text) say(plan.text, { urgent: true, afterMs: beepSeconds * 1000 })
  }, [progress, handled, occs, allOccs, route, radius])

  // The alert showing is for the nearest no-throw house still ahead, or else the nearest of the others. For a no-throw house it is for
  // the whole row it is in, numbers and all, so the driver sees at once which houses to leave out, and the others that wait are counted
  // (not those already gone by, which are only waiting to go).
  const here0 = progress?.at ?? null
  const current = pickCurrent(queue, driven, along, here0, radius)
  const row = current ? houseRow(route, allOccs, occs, handled, current, radius) : []
  const waiting = queue.filter((o) => !row.some((r) => r.key === o.key) && !isGoneBy(o, driven, along, here0, radius)).length
  // On the map, the houses the alert is for stand out, with their numbers.
  const activeStops = row.map((o) => o.stop.id)
  // A stop off the route is met by where the driver is: its distance is how far off it is, and its side is the side it is on
  // as the driver comes up to it. One along the route has a distance and a side along the route.
  const here = current ? byPosition(current, radius) : false
  const ahead = current ? aheadOf(current, along, here0, radius) : 0
  const currentSide = !current ? null : here ? approachSide(headingDeg, here0, current.stop) : alertSide(route, allOccs, current)

  // The next turn, once it is near, while the phone is on the route and its fix is good enough to say how far along it is.
  // A turn that comes up the other way to the way the phone is heading is not the one being driven to, and one already passed
  // does not return, so on a street driven twice only the turn for the pass being driven shows.
  const next = progress && onTheRoute(progress.gap, progress.accuracy, progress.lost) ? upcomingTurn(turns, along, { heading: headingDeg, after: driven - TURN_PASSED_M }) : null
  const nextAt = next?.turn.at ?? null
  const nextAngle = next?.turn.angle ?? 0
  const nextAhead = next?.ahead ?? 0

  // With the voice on, each turn is said twice: a warning when it comes into view, and the last word as it is reached.
  const nextAtRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    nextAtRef.current = nextAt
  })
  useEffect(() => {
    if (!voice || nextAt === null) return
    const cue = turnCue(nextAhead, saidTurn.current.get(nextAt) ?? null)
    if (!cue) return
    saidTurn.current.set(nextAt, cue)
    // Dropped if the turn has been made, or another has come up, by the time the words would start.
    say(turnSpeech({ angle: nextAngle }, nextAhead, cue), { stale: () => nextAtRef.current !== nextAt })
  }, [voice, nextAt, nextAngle, nextAhead])
  // Leaving the round ends anything still being said, and the signal that keeps the audio link open.
  useEffect(
    () => () => {
      stopSpeaking()
      sound.stopKeepAlive()
    },
    [],
  )

  const changeVoice = (on: boolean) => {
    setVoice(on)
    saveVoiceTurns(on)
    if (!on) {
      stopSpeaking()
      sound.stopKeepAlive()
      return
    }
    // Said as the button is tapped, which is also what lets the phone speak later, when a turn comes up. When a
    // turn is due to be said just now, that is what is said, and it is not said again.
    sound.unlock()
    if (keepAudio) sound.startKeepAlive()
    unlockSpeech()
    // An alert showing as the voice goes on is the first thing said, as it is what the driver needs to hear, whether or not it was said before.
    const showing = queue.filter((o) => !isGoneBy(o, driven, along, here0, radius))
    const plan = planSpeech(showing, (first) => houseRow(route, allOccs, occs, handled, first, radius), new Set())
    if (plan.text) {
      for (const key of plan.announce) announced.current.add(key)
      say(plan.text, { urgent: true })
      return
    }
    const cue = next ? turnCue(next.ahead, saidTurn.current.get(next.turn.at) ?? null) : null
    if (next && cue) {
      saidTurn.current.set(next.turn.at, cue)
      say(turnSpeech(next.turn, next.ahead, cue))
    } else {
      say('Voice on')
    }
  }

  const changeKeepAudio = (on: boolean) => {
    setKeepAudio(on)
    saveKeepAudioAwake(on)
    if (on && voice) sound.startKeepAlive()
    else sound.stopKeepAlive()
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
    const start = startProgress(track, 0)
    progressRef.current = start
    setProgress(start)
    trail.current = []
    setHeadingDeg(null)
    savedFurthest.current = 0
    saidTurn.current.clear()
    announced.current.clear()
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
    if (fresh) {
      resetRun()
    } else {
      // Carried on, so the driver is taken to be where the last stop done was, which tells the passes of a street driven twice apart.
      const upTo = Math.max(handledUpTo(allOccs, handled), round.furthest ?? 0)
      const start = startProgress(track, upTo)
      progressRef.current = start
      setProgress(start)
      trail.current = []
    }
    sound.unlock()
    if (voice) {
      if (keepAudio) sound.startKeepAlive()
      unlockSpeech()
    }
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
            You'll only be alerted for bundle drops, no‑throw houses and special requests. Keep the phone unlocked and mounted, because GPS pauses when the screen is off.
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
              <div className="brush-label">Voice</div>
              <Segmented
                label="Whether turns and house numbers are said out loud"
                value={voice ? 'on' : 'off'}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'on', label: 'On' },
                ]}
                onChange={(v) => changeVoice(v === 'on')}
              />
              <p className="fine">Turns always show as an arrow on the map. With the voice on it says them out loud too, and the numbers of the houses to look for.</p>
              {voice && (
                <>
                  <button className="btn secondary block" data-on={keepAudio || undefined} aria-pressed={keepAudio} onClick={() => changeKeepAudio(!keepAudio)}>
                    <Icon name={keepAudio ? 'check' : 'volume-x'} size={18} />
                    Keep car audio awake
                  </button>
                  <p className="fine">Plays a sound too quiet to hear, so a car or speaker doesn't cut off the start of the voice.</p>
                </>
              )}
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
      <MapView route={route} position={fix} handled={handled} drivenM={driven} active={activeStops} follow={!overview} fitPosition bottomFrac={0.16} />

      <div className="map-top">
        {/* The side and the next turn stay at the top where they are, and an alert drops in under them, so nothing jumps about. */}
        <div className="hud-row">
          <div className="side-pill" style={{ background: SIDE_PILL[side] }}>
            {side === 'transit' && <Icon name="slash" size={20} strokeWidth={2.5} />}
            {(side === 'left' || side === 'both') && <Icon name="arrow-left" size={20} strokeWidth={2.5} />}
            {SIDE_SHORT[side]}
            {(side === 'right' || side === 'both') && <Icon name="arrow-right" size={20} strokeWidth={2.5} />}
          </div>
          {next && <TurnCard key={next.turn.at} turn={next.turn} ahead={next.ahead} />}
        </div>
        {current && (
          <AlertBanner
            // A row of no-throw houses keeps the one banner as each is passed, instead of it dropping in again at every house.
            key={current.stop.type === 'nothrow' ? 'nothrow' : current.key}
            stops={row.map((o) => o.stop)}
            pass={Number(current.key.split('#')[1] ?? 1)}
            ahead={ahead}
            side={currentSide}
            waiting={waiting}
          />
        )}
      </div>

      {/* The map buttons and the count of stops left share the bottom, so the top is kept for what the driver is looking out for. */}
      <div className="map-bottom">
        <div className="fab-group low">
          <button className="fab" data-on={!overview || undefined} aria-label="Follow my location" onClick={() => setOverview(false)}>
            <Icon name="navigation" fill={!overview} />
          </button>
          <button className="fab" data-on={overview || undefined} aria-label="Show whole route" onClick={() => setOverview(true)}>
            <Icon name="map" />
          </button>
          {speechAvailable() && (
            <button className="fab" data-on={voice || undefined} aria-pressed={voice} aria-label="Voice" onClick={() => changeVoice(!voice)}>
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
      </div>

      {dialog}
    </div>
  )
}
