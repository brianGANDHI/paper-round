import { describe, expect, it } from 'vitest'
import {
  activeRoute,
  adjustActiveRoute,
  addImported,
  addRoute,
  cleanName,
  createLibrary,
  deleteRoute,
  duplicateRoute,
  editActiveRoute,
  importClashes,
  keepCopy,
  labelledName,
  MAX_NAME,
  MAX_STREET_NAME,
  MAX_STREETS,
  normalizeLibrary,
  normalizeStreets,
  renameRoute,
  sameName,
  selectRoute,
  setActiveRound,
  setActiveSections,
  setActiveStreets,
  setBundleOrder,
  setLoad,
  uniqueName,
} from './library'
import { DEFAULT_LOAD, loadOf } from './load'
import type { Library, LoadList, NamedSection, RoundState, Route, Stop, TurnStreet } from './types'

const drawn = (n = 3): Route => ({
  points: Array.from({ length: n }, (_, i) => ({ lat: -33.87 + i * 0.001, lng: 151.2 })),
  sideChanges: [{ idx: 0, side: 'left' }],
  stops: [{ id: 'a', type: 'nothrow', lat: -33.869, lng: 151.2, pathIdx: 0, label: 'No. 14' }],
})

const names = (lib: Library) => lib.routes.map((r) => r.name)

describe('a copy kept beside a route', () => {
  it('puts the label after the name', () => {
    expect(labelledName(createLibrary(), 'Monday', 'old')).toBe('Monday (old)')
  })

  it('numbers the label, not the name, and ignores case', () => {
    let lib = addRoute(createLibrary(), 'monday (OLD)')
    expect(labelledName(lib, 'Monday', 'old')).toBe('Monday (old 2)')
    lib = addRoute(lib, 'Monday (old 2)')
    expect(labelledName(lib, 'Monday', 'old')).toBe('Monday (old 3)')
  })

  it('cuts a long name short, and never the label', () => {
    const long = 'x'.repeat(MAX_NAME)
    const name = labelledName(createLibrary(), long, 'old')
    expect(name).toHaveLength(MAX_NAME)
    expect(name.endsWith(' (old)')).toBe(true)
    const lib = addRoute(createLibrary(), name)
    const next = labelledName(lib, long, 'old')
    expect(next).toHaveLength(MAX_NAME)
    expect(next.endsWith(' (old 2)')).toBe(true)
  })

  it('never leaves half of an emoji where a long name was cut', () => {
    const name = labelledName(createLibrary(), `${'x'.repeat(MAX_NAME - 7)}😀😀`, 'old')
    expect(name).toBe(`${'x'.repeat(MAX_NAME - 7)} (old)`)
  })

  it('keeps a copy without switching to it', () => {
    const lib = addRoute(createLibrary(), 'Monday', drawn())
    const source = activeRoute(lib)
    const { library, copy } = keepCopy(lib, source, 'Monday kept', 5)
    expect(library.activeId).toBe(source.id)
    expect(names(library)).toEqual(['My Round', 'Monday', 'Monday kept'])
    expect(copy).toEqual({ id: copy.id, name: 'Monday kept', route: source.route, round: { handledStopIds: [] }, updatedAt: 5 })
    expect(copy.id).not.toBe(source.id)
    expect(copy.route).not.toBe(source.route)
  })

  it('keeps the round the route had, as its own, where a duplicate starts one afresh', () => {
    const round: RoundState = { handledStopIds: ['a'], furthest: 300, startM: 20, dropped: ['a'], courtLegs: { a: 'out' } }
    const lib = setActiveRound(addRoute(createLibrary(), 'Monday', drawn()), round)
    const source = activeRoute(lib)
    const { copy } = keepCopy(lib, source, 'Monday kept', 5)
    expect(copy.round).toEqual(source.round)
    expect(copy.round).toMatchObject({ handledStopIds: ['a'], furthest: 300, startM: 20, dropped: ['a'] })
    expect(copy.round).not.toBe(source.round)
    expect(copy.round.handledStopIds).not.toBe(source.round.handledStopIds)
    expect(activeRoute(duplicateRoute(lib, source.id)).round).toEqual({ handledStopIds: [] })
  })
})

describe('a fresh library', () => {
  it('starts with one blank route that is in use', () => {
    const lib = createLibrary()
    expect(lib.routes).toHaveLength(1)
    expect(activeRoute(lib).route.points).toEqual([])
    expect(lib.activeId).toBe(lib.routes[0].id)
  })
})

describe('names', () => {
  it('trims, squashes spaces and caps the length', () => {
    expect(cleanName('  Monday   Round ')).toBe('Monday Round')
    expect(cleanName('x'.repeat(100))).toHaveLength(40)
  })

  it('never repeats a name, ignoring case', () => {
    let lib = addRoute(createLibrary(), 'Monday')
    expect(uniqueName(lib, 'monday')).toBe('monday 2')
    lib = addRoute(lib, 'Monday')
    lib = addRoute(lib, 'MONDAY')
    expect(names(lib)).toEqual(['My Round', 'Monday', 'Monday 2', 'MONDAY 3'])
  })

  it('keeps a long name within the limit when adding a number', () => {
    const long = 'y'.repeat(40)
    const lib = addRoute(createLibrary(), long)
    expect(uniqueName(lib, long)).toHaveLength(40)
    expect(uniqueName(lib, long).endsWith(' 2')).toBe(true)
  })
})

describe('working with routes', () => {
  it('adds a route and switches to it', () => {
    const lib = addRoute(createLibrary(), 'Saturday', drawn())
    expect(activeRoute(lib).name).toBe('Saturday')
    expect(lib.routes).toHaveLength(2)
  })

  it('switches between routes and ignores an unknown id', () => {
    const lib = addRoute(createLibrary(), 'Saturday')
    const first = lib.routes[0].id
    expect(activeRoute(selectRoute(lib, first)).name).toBe('My Round')
    expect(selectRoute(lib, 'nope')).toBe(lib)
  })

  it('renames without clashing, and ignores an empty name', () => {
    const lib = addRoute(createLibrary(), 'Saturday')
    const id = lib.routes[0].id
    expect(names(renameRoute(lib, id, 'Saturday'))).toEqual(['Saturday 2', 'Saturday'])
    expect(renameRoute(lib, id, '   ')).toBe(lib)
    expect(names(renameRoute(lib, lib.activeId, 'Saturday'))).toEqual(['My Round', 'Saturday'])
  })

  it('editing the route saves it and starts its round over', () => {
    let lib = addRoute(createLibrary(), 'Saturday', drawn())
    lib = setActiveRound(lib, { handledStopIds: ['a'] })
    expect(activeRoute(lib).round.handledStopIds).toEqual(['a'])
    lib = editActiveRoute(lib, drawn(4), 1234)
    const r = activeRoute(lib)
    expect(r.route.points).toHaveLength(4)
    expect(r.round.handledStopIds).toEqual([])
    expect(r.updatedAt).toBe(1234)
  })

  it('keeps how far the round got along with the stops done, until the route is edited', () => {
    let lib = addRoute(createLibrary(), 'Saturday', drawn())
    lib = setActiveRound(lib, { handledStopIds: ['a'], furthest: 300 })
    expect(activeRoute(lib).round).toEqual({ handledStopIds: ['a'], furthest: 300 })
    lib = editActiveRoute(lib, drawn(4), 1234)
    expect(activeRoute(lib).round).toEqual({ handledStopIds: [] })
  })

  it("progress belongs to its own route and isn't touched by another", () => {
    let lib = addRoute(createLibrary(), 'Saturday', drawn())
    lib = setActiveRound(lib, { handledStopIds: ['a'] })
    lib = selectRoute(lib, lib.routes[0].id)
    expect(activeRoute(lib).round.handledStopIds).toEqual([])
    lib = selectRoute(lib, lib.routes[1].id)
    expect(activeRoute(lib).round.handledStopIds).toEqual(['a'])
  })

  it('duplicates a route independently, switches to the copy, and starts it fresh', () => {
    let lib = addRoute(createLibrary(), 'Saturday', drawn())
    lib = setActiveRound(lib, { handledStopIds: ['a'] })
    const original = activeRoute(lib).id
    lib = duplicateRoute(lib, original)
    expect(names(lib)).toEqual(['My Round', 'Saturday', 'Saturday copy'])
    const copy = activeRoute(lib)
    expect(copy.id).not.toBe(original)
    expect(copy.round.handledStopIds).toEqual([])
    lib = editActiveRoute(lib, drawn(6))
    expect(lib.routes[1].route.points).toHaveLength(3)
    expect(lib.routes[2].route.points).toHaveLength(6)
  })
})

describe('deleting', () => {
  it('moves to a neighbour when the route in use is deleted', () => {
    let lib = createLibrary()
    lib = addRoute(lib, 'B')
    lib = addRoute(lib, 'C')
    lib = selectRoute(lib, lib.routes[1].id)
    const next = deleteRoute(lib, lib.routes[1].id)
    expect(names(next)).toEqual(['My Round', 'C'])
    expect(activeRoute(next).name).toBe('C')
  })

  it('falls back to the one before when the last route in the list is deleted', () => {
    const lib = addRoute(createLibrary(), 'B')
    const next = deleteRoute(lib, lib.activeId)
    expect(activeRoute(next).name).toBe('My Round')
  })

  it('keeps the same route in use when a different one is deleted', () => {
    const lib = addRoute(addRoute(createLibrary(), 'B'), 'C')
    const next = deleteRoute(lib, lib.routes[0].id)
    expect(activeRoute(next).name).toBe('C')
    expect(names(next)).toEqual(['B', 'C'])
  })

  it('leaves a blank route when the last one is deleted, never an empty library', () => {
    const lib = createLibrary()
    const next = deleteRoute(lib, lib.activeId)
    expect(next.routes).toHaveLength(1)
    expect(activeRoute(next).route.points).toEqual([])
    expect(next.routes[0].id).not.toBe(lib.routes[0].id)
  })
})

describe('adding from a backup', () => {
  const imported = [
    { name: 'Monday', route: drawn() },
    { name: '', route: drawn(2) },
  ]

  it('replaces the blank starter route instead of sitting beside it', () => {
    const lib = addImported(createLibrary(), imported)
    expect(names(lib)).toEqual(['Monday', 'Imported route'])
    expect(activeRoute(lib).name).toBe('Monday')
  })

  it('keeps a route you have drawn on, adds the new ones, and leaves the active route alone', () => {
    const start = addRoute(createLibrary(), 'Mine', drawn())
    const lib = addImported(start, imported)
    expect(names(lib)).toEqual(['My Round', 'Mine', 'Monday', 'Imported route'])
    expect(activeRoute(lib).name).toBe('Mine')
  })

  it('never overwrites a route with the same name', () => {
    const start = addRoute(createLibrary(), 'Monday', drawn(5))
    const lib = addImported(start, [{ name: 'Monday', route: drawn() }])
    expect(names(lib)).toContain('Monday 2')
    expect(lib.routes.find((r) => r.name === 'Monday')?.route.points).toHaveLength(5)
  })

  it('does nothing for an empty backup', () => {
    const lib = createLibrary()
    expect(addImported(lib, [])).toBe(lib)
  })
})

describe('normalizeLibrary', () => {
  it('repairs damaged saved data', () => {
    const lib = normalizeLibrary({
      routes: [
        { id: 'x', name: '  Fine ', route: drawn(), round: { handledStopIds: ['a', 7, null] }, updatedAt: 5 },
        { id: 'x', name: 5, route: null, round: null, updatedAt: 'later' },
        'junk',
      ],
      activeId: 'gone',
    })!
    expect(lib.routes).toHaveLength(2)
    expect(lib.routes[0].name).toBe('Fine')
    expect(lib.routes[0].round.handledStopIds).toEqual(['a'])
    expect(lib.routes[1].id).not.toBe('x')
    expect(lib.routes[1].name).toBe('My Round')
    expect(lib.routes[1].updatedAt).toBe(0)
    expect(lib.activeId).toBe('x')
  })

  it('keeps how far a round got when that is a sensible number, and drops it when it is not', () => {
    const lib = (furthest: unknown) =>
      normalizeLibrary({ routes: [{ id: 'x', name: 'A', route: drawn(), round: { handledStopIds: [], furthest }, updatedAt: 0 }] })!.routes[0].round
    expect(lib(450)).toEqual({ handledStopIds: [], furthest: 450 })
    for (const junk of [0, -10, NaN, Infinity, '300', null, undefined, {}]) expect(lib(junk), String(junk)).toEqual({ handledStopIds: [] })
  })

  it('returns null when there is nothing usable', () => {
    expect(normalizeLibrary(null)).toBeNull()
    expect(normalizeLibrary({ routes: [] })).toBeNull()
    expect(normalizeLibrary({ routes: ['junk'] })).toBeNull()
    expect(normalizeLibrary('text')).toBeNull()
  })
})

describe('restoring a route that has the name of one already here', () => {
  const withMondayAndTuesday = () => {
    let lib = addRoute(createLibrary(), 'Monday', drawn(3))
    lib = addRoute(lib, 'Tuesday', drawn(4))
    return lib
  }
  const idOf = (lib: Library, name: string) => lib.routes.find((r) => r.name === name)!.id

  it('treats names as the same whatever the case or spacing', () => {
    expect(sameName('Monday', ' monday ')).toBe(true)
    expect(sameName('Monday  Round', 'monday round')).toBe(true)
    expect(sameName('Monday', 'Monday 2')).toBe(false)
  })

  it('names the routes here that the backup would collide with', () => {
    const lib = withMondayAndTuesday()
    expect(importClashes(lib, [{ name: 'monday' }, { name: 'Friday' }])).toEqual(['Monday'])
    expect(importClashes(lib, [{ name: 'Friday' }])).toEqual([])
    expect(importClashes(lib, [{ name: 'Monday' }, { name: 'TUESDAY' }])).toEqual(['Monday', 'Tuesday'])
  })

  it('collides with nothing on a fresh install, whose blank route is replaced anyway', () => {
    expect(importClashes(createLibrary(), [{ name: 'My Round' }])).toEqual([])
  })

  it('keeps both by default, with the new one under a new name', () => {
    const lib = addImported(withMondayAndTuesday(), [{ name: 'Monday', route: drawn(9) }], 1)
    expect(names(lib)).toEqual(['My Round', 'Monday', 'Tuesday', 'Monday 2'])
    expect(addImported(withMondayAndTuesday(), [{ name: 'Monday', route: drawn(9) }], 1, 'keep').routes).toHaveLength(4)
  })

  it('can replace the route of that name instead, keeping its place, name and standing', () => {
    let lib = withMondayAndTuesday()
    const monday = idOf(lib, 'Monday')
    lib = setActiveRound({ ...lib, activeId: monday }, { handledStopIds: ['a'] })
    lib = { ...lib, activeId: idOf(lib, 'Tuesday') }
    const next = addImported(lib, [{ name: 'monday', route: drawn(7) }], 1234, 'replace')
    expect(names(next)).toEqual(['My Round', 'Monday', 'Tuesday'])
    const replaced = next.routes[1]
    expect(replaced.id).toBe(monday)
    expect(replaced.route.points).toHaveLength(7)
    // The progress belonged to the old route, so it starts over.
    expect(replaced.round.handledStopIds).toEqual([])
    expect(replaced.updatedAt).toBe(1234)
    expect(next.activeId).toBe(lib.activeId)
  })

  it('leaves the route in use in use when it is the one replaced', () => {
    const lib = withMondayAndTuesday()
    const active = lib.activeId
    const next = addImported(lib, [{ name: 'Tuesday', route: drawn(6) }], 1, 'replace')
    expect(next.activeId).toBe(active)
    expect(activeRoute(next).route.points).toHaveLength(6)
  })

  it('still adds the routes with no match, and leaves the others alone, when replacing', () => {
    const lib = withMondayAndTuesday()
    const next = addImported(lib, [{ name: 'Monday', route: drawn(7) }, { name: 'Friday', route: drawn(5) }], 1, 'replace')
    expect(names(next)).toEqual(['My Round', 'Monday', 'Tuesday', 'Friday'])
    expect(next.routes.find((r) => r.name === 'Tuesday')).toEqual(lib.routes.find((r) => r.name === 'Tuesday'))
  })

  it('replaces the blank starter route the same way in either mode', () => {
    for (const mode of ['keep', 'replace'] as const) {
      const lib = addImported(createLibrary(), [{ name: 'My Round', route: drawn(5) }], 1, mode)
      expect(names(lib)).toEqual(['My Round'])
      expect(activeRoute(lib).route.points).toHaveLength(5)
    }
  })
})

// Up the three points and back down two of them, over the same line: the stop in the middle is met twice.
const doubled = (): Route => ({
  points: [...drawn(3).points, ...drawn(3).points.slice(0, 2).reverse()],
  sideChanges: [{ idx: 0, side: 'left' }],
  stops: [{ id: 'a', type: 'nothrow', lat: -33.869, lng: 151.2, pathIdx: 0, label: 'No. 14' }],
})

const named = (id: string, extra: Partial<NamedSection> = {}): NamedSection => ({ id, name: `Part ${id}`, lat: -33.869, lng: 151.2, ...extra })
const street = (name: string, extra: Partial<TurnStreet> = {}): TurnStreet => ({ lat: -33.869, lng: 151.2, out: 90, name, ...extra })

describe('adjusting the route in use', () => {
  const started = () => {
    let lib = addRoute(createLibrary(), 'Saturday', doubled())
    lib = setActiveRound(lib, { handledStopIds: ['a'], furthest: 300, startM: 120 })
    return lib
  }

  it('saves the route and keeps the round going, where editing it starts over', () => {
    const lib = started()
    const adjusted = adjustActiveRoute(lib, { ...doubled(), sideChanges: [{ idx: 0, side: 'right' }] }, 777)
    const r = activeRoute(adjusted)
    expect(r.route.sideChanges).toEqual([{ idx: 0, side: 'right' }])
    expect(r.round).toEqual({ handledStopIds: ['a'], furthest: 300, startM: 120 })
    expect(r.updatedAt).toBe(777)
    expect(activeRoute(editActiveRoute(lib, doubled(), 777)).round).toEqual({ handledStopIds: [] })
  })

  it('keeps the key of every pass of a stop that is still met, and forgets those that are not', () => {
    let lib = addRoute(createLibrary(), 'Saturday', doubled())
    lib = setActiveRound(lib, { handledStopIds: ['a', 'a#2', 'a#3', 'gone', 'gone#2', 'a2'] })
    expect(activeRoute(adjustActiveRoute(lib, doubled(), 1)).round.handledStopIds).toEqual(['a', 'a#2'])
  })

  it('forgets the second pass of a stop once the route no longer goes by it twice', () => {
    let lib = addRoute(createLibrary(), 'Saturday', doubled())
    lib = setActiveRound(lib, { handledStopIds: ['a', 'a#2'] })
    expect(activeRoute(adjustActiveRoute(lib, drawn(), 1)).round.handledStopIds).toEqual(['a'])
  })

  it('forgets a stop that has been taken off the route', () => {
    let lib = addRoute(createLibrary(), 'Saturday', doubled())
    lib = setActiveRound(lib, { handledStopIds: ['a', 'a#2'], furthest: 200 })
    const without = adjustActiveRoute(lib, { ...doubled(), stops: [] }, 1)
    expect(activeRoute(without).round).toEqual({ handledStopIds: [], furthest: 200 })
  })

  it('keeps the order of the stops done', () => {
    const route: Route = {
      ...doubled(),
      stops: [
        { id: 'b', type: 'bundle', lat: -33.8695, lng: 151.2, pathIdx: 0 },
        { id: 'a', type: 'nothrow', lat: -33.869, lng: 151.2, pathIdx: 0 },
      ],
    }
    let lib = addRoute(createLibrary(), 'Saturday', route)
    lib = setActiveRound(lib, { handledStopIds: ['a#2', 'b', 'a'] })
    expect(activeRoute(adjustActiveRoute(lib, route, 1)).round.handledStopIds).toEqual(['a#2', 'b', 'a'])
  })

  it('forgets every stop done, and keeps the place, for a route with no points left', () => {
    const lib = started()
    const empty = adjustActiveRoute(lib, { points: [], sideChanges: [], stops: [] }, 1)
    expect(activeRoute(empty).round).toEqual({ handledStopIds: [], furthest: 300, startM: 120 })
  })

  it('leaves the other routes, the name and the sections and street names alone', () => {
    let lib = addRoute(createLibrary(), 'Saturday', doubled())
    lib = setActiveSections(setActiveStreets(lib, [street('Oak Road')]), [named('s1')])
    lib = setActiveRound(lib, { handledStopIds: ['a'] })
    const before = lib.routes[0]
    const adjusted = adjustActiveRoute(lib, drawn(5), 9)
    expect(adjusted.routes[0]).toBe(before)
    expect(adjusted.activeId).toBe(lib.activeId)
    const r = activeRoute(adjusted)
    expect(r.name).toBe('Saturday')
    expect(r.id).toBe(activeRoute(lib).id)
    expect(r.sections).toEqual([named('s1')])
    expect(r.streets).toEqual([street('Oak Road')])
  })

  it('uses the time now when none is given', () => {
    const adjusted = adjustActiveRoute(started(), doubled())
    expect(activeRoute(adjusted).updatedAt).toBeGreaterThan(1_600_000_000_000)
  })

  it('does not change the library it is given', () => {
    const lib = started()
    const copy = structuredClone(lib)
    adjustActiveRoute(lib, drawn(), 5)
    expect(lib).toEqual(copy)
  })
})

describe('naming parts of the route and its streets', () => {
  const ready = () => {
    let lib = addRoute(createLibrary(), 'Saturday', drawn())
    lib = setActiveRound(lib, { handledStopIds: ['a'], furthest: 50, startM: 10 })
    return lib
  }

  it('gives the route in use its named sections, and changes nothing else about it', () => {
    const lib = ready()
    const before = activeRoute(lib)
    const next = setActiveSections(lib, [named('s1'), named('s2', { pass: 2 })])
    const r = activeRoute(next)
    expect(r.sections).toEqual([named('s1'), named('s2', { pass: 2 })])
    expect(r.route).toBe(before.route)
    expect(r.round).toBe(before.round)
    expect(r.updatedAt).toBe(before.updatedAt)
    expect(r.name).toBe(before.name)
  })

  it('gives the route in use its street names, and changes nothing else about it', () => {
    const lib = ready()
    const before = activeRoute(lib)
    const r = activeRoute(setActiveStreets(lib, [street('Oak Road'), street('')]))
    expect(r.streets).toEqual([street('Oak Road'), street('')])
    expect(r.route).toBe(before.route)
    expect(r.round).toBe(before.round)
    expect(r.updatedAt).toBe(before.updatedAt)
  })

  it('takes the key off the route when given none, rather than keeping an empty list', () => {
    let lib = setActiveStreets(setActiveSections(ready(), [named('s1')]), [street('Oak Road')])
    lib = setActiveSections(lib, [])
    expect('sections' in activeRoute(lib)).toBe(false)
    expect(activeRoute(lib).streets).toHaveLength(1)
    lib = setActiveStreets(lib, [])
    expect('streets' in activeRoute(lib)).toBe(false)
  })

  it('leaves the street names when the sections are set, and the sections when the streets are', () => {
    let lib = setActiveSections(ready(), [named('s1')])
    lib = setActiveStreets(lib, [street('Oak Road')])
    expect(activeRoute(lib).sections).toEqual([named('s1')])
    lib = setActiveSections(lib, [named('s2')])
    expect(activeRoute(lib).streets).toEqual([street('Oak Road')])
  })

  it('only changes the route in use', () => {
    let lib = addRoute(ready(), 'Sunday', drawn())
    lib = selectRoute(lib, lib.routes[1].id)
    const next = setActiveSections(setActiveStreets(lib, [street('Elm')]), [named('s1')])
    for (const i of [0, 2]) expect(next.routes[i]).toBe(lib.routes[i])
    expect(next.routes[1].sections).toHaveLength(1)
  })

  it('keeps its own copy of the list it is given', () => {
    const list = [named('s1')]
    const lib = setActiveSections(ready(), list)
    list.push(named('s2'))
    expect(activeRoute(lib).sections).toHaveLength(1)
    const streets = [street('Oak')]
    const withStreets = setActiveStreets(ready(), streets)
    streets.pop()
    expect(activeRoute(withStreets).streets).toHaveLength(1)
  })

  it('does nothing when the route in use is not there, as for the other changes', () => {
    const lib = { ...ready(), activeId: 'gone' }
    expect(setActiveSections(lib, [named('s1')]).routes).toEqual(lib.routes)
    expect(setActiveStreets(lib, [street('Oak')]).routes).toEqual(lib.routes)
  })

  it('is kept by the edits that keep the rest of the route in use: renaming and selecting, and by adjusting', () => {
    let lib = setActiveSections(ready(), [named('s1')])
    lib = renameRoute(lib, lib.activeId, 'Sunday')
    lib = setActiveRound(lib, { handledStopIds: [] })
    expect(activeRoute(lib).sections).toEqual([named('s1')])
    expect(activeRoute(editActiveRoute(lib, drawn(4), 5)).sections).toEqual([named('s1')])
  })
})

describe('copying a route with its sections and street names', () => {
  it('copies them, independently of the original', () => {
    let lib = addRoute(createLibrary(), 'Saturday', drawn())
    lib = setActiveStreets(setActiveSections(lib, [named('s1')]), [street('Oak Road')])
    const original = activeRoute(lib).id
    lib = duplicateRoute(lib, original)
    const copy = activeRoute(lib)
    expect(copy.id).not.toBe(original)
    expect(copy.sections).toEqual([named('s1')])
    expect(copy.streets).toEqual([street('Oak Road')])
    lib = setActiveSections(lib, [named('other')])
    expect(lib.routes.find((r) => r.id === original)!.sections).toEqual([named('s1')])
    const again = lib.routes.find((r) => r.id === original)!
    expect(again.sections![0]).not.toBe(copy.sections![0])
    expect(again.streets![0]).not.toBe(copy.streets![0])
  })

  it('has no keys for a route that has none, and still starts its round fresh', () => {
    let lib = addRoute(createLibrary(), 'Saturday', drawn())
    lib = setActiveRound(lib, { handledStopIds: ['a'], furthest: 40, startM: 20 })
    lib = duplicateRoute(lib, lib.activeId)
    const copy = activeRoute(lib)
    expect('sections' in copy).toBe(false)
    expect('streets' in copy).toBe(false)
    expect(copy.round).toEqual({ handledStopIds: [] })
  })

  it('does not copy an empty list', () => {
    let lib = addRoute(createLibrary(), 'Saturday', drawn())
    lib = { ...lib, routes: lib.routes.map((r) => (r.id === lib.activeId ? { ...r, sections: [], streets: [] } : r)) }
    const copy = activeRoute(duplicateRoute(lib, lib.activeId))
    expect('sections' in copy).toBe(false)
    expect('streets' in copy).toBe(false)
  })
})

describe('adding from a backup with sections and street names', () => {
  const sections = [named('s1'), named('s2', { pass: 2 })]
  const streets = [street('Oak Road'), street('')]

  it('adds a route with both, and one without either as before', () => {
    const lib = addImported(createLibrary(), [
      { name: 'Monday', route: drawn(), sections, streets },
      { name: 'Tuesday', route: drawn() },
      { name: 'Friday', route: drawn(), sections: [], streets: [] },
    ])
    const [monday, tuesday, friday] = lib.routes
    expect(monday.sections).toEqual(sections)
    expect(monday.streets).toEqual(streets)
    for (const r of [tuesday, friday]) {
      expect('sections' in r, r.name).toBe(false)
      expect('streets' in r, r.name).toBe(false)
    }
  })

  it('adds one beside a route already here, and keeps both', () => {
    const start = addRoute(createLibrary(), 'Mine', drawn())
    const lib = addImported(start, [{ name: 'Monday', route: drawn(), sections }])
    expect(lib.routes.at(-1)!.sections).toEqual(sections)
    expect('sections' in lib.routes[1]).toBe(false)
  })

  describe('over a route of the same name', () => {
    const here = () => {
      let lib = addRoute(createLibrary(), 'Monday', drawn(3))
      lib = setActiveStreets(setActiveSections(lib, [named('mine')]), [street('My Road')])
      lib = setActiveRound(lib, { handledStopIds: ['a'], furthest: 100, startM: 50 })
      return lib
    }
    const monday = (lib: Library) => lib.routes.find((r) => r.name === 'Monday')!

    it('takes the ones in the backup, starting the round over', () => {
      const lib = addImported(here(), [{ name: 'monday', route: drawn(5), sections, streets }], 9, 'replace')
      expect(monday(lib).sections).toEqual(sections)
      expect(monday(lib).streets).toEqual(streets)
      expect(monday(lib).route.points).toHaveLength(5)
      expect(monday(lib).round).toEqual({ handledStopIds: [] })
      expect(monday(lib).updatedAt).toBe(9)
    })

    it('keeps its own when the backup has none, as one made before they existed has none', () => {
      const lib = addImported(here(), [{ name: 'Monday', route: drawn(5) }], 9, 'replace')
      expect(monday(lib).sections).toEqual([named('mine')])
      expect(monday(lib).streets).toEqual([street('My Road')])
      expect(monday(lib).route.points).toHaveLength(5)
    })

    it('takes only the one the backup has', () => {
      const lib = addImported(here(), [{ name: 'Monday', route: drawn(5), sections }], 9, 'replace')
      expect(monday(lib).sections).toEqual(sections)
      expect(monday(lib).streets).toEqual([street('My Road')])
    })

    it('clears the ones here when the backup says it has none', () => {
      const lib = addImported(here(), [{ name: 'Monday', route: drawn(5), sections: [], streets: [] }], 9, 'replace')
      expect('sections' in monday(lib)).toBe(false)
      expect('streets' in monday(lib)).toBe(false)
    })

    it('adds the backup as a new route in keep mode, leaving the one here with its own', () => {
      const lib = addImported(here(), [{ name: 'Monday', route: drawn(5), sections }], 9, 'keep')
      expect(monday(lib).sections).toEqual([named('mine')])
      expect(lib.routes.find((r) => r.name === 'Monday 2')!.sections).toEqual(sections)
    })
  })

  it('replaces the blank starter with a route that has them', () => {
    const lib = addImported(createLibrary(), [{ name: 'Monday', route: drawn(), sections, streets }])
    expect(lib.routes).toHaveLength(1)
    expect(activeRoute(lib).sections).toEqual(sections)
    expect(activeRoute(lib).streets).toEqual(streets)
  })
})

describe('what is kept when saved data is read back', () => {
  const read = (route: Record<string, unknown>) => normalizeLibrary({ routes: [{ id: 'x', name: 'A', route: drawn(), round: { handledStopIds: [] }, updatedAt: 0, ...route }] })!.routes[0]

  it('keeps the sections and street names that are good', () => {
    const r = read({ sections: [named('s1'), named('s2', { pass: 3 })], streets: [street('Oak Road'), street('')] })
    expect(r.sections).toEqual([named('s1'), named('s2', { pass: 3 })])
    expect(r.streets).toEqual([street('Oak Road'), street('')])
  })

  it('has no keys when there are none, or only junk, or they are not lists', () => {
    for (const junk of [undefined, null, [], 'x', 7, {}, [null, 3, 'x'], [{ id: 'a' }]]) {
      const r = read({ sections: junk, streets: junk })
      expect('sections' in r, JSON.stringify(junk)).toBe(false)
      expect('streets' in r, JSON.stringify(junk)).toBe(false)
    }
  })

  it('cleans the sections and street names it keeps, and drops the bad ones among them', () => {
    const r = read({
      sections: [named('s1', { name: '  Oak   Estate ' }), { id: 's2', name: '   ', lat: 1, lng: 1 }, named('s1')],
      streets: [street('  Oak   Road '), street('Bad', { out: 360 }), street('Bad', { lat: 99 })],
    })
    expect(r.sections).toHaveLength(2)
    expect(r.sections![0].name).toBe('Oak Estate')
    expect(r.sections![1].id).not.toBe('s1')
    expect(r.streets).toEqual([street('Oak Road')])
  })

  it('keeps where a round was started when that is a number from 0, and drops it otherwise', () => {
    const startM = (v: unknown) => read({ round: { handledStopIds: [], startM: v } }).round
    expect(startM(0)).toEqual({ handledStopIds: [], startM: 0 })
    expect(startM(0.5)).toEqual({ handledStopIds: [], startM: 0.5 })
    expect(startM(1234.5)).toEqual({ handledStopIds: [], startM: 1234.5 })
    for (const junk of [-0.001, -10, NaN, Infinity, -Infinity, '300', null, undefined, {}, [], true]) expect(startM(junk), String(junk)).toEqual({ handledStopIds: [] })
  })

  it('keeps how far it got and where it was started together', () => {
    const r = read({ round: { handledStopIds: ['a'], furthest: 450, startM: 120 } })
    expect(r.round).toEqual({ handledStopIds: ['a'], furthest: 450, startM: 120 })
  })

  it('reads a library saved before sections existed just as it was', () => {
    const r = read({})
    expect(Object.keys(r).sort()).toEqual(['id', 'name', 'round', 'route', 'updatedAt'])
  })

  it('keeps no more than the limit of sections and of street names', () => {
    const sections = Array.from({ length: 250 }, (_, i) => named(`s${i}`))
    const streets = Array.from({ length: 5050 }, (_, i) => street(`Road ${i}`))
    const r = read({ sections, streets })
    expect(r.sections).toHaveLength(200)
    expect(r.streets).toHaveLength(5000)
  })

  it('is the same read twice', () => {
    const lib = { routes: [{ id: 'x', name: 'A', route: drawn(), round: { handledStopIds: ['a'], furthest: 30, startM: 5 }, updatedAt: 3, sections: [named('s1')], streets: [street('Oak')] }], activeId: 'x' }
    const once = normalizeLibrary(lib)!
    expect(normalizeLibrary(JSON.parse(JSON.stringify(once)))).toEqual(once)
    expect(once).toEqual(lib)
  })
})

describe('reading street names', () => {
  it('is none for anything that is not a list, and for an empty one', () => {
    for (const junk of [null, undefined, 0, 'x', true, {}, { 0: street('Oak') }, []]) expect(normalizeStreets(junk), String(junk)).toEqual([])
  })

  it('keeps good ones as they are, including one with no name', () => {
    const good = [street('Oak Road'), street('', { out: 0 }), street('Elm', { out: 359, lat: -90, lng: 180 }), street('Ash', { lat: 90, lng: -180 })]
    expect(normalizeStreets(good)).toEqual(good)
  })

  it('drops what is not an object', () => {
    for (const junk of [null, undefined, 5, 'x', true, [], [street('Oak')], () => 0]) expect(normalizeStreets([junk]), String(junk)).toEqual([])
    expect(normalizeStreets([null, street('Oak'), 'x'])).toEqual([street('Oak')])
  })

  it('drops a place that is missing, not a number, not finite or not on Earth', () => {
    const bad = [{ lat: undefined }, { lng: undefined }, { lat: '1' }, { lng: '1' }, { lat: NaN }, { lng: NaN }, { lat: Infinity }, { lng: -Infinity }, { lat: null }, { lat: 90.1 }, { lat: -90.1 }, { lng: 180.1 }, { lng: -180.1 }]
    for (const b of bad) expect(normalizeStreets([street('Oak', b as unknown as Partial<TurnStreet>)]), JSON.stringify(b)).toEqual([])
  })

  it('drops a way out that is not a whole number of degrees from 0 to 359', () => {
    for (const out of [-1, 360, 361, 720, 12.5, 0.1, 359.5, NaN, Infinity, -Infinity, '90', null, undefined, {}, [90]]) {
      expect(normalizeStreets([street('Oak', { out } as Partial<TurnStreet>)]), String(out)).toEqual([])
    }
    for (const out of [0, 1, 90, 180, 270, 359]) expect(normalizeStreets([street('Oak', { out })]), String(out)).toHaveLength(1)
  })

  it('drops a name that is not text, and keeps an empty one', () => {
    for (const name of [undefined, null, 5, {}, ['Oak'], true]) expect(normalizeStreets([street('x', { name } as unknown as Partial<TurnStreet>)]), String(name)).toEqual([])
    expect(normalizeStreets([street('')])).toEqual([street('')])
    expect(normalizeStreets([street('   ')])).toEqual([street('')])
  })

  it('tidies names and keeps them to 60 characters, without half an emoji', () => {
    expect(normalizeStreets([street('  Oak \n  Road ')])[0].name).toBe('Oak Road')
    expect(MAX_STREET_NAME).toBe(60)
    expect(normalizeStreets([street('x'.repeat(60))])[0].name).toBe('x'.repeat(60))
    expect(normalizeStreets([street('x'.repeat(61))])[0].name).toBe('x'.repeat(60))
    expect(normalizeStreets([street(`${'x'.repeat(59)}😀`)])[0].name).toBe('x'.repeat(59))
    expect(normalizeStreets([street(`${'x'.repeat(59)} y`)])[0].name).toBe('x'.repeat(59))
  })

  it('treats a name that shows nothing, such as zero-width spaces, as no name, and takes control characters out of one that does', () => {
    for (const name of ['​', '​​⁠', '﻿', '\0', '\u0007 ‍']) expect(normalizeStreets([street(name)]), JSON.stringify(name)).toEqual([street('')])
    expect(normalizeStreets([street('Oak\0Road')])[0].name).toBe('Oak Road')
    expect(normalizeStreets([street('Oak​Road')])[0].name).toBe('Oak​Road')
  })

  it('keeps no more than 5000, the first good ones, however much junk is mixed in', () => {
    const lots = Array.from({ length: 5020 }, (_, i) => street(`R${i}`, { out: i % 360 }))
    const read = normalizeStreets(lots)
    expect(MAX_STREETS).toBe(5000)
    expect(read).toHaveLength(5000)
    expect(read.map((s) => s.name)).toEqual(lots.slice(0, 5000).map((s) => s.name))
    expect(normalizeStreets([...Array.from({ length: 100 }, () => null), ...lots])).toHaveLength(5000)
    expect(normalizeStreets(lots.slice(0, 4999))).toHaveLength(4999)
    expect(normalizeStreets(lots.slice(0, 5000))).toHaveLength(5000)
    expect(normalizeStreets(lots.slice(0, 5001))).toHaveLength(5000)
  })

  it('keeps only the parts it knows, as new objects, and does not change what it is given', () => {
    const stored = { ...street('Oak'), evil: 1 }
    const copy = structuredClone([stored])
    const [read] = normalizeStreets([stored])
    expect(Object.keys(read).sort()).toEqual(['lat', 'lng', 'name', 'out'])
    expect(read).not.toBe(stored)
    expect([stored]).toEqual(copy)
  })
})

describe('the bundles dropped and missed in a round', () => {
  // The same route, with the stop a bundle drop: met on the way up and again on the way back, as 'a' and 'a#2'.
  const bundles = (): Route => ({ ...doubled(), stops: [{ id: 'a', type: 'bundle', lat: -33.869, lng: 151.2, pathIdx: 0, label: 'Co-op', qty: 12 }] })
  const started = (round: RoundState) => setActiveRound(addRoute(createLibrary(), 'Saturday', bundles()), round)
  const read = (round: unknown) => normalizeLibrary({ routes: [{ id: 'x', name: 'A', route: bundles(), round, updatedAt: 0 }] })!.routes[0].round

  describe('keeping them', () => {
    it('keeps what is dropped and missed with the round, beside the progress', () => {
      const round = { handledStopIds: ['a', 'a#2'], dropped: ['a'], missed: ['a#2'], furthest: 300, startM: 120 }
      expect(activeRoute(started(round)).round).toEqual(round)
    })

    it('has no keys for them when there are none, as a round saved before them has none', () => {
      const round = activeRoute(started({ handledStopIds: ['a'], furthest: 30, dropped: [], missed: [] })).round
      expect(round).toEqual({ handledStopIds: ['a'], furthest: 30 })
      expect('dropped' in round).toBe(false)
      expect('missed' in round).toBe(false)
    })

    it('forgets a bundle that is not among the stops done, and one that is in both lists is dropped', () => {
      const round = activeRoute(started({ handledStopIds: ['a'], dropped: ['a', 'a#2'], missed: ['a', 'zz'] })).round
      expect(round).toEqual({ handledStopIds: ['a'], dropped: ['a'] })
    })

    it('does not change the round it is given', () => {
      const given: RoundState = { handledStopIds: ['a'], dropped: ['a', 'a#2'] }
      const copy = structuredClone(given)
      started(given)
      expect(given).toEqual(copy)
    })

    it('goes with a route that is adjusted while driving, for the times through still met', () => {
      const lib = started({ handledStopIds: ['a', 'a#2'], dropped: ['a'], missed: ['a#2'], furthest: 200 })
      const same = activeRoute(adjustActiveRoute(lib, { ...bundles(), sideChanges: [{ idx: 0, side: 'right' }] }, 1)).round
      expect(same).toEqual({ handledStopIds: ['a', 'a#2'], dropped: ['a'], missed: ['a#2'], furthest: 200 })
    })

    it('keeps a stop dropped on one pass with its other pass done (which is what a drop leaves) through saving, adjusting and reading back', () => {
      const round = { handledStopIds: ['a', 'a#2'], dropped: ['a'], furthest: 200 }
      const lib = started(round)
      expect(activeRoute(lib).round).toEqual(round)
      expect(activeRoute(adjustActiveRoute(lib, { ...bundles(), sideChanges: [{ idx: 0, side: 'right' }] }, 1)).round).toEqual(round)
      expect(read(round)).toEqual(round)
    })

    it('forgets those for a time through the route no longer makes, or a stop taken off it', () => {
      const lib = started({ handledStopIds: ['a', 'a#2'], dropped: ['a'], missed: ['a#2'], furthest: 200 })
      const once = activeRoute(adjustActiveRoute(lib, { ...bundles(), points: drawn(3).points }, 1)).round
      expect(once).toEqual({ handledStopIds: ['a'], dropped: ['a'], furthest: 200 })
      const none = activeRoute(adjustActiveRoute(lib, { ...bundles(), stops: [] }, 1)).round
      expect(none).toEqual({ handledStopIds: [], furthest: 200 })
    })

    it('forgets them when the route is edited, which starts the round over', () => {
      const lib = started({ handledStopIds: ['a'], dropped: ['a'], missed: [] })
      expect(activeRoute(editActiveRoute(lib, bundles(), 5)).round).toEqual({ handledStopIds: [] })
    })

    it('does not carry them to a copy of the route, or over a route restored from a backup', () => {
      let lib = started({ handledStopIds: ['a'], dropped: ['a'], missed: [] })
      expect(activeRoute(duplicateRoute(lib, lib.activeId)).round).toEqual({ handledStopIds: [] })
      lib = addImported(lib, [{ name: 'Saturday', route: bundles() }], 9, 'replace')
      expect(activeRoute(lib).round).toEqual({ handledStopIds: [] })
    })
  })

  describe('reading them back', () => {
    it('keeps the ones that are good', () => {
      const round = { handledStopIds: ['a', 'a#2', 'b'], dropped: ['a'], missed: ['a#2'], furthest: 450, startM: 10 }
      expect(read(round)).toEqual(round)
    })

    it('reads a round saved before they existed just as it was', () => {
      expect(read({ handledStopIds: ['a', 'b'], furthest: 450 })).toEqual({ handledStopIds: ['a', 'b'], furthest: 450 })
      expect(read({ handledStopIds: [] })).toEqual({ handledStopIds: [] })
    })

    it('leaves out a list that is empty, or is junk', () => {
      for (const junk of [undefined, null, [], 'a', 7, {}, true, [7, null, {}]]) {
        const round = read({ handledStopIds: ['a'], dropped: junk, missed: junk })
        expect(round, JSON.stringify(junk)).toEqual({ handledStopIds: ['a'] })
        expect('dropped' in round, JSON.stringify(junk)).toBe(false)
        expect('missed' in round, JSON.stringify(junk)).toBe(false)
      }
    })

    it('drops what is not a key from a list, keeping the keys', () => {
      expect(read({ handledStopIds: ['a', 'b'], dropped: ['a', 7, null, 'b'], missed: [] })).toEqual({ handledStopIds: ['a', 'b'], dropped: ['a', 'b'] })
    })

    it('keeps only what is among the stops done, so neither list holds a stop that is not done', () => {
      const round = read({ handledStopIds: ['a'], dropped: ['a', 'b'], missed: ['c'] })
      expect(round).toEqual({ handledStopIds: ['a'], dropped: ['a'] })
    })

    it('keeps a bundle in the dropped list only, when it is in both', () => {
      expect(read({ handledStopIds: ['a', 'b'], dropped: ['a'], missed: ['a', 'b'] })).toEqual({ handledStopIds: ['a', 'b'], dropped: ['a'], missed: ['b'] })
    })

    it('keeps each key once', () => {
      expect(read({ handledStopIds: ['a', 'b'], dropped: ['a', 'a'], missed: ['b', 'b', 'b'] })).toEqual({ handledStopIds: ['a', 'b'], dropped: ['a'], missed: ['b'] })
    })

    it('reads the stops done as it did, ignoring a key that is not text, before judging the others', () => {
      expect(read({ handledStopIds: ['a', 7, null], dropped: ['a', 7], missed: [] })).toEqual({ handledStopIds: ['a'], dropped: ['a'] })
    })

    it('is the same read twice', () => {
      const once = read({ handledStopIds: ['a', 'b'], dropped: ['a', 'zz'], missed: ['a', 'b'], furthest: 20 })
      expect(read(JSON.parse(JSON.stringify(once)))).toEqual(once)
    })
  })
})

// What a change of side part way through the round made of the passes at the head of a court goes with the round, so Continue Round
// after a reload puts them back as they were (see `RoundState.courtLegs` and `resumedLegs`).
describe('what a change of side made of the passes at the head of a court', () => {
  const read = (round: unknown) => normalizeLibrary(JSON.parse(JSON.stringify({ routes: [{ id: 'x', name: 'A', route: doubled(), round, updatedAt: 0 }] })))!.routes[0].round
  const started = (round: RoundState) => setActiveRound(addRoute(createLibrary(), 'Saturday', doubled()), round)

  it('is read back with the round after a reload', () => {
    const round: RoundState = { handledStopIds: ['E'], furthest: 300, courtLegs: { W: 'out', 'X#2': 'ahead' } }
    expect(read(round)).toEqual(round)
    expect(read(read(round))).toEqual(round)
  })

  it('has no key for a round saved before it was kept, or with none', () => {
    for (const round of [{ handledStopIds: ['E'], furthest: 300 }, { handledStopIds: ['E'], courtLegs: {} }, { handledStopIds: ['E'], courtLegs: 'out' }]) {
      const back = read(round)
      expect(back, JSON.stringify(round)).toEqual({ handledStopIds: ['E'], ...('furthest' in round ? { furthest: 300 } : {}) })
      expect('courtLegs' in back, JSON.stringify(round)).toBe(false)
    }
  })

  it("keeps only the entries that say 'out' or 'ahead'", () => {
    expect(read({ handledStopIds: [], courtLegs: { W: 'gone', V: 'out', __x: 3 } }).courtLegs).toEqual({ V: 'out' })
    expect('courtLegs' in read({ handledStopIds: [], courtLegs: { W: 'gone' } })).toBe(false)
  })

  it('is kept while the round is kept or the route adjusted, and goes when the route is edited or copied', () => {
    const lib = started({ handledStopIds: ['a'], furthest: 300, courtLegs: { a: 'out' } })
    expect(activeRoute(lib).round.courtLegs).toEqual({ a: 'out' })
    expect(activeRoute(adjustActiveRoute(lib, { ...doubled(), sideChanges: [{ idx: 0, side: 'right' }] }, 1)).round.courtLegs).toEqual({ a: 'out' })
    expect(activeRoute(editActiveRoute(lib, doubled(), 1)).round).toEqual({ handledStopIds: [] })
    expect(activeRoute(duplicateRoute(lib, lib.activeId)).round).toEqual({ handledStopIds: [] })
  })
})

describe("the driver's order of the bundle drops", () => {
  // A route with three bundle stops. The order is kept beside the route as stop ids.
  const withBundles = (): Route => ({
    ...doubled(),
    stops: [
      { id: 'a', type: 'bundle', lat: -33.869, lng: 151.2, pathIdx: 0, label: 'Co-op', qty: 12 },
      { id: 'b', type: 'bundle', lat: -33.8695, lng: 151.2, pathIdx: 0, label: 'Spar', qty: 6 },
      { id: 'c', type: 'bundle', lat: -33.87, lng: 151.2, pathIdx: 0, label: 'School', qty: 2 },
    ],
  })
  const ordered = () => {
    let lib = addRoute(createLibrary(), 'Saturday', withBundles())
    lib = setBundleOrder(lib, lib.activeId, ['c', 'a', 'b'])
    return lib
  }

  describe('setting it', () => {
    it('keeps it with the route, and leaves the route and its round alone', () => {
      let lib = addRoute(createLibrary(), 'Saturday', withBundles())
      lib = setActiveRound(lib, { handledStopIds: ['a'], dropped: ['a'], furthest: 300, startM: 120 })
      const before = activeRoute(lib)
      lib = setBundleOrder(lib, lib.activeId, ['c', 'a', 'b'])
      const after = activeRoute(lib)
      expect(after.bundleOrder).toEqual(['c', 'a', 'b'])
      expect(after.route).toBe(before.route)
      expect(after.round).toBe(before.round)
      expect(after.updatedAt).toBe(before.updatedAt)
      expect(after.name).toBe('Saturday')
    })

    it('sets it for the route it is given, whichever is in use, and no other', () => {
      let lib = addRoute(addRoute(createLibrary(), 'Monday', withBundles()), 'Tuesday', withBundles())
      const monday = lib.routes.find((r) => r.name === 'Monday')!
      lib = setBundleOrder(lib, monday.id, ['b', 'a'])
      expect(lib.routes.find((r) => r.name === 'Monday')!.bundleOrder).toEqual(['b', 'a'])
      expect('bundleOrder' in lib.routes.find((r) => r.name === 'Tuesday')!).toBe(false)
      expect(lib.activeId).not.toBe(monday.id)
    })

    it('replaces an order set before', () => {
      let lib = ordered()
      lib = setBundleOrder(lib, lib.activeId, ['b', 'c'])
      expect(activeRoute(lib).bundleOrder).toEqual(['b', 'c'])
    })

    it('keeps it as given: a stop that is gone or one not in it is put right when it is read, not here', () => {
      const lib = addRoute(createLibrary(), 'Saturday', withBundles())
      expect(activeRoute(setBundleOrder(lib, lib.activeId, ['gone', 'c'])).bundleOrder).toEqual(['gone', 'c'])
    })

    it('keeps ids only, once each', () => {
      let lib = addRoute(createLibrary(), 'Saturday', withBundles())
      lib = setBundleOrder(lib, lib.activeId, ['a', 'a', '', 'b'] as string[])
      expect(activeRoute(lib).bundleOrder).toEqual(['a', 'b'])
    })

    it('takes it off when the order is empty, leaving no key', () => {
      let lib = ordered()
      lib = setBundleOrder(lib, lib.activeId, [])
      expect('bundleOrder' in activeRoute(lib)).toBe(false)
    })

    it('changes nothing for a route that is not here', () => {
      const lib = ordered()
      expect(setBundleOrder(lib, 'nope', ['a'])).toBe(lib)
    })

    it('does not change the library or the order it is given', () => {
      const lib = ordered()
      const copy = structuredClone(lib)
      const given = ['b', 'a']
      setBundleOrder(lib, lib.activeId, given)
      expect(lib).toEqual(copy)
      expect(given).toEqual(['b', 'a'])
    })

    it('does not share the order it is given', () => {
      const given = ['b', 'a']
      let lib = addRoute(createLibrary(), 'Saturday', withBundles())
      lib = setBundleOrder(lib, lib.activeId, given)
      given.push('c')
      expect(activeRoute(lib).bundleOrder).toEqual(['b', 'a'])
    })
  })

  describe('keeping it through what happens to the route', () => {
    it('keeps it when the route is edited, which starts the round over but is not the driver\'s progress', () => {
      const lib = editActiveRoute(ordered(), { ...withBundles(), stops: withBundles().stops.slice(0, 2) }, 5)
      expect(activeRoute(lib).bundleOrder).toEqual(['c', 'a', 'b'])
      expect(activeRoute(lib).round).toEqual({ handledStopIds: [] })
    })

    it('keeps it unrewritten when a stop is deleted or added, so the order is worked out when it is read', () => {
      let lib = ordered()
      const added: Stop = { id: 'd', type: 'bundle', lat: -33.871, lng: 151.2, pathIdx: 0 }
      lib = editActiveRoute(lib, { ...withBundles(), stops: [...withBundles().stops, added].filter((x) => x.id !== 'c') })
      expect(activeRoute(lib).bundleOrder).toEqual(['c', 'a', 'b'])
    })

    it('keeps it when the route is adjusted while driving', () => {
      const lib = adjustActiveRoute(ordered(), { ...withBundles(), sideChanges: [{ idx: 0, side: 'right' }] }, 1)
      expect(activeRoute(lib).bundleOrder).toEqual(['c', 'a', 'b'])
    })

    it('keeps it when the round is started over, reset or carried on: it is the driver\'s list, not progress', () => {
      let lib = ordered()
      lib = setActiveRound(lib, { handledStopIds: ['a', 'c'], dropped: ['a'], missed: ['c'], furthest: 200, startM: 50 })
      expect(activeRoute(lib).bundleOrder).toEqual(['c', 'a', 'b'])
      lib = setActiveRound(lib, { handledStopIds: [] })
      expect(activeRoute(lib).bundleOrder).toEqual(['c', 'a', 'b'])
      expect(activeRoute(lib).round).toEqual({ handledStopIds: [] })
    })

    it('keeps it when sections or street names are set', () => {
      let lib = setActiveSections(ordered(), [named('s1')])
      lib = setActiveStreets(lib, [street('Oak Road')])
      expect(activeRoute(lib).bundleOrder).toEqual(['c', 'a', 'b'])
      lib = setActiveSections(lib, [])
      expect(activeRoute(lib).bundleOrder).toEqual(['c', 'a', 'b'])
    })

    it('keeps it when the route is renamed or another is chosen and chosen again', () => {
      let lib = ordered()
      const id = lib.activeId
      lib = renameRoute(lib, id, 'Sunday')
      lib = selectRoute(selectRoute(lib, lib.routes[0].id), id)
      expect(activeRoute(lib).name).toBe('Sunday')
      expect(activeRoute(lib).bundleOrder).toEqual(['c', 'a', 'b'])
    })
  })

  describe('copying a route', () => {
    it('copies it, independently of the original, with the same stop ids to name', () => {
      let lib = ordered()
      const original = lib.activeId
      lib = duplicateRoute(lib, original)
      const copy = activeRoute(lib)
      expect(copy.id).not.toBe(original)
      expect(copy.bundleOrder).toEqual(['c', 'a', 'b'])
      expect(copy.route.stops.map((x) => x.id)).toEqual(['a', 'b', 'c'])
      lib = setBundleOrder(lib, copy.id, ['a', 'b', 'c'])
      expect(lib.routes.find((r) => r.id === original)!.bundleOrder).toEqual(['c', 'a', 'b'])
      expect(lib.routes.find((r) => r.id === original)!.bundleOrder).not.toBe(copy.bundleOrder)
    })

    it('has no key for a route with no order', () => {
      const lib = addRoute(createLibrary(), 'Saturday', withBundles())
      const copy = activeRoute(duplicateRoute(lib, lib.activeId))
      expect(copy.name).toBe('Saturday copy')
      expect('bundleOrder' in copy).toBe(false)
    })

    it('copies it along with sections and street names', () => {
      let lib = setActiveStreets(setActiveSections(ordered(), [named('s1')]), [street('Oak Road')])
      lib = duplicateRoute(lib, lib.activeId)
      const copy = activeRoute(lib)
      expect(copy.bundleOrder).toEqual(['c', 'a', 'b'])
      expect(copy.sections).toEqual([named('s1')])
      expect(copy.streets).toEqual([street('Oak Road')])
    })
  })

  describe('reading it back from the phone', () => {
    const read = (bundleOrder: unknown) => normalizeLibrary({ routes: [{ id: 'x', name: 'A', route: withBundles(), round: { handledStopIds: [] }, updatedAt: 0, bundleOrder }] })!.routes[0]

    it('keeps an order that was saved', () => {
      expect(read(['c', 'a', 'b']).bundleOrder).toEqual(['c', 'a', 'b'])
    })

    it('keeps it as it was, with ids of stops that are gone, for the same reason as when it is set', () => {
      expect(read(['gone', 'c']).bundleOrder).toEqual(['gone', 'c'])
    })

    it('has none when there was none, or when it is nothing usable', () => {
      for (const junk of [undefined, null, 'c,a', 5, {}, [], [1, null, '']]) expect('bundleOrder' in read(junk), String(junk)).toBe(false)
    })

    it('keeps only the ids, once each, from a damaged list', () => {
      expect(read(['a', 7, 'a', null, 'b']).bundleOrder).toEqual(['a', 'b'])
    })

    it('reads a route saved before the order existed as one with none', () => {
      const lib = normalizeLibrary({ routes: [{ id: 'x', name: 'A', route: withBundles(), round: { handledStopIds: [] }, updatedAt: 0 }] })!
      expect('bundleOrder' in lib.routes[0]).toBe(false)
    })

    it('survives being written out and read back', () => {
      const lib = normalizeLibrary(JSON.parse(JSON.stringify(ordered())))!
      expect(activeRoute(lib).bundleOrder).toEqual(['c', 'a', 'b'])
    })
  })

  describe('adding routes from a backup', () => {
    it('adds a route with its order, and one without as before', () => {
      const lib = addImported(createLibrary(), [
        { name: 'Monday', route: withBundles(), bundleOrder: ['b', 'a'] },
        { name: 'Tuesday', route: withBundles() },
      ])
      expect(lib.routes.find((r) => r.name === 'Monday')!.bundleOrder).toEqual(['b', 'a'])
      expect('bundleOrder' in lib.routes.find((r) => r.name === 'Tuesday')!).toBe(false)
    })

    it('adds it as a new route in keep mode, leaving the one here with its own', () => {
      let here = addRoute(createLibrary(), 'Monday', withBundles())
      here = setBundleOrder(here, here.activeId, ['c', 'a', 'b'])
      const lib = addImported(here, [{ name: 'Monday', route: withBundles(), bundleOrder: ['b'] }], 9, 'keep')
      expect(lib.routes.find((r) => r.name === 'Monday')!.bundleOrder).toEqual(['c', 'a', 'b'])
      expect(lib.routes.find((r) => r.name === 'Monday 2')!.bundleOrder).toEqual(['b'])
    })

    describe('over a route of the same name', () => {
      const here = () => {
        let lib = addRoute(createLibrary(), 'Monday', withBundles())
        lib = setBundleOrder(lib, lib.activeId, ['c', 'a', 'b'])
        return setActiveRound(lib, { handledStopIds: ['a'], dropped: ['a'], furthest: 100 })
      }
      const monday = (lib: Library) => lib.routes.find((r) => r.name === 'Monday')!

      it('takes the one in the backup, starting the round over', () => {
        const lib = addImported(here(), [{ name: 'monday', route: withBundles(), bundleOrder: ['b', 'a', 'c'] }], 9, 'replace')
        expect(monday(lib).bundleOrder).toEqual(['b', 'a', 'c'])
        expect(monday(lib).round).toEqual({ handledStopIds: [] })
      })

      it('keeps its own when the backup has none, as a backup made before it existed has none', () => {
        const lib = addImported(here(), [{ name: 'Monday', route: withBundles() }], 9, 'replace')
        expect(monday(lib).bundleOrder).toEqual(['c', 'a', 'b'])
        expect(monday(lib).round).toEqual({ handledStopIds: [] })
      })

      it('keeps its place in the list and its sections', () => {
        let lib = setActiveSections(here(), [named('mine')])
        lib = addRoute(lib, 'Tuesday', withBundles())
        const out = addImported(lib, [{ name: 'Monday', route: withBundles(), bundleOrder: ['a'] }], 9, 'replace')
        expect(out.routes.map((r) => r.name)).toEqual(['My Round', 'Monday', 'Tuesday'])
        expect(monday(out).sections).toEqual([named('mine')])
      })
    })

    it('replaces the blank starter with a route that has an order', () => {
      const lib = addImported(createLibrary(), [{ name: 'Monday', route: withBundles(), bundleOrder: ['c', 'b'] }])
      expect(lib.routes).toHaveLength(1)
      expect(activeRoute(lib).bundleOrder).toEqual(['c', 'b'])
    })

    it('does not share the order it is given', () => {
      const given = ['c', 'b']
      const lib = addImported(createLibrary(), [{ name: 'Monday', route: withBundles(), bundleOrder: given }])
      given.push('a')
      expect(activeRoute(lib).bundleOrder).toEqual(['c', 'b'])
    })
  })
})

describe('what the driver loads before the round', () => {
  // A list of the driver's own, which is not the usual one.
  const mine = (): LoadList => ({
    lines: [
      { id: 'x', bundles: 80, kind: 'bagged', note: 'Front seat' },
      { id: 'y', bundles: 4, kind: 'unwrapped' },
    ],
    papersEach: { bagged: 30, unwrapped: 40 },
  })
  const loaded = () => {
    let lib = addRoute(createLibrary(), 'Saturday', drawn())
    lib = setLoad(lib, lib.activeId, mine())
    return lib
  }

  describe('a route with none of its own', () => {
    it('has no key, and shows the usual list', () => {
      const route = activeRoute(addRoute(createLibrary(), 'Saturday', drawn()))
      expect('load' in route).toBe(false)
      expect(loadOf(route.load)).toBe(DEFAULT_LOAD)
    })
  })

  describe('setting it', () => {
    it('keeps it with the route, and leaves the route and its round alone', () => {
      let lib = addRoute(createLibrary(), 'Saturday', drawn())
      lib = setActiveRound(lib, { handledStopIds: ['a'], furthest: 300, startM: 120 })
      const before = activeRoute(lib)
      lib = setLoad(lib, lib.activeId, mine())
      const after = activeRoute(lib)
      expect(after.load).toEqual(mine())
      expect(after.route).toBe(before.route)
      expect(after.round).toBe(before.round)
      expect(after.updatedAt).toBe(before.updatedAt)
    })

    it('sets it for the route it is given, whichever is in use, and no other', () => {
      let lib = addRoute(addRoute(createLibrary(), 'Monday', drawn()), 'Tuesday', drawn())
      const monday = lib.routes.find((r) => r.name === 'Monday')!
      lib = setLoad(lib, monday.id, mine())
      expect(lib.routes.find((r) => r.name === 'Monday')!.load).toEqual(mine())
      expect('load' in lib.routes.find((r) => r.name === 'Tuesday')!).toBe(false)
      expect(lib.activeId).not.toBe(monday.id)
    })

    it('saves the usual list as the route\'s own once it is edited, not as a link to the usual one', () => {
      const lib = addRoute(createLibrary(), 'Saturday', drawn())
      const saved = activeRoute(setLoad(lib, lib.activeId, DEFAULT_LOAD)).load!
      expect(saved).toEqual(DEFAULT_LOAD)
      expect(saved).not.toBe(DEFAULT_LOAD)
      expect(saved.lines[0]).not.toBe(DEFAULT_LOAD.lines[0])
    })

    it('tidies it: a note typed with stray spaces is kept without them, and a blank one not at all', () => {
      const lib = addRoute(createLibrary(), 'Saturday', drawn())
      const typed: LoadList = { ...mine(), lines: [{ id: 'x', bundles: 1, kind: 'bagged', note: '  1   pallet ' }, { id: 'y', bundles: 2, kind: 'bagged', note: '  ' }] }
      const saved = activeRoute(setLoad(lib, lib.activeId, typed)).load!
      expect(saved.lines[0].note).toBe('1 pallet')
      expect('note' in saved.lines[1]).toBe(false)
    })

    it('keeps a list with no lines: every line taken off is not the same as never having set one', () => {
      const lib = loaded()
      const saved = activeRoute(setLoad(lib, lib.activeId, { ...mine(), lines: [] }))
      expect(saved.load).toEqual({ lines: [], papersEach: { bagged: 30, unwrapped: 40 } })
      expect(loadOf(saved.load).lines).toEqual([])
    })

    it('replaces a list set before', () => {
      let lib = loaded()
      const other: LoadList = { lines: [{ id: 'z', bundles: 1, kind: 'bagged' }], papersEach: { bagged: 25, unwrapped: 50 } }
      lib = setLoad(lib, lib.activeId, other)
      expect(activeRoute(lib).load).toEqual(other)
    })

    it('changes nothing for a route that is not here', () => {
      const lib = loaded()
      expect(setLoad(lib, 'nope', mine())).toBe(lib)
    })

    it('does not change the library or the list it is given, and does not share it', () => {
      const lib = loaded()
      const copy = structuredClone(lib)
      const given = mine()
      const next = setLoad(lib, lib.activeId, given)
      expect(lib).toEqual(copy)
      given.lines[0].bundles = 1
      given.papersEach.bagged = 1
      expect(activeRoute(next).load).toEqual(mine())
    })
  })

  describe('keeping it through what happens to the route', () => {
    it('keeps it when the route is edited, which starts the round over but is not the driver\'s progress', () => {
      const lib = editActiveRoute(loaded(), drawn(5), 5)
      expect(activeRoute(lib).load).toEqual(mine())
      expect(activeRoute(lib).round).toEqual({ handledStopIds: [] })
    })

    it('keeps it when the route is adjusted while driving', () => {
      expect(activeRoute(adjustActiveRoute(loaded(), { ...drawn(), sideChanges: [{ idx: 0, side: 'right' }] }, 1)).load).toEqual(mine())
    })

    it('keeps it when the round is kept, started over or reset', () => {
      let lib = setActiveRound(loaded(), { handledStopIds: ['a'], furthest: 200 })
      expect(activeRoute(lib).load).toEqual(mine())
      lib = setActiveRound(lib, { handledStopIds: [] })
      expect(activeRoute(lib).load).toEqual(mine())
    })

    it('keeps it when sections, street names or the bundle order are set', () => {
      let lib = setActiveSections(loaded(), [named('s1')])
      lib = setActiveStreets(lib, [street('Oak Road')])
      lib = setBundleOrder(lib, lib.activeId, ['a'])
      expect(activeRoute(lib).load).toEqual(mine())
      lib = setBundleOrder(setActiveStreets(setActiveSections(lib, []), []), lib.activeId, [])
      expect(activeRoute(lib).load).toEqual(mine())
    })

    it('keeps what else the route has when it is set', () => {
      let lib = setActiveStreets(setActiveSections(addRoute(createLibrary(), 'Saturday', drawn()), [named('s1')]), [street('Oak Road')])
      lib = setBundleOrder(lib, lib.activeId, ['a'])
      lib = setLoad(lib, lib.activeId, mine())
      expect(activeRoute(lib).sections).toEqual([named('s1')])
      expect(activeRoute(lib).streets).toEqual([street('Oak Road')])
      expect(activeRoute(lib).bundleOrder).toEqual(['a'])
    })

    it('keeps it when the route is renamed or another is chosen and chosen again', () => {
      let lib = loaded()
      const id = lib.activeId
      lib = renameRoute(lib, id, 'Sunday')
      lib = selectRoute(selectRoute(lib, lib.routes[0].id), id)
      expect(activeRoute(lib).load).toEqual(mine())
    })
  })

  describe('copying a route', () => {
    it('copies it, independently of the original', () => {
      let lib = loaded()
      const original = lib.activeId
      lib = duplicateRoute(lib, original)
      const copy = activeRoute(lib)
      expect(copy.id).not.toBe(original)
      expect(copy.load).toEqual(mine())
      lib = setLoad(lib, copy.id, { ...mine(), lines: [] })
      expect(lib.routes.find((r) => r.id === original)!.load).toEqual(mine())
      expect(lib.routes.find((r) => r.id === original)!.load).not.toBe(copy.load)
    })

    it('has no key for a route with none of its own', () => {
      const lib = addRoute(createLibrary(), 'Saturday', drawn())
      expect('load' in activeRoute(duplicateRoute(lib, lib.activeId))).toBe(false)
    })
  })

  describe('reading it back from the phone', () => {
    const read = (load: unknown) => normalizeLibrary({ routes: [{ id: 'x', name: 'A', route: drawn(), round: { handledStopIds: [] }, updatedAt: 0, load }] })!.routes[0]

    it('keeps a list that was saved', () => {
      expect(read(mine()).load).toEqual(mine())
    })

    it('has none when there was none, or when it is nothing usable, so the route shows the usual list', () => {
      for (const junk of [undefined, null, 'list', 5, {}, [], { lines: 'x' }, { lines: [null, 7] }]) {
        const route = read(junk)
        expect('load' in route, JSON.stringify(junk)).toBe(false)
        expect(loadOf(route.load), JSON.stringify(junk)).toBe(DEFAULT_LOAD)
      }
    })

    it('keeps the lines that can be read from a damaged list, and the rest of the route', () => {
      const route = read({ lines: [null, { id: 'x', bundles: 9, kind: 'bagged' }, { id: 'y', bundles: 'lots', kind: 'bagged' }], papersEach: { bagged: 'x', unwrapped: 40 } })
      expect(route.load).toEqual({ lines: [{ id: 'x', bundles: 9, kind: 'bagged' }], papersEach: { bagged: 25, unwrapped: 40 } })
      expect(route.route.points).toHaveLength(3)
    })

    it('keeps a list with no lines', () => {
      expect(read({ ...mine(), lines: [] }).load).toEqual({ lines: [], papersEach: { bagged: 30, unwrapped: 40 } })
    })

    it('reads a route saved before the list existed as one with none', () => {
      const lib = normalizeLibrary({ routes: [{ id: 'x', name: 'A', route: drawn(), round: { handledStopIds: [] }, updatedAt: 0 }] })!
      expect('load' in lib.routes[0]).toBe(false)
    })

    it('survives being written out and read back', () => {
      expect(activeRoute(normalizeLibrary(JSON.parse(JSON.stringify(loaded())))!).load).toEqual(mine())
    })
  })

  describe('adding routes from a backup', () => {
    it('adds a route with its list, and one without as before', () => {
      const lib = addImported(createLibrary(), [
        { name: 'Monday', route: drawn(), load: mine() },
        { name: 'Tuesday', route: drawn() },
      ])
      expect(lib.routes.find((r) => r.name === 'Monday')!.load).toEqual(mine())
      expect('load' in lib.routes.find((r) => r.name === 'Tuesday')!).toBe(false)
    })

    it('adds it as a new route in keep mode, leaving the one here with its own', () => {
      const other: LoadList = { ...mine(), lines: [] }
      let here = addRoute(createLibrary(), 'Monday', drawn())
      here = setLoad(here, here.activeId, mine())
      const lib = addImported(here, [{ name: 'Monday', route: drawn(), load: other }], 9, 'keep')
      expect(lib.routes.find((r) => r.name === 'Monday')!.load).toEqual(mine())
      expect(lib.routes.find((r) => r.name === 'Monday 2')!.load).toEqual(other)
    })

    describe('over a route of the same name', () => {
      const here = () => {
        const lib = addRoute(createLibrary(), 'Monday', drawn())
        return setLoad(lib, lib.activeId, mine())
      }
      const monday = (lib: Library) => lib.routes.find((r) => r.name === 'Monday')!

      it('takes the one in the backup', () => {
        const other: LoadList = { ...mine(), papersEach: { bagged: 10, unwrapped: 20 } }
        expect(monday(addImported(here(), [{ name: 'monday', route: drawn(), load: other }], 9, 'replace')).load).toEqual(other)
      })

      it('keeps its own when the backup has none, as a backup made before it existed has none', () => {
        expect(monday(addImported(here(), [{ name: 'Monday', route: drawn() }], 9, 'replace')).load).toEqual(mine())
      })

      it('takes a list with no lines from the backup, which is a list of its own', () => {
        const none: LoadList = { ...mine(), lines: [] }
        expect(monday(addImported(here(), [{ name: 'Monday', route: drawn(), load: none }], 9, 'replace')).load).toEqual(none)
      })
    })

    it('replaces the blank starter with a route that has a list', () => {
      const lib = addImported(createLibrary(), [{ name: 'Monday', route: drawn(), load: mine() }])
      expect(lib.routes).toHaveLength(1)
      expect(activeRoute(lib).load).toEqual(mine())
    })

    it('does not share the list it is given', () => {
      const given = mine()
      const lib = addImported(createLibrary(), [{ name: 'Monday', route: drawn(), load: given }])
      given.lines.pop()
      expect(activeRoute(lib).load).toEqual(mine())
    })
  })
})
