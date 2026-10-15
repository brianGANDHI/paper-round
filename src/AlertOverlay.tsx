import { Icon } from './Icon'
import type { Stop } from './types'

interface Props {
  stop: Stop
  /** Which time the route has gone past this stop: 1 for the first. */
  pass?: number
  /** How many more alerts are waiting behind this one. */
  waiting: number
  onHandled: () => void
  onDismiss: () => void
}

/** Full-screen prompt for a stop you are approaching. No-throw is red and flashes. */
export function AlertOverlay({ stop, pass = 1, waiting, onHandled, onDismiss }: Props) {
  const noThrow = stop.type === 'nothrow'
  return (
    <div className={noThrow ? 'overlay red' : 'overlay blue'} role="alertdialog" aria-modal="true" aria-labelledby="alert-heading">
      <div className="glyph">
        <Icon name={noThrow ? 'slash' : 'package'} size={52} strokeWidth={1.8} />
      </div>
      <h1 id="alert-heading">{noThrow ? 'No Throw' : 'Bundle Drop'}</h1>
      {!noThrow && stop.qty && (
        <>
          <p className="qty">{stop.qty}</p>
          <p className="qty-label">{stop.qty === 1 ? 'paper' : 'papers'}</p>
        </>
      )}
      <p className="detail">{stop.label ?? (noThrow ? 'This house does not want a paper.' : 'Bundle stop ahead.')}</p>
      {pass > 1 && <p className="more">Time {pass} past this stop on your route</p>}
      <button className="btn primary" onClick={onHandled} autoFocus>
        Handled
      </button>
      <button className="btn plain" onClick={onDismiss}>
        Dismiss
      </button>
      {waiting > 0 && <p className="more">{waiting} more waiting</p>}
    </div>
  )
}
