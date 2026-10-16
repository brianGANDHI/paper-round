import { aheadText } from './alerts'
import { Icon } from './Icon'
import type { Stop } from './types'

interface Props {
  stop: Stop
  /** Which time the route has gone past this stop: 1 for the first. */
  pass?: number
  /** How far ahead the stop is along the route, in metres. Negative once it has been passed. */
  ahead: number
  /** How many more alerts are waiting behind this one. */
  waiting: number
  onHandled: () => void
  onDismiss: () => void
}

/**
 * The warning for a stop you are approaching: a banner across the top of the map, which stays usable
 * underneath. No-throw is red and flashes; a bundle drop is blue and shows how many papers.
 */
export function AlertBanner({ stop, pass = 1, ahead, waiting, onHandled, onDismiss }: Props) {
  const noThrow = stop.type === 'nothrow'
  const label = stop.label ?? (noThrow ? 'This house does not want a paper.' : 'Bundle stop ahead.')
  const qty = !noThrow && stop.qty ? stop.qty : null
  const glyphLabel = qty ? `${qty} ${qty === 1 ? 'paper' : 'papers'}` : noThrow ? 'No throw' : 'Bundle'
  return (
    <div className={noThrow ? 'stop-alert red' : 'stop-alert blue'} role="alert">
      <div className="stop-alert-glyph" role="img" aria-label={glyphLabel}>
        {qty ?? <Icon name={noThrow ? 'slash' : 'package'} size={26} strokeWidth={2} />}
      </div>
      <div className="stop-alert-text">
        <div className="stop-alert-title">{noThrow ? 'No Throw' : 'Bundle Drop'}</div>
        <div className="stop-alert-sub">
          <b>{aheadText(ahead)}</b>
          {` · ${label}`}
          {pass > 1 && ` · pass ${pass}`}
        </div>
      </div>
      <button className="stop-alert-done" onClick={onHandled}>
        Handled
      </button>
      <button className="stop-alert-close" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="x" size={20} strokeWidth={2.6} />
      </button>
      {waiting > 0 && (
        <span className="stop-alert-more" aria-label={`${waiting} more waiting`}>
          +{waiting}
        </span>
      )}
    </div>
  )
}
