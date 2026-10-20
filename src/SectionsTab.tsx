import { useEffect } from 'react'
import { Icon } from './Icon'
import type { DetachedSection, ResolvedSection } from './namedSections'
import { formatDistance } from './routeEdit'
import { Banner, Empty } from './ui'
import type { Route } from './types'

interface Props {
  route: Route
  /** The named sections as they lie along the route now, and any that no longer fit it. */
  resolved: { list: ResolvedSection[]; detached: DetachedSection[] }
  /** How many stops lie along each section, by its id. */
  stopCounts: ReadonlyMap<string, number>
  /** The section picked in the list. */
  focus: string | null
  /** Whether a tap on the route starts a new section. */
  adding: boolean
  onAdding: (on: boolean) => void
  onFocus: (id: string) => void
  /** Give the first stretch of the route, before the first named section, a name of its own. */
  onNameStart: () => void
  onRename: (id: string) => void
  onDelete: (id: string) => void
  onBack: () => void
}

const stops = (n: number) => `${n} ${n === 1 ? 'stop' : 'stops'}`

/**
 * Names for parts of the route, such as a street or an estate, so that a round can be started from any of them. They are
 * separate from the throw-side sections: they can start and end anywhere, and say nothing about which side is thrown.
 */
export function SectionsTab({ route, resolved, stopCounts, focus, adding, onAdding, onFocus, onNameStart, onRename, onDelete, onBack }: Props) {
  // A section picked on the map comes into view in the list.
  useEffect(() => {
    if (focus) document.getElementById(`named-${focus}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focus])

  if (route.points.length < 2) {
    return (
      <Empty
        icon={<Icon name="flag" size={26} />}
        title="Draw Your Route First"
        action={
          <button className="btn primary" onClick={onBack}>
            Go to Route
          </button>
        }
      >
        Once your route is on the map, you can name parts of it, such as a street or an estate.
      </Empty>
    )
  }

  const { list, detached } = resolved
  const named = list.filter((s) => !s.lead)
  const lead = list.find((s) => s.lead)
  return (
    <>
      {!adding && (
        <p className="footnote">
          Name parts of your route, such as a street or an estate. Then when you start a round you can pick one of them and begin there instead
          of at the start. These are separate from the throw-side sections: they only give a place a name.
        </p>
      )}

      <button className="btn secondary block" data-on={adding || undefined} onClick={() => onAdding(!adding)}>
        <Icon name={adding ? 'check' : 'flag'} size={20} strokeWidth={2.2} />
        {adding ? 'Done Adding' : 'Add a Section'}
      </button>
      {adding && <Banner>Tap the route where the section starts. It runs from there to the start of the next one, or to the end of the route.</Banner>}

      {named.length === 0 && !adding && (
        <div className="group">
          <div className="row">
            <div className="grow">
              <div className="title">No sections yet</div>
              <div className="sub">Add one where a street or an estate starts, and give it a name.</div>
            </div>
          </div>
        </div>
      )}

      {lead && (
        <div className="card">
          <div className="card-head">
            <span className="dot" style={{ background: 'var(--tint)' }} />
            <div className="grow">
              <div className="title">{lead.name}</div>
              <div className="sub">
                {formatDistance(lead.startM)} to {formatDistance(lead.endM)} · {stops(stopCounts.get(lead.id) ?? 0)}
              </div>
            </div>
            <button className="btn plain small" aria-label="Name the start of the route" onClick={onNameStart}>
              Name It
            </button>
          </div>
        </div>
      )}

      {named.map((s) => (
        <div key={s.id} id={`named-${s.id}`} className={focus === s.id ? 'card on' : 'card'} onClick={() => onFocus(s.id)}>
          <div className="card-head">
            <span className="dot" style={{ background: 'var(--tint)' }} />
            <div className="grow">
              <div className="title">{s.name}</div>
              <div className="sub">
                {formatDistance(s.startM)} to {formatDistance(s.endM)} · {stops(stopCounts.get(s.id) ?? 0)}
              </div>
            </div>
            <button
              className="btn plain small"
              aria-label={`Rename ${s.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onRename(s.id)
              }}
            >
              Rename
            </button>
            <button
              className="btn plain danger small"
              aria-label={`Delete ${s.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onDelete(s.id)
              }}
            >
              <Icon name="trash" size={16} />
            </button>
          </div>
        </div>
      ))}

      {detached.map(({ section, reason }) => (
        <div key={section.id} className="card">
          <div className="card-head">
            <span className="dot" style={{ background: 'var(--orange)' }} />
            <div className="grow">
              <div className="title">{section.name}</div>
              <div className="sub warn">{reason === 'off' ? "Isn't on the route any more, so it is ignored." : 'Starts in the same place as another section, so it is ignored.'}</div>
            </div>
            <button
              className="btn plain danger small"
              aria-label={`Delete ${section.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onDelete(section.id)
              }}
            >
              <Icon name="trash" size={16} />
            </button>
          </div>
        </div>
      ))}

      <p className="footnote">
        Tap a section to see where it starts. If you change the route, a section stays where it is on the map, and is set aside if the route no
        longer goes by it.
      </p>
    </>
  )
}
