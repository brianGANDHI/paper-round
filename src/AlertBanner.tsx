import { aheadText, alertText } from './alerts'
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
 * red and flashes; a bundle drop is blue. Either has the stop's name, with its address under it when it has
 * both, and a bundle drop has how many papers beside them, in a badge that a long name can't push off. The
 * house number to look for is on a plate at the front of that line, big enough to read at a glance. The side
 * of the road the stop is on sits at that edge of the banner, with an arrow.
 */
export function AlertBanner({ stop, pass = 1, ahead, side, waiting }: Props) {
  const noThrow = stop.type === 'nothrow'
  const { title, name, address, papers, number } = alertText(stop)
  const where = `${name}${pass > 1 ? ` · pass ${pass}` : ''}`
  const marker = side ? (
    <div className="stop-alert-side">
      <Icon name={side === 'left' ? 'arrow-left' : 'arrow-right'} size={26} strokeWidth={2.8} />
      {side === 'left' ? 'Left' : 'Right'}
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
          <span className="stop-alert-title">{title}</span>
          <span className="stop-alert-dist">{aheadText(ahead)}</span>
        </div>
        <div className="stop-alert-sub">
          {number && (
            <span className={number.length > 4 ? 'stop-alert-num long' : 'stop-alert-num'} aria-label={`House number ${number}`}>
              {number}
            </span>
          )}
          <div className="stop-alert-lines">
            <span className={address ? 'stop-alert-name one' : 'stop-alert-name'}>{where}</span>
            {address && <span className="stop-alert-address">{address}</span>}
          </div>
          {papers && <span className="stop-alert-qty">{papers}</span>}
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
