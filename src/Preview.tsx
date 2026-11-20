import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { SIDE_COLOR, SIDE_LABEL, SIDE_PILL, SIDE_SHORT } from './colors'
import { useDialogs } from './confirm'
import { useWakeLock } from './device'
import { sideChangeSentence, sideExtents, type ExtentKey } from './driveEdit'
import { guidedTurn } from './guidance'
import { Icon } from './Icon'
import { MapCredit } from './MapCredit'
import { MapView } from './MapView'
import { resolveSections, sectionAt, sectionCalls } from './namedSections'
import { passNote, passViews } from './passes'
import {
  advanceAlong,
  clearPart,
  drawnStretches,
  GLIDE_MS,
  mapTurn,
  markerAt,
  markerOffset,
  nextStretch,
  PREVIEW_SPEEDS,
  previewEnd,
  previousStretch,
  secondsLeft,
  stretchAt,
  timeLeftText,
  withWholeStretch,
  type Mover,
  type PlaybackHandles,
  type PreviewSpeed,
  type ScreenOffset,
} from './playback'
import { formatDistance, paintMetres, sections as throwSections } from './routeEdit'
import { sideWords } from './sideVoice'
import { say, speechAvailable, stopSpeaking, unlockSpeech } from './speech'
import { loadHeadingUp } from './storage'
import { nameTurns } from './streets'
import { guidanceToShow } from './transitView'
import { routeTurns, TURN_PASSED_M } from './turns'
import { TurnCard } from './TurnCard'
import { Segmented } from './ui'
import { SIDES, type NamedSection, type Route, type Side, type TurnStreet } from './types'
import './preview.css'

interface Props {
  route: Route
  /** The route's named sections, so the panel can say which one the marker is in. */
  sections: readonly NamedSection[]
  /** The street names of the route's turns, for the turn card. */
  streets: readonly TurnStreet[]
  /** How far from the route a no-throw house can be kept quiet, in metres (see `quietReachFor`): the houses drawn small and pale are the ones the round keeps quiet. */
  reachM: number
  /** Where along the route the preview opens, in metres (paused there), and the speed it plays at. */
  from: number
  speed: PreviewSpeed
  /** A side changed from the preview: the route with it, which keeps the round's progress, as a change made while driving does. */
  onAdjustRoute: (route: Route) => void
  /** Edit in Setup: the stretch the marker is in, and where the preview was, to carry on from when it is opened again. */
  onEditStretch: (index: number, along: number, speed: PreviewSpeed) => void
  onClose: () => void
}

/** How often, in milliseconds, the panel catches up with the marker while it plays (the marker itself moves every frame). A new stretch is shown at once. */
const TICK_MS = 120
/** A frame that comes later than this, in seconds (the phone was busy, or the app was in the background), counts as this long, so the marker never leaps ahead. */
const MAX_STEP_S = 0.1

/** No stop is done in a preview: with this, the map draws a no-throw house that never alerts small and pale, as the round does. */
const NONE_DONE: ReadonlySet<string> = new Set()

/** The side as a word and arrows, as on the round's side pill: an arrow to each side thrown, and a bar through for transit. */
function SideWord({ side }: { side: Side }) {
  return (
    <span className="preview-side-word">
      {side === 'transit' && <Icon name="slash" size={30} strokeWidth={2.6} />}
      {(side === 'left' || side === 'both') && <Icon name="arrow-left" size={30} strokeWidth={2.6} />}
      {SIDE_SHORT[side]}
      {(side === 'right' || side === 'both') && <Icon name="arrow-right" size={30} strokeWidth={2.6} />}
    </span>
  )
}

/**
 * Preview the Drive: the route played back from where it opens, faster than real time, with a marker going along it, the throw side of the
 * stretch it is in shown big at the top, the route coloured by side, and the next turn as the round shows it. Nothing here touches the round,
 * and the route only changes when the side is changed from here (or in Setup, through Edit in Setup).
 */
export function Preview({ route, sections, streets, reachM, from, speed: firstSpeed, onAdjustRoute, onEditStretch, onClose }: Props) {
  const stretches = useMemo(() => throwSections(route), [route])
  const views = useMemo(() => passViews(route), [route])
  const drawn = useMemo(() => drawnStretches(views), [views])
  const turns = useMemo(() => routeTurns(route.points), [route.points])
  const named = useMemo(() => nameTurns(route.points, turns, streets), [route.points, turns, streets])
  const resolved = useMemo(() => resolveSections(route.points, sections), [route.points, sections])
  const calls = useMemo(() => sectionCalls(resolved.list), [resolved])
  const end = previewEnd(stretches)

  // Where the marker is: a ref, moved every frame, and what the screen shows of it, which catches up a few times a second.
  const opensAt = Math.min(Math.max(0, from), end)
  const alongRef = useRef(opensAt)
  const [shown, setShown] = useState(opensAt)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<PreviewSpeed>(firstSpeed)
  const [headingUp, setHeadingUp] = useState(loadHeadingUp)
  const [mapHeading, setMapHeading] = useState<number | null>(() => markerAt(drawn, opensAt)?.heading ?? null)
  const [voice, setVoice] = useState(false)
  const [notice, setNotice] = useState<{ message: string; undo?: () => void } | null>(null)
  const moveRef = useRef<Mover | null>(null)
  const offsetRef = useRef<ScreenOffset>({ x: 0, y: 0 })
  const synced = useRef({ at: -Infinity, index: -1 })
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null)
  const [topEl, setTopEl] = useState<HTMLDivElement | null>(null)
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null)
  const [buttonsEl, setButtonsEl] = useState<HTMLDivElement | null>(null)
  /** Where the marker sits from the middle of the map when it points north, how much of the bottom of the map is covered, how tall the panel is, and whether the phone is on its side. */
  const [layout, setLayout] = useState({ offset: { x: 0, y: 0 }, coverPx: 0, panelPx: 0, sideways: false })
  const { choose, dialog } = useDialogs()
  useWakeLock(playing)

  /** The screen catches up with the marker: at once for a new stretch or when told to, otherwise no more than every `TICK_MS`. */
  const sync = useCallback(
    (along: number, now = false) => {
      const index = stretchAt(stretches, along)
      const t = performance.now()
      if (!now && index === synced.current.index && t - synced.current.at < TICK_MS) return
      synced.current = { at: t, index }
      setShown(along)
      const heading = markerAt(drawn, along)?.heading ?? null
      setMapHeading((h) => mapTurn(h, heading))
    },
    [stretches, drawn],
  )

  /** Put the marker somewhere along the route, and the map on it. */
  const seek = (m: number) => {
    const along = Math.min(Math.max(0, m), end)
    alongRef.current = along
    moveRef.current?.(along, null)
    sync(along, true)
  }

  // Playing: each frame the marker goes on as far as the time since the last one takes it, at the speed and its stretch's own pace, to the end.
  useEffect(() => {
    if (!playing) return
    let last: number | null = null
    let frame = 0
    const step = (t: number) => {
      const seconds = last === null ? 0 : Math.min(MAX_STEP_S, (t - last) / 1000)
      last = t
      const along = advanceAlong(stretches, alongRef.current, seconds, speed)
      alongRef.current = along
      moveRef.current?.(along, advanceAlong(stretches, along, GLIDE_MS / 1000, speed))
      if (along >= end) {
        sync(along, true)
        setPlaying(false)
        return
      }
      sync(along)
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [playing, speed, stretches, end, sync])

  // The route changed (a side changed from here): the stretches are new, so the screen is brought up to date where the marker is.
  useEffect(() => {
    alongRef.current = Math.min(alongRef.current, end)
    sync(alongRef.current, true)
  }, [stretches, end, sync])

  // What is over the map (the side at the top, the panel, the map's buttons), measured, so the marker sits in the part left clear (see `clearPart`).
  useEffect(() => {
    if (!rootEl || !topEl || !panelEl || !buttonsEl) return
    const measure = () => {
      const at = rootEl.getBoundingClientRect()
      const box = (el: HTMLElement) => {
        const r = el.getBoundingClientRect()
        return { left: r.left - at.left, top: r.top - at.top, right: r.right - at.left, bottom: r.bottom - at.top }
      }
      const map = { width: at.width, height: at.height }
      const panel = box(panelEl)
      const clear = clearPart(map, box(topEl), panel, box(buttonsEl))
      const sideways = panel.left > map.width * 0.3
      const next = { offset: markerOffset(map, clear), coverPx: sideways ? 0 : Math.round(map.height - clear.bottom), panelPx: panelEl.offsetHeight, sideways }
      setLayout((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
    }
    measure()
    const watcher = new ResizeObserver(measure)
    for (const el of [rootEl, topEl, panelEl, buttonsEl]) watcher.observe(el)
    return () => watcher.disconnect()
  }, [rootEl, topEl, panelEl, buttonsEl])

  // A phone on its side has its panel beside the map, and the map points north there. Pointing the way it goes, the map is laid out with the marker
  // low and clear of the panel (see `HeadingUp` in MapView.tsx); pointing north, it is in the middle of the part left clear.
  const turned = headingUp && !layout.sideways
  useEffect(() => {
    offsetRef.current = turned ? { x: 0, y: 0 } : layout.offset
    moveRef.current?.(alongRef.current, null)
  }, [turned, layout])

  const index = stretchAt(stretches, shown)
  const stretch = stretches[index]
  const side: Side = stretch?.side ?? 'both'

  // The voice, when it is on, says each new side as the marker reaches it. A word whose side has gone by before it could be said is left out.
  const sideNow = useRef<Side>(side)
  const saidSide = useRef<Side | null>(null)
  useEffect(() => {
    sideNow.current = side
    if (!voice || saidSide.current === side) return
    saidSide.current = side
    say(sideWords(side), { stale: () => sideNow.current !== side })
  }, [voice, side])
  useEffect(() => () => stopSpeaking(), [])

  const changeVoice = () => {
    if (!voice) unlockSpeech()
    else stopSpeaking()
    saidSide.current = null
    setVoice(!voice)
  }

  // A notice goes by itself: one with an Undo stays long enough to use it.
  useEffect(() => {
    if (!notice) return
    const id = setTimeout(() => setNotice(null), notice.undo ? 12000 : 6000)
    return () => clearTimeout(id)
  }, [notice])

  const play = () => {
    if (playing) return setPlaying(false)
    // At the end, Play starts again from the beginning.
    if (alongRef.current >= end) seek(0)
    else moveRef.current?.(alongRef.current, null)
    setPlaying(true)
  }

  const goTo = (target: number | null) => {
    if (target === null) return
    seek(stretches[target]?.startM ?? 0)
  }

  /** The side of the part of the route the marker is in, changed here: only the part picked changes, as when it is changed while driving. */
  const changeSide = async () => {
    setPlaying(false)
    const along = alongRef.current
    const { stretch: here, extents: parts } = sideExtents(route, turns, resolved.list, along)
    if (!here || parts.length === 0) return setNotice({ message: 'There is no part of the route here to change.' })
    const extents = withWholeStretch(parts, here)
    const number = stretchAt(stretches, along) + 1
    const picked = await choose<Side>({
      title: 'Change the Throw Side',
      message: `Stretch ${number} is set to ${SIDE_LABEL[here.side]}. Change it to:`,
      choices: SIDES.filter((s) => s !== here.side).map((s) => ({ value: s, label: SIDE_LABEL[s] })),
    })
    if (!picked) return
    const key = await choose<ExtentKey>({
      title: 'How Much of It?',
      message: 'From where the marker is. Only the part you pick changes, not the rest of the stretch.',
      choices: extents.map((e) => ({ value: e.key, label: e.label, detail: e.detail })),
    })
    const extent = extents.find((e) => e.key === key)
    if (!extent) return
    const next = paintMetres(route, extent.fromM, extent.toM, picked)
    if (!next) return setNotice({ message: 'That part is too short to change.' })
    onAdjustRoute(next)
    const houses = sideChangeSentence(route, next, reachM)
    setNotice({ message: `${extent.label}: now ${SIDE_LABEL[picked]}.${houses ? ` ${houses}` : ''}`, undo: () => onAdjustRoute(route) })
  }

  const editInSetup = () => {
    setPlaying(false)
    onEditStretch(Math.max(0, stretchAt(stretches, alongRef.current)), alongRef.current, speed)
  }

  // What the map's marker moves by: the same refs throughout, and the lines it goes along, new only when the route is.
  const handles = useMemo<PlaybackHandles>(() => ({ drawn, alongRef, offsetRef, moveRef }), [drawn])
  const views0 = views[index]
  const highlight = views0?.points
  const drivenM = stretch?.startM
  // The map is drawn again only when what it shows changes (the stretch, the way it is turned, the panels), not each time the marker moves.
  const map = useMemo(
    () => (
      <MapView
        route={route}
        position={null}
        handled={NONE_DONE}
        reachM={reachM}
        follow
        fit={false}
        drivenM={drivenM}
        highlight={highlight}
        headingUp={turned}
        heading={turned ? mapHeading : null}
        bottomPx={layout.coverPx}
        playback={handles}
        outsideCredit
      />
    ),
    [route, reachM, drivenM, highlight, turned, mapHeading, layout.coverPx, handles],
  )

  // The next turn, as the round's card shows it: within 200 m, or always on transit.
  const guidance = guidanceToShow(named, { onTrack: true, transit: side === 'transit', along: shown, routeEnd: end, heading: null, after: shown - TURN_PASSED_M, reached: shown })
  const guided = guidance ? guidedTurn(guidance) : null
  const section = sectionAt(resolved.list, shown)
  const call = section && !section.lead ? calls.get(section.id) : undefined
  const pass = passNote(views0)
  // The bar to drag along is the route itself, coloured by side, so the whole round's sides are there at a glance.
  const track = useMemo(() => {
    if (!(end > 0)) return SIDE_COLOR.both
    const stops = stretches.flatMap((s) => {
      const a = ((s.startM / end) * 100).toFixed(3)
      const b = ((s.endM / end) * 100).toFixed(3)
      return [`${SIDE_COLOR[s.side]} ${a}%`, `${SIDE_COLOR[s.side]} ${b}%`]
    })
    return `linear-gradient(to right, ${stops.join(', ')})`
  }, [stretches, end])
  const atEnd = shown >= end
  const canSpeak = speechAvailable()

  return (
    <div className="preview" ref={setRootEl} style={{ '--panel-h': `${layout.panelPx}px` } as CSSProperties}>
      {map}

      <div className="map-top preview-top" ref={setTopEl}>
        <button
          className="preview-side"
          style={{ background: SIDE_PILL[side] }}
          aria-label={`Throw side: ${SIDE_LABEL[side]}. Stretch ${index + 1} of ${stretches.length}. Tap to change it.`}
          onClick={() => void changeSide()}
        >
          {/* Keyed by the side, so a new side pops in and is seen to change. */}
          <SideWord key={side} side={side} />
          <span className="preview-side-hint">Stretch {index + 1} · Tap to change</span>
        </button>
        {guidance && <TurnCard key={guidance.kind === 'turn' ? guidance.turn.at : 'straight'} {...guidance} street={guided?.turn.street ?? null} />}
        {/* What a change of side did, under the side it changed, so the panel at the bottom keeps its height and the marker stays clear of it. */}
        {notice && (
          <div className="preview-notice" role="status">
            <span>{notice.message}</span>
            {notice.undo && (
              <button
                className="btn small"
                onClick={() => {
                  notice.undo?.()
                  setNotice(null)
                }}
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>

      <MapCredit compact />
      <div className="preview-buttons" ref={setButtonsEl}>
        {canSpeak && (
          <button className="round-btn" data-on={voice || undefined} aria-pressed={voice} aria-label="Say each side as it comes" onClick={changeVoice}>
            <Icon name={voice ? 'volume-2' : 'volume-x'} size={24} />
          </button>
        )}
        {!layout.sideways && (
          <button
            className="round-btn"
            data-on={headingUp || undefined}
            aria-pressed={headingUp}
            aria-label={headingUp ? 'Map points the way the route goes. Tap to point it north.' : 'Map points north. Tap to point it the way the route goes.'}
            onClick={() => setHeadingUp(!headingUp)}
          >
            <Icon name="compass" size={24} />
          </button>
        )}
        <button className="round-btn" aria-label="Back to the marker" onClick={() => moveRef.current?.(alongRef.current, null)}>
          <Icon name="navigation" size={22} fill />
        </button>
      </div>

      <div className="preview-panel" ref={setPanelEl}>
        <div className="preview-head">
          <div className="grow">
            <div className="title">
              Stretch {index + 1} of {stretches.length}
              {pass && <span className="preview-pass"> · {pass}</span>}
            </div>
            {call && (
              <div className="sub">
                {call.label}
                {call.name && ` · ${call.name}`}
              </div>
            )}
            <div className="sub">
              {formatDistance(shown)} of {formatDistance(end)}
              {!atEnd && ` · ${timeLeftText(secondsLeft(stretches, shown, speed))}`}
              {atEnd && ' · End of the route'}
            </div>
          </div>
          <button className="btn plain preview-done" onClick={onClose}>
            Done
          </button>
        </div>

        <input
          type="range"
          className="preview-scrub"
          style={{ '--track': track } as CSSProperties}
          min={0}
          max={Math.max(1, Math.round(end))}
          step={1}
          value={Math.round(shown)}
          aria-label="Where along the route"
          aria-valuetext={`${formatDistance(shown)} of ${formatDistance(end)}, stretch ${index + 1}, ${SIDE_LABEL[side]}`}
          onChange={(e) => seek(Number(e.target.value))}
        />

        <div className="preview-controls">
          <div className="preview-transport">
            <button className="preview-btn" aria-label="Back to the start of the route" onClick={() => seek(0)}>
              <Icon name="restart" size={20} strokeWidth={2.4} />
            </button>
            <button className="preview-btn" aria-label="Previous stretch" onClick={() => goTo(previousStretch(stretches, alongRef.current))}>
              <Icon name="skip-back" size={20} strokeWidth={2.4} fill />
            </button>
            <button className="preview-btn play" aria-label={playing ? 'Pause' : atEnd ? 'Play again from the start' : 'Play'} onClick={play}>
              <Icon name={playing ? 'pause' : 'play'} size={24} fill />
            </button>
            <button
              className="preview-btn"
              aria-label="Next stretch"
              disabled={nextStretch(stretches, shown) === null}
              onClick={() => goTo(nextStretch(stretches, alongRef.current))}
            >
              <Icon name="skip-forward" size={20} strokeWidth={2.4} fill />
            </button>
          </div>
          <Segmented
            label="How fast it plays"
            value={String(speed)}
            options={PREVIEW_SPEEDS.map((s) => ({ value: String(s), label: `${s}×`, ariaLabel: `${s} times real time` }))}
            onChange={(v) => setSpeed(Number(v) as PreviewSpeed)}
          />
        </div>

        <div className="btn-row">
          <button className="btn secondary" onClick={() => void changeSide()}>
            Change Side
          </button>
          <button className="btn secondary" onClick={editInSetup}>
            <Icon name="edit" size={18} />
            Edit in Setup
          </button>
        </div>
      </div>
      {dialog}
    </div>
  )
}
