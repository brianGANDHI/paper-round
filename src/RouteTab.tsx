import { useState } from 'react'
import { Icon } from './Icon'
import { formatDistance, routeLength } from './routeEdit'
import { Banner } from './ui'
import type { Route } from './types'

interface Props {
  route: Route
  recording: boolean
  tracePoints: number
  drawing: boolean
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

  return (
    <>
      {searching && (
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
      )}

      {p.drawing ? (
        <>
          <div className="group">
            <div className="row">
              <div className="grow">
                <div className="title">Tap along your route</div>
                <div className="sub">In the order you drive it. Zoom in for the bends.</div>
              </div>
            </div>
            <div className="row">
              <div className="title">{points(n)}</div>
              <div className="grow" />
              <div className="trail">{ready ? length : ''}</div>
            </div>
          </div>
          <div className="btn-row">
            <button className="btn secondary" disabled={n === 0} onClick={p.onUndo}>
              <Icon name="undo" size={18} />
              Undo
            </button>
            <button className="btn primary" onClick={p.onDone}>
              Done
            </button>
          </div>
        </>
      ) : ready ? (
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
