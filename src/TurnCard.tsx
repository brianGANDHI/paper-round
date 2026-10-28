import type { CSSProperties } from 'react'
import { SIDE_COLOR } from './colors'
import { straightCard } from './transitView'
import { arrowShape, turnAheadText, turnKind, turnWords, type Turn } from './turns'
import './guidance.css'

/** The next turn is close: shown as a turn, at the distance it is. */
interface TurnProps {
  kind?: 'turn'
  turn: Turn
  /** How far ahead the turn is along the route, in metres. Small or negative once the driver is at it. */
  ahead: number
  /** The street the turn leads into, when it is known and it is not the one already being driven. */
  street?: string | null
}

/** No turn for a while, on a stretch of transit: carry on. */
interface StraightProps {
  kind: 'straight'
  /** How far to carry on, in metres: to the turn in `then`, or to the end of the route when there is none. */
  ahead: number
  then: Turn | null
  /** The street the turn in `then` leads into, when it is known and it is not the one already being driven. */
  street?: string | null
}

/** An arrow bent the way a route turns, on the 48 by 48 grid of `arrowShape`. A U-turn is drawn turning right, and flipped for one to the left. */
function Glyph({ angle, size, className }: { angle: number; size?: number; className?: string }) {
  const { shaft, head } = arrowShape(angle)
  const flip = turnKind(angle) === 'uturn' && angle < 0
  return (
    <svg className={className} viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false">
      <g transform={flip ? 'translate(48 0) scale(-1 1)' : undefined} fill="currentColor" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d={shaft} fill="none" strokeWidth="6" />
        <polygon points={head} strokeWidth="2" />
      </g>
    </svg>
  )
}

/** The turn coming up: the arrow, what to do, how far away it is, and the street it leads into. */
function Approach({ turn, ahead, street }: TurnProps) {
  const { label } = turnWords(turn.angle)
  const distance = turnAheadText(ahead)
  const spoken = ahead < 15 ? 'now' : `in ${Math.round(ahead / 10) * 10} metres`
  return (
    <div className="turn-card" role="img" aria-label={`${label}${street ? ` onto ${street}` : ''} ${spoken}`}>
      <div className="turn-arrow">
        <Glyph angle={turn.angle} size={44} />
      </div>
      <div className="turn-text">
        <span className="turn-label">{label}</span>
        <span className="turn-dist">{distance}</span>
        {street && <span className="turn-street">{street}</span>}
      </div>
    </div>
  )
}

/** What the card for a straight draws the arrow tile in, to tie it to the line the driver follows on the map (transit is its own colour there). */
const TRANSIT_TINT = { '--transit': SIDE_COLOR.transit } as CSSProperties

/**
 * The way ahead on a stretch of transit, when the next turn is not near: the same dark card, with an arrow straight up, "Continue" over
 * how far to carry on, and under it the turn that comes then (a small arrow and the street it leads into, or what the turn is when
 * the street is not known). Where no turn is left, it says how far it is to the end of the route.
 */
function Straight({ ahead, then, street }: StraightProps) {
  const card = straightCard({ ahead, then }, street)
  return (
    <div className="turn-card straight" role="img" aria-label={card.label}>
      <div className="turn-arrow" style={TRANSIT_TINT}>
        <Glyph angle={0} size={44} />
      </div>
      <div className="turn-text">
        <span className="turn-label">{card.lead}</span>
        {card.value && <span className="turn-dist">{card.value}</span>}
        {then && card.thenText && (
          <span className="turn-then">
            <Glyph angle={then.angle} className="turn-then-arrow" />
            <span className="turn-street">{card.thenText}</span>
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The next turn: a dark card under the side pill with an arrow bent the way the route turns, what to do, and
 * how far away it is. It is dark so it can't be taken for a stop alert, which are blue and red. It has
 * nothing to tap and goes by itself once the turn is behind. On a stretch of transit it is always there: when the next turn is
 * far off it is the straight variant, "Continue 3.2 km" and the turn that comes then (see `Straight`).
 */
export function TurnCard(props: TurnProps | StraightProps) {
  return props.kind === 'straight' ? <Straight {...props} /> : <Approach {...props} />
}
