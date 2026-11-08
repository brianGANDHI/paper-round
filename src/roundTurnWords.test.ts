/// <reference types="node" />
import { isValidElement, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Fix } from './device'
import { Round } from './Round'
import { say } from './speech'
import { TurnCard } from './TurnCard'
import type { Turn } from './turns'
import type { Pt, Route, Stop } from './types'

/*
 * The turn words of the real round screen, played through its real effects as roundWiring.test.ts plays it (that file has the whole of the screen; this one
 * only the voice for a turn, and copies the few parts of its stand-in for React that it needs). Nothing is mounted: the screen is called as a plain
 * function, the effects whose dependencies changed are run, and it is called again until nothing changes. The GPS, the sound, the speech engine and the
 * map are pretend. The speech engine asks each word's `stale` check just before it would say the words, so the test asks it where the engine would.
 */
const play = vi.hoisted(() => ({
  slots: [] as unknown[],
  at: 0,
  dirty: false,
  layout: [] as { cell: { deps?: readonly unknown[]; cleanup?: void | (() => void) }; run: () => void | (() => void); deps?: readonly unknown[] }[],
  passive: [] as { cell: { deps?: readonly unknown[]; cleanup?: void | (() => void) }; run: () => void | (() => void); deps?: readonly unknown[] }[],
  fix: null as unknown,
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
vi.mock('./storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./storage')>()),
  loadVoiceTurns: () => true,
  loadKeepAudioAwake: () => false,
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
const words = (e: ReactElement<Record<string, unknown>>): string =>
  [e.props.children].flat(3).filter((c): c is string => typeof c === 'string').join('')

// A place in Sydney, as in the other tests of the round.
const ORIGIN = { lat: -33.87, lng: 151.2 }
const M_PER_DEG = (6371000 * Math.PI) / 180
const spot = ([x, y]: readonly [number, number]): Pt => ({ lat: ORIGIN.lat + y / M_PER_DEG, lng: ORIGIN.lng + x / (M_PER_DEG * Math.cos((ORIGIN.lat * Math.PI) / 180)) })

/** The round screen on a route, started, with the car's fixes going in one a second. */
function roundScreen(route: Route) {
  play.slots = []
  play.fix = null
  let time = 1_000_000
  const props: Parameters<typeof Round>[0] = {
    route,
    round: { handledStopIds: [] },
    routeName: 'Test',
    sections: [],
    streets: [],
    onBundleOrder: () => {},
    onLoad: () => {},
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
  const start = all().find((e) => e.type === 'button' && words(e).includes('Start Round'))
  if (!start) throw new Error('No Start Round button')
  ;(start.props.onClick as () => void)()
  update()
  return {
    /** A fix at [x, y] metres, heading this way at 10 m/s. */
    fix(x: number, y: number, heading: number) {
      time += 1000
      vi.advanceTimersByTime(1000)
      play.fix = { ...spot([x, y]), accuracy: 5, heading, speed: 10, time } satisfies Fix
      update()
    },
    /** How far the turn on the card turns the heading, if the card is up. */
    card: () => {
      const shown = all().find((e) => e.type === TurnCard)?.props.turn as Turn | undefined
      return shown ? Math.abs(shown.angle) : null
    },
  }
}

/** The turn words asked for so far, each with the check the speech engine asks just before it says them. */
const asked = () =>
  vi
    .mocked(say)
    .mock.calls.filter(([text]) => /U-turn/.test(text))
    .map(([text, options]) => ({ text, stale: options?.stale ?? (() => false) }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the last word for a U-turn whose card blanks while it waits to be said', () => {
  // Up a road 400 m, across 8 m and back down the other side: a U-turn at the top. A bundle drop near the end, so the round has something to do.
  const bundle: Stop = { id: 'A', type: 'bundle', pathIdx: 0, label: 'A', qty: 10, ...spot([16, 30]) }
  const route: Route = { points: ([[0, 0], [0, 400], [8, 400], [8, 0]] as const).map(spot), sideChanges: [{ idx: 0, side: 'both' }], stops: [bundle] }

  it('is said when the card comes back, and only once', () => {
    const s = roundScreen(route)
    for (let y = 10; y <= 350; y += 10) s.fix(0, y, 0)
    expect(asked().map((w) => w.text)).toEqual(['In 200 metres, make a U-turn.', 'Make a U-turn.'])
    // The phone's heading swings 100 degrees off for a fix, as it can on a bend on the way in: the card is down while the last word waits its turn.
    s.fix(0, 358, 100)
    expect(s.card()).toBeNull()
    // Its turn comes now, so it is out of date, and dropped.
    expect(asked()[1].stale()).toBe(true)
    // The card comes back, and the last word is asked for again, once.
    s.fix(0, 366, 0)
    s.fix(0, 374, 0)
    expect(s.card()).toBeGreaterThanOrEqual(165)
    expect(asked().map((w) => w.text)).toEqual(['In 200 metres, make a U-turn.', 'Make a U-turn.', 'Make a U-turn.'])
    expect(asked()[2].stale()).toBe(false)
  })

  it('is not asked for again when the card comes back before its turn, as it is then said', () => {
    const s = roundScreen(route)
    for (let y = 10; y <= 350; y += 10) s.fix(0, y, 0)
    s.fix(0, 358, 100)
    s.fix(0, 366, 0)
    // The engine gets to it with the card back up: it is in date, and said.
    expect(asked()[1].stale()).toBe(false)
    s.fix(0, 374, 0)
    expect(asked().map((w) => w.text)).toEqual(['In 200 metres, make a U-turn.', 'Make a U-turn.'])
  })
})
