import type { SavedRoute } from '../types'
import { CANCELLED_MESSAGE, CRASHED_MESSAGE, NOT_READY_MESSAGE, type FailureInfo, type OptimiseFailure, type WorkerReply, type WorkerRequest } from './protocol'
import type { OnProgress, OptimiseChoices, OptimiseResult, OsmData, PreparedView } from './types'
import OptimiseWorker from './worker?worker&inline'

/**
 * The screen's way to the worker: `prepare` and `solve` give promises, with `onProgress` hearing how they go. Only one step runs at a time. A new step
 * takes over from one still running, whose promise rejects as cancelled. Everything the worker says about an older step is ignored. `cancel` ends the
 * worker, which is the only way to stop a solve, as it runs from start to end without reading its messages. That loses what the worker had prepared, but
 * not the map: a `solve` after that quietly prepares a new worker from the map in hand, with no need to fetch it again. A worker can also die without
 * a word, so a step that hears nothing from it for `SILENCE_LIMIT_MS` ends as a crash, and the driver isn't left on the working screen.
 */

/**
 * How long a step may run without a word from the worker, in milliseconds, before the worker is taken for dead. One ask for the map can take most of
 * a minute and a slow phone can go quiet for a while, so this sits well past both: a false alarm would throw away a run that was going to finish.
 */
export const SILENCE_LIMIT_MS = 120_000
/** How often the silence is counted, in milliseconds. */
export const SILENCE_CHECK_MS = 5000

/** Why a step of the run didn't finish: see `OptimiseFailure`. The message is ready to show, but for `cancelled`, which the screen has asked for. */
export class OptimiseError extends Error {
  kind: OptimiseFailure
  constructor({ kind, message }: FailureInfo) {
    super(message)
    this.name = 'OptimiseError'
    this.kind = kind
  }
}

/** The parts of a Worker the client uses, so a test can stand in for one. */
export interface WorkerLike {
  postMessage(request: WorkerRequest): void
  terminate(): void
  onmessage: ((event: { data: WorkerReply }) => void) | null
  onerror: (() => void) | null
  onmessageerror: (() => void) | null
}

/**
 * The worker itself, which Vite builds into the app's own script. As a file of its own it would be fetched by name when a run starts, and a page still
 * open after an update would ask for a file that has gone. This way nothing is fetched after start-up, and an old page runs its own old engine.
 */
const startWorker = (): WorkerLike => new OptimiseWorker() as unknown as WorkerLike

export interface OptimiserOptions {
  onProgress?: OnProgress
  /** Stands in for the worker in a test. */
  makeWorker?: () => WorkerLike
}

export interface Optimiser {
  /** Gets the map and reads the route against it, for the choices screen. Rejects with an OptimiseError. */
  prepare(saved: SavedRoute): Promise<PreparedView>
  /** Finds a new drive for these choices. It can be called again with other choices. Rejects with an OptimiseError. */
  solve(choices: OptimiseChoices): Promise<OptimiseResult>
  /** Stops whatever step is running, whose promise rejects as cancelled. With nothing running, it does nothing. */
  cancel(): void
  /** Ends the worker and forgets the route and the map, for when the screen closes. */
  close(): void
}

interface Running {
  /** The first request of this step and its last: a `solve` after a Cancel is a `prepare` and then the solve. */
  firstId: number
  id: number
  kind: WorkerRequest['type']
  resolve: (value: PreparedView | OptimiseResult) => void
  reject: (error: OptimiseError) => void
}

const cancelled = () => new OptimiseError({ kind: 'cancelled', message: CANCELLED_MESSAGE })
const notReady = () => new OptimiseError({ kind: 'not-ready', message: NOT_READY_MESSAGE })
const crashed = () => new OptimiseError({ kind: 'crashed', message: CRASHED_MESSAGE })

export function createOptimiser({ onProgress, makeWorker = startWorker }: OptimiserOptions = {}): Optimiser {
  let worker: WorkerLike | null = null
  /** Whether the worker has what `prepare` made, as a step that finished left it. */
  let primed = false
  let running: Running | null = null
  let lastId = 0
  /** What a new worker would need to be primed: set as `prepare` is asked, and the map once it has arrived. */
  let saved: SavedRoute | null = null
  let map: OsmData | null = null
  /** How long the worker has said nothing while a step runs, as far as the count has got. */
  let silentMs = 0
  let silenceCount: ReturnType<typeof setInterval> | undefined

  /** Ends the worker, and with it anything it was doing or had. */
  function dropWorker() {
    if (!worker) return
    worker.onmessage = null
    worker.onerror = null
    worker.onmessageerror = null
    worker.terminate()
    worker = null
    primed = false
  }

  /** Takes the step running off the books, and stops counting the silence, which matters only while a step waits. */
  function endStep(): Running | null {
    const step = running
    running = null
    clearInterval(silenceCount)
    return step
  }

  /** Ends the step running, if any, with this error. */
  function settle(error: OptimiseError) {
    endStep()?.reject(error)
  }

  /** The worker has failed, however that was heard, so the step running can't finish. */
  function loseWorker() {
    dropWorker()
    settle(crashed())
  }

  /**
   * Starts counting the silence for a new step. It adds up its own checks rather than reading the clock, because a locked phone or a page in the
   * background stops the worker and these checks together: that time isn't silence, and a page waking up must not blame a worker that has had no chance to speak.
   */
  function countSilence() {
    silentMs = 0
    silenceCount = setInterval(() => {
      silentMs += SILENCE_CHECK_MS
      if (silentMs >= SILENCE_LIMIT_MS) loseWorker()
    }, SILENCE_CHECK_MS)
  }

  function onReply(reply: WorkerReply) {
    // Anything at all from the worker shows it is alive, even a reply this step has no use for.
    silentMs = 0
    const step = running
    if (!step || reply.id < step.firstId || reply.id > step.id) return
    if (reply.type === 'progress') {
      onProgress?.(reply.progress)
      return
    }
    if (reply.type === 'map') {
      map = reply.osm
      return
    }
    if (reply.type === 'failed') {
      settle(new OptimiseError(reply.failure))
      return
    }
    // The `prepare` that goes before a solve is not what the step is waiting for.
    if (reply.id !== step.id) {
      primed = true
      return
    }
    endStep()
    if (reply.type === 'prepared') primed = true
    step.resolve(reply.type === 'prepared' ? reply.view : reply.result)
  }

  /** The worker, started if need be. Null if it can't be, which `onerror` is the other way of hearing. */
  function liveWorker(): WorkerLike | null {
    if (worker) return worker
    try {
      const started = makeWorker()
      started.onmessage = (event) => onReply(event.data)
      started.onerror = loseWorker
      started.onmessageerror = loseWorker
      worker = started
      return started
    } catch {
      return null
    }
  }

  function run<T extends PreparedView | OptimiseResult>(kind: WorkerRequest['type'], requests: ((id: number) => WorkerRequest)[]): Promise<T> {
    const live = liveWorker()
    if (!live) return Promise.reject(crashed())
    const firstId = lastId + 1
    return new Promise<T>((resolve, reject) => {
      running = { firstId, id: lastId + requests.length, kind, resolve: resolve as Running['resolve'], reject }
      countSilence()
      for (const request of requests) live.postMessage(request(++lastId))
    })
  }

  return {
    prepare(route) {
      // A step still running has to stop, and a solve can only be stopped by ending the worker. A new route needs a new map, so nothing is kept.
      if (running) {
        dropWorker()
        settle(cancelled())
      }
      primed = false
      saved = route
      map = null
      return run<PreparedView>('prepare', [(id) => ({ type: 'prepare', id, saved: route })])
    },

    solve(choices) {
      // There's nothing to solve until the step that gets it has finished, and asking must not disturb that step.
      if (running?.kind === 'prepare') return Promise.reject(notReady())
      if (running) {
        dropWorker()
        settle(cancelled())
      }
      const solveNow = (id: number): WorkerRequest => ({ type: 'solve', id, choices })
      if (worker && primed) return run<OptimiseResult>('solve', [solveNow])
      const route = saved
      const osm = map
      if (!route || !osm) return Promise.reject(notReady())
      return run<OptimiseResult>('solve', [(id) => ({ type: 'prepare', id, saved: route, osm }), solveNow])
    },

    cancel() {
      if (!running) return
      const wasPreparing = running.kind === 'prepare'
      dropWorker()
      // A prepare cancelled before the map came has nothing to go back to.
      if (wasPreparing && !map) saved = null
      settle(cancelled())
    },

    close() {
      dropWorker()
      saved = null
      map = null
      settle(cancelled())
    },
  }
}
