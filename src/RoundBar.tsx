import type { Ref } from 'react'
import { Icon } from './Icon'
import { barLead, barMiddle } from './roundView'
import './roundBar.css'

/** A message the bar shows in place of its usual line for a while, with a way to take back what it tells of when there is one. */
export interface Notice {
  message: string
  undo?: () => void
}

/**
 * The bar's line for bundle drops, as it shows it. Usually the next one: `distance` and `papers` are already words ("340 m", "12 papers"),
 * and `missed` is how many have been driven past without being dropped. When none is ahead it says how the round stands instead:
 * `lead` is then "Bundles", `name` the sentence ("All bundles dropped"), and there is no distance or papers.
 */
export interface NextBundle {
  /** What the line leads with: "Next bundle" or, with none ahead, "Bundles". */
  lead: string
  name: string
  distance: string | null
  papers: string | null
  missed: number
}

interface BarProps {
  /** The bar's own box, for measuring how much of the map it covers. */
  ref?: Ref<HTMLDivElement>
  /** How many special stops are still to do. */
  remaining: number
  /** How close to a stop its alert comes up, in metres. The bar says it only when it has nothing else to say: the menu is where it is changed. */
  alertDistance: number
  /** Whether the phone's position is known yet: until it is, the bar says it is looking. */
  located: boolean
  /** Something to tell the driver for a few seconds. It takes the bar's line, with Undo where there is one. */
  notice: Notice | null
  /** Called once Undo has been tapped, so the notice can go. */
  onNoticeDone: () => void
  /** Something wrong with the GPS that stays until it is put right, such as no signal. It takes the middle of the bar, but the count stays. */
  problem: string | null
  /** A caution that stays but is not about where the phone is, such as the screen being allowed to sleep. It is a small button beside the menu, so the next bundle stays in view; tapping it says `caution` as a notice. */
  caution: string | null
  /** Called with the caution's words when its button is tapped. */
  onCaution: (message: string) => void
  /** The next bundle drop, shown as a line that opens the list of them. Left out, there is no such line. */
  nextBundle?: NextBundle | null
  /** Opens the list of bundle drops: the whole next-bundle line is the button for it. */
  onBundles?: () => void
  onMenu: () => void
}

/** Three dots, for the menu. */
function More() {
  return (
    <svg className="icon" width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
    </svg>
  )
}

/** How many special stops are left, as a big number with what it counts under it, or that they are all done. */
function Count({ remaining }: { remaining: number }) {
  if (remaining === 0) {
    return (
      <div className="round-count done" role="group" aria-label="All done. Every special stop is behind you.">
        <span className="round-check">
          <Icon name="check" size={28} strokeWidth={3} />
        </span>
        <span className="round-count-label" aria-hidden="true">
          All done
        </span>
      </div>
    )
  }
  return (
    <div className="round-count" role="group" aria-label={`${remaining} special ${remaining === 1 ? 'stop' : 'stops'} left`}>
      <span className="round-count-num" aria-hidden="true">
        {remaining}
      </span>
      <span className="round-count-label" aria-hidden="true">
        {remaining === 1 ? 'stop left' : 'stops left'}
      </span>
    </div>
  )
}

/**
 * The line for the next bundle drop: where it is and how far, and the papers for it. The whole line takes a tap when there is somewhere
 * for it to go. The venue's name has a row to itself, the full width of the line, since it is what the driver wants to see. Above it
 * are the lead, the distance, the pill for bundles missed and the papers, on one row that never wraps into the name: whatever does not
 * fit is left off, the papers first (they are on the alert and in the list). `crowded` is when the line has less room than usual, with
 * the pill for bundles missed or the caution button beside it: the lead is then "Next" rather than "Next bundle".
 */
function BundleLine({ bundle, crowded, onBundles }: { bundle: NextBundle; crowded: boolean; onBundles?: () => void }) {
  const body = (
    <>
      <span className="round-bundle-top">
        <span className="lead">{barLead(bundle.lead, crowded || bundle.missed > 0)}</span>
        {bundle.distance && <span className="dist">{bundle.distance}</span>}
        {bundle.missed > 0 && <span className="round-missed">{bundle.missed} missed</span>}
        {bundle.papers && <span className="papers">{bundle.papers}</span>}
      </span>
      <span className="round-bundle-name">{bundle.name}</span>
    </>
  )
  const said = `${bundle.lead}: ${bundle.name}${bundle.distance ? `, ${bundle.distance}` : ''}${bundle.papers ? `, ${bundle.papers}` : ''}${bundle.missed > 0 ? `. ${bundle.missed} missed` : ''}.`
  return onBundles ? (
    <button className="round-bundle" aria-label={`${said} Tap for the list of bundle drops.`} onClick={onBundles}>
      {body}
    </button>
  ) : (
    <div className="round-bundle" role="group" aria-label={said}>
      {body}
    </div>
  )
}

/**
 * The one slim bar along the bottom of the round: the stops left, the next bundle drop, and the menu. What used to float over the map
 * is shown in it instead. A notice (with its Undo) takes the whole line, and a problem with the GPS takes the middle of it and leaves
 * the count, so the map never has anything laid over it down here. The next bundle stays in view otherwise, with a caution that
 * stays (the screen may sleep) as a small amber button beside the menu. The alert distance is in the menu, and is said in the middle
 * of the bar only when there is nothing else to say.
 */
export function RoundBar({ ref, remaining, alertDistance, located, notice, onNoticeDone, problem, caution, onCaution, nextBundle = null, onBundles, onMenu }: BarProps) {
  const menu = (
    <button className="round-menu-btn" aria-label="Menu" aria-haspopup="dialog" onClick={onMenu}>
      <More />
    </button>
  )
  if (notice) {
    return (
      <div className="round-bar notice" ref={ref}>
        <div className="round-notice" role="status">
          {notice.message}
        </div>
        {notice.undo && (
          <button
            className="round-undo"
            onClick={() => {
              notice.undo?.()
              onNoticeDone()
            }}
          >
            Undo
          </button>
        )}
        {menu}
      </div>
    )
  }
  const middle = barMiddle({ problem: !!problem, located, bundle: !!nextBundle })
  return (
    <div className="round-bar" ref={ref}>
      <Count remaining={remaining} />
      {middle === 'problem' && (
        <div className="round-warn" role="status">
          <Icon name="alert" size={20} />
          <span>{problem}</span>
        </div>
      )}
      {middle === 'finding' && <div className="round-plain">Finding your location...</div>}
      {middle === 'bundle' && nextBundle && <BundleLine bundle={nextBundle} crowded={!!caution} onBundles={onBundles} />}
      {middle === 'alerts' && <div className="round-plain">Alerts at {alertDistance} m</div>}
      {caution && (
        <button className="round-caution" aria-label={`Warning: ${caution}`} onClick={() => onCaution(caution)}>
          <Icon name="alert" size={24} />
        </button>
      )}
      {menu}
    </div>
  )
}

interface ButtonsProps {
  /** The map is not following the driver (they are looking around, or the whole route is up): the way back is a big button with its name on it. */
  recentre: boolean
  /** The map is turned to point the way the driver is heading. */
  headingUp: boolean
  /** The voice is on. */
  voice: boolean
  /** Whether the phone can speak at all. If it can't, there is no voice button. */
  canSpeak: boolean
  onZoom: (by: 1 | -1) => void
  onFollow: () => void
  onCompass: () => void
  onVoice: () => void
}

/** A plus or a minus, for the zoom buttons. */
function ZoomGlyph({ plus }: { plus: boolean }) {
  return (
    <svg className="icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true" focusable="false">
      <line x1="5" y1="12" x2="19" y2="12" />
      {plus && <line x1="12" y1="5" x2="12" y2="19" />}
    </svg>
  )
}

/**
 * The buttons down the right of the map, only those used while driving, each 48 px and apart from the next so a thumb finds the
 * right one in a moving car: the voice, the compass, the way back to following (which is a big button with its name when the map
 * is not following), and zoom in and out nearest the thumb.
 */
export function RoundButtons({ recentre, headingUp, voice, canSpeak, onZoom, onFollow, onCompass, onVoice }: ButtonsProps) {
  return (
    <div className="round-buttons">
      <div className="round-group">
        {canSpeak && (
          <button className="round-btn" data-on={voice || undefined} aria-pressed={voice} aria-label="Voice" onClick={onVoice}>
            <Icon name={voice ? 'volume-2' : 'volume-x'} size={24} />
          </button>
        )}
        <button
          className="round-btn"
          data-on={headingUp || undefined}
          aria-pressed={headingUp}
          aria-label={headingUp ? 'Map points the way you are heading. Tap to point it north.' : 'Map points north. Tap to point it the way you are heading.'}
          onClick={onCompass}
        >
          <Icon name="compass" size={24} />
        </button>
        {recentre ? (
          <button className="round-btn recentre" onClick={onFollow}>
            <Icon name="navigation" size={22} fill />
            Re-centre
          </button>
        ) : (
          <button className="round-btn" data-on aria-label="Following your location" onClick={onFollow}>
            <Icon name="navigation" size={24} fill />
          </button>
        )}
      </div>
      <div className="round-group">
        <button className="round-btn" aria-label="Zoom in" onClick={() => onZoom(1)}>
          <ZoomGlyph plus />
        </button>
        <button className="round-btn" aria-label="Zoom out" onClick={() => onZoom(-1)}>
          <ZoomGlyph plus={false} />
        </button>
      </div>
    </div>
  )
}
