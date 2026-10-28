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
  uniqueName,
} from './library'
import type { Library, NamedSection, RoundState, Route, TurnStreet } from './types'

const drawn = (n = 3): Route => ({
  points: Array.from({ length: n }, (_, i) => ({ lat: -33.87 + i * 0.001, lng: 151.2 })),
  sideChanges: [{ idx: 0, side: 'left' }],
  stops: [{ id: 'a', type: 'nothrow', lat: -33.869, lng: 151.2, pathIdx: 0, label: 'No. 14' }],
})

const names = (lib: Library) => lib.routes.map((r) => r.name)

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
