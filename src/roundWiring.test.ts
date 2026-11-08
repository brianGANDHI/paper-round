/// <reference types="node" />
import { isValidElement, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlertBanner } from './AlertBanner'
import App from './App'
import { freshStart, restartEffect } from './bundleFlow'
import { BundlesSheet } from './BundlesSheet'
import { bundleRows, bundlesLeft, markDropped, NEXT_BEHIND_SPEECH, stillNextSpeech } from './bundles'
import type { Fix } from './device'
import { occurrences } from './geo'
import { DEFAULT_LOAD } from './load'
import { LoadCard } from './LoadCard'
import { Round } from './Round'
import { OffRouteBanner } from './OffRouteBanner'
import { RoundBar, RoundButtons } from './RoundBar'
import { RoundMenu } from './RoundMenu'
import { SectionBanner } from './SectionBanner'
import { VOICE_TEST_GAP_MS, sideWords } from './sideVoice'
import { sound } from './sound'
import { say, stopSpeaking, unlockSpeech } from './speech'
import { StartPicker } from './StartPicker'
import type { LoadList, NamedSection, Pt, RoundState, Route, Stop } from './types'
import { Segmented } from './ui'

/*
 * The round screen itself, not a copy of its steps. The other tests of the round replay what its effects do; this one plays the real `Round` (and `App`)
 * through its real effects, so it finds a step left out, or put in the wrong order, in the screen. Nothing is mounted (the tests have no page): as in
 * loadCard.test.ts, React's hooks are played by the test, which calls the screen as a plain function, runs the effects whose dependencies changed, and
 * calls it again until nothing changes. What it would draw is read from the elements it returns, and a tap is a call of the handler on one of them. Only
 * what is outside the app is pretend: the GPS, the sound, the speech engine and the map.
 */
const play = vi.hoisted(() => ({
  slots: [] as unknown[],
  at: 0,
  /** A state changed, so the screen is to be called again. */
  dirty: false,
  layout: [] as { cell: { deps?: readonly unknown[]; cleanup?: void | (() => void) }; run: () => void | (() => void); deps?: readonly unknown[] }[],
  passive: [] as { cell: { deps?: readonly unknown[]; cleanup?: void | (() => void) }; run: () => void | (() => void); deps?: readonly unknown[] }[],
  fix: null as unknown,
  /** What happens after the effects of the next call and before the one they asked for, as a tap can. */
  between: null as null | (() => void),
  voice: true,
  keepAudio: true,
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const slot = <T>(make: () => T): T => {
    const i = play.at++
    if (!(i in play.slots)) play.slots[i] = make()
    return play.slots[i] as T
  }
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  const effect = (list: typeof play.layout) => (run: () => void | (() => void), deps?: readonly unknown[]) => {
    const cell = slot((): (typeof play.layout)[number]['cell'] => ({}))
    if (!same(cell.deps, deps)) list.push({ cell, run, deps })
  }
  const memo = <T>(make: () => T, deps: readonly unknown[]): T => {
    const cell = slot((): { deps?: readonly unknown[]; value?: T } => ({}))
    if (!same(cell.deps, deps)) {
      cell.value = make()
      cell.deps = deps
    }
    return cell.value as T
  }
  return {
    ...actual,
    useState: <T>(init: T | (() => T)) => {
      const cell = slot(() => {
        const made: { value: T; set?: (next: T | ((was: T) => T)) => void } = { value: typeof init === 'function' ? (init as () => T)() : init }
        made.set = (next) => {
          const value = typeof next === 'function' ? (next as (was: T) => T)(made.value) : next
          if (Object.is(value, made.value)) return
          made.value = value
          play.dirty = true
        }
        return made
      })
      return [cell.value, cell.set]
    },
    useRef: <T>(init: T) => slot(() => ({ current: init })),
    useMemo: memo,
    useCallback: <T>(fn: T, deps: readonly unknown[]) => memo(() => fn, deps),
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => effect(play.passive)(run, deps),
    useLayoutEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => effect(play.layout)(run, deps),
  }
})
vi.mock('./device', () => ({ useGps: () => ({ fix: play.fix, error: null }), useWakeLock: () => true }))
vi.mock('./MapView', () => ({ MapView: () => null }))
vi.mock('./Setup', () => ({ Setup: () => null }))
vi.mock('./Routes', () => ({ Routes: () => null }))
vi.mock('./storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./storage')>()),
  loadVoiceTurns: () => play.voice,
  loadKeepAudioAwake: () => play.keepAudio,
}))
vi.mock('./sound', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sound')>()),
  sound: Object.fromEntries(
    [['unlock'], ['startKeepAlive'], ['stopKeepAlive'], ['nudge'], ['bundle', 0.3], ['noThrow', 0.3], ['request', 0.3], ['block', 0.3], ['dropped', 0.18], ['offRoute', 0.3]].map(([name, seconds]) => [name, vi.fn(() => seconds)]),
  ),
}))
vi.mock('./speech', () => ({ say: vi.fn(), speechAvailable: () => true, stopSpeaking: vi.fn(), unlockSpeech: vi.fn() }))

/** Calls `component` until nothing changes, running the effects each time as a page would, and gives back what it would draw last. */
function settle(component: () => unknown): unknown {
  for (let turn = 0; turn < 100; turn++) {
    let drawn: unknown
    do {
      play.dirty = false
      play.at = 0
      play.layout = []
      play.passive = []
      drawn = component()
    } while (play.dirty)
    for (const list of [play.layout, play.passive]) {
      for (const e of list) {
        if (typeof e.cell.cleanup === 'function') e.cell.cleanup()
        e.cell.cleanup = e.run()
        e.cell.deps = e.deps
      }
    }
    const between = play.between
    play.between = null
    between?.()
    if (!play.dirty) return drawn
  }
  throw new Error('The screen never settled')
}

/** Every element under `node`, in order, without calling any component. */
function* elements(node: unknown): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) {
    for (const n of node) yield* elements(n)
  } else if (isValidElement<Record<string, unknown>>(node)) {
    yield node
    yield* elements(node.props.children)
  }
}
/** The words directly in an element. */
const words = (e: ReactElement<Record<string, unknown>>): string =>
  [e.props.children].flat(3).filter((c): c is string => typeof c === 'string').join('')

// A place in Sydney, so the maths is checked away from the equator and the prime meridian.
const ORIGIN = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
const cos = (deg: number) => Math.cos((deg * Math.PI) / 180)
type XY = [number, number]
const spot = ([x, y]: readonly [number, number]): Pt => ({ lat: ORIGIN.lat + y / M_PER_DEG, lng: ORIGIN.lng + x / (M_PER_DEG * cos(ORIGIN.lat)) })

const bundle = (id: string, xy: XY): Stop => ({ id, type: 'bundle', pathIdx: 0, label: id, qty: 10, ...spot(xy) })
const routeOf = (points: XY[], stops: Stop[]): Route => ({ points: points.map(spot), sideChanges: [{ idx: 0, side: 'both' }], stops })

interface Step {
  x: number
  y: number
  speed: number
  heading: number
  /** How far the fix may be out, in metres, when it is not the usual 8. */
  accuracy?: number
}
/** The car's fixes, one a second, along a straight line at about `speed`, landing on `to`. */
function line(from: XY, to: XY, speed: number): Step[] {
  const count = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / speed - 1e-9)
  const heading = ((Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI + 360) % 360
  return Array.from({ length: count }, (_, k) => ({ x: from[0] + ((to[0] - from[0]) * (k + 1)) / count, y: from[1] + ((to[1] - from[1]) * (k + 1)) / count, speed, heading }))
}
const legs = (speed: number, ...spots: XY[]): Step[] => spots.slice(1).flatMap((to, i) => line(spots[i], to, speed))

/**
 * The round screen on a route, with what `App` does for it: a round, an order and a list that come back as props. The car and the driver's taps go in
 * through what the screen uses, and each is settled before the next.
 */
function roundScreen(route: Route, { order, round = { handledStopIds: [] }, load, sections = [] }: { order?: string[]; round?: RoundState; load?: LoadList; sections?: NamedSection[] } = {}) {
  play.slots = []
  play.fix = null
  let time = 1_000_000
  const loads: LoadList[] = []
  /** Every notice the bar has shown on a fix, in turn: one goes by itself after a few seconds of driving. */
  const notices: string[] = []
  const props: Parameters<typeof Round>[0] = {
    route,
    round,
    routeName: 'Test',
    sections,
    streets: [],
    bundleOrder: order,
    load,
    onBundleOrder: (next) => {
      props.bundleOrder = next
      play.dirty = true
    },
    onLoad: (list) => loads.push(list),
    onRound: (next) => {
      props.round = next
      play.dirty = true
    },
    onAdjustRoute: () => {},
    onGoSetup: () => {},
    onGoRoutes: () => {},
  }
  let drawn: unknown = settle(() => Round(props))
  const update = () => (drawn = settle(() => Round(props)))
  const all = () => [...elements(drawn)]
  const find = <P,>(type: unknown): P | undefined => all().find((e) => e.type === type)?.props as P | undefined
  const button = (name: string) => all().find((e) => e.type === 'button' && words(e).includes(name))
  return {
    props,
    loads,
    all,
    find,
    button,
    /** Taps the button with these words on it. */
    press(name: string) {
      const b = button(name)
      if (!b) throw new Error(`No button says ${name}`)
      ;(b.props.onClick as () => void)()
      update()
    },
    drive(steps: Step[]) {
      for (const f of steps) {
        time += 1000
        vi.advanceTimersByTime(1000)
        play.fix = { ...spot([f.x, f.y]), accuracy: f.accuracy ?? 8, heading: f.speed >= 1.5 ? f.heading : null, speed: f.speed, time } satisfies Fix
        update()
        const shown = find<Parameters<typeof RoundBar>[0]>(RoundBar)?.notice?.message
        if (shown && shown !== notices.at(-1)) notices.push(shown)
      }
    },
    /** The phone gives no fix for this many seconds, as under poor sky. */
    noFixFor(seconds: number) {
      time += seconds * 1000
      vi.advanceTimersByTime(seconds * 1000)
    },
    /** A fix and a change that comes in as a prop right after it, before the screen has been called with the fix's place: React gives the effects both at once. */
    driveWith(next: Partial<typeof props>, step: Step) {
      play.between = () => {
        Object.assign(props, next)
        play.dirty = true
      }
      this.drive([step])
    },
    /** A change that comes in as a prop, such as the side of the road being changed. */
    change(next: Partial<typeof props>) {
      Object.assign(props, next)
      update()
    },
    update,
    /** The words of the first element with these words in it. */
    line: (part: string) => all().map(words).find((text) => text.includes(part)),
    /** The banner for being off the route, if it is up. */
    offRoute: () => find<Parameters<typeof OffRouteBanner>[0]>(OffRouteBanner),
    /** Which stops the alert showing is for. */
    banner: () => find<Parameters<typeof AlertBanner>[0]>(AlertBanner)?.stops.map((s) => s.id) ?? [],
    tapDropped() {
      const onDropped = find<Parameters<typeof AlertBanner>[0]>(AlertBanner)?.onDropped
      if (!onDropped) throw new Error('No Dropped button is up')
      onDropped()
      update()
    },
    /** The driver taps Dropped on the alert showing, in the same moment as the next fix: React gives the effects the tap and the fix at once. */
    dropWith(step: Step) {
      play.between = () => find<Parameters<typeof AlertBanner>[0]>(AlertBanner)?.onDropped?.()
      this.drive([step])
    },
    /** Opens the menu and taps Reset Round, as far as the question it asks. */
    askReset() {
      find<Parameters<typeof RoundBar>[0]>(RoundBar)?.onMenu()
      update()
      const menu = find<Parameters<typeof RoundMenu>[0]>(RoundMenu)
      menu?.onClose()
      menu?.onReset()
      update()
    },
    notices,
    /** What the bar is showing: a message, or the next bundle. */
    notice: () => find<Parameters<typeof RoundBar>[0]>(RoundBar)?.notice?.message ?? null,
    nextName: () => find<Parameters<typeof RoundBar>[0]>(RoundBar)?.nextBundle?.name ?? null,
    /** Brings up the list of bundles from the bar, and gives what it was handed. */
    openList() {
      find<Parameters<typeof RoundBar>[0]>(RoundBar)?.onBundles?.()
      update()
      return find<Parameters<typeof BundlesSheet>[0]>(BundlesSheet)
    },
    /** The list as it is now, if it is up. */
    list: () => find<Parameters<typeof BundlesSheet>[0]>(BundlesSheet),
    /** Words asked for, as they stand when asked. */
    said: () => vi.mocked(say).mock.calls.filter(([, o]) => !o?.queue && !o?.stale?.()).map(([text]) => text),
  }
}

const beeps = () => vi.mocked(sound.bundle).mock.calls.length

/** The alert distance as picked on the start screen. */
const pickDistance = (s: ReturnType<typeof roundScreen>, metres: number) => {
  const picker = s.all().find((e) => e.type === Segmented && String(e.props.label).startsWith('How close'))
  if (!picker) throw new Error('No alert distance is up')
  ;(picker.props.onChange as (v: string) => void)(String(metres))
  s.update()
}
/** The menu's Skip, to a spot, as far as the question it asks and its yes. */
const skipTo = async (s: ReturnType<typeof roundScreen>, metres: number) => {
  s.find<Parameters<typeof RoundBar>[0]>(RoundBar)?.onMenu()
  s.update()
  const menu = s.find<Parameters<typeof RoundMenu>[0]>(RoundMenu)
  menu?.onClose()
  menu?.onSkip()
  s.update()
  s.find<Parameters<typeof StartPicker>[0]>(StartPicker)?.onPick(metres, 'the spot')
  s.update()
  s.press('Skip')
  await vi.advanceTimersByTimeAsync(0)
  s.update()
}
const noThrowAt = (id: string, xy: XY): Stop => ({ id, type: 'nothrow', pathIdx: 0, label: id, ...spot(xy) })
/** What the bar says when the next bundle has been left behind. */
const behind = (name: string) => `Next bundle ${name} is behind you. Mark it or move it in the Bundles list.`
/** What the bar says when the next bundle is holding up those after it. */
const still = (name: string) => `Next bundle is still ${name}. Mark it or move it in the Bundles list.`
/** How many times the driver has been told out loud that the next bundle is behind them. */
const toldAloud = () => vi.mocked(say).mock.calls.filter(([text]) => text === NEXT_BEHIND_SPEECH).length

/*
 * Up a street and back down one 40 m east of it. Bundle drops A, B and C are at 200 m, 400 m and 600 m up the first street, on its east side, too far from
 * the second for it to pass them, but close enough for the car to come within the alert distance of them on the way back (as in bundleGate.test.ts).
 */
const A = bundle('A', [8, 200])
const B = bundle('B', [8, 400])
const C = bundle('C', [8, 600])
const LOOP: XY[] = [[0, 0], [0, 900], [40, 900], [40, 0]]
const up = (to: number, from = 0) => legs(10, [0, from], [0, to])

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  play.voice = true
  play.keepAudio = true
})
afterEach(() => {
  vi.useRealTimers()
})

describe('only the bundle next in the list alerts, on the real screen', () => {
  it('goes by a bundle that is not next with nothing at all, and alerts for the one that is', () => {
    const s = roundScreen(routeOf(LOOP, [A, B, C]), { order: ['C', 'A', 'B'] })
    s.press('Start Round')
    s.drive(up(530))
    expect([s.banner(), beeps(), s.said(), s.props.round.handledStopIds, s.props.round.missed ?? []]).toEqual([[], 0, [], [], []])
    s.drive(up(570, 530))
    expect(s.banner()).toEqual(['C'])
    expect(beeps()).toBe(1)
    expect(s.said()).toEqual(['Bundle drop, C, 10 papers.'])
  })

  it('alerts by where the car is for a bundle driven by before it was next', () => {
    const s = roundScreen(routeOf(LOOP, [A, B, C]), { order: ['C', 'A', 'B'] })
    s.press('Start Round')
    s.drive(up(570))
    s.tapDropped()
    expect(s.nextName()).toBe('A')
    expect(s.banner()).toEqual([])
    s.drive(legs(10, [0, 570], [0, 900], [40, 900], [40, 240]))
    expect(s.banner()).toEqual([])
    s.drive(legs(10, [40, 240], [40, 200]))
    expect(s.banner()).toEqual(['A'])
    expect(beeps()).toBe(2)
    // Said, not dropped as behind the car: judged along the route it is 1,400 m back.
    expect(s.said().at(-1)).toBe('Bundle drop, A, 10 papers.')
    s.tapDropped()
    expect(s.props.round.dropped).toContain('A')
    expect(s.props.round.missed ?? []).toEqual([])
  })

  it('takes an alert down without a word when a reorder makes another bundle next, and brings up that one at once, with no new fix', () => {
    const near = bundle('N', [8, 205])
    const s = roundScreen(routeOf(LOOP, [A, near, C]))
    s.press('Start Round')
    s.drive(up(175))
    expect(s.banner()).toEqual(['A'])
    expect(beeps()).toBe(1)
    const list = s.openList()
    // A bundle alert closes the sheet; this one is opened after it, so it is still up for the reorder.
    list?.onOrder?.(['N', 'A', 'C'])
    s.update()
    expect(s.banner()).toEqual(['N'])
    expect(beeps()).toBe(2)
    expect([s.props.round.handledStopIds, s.props.round.missed ?? [], s.notice()]).toEqual([[], [], null])
    // Forgotten as said so that it can come up again, A is not said again now: it has only gone.
    expect(s.said()).toEqual(['Bundle drop, A, 10 papers.', 'Bundle drop, N, 10 papers.'])
    // The list closes for the alert, and A, not next, stays to do as the car goes past it.
    expect(s.list()).toBeUndefined()
    s.tapDropped()
    expect(s.banner()).toEqual(['A'])
  })

  it('brings up the next bundle at once after a drop when the car is already beside it', () => {
    const near = bundle('N', [8, 205])
    const s = roundScreen(routeOf(LOOP, [A, near, C]))
    s.press('Start Round')
    s.drive(up(180))
    expect(s.banner()).toEqual(['A'])
    s.tapDropped()
    expect(s.banner()).toEqual(['N'])
    expect(beeps()).toBe(2)
  })

  it('misses the next bundle when it goes by with no drop, and moves on to the next in the list', () => {
    const s = roundScreen(routeOf(LOOP, [A, B, C]))
    s.press('Start Round')
    s.drive(up(240))
    expect(s.props.round.missed).toEqual(['A'])
    expect(s.notice()).toBe('Missed bundle: A')
    expect(s.nextName()).toBe('B')
  })

  it('counts the earlier passes of a stop gone by as gone too, or it would hold up the list for ever', () => {
    // The route goes up and back down the same road, so A has two passes. Not next on the way up, its first pass is left to do.
    const route = routeOf([[0, 0], [0, 600], [0, 0]], [A, B])
    const s = roundScreen(route, { order: ['B', 'A'] })
    expect(occurrences(route).filter((o) => o.stop.id === 'A')).toHaveLength(2)
    s.press('Start Round')
    s.drive(up(365))
    expect(s.banner()).toEqual(['B'])
    s.tapDropped()
    s.drive(legs(10, [0, 365], [0, 600], [0, 150]))
    expect(s.props.round.missed).toEqual(['A#2'])
    expect(s.props.round.handledStopIds).toEqual(expect.arrayContaining(['A', 'A#2']))
    expect(s.nextName()).toBe('No bundles left')
  })

  it('keeps an alert up by place through a change to the route, instead of finding it gone by', () => {
    const route = routeOf(LOOP, [A, B, C])
    const s = roundScreen(route, { order: ['C', 'A', 'B'] })
    s.press('Start Round')
    s.drive(up(570))
    s.tapDropped()
    s.drive(legs(10, [0, 570], [0, 900], [40, 900], [40, 200]))
    expect(s.banner()).toEqual(['A'])
    // The throw side changed from the road, which makes new passes of every stop.
    s.change({ route: { ...route, sideChanges: [{ idx: 0, side: 'left' }] } })
    s.drive(legs(5, [40, 200], [40, 190]))
    expect(s.banner()).toEqual(['A'])
    expect(s.props.round.missed ?? []).toEqual([])
    expect(s.props.round.handledStopIds).toEqual(['C'])
  })

  it('does not take an alert that has stopped being next for one driven past, when the reorder comes with the fix that leaves it behind', () => {
    const s = roundScreen(routeOf(LOOP, [A, B, C]))
    s.press('Start Round')
    s.drive(up(235))
    expect(s.banner()).toEqual(['A'])
    s.driveWith({ bundleOrder: ['B', 'A', 'C'] }, { x: 0, y: 245, speed: 10, heading: 0 })
    expect([s.banner(), s.props.round.handledStopIds, s.props.round.missed ?? []]).toEqual([[], [], []])
  })

  it('lets go of a bundle put by over a turn round not sure yet, when a reorder takes it off the top of the list before the turn stands', () => {
    // The car turns round short of the end of the street. X's pass of the way back goes by while the turn is not sure, so it is put by until it is.
    const route = routeOf([[0, 0], [0, 300], [0, 0]], [bundle('X', [8, 150]), bundle('W', [8, 60])])
    const s = roundScreen(route, { order: ['X', 'W'] })
    s.press('Start Round')
    s.drive(legs(10, [0, 0], [0, 200]))
    s.drive(legs(5, [0, 200], [0, 195], [0, 95]))
    expect(s.props.round.handledStopIds).toEqual(['X'])
    s.change({ bundleOrder: ['W', 'X'] })
    s.drive(legs(5, [0, 95], [0, 75]))
    expect(s.props.round.handledStopIds).toEqual(['X'])
    expect(s.props.round.missed).toEqual(['X'])
  })

  it('does not meet the next bundle by place during a turn round that may be taken back', () => {
    // W, 260 m up, is first on the list. Backing up short of B, the car is put on the way back, past both of B's passes, and W is marked dropped.
    const B1 = bundle('B', [8, 195])
    const s = roundScreen(routeOf([[0, 0], [0, 300], [0, 0]], [bundle('W', [8, 260]), B1]), { order: ['W', 'B'] })
    s.press('Start Round')
    s.drive(legs(10, [0, 0], [0, 170]))
    s.drive(legs(4, [0, 170], [0, 158]))
    s.openList()?.onMark('W')
    s.update()
    expect(s.nextName()).toBe('B')
    expect([s.banner(), beeps()]).toEqual([[], 0])
    // Taken back as the car drives on, it comes up as ever, on the way out.
    s.drive(legs(5, [0, 158], [0, 180]))
    expect(s.banner()).toEqual(['B'])
    expect(s.props.round.missed ?? []).toEqual([])
  })

  it('sweeps the houses in the stretch gone round when the car comes back onto the route, and leaves the bundles not next in it to do', () => {
    const street: XY[] = [[0, 0], [0, 900]]
    const house: Stop = { id: 'H', type: 'nothrow', pathIdx: 0, label: 'H', ...spot([8, 240]) }
    const s = roundScreen(routeOf(street, [bundle('A', [8, 100]), bundle('L', [8, 280]), bundle('B', [8, 800]), house]), { order: ['B', 'L', 'A'] })
    s.press('Start Round')
    // Past A, then off the street at 200 m, round the block and back onto it at 300 m, past L and the house.
    s.drive(legs(10, [0, 0], [0, 200], [100, 210], [100, 300], [0, 310], [0, 340]))
    expect(s.props.round.handledStopIds).toEqual(['H'])
    expect(s.props.round.missed ?? []).toEqual([])
    s.drive(legs(10, [0, 340], [0, 790]))
    s.tapDropped()
    expect(s.nextName()).toBe('L')
    expect(s.openList()?.rows.map((r) => [r.id, r.status])).toEqual([['B', 'dropped'], ['L', 'next'], ['A', 'todo']])
  })

  it('leaves the next bundle next when the car comes back onto the route past it: that fix is no proof of what it drove, so nothing is missed, and the driver is told once it is left behind', () => {
    // X, between two streets, is passed by both. Not next on the way up, its first pass stays to do. On the way down the car goes round the block past the second.
    const route = routeOf(LOOP, [bundle('X', [20, 300]), bundle('Y', [48, 700])])
    const s = roundScreen(route, { order: ['Y', 'X'] })
    expect(occurrences(route).filter((o) => o.stop.id === 'X')).toHaveLength(2)
    s.press('Start Round')
    s.drive(legs(10, [0, 0], [0, 900], [40, 900], [40, 680]))
    s.tapDropped()
    expect(s.nextName()).toBe('X')
    s.drive(legs(10, [40, 680], [40, 360], [140, 360], [140, 240], [40, 240]))
    expect([s.notice(), s.props.round.missed ?? [], s.nextName()]).toEqual([null, [], 'X'])
    s.drive(legs(10, [40, 240], [40, 60]))
    expect([s.notices, s.nextName()]).toEqual([['Dropped', behind('X')], 'X'])
    expect(s.openList()?.rows.find((r) => r.id === 'X')).toMatchObject({ status: 'next', markKey: 'X' })
  })

  it('misses a bundle whose alert was up as the route is left just past it, tells the driver, and keeps its Mark dropped; the first pass goes with the last, so the stop does not hold up the list', () => {
    // X is next on the way back only. The car goes 25 m past it, the alert still up, and turns off the street.
    const route = routeOf([[0, 0], [0, 500], [0, 0]], [bundle('X', [8, 200]), bundle('W', [8, 300]), bundle('Z', [8, 50])])
    const s = roundScreen(route, { order: ['W', 'X', 'Z'] })
    s.press('Start Round')
    s.drive(legs(10, [0, 0], [0, 280]))
    s.tapDropped()
    s.drive(legs(10, [0, 280], [0, 500], [0, 175]))
    expect(s.banner()).toEqual(['X'])
    s.drive(legs(10, [0, 175], [-100, 175]))
    expect(s.notice()).toBe('Missed bundle: X')
    expect([...s.props.round.handledStopIds].sort()).toEqual(['W', 'W#2', 'X', 'X#2'])
    expect(s.props.round.missed).toEqual(['X#2'])
    expect(s.nextName()).toBe('Z')
    const row = s.openList()?.rows.find((r) => r.id === 'X')
    expect(row).toMatchObject({ status: 'missed', markKey: 'X#2' })
    s.list()?.onMark('X#2')
    s.update()
    expect(s.list()?.rows.find((r) => r.id === 'X')?.status).toBe('dropped')
  })

  it('says an alert up by place when the voice comes on, rather than dropping it as behind the car', () => {
    const s = roundScreen(routeOf(LOOP, [A, B, C]), { order: ['C', 'A', 'B'] })
    s.press('Start Round')
    s.drive(up(570))
    s.tapDropped()
    s.find<Parameters<typeof RoundButtons>[0]>(RoundButtons)?.onVoice()
    s.update()
    s.drive(legs(10, [0, 570], [0, 900], [40, 900], [40, 200]))
    expect(s.banner()).toEqual(['A'])
    vi.mocked(say).mockClear()
    s.find<Parameters<typeof RoundButtons>[0]>(RoundButtons)?.onVoice()
    s.update()
    expect(s.said()).toEqual(['Bundle drop, A, 10 papers.'])
  })
})

describe('a next bundle gone by with no alert, on the real screen', () => {
  const started = (route: Route, order?: string[]) => {
    const s = roundScreen(route, { order })
    s.press('Start Round')
    return s
  }

  it('counts it missed when the phone has no fix past it, tells the driver, keeps its Mark dropped, and lets the next one alert', () => {
    const s = started(routeOf(LOOP, [A, B, C]))
    s.drive(up(150))
    s.noFixFor(15)
    s.drive(up(310, 300))
    expect(s.notice()).toBe('Missed bundle: A')
    expect(s.props.round.missed).toEqual(['A'])
    expect(s.nextName()).toBe('B')
    expect(s.drive(up(370, 310))).toBeUndefined()
    expect(s.banner()).toEqual(['B'])
    expect(s.openList()?.rows.find((r) => r.id === 'A')).toMatchObject({ status: 'missed', markKey: 'A' })
  })

  it('goes on down the list in the same stretch, so a gap past two in a row does not leave the second holding it, and names them together', () => {
    const s = started(routeOf(LOOP, [A, B, C]))
    s.drive(up(150))
    s.noFixFor(30)
    s.drive(up(510, 500))
    expect(s.notice()).toBe('Missed 2 bundles: A and B')
    expect(s.props.round.missed).toEqual(['A', 'B'])
    expect(s.nextName()).toBe('C')
    s.drive(up(570, 510))
    expect(s.banner()).toEqual(['C'])
  })

  it('stops at the first that fails, in the driver\'s order: one still ahead keeps its place, and one further down is not reached', () => {
    const s = started(routeOf(LOOP, [A, B, C]), ['A', 'C', 'B'])
    s.drive(up(150))
    s.noFixFor(30)
    s.drive(up(510, 500))
    expect(s.props.round.missed).toEqual(['A'])
    expect(s.nextName()).toBe('C')
    expect(s.openList()?.rows.map((r) => r.status)).toEqual(['missed', 'next', 'todo'])
  })

  it('leaves a stop with a pass still to come next, and it alerts on that pass', () => {
    // X is at 200 m on the way out and 800 m on the way back.
    const s = started(routeOf([[0, 0], [0, 500], [0, 0]], [bundle('X', [8, 200]), bundle('Y', [8, 100])]), ['X', 'Y'])
    s.drive(legs(10, [0, 0], [0, 150]))
    s.noFixFor(15)
    s.drive(legs(10, [0, 300], [0, 310]))
    expect([s.notice(), s.props.round.missed ?? [], s.nextName()]).toEqual([null, [], 'X'])
    s.drive(legs(10, [0, 310], [0, 500], [0, 230]))
    expect(s.banner()).toEqual(['X'])
  })

  it('misses a stop on its last pass, with the first pass, already gone by, settled with it', () => {
    const s = started(routeOf([[0, 0], [0, 500], [0, 0]], [bundle('X', [8, 200]), bundle('Y', [8, 20])]), ['X', 'Y'])
    s.drive(legs(10, [0, 0], [0, 150]))
    s.noFixFor(15)
    s.drive(legs(10, [0, 300], [0, 500], [0, 250]))
    s.noFixFor(15)
    s.drive(legs(10, [0, 100], [0, 90]))
    expect(s.notice()).toBe('Missed bundle: X')
    expect(s.props.round.missed).toEqual(['X#2'])
    expect([...s.props.round.handledStopIds].sort()).toEqual(['X', 'X#2'])
    expect(s.nextName()).toBe('Y')
  })

  it('leaves a bundle not next to do, whatever goes by', () => {
    const s = started(routeOf(LOOP, [A, B, C]), ['C', 'A', 'B'])
    s.drive(up(150))
    s.noFixFor(20)
    s.drive(up(410, 400))
    expect([s.notice(), s.props.round.handledStopIds, s.props.round.missed ?? [], s.nextName()]).toEqual([null, [], [], 'C'])
  })

  it('does not count a bundle that came up, and goes on as ever once it is gone by', () => {
    const s = started(routeOf(LOOP, [A, B, C]))
    s.drive(up(190))
    expect(s.banner()).toEqual(['A'])
    s.noFixFor(5)
    s.drive(up(250, 240))
    expect(s.props.round.missed).toEqual(['A'])
    expect(s.nextName()).toBe('B')
  })

  it('does not count one that has only just become next, by a tap in the same moment as the car passes it: it is met by place', () => {
    const near = bundle('N', [8, 225])
    const s = started(routeOf(LOOP, [A, near, C]))
    s.drive(up(205))
    expect(s.banner()).toEqual(['A'])
    s.noFixFor(1)
    s.dropWith({ x: 0, y: 250, speed: 10, heading: 0 })
    expect(s.props.round.dropped).toEqual(['A'])
    expect(s.props.round.missed ?? []).toEqual([])
    expect(s.banner()).toEqual(['N'])
    s.noFixFor(1)
    s.tapDropped()
    expect(s.props.round.dropped).toEqual(['A', 'N'])
  })

  it('counts one that became next at a tap, ahead of the car, once a gap takes the car past it', () => {
    const s = started(routeOf(LOOP, [A, B, C]))
    s.drive(up(190))
    s.tapDropped()
    expect(s.nextName()).toBe('B')
    s.noFixFor(25)
    s.drive(up(460, 450))
    expect(s.notice()).toBe('Missed bundle: B')
    expect(s.props.round.missed).toEqual(['B'])
  })

  it('counts nothing on the first fix of Continue Round, with no reach to go from: a bundle behind the car is met by place', () => {
    const s = roundScreen(routeOf(LOOP, [A, B, C]), { round: { handledStopIds: [], furthest: 100 } })
    s.press('Continue Round')
    s.drive(up(310, 300))
    s.drive(up(320, 310))
    expect([s.notice(), s.props.round.missed ?? [], s.nextName()]).toEqual([null, [], 'A'])
  })

  it('counts from the first fix on after Continue Round', () => {
    const s = roundScreen(routeOf(LOOP, [A, B, C]), { round: { handledStopIds: [], furthest: 100 } })
    s.press('Continue Round')
    s.drive(up(120, 100))
    s.noFixFor(15)
    s.drive(up(310, 300))
    expect(s.props.round.missed).toEqual(['A'])
  })

  it('counts nothing on the first fix after a reset either, whatever was going on before it', async () => {
    // Near enough the start for that fix to reach the route, and past N, with the reach from before the reset short of it.
    const s = started(routeOf(LOOP, [bundle('N', [8, 70]), B, C]))
    s.drive(up(25))
    s.askReset()
    s.press('Reset')
    await vi.advanceTimersByTimeAsync(0)
    s.update()
    s.noFixFor(8)
    s.drive(up(100, 90))
    expect([s.notice(), s.props.round.missed ?? [], s.nextName()]).toEqual([null, [], 'N'])
  })

  describe('at the first fix after a start from a spot', () => {
    const startAt = (metres: number, order?: string[]) => {
      const s = roundScreen(routeOf(LOOP, [A, B, C]), { order })
      s.press('Choose Where to Start')
      s.find<Parameters<typeof StartPicker>[0]>(StartPicker)?.onPick(metres, 'here')
      s.update()
      return s
    }

    it('leaves the next bundle in the stretch from the spot to the car next: the first fix is no proof the car drove that stretch', () => {
      const s = startAt(150)
      s.drive(up(250, 240))
      expect([s.notice(), s.props.round.missed ?? [], s.nextName()]).toEqual([null, [], 'A'])
    })

    it('tells the driver once if they leave it behind, and it alerts by place if they go back for it', () => {
      const s = startAt(150, ['A', 'C', 'B'])
      s.drive(up(500, 240))
      expect([s.notices, toldAloud(), s.nextName(), s.props.round.missed ?? []]).toEqual([[behind('A')], 1, 'A', []])
      s.drive(legs(10, [0, 500], [20, 500], [20, 220]))
      expect([s.banner(), toldAloud()]).toEqual([['A'], 1])
    })

    it('does not give a car crossing the road on its way to the spot a miss: A alerts as it drives up from the spot', () => {
      const s = roundScreen(routeOf(LOOP, [bundle('M', [8, 700]), bundle('Z', [8, 880])]))
      s.press('Choose Where to Start')
      s.find<Parameters<typeof StartPicker>[0]>(StartPicker)?.onPick(500, 'here')
      s.update()
      s.drive(legs(10, [-100, 790], [100, 790]))
      expect([s.notice(), s.props.round.missed ?? [], s.nextName()]).toEqual([null, [], 'M'])
      s.drive(legs(10, [100, 790], [100, 500], [0, 500], [0, 680]))
      expect([s.banner(), s.props.round.missed ?? []]).toEqual([['M'], []])
    })

    it('leaves a bundle not next in that stretch to do', () => {
      const s = startAt(150, ['C', 'A', 'B'])
      s.drive(up(250, 240))
      expect([s.notice(), s.props.round.handledStopIds, s.props.round.missed ?? []]).toEqual([null, [], []])
      expect(s.openList()?.rows.map((r) => r.status)).toEqual(['next', 'todo', 'todo'])
    })

    it('leaves a bundle before the spot as the spot left it', () => {
      const s = startAt(300)
      expect(s.props.round.handledStopIds).toEqual(['A'])
      s.drive(up(340, 330))
      expect(s.props.round.missed ?? []).toEqual([])
      expect(s.nextName()).toBe('B')
    })

    it('counts nothing with the car too far from the spot for the stretch to say what it went by', () => {
      const s = startAt(100)
      s.drive(up(490, 480))
      expect([s.notice(), s.props.round.handledStopIds, s.props.round.missed ?? []]).toEqual([null, [], []])
    })
  })

  describe('where the place along the route says nothing of what the car drove past', () => {
    // X is 50 m further up the street than the car turns round, so its alert never comes up, and the way back jumps the route past both of its passes.
    const X = bundle('X', [8, 260])
    const backOver = () => {
      const s = started(routeOf([[0, 0], [0, 400], [0, 0]], [X, bundle('Y', [8, 40])]), ['X', 'Y'])
      s.drive(legs(10, [0, 0], [0, 200], [0, 195], [0, 190]))
      s.drive(legs(10, [0, 190], [0, 40]))
      return s
    }

    it('counts no miss over a turn round, sure or not: the stretch it jumps was never driven', () => {
      const s = backOver()
      expect(s.props.round.missed ?? []).toEqual([])
      expect(s.notice()).toBe(behind('X'))
      expect(s.nextName()).toBe('X')
    })

    // The route comes back down a street 100 m east: the jump from one to the other is a long way along the route, and a short way on the ground.
    const street = (): Route => routeOf([[0, 0], [0, 500], [100, 500], [100, 0]], [bundle('A', [8, 300])])
    const across = legs(10, [0, 0], [0, 100], [100, 300])

    it('counts no miss on the fixes after a jump along the route that the off-route machine has yet to believe', () => {
      const s = started(street())
      s.drive([...across, ...legs(10, [100, 300], [100, 250])])
      expect(s.offRoute()).toBeUndefined()
      expect([s.notice(), s.props.round.missed ?? [], s.nextName()]).toEqual([null, [], 'A'])
    })

    it('counts no miss while back on the route somewhere else, and the driver can go back for it', () => {
      const s = started(street())
      s.drive([...across, ...legs(10, [100, 300], [100, 100])])
      expect(s.offRoute()?.phase).toBe('rejoined')
      expect([s.props.round.handledStopIds, s.props.round.missed ?? [], s.nextName()]).toEqual([[], [], 'A'])
      s.offRoute()?.onTakeBack()
      s.update()
      s.drive(legs(10, [100, 100], [0, 100], [0, 280]))
      expect(s.banner()).toEqual(['A'])
    })

    it('counts no miss on the fix that comes back onto the route somewhere else with no spell off it to go by', () => {
      // Up a street, across, down a second, across, and up a third: the car goes unseen from the first street to the third, a long way along the route.
      const s = started(routeOf([[0, 0], [0, 500], [300, 500], [300, 0], [600, 0], [600, 500]], [bundle('A', [8, 300])]))
      s.drive(up(100))
      s.noFixFor(10)
      s.drive([{ x: 200, y: 100, speed: 10, heading: 90 }])
      s.noFixFor(30)
      s.drive(legs(10, [600, 300], [600, 330]))
      expect([s.offRoute(), s.notice(), s.props.round.missed ?? [], s.nextName()]).toEqual([undefined, null, [], 'A'])
    })

    it('counts no miss on the way to the route: crossing it is not driving it', () => {
      const s = started(routeOf(LOOP, [A, B, C]))
      s.drive(up(150, 140))
      s.noFixFor(15)
      s.drive(up(310, 300))
      expect([s.notice(), s.props.round.missed ?? [], s.nextName()]).toEqual([null, [], 'A'])
    })

    it('counts no miss off the route: the car comes back past the bundle further than the catch-up goes, and it stays next', () => {
      const s = started(routeOf([[0, 0], [0, 1500]], [bundle('A', [8, 300]), bundle('B', [8, 1400])]))
      s.drive(legs(10, [0, 0], [0, 100], [200, 110], [200, 600], [0, 610], [0, 660]))
      expect([s.props.round.missed ?? [], s.nextName()]).toEqual([[], 'A'])
    })
  })

  it('counts a miss once only when the car backs up and comes on again', () => {
    const s = started(routeOf([[0, 0], [0, 900]], [bundle('A', [8, 200]), bundle('B', [8, 700])]))
    s.drive(up(150))
    s.noFixFor(15)
    s.drive(up(310, 300))
    expect(s.props.round.missed).toEqual(['A'])
    s.drive(legs(4, [0, 310], [0, 240]))
    s.drive(legs(10, [0, 240], [0, 320]))
    expect(s.props.round.missed).toEqual(['A'])
    expect(s.nextName()).toBe('B')
  })
})

describe('a next bundle met by place, on the real screen', () => {
  // A, 55 m off the road, is further from it than the alert distance, and not so far that it counts as away from the route. B is first on the list.
  const SET_BACK = bundle('A', [55, 100])
  const backedUp = () => {
    const s = roundScreen(routeOf([[0, 0], [0, 800]], [SET_BACK, bundle('B', [8, 190])]), { order: ['B', 'A'] })
    s.press('Start Round')
    s.drive(legs(10, [0, 0], [0, 200]))
    s.tapDropped()
    return s
  }

  it('alerts from the road for a bundle set back further than the alert distance, rather than hold the list up for good', () => {
    const s = backedUp()
    expect(s.banner()).toEqual([])
    s.drive(legs(4, [0, 200], [0, 100]))
    expect(s.banner()).toEqual(['A'])
    s.tapDropped()
    expect(s.props.round.dropped).toEqual(['B', 'A'])
  })

  it('leaves its alert up until the car is well away from the road beside it', () => {
    const s = backedUp()
    s.drive(legs(4, [0, 200], [0, 120]))
    expect(s.banner()).toEqual(['A'])
    s.drive(legs(4, [0, 120], [0, 40]))
    expect(s.banner()).toEqual(['A'])
    s.drive(legs(4, [0, 40], [0, 24]))
    expect(s.banner()).toEqual([])
    expect(s.props.round.missed).toEqual(['A'])
  })

  it('takes no notice of one poor fix: a bundle is not missed with the car parked at it', () => {
    const s = roundScreen(routeOf(LOOP, [A, B, C]), { order: ['C', 'A', 'B'] })
    s.press('Start Round')
    s.drive(up(570))
    s.tapDropped()
    s.drive(legs(10, [0, 570], [0, 900], [40, 900], [40, 200]))
    expect(s.banner()).toEqual(['A'])
    s.drive([{ x: 130, y: 200, speed: 0, heading: 0, accuracy: 41 }])
    expect([s.banner(), s.props.round.missed ?? [], s.notice()]).toEqual([['A'], [], null])
    s.noFixFor(5)
    s.drive([{ x: 40, y: 200, speed: 0, heading: 0 }])
    expect(s.banner()).toEqual(['A'])
    // A fix good enough to go by says the car has left, as ever.
    s.noFixFor(5)
    s.drive([{ x: 130, y: 200, speed: 0, heading: 0, accuracy: 40 }])
    expect(s.banner()).toEqual([])
    expect(s.props.round.missed).toEqual(['A'])
  })
})

describe('never inventing a miss, on the real screen', () => {
  const started = (route: Route, order?: string[]) => {
    const s = roundScreen(route, { order })
    s.press('Start Round')
    return s
  }

  describe('a move along the route the car cannot have driven', () => {
    // Up one street and back down the next, `gap` m east: a fix on the second street is a long way along the route from the first, and a short way on the ground.
    const streets = (gap: number) =>
      routeOf([[0, 0], [0, 1000], [gap, 1000], [gap, 0], [gap + 300, 0]], [bundle('A', [8, 500]), bundle('B', [8, 700]), bundle('C', [gap - 8, 150]), noThrowAt('H', [8, 600])])

    it('counts nothing when the car cuts across to the next street, whatever the street and the speed', { timeout: 60_000 }, () => {
      for (const gap of [100, 110, 120, 130, 140, 150, 160, 180, 200]) {
        for (const speed of [8, 10, 12, 14, 16]) {
          const s = started(streets(gap))
          s.drive(up(300))
          s.drive(legs(speed, [0, 300], [gap, 300], [gap, 280]))
          expect([gap, speed, s.props.round.missed ?? [], s.nextName()]).toEqual([gap, speed, [], 'A'])
        }
      }
    })

    it('leaves them to alert when the driver goes back up the first street after all', () => {
      const s = started(streets(140))
      s.drive(up(300))
      s.drive(legs(12, [0, 300], [140, 300]))
      expect(s.props.round.missed ?? []).toEqual([])
      s.drive(legs(10, [140, 300], [0, 300], [0, 480]))
      expect(s.banner()).toEqual(['A'])
      s.tapDropped()
      s.drive(up(680, 480))
      expect(s.banner()).toEqual(['B'])
      expect(beeps()).toBe(2)
    })

    it('does not count a side street the car overshot by 60 m, and it alerts when the car turns back and drives up it', () => {
      for (const depth of [60, 80, 150]) {
        vi.clearAllMocks()
        const s = started(routeOf([[0, 0], [0, 300], [depth, 300], [0, 300], [0, 1200]], [bundle('T', [depth - 10, 308]), bundle('Z', [8, 900])]))
        s.drive(up(360))
        expect([depth, s.props.round.missed ?? [], s.nextName()]).toEqual([depth, [], 'T'])
        s.drive(legs(10, [0, 360], [0, 300], [depth, 300]))
        expect([depth, s.banner(), beeps()]).toEqual([depth, ['T'], 1])
      }
    })

    it('still counts a gap the car can have driven, on a road that bends', () => {
      // Round a bend, so the road is 100 m further than the straight line between the fixes, which is as far as it may be.
      const s = started(routeOf([[0, 0], [0, 200], [200, 200], [200, 800]], [bundle('A', [8, 150]), bundle('B', [208, 700])]))
      s.drive(up(50))
      s.noFixFor(30)
      // 300 m on along the road, 200 m or so in a straight line.
      s.drive([{ x: 150, y: 200, speed: 10, heading: 90 }])
      expect(s.props.round.missed).toEqual(['A'])
    })
  })

  describe('a fix too poor to go by', () => {
    const edge = 256
    const near = () => {
      const s = started(routeOf([[0, 0], [0, 900]], [bundle('A', [8, 300]), bundle('Z', [8, 700])]))
      s.drive(legs(10, [0, 0], [0, edge - 15]))
      s.drive(legs(3, [0, edge - 15], [0, edge]))
      return s
    }

    it('counts nothing when one is thrown forward past a bundle the car has not got to, and the alert comes up as it arrives', () => {
      const s = near()
      s.drive([{ x: 0, y: edge + 100, speed: 3, heading: 0, accuracy: 60 }])
      expect([s.notice(), s.props.round.missed ?? []]).toEqual([null, []])
      s.drive(legs(3, [0, edge], [0, 300]))
      expect([s.banner(), s.props.round.missed ?? [], s.notice()]).toEqual([['A'], [], null])
    })

    it('leaves the whole stretch to the next good fix, which counts it from before the poor one', () => {
      const s = started(routeOf([[0, 0], [0, 900]], [bundle('A', [8, 200]), bundle('Z', [8, 700])]))
      s.drive(up(150))
      s.noFixFor(15)
      s.drive([{ x: 0, y: 300, speed: 10, heading: 0, accuracy: 50 }])
      expect(s.props.round.missed ?? []).toEqual([])
      s.drive(up(310, 300))
      expect(s.props.round.missed).toEqual(['A'])
      expect(s.notice()).toBe('Missed bundle: A')
    })

    describe('with the next bundle\'s alert up along the route', () => {
      /** Bundle A, with the car 6 m inside its alert distance and the alert up, and Z well on. */
      const inside = (distance: number) => {
        vi.clearAllMocks()
        const s = roundScreen(routeOf([[0, 0], [0, 900]], [bundle('A', [8, 300]), bundle('Z', [8, 800])]))
        pickDistance(s, distance)
        s.press('Start Round')
        s.drive(legs(10, [0, 0], [0, 200]))
        s.drive(legs(3, [0, 200], [0, 306 - distance]))
        expect(s.banner()).toEqual(['A'])
        return s
      }

      it('keeps it up with its Dropped button through one fix thrown ahead, whatever the alert distance, and it is still there on arrival', { timeout: 60_000 }, () => {
        for (const distance of [20, 40, 60]) {
          for (const jump of [60, 80, 90, 100, 120]) {
            for (const accuracy of [31, 35, 41, 50, 60]) {
              const s = inside(distance)
              const at = 306 - distance
              s.drive([{ x: 0, y: at + jump, speed: 3, heading: 0, accuracy }])
              expect([distance, jump, accuracy, s.banner(), s.notice(), s.props.round.missed ?? []]).toEqual([distance, jump, accuracy, ['A'], null, []])
              s.drive(legs(3, [0, at], [0, 300]))
              expect([s.banner(), s.notice(), s.props.round.missed ?? []]).toEqual([['A'], null, []])
              s.tapDropped()
              expect([s.props.round.dropped, s.nextName()]).toEqual([['A'], 'Z'])
            }
          }
        }
      })

      it('keeps it up through one to three poor fixes thrown far ahead, though the first good fix after them still has the car at the thrown place', { timeout: 60_000 }, () => {
        for (const distance of [20, 40, 60]) {
          for (const jump of [150, 200, 300, 400]) {
            for (const accuracy of [35, 60]) {
              for (const fixes of [1, 3]) {
                const s = inside(distance)
                const at = 306 - distance
                s.drive(Array.from({ length: fixes }, (_, i) => ({ x: 0, y: at + jump + i * 3, speed: 3, heading: 0, accuracy })))
                s.drive(legs(3, [0, at], [0, 300]))
                expect([distance, jump, accuracy, fixes, s.banner(), s.notice(), s.props.round.missed ?? []]).toEqual([distance, jump, accuracy, fixes, ['A'], null, []])
              }
            }
          }
        }
      })

      it('keeps it up through a poor fix thrown back, so Dropped does not go from under a finger and there is no second beep', () => {
        const s = inside(40)
        const beeps = vi.mocked(sound.bundle).mock.calls.length
        s.drive([{ x: 0, y: 186, speed: 3, heading: 0, accuracy: 45 }])
        expect([s.banner(), s.props.round.missed ?? []]).toEqual([['A'], []])
        s.drive(legs(3, [0, 269], [0, 300]))
        expect([s.banner(), s.props.round.missed ?? []]).toEqual([['A'], []])
        expect(vi.mocked(sound.bundle).mock.calls.length).toBe(beeps)
      })

      it('still lets a good fix behind the bundle take it down, to alert again as the car comes back', () => {
        const s = inside(40)
        const beeps = vi.mocked(sound.bundle).mock.calls.length
        s.drive(legs(5, [0, 266], [0, 200]).map((f) => ({ ...f, heading: 180 })))
        expect([s.banner(), s.props.round.missed ?? []]).toEqual([[], []])
        s.drive(legs(5, [0, 200], [0, 280]))
        expect(s.banner()).toEqual(['A'])
        expect(vi.mocked(sound.bundle).mock.calls.length).toBe(beeps + 1)
      })

      it('leaves it to the next good fix, which takes it down and counts the miss, however many poor ones come first', () => {
        const s = inside(40)
        s.drive(legs(10, [0, 266], [0, 400]).map((f) => ({ ...f, accuracy: 35 })))
        expect([s.banner(), s.props.round.missed ?? []]).toEqual([['A'], []])
        s.drive(up(410, 400))
        expect([s.banner(), s.notice(), s.props.round.missed, s.nextName()]).toEqual([[], 'Missed bundle: A', ['A'], 'Z'])
      })

      it('takes a fix of 30 m as good: it is as good as the tracker needs to set aside a jump by itself', () => {
        const s = inside(40)
        s.drive(legs(10, [0, 266], [0, 400]).map((f) => ({ ...f, accuracy: 30 })))
        expect([s.banner(), s.props.round.missed]).toEqual([[], ['A']])
      })

      it('changes nothing for a house: its alert goes on the same fix, as a wrong house alert is forgotten, not left up', () => {
        const s = roundScreen(routeOf([[0, 0], [0, 900]], [noThrowAt('H', [8, 300]), bundle('Z', [8, 800])]))
        pickDistance(s, 40)
        s.press('Start Round')
        s.drive(legs(10, [0, 0], [0, 266]))
        expect(s.banner()).toEqual(['H'])
        s.drive([{ x: 0, y: 366, speed: 3, heading: 0, accuracy: 35 }])
        expect([s.banner(), s.props.round.handledStopIds]).toEqual([[], ['H']])
      })

      it('changes nothing for an alert up by place: a fix that can say where the car is takes it down', () => {
        const s = started(routeOf([[0, 0], [0, 1500]], [bundle('N', [8, 100]), bundle('Q', [8, 300]), bundle('Z', [8, 1400])]), ['Q', 'N', 'Z'])
        s.drive(up(280))
        s.tapDropped()
        s.drive(legs(8, [0, 280], [0, 130]).map((f) => ({ ...f, heading: 180 })))
        expect(s.banner()).toEqual(['N'])
        s.drive([{ x: 0, y: 330, speed: 8, heading: 0, accuracy: 35 }])
        expect([s.banner(), s.props.round.missed]).toEqual([[], ['N']])
      })
    })

    it('counts no stretch on a fix of 31 to 39 m, thrown forward as the tracker does not set aside: the alert comes up as the car arrives', { timeout: 60_000 }, () => {
      for (const accuracy of [31, 35, 39]) {
        for (const distance of [10, 20, 30, 40]) {
          for (const jump of [40, 50, 60, 80]) {
            vi.clearAllMocks()
            const s = roundScreen(routeOf([[0, 0], [0, 900]], [bundle('A', [8, 300]), bundle('Z', [8, 800])]))
            pickDistance(s, distance)
            s.press('Start Round')
            const short = 296 - distance
            s.drive(legs(10, [0, 0], [0, short - 15]))
            s.drive(legs(3, [0, short - 15], [0, short]))
            s.drive([{ x: 0, y: short + jump, speed: 3, heading: 0, accuracy }])
            s.drive(legs(3, [0, short], [0, 300]))
            expect([accuracy, distance, jump, s.banner(), s.props.round.missed ?? [], s.notice()]).toEqual([accuracy, distance, jump, ['A'], [], null])
          }
        }
      }
    })

    it('waits for a good fix before the catch-up after a skip, which then takes the house it passed and no bundle', async () => {
      const s = started(routeOf([[0, 0], [0, 1500]], [noThrowAt('H', [8, 1060]), bundle('M', [8, 1020]), bundle('Z', [8, 1400])]))
      s.drive(up(100))
      await skipTo(s, 1000)
      s.drive([{ x: 0, y: 1200, speed: 10, heading: 0, accuracy: 50 }])
      expect([s.props.round.handledStopIds.includes('H'), s.props.round.missed ?? [], s.nextName()]).toEqual([false, [], 'M'])
      s.drive([{ x: 0, y: 1200, speed: 10, heading: 0 }])
      expect([s.props.round.handledStopIds.includes('H'), s.props.round.missed ?? [], s.nextName()]).toEqual([true, [], 'M'])
    })

    it('leaves the house to come up as the car gets there, when a poor first fix after a start from a spot is thrown past it', () => {
      const s = roundScreen(routeOf([[0, 0], [0, 1500]], [noThrowAt('H', [8, 560]), bundle('Z', [8, 1400])]))
      s.press('Choose Where to Start')
      s.find<Parameters<typeof StartPicker>[0]>(StartPicker)?.onPick(500, 'here')
      s.update()
      s.drive([{ x: 0, y: 640, speed: 10, heading: 0, accuracy: 60 }])
      expect(s.props.round.handledStopIds.includes('H')).toBe(false)
      s.drive(legs(10, [0, 500], [0, 540]))
      expect(s.banner()).toEqual(['H'])
    })

    it('leaves the house for its alert when the good fixes after a poor first fix still have the car at the thrown place', { timeout: 60_000 }, () => {
      for (const throwTo of [660, 700, 780]) {
        for (const accuracy of [35, 60]) {
          vi.clearAllMocks()
          const s = roundScreen(routeOf([[0, 0], [0, 1500]], [noThrowAt('H', [8, 560]), bundle('Z', [8, 1400])]))
          s.press('Choose Where to Start')
          s.find<Parameters<typeof StartPicker>[0]>(StartPicker)?.onPick(500, 'here')
          s.update()
          s.drive([{ x: 0, y: throwTo, speed: 5, heading: 0, accuracy }])
          s.drive(legs(5, [0, 500], [0, 545]))
          expect([throwTo, accuracy, s.props.round.handledStopIds.includes('H'), s.banner()]).toEqual([throwTo, accuracy, false, ['H']])
          expect(sound.noThrow).toHaveBeenCalledTimes(1)
        }
      }
    })

    it('keeps nothing from a fix that says nothing of the stretch, good as it is: the fix that first reaches the route counts no miss, however far it is from the last, and the driver is told it is behind them', () => {
      const s = started(routeOf(LOOP, [A, B, C]))
      s.drive(up(150, 140))
      s.noFixFor(21)
      s.drive([{ x: 0, y: 360, speed: 10, heading: 0 }])
      expect([s.notice(), s.props.round.missed ?? [], s.nextName()]).toEqual([behind('A'), [], 'A'])
    })
  })

  describe('a car in the zone of the bundle at the end of a gap', () => {
    const A1 = bundle('A', [8, 200])
    const B1 = bundle('B', [8, 400])

    it('is at it: it alerts by place on that fix, with no notice, and it is missed the ordinary way if driven out of the zone', () => {
      const s = started(routeOf([[0, 0], [0, 900]], [A1, B1]))
      s.drive(up(150))
      s.noFixFor(8)
      s.drive([{ x: 0, y: 225, speed: 10, heading: 0 }])
      expect([s.banner(), beeps(), s.notice(), s.props.round.missed ?? []]).toEqual([['A'], 1, null, []])
      s.drive(up(260, 225))
      expect(s.banner()).toEqual([])
      expect(s.props.round.missed).toEqual(['A'])
      expect(s.notice()).toBe('Missed bundle: A')
    })

    it('can drop it there, with no miss', () => {
      const s = started(routeOf([[0, 0], [0, 900]], [A1, B1]))
      s.drive(up(150))
      s.noFixFor(8)
      s.drive([{ x: 0, y: 225, speed: 10, heading: 0 }])
      s.tapDropped()
      expect([s.props.round.dropped, s.props.round.missed ?? []]).toEqual([['A'], []])
    })

    it('ends the chain there: the one before is missed, and this one alerts', () => {
      const s = started(routeOf([[0, 0], [0, 900]], [A1, B1, bundle('C', [8, 430])]))
      s.drive(up(150))
      s.noFixFor(28)
      s.drive([{ x: 0, y: 425, speed: 10, heading: 0 }])
      expect([s.props.round.missed, s.notice(), s.banner(), s.nextName()]).toEqual([['A'], 'Missed bundle: A', ['B'], 'B'])
    })

    it('counts a car past the zone at the end of a gap as ever', () => {
      const s = started(routeOf([[0, 0], [0, 900]], [A1, B1]))
      s.drive(up(150))
      s.noFixFor(11)
      s.drive([{ x: 0, y: 260, speed: 10, heading: 0 }])
      expect([s.props.round.missed, s.notice(), s.banner()]).toEqual([['A'], 'Missed bundle: A', []])
    })

    it('holds at the catch-up after a start from a spot as well', () => {
      const s = roundScreen(routeOf([[0, 0], [0, 900]], [A1, B1]))
      s.press('Choose Where to Start')
      s.find<Parameters<typeof StartPicker>[0]>(StartPicker)?.onPick(150, 'here')
      s.update()
      s.drive([{ x: 0, y: 225, speed: 10, heading: 0 }])
      expect([s.banner(), s.notice(), s.props.round.missed ?? []]).toEqual([['A'], null, []])
    })
  })

  it('ends the catch-up where the car is, not at the furthest reached: a car back behind that has not gone by what lies between', () => {
    // The round was kept further on than the car really is, so the furthest reached is 1,200 m all the while it drives from 280 m.
    const s = roundScreen(routeOf([[0, 0], [0, 1500]], [bundle('M', [8, 800]), bundle('Z', [8, 1400])]), { order: ['M', 'Z'], round: { handledStopIds: [], furthest: 1200 } })
    s.press('Continue Round')
    s.drive(legs(10, [0, 280], [0, 500]))
    // Off the route and back onto it a little further on, which catches up the stretch from where it was left.
    s.drive(legs(10, [0, 500], [120, 510], [120, 600], [0, 610], [0, 640]))
    expect([s.offRoute(), s.notices, s.props.round.missed ?? [], s.nextName()]).toEqual([undefined, [], [], 'M'])
    s.drive(up(770, 640))
    expect(s.banner()).toEqual(['M'])
  })

  describe('a bundle missed the ordinary way on the fix that ends a gap', () => {
    const route = () => routeOf([[0, 0], [0, 1500]], [A, B, C])

    it('lets the walk run on from it, so the next does not hold the list, and names them together', () => {
      const s = started(route())
      s.drive(up(190))
      expect(s.banner()).toEqual(['A'])
      s.noFixFor(27)
      s.drive(up(470, 460))
      expect(s.notice()).toBe('Missed 2 bundles: A and B')
      expect(s.props.round.missed).toEqual(['A', 'B'])
      expect(s.nextName()).toBe('C')
      s.drive(up(570, 470))
      expect(s.banner()).toEqual(['C'])
      expect(beeps()).toBe(2)
    })

    it('stops at the first that fails, as a gap with no alert up does', () => {
      const s = started(route())
      s.drive(up(190))
      s.noFixFor(17)
      s.drive([{ x: 0, y: 360, speed: 10, heading: 0 }])
      expect(s.props.round.missed).toEqual(['A'])
      expect(s.nextName()).toBe('B')
      s.drive(up(370, 360))
      expect(s.banner()).toEqual(['B'])
    })

    it('leaves a bundle not next out of it: the walk goes down the list, not the road', () => {
      const s = started(route(), ['A', 'C', 'B'])
      s.drive(up(190))
      s.noFixFor(27)
      s.drive(up(470, 460))
      expect(s.props.round.missed).toEqual(['A'])
      expect(s.nextName()).toBe('C')
    })

    it('is no reason to count one that only became next at a tap: dropping A as the car passes B leaves B to alert by place, even with the car past its zone', () => {
      const near = bundle('N', [8, 225])
      const s = started(routeOf([[0, 0], [0, 1500]], [A, near, C]))
      s.drive(up(205))
      s.noFixFor(7)
      s.dropWith({ x: 0, y: 285, speed: 10, heading: 0 })
      expect(s.props.round).toMatchObject({ dropped: ['A'] })
      expect([s.props.round.missed ?? [], s.notice(), s.nextName()]).toEqual([[], 'Dropped', 'N'])
      // The driver turns back for it.
      s.drive(legs(8, [0, 285], [0, 255]).map((f) => ({ ...f, heading: 180 })))
      expect(s.banner()).toEqual(['N'])
    })
  })

  describe('a skip back behind the car', () => {
    const dropped = () => {
      const s = started(routeOf([[0, 0], [0, 1500]], [bundle('A', [8, 300]), bundle('C', [8, 600])]))
      s.drive(up(280))
      s.tapDropped()
      s.drive(up(580, 280))
      s.tapDropped()
      s.drive(up(700, 580))
      expect(s.props.round.dropped).toEqual(['A', 'C'])
      return s
    }

    it('keeps what the dialog promised: the bundle after the spot stays to do on the first fix, and alerts when the car drives back to it', async () => {
      const s = dropped()
      await skipTo(s, 500)
      expect(s.openList()?.rows.map((r) => [r.id, r.status])).toEqual([['A', 'dropped'], ['C', 'next']])
      s.list()?.onClose()
      s.update()
      const before = beeps()
      s.drive([{ x: 0, y: 690, speed: 8, heading: 0 }])
      expect([s.notice(), s.props.round.missed ?? [], s.props.round.handledStopIds, s.nextName()]).toEqual([null, [], ['A'], 'C'])
      s.drive(legs(8, [0, 690], [0, 630]).map((f) => ({ ...f, heading: 180 })))
      expect(s.banner()).toEqual(['C'])
      expect(beeps()).toBe(before + 1)
    })

    it('holds for a house as well: it stays to do on the first fix', async () => {
      const s = started(routeOf([[0, 0], [0, 1500]], [noThrowAt('H', [8, 600])]))
      s.drive(up(700))
      expect(s.props.round.handledStopIds).toEqual(['H'])
      await skipTo(s, 500)
      s.drive([{ x: 0, y: 690, speed: 8, heading: 0 }])
      expect(s.props.round.handledStopIds).toEqual([])
    })

    it('leaves a skip ahead of the car with its stretch to catch up', async () => {
      const s = started(routeOf([[0, 0], [0, 1500]], [noThrowAt('H', [8, 600])]))
      s.drive(up(100))
      await skipTo(s, 500)
      s.drive([{ x: 0, y: 690, speed: 8, heading: 0 }])
      expect(s.props.round.handledStopIds).toEqual(['H'])
    })

    it('leaves a start from a spot as it is, with the car past the spot: the stretch from the spot to the car is caught up', () => {
      const s = roundScreen(routeOf([[0, 0], [0, 1500]], [noThrowAt('H', [8, 600])]), { round: { handledStopIds: [], furthest: 800 } })
      s.press('Choose Where to Start')
      // The picker watches the position, so the car is known to be past the spot picked.
      s.drive([{ x: 0, y: 680, speed: 8, heading: 0 }])
      s.find<Parameters<typeof StartPicker>[0]>(StartPicker)?.onPick(500, 'here')
      s.update()
      s.drive([{ x: 0, y: 690, speed: 8, heading: 0 }])
      expect(s.props.round.handledStopIds).toEqual(['H'])
    })

    it('leaves a carry-on, from where the car is, with its stretch to catch up: the spot is not behind the car', () => {
      const s = started(routeOf([[0, 0], [0, 1500]], [noThrowAt('K', [8, 1000])]))
      s.drive(legs(10, [0, 0], [0, 300], [150, 310], [150, 800], [0, 800], [0, 950]))
      s.offRoute()?.onCarryOn()
      s.update()
      s.noFixFor(15)
      s.drive([{ x: 0, y: 1150, speed: 10, heading: 0 }])
      expect(s.props.round.handledStopIds).toEqual(['K'])
    })
  })

  describe('an alert going by back on the route somewhere else', () => {
    const rejoined = (stops: Stop[], order?: string[]) => {
      const s = started(routeOf([[0, 0], [0, 1800]], stops), order)
      s.drive(legs(10, [0, 0], [0, 200], [150, 200], [150, 500], [0, 500], [0, 640]))
      expect(s.offRoute()?.phase).toBe('rejoined')
      return s
    }

    it('is a real pass: the bundle is missed, with its notice, keeps its Mark dropped, and the next alerts', () => {
      const s = rejoined([bundle('M', [8, 800]), bundle('Z', [8, 1500])], ['M', 'Z'])
      s.drive(up(780, 640))
      expect([s.banner(), beeps()]).toEqual([['M'], 1])
      s.drive(up(900, 780))
      expect(s.offRoute()?.phase).toBe('rejoined')
      expect([s.banner(), s.notices, s.props.round.missed, s.nextName()]).toEqual([[], ['Missed bundle: M'], ['M'], 'Z'])
      expect(s.openList()?.rows.find((r) => r.id === 'M')).toMatchObject({ status: 'missed', markKey: 'M' })
      s.list()?.onClose()
      s.update()
      s.drive(up(1490, 900))
      expect(s.banner()).toEqual(['Z'])
      expect(beeps()).toBe(2)
    })

    it('settles the earlier pass with it, as on the route', () => {
      // M has a pass on the first leg, behind where the car rejoins, and one on the way back past it.
      const s = started(routeOf([[0, 0], [0, 900], [0, 0]], [bundle('M', [8, 300]), bundle('Z', [8, 100])]), ['M', 'Z'])
      s.drive(legs(10, [0, 0], [0, 200], [150, 210], [150, 500], [60, 600], [40, 880], [0, 890]))
      s.drive(legs(10, [0, 890], [0, 900], [0, 340]))
      const phase = s.offRoute()?.phase
      s.drive(legs(10, [0, 340], [0, 240]))
      expect([phase, s.props.round.missed]).toEqual(['rejoined', ['M#2']])
      expect(s.props.round.handledStopIds).toEqual(expect.arrayContaining(['M', 'M#2']))
      expect(s.nextName()).toBe('Z')
    })

    it('leaves a house to come up again, as it was', () => {
      const s = rejoined([noThrowAt('H', [8, 800])])
      s.drive(up(780, 640))
      expect(s.banner()).toEqual(['H'])
      s.drive(up(900, 780))
      expect([s.banner(), s.props.round.handledStopIds, s.notice()]).toEqual([[], [], null])
    })

    it('leaves one going by while off the route as it was: nothing says where along the route the car is', () => {
      // The tracker stays where the car left the road, so K comes up from the side street beside it, and the place along the route goes past it only as the car comes back on.
      const s = started(routeOf([[0, 0], [0, 1500]], [bundle('K', [8, 195]), bundle('Z', [8, 1400])]))
      s.drive(legs(10, [0, 0], [0, 150], [70, 160], [70, 195]))
      expect([s.offRoute()?.phase, s.banner()]).toEqual(['off', ['K']])
      s.drive(legs(10, [70, 195], [70, 500], [0, 505], [0, 515]))
      expect([s.props.round.missed ?? [], s.nextName()]).toEqual([[], 'K'])
    })
  })

  describe('a bundle set back from the road', () => {
    const past = (distance: number, off: number) => {
      vi.clearAllMocks()
      const s = roundScreen(routeOf([[0, 0], [0, 1000]], [bundle('P', [off, 300]), bundle('Z', [8, 700])]), { order: ['P', 'Z'] })
      pickDistance(s, distance)
      s.press('Start Round')
      s.drive(up(900))
      return s
    }

    it('alerts from the road at every alert distance, and goes by as ever, so it does not hold the list', () => {
      for (const [distance, off] of [[10, 45], [10, 55], [10, 60], [20, 55], [20, 60], [30, 60]]) {
        const s = past(distance, off)
        expect([distance, off, beeps(), s.props.round.missed]).toEqual([distance, off, 2, ['P', 'Z']])
      }
    })

    it('leaves one over 60 m off the road to the driver: it never comes up from the road, and they are told it is behind them', () => {
      const s = past(10, 65)
      expect([beeps(), s.props.round.missed ?? [], s.nextName(), s.notices]).toEqual([0, [], 'P', [behind('P')]])
    })

    describe('on a street driven twice', () => {
      /** Out and back past P, with F first on the list, dropped at the far end of the way out, so P goes by on the way out while it is not next. */
      const pastTwice = (distance: number, off: number, order: string[]) => {
        vi.clearAllMocks()
        const s = roundScreen(routeOf([[0, 0], [0, 1300], [0, 0]], [bundle('P', [off, 300]), bundle('Z', [8, 600]), bundle('F', [8, 900])]), { order })
        pickDistance(s, distance)
        s.press('Start Round')
        return s
      }

      it('meets a stop driven by while it was not next on its later pass, so going by settles the stop and the list moves on', { timeout: 60_000 }, () => {
        for (const [distance, off] of [[10, 41], [10, 50], [10, 60], [20, 51], [20, 60]]) {
          const s = pastTwice(distance, off, ['F', 'P', 'Z'])
          s.drive(legs(10, [0, 0], [0, 900]))
          s.tapDropped()
          s.drive(legs(10, [0, 900], [0, 1300], [0, 1000]))
          s.drive(legs(10, [0, 1000], [0, 100]))
          expect([distance, off, s.props.round.missed, s.nextName()]).toEqual([distance, off, ['P#2'], 'Z'])
          expect(s.openList()?.rows.find((r) => r.id === 'P')).toMatchObject({ status: 'missed', markKey: 'P#2' })
        }
      })

      it('leaves a stop next from the start as it was: its first pass goes by, and it has its later pass to come', () => {
        const s = pastTwice(10, 50, ['P', 'F', 'Z'])
        s.drive(legs(10, [0, 0], [0, 500]))
        expect([s.props.round.missed, s.nextName()]).toEqual([['P'], 'P'])
        s.drive(legs(10, [0, 500], [0, 1300], [0, 1000]))
        s.drive(legs(10, [0, 1000], [0, 280]))
        expect(s.banner()).toEqual(['P'])
      })

      it('alerts on the first pass still, for a stop that becomes next with the car just past it', () => {
        const s = roundScreen(routeOf([[0, 0], [0, 1300], [0, 0]], [bundle('P', [50, 300]), bundle('F', [8, 330])]), { order: ['F', 'P'] })
        pickDistance(s, 10)
        s.press('Start Round')
        s.drive(legs(10, [0, 0], [0, 330]))
        s.tapDropped()
        expect(s.banner()).toEqual(['P'])
        s.drive(legs(10, [0, 330], [0, 500]))
        s.drive(legs(10, [0, 500], [0, 1300], [0, 1000]))
        s.drive(legs(10, [0, 1000], [0, 300]))
        expect(s.banner()).toEqual(['P'])
      })
    })
  })

  describe('visited on a street the route drives again later', () => {
    // East along the street, round, and along it again as far as x = 1000, 4.7 m north of the first pass, as a road drawn twice by hand is. C is 85 m north of
    // the street, and H, next after it, is further along the first pass, with no pass of its own on the second.
    const twice: XY[] = [[0, 0], [1500, 0], [1500, 500], [-200, 500], [-200, 4.7], [1000, 4.7], [1000, -600]]
    const visited = (speed: number, dwell: number) => {
      vi.clearAllMocks()
      const s = roundScreen(routeOf(twice, [bundle('C', [900, 85]), bundle('H', [1300, 8])]), { order: ['C', 'H'] })
      s.press('Start Round')
      s.drive(legs(10, [0, 0], [900, 0]))
      s.drive(legs(speed, [900, 0], [900, 80]))
      s.tapDropped()
      s.drive(Array.from({ length: dwell }, () => ({ x: 900, y: 80, speed: 0, heading: 0 })))
      s.drive(legs(speed, [900, 80], [900, 0]))
      return s
    }

    it('comes back on the pass it left: H is not told of as behind the car, nor missed, and the round does not carry on from the later pass', { timeout: 60_000 }, () => {
      // Back onto the street, the later pass was in reach a fix or two before the one the car left, and the only place there was to put it.
      for (const [speed, dwell] of [[1, 0], [2, 0], [2, 30], [5, 0], [5, 30]]) {
        const s = visited(speed, dwell)
        s.drive(legs(10, [900, 0], [1100, 0]))
        expect([speed, dwell, s.notices.filter((n) => n.includes('Next bundle')), s.props.round.missed ?? [], s.nextName()]).toEqual([speed, dwell, [], [], 'H'])
        expect(s.props.round.furthest ?? 0, `${speed} m/s, ${dwell} s`).toBeLessThan(1200)
        s.drive(legs(10, [1100, 0], [1300, 0]))
        expect(s.banner(), `${speed} m/s, ${dwell} s`).toEqual(['H'])
      }
    })
  })

  describe('a next bundle away from the route, visited with the off-route banner up', () => {
    const K = bundle('K', [300, 1700])
    const STOPS = [K, bundle('Z', [8, 2400])]
    /** Off the street at 500 m, far enough from K for that to count as leaving the route, and out into K's zone: too far from the road for the route to bring the car to it. */
    const toK = () => {
      const s = roundScreen(routeOf([[0, 0], [0, 2500]], STOPS), { order: ['K', 'Z'] })
      s.press('Start Round')
      s.drive(legs(10, [0, 0], [0, 500], [200, 500]))
      expect(s.offRoute()?.phase).toBe('off')
      s.drive(legs(10, [200, 500], [300, 1500], [300, 1690]))
      expect([s.offRoute()?.phase, s.banner()]).toEqual(['off', ['K']])
      return s
    }

    it('counts it missed when the car leaves its zone with no tap, tells the driver, keeps its Mark dropped, and moves on', () => {
      const s = toK()
      s.drive(legs(10, [300, 1690], [300, 1500]))
      expect(s.props.round.missed).toEqual(['K'])
      expect(s.nextName()).toBe('Z')
      expect(s.notices).toContain('Missed bundle: K')
      expect(s.openList()?.rows.map((r) => [r.id, r.status])).toEqual([['K', 'missed'], ['Z', 'next']])
      expect(s.list()?.rows[0].markKey).toBe('K')
      s.list()?.onMark('K')
      s.update()
      expect(s.list()?.rows[0].status).toBe('dropped')
    })

    it('does the same while being taken back to where the route was left', () => {
      // Up a street and down the next, 600 m on, with K a long way out to the east.
      const s = roundScreen(routeOf([[0, 0], [0, 1000], [600, 1000], [600, 0]], [bundle('K', [1100, 900]), bundle('Z', [608, 20])]), { order: ['K', 'Z'] })
      s.press('Start Round')
      // Off the route, across, back onto it on the second street, and on down it till the banner asks.
      s.drive(legs(10, [0, 0], [0, 100], [100, 110], [100, 400], [600, 400], [600, 100]))
      expect(s.offRoute()?.phase).toBe('rejoined')
      s.offRoute()?.onTakeBack()
      s.update()
      expect(s.offRoute()?.phase).toBe('returning')
      s.drive(legs(10, [600, 100], [1100, 100], [1100, 890]))
      // Leaving the route again on the way there is still being taken back: the banner is up, and the phone is not on the route.
      expect([s.offRoute()?.phase, s.banner()]).toEqual(['off', ['K']])
      s.drive(legs(10, [1100, 890], [1100, 700]))
      expect([s.props.round.missed, s.nextName()]).toEqual([['K'], 'Z'])
    })
  })
})

describe('never holding the list in silence, on the real screen', () => {
  const started = (route: Route, order?: string[]) => {
    const s = roundScreen(route, { order })
    s.press('Start Round')
    return s
  }

  describe('a carry-on ahead of the next bundle', () => {
    const STOPS = [bundle('M', [8, 400]), bundle('Z', [8, 1100]), noThrowAt('H', [8, 1000])]
    const round = () => {
      const s = started(routeOf([[0, 0], [0, 1500]], STOPS), ['M', 'Z'])
      s.drive(legs(10, [0, 0], [0, 300], [150, 310], [150, 800], [0, 800], [0, 950]))
      expect(s.offRoute()?.phase).toBe('rejoined')
      expect([s.notice(), toldAloud()]).toEqual([null, 0])
      s.offRoute()?.onCarryOn()
      s.update()
      return s
    }

    it('tells the driver once, and the voice with it, on the next fix, with nothing else changed', () => {
      const s = round()
      // The house at 1,000 m comes up on the first fix, so it waits for the next.
      s.drive(up(970, 950))
      expect([s.notice(), toldAloud()]).toEqual([behind('M'), 1])
      expect([s.nextName(), s.props.round.missed ?? [], s.props.round.dropped ?? []]).toEqual(['M', [], []])
      s.drive(up(1050, 970))
      expect(toldAloud()).toBe(1)
    })

    it('waits for a fix with no alert coming up, whose words would take its place, and then says it breaking in on nothing', () => {
      const s = round()
      // The house at 1,000 m comes up on this fix, with its words.
      s.drive(up(960, 950))
      expect([s.banner(), s.notice(), toldAloud()]).toEqual([['H'], null, 0])
      s.drive(up(970, 960))
      expect(toldAloud()).toBe(1)
      const [, options] = vi.mocked(say).mock.calls.find(([text]) => text === NEXT_BEHIND_SPEECH) ?? []
      expect(options?.urgent ?? false).toBe(false)
    })

    it('leaves it to alert by place if the driver goes back for it', () => {
      const s = round()
      s.drive(up(960, 950))
      s.drive(legs(10, [0, 960], [150, 960], [150, 400], [40, 400]))
      expect(s.banner()).toEqual(['M'])
      s.tapDropped()
      expect(s.props.round.dropped).toEqual(['M'])
      expect(s.nextName()).toBe('Z')
    })

    it('tells it by itself too, when the round carries on by itself', () => {
      const s = started(routeOf([[0, 0], [0, 1500]], STOPS), ['M', 'Z'])
      s.drive(legs(10, [0, 0], [0, 300], [150, 310], [150, 700], [0, 700], [0, 850]))
      expect(s.offRoute()?.phase).toBe('rejoined')
      const slowly = legs(2.5, [0, 850], [0, 1050])
      while (s.offRoute() && slowly.length) s.drive(slowly.splice(0, 1))
      expect(s.notice()).toBe('Carrying on from here.')
      // It waits for that notice to go from the bar.
      s.drive(slowly.splice(0, 2))
      expect([s.notice(), toldAloud()]).toEqual(['Carrying on from here.', 0])
      s.drive(slowly.splice(0, 6))
      expect(s.notices).toEqual(['Carrying on from here.', behind('M')])
      expect(toldAloud()).toBe(1)
    })
  })

  it('tells of a turn round short of it, and it stays next', () => {
    const X = bundle('X', [8, 260])
    const s = started(routeOf([[0, 0], [0, 400], [0, 0]], [X, bundle('Y', [8, 40])]), ['X', 'Y'])
    s.drive(legs(10, [0, 0], [0, 200], [0, 195], [0, 190]))
    s.drive(legs(10, [0, 190], [0, 120]))
    expect(s.notice()).toBeNull()
    s.drive(legs(10, [0, 120], [0, 60]))
    expect([s.notices, s.props.round.missed ?? [], s.nextName()]).toEqual([[behind('X')], [], 'X'])
  })

  it('tells of a court the tracker moved on past', () => {
    // The car goes by the court's junction and on along the street, with T at the far end of the court.
    const s = started(routeOf([[0, 0], [0, 300], [90, 300], [0, 300], [0, 1200]], [bundle('T', [80, 308]), bundle('Z', [8, 1100])]))
    s.drive(up(560))
    expect([s.notices, s.props.round.missed ?? [], s.nextName()]).toEqual([[behind('T')], [], 'T'])
  })

  it('tells of the next bundle left by a cut across to the next street, with the guard against a false miss', () => {
    const s = started(routeOf([[0, 0], [0, 1000], [140, 1000], [140, 0]], [bundle('A', [8, 500]), bundle('B', [8, 700])]))
    s.drive(up(300))
    // (Nothing is said while the car only comes up to the street: being near it is not being on it. Driving on along it, the driver is asked first.)
    s.drive(legs(12, [0, 300], [140, 300], [140, 150]))
    expect([s.offRoute()?.phase, s.notices, s.props.round.missed ?? [], s.nextName()]).toEqual(['rejoined', [], [], 'A'])
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(legs(12, [140, 150], [140, 120]))
    expect([s.notices, s.props.round.missed ?? [], s.nextName()]).toEqual([[behind('A')], [], 'A'])
  })

  it('tells of one gone by on a road so bent it can\'t be counted, once the round has carried on from where the car came out', () => {
    // Up and back down the two sides of a tight loop, unseen: more road than the guard will take, and the car comes out well past it, back on the route somewhere else.
    const s = started(routeOf([[0, 0], [0, 300], [60, 300], [60, 0], [120, 0], [120, 900]], [bundle('A', [8, 250]), bundle('Z', [128, 800])]))
    s.drive(up(100))
    s.noFixFor(40)
    s.drive(legs(10, [120, 300], [120, 500]))
    expect([s.offRoute()?.phase, s.notices, s.props.round.missed ?? [], s.nextName()]).toEqual(['rejoined', [], [], 'A'])
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(up(510, 500).map((f) => ({ ...f, x: 120 })))
    expect(s.notices).toEqual([behind('A')])
  })

  it('waits for the car to be more than 150 m from the stop in a straight line, however far on along the route', () => {
    // The route goes up the street and back down the next, 90 m east: the car on the way back is a long way on along the route, and close to the bundle.
    const s = started(routeOf([[0, 0], [0, 600], [90, 600], [90, 0]], [bundle('A', [8, 250]), bundle('Z', [98, 20])]))
    s.drive(up(100))
    s.noFixFor(25)
    s.drive(legs(10, [90, 320], [90, 160]))
    expect(s.offRoute()?.phase).toBe('rejoined')
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(legs(10, [90, 160], [90, 130]))
    expect(s.notices).toEqual([])
    s.drive(legs(10, [90, 130], [90, 110]))
    expect(s.notices).toEqual([behind('A')])
  })

  describe('a bundle already behind the car as the list comes to it by itself', () => {
    /*
     * A goes up a street at 200 m, round a block, and back up the same street at about 2,600 m, with B and C on the block between. D and E are further up the street, ahead of the
     * car all the time. No tap on A's first pass leaves it next for its second, and the car goes by B and C with them not next.
     */
    const POINTS: XY[] = [[0, 0], [0, 400], [600, 400], [600, -200], [0, -200], [0, 1500]]
    const STOPS = [bundle('A', [8, 200]), bundle('B', [300, 408]), bundle('C', [608, 100]), bundle('D', [8, 1000]), bundle('E', [8, 1300])]
    const DRIVE = legs(10, ...POINTS)
    /** The drive from `from` metres to `to` metres along it. */
    const leg = (from: number, to: number) => DRIVE.slice(Math.round(from / 10), Math.round(to / 10))
    const toSecondPass = () => {
      const s = started(routeOf(POINTS, STOPS))
      s.drive(leg(0, 2600))
      expect([s.nextName(), s.banner(), s.notices]).toEqual(['A', ['A'], ['Missed bundle: A', still('A')]])
      expect(toldAloud()).toBe(0)
      return s
    }

    it('tells of it after a drop on the second pass, once the Undo has gone from the bar', () => {
      const s = toSecondPass()
      s.tapDropped()
      s.drive(leg(2600, 2700))
      expect([s.notice(), toldAloud()]).toEqual(['Dropped', 0])
      s.drive(leg(2700, 2800))
      expect([s.notices, s.nextName(), toldAloud()]).toEqual([['Missed bundle: A', still('A'), 'Dropped', behind('B')], 'B', 1])
    })

    it('says nothing when the drop is taken back with Undo before the bar is free', () => {
      const s = toSecondPass()
      s.tapDropped()
      s.drive(leg(2600, 2650))
      s.find<Parameters<typeof RoundBar>[0]>(RoundBar)?.notice?.undo?.()
      s.update()
      expect([s.nextName(), s.notices, toldAloud()]).toEqual(['A', ['Missed bundle: A', still('A'), 'Dropped'], 0])
    })

    it('tells of it when the second pass goes by with no tap too, after the notice of the miss', () => {
      const s = toSecondPass()
      s.drive(leg(2600, 2640))
      expect(s.notice()).toBe('Missed bundle: A')
      s.drive(leg(2640, 2800))
      expect([s.notices.at(-1), s.nextName(), toldAloud()]).toEqual([behind('B'), 'B', 1])
    })

    it('tells the driver with the voice off too, on the bar', () => {
      play.voice = false
      const s = toSecondPass()
      s.tapDropped()
      s.drive(leg(2600, 2800))
      expect(s.notices.at(-1)).toBe(behind('B'))
    })

    it('tells of each in turn as the one before is dealt with, not while the list is up, and the list then runs as ever', () => {
      const s = toSecondPass()
      s.tapDropped()
      s.drive(leg(2600, 2800))
      expect(s.notices.at(-1)).toBe(behind('B'))
      s.openList()?.onMark('B')
      s.update()
      expect(s.nextName()).toBe('C')
      s.drive(leg(2800, 2850))
      expect([s.notices.at(-1), toldAloud()]).toEqual([behind('B'), 1])
      s.list()?.onClose()
      s.update()
      s.drive(leg(2850, 3000))
      expect([s.notices.at(-1), s.nextName(), toldAloud()]).toEqual([behind('C'), 'C', 2])
      s.openList()?.onMark('C')
      s.update()
      s.list()?.onClose()
      s.update()
      expect(s.nextName()).toBe('D')
      s.drive(leg(3000, 3390))
      expect(s.banner()).toEqual(['D'])
    })

    it('tells of it after Mark dropped in the list on the first bundle', () => {
      const s = started(routeOf(POINTS, STOPS))
      s.drive(leg(0, 1500))
      s.openList()?.onMark('A')
      s.update()
      s.list()?.onClose()
      s.update()
      s.drive(leg(1500, 1700))
      expect([s.nextName(), s.notices.at(-1), toldAloud()]).toEqual(['B', behind('B'), 1])
    })
  })

  describe('a next bundle holding up those after it, with a pass still to come', () => {
    const POINTS: XY[] = [[0, 0], [0, 400], [600, 400], [600, -200], [0, -200], [0, 1500]]
    const DRIVE = legs(10, ...POINTS)
    const leg = (from: number, to: number) => DRIVE.slice(Math.round(from / 10), Math.round(to / 10))
    const STOPS = [bundle('A', [8, 200]), bundle('B', [300, 408]), bundle('D', [8, 1000])]
    const spoken = () => vi.mocked(say).mock.calls.filter(([text]) => text === stillNextSpeech('A')).length

    it('says so by name as the car goes by the first bundle after it, not at the end of the second pass, and the bundle stays next', () => {
      const s = started(routeOf(POINTS, STOPS))
      s.drive(leg(0, 500))
      expect([s.notices, spoken()]).toEqual([['Missed bundle: A'], 0])
      s.drive(leg(500, 800))
      expect([s.notices, spoken(), s.nextName()]).toEqual([['Missed bundle: A', still('A')], 1, 'A'])
      s.drive(leg(800, 2500))
      expect([s.notices.length, spoken()]).toEqual([2, 1])
    })

    it('shows it on the bar with the voice off', () => {
      play.voice = false
      const s = started(routeOf(POINTS, STOPS))
      s.drive(leg(0, 800))
      expect([s.notices.at(-1), spoken()]).toEqual([still('A'), 0])
    })

    it('says nothing with no bundle gone by, however far on the pass still to come is', () => {
      const s = started(routeOf(POINTS, [bundle('A', [8, 200]), bundle('D', [8, 1000])]))
      s.drive(leg(0, 2500))
      expect([s.notices, spoken()]).toEqual([['Missed bundle: A'], 0])
    })

    it('says nothing of a house gone by: that costs the driver no bundle', () => {
      const s = started(routeOf(POINTS, [bundle('A', [8, 200]), noThrowAt('H', [300, 408]), bundle('D', [8, 1000])]))
      s.drive(leg(0, 2500))
      expect([s.notices, spoken()]).toEqual([['Missed bundle: A'], 0])
    })

    it('says nothing of a bundle the car has yet to come to, however many others go by first: that is the driver\'s order at work', () => {
      const s = started(routeOf([[0, 0], [0, 1500]], [bundle('N', [8, 100]), bundle('M', [8, 300]), bundle('Q', [8, 1000]), bundle('Z', [8, 1400])]), ['Q', 'N', 'M', 'Z'])
      s.drive(up(900))
      expect([s.nextName(), s.notices, toldAloud()]).toEqual(['Q', [], 0])
    })

    it('tells of a bundle set too far from the road to alert, as soon as the car goes by the next one, not at its last pass', () => {
      // Up the street and back: F, 90 m off it, is never in reach of a car on the road, on either pass.
      const s = started(routeOf([[0, 0], [0, 800], [0, 0]], [bundle('F', [90, 200]), bundle('G', [8, 500])]), ['F', 'G'])
      s.drive(up(700))
      expect([s.nextName(), s.banner(), s.notices, vi.mocked(say).mock.calls.filter(([text]) => text === stillNextSpeech('F')).length]).toEqual(['F', [], [still('F')], 1])
    })

    it('is said once for a bundle: not again, and not as behind the car either, when it comes to that', () => {
      const s = started(routeOf([[0, 0], [0, 800], [0, 0], [0, -1500]], [bundle('F', [90, 200]), bundle('G', [8, 500])]), ['F', 'G'])
      s.drive(legs(10, [0, 0], [0, 800], [0, -1400]))
      expect([s.nextName(), s.notices, toldAloud()]).toEqual(['F', [still('F')], 0])
    })

    it('says it as behind the car, once, of a bundle with no pass to come', () => {
      const s = started(routeOf([[0, 0], [0, 3000]], [bundle('F', [90, 200]), bundle('G', [8, 500]), bundle('Z', [8, 2900])]), ['F', 'G', 'Z'])
      s.drive(up(2800))
      expect([s.notices, toldAloud()]).toEqual([[behind('F')], 1])
    })

    it('waits while its alert is up by place: the car is still at it', () => {
      const s = started(routeOf([[0, 0], [0, 1500]], [bundle('P', [8, 300]), bundle('C', [8, 320]), bundle('A', [8, 340]), bundle('Z', [8, 1400])]), ['A', 'P', 'C', 'Z'])
      s.drive(up(325))
      s.tapDropped()
      // Rolling on, not parked: the tracker sets aside a phone standing still, so a parked car gives the screen no fix to tell on, whatever the check says. The Undo goes from the bar with the car still in P's zone.
      s.drive(legs(1.6, [0, 325], [0, 347]))
      expect([s.nextName(), s.banner(), s.notice(), s.notices]).toEqual(['P', ['P'], null, ['Dropped']])
    })

    it('says nothing of a bundle still ahead of the car after Continue Round from further on: past it means past where the car is', () => {
      const route = routeOf([[0, 0], [0, 3000]], [bundle('A', [8, 600]), bundle('B', [8, 800]), bundle('Z', [8, 2900])])
      const s = roundScreen(route, { order: ['A', 'B', 'Z'], round: { handledStopIds: [], furthest: 1000 } })
      s.press('Continue Round')
      s.drive(up(520, 250))
      expect([s.nextName(), s.banner(), s.notices, toldAloud()]).toEqual(['A', [], [], 0])
    })

    it('shortens a long name in the bar', () => {
      const long = { ...bundle('L', [90, 200]), label: 'The Corner Shop on Woolgoolga Road' }
      const s = started(routeOf([[0, 0], [0, 800], [0, 0]], [long, bundle('G', [8, 500])]), ['L', 'G'])
      s.drive(up(700))
      expect(s.notices).toEqual(['Next bundle is still The Corner Shop on Woolgo…. Mark it or move it in the Bundles list.'])
    })

    it('says nothing of a bundle the driver moved to the top of the list behind the car, as the next goes by', () => {
      const s = started(routeOf([[0, 0], [0, 1500]], [bundle('N', [8, 100]), bundle('Q', [8, 800]), bundle('Y', [8, 1200]), bundle('Z', [8, 1400])]), ['Q', 'N', 'Y', 'Z'])
      s.drive(up(400))
      s.openList()?.onOrder?.(['N', 'Q', 'Y', 'Z'])
      s.update()
      s.list()?.onClose()
      s.update()
      s.drive(up(1350, 400))
      expect([s.nextName(), s.notices, toldAloud()]).toEqual(['N', [], 0])
    })

    describe('with a list in the order the driver means to drive', () => {
      const banner = (s: ReturnType<typeof roundScreen>) => s.find<Parameters<typeof AlertBanner>[0]>(AlertBanner)
      /** The drive, tapping Dropped on each alert as it comes up, and the bundles tapped. */
      const tapping = (s: ReturnType<typeof roundScreen>, steps: Step[]) => {
        const tapped: string[] = []
        for (const f of steps) {
          s.drive([f])
          const b = banner(s)
          const id = b?.bundleUp?.id ?? (b?.stops[0].type === 'bundle' ? b.stops[0].id : undefined)
          if (b?.onDropped && id) {
            vi.advanceTimersByTime(700)
            s.tapDropped()
            tapped.push(id)
          }
        }
        return tapped
      }
      const tells = (s: ReturnType<typeof roundScreen>) => [s.notices.filter((n) => n !== 'Dropped'), vi.mocked(say).mock.calls.filter(([text]) => text.startsWith('Next bundle is still') || text === NEXT_BEHIND_SPEECH).length]

      it('says nothing with bundles left for a second pass of a street driven twice, each taken in turn', () => {
        // S goes by at 100 and 2,500, U at 150 and 2,550, B at 700 and R at 3,400. U's first pass goes by before S is next, and it can still be had after S.
        const s = started(routeOf(POINTS, [bundle('S', [8, 100]), bundle('U', [8, 150]), bundle('B', [300, 408]), bundle('R', [8, 1000])]), ['B', 'S', 'U', 'R'])
        expect(tapping(s, DRIVE)).toEqual(['B', 'S', 'U', 'R'])
        expect(tells(s)).toEqual([[], 0])
      })

      it('says nothing with the first in the list left for its second pass, and the one after it still to be had after that', () => {
        const s = started(routeOf(POINTS, [bundle('S', [8, 100]), bundle('U', [8, 150]), bundle('R', [8, 1000])]), ['S', 'U', 'R'])
        s.drive(leg(0, 700))
        expect(s.notices.filter((n) => n.includes('still'))).toEqual([])
      })

      it('says nothing of passes that interleave, each bundle taken on its last pass', () => {
        // X goes by at 100 and 2,500, W at 700, V at 1,300 and 3,400 (the far side of the block, and on past the street): W, X and V is the order they are taken in.
        const points: XY[] = [[0, 0], [0, 400], [600, 400], [600, -200], [0, -200], [0, 800], [900, 800], [900, 300], [640, 300], [640, 1200]]
        const s = started(routeOf(points, [bundle('X', [8, 100]), bundle('W', [300, 408]), bundle('V', [632, 300]), bundle('Z', [648, 1100])]), ['W', 'X', 'V', 'Z'])
        expect(tapping(s, legs(10, ...points))).toEqual(['W', 'X', 'V', 'Z'])
        expect(tells(s)).toEqual([[], 0])
      })

      it('tells as soon as a bundle gone by has no pass left after the next pass of the bundle next', () => {
        const s = started(routeOf(POINTS, [bundle('S', [8, 100]), bundle('O', [300, 408]), bundle('R', [8, 1000])]), ['S', 'O', 'R'])
        s.drive(leg(0, 800))
        expect(s.notices).toContain(still('S'))
      })
    })

    describe('and a reorder', () => {
      const reorder = (s: ReturnType<typeof roundScreen>, order: string[]) => {
        s.openList()?.onOrder?.(order)
        s.update()
        s.list()?.onClose()
        s.update()
      }

      it('is not told straight back to a driver who moves a bundle up for its second pass: what went by before is not its doing', () => {
        // Y goes by at 100 and 2,500, U at 150 with no second chance after that (it has only the street's other side), X at 3,400.
        const s = started(routeOf(POINTS, [bundle('Y', [8, 100]), bundle('U', [8, 150]), bundle('X', [8, 1000])]), ['X', 'Y', 'U'])
        s.drive(leg(0, 500))
        reorder(s, ['Y', 'X', 'U'])
        s.drive(leg(500, 520))
        expect(s.notices).toEqual([])
      })

      it('is told of for what the car goes by after that', () => {
        const s = started(routeOf(POINTS, [bundle('Y', [8, 100]), bundle('L', [300, 408]), bundle('X', [8, 1000])]), ['X', 'Y', 'L'])
        s.drive(leg(0, 500))
        reorder(s, ['Y', 'X', 'L'])
        s.drive(leg(500, 800))
        expect(s.notices).toEqual([still('Y')])
      })

      it('is not told again the moment the list closes on one told of, moved down and back up in one sitting', () => {
        const s = started(routeOf(POINTS, STOPS))
        s.drive(leg(0, 900))
        expect([s.notices.at(-1), s.notice(), spoken()]).toEqual([still('A'), null, 1])
        s.openList()?.onOrder?.(['B', 'A', 'D'])
        s.update()
        s.list()?.onOrder?.(['A', 'B', 'D'])
        s.update()
        s.list()?.onClose()
        s.update()
        s.drive(leg(900, 920))
        expect(spoken()).toBe(1)
      })

      it('tells again of one told of, marked, moved down, undone and put back on top, as the next bundle goes by: nothing from before stands', () => {
        const s = started(routeOf(POINTS, [bundle('A', [8, 200]), bundle('B', [300, 408]), bundle('C', [608, 100]), bundle('D', [8, 1000])]), ['A', 'B', 'C', 'D'])
        s.drive(leg(0, 900))
        expect(spoken()).toBe(1)
        s.openList()?.onMark('A')
        s.update()
        s.list()?.onOrder?.(['B', 'A', 'C', 'D'])
        s.update()
        s.list()?.onUndo('A')
        s.update()
        s.list()?.onOrder?.(['A', 'B', 'C', 'D'])
        s.update()
        s.list()?.onClose()
        s.update()
        s.drive(leg(900, 1400))
        expect(spoken()).toBe(2)
      })

      it('has Undo bringing a bundle back answer only for what goes by after that', () => {
        const s = started(routeOf(POINTS, [bundle('K', [8, 50]), bundle('A', [8, 200]), bundle('B', [300, 408]), bundle('D', [8, 1000])]), ['K', 'A', 'B', 'D'])
        s.drive(leg(0, 20))
        s.tapDropped()
        s.drive(leg(20, 900))
        expect(s.notices).toContain(still('A'))
        s.openList()?.onUndo('K')
        s.update()
        s.list()?.onClose()
        s.update()
        s.drive(leg(900, 930))
        expect([s.nextName(), s.notices.filter((n) => n === still('K'))]).toEqual(['K', []])
      })
    })

    it('waits for the words of a no-throw row held for the side, which would take its place on the fix they are named', () => {
      const street: XY[] = [[0, 0], [0, 650], [0, 3000]]
      const base = routeOf(street, [bundle('N', [8, 100]), bundle('Q', [8, 300]), noThrowAt('H', [8, 660]), bundle('Z', [8, 2900])])
      const s = started({ ...base, sideChanges: [{ idx: 0, side: 'left' }, { idx: 1, side: 'right' }] }, ['Q', 'N', 'Z'])
      s.drive(legs(10, [0, 0], [0, 260]))
      s.drive(legs(4, [0, 260], [0, 280]))
      s.tapDropped()
      s.drive(legs(36, [0, 280], [0, 640]))
      s.drive(legs(10, [0, 640], [0, 900]))
      const said = vi.mocked(say).mock.calls.map(([text]) => text)
      const row = said.findIndex((t) => t.startsWith('No throw'))
      expect(row).toBeGreaterThan(-1)
      expect(said.indexOf(NEXT_BEHIND_SPEECH)).toBeGreaterThan(row)
    })

    describe('and what went by while it was next', () => {
      const N = bundle('N', [8, 100])
      const X = bundle('X', [300, 408])
      const Z = bundle('Z', [8, 1000])
      const A1 = bundle('A', [100, 408])
      const reorder = (s: ReturnType<typeof roundScreen>, order: string[]) => {
        s.openList()?.onOrder?.(order)
        s.update()
        s.list()?.onClose()
        s.update()
      }

      it('counts a neighbour still in its window when the bundle above is tapped', () => {
        const s = started(routeOf(POINTS, [N, A1, bundle('C', [120, 408]), Z]), ['A', 'N', 'C', 'Z'])
        s.drive(leg(0, 530))
        s.tapDropped()
        expect(s.nextName()).toBe('N')
        s.drive(leg(530, 2450))
        expect(s.notices).toContain(still('N'))
      })

      it('counts a neighbour that goes by on the fix of the miss above it', () => {
        const s = started(routeOf(POINTS, [N, A1, bundle('C', [120, 408]), Z]), ['A', 'N', 'C', 'Z'])
        s.drive(leg(0, 2450))
        expect(s.notices).toContain(still('N'))
      })

      it('counts a bundle gone by in the gap the misses above it were in', () => {
        const s = started(routeOf(POINTS, [A1, bundle('B', [200, 408]), N, X, Z]), ['A', 'B', 'N', 'X', 'Z'])
        s.drive(leg(0, 450))
        s.noFixFor(35)
        s.drive(leg(800, 2450))
        expect(s.notices).toContain(still('N'))
      })

      it('counts the later leg of a court when the bundle above is tapped between its legs', () => {
        const points: XY[] = [[0, 0], [0, 800], [0, 0], [0, -1500]]
        const s = started(routeOf(points, [N, bundle('M', [8, 800]), bundle('X', [12, 785]), bundle('Z', [8, -1400])]), ['M', 'N', 'X', 'Z'])
        const drive = legs(10, ...points)
        s.drive(drive.slice(0, 80))
        s.tapDropped()
        expect(s.nextName()).toBe('N')
        s.drive(drive.slice(80, 148))
        expect(s.notices).toContain(still('N'))
      })

      it('counts a bundle gone by again after a skip back: moved to the top further on, the car is put behind it', async () => {
        const s = started(routeOf(POINTS, [N, X, Z]), ['Z', 'N', 'X'])
        s.drive(leg(0, 1400))
        reorder(s, ['N', 'Z', 'X'])
        s.drive(leg(1400, 1420))
        expect(s.notices).toEqual([])
        await skipTo(s, 600)
        s.drive(leg(600, 2450))
        expect(s.notices).toContain(still('N'))
      })

      it('counts a bundle gone by again after carrying on from further back', () => {
        const s = started(routeOf(POINTS, [N, X, Z]), ['Z', 'N', 'X'])
        s.drive(leg(0, 1400))
        reorder(s, ['N', 'Z', 'X'])
        s.drive(leg(1400, 1420))
        s.drive(legs(10, [600, -20], [300, -20], [300, 200], [100, 200], [100, 400]))
        s.drive(leg(500, 650))
        s.offRoute()?.onCarryOn()
        s.update()
        s.drive(leg(650, 2450))
        expect(s.notices).toContain(still('N'))
      })

      it('keeps what went by before a reorder uncounted through a carry-on further on', () => {
        const s = started(routeOf(POINTS, [N, X, Z]), ['Z', 'N', 'X'])
        s.drive(leg(0, 1400))
        reorder(s, ['N', 'Z', 'X'])
        s.drive(leg(1400, 1420))
        s.drive(legs(10, [600, -20], [300, -20], [300, 150], [600, 150]))
        s.drive(leg(1150, 1200))
        s.offRoute()?.onCarryOn()
        s.update()
        s.drive(leg(1200, 1500))
        expect(s.notices).toEqual([])
      })

      it('counts nothing from before Undo with every bundle done, as it does with one left', () => {
        const stops = [bundle('K', [8, 200]), bundle('L', [300, 408]), noThrowAt('H', [8, 1000])]
        const s = started(routeOf(POINTS, stops), ['K', 'L'])
        s.drive(leg(0, 180))
        expect(s.banner()).toEqual(['K'])
        s.tapDropped()
        s.drive(leg(180, 680))
        expect(s.banner()).toEqual(['L'])
        s.tapDropped()
        s.drive(leg(680, 900))
        expect(s.nextName()).toBe('All bundles dropped')
        s.openList()?.onUndo('K')
        s.update()
        s.list()?.onUndo('L')
        s.update()
        s.list()?.onClose()
        s.update()
        expect(s.nextName()).toBe('K')
        s.drive(leg(900, 1000))
        expect(s.notices.filter((n) => n.includes('still'))).toEqual([])
      })

      it('forgets what went by at a reset: the bundle next when the route is reached again answers for all of it, as after a reload', async () => {
        const s = started(routeOf(POINTS, [bundle('S', [8, 100]), bundle('O', [300, 408]), bundle('R', [8, 1000])]), ['S', 'O', 'R'])
        const told = () => vi.mocked(say).mock.calls.filter(([text]) => text === stillNextSpeech('S')).length
        s.drive(leg(0, 800))
        expect([s.nextName(), told()]).toEqual(['S', 1])
        s.askReset()
        s.press('Reset')
        await vi.advanceTimersByTimeAsync(0)
        s.update()
        s.drive(leg(800, 1100))
        expect([s.nextName(), told()]).toEqual(['S', 2])
      })

      it('forgets what went by at a reset with the order changed before the route is reached again', async () => {
        const s = started(routeOf(POINTS, [bundle('S', [8, 100]), bundle('O', [300, 408]), bundle('R', [8, 1000])]), ['R', 'S', 'O'])
        s.drive(leg(0, 800))
        expect([s.nextName(), s.notices]).toEqual(['R', []])
        s.askReset()
        s.press('Reset')
        await vi.advanceTimersByTimeAsync(0)
        s.update()
        reorder(s, ['S', 'R', 'O'])
        s.drive(leg(800, 1100))
        expect([s.nextName(), s.notices]).toEqual(['S', [still('S')]])
      })

      describe('and a poor fix thrown back', () => {
        const A = bundle('A', [370, 408])
        const thrown = { x: 290, y: 400, speed: 10, heading: 90, accuracy: 35 }

        it('has no pass gone by again that never was: what went before the list came to it stays uncounted', () => {
          const s = started(routeOf(POINTS, [N, X, A, Z]), ['A', 'N', 'X', 'Z'])
          s.drive(leg(0, 750))
          s.tapDropped()
          s.drive(leg(750, 790))
          s.drive([thrown])
          s.drive(leg(800, 1600))
          expect(s.notices.filter((n) => n !== 'Dropped')).toEqual([])
        })

        it('has none after a reorder either: the driver is not told straight back of what they have just decided', () => {
          const s = started(routeOf(POINTS, [N, X, Z]), ['Z', 'N', 'X'])
          s.drive(leg(0, 790))
          reorder(s, ['N', 'Z', 'X'])
          s.drive([thrown])
          s.drive(leg(800, 1600))
          expect(s.notices).toEqual([])
        })

        it('leaves out what it says of the car when a tap comes on it', () => {
          const s = started(routeOf(POINTS, [N, X, A, Z]), ['A', 'N', 'X', 'Z'])
          s.drive(leg(0, 780))
          s.drive([thrown])
          s.tapDropped()
          s.drive(leg(790, 1600))
          expect(s.notices.filter((n) => n !== 'Dropped')).toEqual([])
        })

        it('does not make a bundle moved to the top behind the car one to tell of: it is not ahead for having been put there', () => {
          const s = started(routeOf([[0, 0], [0, 3000]], [bundle('P', [8, 200]), bundle('Q', [8, 1400]), bundle('R', [8, 2900])]), ['Q', 'P', 'R'])
          s.drive(up(250))
          reorder(s, ['P', 'Q', 'R'])
          s.drive(up(300, 250))
          s.drive([{ x: 0, y: 212, speed: 10, heading: 0, accuracy: 50 }])
          s.drive(up(800, 310))
          expect([s.nextName(), s.notices]).toEqual(['P', []])
        })
      })

      it('has no pass gone by again for a car off the route that crosses an earlier street', () => {
        const points: XY[] = [[0, 0], [0, 1000], [300, 1000], [300, -100], [0, -100], [0, 200], [-300, 200]]
        const drive = legs(10, ...points)
        const s = started(routeOf(points, [bundle('N', [8, 100]), bundle('X', [8, 500]), bundle('A', [8, 900]), bundle('Z', [-250, 208])]), ['A', 'N', 'X', 'Z'])
        s.drive(drive.slice(0, 87))
        s.tapDropped()
        s.drive(drive.slice(87, 190))
        s.drive(legs(10, [300, 400], [-100, 400], [-100, 300], [300, 300]))
        s.drive(drive.slice(200, 240))
        expect(s.notices.filter((n) => n !== 'Dropped')).toEqual([])
      })

      it('does not make a bundle moved to the top behind the car one to tell of, for a car off the route that crosses the street short of it', () => {
        const points: XY[] = [[0, 0], [0, 1000], [300, 1000], [300, -100], [0, -100], [0, 200], [-300, 200]]
        const drive = legs(10, ...points)
        const s = started(routeOf(points, [bundle('P', [8, 500]), bundle('Q', [-250, 208]), bundle('R', [-280, 208])]), ['Q', 'P', 'R'])
        s.drive(drive.slice(0, 190))
        reorder(s, ['P', 'Q', 'R'])
        s.drive(legs(10, [300, 400], [-100, 400], [-100, 300], [300, 300]))
        s.drive(drive.slice(200, 240))
        expect([s.nextName(), s.notices]).toEqual(['P', []])
      })

      it('counts what went by before the route was reached, as nothing says the bundle was not next then: a round taken up again past it is told at once', () => {
        const s = roundScreen(routeOf(POINTS, STOPS), { order: ['A', 'B', 'D'], round: { handledStopIds: [], furthest: 900 } })
        s.press('Continue Round')
        s.drive(leg(900, 1200))
        expect([s.nextName(), s.notices, spoken()]).toEqual(['A', [still('A')], 1])
      })
    })

    it('says nothing of a neighbour taken on the way back right after the bundle next, though its pass there comes first', () => {
      const points: XY[] = [[0, 0], [0, 800], [0, 0], [0, -1000]]
      const s = started(routeOf(points, [bundle('N', [8, 300]), bundle('X', [8, 350]), bundle('Z', [8, -900])]))
      const drive = legs(10, ...points)
      s.drive(drive.slice(0, 120))
      expect(s.notices.filter((n) => n.includes('still'))).toEqual([])
    })

    it('tells with the voice turned off while a no-throw row is held: nothing is left to name it, so nothing holds the tell back', () => {
      const street: XY[] = [[0, 0], [0, 650], [0, 3000]]
      const base = routeOf(street, [bundle('N', [8, 100]), bundle('Q', [8, 590]), noThrowAt('H', [8, 660]), bundle('Z', [8, 2900])])
      const s = started({ ...base, sideChanges: [{ idx: 0, side: 'left' }, { idx: 1, side: 'right' }] }, ['Q', 'N', 'Z'])
      s.drive(legs(10, [0, 0], [0, 590]))
      s.tapDropped()
      s.drive(legs(5, [0, 590], [0, 640]))
      s.find<Parameters<typeof RoundButtons>[0]>(RoundButtons)?.onVoice()
      s.update()
      s.drive(legs(10, [0, 640], [0, 2980]))
      expect(s.notices).toContain(behind('N'))
    })

    it('tells again after a reorder takes it off the top, once the list comes back to it', () => {
      const s = started(routeOf([[0, 0], [0, 800], [0, 0]], [bundle('F', [90, 200]), bundle('G', [8, 500]), bundle('K', [8, 600])]), ['F', 'G', 'K'])
      s.drive(up(700))
      expect(s.notices).toEqual([still('F')])
      s.openList()?.onOrder?.(['G', 'F', 'K'])
      s.update()
      s.list()?.onMark('G')
      s.update()
      s.list()?.onClose()
      s.update()
      expect(s.nextName()).toBe('F')
      // Nothing has gone by since: K's pass on the way back is the first to cost it anything.
      s.drive(legs(10, [0, 700], [0, 800], [0, 300]))
      expect(vi.mocked(say).mock.calls.filter(([text]) => text === stillNextSpeech('F')).length).toBe(2)
    })
  })

  describe('a tell with the bar covered', () => {
    const route = () => routeOf([[0, 0], [0, 2500]], [bundle('N', [8, 100]), bundle('Q', [8, 400]), bundle('Z', [8, 2400])])
    const dropQ = () => {
      play.voice = false
      const s = started(route(), ['Q', 'N', 'Z'])
      s.drive(up(380))
      s.tapDropped()
      s.drive(up(420, 380))
      return s
    }
    it('waits for the menu to close', () => {
      const s = dropQ()
      s.find<Parameters<typeof RoundBar>[0]>(RoundBar)?.onMenu()
      s.update()
      s.drive(up(800, 420))
      expect(s.notices.at(-1)).toBe('Dropped')
      s.find<Parameters<typeof RoundMenu>[0]>(RoundMenu)?.onClose()
      s.update()
      s.drive(up(1000, 800))
      expect(s.notices.at(-1)).toBe(behind('N'))
    })

    it('waits for the picker of a spot to skip to to close', () => {
      const s = dropQ()
      s.find<Parameters<typeof RoundBar>[0]>(RoundBar)?.onMenu()
      s.update()
      const menu = s.find<Parameters<typeof RoundMenu>[0]>(RoundMenu)
      menu?.onClose()
      menu?.onSkip()
      s.update()
      s.drive(up(800, 420))
      expect(s.notices.at(-1)).toBe('Dropped')
      s.find<Parameters<typeof StartPicker>[0]>(StartPicker)?.onClose()
      s.update()
      s.drive(up(1000, 800))
      expect(s.notices.at(-1)).toBe(behind('N'))
    })

    it('waits for a question to be answered', async () => {
      const s = dropQ()
      s.askReset()
      expect(s.button('Reset')).toBeTruthy()
      s.drive(up(800, 420))
      expect(s.notices.at(-1)).toBe('Dropped')
      s.press('Cancel')
      await vi.advanceTimersByTimeAsync(0)
      s.update()
      s.drive(up(1000, 800))
      expect(s.notices.at(-1)).toBe(behind('N'))
    })
  })

  describe('a reorder after the driver has been told', () => {
    const STREET: XY[] = [[0, 0], [0, 3000]]
    const reorder = (s: ReturnType<typeof roundScreen>, order: string[]) => {
      s.openList()?.onOrder?.(order)
      s.update()
      s.list()?.onClose()
      s.update()
    }

    it('tells again if the driver moves it down as the notice says and the list comes back to it: the list must not stand still with nothing said', () => {
      const s = started(routeOf(STREET, [bundle('X', [8, 200]), bundle('Y', [8, 1200]), bundle('W', [8, 2500])]), ['X', 'Y', 'W'])
      s.drive(legs(10, [0, 0], [0, 100], [150, 110], [150, 800], [0, 800], [0, 950]))
      s.offRoute()?.onCarryOn()
      s.update()
      s.drive(up(1000, 950))
      expect([s.notice(), toldAloud()]).toEqual([behind('X'), 1])
      s.drive(up(1100, 1000))
      reorder(s, ['Y', 'X', 'W'])
      s.drive(up(1190, 1100))
      s.tapDropped()
      expect(s.nextName()).toBe('X')
      s.drive(up(2800, 1190))
      expect([s.nextName(), s.banner(), s.props.round.dropped, toldAloud()]).toEqual(['X', [], ['Y'], 2])
    })

    it('tells of a bundle moved to the top ahead of the car with the furthest reached past it: behind you means behind where the car is', () => {
      const s = started(routeOf(STREET, [bundle('A', [8, 100]), bundle('Y', [8, 600]), bundle('Z', [8, 2900])]), ['A', 'Y', 'Z'])
      s.drive(legs(10, [0, 0], [0, 50], [150, 60], [150, 900], [0, 900], [0, 1000]))
      s.offRoute()?.onCarryOn()
      s.update()
      s.drive(up(1100, 1000))
      s.drive(legs(10, [0, 1100], [0, 300]).map((f) => ({ ...f, heading: 180 })))
      s.drive(up(400, 300))
      reorder(s, ['Y', 'A', 'Z'])
      s.drive(legs(10, [0, 400], [0, 500], [150, 510], [150, 1400], [0, 1400], [0, 1600]))
      s.offRoute()?.onCarryOn()
      s.update()
      s.drive(up(2200, 1600))
      expect(s.nextName()).toBe('Y')
      expect(s.notices).toContain(behind('Y'))
    })

    it('tells of the same after Continue Round from further on than the car', () => {
      const route = routeOf(STREET, [bundle('A', [8, 100]), bundle('Y', [8, 600]), bundle('Z', [8, 2900])])
      const s = roundScreen(route, { order: ['A', 'Y', 'Z'], round: { handledStopIds: [], furthest: 1000 } })
      s.press('Continue Round')
      s.drive(up(520, 250))
      reorder(s, ['Y', 'A', 'Z'])
      s.drive(legs(10, [0, 520], [150, 530], [150, 900], [0, 900], [0, 1050]))
      s.offRoute()?.onCarryOn()
      s.update()
      s.drive(up(1500, 1050))
      expect(s.nextName()).toBe('Y')
      expect(s.notices).toContain(behind('Y'))
    })

    it('says nothing of one moved to the top behind the car, though it was next once before: moving it is the driver\'s decision', () => {
      const s = started(routeOf(STREET, [bundle('Y', [8, 300]), bundle('X', [8, 1000]), bundle('Z', [8, 2900])]), ['Y', 'X', 'Z'])
      s.drive(up(290))
      s.tapDropped()
      s.drive(up(320, 290))
      reorder(s, ['X', 'Y', 'Z'])
      s.openList()?.onUndo('Y')
      s.update()
      s.list()?.onClose()
      s.update()
      s.drive(up(700, 320))
      reorder(s, ['Y', 'X', 'Z'])
      s.drive(up(1300, 700))
      expect([s.nextName(), s.notices.filter((n) => n !== 'Dropped'), toldAloud()]).toEqual(['Y', [], 0])
    })
  })

  describe('a bundle whose alert is up behind a no-throw house at the same spot', () => {
    const HOUSE = noThrowAt('H', [8, 300])
    const SPOT = bundle('S', [8, 300])
    const strip = (s: ReturnType<typeof roundScreen>) => s.find<Parameters<typeof AlertBanner>[0]>(AlertBanner)

    it('has its Dropped button in the house\'s banner, and the tap counts as ever', () => {
      const s = started(routeOf([[0, 0], [0, 1500]], [HOUSE, SPOT, bundle('Z', [8, 1400])]))
      s.drive(up(290))
      expect([s.banner(), strip(s)?.bundleUp?.id, strip(s)?.waiting]).toEqual([['H'], 'S', 0])
      s.tapDropped()
      expect([s.props.round.dropped, s.banner(), strip(s)?.bundleUp, s.nextName()]).toEqual([['S'], ['H'], undefined, 'Z'])
      s.drive(up(420, 290))
      expect([s.notices, s.props.round.missed ?? []]).toEqual([['Dropped'], []])
    })

    it('counts it missed as ever with no tap', () => {
      const s = started(routeOf([[0, 0], [0, 1500]], [HOUSE, SPOT, bundle('Z', [8, 1400])]))
      s.drive(up(420))
      expect([s.props.round.missed, s.notices]).toEqual([['S'], ['Missed bundle: S']])
    })

    it('carries it behind a request at the same spot too, and in no banner of its own twice', () => {
      const request: Stop = { ...noThrowAt('R', [8, 300]), type: 'request' }
      const s = started(routeOf([[0, 0], [0, 1500]], [request, SPOT, bundle('Z', [8, 1400])]))
      s.drive(up(290))
      const banner = strip(s)
      expect([s.banner(), banner?.bundleUp?.id, !!banner?.onDropped]).toEqual([['R'], 'S', true])
    })

    it('carries no bundle put by over a turn round once the car is put past it', () => {
      // X comes up ahead of the car, which turns round short of it, so it is held, and the house comes up on the way back.
      const route = routeOf([[0, 0], [0, 600], [0, 0]], [bundle('X', [8, 225]), noThrowAt('H', [8, 150]), bundle('W', [8, 60])])
      const s = roundScreen(route, { order: ['X', 'W'] })
      s.press('Start Round')
      s.drive(up(200))
      expect(s.banner()).toEqual(['X'])
      s.drive(legs(5, [0, 200], [0, 195], [0, 150]))
      expect([s.banner(), strip(s)?.bundleUp, strip(s)?.onDropped]).toEqual([['H'], undefined, undefined])
    })

    it('carries no bundle that is not up', () => {
      const s = started(routeOf([[0, 0], [0, 1500]], [HOUSE, bundle('S', [8, 500]), bundle('Z', [8, 1400])]))
      s.drive(up(290))
      expect([s.banner(), strip(s)?.bundleUp, strip(s)?.onDropped]).toEqual([['H'], undefined, undefined])
    })
  })

  it('tells of a bundle the driver\'s own order put behind the car, a moment after the next is named, and it stays next', () => {
    const s = started(routeOf([[0, 0], [0, 1500]], [bundle('N', [8, 100]), bundle('Q', [8, 400]), bundle('Z', [8, 1400])]), ['Q', 'N', 'Z'])
    s.drive(up(380))
    s.tapDropped()
    expect(s.nextName()).toBe('N')
    s.drive(up(420, 380))
    expect([s.notice(), toldAloud()]).toEqual(['Dropped', 0])
    s.drive(up(800, 420))
    expect([s.notices.at(-1), toldAloud(), s.nextName()]).toEqual([behind('N'), 1, 'N'])
  })

  it('says nothing of one the driver moves to the top of the list once it is behind the car', () => {
    const s = started(routeOf([[0, 0], [0, 1500]], [bundle('N', [8, 100]), bundle('Q', [8, 800]), bundle('Z', [8, 1400])]), ['Q', 'N', 'Z'])
    s.drive(up(400))
    s.openList()?.onOrder?.(['N', 'Q', 'Z'])
    s.update()
    s.list()?.onClose()
    s.update()
    s.drive(up(1000, 400))
    expect([s.nextName(), s.notices, toldAloud()]).toEqual(['N', [], 0])
  })

  it('says nothing of one moved back up the list once it is behind the car, even if it was next while it was ahead', () => {
    const reorder = (s: ReturnType<typeof roundScreen>, order: string[]) => {
      s.openList()?.onOrder?.(order)
      s.update()
      s.list()?.onClose()
      s.update()
    }
    const s = started(routeOf([[0, 0], [0, 1500]], [bundle('Y', [8, 100]), bundle('X', [8, 300]), bundle('W', [8, 1400])]), ['X', 'Y', 'W'])
    s.drive(up(200))
    // Y, behind the car, goes first, so the car goes by X as a bundle not next. Then the driver puts X back.
    reorder(s, ['Y', 'X', 'W'])
    s.drive(up(600, 200))
    reorder(s, ['X', 'Y', 'W'])
    s.drive(up(800, 600))
    expect([s.nextName(), s.notices, toldAloud()]).toEqual(['X', [], 0])
  })

  it('tells of one taken back with Undo behind the car: it was ahead while it was next, and nothing else would ever say why the list has stopped', () => {
    const s = started(routeOf([[0, 0], [0, 1500]], [bundle('A', [8, 200]), bundle('Z', [8, 1400])]))
    s.drive(up(190))
    s.tapDropped()
    s.drive(up(300, 190))
    s.openList()?.onUndo('A')
    s.update()
    s.list()?.onClose()
    s.update()
    s.drive(up(600, 300))
    expect([s.nextName(), s.notices, toldAloud()]).toEqual(['A', ['Dropped', behind('A')], 1])
  })

  it('says nothing of one with a pass still to come, and alerts on that pass', () => {
    const route = routeOf([[0, 0], [0, 600], [0, 0]], [bundle('X', [8, 200]), bundle('Y', [8, 20])])
    const s = started(route, ['X', 'Y'])
    s.drive(up(150))
    s.noFixFor(15)
    s.drive(legs(10, [0, 300], [0, 600], [0, 230]))
    expect([s.notices, toldAloud()]).toEqual([[], 0])
    expect(s.banner()).toEqual(['X'])
  })

  it('says nothing on fixes too poor to go by: the fix is what stops it, and the first good one takes down the alert up by place, so the bundle is missed, not told of', () => {
    const s = started(routeOf([[0, 0], [0, 1500]], [bundle('N', [8, 100]), bundle('Q', [8, 300]), bundle('Z', [8, 1400])]), ['Q', 'N', 'Z'])
    s.drive(up(280))
    s.tapDropped()
    // Back to N, which came up behind the car, and on, with the phone reading too poorly to take the alert down.
    s.drive(legs(8, [0, 280], [0, 130]).map((f) => ({ ...f, heading: 180 })))
    expect(s.banner()).toEqual(['N'])
    s.drive(legs(15, [0, 130], [0, 500]).map((f) => ({ ...f, accuracy: 45 })))
    expect([s.banner(), s.notice(), toldAloud()]).toEqual([['N'], null, 0])
    s.drive(up(510, 500))
    expect([s.banner(), s.notice(), toldAloud(), s.props.round.missed]).toEqual([[], 'Missed bundle: N', 0, ['N']])
  })

  it('says nothing on a fix too poor to go by, thrown forward past a bundle the car has not got to', () => {
    const s = started(routeOf([[0, 0], [0, 1500]], [bundle('A', [8, 300]), bundle('Z', [8, 1400])]))
    s.drive(up(200))
    s.drive([{ x: 0, y: 500, speed: 10, heading: 0, accuracy: 60 }])
    expect([s.notice(), toldAloud()]).toEqual([null, 0])
  })

  describe('after Continue Round', () => {
    it('says nothing on the first fix, with the car well past a bundle that looked ahead of where the round was left: the route has not been reached yet', () => {
      const s = roundScreen(routeOf([[0, 0], [0, 1500]], [bundle('A', [8, 200]), bundle('Z', [8, 1400])]), { round: { handledStopIds: [], furthest: 100 } })
      s.press('Continue Round')
      s.drive(up(420, 400))
      expect([s.notice(), toldAloud()]).toEqual([null, 0])
    })

    it('tells the driver once the route is reached: the reload lost whether it was ever ahead, and an untold hold of the list is the worse fault', () => {
      const s = roundScreen(routeOf([[0, 0], [0, 1500]], [bundle('A', [8, 200]), bundle('Z', [8, 1400])]), { round: { handledStopIds: [], furthest: 100 } })
      s.press('Continue Round')
      s.drive(up(800, 400))
      expect([s.notices, toldAloud(), s.nextName()]).toEqual([[behind('A')], 1, 'A'])
    })
  })

  it('tells of what a car coming onto the route far along it finds behind it: a car joining past the next bundle is holding the list as surely as one that drove by it', () => {
    const s = started(routeOf([[0, 0], [0, 1500]], [A, bundle('Z', [8, 1400])]))
    // The car comes in from the side and down the road, far enough along it for the route to count as reached.
    s.drive(legs(10, [-200, 700], [0, 700], [0, 420]))
    expect([s.notices, toldAloud(), s.nextName()]).toEqual([[behind('A')], 1, 'A'])
  })

  describe('what is remembered of the next bundle', () => {
    const STOPS = [bundle('M', [8, 400]), bundle('N', [8, 2000]), bundle('Z', [8, 2600])]
    const STREET: XY[] = [[0, 0], [0, 3000]]
    /** Round a block past M, and back onto the street under 150 m on from it. */
    const pastM = () => {
      const s = started(routeOf(STREET, STOPS), ['M', 'N', 'Z'])
      s.drive(legs(10, [0, 0], [0, 300], [150, 310], [150, 470], [0, 470]))
      s.offRoute()?.onCarryOn()
      s.update()
      s.drive(up(500, 470))
      expect([s.offRoute(), s.notices, s.banner(), s.nextName()]).toEqual([undefined, [], [], 'M'])
      return s
    }
    const reopened = (was: ReturnType<typeof roundScreen>) => {
      const s = roundScreen(routeOf(STREET, STOPS), { order: ['M', 'N', 'Z'], round: was.props.round })
      s.press('Continue Round')
      return s
    }

    it('lasts through Mark dropped and Undo under 150 m past it, and it is told once', () => {
      const s = pastM()
      s.openList()?.onMark('M')
      s.update()
      expect(s.nextName()).toBe('N')
      s.list()?.onUndo('M')
      s.update()
      s.list()?.onClose()
      s.update()
      s.drive(up(1500, 500))
      expect([s.notices, toldAloud(), s.nextName()]).toEqual([[behind('M')], 1, 'M'])
    })

    it('is told once after a reload and Continue Round under 150 m past it', () => {
      const s = reopened(pastM())
      s.drive(up(1500, 500))
      expect([s.notices, toldAloud(), s.nextName()]).toEqual([[behind('M')], 1, 'M'])
    })

    it('is told once when the app is killed short of it and opened again past it', () => {
      const s = roundScreen(routeOf(STREET, STOPS), { order: ['M', 'N', 'Z'], round: { handledStopIds: [], furthest: 300 } })
      s.press('Continue Round')
      s.drive(up(1500, 1000))
      expect([s.notices, toldAloud(), s.nextName()]).toEqual([[behind('M')], 1, 'M'])
    })

    it('forgets that it was told when the screen is opened again, so it is told once more, and not again', () => {
      const s = pastM()
      s.drive(up(800, 500))
      expect(toldAloud()).toBe(1)
      const again = reopened(s)
      again.drive(up(1800, 800))
      expect([again.notices, toldAloud()]).toEqual([[behind('M')], 2])
    })

    it('tells of a bundle moved back by a reorder and driven past, once the list comes back to it by itself: every bundle after it is silent', () => {
      const s = started(routeOf(STREET, [bundle('X', [8, 300]), bundle('Y', [8, 1000]), bundle('W', [8, 2900])]), ['X', 'Y', 'W'])
      s.drive(up(200))
      s.openList()?.onOrder?.(['Y', 'X', 'W'])
      s.update()
      s.list()?.onClose()
      s.update()
      s.drive(up(990, 200))
      s.tapDropped()
      expect(s.nextName()).toBe('X')
      s.drive(up(1500, 990))
      expect([s.notices, toldAloud(), s.nextName()]).toEqual([['Dropped', behind('X')], 1, 'X'])
    })

    it('says nothing after a reorder there and back either: they have just been in the list', () => {
      const s = pastM()
      s.openList()?.onOrder?.(['N', 'M', 'Z'])
      s.update()
      s.list()?.onOrder?.(['M', 'N', 'Z'])
      s.update()
      s.list()?.onClose()
      s.update()
      s.drive(up(1500, 500))
      expect([s.notices, toldAloud(), s.nextName()]).toEqual([[], 0, 'M'])
    })

    it('keeps a bundle the reorder did not move from the top of the list', () => {
      const s = pastM()
      s.openList()?.onOrder?.(['M', 'Z', 'N'])
      s.update()
      s.list()?.onClose()
      s.update()
      s.drive(up(1500, 500))
      expect([s.notices, toldAloud()]).toEqual([[behind('M')], 1])
    })

    it('tells once of a bundle the list came to behind the car, through a carry-on as well', () => {
      const s = started(routeOf(STREET, [bundle('N', [8, 100]), bundle('Q', [8, 400]), bundle('Z', [8, 2900])]), ['Q', 'N', 'Z'])
      s.drive(up(380))
      s.tapDropped()
      expect(s.nextName()).toBe('N')
      s.drive(legs(10, [0, 380], [150, 390], [150, 900], [0, 900], [0, 1050]))
      expect(s.offRoute()?.phase).toBe('rejoined')
      s.offRoute()?.onCarryOn()
      s.update()
      s.drive(up(1500, 1050))
      expect([s.nextName(), toldAloud()]).toEqual(['N', 1])
    })
  })

  it('says nothing after a skip of one moved to the top of the list behind the car: the decision outlasts the skip, as the list did not come to it', async () => {
    const s = started(routeOf([[0, 0], [0, 3000]], [bundle('N', [8, 100]), bundle('Q', [8, 800]), bundle('Z', [8, 2900])]), ['Q', 'N', 'Z'])
    s.drive(up(400))
    s.openList()?.onOrder?.(['N', 'Q', 'Z'])
    s.update()
    s.list()?.onClose()
    s.update()
    s.drive(up(500, 400))
    await skipTo(s, 50)
    s.drive(up(1500, 500))
    expect([s.nextName(), toldAloud()]).toEqual(['N', 0])
  })

  it('tells again after a restart, once more, and not again', async () => {
    const s = started(routeOf([[0, 0], [0, 3000]], [bundle('M', [8, 400]), bundle('Z', [8, 2900])]), ['M', 'Z'])
    s.drive(legs(10, [0, 0], [0, 300], [150, 310], [150, 800], [0, 800], [0, 950]))
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(up(960, 950))
    expect(toldAloud()).toBe(1)
    // Back behind the bundle on paper, so it stays to do; the car drives on from where it is, and it is told once more.
    await skipTo(s, 300)
    s.drive(up(1250, 960))
    expect(toldAloud()).toBe(2)
    s.drive(up(1400, 1250))
    expect(toldAloud()).toBe(2)
  })

  it('forgets what was ahead at a fresh start, and looks afresh at the bundle next when the route is reached', async () => {
    const s = started(routeOf([[0, 0], [0, 3000]], [bundle('M', [8, 300]), bundle('N', [8, 500]), bundle('Z', [8, 2900])]), ['M', 'N', 'Z'])
    s.drive(up(280))
    s.tapDropped()
    expect(s.nextName()).toBe('N')
    s.drive(up(480, 280))
    s.askReset()
    s.press('Reset')
    await vi.advanceTimersByTimeAsync(0)
    s.update()
    // The car joins the round past M, which is next again, so it is told of. N is told of too: what was said on the last round is forgotten, and the list comes to it behind the car.
    s.drive(up(800, 490))
    expect([s.nextName(), toldAloud()]).toEqual(['M', 1])
    s.openList()?.onMark('M')
    s.update()
    s.list()?.onClose()
    s.update()
    s.drive(up(1300, 800))
    expect([s.nextName(), toldAloud()]).toEqual(['N', 2])
  })

  it('looks afresh at a fresh start with the list standing at the same bundle as before it, so it is told of again, and not again', async () => {
    const s = started(routeOf([[0, 0], [0, 3000]], [bundle('M', [8, 400]), bundle('Z', [8, 2900])]), ['M', 'Z'])
    s.drive(legs(10, [0, 0], [0, 300], [150, 310], [150, 800], [0, 800], [0, 950]))
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(up(960, 950))
    expect([s.nextName(), toldAloud()]).toEqual(['M', 1])
    s.askReset()
    s.press('Reset')
    await vi.advanceTimersByTimeAsync(0)
    s.update()
    // M is next on both sides of the reset, so only the fresh start makes it count as come to when the route is reached again.
    expect(s.nextName()).toBe('M')
    s.drive(up(1250, 960))
    expect([s.nextName(), toldAloud()]).toEqual(['M', 2])
    s.drive(up(1500, 1250))
    expect(toldAloud()).toBe(2)
  })

  it('tells at a fresh start of a bundle the driver had put on top behind the car on the last round: that decision goes with the round', async () => {
    const s = started(routeOf([[0, 0], [0, 3000]], [bundle('N', [8, 100]), bundle('Q', [8, 800]), bundle('Z', [8, 2900])]), ['Q', 'N', 'Z'])
    s.drive(up(400))
    s.openList()?.onOrder?.(['N', 'Q', 'Z'])
    s.update()
    s.list()?.onClose()
    s.update()
    s.drive(up(600, 400))
    expect([s.nextName(), toldAloud()]).toEqual(['N', 0])
    s.askReset()
    s.press('Reset')
    await vi.advanceTimersByTimeAsync(0)
    s.update()
    expect(s.nextName()).toBe('N')
    s.drive(up(1000, 600))
    expect([s.nextName(), toldAloud()]).toEqual(['N', 1])
  })

  it('forgets at a fresh start what could be told of: one the driver then moves to the top of the list behind the car is said nothing of, though it was next ahead of the car on the last round', async () => {
    const s = started(routeOf([[0, 0], [0, 3000]], [bundle('Y', [8, 100]), bundle('X', [8, 300]), bundle('W', [8, 2900])]), ['Y', 'X', 'W'])
    s.drive(up(90))
    s.tapDropped()
    s.drive(up(280, 90))
    s.tapDropped()
    s.askReset()
    s.press('Reset')
    await vi.advanceTimersByTimeAsync(0)
    s.update()
    s.drive(up(800, 280))
    expect([s.nextName(), s.notices.at(-1), toldAloud()]).toEqual(['Y', behind('Y'), 1])
    s.openList()?.onOrder?.(['X', 'Y', 'W'])
    s.update()
    s.list()?.onClose()
    s.update()
    s.drive(up(1200, 800))
    expect([s.nextName(), s.notices.at(-1), toldAloud()]).toEqual(['X', behind('Y'), 1])
  })

  it('tells of a bundle the list comes back to by itself between a skip and the route being reached, though a reorder moved it down meanwhile', async () => {
    const s = started(routeOf([[0, 0], [0, 3000]], [bundle('X', [8, 400]), bundle('Y', [8, 2000]), bundle('Z', [8, 2900])]), ['X', 'Y', 'Z'])
    s.drive(legs(10, [0, 0], [0, 300], [150, 310], [150, 800], [0, 800], [0, 950]))
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(up(960, 950))
    expect(toldAloud()).toBe(1)
    await skipTo(s, 300)
    expect(s.nextName()).toBe('X')
    s.openList()?.onOrder?.(['Y', 'X', 'Z'])
    s.update()
    s.list()?.onMark('Y')
    s.update()
    s.list()?.onClose()
    s.update()
    expect(s.nextName()).toBe('X')
    s.drive(up(1500, 960))
    expect([s.nextName(), toldAloud()]).toEqual(['X', 2])
  })

  it('counts a bundle put on top before the route is reached as come to, the same whichever bundle was next when the route was last looked at', async () => {
    const s = started(routeOf([[0, 0], [0, 3000]], [bundle('C', [8, 2000]), bundle('E', [8, 400]), bundle('Z', [8, 2900])]), ['E', 'C', 'Z'])
    s.drive(legs(10, [0, 0], [0, 300], [150, 310], [150, 800], [0, 800], [0, 950]))
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(up(960, 950))
    expect([s.nextName(), toldAloud()]).toEqual(['E', 1])
    // Back behind E on paper, and the driver makes sure of the list before the route is reached: C, then E again.
    await skipTo(s, 300)
    s.openList()?.onOrder?.(['C', 'E', 'Z'])
    s.update()
    s.list()?.onOrder?.(['E', 'C', 'Z'])
    s.update()
    s.list()?.onClose()
    s.update()
    s.drive(up(1500, 960))
    expect([s.nextName(), toldAloud()]).toEqual(['E', 2])
  })

  it('takes nothing from a car crossing the route before it is reached: one moved to the top behind the car is still said nothing of, though it looked ahead for a moment', async () => {
    const s = started(routeOf([[0, 0], [0, 3000]], [bundle('N', [8, 1000]), bundle('Q', [8, 2000]), bundle('Z', [8, 2900])]), ['Q', 'N', 'Z'])
    s.drive(up(1100))
    s.openList()?.onOrder?.(['N', 'Q', 'Z'])
    s.update()
    s.list()?.onClose()
    s.update()
    s.drive(up(1200, 1100))
    await skipTo(s, 100)
    // Off the road, across it short of N, and onto it again past N.
    s.drive(legs(10, [0, 1200], [150, 1210], [150, 800], [-150, 800], [-150, 1400], [0, 1400], [0, 2600]))
    expect([s.nextName(), toldAloud()]).toEqual(['N', 0])
  })

  describe('a reorder before the route is reached', () => {
    // P is ahead of where the car joins and Q behind it, and the driver puts Q first with nothing yet to say where the car is.
    const STOPS = [bundle('P', [8, 1000]), bundle('Q', [8, 200]), bundle('Z', [8, 1400])]
    const STREET: XY[] = [[0, 0], [0, 1500]]

    it('still counts the bundle next as come to when the route is reached, from the list on the bar', () => {
      const s = started(routeOf(STREET, STOPS), ['P', 'Q', 'Z'])
      s.openList()?.onOrder?.(['Q', 'P', 'Z'])
      s.update()
      s.list()?.onClose()
      s.update()
      expect(s.nextName()).toBe('Q')
      s.drive(legs(10, [-200, 700], [0, 700], [0, 420]))
      expect([s.notices, toldAloud(), s.nextName()]).toEqual([[behind('Q')], 1, 'Q'])
    })

    it('still counts the bundle next as come to when the route is reached, from the start screen before Continue Round', () => {
      const s = roundScreen(routeOf(STREET, STOPS), { order: ['P', 'Q', 'Z'], round: { handledStopIds: [], furthest: 100 } })
      s.press('Bundle drop order')
      s.list()?.onOrder?.(['Q', 'P', 'Z'])
      s.update()
      s.list()?.onClose()
      s.update()
      s.press('Continue Round')
      s.drive(up(800, 400))
      expect([s.notices, toldAloud(), s.nextName()]).toEqual([[behind('Q')], 1, 'Q'])
    })
  })

  it('leaves the name of a bundle gone by unseen on the bar, and tells of the next, already behind the car, once it has gone', () => {
    // B goes by while it is not next. A then goes by in a gap, so the fix that counts A missed is the one that finds the list at B behind the car.
    const s = started(routeOf([[0, 0], [0, 3000]], [bundle('B', [8, 200]), bundle('A', [8, 1000]), bundle('Z', [8, 2900])]), ['A', 'B', 'Z'])
    s.drive(up(850))
    s.noFixFor(25)
    s.drive(up(1110, 1100))
    expect([s.notice(), s.props.round.missed, s.nextName(), toldAloud()]).toEqual(['Missed bundle: A', ['A'], 'B', 0])
    s.drive(up(1200, 1110))
    expect([s.notices, toldAloud()]).toEqual([['Missed bundle: A', behind('B')], 1])
  })

  it('shows the words with the voice off, and says nothing', () => {
    play.voice = false
    const s = roundScreen(routeOf([[0, 0], [0, 1500]], [bundle('P', [65, 300]), bundle('Z', [8, 1400])]), { order: ['P', 'Z'] })
    pickDistance(s, 10)
    s.press('Start Round')
    s.drive(up(600))
    expect([s.notices, toldAloud()]).toEqual([[behind('P')], 0])
  })

  it('shortens a long name in the bar, as the notices of a miss do', () => {
    const long = { ...bundle('L', [8, 400]), label: 'The Corner Shop on Woolgoolga Road' }
    const s = started(routeOf([[0, 0], [0, 1500]], [long, bundle('Z', [8, 1400])]), ['L', 'Z'])
    s.drive(legs(10, [0, 0], [0, 300], [150, 310], [150, 800], [0, 800], [0, 950]))
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(up(960, 950))
    expect(s.notice()).toBe('Next bundle The Corner Shop on Woolgo… is behind you. Mark it or move it in the Bundles list.')
  })
})

describe('a round over but for its bundles, on the start screen', () => {
  const longRoute = (stops: Stop[]) => routeOf([[0, 0], [0, 1000]], stops)

  it('says nothing of bundles on a route with none: a route with no stops, driven to the end, is a round like any other', () => {
    const s = roundScreen(longRoute([]), { round: { handledStopIds: [], furthest: 1000 } })
    expect(s.all().some((e) => e.type === 'p' && words(e).includes('still to do'))).toBe(false)
    expect(s.button('Start New Round')).toBeUndefined()
    expect(s.button('Start Round')).toBeDefined()
    expect(s.button('Continue Round')).toBeUndefined()
  })

  it('makes Choose Where to Start a new round, as the note says: nothing of yesterday\'s is kept before the spot', () => {
    const route = longRoute([noThrowAt('H', [8, 900]), bundle('A', [8, 300]), bundle('C', [8, 600])])
    const s = roundScreen(route, { round: { handledStopIds: ['H', 'A'], dropped: ['A'], furthest: 900 } })
    expect(s.button('Start New Round')).toBeDefined()
    s.press('Choose Where to Start')
    s.find<Parameters<typeof StartPicker>[0]>(StartPicker)?.onPick(500, 'here')
    s.update()
    expect(s.props.round.dropped ?? []).toEqual([])
    expect(s.openList()?.rows.find((r) => r.id === 'C')?.status).toBe('next')
    expect(s.list()?.rows.find((r) => r.id === 'A')?.status).toBe('skipped')
  })

  it('has the picker say what the start will do, on a street driven twice, where yesterday\'s drop would keep its later pass done', () => {
    // X was dropped on its way out, which settled its way back. B, up the same street, is what is left.
    const route = routeOf([[0, 0], [0, 500], [0, 0]], [bundle('X', [8, 200]), bundle('B', [8, 300]), noThrowAt('H', [8, 100])])
    const had = ['X', 'X#2', 'H', 'H#2']
    const s = roundScreen(route, { round: { handledStopIds: had, dropped: ['X'], furthest: 1000 } })
    expect(s.button('Start New Round')).toBeDefined()
    s.press('Choose Where to Start')
    const picker = s.find<Parameters<typeof StartPicker>[0]>(StartPicker)
    if (!picker) throw new Error('No picker is up')
    // As the picker works it out: on this round it finds no finished round to start afresh from.
    const said = restartEffect(picker.round, picker.occs, picker.handled, 500, picker.slack, freshStart(false, false))
    picker.onPick(500, 'here')
    s.update()
    const after = new Set(s.props.round.handledStopIds)
    expect(said).toEqual({ newly: [...after].filter((key) => !had.includes(key)).length, back: had.filter((key) => !after.has(key)).length })
    expect(s.props.round.dropped ?? []).toEqual([])
    expect(after.has('X#2')).toBe(false)
  })

  it('keeps what is before the spot on a round not over, as ever', () => {
    const route = longRoute([noThrowAt('H', [8, 900]), bundle('A', [8, 300]), bundle('C', [8, 600])])
    const s = roundScreen(route, { round: { handledStopIds: ['A'], dropped: ['A'], furthest: 400 } })
    s.press('Choose Where to Start')
    s.find<Parameters<typeof StartPicker>[0]>(StartPicker)?.onPick(500, 'here')
    s.update()
    expect(s.props.round.dropped).toEqual(['A'])
  })
})

describe('carrying on from where the route is rejoined, on the real screen', () => {
  // Up a street and back down one 100 m east. The car goes by A with no drop, marks D, 100 m from the end, dropped from the list, and at 200 m cuts across
  // to the second street, past L and the house J, which are before where it comes back on, at about 1,400 m. K, a house further on, is after it, as D is.
  const noThrow = (id: string, xy: XY): Stop => ({ id, type: 'nothrow', pathIdx: 0, label: id, ...spot(xy) })
  const STOPS = [bundle('A', [8, 100]), bundle('L', [8, 500]), bundle('D', [108, 100]), noThrow('J', [108, 700]), noThrow('K', [108, 150])]
  const rejoined = () => {
    const s = roundScreen(routeOf([[0, 0], [0, 800], [100, 800], [100, 0]], STOPS), { order: ['A', 'D', 'L'] })
    s.press('Start Round')
    s.drive(legs(10, [0, 0], [0, 150]))
    expect(s.props.round.missed).toEqual(['A'])
    s.openList()?.onMark('D')
    s.update()
    s.list()?.onClose()
    s.update()
    s.drive(legs(10, [0, 150], [0, 200], [100, 500], [100, 270]))
    expect(s.offRoute()?.phase).toBe('rejoined')
    expect(s.props.round.handledStopIds).toEqual(['A', 'D'])
    return s
  }
  const kept = { dropped: ['D'], missed: ['A'] }
  const rows = [['A', 'missed'], ['D', 'dropped'], ['L', 'next']]

  it('tells of the stops it moves, and no bundle among them', () => {
    expect(rejoined().offRoute()?.effect).toBe('1 stop before it will count as done.')
  })

  it('keeps every bundle as it was when the driver taps Carry on from here: on either side of the spot, a drop, a miss and one still to do', () => {
    const s = rejoined()
    s.offRoute()?.onCarryOn()
    s.update()
    expect(s.props.round).toMatchObject(kept)
    expect([...s.props.round.handledStopIds].sort()).toEqual(['A', 'D', 'J'])
    expect(s.openList()?.rows.map((r) => [r.id, r.status])).toEqual(rows)
  })

  it('keeps them the same when it carries on by itself', () => {
    const s = rejoined()
    const slowly = legs(2.5, [100, 270], [100, 110])
    while (s.offRoute() && slowly.length) s.drive(slowly.splice(0, 1))
    expect(s.notice()).toBe('Carrying on from here.')
    expect(s.props.round).toMatchObject(kept)
    expect(s.props.round.handledStopIds).toEqual(expect.arrayContaining(['A', 'D', 'J']))
    expect(s.openList()?.rows.map((r) => [r.id, r.status])).toEqual(rows)
  })

  it('lets the driver go back for the bundle next on the list: it stays next behind the spot, and alerts as they get there', () => {
    const s = rejoined()
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(legs(10, [100, 270], [100, 260], [40, 500]))
    expect(s.banner()).toEqual(['L'])
    s.tapDropped()
    expect(s.props.round.dropped).toEqual(['D', 'L'])
  })
})

describe('the voice, on the real screen', () => {
  const route = routeOf(LOOP, [A, B, C])
  const sideCalls = () => vi.mocked(say).mock.calls.map(([text, options]) => [text, options])
  const word = (side: 'left' | 'right' | 'both') => [sideWords(side), { queue: true }]

  it('has Test Voice say the side words apart, from the tap, with the signal started', () => {
    const s = roundScreen(route)
    s.press('Test Voice')
    expect(sound.unlock).toHaveBeenCalledTimes(1)
    expect(sound.startKeepAlive).toHaveBeenCalledTimes(1)
    expect(unlockSpeech).toHaveBeenCalledTimes(1)
    expect(sideCalls()).toEqual([word('left')])
    vi.advanceTimersByTime(VOICE_TEST_GAP_MS - 1)
    expect(sideCalls()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sideCalls()).toEqual([word('left'), word('right')])
    vi.advanceTimersByTime(VOICE_TEST_GAP_MS)
    expect(sideCalls()).toEqual([word('left'), word('right'), word('both')])
  })

  it('leaves the signal alone in Test Voice when it is turned off', () => {
    play.keepAudio = false
    const s = roundScreen(route)
    s.press('Test Voice')
    expect(sound.startKeepAlive).not.toHaveBeenCalled()
    expect(sideCalls()).toEqual([word('left')])
  })

  it('has no Test Voice with the voice off', () => {
    play.voice = false
    expect(roundScreen(route).button('Test Voice')).toBeUndefined()
  })

  it('starts Test Voice again from the first word when it is tapped twice, with no words left over from the first', () => {
    const s = roundScreen(route)
    s.press('Test Voice')
    vi.advanceTimersByTime(VOICE_TEST_GAP_MS / 2)
    s.press('Test Voice')
    vi.advanceTimersByTime(VOICE_TEST_GAP_MS)
    expect(sideCalls()).toEqual([word('left'), word('left'), word('right')])
  })

  it('drops the words of Test Voice still to come when the round starts', () => {
    const s = roundScreen(route)
    s.press('Test Voice')
    s.press('Start Round')
    vi.advanceTimersByTime(VOICE_TEST_GAP_MS * 3)
    expect(sideCalls()).toEqual([word('left')])
  })

  it('drops the words of Test Voice still to come when the voice goes off', () => {
    const s = roundScreen(route)
    s.press('Test Voice')
    const change = s.all().find((e) => e.props.label === 'Whether turns, house numbers, and leaving or rejoining the route are said out loud')?.props.onChange as ((v: string) => void) | undefined
    expect(change).toBeDefined()
    change?.('off')
    s.update()
    vi.advanceTimersByTime(VOICE_TEST_GAP_MS * 3)
    expect(sideCalls()).toEqual([word('left')])
    expect(stopSpeaking).toHaveBeenCalled()
  })

  describe('a second try of its words, if the phone fails them', () => {
    const lastAlert = (part: string) => vi.mocked(say).mock.calls.filter(([t, o]) => t.includes(part) && o?.whole).at(-1)
    const along = (from: number, to: number, speed = 10) => line([0, from], [0, to], speed)

    it('is dropped from a no-throw row once the car is level with the house, while the words are not out of date yet', () => {
      const s = roundScreen(routeOf([[0, 0], [0, 900]], [noThrowAt('17', [8, 300])]))
      s.press('Start Round')
      s.drive(along(0, 270))
      const words = lastAlert('No throw')?.[1]
      expect(words?.warning).toBe(true)
      expect(words?.retryStale?.()).toBe(false)
      s.drive(along(270, 295))
      expect(words?.retryStale?.()).toBe(false)
      s.drive(along(295, 305, 5))
      expect([words?.retryStale?.(), words?.stale?.()]).toEqual([true, false])
    })

    it('waits for the last house of a row', () => {
      const s = roundScreen(routeOf([[0, 0], [0, 900]], [noThrowAt('17', [8, 300]), noThrowAt('19', [8, 330])]))
      s.press('Start Round')
      s.drive(along(0, 270))
      const words = lastAlert('No throw')?.[1]
      s.drive(along(270, 310))
      expect(words?.retryStale?.()).toBe(false)
      s.drive(along(310, 335))
      expect(words?.retryStale?.()).toBe(true)
    })

    it('is dropped the same way for a row said as the voice is turned on', () => {
      play.voice = false
      const s = roundScreen(routeOf([[0, 0], [0, 900]], [noThrowAt('17', [8, 300])]))
      s.press('Start Round')
      s.drive(along(0, 270))
      expect(lastAlert('No throw')).toBeUndefined()
      s.find<Parameters<typeof RoundButtons>[0]>(RoundButtons)?.onVoice()
      s.update()
      play.voice = true
      const words = lastAlert('No throw')?.[1]
      expect(words?.retryStale?.()).toBe(false)
      s.drive(along(270, 305))
      expect(words?.retryStale?.()).toBe(true)
    })

    it('stays for every other alert, whose words are still of use late', () => {
      const request: Stop = { id: 'R', type: 'request', pathIdx: 0, address: '9 Oak Road', note: 'Blue gate', ...spot([8, 300]) }
      const block: Stop = { id: 'K', type: 'block', pathIdx: 0, label: 'Lakeside', qty: 12, ...spot([8, 500]) }
      const s = roundScreen(routeOf([[0, 0], [0, 900]], [request, block, bundle('B', [8, 700])]))
      s.press('Start Round')
      s.drive(along(0, 750))
      for (const part of ['Special request', 'Apartment block', 'Bundle drop']) {
        const said = lastAlert(part)
        expect(said, part).toBeTruthy()
        expect(said?.[1]?.retryStale).toBeUndefined()
      }
    })
  })

  it('tries to wake the audio on each fix while the round runs with the voice and the signal on', () => {
    const s = roundScreen(route)
    s.drive(up(20))
    expect(sound.nudge).not.toHaveBeenCalled()
    s.press('Start Round')
    const before = vi.mocked(sound.nudge).mock.calls.length
    s.drive(up(50, 20))
    expect(vi.mocked(sound.nudge).mock.calls.length - before).toBe(3)
  })

  it.each([
    ['the voice', { voice: false, keepAudio: true }],
    ['the signal', { voice: true, keepAudio: false }],
  ])('leaves the audio alone with %s off', (_, { voice, keepAudio }) => {
    play.voice = voice
    play.keepAudio = keepAudio
    const s = roundScreen(route)
    s.press('Start Round')
    s.drive(up(50))
    expect(sound.nudge).not.toHaveBeenCalled()
  })
})

describe('the start screen', () => {
  const scrolling = (s: ReturnType<typeof roundScreen>) => s.all().find((e) => e.props.className === 'screen plain')
  const route = routeOf(LOOP, [A, B, C])
  const allGone: RoundState = { handledStopIds: ['A', 'B', 'C'], dropped: ['A', 'B'], missed: ['C'] }
  /** What the scrolling part of the screen shows, in order, of the parts that move about. */
  const parts = (s: ReturnType<typeof roundScreen>) =>
    [...elements(scrolling(s))]
      .map((e) => {
        if (e.type === LoadCard) return 'load'
        if (words(e) === 'Alert distance') return 'distance'
        if (words(e) === 'Voice') return 'voice'
        if (e.type !== 'button') return e.type === 'p' && words(e).startsWith('Your last round') ? 'note' : null
        const name = ['Continue Round', 'Start Over', 'Start New Round', 'Start Round', 'Choose Where to Start', 'Bundle drop order'].find((n) => words(e).includes(n))
        return name ? `${name}${e.props.className === 'btn primary block' ? ' (main)' : ''}` : null
      })
      .filter(Boolean)
  const START = ['Bundle drop order', 'distance', 'voice']

  it('has the buttons of a round to carry on straight under the summary, above what to load', () => {
    const s = roundScreen(route, { round: { handledStopIds: ['A'], dropped: ['A'], furthest: 300 } })
    expect(parts(s)).toEqual(['Continue Round (main)', 'Start Over', 'Choose Where to Start', 'load', ...START])
    const seen = [...elements(scrolling(s))].map((e) => (e.type === 'p' && words(e).includes('carries on from') ? 'summary' : e.type === 'button' && words(e).includes('Continue Round') ? 'continue' : null)).filter(Boolean)
    expect(seen).toEqual(['summary', 'continue'])
  })

  it('keeps them under everything else on a fresh round and a finished one', () => {
    expect(parts(roundScreen(route))).toEqual(['load', ...START, 'Start Round (main)', 'Choose Where to Start'])
    expect(parts(roundScreen(route, { round: allGone }))).toEqual(['note', 'load', ...START, 'Start New Round (main)', 'Choose Where to Start'])
  })

  describe('a round left at the end of the route with only bundles to do', () => {
    // 1,900 m of route, with a no-throw house on it.
    const end = 1840
    const H: Stop = { id: 'H', type: 'nothrow', pathIdx: 0, label: 'H', ...spot([8, 100]) }
    const withHouse = routeOf(LOOP, [A, B, C, H])
    const left: RoundState = { handledStopIds: ['A', 'B', 'H'], dropped: ['A', 'B'], furthest: 1800 }

    it('starts a new round with the main button, says why, and keeps Continue Round under it', () => {
      const s = roundScreen(withHouse, { round: left })
      expect(parts(s)).toEqual(['note', 'load', ...START, 'Start New Round (main)', 'Continue Round', 'Choose Where to Start'])
      expect(s.line('Your last round')).toBe('Your last round reached the end with 1 bundle drop still to do, so this will start a new one.')
    })

    it('counts the bundle stops, however many times the route goes by each', () => {
      const s = roundScreen(withHouse, { round: { handledStopIds: ['A', 'H'], dropped: ['A'], furthest: 1800 } })
      expect(s.line('Your last round')).toBe('Your last round reached the end with 2 bundle drops still to do, so this will start a new one.')
    })

    it('starts afresh from the main button', () => {
      const s = roundScreen(withHouse, { round: left })
      s.press('Start New Round')
      expect(s.props.round).toEqual({ handledStopIds: [] })
      s.drive(up(120))
      expect(s.banner()).toEqual(['H'])
    })

    it('opens the next round from Bundle drop order, with two bundles left to do as with one: the round kept is the one the screen says is over', () => {
      const s = roundScreen(routeOf([[0, 0], [0, 900]], [bundle('A', [8, 200]), bundle('B', [8, 400]), noThrowAt('H', [8, 500])]), { round: { handledStopIds: ['H'], furthest: 900 } })
      s.press('Bundle drop order')
      expect(s.list()?.heading).toBe('Bundles, next round')
    })

    it('carries on as ever from Continue Round', () => {
      const s = roundScreen(withHouse, { round: left })
      s.press('Continue Round')
      expect(s.props.round).toBe(left)
      expect(s.nextName()).toBe('C')
    })

    it('goes by the furthest kept, a hundred metres at a time: a car that got to the last 50 m is over, and one short of that is not', () => {
      const last = (furthest: number) => parts(roundScreen(withHouse, { round: { ...left, furthest } }))[0]
      expect(end - 50 - 100).toBe(1690)
      expect(last(1700)).toBe('note')
      expect(last(1600)).toBe('Continue Round (main)')
    })

    it('is not that on a round not begun, however short the route', () => {
      const short = roundScreen(routeOf([[0, 0], [0, 120]], [bundle('S', [8, 60])]))
      expect(parts(short).slice(-2)).toEqual(['Start Round (main)', 'Choose Where to Start'])
      expect(short.line('Your last round')).toBeUndefined()
    })

    it('is not that with a house still to do', () => {
      const s = roundScreen(withHouse, { round: { ...left, handledStopIds: ['A', 'B'] } })
      expect(parts(s)[0]).toBe('Continue Round (main)')
    })

    it('comes of a real round: the car drives to the end with one bundle behind it, and the phone is put down', () => {
      const s = roundScreen(withHouse, { order: ['C', 'A', 'B'] })
      s.press('Start Round')
      s.drive(up(570))
      s.tapDropped()
      s.drive(legs(10, [0, 570], [0, 900], [40, 900], [40, 200]))
      s.noFixFor(1)
      s.tapDropped()
      s.drive(legs(10, [40, 200], [40, 0]))
      expect(s.nextName()).toBe('B')
      const back = roundScreen(withHouse, { round: s.props.round })
      expect(parts(back).slice(-3)).toEqual(['Start New Round (main)', 'Continue Round', 'Choose Where to Start'])
      expect(back.line('Your last round')).toBe('Your last round reached the end with 1 bundle drop still to do, so this will start a new one.')
    })
  })

  it('has the papers to load above the alert distance, with the Bundle drop order button straight after it', () => {
    const load: LoadList = { ...DEFAULT_LOAD, lines: DEFAULT_LOAD.lines.slice(0, 1) }
    const s = roundScreen(route, { load })
    const seen = s.all().map((e) => (e.type === LoadCard ? 'load' : e.type === 'button' && words(e).includes('Bundle drop order') ? 'order' : words(e) === 'Alert distance' ? 'distance' : null)).filter(Boolean)
    expect(seen).toEqual(['load', 'order', 'distance'])
    expect(s.find<Parameters<typeof LoadCard>[0]>(LoadCard)?.load).toBe(load)
    s.find<Parameters<typeof LoadCard>[0]>(LoadCard)?.onLoad(load)
    expect(s.loads).toEqual([load])
  })

  it('has the Bundle drop order button only with two bundle drops or more', () => {
    expect(roundScreen(routeOf(LOOP, [A])).button('Bundle drop order')).toBeUndefined()
    expect(roundScreen(routeOf(LOOP, [A, B])).button('Bundle drop order')).toBeDefined()
  })

  it('opens the list on a screen of its own, not in the one that scrolls, so its scrim stays on the screen when the page has been scrolled', () => {
    const s = roundScreen(route)
    expect(s.list()).toBeUndefined()
    s.press('Bundle drop order')
    expect(s.list()).toBeDefined()
    expect([...elements(scrolling(s))].some((e) => e.type === BundlesSheet)).toBe(false)
    const outer = s.all().find((e) => e.props.className === 'screen')
    expect([...elements(outer)].some((e) => e.type === BundlesSheet)).toBe(true)
    s.list()?.onClose()
    s.update()
    expect(s.list()).toBeUndefined()
  })

  it('opens the list of the round kept while it has bundles to move, and a change of order from it is kept', () => {
    const round: RoundState = { handledStopIds: ['A'], dropped: ['A'] }
    const s = roundScreen(route, { round })
    s.press('Bundle drop order')
    expect(s.list()?.rows.map((r) => [r.id, r.status, r.undoKey])).toEqual([['A', 'dropped', 'A'], ['B', 'next', null], ['C', 'todo', null]])
    s.list()?.onOrder?.(['A', 'C', 'B'])
    s.update()
    expect(s.props.bundleOrder).toEqual(['A', 'C', 'B'])
    expect(s.list()?.rows.map((r) => r.id)).toEqual(['A', 'C', 'B'])
  })

  it('opens the next round on a finished round, as nothing is left in it to move, so Reorder is there', () => {
    const s = roundScreen(route, { round: allGone, order: ['C', 'A', 'B'] })
    expect(bundlesLeft(bundleRows(occurrences(route), allGone, undefined, null))).toBe(0)
    s.press('Bundle drop order')
    const rows = s.list()?.rows ?? []
    expect(rows.map((r) => [r.id, r.status])).toEqual([['C', 'next'], ['A', 'todo'], ['B', 'todo']])
    expect(bundlesLeft(rows)).toBe(3)
    expect(rows.every((r) => r.markKey === null && r.undoKey === null)).toBe(true)
    s.list()?.onOrder?.(['A', 'C', 'B'])
    s.update()
    expect(s.list()?.rows.map((r) => r.id)).toEqual(['A', 'C', 'B'])
    // Setting the order leaves the round as it was.
    expect(s.props.round).toBe(allGone)
  })

  it('opens the next round too on a round left with one bundle to do, which alerts keep open now', () => {
    const s = roundScreen(route, { round: { handledStopIds: ['A', 'B'], dropped: ['A', 'B'] } })
    s.press('Bundle drop order')
    expect(s.list()?.rows.map((r) => r.status)).toEqual(['next', 'todo', 'todo'])
  })

  it('heads the list of the next round as that, so it can\'t be taken for the round in progress, and the round\'s own list as ever', () => {
    const next = roundScreen(route, { round: { handledStopIds: ['A', 'B'], dropped: ['A', 'B'] } })
    next.press('Bundle drop order')
    expect(next.list()?.heading).toBe('Bundles, next round')
    const own = roundScreen(route, { round: { handledStopIds: ['A'], dropped: ['A'] } })
    own.press('Bundle drop order')
    expect(own.list()?.heading).toBeUndefined()
  })

  it('keeps the list it opened with, under the finger, when Mark dropped leaves one bundle to do', () => {
    const round: RoundState = { handledStopIds: ['A'], dropped: ['A'] }
    const s = roundScreen(route, { round })
    s.press('Bundle drop order')
    s.list()?.onMark('B')
    s.update()
    expect(s.list()?.rows.map((r) => [r.id, r.status])).toEqual([['A', 'dropped'], ['B', 'dropped'], ['C', 'next']])
    expect(s.props.round).toEqual(markDropped(round, 'B', []))
  })

  it('goes back to the list of the round on the road, whatever the start screen opened', () => {
    const s = roundScreen(route, { round: { handledStopIds: ['A', 'B'], dropped: ['A', 'B'] } })
    s.press('Bundle drop order')
    s.list()?.onClose()
    s.update()
    s.press('Continue Round')
    expect(s.openList()?.rows.map((r) => r.status)).toEqual(['dropped', 'dropped', 'next'])
  })
})

describe('the app', () => {
  it('hands the round the list kept with the route, and keeps a change to it there', () => {
    play.slots = []
    const app = () => settle(() => App())
    const round = () => [...elements(app())].find((e) => e.type === Round)?.props as unknown as Parameters<typeof Round>[0]
    expect(round().load).toBeUndefined()
    const load: LoadList = { ...DEFAULT_LOAD, papersEach: { bagged: 30, unwrapped: 60 } }
    round().onLoad(load)
    expect(round().load).toEqual(load)
  })
})

describe('the banner where a named section starts and ends, on the real screen', () => {
  const POINTS: XY[] = [[0, 0], [0, 3000]]
  const place = (id: string, name: string, y: number): NamedSection => ({ id, name, ...spot([0, y]) })
  const SECTIONS = [place('a', 'Oak Estate', 500), place('b', 'Beach Road', 1500)]
  const onStreet = (stops: Stop[] = [bundle('Z', [8, 2900])]) => routeOf(POINTS, stops)
  const drivingFrom = (route = onStreet(), sections = SECTIONS) => {
    const s = roundScreen(route, { sections })
    s.press('Start Round')
    return s
  }
  const shown = (s: ReturnType<typeof roundScreen>) => {
    const banner = s.find<Parameters<typeof SectionBanner>[0]>(SectionBanner)
    return banner ? [banner.ended, banner.started] : null
  }
  const saidOf = (word: string) => vi.mocked(say).mock.calls.map(([text]) => text).filter((text) => text.includes(word))

  it('says nothing for the part before the first section, and starts the first as the car comes to it', () => {
    const s = drivingFrom()
    s.drive(up(480))
    expect(shown(s)).toBeNull()
    s.drive(up(520, 480))
    expect(shown(s)).toEqual([null, 'Oak Estate'])
    expect(saidOf('Oak Estate')).toEqual(['Start of Oak Estate.'])
  })

  it('ends one and starts the next on one banner, and the voice says them in that order', () => {
    const s = drivingFrom()
    s.drive(up(1480))
    s.drive(up(1520, 1480))
    expect(shown(s)).toEqual(['Oak Estate', 'Beach Road'])
    expect(saidOf('Beach Road')).toEqual(['End of Oak Estate. Start of Beach Road.'])
  })

  it('ends the last at the end of the route', () => {
    const s = drivingFrom()
    s.drive(up(2960))
    expect(shown(s)).toEqual(['Beach Road', null])
    expect(saidOf('Beach Road').at(-1)).toBe('End of Beach Road.')
  })

  it('goes by itself after a few seconds, and does not come back', () => {
    const s = drivingFrom()
    s.drive(up(520))
    s.drive(up(560, 530))
    expect(shown(s)).toEqual([null, 'Oak Estate'])
    s.drive(up(620, 570))
    expect(shown(s)).toBeNull()
    s.drive(up(1400, 630))
    expect(shown(s)).toBeNull()
  })

  it('shows with the voice off, and nothing is said', () => {
    play.voice = false
    const s = drivingFrom()
    s.drive(up(520))
    expect([shown(s), saidOf('Oak Estate')]).toEqual([[null, 'Oak Estate'], []])
  })

  it('is told of the section a round starts in', () => {
    const s = drivingFrom(onStreet(), [place('a', 'Oak Estate', 0), place('b', 'Beach Road', 1500)])
    s.drive(up(30))
    expect(shown(s)).toEqual([null, 'Oak Estate'])
  })

  it('asks for its words after those of an alert on the same fix, once the beep is over, as of less account than any', () => {
    const s = drivingFrom(onStreet([noThrowAt('H', [8, 532]), bundle('Z', [8, 2900])]))
    s.drive(up(500))
    const calls = vi.mocked(say).mock.calls
    const alert = calls.findIndex(([text]) => text.startsWith('No throw'))
    const section = calls.findIndex(([text]) => text === 'Start of Oak Estate.')
    expect(alert).toBeGreaterThanOrEqual(0)
    expect(section).toBe(alert + 1)
    expect(calls[section][1]).toEqual({ minor: true, afterMs: 300 })
  })

  it('asks for its words after the side word on the same fix', () => {
    const base = routeOf([[0, 0], [0, 500], [150, 500], [150, 900]], [bundle('Z', [158, 880])])
    const route = { ...base, sideChanges: [{ idx: 0, side: 'left' as const }, { idx: 1, side: 'right' as const }] }
    const s = roundScreen(route, { sections: [place('a', 'Oak Estate', 100), place('b', 'Beach Road', 475)] })
    s.press('Start Round')
    s.drive(up(480))
    const said = vi.mocked(say).mock.calls.map(([text]) => text)
    expect(said.indexOf('Starboard')).toBeGreaterThanOrEqual(0)
    expect(said.indexOf('End of Oak Estate. Start of Beach Road.')).toBe(said.indexOf('Starboard') + 1)
  })

  it('says nothing at all on a route with no sections', () => {
    const s = drivingFrom(onStreet(), [])
    s.drive(up(2960))
    expect(shown(s)).toBeNull()
    expect(saidOf('Start of')).toEqual([])
  })

  it('comes under the alert of a stop, which it leaves up, and asks for its words after those of the alert', () => {
    const s = drivingFrom(onStreet([noThrowAt('H', [8, 505]), bundle('Z', [8, 2900])]))
    s.drive(up(520))
    expect([s.banner(), shown(s)]).toEqual([['H'], [null, 'Oak Estate']])
    const order = s.all().filter((e) => e.type === AlertBanner || e.type === SectionBanner).map((e) => e.type)
    expect(order).toEqual([AlertBanner, SectionBanner])
    const said = vi.mocked(say).mock.calls.map(([text]) => text)
    expect(said.findIndex((t) => t.startsWith('No throw'))).toBeLessThan(said.indexOf('Start of Oak Estate.'))
  })

  it('takes no notice of a poor fix thrown over the line, and tells when the car gets there', () => {
    const s = drivingFrom()
    s.drive(up(1450, 0))
    s.drive(up(1490, 1460))
    s.drive([{ x: 0, y: 1560, speed: 10, heading: 0, accuracy: 50 }])
    expect(saidOf('Beach Road')).toEqual([])
    s.drive(up(1520, 1500))
    expect(saidOf('Beach Road')).toEqual(['End of Oak Estate. Start of Beach Road.'])
  })

  it('waits for the list to close, for its time on the screen', () => {
    const s = drivingFrom()
    s.drive(up(480))
    s.openList()
    s.update()
    s.drive(up(520, 490))
    expect(shown(s)).toBeNull()
    s.drive(up(800, 530))
    expect(shown(s)).toBeNull()
    s.list()?.onClose()
    s.update()
    expect(shown(s)).toEqual([null, 'Oak Estate'])
  })

  it('waits for the menu to close, for its time on the screen', () => {
    const s = drivingFrom()
    s.drive(up(520))
    expect(shown(s)).toEqual([null, 'Oak Estate'])
    s.find<Parameters<typeof RoundBar>[0]>(RoundBar)?.onMenu()
    s.update()
    expect(shown(s)).toBeNull()
    s.drive(up(700, 530))
    expect(shown(s)).toBeNull()
    s.find<Parameters<typeof RoundMenu>[0]>(RoundMenu)?.onClose()
    s.update()
    expect(shown(s)).toEqual([null, 'Oak Estate'])
  })

  it('waits for the picker to close, for its time on the screen', () => {
    const s = drivingFrom()
    s.drive(up(520))
    s.find<Parameters<typeof RoundBar>[0]>(RoundBar)?.onMenu()
    s.update()
    const menu = s.find<Parameters<typeof RoundMenu>[0]>(RoundMenu)
    menu?.onClose()
    menu?.onSkip()
    s.update()
    expect(shown(s)).toBeNull()
    s.drive(up(700, 530))
    expect(shown(s)).toBeNull()
    s.find<Parameters<typeof StartPicker>[0]>(StartPicker)?.onClose()
    s.update()
    expect(shown(s)).toEqual([null, 'Oak Estate'])
  })

  it('waits for a question to be answered, for its time on the screen', async () => {
    const s = drivingFrom()
    s.drive(up(520))
    s.askReset()
    expect(shown(s)).toBeNull()
    s.drive(up(700, 530))
    expect(shown(s)).toBeNull()
    s.press('Cancel')
    await vi.advanceTimersByTimeAsync(0)
    s.update()
    expect(shown(s)).toEqual([null, 'Oak Estate'])
  })

  it('has its 8 seconds once the list closes, and then goes', () => {
    const s = drivingFrom()
    s.drive(up(480))
    s.openList()
    s.update()
    s.drive(up(520, 490))
    s.list()?.onClose()
    s.update()
    s.drive(up(590, 530))
    expect(shown(s)).toEqual([null, 'Oak Estate'])
    s.drive(up(620, 600))
    expect(shown(s)).toBeNull()
  })

  it('gives up waiting for a list left open, as old news', () => {
    const s = drivingFrom()
    s.drive(up(480))
    s.openList()
    s.update()
    s.drive(up(520, 490))
    s.drive(up(860, 530))
    s.list()?.onClose()
    s.update()
    expect(shown(s)).toBeNull()
  })

  it('says nothing while back on the route somewhere else, and tells when the driver says to carry on: of the section left and the one the car is in', () => {
    const s = drivingFrom()
    s.drive(up(560))
    s.drive(legs(10, [0, 560], [200, 560], [200, 1530], [0, 1530], [0, 1680]))
    expect(s.offRoute()?.phase).toBe('rejoined')
    expect(saidOf('Beach Road')).toEqual([])
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(up(1720, 1690))
    expect(saidOf('Beach Road')).toEqual(['End of Oak Estate. Start of Beach Road.'])
  })

  it('tells of a line gone over on the way back from a stop off the road, once the round carries on', () => {
    const s = drivingFrom(onStreet([bundle('F', [90, 1000]), bundle('Z', [8, 2900])]), [place('a', 'Oak Estate', 500), place('b', 'Beach Road', 1300)])
    s.drive(up(1000))
    s.drive(legs(2, [0, 1000], [85, 1000], [0, 1000]))
    s.drive(up(1800, 1010))
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(up(1900, 1810))
    expect(saidOf('Beach Road')).toEqual(['End of Oak Estate. Start of Beach Road.'])
  })

  it('tells of a line gone over in poor GPS round the head of a street, a little late', () => {
    const points: XY[] = [[0, 0], [0, 800], [0, 0], [0, -1500]]
    const drive = legs(10, ...points)
    const s = drivingFrom(routeOf(points, [bundle('Z', [8, -1400])]), [place('a', 'Oak Estate', 300), { ...place('b', 'Beach Road', 700), pass: 2 }])
    s.drive(drive.slice(0, 64))
    s.drive(drive.slice(64, 96).map((f) => ({ ...f, accuracy: 60 })))
    s.drive(drive.slice(96, 120))
    expect(saidOf('Beach Road')).toEqual(['End of Oak Estate. Start of Beach Road.'])
  })

  it('tells nothing going the wrong way over a line on being taken back, and tells when the car comes over it going forward', () => {
    const s = drivingFrom(onStreet(), [place('a', 'Oak Estate', 500), place('b', 'Beach Road', 1500)])
    s.drive(up(1400))
    s.drive(legs(10, [0, 1400], [200, 1400], [200, 1700], [0, 1700], [0, 1850]))
    expect(s.offRoute()?.phase).toBe('rejoined')
    s.offRoute()?.onTakeBack()
    s.update()
    s.drive(legs(10, [0, 1850], [0, 1395]).map((f) => ({ ...f, heading: 180 })))
    expect(saidOf('Beach Road')).toEqual([])
    s.drive(up(1560, 1400))
    expect(saidOf('Beach Road')).toEqual(['End of Oak Estate. Start of Beach Road.'])
  })

  it('tells of no section on a diagonal to a stop off the road, level with a line the car has not come to', () => {
    const s = drivingFrom(onStreet([bundle('F', [80, 1560]), bundle('Z', [8, 2900])]))
    s.drive(up(1460))
    s.drive(legs(5, [0, 1460], [75, 1555]))
    expect(saidOf('Beach Road')).toEqual([])
  })

  it('ends the section where the last stop is done, and tells nothing after that', () => {
    const s = drivingFrom(onStreet([bundle('Z', [8, 700])]))
    s.drive(up(690))
    s.tapDropped()
    s.drive(up(1000, 700))
    expect(saidOf('End of')).toEqual(['End of Oak Estate.'])
    s.drive(up(1600, 1010))
    expect(saidOf('Beach Road')).toEqual([])
  })

  it('waits for the car to get to the section skipped to, and tells of no section on the way there', async () => {
    const s = drivingFrom()
    s.drive(up(100))
    await skipTo(s, 1500)
    s.drive(up(1540, 1420))
    expect(vi.mocked(say).mock.calls.map(([text]) => text).filter((text) => /^(Start|End) of/.test(text))).toEqual(['Start of Beach Road.'])
    expect(shown(s)).toEqual([null, 'Beach Road'])
  })

  it('says nothing before a round has started, with the picker fetching a fix on a round finished last time', () => {
    const route = onStreet([bundle('Z', [8, 700])])
    const s = roundScreen(route, { sections: SECTIONS, round: { handledStopIds: ['Z'], furthest: 2900 } })
    s.press('Choose Where to Start')
    s.drive(up(720, 600))
    expect(saidOf('End of')).toEqual([])
  })

  it('does not tell again of the end told at the last stop when an earlier drop is taken back and the round goes on', () => {
    const s = drivingFrom(onStreet([bundle('A', [8, 600]), bundle('Z', [8, 700])]))
    s.drive(up(595))
    s.tapDropped()
    s.drive(up(690, 600))
    s.tapDropped()
    s.drive(up(720, 700))
    expect(saidOf('End of')).toEqual(['End of Oak Estate.'])
    s.openList()?.onUndo('A')
    s.list()?.onClose()
    s.update()
    s.drive(up(1520, 730))
    expect(saidOf('Beach Road')).toEqual(['Start of Beach Road.'])
    expect(saidOf('End of')).toEqual(['End of Oak Estate.'])
  })

  it('ends the section where the last stop is done off the road, with the car still there', () => {
    const s = drivingFrom(onStreet([bundle('Z', [90, 700])]))
    s.drive(up(700))
    s.drive(legs(2, [0, 700], [85, 700]))
    s.tapDropped()
    s.drive(legs(2, [85, 700], [80, 700]))
    expect(saidOf('End of')).toEqual(['End of Oak Estate.'])
  })

  it('believes the driver at a carry-on however far along the route the car came back onto it, and tells at once', () => {
    const points: XY[] = [[0, 0], [0, 4000], [400, 4000], [400, 0]]
    const s = drivingFrom(routeOf(points, [bundle('Z', [408, 100])]), [place('a', 'Oak Estate', 500), { ...place('b', 'Beach Road', 700), pass: 2 }])
    s.drive(up(600))
    s.drive(legs(10, [0, 600], [400, 600], [400, 450]))
    expect(s.offRoute()?.phase).toBe('rejoined')
    expect(saidOf('Beach Road')).toEqual([])
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(legs(10, [400, 440], [400, 400]))
    expect(saidOf('Beach Road')).toEqual(['End of Oak Estate. Start of Beach Road.'])
  })

  it('tells nothing at the first look of Continue Round: the driver is carrying on in the section', () => {
    const s = roundScreen(onStreet(), { sections: SECTIONS, round: { handledStopIds: [], furthest: 560 } })
    s.press('Continue Round')
    s.drive(up(640, 550))
    expect(saidOf('Oak Estate')).toEqual([])
    s.drive(up(1520, 650))
    expect(saidOf('Beach Road')).toEqual(['End of Oak Estate. Start of Beach Road.'])
  })

  it('tells of the section skipped to, and again of one driven over again after a skip back', async () => {
    const s = drivingFrom()
    s.drive(up(1520))
    await skipTo(s, 500)
    s.drive(up(530, 500))
    expect(shown(s)).toEqual([null, 'Oak Estate'])
    s.drive(up(1520, 540))
    expect(shown(s)).toEqual(['Oak Estate', 'Beach Road'])
  })

  it('does not tell the driver again of a section they carried on in', () => {
    const s = drivingFrom()
    s.drive(up(560))
    expect(saidOf('Oak Estate')).toEqual(['Start of Oak Estate.'])
    // Off the road and back onto it a little further on, in the same section.
    s.drive(legs(10, [0, 560], [300, 560], [300, 760], [0, 760]))
    s.offRoute()?.onCarryOn()
    s.update()
    s.drive(up(900, 770))
    expect(saidOf('Oak Estate')).toEqual(['Start of Oak Estate.'])
  })

  it('tells again after a reset, as the round starts over', async () => {
    const s = drivingFrom()
    s.drive(up(520))
    s.askReset()
    s.press('Reset')
    await vi.advanceTimersByTimeAsync(0)
    s.update()
    expect(shown(s)).toBeNull()
    s.drive(up(400, 0))
    s.drive(up(520, 410))
    expect(saidOf('Oak Estate')).toEqual(['Start of Oak Estate.', 'Start of Oak Estate.'])
  })
})
