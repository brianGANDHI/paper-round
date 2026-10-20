import { aheadText, alertSpeech, alertText, platesLayout, plateText } from './alerts'
import { Icon } from './Icon'
import type { Stop } from './types'

/** How many plates of a row of houses fit on a line of the banner. A longer row takes a second line, and then ends with how many more there are. */
export const PLATES_PER_LINE = 5

interface Props {
  /** The stop this is for, or a row of no-throw houses in the order the route reaches them. */
  stops: Stop[]
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
 * red and flashes; a bundle drop is blue; a special request is purple. Each has the stop's name, with its address
 * under it when it has both, and a bundle drop has how many papers beside them, in a badge that a long name can't
 * push off. A special request has its note in place of the name, in a banner a little taller so it can have the room.
 * The house number to look for is on a plate at the front of that line, big enough to read at a glance. The side
 * of the road the stop is on sits at that edge of the banner, with an arrow.
 *
 * For a row of no-throw houses it is a plate for each house, in order, since which house it is is what the driver is after:
 * on one line, or two when the row is long. How many more alerts are waiting is a small badge beside the title.
 */
export function AlertBanner({ stops, pass = 1, ahead, side, waiting }: Props) {
  const stop = stops[0]
  const noThrow = stop.type === 'nothrow'
  const request = stop.type === 'request'
  const { title, name, address, papers, number } = alertText(stop)
  const where = `${name}${pass > 1 ? ` · pass ${pass}` : ''}`
  const row = stops.length > 1
  const layout = platesLayout(stops.length, PLATES_PER_LINE)
  const marker = side ? (
    <div className="stop-alert-side">
      <Icon name={side === 'left' ? 'arrow-left' : 'arrow-right'} size={26} strokeWidth={2.8} />
      {side === 'left' ? 'Left' : 'Right'}
    </div>
  ) : (
    <div className="stop-alert-glyph">
      <Icon name={noThrow ? 'slash' : request ? 'star' : 'package'} size={26} strokeWidth={2} />
    </div>
  )
  return (
    <div
      className={`stop-alert ${noThrow ? 'red' : request ? 'purple' : 'blue'}${side === 'right' ? ' right' : ''}${row ? ' row' : ''}${layout.lines > 1 ? ' tall' : ''}`}
      role="alert"
      aria-label={alertSpeech(stops)}
    >
      {side !== 'right' && marker}
      <div className="stop-alert-text">
        <div className="stop-alert-head">
          <span className="stop-alert-title">{title}</span>
          {waiting > 0 && (
            <span className="stop-alert-more" aria-label={`${waiting} more waiting`}>
              +{waiting}
            </span>
          )}
          <span className="stop-alert-dist">{aheadText(ahead)}</span>
        </div>
        {row ? (
          <div className="stop-alert-plates">
            {stops.slice(0, layout.shown).map((s) => {
              const { text, named } = plateText(s)
              return (
                <span key={s.id} className={`stop-alert-num${text.length > 4 ? ' long' : ''}${named ? ' named' : ''}`}>
                  {text}
                </span>
              )
            })}
            {layout.more > 0 && <span className="stop-alert-plus">+{layout.more}</span>}
          </div>
        ) : (
          <div className="stop-alert-sub">
            {number && (
              <span className={number.length > 4 ? 'stop-alert-num long' : 'stop-alert-num'} aria-label={`House number ${number}`}>
                {number}
              </span>
            )}
            <div className="stop-alert-lines">
              <span className={address ? (request ? 'stop-alert-name two' : 'stop-alert-name one') : 'stop-alert-name'}>{where}</span>
              {address && <span className="stop-alert-address">{address}</span>}
            </div>
            {papers && <span className="stop-alert-qty">{papers}</span>}
          </div>
        )}
      </div>
      {side === 'right' && marker}
    </div>
  )
}
