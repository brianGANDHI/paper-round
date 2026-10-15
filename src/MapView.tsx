import { useEffect, useMemo, useState } from 'react'
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
import { arrowsAlong, haversine, occurrences } from './geo'
import { passViews } from './passes'
import { AUSTRALIA } from './region'
import type { Pt, Route } from './types'

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
  const start = position ?? route.points[0]
  // With nothing to show yet, open on Australia (decided once, when the map first appears).
  const [opensOnDefault] = useState(() => !start)
  // Each section is drawn from its own path, so a road driven twice shows both passes side by side.
  const views = useMemo(() => passViews(route), [route])
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
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        maxZoom={19}
      />
      <AttributionControl position="topleft" prefix={false} />
      {highlight && highlight.length > 1 && (
        <Polyline positions={highlight.map(toLatLng)} pathOptions={{ ...LINE, color: '#000', weight: 18, opacity: 0.22, interactive: false }} />
      )}
      {/* White casing first so the coloured line stays readable on any map background. */}
      {views.map((v) => (
        <Polyline key={`c${v.index}`} positions={v.points.map(toLatLng)} pathOptions={{ ...LINE, color: '#fff', weight: 10, opacity: 0.95, interactive: false }} />
      ))}
      {views.map((v) => (
        <Polyline key={v.index} positions={v.points.map(toLatLng)} pathOptions={{ ...LINE, color: SIDE_COLOR[v.side], weight: 6, opacity: 1, interactive: false }} />
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
            {!endsWhereItStarts && <Tooltip className="pin-label" permanent direction="top" offset={[0, -8]}>Start</Tooltip>}
          </CircleMarker>
          <CircleMarker center={toLatLng(last)} radius={endsWhereItStarts ? 5 : 8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#1c1c1e', fillOpacity: 1, interactive: false }}>
            <Tooltip className="pin-label" permanent direction="top" offset={[0, -8]}>{endsWhereItStarts ? 'Start & End' : 'End'}</Tooltip>
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
      <Clicks onTap={onTap} />
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
