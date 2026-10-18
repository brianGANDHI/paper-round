import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeRoute, addRoute, createLibrary } from './library'
import {
  canSave,
  loadAlertDistance,
  loadFollowRoads,
  loadLibrary,
  loadVoiceTurns,
  saveAlertDistance,
  saveFollowRoads,
  saveLibrary,
  saveVoiceTurns,
} from './storage'
import type { Route } from './types'

/** A stand-in for the phone's local storage. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

const oldRoute: Route = {
  points: [
    { lat: -33.87, lng: 151.2 },
    { lat: -33.871, lng: 151.201 },
  ],
  sideChanges: [{ idx: 0, side: 'right' }],
  stops: [{ id: 'z', type: 'nothrow', lat: -33.8705, lng: 151.2005, pathIdx: 0, label: 'No. 9' }],
}

afterEach(() => vi.unstubAllGlobals())

describe('opening the app', () => {
  let store: ReturnType<typeof fakeStorage>

  beforeEach(() => {
    store = fakeStorage()
    vi.stubGlobal('localStorage', store)
  })

  it('starts with one blank route when nothing has been saved, and saves it', () => {
    const lib = loadLibrary()
    expect(lib.routes).toHaveLength(1)
    expect(store.data.has('paperround.library.v2')).toBe(true)
  })

  it('carries over the route and progress saved by earlier versions', () => {
    store.data.set('paperround.route.v1', JSON.stringify(oldRoute))
    store.data.set('paperround.round.v1', JSON.stringify({ handledStopIds: ['z'] }))
    const lib = loadLibrary()
    expect(lib.routes).toHaveLength(1)
    const r = activeRoute(lib)
    expect(r.name).toBe('My Round')
    expect(r.route.points).toHaveLength(2)
    expect(r.route.sideChanges).toEqual([{ idx: 0, side: 'right' }])
    expect(r.route.stops[0].label).toBe('No. 9')
    expect(r.round.handledStopIds).toEqual(['z'])
  })

  it('keeps the old saved copy in place after carrying it over', () => {
    store.data.set('paperround.route.v1', JSON.stringify(oldRoute))
    loadLibrary()
    expect(store.data.has('paperround.route.v1')).toBe(true)
  })

  it('does not carry the old route over a second time once the new library exists', () => {
    store.data.set('paperround.route.v1', JSON.stringify(oldRoute))
    const first = loadLibrary()
    store.data.set('paperround.route.v1', JSON.stringify({ ...oldRoute, points: [] }))
    const second = loadLibrary()
    expect(second.routes).toHaveLength(1)
    expect(second.routes[0].id).toBe(first.routes[0].id)
    expect(activeRoute(second).route.points).toHaveLength(2)
  })

  it('brings back exactly what was saved', () => {
    const lib = addRoute(createLibrary(), 'Saturday', oldRoute)
    expect(saveLibrary(lib)).toBe(true)
    expect(loadLibrary()).toEqual(lib)
  })

  it('falls back to the old route if the new data is damaged', () => {
    store.data.set('paperround.library.v2', '{not json')
    store.data.set('paperround.route.v1', JSON.stringify(oldRoute))
    expect(activeRoute(loadLibrary()).route.points).toHaveLength(2)
  })

  it('starts fresh if everything saved is damaged', () => {
    store.data.set('paperround.library.v2', '[]')
    expect(loadLibrary().routes).toHaveLength(1)
  })
})

describe('a phone that refuses to store anything', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError')
      },
      removeItem: () => {},
    })
  })

  it('says so instead of pretending it saved', () => {
    expect(saveLibrary(createLibrary())).toBe(false)
    expect(canSave()).toBe(false)
  })

  it('still opens, with a blank route', () => {
    expect(loadLibrary().routes).toHaveLength(1)
  })

  it('still lets Follow roads be switched, though it starts off next time', () => {
    expect(() => saveFollowRoads(true)).not.toThrow()
    expect(loadFollowRoads()).toBe(false)
  })
})

describe('a phone that stores normally', () => {
  it('reports that it can save, without leaving anything behind', () => {
    const store = fakeStorage()
    vi.stubGlobal('localStorage', store)
    expect(canSave()).toBe(true)
    expect(store.data.size).toBe(0)
  })
})

describe('the Follow roads switch', () => {
  let store: ReturnType<typeof fakeStorage>

  beforeEach(() => {
    store = fakeStorage()
    vi.stubGlobal('localStorage', store)
  })

  it('starts off, so nothing goes to the road service until someone asks', () => {
    expect(loadFollowRoads()).toBe(false)
  })

  it('stays as it was left', () => {
    saveFollowRoads(true)
    expect(loadFollowRoads()).toBe(true)
    saveFollowRoads(false)
    expect(loadFollowRoads()).toBe(false)
  })

  it('is kept apart from the routes', () => {
    saveFollowRoads(true)
    expect(store.data.has('paperround.library.v2')).toBe(false)
  })

  it('reads anything unexpected as off', () => {
    for (const junk of ['{not json', '"yes"', '1', 'null', '[]']) {
      store.data.set('paperround.followRoads', junk)
      expect(loadFollowRoads()).toBe(false)
    }
  })
})

describe('the voice directions switch', () => {
  let store: ReturnType<typeof fakeStorage>

  beforeEach(() => {
    store = fakeStorage()
    vi.stubGlobal('localStorage', store)
  })

  it('starts off, so the turns are only an arrow until someone asks to hear them', () => {
    expect(loadVoiceTurns()).toBe(false)
  })

  it('stays as it was left', () => {
    saveVoiceTurns(true)
    expect(loadVoiceTurns()).toBe(true)
    saveVoiceTurns(false)
    expect(loadVoiceTurns()).toBe(false)
  })

  it('is kept apart from the routes and from the other choices', () => {
    saveVoiceTurns(true)
    expect(store.data.has('paperround.library.v2')).toBe(false)
    expect(loadFollowRoads()).toBe(false)
    expect(loadAlertDistance()).toBe(40)
  })

  it('reads anything unexpected as off', () => {
    for (const junk of ['{not json', '"yes"', '1', 'null', '[]']) {
      store.data.set('paperround.voiceTurns', junk)
      expect(loadVoiceTurns()).toBe(false)
    }
  })

  it('still works on a phone that stores nothing, starting off each time', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('no storage')
      },
      setItem: () => {
        throw new Error('no storage')
      },
    })
    expect(() => saveVoiceTurns(true)).not.toThrow()
    expect(loadVoiceTurns()).toBe(false)
  })
})

describe('the alert distance', () => {
  let store: ReturnType<typeof fakeStorage>

  beforeEach(() => {
    store = fakeStorage()
    vi.stubGlobal('localStorage', store)
  })

  it('starts on the usual 40 m', () => {
    expect(loadAlertDistance()).toBe(40)
  })

  it('stays as it was left', () => {
    for (const distance of [10, 60, 30, 40] as const) {
      saveAlertDistance(distance)
      expect(loadAlertDistance()).toBe(distance)
    }
  })

  it('is kept apart from the routes', () => {
    saveAlertDistance(60)
    expect(store.data.has('paperround.library.v2')).toBe(false)
  })

  it('carries over what earlier versions called Close, Normal and Far', () => {
    for (const [old, metres] of [['close', 20], ['normal', 40], ['far', 60]] as const) {
      store.data.set('paperround.alertDistance', JSON.stringify(old))
      expect(loadAlertDistance()).toBe(metres)
    }
  })

  it('reads anything unexpected as the usual distance', () => {
    for (const junk of ['{not json', '"soon"', '35', '0', '100', 'null', '[]', '"CLOSE"', '"40"']) {
      store.data.set('paperround.alertDistance', junk)
      expect(loadAlertDistance()).toBe(40)
    }
  })

  it('still lets the distance be changed on a phone that stores nothing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('no storage')
      },
      setItem: () => {
        throw new Error('no storage')
      },
    })
    expect(() => saveAlertDistance(20)).not.toThrow()
    expect(loadAlertDistance()).toBe(40)
  })
})
