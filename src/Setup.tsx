import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { quietNoThrows, quietNote, sideNote, stopsWithoutSide } from './alerts'
import { useDialogs } from './confirm'
import { useGps } from './device'
import { SIDE_COLOR, SIDE_LABEL } from './colors'
import { haversine, sideAt, simplify } from './geo'
import { searchPlaces } from './geocode'
import { Icon } from './Icon'
import { MapView, type ViewCmd } from './MapView'
import { passNote, passViews } from './passes'
import type { Spot } from './placement'
import { RouteTab } from './RouteTab'
import {
  appendPoint,
  cleanLabel,
  deletedNote,
  deletePoint,
  deleteSection,
  deleteWarning,
  formatDistance,
  insertPoint,
  MAX_STOP_OFFSET_M,
  movePoint,
  nearestOnRoute,
  ON_ROUTE_M,
  otherSide,
  paintStretch,
  parseQty,
  qtyProblem,
  removeLastPoint,
  removeSplit,
  repeatSection,
  routeLength,
  sections,
  segmentCount,
  setSectionSide,
  stopAt,
  updateStop,
  type RepeatMode,
} from './routeEdit'
import { SidePopover } from './SidePopover'
import { SidesTab } from './SidesTab'
import { StopsTab } from './StopsTab'
import { loadFollowRoads, saveFollowRoads } from './storage'
import { transitNotice, type TransitResult } from './transit'
import { TransitDialog } from './TransitDialog'
import { Banner, RouteChip, Segmented, Sheet } from './ui'
import { useRoadFollow } from './useRoadFollow'
import type { Pt, Route, Side, Stop, StopType } from './types'

type Tab = 'route' | 'sides' | 'stops'
/** What a tap on the map does. */
type Tool = 'none' | 'draw' | 'paint' | 'place'

const TAB_OPTIONS: { value: Tab; label: string }[] = [
  { value: 'route', label: 'Route' },
  { value: 'sides', label: 'Throw Side' },
  { value: 'stops', label: 'Stops' },
]

const MIN_STEP_M = 5
const MAX_ACCURACY_M = 30
const SIMPLIFY_M = 3

interface Props {
  route: Route
  /** Name of the route being edited. */
  routeName: string
  onChange: (r: Route) => void
  onGoRoutes: () => void
}

export function Setup({ route, routeName, onChange, onGoRoutes }: Props) {
  const [tab, setTab] = useState<Tab>('route')
  const [tool, setTool] = useState<Tool>('none')
  const [expanded, setExpanded] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [view, setView] = useState<ViewCmd>()
  const [focus, setFocus] = useState<number | null>(null)
  const [recording, setRecording] = useState(false)
  const [trace, setTrace] = useState<Pt[]>([])
  const [stopType, setStopType] = useState<StopType>('nothrow')
  const [stopQty, setStopQty] = useState('')
  const [stopLabel, setStopLabel] = useState('')
  /** The side new points are drawn on, and the side painted onto a stretch. */
  const [brush, setBrush] = useState<Side>('both')
  /** Taps follow roads instead of joining with straight lines. Needs internet, so it is the drawer's choice. */
  const [follow, setFollow] = useState(loadFollowRoads)
  /** The dialog that routes between two typed addresses. */
  const [addressOpen, setAddressOpen] = useState(false)
  /** The section tapped on the map, and where, while the box for choosing its side is open. */
  const [pick, setPick] = useState<{ index: number; at: Spot; route: Route } | null>(null)
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null)
  /** A point being dragged: shown at its new place until it is dropped. */
  const [drag, setDrag] = useState<{ index: number; pos: Pt } | null>(null)
  /** Where the stretch being painted starts, once its first end is tapped. */
  const [paintStart, setPaintStart] = useState<Pt | null>(null)
  const { fix, error } = useGps(true)
  const { confirm, choose, dialog } = useDialogs()
  const roads = useRoadFollow({ route, side: brush, active: tool === 'draw' && follow, onRoute: onChange, onNotice: setNotice })
  const lastRef = useRef<Pt | null>(null)
  const viewKey = useRef(0)
  const moved = useRef(false)
  const dragFrame = useRef(0)
  const dragNext = useRef<{ index: number; pos: Pt } | null>(null)

  useEffect(() => () => cancelAnimationFrame(dragFrame.current), [])

  const goTo = (cmd: Omit<ViewCmd, 'key'>) => {
    moved.current = true
    setView({ ...cmd, key: (viewKey.current += 1) })
  }

  // With no route yet, start the map where the phone is rather than a default city.
  useEffect(() => {
    if (fix && !moved.current && route.points.length === 0) goTo({ center: fix, zoom: 17 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fix])

  useEffect(() => {
    if (!recording || !fix || fix.accuracy > MAX_ACCURACY_M) return
    if (lastRef.current && haversine(lastRef.current, fix) < MIN_STEP_M) return
    lastRef.current = { lat: fix.lat, lng: fix.lng }
    setTrace((t) => [...t, { lat: fix.lat, lng: fix.lng }])
  }, [fix, recording])

  /** What a tap on the map does. Changing it closes the box on the map, which only makes sense while taps do nothing else. */
  const changeTool = (t: Tool) => {
    setTool(t)
    setPick(null)
  }

  const switchTab = (t: Tab) => {
    setTab(t)
    changeTool('none')
    setNotice(null)
    setSelectedPoint(null)
    setPaintStart(null)
  }

  const secs = sections(route)
  const views = useMemo(() => passViews(route), [route])
  const hasRoute = route.points.length > 1
  const showing: Route = recording
    ? { ...route, points: trace, sideChanges: [], stops: [] }
    : drag
      ? movePoint(route, drag.index, drag.pos)
      : route
  const highlight = focus !== null ? views[focus]?.points : undefined
  /** The section whose box is open, for as long as nothing has changed since it was tapped. */
  const picking = pick && pick.route === route && tool === 'none' && !recording && (tab === 'route' || tab === 'sides') ? pick : null
  const pickedSection = picking ? secs[picking.index] : undefined
  /** When a road is driven twice both passes lie under a tap, so a picked section says which one is meant. */
  const overlapping = views.some((v) => v.repeatOf !== null)

  // Route tab
  const startDraw = () => {
    // Carry on with the side the route already ends on.
    const segs = segmentCount(route)
    if (segs) setBrush(sideAt(route, segs - 1))
    changeTool('draw')
    setExpanded(false)
    setNotice(null)
    setSelectedPoint(null)
  }

  const finishDraw = () => {
    changeTool('none')
    setSelectedPoint(null)
  }

  const undo = () => {
    setSelectedPoint(null)
    // A road lookup is cancelled, and a stretch of road comes off in one go.
    if (roads.undo()) return
    onChange(removeLastPoint(route))
  }

  const changeFollow = (on: boolean) => {
    setFollow(on)
    saveFollowRoads(on)
    setNotice(null)
  }

  /** A note sits at the top of the sheet, which may have been scrolled down to reach the control that made it. */
  const showNoteAtTop = () => requestAnimationFrame(() => document.querySelector('.sheet-body')?.scrollTo({ top: 0, behavior: 'smooth' }))

  const openAddress = () => {
    setSelectedPoint(null)
    setNotice(null)
    setAddressOpen(true)
  }

  /** A road between two typed addresses has been worked out: it joins the route, whole, and Undo takes it off whole. */
  const addTransit = (result: TransitResult) => {
    roads.remember({ added: result.added, replaced: null })
    onChange(result.route)
    setAddressOpen(false)
    // Include the point it joins, so there is always a line to fit.
    goTo({ bounds: result.route.points.slice(Math.max(0, result.route.points.length - result.added.length - 1)) })
    setNotice(transitNotice(result))
    showNoteAtTop()
  }

  const tapPoint = (index: number) => setSelectedPoint((now) => (now === index ? null : index))

  // Dragging redraws the route as it moves, at most once a frame, and saves it only when dropped.
  const dragPoint = (index: number, pos: Pt) => {
    dragNext.current = { index, pos }
    if (dragFrame.current) return
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0
      setDrag(dragNext.current)
    })
  }

  const dropPoint = (index: number, pos: Pt) => {
    cancelAnimationFrame(dragFrame.current)
    dragFrame.current = 0
    dragNext.current = null
    setDrag(null)
    onChange(movePoint(route, index, pos))
  }

  const removePoint = () => {
    if (selectedPoint === null) return
    onChange(deletePoint(route, selectedPoint))
    setSelectedPoint(null)
  }

  const addPointInside = (segment: number) => {
    const added = insertPoint(route, segment)
    if (!added) return
    onChange(added.route)
    setSelectedPoint(added.vertex)
  }

  const startRecord = async () => {
    if (hasRoute) {
      const ok = await confirm({
        title: 'Replace Your Route?',
        message: 'Recording a new route replaces the current route, its sections and its stops.',
        confirmLabel: 'Replace',
        destructive: true,
      })
      if (!ok) return
    }
    lastRef.current = null
    setTrace([])
    changeTool('none')
    setNotice(null)
    setRecording(true)
  }

  const stopRecord = () => {
    setRecording(false)
    const points = simplify(trace, SIMPLIFY_M)
    setTrace([])
    if (points.length < 2) return setNotice('Not enough movement was recorded. Try again, or draw the route on the map.')
    onChange({ points, sideChanges: [{ idx: 0, side: 'both' }], stops: [] })
  }

  const clearRoute = async () => {
    const ok = await confirm({
      title: 'Clear Route?',
      message: 'This removes the route, its side settings and all of its stops.',
      confirmLabel: 'Clear Route',
      destructive: true,
    })
    if (!ok) return
    changeTool('none')
    setFocus(null)
    onChange({ points: [], sideChanges: [], stops: [] })
  }

  const find = async (query: string) => {
    if (!query.trim()) return
    setNotice('Searching...')
    try {
      const [hit] = await searchPlaces(query.trim(), { near: route.points, limit: 1 })
      if (!hit) return setNotice('No place found. Try adding the town or postcode.')
      goTo({ center: hit, zoom: 17 })
      setNotice(null)
    } catch {
      setNotice('Searching needs an internet connection.')
    }
  }

  // Throw side tab
  const changeSide = (index: number, side: Side) => {
    const next = { ...route, sideChanges: setSectionSide(route, index, side) }
    onChange(next)
    // Nothing is thrown on transit, so no-throw houses there stay quiet: say so rather than let it be a surprise.
    const note = side === 'transit' ? quietNote(quietNoThrows(next)) : ''
    setNotice(note || null)
    return note
  }

  /** A section's line was tapped on the map: pick it, and open the box for choosing its side where it was tapped. */
  const tapSection = (index: number, at: Spot) => {
    setFocus(index)
    setPick({ index, at, route })
  }

  const closePick = useCallback(() => setPick(null), [])

  /** A side chosen in the box on the map: the whole section takes it. */
  const chooseSide = (side: Side) => {
    if (!picking || !pickedSection) return
    closePick()
    if (pickedSection.side !== side && changeSide(picking.index, side)) showNoteAtTop()
  }

  /** Delete a section once the person has seen what it takes with it: the stretch of route, and the stops along it. */
  const deleteSectionAt = async (index: number) => {
    const deletion = deleteSection(route, index)
    if (!deletion) return
    const ok = await confirm({
      title: `Delete Section ${index + 1}?`,
      message: deleteWarning(deletion),
      confirmLabel: 'Delete Section',
      destructive: true,
    })
    if (!ok) return
    closePick()
    // Sections are renumbered, so none stays picked, and a stretch half painted no longer fits the route.
    setFocus(null)
    setPaintStart(null)
    onChange(deletion.route)
    setNotice(deletedNote(deletion, index))
    showNoteAtTop()
  }

  /** From the box on the map: paint just part of the section, starting from a side it doesn't have already. */
  const paintPart = () => {
    if (!picking || !pickedSection) return
    if (brush === pickedSection.side) setBrush(otherSide(pickedSection.side))
    setFocus(picking.index)
    switchTab('sides')
    setPainting(true)
  }

  const merge = (index: number) => {
    setFocus(null)
    onChange({ ...route, sideChanges: removeSplit(route, index) })
  }

  const focusSection = (index: number) => {
    setFocus(index)
    const view = views[index]
    if (view) goTo({ bounds: view.points })
  }

  /** Add another pass over a section: back along it, or along it again the same way. */
  const repeat = async (index: number) => {
    const mode = await choose<RepeatMode>({
      title: `Repeat Section ${index + 1}`,
      message: 'Adds this stretch to the end of your route as another pass, with a side of its own.',
      choices: [
        { value: 'back', label: 'Drive it back', detail: 'The same road, the other way' },
        { value: 'again', label: 'Drive it again', detail: 'The same way, with a link back to its start' },
      ],
    })
    if (!mode) return
    const next = repeatSection(route, index, mode)
    if (!next) return setNotice("That section can't be repeated.")
    onChange(next)
    const added = sections(next)
    const last = added.length - 1
    setFocus(last)
    const pass = added[last]
    goTo({ bounds: next.points.slice(pass.idx, pass.endIdx + 1) })
    setNotice(`Added section ${last + 1}, ${mode === 'back' ? 'back along' : 'again along'} section ${index + 1}. Choose which side to throw on for this pass.`)
  }

  /** Paint with a side: tap where the stretch starts, then where it ends. */
  const paintTap = (p: Pt) => {
    const picked = focus !== null ? secs[focus] : undefined
    const range = overlapping && picked ? { from: picked.idx, to: picked.endIdx } : undefined
    if (!paintStart) {
      const snap = nearestOnRoute(route, p, range)
      if (!snap || snap.dist > ON_ROUTE_M) return setNotice('Tap on the route to mark where the stretch starts.')
      setNotice(null)
      return setPaintStart(snap.point)
    }
    const result = paintStretch(route, paintStart, p, brush, range)
    setPaintStart(null)
    if (!result) return setNotice('Tap on the route, away from where the stretch started, to mark where it ends.')
    onChange(result.route)
    // Sections have been renumbered, so no section stays picked.
    setFocus(null)
    const length = routeLength(result.route.points.slice(result.from, result.to + 1))
    const quiet = brush === 'transit' ? quietNote(quietNoThrows(result.route)) : ''
    setNotice(`Painted ${formatDistance(length)} for ${SIDE_LABEL[brush].toLowerCase()}.${quiet ? ` ${quiet}` : ''}`)
  }

  const setPainting = (on: boolean) => {
    changeTool(on ? 'paint' : 'none')
    setPaintStart(null)
    setNotice(null)
    if (on) setExpanded(false)
  }

  // Stops tab
  const addStops = (stops: Stop[]) => {
    const next = { ...route, stops: [...route.stops, ...stops] }
    onChange(next)
    return sideNote(stopsWithoutSide(next, stops).length)
  }

  /** Which side of the road a stop is on, picked by hand: for when the map can't say, or has it wrong. */
  const pickSide = async (id: string) => {
    const stop = route.stops.find((s) => s.id === id)
    if (!stop) return
    const picked = await choose({
      title: 'Which Side of the Road?',
      message: 'As you drive past it the first time. Going the other way it swaps.',
      choices: [
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
        ...(stop.side ? [{ value: 'map', label: 'Work It Out From the Map', detail: 'Use where it sits beside the road' }] : []),
      ],
    })
    if (picked !== 'left' && picked !== 'right' && picked !== 'map') return
    const stops = route.stops.map((s) => {
      if (s.id !== id) return s
      const next = { ...s }
      if (picked === 'map') delete next.side
      else next.side = picked
      return next
    })
    onChange({ ...route, stops })
    setNotice(null)
  }

  const placeStop = (p: Pt) => {
    const problem = stopType === 'bundle' ? qtyProblem(stopQty) : null
    if (problem) return setNotice(problem)
    const qty = stopType === 'bundle' ? parseQty(stopQty) : undefined
    const hit = stopAt(route, p, stopType, { label: cleanLabel(stopLabel), qty })
    if (!hit) return setNotice('Draw your route first.')
    if (hit.offM > MAX_STOP_OFFSET_M) return setNotice(`That spot is ${Math.round(hit.offM)} m from your route. Tap closer to it.`)
    const note = addStops([hit.stop])
    setStopLabel('')
    setNotice(note || null)
  }

  const onTap = (p: Pt) => {
    if (tool === 'draw') {
      // With a point picked, the first tap just puts it down.
      if (selectedPoint !== null) return setSelectedPoint(null)
      if (follow) roads.tap(p)
      else onChange(appendPoint(route, p, brush))
    } else if (tool === 'paint') {
      paintTap(p)
    } else if (tool === 'place') {
      placeStop(p)
    } else {
      closePick()
    }
  }

  return (
    <div className="screen">
      <MapView
        route={showing}
        position={fix}
        follow={recording}
        fit={tool !== 'draw'}
        bottomFrac={tool === 'draw' || tool === 'paint' ? 0.42 : 0.5}
        highlight={picking ? views[picking.index]?.points : tab === 'sides' ? highlight : undefined}
        editable={tool === 'draw'}
        selectedPoint={selectedPoint}
        onPointTap={tapPoint}
        onPointDrag={dragPoint}
        onPointDrop={dropPoint}
        onMidTap={addPointInside}
        selectable={(tab === 'sides' || tab === 'route') && tool === 'none' && !recording}
        onSectionTap={tapSection}
        onMoveStart={closePick}
        pin={
          roads.finding
            ? { pos: roads.finding, label: 'Finding road…', color: SIDE_COLOR[brush] }
            : paintStart
              ? { pos: paintStart, label: 'From here', color: SIDE_COLOR[brush] }
              : null
        }
        view={view}
        onTap={onTap}
      />

      <div className="fab-group">
        <button className="fab" aria-label="Show my location" disabled={!fix} onClick={() => fix && goTo({ center: fix, zoom: 17 })}>
          <Icon name="navigation" />
        </button>
      </div>

      <Sheet
        expanded={expanded}
        onExpandedChange={(open) => {
          setExpanded(open)
          closePick()
        }}
        compact={tool === 'draw' || tool === 'paint'}
        // While drawing or painting, the sheet is just that tool's controls, so the map gets the room.
        header={
          tool === 'draw' || tool === 'paint' ? undefined : (
            <div className="head-stack">
              <RouteChip name={routeName} onClick={onGoRoutes} />
              <Segmented tabs label="Setup step" value={tab} options={TAB_OPTIONS} onChange={switchTab} />
            </div>
          )
        }
      >
        {notice && <Banner>{notice}</Banner>}
        {tab === 'route' && (
          <RouteTab
            route={route}
            recording={recording}
            tracePoints={trace.length}
            drawing={tool === 'draw'}
            brush={brush}
            onBrush={setBrush}
            follow={follow}
            onFollow={changeFollow}
            finding={roads.finding !== null}
            onAddress={openAddress}
            selectedPoint={selectedPoint}
            onDeletePoint={removePoint}
            gpsError={error}
            onDraw={startDraw}
            onDone={finishDraw}
            onUndo={undo}
            onClear={clearRoute}
            onRecord={startRecord}
            onStopRecord={stopRecord}
            onFind={find}
            onNext={() => switchTab('sides')}
          />
        )}
        {tab === 'sides' && (
          <SidesTab
            route={route}
            views={views}
            focus={focus}
            painting={tool === 'paint'}
            onPainting={setPainting}
            brush={brush}
            onBrush={setBrush}
            paintStarted={paintStart !== null}
            onFocus={focusSection}
            onSide={changeSide}
            onMerge={merge}
            onRepeat={repeat}
            onDelete={deleteSectionAt}
            onBack={() => switchTab('route')}
            onNext={() => switchTab('stops')}
          />
        )}
        {tab === 'stops' && (
          <StopsTab
            route={route}
            type={stopType}
            onType={setStopType}
            qty={stopQty}
            onQty={setStopQty}
            label={stopLabel}
            onLabel={setStopLabel}
            placing={tool === 'place'}
            onPlacing={(on) => changeTool(on ? 'place' : 'none')}
            canMark={!!fix}
            onMarkHere={() => fix && placeStop(fix)}
            onAdd={addStops}
            onPickSide={pickSide}
            onEdit={(id, change) => onChange(updateStop(route, id, change))}
            onRemove={(id) => onChange({ ...route, stops: route.stops.filter((s) => s.id !== id) })}
            onFocus={(p) => goTo({ center: p, zoom: 18 })}
            onNotice={setNotice}
            onBack={() => switchTab('route')}
          />
        )}
      </Sheet>
      {picking && pickedSection && (
        <SidePopover
          at={picking.at}
          title={`Section ${picking.index + 1} · ${formatDistance(pickedSection.endM - pickedSection.startM)}`}
          note={passNote(views[picking.index])}
          side={pickedSection.side}
          onSide={chooseSide}
          onPart={paintPart}
          onDelete={secs.length > 1 ? () => void deleteSectionAt(picking.index) : undefined}
          onClose={closePick}
        />
      )}
      <TransitDialog open={addressOpen} route={route} onAdded={addTransit} onClose={() => setAddressOpen(false)} />
      {dialog}
    </div>
  )
}
