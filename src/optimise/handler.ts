import type { SavedRoute } from '../types'
import { fetchMap, OSM_NOTICE, OsmError, type MapOptions } from './osmFetch'
import { prepare, solve } from './optimise'
import { CANCELLED_MESSAGE, CRASHED_MESSAGE, NOT_READY_MESSAGE, type FailureInfo, type WorkerReply, type WorkerRequest } from './protocol'
import type { Budget, OnProgress, OptimiseChoices, OptimiseResult, OsmData, Prepared } from './types'

/**
 * What the worker does, apart from being a worker: a message comes in, and replies go out through `post`. Each request has an id, higher than the last,
 * and every reply carries it. The one thing that can overlap in here is the wait for the map, as everything else runs to its end before the next message
 * is read: so a newer request stops that fetch, and anything an older one still has to say is dropped.
 */

/** What the engine and the fetch throw, as the screen needs it. An `Error` of no kind of its own is the engine saying why, in plain words; anything else is a fault. */
export function failureOf(e: unknown): FailureInfo {
  if (e instanceof OsmError) return { kind: e.kind, message: e.kind === 'cancelled' ? CANCELLED_MESSAGE : OSM_NOTICE[e.kind] }
  if (e instanceof Error && e.name === 'Error' && e.message) return { kind: 'route', message: e.message }
  return { kind: 'crashed', message: CRASHED_MESSAGE }
}

/** The engine and the fetch, which a test can stand in for. */
export interface HandlerParts {
  fetchMap: (points: SavedRoute['route']['points'], options: MapOptions) => Promise<OsmData>
  prepare: (saved: SavedRoute, osm: OsmData, onProgress?: OnProgress) => Prepared
  solve: (prepared: Prepared, choices: OptimiseChoices, budget?: Budget, onProgress?: OnProgress) => OptimiseResult
}

const ENGINE: HandlerParts = { fetchMap, prepare, solve }

/** A handler for the messages of one worker. It keeps what `prepare` made, for `solve` to use as often as it's asked. */
export function makeHandler(post: (reply: WorkerReply) => void, parts: Partial<HandlerParts> = {}): (request: WorkerRequest) => Promise<void> {
  const { fetchMap: getMap, prepare: prepareRoute, solve: solveRoute } = { ...ENGINE, ...parts }
  let prepared: Prepared | null = null
  let newest = 0
  let fetching: AbortController | null = null

  return async (request) => {
    const { id } = request
    // An older request arriving late has nothing to add.
    if (id < newest) return
    newest = id
    fetching?.abort()
    fetching = null
    const current = () => id === newest
    const tell: OnProgress = (progress) => {
      if (current()) post({ type: 'progress', id, progress })
    }
    try {
      if (request.type === 'prepare') {
        prepared = null
        let { osm } = request
        if (!osm) {
          const stop = new AbortController()
          fetching = stop
          osm = await getMap(request.saved.route.points, { signal: stop.signal, onProgress: tell })
          if (!current()) return
          fetching = null
          post({ type: 'map', id, osm })
        }
        prepared = prepareRoute(request.saved, osm, tell)
        post({ type: 'prepared', id, view: prepared.view })
      } else if (prepared) {
        post({ type: 'solved', id, result: solveRoute(prepared, request.choices, {}, tell) })
      } else {
        post({ type: 'failed', id, failure: { kind: 'not-ready', message: NOT_READY_MESSAGE } })
      }
    } catch (e) {
      if (current()) post({ type: 'failed', id, failure: failureOf(e) })
    }
  }
}
