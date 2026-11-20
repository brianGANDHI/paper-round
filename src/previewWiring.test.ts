/// <reference types="node" />
import { isValidElement, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lineThrough } from './driveSim'
import { FIRST_SPEED, type PreviewSpeed } from './playback'
import { Preview } from './Preview'
import { sections } from './routeEdit'
import { say, stopSpeaking, unlockSpeech } from './speech'
import { TurnCard } from './TurnCard'
import { Segmented } from './ui'
import type { NamedSection, Route } from './types'

/*
 * Preview the Drive itself, not a copy of its steps: the real `Preview` played through its real effects, as roundWiring.test.ts plays the round
 * screen (see there). Nothing is mounted (the tests have no page): React's hooks are played by the test, which calls the screen as a plain function,
 * runs the effects whose dependencies changed, and calls it again until nothing changes. A frame of the screen is a timer of 16 ms. Only what is
 * outside the app is pretend: the speech engine, keeping the screen awake and the map, which has nothing to draw on.
 */
const play = vi.hoisted(() => ({
  slots: [] as unknown[],
  at: 0,
  dirty: false,
  passive: [] as { cell: { deps?: readonly unknown[]; cleanup?: void | (() => void) }; run: () => void | (() => void); deps?: readonly unknown[] }[],
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const slot = <T>(make: () => T): T => {
    const i = play.at++
    if (!(i in play.slots)) play.slots[i] = make()
    return play.slots[i] as T
  }
  const same = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
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
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => {
      const cell = slot((): (typeof play.passive)[number]['cell'] => ({}))
      if (!same(cell.deps, deps)) play.passive.push({ cell, run, deps })
    },
  }
})
vi.mock('./device', () => ({ useWakeLock: () => true }))
vi.mock('./MapView', () => ({ MapView: () => null }))
vi.mock('./speech', () => ({ say: vi.fn(), speechAvailable: () => true, stopSpeaking: vi.fn(), unlockSpeech: vi.fn() }))

/** Calls `component` until nothing changes, running the effects each time as a page would, and gives back what it would draw last. */
function settle(component: () => unknown): unknown {
  for (let turn = 0; turn < 100; turn++) {
    let drawn: unknown
    do {
      play.dirty = false
      play.at = 0
      play.passive = []
      drawn = component()
    } while (play.dirty)
    for (const e of play.passive) {
      if (typeof e.cell.cleanup === 'function') e.cell.cleanup()
      e.cell.cleanup = e.run()
      e.cell.deps = e.deps
    }
    if (!play.dirty) return drawn
  }
  throw new Error('The screen never settled')
}

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
/** All the words in an element and what is in it, numbers too, as they read. */
const text = (e: ReactElement<Record<string, unknown>>): string =>
  [...elements(e)].map((x) => [x.props.children].flat(3).filter((c) => typeof c === 'string' || typeof c === 'number').join('')).join('')
/** A choice in a sheet, Cancel among them. */
const isChoice = (e: ReactElement<Record<string, unknown>>) => e.type === 'button' && String(e.props.className ?? '').startsWith('action-choice')

/**
 * A made-up route (see driveSim.ts), a point every 10 m: 600 m north, a right turn, then 400 m east. The first 300 m are thrown port, the next 200 m
 * are transit, and the rest is thrown on both sides. A named section, Oak Estate, starts 550 m along.
 */
const ROUTE: Route = {
  points: lineThrough(
    [
      [0, 0],
      [0, 600],
      [400, 600],
    ],
    10,
  ),
  sideChanges: [
    { idx: 0, side: 'left' },
    { idx: 30, side: 'transit' },
    { idx: 50, side: 'both' },
  ],
  stops: [],
}
const OAK: NamedSection = { id: 'oak', name: 'Oak Estate', ...ROUTE.points[55] }

/** The preview on a route, with what the round screen does for it. */
function previewScreen({ route = ROUTE, from = 0, speed = FIRST_SPEED as PreviewSpeed, named = [OAK] }: { route?: Route; from?: number; speed?: PreviewSpeed; named?: NamedSection[] } = {}) {
  play.slots = []
  const adjusted: Route[] = []
  const edits: [number, number, PreviewSpeed][] = []
  let closed = 0
  const props: Parameters<typeof Preview>[0] = {
    route,
    sections: named,
    streets: [],
    reachM: 70,
    from,
    speed,
    onAdjustRoute: (next) => {
      adjusted.push(next)
      props.route = next
      play.dirty = true
    },
    onEditStretch: (index, along, at) => void edits.push([index, along, at]),
    onClose: () => void closed++,
  }
  let drawn: unknown = settle(() => Preview(props))
  const update = () => (drawn = settle(() => Preview(props)))
  const all = () => [...elements(drawn)]
  const byLabel = (label: string) => all().find((e) => e.type === 'button' && e.props['aria-label'] === label)
  const byWords = (name: string) => all().find((e) => e.type === 'button' && [...elements(e)].some((x) => words(x).includes(name)))
  const tap = (button: ReactElement<Record<string, unknown>> | undefined, what: string) => {
    if (!button) throw new Error(`No button for ${what}`)
    ;(button.props.onClick as () => void)()
    update()
  }
  return {
    props,
    adjusted,
    edits,
    closed: () => closed,
    all,
    update,
    /** Taps the button with this name for a screen reader. */
    tapLabel: (label: string) => tap(byLabel(label), label),
    /** Taps the button with these words on it. */
    press: (name: string) => tap(byWords(name), name),
    /** Taps a choice in the sheet that is up, and lets the screen carry on with it. */
    async choose(name: string) {
      const choice = all().find((e) => isChoice(e) && [...elements(e)].some((x) => words(x) === name))
      if (!choice) throw new Error(`No choice ${name}: ${this.choices().join(', ')}`)
      ;(choice.props.onClick as () => void)()
      update()
      await Promise.resolve()
      await Promise.resolve()
      update()
    },
    /** The choices in the sheet that is up. */
    choices: () =>
      all()
        .filter(isChoice)
        .map((e) => [...elements(e)].map(words).find(Boolean) ?? ''),
    /** The big side at the top: what a screen reader is told of it. */
    side: () => String(all().find((e) => e.props.className === 'preview-side')?.props['aria-label'] ?? ''),
    /** How far along the route it is, as the bar to drag along says. */
    along: () => Number(all().find((e) => e.type === 'input')?.props.value),
    /** Drags the bar along the route to this many metres. */
    drag(metres: number) {
      const bar = all().find((e) => e.type === 'input')
      if (!bar) throw new Error('No bar to drag')
      ;(bar.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: String(metres) } })
      update()
    },
    /** The lines of the panel: the stretch, the named section, how far along. */
    panel: () =>
      all()
        .filter((e) => e.props.className === 'title' || e.props.className === 'sub')
        .map(text),
    turn: () => all().find((e) => e.type === TurnCard)?.props as Parameters<typeof TurnCard>[0] | undefined,
    notice: () => {
      const n = all().find((e) => e.props.className === 'preview-notice')
      return n ? [...elements(n)].map(words).filter(Boolean).join(' ') : null
    },
    /** Lets this many milliseconds of frames go by. */
    frames(ms: number) {
      vi.advanceTimersByTime(ms)
      update()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (run: (t: number) => void) => setTimeout(() => run(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
  vi.clearAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('opening the preview', () => {
  it('opens paused at the start of the route, with the side of the first stretch big at the top', () => {
    const s = previewScreen()
    expect(s.side()).toBe('Throw side: Port Side. Stretch 1 of 3. Tap to change it.')
    expect(s.along()).toBe(0)
    expect(s.panel()[0]).toBe('Stretch 1 of 3')
    expect(s.all().some((e) => e.props['aria-label'] === 'Play')).toBe(true)
  })

  it('opens where it was left, at the speed it was playing at', () => {
    const s = previewScreen({ from: 400, speed: 30 })
    expect(s.side()).toBe('Throw side: Transit. Stretch 2 of 3. Tap to change it.')
    expect(s.along()).toBe(400)
    const speeds = s.all().find((e) => e.type === Segmented)?.props as { value: string; options: { label: string }[] }
    expect(speeds.value).toBe('30')
    expect(speeds.options.map((o) => o.label)).toEqual(['10×', '30×', '60×'])
  })

  it('never opens past the end of the route', () => {
    expect(previewScreen({ from: 50_000 }).along()).toBe(1000)
  })
})

describe('playing', () => {
  it('goes along at the speed picked, 25 km/h times it where papers are thrown', () => {
    const s = previewScreen()
    s.tapLabel('Play')
    s.frames(1000)
    // At 10x, 69 m a second, less the first frame, which only starts the clock.
    expect(s.along()).toBeGreaterThan(60)
    expect(s.along()).toBeLessThan(70)
    expect(s.all().some((e) => e.props['aria-label'] === 'Pause')).toBe(true)
  })

  it('shows the new side the moment the marker reaches its stretch, and goes faster on transit', () => {
    const s = previewScreen({ from: 280 })
    s.tapLabel('Play')
    s.frames(500)
    expect(s.side()).toContain('Transit. Stretch 2 of 3')
    const onTransit = s.along()
    s.frames(500)
    // Half a second of transit at 10x is about 69 m, twice the pace of a thrown stretch.
    expect(s.along() - onTransit).toBeGreaterThan(60)
  })

  it('stops by itself at the end of the route, and Play then starts again from the beginning', () => {
    const s = previewScreen({ from: 990 })
    s.tapLabel('Play')
    s.frames(2000)
    expect(s.along()).toBe(1000)
    expect(s.panel()).toContain('1.0 km of 1.0 km · End of the route')
    s.tapLabel('Play again from the start')
    expect(s.along()).toBeLessThan(5)
    expect(s.all().some((e) => e.props['aria-label'] === 'Pause')).toBe(true)
  })

  it('pauses where it is', () => {
    const s = previewScreen()
    s.tapLabel('Play')
    s.frames(500)
    s.tapLabel('Pause')
    const at = s.along()
    s.frames(2000)
    expect(s.along()).toBe(at)
  })
})

describe('jumping', () => {
  it('goes on to the start of the next stretch, and back a stretch at a time', () => {
    const s = previewScreen({ from: 120 })
    s.tapLabel('Next stretch')
    expect(s.along()).toBe(300)
    expect(s.side()).toContain('Transit. Stretch 2 of 3')
    s.tapLabel('Next stretch')
    expect(s.along()).toBe(500)
    expect(s.all().find((e) => e.props['aria-label'] === 'Next stretch')?.props.disabled).toBe(true)
    s.tapLabel('Previous stretch')
    expect(s.along()).toBe(300)
    s.tapLabel('Previous stretch')
    expect(s.along()).toBe(0)
  })

  it('goes anywhere along the route with the bar, and back to the beginning', () => {
    const s = previewScreen()
    s.drag(720)
    expect(s.along()).toBe(720)
    expect(s.side()).toContain('Both Sides. Stretch 3 of 3')
    s.tapLabel('Back to the start of the route')
    expect(s.along()).toBe(0)
  })
})

describe('what the panel and the top say', () => {
  it('says how far along it is and roughly how long the rest takes at the speed picked', () => {
    const s = previewScreen()
    // 800 m thrown at 25 km/h and 200 m of transit at 50 km/h take about 2 minutes of real time: under a minute at 10x.
    expect(s.panel()).toContain('0 m of 1.0 km · Under a minute left')
  })

  it('names the named section the marker is in, as the round numbers it', () => {
    const s = previewScreen({ from: 700 })
    expect(s.panel()).toContain('Section 1 · Oak Estate')
    expect(previewScreen({ from: 100 }).panel().some((line) => line.startsWith('Section'))).toBe(false)
  })

  it('shows the next turn as the round does: within 200 m', () => {
    expect(previewScreen({ from: 100 }).turn()).toBeUndefined()
    const near = previewScreen({ from: 520 }).turn()
    expect(near?.kind ?? 'turn').toBe('turn')
    expect(near && 'turn' in near ? near.turn.angle : 0).toBeGreaterThan(0)
  })

  it('has no Left or Right in what it shows for a side', () => {
    for (const from of [0, 400, 700]) {
      const shown = previewScreen({ from })
        .all()
        .map(words)
        .join(' ')
      expect(shown).not.toMatch(/\b(Left|Right|LEFT|RIGHT)\b/)
    }
  })
})

describe('changing a side from the preview', () => {
  it('asks the side, then how much, changes only that part, and can be undone', async () => {
    const s = previewScreen({ from: 400 })
    s.tapLabel('Throw side: Transit. Stretch 2 of 3. Tap to change it.')
    expect(s.choices()).toEqual(['Both Sides', 'Port Side', 'Starboard Side', 'Cancel'])
    await s.choose('Starboard Side')
    expect(s.choices()).toEqual(['To the end of this stretch', 'The whole stretch', 'Cancel'])
    await s.choose('To the end of this stretch')
    expect(s.adjusted).toHaveLength(1)
    // From the marker to the end of the stretch: the first half of the transit stays as it was.
    expect(sections(s.adjusted[0]).map((x) => [Math.round(x.startM), Math.round(x.endM), x.side])).toEqual([
      [0, 300, 'left'],
      [300, 400, 'transit'],
      [400, 500, 'right'],
      [500, 1000, 'both'],
    ])
    expect(s.side()).toContain('Starboard Side. Stretch 3 of 4')
    expect(s.notice()).toBe('To the end of this stretch: now Starboard Side. Undo')
    s.press('Undo')
    expect(s.adjusted.at(-1)).toBe(ROUTE)
    expect(s.notice()).toBeNull()
  })

  it('calls the whole stretch the whole stretch when the marker is at its start, as after Next Stretch', async () => {
    const s = previewScreen()
    s.tapLabel('Next stretch')
    s.press('Change Side')
    await s.choose('Both Sides')
    expect(s.choices()).toEqual(['The whole stretch', 'Cancel'])
    await s.choose('The whole stretch')
    // Joined to the stretch after it, which is thrown on both sides too.
    expect(sections(s.adjusted[0]).map((x) => [Math.round(x.startM), Math.round(x.endM), x.side])).toEqual([
      [0, 300, 'left'],
      [300, 1000, 'both'],
    ])
  })

  it('pauses while the side is asked, and changes nothing when it is cancelled', async () => {
    const s = previewScreen()
    s.tapLabel('Play')
    s.frames(300)
    s.press('Change Side')
    expect(s.all().some((e) => e.props['aria-label'] === 'Play')).toBe(true)
    await s.choose('Cancel')
    expect(s.adjusted).toEqual([])
  })

  it('hands Edit in Setup the stretch the marker is in, where it is and the speed, to carry on from', () => {
    const s = previewScreen({ from: 420, speed: 60 })
    s.press('Edit in Setup')
    expect(s.edits).toEqual([[1, 420, 60]])
  })

  it('closes with Done', () => {
    const s = previewScreen()
    s.press('Done')
    expect(s.closed()).toBe(1)
  })
})

describe('the voice', () => {
  it('is off until switched on, then says each new side once, as the marker reaches it', () => {
    const s = previewScreen()
    s.tapLabel('Next stretch')
    expect(say).not.toHaveBeenCalled()
    s.tapLabel('Say each side as it comes')
    expect(unlockSpeech).toHaveBeenCalled()
    expect(vi.mocked(say).mock.calls.map(([text]) => text)).toEqual(['Transit'])
    s.tapLabel('Next stretch')
    expect(vi.mocked(say).mock.calls.map(([text]) => text)).toEqual(['Transit', 'Both'])
    // A word whose side has gone by before it could be said is left out.
    const [, options] = vi.mocked(say).mock.calls[0]
    expect(options?.stale?.()).toBe(true)
    s.tapLabel('Say each side as it comes')
    expect(stopSpeaking).toHaveBeenCalled()
    s.tapLabel('Previous stretch')
    expect(vi.mocked(say).mock.calls).toHaveLength(2)
  })
})
