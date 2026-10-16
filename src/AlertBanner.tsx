import { aheadText } from './alerts'
import { Icon } from './Icon'
import type { Stop } from './types'

interface Props {
  stop: Stop
  /** Which time the route has gone past this stop: 1 for the first. */
  pass?: number
  /** How far ahead the stop is along the route, in metres. Negative once it has been passed. */
  ahead: number
  /** Which side of the road the stop is on as you drive past, or null when that can't be told. */
  side: 'left' | 'right' | null
  /** How many more alerts are waiting behind this one. */
  waiting: number
}

/**
 * The warning for a stop you are close to: a banner across the top of the map, which stays usable
 * underneath. It has nothing to tap and goes by itself once you are away from the stop. No-throw is
 * red and flashes; a bundle drop is blue and says how many papers. The side of the road the stop is
 * on sits at that edge of the banner, with an arrow.
 */
export function AlertBanner({ stop, pass = 1, ahead, side, waiting }: Props) {
  const noThrow = stop.type === 'nothrow'
  const label = stop.label ?? (noThrow ? 'This house does not want a paper.' : 'Bundle stop ahead.')
  const qty = !noThrow && stop.qty ? stop.qty : null
  const marker = side ? (
    <div className="stop-alert-side">
      {side === 'left' && <Icon name="arrow-left" size={26} strokeWidth={2.8} />}
      {side === 'left' ? 'Left' : 'Right'}
      {side === 'right' && <Icon name="arrow-right" size={26} strokeWidth={2.8} />}
    </div>
  ) : (
    <div className="stop-alert-glyph">
      <Icon name={noThrow ? 'slash' : 'package'} size={26} strokeWidth={2} />
    </div>
  )
  return (
    <div className={`stop-alert ${noThrow ? 'red' : 'blue'}${side === 'right' ? ' right' : ''}`} role="alert">
      {side !== 'right' && marker}
      <div className="stop-alert-text">
        <div className="stop-alert-head">
          <span className="stop-alert-title">{noThrow ? 'No Throw' : 'Bundle Drop'}</span>
          <span className="stop-alert-dist">{aheadText(ahead)}</span>
        </div>
        <div className="stop-alert-sub">
          {qty && (
            <b>
              {qty} {qty === 1 ? 'paper' : 'papers'}
              {' · '}
            </b>
          )}
          {label}
          {pass > 1 && ` · pass ${pass}`}
        </div>
      </div>
      {side === 'right' && marker}
      {waiting > 0 && (
        <span className="stop-alert-more" aria-label={`${waiting} more waiting`}>
          +{waiting}
        </span>
      )}
    </div>
  )
}
