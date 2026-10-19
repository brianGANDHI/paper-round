import { describe, expect, it } from 'vitest'
import { backupFileName, makeBackup, parseBackup, type BackupRoute } from './backup'
import type { Route } from './types'

const route: Route = {
  points: [
    { lat: -33.8688197, lng: 151.2092955 },
    { lat: -33.8695, lng: 151.211 },
    { lat: -33.8702, lng: 151.2135 },
  ],
  sideChanges: [
    { idx: 0, side: 'both' },
    { idx: 1, side: 'left' },
  ],
  stops: [
    { id: 's1', type: 'nothrow', lat: -33.8691, lng: 151.2101, pathIdx: 0, label: "O'Brien, 14" },
    { id: 's2', type: 'bundle', lat: -33.8699, lng: 151.2125, pathIdx: 1, qty: 12 },
  ],
}

const routes: BackupRoute[] = [
  { name: 'Monday Round', route },
  { name: 'Saturday', route: { points: [], sideChanges: [], stops: [] } },
]

function ok(text: string) {
  const r = parseBackup(text)
  if (!r.ok) throw new Error(r.error)
  return r.routes
}

describe('making a backup', () => {
  it('is readable text that starts with a plain-English line', () => {
    const text = makeBackup(routes, new Date('2026-10-15T00:00:00Z'))
    expect(text.split('\n')[0]).toBe('Paper Round backup')
    expect(text).toContain('"exportedAt":"2026-10-15T00:00:00.000Z"')
  })

  it('keeps locations to about 10 cm so the text stays short', () => {
    const text = makeBackup(routes)
    expect(text).toContain('-33.86882')
    expect(text).not.toContain('-33.8688197')
  })

  it('leaves progress out', () => {
    expect(makeBackup(routes)).not.toContain('handledStopIds')
  })
})

describe('reading a backup back', () => {
  it('restores names, points, sides and stops', () => {
    const back = ok(makeBackup(routes))
    expect(back.map((r) => r.name)).toEqual(['Monday Round', 'Saturday'])
    expect(back[0].route.points).toHaveLength(3)
    expect(back[0].route.points[0].lat).toBeCloseTo(-33.86882, 5)
    expect(back[0].route.sideChanges).toEqual(route.sideChanges)
    expect(back[0].route.stops.map((s) => [s.type, s.label, s.qty])).toEqual([
      ['nothrow', "O'Brien, 14", undefined],
      ['bundle', undefined, 12],
    ])
    expect(back[1].route.points).toEqual([])
  })

  it('keeps the address of a stop apart from its name, and drops one that is not text', () => {
    const named: Route = {
      ...route,
      stops: [
        { ...route.stops[0], label: "Joe's Cafe", address: '  12 Oak Road, Lewes ' },
        { ...route.stops[1], address: '9 Elm Street' },
      ],
    }
    const back = ok(makeBackup([{ name: 'Monday Round', route: named }]))[0].route.stops
    expect(back.map((s) => [s.label, s.address])).toEqual([
      ["Joe's Cafe", '12 Oak Road, Lewes'],
      [undefined, '9 Elm Street'],
    ])
    const mangled = makeBackup([{ name: 'Monday Round', route: named }]).replace('"9 Elm Street"', '9').replace('"  12 Oak Road, Lewes "', '"   "')
    expect(ok(mangled)[0].route.stops.map((s) => s.address)).toEqual([undefined, undefined])
  })

  it('keeps a long address, up to a limit, so a backup cannot be made to hold a huge one', () => {
    const long: Route = { ...route, stops: [{ ...route.stops[0], address: 'x'.repeat(500) }] }
    expect(ok(makeBackup([{ name: 'Monday Round', route: long }]))[0].route.stops[0].address).toHaveLength(120)
  })

  it('restores a special request with its address and note, tidied, and keeps the note to a limit', () => {
    const requests: Route = {
      ...route,
      stops: [
        { id: 'q1', type: 'request', lat: -33.8691, lng: 151.2101, pathIdx: 0, address: '23 Oak Road', note: '  Blue gate, deliver by hand ' },
        { id: 'q2', type: 'request', lat: -33.8699, lng: 151.2125, pathIdx: 1, note: 'x'.repeat(500) },
        { id: 'q3', type: 'request', lat: -33.8695, lng: 151.211, pathIdx: 1 },
      ],
    }
    const back = ok(makeBackup([{ name: 'Monday Round', route: requests }]))[0].route.stops
    expect(back.map((s) => s.type)).toEqual(['request', 'request', 'request'])
    expect(back[0]).toMatchObject({ address: '23 Oak Road', note: 'Blue gate, deliver by hand' })
    expect(back[1].note).toHaveLength(120)
    expect('note' in back[2]).toBe(false)
  })

  it('drops a note that is not text or is blank, and one on a stop that is not a special request', () => {
    const odd: Route = {
      ...route,
      stops: [
        { id: 'a', type: 'request', lat: -33.8691, lng: 151.2101, pathIdx: 0, note: 'Blue gate' },
        { id: 'b', type: 'request', lat: -33.8699, lng: 151.2125, pathIdx: 1, note: 'Red door' },
        { id: 'c', type: 'bundle', lat: -33.8695, lng: 151.211, pathIdx: 1, qty: 3, note: 'Blue gate' },
        { id: 'd', type: 'nothrow', lat: -33.8693, lng: 151.2105, pathIdx: 0, note: 'Blue gate' },
      ],
    }
    const text = makeBackup([{ name: 'Monday Round', route: odd }]).replace('"Blue gate"', '7').replace('"Red door"', '"   "')
    expect(ok(text)[0].route.stops.map((s) => s.note)).toEqual([undefined, undefined, undefined, undefined])
  })

  it('copes with text that came through Notes or Messages', () => {
    const text = makeBackup(routes)
    const curly = text.replace(/"/g, (_, i) => (i % 2 ? '”' : '“'))
    expect(ok(`Here you go!\n\n${curly}\n\nSent from my iPhone`)).toHaveLength(2)
  })

  it('accepts the JSON on its own, without the header line', () => {
    expect(ok(makeBackup(routes).split('\n')[1])).toHaveLength(2)
  })

  it('keeps the side picked by hand for a stop, and ignores one that is not a side', () => {
    const withSides: Route = {
      ...route,
      stops: [
        { ...route.stops[0], side: 'right' },
        { ...route.stops[1], side: 'left' },
      ],
    }
    const text = makeBackup([{ name: 'X', route: withSides }])
    expect(ok(text)[0].route.stops.map((s) => s.side)).toEqual(['right', 'left'])
    const mangled = text.replace('"side":"right"', '"side":"upwards"')
    expect(ok(mangled)[0].route.stops.map((s) => s.side)).toEqual([undefined, 'left'])
  })

  it('gives stops with missing or repeated ids their own ids', () => {
    const text = makeBackup([{ name: 'X', route }])
    const mangled = text.replace(/"id":"s2"/, '"id":"s1"').replace(/"id":"s1"/, '"id":"s1"')
    const stops = ok(mangled)[0].route.stops
    expect(new Set(stops.map((s) => s.id)).size).toBe(2)
  })

  it('names an unnamed route nothing, leaving the library to name it', () => {
    const text = makeBackup([{ name: 'X', route }]).replace('"name":"X",', '')
    expect(ok(text)[0].name).toBe('')
  })
})

describe('refusing what is not a usable backup', () => {
  const error = (text: string) => {
    const r = parseBackup(text)
    return r.ok ? null : r.error
  }

  it('rejects ordinary text and broken JSON', () => {
    expect(error('buy milk')).toMatch(/doesn't look like a Paper Round backup/)
    expect(error('{"app":')).toMatch(/doesn't look like a Paper Round backup/)
    expect(error('')).toMatch(/doesn't look like a Paper Round backup/)
  })

  it("rejects JSON from some other app", () => {
    expect(error('{"app":"other","routes":[]}')).toMatch(/doesn't look like a Paper Round backup/)
  })

  it('rejects a backup from a newer version, and an empty one', () => {
    const text = makeBackup(routes)
    expect(error(text.replace('"version":1', '"version":99'))).toMatch(/newer version/)
    expect(error('{"app":"paper-round","version":1,"routes":[]}')).toMatch(/no routes/)
  })

  it('rejects impossible locations and damaged routes', () => {
    const text = makeBackup(routes)
    expect(error(text.replace('"lat":-33.86882', '"lat":123'))).toMatch(/location that isn't valid/)
    expect(error(text.replace('"lat":-33.86882', '"lat":"x"'))).toMatch(/location that isn't valid/)
    expect(error('{"app":"paper-round","version":1,"routes":[5]}')).toMatch(/Route 1 in the backup is damaged/)
    expect(error(text.replace('"type":"bundle"', '"type":"parcel"'))).toMatch(/stop that isn't valid/)
  })

  it('rejects absurdly large input', () => {
    expect(error('x'.repeat(5_000_001))).toMatch(/too long/)
  })
})

describe('the name a backup file is saved under', () => {
  it('is the route name, as a text file', () => {
    expect(backupFileName('Monday Round')).toBe('Paper Round - Monday Round.txt')
  })

  it('has nothing in it a computer or phone would object to', () => {
    expect(backupFileName('Mon/Tue: "early" <1>')).toBe('Paper Round - Mon Tue early 1.txt')
    expect(backupFileName('A\\B*C?D|E')).toBe('Paper Round - A B C D E.txt')
    expect(backupFileName('Line\none\ttwo')).toBe('Paper Round - Line one two.txt')
    expect(backupFileName('“Quoted”')).toBe('Paper Round - Quoted.txt')
  })

  it('falls back to a plain name, and is kept short', () => {
    expect(backupFileName('')).toBe('Paper Round - Routes.txt')
    expect(backupFileName('  /  ')).toBe('Paper Round - Routes.txt')
    expect(backupFileName('x'.repeat(200))).toBe(`Paper Round - ${'x'.repeat(60)}.txt`)
  })
})

describe('transit stretches in a backup', () => {
  const withTransit: Route = {
    ...route,
    sideChanges: [
      { idx: 0, side: 'left' },
      { idx: 1, side: 'transit' },
    ],
  }

  it('come back as they were saved', () => {
    const back = ok(makeBackup([{ name: 'X', route: withTransit }]))
    expect(back[0].route.sideChanges).toEqual([
      { idx: 0, side: 'left' },
      { idx: 1, side: 'transit' },
    ])
  })

  it('leave out a side that is not one of the real ones, as an older app would for transit', () => {
    const text = makeBackup([{ name: 'X', route: withTransit }]).replace('"side":"transit"', '"side":"hovering"')
    expect(ok(text)[0].route.sideChanges).toEqual([{ idx: 0, side: 'left' }])
  })
})
