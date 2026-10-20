import { describe, expect, it } from 'vitest'
import { BACKUP_VERSION, backupFileName, makeBackup, parseBackup, toBackupRoute, type BackupRoute } from './backup'
import { resolveSections } from './namedSections'
import { activeRoute, addImported, addRoute, createLibrary, makeRoute, setActiveRound, setActiveSections, setActiveStreets } from './library'
import { snapAtDistance, pathLength } from './geo'
import type { Library, NamedSection, Pt, Route, SavedRoute, TurnStreet } from './types'

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

describe('named sections and street names in a backup', () => {
  const sections: NamedSection[] = [
    { id: 's1', name: 'Oak Estate', lat: -33.8688197, lng: 151.2092955 },
    { id: 's2', name: 'Back of the estate', lat: -33.8695, lng: 151.211, pass: 2 },
  ]
  const streets: TurnStreet[] = [
    { lat: -33.8691234567, lng: 151.2101234567, out: 90, name: 'Elm Street' },
    { lat: -33.8699, lng: 151.2125, out: 359, name: '' },
  ]
  const full: BackupRoute = { name: 'Monday Round', route, sections, streets }

  /** The backup text with its payload changed by `change`, the way a damaged or hand-edited one would be. */
  function altered(change: (payload: { routes: Record<string, unknown>[] }) => void, source: BackupRoute[] = [full]): string {
    const text = makeBackup(source)
    const payload = JSON.parse(text.split('\n')[1])
    change(payload)
    return `${text.split('\n')[0]}\n${JSON.stringify(payload)}`
  }

  it('are written beside the route, with locations to about 10 cm and the rest as they are', () => {
    const payload = JSON.parse(makeBackup([full]).split('\n')[1])
    const entry = payload.routes[0]
    expect(Object.keys(entry).sort()).toEqual(['name', 'route', 'sections', 'streets'])
    expect(entry.sections).toEqual([
      { id: 's1', name: 'Oak Estate', lat: -33.86882, lng: 151.209296 },
      { id: 's2', name: 'Back of the estate', lat: -33.8695, lng: 151.211, pass: 2 },
    ])
    expect(entry.streets).toEqual([
      { lat: -33.869123, lng: 151.210123, out: 90, name: 'Elm Street' },
      { lat: -33.8699, lng: 151.2125, out: 359, name: '' },
    ])
    expect(makeBackup([full])).not.toContain('-33.8688197')
    expect(makeBackup([full])).not.toContain('-33.8691234567')
  })

  it('are left out when they are not given, as a backup was before they existed, and written empty when given empty', () => {
    const plain = makeBackup(routes)
    expect(plain).not.toContain('"sections"')
    expect(plain).not.toContain('"streets"')
    const when = new Date('2026-10-15T00:00:00Z')
    const empty = makeBackup([{ name: 'X', route, sections: [], streets: [] }], when)
    expect(empty).toContain('"sections":[]')
    expect(empty).toContain('"streets":[]')
  })

  it('say a route has none when written empty, so restoring over a route that has some takes them off, and an older backup leaves them', () => {
    const when = new Date('2026-10-15T00:00:00Z')
    const none = ok(makeBackup([{ name: 'X', route, sections: [], streets: [] }], when))[0]
    expect(none.sections).toEqual([])
    expect(none.streets).toEqual([])
    const older = ok(makeBackup([{ name: 'X', route }], when))[0]
    expect('sections' in older).toBe(false)
    expect('streets' in older).toBe(false)
    let lib = addRoute(createLibrary(), 'X', route)
    lib = setActiveSections(setActiveStreets(lib, streets), sections)
    const replaced = (item: (typeof none)) => addImported(lib, [item], 0, 'replace').routes.find((r) => r.name === 'X')!
    expect(replaced(none).sections).toBeUndefined()
    expect(replaced(none).streets).toBeUndefined()
    expect(replaced(older).sections).toEqual(sections)
    expect(replaced(older).streets).toEqual(streets)
  })

  it('writes one without the other when a route has only one', () => {
    expect(makeBackup([{ name: 'X', route, sections }])).not.toContain('"streets"')
    expect(makeBackup([{ name: 'X', route, streets }])).not.toContain('"sections"')
  })

  it('leaves out a pass of 1 and anything else a section does not own', () => {
    const odd = [{ id: 'a', name: 'A', lat: 1, lng: 2, evil: 'x' }] as unknown as NamedSection[]
    const text = makeBackup([{ name: 'X', route, sections: odd, streets: [{ lat: 1, lng: 2, out: 3, name: 'N', evil: 'x' } as TurnStreet] }])
    expect(text).not.toContain('evil')
    expect(text).not.toContain('"pass"')
  })

  it('come back as they were, to the 10 cm, for the route they belong to', () => {
    const back = ok(makeBackup([{ name: 'First', route }, full, { name: 'Last', route, streets }]))
    expect('sections' in back[0]).toBe(false)
    expect('streets' in back[0]).toBe(false)
    expect(back[1].sections).toEqual([
      { id: 's1', name: 'Oak Estate', lat: -33.86882, lng: 151.209296 },
      { id: 's2', name: 'Back of the estate', lat: -33.8695, lng: 151.211, pass: 2 },
    ])
    expect(back[1].streets).toEqual([
      { lat: -33.869123, lng: 151.210123, out: 90, name: 'Elm Street' },
      { lat: -33.8699, lng: 151.2125, out: 359, name: '' },
    ])
    expect('sections' in back[2]).toBe(false)
    expect(back[2].streets).toHaveLength(2)
  })

  it('does not change what the rest of a route comes back as', () => {
    const back = ok(makeBackup([full]))[0]
    const plain = ok(makeBackup([{ name: 'Monday Round', route }]))[0]
    expect(back.route).toEqual(plain.route)
    expect(back.name).toBe(plain.name)
  })

  it('stay at version 1, which an older version of the app still reads, ignoring them', () => {
    expect(BACKUP_VERSION).toBe(1)
    expect(makeBackup([full])).toContain('"version":1')
    // What an older build does: read the route and nothing else.
    const old = JSON.parse(makeBackup([full]).split('\n')[1])
    expect(old.routes[0].route.points).toHaveLength(3)
  })

  it('keep a pass 2 section on the second pass of a road driven out and back', () => {
    const out: Pt[] = [0, 1, 2, 3, 4, 5].map((i) => ({ lat: -33.87 + i * 0.001, lng: 151.2 }))
    const points = [...out, ...out.slice(0, 5).reverse()]
    const spot = snapAtDistance(points, 200)!.point
    const there: NamedSection[] = [
      { id: 'out', name: 'Way out', ...spot },
      { id: 'back', name: 'Way back', ...spot, pass: 2 },
    ]
    const back = ok(makeBackup([{ name: 'X', route: { points, sideChanges: [{ idx: 0, side: 'both' }], stops: [] }, sections: there }]))[0]
    const { list, detached } = resolveSections(back.route.points, back.sections!)
    expect(detached).toEqual([])
    expect(list.map((s) => s.id)).toEqual(['start', 'out', 'back'])
    expect(list[1].startM).toBeCloseTo(200, 0)
    expect(list[2].startM).toBeCloseTo(pathLength(points) - 200, 0)
  })

  it('ignore ones that are not a list, and never stop the route being restored', () => {
    for (const junk of [null, 'x', 7, true, {}, { 0: { id: 'a', name: 'A', lat: 1, lng: 2 } }]) {
      const text = altered((p) => {
        p.routes[0].sections = junk
        p.routes[0].streets = junk
      })
      const back = ok(text)[0]
      expect(back.route.points, JSON.stringify(junk)).toHaveLength(3)
      expect('sections' in back).toBe(false)
      expect('streets' in back).toBe(false)
    }
  })

  it('drop the entries that are damaged and keep the good ones', () => {
    const text = altered((p) => {
      p.routes[0].sections = [
        { id: 'good', name: 'Good', lat: 1, lng: 2 },
        null,
        'x',
        { id: 'a', name: '   ', lat: 1, lng: 2 },
        { id: 'b', name: 'Bad place', lat: 91, lng: 2 },
        { id: 'c', name: 'Bad place', lat: 1, lng: 'x' },
        { id: 'd', name: 'Bad pass', lat: 1, lng: 2, pass: 'second' },
        { id: 'e', name: 'Big pass', lat: 1, lng: 2, pass: 500 },
      ]
      p.routes[0].streets = [
        { lat: 1, lng: 2, out: 10, name: 'Good' },
        { lat: 1, lng: 2, out: 400, name: 'Bad out' },
        { lat: 1, lng: 2, out: 10.5, name: 'Bad out' },
        { lat: 1, lng: 2, out: 10 },
        { lat: 1, lng: 200, out: 10, name: 'Bad place' },
        7,
      ]
    })
    const back = ok(text)[0]
    expect(back.sections!.map((s) => [s.id, s.pass])).toEqual([
      ['good', undefined],
      ['e', 99],
    ])
    expect(back.streets).toEqual([{ lat: 1, lng: 2, out: 10, name: 'Good' }])
  })

  it('have no keys when every entry is damaged, which leaves a route that is replaced with its own', () => {
    const back = ok(altered((p) => {
      p.routes[0].sections = [null, 1, { id: 'a' }]
      p.routes[0].streets = [null, 1, { lat: 1 }]
    }))[0]
    expect('sections' in back).toBe(false)
    expect('streets' in back).toBe(false)
  })

  it('tidy names and give repeated or missing ids their own', () => {
    const back = ok(altered((p) => {
      p.routes[0].sections = [
        { id: 'same', name: '  Oak   Estate ', lat: 1, lng: 2 },
        { id: 'same', name: 'Elm', lat: 1, lng: 2 },
        { name: 'No id', lat: 1, lng: 2 },
        { id: 'start', name: 'Clash', lat: 1, lng: 2 },
      ]
      p.routes[0].streets = [{ lat: 1, lng: 2, out: 10, name: `  ${'x'.repeat(80)} ` }]
    }))[0]
    expect(back.sections![0].name).toBe('Oak Estate')
    expect(new Set(back.sections!.map((s) => s.id)).size).toBe(4)
    expect(back.sections![3].id).not.toBe('start')
    expect(back.streets![0].name).toBe('x'.repeat(60))
  })

  it('are cut to the limit rather than the backup being refused', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `Part ${i}`, lat: -33.87 + i * 1e-5, lng: 151.2 }))
    const lots = (n: number) => Array.from({ length: n }, (_, i) => ({ lat: -33.87 + i * 1e-6, lng: 151.2, out: i % 360, name: `Road ${i}` }))
    const text = altered((p) => {
      p.routes[0].sections = many(300)
      p.routes[0].streets = lots(5100)
    })
    const result = parseBackup(text)
    expect(result.ok).toBe(true)
    const back = ok(text)[0]
    expect(back.sections).toHaveLength(200)
    expect(back.sections![0].id).toBe('s0')
    expect(back.sections!.at(-1)!.id).toBe('s199')
    expect(back.streets).toHaveLength(5000)
    expect(back.streets![0].name).toBe('Road 0')
    expect(back.route.points).toHaveLength(3)
  })

  it('are all kept at the limit exactly', () => {
    const text = altered((p) => {
      p.routes[0].sections = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, name: 'N', lat: 1, lng: 2 }))
    })
    expect(ok(text)[0].sections).toHaveLength(200)
  })

  it('leave a backup of several long routes well within the text limit', () => {
    // A long round: 2,000 points, 200 sections and 800 street names, five times over, is far below the 5,000,000 characters allowed.
    const long: Route = { points: Array.from({ length: 2000 }, (_, i) => ({ lat: -33.87 + i * 1e-4, lng: 151.2 + i * 1e-5 })), sideChanges: [{ idx: 0, side: 'both' }], stops: [] }
    const bigSections = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, name: `A long enough name ${i}`, lat: -33.87 + i * 1e-3, lng: 151.2 }))
    const bigStreets = Array.from({ length: 800 }, (_, i) => ({ lat: -33.87 + i * 1e-4, lng: 151.2, out: i % 360, name: `Some Road Name ${i}` }))
    const text = makeBackup(Array.from({ length: 5 }, (_, i) => ({ name: `R${i}`, route: long, sections: bigSections, streets: bigStreets })))
    expect(text.length).toBeLessThan(5_000_000)
    expect(ok(text)).toHaveLength(5)
  })

  it('is never longer than the routes are as the phone keeps them, so what the phone can store can be backed up and read back', () => {
    // Coordinates as a drawn or recorded route has them, with a dozen or more decimals, and as a road finder gives them, with six.
    const fine = (i: number) => ({ lat: 51.5 + Math.sin(i * 0.37) * 0.05 + i * 1.234567891e-7, lng: -0.1 + Math.cos(i * 0.21) * 0.05 + i * 9.87654321e-8 })
    const coarse = (i: number) => ({ lat: Math.round(fine(i).lat * 1e6) / 1e6, lng: Math.round(fine(i).lng * 1e6) / 1e6 })
    for (const where of [fine, coarse]) {
      const saved: SavedRoute[] = Array.from({ length: 6 }, (_, n) => ({
        ...makeRoute(`Round ${n}`, {
          points: Array.from({ length: 3000 }, (_, i) => where(i + n)),
          sideChanges: [{ idx: 0, side: 'both' }],
          stops: Array.from({ length: 300 }, (_, i) => ({ id: `stop-${n}-${i}`, type: 'nothrow' as const, pathIdx: i, ...where(i * 7) })),
        }),
        sections: Array.from({ length: 30 }, (_, i) => ({ id: `sec${n}${i}`, name: `Section number ${i}`, ...where(i * 90) })),
        streets: Array.from({ length: 300 }, (_, i) => ({ ...where(i * 10), out: i % 360, name: `Some Road Name ${i}` })),
      }))
      const library: Library = { routes: saved, activeId: saved[0].id }
      const text = makeBackup(saved.map(toBackupRoute))
      expect(text.length, where.name).toBeLessThan(JSON.stringify(library).length)
      expect(ok(text), where.name).toHaveLength(6)
    }
  })
})

describe('backing up saved routes', () => {
  const sections: NamedSection[] = [{ id: 's1', name: 'Oak Estate', lat: -33.8695, lng: 151.211, pass: 2 }]
  const streets: TurnStreet[] = [{ lat: -33.8691, lng: 151.2101, out: 90, name: 'Elm Street' }]
  const saved = () => {
    let lib = addRoute(createLibrary(), 'Monday', route)
    lib = setActiveStreets(setActiveSections(lib, sections), streets)
    return setActiveRound(lib, { handledStopIds: ['s1'], furthest: 300, startM: 120 })
  }

  it('takes the name, route, sections and street names of a saved route, and no progress', () => {
    const r = activeRoute(saved())
    expect(toBackupRoute(r)).toEqual({ name: 'Monday', route, sections, streets })
    expect(Object.keys(toBackupRoute(r)).sort()).toEqual(['name', 'route', 'sections', 'streets'])
    expect(makeBackup([toBackupRoute(r)])).not.toContain('handledStopIds')
    expect(makeBackup([toBackupRoute(r)])).not.toContain('startM')
  })

  it('takes empty lists for a saved route that has none, so the backup says it has none', () => {
    const plain = activeRoute(addRoute(createLibrary(), 'Monday', route))
    expect(toBackupRoute(plain).sections).toEqual([])
    expect(toBackupRoute(plain).streets).toEqual([])
    const when = new Date('2026-10-15T00:00:00Z')
    expect(makeBackup([toBackupRoute(plain)], when)).toBe(makeBackup([{ name: 'Monday', route, sections: [], streets: [] }], when))
  })

  it('carries the sections and street names all the way: saved, backed up, read back and restored', () => {
    const text = makeBackup(saved().routes.map(toBackupRoute))
    const result = parseBackup(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const restored = addImported(createLibrary(), result.routes)
    const r = restored.routes.find((x) => x.name === 'Monday')!
    expect(r.sections).toEqual(sections)
    expect(r.streets).toEqual(streets)
    expect(r.route.points).toHaveLength(3)
    expect(r.round).toEqual({ handledStopIds: [] })
  })
})
