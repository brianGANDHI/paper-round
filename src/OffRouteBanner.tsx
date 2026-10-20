import { Icon } from './Icon'
import { formatDistance } from './routeEdit'

/** How the way to where the route was left is put in a sentence. */
const SAY: Record<string, string> = { ahead: 'ahead of you', behind: 'behind you' }

interface Props {
  /** Off the route; heading back to where it was left; or back on the route somewhere else and waiting to be told what to do. */
  phase: 'off' | 'returning' | 'rejoined'
  /** How far it is to where the route was left, in metres, while off or heading back. Not given when there is no such place (the route was never followed). */
  metres?: number
  /** Which way that is, from the way the phone is heading: "ahead", "behind", "on your left" or "on your right". Null when that isn't known. */
  where?: string | null
  /** While waiting after a rejoin: how far along the route the driver is compared with where they left it (negative: earlier on), and both places, in metres. */
  moved?: number
  leftAt?: number
  nowAt?: number
  /** What carrying on from here would do to the stops, in words, while waiting after a rejoin. */
  effect?: string
  onCarryOn: () => void
  onTakeBack: () => void
}

/**
 * The warning for leaving the route: an amber banner under the side and the next turn. While off, or heading back, it says how far
 * it is to where the route was left and which way; the line on the map runs there too. Back on the route somewhere else, it has two
 * buttons, since the app can't know whether the driver meant to skip the part in between.
 */
export function OffRouteBanner({ phase, metres, where = null, moved = 0, leftAt = 0, nowAt = 0, effect, onCarryOn, onTakeBack }: Props) {
  if (phase === 'rejoined') {
    const further = moved >= 0
    return (
      <div className="off-banner" role="alert">
        <Icon name="alert" size={26} strokeWidth={2.4} />
        <div className="off-text">
          <div className="off-head">
            <span className="off-title">{further ? 'Back on the route, further on' : 'Back on the route, earlier on'}</span>
            <span className="off-dist" aria-hidden="true">
              {formatDistance(Math.abs(moved))}
            </span>
          </div>
          {/* The places change with every fix: they are not read out again each time. */}
          <div className="off-sub" aria-live="off">
            You left it at {formatDistance(leftAt)} and are now at {formatDistance(nowAt)}.
            {effect && ` If you carry on from here, ${effect[0].toLowerCase()}${effect.slice(1)}`}
          </div>
          <div className="off-sub">Left alone, it carries on from here after about a minute.</div>
          <div className="off-actions">
            <button className="off-btn solid" onClick={onCarryOn}>
              Carry on from here
            </button>
            <button className="off-btn" onClick={onTakeBack}>
              Take me back
            </button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="off-banner" role="alert">
      <Icon name="alert" size={26} strokeWidth={2.4} />
      <div className="off-text">
        <div className="off-head">
          <span className="off-title">{phase === 'off' ? 'Off the route' : 'Heading back'}</span>
          {metres !== undefined && (
            <span className="off-dist" aria-hidden="true">
              {formatDistance(metres)}
            </span>
          )}
        </div>
        <div className="off-sub">
          {metres === undefined
            ? 'You are not on the route.'
            : where
              ? `Where you left the route is ${SAY[where] ?? where}.`
              : 'The dashed line goes to where you left the route.'}
        </div>
      </div>
    </div>
  )
}
