import { useState } from 'react'
import { Icon } from './Icon'
import { formatDistance, routeLength } from './routeEdit'
import { BRUSH_OPTIONS } from './sideOptions'
import { Banner, Segmented } from './ui'
import type { Route, Side } from './types'

interface Props {
  route: Route
  recording: boolean
  tracePoints: number
  drawing: boolean
  /** The side new points are drawn on. */
  brush: Side
  onBrush: (side: Side) => void
  /** Taps follow roads (which needs internet), and whether a road is being looked up right now. */
  follow: boolean
  onFollow: (on: boolean) => void
  finding: boolean
  /** The point picked on the map, if any. */
  selectedPoint: number | null
  onDeletePoint: () => void
  gpsError: string | null
  onDraw: () => void
  onDone: () => void
  onUndo: () => void
  onClear: () => void
  onRecord: () => void
  onStopRecord: () => void
  onFind: (query: string) => void
  onNext: () => void
}

const points = (n: number) => `${n} ${n === 1 ? 'point' : 'points'}`

export function RouteTab(p: Props) {
  const [query, setQuery] = useState('')
  const n = p.route.points.length
  const ready = n > 1
  const length = formatDistance(routeLength(p.route.points))

  if (p.recording) {
    return (
      <>
        <div className="group">
          <div className="row">
            <span className="rec-dot" />
            <div className="grow">
              <div className="title">Recording your route</div>
              <div className="sub">{points(p.tracePoints)} so far. Drive your round as normal.</div>
            </div>
          </div>
        </div>
        {p.gpsError && <Banner kind="warn">{p.gpsError}</Banner>}
        <button className="btn primary block" onClick={p.onStopRecord}>
          Stop and Save Route
        </button>
      </>
    )
  }

  // Searching only helps while finding the area to draw in.
  const searching = p.drawing || !ready
  const searchBox = searching && (
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        p.onFind(query)
      }}
    >
      <Icon name="search" size={18} />
      <input
        type="search"
        enterKeyHint="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for a street or town"
        aria-label="Search for a street or town"
      />
    </form>
  )

  if (p.drawing) {
    return (
      <>
        <div className="brush">
          <div className="brush-label">New points are thrown on</div>
          <Segmented label="Side for the points you add" value={p.brush} options={BRUSH_OPTIONS} onChange={p.onBrush} />
        </div>
        <div className="btn-row tools">
          {/* While a road is being looked up, this cancels that tap instead of taking back the one before. */}
          <button className="btn secondary" disabled={n === 0} onClick={p.onUndo}>
            <Icon name={p.finding ? 'x' : 'undo'} size={18} />
            {p.finding ? 'Cancel' : 'Undo'}
          </button>
          <button
            className="btn secondary"
            data-on={p.follow || undefined}
            aria-pressed={p.follow}
            title="Taps follow the streets. Needs internet."
            onClick={() => p.onFollow(!p.follow)}
          >
            <Icon name="route" size={18} />
            Follow roads
          </button>
          <button className="btn primary" onClick={p.onDone}>
            Done
          </button>
        </div>
        {p.selectedPoint !== null ? (
          <div className="group">
            <div className="row">
              <div className="grow">
                <div className="title">
                  Point {p.selectedPoint + 1} of {n}
                </div>
                <div className="sub">Drag it to move it.</div>
              </div>
              <button className="btn plain danger small" onClick={p.onDeletePoint}>
                Delete Point
              </button>
            </div>
          </div>
        ) : (
          <p className="footnote">
            {points(n)}
            {ready ? ` · ${length}` : ''}.{' '}
            {p.follow
              ? 'Tap the map and the route follows the streets there (routing by OSRM, run by FOSSGIS).'
              : 'Tap the map to add points in the order you drive, or turn on Follow roads (needs internet) to have each tap follow the streets.'}{' '}
            Change the side above to start a new section. Drag a point to move it, tap it to delete it, or tap a + to add a point there.
          </p>
        )}
        {searchBox}
      </>
    )
  }

  return (
    <>
      {searchBox}

      {ready ? (
        <>
          <div className="group">
            <div className="row">
              <span className="icon-tint" style={{ color: 'var(--green)' }}>
                <Icon name="check" size={22} strokeWidth={2.6} />
              </span>
              <div className="grow">
                <div className="title">Route ready</div>
                <div className="sub">
                  {length} · {points(n)}
                </div>
                <div className="sub">Saved automatically on this phone</div>
              </div>
            </div>
          </div>
          <button className="btn primary block" onClick={p.onNext}>
            Next: Choose Throw Side
          </button>
          <div className="btn-row">
            <button className="btn secondary" onClick={p.onDraw}>
              <Icon name="edit" size={18} />
              Edit Route
            </button>
            <button className="btn secondary" onClick={p.onRecord}>
              Record Again
            </button>
          </div>
          <button className="btn plain danger block" onClick={p.onClear}>
            Clear Route
          </button>
        </>
      ) : (
        <>
          <div className="group">
            <div className="row">
              <div className="grow">
                <div className="title">{n === 0 ? 'Draw your round' : 'Keep drawing'}</div>
                <div className="sub">
                  Search for your area above, then tap along the streets in the order you drive them. No driving needed.
                </div>
              </div>
            </div>
          </div>
          <button className="btn primary block" onClick={p.onDraw}>
            <Icon name="edit" size={20} />
            {n === 0 ? 'Draw Route' : 'Continue Drawing'}
          </button>
          <button className="btn plain block" onClick={p.onRecord}>
            Record by Driving Instead
          </button>
          {n > 0 && (
            <button className="btn plain danger block" onClick={p.onClear}>
              Clear Route
            </button>
          )}
        </>
      )}
    </>
  )
}
