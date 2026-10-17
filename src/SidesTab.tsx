import { useEffect } from 'react'
import { SIDE_COLOR } from './colors'
import { Icon } from './Icon'
import { passNote, type PassView } from './passes'
import { formatDistance, sections } from './routeEdit'
import { BRUSH_OPTIONS } from './sideOptions'
import { Banner, Empty, Segmented } from './ui'
import type { Route, Side } from './types'

const SIDE_OPTIONS: { value: Side; label: string; ariaLabel: string }[] = [
  { value: 'both', label: 'Both', ariaLabel: 'Both sides' },
  { value: 'left', label: 'Left', ariaLabel: 'Left side' },
  { value: 'right', label: 'Right', ariaLabel: 'Right side' },
  { value: 'transit', label: 'Transit', ariaLabel: 'Transit, no throwing' },
]

interface Props {
  route: Route
  /** How each section is drawn, which says which ones repeat an earlier one. */
  views: PassView[]
  focus: number | null
  /** Whether the paint tool is on, which side it paints with, and whether a stretch has been started. */
  painting: boolean
  onPainting: (on: boolean) => void
  brush: Side
  onBrush: (side: Side) => void
  paintStarted: boolean
  onFocus: (index: number) => void
  onSide: (index: number, side: Side) => void
  onMerge: (index: number) => void
  onRepeat: (index: number) => void
  onDelete: (index: number) => void
  onBack: () => void
  onNext: () => void
}

export function SidesTab({
  route,
  views,
  focus,
  painting,
  onPainting,
  brush,
  onBrush,
  paintStarted,
  onFocus,
  onSide,
  onMerge,
  onRepeat,
  onDelete,
  onBack,
  onNext,
}: Props) {
  // A section picked on the map comes into view in the list.
  useEffect(() => {
    if (focus !== null) document.getElementById(`section-${focus}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focus])

  if (route.points.length < 2) {
    return (
      <Empty
        icon={<Icon name="edit" size={26} />}
        title="Draw Your Route First"
        action={
          <button className="btn primary" onClick={onBack}>
            Go to Route
          </button>
        }
      >
        Once your route is on the map, you can choose which side you throw on for each part of it.
      </Empty>
    )
  }

  const secs = sections(route)
  const repeated = views.some((v) => v.repeatOf !== null)
  return (
    <>
      {!painting && (
        <p className="footnote">
          Tap a line on the map to change its side right there. Left and right are as you face the way you drive, and the arrows on the map show
          that direction.
        </p>
      )}

      <button className="btn secondary block" data-on={painting || undefined} onClick={() => onPainting(!painting)}>
        <Icon name={painting ? 'check' : 'droplet'} size={20} strokeWidth={2.2} />
        {painting ? 'Done Painting' : 'Paint a Stretch'}
      </button>
      {painting && (
        <>
          <div className="brush">
            <div className="brush-label">Paint with</div>
            <Segmented label="Side to paint with" value={brush} options={BRUSH_OPTIONS} onChange={onBrush} />
          </div>
          <Banner>
            {paintStarted
              ? 'Now tap the route where the stretch ends.'
              : 'Tap the route where the stretch starts, then where it ends. Pick a section first if the road is driven twice.'}
          </Banner>
        </>
      )}

      {secs.map((s) => {
        const view = views[s.index]
        const note = passNote(view)
        return (
          <div key={s.idx} id={`section-${s.index}`} className={focus === s.index ? 'card on' : 'card'} onClick={() => onFocus(s.index)}>
            <div className="card-head">
              <span className="dot" style={{ background: SIDE_COLOR[s.side] }} />
              <div className="grow">
                <div className="title">Section {s.index + 1}</div>
                <div className="sub">
                  {formatDistance(s.startM)} to {formatDistance(s.endM)}
                  {note && ` · ${note}`}
                </div>
              </div>
              <button
                className="btn plain small"
                aria-label={`Repeat section ${s.index + 1}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onRepeat(s.index)
                }}
              >
                Repeat
              </button>
              {s.index > 0 && (
                <button
                  className="btn plain small"
                  aria-label={`Merge section ${s.index + 1} into section ${s.index}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onMerge(s.index)
                  }}
                >
                  Merge
                </button>
              )}
            </div>
            <Segmented label={`Throw side for section ${s.index + 1}`} value={s.side} options={SIDE_OPTIONS} onChange={(side) => onSide(s.index, side)} />
            {/* Only on the section that is picked, so the list isn't a row of delete buttons. */}
            {focus === s.index && secs.length > 1 && !painting && (
              <button
                className="btn plain danger small card-delete"
                aria-label={`Delete section ${s.index + 1}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(s.index)
                }}
              >
                <Icon name="trash" size={16} />
                Delete Section
              </button>
            )}
          </div>
        )
      })}

      {!painting && (
        <p className="footnote">
          To change just part of a road, use Paint a Stretch. A section that is picked can be deleted. Transit, shown dotted, is for a stretch
          where you only drive, between places you deliver: nothing is thrown there, and no-throw houses on it stay quiet.
        </p>
      )}
      {repeated && <p className="footnote">Passes over the same road are drawn side by side on the map, so you can tell them apart.</p>}

      <button className="btn primary block" onClick={onNext}>
        Next: Add Stops
      </button>
    </>
  )
}
