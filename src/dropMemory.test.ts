import { describe, expect, it } from 'vitest'
import { restartedRound, restoreBundle } from './bundleFlow'
import { markDropped, otherPasses, passStates, type PassStates } from './bundles'
import { keptBeforeDrop } from './dropMemory'
import type { Occurrence } from './geo'
import type { RoundState, StopType } from './types'

/** One time the route goes by a stop, `at` metres along it. */
const occ = (key: string, at: number, type: StopType = 'bundle'): Occurrence => ({
  key,
  stop: { id: key.split('#')[0], type, pathIdx: 0, lat: 0, lng: 0 },
  idx: 0,
  at,
  off: 0,
})

// A bundle stop on a street the route drives twice (x at 200 m and again at 800 m), with another bundle stop between, at 500 m.
const occs = [occ('x', 200), occ('y', 500), occ('x#2', 800)]
const SLACK = 15

/** Drops a bundle as the round screen does: what its passes stood at is kept first, for Undo. */
function drop(round: RoundState, key: string, memory: Map<string, PassStates>): RoundState {
  const others = otherPasses(occs, key)
  memory.set(key, passStates(round, [key, ...others]))
  return markDropped(round, key, others)
}

/** Undo, as the round screen does it: with what was kept for the drop, or, with nothing kept, only the pass that was dropped. */
const undo = (round: RoundState, key: string, memory: ReadonlyMap<string, PassStates>): RoundState => restoreBundle(round, key, memory.get(key) ?? false)

describe('what is kept for taking back a drop when the round is restarted', () => {
  it('keeps it for a drop the restart keeps, so Undo after a carry-on puts back the pass still to come as well', () => {
    const memory = new Map<string, PassStates>()
    const dropped = drop({ handledStopIds: [] }, 'x', memory)
    expect(dropped.handledStopIds).toEqual(['x', 'x#2'])
    // Carry on from here, 400 m along: the drop at 200 m stays, and so does the pass at 800 m it settled.
    const next = restartedRound(dropped, occs, 400, SLACK)
    expect(next.dropped).toEqual(['x'])
    expect(next.handledStopIds).toContain('x#2')
    const kept = keptBeforeDrop(memory, next)
    const back = undo(next, 'x', kept)
    // Both passes are to do again: the one at 800 m alerts when the driver gets there.
    expect(back.handledStopIds).not.toContain('x')
    expect(back.handledStopIds).not.toContain('x#2')
    expect(back.dropped ?? []).toEqual([])
  })

  it('would leave the pass to come done, and so silent, with nothing kept', () => {
    const memory = new Map<string, PassStates>()
    const next = restartedRound(drop({ handledStopIds: [] }, 'x', memory), occs, 400, SLACK)
    expect(undo(next, 'x', new Map()).handledStopIds).toEqual(['x#2'])
  })

  it('lets go of a drop the restart forgot: one after the spot, and every one on a fresh start', () => {
    const memory = new Map<string, PassStates>()
    const both = drop(drop({ handledStopIds: [] }, 'x', memory), 'y', memory)
    expect([...memory.keys()]).toEqual(['x', 'y'])
    // A skip back to 300 m: the drop at 500 m comes up again, and the one at 200 m stays.
    expect([...keptBeforeDrop(memory, restartedRound(both, occs, 300, SLACK)).keys()]).toEqual(['x'])
    expect(keptBeforeDrop(memory, restartedRound(both, occs, 0, SLACK)).size).toBe(0)
    expect(keptBeforeDrop(memory, restartedRound(both, occs, 300, SLACK, true)).size).toBe(0)
  })

  it('does not change what it is given', () => {
    const memory = new Map<string, PassStates>([['x', new Map([['x', 'open']])]])
    keptBeforeDrop(memory, { dropped: [] })
    expect(memory.size).toBe(1)
  })
})
