import { aheadText, alertSpeech, alertText, platesLayout, plateText } from './alerts'
import { BLOCK_GLYPH } from './colors'
import { Icon } from './Icon'
import type { Stop } from './types'
import './block.css'
import './bundles.css'

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
  /** The driver tapped Dropped. Given for a bundle drop, it adds the big Dropped button, the one tappable part of an alert. */
  onDropped?: () => void
  /**
   * An apartment block still to come while this is the banner of another stop (see `bannerBlock`), with the side of the road it is on
   * (null when that can't be told): it is shown in a teal strip under the stop's details (above a bundle drop's Dropped button), so its
   * papers are not hidden by the other stop. Left out, or given to a block's own banner, there is no strip.
   */
  blockAhead?: { stop: Stop; side: 'left' | 'right' | null }
}

/**
 * The strip in another stop's banner for an apartment block still to come: 'Apartment block' with how many papers to throw there, and
 * the side it is on in the same arrow and word as the block's own banner, at that edge of the strip (a building when the side can't be
 * told). Teal, as the block's own banner is, so it is not taken for part of the stop the banner is for.
 */
function BlockStrip({ stop, side }: { stop: Stop; side: 'left' | 'right' | null }) {
  const marker = side ? (
    <div className="block-strip-side">
      <Icon name={side === 'left' ? 'arrow-left' : 'arrow-right'} size={20} strokeWidth={2.8} />
      {side === 'left' ? 'Left' : 'Right'}
    </div>
  ) : (
    <div className="block-strip-glyph">
      <svg className="icon" width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: BLOCK_GLYPH }} />
    </div>
  )
  return (
    <div className={`block-strip${side === 'right' ? ' right' : ''}`}>
      {side !== 'right' && marker}
      <div className="block-strip-title">Apartment block</div>
      {!!stop.qty && (
        <div className="block-strip-papers">
          <span className="block-strip-count">{stop.qty}</span>
          <span className="block-strip-unit">{stop.qty === 1 ? 'paper' : 'papers'}</span>
        </div>
      )}
      {side === 'right' && marker}
    </div>
  )
}

/**
 * The warning for a stop you are close to: a banner across the top of the map, which stays usable
 * underneath. Touches go through it to the map and it goes by itself once you are away from the stop; the one thing
 * to tap is a bundle drop's big Dropped button, which says the bundle is done. No-throw is
 * red and flashes; a bundle drop is blue; a special request is purple; an apartment block is teal. Each has the stop's name, with its address
 * under it when it has both, and a bundle drop has how many papers in a badge that a long name can't push off. A bundle drop
 * with its button is taller: the stop's details across the top, in bigger type with room for a long name and a two-line address
 * (the papers are not beside them but beside the button, so the name has the width), and the button under them. A special request
 * has its note in place of the name, in a banner a little taller so it can have the room.
 *
 * An apartment block is told as 'Apartment block' with the side it is on, in the same arrow and word as a bundle drop's, and how many
 * papers to throw there in a big panel under its details, as a bundle drop's papers are beside its button: it is the count the driver
 * looks for. It has no button, as it is done by being passed, and no part of it takes a touch.
 *
 * The distance changes as the driver approaches, and is hidden from a screen reader: the banner's own label says what it is for,
 * and each change of the distance would otherwise read the whole alert out again.
 * The house number to look for is on a plate at the front of that line, big enough to read at a glance. The side
 * of the road the stop is on sits at that edge of the banner, with an arrow.
 *
 * For a row of no-throw houses it is a plate for each house, in order, since which house it is is what the driver is after:
 * on one line, or two when the row is long. How many more alerts are waiting is a small badge beside the title.
 *
 * Every other stop outranks an apartment block (see `pickCurrent`), so while a no-throw house's, a bundle drop's or a special request's
 * banner is up, a block still to come is shown in it, in a teal strip under the stop's details with its papers and its side (see
 * `BlockStrip`), and the label says both. A bundle drop keeps its Dropped button under the strip.
 */
export function AlertBanner({ stops, pass = 1, ahead, side, waiting, onDropped, blockAhead }: Props) {
  const stop = stops[0]
  const noThrow = stop.type === 'nothrow'
  const request = stop.type === 'request'
  const block = stop.type === 'block'
  // A block's own banner already has its papers: any other has room made for a block in it.
  const strip = block ? undefined : blockAhead
  const { title, name, address, papers, number } = alertText(stop)
  const where = `${name}${pass > 1 ? ` · pass ${pass}` : ''}`
  const row = stops.length > 1
  const ask = stop.type === 'bundle' && !!onDropped
  const layout = platesLayout(stops.length, PLATES_PER_LINE)
  const marker = side ? (
    <div className="stop-alert-side">
      <Icon name={side === 'left' ? 'arrow-left' : 'arrow-right'} size={26} strokeWidth={2.8} />
      {side === 'left' ? 'Left' : 'Right'}
    </div>
  ) : (
    <div className="stop-alert-glyph">
      {block ? (
        <svg className="icon" width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" dangerouslySetInnerHTML={{ __html: BLOCK_GLYPH }} />
      ) : (
        <Icon name={noThrow ? 'slash' : request ? 'star' : 'package'} size={26} strokeWidth={2} />
      )}
    </div>
  )
  const body = (
    <>
      {side !== 'right' && marker}
      <div className="stop-alert-text">
        <div className="stop-alert-head">
          <span className="stop-alert-title">{title}</span>
          {waiting > 0 && (
            <span className="stop-alert-more" aria-label={`${waiting} more waiting`}>
              +{waiting}
            </span>
          )}
          <span className="stop-alert-dist" aria-hidden="true">
            {aheadText(ahead)}
          </span>
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
            {papers && !ask && !block && <span className="stop-alert-qty">{papers}</span>}
          </div>
        )}
      </div>
      {side === 'right' && marker}
    </>
  )
  return (
    <div
      className={`stop-alert ${noThrow ? 'red' : request ? 'purple' : block ? 'teal' : 'blue'}${side === 'right' ? ' right' : ''}${row ? ' row' : ''}${layout.lines > 1 ? ' tall' : ''}${ask ? ' ask' : ''}${strip ? ' with-block' : ''}`}
      role="alert"
      aria-label={strip ? `${alertSpeech(stops, side)} ${alertSpeech([strip.stop], strip.side)}` : alertSpeech(stops, side)}
    >
      {ask ? <div className="stop-alert-body">{body}</div> : block || strip ? <div className="block-body">{body}</div> : body}
      {strip && <BlockStrip stop={strip.stop} side={strip.side} />}
      {block && papers && (
        <div className="block-papers">
          <span className="block-count">{stop.qty}</span> <span className="block-unit">{stop.qty === 1 ? 'paper' : 'papers'}</span>
        </div>
      )}
      {ask && (
        <div className="stop-alert-act">
          {papers && <span className="stop-alert-qty">{papers}</span>}
          <button className="stop-alert-drop" aria-label={`Dropped: ${name}`} onClick={onDropped}>
            <Icon name="check" size={30} strokeWidth={3.2} />
            Dropped
          </button>
        </div>
      )}
    </div>
  )
}
