import { useEffect, useMemo, useRef, useState } from 'react'
import { stopRoadSides, type RoadSide } from './alerts'
import { STOP_COLOR } from './colors'
import { occurrences } from './geo'
import { lookupAddress, type Match } from './geocode'
import { Icon } from './Icon'
import { formatDistance, stopAt } from './routeEdit'
import { Empty, Segmented } from './ui'
import type { Pt, Route, Stop, StopType } from './types'

/** Matches closer than this to the route are ticked automatically. */
const AUTO_SELECT_M = 120

const TYPE_OPTIONS: { value: StopType; label: string }[] = [
  { value: 'nothrow', label: 'No-Throw' },
  { value: 'bundle', label: 'Bundle Drop' },
]

interface Row {
  line: string
  status: 'waiting' | 'looking' | 'found' | 'none' | 'error'
  match?: Match
  selected: boolean
}

interface Props {
  route: Route
  type: StopType
  onType: (t: StopType) => void
  qty: string
  onQty: (q: string) => void
  label: string
  onLabel: (l: string) => void
  placing: boolean
  onPlacing: (on: boolean) => void
  canMark: boolean
  onMarkHere: () => void
  /** Adds the stops, and says what to tell the driver about any whose side of the road couldn't be told. */
  onAdd: (stops: Stop[]) => string
  onPickSide: (id: string) => void
  onRemove: (id: string) => void
  onFocus: (p: Pt) => void
  onNotice: (message: string | null) => void
  onBack: () => void
}

const SIDE_WORD: Record<RoadSide, string> = { left: 'Left', right: 'Right' }

/** The side of the road a stop is on for each pass: "Left", "Left, then Right" on a street driven both ways. */
function sidesText(sides: (RoadSide | null)[]): string {
  if (sides.every((x) => x === null)) return 'side not known'
  return sides.map((x) => (x ? SIDE_WORD[x] : '?')).join(', then ')
}

/** "12, Oak Road, Town, County, England, AB1 2CD, UK" is more than needed to recognise a place. */
const shortName = (name: string) => name.split(', ').slice(0, 3).join(', ')

function describe(r: Row): string {
  switch (r.status) {
    case 'waiting':
      return 'Waiting...'
    case 'looking':
      return 'Looking up...'
    case 'none':
      return 'Not found. Check the spelling, add the town or postcode, or place it by tapping the map.'
    case 'error':
      return 'Could not reach the address service. Lookups need an internet connection.'
    case 'found': {
      const m = r.match!
      const notes = [`${formatDistance(m.offM)} from your route`]
      if (!m.exact) notes.push('only the street or area was found, so the position is approximate')
      else if (m.offM > AUTO_SELECT_M) notes.push('far from your route, check it is the right place')
      return `${shortName(m.place.name)}. ${notes.join('; ')}.`
    }
  }
}

function tone(r: Row): string {
  if (r.status === 'none' || r.status === 'error') return 'bad'
  if (r.status === 'found' && (!r.match!.exact || r.match!.offM > AUTO_SELECT_M)) return 'warn'
  return ''
}

export function StopsTab(p: Props) {
  const [text, setText] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const isBundle = p.type === 'bundle'
  // A stop on a road driven twice is passed on more than one side, so the list shows each.
  const occs = useMemo(() => occurrences(p.route), [p.route])
  const noun = isBundle ? 'Bundle Drop' : 'No-Throw House'

  // Leaving the tab mid-lookup must not keep calling the address service.
  useEffect(() => () => abort.current?.abort(), [])

  if (p.route.points.length < 2) {
    return (
      <Empty
        icon={<Icon name="pin" size={26} />}
        title="Draw Your Route First"
        action={
          <button className="btn primary" onClick={p.onBack}>
            Go to Route
          </button>
        }
      >
        Stops are matched to your route, so it needs to be on the map before you add them.
      </Empty>
    )
  }

  const patch = (i: number, change: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...change } : r)))

  const lookup = async () => {
    const lines = [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))]
    if (!lines.length) return
    p.onNotice(null)
    const ctl = new AbortController()
    abort.current = ctl
    setBusy(true)
    setRows(lines.map((line) => ({ line, status: 'waiting', selected: false })))
    for (let i = 0; i < lines.length; i++) {
      if (ctl.signal.aborted) break
      patch(i, { status: 'looking' })
      try {
        const match = await lookupAddress(lines[i], p.route, ctl.signal)
        patch(i, match ? { status: 'found', match, selected: match.exact && match.offM <= AUTO_SELECT_M } : { status: 'none' })
      } catch {
        if (ctl.signal.aborted) break
        patch(i, { status: 'error' })
      }
    }
    setBusy(false)
  }

  const cancel = () => {
    abort.current?.abort()
    setBusy(false)
    setRows((rs) => rs.filter((r) => r.status !== 'waiting' && r.status !== 'looking'))
  }

  const chosen = rows.filter((r) => r.selected && r.match)
  const finished = rows.filter((r) => r.status !== 'waiting' && r.status !== 'looking').length

  const addChosen = () => {
    const qty = isBundle ? Number.parseInt(p.qty, 10) || undefined : undefined
    const stops = chosen.flatMap((r) => {
      const hit = stopAt(p.route, r.match!.place, p.type, { label: r.line, qty })
      return hit ? [hit.stop] : []
    })
    const note = p.onAdd(stops)
    const added = new Set(chosen.map((r) => r.line))
    setRows((rs) => rs.filter((r) => !added.has(r.line)))
    setText((t) => t.split('\n').filter((l) => !added.has(l.trim())).join('\n'))
    p.onNotice(`Added ${stops.length} ${noun.toLowerCase()}${stops.length === 1 ? '' : 's'}.${note ? ` ${note}` : ''}`)
  }

  return (
    <>
      <Segmented label="Type of stop" value={p.type} options={TYPE_OPTIONS} onChange={p.onType} />

      {isBundle && (
        <div className="group">
          <label className="row field">
            <span className="title">Bundle size</span>
            <input type="number" inputMode="numeric" min="1" value={p.qty} onChange={(e) => p.onQty(e.target.value)} placeholder="Optional" />
          </label>
        </div>
      )}

      <div className="section-label">Add by address</div>
      <div className="group">
        <textarea
          className="textarea"
          aria-label="Addresses, one per line"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'12 Oak Road, Lewes\n14 Oak Road, Lewes'}
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <p className="footnote">One address per line. Include the town or postcode for the best match.</p>

      {busy ? (
        <div className="group">
          <div className="row">
            <span className="spinner" />
            <div className="grow">
              <div className="title">
                Looking up {Math.min(finished + 1, rows.length)} of {rows.length}
              </div>
            </div>
            <button className="btn plain small" onClick={cancel}>
              Stop
            </button>
          </div>
        </div>
      ) : (
        <button className="btn primary block" disabled={!text.trim()} onClick={lookup}>
          Look Up Addresses
        </button>
      )}

      {rows.length > 0 && (
        <>
          <ul className="group">
            {rows.map((r, i) => (
              <li className="row" key={r.line}>
                <input
                  type="checkbox"
                  className="check"
                  checked={r.selected}
                  disabled={r.status !== 'found'}
                  onChange={() => patch(i, { selected: !r.selected })}
                  aria-label={`Add ${r.line}`}
                />
                <div className="grow">
                  <div className="title">{r.line}</div>
                  <div className={`sub ${tone(r)}`}>{describe(r)}</div>
                </div>
              </li>
            ))}
          </ul>
          <button className="btn primary block" disabled={!chosen.length} onClick={addChosen}>
            Add {chosen.length} {noun}
            {chosen.length === 1 ? '' : 's'}
          </button>
        </>
      )}

      <div className="section-label">Or place it without an address</div>
      <div className="group">
        <label className="row field">
          <span className="title">Name</span>
          <input value={p.label} onChange={(e) => p.onLabel(e.target.value)} placeholder="Optional, e.g. No. 14" />
        </label>
        <button className="row" onClick={() => p.onPlacing(!p.placing)} aria-pressed={p.placing}>
          <span className="icon-tint">
            <Icon name="pin" size={22} />
          </span>
          <span className="grow title">{p.placing ? 'Tap the map to place it' : 'Tap on the Map'}</span>
          {p.placing && (
            <span className="icon-tint">
              <Icon name="check" size={20} strokeWidth={2.6} />
            </span>
          )}
        </button>
        <button className="row" disabled={!p.canMark} onClick={p.onMarkHere}>
          <span className="icon-tint">
            <Icon name="navigation" size={22} />
          </span>
          <span className="grow title">Use My Current Location</span>
        </button>
      </div>

      {p.route.stops.length > 0 && (
        <>
          <div className="section-label">On your route</div>
          <ul className="group">
            {p.route.stops.map((s) => {
              const sides = stopRoadSides(p.route, occs, s.id)
              return (
                <li className="row" key={s.id}>
                  <span className="dot" style={{ background: STOP_COLOR[s.type] }} />
                  <button className="grow rowbtn" onClick={() => p.onFocus(s)}>
                    <div className="title">{s.label ?? (s.type === 'bundle' ? 'Bundle drop' : 'No-throw house')}</div>
                    <div className="sub">
                      {s.type === 'bundle' ? `Bundle${s.qty ? ` of ${s.qty}` : ''}` : 'No-throw'} · {sidesText(sides)}
                    </div>
                  </button>
                  <button
                    className="chip-btn"
                    data-warn={sides.every((x) => x === null) || undefined}
                    aria-label={`Side of the road: ${sidesText(sides)}. Tap to change.`}
                    onClick={() => p.onPickSide(s.id)}
                  >
                    {sides.every((x) => x === null) ? 'Set side' : SIDE_WORD[sides.find((x) => x) as RoadSide]}
                  </button>
                  <button className="icon-btn" aria-label={`Delete ${s.label ?? 'stop'}`} onClick={() => p.onRemove(s.id)}>
                    <Icon name="trash" size={20} />
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </>
  )
}
