import { useState } from 'react'
import { compassLabel, compassName } from './guidance'
import { turnTo } from './transitView'
import './guidance.css'

interface Props {
  /** The way the phone is heading, in degrees clockwise from north. */
  heading: number
  /** The map is turned to the heading (so up on the screen is the way the driver is going, not north). */
  turned: boolean
}

/**
 * The way the driver is heading: a small dial at the top right with an arrow turned to the heading, and the compass point under it
 * ("NE"). It is for being sure which way you are going, most of all on a long drive between delivery areas.
 *
 * It agrees with the map. With the map north up, the ring is still and its red mark is at the top (north), and the arrow turns to
 * the heading. With the map turned to the heading, up is the way the driver is going, so the arrow points up and the ring turns
 * the other way to keep its red mark where north is on the map. It has nothing to tap, and it is not drawn while the phone can't say which way it is heading.
 */
export function HeadingBadge({ heading, turned }: Props) {
  // What the dial is turned by is kept unwrapped, so that passing north turns it the short way round and not almost all the way back.
  const [shown, setShown] = useState(heading)
  const angle = turnTo(shown, heading)
  if (angle !== shown) setShown(angle)
  const name = compassName(heading)
  return (
    <div className="heading-badge" role="img" aria-label={`Heading ${name}`}>
      {/* Switching between the two ways of drawing it is instant, not a spin: a new dial each time. */}
      <div className="heading-dial" key={turned ? 'turned' : 'north'} aria-hidden="true">
        <span className="heading-ring" style={{ transform: `rotate(${turned ? -angle : 0}deg)` }}>
          <svg viewBox="0 0 26 26" focusable="false">
            <circle cx="13" cy="13" r="11" />
            <circle className="heading-north" cx="13" cy="3.6" r="2.4" />
          </svg>
        </span>
        <span className="heading-needle" style={{ transform: `rotate(${turned ? 0 : angle}deg)` }}>
          <svg viewBox="0 0 26 26" focusable="false">
            <polygon points="13,5.5 18.5,19.5 13,16.5 7.5,19.5" />
          </svg>
        </span>
      </div>
      <span className="heading-abbr" aria-hidden="true">
        {compassLabel(heading)}
      </span>
    </div>
  )
}
