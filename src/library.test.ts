import { describe, expect, it } from 'vitest'
import {
  activeRoute,
  addImported,
  addRoute,
  cleanName,
  createLibrary,
  deleteRoute,
  duplicateRoute,
  editActiveRoute,
  importClashes,
  normalizeLibrary,
  renameRoute,
  sameName,
  selectRoute,
  setActiveRound,
  uniqueName,
} from './library'
import type { Library, Route } from './types'

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
