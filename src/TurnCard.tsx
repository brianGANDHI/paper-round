import { arrowShape, turnAheadText, turnKind, turnWords, type Turn } from './turns'

interface Props {
  turn: Turn
  /** How far ahead the turn is along the route, in metres. Small or negative once the driver is at it. */
  ahead: number
}

/**
 * The next turn: a dark card under the side pill with an arrow bent the way the route turns, what to do, and
 * how far away it is. It is dark so it can't be taken for a stop alert, which are blue and red. It has
 * nothing to tap and goes by itself once the turn is behind.
 */
export function TurnCard({ turn, ahead }: Props) {
  const { label } = turnWords(turn.angle)
  const distance = turnAheadText(ahead)
  const { shaft, head } = arrowShape(turn.angle)
  // The U in the arrow turns right; for a U-turn to the left it is flipped.
  const flip = turnKind(turn.angle) === 'uturn' && turn.angle < 0
  const spoken = ahead < 15 ? 'now' : `in ${Math.round(ahead / 10) * 10} metres`
  return (
    <div className="turn-card" role="img" aria-label={`${label} ${spoken}`}>
      <div className="turn-arrow">
        <svg viewBox="0 0 48 48" width="44" height="44" aria-hidden="true" focusable="false">
          <g
            transform={flip ? 'translate(48 0) scale(-1 1)' : undefined}
            fill="currentColor"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={shaft} fill="none" strokeWidth="6" />
            <polygon points={head} strokeWidth="2" />
          </g>
        </svg>
      </div>
      <div className="turn-text">
        <span className="turn-label">{label}</span>
        <span className="turn-dist">{distance}</span>
      </div>
    </div>
  )
}
