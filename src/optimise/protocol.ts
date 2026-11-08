import type { SavedRoute } from '../types'
import type { OptimiseChoices, OptimiseResult, OsmData, PreparedView, ProgressInfo } from './types'

/** What the screen's side and the worker say to each other. It lives apart from both so that the client can have it without bringing the engine along. */

export type WorkerRequest =
  /** With `osm`, the map is the one already in hand, so nothing is fetched. */
  | { type: 'prepare'; id: number; saved: SavedRoute; osm?: OsmData }
  | { type: 'solve'; id: number; choices: OptimiseChoices }

/** Why a step failed, for the screen: the three a map fetch can give, a route the engine can't work on, and a step asked for out of turn or that broke. */
export type OptimiseFailure = 'offline' | 'busy' | 'nothing' | 'cancelled' | 'route' | 'not-ready' | 'crashed'

export interface FailureInfo {
  kind: OptimiseFailure
  /** What to tell the driver. */
  message: string
}

export type WorkerReply =
  | { type: 'progress'; id: number; progress: ProgressInfo }
  /** The map, for the client to hold on to: a Cancel ends the worker, and a run after that shouldn't have to fetch it again. */
  | { type: 'map'; id: number; osm: OsmData }
  | { type: 'prepared'; id: number; view: PreparedView }
  | { type: 'solved'; id: number; result: OptimiseResult }
  | { type: 'failed'; id: number; failure: FailureInfo }

/** The plain words for something that broke, which isn't the driver's to fix. */
export const CRASHED_MESSAGE = 'Something went wrong working out the route. Nothing has changed.'
export const NOT_READY_MESSAGE = "The route isn't ready to work on. Start again."
export const CANCELLED_MESSAGE = 'Cancelled.'
