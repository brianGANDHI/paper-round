import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOptimiser, OptimiseError, SILENCE_CHECK_MS, SILENCE_LIMIT_MS, type WorkerLike } from './client'
import { makeHandler, type HandlerParts } from './handler'
import { solve } from './optimise'
import { fetchMap, OSM_NOTICE, OsmError, TOTAL_TIMEOUT_MS } from './osmFetch'
import { CRASHED_MESSAGE, NOT_READY_MESSAGE, type WorkerReply, type WorkerRequest } from './protocol'
import { drive, gridWays, osmOf, savedRoute, stopAt } from './testNetwork'
import type { Budget, OptimiseChoices, ProgressInfo } from './types'

const QUICK: Budget = { iterations: 2000, seed: 1 }
const WAY = drive([['left', [0, 0], [1, 0], [2, 0], [3, 0]], ['both', [3, 0], [3, 1], [2, 1], [1, 1], [0, 1], [0, 0]]])
const SAVED = savedRoute(WAY, [stopAt('a', 'bundle', [1.5, 0])])
const MAP = osmOf(gridWays())
const CHOICES: OptimiseChoices = { allowed: {}, keepOrder: true }

/** A worker in all but the thread: the real handler over the real engine, a message at a time, each after a turn of the event loop as a real worker's would be. */
class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null
  onerror: WorkerLike['onerror'] = null
  onmessageerror: WorkerLike['onmessageerror'] = null
  terminated = false
  requests: WorkerRequest[] = []
  /** Replies held back, for a test to let go when it wants. */
  held: WorkerReply[] | null = null
  private handle: (r: WorkerRequest) => Promise<void>

  constructor(parts: Partial<HandlerParts>) {
    this.handle = makeHandler(
      (reply) => {
        if (this.terminated) return
        // Each goes through a clone, as one crossing from a worker does.
        const copy = structuredClone(reply)
        if (this.held) this.held.push(copy)
        else setTimeout(() => this.onmessage?.({ data: copy }), 0)
      },
      { fetchMap: async () => MAP, solve: (p, c, _b, tell) => solve(p, c, QUICK, tell), ...parts },
    )
  }

  postMessage(request: WorkerRequest) {
    this.requests.push(request)
    const copy = structuredClone(request)
    setTimeout(() => {
      if (!this.terminated) void this.handle(copy)
    }, 0)
  }

  terminate() {
    this.terminated = true
  }
}

function setUp(parts: Partial<HandlerParts> = {}, onProgress?: (p: ProgressInfo) => void) {
  const workers: FakeWorker[] = []
  const client = createOptimiser({
    onProgress,
    makeWorker: () => {
      const worker = new FakeWorker(parts)
      workers.push(worker)
      return worker
    },
  })
  return { client, workers }
}

const kindOf = (run: Promise<unknown>) => run.then(() => 'fine', (e: unknown) => (e instanceof OptimiseError ? e.kind : `thrown: ${String(e)}`))
/** A map that never comes, unless the fetch is stopped. */
const noMap: HandlerParts['fetchMap'] = (_points, { signal }) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new OsmError('cancelled'))))

describe('a run', () => {
  it('prepares, and then solves from what the worker kept', async () => {
    const { client, workers } = setUp()
    const view = await client.prepare(SAVED)
    expect(view.streets.length).toBeGreaterThan(0)
    const result = await client.solve(CHOICES)
    expect(result.blocked).toEqual([])
    expect(workers).toHaveLength(1)
    expect(workers[0].requests.map((r) => r.type)).toEqual(['prepare', 'solve'])
  })

  it('can solve again with other choices, and needs no second worker or map', async () => {
    const fetchMap = vi.fn(async () => MAP)
    const { client, workers } = setUp({ fetchMap })
    await client.prepare(SAVED)
    await client.solve(CHOICES)
    await client.solve({ ...CHOICES, keepOrder: false })
    expect(workers).toHaveLength(1)
    expect(fetchMap).toHaveBeenCalledTimes(1)
  })

  it('tells the progress callback how each step goes', async () => {
    const heard: ProgressInfo[] = []
    const { client } = setUp({}, (p) => heard.push(p))
    await client.prepare(SAVED)
    expect(heard.some((p) => p.step === 'Matching the route to the map')).toBe(true)
    heard.length = 0
    await client.solve(CHOICES)
    expect(heard.at(-1)).toEqual({ step: 'Done', done: 1 })
  })

  it('gives each failure as an error the screen can word', async () => {
    const { client } = setUp({ fetchMap: () => Promise.reject(new OsmError('offline')) })
    const error = await client.prepare(SAVED).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OptimiseError)
    expect(error).toMatchObject({ kind: 'offline' })
    expect((error as OptimiseError).message).toBe(OSM_NOTICE.offline)
  })

  it('can be tried again after a failure', async () => {
    const fetchMap = vi.fn<HandlerParts['fetchMap']>().mockRejectedValueOnce(new OsmError('busy')).mockResolvedValue(MAP)
    const { client, workers } = setUp({ fetchMap })
    expect(await kindOf(client.prepare(SAVED))).toBe('busy')
    expect((await client.prepare(SAVED)).streets.length).toBeGreaterThan(0)
    expect(workers).toHaveLength(1)
  })
})

describe('cancelling', () => {
  it('rejects the step running as cancelled, and ends the worker', async () => {
    const { client, workers } = setUp({ fetchMap: noMap })
    const run = client.prepare(SAVED)
    client.cancel()
    expect(await kindOf(run)).toBe('cancelled')
    expect(workers[0].terminated).toBe(true)
  })

  it('ends a solve, which could not hear anything else', async () => {
    const { client, workers } = setUp()
    await client.prepare(SAVED)
    const run = client.solve(CHOICES)
    client.cancel()
    expect(await kindOf(run)).toBe('cancelled')
    expect(workers[0].terminated).toBe(true)
  })

  it('does nothing with no step running, so what the worker prepared stays', async () => {
    const { client, workers } = setUp()
    await client.prepare(SAVED)
    client.cancel()
    expect(workers[0].terminated).toBe(false)
    expect((await client.solve(CHOICES)).blocked).toEqual([])
    expect(workers).toHaveLength(1)
  })

  it('leaves the map in hand: the next solve starts a new worker, and fetches nothing', async () => {
    const fetchMap = vi.fn(async () => MAP)
    const { client, workers } = setUp({ fetchMap })
    await client.prepare(SAVED)
    const run = client.solve(CHOICES)
    client.cancel()
    await kindOf(run)
    expect((await client.solve({ ...CHOICES, keepOrder: false })).keepOrder).toBe(false)
    expect(workers).toHaveLength(2)
    expect(fetchMap).toHaveBeenCalledTimes(1)
    expect(workers[1].requests.map((r) => r.type)).toEqual(['prepare', 'solve'])
    expect(workers[1].requests[0]).toMatchObject({ osm: MAP })
  })

  it('tells the screen how that goes, from the map onwards', async () => {
    const heard: ProgressInfo[] = []
    const { client } = setUp({}, (p) => heard.push(p))
    await client.prepare(SAVED)
    const run = client.solve(CHOICES)
    client.cancel()
    await kindOf(run)
    heard.length = 0
    await client.solve(CHOICES)
    expect(heard[0].step).toBe('Reading the map')
    expect(heard.at(-1)?.step).toBe('Done')
  })

  it('cannot solve after a prepare cancelled before the map came', async () => {
    const { client } = setUp({ fetchMap: noMap })
    const run = client.prepare(SAVED)
    client.cancel()
    await kindOf(run)
    const error = await client.solve(CHOICES).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'not-ready', message: NOT_READY_MESSAGE })
  })
})

describe('steps that overlap', () => {
  it('lets a new prepare take over from one running, whose promise rejects as cancelled', async () => {
    const { client, workers } = setUp()
    const first = client.prepare(SAVED)
    const second = client.prepare(SAVED)
    expect(await kindOf(first)).toBe('cancelled')
    expect((await second).streets.length).toBeGreaterThan(0)
    expect(workers).toHaveLength(2)
    expect(workers[0].terminated).toBe(true)
  })

  it('lets a new solve take over from one running, from the map in hand', async () => {
    const fetchMap = vi.fn(async () => MAP)
    const { client, workers } = setUp({ fetchMap })
    await client.prepare(SAVED)
    const first = client.solve(CHOICES)
    const second = client.solve({ ...CHOICES, keepOrder: false })
    expect(await kindOf(first)).toBe('cancelled')
    expect((await second).keepOrder).toBe(false)
    expect(workers[0].terminated).toBe(true)
    expect(fetchMap).toHaveBeenCalledTimes(1)
  })

  it('refuses a solve while the prepare it needs is running, and leaves the prepare alone', async () => {
    const { client, workers } = setUp()
    const preparing = client.prepare(SAVED)
    expect(await kindOf(client.solve(CHOICES))).toBe('not-ready')
    expect((await preparing).streets.length).toBeGreaterThan(0)
    expect(workers[0].terminated).toBe(false)
  })

  it('refuses a solve with no route prepared', async () => {
    const { client, workers } = setUp()
    expect(await kindOf(client.solve(CHOICES))).toBe('not-ready')
    expect(workers).toHaveLength(0)
  })

  it('ignores what an older step still had on its way when the newer one took over', async () => {
    const heard: ProgressInfo[] = []
    const { client, workers } = setUp({}, (p) => heard.push(p))
    await client.prepare(SAVED)
    const worker = workers[0]
    const sent = { type: 'progress' as const, id: 1, progress: { step: 'From the first step', done: 0.5 } }
    const stale = worker.onmessage
    const second = client.solve(CHOICES)
    stale?.({ data: sent })
    await second
    expect(heard.some((p) => p.step === 'From the first step')).toBe(false)
  })

  it('drops the stale result too, so a late answer can never be taken for the new step', async () => {
    const { client, workers } = setUp()
    await client.prepare(SAVED)
    const worker = workers[0]
    const handler = worker.onmessage
    const running = client.solve(CHOICES)
    handler?.({ data: { type: 'prepared', id: 1, view: {} as never } })
    expect((await running).blocked).toEqual([])
  })
})

describe('the worker going wrong', () => {
  it('rejects the step running, and can start again', async () => {
    const { client, workers } = setUp({ fetchMap: noMap })
    const run = client.prepare(SAVED)
    workers[0].onerror?.()
    expect(await kindOf(run)).toBe('crashed')
    expect(workers[0].terminated).toBe(true)
  })

  it('takes a message that cannot be read the same way', async () => {
    const { client, workers } = setUp({ fetchMap: noMap })
    const run = client.prepare(SAVED)
    workers[0].onmessageerror?.()
    expect(await kindOf(run)).toBe('crashed')
    expect(workers[0].terminated).toBe(true)
    expect(workers[0].onmessageerror).toBeNull()
  })

  it('says so if the worker cannot be started at all', async () => {
    const client = createOptimiser({
      makeWorker: () => {
        throw new Error('no workers here')
      },
    })
    expect(await kindOf(client.prepare(SAVED))).toBe('crashed')
  })
})

describe('a worker that goes silent', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** A worker a test speaks for: it does nothing unless told. */
  function silentWorkers() {
    const started: (WorkerLike & { requests: WorkerRequest[]; terminated: boolean })[] = []
    const client = createOptimiser({
      makeWorker: () => {
        const worker = {
          requests: [] as WorkerRequest[],
          terminated: false,
          onmessage: null,
          onerror: null,
          onmessageerror: null,
          postMessage(request: WorkerRequest) {
            this.requests.push(request)
          },
          terminate() {
            this.terminated = true
          },
        }
        started.push(worker)
        return worker
      },
    })
    return { client, started }
  }

  const progress = (id: number): WorkerReply => ({ type: 'progress', id, progress: { step: 'Still going', done: 0.5 } })

  it('is ended after the limit of silence, and the step says it crashed in the usual words', async () => {
    const { client, started } = silentWorkers()
    const run = client.prepare(SAVED)
    const failure = run.catch((e: unknown) => e)
    vi.advanceTimersByTime(SILENCE_LIMIT_MS - 1)
    expect(started[0].terminated).toBe(false)
    vi.advanceTimersByTime(1)
    expect(started[0].terminated).toBe(true)
    expect(await failure).toMatchObject({ kind: 'crashed', message: CRASHED_MESSAGE })
  })

  it('leaves alone a worker that goes on speaking, however long the step takes', async () => {
    const { client, started } = silentWorkers()
    const run = client.prepare(SAVED)
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(SILENCE_LIMIT_MS - SILENCE_CHECK_MS)
      started[0].onmessage?.({ data: progress(1) })
    }
    expect(started[0].terminated).toBe(false)
    started[0].onmessage?.({ data: { type: 'prepared', id: 1, view: {} as never } })
    await expect(run).resolves.toEqual({})
  })

  it('counts any reply as a word from it, even one the step has no use for', () => {
    const { client, started } = silentWorkers()
    void client.prepare(SAVED).catch(() => {})
    vi.advanceTimersByTime(SILENCE_LIMIT_MS - SILENCE_CHECK_MS)
    started[0].onmessage?.({ data: progress(0) })
    vi.advanceTimersByTime(SILENCE_LIMIT_MS - SILENCE_CHECK_MS)
    expect(started[0].terminated).toBe(false)
  })

  it('does not count time a sleeping phone held everything still, as the checks stop too', () => {
    const { client, started } = silentWorkers()
    void client.prepare(SAVED).catch(() => {})
    vi.advanceTimersByTime(SILENCE_LIMIT_MS - 2 * SILENCE_CHECK_MS)
    // The phone wakes ten minutes later, and the page gets just the one check that fell due.
    vi.setSystemTime(Date.now() + 600_000)
    vi.advanceTimersByTime(SILENCE_CHECK_MS)
    expect(started[0].terminated).toBe(false)
  })

  it('does not trouble a worker with no step running, however long the driver takes on the choices', async () => {
    const { client, started } = silentWorkers()
    const run = client.prepare(SAVED)
    started[0].onmessage?.({ data: { type: 'prepared', id: 1, view: {} as never } })
    await run
    vi.advanceTimersByTime(SILENCE_LIMIT_MS * 3)
    expect(started[0].terminated).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives each step its own count', async () => {
    const { client, started } = silentWorkers()
    const preparing = client.prepare(SAVED)
    vi.advanceTimersByTime(SILENCE_LIMIT_MS - SILENCE_CHECK_MS)
    started[0].onmessage?.({ data: { type: 'prepared', id: 1, view: {} as never } })
    await preparing
    const solving = client.solve(CHOICES)
    const kind = kindOf(solving)
    vi.advanceTimersByTime(SILENCE_LIMIT_MS - SILENCE_CHECK_MS)
    expect(started[0].terminated).toBe(false)
    vi.advanceTimersByTime(SILENCE_CHECK_MS)
    expect(await kind).toBe('crashed')
  })

  it('stops counting when the step is cancelled, the screen closes or a failure comes back', async () => {
    const { client, started } = silentWorkers()
    const cancelling = kindOf(client.prepare(SAVED))
    client.cancel()
    expect(await cancelling).toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)

    const closing = kindOf(client.prepare(SAVED))
    client.close()
    expect(await closing).toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)

    const failing = kindOf(client.prepare(SAVED))
    started[2].onmessage?.({ data: { type: 'failed', id: 3, failure: { kind: 'busy', message: 'Busy.' } } })
    expect(await failing).toBe('busy')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('leaves the map in hand, so a run can start again from it with a new worker', async () => {
    const { client, started } = silentWorkers()
    const preparing = client.prepare(SAVED)
    started[0].onmessage?.({ data: { type: 'map', id: 1, osm: MAP } })
    started[0].onmessage?.({ data: { type: 'prepared', id: 1, view: {} as never } })
    await preparing
    const failed = kindOf(client.solve(CHOICES))
    vi.advanceTimersByTime(SILENCE_LIMIT_MS)
    expect(await failed).toBe('crashed')
    void client.solve(CHOICES).catch(() => {})
    expect(started).toHaveLength(2)
    expect(started[1].requests[0]).toMatchObject({ type: 'prepare', osm: MAP })
    client.close()
  })

  it('never takes the search for a map for silence, even with every server hanging to the end of the total', async () => {
    const hangs = ((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))) as unknown as typeof fetch
    const { client, workers } = setUp({ fetchMap: (points, options) => fetchMap(points, { ...options, fetchFn: hangs }) })
    const kind = kindOf(client.prepare(SAVED))
    await vi.advanceTimersByTimeAsync(TOTAL_TIMEOUT_MS + 1)
    expect(await kind).toBe('busy')
    expect(workers[0].terminated).toBe(false)
  })
})

describe('closing', () => {
  it('ends the worker and forgets the route', async () => {
    const { client, workers } = setUp()
    await client.prepare(SAVED)
    client.close()
    expect(workers[0].terminated).toBe(true)
    expect(await kindOf(client.solve(CHOICES))).toBe('not-ready')
  })

  it('rejects a step still running', async () => {
    const { client } = setUp({ fetchMap: noMap })
    const run = client.prepare(SAVED)
    client.close()
    expect(await kindOf(run)).toBe('cancelled')
  })
})
