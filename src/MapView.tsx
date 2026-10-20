import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { divIcon, type DivIcon, type Marker as LeafletMarker } from 'leaflet'
import {
  AttributionControl,
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { SIDE_COLOR, STOP_COLOR } from './colors'
import { arrowsAlong, awayBearing, haversine, occurrences, pathLength, screenPlace, splitPathAt, type Place } from './geo'
import { headingUpLayout } from './mapHeading'
import { houseNumber } from './routeEdit'
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

/** How much of its colour the part of the route already driven keeps. */
const DRIVEN_FADE = 0.28
/** The driven part is cut at multiples of this many metres, so the line isn't redrawn on every fix. */
const DRIVEN_STEP_M = 10

/** A stretch is a solid line in its colour, or a thinner dotted grey one where nothing is thrown. */
function lineStyle(side: Side) {
  return side === 'transit'
    ? { casing: { weight: 8, opacity: 0.55 }, line: { weight: 4, dashArray: '0.5 9' } }
    : { casing: { weight: 10, opacity: 0.95 }, line: { weight: 6 } }
}

/** A stretch's style with only `keep` of its opacity: the part of the route already driven is drawn faded. */
function faded(style: { opacity?: number }, keep: number) {
  return { ...style, opacity: (style.opacity ?? 1) * keep }
}

/** Keeps the map centred on the position. A change of `mode` (north up or heading up) re-centres at once, without gliding. */
function Follow({ pos, mode }: { pos: Pt | null; mode: string }) {
  const map = useMap()
  const lastMode = useRef<string | null>(null)
  useEffect(() => {
    if (!pos) return
    const changed = lastMode.current !== mode
    lastMode.current = mode
    map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 17), { animate: !changed })
  }, [pos, map, mode])
  return null
}

/** Sets how a pinch zooms: about the middle of the map, or about the fingers. Leaflet reads it at each touch. Gives back what it was. */
function setPinchMode(map: ReturnType<typeof useMap>, mode: boolean | 'center' | undefined): boolean | 'center' | undefined {
  const before = map.options.touchZoom
  map.options.touchZoom = mode
  return before
}

/** Turns the map by `heading` degrees, so that way is up the screen, and turns the labels back so they stay upright. */
function turnMap(el: HTMLElement, heading: number | null) {
  if (heading === null) return
  el.style.transform = `rotate(${-heading}deg)`
  el.style.setProperty('--unrot', `${heading}deg`)
}

/**
 * Makes the way the driver is heading the way up the screen. The map is put in a square bigger than the screen, so its corners
 * stay covered at any angle, with the driver's dot at the middle of it, and the square is turned about that dot. It is clipped
 * to the screen by `clip`. One finger can't drag the map (it follows the driver) and two fingers still zoom, about the dot.
 */
function HeadingUp({ on, heading, clip }: { on: boolean; heading: number | null; clip: HTMLElement | null }) {
  const map = useMap()
  /** Two fingers are down: the turn waits, since it would skew what the pinch measures. */
  const frozen = useRef(false)
  const latest = useRef(heading)
  /** The frame request that will start the glide, if one is waiting. */
  const gliding = useRef(0)
  useEffect(() => {
    latest.current = heading
  })

  useEffect(() => {
    if (!on || !clip) return
    const el = map.getContainer()
    const fit = () => {
      const { ax, ay, s } = headingUpLayout(clip.clientWidth, clip.clientHeight)
      clip.style.setProperty('--s', `${s}px`)
      clip.style.setProperty('--ax', `${ax}px`)
      clip.style.setProperty('--ay', `${ay}px`)
      // The map keeps its centre where it is, which is under the dot, whatever size it is now.
      map.invalidateSize()
    }
    const touch = (e: TouchEvent) => {
      const two = e.touches.length > 1
      if (frozen.current && !two) {
        frozen.current = false
        turnMap(el, latest.current)
      } else {
        frozen.current = two
      }
    }
    el.classList.add('heading-up')
    map.dragging.disable()
    const previousZoom = setPinchMode(map, 'center')
    fit()
    turnMap(el, latest.current)
    const watcher = new ResizeObserver(fit)
    watcher.observe(clip)
    for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) clip.addEventListener(type, touch, { passive: true })
    return () => {
      cancelAnimationFrame(gliding.current)
      gliding.current = 0
      watcher.disconnect()
      for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) clip.removeEventListener(type, touch)
      el.classList.remove('heading-up', 'turning')
      el.style.transform = ''
      el.style.removeProperty('--unrot')
      for (const name of ['--s', '--ax', '--ay']) clip.style.removeProperty(name)
      frozen.current = false
      // When the screen is closing the map has already been taken down, and Leaflet can no longer measure it: that is not an error.
      try {
        map.dragging.enable()
        setPinchMode(map, previousZoom)
        map.invalidateSize()
      } catch {
        // Nothing left to put back.
      }
    }
  }, [on, clip, map])

  useEffect(() => {
    if (!on) return
    const el = map.getContainer()
    if (!frozen.current) turnMap(el, heading)
    if (heading === null || gliding.current || el.classList.contains('turning')) return
    // The first heading is put straight in, and the turn glides from two frames later on, so that neither switching on nor the first
    // heading arriving spins the map round from north. A heading that changes in the meantime doesn't start the wait again.
    gliding.current = requestAnimationFrame(() => {
      gliding.current = requestAnimationFrame(() => {
        gliding.current = 0
        el.classList.add('turning')
      })
    })
  }, [on, heading, map])
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

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

const tagIcons = new Map<string, DivIcon>()
/**
 * A label beside a point on the map: `place` is which side of the point it sits. It is turned back by however far the map is
 * turned (see `turnMap`), so it stays upright, and on the same side of its point on the screen, when the map points the way
 * the driver is heading.
 */
function tagIcon(kind: 'pin' | 'house' | 'section', text: string, place: Place, next = false): DivIcon {
  const key = `${kind}|${place}|${next ? 1 : 0}|${text}`
  let icon = tagIcons.get(key)
  if (!icon) {
    icon = divIcon({ className: `tag ${kind}-tag`, html: `<span class="unrot ${place}${next ? ' next' : ''}">${escapeHtml(text)}</span>`, iconSize: [0, 0] })
    tagIcons.set(key, icon)
  }
  return icon
}

/** Where a stop's house number goes: the side clear of the road. */
function HouseTag({ at, text, place, next }: { at: Pt; text: string; place: Place; next: boolean }) {
  return <Marker position={toLatLng(at)} icon={tagIcon('house', text, place, next)} interactive={false} keyboard={false} zIndexOffset={1000} />
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
  /** How far along the route has been driven, in metres: that part is drawn faded. */
  drivenM?: number
  /** The stops an alert is showing for, in the order the route reaches them: each has its house number beside it, and the first a ring round it, so it is clear which they are. */
  active?: readonly string[]
  /** Turn the map so the way the driver is heading is up the screen (while following), instead of north. Only the round uses it. */
  headingUp?: boolean
  /** The way the driver is heading, in degrees clockwise from north, unwrapped (it may be past 360 or below 0, so it never turns the long way round). Null when it isn't known: the map stays north up. */
  heading?: number | null
  /** The OpenStreetMap credit is shown by the screen itself (as `MapCredit`), not inside the map, where turning it would turn the credit too. */
  outsideCredit?: boolean
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
  onSectionTap?: (index: number, at: { x: number; y: number }, pos: Pt) => void
  /** Labelled marks along the route, such as where each named section starts. `on` is the one picked. */
  marks?: readonly { pos: Pt; label: string; on?: boolean }[]
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
  drivenM,
  active,
  headingUp = false,
  heading = null,
  outsideCredit = false,
  highlight,
  editable,
  selectedPoint = null,
  onPointTap,
  onPointDrag,
  onPointDrop,
  onMidTap,
  selectable,
  onSectionTap,
  marks,
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
  // Each section is cut where the driving has got to, so what is behind can be drawn faded and what is ahead as it was.
  const cutKey = drivenM === undefined ? undefined : Math.floor(drivenM / DRIVEN_STEP_M)
  const drawn = useMemo(
    () =>
      views.map((v) => {
        if (cutKey === undefined) return { view: v, before: [] as Pt[], after: v.points }
        const share = v.endM > v.startM ? (cutKey * DRIVEN_STEP_M - v.startM) / (v.endM - v.startM) : 1
        return { view: v, ...splitPathAt(v.points, Math.min(1, Math.max(0, share)) * pathLength(v.points)) }
      }),
    [views, cutKey],
  )
  // Each arrow knows how far along the route it is, to fade with the rest of what has been driven.
  const arrows = useMemo(
    () =>
      views.flatMap((v) => {
        const length = pathLength(v.points)
        return arrowsAlong(v.points, 150).map((a, k) => ({ ...a, routeM: v.startM + (length ? (75 + 150 * k) / length : 0) * (v.endM - v.startM) }))
      }),
    [views],
  )
  const [clip, setClip] = useState<HTMLDivElement | null>(null)
  // How far the map is turned on the screen: house numbers go on the side of the house away from the road as it looks, not as it is on a map with north up.
  const turnedBy = headingUp && follow && heading !== null ? heading : 0
  const first = route.points[0]
  const last = route.points[route.points.length - 1]
  // An out-and-back or a loop ends where it began: one label for both avoids one hiding the other.
  const endsWhereItStarts = !!first && !!last && route.points.length > 2 && haversine(first, last) < 25
  return (
    <div className="map-clip" ref={setClip}>
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
        {!outsideCredit && <AttributionControl position="topleft" prefix={false} />}
        {highlight && highlight.length > 1 && (
          <Polyline positions={highlight.map(toLatLng)} pathOptions={{ ...LINE, color: '#000', weight: 18, opacity: 0.22, interactive: false }} />
        )}
        {/* White casing first so the coloured line stays readable on any map background. */}
        {drawn.map(({ view: v, before, after }) => (
          <Fragment key={v.index}>
            {before.length > 1 && (
              <>
                <Polyline positions={before.map(toLatLng)} pathOptions={{ ...LINE, color: '#fff', ...faded(lineStyle(v.side).casing, DRIVEN_FADE), interactive: false }} />
                <Polyline positions={before.map(toLatLng)} pathOptions={{ ...LINE, color: SIDE_COLOR[v.side], ...faded({ opacity: 1, ...lineStyle(v.side).line }, DRIVEN_FADE), interactive: false }} />
              </>
            )}
            {after.length > 1 && (
              <>
                <Polyline positions={after.map(toLatLng)} pathOptions={{ ...LINE, color: '#fff', ...lineStyle(v.side).casing, interactive: false }} />
                <Polyline positions={after.map(toLatLng)} pathOptions={{ ...LINE, color: SIDE_COLOR[v.side], opacity: 1, ...lineStyle(v.side).line, interactive: false }} />
              </>
            )}
          </Fragment>
        ))}
        {selectable &&
          views.map((v) => (
            <Polyline
              key={`h${v.index}`}
              positions={v.points.map(toLatLng)}
              pathOptions={{ ...LINE, color: '#000', weight: 30, opacity: 0, bubblingMouseEvents: false }}
              eventHandlers={{ click: (e) => onSectionTap?.(v.index, { x: e.containerPoint.x, y: e.containerPoint.y }, { lat: e.latlng.lat, lng: e.latlng.lng }) }}
            />
          ))}
        {arrows.map((a, i) => (
          <Marker
            key={i}
            position={toLatLng(a.pos)}
            icon={arrowIcon(a.bearing)}
            opacity={cutKey !== undefined && cutKey * DRIVEN_STEP_M > a.routeM ? DRIVEN_FADE : 1}
            interactive={false}
            keyboard={false}
          />
        ))}
        {route.points.length > 1 && first && last && (
          <>
            <CircleMarker center={toLatLng(first)} radius={8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#34c759', fillOpacity: 1, interactive: false }} />
            <CircleMarker center={toLatLng(last)} radius={endsWhereItStarts ? 5 : 8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#1c1c1e', fillOpacity: 1, interactive: false }} />
            {!endsWhereItStarts && <Marker position={toLatLng(first)} icon={tagIcon('pin', 'Start', 'top')} interactive={false} keyboard={false} zIndexOffset={1100} />}
            <Marker position={toLatLng(last)} icon={tagIcon('pin', endsWhereItStarts ? 'Start & End' : 'End', 'top')} interactive={false} keyboard={false} zIndexOffset={1100} />
          </>
        )}
        {marks?.map((m, i) => (
          <Fragment key={`${i}${m.label}`}>
            {/* One where the route starts would hide the green dot there: it only has its label. */}
            {!(first && haversine(first, m.pos) < 12) && (
              <CircleMarker center={toLatLng(m.pos)} radius={m.on ? 9 : 7} pathOptions={{ color: '#fff', weight: 3, fillColor: '#007aff', fillOpacity: 1, interactive: false }} />
            )}
            <Marker position={toLatLng(m.pos)} icon={tagIcon('section', m.label, 'right', !!m.on)} interactive={false} keyboard={false} zIndexOffset={900} />
          </Fragment>
        ))}
        {pin && (
          <>
            <CircleMarker center={toLatLng(pin.pos)} radius={9} pathOptions={{ color: pin.color, weight: 5, fillColor: '#fff', fillOpacity: 1, interactive: false }} />
            {/* Below the pin, because the route's Start and End labels sit above theirs. */}
            <Marker position={toLatLng(pin.pos)} icon={tagIcon('pin', pin.label, 'bottom')} interactive={false} keyboard={false} zIndexOffset={1100} />
          </>
        )}
        {route.stops.map((s) => {
          const on = active?.includes(s.id) ?? false
          const number = on ? houseNumber(s) : null
          // The number goes on the side of the house away from the road, so it doesn't hide the road or the houses along it.
          const away = number ? screenPlace(awayBearing(route.points, s), turnedBy) : 'right'
          return (
            <Fragment key={s.id}>
              {active?.[0] === s.id && (
                <CircleMarker center={[s.lat, s.lng]} radius={20} pathOptions={{ color: STOP_COLOR[s.type], weight: 4, fill: false, className: 'stop-ring', interactive: false }} />
              )}
              <CircleMarker
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
              {number && <HouseTag at={s} text={number} place={away} next={active?.[0] === s.id} />}
            </Fragment>
          )
        })}
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
        <HeadingUp on={headingUp && !!follow} heading={heading} clip={clip} />
        {follow ? (
          <Follow pos={position} mode={headingUp ? 'heading' : 'north'} />
        ) : (
          fit && <Fit points={fitPosition && position ? [...route.points, position] : route.points} bottomFrac={bottomFrac} />
        )}
      </MapContainer>
    {headingUp && follow && heading !== null && <div className="heading-chevron" aria-hidden="true" />}
    </div>
  )
}
