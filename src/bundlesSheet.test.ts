import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BundleOrderEditor } from './BundleOrderEditor'
import { DROP_LOCK_MS, restoreBundle } from './bundleFlow'
import { bundleRows, markDropped, otherPasses } from './bundles'
import { BundlesSheet } from './BundlesSheet'
import type { Occurrence } from './geo'
import type { RoundState, Stop } from './types'

/*
 * What a tap on the Bundles list does, render after render. Nothing is mounted (the tests have no page): React's hooks are played by the
 * test, so the list can be called as a plain function and keep its state and refs from one render to the next as it would on the phone,
 * and its buttons are tapped by calling their onClick. Effects are not run. A state set while it renders renders it again at once, as
 * React does.
 */
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], at: 0, again: false }))
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
      const cell = slot(() => ({ value: typeof init === 'function' ? (init as () => T)() : init }))
      const set = (next: T | ((was: T) => T)) => {
        cell.value = typeof next === 'function' ? (next as (was: T) => T)(cell.value) : next
        hooks.again = true
      }
      return [cell.value, set]
    },
    useRef: <T>(init: T) => slot(() => ({ current: init })),
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
  }
})

type El = { type?: unknown; props?: { className?: string; children?: unknown; onClick?: () => void; 'aria-label'?: string } }

/** Every element in a tree that passes `test`, found by walking `props.children`. */
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

// Two bundles up a street, the phone at its foot.
const at = (id: string, y: number, extra: Partial<Stop> = {}): Occurrence => ({
  key: id,
  stop: { id, type: 'bundle', lat: -33.87 + y / 111_195, lng: 151.2, pathIdx: 0, ...extra },
  idx: 0,
  at: y,
  off: 0,
})
const occs = [at('a', 100, { label: 'Co-op', qty: 12 }), at('b', 400, { label: 'Spar', qty: 6 })]
const here = { lat: -33.87, lng: 151.2 }

/**
 * The list on a round, as the round screen has it: Mark dropped drops the bundle (and settles its other passes), Undo takes it back.
 * `render` draws it for the round as it now is, keeping what the list remembers from the render before.
 */
function sheet(round: RoundState = { handledStopIds: [] }, reorderable = false) {
  const state = { round, marks: [] as string[], undos: [] as string[] }
  hooks.slots = []
  const render = (): unknown => {
    let tree: unknown
    let renders = 0
    do {
      hooks.at = 0
      hooks.again = false
      tree = BundlesSheet({
        rows: bundleRows(occs, state.round, undefined, here),
        onOrder: reorderable ? () => undefined : undefined,
        onClose: () => undefined,
        onMark: (key) => {
          state.marks.push(key)
          state.round = markDropped(state.round, key, otherPasses(occs, key))
        },
        onUndo: (key) => {
          state.undos.push(key)
          state.round = restoreBundle(state.round, key, false)
        },
      })
    } while (hooks.again && ++renders < 5)
    return tree
  }
  /** Taps the button with this label, in the list as it is drawn now. */
  const tap = (label: string) => {
    const button = find(render(), (n) => n.props?.['aria-label'] === label)[0]
    expect(button, label).toBeDefined()
    button.props?.onClick?.()
  }
  const labels = () => find(render(), (n) => typeof n.props?.['aria-label'] === 'string' && /^(Mark|Undo)/.test(n.props['aria-label'])).map((n) => n.props?.['aria-label'])
  return { state, render, tap, labels }
}

let now = 0
beforeEach(() => {
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => vi.restoreAllMocks())

describe('a quick second tap on a bundle in the list', () => {
  it('is not taken as Undo when Mark dropped has just turned into Undo under the finger', () => {
    const { state, tap, labels } = sheet()
    tap('Mark Co-op as dropped')
    expect(labels()).toContain('Undo dropped for Co-op')
    now += 150
    tap('Undo dropped for Co-op')
    expect(state.undos).toEqual([])
    expect(state.round.dropped).toEqual(['a'])
  })

  it('is not taken as Mark dropped when Undo has just turned back into it', () => {
    const { state, tap } = sheet({ handledStopIds: ['a'], dropped: ['a'] })
    tap('Undo dropped for Co-op')
    expect(state.undos).toEqual(['a'])
    now += DROP_LOCK_MS - 1
    tap('Mark Co-op as dropped')
    expect(state.marks).toEqual([])
    expect(state.round.dropped ?? []).toEqual([])
  })

  it('is taken once the moment is over, as a tap of its own', () => {
    const { state, tap } = sheet()
    tap('Mark Co-op as dropped')
    now += DROP_LOCK_MS
    tap('Undo dropped for Co-op')
    expect(state.marks).toEqual(['a'])
    expect(state.undos).toEqual(['a'])
    expect(state.round.handledStopIds).toEqual([])
  })
})

describe('Reorder in the list', () => {
  const editor = (tree: unknown) => find(tree, (n) => n.type === BundleOrderEditor).length > 0
  const reorderButton = (tree: unknown) => find(tree, (n) => n.props?.className?.includes('bundles-reorder') ?? false)[0]

  it('ends for good when fewer than two are left to do, so an Undo that makes two again shows the list, not the editor', () => {
    const { state, render, tap } = sheet({ handledStopIds: [] }, true)
    reorderButton(render()).props?.onClick?.()
    expect(editor(render())).toBe(true)
    // Dropped on the alert above the list: one left, nothing to move, and the plain list is back.
    state.round = markDropped(state.round, 'a')
    expect(editor(render())).toBe(false)
    expect(reorderButton(render())).toBeUndefined()
    // Undo on its row: two to do again. The list stays the list, with Reorder to tap, and its buttons where they were.
    tap('Undo dropped for Co-op')
    const tree = render()
    expect(editor(tree)).toBe(false)
    expect(reorderButton(tree)?.props?.children).toBe('Reorder')
    expect(find(tree, (n) => n.props?.['aria-label'] === 'Mark Co-op as dropped')).toHaveLength(1)
  })

  it('opens the editor again when Reorder is tapped, and Finish closes it', () => {
    const { render } = sheet({ handledStopIds: [] }, true)
    reorderButton(render()).props?.onClick?.()
    expect(editor(render())).toBe(true)
    expect(reorderButton(render())?.props?.children).toBe('Finish')
    reorderButton(render()).props?.onClick?.()
    expect(editor(render())).toBe(false)
  })
})
