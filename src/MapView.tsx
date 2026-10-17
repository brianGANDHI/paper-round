import { useEffect, useMemo, useState } from 'react'
import { divIcon, type DivIcon, type Marker as LeafletMarker } from 'leaflet'
import {
  AttributionControl,
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { SIDE_COLOR, STOP_COLOR } from './colors'
import { arrowsAlong, haversine, occurrences } from './geo'
import { passViews } from './passes'
import { AUSTRALIA } from './region'
import type { Pt, Route, Side } from './types'

/** Ask the map to move. A new `key` makes it move again, even to the same place. */
export interface ViewCmd {
  key: number
  center?: Pt
  zoom?: number
  bounds?: Pt[]
}

const toLatLng = (p: Pt): [number, number] => [p.lat, p.lng]

const LINE = { lineCap: 'round', lineJoin: 'round' } as const

/** A stretch is a solid line in its colour, or a thinner dotted grey one where nothing is thrown. */
function lineStyle(side: Side) {
  return side === 'transit'
    ? { casing: { weight: 8, opacity: 0.55 }, line: { weight: 4, dashArray: '0.5 9' } }
    : { casing: { weight: 10, opacity: 0.95 }, line: { weight: 6 } }
}

function Follow({ pos }: { pos: Pt | null }) {
  const map = useMap()
  useEffect(() => {
    if (pos) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 17), { animate: true })
  }, [pos, map])
  return null
}

/** `bottomFrac` keeps fitted points clear of a panel covering that fraction of the map. */
function fitTo(map: ReturnType<typeof useMap>, points: Pt[], bottomFrac: number) {
  map.fitBounds(points.map(toLatLng), {
    paddingTopLeft: [30, 70],
    paddingBottomRight: [30, 30 + Math.round(map.getSize().y * bottomFrac)],
    maxZoom: 18,
  })
}

function Fit({ points, bottomFrac }: { points: Pt[]; bottomFrac: number }) {
  const map = useMap()
  useEffect(() => {
    if (points.length > 1) fitTo(map, points, bottomFrac)
    // Fit once per route load, not on every point added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points.length > 1])
  return null
}

/** Shows all of Australia, clear of any bottom panel. Runs once, when the map first opens. */
function FitRegion({ bottomFrac }: { bottomFrac: number }) {
  const map = useMap()
  useEffect(() => {
    fitTo(map, AUSTRALIA.bounds, bottomFrac)
    // Later moves belong to the user, or to a view command such as finding their location.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

function ViewController({ view, bottomFrac }: { view?: ViewCmd; bottomFrac: number }) {
  const map = useMap()
  useEffect(() => {
    if (!view) return
    if (view.bounds && view.bounds.length > 1) {
      fitTo(map, view.bounds, bottomFrac)
    } else if (view.center) {
      map.setView(toLatLng(view.center), view.zoom ?? Math.max(map.getZoom(), 17), { animate: false })
      // Centre in the part of the map the bottom panel leaves visible, not behind it.
      map.panBy([0, Math.round((map.getSize().y * bottomFrac) / 2)], { animate: false })
    }
    // Only a new command moves the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.key])
  return null
}

function MapEvents({ onTap, onMoveStart }: { onTap?: (p: Pt) => void; onMoveStart?: () => void }) {
  useMapEvents({
    click: (e) => onTap?.({ lat: e.latlng.lat, lng: e.latlng.lng }),
    // Panning, zooming and fitting all move what a box over the map was pointing at.
    movestart: () => onMoveStart?.(),
    zoomstart: () => onMoveStart?.(),
  })
  return null
}

const arrowIcons = new Map<number, DivIcon>()
function arrowIcon(bearing: number): DivIcon {
  const deg = Math.round(bearing / 10) * 10
  let icon = arrowIcons.get(deg)
  if (!icon) {
    icon = divIcon({
      className: 'arrow',
      html: `<span style="transform:rotate(${deg}deg)">▲</span>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    })
    arrowIcons.set(deg, icon)
  }
  return icon
}

const vertexIcons = new Map<boolean, DivIcon>()
/** A point on the route you can drag. The box is bigger than the dot so a finger can find it. */
function vertexIcon(selected: boolean): DivIcon {
  let icon = vertexIcons.get(selected)
  if (!icon) {
    icon = divIcon({ className: selected ? 'vertex on' : 'vertex', html: '<span></span>', iconSize: [44, 44], iconAnchor: [22, 22] })
    vertexIcons.set(selected, icon)
  }
  return icon
}

let midIconCache: DivIcon | undefined
/** The "+" halfway along a stretch: tap it to add a point there. */
const midIcon = () => (midIconCache ??= divIcon({ className: 'mid', html: '<span>+</span>', iconSize: [36, 36], iconAnchor: [18, 18] }))

/** Stretches shorter than this are too small for a "+" handle. */
const MID_HANDLE_MIN_M = 30

const where = (e: { target: unknown }): Pt => {
  const at = (e.target as LeafletMarker).getLatLng()
  return { lat: at.lat, lng: at.lng }
}

interface HandlesProps {
  points: Pt[]
  selected: number | null
  onTap?: (index: number) => void
  onDrag?: (index: number, pos: Pt) => void
  onDrop?: (index: number, pos: Pt) => void
  onMid?: (segment: number) => void
}

/** Draggable handles on every point, and "+" handles on the longer stretches between them. */
function EditHandles({ points, selected, onTap, onDrag, onDrop, onMid }: HandlesProps) {
  return (
    <>
      {points.slice(0, -1).map((a, i) => {
        const b = points[i + 1]
        if (haversine(a, b) < MID_HANDLE_MIN_M) return null
        return (
          <Marker
            key={`m${i}`}
            position={[(a.lat + b.lat) / 2, (a.lng + b.lng) / 2]}
            icon={midIcon()}
            keyboard={false}
            eventHandlers={{ click: () => onMid?.(i) }}
          />
        )
      })}
      {points.map((p, i) => (
        <Marker
          key={`v${i}`}
          position={toLatLng(p)}
          icon={vertexIcon(i === selected)}
          draggable
          keyboard={false}
          zIndexOffset={i === selected ? 1000 : 500}
          eventHandlers={{
            click: () => onTap?.(i),
            drag: (e) => onDrag?.(i, where(e)),
            dragend: (e) => onDrop?.(i, where(e)),
          }}
        />
      ))}
    </>
  )
}

interface Props {
  route: Route
  position: Pt | null
  handled?: ReadonlySet<string>
  /** Keep the map centred on the position. */
  follow?: boolean
  /** Fit the whole route when not following. On by default. */
  fit?: boolean
  /** When fitting, include the live position (round overview, not setup). */
  fitPosition?: boolean
  /** Fraction of the map height covered by a bottom panel, kept clear when fitting. */
  bottomFrac?: number
  /** A stretch of the route to emphasise. */
  highlight?: Pt[]
  /** Show draggable handles on the route's points, for editing. Sections are drawn on their true lines. */
  editable?: boolean
  /** The point picked in the editor. */
  selectedPoint?: number | null
  onPointTap?: (index: number) => void
  onPointDrag?: (index: number, pos: Pt) => void
  onPointDrop?: (index: number, pos: Pt) => void
  onMidTap?: (segment: number) => void
  /** Tapping a section's line selects it, and says where on the map, in pixels from its top left corner. */
  selectable?: boolean
  onSectionTap?: (index: number, at: { x: number; y: number }) => void
  /** The map starts to move: panned, zoomed or fitted. */
  onMoveStart?: () => void
  /** A labelled pin, for example where a stretch being painted starts. It is a ring in `color`, so it reads apart from the route's own markers. */
  pin?: { pos: Pt; label: string; color: string } | null
  view?: ViewCmd
  onTap?: (p: Pt) => void
}

export function MapView({
  route,
  position,
  handled,
  follow,
  fit = true,
  fitPosition,
  bottomFrac = 0,
  highlight,
  editable,
  selectedPoint = null,
  onPointTap,
  onPointDrag,
  onPointDrop,
  onMidTap,
  selectable,
  onSectionTap,
  onMoveStart,
  pin,
  view,
  onTap,
}: Props) {
  const start = position ?? route.points[0]
  // With nothing to show yet, open on Australia (decided once, when the map first appears).
  const [opensOnDefault] = useState(() => !start)
  // Each section is drawn from its own path, so a road driven twice shows both passes side by side.
  const views = useMemo(() => passViews(route, !!editable), [route, editable])
  // A stop passed more than once only counts as finished when every pass of it is handled.
  const finished = useMemo(() => {
    if (!handled) return null
    const done = new Map<string, boolean>()
    for (const o of occurrences(route)) done.set(o.stop.id, (done.get(o.stop.id) ?? true) && handled.has(o.key))
    return done
  }, [route, handled])
  const arrows = useMemo(() => views.flatMap((v) => arrowsAlong(v.points, 150)), [views])
  const first = route.points[0]
  const last = route.points[route.points.length - 1]
  // An out-and-back or a loop ends where it began: one label for both avoids one hiding the other.
  const endsWhereItStarts = !!first && !!last && route.points.length > 2 && haversine(first, last) < 25
  return (
    <MapContainer
      center={toLatLng(start ?? AUSTRALIA.center)}
      zoom={start ? 16 : AUSTRALIA.zoom}
      className="map"
      zoomControl={false}
      attributionControl={false}
      doubleClickZoom={false}
    >
      {/* Tiles are a bonus: offline they simply fail and the vector overlay still shows. */}
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; <a href="https://www.openstreetmap.org/fixthemap">Fix the map</a>'
        maxZoom={19}
      />
      <AttributionControl position="topleft" prefix={false} />
      {highlight && highlight.length > 1 && (
        <Polyline positions={highlight.map(toLatLng)} pathOptions={{ ...LINE, color: '#000', weight: 18, opacity: 0.22, interactive: false }} />
      )}
      {/* White casing first so the coloured line stays readable on any map background. */}
      {views.map((v) => (
        <Polyline key={`c${v.index}`} positions={v.points.map(toLatLng)} pathOptions={{ ...LINE, color: '#fff', ...lineStyle(v.side).casing, interactive: false }} />
      ))}
      {views.map((v) => (
        <Polyline key={v.index} positions={v.points.map(toLatLng)} pathOptions={{ ...LINE, color: SIDE_COLOR[v.side], opacity: 1, ...lineStyle(v.side).line, interactive: false }} />
      ))}
      {selectable &&
        views.map((v) => (
          <Polyline
            key={`h${v.index}`}
            positions={v.points.map(toLatLng)}
            pathOptions={{ ...LINE, color: '#000', weight: 30, opacity: 0, bubblingMouseEvents: false }}
            eventHandlers={{ click: (e) => onSectionTap?.(v.index, { x: e.containerPoint.x, y: e.containerPoint.y }) }}
          />
        ))}
      {arrows.map((a, i) => (
        <Marker key={i} position={toLatLng(a.pos)} icon={arrowIcon(a.bearing)} interactive={false} keyboard={false} />
      ))}
      {route.points.length > 1 && first && last && (
        <>
          <CircleMarker center={toLatLng(first)} radius={8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#34c759', fillOpacity: 1, interactive: false }}>
            {!endsWhereItStarts && <Tooltip className="pin-label" permanent direction="top" offset={[0, -8]}>Start</Tooltip>}
          </CircleMarker>
          <CircleMarker center={toLatLng(last)} radius={endsWhereItStarts ? 5 : 8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#1c1c1e', fillOpacity: 1, interactive: false }}>
            <Tooltip className="pin-label" permanent direction="top" offset={[0, -8]}>{endsWhereItStarts ? 'Start & End' : 'End'}</Tooltip>
          </CircleMarker>
        </>
      )}
      {pin && (
        <CircleMarker center={toLatLng(pin.pos)} radius={9} pathOptions={{ color: pin.color, weight: 5, fillColor: '#fff', fillOpacity: 1, interactive: false }}>
          {/* Below the pin, because the route's Start and End labels sit above theirs. */}
          <Tooltip className="pin-label" permanent direction="bottom" offset={[0, 10]}>{pin.label}</Tooltip>
        </CircleMarker>
      )}
      {route.stops.map((s) => (
        <CircleMarker
          key={s.id}
          center={[s.lat, s.lng]}
          radius={12}
          pathOptions={{
            color: '#fff',
            weight: 3,
            fillColor: STOP_COLOR[s.type],
            fillOpacity: finished?.get(s.id) ? 0.3 : 1,
            opacity: finished?.get(s.id) ? 0.6 : 1,
            interactive: false,
          }}
        />
      ))}
      {position && (
        <>
          <CircleMarker center={toLatLng(position)} radius={22} pathOptions={{ stroke: false, fillColor: '#007aff', fillOpacity: 0.16, interactive: false }} />
          <CircleMarker center={toLatLng(position)} radius={9} pathOptions={{ color: '#fff', weight: 3.5, fillColor: '#007aff', fillOpacity: 1, interactive: false }} />
        </>
      )}
      {editable && (
        <EditHandles points={route.points} selected={selectedPoint} onTap={onPointTap} onDrag={onPointDrag} onDrop={onPointDrop} onMid={onMidTap} />
      )}
      <MapEvents onTap={onTap} onMoveStart={onMoveStart} />
      {opensOnDefault && <FitRegion bottomFrac={bottomFrac} />}
      <ViewController view={view} bottomFrac={bottomFrac} />
      {follow ? (
        <Follow pos={position} />
      ) : (
        fit && <Fit points={fitPosition && position ? [...route.points, position] : route.points} bottomFrac={bottomFrac} />
      )}
    </MapContainer>
  )
}
