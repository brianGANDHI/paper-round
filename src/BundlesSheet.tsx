import { useEffect, useLayoutEffect, useRef } from 'react'
import { sheetRow, unsetAmounts } from './bundleFlow'
import { bundleTotals, bundleTotalsText, type BundleItem } from './bundles'
import { plural } from './format'
import './bundles.css'

interface Props {
  /** Every bundle drop on the route in the order the route reaches them (see `bundleList`). */
  items: readonly BundleItem[]
  onClose: () => void
  /** "Mark dropped", for a bundle that was missed or is still to come. */
  onMark: (key: string) => void
  /** "Undo", for a bundle that is marked dropped. */
  onUndo: (key: string) => void
}

/**
 * Every bundle drop on the round, as a sheet that comes up from the bottom over a dimmed map: how many papers are dropped, how many are
 * left to drop and how many bundles were missed, then each drop in route order with what became of it (Dropped, Missed, Next, Later or
 * Skipped), its venue and papers and how far ahead of you it is (or behind you). A missed or later one has "Mark dropped", a dropped one
 * has "Undo". The list opens with the next bundle in the middle of the view, since a round can have many. An alert still shows above
 * the sheet, with its Dropped button.
 */
export function BundlesSheet({ items, onClose, onMark, onUndo }: Props) {
  const totals = bundleTotals(items)
  const rows = items.map(sheetRow)
  const unset = unsetAmounts(items)
  const scroller = useRef<HTMLDivElement>(null)
  const nextRow = useRef<HTMLLIElement>(null)

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
      <div className="bundles-sheet" role="dialog" aria-modal="true" aria-label="Bundle drops" onClick={(e) => e.stopPropagation()}>
        <div className="bundles-head">
          <div>
            <h2>Bundles</h2>
            {totals.total > 0 && (
              <div className="bundles-count">
                {totals.dropped} of {plural(totals.total, 'bundle', 'bundles')} dropped
              </div>
            )}
          </div>
          <button className="btn plain" onClick={onClose}>
            Done
          </button>
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
          {rows.length === 0 ? (
            <p className="bundles-empty">This route has no bundle drops. Add them in Setup, under Stops.</p>
          ) : (
            <ul className="group">
              {rows.map((r) => (
                <li key={r.key} className={`bundle-row ${r.status}`} ref={r.status === 'next' ? nextRow : undefined}>
                  <div className="bundle-main" role="group" aria-label={r.label}>
                    <div className="bundle-top">
                      <span className="bundle-status">{r.statusLabel}</span>
                      <span className="bundle-where">{r.where}</span>
                    </div>
                    <div className="bundle-name">{r.name}</div>
                    {r.address && <div className="bundle-address">{r.address}</div>}
                    {(r.papers || r.pass) && (
                      <div className="bundle-meta">
                        {r.papers && <b>{r.papers}</b>}
                        {r.papers && r.pass && ' · '}
                        {r.pass}
                      </div>
                    )}
                  </div>
                  {r.action === 'mark' && (
                    <button className="bundle-action" aria-label={`Mark ${r.name} as dropped`} onClick={() => onMark(r.key)}>
                      Mark dropped
                    </button>
                  )}
                  {r.action === 'undo' && (
                    <button className="bundle-action undo" aria-label={`Undo dropped for ${r.name}`} onClick={() => onUndo(r.key)}>
                      Undo
                    </button>
                  )}
                </li>
              ))}
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
