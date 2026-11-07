import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BundleOrderEditor } from './BundleOrderEditor'
import { dropAllowed, stopRow, unsetRows } from './bundleFlow'
import { bundleLeftText, bundlesLeft, rowTotals, bundleTotalsText, type BundleRow } from './bundles'
import { plural } from './format'
import './bundles.css'

interface Props {
  /** Every bundle drop on the route, one for each stop, in the driver's order (see `bundleRows`). */
  rows: readonly BundleRow[]
  /** The order as kept with the route, which the Reorder buttons change. Only needed with `onOrder`. */
  order?: readonly string[]
  /** Called with the whole new order each time a bundle is moved. Left out, the list can't be reordered. */
  onOrder?: (order: string[]) => void
  onClose: () => void
  /** "Mark dropped", for a bundle that is still to do or was missed: the key of the pass to mark (`BundleRow.markKey`). */
  onMark: (key: string) => void
  /** "Undo", for a bundle that is marked dropped: the key of the pass that was dropped (`BundleRow.undoKey`). */
  onUndo: (key: string) => void
  /** What the list is headed, when it is not the bundles of the round: the next round's list (see `nextRoundRows`) must not pass for this one's. */
  heading?: string
}

/**
 * A lock for the buttons of the rows: given what a tap does, it does it unless a tap was taken a moment before (see `dropAllowed`). Mark
 * dropped turns into Undo where it was, and back, so a second tap straight after the first (a double tap, or a bump) would take back what
 * the first did: it is ignored, as a second tap on an alert's Dropped is. It keeps its own time, so a tap in the list never holds up the
 * alert's Dropped.
 */
function tapLock(): (act: () => void) => void {
  let last = -Infinity
  return (act) => {
    const now = Date.now()
    if (!dropAllowed(last, now)) return
    last = now
    act()
  }
}

/**
 * Every bundle drop on the round, as a sheet that comes up from the bottom over a dimmed map: how many are left to do and how many are
 * dropped, how many papers are dropped and left to drop and how many bundles were missed, then one row for each bundle stop in the
 * order the driver has put them in, with what became of it (Next, To do, Dropped, Missed or Skipped), its venue and papers and how far
 * it is from the phone in a straight line. A bundle still to do, or missed, has "Mark dropped", and a dropped one has "Undo" (a second tap
 * on either straight after one is ignored, as the one becomes the other under the finger). "Reorder"
 * turns the rows into the order editor, where each bundle still to do moves up or down and the list changes as it is tapped. The list
 * opens with the next bundle in the middle of the view, since a round can have many. An alert still shows above the sheet, with its
 * Dropped button.
 */
export function BundlesSheet({ rows, order, onOrder, onClose, onMark, onUndo, heading }: Props) {
  const totals = rowTotals(rows)
  const list = rows.map((r, i) => stopRow(r, i + 1))
  const unset = unsetRows(rows)
  const [reorder, setReorder] = useState(false)
  // Moving needs two bundles still to do. If a drop (from an alert, or one driven past) leaves fewer, there is nothing to move: Reorder
  // ends for good and the list is back to the plain one, so an Undo that makes two again shows the list with its Reorder button, not the
  // editor under the driver's finger.
  const canReorder = !!onOrder && bundlesLeft(rows) >= 2
  if (reorder && !canReorder) setReorder(false)
  const editing = reorder && canReorder
  const scroller = useRef<HTMLDivElement>(null)
  const nextRow = useRef<HTMLLIElement>(null)
  // One lock for both buttons of every row, kept for as long as the list is up.
  const [tapped] = useState(tapLock)

  // Opens with the next bundle in view, in the middle of the list.
  useLayoutEffect(() => {
    const box = scroller.current
    const row = nextRow.current
    if (box && row) box.scrollTop = Math.max(0, row.offsetTop - (box.clientHeight - row.offsetHeight) / 2)
  }, [])

  // Escape closes it. The latest onClose is read when the key is pressed, so the listener isn't remade each time the list is.
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="bundles-scrim" onClick={onClose}>
      <div className="bundles-sheet" role="dialog" aria-modal="true" aria-label={heading ?? 'Bundle drops'} onClick={(e) => e.stopPropagation()}>
        <div className="bundles-head">
          <div>
            <h2>{heading ?? 'Bundles'}</h2>
            {totals.total > 0 && <div className="bundles-count">{bundleLeftText(totals)}</div>}
          </div>
          <div className="bundles-head-actions">
            {canReorder && (
              <button className="btn secondary small bundles-reorder" data-on={editing || undefined} onClick={() => setReorder(!editing)}>
                {editing ? 'Finish' : 'Reorder'}
              </button>
            )}
            <button className="btn plain" onClick={onClose}>
              Done
            </button>
          </div>
        </div>

        {totals.total > 0 && (
          <div className="bundles-summary" role="group" aria-label={bundleTotalsText(totals)}>
            <div className="bundles-stat" aria-hidden="true">
              <b>{totals.droppedPapers}</b>
              <span>Papers dropped</span>
            </div>
            <div className="bundles-stat" aria-hidden="true">
              <b>{totals.toDropPapers}</b>
              <span>Papers to drop</span>
            </div>
            <div className={totals.missed > 0 ? 'bundles-stat warn' : 'bundles-stat'} aria-hidden="true">
              <b>{totals.missed}</b>
              <span>Missed</span>
            </div>
          </div>
        )}

        <div className="bundles-scroll" ref={scroller}>
          {list.length === 0 ? (
            <p className="bundles-empty">This route has no bundle drops. Add them in Setup, under Stops.</p>
          ) : editing ? (
            <BundleOrderEditor bundles={rows.map((r) => ({ id: r.id, name: r.name, qty: r.papers, status: r.status }))} order={order} onChange={(next) => onOrder?.(next)} />
          ) : (
            <ul className="group">
              {list.map((r) => {
                const { action } = r
                return (
                  <li key={r.id} className={`bundle-row ${r.status}`} ref={r.status === 'next' ? nextRow : undefined}>
                    <div className="bundle-main" role="group" aria-label={r.label}>
                      <div className="bundle-top">
                        <span className="bundle-place" aria-hidden="true">
                          {r.place}
                        </span>
                        <span className="bundle-status">{r.statusLabel}</span>
                        {r.where && <span className="bundle-where">{r.where}</span>}
                      </div>
                      <div className="bundle-name">{r.name}</div>
                      {r.address && <div className="bundle-address">{r.address}</div>}
                      {(r.papers || r.passes) && (
                        <div className="bundle-meta">
                          {r.papers && <b>{r.papers}</b>}
                          {r.papers && r.passes && ' · '}
                          {r.passes}
                        </div>
                      )}
                    </div>
                    {action?.kind === 'mark' && (
                      <button className="bundle-action" aria-label={`Mark ${r.name} as dropped`} onClick={() => tapped(() => onMark(action.key))}>
                        Mark dropped
                      </button>
                    )}
                    {action?.kind === 'undo' && (
                      <button className="bundle-action undo" aria-label={`Undo dropped for ${r.name}`} onClick={() => tapped(() => onUndo(action.key))}>
                        Undo
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {unset > 0 && (
            <p className="footnote">
              {plural(unset, 'bundle has', 'bundles have')} no amount set, so {unset === 1 ? 'it adds' : 'they add'} no papers to these figures. Set it in Setup, under Stops.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
