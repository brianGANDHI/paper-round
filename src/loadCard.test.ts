/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addRoute, activeRoute, createLibrary, setLoad } from './library'
import { DEFAULT_LOAD, MAX_LOAD_LINES, MAX_LOAD_NOTE, MAX_LOAD_NUMBER, type LoadLine, type LoadList } from './load'
import { LoadCard, LoadSheet } from './LoadCard'
import { Segmented } from './ui'

/*
 * The list on the start screen and the sheet that changes it. What they draw is read from their markup, and what a tap or a key does is
 * played render after render, as in bundlesSheet.test.ts: nothing is mounted (the tests have no page), so React's hooks are played by the
 * test, the sheet is called as a plain function that keeps its state from one render to the next, and its controls are used by calling
 * their handlers. Effects are kept to be run by the test that wants them, as React keeps them: not again while their dependencies stay the
 * same. The sheet goes straight on the page, which here is its own markup.
 */
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], at: 0, effects: [] as (() => void | (() => void))[] }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  const slot = <T>(make: () => T): T => {
    const i = hooks.at++
    if (!(i in hooks.slots)) hooks.slots[i] = make()
    return hooks.slots[i] as T
  }
  const keep = (run: () => void | (() => void), deps?: unknown[]) => {
    const last = slot(() => ({ deps: undefined as unknown[] | undefined }))
    const same = deps && last.deps && deps.every((d, i) => Object.is(d, last.deps?.[i]))
    last.deps = deps
    if (!same) hooks.effects.push(run)
  }
  return {
    ...actual,
    useState: <T>(init: T) => {
      const cell = slot(() => ({ value: init }))
      return [cell.value, (next: T) => (cell.value = next)]
    },
    useRef: <T>(init: T) => slot(() => ({ current: init })),
    useEffect: keep,
    useLayoutEffect: keep,
  }
})
vi.mock('react-dom', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-dom')>()), createPortal: (node: unknown) => node }))

const css = readFileSync(new URL('./load.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const indexCss = readFileSync(new URL('./index.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** What a rule of a stylesheet sets, or null when it has no such rule or sets no such thing. */
const declared = (sheet: string, selector: string, property: string): string | null => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`(?:^|})\\s*${escaped}\\s*{([^}]*)}`).exec(sheet)
  const value = rule ? new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`).exec(rule[1]) : null
  return value ? value[1].trim() : null
}
const px = (sheet: string, selector: string, property: string) => Number.parseInt(declared(sheet, selector, property) ?? '0', 10)

const html = (element: Parameters<typeof renderToStaticMarkup>[0]): string => {
  hooks.slots = []
  hooks.at = 0
  return renderToStaticMarkup(element)
}

/** The rows of the card as words, in order, with the hidden word for the papers left out. */
const rowsOf = (out: string): string[] =>
  [...out.matchAll(/<li class="load-row[^"]*">(.*?)<\/li>/g)].map((m) =>
    m[1]
      .replace(/<span class="load-unit">.*?<\/span>/g, '')
      .replace(/<\/span><span class="load-papers">/g, ' | ')
      .replace(/<[^>]*>/g, ''),
  )

const card = (load?: LoadList): string => html(createElement(LoadCard, { load, onLoad: () => undefined }))

const line = (id: string, bundles: number, kind: LoadLine['kind'], note?: string): LoadLine => ({ id, bundles, kind, ...(note ? { note } : {}) })
const list = (...lines: LoadLine[]): LoadList => ({ lines, papersEach: { bagged: 25, unwrapped: 50 } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the list on the start screen', () => {
  it("shows the driver's own list, line for line, when the route has none of its own", () => {
    expect(rowsOf(card())).toEqual(['102 bagged · 1 pallet | 2,550', '+ 18 bagged | 450', '= 120 bagged', '+ 13 unwrapped | 650', '133 bundles · 3,650 papers all up'])
  })

  it('has the name of the list and Edit above it', () => {
    const out = card()
    expect(out).toContain('<div class="brush-label">Papers to load</div>')
    expect(out).toMatch(/<button class="btn plain load-edit" aria-label="Edit papers to load">Edit<\/button>/)
    expect(out.indexOf('Papers to load</div>')).toBeLessThan(out.indexOf('load-row'))
  })

  it('shows the list the route has', () => {
    expect(rowsOf(card(list(line('a', 4, 'bagged'), line('b', 2, 'unwrapped'))))).toEqual(['4 bagged | 100', '+ 2 unwrapped | 100', '6 bundles · 200 papers all up'])
  })

  it('marks the row that adds up and the whole, and tells a screen reader what the figures are', () => {
    const out = card()
    expect(out).toContain('<li class="load-row subtotal">')
    expect(out).toContain('<li class="load-row whole">')
    expect(out).toContain('<span class="load-papers">2,550<span class="load-unit"> papers</span></span>')
  })

  it('says so, with no sums, when every line has been taken off', () => {
    const out = card(list())
    expect(rowsOf(out)).toEqual([])
    expect(out).toContain('Nothing on the list yet.')
    expect(out).toContain('Edit')
  })

  it('is closed until Edit is tapped', () => {
    expect(card()).not.toContain('load-scrim')
  })
})

type El = { type?: unknown; props?: Record<string, unknown> & { className?: string; children?: unknown } }

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

/** All the words under an element, run together. */
const words = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(words).join('')
  return node && typeof node === 'object' ? words((node as El).props?.children) : ''
}

/** Calls one of an element's handlers. */
const fire = (el: El, handler: string, ...args: unknown[]) => {
  const run = el.props?.[handler] as (...given: unknown[]) => void
  run(...args)
}

const labelled = (tree: unknown, label: string): El => {
  const [el] = find(tree, (n) => n.props?.['aria-label'] === label)
  expect(el, label).toBeDefined()
  return el
}

/** The sheet on a route, as the app has it: each change goes through `setLoad`, and `saved` is what the route holds now. */
function sheet(start: LoadList = DEFAULT_LOAD) {
  let lib = addRoute(createLibrary(), 'Monday')
  const closes = { count: 0 }
  const changes: LoadList[] = []
  const onChange = (next: LoadList) => {
    changes.push(next)
    lib = setLoad(lib, lib.activeId, next)
  }
  hooks.slots = []
  hooks.effects = []
  const render = (): unknown => {
    hooks.at = 0
    return LoadSheet({ list: start, onChange, onClose: () => closes.count++ })
  }
  /** Types into a field: the whole of what it would then hold. */
  const type = (label: string, value: string) => {
    fire(labelled(render(), label), 'onChange', { target: { value } })
  }
  const field = (label: string) => labelled(render(), label).props?.value
  const tap = (label: string) => fire(labelled(render(), label), 'onClick')
  const addLineButton = () => find(render(), (n) => n.type === 'button' && words(n).includes('Add line'))[0]
  const paperField = (kind: string) => find(find(render(), (n) => n.props?.className === 'row field' && words(n).startsWith(kind))[0], (n) => n.type === 'input')[0]
  const typePapers = (kind: string, value: string) => fire(paperField(kind), 'onChange', { target: { value } })
  const whole = () => words(find(render(), (n) => n.props?.className === 'load-sheet-whole')[0])
  const papersOf = (i: number) => words(find(labelled(render(), `Line ${i}`), (n) => n.props?.className === 'load-line-papers')[0])
  return { render, type, field, tap, addLineButton, paperField, typePapers, whole, papersOf, closes, changes, saved: () => activeRoute(lib).load }
}

describe('the sheet that changes the list', () => {
  it('shows each line with its bundles, kind and note, its papers and the whole', () => {
    const s = sheet()
    expect(s.field('Line 1, how many bundles')).toBe('102')
    expect(s.field('Line 1, note')).toBe('1 pallet')
    expect(s.field('Line 2, note')).toBe('')
    expect(find(s.render(), (n) => n.type === Segmented).map((n) => n.props?.value)).toEqual(['bagged', 'bagged', 'unwrapped'])
    expect(s.papersOf(1)).toBe('2,550 papers')
    expect(s.papersOf(3)).toBe('650 papers')
    expect(s.whole()).toBe('133 bundles · 3,650 papers all up')
    expect(s.paperField('Bagged').props?.value).toBe('25')
    expect(s.paperField('Unwrapped').props?.value).toBe('50')
  })

  it('offers both kinds', () => {
    const s = sheet()
    const options = find(s.render(), (n) => n.type === Segmented)[0].props?.options as { value: string; label: string }[]
    expect(options).toEqual([
      { value: 'bagged', label: 'Bagged' },
      { value: 'unwrapped', label: 'Unwrapped' },
    ])
  })

  it('updates the sums as bundles are typed, and keeps each change', () => {
    const s = sheet()
    s.type('Line 2, how many bundles', '20')
    expect(s.papersOf(2)).toBe('500 papers')
    expect(s.whole()).toBe('135 bundles · 3,700 papers all up')
    expect(s.saved()?.lines[1].bundles).toBe(20)
  })

  it('treats a blank field as 0 while it is rubbed out, showing it blank', () => {
    const s = sheet()
    s.type('Line 1, how many bundles', '')
    expect(s.field('Line 1, how many bundles')).toBe('')
    expect(s.papersOf(1)).toBe('0 papers')
    expect(s.whole()).toBe('31 bundles · 1,100 papers all up')
    expect(s.saved()?.lines[0].bundles).toBe(0)
    s.type('Line 1, how many bundles', '9')
    expect(s.field('Line 1, how many bundles')).toBe('9')
  })

  it('takes no more than the most a field holds, and nothing but a whole number', () => {
    const s = sheet()
    s.type('Line 1, how many bundles', '123456')
    expect(s.field('Line 1, how many bundles')).toBe(String(MAX_LOAD_NUMBER))
    s.type('Line 1, how many bundles', '12a')
    expect(s.field('Line 1, how many bundles')).toBe('12')
    s.type('Line 1, how many bundles', '-')
    expect(s.field('Line 1, how many bundles')).toBe('')
  })

  it('changes the kind of a line, and the sums with it', () => {
    const s = sheet()
    fire(find(s.render(), (n) => n.type === Segmented)[1], 'onChange', 'unwrapped')
    expect(s.papersOf(2)).toBe('900 papers')
    expect(s.whole()).toBe('133 bundles · 4,100 papers all up')
    expect(s.saved()?.lines[1].kind).toBe('unwrapped')
  })

  it('updates the sums as the papers in a bundle are typed', () => {
    const s = sheet()
    s.typePapers('Bagged', '30')
    expect(s.papersOf(1)).toBe('3,060 papers')
    expect(s.whole()).toBe('133 bundles · 4,250 papers all up')
    expect(s.saved()?.papersEach).toEqual({ bagged: 30, unwrapped: 50 })
    s.typePapers('Unwrapped', '')
    expect(s.paperField('Unwrapped').props?.value).toBe('')
    expect(s.saved()?.papersEach).toEqual({ bagged: 30, unwrapped: 0 })
  })

  it('lets a note be typed a letter at a time, spaces and all, and keeps it tidy on the route', () => {
    const s = sheet(list(line('a', 1, 'bagged')))
    for (const typed of ['1', '1 ', '1 p', '1 pallet ']) {
      s.type('Line 1, note', typed)
      expect(s.field('Line 1, note')).toBe(typed)
    }
    expect(s.saved()?.lines[0].note).toBe('1 pallet')
  })

  it('takes a note off when it is rubbed out', () => {
    const s = sheet()
    s.type('Line 1, note', '')
    expect('note' in s.saved()!.lines[0]).toBe(false)
  })

  it('stops a note at the longest kept', () => {
    expect(labelled(sheet().render(), 'Line 1, note').props?.maxLength).toBe(MAX_LOAD_NOTE)
  })

  it('removes a line, and the sums with it', () => {
    const s = sheet()
    s.tap('Remove line 2')
    expect(s.field('Line 2, how many bundles')).toBe('13')
    expect(s.whole()).toBe('115 bundles · 3,200 papers all up')
    expect(s.saved()?.lines.map((l) => l.bundles)).toEqual([102, 13])
  })

  it('says so when every line has been taken off, and keeps that on the route', () => {
    const s = sheet(list(line('a', 1, 'bagged')))
    s.tap('Remove line 1')
    expect(words(s.render())).toContain('Nothing on the list yet.')
    expect(s.saved()?.lines).toEqual([])
    expect(s.addLineButton().props?.disabled).toBe(false)
  })

  it('adds a line ready to be typed in, and only that one', () => {
    const s = sheet()
    fire(s.addLineButton(), 'onClick')
    const tree = s.render()
    expect(labelled(tree, 'Line 4, how many bundles').props?.autoFocus).toBe(true)
    expect(labelled(tree, 'Line 3, how many bundles').props?.autoFocus).toBe(false)
    expect(s.field('Line 4, how many bundles')).toBe('')
    expect(s.saved()?.lines).toHaveLength(4)
    s.type('Line 4, how many bundles', '2')
    expect(s.whole()).toBe('135 bundles · 3,750 papers all up')
  })

  it('has no room for another line on a full list', () => {
    const full = sheet(list(...Array.from({ length: MAX_LOAD_LINES }, (_, i) => line(`l${i}`, 1, 'bagged'))))
    expect(full.addLineButton().props?.disabled).toBe(true)
    expect(sheet(list(...Array.from({ length: MAX_LOAD_LINES - 1 }, (_, i) => line(`l${i}`, 1, 'bagged')))).addLineButton().props?.disabled).toBe(false)
  })

  it('saves nothing until something is changed, so a route with none of its own still has none after a look', () => {
    const s = sheet()
    fire(find(s.render(), (n) => n.type === 'button' && words(n) === 'Done')[0], 'onClick')
    expect(s.closes.count).toBe(1)
    expect(s.changes).toEqual([])
    expect(s.saved()).toBeUndefined()
  })

  it('never changes the usual list, however it is edited', () => {
    const before = structuredClone(DEFAULT_LOAD)
    const s = sheet()
    s.type('Line 1, how many bundles', '5')
    s.type('Line 1, note', 'Boot')
    s.typePapers('Bagged', '10')
    s.tap('Remove line 2')
    fire(s.addLineButton(), 'onClick')
    expect(DEFAULT_LOAD).toEqual(before)
  })

  it('saves the whole of the usual list on the route at the first change', () => {
    const s = sheet()
    s.type('Line 2, how many bundles', '20')
    expect(s.saved()).toEqual({ ...DEFAULT_LOAD, lines: [DEFAULT_LOAD.lines[0], { ...DEFAULT_LOAD.lines[1], bundles: 20 }, DEFAULT_LOAD.lines[2]] })
  })

  describe('its fields', () => {
    it('brings up the numeric keypad for every number', () => {
      const tree = sheet().render()
      const numbers = find(tree, (n) => n.type === 'input' && n.props?.inputMode === 'numeric')
      expect(numbers).toHaveLength(5)
      for (const f of numbers) {
        expect(f.props?.pattern).toBe('[0-9]*')
        expect(f.props?.placeholder).toBe('0')
        expect(f.props?.maxLength).toBe(String(MAX_LOAD_NUMBER).length)
      }
    })

    it('puts the keyboard away on Return in every field, and not on any other key', () => {
      const tree = sheet().render()
      const fields = find(tree, (n) => n.type === 'input')
      expect(fields).toHaveLength(8)
      for (const f of fields) {
        const blur = vi.fn()
        fire(f, 'onKeyDown', { key: '5', currentTarget: { blur } })
        expect(blur).not.toHaveBeenCalled()
        fire(f, 'onKeyDown', { key: 'Enter', currentTarget: { blur } })
        expect(blur).toHaveBeenCalledOnce()
      }
    })

    it('names each field and button by its line for a screen reader', () => {
      const out = html(createElement(LoadSheet, { list: DEFAULT_LOAD, onChange: () => undefined, onClose: () => undefined }))
      for (const label of ['Line 3, how many bundles', 'Line 3, what kind of bundle', 'Line 3, note', 'Remove line 3']) expect(out).toContain(`aria-label="${label}"`)
      expect(out).toContain('role="dialog"')
      expect(out).toContain('aria-modal="true"')
      expect(out).toContain('aria-label="Papers to load"')
    })

    it('says what the papers in a bundle are for a screen reader, not only Bagged and Unwrapped', () => {
      const s = sheet()
      expect(s.paperField('Bagged').props?.['aria-label']).toBe('Papers in a bagged bundle')
      expect(s.paperField('Unwrapped').props?.['aria-label']).toBe('Papers in an unwrapped bundle')
      s.type('Papers in a bagged bundle', '30')
      expect(s.saved()?.papersEach).toEqual({ bagged: 30, unwrapped: 50 })
      s.type('Papers in an unwrapped bundle', '40')
      expect(s.saved()?.papersEach).toEqual({ bagged: 30, unwrapped: 40 })
    })
  })

  describe('removing a line', () => {
    /** The sheet as if on a page: `settle` draws it, with its buttons able to take the focus, and runs what React runs once it is drawn. `focused` is each button that took it. */
    function onPage(start: LoadList = DEFAULT_LOAD) {
      vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
      const s = sheet(start)
      const focused: string[] = []
      const button = (el: El) => ({
        focus: () => {
          if (!el.props?.disabled) focused.push(String(el.props?.['aria-label'] ?? words(el)))
        },
      })
      const settle = () => {
        hooks.effects = []
        const tree = s.render()
        const buttons = find(tree, (n) => n.type === 'button')
        const box = { querySelectorAll: (selector: string) => buttons.filter((b) => `.${b.props?.className}` === selector).map(button) }
        const put = (ref: unknown, on: unknown) => ((ref as { current: unknown }).current = on)
        put((tree as El).props?.ref, box)
        const add = s.addLineButton()
        put(add.props?.ref, button(add))
        for (const run of hooks.effects) run()
      }
      return { ...s, focused, settle }
    }

    it('hands the focus to the remove button of the line that takes its place', () => {
      const s = onPage()
      s.tap('Remove line 1')
      s.settle()
      expect(s.focused).toEqual(['Remove line 1'])
      expect(s.field('Line 1, how many bundles')).toBe('18')
    })

    it('hands it on from a line part way down', () => {
      const s = onPage()
      s.tap('Remove line 2')
      s.settle()
      expect(s.focused).toEqual(['Remove line 2'])
      expect(s.field('Line 2, how many bundles')).toBe('13')
    })

    it('hands it to Add line when no line comes after it', () => {
      const s = onPage()
      s.tap('Remove line 3')
      s.settle()
      expect(s.focused).toEqual(['Add line'])
    })

    it('hands it to Add line when no line is left', () => {
      const s = onPage(list(line('a', 1, 'bagged')))
      s.tap('Remove line 1')
      s.settle()
      expect(s.focused).toEqual(['Add line'])
    })

    it('hands it to Add line from a full list, where that button has only now come back', () => {
      const s = onPage(list(...Array.from({ length: MAX_LOAD_LINES }, (_, i) => line(`l${i}`, 1, 'bagged'))))
      expect(s.addLineButton().props?.disabled).toBe(true)
      s.tap(`Remove line ${MAX_LOAD_LINES}`)
      s.settle()
      expect(s.focused).toEqual(['Add line'])
    })

    it('hands it on the same way each time, down to the last line', () => {
      const s = onPage()
      s.tap('Remove line 1')
      s.settle()
      s.tap('Remove line 1')
      s.settle()
      s.tap('Remove line 1')
      s.settle()
      expect(s.focused).toEqual(['Remove line 1', 'Remove line 1', 'Add line'])
    })

    it('hands it on once, and leaves it where it is as the sheet carries on', () => {
      const s = onPage()
      s.tap('Remove line 1')
      s.settle()
      s.settle()
      s.type('Line 1, how many bundles', '20')
      s.settle()
      expect(s.focused).toEqual(['Remove line 1'])
    })

    it('leaves the focus alone for any other change', () => {
      const s = onPage()
      s.type('Line 1, how many bundles', '20')
      s.settle()
      s.type('Line 1, note', 'Boot')
      s.settle()
      s.typePapers('Bagged', '30')
      s.settle()
      fire(s.addLineButton(), 'onClick')
      s.settle()
      expect(s.focused).toEqual([])
    })
  })

  describe('closing it', () => {
    it('closes with Done', () => {
      const s = sheet()
      const done = find(s.render(), (n) => n.type === 'button' && words(n) === 'Done')[0]
      fire(done, 'onClick')
      expect(s.closes.count).toBe(1)
    })

    it('closes with a tap on the dimmed part, and a tap on the sheet stays in it', () => {
      const s = sheet()
      const tree = s.render() as El
      expect(tree.props?.className).toBe('load-scrim')
      fire(tree, 'onClick')
      expect(s.closes.count).toBe(1)
      const stop = vi.fn()
      fire(find(tree, (n) => n.props?.className === 'load-sheet')[0], 'onClick', { stopPropagation: stop })
      expect(stop).toHaveBeenCalledOnce()
    })

    it('closes with Escape, and leaves off listening when it has gone', () => {
      const listeners = new Map<string, (e: { key: string }) => void>()
      vi.stubGlobal('window', { addEventListener: (t: string, f: (e: { key: string }) => void) => listeners.set(t, f), removeEventListener: (t: string) => listeners.delete(t), visualViewport: undefined })
      const s = sheet()
      s.render()
      const stops = hooks.effects.map((run) => run())
      listeners.get('keydown')?.({ key: 'a' })
      expect(s.closes.count).toBe(0)
      listeners.get('keydown')?.({ key: 'Escape' })
      expect(s.closes.count).toBe(1)
      for (const stop of stops) stop?.()
      expect(listeners.size).toBe(0)
    })
  })

  describe('staying above the keyboard', () => {
    /** The sheet up on a phone whose keyboard can be brought up and put away, with the dimmed part it moves. */
    function phone() {
      const on = new Map<string, () => void>()
      const view = {
        height: 800,
        offsetTop: 0,
        addEventListener: (t: string, f: () => void) => on.set(t, f),
        removeEventListener: (t: string) => on.delete(t),
      }
      vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined, visualViewport: view })
      const s = sheet()
      const box = { style: { height: '', transform: '' } }
      const ref = (s.render() as El).props?.ref as { current: unknown }
      ref.current = box
      const stops = hooks.effects.map((run) => run())
      return { on, view, box, stops }
    }

    it('fills the screen to begin with', () => {
      expect(phone().box.style).toEqual({ height: '800px', transform: 'translateY(0px)' })
    })

    it('shrinks to what the keyboard leaves, and grows again when it goes', () => {
      const { on, view, box } = phone()
      view.height = 440
      on.get('resize')?.()
      expect(box.style.height).toBe('440px')
      view.height = 800
      on.get('resize')?.()
      expect(box.style.height).toBe('800px')
    })

    it('goes with the page when the phone slides it up', () => {
      const { on, view, box } = phone()
      view.offsetTop = 120
      on.get('scroll')?.()
      expect(box.style.transform).toBe('translateY(120px)')
    })

    it('leaves off when it has gone', () => {
      const { on, stops } = phone()
      for (const stop of stops) stop?.()
      expect(on.size).toBe(0)
    })

    it('does nothing on a browser that cannot tell', () => {
      vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
      const s = sheet()
      s.render()
      expect(() => hooks.effects.map((run) => run())).not.toThrow()
    })
  })
})

describe('the card and its sheet together', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { body: {} })
  })

  /** The card on a route: what `render` draws is the card as it is now, with the sheet in it when it is up. */
  function together(load?: LoadList) {
    const state = { load, calls: [] as LoadList[] }
    hooks.slots = []
    const render = (): unknown => {
      hooks.at = 0
      return LoadCard({
        load: state.load,
        onLoad: (next) => {
          state.calls.push(next)
          state.load = next
        },
      })
    }
    return { state, render }
  }
  const isSheet = (n: El) => n.type === LoadSheet
  const edit = (tree: unknown) => fire(labelled(tree, 'Edit papers to load'), 'onClick')

  it('opens the sheet on Edit with the list that is showing', () => {
    const { render } = together()
    expect(find(render(), isSheet)).toHaveLength(0)
    edit(render())
    const [up] = find(render(), isSheet)
    expect(up.props?.list).toBe(DEFAULT_LOAD)
  })

  it('opens it on the route\'s own list when it has one', () => {
    const own = list(line('a', 4, 'bagged'))
    const { render } = together(own)
    edit(render())
    expect(find(render(), isSheet)[0].props?.list).toBe(own)
  })

  it('passes a change on as it is made', () => {
    const { render, state } = together()
    edit(render())
    const next = list(line('a', 1, 'bagged'))
    fire(find(render(), isSheet)[0], 'onChange', next)
    expect(state.calls).toEqual([next])
  })

  it('closes the sheet again', () => {
    const { render } = together()
    edit(render())
    fire(find(render(), isSheet)[0], 'onClose')
    expect(find(render(), isSheet)).toHaveLength(0)
  })
})

describe('how it is styled', () => {
  it('gives every control a target of 48 px', () => {
    expect(px(css, '.hero .load-card .load-edit', 'min-height')).toBe(48)
    expect(px(css, '.load-sheet-head .btn', 'min-height')).toBe(48)
    expect(px(css, '.load-line .field-input', 'min-height')).toBe(48)
    expect(px(css, '.load-line .segmented button', 'min-height')).toBe(48)
    expect(px(css, '.load-remove', 'width')).toBe(48)
    expect(px(css, '.load-remove', 'height')).toBe(48)
    // Add line and the papers in a bundle use the app's own: a block button, and a field row.
    expect(px(indexCss, '.btn', 'min-height')).toBeGreaterThanOrEqual(48)
    expect(px(indexCss, '.row', 'min-height')).toBeGreaterThanOrEqual(48)
  })

  it('has type big enough for an iPhone not to zoom in on a field', () => {
    expect(px(indexCss, '.field-input', 'font-size')).toBeGreaterThanOrEqual(16)
    expect(px(indexCss, '.row.field input', 'font-size')).toBeGreaterThanOrEqual(16)
  })

  it('takes back the space a button on the start screen has above it', () => {
    expect(declared(indexCss, '.hero .btn', 'margin-top')).toBe('12px')
    expect(declared(css, '.hero .load-card .load-edit', 'margin-top')).toBe('0')
  })

  it('covers the whole screen from wherever the page is, and sits over the tab bar', () => {
    expect(declared(css, '.load-scrim', 'position')).toBe('fixed')
    expect(px(css, '.load-scrim', 'z-index')).toBeGreaterThan(px(indexCss, '.tabbar', 'z-index'))
  })

  it('scrolls the lines inside the sheet, with the head and its Done left in view', () => {
    expect(declared(css, '.load-sheet-head', 'flex')).toBe('none')
    expect(declared(css, '.load-sheet-scroll', 'overflow-y')).toBe('auto')
    expect(declared(css, '.load-sheet-scroll', 'min-height')).toBe('0')
    expect(declared(css, '.load-sheet', 'max-height')).toContain('100%')
  })

  it('fits a line on a phone 320 px wide', () => {
    const narrow = /@media \(max-width: 350px\) \{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? ''
    const sheetPadding = 12 * 2
    const linePadding = 10 * 2
    const gap = px(narrow, '.load-line-row', 'gap')
    const number = px(narrow, '.load-bundles', 'width')
    const room = 320 - sheetPadding - linePadding - number - gap
    // The two kinds share what is left equally, inside the 2 px edge of the track. "Unwrapped" is about 72 px wide in the system font at 14 px.
    const each = (room - 4) / 2
    const sidePadding = Number.parseInt(declared(css, '.load-line .segmented button', 'padding')?.split(' ')[1] ?? '', 10)
    expect(sidePadding).toBeGreaterThan(0)
    expect(each - sidePadding * 2).toBeGreaterThanOrEqual(72)
    expect(declared(css, '.load-line .segmented', 'min-width')).toBe('0')
    expect(declared(css, '.load-note', 'min-width')).toBe('0')
    expect(declared(css, '.load-text', 'min-width')).toBe('0')
    expect(declared(css, '.load-text', 'overflow-wrap')).toBe('anywhere')
  })

  it('stops a long figure pushing a row off the screen', () => {
    expect(declared(css, '.load-line-papers', 'overflow-wrap')).toBe('anywhere')
    expect(declared(css, '.load-sheet-whole', 'overflow-wrap')).toBe('anywhere')
    expect(declared(css, '.load-row.whole', 'overflow-wrap')).toBe('anywhere')
  })
})
