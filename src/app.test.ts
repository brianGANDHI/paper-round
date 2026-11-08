import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { addRoute, deleteRoute, editActiveRoute } from './library'
import { Round } from './Round'
import { Routes } from './Routes'
import type { SaveTrouble } from './storage'
import type { Library, Pt, Route } from './types'

/*
 * The app around the screens: what it does when the phone won't keep the routes. Nothing is mounted, as in optimiseSheet.test.ts: the app is called as a
 * plain function that keeps its state from one call to the next, and the screens it holds are stand-ins, so only what it hands them is looked at. The
 * phone's storage is a stand-in too, with as much room as a test gives it. All the routes are made up.
 */
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], at: 0 }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const slot = <T>(make: () => T): T => {
    const i = hooks.at++
    if (!(i in hooks.slots)) hooks.slots[i] = make()
    return hooks.slots[i] as T
  }
  return {
    ...actual,
    useState: <T>(init: T | (() => T)) => {
      const cell = slot(() => {
        const made = {
          value: typeof init === 'function' ? (init as () => T)() : init,
          set: (next: T | ((was: T) => T)) => {
            made.value = typeof next === 'function' ? (next as (was: T) => T)(made.value) : next
          },
        }
        return made
      })
      return [cell.value, cell.set]
    },
    useRef: <T>(init: T) => slot(() => ({ current: init })),
    useEffect: () => undefined,
  }
})
vi.mock('./Round', () => ({ Round: () => null }))
vi.mock('./Routes', () => ({ Routes: () => null }))
vi.mock('./Setup', () => ({ Setup: () => null }))

interface El {
  type: unknown
  props?: Record<string, unknown> & { children?: unknown }
}

function find(node: unknown, test: (n: El) => boolean, found: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const kid of node) find(kid, test, found)
    return found
  }
  if (!node || typeof node !== 'object') return found
  const el = node as El
  if (test(el)) found.push(el)
  find(el.props?.children, test, found)
  return found
}

const words = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(words).join('')
  return node && typeof node === 'object' ? words((node as El).props?.children) : ''
}

/** Storage that holds as many characters as `room` says, keys and all, and refuses a write that would take it past that, as a full phone does. */
function phoneStorage(room: number) {
  const kept = new Map<string, string>()
  const size = { room }
  const usedBesides = (key: string) => [...kept].reduce((n, [k, v]) => (k === key ? n : n + k.length + v.length), 0)
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (usedBesides(key) + key.length + value.length > size.room) throw new Error('The quota has been exceeded.')
      kept.set(key, value)
    },
    removeItem: (key: string) => void kept.delete(key),
  }
  return { storage, size, used: () => usedBesides('') }
}

/** The app, called afresh each time as React would draw it, keeping its state. */
function app() {
  hooks.slots = []
  const draw = () => {
    hooks.at = 0
    return App() as unknown
  }
  const warning = () => find(draw(), (n) => n.props?.className === 'save-warning').map(words)[0]
  /** Taps a tab in the bar along the bottom. */
  const go = (label: string) => {
    const [tab] = find(draw(), (n) => n.type === 'button' && words(n) === label)
    const tap = tab.props?.onClick as () => void
    tap()
  }
  /** Goes to the Routes tab and hands back what it gives the screen to change the routes with. */
  const update = () => {
    go('Routes')
    const [routes] = find(draw(), (n) => n.type === Routes)
    return routes.props?.update as (change: (lib: Library) => Library) => SaveTrouble | null
  }
  return { draw, go, warning, update }
}

/** A route long enough to need some room: a line of made-up points going nowhere in particular. */
const longRoute = (n: number): Route => ({
  points: Array.from({ length: n }, (_, i): Pt => ({ lat: -31 - i * 0.0001, lng: 149 + (i % 7) * 0.0001 })),
  sideChanges: [{ idx: 0, side: 'left' }],
  stops: [],
})

describe('the app when the phone will not keep the routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('because it has no room left', () => {
    let phone: ReturnType<typeof phoneStorage>
    beforeEach(() => {
      phone = phoneStorage(1_000_000)
      vi.stubGlobal('localStorage', phone.storage)
    })

    it('says so, and to delete a route, not to try another tab, tells the screen it was for want of room, and says nothing once a change fits again', () => {
      const a = app()
      const update = a.update()
      expect(a.warning()).toBeUndefined()
      phone.size.room = phone.used() + 5_000
      expect(update((lib) => addRoute(lib, 'Long', longRoute(2_000)))).toBe('full')
      const warning = a.warning()
      expect(warning).toMatch(/no room left/)
      expect(warning).toMatch(/Delete a route/)
      expect(warning).not.toMatch(/private/)
      expect(update((lib) => deleteRoute(lib, lib.activeId))).toBeNull()
      expect(a.warning()).toBeUndefined()
    })
  })

  describe('because it keeps nothing at all', () => {
    beforeEach(() => {
      const { storage } = phoneStorage(0)
      vi.stubGlobal('localStorage', storage)
    })

    it('says so from the start, and to try a normal tab, and tells the screen each change was not kept because nothing is', () => {
      const a = app()
      expect(a.warning()).toMatch(/private/)
      expect(a.update()((lib) => addRoute(lib, 'Monday'))).toBe('blocked')
      expect(a.warning()).toMatch(/private/)
    })
  })
})

describe('the Round screen while Optimise Route is open', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', phoneStorage(1_000_000).storage)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Optimise Route opens from the Routes tab, so Accept changes the route in use while that tab is up. The Round screen keeps where the car is along
  // the route, and what it has told of the named sections, only while it is up, so it must not be up then: back on the Round tab it starts afresh,
  // on the new route, and can't carry on from a place on the old one.
  it('is not up while the Routes tab is, and comes back with the route that is in use then', () => {
    const a = app()
    expect(find(a.draw(), (n) => n.type === Round)).toHaveLength(1)
    const update = a.update()
    expect(find(a.draw(), (n) => n.type === Round)).toEqual([])
    const line: Pt[] = [
      { lat: -31, lng: 149 },
      { lat: -31.001, lng: 149 },
    ]
    update((lib) => editActiveRoute(addRoute(lib, 'Monday'), { points: line, sideChanges: [{ idx: 0, side: 'left' }], stops: [] }))
    a.go('Round')
    const [round] = find(a.draw(), (n) => n.type === Round)
    expect(round.props?.route).toMatchObject({ points: line })
    expect(round.props?.round).toEqual({ handledStopIds: [] })
  })
})
