import { useEffect, useMemo, useRef, useState } from 'react'
import { onlyInTransit, stopRoadSides, type RoadSide } from './alerts'
import { STOP_COLOR } from './colors'
import { occurrences } from './geo'
import { lookupAddress, shortPlaceName, type Match } from './geocode'
import { Icon } from './Icon'
import {
  cleanAddress,
  cleanLabel,
  formatDistance,
  MAX_ADDRESS,
  MAX_LABEL,
  parseQty,
  qtyProblem,
  stopAt,
  stopDetail,
  stopName,
  stopWhere,
} from './routeEdit'
import { StopDialog } from './StopDialog'
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
  /** What it is called and, for a bundle drop, how many papers it gets, as typed. The address is the line that was looked up. */
  name: string
  qty: string
}

interface Props {
  route: Route
  type: StopType
  onType: (t: StopType) => void
  qty: string
  onQty: (q: string) => void
  label: string
  onLabel: (l: string) => void
  address: string
  onAddress: (a: string) => void
  placing: boolean
  onPlacing: (on: boolean) => void
  canMark: boolean
  onMarkHere: () => void
  /** Adds the stops, and says what to tell the driver about any whose side of the road couldn't be told. */
  onAdd: (stops: Stop[]) => string
  onPickSide: (id: string) => void
  /** A stop's name, address and papers changed. Anything left out is taken off the stop. */
  onEdit: (id: string, change: { label?: string; address?: string; qty?: number }) => void
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
      return `${shortPlaceName(m.place.name)}. ${notes.join('; ')}.`
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
  /** The stop whose name, address and papers are being changed. */
  const [editing, setEditing] = useState<string | null>(null)
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
    setRows(lines.map((line) => ({ line, status: 'waiting', selected: false, name: '', qty: '' })))
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
  // A stop is added with the name (and papers) typed beside it, and the address that was looked up.
  const badQty = isBundle && chosen.some((r) => qtyProblem(r.qty))
  const editingStop = editing ? p.route.stops.find((s) => s.id === editing) : undefined

  const addChosen = () => {
    const stops = chosen.flatMap((r) => {
      const hit = stopAt(p.route, r.match!.place, p.type, {
        label: cleanLabel(r.name),
        address: cleanAddress(r.line),
        qty: isBundle ? parseQty(r.qty) : undefined,
      })
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
      <p className="footnote">
        One address per line. Include the town or postcode for the best match.{' '}
        {isBundle
          ? 'Once one is found, give it a business name and the number of papers it gets: the alert shows both, with the address under the name.'
          : 'Once one is found you can give it a name too: the alert shows it, with the address under it.'}
      </p>

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
                  {r.status === 'found' && (
                    <div className="row-fields">
                      <input
                        className="mini-input name"
                        value={r.name}
                        maxLength={MAX_LABEL}
                        placeholder={isBundle ? 'Business name' : 'Name (optional)'}
                        aria-label={`${isBundle ? 'Business name' : 'Name'} for ${r.line}`}
                        enterKeyHint={isBundle ? 'next' : 'done'}
                        autoCapitalize="words"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(e) => patch(i, { name: e.target.value })}
                      />
                      {isBundle && (
                        <input
                          className="mini-input qty"
                          value={r.qty}
                          inputMode="numeric"
                          pattern="[0-9]*"
                          placeholder="Papers"
                          aria-label={`Papers for ${r.line}`}
                          aria-invalid={!!qtyProblem(r.qty)}
                          enterKeyHint="done"
                          onChange={(e) => patch(i, { qty: e.target.value })}
                        />
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {badQty && <p className="footnote bad">Papers must be a whole number from 1 to 9999.</p>}
          <button className="btn primary block" disabled={!chosen.length || badQty} onClick={addChosen}>
            Add {chosen.length} {noun}
            {chosen.length === 1 ? '' : 's'}
          </button>
        </>
      )}

      <div className="section-label">Or place it on the map</div>
      <div className="group">
        <label className="row field">
          <span className="title">{isBundle ? 'Business name' : 'Name'}</span>
          <input
            value={p.label}
            maxLength={MAX_LABEL}
            onChange={(e) => p.onLabel(e.target.value)}
            placeholder={isBundle ? "e.g. Joe's Cafe" : 'Optional'}
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <label className="row field">
          <span className="title">Address</span>
          <input
            value={p.address}
            maxLength={MAX_ADDRESS}
            onChange={(e) => p.onAddress(e.target.value)}
            placeholder="Optional, e.g. 12 Oak Road"
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        {isBundle && (
          <label className="row field">
            <span className="title">Papers</span>
            <input
              value={p.qty}
              inputMode="numeric"
              pattern="[0-9]*"
              onChange={(e) => p.onQty(e.target.value)}
              placeholder="How many"
              aria-invalid={!!qtyProblem(p.qty)}
            />
          </label>
        )}
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
              // Nothing is thrown where it is only transit, so a no-throw house there never alerts and needs no side.
              const quiet = s.type === 'nothrow' && onlyInTransit(p.route, occs, s.id)
              const unknown = sides.every((x) => x === null)
              return (
                <li className="row stop-row" key={s.id}>
                  <span className="dot" style={{ background: STOP_COLOR[s.type] }} />
                  <button className="grow rowbtn" onClick={() => p.onFocus(s)}>
                    <div className="title">{stopName(s)}</div>
                    {/* The address is under the name only when there is a name: with none, the address is the name. */}
                    {stopWhere(s) && <div className="sub">{stopWhere(s)}</div>}
                    <div className="sub">
                      {/* A bundle drop with no amount says so, since its alert can't say how many to leave. */}
                      <span className={s.type === 'bundle' && !s.qty ? 'warn-text' : undefined}>{stopDetail(s)}</span> ·{' '}
                      {quiet ? 'in transit, so no alert' : sidesText(sides)}
                    </div>
                  </button>
                  <button
                    className="chip-btn"
                    data-warn={(unknown && !quiet) || undefined}
                    aria-label={`Side of the road: ${sidesText(sides)}. Tap to change.`}
                    onClick={() => p.onPickSide(s.id)}
                  >
                    {unknown ? 'Set side' : SIDE_WORD[sides.find((x) => x) as RoadSide]}
                  </button>
                  <button className="icon-btn edit" aria-label={`Edit ${stopName(s)}`} onClick={() => setEditing(s.id)}>
                    <Icon name="edit" size={20} />
                  </button>
                  <button className="icon-btn" aria-label={`Delete ${stopName(s)}`} onClick={() => p.onRemove(s.id)}>
                    <Icon name="trash" size={20} />
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}

      {editingStop && (
        <StopDialog
          key={editingStop.id}
          stop={editingStop}
          onSave={(change) => {
            p.onEdit(editingStop.id, change)
            setEditing(null)
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}
