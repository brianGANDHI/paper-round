import type { PassStates } from './bundles'
import type { RoundState } from './types'

/**
 * What the round screen keeps for taking back each drop once the round is restarted to `next` (a skip, Carry on from here, the carry-on
 * that comes by itself, or a start from a spot): how each pass of the stop stood before the drop (`passStates`, by the key dropped: see
 * `restoreBundle`), for the drops `next` still has. A restart keeps a drop made before the spot, with every pass of the stop it settled
 * still done (see `restartedRound`), so an Undo of it after the restart puts all of them back, as it does before one, and the pass to
 * come alerts again. A drop the restart forgot (one after the spot, or every drop on a fresh start) has nothing left to take back, and
 * its memory goes. Nothing in `before` is changed.
 */
export function keptBeforeDrop(before: ReadonlyMap<string, PassStates>, next: Pick<RoundState, 'dropped'>): Map<string, PassStates> {
  const dropped = new Set(next.dropped ?? [])
  return new Map([...before].filter(([key]) => dropped.has(key)))
}
