import { useLayoutEffect, useRef, useState, type Ref } from 'react'
import { editorMove, editorRows, type EditorBundle, type EditorRow } from './bundles'
import './bundles.css'

export type { EditorBundle } from './bundles'

interface ListProps {
  rows: readonly EditorRow[]
  /** Called with the row and which way it is to go when one of its buttons is tapped. */
  onMove: (row: EditorRow, delta: -1 | 1) => void
  /** What a screen reader is told after a move: where the bundle is now. */
  said: string
  /** The list's own box, for finding the button that was tapped again after the rows have moved. */
  ref?: Ref<HTMLOListElement>
}

/** A chevron pointing up or down, for the move buttons. */
function Chevron({ up }: { up: boolean }) {
  return (
    <svg className="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <polyline points={up ? '6 15 12 9 18 15' : '6 9 12 15 18 9'} />
    </svg>
  )
}

/**
 * The rows of the editor, with no state of its own: each bundle with its place, its papers and where it stands, and, unless it is
 * already done, Move up and Move down (48 px buttons that name the bundle). A button that has nowhere to go is dimmed and disabled.
 */
export function BundleOrderList({ rows, onMove, said, ref }: ListProps) {
  if (!rows.length) return <p className="bundle-order-empty">There are no bundle drops yet. Add them under Stops.</p>
  return (
    <div className="bundle-order">
      <p className="bundle-order-hint">The order you deliver them in. It never changes unless you move one.</p>
      <ol className="bundle-order-list" ref={ref} aria-label="Bundle drops, in the order you deliver them">
        {rows.map((row) => (
          <li key={row.id} className={`bundle-order-row ${row.status ?? ''}`} data-id={row.id}>
            <span className="bundle-order-num" aria-hidden="true">
              {row.place}
            </span>
            <div className="bundle-order-main">
              <div className="bundle-order-name">{row.name}</div>
              {(row.statusLabel || row.papers) && (
                <div className="bundle-order-meta">
                  {row.statusLabel && <span className="bundle-order-status">{row.statusLabel}</span>}
                  {row.statusLabel && row.papers && ' · '}
                  {row.papers}
                </div>
              )}
            </div>
            {!row.finished && (
              <div className="bundle-order-moves">
                <button type="button" className="bundle-move" data-dir="up" aria-label={`Move ${row.name} up`} disabled={!row.canUp} onClick={() => onMove(row, -1)}>
                  <Chevron up />
                </button>
                <button type="button" className="bundle-move" data-dir="down" aria-label={`Move ${row.name} down`} disabled={!row.canDown} onClick={() => onMove(row, 1)}>
                  <Chevron up={false} />
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="bundle-order-said" role="status">
        {said}
      </div>
    </div>
  )
}

interface Props {
  /** Every bundle drop on the route, new ones last in route order (see `orderedStops`); the list is shown in the driver's order. */
  bundles: readonly EditorBundle[]
  /** The order as kept (`SavedRoute.bundleOrder`), which may be missing, stale or short: it is put right here for showing. */
  order: readonly string[] | undefined
  /** Called with the whole new order each time a bundle is moved: keep it as it is. */
  onChange: (order: string[]) => void
}

/**
 * The bundle drops in the order the driver delivers them, each with Move up and Move down that change the order as they are tapped.
 * The order is the driver's: it never changes by itself, and the next bundle on the round is the first in it still to do. It is used in
 * Setup, and in the round's Bundles list when that is set to reorder. It holds nothing of its own but a note for a screen reader:
 * `order` goes in and each move comes out through `onChange` as the whole new order. A bundle dropped, missed or skipped over (its
 * `status`) is shown but has no buttons, and one moved past it hops over it.
 */
export function BundleOrderEditor({ bundles, order, onChange }: Props) {
  const rows = editorRows(bundles, order)
  const root = useRef<HTMLOListElement>(null)
  const refocus = useRef<{ id: string; dir: 'up' | 'down' } | null>(null)
  const [said, setSaid] = useState('')

  // The row moves from under the finger, so the button that was tapped is found again and kept focused, ready for the next tap.
  useLayoutEffect(() => {
    const want = refocus.current
    const list = root.current?.children
    if (!want || !list) return
    refocus.current = null
    for (const row of Array.from(list)) {
      if ((row as HTMLElement).dataset.id !== want.id) continue
      const same = row.querySelector<HTMLButtonElement>(`button[data-dir="${want.dir}"]`)
      ;(same && !same.disabled ? same : row.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus()
    }
  })

  const move = (row: EditorRow, delta: -1 | 1) => {
    const next = editorMove(bundles, order, row.id, delta)
    refocus.current = { id: row.id, dir: delta < 0 ? 'up' : 'down' }
    setSaid(`${row.name} is now number ${next.indexOf(row.id) + 1} of ${next.length}.`)
    onChange(next)
  }

  return <BundleOrderList rows={rows} onMove={move} said={said} ref={root} />
}
