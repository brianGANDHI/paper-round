import { isGoneBy, zoneExit } from './alerts'
import { missedAmong } from './bundleFlow'
import { byPosition, type Occurrence } from './geo'
import type { Progress } from './progress'
import type { Pt, StopType } from './types'

/*
 * What the round's alerts do over a turn round that the tracker is not sure of yet (see `Progress.turned`), kept apart from the screen so
 * it can be tested. A car that backs up on the way out of a street driven out and back heads against the way out just as one that has
 * turned round does, so for a while the tracker puts it on the way back, far on along the route, and then may take that back. Judged by
 * that place, every alert that was up is gone by: it would be kept as done (a bundle among them missed, and told so while the car is at
 * it), and after the undo it would never come up again, so a no-throw house just ahead would be driven past in silence.
 *
 * So while the turn is not sure, the alerts that were up as the driver was put on the way back are held: they stay up, judged where the
 * driver was put from, but the banner does not show them as passed (they are for the way out, and the driver is put on the way back). A
 * stop along the route that is gone by in that time (a pass of the way back that came up on the way) is put by: neither done nor to come
 * up again. Once the turn is sure, the held alerts are gone by and done, and those put by are done too, as they would have been at once,
 * only later (about 100 m along the way back). Once it is undone, the held alerts are judged where the driver is again, still to come, with
 * no new beep, and those put by may come up again. A stop met by where the phone is (see `byPosition`) has nothing to do with where along
 * the route the driver is put, and is judged as ever. A turn that can't become sure is taken to stand at the end of the route (see
 * HOLD_END_M), and on a restart (see `endTurnHold`).
 */

/**
 * Near the end of the route a turn round can't become sure, as there is not enough of the route left after it: so once the driver has been
 * put on the way back this close to the end, in metres, the turn is taken to stand, and the round can be finished there. It is the very end
 * (the tracker puts a phone past the end of the route at its end), not the END_QUIET_M of Round.tsx: a car that backs up on the way into a
 * court at the end of the route is put on the way back 30 to 40 m from the end, and must not have the alerts that were up gone by.
 */
export const HOLD_END_M = 20

/** The alerts held over a turn round that is not sure yet (see `Progress.turned`). */
export interface TurnHold {
  /** The turn round it is for: how far along the route the driver was put on the way back from, and to, in metres. */
  from: number
  to: number
  /** The keys of the alerts that were up as the driver was put on the way back, while they still are. */
  held: ReadonlySet<string>
  /** The stops along the route gone by while the turn is not sure: done once it is, to come again if it is undone. */
  deferred: readonly Occurrence[]
  /** The driver has got to the end of the route on the way back (see HOLD_END_M): the turn stands, and nothing is held or put by any more. */
  ended: boolean
}

/** What a fix does to the hold: the hold now, and the stops put by that are now done (`settle`) or to come again (`release`). */
export interface TurnStep {
  hold: TurnHold | null
  /** Stops put by over a turn round that stood: done now, and a bundle among them missed (see `doneNow`). */
  settle: Occurrence[]
  /** Stops put by over a turn round that was undone: still to come, so they may alert again (forget them as seen, said and held). */
  release: Occurrence[]
}

/** No keys held: one set for every time there is no hold, so the screen can keep it as state without a change for nothing. */
export const NOTHING_HELD: ReadonlySet<string> = new Set()

/**
 * The hold after a fix that put the driver at `p`, with `queue` the alerts up before it. A turn round that is not sure yet starts a hold
 * of the alerts that are up. The hold ends when the turn does: when it is sure, when another further on takes its place, or when the
 * tracker starts afresh after losing the route, the turn stood (the driver is at or past where it put them), and the stops put by are
 * done; when it is undone (the driver is back before where it put them), they are to come again. Near the end of the route (see
 * HOLD_END_M) it stands as well. A held alert that is no longer up (it was dropped, or the screen cleared the alerts) is let go of, so
 * that if it comes up again it is judged as any other.
 */
export function stepTurnHold(hold: TurnHold | null, p: Pick<Progress, 'turned' | 'along'>, queue: readonly Pick<Occurrence, 'key'>[], routeEnd: number): TurnStep {
  const turned = p.turned ?? null
  let settle: Occurrence[] = []
  let release: Occurrence[] = []
  if (hold && (!turned || turned.from !== hold.from || turned.to !== hold.to)) {
    if (p.along >= hold.to) settle = [...hold.deferred]
    else release = [...hold.deferred]
    hold = null
  }
  if (turned && !hold) hold = { from: turned.from, to: turned.to, held: new Set(queue.map((o) => o.key)), deferred: [], ended: false }
  if (hold && !hold.ended) {
    if (p.along >= hold.to && p.along >= routeEnd - HOLD_END_M) {
      settle = [...settle, ...hold.deferred]
      hold = { ...hold, held: NOTHING_HELD, deferred: [], ended: true }
    } else {
      const up = new Set(queue.map((o) => o.key))
      if ([...hold.held].some((key) => !up.has(key))) hold = { ...hold, held: new Set([...hold.held].filter((key) => up.has(key))) }
    }
  }
  return { hold, settle, release }
}

/** Where along the route an alert that is up is judged, for leaving its zone (see `zoneExit`): where the driver was put from, while it is held; otherwise `along`, where the driver is. */
export const judgedAt = (o: Pick<Occurrence, 'key'>, along: number, hold: TurnHold | null): number => (hold?.held.has(o.key) ? hold.from : along)

/**
 * Of the stops just gone by (`goneBy`, those the screen would keep as done), the ones that are done now, and the hold with the others put
 * by: while a turn round is not sure, a stop along the route was gone by only by where along the route the turn put the driver, which it may
 * take back. A stop met by where the phone is (see `byPosition`) is done now whatever the turn, and so is everything with no hold, or one
 * that has ended. Nothing given is changed.
 */
export function holdGoneBy(hold: TurnHold | null, goneBy: readonly Occurrence[], radius: Record<StopType, number>): { hold: TurnHold | null; now: Occurrence[] } {
  const later = hold && !hold.ended ? goneBy.filter((o) => !byPosition(o, radius)) : []
  if (!hold || !later.length) return { hold, now: [...goneBy] }
  return { hold: { ...hold, deferred: [...hold.deferred, ...later] }, now: goneBy.filter((o) => byPosition(o, radius)) }
}

/**
 * Of the stops a change of the route leaves behind the driver (`behind`: one that starts to alert behind them, or whose alert moved there, see
 * `keepAlertsAhead`), the ones done now, and the hold with the others put by. While a turn round is not sure, a stop along the route is behind
 * the driver only by where the turn put them, which it may take back, unless it is also more than `slack` (see `slackFor`) behind where the
 * turn put them from: so it is put by, as a stop gone by then is (see `holdGoneBy`), done once the turn is sure and still to come if it is
 * undone. One met by where the phone is is done now, and so is everything with no hold, or one that has ended. Nothing given is changed.
 */
export function holdLeftBehind(hold: TurnHold | null, behind: readonly Occurrence[], slack: number, radius: Record<StopType, number>): { hold: TurnHold | null; now: Occurrence[] } {
  const later = hold && !hold.ended ? behind.filter((o) => !byPosition(o, radius) && o.at >= hold.from - slack) : []
  if (!hold || !later.length) return { hold, now: [...behind] }
  return { hold: { ...hold, deferred: [...hold.deferred, ...later] }, now: behind.filter((o) => !later.includes(o)) }
}

/**
 * The stops a fix makes done, to keep in one go, and the bundles among them missed: those just gone by (`now`, missed only on the route:
 * see `missedAmong`), and those put by over a turn round that stood (`settle`, see `TurnStep`), less any done already (a drop from the
 * alert of another pass of the stop settles them too). A stop put by was gone by on the route, so a bundle among them is missed wherever
 * the driver is now.
 */
export function doneNow(now: readonly Occurrence[], settle: readonly Occurrence[], handled: ReadonlySet<string>, onRoute: boolean): { done: Occurrence[]; missed: string[] } {
  const keys = new Set(now.map((o) => o.key))
  const late: Occurrence[] = []
  for (const o of settle) {
    if (handled.has(o.key) || keys.has(o.key)) continue
    keys.add(o.key)
    late.push(o)
  }
  return { done: [...now, ...late], missed: [...missedAmong(now, onRoute), ...missedAmong(late, true)] }
}

/**
 * What a restart (a start or a skip to a spot, carrying on, a reset) does with a turn round that is not sure yet, before the spot decides
 * which stops are done: the turn is taken as the tracker has it. With the driver put at or past where it put them, the stops put by, and
 * the alerts held that are gone by from `along`, are done, and a bundle among them is missed, as they would have been had the turn been
 * sure; the spot then keeps them so if it is past them, as it keeps every stop done or missed before it. Before where it put them, nothing
 * is, and the spot decides them as it does every stop. Empty with no hold, or one that has ended (which holds nothing).
 */
export function endTurnHold(hold: TurnHold | null, along: number, queue: readonly Occurrence[], radius: Record<StopType, number>): Occurrence[] {
  if (!hold || along < hold.to) return []
  return [...hold.deferred, ...queue.filter((o) => hold.held.has(o.key) && zoneExit(o, along, radius) === 'passed')]
}

/** The keys held over a turn round (none, `NOTHING_HELD`, with no hold): the same set for as long as they are the same, so the screen can keep them as state. */
export const heldKeys = (hold: TurnHold | null): ReadonlySet<string> => hold?.held ?? NOTHING_HELD

/**
 * The alerts the banner is to choose from (see `pickCurrent`, `bannerBlock` and `bannerWaiting`, which take `driven`, `along` and `pos` as
 * this does), of those up (`queue`): not those held over a turn round that is not sure yet (`held`, see `heldKeys`) that the driver, put on
 * the way back, has gone by (see `isGoneBy`). They are for the way out, and with nothing of the way back up the banner would fall back on
 * the least far behind of them and show it as passed for as long as the turn is not sure, up to 100 m of the way back. (They are never
 * counted as waiting, being gone by.) One the driver is still at, as a house at the turn-round of a court is, shows as ever, and once the
 * turn is undone they all do. The queue itself when nothing is held.
 */
export function shownQueue<T extends Occurrence>(
  queue: T[],
  held: ReadonlySet<string>,
  driven: number,
  along: number,
  pos: Pt | null,
  radius: Record<StopType, number>,
): T[] {
  return held.size ? queue.filter((o) => !held.has(o.key) || !isGoneBy(o, driven, along, pos, radius)) : queue
}
