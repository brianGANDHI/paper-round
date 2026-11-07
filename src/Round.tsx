import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertBanner } from './AlertBanner'
import { barBundle, caughtUp, dropAllowed, freshStart, leftBehindNotice, missedAmong, missedNotice, nextRoundRows, restartedRound, restartEffect, restoreBundle, savedRound, stillNextNotice } from './bundleFlow'
import { bundleList, bundleNameOf, bundleRows, bundlesBehind, bundlesLeft, earlierPasses, firstLink, gatedOccurrences, markDropped, NEXT_BEHIND_SPEECH, nextBundleId, nextBundleSpeech, nextHoldsUp, nextInOrder, nextLeftBehind, nextStillAhead, notNextAlerts, otherPasses, passStates, stillNextSpeech, wentByUnseen, type PassStates } from './bundles'
import { BundlesSheet } from './BundlesSheet'
import { aheadOf, alertable, alertRadius, ALERT_DISTANCES, courtLegsOf, houseRow, isAlertDistance, isGoneBy, keepAlertsAhead, legsOnResume, pickCurrent, quietReachFor, resumedLegs, roundCounts, zoneExit, type AlertDistance } from './alerts'
import { bannerBlock, bannerBundle, bannerWaiting, shownSide } from './bannerBlock'
import { SIDE_LABEL, SIDE_PILL, SIDE_SHORT } from './colors'
import { useDialogs } from './confirm'
import { useGps, useWakeLock } from './device'
import { plural } from './format'
import { angleBetween, approachingOccurrences, byPosition, haversine, keepPlaced, occurrences, POSITION_MAX_ACCURACY_M, sideAt, snapAtDistance, type Occurrence } from './geo'
import { guidedTurn } from './guidance'
import { pushTrail, trailHeading, type TrailPoint } from './heading'
import { HeadingBadge } from './HeadingBadge'
import { Icon } from './Icon'
import { LoadCard } from './LoadCard'
import { MapCredit } from './MapCredit'
import {
  guideToLeft,
  OFF_MAX_ACCURACY_M,
  ON_ROUTE_M,
  offRouteSpeech,
  restartWatch,
  startOffRoute,
  startOffWatch,
  stepWatched,
  takeMeBack,
  unasked,
  watchFix,
  type OffEvent,
  type OffState,
  type OffWatch,
  type RouteFix,
} from './offRoute'
import { OffRouteBanner } from './OffRouteBanner'
import { holdHeading } from './mapHeading'
import { MapView, type ViewCmd } from './MapView'
import { resolveSections } from './namedSections'
import { SectionBanner } from './SectionBanner'
import { carriedOn, NOTHING_WATCHED, RESUMED_WATCH, SECTION_ROAD_M, sectionSpeech, startedAt, watchSection, type SectionNote, type SectionWatch } from './sectionWatch'
import { advance, makeTrack, offRouteGap, OUTLIER_ACCURACY_M, rebaseProgress, startProgress, type Progress } from './progress'
import { keptBeforeDrop } from './dropMemory'
import { continueFrom, sameCourtLegs, slackFor, withCourtLegs } from './resume'
import { RoundBar, RoundButtons, type Notice } from './RoundBar'
import { RoundMenu } from './RoundMenu'
import { afterUserMove, barCover, FREE_LOOK_MS } from './roundView'
import { formatDistance, paintMetres, routeLength } from './routeEdit'
import { loadAlertDistance, loadHeadingUp, loadKeepAudioAwake, loadVoiceTurns, saveAlertDistance, saveHeadingUp, saveKeepAudioAwake, saveVoiceTurns } from './storage'
import { RouteChip, Segmented } from './ui'
import { sideChangeNote, sideExtents, type ExtentKey } from './driveEdit'
import { createSideCue, sideAtAlong, sideLookAheadM, sideWords, testVoice } from './sideVoice'
import { sound } from './sound'
import { say, speechAvailable, stopSpeaking, unlockSpeech } from './speech'
import { StartPicker } from './StartPicker'
import { missingQueries, nameTurns } from './streets'
import { cueToSay, guidanceToShow, turnKey } from './transitView'
import { TurnCard } from './TurnCard'
import { doneNow, endTurnHold, heldKeys, holdGoneBy, holdLeftBehind, judgedAt, NOTHING_HELD, reachedAt, shownQueue, stepForNext, stepTurnHold, type TurnHold } from './turnHold'
import { onTheRoute, routeTurns, TURN_KM_M, TURN_PASSED_M, type TurnCue } from './turns'
import { alertWordsLevel, alertWordsStale, planVoice } from './voicePlan'
import { SIDES, type LoadList, type NamedSection, type Pt, type RoundState, type Route, type Side, type StopType, type TurnStreet } from './types'

/** The furthest reached is kept with the round this many metres at a time. */
const SAVE_EVERY_M = 100
/** How long a message with a way to undo what it says stays up, and one without, in milliseconds. */
const UNDO_MS = 12000
const NOTE_MS = 6000
/** How long the banner for a named section ending or starting stays up. */
const SECTION_NOTE_MS = 8000
/** How long it waits for the list or the menu to close, after which it is old news. */
const SECTION_HOLD_MS = 30000
/** What the bar along the bottom covers of the map, in pixels (its height and the gap under it), until it has been measured. */
const BAR_COVER_PX = 64
/** What the small amber button in the bar says when the screen is not being kept awake, which stops the GPS. */
const WAKE_CAUTION = 'Keep the phone awake so GPS keeps updating.'
/** After a round is started or skipped to a spot, stops other than bundles between it and the car, if the car's first good fix on the route is this far or less ahead of it, in metres, count as gone by. */
const CATCH_UP_M = 300
/** Once the furthest reached is this close to the end of the route, in metres, leaving it is going home, not going wrong. */
const END_QUIET_M = 50
/** The route counts as reached at once when the phone is on it within this many metres, along it, of where the round starts. */
const REACH_NEAR_M = 100
/** Anywhere else it counts as reached after this many metres on it (crossing it on the way to the start is not that). */
const REACH_RUN_M = 200
/** A stop that is away from the route is being visited, not left for, within how far off the route it is, its alert distance and this much, in metres. */
const OFF_ROUTE_STOP_M = 60
/** The phone is going the way the route runs, not back down it, if its heading is within this many degrees of the route's (a street coming in from the side counts as going the way it runs). */
const FORWARD_DEG = 110
/** Driving this much nearer, in metres, to where the route was left than the place it was rejoined at is going back to it. */
const CLOSING_M = 100
/** A fix is weighed for leaving the route only if the phone has moved this far, in metres, since the last that was, or says it is going. */
const STEP_MOVED_M = 5
/**
 * A next bundle counts as gone by with no alert only over a move along the route the car can have driven: one no more than this many metres beyond the ground
 * between the two fixes. Further than that the tracker has landed on another street of the route, and what lies between was never near the car. A gap on a road with
 * sharp bends can fall outside it too, and then the bundle is told of as left behind (see `nextLeftBehind`), not missed.
 */
const DRIVEN_SLACK_M = 100

interface Props {
  route: Route
  round: RoundState
  /** Name of the route in use, shown so the wrong round isn't run by mistake. */
  routeName: string
  /** The route's named sections, and the street names found for its turns. */
  sections: readonly NamedSection[]
  streets: readonly TurnStreet[]
  /** The order the driver drops the bundles in (stop ids, see `SavedRoute.bundleOrder`), and a change to it from the Bundles list. */
  bundleOrder?: readonly string[]
  onBundleOrder: (order: string[]) => void
  /** What the driver loads before the round (see `SavedRoute.load`), and a change to it. */
  load?: LoadList
  onLoad: (list: LoadList) => void
  onRound: (r: RoundState) => void
  /** The route was changed from the road, such as the throw side of the part being driven: the round carries on with it. */
  onAdjustRoute: (route: Route) => void
  onGoSetup: () => void
  onGoRoutes: () => void
}

export function Round({ route, round, routeName, sections, streets, bundleOrder, onBundleOrder, load, onLoad, onRound, onAdjustRoute, onGoSetup, onGoRoutes }: Props) {
  const [started, setStarted] = useState(false)
  const [overview, setOverview] = useState(false)
  // Alerts wait their turn so a bundle prompt can never hide a no-throw warning.
  const [queue, setQueue] = useState<Occurrence[]>([])
  const seen = useRef(new Set<string>())
  /** The alerts held over a turn round the tracker is not sure of yet, and the stops put by meanwhile (see turnHold.ts). */
  const turnHold = useRef<TurnHold | null>(null)
  /** The keys of the alerts held, for the banner, which does not show one the driver has gone by as passed (see `shownQueue`). */
  const [turnHeld, setTurnHeld] = useState<ReadonlySet<string>>(NOTHING_HELD)
  /** Where the phone has been, for a heading when it has no course of its own. Only fixes that were believed are in it. */
  const trail = useRef<TrailPoint[]>([])
  /** Which way the phone is heading, if it can say: which pass of a street is being driven, which side a stop off the route is on, and the turn that comes up depend on it. */
  const [headingDeg, setHeadingDeg] = useState<number | null>(null)
  /** Whether the map turns to point the way the driver is heading, instead of north. */
  const [headingUp, setHeadingUp] = useState(loadHeadingUp)
  /** The way the map is turned to, smoothed from fix to fix and held while the phone can't say (unwrapped degrees, so it never turns the long way round). */
  const [mapHeading, setMapHeading] = useState<number | null>(null)
  /** When the fix that last moved the map's heading was taken, for how long it has been since. */
  const mapHeadingTime = useRef<number | null>(null)
  /** Whether the driver is following the route, has left it, or has come back onto it somewhere else (see offRoute.ts). */
  const [off, setOff] = useState<OffState>(startOffRoute)
  const offRef = useRef<OffState>(startOffRoute)
  /** Whether the route has been reached yet: until then the driver is on the way to it, not off it. */
  const reachedRef = useRef(false)
  /** What is kept beside the off-route machine from fix to fix (see `OffWatch` in offRoute.ts): when the last fix to go by came, whether the phone has been unseen since the place last followed, and whether it has got to where the round starts. */
  const watchRef = useRef<OffWatch>(startOffWatch)
  /** Where the last fix that was weighed for leaving the route was: a phone standing still, jittering, is not weighed again. */
  const lastStepAt = useRef<Pt | null>(null)
  /** How far along the route the round starts from, and where the phone first touched it, for telling reaching the route from crossing it. */
  const reachAlong = useRef(0)
  const reachRun = useRef<Pt | null>(null)
  /** While being taken back to where the route was left: how far the furthest reached may go, until the driver is back at or before it. */
  const capRef = useRef<number | null>(null)
  /** Whether the driver has asked to be taken back to where the route was left: leaving the route on the way there is not news. */
  const guidedRef = useRef(false)
  /** What the fix effect needs to know and re-reads on its own schedule. */
  const startedRef = useRef(false)
  const finishedRef = useRef(false)
  const overButBundlesRef = useRef(false)
  const routeEndRef = useRef(0)
  const occsRef = useRef<Occurrence[]>([])
  const radiusRef = useRef<Record<StopType, number>>({ bundle: 40, nothrow: 40, request: 40, block: 40 })
  /** The latest `restartAt`, for the fix effect, which runs on its own schedule. */
  const restartAtRef = useRef<(metres: number, skip: boolean, keepBundles?: boolean) => void>(() => {})
  /** The picker of where to start, or to skip to: on the start screen, or over the road. */
  const [picker, setPicker] = useState<'start' | 'jump' | null>(null)
  // The position is watched from the start screen's map too, so it can show where you are.
  const { fix, error } = useGps(started || picker === 'start')
  const wake = useWakeLock(started)
  const { confirm, choose, dialog } = useDialogs()
  /** A message the bar along the bottom shows for a while, with a way to take back the change it tells of, if there is one (a closure that does it). */
  const [toast, setToast] = useState<Notice | null>(null)
  /** A named section just ended or started, for its banner (see `watchSection`). */
  const [sectionNote, setSectionNote] = useState<SectionNote | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  /** The list of bundle drops is up. */
  const [bundlesOpen, setBundlesOpen] = useState(false)
  /**
   * The list is up from the start screen for the order of the next round, as the round kept is over, or has too few bundles left to move (see `nextRoundRows`).
   * Settled as it opens, so that Mark dropped taking the round down to one left doesn't turn the list into another one under the driver's finger.
   */
  const [orderForNext, setOrderForNext] = useState(false)
  /** Free look: the driver has dragged the north-up map, so it stays where they put it instead of following them. Re-centring, or a quiet spell, ends it. */
  const [freeLook, setFreeLook] = useState(false)
  /** Counts the driver's moves of the map while looking around, so the wait before following starts again begins afresh at each. */
  const [lastMove, setLastMove] = useState(0)
  /** The latest zoom button command: a new key each time, so every tap is a step. */
  const [view, setView] = useState<ViewCmd | undefined>(undefined)
  /** The screen and the bar along its bottom, for measuring how much of the map the bar covers. */
  const [screenEl, setScreenEl] = useState<HTMLDivElement | null>(null)
  const [barEl, setBarEl] = useState<HTMLDivElement | null>(null)
  const [coverPx, setCoverPx] = useState(BAR_COVER_PX)
  const handled = useMemo(() => new Set(round.handledStopIds), [round])
  /** How close to a stop its alert shows, as the driver chose it. */
  const [alertDistance, setAlertDistance] = useState(loadAlertDistance)
  // Each time the route passes a stop is a separate warning, so a street driven twice warns on both passes.
  const allOccs = useMemo(() => occurrences(route), [route])
  // How far from the route a no-throw house can be kept quiet: out to where it is met by where the driver is, which goes with the alert distance.
  const reachM = useMemo(() => quietReachFor(alertDistance), [alertDistance])
  /** Where the driver has got to along the route, judged against where they were a moment ago. Null until the round has begun. */
  const [progress, setProgress] = useState<Progress | null>(null)
  const progressRef = useRef<Progress | null>(null)
  const radius = useMemo(() => alertRadius(alertDistance), [alertDistance])
  // The passes that alert, as `alertable` gives them for the route as it is: a no-throw house on a stretch where nothing is thrown at all has nothing to warn about.
  const fresh = useMemo(() => alertable(route, allOccs, reachM), [route, allOccs, reachM])
  /**
   * The passes the round alerts for: `fresh`, with any alert a change part way through the round moved onto a leg of a court the driver has gone by kept on the leg still ahead (see `keepAlertsAhead`). Worked out in the render the route changes in, so no effect ever sees the alert on the leg gone by.
   * Before the round is under way (the start screen, and Continue Round) they are as the change left them, from what is kept with the round (see `resumedLegs`), so nothing is worked out again from where the driver is, until the first fix on the route after Continue Round (see `legsOnResume`).
   */
  const [legs, setLegs] = useState(() => ({ fresh, occs: resumedLegs(route, allOccs, fresh, round.courtLegs, radius) }))
  let occs = legs.occs
  if (legs.fresh !== fresh) {
    occs = progress ? keepAlertsAhead(route, allOccs, legs.occs, fresh, progress.along, radius).occs : resumedLegs(route, allOccs, fresh, round.courtLegs, radius)
    setLegs({ fresh, occs })
  }
  const track = useMemo(() => makeTrack(route.points), [route.points])
  /** What each bundle drop is called, by occurrence, for saying which was missed. */
  const bundleNames = useMemo(() => new Map(bundleList(occs, { handledStopIds: [] }, 0).map((b) => [b.key, b.name])), [occs])
  /** The furthest reached that has been saved with the round, in metres. */
  const savedFurthest = useRef(round.furthest ?? 0)
  /** How far along the route the driver is, and the furthest they have got (what is behind it is drawn faded), in metres. */
  const along = progress?.along ?? 0
  const driven = progress?.furthest ?? 0
  const snapIdx = progress?.idx ?? 0
  /** Where the phone is, as its latest fix says: how far each bundle drop is, in a straight line. Null before the first fix. */
  const fixLat = fix?.lat
  const fixLng = fix?.lng
  const phoneAt = useMemo<Pt | null>(() => (fixLat === undefined || fixLng === undefined ? null : { lat: fixLat, lng: fixLng }), [fixLat, fixLng])
  /** Every bundle stop in the driver's order with what became of it, the first still to do being the next, for the bar and the list. */
  const rows = useMemo(() => bundleRows(occs, round, bundleOrder, phoneAt), [occs, round, bundleOrder, phoneAt])
  const barNext = useMemo(() => barBundle(rows), [rows])
  const turns = useMemo(() => routeTurns(route.points), [route.points])
  // The turns with the street each leads into, where it is known.
  const named = useMemo(() => nameTurns(route.points, turns, streets), [route.points, turns, streets])
  const resolved = useMemo(() => resolveSections(route.points, sections), [route.points, sections])
  /** How many turns still have no answer to which street they lead into, once some have been looked up: a reminder on the start screen. */
  const missingStreets = useMemo(
    () => (streets.length > 0 && turns.length > 0 ? missingQueries(route.points, turns, streets).length : 0),
    [route.points, turns, streets],
  )
  /** Whether the next turn is said out loud as well as shown. */
  const [voice, setVoice] = useState(loadVoiceTurns)
  /** Whether a near-silent signal keeps the audio link to a car or speaker open while the voice is on. */
  const [keepAudio, setKeepAudio] = useState(loadKeepAudioAwake)
  /** What has been said about each turn, by how far along the route it is, so each is said once. */
  const saidTurn = useRef(new Map<number, TurnCue>())
  /** The alerts already said out loud, by occurrence, so a row of houses is said once, not house by house. */
  const announced = useRef(new Set<string>())
  const voiceRef = useRef(voice)
  /** Whether the bar has a notice up, or the list, the menu, the picker or a question covers it, as a word for the bar waits for it (see `nextHoldsUp`). */
  const barBusyRef = useRef(false)
  /** The alerts that came up but are not said yet, by occurrence: a no-throw house is named only once the side thrown where the driver is includes its side (see `planVoice`). */
  const heldRef = useRef(new Set<string>())
  /** The side last said out loud, so each change of the side thrown is said once (see `createSideCue`). */
  const sideCueRef = useRef(createSideCue())
  /** How fast the phone said it was going at the fix the driver's place is from, for how far ahead the side is said. */
  const speedRef = useRef<number | null>(null)
  /** Stops the words still to come from Test Voice on the start screen. */
  const stopVoiceTest = useRef<(() => void) | null>(null)
  const side = sideAt(route, snapIdx)
  // The effect below reads what is showing, and the latest way to save progress, without re-running for them.
  const queueRef = useRef(queue)
  const onRoundRef = useRef(onRound)
  const handledRef = useRef(handled)
  /** Where the round was started or last skipped to, which is kept with it. */
  const startMRef = useRef(round.startM ?? 0)
  /** Where the round was started or skipped to, until the first good fix on the route after that: see CATCH_UP_M. */
  const restartRef = useRef<number | null>(null)
  /**
   * How far the driver had got at the last fix that could say so, where the car was, and the bundle next in the list as things stood after it, for a next bundle
   * gone by with no alert (see `wentByUnseen`). Null with nothing to go by: until the first fix after a start, a skip or *Continue Round*, and after a fix that says nothing
   * of what the car drove past. So the first fix after one of those counts nothing. A fix too poor to go by leaves it as it is, for the next good one to judge the whole stretch.
   */
  const lastJudged = useRef<{ reach: number; next: string | null; at: Pt } | null>(null)
  /**
   * The bundles the driver may be told of as holding up the list (see `nextHoldsUp` and `nextLeftBehind`), by stop id: those the list came to by itself, by a drop, a miss, *Mark dropped*,
   * Undo or a skip, and those next with a pass not yet behind the car, on a fix that can say so. Kept through a change of the next and through a skip or a carry-on, so a drop taken back with
   * Undo is still known. A start clears it. The one case left out is a bundle the driver moved to the top of the list when it was already behind the car (see `changeOrder`): that is their own decision.
   * Anything else behind the car holds up every bundle after it, ahead of the car or not, so it must not go unsaid.
   */
  const mayTellBehind = useRef(new Set<string>())
  /**
   * The bundle next in the list at the last look, null with none next, for seeing that the list has come to another by itself; a reorder sets it (see `changeOrder`). Not known until the
   * route is first reached, and again after a start, so the bundle next then counts as come to: after a reload, a killed app opened further on, or a car joining the route past it,
   * nothing else knows of it.
   */
  const listNext = useRef<string | null | undefined>(undefined)
  /** The passes of bundles behind the car at the last good fix (see `bundlesBehind`), for `goneBefore`: a pass gone by on the fix the next changes on did not go by before it. */
  const behindLast = useRef<ReadonlySet<string>>(new Set())
  /**
   * The passes already behind the car when the bundle next became next, by the list or a reorder: what it can't be held to have cost (see `nextHoldsUp`). None when that is not known. A pass
   * the car is put back behind (a skip back, a carry-on, *Take me back*) leaves it, as it can be gone by again.
   */
  const goneBefore = useRef<ReadonlySet<string>>(new Set())
  /** The bundles the driver has been told are holding up the list (see `nextHoldsUp` and `nextLeftBehind`), so each is told once. A start and a restart clear it, and a reorder for the two it changes. */
  const toldBehind = useRef(new Set<string>())
  /** What has been told of the named sections, and the section the car was in at the last look (see `watchSection`). */
  const sectionWatch = useRef<SectionWatch>(NOTHING_WATCHED)
  /** Whether the car was going the way the route runs at the last fix, or can't say. */
  const forwardRef = useRef(true)
  /** Set by *Continue Round* until the first fix on the route after it, where a house at the head of a court the driver is between the two legs of is put on the leg ahead (see `legsOnResume`). */
  const resumeRef = useRef(false)
  /**
   * The round as it was last kept. Every save builds on it, so the bundles dropped and missed are carried along with the stops done and
   * not lost by a save that knows only of those (the screen used to build the round afresh each time). It is set at once when the round
   * is kept, not waiting for the new one to come back as a prop, so two changes in the same moment build on each other.
   */
  const roundRef = useRef(round)
  /**
   * How each pass of a bundle's stop stood just before it was dropped (open, skipped or missed), so that taking the drop back puts every one
   * of them back. A restart keeps it for the drops it keeps (see `keptBeforeDrop`); it is lost only when the driver leaves the Round tab.
   */
  const beforeDrop = useRef(new Map<string, PassStates>())
  /** When Dropped was last tapped on an alert, so that a double tap drops only one bundle. */
  const lastDropAt = useRef(-Infinity)
  const { total, remaining, done, finished } = roundCounts(occs, handled)
  // A round that has been started part way, or driven some way, carries on from there even when no stop has been done.
  const carryOn = continueFrom(round, allOccs, handled)
  // With nothing to carry on, the one button starts afresh (as Start Over does). With nothing done that is where the round would carry on
  // from anyway, but what a change of side made of the passes at the head of a court is forgotten, so a house it left out alerts again on the new drive.
  // A round that got to the end of the route with only bundles still to do would carry on with no house left to alert for: the driver is given a new one first.
  // (The furthest is kept a hundred metres at a time, so the end is that far short of it.)
  const overButBundles = !finished && carryOn > 0 && carryOn >= (track.cum[track.cum.length - 1] ?? 0) - END_QUIET_M - SAVE_EVERY_M && bundlesLeft(rows) > 0 && occs.every((o) => handled.has(o.key) || o.stop.type === 'bundle')
  const partial = !overButBundles && remaining > 0 && (done > 0 || carryOn > 0)
  useLayoutEffect(() => {
    queueRef.current = queue
    onRoundRef.current = onRound
    roundRef.current = round
    handledRef.current = handled
    startMRef.current = round.startM ?? 0
    voiceRef.current = voice
    barBusyRef.current = toast !== null || bundlesOpen || menuOpen || picker !== null || dialog !== null
    startedRef.current = started
    finishedRef.current = finished
    overButBundlesRef.current = overButBundles
    routeEndRef.current = track.cum[track.cum.length - 1] ?? 0
    occsRef.current = occs
    radiusRef.current = radius
  })
  /** Keeps the round, and remembers it as the latest. */
  const commitRound = useCallback((next: RoundState) => {
    roundRef.current = next
    onRoundRef.current(next)
  }, [])

  /**
   * Keeps the stops done and how far the round has got, and where it was started from, with the bundles dropped and missed it had, and
   * what a change of side made of the passes at the head of a court (see `courtLegsOf`).
   * `missedKeys` are bundles driven past with no tap, which must be among the stops done. A bundle marked done any other way (the earlier
   * passes of one of those) is left skipped: neither dropped nor missed.
   */
  const saveRound = useCallback(
    (handledStopIds: string[], furthest?: number, missedKeys: readonly string[] = []) => {
      commitRound(withCourtLegs(savedRound(roundRef.current, handledStopIds, furthest, startMRef.current, missedKeys), roundRef.current.courtLegs))
    },
    [commitRound],
  )

  /** Tells the driver of leaving the route, being back on it, or having come back onto it somewhere else: a tone, and the voice if it is on. */
  const announceOff = useCallback((event: OffEvent, fix: RouteFix, state: OffState) => {
    if (!event) return
    // Asked to be taken back, the guide is up already: leaving the route on the way there is not said.
    if (guidedRef.current && (event === 'went-off' || event === 'remind')) return
    // Back, and carried on, are only said: a tone would be one more thing to take in.
    const beep = event === 'went-off' || event === 'remind' || event === 'rejoined-elsewhere' ? sound.offRoute() : 0
    if (!voiceRef.current) return
    const delta = state.left ? fix.along - state.left.along : 0
    say(offRouteSpeech(event, delta), { urgent: event !== 'back', afterMs: beep * 1000 })
  }, [])

  /** The furthest reached goes back to `metres`, on the map and in what is kept with the round: it had gone on with a rejoin that is being undone. */
  const lowerFurthest = useCallback(
    (metres: number) => {
      const p = progressRef.current
      if (p && p.furthest > metres) {
        const back = { ...p, furthest: metres, recent: [] }
        progressRef.current = back
        setProgress(back)
      }
      const kept = Math.floor(metres / SAVE_EVERY_M) * SAVE_EVERY_M
      if (kept < savedFurthest.current) {
        savedFurthest.current = kept
        saveRound([...handledRef.current], kept)
      }
    },
    [saveRound],
  )

  /**
   * Weighs a fix that was taken in for leaving the route (see offRoute.ts) and tells the driver what it finds. The route is first
   * reached when the phone is on it near where the round starts, or has stayed on it for a good stretch: crossing it on the way
   * to the start is neither. A trip to a stop that is away from the route is the app's own errand, and is not leaving it.
   */
  const weighOff = useCallback(
    (now: Progress, speed: number | null, forward: boolean) => {
      if (!reachedRef.current) {
        const on = !now.lost && now.gap <= ON_ROUTE_M && now.accuracy <= OFF_MAX_ACCURACY_M
        if (!on) {
          reachRun.current = null
          return
        }
        reachRun.current ??= now.at
        if (Math.abs(now.along - reachAlong.current) <= REACH_NEAR_M || haversine(reachRun.current, now.at) >= REACH_RUN_M) reachedRef.current = true
        else return
      }
      const radius = radiusRef.current
      if (occsRef.current.some((o) => byPosition(o, radius) && !handledRef.current.has(o.key) && haversine(now.at, o.stop) <= o.off + radius[o.stop.type] + OFF_ROUTE_STOP_M)) {
        // The machine is not asked about this fix, so the place it last followed goes stale: the phone is as good as unseen (see `unasked`).
        watchRef.current = unasked(watchRef.current)
        return
      }
      // While the tracker is weighing up a jump to somewhere else on the route its place is the old one and its gap the new one's: not a fix on the route (`doubt`).
      // How far the phone is from the route is from the nearest part of it, not from the place the tracker holds (see `offRouteGap`).
      const reading: RouteFix = { time: now.time, at: now.at, accuracy: now.accuracy, speed, gap: offRouteGap(now), along: now.along, furthest: now.furthest, lost: now.lost, doubt: now.doubt !== null }
      const before = offRef.current
      // The machine is told what the watch knows: whether the phone has been unseen, and whether it is still on its way to where the round
      // starts. The watch is kept before a carry-on below restarts the round, so that the restart's own reset of it is the one that stands.
      const step = stepWatched(watchRef.current, before, reading, reachAlong.current)
      watchRef.current = step.watch
      let state = step.state
      let event = step.event
      // Driving back towards where the route was left, without asking to be taken back, is being taken back: it does not carry on from here.
      if (event === 'carried-on' && before.phase === 'rejoined' && before.left && before.rejoin && Math.abs(now.along - before.left.along) <= Math.abs(before.rejoin.along - before.left.along) - CLOSING_M) {
        state = takeMeBack(before)
        event = null
        capRef.current = before.left.furthest
        lowerFurthest(before.left.furthest)
      }
      // Being guided back lasts until the driver is on the route again.
      guidedRef.current = state.phase === 'returning' || (state.phase === 'off' && guidedRef.current)
      offRef.current = state
      setOff(state)
      if (event === 'went-off') {
        // An alert that was showing is for a place the driver is no longer at: it goes, and may come up again when they are back. Not one for a stop
        // already behind the place the route was left at: that is gone by, and no longer alerts when they are back.
        const gone: Occurrence[] = []
        for (const o of queueRef.current) {
          if (state.left && !byPosition(o, radius) && o.at < state.left.along - slackFor(radius)) {
            gone.push(o)
            continue
          }
          seen.current.delete(o.key)
          announced.current.delete(o.key)
          heldRef.current.delete(o.key)
        }
        setQueue([])
        // A bundle among them was up with its Dropped button and went by with no tap, so it is missed, as on the road, and the list can still mark it
        // dropped. Earlier passes of it go with it (see `earlierPasses`), as they do when a pass goes by on the road.
        if (gone.length) {
          const keys = gone.map((o) => o.key)
          saveRound([...handledRef.current, ...keys, ...earlierPasses(occsRef.current, keys, handledRef.current)], savedFurthest.current, missedAmong(gone))
          const bundles = gone.filter((o) => o.stop.type === 'bundle')
          if (bundles.length) setToast({ message: missedNotice(bundles.map((o) => bundleNameOf(o.stop))) })
        }
      }
      if (event === 'back' && before.left) {
        // The turn that was missed is met again, so it is said again, wherever in view of the place the route was left it is: on a stretch of transit that is as far as the first cue, a kilometre.
        for (const key of [...saidTurn.current.keys()]) if (key >= before.left.along - TURN_KM_M) saidTurn.current.delete(key)
        if (forward) {
          // Stops in the stretch skipped over, if it was further on, are gone by, but for the bundles (see `caughtUp`); and the furthest reached, if it had gone on with a rejoin, is where the driver is.
          restartRef.current = before.left.along
          capRef.current = null
          const settle = Math.max(before.left.furthest, now.along)
          if (now.furthest > settle) lowerFurthest(settle)
        } else {
          // Coming back down the route, the stretch skipped over is still to be driven.
          restartRef.current = null
          capRef.current = before.left.furthest
          lowerFurthest(before.left.furthest)
        }
      }
      if (event === 'carried-on') {
        // Left alone for a minute on the new part, the round carries on from there, as if it had been skipped to, but for the bundles (see `restartedRound`),
        // and says so afterwards: the skip stops what is being said.
        restartAtRef.current(now.along, true, true)
        setToast({ message: 'Carrying on from here.' })
      }
      announceOff(event, reading, state)
    },
    [announceOff, lowerFurthest, saveRound],
  )

  // Each fix moves the driver along the route. Which way the phone is heading tells a return pass from the first, which lie on the
  // same road: it is the phone's own course while that is there (only while it is really moving), and otherwise the way it has
  // been going over the last few dozen metres, if that is clear. A fix that was set aside, or seen before, changes nothing.
  useEffect(() => {
    if (!fix) return
    // Every fix the phone gives is watched, whatever the tracker makes of it: a good one more than 10 s after the last means the phone was unseen
    // (in the background, or under poor sky) and may have driven on along the route. Fixes set aside, and those while standing still, count too:
    // they are what keep a stop from looking like a gap.
    watchRef.current = watchFix(watchRef.current, fix)
    const course = fix.heading ?? trailHeading(trail.current, fix.accuracy)
    const before = progressRef.current
    let now = advance(track, before, fix, course)
    if (!now || now === before) return
    // The way the route runs here, when the phone is on it, and whether the phone is going that way (or can't say).
    const routeBearing = onTheRoute(now.gap, now.accuracy, now.lost) ? (track.bearings[now.idx] ?? null) : null
    const forward = course === null || routeBearing === null || angleBetween(course, routeBearing) <= FORWARD_DEG
    forwardRef.current = forward
    // Being taken back to where the route was left, the furthest reached stays where it was then, until the driver is back there: it
    // would jump on with the place they came back onto the route at, and the turns on the way back would be hidden. Back on the route
    // and going on along it, it is let go.
    if (capRef.current !== null) {
      if (now.furthest > capRef.current) now = { ...now, furthest: capRef.current }
      if (now.along <= capRef.current || (offRef.current.phase === 'on' && forward)) capRef.current = null
    }
    progressRef.current = now
    speedRef.current = fix.speed ?? null
    trail.current = pushTrail(trail.current, { lat: now.at.lat, lng: now.at.lng, time: now.time ?? fix.time })
    setHeadingDeg(course)
    // The map's own heading: the course when there is one, held when there isn't, and from the route's own direction at the start.
    const dt = mapHeadingTime.current === null || fix.time === undefined ? 1 : (fix.time - mapHeadingTime.current) / 1000
    mapHeadingTime.current = fix.time ?? null
    setMapHeading((m) => holdHeading(m, course, routeBearing, dt))
    setProgress(now)
    // Off the route? Only for a fix that was taken in (not one the tracker set aside, which comes back as the old position), that moved
    // the phone or says it is going, once the round has started, and not once it is over: at the end of the route, or with every stop
    // done, the driver is going home.
    const stepped = lastStepAt.current
    const moving = (fix.speed ?? 0) >= 1.5 || !stepped || haversine(stepped, now.at) >= STEP_MOVED_M
    if (now.time !== before?.time && moving && startedRef.current) {
      lastStepAt.current = now.at
      if (finishedRef.current || now.furthest >= routeEndRef.current - END_QUIET_M) {
        if (offRef.current.phase !== 'on') {
          offRef.current = startOffRoute
          setOff(startOffRoute)
        }
      } else {
        weighOff(now, fix.speed ?? null, forward)
      }
    }
  }, [fix, track, weighOff])

  // After the route is edited from the road its points have new numbers: the driver's place is found again from how far along they are.
  useEffect(() => {
    const p = progressRef.current
    if (!p) return
    const next = rebaseProgress(track, p)
    progressRef.current = next
    setProgress(next)
  }, [track])

  // What is waiting to be shown is looked up again in the edited route, and a stop that no longer alerts goes. One that has just started
  // to alert, behind the driver, is one they have already gone by, so it counts as done and doesn't hold up the count; so is one whose
  // alert moved behind the driver with no leg ahead that it alerts on; one still to be passed on the other leg of a court, where it is
  // quiet, is left out instead, so taking the change back brings it back (see `keepAlertsAhead`).
  const alertsBefore = useRef(occs)
  useEffect(() => {
    const before = alertsBefore.current
    alertsBefore.current = occs
    const byKey = new Map(occs.map((o) => [o.key, o]))
    // A stop that stopped alerting, and may alert again (the change is taken back), is forgotten as one already seen and said.
    for (const { key } of before) {
      if (byKey.has(key)) continue
      seen.current.delete(key)
      announced.current.delete(key)
      heldRef.current.delete(key)
    }
    const waiting = queueRef.current
    // An alert up by place stays so (see `keepPlaced`): judged along the route it would be gone by, and missed, at once.
    const live = new Map(keepPlaced(occs, waiting).map((o) => [o.key, o]))
    const next = waiting.flatMap((o) => {
      const now = live.get(o.key)
      return now ? [now] : []
    })
    if (next.length !== waiting.length || next.some((o, i) => o !== waiting[i])) setQueue(next)
    const p = progressRef.current
    if (!p) return
    // What the change made of the passes at the head of a court is kept with the round at once, so Continue Round puts them back as they were (see `resumedLegs`).
    const kept = courtLegsOf(fresh, occs)
    if (!sameCourtLegs(kept, roundRef.current.courtLegs)) commitRound(withCourtLegs(roundRef.current, kept))
    const behind = keepAlertsAhead(route, allOccs, before, occs, p.along, radius).done.flatMap((key) => {
      const o = byKey.get(key)
      return o && !handledRef.current.has(key) ? [o] : []
    })
    // While a turn round is not sure yet, `p.along` is where the turn put the driver, which it may take back: a stop behind that but not behind
    // where it put them from is put by with the hold, as a stop gone by then is (see `holdLeftBehind`), and is done only once the turn is sure.
    const put = holdLeftBehind(turnHold.current, behind, slackFor(radius), radius)
    turnHold.current = put.hold
    const gone = put.now.map((o) => o.key)
    if (gone.length) saveRound([...handledRef.current, ...gone], savedFurthest.current)
  }, [occs, fresh, radius, saveRound, commitRound, route, allOccs])

  // The furthest reached is kept with the round a hundred metres at a time, so that carrying on later starts from there.
  useEffect(() => {
    if (!progress) return
    const far = Math.floor(progress.furthest / SAVE_EVERY_M) * SAVE_EVERY_M
    if (far <= savedFurthest.current) return
    savedFurthest.current = far
    saveRound([...handled], far)
  }, [progress, handled, saveRound])

  // What the driver is near. This runs for every move of the driver, and when the stops done, the route, the distance or the order of the bundles change.
  useEffect(() => {
    if (!progress) return
    // The first fix on the route after Continue Round (the place carried on from is only on paper): a house at the head of a court the driver is
    // between the two legs of, thrown on the leg ahead, is put there, once (see `legsOnResume`). The effect that follows the passes keeps that
    // with the round, and this one runs again with them. The updater keeps the legs' own `fresh`: in here `fresh` is the alerts coming up, declared below.
    if (resumeRef.current && !progress.lost) {
      resumeRef.current = false
      const moved = legsOnResume(route, allOccs, occs, handled, progress.along, radius)
      if (moved !== occs) {
        // Once, at the first fix on the route after Continue Round (the ref is cleared above), which the render cannot tell from the fixes after it.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLegs((l) => ({ fresh: l.fresh, occs: moved }))
        return
      }
    }
    const driverAt = progress.along
    const pos = progress.at

    // Only the bundle next in the driver's list alerts (see `gatedOccurrences`). One up that no longer is, after a reorder, a drop, a miss or an Undo, goes
    // without a word: not done, not missed, and it may alert again once it is next. It is gone before anything below can take it for driven past.
    const nextAtStart = nextBundleId(occs, roundRef.current, bundleOrder)
    const notNext = notNextAlerts(queueRef.current, nextAtStart)
    for (const o of notNext) {
      seen.current.delete(o.key)
      announced.current.delete(o.key)
      heldRef.current.delete(o.key)
    }
    if (notNext.length) setQueue((q) => q.filter((o) => !notNext.some((n) => n.key === o.key)))
    const up = notNext.length ? queueRef.current.filter((o) => !notNext.includes(o)) : queueRef.current

    // A turn round the tracker is not sure of yet (see turnHold.ts): the alerts up as it began are judged where the driver was put from, and a
    // stop along the route gone by meanwhile is put by, until the turn is sure (they are done) or undone (they are still to come, and may alert again).
    const step = stepForNext(stepTurnHold(turnHold.current, progress, up, track.cum[track.cum.length - 1] ?? 0), nextAtStart)
    for (const o of step.release) {
      seen.current.delete(o.key)
      announced.current.delete(o.key)
      heldRef.current.delete(o.key)
    }

    // An alert goes when you are away from its stop (only a bundle drop's has a button, Dropped, and it stays up till then). Driving on
    // past a stop counts it as done, and backing away from it first lets it alert again when you come back. A bundle drop driven past
    // like that, without Dropped, is recorded as missed. One fix too poor to say where the car is says nothing of a stop met by where it is.
    const placeFix = progress.accuracy <= POSITION_MAX_ACCURACY_M ? pos : undefined
    // A fix good enough to go by from one fix to the next: as good as the tracker needs to set aside a jump by itself, and with the tracker not doubting where it has put the
    // driver, as a good fix just after a throw leaves it, still at the thrown place. Any other can be thrown ahead of the car or back from it, so it does not end a bundle's alert
    // along the route: that stays up with its Dropped button, and the next good fix judges it.
    const goodFix = progress.accuracy <= OUTLIER_ACCURACY_M && progress.doubt === null
    const left = up.flatMap((o) => {
      const exit = zoneExit(o, judgedAt(o, driverAt, step.hold), radius, placeFix)
      if (exit && !goodFix && o.stop.type === 'bundle' && !byPosition(o, radius)) return []
      return exit ? [{ o, exit }] : []
    })
    const gone = new Set(left.map((l) => l.o.key))
    // While off the route, or on a part of it that is not where it was left, the place along the route is not where the driver is, so
    // going 'past' a stop along it says nothing: it may alert again. A stop away from the route is met by where the driver is, whatever the route says.
    // A bundle back on the route somewhere else is the exception: the phone is on the route and reading near, so its alert going by is a real pass, and
    // left forgotten it would stay next behind the car, and every bundle after it silent.
    const phase = offRef.current.phase
    const onRoute = phase === 'on'
    const backOn = phase === 'rejoined'
    const reallyPassed = (o: Occurrence) => onRoute || byPosition(o, radius) || (backOn && o.stop.type === 'bundle')
    let goneBy: Occurrence[] = []
    if (left.length) {
      setQueue((q) => q.filter((o) => !gone.has(o.key)))
      for (const l of left) {
        if (l.exit === 'back' || (l.exit === 'passed' && !reallyPassed(l.o))) {
          seen.current.delete(l.o.key)
          announced.current.delete(l.o.key)
          heldRef.current.delete(l.o.key)
        }
      }
      goneBy = left.filter((l) => l.exit === 'passed' && !handled.has(l.o.key) && reallyPassed(l.o)).map((l) => l.o)
    }
    const put = holdGoneBy(step.hold, goneBy, radius)
    turnHold.current = put.hold
    setTurnHeld(heldKeys(put.hold))
    // The stops done now, and those put by over a turn round that stood, in one save: `handled` is this render's, so a second save would undo the first.
    const settled = doneNow(put.now, step.settle, handled, onRoute || backOn, radius)
    const nameOf = (key: string) => bundleNames.get(key) ?? 'a bundle drop'
    let done: ReadonlySet<string> = handled
    if (settled.done.length) {
      // A pass of a bundle that goes by takes the earlier passes of the stop with it: those driven by while it was not next would keep it to do for ever.
      const keys = settled.done.map((o) => o.key)
      done = new Set([...handled, ...keys, ...earlierPasses(occs, keys, handled)])
      saveRound([...done], savedFurthest.current, settled.missed)
      if (settled.missed.length) setToast({ message: missedNotice(settled.missed.map(nameOf)) })
    }

    // A round just started or skipped to is at that spot only on paper, until the first fix says where the phone really is.
    if (progress.lost && progress.time === null) return
    // A next bundle the car has gone by with no alert (see `wentByUnseen`) is judged from one fix to the next, but not on the way to the route, off it, on a jump
    // along it that the off-route machine has yet to believe, or over a turn round not sure yet: where the driver is put along the route then says nothing of what they drove past.
    // Nor on a fix too poor to go by, thrown forward past a bundle the car has not got to: that says nothing of the stretch, which the next good fix judges whole.
    const reach = reachedAt(progress, put.hold)
    const offNow = offRef.current
    const judged = reachedRef.current && offNow.phase === 'on' && offNow.near === 0 && !put.hold
    // The first good fix on the route after the round was started or skipped to a spot finds the car some way past it, by the time it was
    // confirmed: the stops in between would be neither done nor alerting, so they count as gone by (if the car is not far from the spot). It builds on the stops
    // just done, for the same reason. A poorer fix waits for the next: it can be thrown past a house the car has not got to. No bundle counts: that fix is no proof the car
    // drove the stretch, as one crossing the road on the way to the spot has not, so a next bundle in it stays next, alerts by place if the car comes to it, and is told of below if it is left behind.
    const from = restartRef.current
    let unseen: string[] = []
    if (from !== null && !progress.lost && goodFix) {
      restartRef.current = null
      const ahead = progress.along - from
      if (ahead > 0 && ahead < CATCH_UP_M) {
        const gone = caughtUp(occs, done, progress.along, radius)
        if (gone.length) {
          done = new Set([...done, ...gone])
          saveRound([...done], savedFurthest.current)
        }
      }
    } else if (judged && goodFix && lastJudged.current && Math.abs(reach - lastJudged.current.reach) - haversine(lastJudged.current.at, pos) <= DRIVEN_SLACK_M) {
      unseen = wentByUnseen(occs, roundRef.current, bundleOrder, lastJudged.current.reach, reach, pos, radius, seen.current, firstLink(occs, lastJudged.current.next, settled.missed))
    }
    if (unseen.length) {
      done = new Set([...done, ...unseen, ...earlierPasses(occs, unseen, done)])
      saveRound([...done], savedFurthest.current, unseen)
      setToast({ message: missedNotice([...settled.missed, ...unseen].map(nameOf)) })
    }
    const next = nextBundleId(occs, roundRef.current, bundleOrder)
    lastJudged.current = !judged ? null : goodFix ? { reach, next, at: pos } : lastJudged.current
    // The passes that may alert, with the list as it stands after the stops done just now: a bundle next from this fix on alerts on this fix, if the car is beside it.
    const gated = gatedOccurrences(occs, next, done, reach, radius)
    const fresh = approachingOccurrences(driverAt, pos, gated, done, radius, progress.accuracy).filter((o) => !seen.current.has(o.key))
    let beepSeconds = 0
    if (fresh.length) {
      fresh.forEach((o) => seen.current.add(o.key))
      setQueue((q) => [...q, ...fresh])
      // A bundle alert is the thing to answer, and its Dropped button is where a sheet's Done is, so the sheets make way for it.
      if (fresh.some((o) => o.stop.type === 'bundle')) {
        setMenuOpen(false)
        setBundlesOpen(false)
      }
      const has = (type: StopType) => fresh.some((o) => o.stop.type === type)
      beepSeconds = has('nothrow') ? sound.noThrow() : has('request') ? sound.request() : has('block') ? sound.block() : sound.bundle()
    }
    // A next bundle the car has gone by, and not counted missed, stays next: the driver may mean to go back, or to take it on a later pass, and it alerts then. But every bundle after it
    // is silent while it is, even those still ahead, so the list must not stand still with nothing said: they are told once, as soon as it costs them a bundle (see `nextHoldsUp`), which
    // can be many kilometres before it is left behind for good (see `nextLeftBehind`), with nothing else said. That goes for one the list came to by itself as much as one that went by
    // while it was next: a first pass gone by with no tap leaves that stop next while the car goes by the bundles after it, and the list then comes to them behind it. Not for one the
    // driver moved to the top of the list when it was already behind the car (see `changeOrder`). Only on a fix that can say so, once the route has been reached. The memory (see
    // `mayTellBehind`) outlasts a skip or a carry-on, which is how a carry-on past the bundle is told of.
    if (reachedRef.current) {
      if (next !== null && (next !== listNext.current || (judged && goodFix && nextStillAhead(occs, next, done, driverAt, radius)))) mayTellBehind.current.add(next)
      if (next !== listNext.current) goneBefore.current = listNext.current === undefined ? new Set() : behindLast.current
      listNext.current = next
    }
    // Only from a fix that says where the car is: a poor one, thrown back, would have a pass gone by again when it never was.
    if (goodFix) {
      const behindNow = bundlesBehind(occs, driverAt, radius)
      if (judged) goneBefore.current = new Set([...goneBefore.current].filter((key) => behindNow.has(key)))
      behindLast.current = behindNow
    }
    // It waits its turn: for the bar, as it would push off a notice (Undo after a drop, or the name of a bundle just missed), and for the words of any alert, which would take its place:
    // those on this fix, and with the voice on those of a no-throw row held for the side, which can be named on any fix.
    const free = !barBusyRef.current && !settled.missed.length && !unseen.length && !fresh.length && (!voiceRef.current || heldRef.current.size === 0)
    if (judged && goodFix && free && next !== null && mayTellBehind.current.has(next) && !toldBehind.current.has(next) && !up.some((o) => o.stop.id === next && !gone.has(o.key))) {
      const behindCar = nextLeftBehind(occs, next, done, driverAt, pos)
      if (behindCar || nextHoldsUp(occs, next, done, driverAt, radius, goneBefore.current)) {
        toldBehind.current.add(next)
        const name = bundleNameOf(occs.find((o) => o.stop.id === next)?.stop ?? {})
        setToast({ message: behindCar ? leftBehindNotice(name) : stillNextNotice(name) })
        if (voiceRef.current) say(behindCar ? NEXT_BEHIND_SPEECH : stillNextSpeech(name))
      }
    }
    // The car into another named section, or out of the last. Only a fix that can say where the car is, as a thrown one would tell of a section it is nowhere near. A round over
    // needs none: the section ends where the last stop is done, wherever the car then goes.
    let sectionWords = ''
    if ((judged && goodFix && progress.gap <= SECTION_ROAD_M) || finishedRef.current) {
      const step = watchSection(sectionWatch.current, resolved.list, { along: driverAt, time: progress.time ?? 0, forward: forwardRef.current, routeEnd: track.cum[track.cum.length - 1] ?? 0, over: finishedRef.current })
      sectionWatch.current = step.watch
      if (step.note) {
        setSectionNote(step.note)
        sectionWords = sectionSpeech(step.note)
      }
    }
    if (!voiceRef.current) return
    // With the voice on, the side thrown is said as it changes, a few metres before the change so the word is done by then, and once
    // where the round starts. It is queued: it breaks in on another alert's words being said, which are said again in full after it (see
    // `CUT_GRACE_MS`), and a no-throw row and it are said in the order asked, neither cutting the other off (see `SayOptions.warning`).
    // The cue is stepped on every fix, but the word is asked for after the alerts' words of this fix, so a no-throw row that comes up as
    // the side changes is said first, before the house, and the side word right after it.
    const word = progress.lost ? null : sideCueRef.current.update(sideAt(route, progress.idx), sideAtAlong(route, track.cum, progress.along + sideLookAheadM(speedRef.current)), progress.along)
    const saySide = () => {
      if (word) say(sideWords(word), { queue: true, afterMs: beepSeconds * 1000, stale: () => sideCueRef.current.last() !== word })
      // Last of all: a section is not worth holding up a warning or a turn for, and the banner shows it either way.
      if (sectionWords) say(sectionWords, { minor: true, afterMs: beepSeconds * 1000 })
    }
    if (!fresh.length && heldRef.current.size === 0) {
      saySide()
      return
    }
    // The house numbers are said once the beep is over: a row of no-throw houses all together, the first time any of it comes up, and
    // only once the side thrown where the driver is takes in their side (until then they are held). Other stops are said as they come up.
    const plan = planVoice({
      route,
      allOccs,
      occs,
      handled: done,
      radius,
      queue: up.filter((o) => !gone.has(o.key)),
      fresh,
      announced: announced.current,
      held: heldRef.current,
      driver: { idx: progress.idx, along: progress.along, driven: progress.furthest, pos, heading: headingDeg },
    })
    for (const key of plan.announce) announced.current.add(key)
    heldRef.current = new Set(plan.held)
    // Said whole, so the next alert waits for them instead of cutting them short; a no-throw row is a warning, which cuts off any other
    // alert's words and goes before them, but waits for a side word being said or asked before it (see `SayOptions.warning`); on this fix
    // it is asked for before the side word. Left out if the driver has gone by all they name before their turn comes.
    // (`gated`, as a bundle up by place is never gone by: judged along the route its words would be dropped for being behind the car.)
    // A no-throw row that failed gets no second try once the car is level with it: named over the next houses it could be taken for one of them.
    // Other alerts keep theirs, as their words are of use for longer and missing words are what drivers notice.
    if (plan.text) say(plan.text, { urgent: true, whole: true, warning: plan.noThrow, afterMs: beepSeconds * 1000, stale: alertWordsStale(plan.announce, gated, () => progressRef.current, radius), retryStale: plan.noThrow ? alertWordsLevel(plan.announce, gated, () => progressRef.current, radius) : undefined })
    saySide()
  }, [progress, handled, occs, allOccs, route, track, radius, headingDeg, saveRound, bundleNames, bundleOrder, resolved])

  // The alert showing is for the nearest no-throw house still ahead, or else the nearest of the others. For a no-throw house it is for
  // the whole row it is in, numbers and all, so the driver sees at once which houses to leave out, with an apartment block still to come
  // in it (its papers are not hidden by the house), and the others that wait are counted (not those already gone by, which are only
  // waiting to go).
  const here0 = progress?.at ?? null
  // Not an alert held over a turn round not sure yet that the driver, put on the way back, has gone by: the banner would show it as passed (see `shownQueue`).
  const shown = shownQueue(queue, turnHeld, driven, along, here0, radius)
  const current = pickCurrent(shown, driven, along, here0, radius)
  const row = current ? houseRow(route, allOccs, occs, handled, current, radius) : []
  const blockAhead = bannerBlock(shown, current, driven, along, here0, radius)
  // A bundle's alert up behind another stop's banner keeps its Dropped button, in that banner.
  const bundleUp = bannerBundle(shown, current)
  const toDrop = current?.stop.type === 'bundle' ? current : bundleUp
  const waiting = bannerWaiting(shown, [...row, ...(blockAhead ? [blockAhead] : []), ...(bundleUp ? [bundleUp] : [])], driven, along, here0, radius)
  // On the map, the houses the alert is for stand out, with their numbers.
  const activeStops = row.map((o) => o.stop.id)
  // Off the route: a line from the phone to where the route was left, and how far and which way that is.
  const leftAt = off.left
  const guiding = (off.phase === 'off' || off.phase === 'returning') && progress && leftAt
  const leftPoint = guiding ? (snapAtDistance(route.points, leftAt.along)?.point ?? leftAt.at) : null
  const guide = guiding && leftPoint ? { from: progress.at, to: leftPoint } : null
  const guideInfo = guiding && leftPoint ? guideToLeft(progress.at, { ...leftAt, at: leftPoint }, headingDeg ?? mapHeading) : null
  // A stop off the route is met by where the driver is: its distance is how far off it is, and its side is the side it is on
  // as the driver comes up to it. One along the route has a distance and a side along the route.
  const ahead = current ? aheadOf(current, along, here0, radius) : 0
  const currentSide = current ? shownSide(route, allOccs, current, radius, headingDeg, here0) : null
  const blockSide = blockAhead ? shownSide(route, allOccs, blockAhead, radius, headingDeg, here0) : null

  // What the turn card shows, while the phone is on the route (and no Off the route banner is up) and its fix is good enough to say how
  // far along it is. Anywhere but a stretch of transit it is the next turn, once it is within 200 m. On transit it is always something:
  // the next turn however far off, or a straight that leads to it (or to the end of the route). A turn that comes up the other way to
  // the way the phone is heading is passed over for one that agrees with it, and one already passed does not return, so on a street
  // driven twice it is the turn for the pass being driven that shows (the next turn by place only when none agrees with the heading).
  // The turns are the named ones, so the street each leads into comes with it.
  const transit = side === 'transit'
  const onTrack = off.phase === 'on' && !!progress && onTheRoute(progress.gap, progress.accuracy, progress.lost)
  const guidance = guidanceToShow(named, { onTrack, transit, along, routeEnd: track.cum[track.cum.length - 1] ?? 0, heading: headingDeg, after: driven - TURN_PASSED_M, reached: driven })
  // The turn the card is for and the voice speaks of, however it is shown: the turn itself, or the turn a straight leads to.
  const guided = guidance ? guidedTurn(guidance) : null
  const nextAt = guided?.turn.at ?? null
  const nextAngle = guided?.turn.angle ?? 0
  const nextAhead = guided?.ahead ?? 0
  // The street it leads into, when that is known and is not the road already being driven.
  const nextStreet = guided?.turn.street ?? null

  // With the voice on, each turn is said twice: a warning when it comes into view, and the last word as it is reached. On a stretch of
  // transit it is also said at about a kilometre and at 500 m. Only the cue for where the turn is now is said, so a turn first met part
  // way in (as transit begins, or after a skip) is not told of with every cue it missed. With the voice off nothing is said, and
  // nothing is kept as said, so switching it on mid-way (see `changeVoice`) starts from where the turn is.
  const nextAtRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    nextAtRef.current = nextAt
  })
  useEffect(() => {
    if (!voice || nextAt === null) return
    const spoken = cueToSay({ angle: nextAngle, street: nextStreet }, nextAhead, saidTurn.current.get(turnKey(nextAt)) ?? null, transit)
    if (!spoken) return
    saidTurn.current.set(turnKey(nextAt), spoken.cue)
    // Dropped if the turn has been made, or another has come up, by the time the words would start.
    say(spoken.text, { stale: () => nextAtRef.current !== nextAt })
  }, [voice, nextAt, nextAngle, nextAhead, nextStreet, transit])
  // Leaving the round ends anything still being said, and the signal that keeps the audio link open.
  useEffect(
    () => () => {
      stopSpeaking()
      sound.stopKeepAlive()
    },
    [],
  )
  // Test Voice's words still to come go when the start screen does: the round starts, the voice goes off, or the Round tab is left.
  useEffect(
    () => () => {
      stopVoiceTest.current?.()
      stopVoiceTest.current = null
    },
    [started, voice],
  )
  // A call or Siri stops the audio, and with it the signal that keeps the car's audio open. Nothing else would bring it back until the next word was due.
  useEffect(() => {
    if (started && voice && keepAudio && fix) sound.nudge()
  }, [fix, started, voice, keepAudio])

  const changeVoice = (on: boolean) => {
    setVoice(on)
    saveVoiceTurns(on)
    if (!on) {
      stopSpeaking()
      sound.stopKeepAlive()
      return
    }
    // Said as the button is tapped, which is also what lets the phone speak later, when a turn comes up. When a
    // turn is due to be said just now, that is what is said, and it is not said again.
    sound.unlock()
    if (keepAudio) sound.startKeepAlive()
    unlockSpeech()
    // The side thrown is said again at the next fix, as it was not said while the voice was off.
    sideCueRef.current.reset()
    // An alert showing as the voice goes on is the first thing said, as it is what the driver needs to hear, whether or not it was said
    // before: a no-throw house only if the side thrown where the driver is takes it in, and otherwise it is held until it does.
    const showing = queue.filter((o) => !isGoneBy(o, driven, along, here0, radius))
    const plan = planVoice({
      route,
      allOccs,
      occs,
      handled,
      radius,
      queue: showing,
      fresh: showing,
      announced: new Set(),
      held: new Set(),
      driver: { idx: snapIdx, along, driven, pos: here0, heading: headingDeg },
    })
    heldRef.current = new Set(plan.held)
    if (plan.text) {
      for (const key of plan.announce) announced.current.add(key)
      const named = keepPlaced(occs, showing)
      say(plan.text, { urgent: true, whole: true, warning: plan.noThrow, stale: alertWordsStale(plan.announce, named, () => progressRef.current, radius), retryStale: plan.noThrow ? alertWordsLevel(plan.announce, named, () => progressRef.current, radius) : undefined })
      return
    }
    // On a stretch of transit that includes the turn a long way off, at the cue for where it is.
    const spoken = guided ? cueToSay({ angle: guided.turn.angle, street: nextStreet }, guided.ahead, saidTurn.current.get(turnKey(guided.turn.at)) ?? null, transit) : null
    if (guided && spoken) {
      saidTurn.current.set(turnKey(guided.turn.at), spoken.cue)
      say(spoken.text)
    } else {
      say('Voice on')
    }
  }

  const changeHeadingUp = (on: boolean) => {
    setHeadingUp(on)
    saveHeadingUp(on)
    // Turning the map to the way you are heading is for following you, so it brings the overview back to following. Either way, the map goes back to the driver.
    setFreeLook(false)
    if (on) setOverview(false)
  }

  const changeKeepAudio = (on: boolean) => {
    setKeepAudio(on)
    saveKeepAudioAwake(on)
    if (on && voice) sound.startKeepAlive()
    else sound.stopKeepAlive()
  }

  /** Test Voice: unlocks sound from the tap, starts the signal if it is on, and says the side words as the road would. */
  const tryVoice = () => {
    stopVoiceTest.current?.()
    sound.unlock()
    if (keepAudio) sound.startKeepAlive()
    unlockSpeech()
    stopVoiceTest.current = testVoice((word) => say(word, { queue: true }))
  }

  const changeAlertDistance = (distance: AlertDistance) => {
    setAlertDistance(distance)
    saveAlertDistance(distance)
  }

  /** On the road: pick another distance without going back to the start screen. */
  const pickDistance = async () => {
    const picked = await choose({
      title: 'Alert Distance',
      message: 'How close to a stop its alert comes up. It goes again once you are further away than this.',
      choices: ALERT_DISTANCES.map((d) => ({ value: String(d), label: `${d} m`, detail: d === alertDistance ? 'Current setting' : undefined })),
    })
    const metres = Number(picked)
    if (picked && isAlertDistance(metres)) changeAlertDistance(metres)
  }

  /**
   * Start, or skip, to `metres` along the route: the stops before it count as done and those after it as not done, and the driver
   * is taken to be there. At 0 it is a fresh start, which forgets everything, bundles dropped and missed included. Skipping while driving
   * keeps the heading the phone has. `keepBundles` is for carrying on from where the driver came back onto the route: the bundles stay as
   * they are (see `restartedRound`).
   */
  const restartAt = (metres: number, skip: boolean, keepBundles = false) => {
    // A turn round not sure yet is taken as it stands (see `endTurnHold`): what it held or put by that the driver has gone by is done, a bundle
    // among it missed, before the spot decides the stops (and keeps those before it so).
    const ended = doneNow([], endTurnHold(turnHold.current, progressRef.current?.along ?? 0, queueRef.current, radius), handledRef.current, true, radius)
    if (ended.done.length) saveRound([...handledRef.current, ...ended.done.map((o) => o.key)], savedFurthest.current, ended.missed)
    turnHold.current = null
    setTurnHeld(NOTHING_HELD)
    seen.current.clear()
    toldBehind.current.clear()
    // A carry-on is the same drive going on, so what has been told stands; a skip goes somewhere to drive it, and a section is told as it is come to.
    sectionWatch.current = keepBundles ? carriedOn(sectionWatch.current) : startedAt(metres)
    setSectionNote(null)
    if (!skip) {
      mayTellBehind.current.clear()
      listNext.current = undefined
    }
    // A skip back to a spot behind the car has no stretch to catch up: what is after the spot comes up again, as the question that came before it said.
    const skippedBack = skip && progressRef.current !== null && metres < progressRef.current.along
    const start = startProgress(track, metres)
    progressRef.current = start
    setProgress(start)
    if (!skip) {
      trail.current = []
      setHeadingDeg(null)
    }
    savedFurthest.current = metres
    startMRef.current = metres
    restartRef.current = metres > 0 && !skippedBack ? metres : null
    lastJudged.current = null
    resumeRef.current = false
    // A round started or skipped to a spot has not reached the route yet, and has not left it.
    offRef.current = startOffRoute
    setOff(startOffRoute)
    reachedRef.current = false
    watchRef.current = restartWatch(watchRef.current)
    reachAlong.current = metres
    reachRun.current = null
    lastStepAt.current = null
    capRef.current = null
    guidedRef.current = false
    saidTurn.current.clear()
    announced.current.clear()
    heldRef.current.clear()
    // The side where the round starts is said once the phone is there.
    sideCueRef.current.reset()
    stopSpeaking()
    setQueue([])
    // A pass kept on the leg of a court still ahead (see `keepAlertsAhead`) is kept so from the spot: a skip back before the court puts it
    // back on the way in, which the car passes again, and a fresh start (at 0) gives the passes as `alertable` has them.
    const based = keepAlertsAhead(route, allOccs, occs, fresh, metres, radius).occs
    setLegs({ fresh, occs: based })
    // Skipping keeps the bundles dropped or missed before the spot (and forgets those after it, which come up again); carrying on keeps them all; a fresh start forgets all.
    // What that makes of the passes at the head of a court is kept with the round, in place of what it had (a fresh start has none).
    const next = withCourtLegs(restartedRound(roundRef.current, based, metres, slackFor(radius), freshStart(skip, finishedRef.current || overButBundlesRef.current), keepBundles), courtLegsOf(fresh, based))
    // A drop that is kept can still be taken back whole, with every pass it settled, until the driver leaves the Round tab.
    beforeDrop.current = keptBeforeDrop(beforeDrop.current, next)
    commitRound(next)
  }

  useLayoutEffect(() => {
    restartAtRef.current = restartAt
  })

  /** Forget this run's progress, so every special stop counts as not done again. */
  const resetRun = () => restartAt(0, false)

  const reset = async () => {
    const ok = await confirm({
      title: 'Reset Round?',
      message: 'Every special stop will count as not done, so you can start the round again.',
      confirmLabel: 'Reset',
      destructive: true,
    })
    if (ok) resetRun()
  }

  /** The round is under way: sound is unlocked (it takes a tap), and the voice and the signal that keeps the car's audio open start. */
  const go = () => {
    sound.unlock()
    if (voice) {
      if (keepAudio) sound.startKeepAlive()
      unlockSpeech()
    }
    setStarted(true)
  }

  /** `fresh` starts a new run; otherwise an unfinished run carries on where it stopped. */
  const begin = (fresh: boolean) => {
    if (fresh) {
      resetRun()
    } else {
      // Carried on, so the driver is taken to be where the last stop done was (or where the round was started from), which tells the passes of a street driven twice apart.
      const carryOn = continueFrom(round, allOccs, handled)
      reachAlong.current = carryOn
      sectionWatch.current = RESUMED_WATCH
      watchRef.current = restartWatch(watchRef.current)
      const start = startProgress(track, carryOn)
      progressRef.current = start
      setProgress(start)
      trail.current = []
      announced.current.clear()
      heldRef.current.clear()
      sideCueRef.current.reset()
      // The passes at the head of a court are as a change of side left them, from what is kept with the round (see `resumedLegs`). The
      // first fix on the route then puts a house at the head of a court the driver is between the two legs of on the leg ahead (see `legsOnResume`).
      resumeRef.current = true
    }
    go()
  }

  /** Start a round part way along the route, from a spot or a section picked on the map. */
  const beginAt = (metres: number) => {
    restartAt(metres, false)
    setPicker(null)
    go()
  }

  /** What carrying on from `metres` along the route does to the stops: those before it not yet done count as done, and done ones after it come up again. With `keepBundles`, as it does, no bundle is among them. */
  const skipEffect = (metres: number, keepBundles = false): string => {
    const { newly, back } = restartEffect(round, occs, handled, metres, slackFor(radius), false, keepBundles)
    return [newly > 0 ? `${plural(newly, 'stop', 'stops')} before it will count as done.` : '', back > 0 ? `${plural(back, 'stop', 'stops')} after it will come up again.` : ''].filter(Boolean).join(' ')
  }

  /** Skip to a spot while driving, once what it does to the stops done has been seen. */
  const skipTo = async (metres: number, name: string) => {
    const ok = await confirm({ title: `Skip to ${name}?`, message: skipEffect(metres) || 'The round carries on from there.', confirmLabel: 'Skip' })
    if (!ok) return
    restartAt(metres, true)
    setPicker(null)
  }

  /** Back on the route somewhere else, and the driver says to carry on from here: as if that place had been skipped to, but for the bundles, as they may be going back for one. */
  const carryOnHereNow = () => {
    const p = progressRef.current
    if (!p) return
    restartAt(p.along, true, true)
  }

  /** Back on the route somewhere else, and the driver says to be taken back to where it was left: the guide carries on to there. */
  const takeBackNow = () => {
    const state = takeMeBack(offRef.current)
    offRef.current = state
    setOff(state)
    guidedRef.current = true
    capRef.current = state.left ? state.left.furthest : null
    // The furthest reached jumped on with the rejoin: it goes back, or the turns on the way back would not show.
    if (state.left) lowerFurthest(state.left.furthest)
  }

  /** Takes back a drop (Undo, in the bar or the list): the bundle is as it was before, and alerts again if the driver is still at it. */
  const takeBackDrop = (key: string) => {
    const before = beforeDrop.current.get(key)
    beforeDrop.current.delete(key)
    commitRound(restoreBundle(roundRef.current, key, before ?? false))
    // The other passes of the stop that the drop had settled come back too, and may alert again.
    for (const k of before?.keys() ?? [key]) {
      seen.current.delete(k)
      announced.current.delete(k)
      heldRef.current.delete(k)
    }
  }

  /** A bundle is dropped: the pass, and any other pass of the same stop (a street driven twice is one delivery), are done and need no alert. */
  const dropBundle = (key: string) => {
    const others = otherPasses(occs, key)
    beforeDrop.current.set(key, passStates(roundRef.current, [key, ...others]))
    commitRound(markDropped(roundRef.current, key, others))
    const settled = new Set([key, ...others])
    setQueue((q) => q.filter((x) => !settled.has(x.key)))
  }

  /**
   * The driver tapped Dropped on a bundle's alert: it is done and dropped, so the alert goes, a quiet tone says the tap was taken, and the
   * bar says so with a way to undo it. With the voice on, the bundle after it is named once the tone is over.
   */
  const dropFromAlert = (o: Occurrence) => {
    // A second tap straight after the first lands on the alert of the next bundle at the same spot, which is not delivered yet.
    const now = Date.now()
    if (!dropAllowed(lastDropAt.current, now)) return
    lastDropAt.current = now
    const key = o.key
    dropBundle(key)
    const seconds = sound.dropped()
    setToast({ message: 'Dropped', undo: () => takeBackDrop(key) })
    if (!voiceRef.current) return
    // The next is the next in the driver's own order, wherever it is, with how far it is in a straight line.
    const next = nextInOrder(bundleRows(occs, roundRef.current, bundleOrder, phoneAt))
    if (next) say(nextBundleSpeech(next), { afterMs: seconds * 1000 })
  }

  /** "Mark dropped" in the list, for a bundle that was missed or is still to come. The list has its Undo. */
  const markFromList = (key: string) => {
    if (roundRef.current.dropped?.includes(key)) return
    // An alert that was up for it has no more to ask.
    dropBundle(key)
    sound.dropped()
  }

  /**
   * A new order from the Bundles list. One that changes the bundle next is the driver's own decision about both, so nothing from before stands for either. The one taken off the top is
   * forgotten as told of: driven past after that, it is not told of unless the list comes back to it by itself, and then it is, even if it was before. The one put on top does not count as
   * come to by itself: already behind the car it is not told of, and with a pass ahead it goes back in with the next fix (see `mayTellBehind`). It answers only for what the car goes by
   * from here on (see `nextHoldsUp`), so the driver is not told straight back of what they have just decided. Before the route is reached nothing is known of where the car is, so the
   * bundle next then counts as come to, whichever it is.
   */
  const changeOrder = (order: string[]) => {
    const was = nextBundleId(occs, roundRef.current, bundleOrder)
    const now = nextBundleId(occs, roundRef.current, order)
    if (was !== now) {
      if (was !== null) toldBehind.current.delete(was)
      if (now !== null) {
        toldBehind.current.delete(now)
        mayTellBehind.current.delete(now)
      }
      listNext.current = reachedRef.current ? now : undefined
      goneBefore.current = behindLast.current
    }
    onBundleOrder(order)
  }

  // A section's banner has its time on the screen: the list, the menu, the picker and a question cover the map, so it waits for them to close, for a while.
  const sectionCovered = bundlesOpen || menuOpen || picker !== null || dialog !== null
  useEffect(() => {
    if (!sectionNote) return
    const id = setTimeout(() => setSectionNote(null), sectionCovered ? SECTION_HOLD_MS : SECTION_NOTE_MS)
    return () => clearTimeout(id)
  }, [sectionNote, sectionCovered])

  /** Message for a while, or until it is taken back. */
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), toast.undo ? UNDO_MS : NOTE_MS)
    return () => clearTimeout(id)
  }, [toast])

  // How much of the map the bar along the bottom covers, kept up to date as it grows (a long notice) or the phone is turned, so the
  // driver's dot in the turned map and the fit of the whole route stay clear of it. The first reading comes before the screen is painted.
  useLayoutEffect(() => {
    if (!screenEl || !barEl) return
    const measure = () => {
      const px = barCover(screenEl.getBoundingClientRect().bottom, barEl.getBoundingClientRect().top)
      if (px !== null) setCoverPx(px)
    }
    const watcher = new ResizeObserver(measure)
    watcher.observe(barEl)
    watcher.observe(screenEl)
    return () => watcher.disconnect()
  }, [screenEl, barEl])

  // Free look ends fifteen seconds after the driver last touched the map: every move of theirs starts the wait again, and leaving free
  // look (re-centring, the whole route, the compass) or leaving the screen puts the wait away.
  useEffect(() => {
    if (!freeLook) return
    const id = setTimeout(() => setFreeLook(false), FREE_LOOK_MS)
    return () => clearTimeout(id)
  }, [freeLook, lastMove])

  /** The driver moved the map themselves: a drag of the north-up map pauses following, and a zoom never does (see `afterUserMove`). */
  const userMoved = (kind: 'drag' | 'zoom') => {
    const change = afterUserMove(kind, { overview, headingUp, freeLook })
    if (change.freeLook !== freeLook) setFreeLook(change.freeLook)
    if (change.restart) setLastMove((n) => n + 1)
  }

  /**
   * A step in or out about the middle of the map, which is the driver's dot while they are followed. The buttons are not on the map, so
   * it doesn't tell of a press as it does of a pinch: a press is the driver's hand on the map all the same, and while they are looking
   * around it starts the wait before following again afresh.
   */
  const zoomBy = (by: 1 | -1) => {
    setView((v) => ({ key: (v?.key ?? 0) + 1, zoomBy: by }))
    userMoved('zoom')
  }

  /** The whole route in view: north up, and no longer looking around. */
  const showWholeRoute = () => {
    setOverview(true)
    setFreeLook(false)
  }

  /** Back to following the driver at the zoom they have (from the whole route it is street level). */
  const followMe = () => {
    setOverview(false)
    setFreeLook(false)
  }

  /** The throw side of the part of the route being driven, when it was put in wrongly: only that part changes, not the whole stretch. */
  const changeSide = async () => {
    if (!progress || !onTheRoute(progress.gap, progress.accuracy, progress.lost)) {
      return setToast({ message: "Can't tell where you are on the route yet, so the side can't be changed here." })
    }
    const { stretch, extents } = sideExtents(route, turns, resolved.list, along)
    if (!stretch || extents.length === 0) return setToast({ message: 'There is no part of the route here to change.' })
    const side = await choose<Side>({
      title: 'Change the Throw Side',
      message: `This stretch is set to ${SIDE_LABEL[stretch.side]}. Change it to:`,
      choices: SIDES.filter((s) => s !== stretch.side).map((s) => ({ value: s, label: SIDE_LABEL[s] })),
    })
    if (!side) return
    const key = await choose<ExtentKey>({
      title: 'How Much of It?',
      message: 'Only the part you pick changes, not the rest of the stretch.',
      choices: extents.map((e) => ({ value: e.key, label: e.label, detail: e.detail })),
    })
    const extent = extents.find((e) => e.key === key)
    if (!extent) return
    // The sheets took a while and the car has moved on: a part that is from here on starts where the car is now, not where the side was tapped.
    const here = progressRef.current?.along ?? extent.fromM
    const fromM = extent.key === 'toTurn' || extent.key === 'toStretchEnd' ? Math.max(extent.fromM, here) : extent.fromM
    const next = paintMetres(route, fromM, extent.toM, side)
    if (!next) return setToast({ message: 'There is not enough of that part left ahead of you to change.' })
    onAdjustRoute(next)
    const said = `${extent.label}: now ${SIDE_LABEL[side]}.`
    // Undo puts the route back as it was.
    const undo = () => onAdjustRoute(route)
    setToast({ message: said, undo })
    // Counting the houses that go quiet or start to alert takes a moment on a long round, so it follows the message rather than holding it up.
    setTimeout(() => {
      const note = sideChangeNote(route, next, reachM)
      // Houses that start to alert behind the car are counted done at once, so the driver is told they won't alert.
      const full = note && /alert/.test(note) ? `${note} (any already behind you count as done)` : note
      if (full) setToast((t) => (t && t.undo === undo ? { ...t, message: `${said} ${full}` } : t))
    }, 0)
  }

  if (route.points.length < 2) {
    return (
      <div className="screen plain">
        <div className="hero">
          <div className="hero-icon muted">
            <Icon name="map" size={42} strokeWidth={1.7} />
          </div>
          <h1>No Route Yet</h1>
          <RouteChip name={routeName} onClick={onGoRoutes} />
          <p>Draw this route on the map in Setup. You don't need to drive it first.</p>
          <button className="btn primary" onClick={onGoSetup}>
            Go to Setup
          </button>
        </div>
      </div>
    )
  }

  if (!started && picker === 'start') {
    return (
      <div className="screen">
        {/* A start on a round over but for its bundles is a new round (see `freshStart`), so the picker works out what the spot does from none, or what it said would not be what happens. */}
        <StartPicker route={route} sections={sections} occs={occs} handled={handled} round={overButBundles ? { handledStopIds: [] } : round} slack={slackFor(radius)} position={fix} mode="start" onPick={(m) => beginAt(m)} onClose={() => setPicker(null)} />
        {dialog}
      </div>
    )
  }

  /** Bundle drop order: the list with its Reorder, of the round kept while it has bundles to move and is not over but for them, and otherwise of the next round. */
  const openBundleOrder = () => {
    setOrderForNext(overButBundles || bundlesLeft(rows) < 2)
    setBundlesOpen(true)
  }

  if (!started) {
    const startButtons = (
      <>
        {partial ? (
          <>
            <button className="btn primary block" onClick={() => begin(false)}>
              Continue Round
            </button>
            <button className="btn plain" onClick={() => begin(true)}>
              Start Over
            </button>
          </>
        ) : (
          <>
            <button className="btn primary block" onClick={() => begin(true)}>
              {finished || overButBundles ? 'Start New Round' : 'Start Round'}
            </button>
            {overButBundles && (
              <button className="btn plain" onClick={() => begin(false)}>
                Continue Round
              </button>
            )}
          </>
        )}
        <button className="btn secondary block" onClick={() => setPicker('start')}>
          <Icon name="flag" size={18} />
          Choose Where to Start
        </button>
      </>
    )
    return (
      <>
        <div className="screen plain">
          <div className="hero">
            <div className="hero-icon">
              <Icon name="navigation" size={42} strokeWidth={1.7} fill />
            </div>
            <h1>Ready to Deliver</h1>
            <RouteChip name={routeName} onClick={onGoRoutes} />
            <p>
              {formatDistance(routeLength(route.points))} · {plural(total, 'special stop', 'special stops')}
              {partial && ` · ${done} of ${total} done`}
              {partial && carryOn > 0 && ` · carries on from ${formatDistance(carryOn)}`}
            </p>
            {/* A round to carry on has these first: nothing alerts until one is tapped, and what to load is for the start of a round. */}
            {partial && startButtons}
            {finished && <p className="fine">Your last round is finished, so this will start a new one.</p>}
            {overButBundles && <p className="fine">Your last round reached the end with {plural(bundlesLeft(rows), 'bundle drop', 'bundle drops')} still to do, so this will start a new one.</p>}
            <p className="fine">
              You'll only be alerted for bundle drops, no‑throw houses, special requests and apartment blocks. Keep the phone unlocked and mounted, because GPS pauses when the screen is off.
            </p>
            <LoadCard load={load} onLoad={onLoad} />
            {rows.length >= 2 && (
              <button className="btn secondary block" onClick={openBundleOrder}>
                <Icon name="list" size={18} />
                Bundle drop order
              </button>
            )}
            <div className="alert-setting">
              <div className="brush-label">Alert distance</div>
              <Segmented
                label="How close to a stop its alert comes up, in metres"
                value={String(alertDistance)}
                options={ALERT_DISTANCES.map((d) => ({ value: String(d), label: String(d) }))}
                onChange={(v) => changeAlertDistance(Number(v) as AlertDistance)}
              />
              <p className="fine">
                In metres. An alert comes up when you are within {alertDistance} m of a stop, and goes by itself once you are further away than that.
              </p>
            </div>
            {speechAvailable() && (
              <div className="alert-setting">
                <div className="brush-label">Voice</div>
                <Segmented
                  label="Whether turns, house numbers, and leaving or rejoining the route are said out loud"
                  value={voice ? 'on' : 'off'}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'on', label: 'On' },
                  ]}
                  onChange={(v) => changeVoice(v === 'on')}
                />
                <p className="fine">Turns always show as an arrow on the map. With the voice on it says them out loud too, and the numbers of the houses to look for, and when you leave the route or are back on it.</p>
                {voice && (
                  <>
                    <button className="btn secondary block" data-on={keepAudio || undefined} aria-pressed={keepAudio} onClick={() => changeKeepAudio(!keepAudio)}>
                      <Icon name={keepAudio ? 'check' : 'volume-x'} size={18} />
                      Keep car audio awake
                    </button>
                    <p className="fine">Plays a sound too quiet to hear, so a car or speaker doesn't cut off the start of the voice.</p>
                    <button className="btn secondary block" onClick={tryVoice}>
                      <Icon name="volume-2" size={18} />
                      Test Voice
                    </button>
                    <p className="fine">Says the throw side words one at a time with a silence between them, as they come on the road. Try it over the car's speakers before you set off.</p>
                  </>
                )}
              </div>
            )}
            {missingStreets > 0 && (
              <p className="fine">
                {plural(missingStreets, 'turn has', 'turns have')} no street name yet. Look them up in Setup, under Route, and the turns will say where they lead.
              </p>
            )}
            {!partial && startButtons}
          </div>
          {dialog}
        </div>
        {/* Beside the scrolling screen, not in it: the sheet's scrim fills what it is in, which scrolled would take it off the screen. */}
        {bundlesOpen && (
          <div className="screen">
            <BundlesSheet
              rows={orderForNext ? nextRoundRows(occs, bundleOrder, phoneAt) : rows}
              heading={orderForNext ? 'Bundles, next round' : undefined}
              order={bundleOrder}
              onOrder={changeOrder}
              onClose={() => setBundlesOpen(false)}
              onMark={markFromList}
              onUndo={takeBackDrop}
            />
          </div>
        )}
      </>
    )
  }

  return (
    <div className="screen" ref={setScreenEl}>
      <MapView
        route={route}
        position={fix}
        handled={handled}
        reachM={reachM}
        drivenM={driven}
        active={activeStops}
        follow={!overview}
        paused={freeLook}
        fitPosition
        bottomPx={coverPx}
        headingUp={headingUp}
        heading={mapHeading}
        guide={guide}
        view={view}
        onUserMove={userMoved}
        outsideCredit
      />

      {/* The way the phone is heading, while it can say. It stays when the turn card does not (off the route, say). */}
      {headingDeg !== null && <HeadingBadge heading={headingDeg} turned={headingUp && !overview && mapHeading !== null} />}

      <div className="map-top">
        {/* The side and the next turn stay at the top where they are, and an alert drops in under them, so nothing jumps about. */}
        <div className="hud-row">
          {/* Tapping the side changes it for the part of the route being driven, if it was put in wrongly. */}
          <button
            className="side-pill"
            style={{ background: SIDE_PILL[side] }}
            aria-label={`Throw side: ${SIDE_LABEL[side]}. Tap to change it for the part you are driving.`}
            onClick={() => void changeSide()}
          >
            {side === 'transit' && <Icon name="slash" size={20} strokeWidth={2.5} />}
            {(side === 'left' || side === 'both') && <Icon name="arrow-left" size={20} strokeWidth={2.5} />}
            {SIDE_SHORT[side]}
            {(side === 'right' || side === 'both') && <Icon name="arrow-right" size={20} strokeWidth={2.5} />}
          </button>
          {/* A turn in sight is a card of its own; a straight on a stretch of transit stays one card, counting down. */}
          {guidance && <TurnCard key={guidance.kind === 'turn' ? guidance.turn.at : 'straight'} {...guidance} street={nextStreet} />}
        </div>
        {off.phase !== 'on' && progress && (
          <OffRouteBanner
            phase={off.phase}
            metres={guideInfo?.metres}
            where={guideInfo?.where ?? null}
            moved={off.left ? progress.along - off.left.along : 0}
            leftAt={off.left?.along}
            nowAt={progress.along}
            effect={off.phase === 'rejoined' ? skipEffect(progress.along, true) : undefined}
            onCarryOn={carryOnHereNow}
            onTakeBack={takeBackNow}
          />
        )}
        {current && (
          <AlertBanner
            // A row of no-throw houses keeps the one banner as each is passed, instead of it dropping in again at every house.
            key={current.stop.type === 'nothrow' ? 'nothrow' : current.key}
            stops={row.map((o) => o.stop)}
            pass={Number(current.key.split('#')[1] ?? 1)}
            ahead={ahead}
            side={currentSide}
            waiting={waiting}
            onDropped={toDrop ? () => dropFromAlert(toDrop) : undefined}
            blockAhead={blockAhead ? { stop: blockAhead.stop, side: blockSide } : undefined}
            bundleUp={bundleUp?.stop}
          />
        )}
        {sectionNote && !sectionCovered && <SectionBanner {...sectionNote} />}
      </div>

      {/* The bottom is kept slim: the few buttons for driving and the map's credit over one bar, which also carries any notice or GPS problem, so the top stays for what the driver is looking out for. */}
      <div className="round-bottom">
        <div className="round-aside">
          <MapCredit compact />
          <RoundButtons
            recentre={freeLook || overview}
            headingUp={headingUp && !overview}
            voice={voice}
            canSpeak={speechAvailable()}
            onZoom={zoomBy}
            onFollow={followMe}
            onCompass={() => changeHeadingUp(overview ? true : !headingUp)}
            onVoice={() => changeVoice(!voice)}
          />
        </div>
        <RoundBar
          ref={setBarEl}
          remaining={remaining}
          alertDistance={alertDistance}
          located={!!fix}
          notice={toast}
          onNoticeDone={() => setToast(null)}
          problem={error}
          caution={wake ? null : WAKE_CAUTION}
          onCaution={(message) => setToast({ message })}
          nextBundle={barNext}
          onBundles={() => setBundlesOpen(true)}
          onMenu={() => setMenuOpen(true)}
        />
      </div>

      {menuOpen && (
        <RoundMenu
          alertDistance={alertDistance}
          onClose={() => setMenuOpen(false)}
          onWholeRoute={showWholeRoute}
          onSkip={() => setPicker('jump')}
          onAlertDistance={() => void pickDistance()}
          onReset={() => void reset()}
          onBundles={() => setBundlesOpen(true)}
        />
      )}

      {bundlesOpen && <BundlesSheet rows={rows} order={bundleOrder} onOrder={changeOrder} onClose={() => setBundlesOpen(false)} onMark={markFromList} onUndo={takeBackDrop} />}

      {picker === 'jump' && (
        <StartPicker route={route} sections={sections} occs={occs} handled={handled} round={round} slack={slackFor(radius)} position={fix} mode="jump" onPick={(m, name) => void skipTo(m, name)} onClose={() => setPicker(null)} />
      )}
      {dialog}
    </div>
  )
}
