import type { Side } from './types'

/** Route colours on the map. These are the iOS system colours, and the map is always light. */
export const SIDE_COLOR: Record<Side, string> = { both: '#007aff', left: '#34c759', right: '#ff9500', transit: '#76767a' }

/** Deeper shades of the same colours, so white text on the side pill stays readable at a glance. */
export const SIDE_PILL: Record<Side, string> = { both: '#0a6ae0', left: '#2b9a4a', right: '#cf6100', transit: '#5c5c60' }

export const SIDE_LABEL: Record<Side, string> = { both: 'Both Sides', left: 'Left Side', right: 'Right Side', transit: 'Transit' }

export const STOP_COLOR = { bundle: '#007aff', nothrow: '#ff3b30' } as const
