import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { quietReachFor } from './alerts'
import { SIDE_COLOR } from './colors'
import { MapCredit } from './MapCredit'
import { MapView } from './MapView'
import { ROUND_RESET_WARNING, roundInProgress, unplacedSections, type AcceptOutcome } from './optimise/accept'
import { createOptimiser, OptimiseError, type Optimiser, type OptimiserOptions } from './optimise/client'
import { CRASHED_MESSAGE } from './optimise/protocol'
import { isStale } from './optimise/run'
import type { OptimiseResult, ProgressInfo } from './optimise/types'
import {
  acceptGate,
  advance,
  bundleSummary,
  canClose,
  closesOnTapBeside,
  closingNote,
  FIRST_STEP,
  gapNote,
  hasBundleOrder,
  keepOrderNote,
  keptText,
  length,
  moreOnText,
  notesFirst,
  savingText,
  shownChecks,
  startLine,
  statRows,
  streetGroups,
  streetNote,
  streetOn,
  tooSoon,
  turnBackRows,
  unmatchedLines,
  unplacedNote,
  workingLine,
  WORKING_HINT,
  WORKING_TITLE,
  type ChoicesState,
  type OptimiseEvent,
  type OptimiseState,
  type ResultsState,
} from './optimiseFlow'
import { loadAlertDistance } from './storage'
import { Banner } from './ui'
import type { Route, SavedRoute } from './types'
import './load.css'
import './optimise.css'

/** How long a step left for after the screen has been drawn waits first, in ms, so that what it says is up before the phone gets busy. */
const PAINT_MS = 30

/** What the steps' buttons do. */
export interface SheetActions {
  start: () => void
  cancel: () => void
  run: () => void
  accept: () => void
  close: () => void
  /** For what only moves the sheet along, with nothing to start or stop. */
  send: (event: OptimiseEvent) => void
}

/** The buttons along the foot of a step, which stay in view however long its list. */
const Foot = ({ children }: { children: ReactNode }) => <div className="optimise-foot">{children}</div>

/** Whether a tap landed on the buttons along the foot of a step. */
const onFoot = (target: EventTarget): boolean => target instanceof Element && target.closest('.optimise-foot') !== null

interface SwitchProps {
  title: string
  note: string
  /** What a screen reader hears, when the title alone doesn't say what is switched. */
  label?: string
  on: boolean
  onChange: (on: boolean) => void
}

/** A row with a switch at its end. The whole row takes the tap. */
function SwitchRow({ title, note, label, on, onChange }: SwitchProps) {
  return (
    <label className="row optimise-switch">
      <span className="grow">
        <span className="title">{title}</span>
        <span className="sub">{note}</span>
      </span>
      <input type="checkbox" role="switch" aria-label={label} checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="optimise-track" aria-hidden="true" />
    </label>
  )
}

function IntroStep({ act }: { act: SheetActions }) {
  return (
    <>
      <div className="load-sheet-scroll">
        <p className="optimise-text">Works out a shorter way to drive this route, with every street and stop still on it.</p>
        <p className="optimise-text">It needs internet to get the map. Nothing changes until you tap Accept.</p>
      </div>
      <Foot>
        <button className="btn primary block" onClick={act.start}>
          Start
        </button>
      </Foot>
    </>
  )
}

/** A step that is running: what it is doing, how far along that is, and Cancel. The bar starts over with each part of the step, as `done` does. */
function WorkingStep({ which, progress, act }: { which: 'fetching' | 'solving'; progress: ProgressInfo | null; act: SheetActions }) {
  const percent = Math.round((progress?.done ?? 0) * 100)
  return (
    <>
      <div className="load-sheet-scroll">
        <div className="optimise-working">
          <span className="spinner" aria-hidden="true" />
          <div>
            <div className="title">{WORKING_TITLE[which]}</div>
            <div className="sub" role="status">
              {workingLine(which, progress)}
            </div>
          </div>
        </div>
        <div className="optimise-bar" role="progressbar" aria-label={WORKING_TITLE[which]} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <span style={{ width: `${percent}%` }} />
        </div>
        <p className="footnote">{WORKING_HINT[which]}</p>
      </div>
      <Foot>
        <button className="btn secondary block" onClick={act.cancel}>
          Cancel
        </button>
      </Foot>
    </>
  )
}

function FailedStep({ state, act }: { state: Extract<OptimiseState, { step: 'failed' }>; act: SheetActions }) {
  const again = state.recovery === 'try-again' ? 'Try Again' : state.recovery === 'start-again' ? 'Start Again' : null
  return (
    <>
      <div className="load-sheet-scroll">
        <Banner kind="warn">{state.message}</Banner>
      </div>
      {again && (
        <Foot>
          <button className="btn primary block" onClick={act.start}>
            {again}
          </button>
        </Foot>
      )}
      {state.recovery === 'choices' && (
        <Foot>
          <button className="btn primary block" onClick={() => act.send({ type: 'back' })}>
            Back to Choices
          </button>
        </Foot>
      )}
    </>
  )
}

function ChoicesStep({ state, act }: { state: ChoicesState; act: SheetActions }) {
  const { view, choices } = state
  const start = startLine(view.start)
  const groups = streetGroups(view.streets, state)
  return (
    <>
      <div className="load-sheet-scroll">
        {unmatchedLines(view.unmatched).map((line) => (
          <Banner kind="warn" key={line}>
            {line}
          </Banner>
        ))}
        <div className="section-label">Start and end</div>
        <div className="group">
          <div className="row">
            <div className="grow">
              <div className="title">{start.title}</div>
              <div className="sub">{start.note}</div>
            </div>
          </div>
        </div>
        {hasBundleOrder(view) && (
          <div className="group">
            <SwitchRow title="Keep my bundle order" note={keepOrderNote(choices.keepOrder)} on={choices.keepOrder} onChange={(on) => act.send({ type: 'keep-order', on })} />
          </div>
        )}
        <div className="section-label">Allow throwing starboard or both</div>
        <p className="footnote">Switched off, a street is thrown from the port side only, so both sides of it take a pass each way.</p>
        {groups.map((group) => (
          <Fragment key={group.label}>
            <div className="group" role="group" aria-label={group.label}>
              {group.streets.map((street) => (
                <SwitchRow
                  key={street.key}
                  title={street.name}
                  note={streetNote(street)}
                  label={`Allow throwing starboard or both on ${street.name}`}
                  on={streetOn(choices, street)}
                  onChange={(on) => act.send({ type: 'street', key: street.key, on })}
                />
              ))}
              {group.moreOn > 0 && (
                <div className="row">
                  <span className="grow title">{moreOnText(group.moreOn)}</span>
                </div>
              )}
            </div>
            {group.moreOn > 0 && (
              <button className="btn secondary block" onClick={() => act.send({ type: 'show-all-streets' })}>
                Show All {group.streets.length + group.moreOn}
              </button>
            )}
          </Fragment>
        ))}
        {view.notes.map((note) => (
          <p className="footnote" key={note}>
            {note}
          </p>
        ))}
      </div>
      <Foot>
        <button className="btn primary block" onClick={act.run}>
          Find My Route
        </button>
      </Foot>
    </>
  )
}

/**
 * The new route coloured by side, for the driver to look over. It is only the line, as a round's worth of stops would hide it, and it is an overview
 * (see `MapView`), so a finger on it scrolls the sheet. It is drawn once: the route never changes on the results step, and drawing a few hundred
 * stretches again on every tap there would hold up what the tap was for, such as "Saving".
 */
const NewRouteMap = memo(function NewRouteMap({ route }: { route: OptimiseResult['route'] }) {
  const drawn = useMemo<Route>(() => ({ ...route, stops: [] }), [route])
  return (
    <div className="optimise-map" role="group" aria-label="Map of the new route, coloured by throw side">
      <MapView route={drawn} position={null} outsideCredit overview />
      <MapCredit compact />
    </div>
  )
})

/** Today and the new route, figure by figure, each side with the colour it has on the map. */
function FiguresTable({ result }: { result: OptimiseResult }) {
  return (
    <div className="group">
      <table className="optimise-table">
        <thead>
          <tr>
            <td />
            <th scope="col">Today</th>
            <th scope="col">New</th>
          </tr>
        </thead>
        <tbody>
          {statRows(result.before, result.after).map((row) => (
            <tr key={row.label}>
              <th scope="row">
                {row.side && <span className="seg-dot" style={{ background: SIDE_COLOR[row.side] }} />}
                {row.label}
              </th>
              <td>{row.before}</td>
              <td className="optimise-new">{row.after}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A heading and a list of plain lines under it. */
function Lines({ label, lines }: { label: string; lines: readonly string[] }) {
  return (
    <>
      <div className="section-label">{label}</div>
      <ul className="group">
        {lines.map((line) => (
          <li className="row optimise-line" key={line}>
            {line}
          </li>
        ))}
      </ul>
    </>
  )
}

interface ResultsProps {
  state: ResultsState
  saved: Pick<SavedRoute, 'sections'>
  /** The route has changed since this run started. */
  stale: boolean
  /** Accept would start over a round under way: see `roundInProgress`. */
  roundUnderWay: boolean
  act: SheetActions
}

function ResultsStep({ state, saved, stale, roundUnderWay, act }: ResultsProps) {
  const { result, unplaced, accepting } = state
  const gate = acceptGate(state, stale)
  const closing = closingNote(result.before)
  const turnBacks = turnBackRows(result.turnBacks)
  const bundles = bundleSummary(result)
  const gaps = gapNote(result.gaps, result.gapKm)
  const checks = shownChecks(result.worthChecking, state.allChecks)
  const hidden = result.worthChecking.length - checks.length
  // Where they say why the route is longer and what to do about it, the notes go up under the line that says so, where they will be read.
  const notesUp = notesFirst(result)
  return (
    <>
      <div className="load-sheet-scroll">
        <p className="optimise-lead">{savingText(result.before, result.after, result.keepOrder)}</p>
        {notesUp && result.notes.map((note) => <Banner key={note}>{note}</Banner>)}
        <FiguresTable result={result} />
        {closing && <p className="footnote">{closing}</p>}
        <NewRouteMap route={result.route} />

        {result.newRoads.length > 0 && (
          <>
            {/* In metres under a km, as its rows are: a short total in tenths of a km would read as nothing at all. */}
            <div className="section-label">Roads you don't drive today · {length(result.newRoadKm)}</div>
            <ul className="group">
              {result.newRoads.map((road) => (
                <li className="row" key={road.street}>
                  <span className="grow title">{road.street}</span>
                  <span className="trail">{length(road.km)}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {turnBacks.length > 0 && (
          <>
            <div className="section-label">Turning back, with no dead end</div>
            <ul className="group">
              {turnBacks.map((turn, i) => (
                <li className="row" key={`${i}${turn.street}`}>
                  <div className="grow">
                    <div className="title">{turn.street}</div>
                    <div className="sub">{turn.note}</div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {!!unplaced?.length && (
          <>
            <Lines label="Sections that can't be placed" lines={unplaced} />
            <p className="footnote">{unplacedNote(false)}</p>
          </>
        )}

        {bundles && bundles.order.length > 0 && (
          <>
            <div className="section-label">New bundle order</div>
            <ol className="group">
              {bundles.order.map((bundle, i) => (
                <li className="row" key={bundle.id}>
                  <span className="optimise-place" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="grow title">{bundle.name}</span>
                </li>
              ))}
            </ol>
          </>
        )}
        {bundles && <p className="footnote">{bundles.note}</p>}

        {checks.length > 0 && <Lines label="Worth checking" lines={checks.map((c) => c.text)} />}
        {hidden > 0 && (
          <button className="btn secondary block" onClick={() => act.send({ type: 'show-all-checks' })}>
            Show All {result.worthChecking.length}
          </button>
        )}
        {gaps && <p className="footnote">{gaps}</p>}

        {!notesUp &&
          result.notes.map((note) => (
            <p className="footnote" key={note}>
              {note}
            </p>
          ))}
      </div>
      <Foot>
        {gate.why.length > 0 && (
          <div className="optimise-why" id="optimise-why">
            {gate.why.map((why) => (
              <Banner kind="warn" key={why}>
                {why}
              </Banner>
            ))}
          </div>
        )}
        {gate.why.length === 0 && roundUnderWay && <Banner kind="warn">{ROUND_RESET_WARNING}</Banner>}
        {!unplaced && !!saved.sections?.length && (
          <p className="footnote" role="status">
            Checking your sections.
          </p>
        )}
        <button className="btn primary block" disabled={!gate.ready} aria-describedby={gate.why.length ? 'optimise-why' : undefined} onClick={act.accept}>
          {accepting && <span className="spinner" aria-hidden="true" />}
          {accepting ? 'Saving' : 'Accept'}
        </button>
        <div className="btn-row">
          <button className="btn secondary" disabled={accepting} onClick={act.close}>
            Cancel
          </button>
          <button className="btn secondary" disabled={accepting} onClick={() => act.send({ type: 'back' })}>
            Change Choices
          </button>
        </div>
      </Foot>
    </>
  )
}

function AcceptedStep({ state }: { state: Extract<OptimiseState, { step: 'accepted' }> }) {
  return (
    <div className="load-sheet-scroll">
      <p className="optimise-lead">Your new route is in use.</p>
      <Banner>{keptText(state.kept)}</Banner>
      {state.unplaced.length > 0 && (
        <>
          <Lines label="Sections that couldn't be placed" lines={state.unplaced} />
          <p className="footnote">{unplacedNote(true)}</p>
        </>
      )}
    </div>
  )
}

interface BodyProps {
  state: OptimiseState
  saved: Pick<SavedRoute, 'sections'>
  stale: boolean
  roundUnderWay: boolean
  act: SheetActions
}

/** What the sheet shows at each step, from the state alone. */
export function OptimiseBody({ state, saved, stale, roundUnderWay, act }: BodyProps) {
  switch (state.step) {
    case 'intro':
      return <IntroStep act={act} />
    case 'fetching':
      return <WorkingStep which="fetching" progress={state.progress} act={act} />
    case 'choices':
      return <ChoicesStep state={state} act={act} />
    case 'solving':
      return <WorkingStep which="solving" progress={state.progress} act={act} />
    case 'results':
      return <ResultsStep state={state} saved={saved} stale={stale} roundUnderWay={roundUnderWay} act={act} />
    case 'accepted':
      return <AcceptedStep state={state} />
    case 'failed':
      return <FailedStep state={state} act={act} />
  }
}

interface Props {
  /** The route in use, which is the one worked on. */
  saved: SavedRoute
  /** Puts a finished run into the saved routes: see `acceptOptimised`. It is left to the screen that holds the library, as it says what the library is now. */
  onAccept: (result: OptimiseResult) => AcceptOutcome
  onClose: () => void
  /** Stands in for the worker's client in a test. */
  makeOptimiser?: (options: OptimiserOptions) => Optimiser
}

/**
 * Optimise Route, as a sheet that comes up from the bottom and fills the screen, over the tab bar too, so the route can't be changed under a run from
 * another screen. It starts with what it does, gets the map, asks what is to be allowed, works out the route and sets the old and new side by side, and
 * nothing is saved until Accept. Every way out of it ends the worker, as that is what stops a run. The steps are in `optimiseFlow.ts`.
 */
export function OptimiseSheet({ saved, onAccept, onClose, makeOptimiser = createOptimiser }: Props) {
  const [state, send] = useReducer(advance, FIRST_STEP)
  const [optimiser] = useState(() => makeOptimiser({ onProgress: (progress) => send({ type: 'progress', progress }) }))
  const sheet = useRef<HTMLDivElement>(null)
  const results = state.step === 'results' ? state : null
  const ran = results?.result
  const accepting = results?.accepting ?? false
  const placing = !!results && !results.unplaced
  const closable = canClose(state)

  // The route is compared whole, so only when it or the run has changed.
  const stale = useMemo(() => !!ran && isStale(saved, ran.basedOn), [saved, ran])
  const showing = !!results
  // How far from the route a no-throw house is kept quiet, as on the round: it goes with the alert distance chosen there (see `quietReachFor`), and
  // which houses are stops still to do depends on it.
  const [reachM] = useState(() => quietReachFor(loadAlertDistance()))
  // Whether Accept would start over a round under way. It goes through every pass of the route, so it is worked out once the results are up, as the
  // sections are, and not on every draw or before it is wanted.
  const [roundUnderWay, setRoundUnderWay] = useState(false)
  useEffect(() => {
    if (!showing) return
    const timer = setTimeout(() => setRoundUnderWay(roundInProgress(saved, reachM)), PAINT_MS)
    return () => clearTimeout(timer)
  }, [showing, saved, reachM])

  useEffect(() => () => optimiser.close(), [optimiser])

  /** When the step on the screen came up, by `performance.now()`. */
  const stepAt = useRef(0)
  // The button tapped goes with the step it was on, so the focus is taken into the new step. Left alone it would drop to the page behind the sheet.
  useLayoutEffect(() => {
    stepAt.current = performance.now()
    sheet.current?.focus({ preventScroll: true })
  }, [state.step])

  /** A tap on the foot just after the step changed was the second half of a double tap meant for the step before, so it goes no further: see `tooSoon`. */
  const holdTapThrough = (e: MouseEvent<HTMLDivElement>) => {
    if (onFoot(e.target) && tooSoon(performance.now() - stepAt.current)) e.stopPropagation()
  }

  // Escape goes by the same rule as a tap beside the sheet, as it is as easy to press by mistake. Close in the head is there to leave on purpose.
  const escapes = closesOnTapBeside(state)
  useEffect(() => {
    if (!escapes) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [escapes, onClose])

  // Placing sections can take the phone a moment, so the results go up first. The new route is what Accept will place them on, the same way.
  useEffect(() => {
    if (!placing || !ran) return
    const timer = setTimeout(() => send({ type: 'placed', unplaced: unplacedSections(saved, ran.route.points) }), PAINT_MS)
    return () => clearTimeout(timer)
  }, [placing, ran, saved])

  // So can Accept, which runs here on the main thread. "Saving" goes up first, and it can only run once, as `accepting` holds until it is done.
  useEffect(() => {
    if (!accepting || !ran) return
    const timer = setTimeout(() => {
      try {
        const outcome = onAccept(ran)
        send(outcome.ok ? { type: 'accepted', kept: outcome.kept.name, unplaced: outcome.unplaced } : { type: 'refused', reason: outcome.reason })
      } catch {
        // The sheet can't be closed while this runs, so it has to come to an end whatever happens. The routes are only changed once all of it has gone right.
        send({ type: 'refused', reason: CRASHED_MESSAGE })
      }
    }, PAINT_MS)
    return () => clearTimeout(timer)
  }, [accepting, ran, onAccept])

  /** A step's promise having failed. A step that was cancelled or taken over says so too, and `advance` passes over it. */
  const fail = (error: unknown) => send(error instanceof OptimiseError ? { type: 'failed', kind: error.kind, message: error.message } : { type: 'failed', kind: 'crashed', message: CRASHED_MESSAGE })

  const act: SheetActions = {
    start: () => {
      send({ type: 'start' })
      optimiser.prepare(saved).then((view) => send({ type: 'prepared', view }), fail)
    },
    cancel: () => {
      optimiser.cancel()
      send({ type: 'cancel' })
    },
    run: () => {
      if (state.step !== 'choices') return
      send({ type: 'run' })
      optimiser.solve(state.choices).then((result) => send({ type: 'solved', result }), fail)
    },
    accept: () => {
      if (results && acceptGate(results, stale).ready) send({ type: 'accept' })
    },
    close: onClose,
    send,
  }

  return (
    <div className="load-scrim" onClick={escapes ? onClose : undefined}>
      <div
        className="load-sheet optimise-sheet"
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Optimise Route"
        tabIndex={-1}
        onClickCapture={holdTapThrough}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="load-sheet-head">
          <div>
            <h2>Optimise Route</h2>
            <div className="load-sheet-whole">{saved.name}</div>
          </div>
          <button className="btn plain" disabled={!closable} onClick={onClose}>
            {state.step === 'accepted' ? 'Done' : 'Close'}
          </button>
        </div>
        <OptimiseBody state={state} saved={saved} stale={stale} roundUnderWay={roundUnderWay} act={act} />
      </div>
    </div>
  )
}
