import { useEffect } from 'react'
import { CircleMarker, MapContainer, Polyline, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { SIDE_COLOR } from './colors'
import { sideAt } from './geo'
import type { Pt, Route, Side } from './types'

function Follow({ pos }: { pos: Pt | null }) {
  const map = useMap()
  useEffect(() => {
    if (pos) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 17), { animate: true })
  }, [pos, map])
  return null
}

/** `bottomFrac` keeps the fitted route clear of a panel covering that fraction of the map. */
function Fit({ points, bottomFrac }: { points: Pt[]; bottomFrac: number }) {
  const map = useMap()
  useEffect(() => {
    if (points.length < 2) return
    map.fitBounds(
      points.map((p) => [p.lat, p.lng] as [number, number]),
      { paddingTopLeft: [30, 70], paddingBottomRight: [30, 30 + Math.round(map.getSize().y * bottomFrac)] },
    )
    // Fit once per route load, not on every point added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points.length > 1])
  return null
}

function Clicks({ onTap }: { onTap?: (p: Pt) => void }) {
  useMapEvents({ click: (e) => onTap?.({ lat: e.latlng.lat, lng: e.latlng.lng }) })
  return null
}

/** Route split into runs of the same delivery side, each drawn in its own colour. */
function sideRuns(route: Route) {
  const runs: { side: Side; pts: [number, number][] }[] = []
  for (let i = 0; i < route.points.length - 1; i++) {
    const side = sideAt(route, i)
    const a: [number, number] = [route.points[i].lat, route.points[i].lng]
    const b: [number, number] = [route.points[i + 1].lat, route.points[i + 1].lng]
    const last = runs[runs.length - 1]
    if (last && last.side === side) last.pts.push(b)
    else runs.push({ side, pts: [a, b] })
  }
  return runs
}

interface Props {
  route: Route
  position: Pt | null
  handled?: ReadonlySet<string>
  /** Keep the map centred on the position; otherwise the whole route is fitted. */
  follow?: boolean
  /** When fitting, include the live position (round overview, not setup). */
  fitPosition?: boolean
  /** Fraction of the map height covered by a bottom panel, kept clear when fitting. */
  bottomFrac?: number
  onTap?: (p: Pt) => void
}

export function MapView({ route, position, handled, follow, fitPosition, bottomFrac = 0, onTap }: Props) {
  const start = position ?? route.points[0] ?? { lat: 51.5, lng: -0.12 }
  return (
    <MapContainer center={[start.lat, start.lng]} zoom={16} className="map" zoomControl={false}>
      {/* Tiles are a bonus: offline they simply fail and the vector overlay still shows. */}
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="&copy; OpenStreetMap"
        maxZoom={19}
      />
      {sideRuns(route).map((r, i) => (
        <Polyline key={i} positions={r.pts} pathOptions={{ color: SIDE_COLOR[r.side], weight: 6, opacity: 0.85 }} />
      ))}
      {route.stops.map((s) => (
        <CircleMarker
          key={s.id}
          center={[s.lat, s.lng]}
          radius={11}
          pathOptions={{
            color: '#fff',
            weight: 3,
            fillColor: s.type === 'bundle' ? '#1c4fd8' : '#d11a2a',
            fillOpacity: handled?.has(s.id) ? 0.25 : 1,
          }}
        />
      ))}
      {position && (
        <CircleMarker
          center={[position.lat, position.lng]}
          radius={9}
          pathOptions={{ color: '#fff', weight: 3, fillColor: '#111', fillOpacity: 1 }}
        />
      )}
      <Clicks onTap={onTap} />
      {follow ? (
        <Follow pos={position} />
      ) : (
        <Fit points={fitPosition && position ? [...route.points, position] : route.points} bottomFrac={bottomFrac} />
      )}
    </MapContainer>
  )
}
