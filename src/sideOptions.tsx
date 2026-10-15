import type { ReactNode } from 'react'
import { SIDE_COLOR } from './colors'
import type { Side } from './types'

const dot = (color: string) => <span className="seg-dot" style={{ background: color }} />

/** Both / Left / Right, each with the colour it is drawn in on the map. */
export const BRUSH_OPTIONS: { value: Side; label: ReactNode; ariaLabel: string }[] = [
  { value: 'both', label: <>{dot(SIDE_COLOR.both)}Both</>, ariaLabel: 'Both sides' },
  { value: 'left', label: <>{dot(SIDE_COLOR.left)}Left</>, ariaLabel: 'Left side' },
  { value: 'right', label: <>{dot(SIDE_COLOR.right)}Right</>, ariaLabel: 'Right side' },
]
