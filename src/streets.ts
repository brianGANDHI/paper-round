import { angleBetween, bearing, cumulativeDistances, haversine } from './geo'
import { getJson, NEAREST, RoadError, type LookupOptions, type RoadFailure } from './roads'
import { cardStreet, spokenStreet, streetKey } from './streetName'
import { pointAt, type Turn } from './turns'
import type { Pt, TurnStreet } from './types'

/**
 * The names of the streets turns lead into. The route is only a line, with no street names in it, so each turn is looked
 * up once, online, in Setup: the server is asked which road is nearest a point just past the turn, running the way the
 * route leaves it. The answer is kept with the route (see `TurnStreet`), so the round itself needs no signal.
 *
 * A turn is held by where it is and the way the road leaves it, not by its number along the route, so the names stay put
 * when the route is edited, and a turn that has moved or changed is simply asked about again.
 */

/** A kept name is for a turn if it was found within this many metres of it... */
export const STREET_MATCH_M = 12
/** ...and for a road leaving within this many degrees of the way this turn leaves. */
export const STREET_MATCH_DEG = 35
/** A road further than this from the point asked about is not the one the turn leads into, in metres. */
export const STREET_SNAP_M = 25
/** The point asked about is this far past the end of the turn along the route, in metres: clear of the cross street, on the road the turn leads into. */
export const STREET_SAMPLE_M = 15
/** With less road than this between a turn and the next one (less the margin kept clear), there is nowhere to ask about, in metres. */
export const STREET_MIN_ROOM_M = 6

/** The point asked about stays this far short of the next turn, in metres, so it is on this road and not that junction. */
const CLEAR_M = 3
/** A point asked about must be this far from the end of the turn, as the crow flies, for the way between them to mean anything, in metres. */
const MIN_RUN_M = 1
/** The roads asked for are the nearest few, as a road is made of segments and its own segments come first. */
const NEAREST_COUNT = 4
/** The roads asked for run within this many degrees of the way the turn leaves. */
const BEARING_RANGE_DEG = 35
/** A road with a name may be this much further than the nearest road of all and still be the one, in metres: the nearest may be a driveway with no name. */
const NAMED_WINDOW_M = 10
/** This many lookups in a row failing is the end of a run: the service is down, or there is no connection. */
const MAX_FAILURES_IN_A_ROW = 3
/** A name found for the same turn as one kept replaces it if the two are within this many metres, and leave the same way (within STREET_MATCH_DEG). */
const SAME_SPOT_M = 1

export { cardStreet, spokenStreet }

/** A question to ask the server about one turn. */
export interface StreetQuery {
  /** The turn: its middle (the key the answer is kept under), not the point asked about. */
  lat: number
  lng: number
  /** The way the road leaves the turn, in whole degrees clockwise from north, 0 to 359. */
  out: number
  /** The place to ask about: on the route, past the turn along the road it leads into. */
  point: Pt
}

/** Whether two things at a place, each leaving a way, would get the same answer: close enough, and leaving the same way. */
const sameTurn = (a: Pt & { out: number }, b: Pt & { out: number }): boolean =>
  angleBetween(a.out, b.out) <= STREET_MATCH_DEG && haversine(a, b) <= STREET_MATCH_M

/**
 * What to ask about each turn, in the order of the turns: null where there is no room to ask, between this turn and the
 * next (or the end of the route). The place is the turn's middle. The point asked about is on the line that was drawn,
 * `STREET_SAMPLE_M` past the end of the turn, or nearer than that if the next turn is nearer, so it is on the road the turn
 * leads into whether it is a corner or a roundabout. The way out is the way from the end of the turn to that point,
 * rather than the heading of the first few metres, which a wobbly recorded line can bend out of the road's way.
 */
export function streetQueries(points: Pt[], turns: readonly Turn[]): (StreetQuery | null)[] {
  if (!turns.length) return []
  if (points.length < 2) return turns.map(() => null)
  const cum = cumulativeDistances(points)
  const length = cum[cum.length - 1]
  return turns.map((turn, i) => {
    const room = (turns[i + 1] ? turns[i + 1].from : length) - CLEAR_M - turn.to
    if (!(room >= STREET_MIN_ROOM_M)) return null
    const end = pointAt(points, cum, turn.to)
    const point = pointAt(points, cum, turn.to + Math.min(STREET_SAMPLE_M, room))
    if (haversine(end, point) < MIN_RUN_M) return null
    const apex = pointAt(points, cum, turn.at)
    return { lat: apex.lat, lng: apex.lng, out: Math.round(bearing(end, point)) % 360, point }
  })
}

/** The name kept for a turn at `apex` leaving by `out` degrees: the nearest kept within STREET_MATCH_M that leaves within STREET_MATCH_DEG of that way. The first kept wins a tie. */
export function streetFor(apex: Pt, out: number, streets: readonly TurnStreet[]): TurnStreet | undefined {
  if (!Number.isFinite(out)) return undefined
  let best: TurnStreet | undefined
  let nearest = Infinity
  for (const street of streets) {
    if (angleBetween(out, street.out) > STREET_MATCH_DEG) continue
    const away = haversine(apex, street)
    if (away <= STREET_MATCH_M && away < nearest) {
      best = street
      nearest = away
    }
  }
  return best
}

/** A turn and the street it leads into: null when that is not known, the road has no name, or it is the street the turn before led into (the road being driven goes on). */
export type NamedTurn = Turn & { street: string | null }

/**
 * The turns with the street each leads into, for the card and the voice, from the names kept. A street is left out
 * where it is the same one (whatever its capitals or spacing) as the turn before led into, since the driver is
 * already on it: a bend in a road, or a U-turn, says only which way to turn. Where the turn before is not known, the
 * road being driven is not, and the name is given.
 */
export function nameTurns(points: Pt[], turns: readonly Turn[], streets: readonly TurnStreet[]): NamedTurn[] {
  const queries = streetQueries(points, turns)
  let before = ''
  return turns.map((turn, i) => {
    const q = queries[i]
    const found = q ? streetFor(q, q.out, streets) : undefined
    const name = found ? cardStreet(found.name) : ''
    const key = streetKey(name)
    const street = name && key !== before ? name : null
    before = key
    return { ...turn, street }
  })
}

/**
 * What still has to be asked: the turns with no answer kept, with no question for a turn that has no room for one, and
 * only one question for turns that would get the same answer (the same corner turned the same way twice, as in a loop
 * driven twice). A kept answer saying the road has no name is an answer.
 */
export function missingQueries(points: Pt[], turns: readonly Turn[], streets: readonly TurnStreet[]): StreetQuery[] {
  const asked: StreetQuery[] = []
  for (const q of streetQueries(points, turns)) {
    if (!q || streetFor(q, q.out, streets) || asked.some((a) => sameTurn(a, q))) continue
    asked.push(q)
  }
  return asked
}

/**
 * The name of the street from the roads the server found near the point, nearest first as it lists them. The nearest
 * road is not always the street: it can be a driveway with no name, or a tunnel or a bridge over or under it. So the
 * roads within the nearest plus 10 m (and never beyond STREET_SNAP_M) are grouped by name, capitals and spacing ignored, and
 * the name with most segments wins; a tie goes to the nearest. A road with no name is no street, and a street is shown as
 * its nearest segment spells it. Empty when there is none. A tunnel right under the street, as many segments and as
 * near, still wins the tie: the server has no way to leave tunnels out.
 */
export function pickStreetName(waypoints: readonly { name?: string; distance: number }[]): string {
  const found = waypoints.filter((w) => typeof w?.distance === 'number' && w.distance >= 0)
  const limit = Math.min(STREET_SNAP_M, Math.min(...found.map((w) => w.distance)) + NAMED_WINDOW_M)
  const groups = new Map<string, { name: string; count: number; nearest: number }>()
  for (const w of found) {
    const name = cardStreet(w.name ?? '')
    if (!name || w.distance > limit) continue
    const key = streetKey(name)
    const group = groups.get(key)
    if (!group) groups.set(key, { name, count: 1, nearest: w.distance })
    else {
      group.count++
      if (w.distance < group.nearest) Object.assign(group, { name, nearest: w.distance })
    }
  }
  let best: { name: string; count: number; nearest: number } | undefined
  for (const group of groups.values()) {
    if (!best || group.count > best.count || (group.count === best.count && group.nearest < best.nearest)) best = group
  }
  return best?.name ?? ''
}

/**
 * The request for the roads nearest a point that run the way a turn leaves. Longitude first. The server is told no hints
 * are wanted (it says they are off, but sends them), which halves the answer, and to look no further than STREET_SNAP_M, so
 * a point with no road near it is an answer of "nothing here" and not a road a long way off. The bearing is always 0 to 359.
 */
export function nearestUrl(q: StreetQuery): string {
  const out = ((Math.round(q.out) % 360) + 360) % 360
  const at = `${q.point.lng.toFixed(6)},${q.point.lat.toFixed(6)}`
  return `${NEAREST ?? ''}/${at}?number=${NEAREST_COUNT}&bearings=${out},${BEARING_RANGE_DEG}&radiuses=${STREET_SNAP_M}&generate_hints=false`
}

/**
 * The name of the street a turn leads into, from one request. Empty when it was asked and there is no named road
 * there, which is an answer. A RoadError when there was no answer: offline (no connection, or the request never got
 * through), timeout, service (an error, or an answer that makes no sense, in which case `status` says what the server
 * said) or cancelled. Never faster than the service allows, and the gap is shared with the road lookups.
 */
export async function fetchStreetName(q: StreetQuery, opts: LookupOptions = {}): Promise<string> {
  if (!NEAREST) throw new RoadError('service', 'this server cannot say which street is nearest')
  const { ok, status, json } = await getJson(nearestUrl(q), opts)
  const body = (json && typeof json === 'object' ? json : {}) as { code?: unknown; waypoints?: unknown }
  // No road within reach is an answer, whether the server says it with a 400 or not.
  if (body.code === 'NoSegment') return ''
  if (!ok) throw new RoadError('service', `status ${status}`, status)
  if (body.code !== 'Ok' || !Array.isArray(body.waypoints)) throw new RoadError('service', `answered ${String(body.code)}`)
  // Whatever is in the list that is not a road with a distance is ignored by the pick.
  return pickStreetName(body.waypoints)
}

/** How a run of lookups went. */
export interface StreetRun {
  /** How many it got an answer for, those with no name included. */
  found: number
  /** Of those, how many were roads with no name. */
  unnamed: number
  /** How many failed. They are not reported, so they are still missing. */
  failed: number
  /** Why it ended: all asked, cancelled, or the way the lookup that ended it failed. */
  stopped: 'done' | 'cancelled' | RoadFailure
}

export interface StreetHooks {
  signal?: AbortSignal
  /** Called with each answer as it comes, the name empty when the road has none. */
  onFound: (q: StreetQuery, name: string) => void
  /** Called after each one is dealt with, answered or failed: how many have been, of how many there are. */
  onProgress?: (done: number, total: number) => void
}

/** Whether the server is refusing, or struggling: asking it more would only make it worse. */
function refusing(e: unknown): boolean {
  const status = e instanceof RoadError ? (e.status ?? 0) : 0
  return status === 429 || (status >= 500 && status <= 599)
}

/** Calls something the caller gave, without whatever it does wrong stopping the run. */
function safely(call: () => void) {
  try {
    call()
  } catch {
    // The caller's trouble; the lookups go on.
  }
}

/**
 * Look up the street for each question, one at a time and a gap apart, telling the caller about each answer as it comes.
 * It ends after 3 failures in a row, or at once if the server says it is busy or broken (429, or any 5xx), and keeps what
 * it found, so asking for the ones missing later picks up where it left off. It never throws.
 */
export async function lookUpStreets(queries: readonly StreetQuery[], hooks: StreetHooks): Promise<StreetRun> {
  const run: StreetRun = { found: 0, unnamed: 0, failed: 0, stopped: 'done' }
  let inARow = 0
  for (const [i, q] of queries.entries()) {
    if (hooks.signal?.aborted) {
      run.stopped = 'cancelled'
      break
    }
    let name: string
    try {
      name = await fetchStreetName(q, { signal: hooks.signal })
    } catch (e) {
      const kind: RoadFailure = e instanceof RoadError ? e.kind : 'service'
      if (kind === 'cancelled') {
        run.stopped = 'cancelled'
        break
      }
      run.failed++
      inARow++
      safely(() => hooks.onProgress?.(i + 1, queries.length))
      if (refusing(e) || inARow >= MAX_FAILURES_IN_A_ROW) {
        run.stopped = kind
        break
      }
      continue
    }
    inARow = 0
    run.found++
    if (!name) run.unnamed++
    safely(() => hooks.onFound(q, name))
    safely(() => hooks.onProgress?.(i + 1, queries.length))
  }
  return run
}

/**
 * The names kept with the ones just found: a name found for a turn already kept (the same place, to within a metre, and
 * leaving the same way, to within STREET_MATCH_DEG) replaces it where it was, and the rest are added in the order found.
 * The way out is compared as loosely as a lookup compares it, since a lookup cannot tell such names apart: a kept name a
 * degree different would otherwise sit beside the new one and win, being first. The newest of two found for one turn wins.
 */
export function mergeStreets(existing: readonly TurnStreet[], found: readonly TurnStreet[]): TurnStreet[] {
  const merged = [...existing]
  for (const f of found) {
    const same = (s: TurnStreet) => angleBetween(s.out, f.out) <= STREET_MATCH_DEG && haversine(s, f) <= SAME_SPOT_M
    const at = merged.findIndex(same)
    if (at < 0) {
      merged.push(f)
      continue
    }
    merged[at] = f
    // Any other answer for this turn is older than this one, and is gone with it.
    for (let i = merged.length - 1; i > at; i--) if (same(merged[i])) merged.splice(i, 1)
  }
  return merged
}

/** The names kept that some turn still uses, in the order kept: a name for a place that is no longer a turn, or one that no turn would pick over a nearer name, is dropped. */
export function pruneStreets(points: Pt[], turns: readonly Turn[], streets: readonly TurnStreet[]): TurnStreet[] {
  const used = new Set<TurnStreet>()
  for (const q of streetQueries(points, turns)) {
    const street = q ? streetFor(q, q.out, streets) : undefined
    if (street) used.add(street)
  }
  return streets.filter((s) => used.has(s))
}
