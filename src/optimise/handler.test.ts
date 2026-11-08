import { describe, expect, it, vi } from 'vitest'
import { failureOf, makeHandler, type HandlerParts } from './handler'
import { prepare, solve } from './optimise'
import { OSM_NOTICE, OsmError } from './osmFetch'
import { CANCELLED_MESSAGE, CRASHED_MESSAGE, NOT_READY_MESSAGE, type WorkerReply } from './protocol'
import { defaultChoices } from './run'
import { drive, gridWays, osmOf, savedRoute, stopAt } from './testNetwork'
import type { Budget, OptimiseChoices } from './types'

const QUICK: Budget = { iterations: 2000, seed: 1 }
const WAY = drive([['left', [0, 0], [1, 0], [2, 0], [3, 0]], ['both', [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0]]])
const SAVED = savedRoute(WAY, [stopAt('a', 'bundle', [1.5, 0])])
const MAP = osmOf(gridWays())
const CHOICES: OptimiseChoices = { allowed: {}, keepOrder: true }

/** A handler over the real engine, with the map from a stand-in and a short search. */
function setUp(parts: Partial<HandlerParts> = {}) {
  const replies: WorkerReply[] = []
  const handle = makeHandler((r) => replies.push(r), { fetchMap: async () => MAP, solve: (p, c, _budget, tell) => solve(p, c, QUICK, tell), ...parts })
  return { replies, handle }
}

const lastOf = (replies: WorkerReply[]) => replies[replies.length - 1]
const typed = (replies: WorkerReply[], type: WorkerReply['type']) => replies.filter((r) => r.type === type)

describe('a step at a time', () => {
  it('prepares: the map goes back, then the street list, with progress on the way', async () => {
    const { handle, replies } = setUp()
    await handle({ type: 'prepare', id: 1, saved: SAVED })
    expect(typed(replies, 'map')).toEqual([{ type: 'map', id: 1, osm: MAP }])
    const last = lastOf(replies)
    if (last.type !== 'prepared') throw new Error(`got ${last.type}`)
    expect(last.id).toBe(1)
    expect(last.view.streets.length).toBeGreaterThan(0)
    expect(typed(replies, 'progress').length).toBeGreaterThan(0)
    expect(replies.every((r) => r.id === 1)).toBe(true)
  })

  it('sends only what can cross to the screen', async () => {
    const { handle, replies } = setUp()
    await handle({ type: 'prepare', id: 1, saved: SAVED })
    await handle({ type: 'solve', id: 2, choices: CHOICES })
    expect(() => structuredClone(replies)).not.toThrow()
    expect(JSON.stringify(replies)).not.toContain('"world"')
  })

  it('solves from what it prepared, as often as it is asked, and tells the screen the steps as it goes', async () => {
    const { handle, replies } = setUp()
    await handle({ type: 'prepare', id: 1, saved: SAVED })
    await handle({ type: 'solve', id: 2, choices: CHOICES })
    await handle({ type: 'solve', id: 3, choices: { ...CHOICES, keepOrder: false } })
    const solved = typed(replies, 'solved')
    expect(solved.map((r) => r.id)).toEqual([2, 3])
    for (const r of solved) if (r.type === 'solved') expect(r.result.blocked).toEqual([])
    expect(typed(replies, 'progress').filter((r) => r.id === 2).length).toBeGreaterThan(0)
  })

  it('fetches nothing when the map is given, and sends no map back', async () => {
    const fetchMap = vi.fn(async () => MAP)
    const { handle, replies } = setUp({ fetchMap })
    await handle({ type: 'prepare', id: 1, saved: SAVED, osm: MAP })
    expect(fetchMap).not.toHaveBeenCalled()
    expect(typed(replies, 'map')).toEqual([])
    expect(lastOf(replies).type).toBe('prepared')
  })

  it('finishes a prepare given a map before the next message is read, so a solve can follow straight on', () => {
    const { handle, replies } = setUp()
    void handle({ type: 'prepare', id: 1, saved: SAVED, osm: MAP })
    void handle({ type: 'solve', id: 2, choices: CHOICES })
    expect(typed(replies, 'prepared').map((r) => r.id)).toEqual([1])
    expect(typed(replies, 'solved').map((r) => r.id)).toEqual([2])
  })

  it('says a solve is not ready with nothing prepared', async () => {
    const { handle, replies } = setUp()
    await handle({ type: 'solve', id: 1, choices: CHOICES })
    expect(replies).toEqual([{ type: 'failed', id: 1, failure: { kind: 'not-ready', message: NOT_READY_MESSAGE } }])
  })

  it('leaves what was prepared in place when a solve fails, so it can be tried again', async () => {
    let fail = true
    const { handle, replies } = setUp({
      solve: (p, c, _b, tell) => {
        if (fail) throw new TypeError('a fault')
        return solve(p, c, QUICK, tell)
      },
    })
    await handle({ type: 'prepare', id: 1, saved: SAVED })
    await handle({ type: 'solve', id: 2, choices: CHOICES })
    expect(lastOf(replies)).toEqual({ type: 'failed', id: 2, failure: { kind: 'crashed', message: CRASHED_MESSAGE } })
    fail = false
    await handle({ type: 'solve', id: 3, choices: CHOICES })
    expect(lastOf(replies).type).toBe('solved')
  })
})

describe('the date of the map', () => {
  it('reaches the screen as a note when the map is old, and goes back with the map', async () => {
    const old = { ...MAP, date: '2019-01-02T03:04:05Z' }
    const { handle, replies } = setUp({ fetchMap: async () => old })
    await handle({ type: 'prepare', id: 1, saved: SAVED })
    expect(typed(replies, 'map')).toEqual([{ type: 'map', id: 1, osm: old }])
    const last = lastOf(replies)
    if (last.type !== 'prepared') throw new Error(`got ${last.type}`)
    expect(last.view.notes.join(' ')).toMatch(/months old/)
  })
})

describe('failing', () => {
  it('passes on what the fetch said, in the words for it', async () => {
    const { handle, replies } = setUp({ fetchMap: () => Promise.reject(new OsmError('busy')) })
    await handle({ type: 'prepare', id: 1, saved: SAVED })
    expect(replies).toEqual([{ type: 'failed', id: 1, failure: { kind: 'busy', message: OSM_NOTICE.busy } }])
  })

  it('passes on why the engine could not start, in its own plain words', async () => {
    const { handle, replies } = setUp()
    await handle({ type: 'prepare', id: 1, saved: savedRoute({ points: [], sideChanges: [] }) })
    expect(lastOf(replies)).toEqual({ type: 'failed', id: 1, failure: { kind: 'route', message: 'This route is too short to optimise.' } })
  })

  it('tells the driver nothing technical about a fault', () => {
    expect(failureOf(new TypeError('x is not a function'))).toEqual({ kind: 'crashed', message: CRASHED_MESSAGE })
    expect(failureOf('a string')).toEqual({ kind: 'crashed', message: CRASHED_MESSAGE })
    expect(failureOf(new OsmError('cancelled'))).toEqual({ kind: 'cancelled', message: CANCELLED_MESSAGE })
  })
})

describe('requests that overlap', () => {
  /** A fetch that waits to be let go, or stopped. */
  function gate() {
    const waiting: { signal?: AbortSignal; go: () => void }[] = []
    const fetchMap: HandlerParts['fetchMap'] = (_points, { signal }) =>
      new Promise((resolve, reject) => {
        waiting.push({ signal, go: () => resolve(MAP) })
        signal?.addEventListener('abort', () => reject(new OsmError('cancelled')))
      })
    return { waiting, fetchMap }
  }

  it('stops the fetch of an older prepare, and says nothing more about it', async () => {
    const { waiting, fetchMap } = gate()
    const { handle, replies } = setUp({ fetchMap })
    const first = handle({ type: 'prepare', id: 1, saved: SAVED })
    const second = handle({ type: 'prepare', id: 2, saved: SAVED })
    expect(waiting[0].signal?.aborted).toBe(true)
    expect(waiting[1].signal?.aborted).toBe(false)
    waiting[1].go()
    await Promise.all([first, second])
    expect(replies.every((r) => r.id === 2)).toBe(true)
    expect(lastOf(replies).type).toBe('prepared')
  })

  it('drops a fetch that comes back after a newer request took over, even if it ignored being stopped', async () => {
    let finish = () => {}
    const fetchMap: HandlerParts['fetchMap'] = () => new Promise((resolve) => (finish = () => resolve(MAP)))
    const prepareRoute = vi.fn(prepare)
    const { handle, replies } = setUp({ fetchMap, prepare: prepareRoute })
    const first = handle({ type: 'prepare', id: 1, saved: SAVED })
    await handle({ type: 'prepare', id: 2, saved: SAVED, osm: MAP })
    prepareRoute.mockClear()
    finish()
    await first
    expect(prepareRoute).not.toHaveBeenCalled()
    expect(replies.some((r) => r.id === 1)).toBe(false)
  })

  it('ignores a request older than one it has already had', async () => {
    const { handle, replies } = setUp()
    await handle({ type: 'prepare', id: 5, saved: SAVED })
    const count = replies.length
    await handle({ type: 'solve', id: 4, choices: CHOICES })
    expect(replies).toHaveLength(count)
  })

  it('stops a fetch for a solve that comes too soon, and says it is not ready', async () => {
    const { waiting, fetchMap } = gate()
    const { handle, replies } = setUp({ fetchMap })
    const first = handle({ type: 'prepare', id: 1, saved: SAVED })
    await handle({ type: 'solve', id: 2, choices: CHOICES })
    await first
    expect(waiting[0].signal?.aborted).toBe(true)
    expect(replies).toEqual([{ type: 'failed', id: 2, failure: { kind: 'not-ready', message: NOT_READY_MESSAGE } }])
  })

  it('forgets the last route as soon as a new prepare is asked for', async () => {
    const { handle, replies } = setUp()
    await handle({ type: 'prepare', id: 1, saved: SAVED })
    await handle({ type: 'prepare', id: 2, saved: savedRoute({ points: [], sideChanges: [] }) })
    await handle({ type: 'solve', id: 3, choices: CHOICES })
    expect(lastOf(replies)).toMatchObject({ type: 'failed', id: 3, failure: { kind: 'not-ready' } })
  })
})

describe('the choices the screen starts from', () => {
  it('are there to send straight back', async () => {
    const { handle, replies } = setUp()
    await handle({ type: 'prepare', id: 1, saved: SAVED })
    const reply = lastOf(replies)
    if (reply.type !== 'prepared') throw new Error('not prepared')
    await handle({ type: 'solve', id: 2, choices: defaultChoices(reply.view) })
    expect(lastOf(replies).type).toBe('solved')
  })
})
