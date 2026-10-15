import { useEffect, useRef, useState } from 'react'
import { useConfirm } from './confirm'
import { useGps } from './device'
import { haversine, simplify } from './geo'
import { searchPlaces } from './geocode'
import { Icon } from './Icon'
import { MapView, type ViewCmd } from './MapView'
import { RouteTab } from './RouteTab'
import {
  appendPoint,
  MAX_STOP_OFFSET_M,
  removeLastPoint,
  removeSplit,
  sections,
  setSectionSide,
  splitAt,
  stopAt,
} from './routeEdit'
import { SidesTab } from './SidesTab'
import { StopsTab } from './StopsTab'
import { Banner, Segmented, Sheet } from './ui'
import type { Pt, Route, Side, Stop, StopType } from './types'

type Tab = 'route' | 'sides' | 'stops'
/** What a tap on the map does. */
type Tool = 'none' | 'draw' | 'split' | 'place'

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
  onChange: (r: Route) => void
}

export function Setup({ route, onChange }: Props) {
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
  const { fix, error } = useGps(true)
  const { confirm, dialog } = useConfirm()
  const lastRef = useRef<Pt | null>(null)
  const viewKey = useRef(0)
  const moved = useRef(false)

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

  const switchTab = (t: Tab) => {
    setTab(t)
    setTool('none')
    setNotice(null)
  }

  const secs = sections(route)
  const hasRoute = route.points.length > 1
  const showing: Route = recording ? { ...route, points: trace, sideChanges: [], stops: [] } : route
  const highlight = focus !== null && secs[focus] ? route.points.slice(secs[focus].idx, secs[focus].endIdx + 1) : undefined

  // Route tab
  const startDraw = () => {
    setTool('draw')
    setExpanded(false)
    setNotice(null)
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
    setTool('none')
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
    setTool('none')
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
  const changeSide = (index: number, side: Side) => onChange({ ...route, sideChanges: setSectionSide(route, index, side) })

  const merge = (index: number) => {
    setFocus(null)
    onChange({ ...route, sideChanges: removeSplit(route, index) })
  }

  const focusSection = (index: number) => {
    setFocus(index)
    const s = secs[index]
    if (s) goTo({ bounds: route.points.slice(s.idx, s.endIdx + 1) })
  }

  // Stops tab
  const addStops = (stops: Stop[]) => onChange({ ...route, stops: [...route.stops, ...stops] })

  const placeStop = (p: Pt) => {
    const qty = stopType === 'bundle' ? Number.parseInt(stopQty, 10) || undefined : undefined
    const hit = stopAt(route, p, stopType, { label: stopLabel.trim() || undefined, qty })
    if (!hit) return setNotice('Draw your route first.')
    if (hit.offM > MAX_STOP_OFFSET_M) return setNotice(`That spot is ${Math.round(hit.offM)} m from your route. Tap closer to it.`)
    addStops([hit.stop])
    setStopLabel('')
    setNotice(null)
  }

  const onTap = (p: Pt) => {
    if (tool === 'draw') {
      onChange(appendPoint(route, p))
    } else if (tool === 'split') {
      const next = splitAt(route, p)
      if (!next) return setNotice('Tap on the route, away from its very start and end.')
      setNotice(null)
      setFocus(null)
      onChange(next)
    } else if (tool === 'place') {
      placeStop(p)
    }
  }

  return (
    <div className="screen">
      <MapView
        route={showing}
        position={fix}
        follow={recording}
        fit={tool !== 'draw'}
        bottomFrac={0.5}
        highlight={tab === 'sides' ? highlight : undefined}
        vertices={tool === 'draw'}
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
        onExpandedChange={setExpanded}
        header={<Segmented tabs label="Setup step" value={tab} options={TAB_OPTIONS} onChange={switchTab} />}
      >
        {notice && <Banner>{notice}</Banner>}
        {tab === 'route' && (
          <RouteTab
            route={route}
            recording={recording}
            tracePoints={trace.length}
            drawing={tool === 'draw'}
            gpsError={error}
            onDraw={startDraw}
            onDone={() => setTool('none')}
            onUndo={() => onChange(removeLastPoint(route))}
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
            focus={focus}
            splitting={tool === 'split'}
            onSplitting={(on) => setTool(on ? 'split' : 'none')}
            onFocus={focusSection}
            onSide={changeSide}
            onMerge={merge}
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
            onPlacing={(on) => setTool(on ? 'place' : 'none')}
            canMark={!!fix}
            onMarkHere={() => fix && placeStop(fix)}
            onAdd={addStops}
            onRemove={(id) => onChange({ ...route, stops: route.stops.filter((s) => s.id !== id) })}
            onFocus={(p) => goTo({ center: p, zoom: 18 })}
            onNotice={setNotice}
            onBack={() => switchTab('route')}
          />
        )}
      </Sheet>
      {dialog}
    </div>
  )
}
