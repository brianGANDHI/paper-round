import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogs } from './confirm'
import { useWakeLock } from './device'
import { Icon } from './Icon'
import { NEAREST, type RoadFailure } from './roads'
import { lookUpStreets, mergeStreets, missingQueries, pruneStreets, streetFor, streetQueries } from './streets'
import { routeTurns } from './turns'
import type { Pt, Route, TurnStreet } from './types'

interface Props {
  route: Route
  /** The street names found so far for this route's turns. */
  streets: readonly TurnStreet[]
  /** Called with the full, updated list as names are found, so that they are kept as they come, and the points of the route they were found for. */
  onStreets: (next: TurnStreet[], forPoints?: Pt[]) => void
}

/** The names found are kept this many at a time, since each save writes the whole library. */
const SAVE_EVERY = 10
/** About how long each lookup takes, in seconds, counting the wait the street server asks for between requests. */
const SECONDS_EACH = 1.4

const STOPPED: Record<Exclude<RoadFailure, 'cancelled' | 'no-road'>, string> = {
  offline: 'Street names need an internet connection.',
  timeout: 'The street service was too slow.',
  service: "The street service isn't working right now.",
}

const minutes = (n: number) => {
  const m = Math.max(1, Math.round((n * SECONDS_EACH) / 60))
  return `about ${m} ${m === 1 ? 'minute' : 'minutes'}`
}

/**
 * Looks up the name of the street each turn leads into, once, so the round can show and say it ("Turn left onto Oak Road").
 * The names are kept with the route, so the round needs no internet. It only happens when asked for, one request at a time.
 */
export function StreetNames({ route, streets, onStreets }: Props) {
  const turns = useMemo(() => routeTurns(route.points), [route.points])
  const queries = useMemo(() => streetQueries(route.points, turns), [route.points, turns])
  const missing = useMemo(() => missingQueries(route.points, turns, streets), [route.points, turns, streets])
  const { confirm, dialog } = useDialogs()
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  /** The names kept so far, as of the latest save, for adding to as more are found. */
  const kept = useRef<readonly TurnStreet[]>(streets)
  useLayoutEffect(() => {
    kept.current = streets
  })
  // The screen is kept awake while the names are being found: the lookups stop when the phone locks.
  useWakeLock(progress !== null)
  // Leaving the screen ends the lookups, and so does a change to the route, which they were asked about; what was found before that is kept.
  useEffect(() => () => abort.current?.abort(), [route.points])

  // How many turns have an answer, and how many of those have a street name.
  const answered = queries.flatMap((q) => (q ? [streetFor(q, q.out, streets)] : [])).filter((s): s is TurnStreet => !!s)
  const named = answered.filter((s) => s.name !== '').length

  if (turns.length === 0) return null

  const start = async () => {
    if (abort.current) return
    const controller = new AbortController()
    abort.current = controller
    setNotice(null)
    setProgress({ done: 0, total: missing.length })
    const asked = route.points
    const batch: TurnStreet[] = []
    const save = () => {
      if (!batch.length) return
      kept.current = mergeStreets(kept.current, batch.splice(0))
      onStreets([...kept.current], asked)
    }
    const run = await lookUpStreets(missing, {
      signal: controller.signal,
      onFound: (q, name) => {
        batch.push({ lat: q.lat, lng: q.lng, out: q.out, name })
        if (batch.length >= SAVE_EVERY) save()
      },
      onProgress: (done, total) => setProgress({ done, total }),
    })
    save()
    // Names that no turn uses any more (the route changed since) are dropped now that the list is complete.
    if (run.stopped === 'done') {
      const tidy = pruneStreets(route.points, turns, kept.current)
      if (tidy.length !== kept.current.length) {
        kept.current = tidy
        onStreets(tidy, asked)
      }
    }
    abort.current = null
    setProgress(null)
    if (run.stopped !== 'done' && run.stopped !== 'cancelled' && run.stopped !== 'no-road') {
      setNotice(`${STOPPED[run.stopped]} What was found is kept: try again to do the rest.`)
    } else if (run.stopped === 'done') {
      // Fewer than three failures in a row don't stop a run, so some can have failed without it saying so.
      const named = run.found - run.unnamed
      const failed = run.failed > 0 ? ` ${run.failed} could not be looked up: try again.` : ''
      if (run.found === 0 && run.failed > 0) setNotice(`Nothing could be looked up: check the internet connection and try again.`)
      else setNotice(`${named} named${run.unnamed > 0 ? `, ${run.unnamed} on roads with no name` : ''}.${failed}`)
    }
  }

  const stop = () => abort.current?.abort()

  const clear = async () => {
    const ok = await confirm({
      title: 'Clear Street Names?',
      message: 'Turns go back to saying only which way to turn. You can look the names up again.',
      confirmLabel: 'Clear',
      destructive: true,
    })
    if (ok) {
      setNotice(null)
      onStreets([])
    }
  }

  return (
    <>
      <div className="group">
        <div className="row">
          <span className="icon-tint">
            <Icon name="signpost" size={22} />
          </span>
          <div className="grow">
            <div className="title">Street names</div>
            {NEAREST === null && missing.length > 0 ? (
              <div className="sub">This build of the app has a routing address that can't look up street names.</div>
            ) : progress ? (
              <div className="sub">
                Looking up {Math.min(progress.done + 1, progress.total)} of {progress.total}, {minutes(progress.total - progress.done)} left. Keep this screen open.
              </div>
            ) : missing.length > 0 ? (
              <div className="sub">
                {answered.length > 0
                  ? `${missing.length} of ${turns.length} turns still need a street name`
                  : `So turns can say "Turn left onto Oak Road". ${turns.length} ${turns.length === 1 ? 'turn needs' : 'turns need'} a name`}
                . Needs internet, {minutes(missing.length)}.
              </div>
            ) : (
              <div className="sub">
                {named} of {turns.length} {turns.length === 1 ? 'turn has' : 'turns have'} a street name, kept on this phone.
              </div>
            )}
            {notice && !progress && <div className="sub">{notice}</div>}
          </div>
          {progress && <span className="spinner" aria-hidden="true" />}
        </div>
      </div>
      {NEAREST === null && missing.length > 0 ? null : progress ? (
        <button className="btn secondary block" onClick={stop}>
          <Icon name="x" size={18} />
          Stop
        </button>
      ) : missing.length > 0 ? (
        <button className="btn secondary block" onClick={start}>
          {answered.length > 0 ? `Look Up the Rest (${missing.length} left)` : 'Look Up Street Names'}
        </button>
      ) : (
        <button className="btn plain danger block" onClick={clear}>
          Clear Street Names
        </button>
      )}
      {missing.length > 0 && answered.length > 0 && !progress && (
        <button className="btn plain danger block" onClick={clear}>
          Clear Street Names
        </button>
      )}
      {/* Outside the sheet, which would otherwise hold the dialog's dimmed backdrop to its own box. */}
      {dialog && createPortal(dialog, document.body)}
    </>
  )
}
