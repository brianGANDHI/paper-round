import { SIDE_COLOR } from './colors'
import { Icon } from './Icon'
import type { PassView } from './passes'
import { formatDistance, sections } from './routeEdit'
import { Banner, Empty, Segmented } from './ui'
import type { Route, Side } from './types'

const SIDE_OPTIONS: { value: Side; label: string; ariaLabel: string }[] = [
  { value: 'both', label: 'Both', ariaLabel: 'Both sides' },
  { value: 'left', label: 'Left', ariaLabel: 'Left side' },
  { value: 'right', label: 'Right', ariaLabel: 'Right side' },
]

interface Props {
  route: Route
  /** How each section is drawn, which says which ones repeat an earlier one. */
  views: PassView[]
  focus: number | null
  splitting: boolean
  onSplitting: (on: boolean) => void
  onFocus: (index: number) => void
  onSide: (index: number, side: Side) => void
  onMerge: (index: number) => void
  onRepeat: (index: number) => void
  onBack: () => void
  onNext: () => void
}

export function SidesTab({ route, views, focus, splitting, onSplitting, onFocus, onSide, onMerge, onRepeat, onBack, onNext }: Props) {
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
      <p className="footnote">
        Choose the side you throw on for each section. Left and right are as you face the way you drive, and the arrows on the map show that direction.
        Driving a street twice, say down it and back? Tap Repeat on its section to add the second pass, then choose the side for that pass.
      </p>

      {secs.map((s) => {
        const view = views[s.index]
        const note = view?.repeatOf != null ? `${view.reversed ? 'back along' : 'again along'} section ${view.repeatOf + 1}` : ''
        return (
          <div key={s.idx} className={focus === s.index ? 'card on' : 'card'} onClick={() => onFocus(s.index)}>
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
          </div>
        )
      })}

      {repeated && <p className="footnote">Passes over the same road are drawn side by side on the map, so you can tell them apart.</p>}

      <button className="btn secondary block" data-on={splitting || undefined} onClick={() => onSplitting(!splitting)}>
        <Icon name={splitting ? 'check' : 'plus'} size={20} strokeWidth={2.4} />
        {splitting ? 'Done Adding Changes' : 'Add a Side Change'}
      </button>
      {splitting && (
        <Banner>
          Tap the route on the map where the side changes. The new section starts there. If a road is driven twice, select the section you mean first.
        </Banner>
      )}

      <button className="btn primary block" onClick={onNext}>
        Next: Add Stops
      </button>
    </>
  )
}
