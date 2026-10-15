import { useEffect, useMemo } from 'react'
import { divIcon, type DivIcon } from 'leaflet'
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
import { arrowsAlong, sideAt } from './geo'
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

function Clicks({ onTap }: { onTap?: (p: Pt) => void }) {
  useMapEvents({ click: (e) => onTap?.({ lat: e.latlng.lat, lng: e.latlng.lng }) })
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

/** Route split into runs of the same delivery side, each drawn in its own colour. */
function sideRuns(route: Route) {
  const runs: { side: Side; pts: [number, number][] }[] = []
  for (let i = 0; i < route.points.length - 1; i++) {
    const side = sideAt(route, i)
    const last = runs[runs.length - 1]
    if (last && last.side === side) last.pts.push(toLatLng(route.points[i + 1]))
    else runs.push({ side, pts: [toLatLng(route.points[i]), toLatLng(route.points[i + 1])] })
  }
  return runs
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
  /** Show a dot on every route point, for drawing. */
  vertices?: boolean
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
  vertices,
  view,
  onTap,
}: Props) {
  const start = position ?? route.points[0] ?? { lat: 51.5, lng: -0.12 }
  const arrows = useMemo(() => arrowsAlong(route.points, 150), [route.points])
  const runs = sideRuns(route)
  const first = route.points[0]
  const last = route.points[route.points.length - 1]
  return (
    <MapContainer
      center={toLatLng(start)}
      zoom={16}
      className="map"
      zoomControl={false}
      attributionControl={false}
      doubleClickZoom={false}
    >
      {/* Tiles are a bonus: offline they simply fail and the vector overlay still shows. */}
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        maxZoom={19}
      />
      <AttributionControl position="topleft" prefix={false} />
      {highlight && highlight.length > 1 && (
        <Polyline positions={highlight.map(toLatLng)} pathOptions={{ ...LINE, color: '#000', weight: 18, opacity: 0.22, interactive: false }} />
      )}
      {/* White casing first so the coloured line stays readable on any map background. */}
      {runs.map((r, i) => (
        <Polyline key={`c${i}`} positions={r.pts} pathOptions={{ ...LINE, color: '#fff', weight: 10, opacity: 0.95, interactive: false }} />
      ))}
      {runs.map((r, i) => (
        <Polyline key={i} positions={r.pts} pathOptions={{ ...LINE, color: SIDE_COLOR[r.side], weight: 6, opacity: 1, interactive: false }} />
      ))}
      {arrows.map((a, i) => (
        <Marker key={i} position={toLatLng(a.pos)} icon={arrowIcon(a.bearing)} interactive={false} keyboard={false} />
      ))}
      {vertices &&
        route.points.map((p, i) => (
          <CircleMarker
            key={i}
            center={toLatLng(p)}
            radius={4.5}
            pathOptions={{ color: '#fff', weight: 2, fillColor: '#1c1c1e', fillOpacity: 1, interactive: false }}
          />
        ))}
      {route.points.length > 1 && first && last && (
        <>
          <CircleMarker center={toLatLng(first)} radius={8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#34c759', fillOpacity: 1, interactive: false }}>
            <Tooltip className="pin-label" permanent direction="top" offset={[0, -8]}>Start</Tooltip>
          </CircleMarker>
          <CircleMarker center={toLatLng(last)} radius={8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#1c1c1e', fillOpacity: 1, interactive: false }}>
            <Tooltip className="pin-label" permanent direction="top" offset={[0, -8]}>End</Tooltip>
          </CircleMarker>
        </>
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
            fillOpacity: handled?.has(s.id) ? 0.3 : 1,
            opacity: handled?.has(s.id) ? 0.6 : 1,
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
      <Clicks onTap={onTap} />
      <ViewController view={view} bottomFrac={bottomFrac} />
      {follow ? (
        <Follow pos={position} />
      ) : (
        fit && <Fit points={fitPosition && position ? [...route.points, position] : route.points} bottomFrac={bottomFrac} />
      )}
    </MapContainer>
  )
}
