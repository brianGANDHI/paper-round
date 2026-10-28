import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { divIcon, type DivIcon, type Marker as LeafletMarker, type MapOptions } from 'leaflet'
import {
  AttributionControl,
  CircleMarker,
  MapContainer,
  Marker,
  Pane,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { alertable, quietHouseIds } from './alerts'
import { LINE_PANES, lineStyle, SIDE_COLOR, STOP_COLOR } from './colors'
import { arrowsAlong, awayBearing, haversine, occurrences, pathLength, screenPlace, splitPathAt, type Place } from './geo'
import { bottomCover, drivenCut, drivenShare, followZoom, headingUpFrac, headingUpLayout, isAhead, userInput, type UserInput } from './mapHeading'
import { houseNumber } from './routeEdit'
import { passViews } from './passes'
import { AUSTRALIA } from './region'
import { fitPadding, followAnimation, settleZoom, stepZoom } from './roundView'
import type { Pt, Route } from './types'

/** Ask the map to move. A new `key` makes it move again, even to the same place. */
export interface ViewCmd {
  key: number
  center?: Pt
  zoom?: number
  bounds?: Pt[]
  /** Zoom in (+1) or out (-1) by this many levels, about the middle of the map: the driver's dot while following. Animated. */
  zoomBy?: number
}

const toLatLng = (p: Pt): [number, number] => [p.lat, p.lng]

const LINE = { lineCap: 'round', lineJoin: 'round' } as const

/** The radius of a no-throw house that never alerts, against 12 for the other stops: it reads as a place on the map, not something to do. */
const QUIET_RADIUS = 7

/** How much of its colour the part of the route already driven keeps. */
const DRIVEN_FADE = 0.28

/** A stretch's style with only `keep` of its opacity: the part of the route already driven is drawn faded. */
function faded(style: { opacity?: number }, keep: number) {
  return { ...style, opacity: (style.opacity ?? 1) * keep }
}

/** Whether the next time the map follows the driver it is brought to street level: true until following has started, and again whenever the map is fitted to the route or a region, which is a zoom of ours, not the driver's. */
type StreetNext = RefObject<boolean>

const setStreet = (street: StreetNext, next: boolean) => {
  street.current = next
}

/**
 * Keeps the map centred on the position. A change of `mode` (north up or heading up) re-centres at once, without gliding.
 *
 * The zoom is the driver's: a fix never changes it. It is only brought in to street level when following starts afresh (the first
 * time, or from the view of the whole route). While `paused` (free look) the map stays where the driver has put it, and goes
 * back to the position, at the zoom it has, the moment it is not. It also waits while a finger is on the map, since that is a
 * drag about to pause it or a pinch zooming about the dot, and is back on the dot at the next fix after the fingers lift. How far
 * the map is glided to the position is left to Leaflet (see `followAnimation`).
 */
function Follow({ pos, mode, paused, street, input }: { pos: Pt | null; mode: string; paused: boolean; street: StreetNext; input: UserInput }) {
  const map = useMap()
  const lastMode = useRef<string | null>(null)
  useEffect(() => {
    if (!pos || paused || input.touching(performance.now())) return
    const changed = lastMode.current !== mode
    lastMode.current = mode
    const zoom = followZoom(map.getZoom(), street.current)
    setStreet(street, false)
    map.setView([pos.lat, pos.lng], zoom, { animate: followAnimation(changed) })
  }, [pos, map, mode, paused, street, input])
  return null
}

type ZoomModes = { touch: MapOptions['touchZoom']; wheel: MapOptions['scrollWheelZoom'] }

/** Sets how a pinch and the wheel zoom: about the middle of the map, or as `modes` says. Leaflet reads the options at each gesture. */
function setZoomAbout(map: ReturnType<typeof useMap>, centre: boolean, modes: ZoomModes) {
  map.options.touchZoom = centre ? 'center' : modes.touch
  map.options.scrollWheelZoom = centre ? 'center' : modes.wheel
}

/**
 * Zooms a pinch (or the wheel) about the middle of the map, which is the driver's dot while they are followed, so the dot stays
 * put and the map isn't pulled back to it afterwards, or about the fingers when they are looking around. Gives back what the map
 * started with.
 */
function ZoomAbout({ centre }: { centre: boolean }) {
  const map = useMap()
  const started = useRef<ZoomModes>({ touch: map.options.touchZoom, wheel: map.options.scrollWheelZoom })
  useEffect(() => {
    const original = started.current
    setZoomAbout(map, centre, original)
    return () => setZoomAbout(map, false, original)
  }, [map, centre])
  return null
}

/**
 * Says when the driver moves the map themselves, and not when the app does (following a fix, fitting the route, the zoom buttons):
 * a drag, or a zoom with fingers, the wheel or keys. It tells at the start of each and again at the end, so a timer on
 * "the last touch" can be started from the end. Leaflet's own `dragstart` is only ever a finger or mouse dragging the map, but a
 * zoom looks the same whoever made it, so it is told by whether a touch, wheel turn or key came just before it (see `userInput`).
 */
function UserMoves({ input, onUserMove }: { input: UserInput; onUserMove?: (kind: 'drag' | 'zoom') => void }) {
  const map = useMap()
  const latest = useRef(onUserMove)
  useEffect(() => {
    latest.current = onUserMove
  })
  useEffect(() => {
    // The map's parent, in the capture phase, so the touch is on record before Leaflet's own handlers (which fire the events) see it.
    const root = map.getContainer().parentElement ?? map.getContainer()
    const touch = (e: TouchEvent) => input.touch(e.touches.length, performance.now())
    const other = () => input.input(performance.now())
    const touches = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const
    const others = ['wheel', 'keydown', 'mousedown'] as const
    for (const type of touches) root.addEventListener(type, touch, { capture: true, passive: true })
    for (const type of others) root.addEventListener(type, other, { capture: true, passive: true })
    const dragged = () => latest.current?.('drag')
    const zoomed = () => {
      if (input.active(performance.now())) latest.current?.('zoom')
    }
    map.on({ dragstart: dragged, dragend: dragged, zoomstart: zoomed, zoomend: zoomed })
    return () => {
      for (const type of touches) root.removeEventListener(type, touch, { capture: true })
      for (const type of others) root.removeEventListener(type, other, { capture: true })
      map.off({ dragstart: dragged, dragend: dragged, zoomstart: zoomed, zoomend: zoomed })
    }
  }, [map, input])
  return null
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
 * to the screen by `clip`. One finger can't drag the map (it follows the driver) and two fingers still zoom, about the dot (see
 * `ZoomAbout`). The dot sits as low as it can and still clear what covers the bottom of the map (`cover`: pixels of the map's
 * height that are covered, or null when that isn't known, and the dot sits 70 percent of the way down).
 */
function HeadingUp({ on, heading, clip, cover }: { on: boolean; heading: number | null; clip: HTMLElement | null; cover: ((height: number) => number) | null }) {
  const map = useMap()
  /** Lays the map out again, for when what covers the bottom changes. */
  const refit = useRef<(() => void) | null>(null)
  const coverNow = useRef(cover)
  /** Two fingers are down: the turn waits, since it would skew what the pinch measures. */
  const frozen = useRef(false)
  const latest = useRef(heading)
  /** The frame request that will start the glide, if one is waiting. */
  const gliding = useRef(0)
  useEffect(() => {
    latest.current = heading
    coverNow.current = cover
  })

  useEffect(() => {
    if (!on || !clip) return
    const el = map.getContainer()
    const fit = () => {
      const height = clip.clientHeight
      const covered = coverNow.current ? coverNow.current(height) : null
      const { ax, ay, s } = headingUpLayout(clip.clientWidth, height, headingUpFrac(height, covered))
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
    refit.current = fit
    fit()
    turnMap(el, latest.current)
    const watcher = new ResizeObserver(fit)
    watcher.observe(clip)
    for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) clip.addEventListener(type, touch, { passive: true })
    return () => {
      refit.current = null
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
        map.invalidateSize()
      } catch {
        // Nothing left to put back.
      }
    }
  }, [on, clip, map])

  // The bar along the bottom grew, shrank or went: the dot moves to clear it.
  useEffect(() => {
    refit.current?.()
  }, [cover])

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

/** How many pixels of a map of the height given are covered along the bottom. */
type Cover = (height: number) => number

/** `coverPx` keeps fitted points clear of a panel covering that many pixels of the bottom of the map (and the buttons down the right: see `fitPadding`). */
function fitTo(map: ReturnType<typeof useMap>, points: Pt[], coverPx: number) {
  const { topLeft, bottomRight } = fitPadding(coverPx)
  map.fitBounds(points.map(toLatLng), { paddingTopLeft: topLeft, paddingBottomRight: bottomRight, maxZoom: 18 })
}

/** Fits the whole route (and the driver) in the part of the map that is not covered. That zoom is ours, so the next time the driver is followed it goes back to street level. */
function Fit({ points, cover, street }: { points: Pt[]; cover: Cover; street: StreetNext }) {
  const map = useMap()
  useEffect(() => {
    if (points.length > 1) {
      fitTo(map, points, cover(map.getSize().y))
      setStreet(street, true)
    }
    // Fit once per route load, not on every point added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points.length > 1])
  return null
}

/** Shows all of Australia, clear of any bottom panel. Runs once, when the map first opens. */
function FitRegion({ cover, street }: { cover: Cover; street: StreetNext }) {
  const map = useMap()
  useEffect(() => {
    fitTo(map, AUSTRALIA.bounds, cover(map.getSize().y))
    setStreet(street, true)
    // Later moves belong to the user, or to a view command such as finding their location.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

function ViewController({ view, cover, street }: { view?: ViewCmd; cover: Cover; street: StreetNext }) {
  const map = useMap()
  /** The zoom the zoom buttons are heading for: a press made while the map is still zooming from the last one steps from there (see `stepZoom`). */
  const goal = useRef<number | null>(null)
  // Whatever the zoom was heading for, a press that was lost to the animation is made up for when the map has stopped zooming.
  useEffect(() => {
    const settle = () => settleZoom(map, goal)
    map.on('zoomend', settle)
    return () => {
      map.off('zoomend', settle)
    }
  }, [map])
  useEffect(() => {
    if (!view) return
    const covered = cover(map.getSize().y)
    if (view.bounds && view.bounds.length > 1) {
      goal.current = null
      fitTo(map, view.bounds, covered)
      setStreet(street, true)
    } else if (view.center) {
      goal.current = null
      map.setView(toLatLng(view.center), view.zoom ?? Math.max(map.getZoom(), 17), { animate: false })
      // Centre in the part of the map the bottom panel leaves visible, not behind it.
      map.panBy([0, Math.round(covered / 2)], { animate: false })
    }
    // A step in or out is about the middle of the map.
    if (view.zoomBy) stepZoom(map, goal, view.zoomBy)
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

const arrowIcons = new Map<string, DivIcon>()
/** A direction arrow along the route, turned `bearing` degrees. Along a transit stretch it is bigger, since that road is followed rather than delivered along. */
function arrowIcon(bearing: number, transit: boolean): DivIcon {
  const deg = Math.round(bearing / 10) * 10
  const key = `${transit ? 't' : 's'}${deg}`
  let icon = arrowIcons.get(key)
  if (!icon) {
    const size = transit ? 22 : 16
    icon = divIcon({
      className: transit ? 'arrow transit' : 'arrow',
      html: `<span style="transform:rotate(${deg}deg)">▲</span>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    })
    arrowIcons.set(key, icon)
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
  /** The stops done, by key (see `occurrences`). Only the round has it, and with it a stop whose every alert is done is drawn faded, and a no-throw house that never alerts (see `quietHouseIds`) small and muted. */
  handled?: ReadonlySet<string>
  /** Keep the map centred on the position. The screen decides this: the map never turns it off by itself. */
  follow?: boolean
  /** Following is paused ("free look", while the driver looks around a north-up map): the map stays where the driver has put it, and goes back to the position, at the zoom it has, as soon as this is false again. Only means anything with `follow`; it stays true there so the whole-route fit does not take over. */
  paused?: boolean
  /** Fit the whole route when not following. On by default. */
  fit?: boolean
  /** When fitting, include the live position (round overview, not setup). */
  fitPosition?: boolean
  /** Fraction of the map height covered by a bottom panel, kept clear when fitting, when centring on a place and (turned to the heading) by the driver's dot. */
  bottomFrac?: number
  /** The same in pixels, for a panel of a set height, such as the bar along the bottom of the round (its height with the bottom safe area). With both, whichever covers more. */
  bottomPx?: number
  /** How far along the route has been driven, in metres: that part is drawn faded, under the part still to come, which is always at full strength. */
  drivenM?: number
  /** The stops an alert is showing for, in the order the route reaches them: each has its house number beside it, and the first a ring round it, so it is clear which they are. */
  active?: readonly string[]
  /** Turn the map so the way the driver is heading is up the screen (while following), instead of north. Only the round uses it. */
  headingUp?: boolean
  /** The way the driver is heading, in degrees clockwise from north, unwrapped (it may be past 360 or below 0, so it never turns the long way round). Null when it isn't known: the map stays north up. */
  heading?: number | null
  /** A dashed line from one place to another, such as from the phone back to where the route was left. */
  guide?: { from: Pt; to: Pt } | null
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
  /** The driver moved the map with their fingers, the wheel or keys: a drag, or a zoom (told at the start of each and at the end). Never called for the app's own moves: following a fix, fitting the route, `ViewCmd`. */
  onUserMove?: (kind: 'drag' | 'zoom') => void
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
  paused = false,
  fit = true,
  fitPosition,
  bottomFrac,
  bottomPx,
  drivenM,
  active,
  headingUp = false,
  heading = null,
  outsideCredit = false,
  guide = null,
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
  onUserMove,
  pin,
  view,
  onTap,
}: Props) {
  const start = position ?? route.points[0]
  // With nothing to show yet, open on Australia (decided once, when the map first appears).
  const [opensOnDefault] = useState(() => !start)
  // Each section is drawn from its own path, so a road driven twice shows both passes side by side.
  const views = useMemo(() => passViews(route, !!editable), [route, editable])
  const tracked = handled !== undefined
  // What alerts and what never does, which only the route's sides and stops decide: worked out once per route, not at every stop done.
  const alerting = useMemo(() => {
    if (!tracked) return null
    const occs = occurrences(route)
    return { occs: alertable(route, occs), quiet: quietHouseIds(route, occs) }
  }, [route, tracked])
  // A stop passed more than once only counts as finished when every pass of it that alerts is handled. A quiet no-throw house has no alert to be handled (it is in `alerting.quiet`, not here).
  const finished = useMemo(() => {
    if (!handled || !alerting) return null
    const done = new Map<string, boolean>()
    for (const o of alerting.occs) done.set(o.stop.id, (done.get(o.stop.id) ?? true) && handled.has(o.key))
    return done
  }, [alerting, handled])
  // Each section is cut where the driving has got to, so what is behind can be drawn faded and what is ahead as it was.
  const cut = drivenCut(drivenM)
  const drawn = useMemo(
    () =>
      views.map((v) => {
        if (cut === undefined) return { view: v, before: [] as Pt[], after: v.points }
        return { view: v, ...splitPathAt(v.points, drivenShare(cut, v.startM, v.endM) * pathLength(v.points)) }
      }),
    [views, cut],
  )
  // Each arrow knows how far along the route it is, so the ones already driven can be left off: a faded arrow among the bright ones is just a muddle.
  const arrows = useMemo(
    () =>
      views.flatMap((v) => {
        const length = pathLength(v.points)
        return arrowsAlong(v.points, 150).map((a, k) => ({
          ...a,
          id: `${v.index}:${k}`,
          transit: v.side === 'transit',
          routeM: v.startM + (length ? (75 + 150 * k) / length : 0) * (v.endM - v.startM),
        }))
      }),
    [views],
  )
  const arrowsAhead = useMemo(() => arrows.filter((a) => isAhead(a.routeM, cut)), [arrows, cut])
  // What covers the bottom of the map, in pixels for a map of a given height. Null for the dot when nothing is said about it.
  const cover = useCallback((height: number) => bottomCover(height, bottomFrac, bottomPx), [bottomFrac, bottomPx])
  const coverKnown = bottomFrac !== undefined || bottomPx !== undefined
  // The driver's own moves of the map are told from the app's by what their fingers (or the wheel or keys) were doing just before.
  const [input] = useState(userInput)
  // Whether the next time the driver is followed the map goes to street level: the first time, and after the map has been fitted to the route.
  const street = useRef(true)
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
        {/*
          The route's lines are in panes of their own, each drawn by its own renderer, so the panes' order is the stacking whatever order
          the lines came in: the emphasis, then what is behind the driver (faded), then the white casings, then the coloured lines still
          to come. What is ahead is always on top, at full strength, even on a road that is driven twice. All of them are under the
          overlay pane, which has the stops, marks, position and guide line, and the marker pane with the arrows and labels.
        */}
        <Pane name={LINE_PANES.highlight.name} style={{ zIndex: LINE_PANES.highlight.zIndex }}>
          {highlight && highlight.length > 1 && (
            <Polyline positions={highlight.map(toLatLng)} pathOptions={{ ...LINE, color: '#000', weight: 18, opacity: 0.22, interactive: false }} />
          )}
        </Pane>
        <Pane name={LINE_PANES.driven.name} style={{ zIndex: LINE_PANES.driven.zIndex }}>
          {drawn.map(({ view: v, before }) =>
            before.length > 1 ? (
              <Fragment key={v.index}>
                <Polyline positions={before.map(toLatLng)} pathOptions={{ ...LINE, color: '#fff', ...faded(lineStyle(v.side).casing, DRIVEN_FADE), interactive: false }} />
                <Polyline positions={before.map(toLatLng)} pathOptions={{ ...LINE, color: SIDE_COLOR[v.side], ...faded({ opacity: 1, ...lineStyle(v.side).line }, DRIVEN_FADE), interactive: false }} />
              </Fragment>
            ) : null,
          )}
        </Pane>
        {/* White casings under every coloured line, so the line stays readable on any map background and one section's casing never cuts into another's line. */}
        <Pane name={LINE_PANES.aheadCasing.name} style={{ zIndex: LINE_PANES.aheadCasing.zIndex }}>
          {drawn.map(({ view: v, after }) =>
            after.length > 1 ? <Polyline key={v.index} positions={after.map(toLatLng)} pathOptions={{ ...LINE, color: '#fff', ...lineStyle(v.side).casing, interactive: false }} /> : null,
          )}
        </Pane>
        <Pane name={LINE_PANES.ahead.name} style={{ zIndex: LINE_PANES.ahead.zIndex }}>
          {drawn.map(({ view: v, after }) =>
            after.length > 1 ? (
              <Polyline key={v.index} positions={after.map(toLatLng)} pathOptions={{ ...LINE, color: SIDE_COLOR[v.side], opacity: 1, ...lineStyle(v.side).line, interactive: false }} />
            ) : null,
          )}
        </Pane>
        {selectable &&
          views.map((v) => (
            <Polyline
              key={`h${v.index}`}
              positions={v.points.map(toLatLng)}
              pathOptions={{ ...LINE, color: '#000', weight: 30, opacity: 0, bubblingMouseEvents: false }}
              eventHandlers={{ click: (e) => onSectionTap?.(v.index, { x: e.containerPoint.x, y: e.containerPoint.y }, { lat: e.latlng.lat, lng: e.latlng.lng }) }}
            />
          ))}
        {arrowsAhead.map((a) => (
          <Marker key={a.id} position={toLatLng(a.pos)} icon={arrowIcon(a.bearing, a.transit)} interactive={false} keyboard={false} />
        ))}
        {route.points.length > 1 && first && last && (
          <>
            <CircleMarker center={toLatLng(first)} radius={8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#34c759', fillOpacity: 1, interactive: false }} />
            <CircleMarker center={toLatLng(last)} radius={endsWhereItStarts ? 5 : 8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#1c1c1e', fillOpacity: 1, interactive: false }} />
            {!endsWhereItStarts && <Marker position={toLatLng(first)} icon={tagIcon('pin', 'Start', 'top')} interactive={false} keyboard={false} zIndexOffset={1100} />}
            <Marker position={toLatLng(last)} icon={tagIcon('pin', endsWhereItStarts ? 'Start & End' : 'End', 'top')} interactive={false} keyboard={false} zIndexOffset={1100} />
          </>
        )}
        {guide && (
          <>
            <Polyline positions={[toLatLng(guide.from), toLatLng(guide.to)]} pathOptions={{ ...LINE, color: '#fff', weight: 8, opacity: 0.9, interactive: false }} />
            <Polyline positions={[toLatLng(guide.from), toLatLng(guide.to)]} pathOptions={{ ...LINE, color: '#d97706', weight: 4, dashArray: '2 9', interactive: false }} />
            <CircleMarker center={toLatLng(guide.to)} radius={8} pathOptions={{ color: '#fff', weight: 3, fillColor: '#d97706', fillOpacity: 1, interactive: false }} />
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
          // A house that never alerts (nothing is thrown on its side) is no job to do or to have done: small and muted, as just a place on the map. Done is faded.
          const quiet = alerting?.quiet.has(s.id) ?? false
          const muted = quiet || (finished?.get(s.id) ?? false)
          return (
            <Fragment key={s.id}>
              {active?.[0] === s.id && (
                <CircleMarker center={[s.lat, s.lng]} radius={20} pathOptions={{ color: STOP_COLOR[s.type], weight: 4, fill: false, className: 'stop-ring', interactive: false }} />
              )}
              <CircleMarker
                center={[s.lat, s.lng]}
                radius={quiet ? QUIET_RADIUS : 12}
                pathOptions={{
                  color: '#fff',
                  weight: 3,
                  fillColor: STOP_COLOR[s.type],
                  fillOpacity: muted ? 0.3 : 1,
                  opacity: muted ? 0.6 : 1,
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
        <UserMoves input={input} onUserMove={onUserMove} />
        {opensOnDefault && <FitRegion cover={cover} street={street} />}
        <ViewController view={view} cover={cover} street={street} />
        <ZoomAbout centre={!!follow && (headingUp || !paused)} />
        <HeadingUp on={headingUp && !!follow} heading={heading} clip={clip} cover={coverKnown ? cover : null} />
        {follow ? (
          <Follow pos={position} mode={headingUp ? 'heading' : 'north'} paused={paused} street={street} input={input} />
        ) : (
          fit && <Fit points={fitPosition && position ? [...route.points, position] : route.points} cover={cover} street={street} />
        )}
      </MapContainer>
    {headingUp && follow && heading !== null && <div className="heading-chevron" aria-hidden="true" />}
    </div>
  )
}
