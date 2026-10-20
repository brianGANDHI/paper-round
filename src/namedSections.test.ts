import { describe, expect, it, vi } from 'vitest'
import { cumulativeDistances, haversine, occurrences, passesNear, pathLength, snapAtDistance, type Occurrence } from './geo'
import {
  addSection,
  ANCHOR_MAX_M,
  ANCHOR_TOLERANCE_M,
  anchorAt,
  cleanSectionName,
  LEAD_ID,
  LEAD_NAME,
  MAX_SECTION_NAME,
  MAX_SECTIONS,
  normalizeSections,
  removeSection,
  renameSection,
  resolveSections,
  SECTION_GAP_M,
  sectionAt,
  sectionPoint,
  sectionStatus,
  type ResolvedSection,
} from './namedSections'
import { appendPoint, appendPoints, deletePoint, insertPoint, movePoint, repeatSection } from './routeEdit'
import type { NamedSection, Pt, Route } from './types'

// Finding where a route passes a spot walks all of it, so some tests count how many times that is done.
vi.mock('./geo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./geo')>()
  return { ...actual, passesNear: vi.fn(actual.passesNear) }
})

const M_PER_DEG = (6371000 * Math.PI) / 180
/** The length of one step of the test roads, in metres. */
const STEP = M_PER_DEG * 0.001

// A straight road running north, ~111 m between points.
const pt = (i: number): Pt => ({ lat: 51 + i * 0.001, lng: 0 })
const road = (n: number): Pt[] => Array.from({ length: n }, (_, i) => pt(i))
/** Out along the road to its sixth point and straight back over the same line: the second pass is exactly the first. */
const outAndBack = (): Pt[] => [...road(6), ...road(6).slice(0, 5).reverse()]
const asRoute = (points: Pt[]): Route => ({ points, sideChanges: [{ idx: 0, side: 'both' }], stops: [] })

/** A spot `x` metres east and `y` metres north of the road's start. */
const spot = (x: number, y: number): Pt => ({ lat: 51 + y / M_PER_DEG, lng: x / (M_PER_DEG * Math.cos((51 * Math.PI) / 180)) })
/** A square 300 m a side that ends where it starts. */
const loop = (): Pt[] => [spot(0, 0), spot(0, 300), spot(300, 300), spot(300, 0), spot(0, 0)]
/** A road 600 m out and straight back along the same line, so that the far end is 600 m along and the way back runs from there to 1200 m. */
const turnBack = (): Pt[] => [spot(0, 0), spot(0, 600), spot(0, 0)]

const at = (points: Pt[], m: number): Pt => snapAtDistance(points, m)!.point
/** A section anchored on the route `m` metres along it. */
const sec = (points: Pt[], m: number, id = `s${m}`, extra: Partial<NamedSection> = {}): NamedSection => ({ id, name: `Part ${id}`, ...at(points, m), ...extra })
/** A spot beside the road, `m` metres east of the point `along` metres up it. */
const beside = (points: Pt[], along: number, m: number): Pt => {
  const p = at(points, along)
  return { lat: p.lat, lng: p.lng + m / (M_PER_DEG * Math.cos((p.lat * Math.PI) / 180)) }
}

/** Where a section starts once placed, with one at the very start of the route before it so that it is not pulled back to 0. */
const startOf = (points: Pt[], section: NamedSection): number | undefined =>
  resolveSections(points, [sec(points, 0, 'home'), section]).list.find((s) => s.id === section.id)?.startM

const starts = (list: readonly ResolvedSection[]) => list.map((s) => s.startM)
const ids = (list: readonly { id: string }[]) => list.map((s) => s.id)

/** The sections run on from one another from 0 to the end of the route, each at least a little way past the last. */
function expectPartition(list: readonly ResolvedSection[], length: number) {
  expect(list[0].startM).toBe(0)
  for (let i = 0; i < list.length - 1; i++) {
    expect(list[i].endM).toBe(list[i + 1].startM)
    expect(list[i + 1].startM).toBeGreaterThan(list[i].startM)
  }
  expect(list[list.length - 1].endM).toBeCloseTo(length, 6)
}

const occ = (key: string, atM: number): Occurrence => ({ key, stop: { id: key.split('#')[0], type: 'nothrow', pathIdx: 0, lat: 0, lng: 0 }, idx: 0, at: atM, off: 0 })

describe('the limits on sections', () => {
  it('are a short name, a few hundred sections, a gap of a street, a reach of a block and a few metres of give', () => {
    expect(MAX_SECTION_NAME).toBe(40)
    expect(MAX_SECTIONS).toBe(200)
    expect(SECTION_GAP_M).toBe(25)
    expect(ANCHOR_MAX_M).toBe(100)
    expect(ANCHOR_TOLERANCE_M).toBe(10)
    expect(LEAD_ID).toBe('start')
    expect(LEAD_NAME).toBe('Start of route')
  })
})

describe('cleaning a section name', () => {
  it('tidies spaces, new lines and tabs, and gives nothing for a blank name', () => {
    expect(cleanSectionName('  Oak   Estate ')).toBe('Oak Estate')
    expect(cleanSectionName('Oak\n\tEstate')).toBe('Oak Estate')
    for (const blank of ['', ' ', '   \n\t ']) expect(cleanSectionName(blank), JSON.stringify(blank)).toBeUndefined()
  })

  it('keeps up to 40 characters and cuts the rest', () => {
    expect(cleanSectionName('x'.repeat(40))).toBe('x'.repeat(40))
    expect(cleanSectionName('x'.repeat(41))).toBe('x'.repeat(40))
    expect(cleanSectionName('x'.repeat(500))).toHaveLength(40)
  })

  it('does not count the spaces it takes off towards the 40', () => {
    expect(cleanSectionName(`     ${'x'.repeat(40)}`)).toBe('x'.repeat(40))
    expect(cleanSectionName(`\n\t ${'x'.repeat(45)}  `)).toBe('x'.repeat(40))
  })

  it('does not end in a space, or half of an emoji, after cutting', () => {
    expect(cleanSectionName(`${'x'.repeat(39)} y`)).toBe('x'.repeat(39))
    expect(cleanSectionName(`${'x'.repeat(39)}😀`)).toBe('x'.repeat(39))
    expect(cleanSectionName(`${'x'.repeat(38)}😀`)).toBe(`${'x'.repeat(38)}😀`)
    expect(cleanSectionName(`${'x'.repeat(38)}😀😀`)).toBe(`${'x'.repeat(38)}😀`)
  })

  it('keeps names in other scripts as they are', () => {
    expect(cleanSectionName(' Café  Straße ')).toBe('Café Straße')
    expect(cleanSectionName('山手町')).toBe('山手町')
  })

  it('gives nothing for a name of marks that show nothing, such as zero-width spaces', () => {
    const invisible = ['\u200b', '\u200b\u200b\u200b', '\u200c', '\u200d', '\u200e\u200f', '\u2060', '\u00ad', '\ufeff', '\u180e', '\u3164', '\ufe0f', '\u202e', ' \u200b \u2060\t']
    for (const blank of invisible) expect(cleanSectionName(blank), JSON.stringify(blank)).toBeUndefined()
  })

  it('gives nothing for a name of control characters, and takes them out of the middle of one as it does spaces', () => {
    for (const blank of ['\0', '\0\0', '\u0007', '\u001b', '\u007f', '\u0085', ' \0 \u0001 ']) expect(cleanSectionName(blank), JSON.stringify(blank)).toBeUndefined()
    expect(cleanSectionName('Oak\0Estate')).toBe('Oak Estate')
    expect(cleanSectionName('Oak\u0001\u0002  Estate\u007f')).toBe('Oak Estate')
    expect(cleanSectionName('\0Oak')).toBe('Oak')
  })

  it('keeps the marks that do not show on their own when they are part of a name, as in an emoji or a script that needs them', () => {
    for (const name of ['\u200bOak', 'Oak\u200b', 'Oak\u200bEstate', '\u2764\ufe0f', '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67', '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645']) {
      expect(cleanSectionName(name), JSON.stringify(name)).toBe(name)
    }
  })

  it('judges a name by what is left after it is cut to 40, so a long run of marks that show nothing is nothing', () => {
    expect(cleanSectionName(`${'\u200b'.repeat(40)}Oak`)).toBeUndefined()
    expect(cleanSectionName(`${'\u200b'.repeat(39)}O`)).toBe(`${'\u200b'.repeat(39)}O`)
  })
})

describe('anchoring a section on the route', () => {
  const P = road(11)
  const length = pathLength(P)

  it('is held by the spot on the route, with no pass for the first and a tidy name', () => {
    const a = anchorAt(P, 300, '  Oak   Estate ')!
    expect(a.name).toBe('Oak Estate')
    expect(typeof a.id).toBe('string')
    expect(a.id).not.toBe('')
    expect(haversine(a, at(P, 300))).toBeLessThan(0.01)
    expect('pass' in a).toBe(false)
    expect(Object.keys(a).sort()).toEqual(['id', 'lat', 'lng', 'name'])
  })

  it('uses the id it is given, and makes its own otherwise, never two the same or the one the start stand-in has', () => {
    expect(anchorAt(P, 300, 'A', 'mine')!.id).toBe('mine')
    const made = Array.from({ length: 300 }, () => anchorAt(P, 300, 'A')!.id)
    expect(new Set(made).size).toBe(300)
    expect(made).not.toContain(LEAD_ID)
    expect(anchorAt(P, 300, 'A', '')!.id).not.toBe('')
  })

  it('is kept within the route: past either end is the end', () => {
    expect(haversine(anchorAt(P, -40, 'A')!, P[0])).toBeLessThan(0.01)
    expect(haversine(anchorAt(P, length + 40, 'A')!, P[10])).toBeLessThan(0.01)
    expect(haversine(anchorAt(P, 0, 'A')!, P[0])).toBeLessThan(0.01)
    expect(haversine(anchorAt(P, length, 'A')!, P[10])).toBeLessThan(0.01)
  })

  it('is nothing for a blank name, a distance that is not a number, or a route with no length', () => {
    expect(anchorAt(P, 300, '')).toBeNull()
    expect(anchorAt(P, 300, '  \n ')).toBeNull()
    expect(anchorAt(P, NaN, 'A')).toBeNull()
    expect(anchorAt(P, Infinity, 'A')).toBeNull()
    expect(anchorAt(P, -Infinity, 'A')).toBeNull()
    expect(anchorAt([], 0, 'A')).toBeNull()
    expect(anchorAt([pt(0)], 0, 'A')).toBeNull()
    expect(anchorAt([pt(0), pt(0)], 0, 'A')).toBeNull()
  })

  it('is the first pass on the way out of a road driven out and back, and the second on the way back', () => {
    const OB = outAndBack()
    const total = pathLength(OB)
    const out = anchorAt(OB, 2 * STEP, 'A')!
    const back = anchorAt(OB, total - 2 * STEP, 'B')!
    expect('pass' in out).toBe(false)
    expect(back.pass).toBe(2)
    expect(haversine(out, back)).toBeLessThan(0.01)
    // The first pass is the nearer of the two to the distance asked for, however little in it.
    expect(anchorAt(OB, 2 * STEP + 200, 'C')!.pass).toBeUndefined()
    expect(anchorAt(OB, total - 2 * STEP - 200, 'C')!.pass).toBe(2)
  })

  it('is the first pass up to the far end of a road driven out and back, where the two passes run together', () => {
    const OB = turnBack()
    for (const m of [571, 580, 590, 595, 600]) {
      const a = anchorAt(OB, m, 'Turn')!
      expect(a.pass, String(m)).toBeUndefined()
      expect(startOf(OB, a), String(m)).toBeCloseTo(m, 1)
    }
  })

  it('is refused on the way back from about 5 m to 30 m past the far end, where it would be put on the way out instead', () => {
    const OB = turnBack()
    // Close to the end it comes out in the right place, or the mirror image a few metres off: no further than the give allows.
    for (const d of [1, 2, 3, 4]) {
      const a = anchorAt(OB, 600 + d, 'Turn')
      expect(a, String(d)).not.toBeNull()
      expect(Math.abs(startOf(OB, a!)! - (600 + d)), String(d)).toBeLessThanOrEqual(10)
    }
    // Further on the mirror image is 12 m off or more, up to 58 m.
    for (const d of [6, 10, 15, 20, 25, 29]) expect(anchorAt(OB, 600 + d, 'Turn'), String(d)).toBeNull()
  })

  it('is the second pass again on the way back once past the reach of the way out', () => {
    const OB = turnBack()
    for (const d of [31, 40, 100, 300, 600]) {
      const a = anchorAt(OB, 600 + d, 'Back')!
      expect(a.pass, String(d)).toBe(2)
      expect(startOf(OB, a), String(d)).toBeCloseTo(600 + d, 1)
    }
  })

  it('is nothing when the route offers no pass at the spot, which is not met on a real route', () => {
    vi.mocked(passesNear).mockReturnValueOnce([])
    expect(anchorAt(road(11), 300, 'A')).toBeNull()
    expect(anchorAt(road(11), 300, 'A')).not.toBeNull()
  })

  it('is the second pass again on the way back once past the reach of the way out', () => {
    const OB = outAndBack()
    const tip = 5 * STEP
    for (const d of [31, 40, 100, 300]) {
      const a = anchorAt(OB, tip + d, 'Back')!
      expect(a.pass, String(d)).toBe(2)
      expect(startOf(OB, a), String(d)).toBeCloseTo(tip + d, 1)
    }
  })

  it('tells the start of a loop from its end, which are the same spot', () => {
    const L = loop()
    const total = pathLength(L)
    const first = anchorAt(L, 0, 'Home')!
    const last = anchorAt(L, total, 'Home again')!
    expect(first.pass).toBeUndefined()
    expect(last.pass).toBe(2)
    const resolved = resolveSections(L, [first, last]).list
    expect(starts(resolved).map((m) => Math.round(m))).toEqual([0, Math.round(total)])
  })

  it('is on the pass that the distance is nearest when a route comes back past a spot three times', () => {
    const three = [...road(4), ...road(4).slice(0, 3).reverse(), ...road(4).slice(1)]
    const total = pathLength(three)
    const passes = passesNear(three, pt(2))
    expect(passes).toHaveLength(3)
    for (const [n, p] of passes.entries()) {
      const a = anchorAt(three, p.at, 'X')!
      expect(a.pass ?? 1, `pass ${n + 1}`).toBe(n + 1)
      expect(resolveSections(three, [a]).list.at(-1)!.startM).toBeCloseTo(p.at, 3)
    }
    expect(total).toBeGreaterThan(passes[2].at)
  })
})

describe('anchoring a section where it was asked for', () => {
  /** A repeatable run of numbers from 0 up to 1. */
  const stream = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  /** A road of 12 to 40 stretches, each 20 to 220 m long and turning from the last by whatever `turn` says, in radians. */
  const wander = (next: () => number, turn: () => number): Pt[] => {
    let x = 0
    let y = 0
    let heading = next() * 2 * Math.PI
    const points = [spot(0, 0)]
    for (let i = 12 + Math.floor(next() * 28); i > 0; i--) {
      heading += turn()
      const len = 20 + next() * 200
      x += Math.sin(heading) * len
      y += Math.cos(heading) * len
      points.push(spot(x, y))
    }
    return points
  }
  /** The sharpest turn, in degrees, at a bend within `reach` metres along the route of `m`: 180 is turning right back. */
  const sharpestNear = (points: Pt[], m: number, reach: number): number => {
    const cum = cumulativeDistances(points)
    const bearing = (a: Pt, b: Pt) => Math.atan2((b.lng - a.lng) * Math.cos((51 * Math.PI) / 180), b.lat - a.lat)
    let sharpest = 0
    for (let v = 1; v < points.length - 1; v++) {
      if (Math.abs(cum[v] - m) > reach) continue
      let turn = Math.abs(bearing(points[v - 1], points[v]) - bearing(points[v], points[v + 1])) % (2 * Math.PI)
      if (turn > Math.PI) turn = 2 * Math.PI - turn
      sharpest = Math.max(sharpest, (turn * 180) / Math.PI)
    }
    return sharpest
  }
  const samples = (points: Pt[], next: () => number): number[] => Array.from({ length: 25 }, () => 60 + next() * (pathLength(points) - 60))

  it('is where it was asked for on a road that bends gently, wherever that is', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const next = stream(seed)
      const P = wander(next, () => ((next() - 0.5) * Math.PI) / 3)
      for (const m of samples(P, next)) {
        const a = anchorAt(P, m, 'Here')
        expect(a, `${seed} ${m}`).not.toBeNull()
        expect(Math.abs(startOf(P, a!)! - m), `${seed} ${m}`).toBeLessThan(3)
      }
    }
  })

  it('is where it was asked for or not at all on a road that doubles back on itself, and refused only at a turn right back', () => {
    let placed = 0
    let refused = 0
    for (const sharp of [false, true]) {
      for (let seed = 1; seed <= 40; seed++) {
        const next = stream(seed)
        // Roads on a grid, with turns right back as common as any other, and roads that now and then turn nearly right back.
        const P = wander(next, sharp ? () => (next() < 0.3 ? Math.PI + (next() - 0.5) * 0.4 : next() - 0.5) : () => Math.floor(next() * 4) * (Math.PI / 2))
        for (const m of samples(P, next)) {
          const a = anchorAt(P, m, 'Here')
          if (a) {
            placed++
            expect(Math.abs(startOf(P, a)! - m), `${sharp} ${seed} ${m}`).toBeLessThanOrEqual(ANCHOR_TOLERANCE_M)
          } else {
            refused++
            expect(sharpestNear(P, m, 45), `${sharp} ${seed} ${m}`).toBeGreaterThan(150)
          }
        }
      }
    }
    // Both kinds of road are really met.
    expect(refused).toBeGreaterThan(20)
    expect(placed).toBeGreaterThan(1000)
  })
})

describe('placing sections on the route', () => {
  const P = road(11)
  const length = pathLength(P)

  it('is an empty list for no sections, with no stand-in for the start', () => {
    expect(resolveSections(P, [])).toEqual({ list: [], detached: [] })
  })

  it('has a stand-in for the part before the first section, and runs on to the end of the route', () => {
    const { list, detached } = resolveSections(P, [sec(P, 300, 'a'), sec(P, 700, 'b')])
    expect(detached).toEqual([])
    expect(ids(list)).toEqual([LEAD_ID, 'a', 'b'])
    expect(list.map((s) => s.lead)).toEqual([true, false, false])
    expect(list[0].name).toBe('Start of route')
    expect(LEAD_NAME).toBe('Start of route')
    expect(list[1].name).toBe('Part a')
    expect(starts(list)[1]).toBeCloseTo(300, 4)
    expect(starts(list)[2]).toBeCloseTo(700, 4)
    expectPartition(list, length)
  })

  it('gives each section its own id and name, and does not add anything to the route', () => {
    const stored = [sec(P, 300, 'a')]
    const copy = structuredClone(stored)
    resolveSections(P, stored)
    expect(stored).toEqual(copy)
  })

  it('puts them in route order whatever order they were stored in', () => {
    const a = sec(P, 800, 'late')
    const b = sec(P, 200, 'early')
    const c = sec(P, 500, 'middle')
    for (const order of [[a, b, c], [c, b, a], [b, a, c]]) {
      expect(ids(resolveSections(P, order).list)).toEqual([LEAD_ID, 'early', 'middle', 'late'])
    }
  })

  it('has no stand-in when the first section starts within a street of the start, and that one starts at 0', () => {
    for (const m of [0, 10, SECTION_GAP_M - 1]) {
      const { list } = resolveSections(P, [sec(P, m, 'a'), sec(P, 400, 'b')])
      expect(ids(list), String(m)).toEqual(['a', 'b'])
      expect(list[0].startM).toBe(0)
      expectPartition(list, length)
    }
  })

  it('has a stand-in when the first section starts further in than that', () => {
    for (const m of [SECTION_GAP_M + 1, 60, 400]) {
      const { list } = resolveSections(P, [sec(P, m, 'a')])
      expect(ids(list), String(m)).toEqual([LEAD_ID, 'a'])
      expect(list[0]).toMatchObject({ startM: 0, lead: true })
      expect(list[0].endM).toBeCloseTo(m, 4)
      expect(list[1].startM).toBeCloseTo(m, 4)
    }
  })

  it('is one section from the start to the end for a single section anchored at the start', () => {
    const { list } = resolveSections(P, [sec(P, 0, 'only')])
    expect(list).toEqual([{ id: 'only', name: 'Part only', startM: 0, endM: expect.closeTo(length, 6), lead: false }])
  })

  it('sets aside a section starting within a street of an earlier one, and keeps the earlier', () => {
    const gap = (g: number) => resolveSections(P, [sec(P, 300, 'first'), sec(P, 300 + g, 'second')])
    const near = gap(SECTION_GAP_M - 1)
    expect(ids(near.list)).toEqual([LEAD_ID, 'first'])
    expect(near.detached.map((d) => [d.section.id, d.reason])).toEqual([['second', 'overlap']])
    expect(near.list[1].endM).toBeCloseTo(length, 6)
    const far = gap(SECTION_GAP_M + 1)
    expect(ids(far.list)).toEqual([LEAD_ID, 'first', 'second'])
    expect(far.detached).toEqual([])
  })

  it('keeps whichever of two close sections is first along the route, not the first stored', () => {
    const { list, detached } = resolveSections(P, [sec(P, 310, 'stored first'), sec(P, 300, 'along first')])
    expect(ids(list)).toEqual([LEAD_ID, 'along first'])
    expect(detached.map((d) => d.section.id)).toEqual(['stored first'])
  })

  it('judges each against the last one kept, so a run of close ones leaves every other', () => {
    const run = [0, 20, 40, 60, 80].map((m) => sec(P, 300 + m, `m${m}`))
    const { list, detached } = resolveSections(P, run)
    expect(ids(list)).toEqual([LEAD_ID, 'm0', 'm40', 'm80'])
    expect(detached.map((d) => d.section.id)).toEqual(['m20', 'm60'])
    expect(detached.every((d) => d.reason === 'overlap')).toBe(true)
  })

  it('sets aside two anchored at exactly the same spot, keeping the one stored first', () => {
    const { list, detached } = resolveSections(P, [sec(P, 300, 'one'), sec(P, 300, 'two')])
    expect(ids(list)).toEqual([LEAD_ID, 'one'])
    expect(detached.map((d) => [d.section.id, d.reason])).toEqual([['two', 'overlap']])
  })

  it('sets aside one within a street of the start of the first, even when that has been moved back to 0', () => {
    const { list, detached } = resolveSections(P, [sec(P, 20, 'a'), sec(P, 40, 'b')])
    expect(ids(list)).toEqual(['a'])
    expect(list[0].startM).toBe(0)
    expect(detached.map((d) => d.section.id)).toEqual(['b'])
  })

  it('sets aside a section that lies further than 100 m from the route, and still places the others', () => {
    const near = { id: 'near', name: 'Near', ...beside(P, 500, 90) }
    const far = { id: 'far', name: 'Far', ...beside(P, 500, 110) }
    const { list, detached } = resolveSections(P, [sec(P, 200, 'a'), far, near, sec(P, 800, 'b')])
    expect(detached.map((d) => [d.section.id, d.reason])).toEqual([['far', 'off']])
    expect(ids(list)).toEqual([LEAD_ID, 'a', 'near', 'b'])
    expectPartition(list, length)
  })

  it('gives the sections that are off the route in the order they were stored, apart from those that overlap', () => {
    const offA = { id: 'offA', name: 'A', lat: 52, lng: 1 }
    const offB = { id: 'offB', name: 'B', lat: -10, lng: 100 }
    const { detached } = resolveSections(P, [offB, sec(P, 300, 'x'), sec(P, 305, 'dup'), offA])
    expect(detached.map((d) => [d.section.id, d.reason])).toEqual([['offB', 'off'], ['dup', 'overlap'], ['offA', 'off']])
  })

  it('sets aside a section whose place is not a real one, rather than failing', () => {
    const junk = [{ lat: NaN, lng: 0 }, { lat: 51, lng: NaN }, { lat: Infinity, lng: 0 }, { lat: 51, lng: -Infinity }]
    const { list, detached } = resolveSections(P, [...junk.map((j, i) => ({ id: `j${i}`, name: 'J', ...j })), sec(P, 300, 'fine')])
    expect(ids(list)).toEqual([LEAD_ID, 'fine'])
    expect(detached.map((d) => [d.section.id, d.reason])).toEqual(junk.map((_, i) => [`j${i}`, 'off']))
  })

  it('has nothing placed when every section is off the route, and no stand-in', () => {
    const { list, detached } = resolveSections(P, [{ id: 'x', name: 'X', lat: 40, lng: 40 }])
    expect(list).toEqual([])
    expect(detached).toHaveLength(1)
  })

  it('has nothing placed on a route with no points, or one point, or no length', () => {
    for (const points of [[], [pt(0)]]) {
      const { list, detached } = resolveSections(points, [{ id: 'x', name: 'X', ...pt(0) }])
      expect(list).toEqual([])
      expect(detached.map((d) => [d.section.id, d.reason])).toEqual([['x', 'off']])
    }
  })

  it('places a section on a route of two identical points at its start, with nothing to it', () => {
    const { list } = resolveSections([pt(0), pt(0)], [{ id: 'x', name: 'X', ...pt(0) }])
    expect(list).toEqual([{ id: 'x', name: 'X', startM: 0, endM: 0, lead: false }])
  })

  it('puts a pass 2 anchor on the way back, and a pass 1 anchor at the same spot on the way out', () => {
    const OB = outAndBack()
    const total = pathLength(OB)
    const spotAt = at(OB, 2 * STEP)
    const out: NamedSection = { id: 'out', name: 'Out', ...spotAt }
    const back: NamedSection = { id: 'back', name: 'Back', ...spotAt, pass: 2 }
    const { list } = resolveSections(OB, [back, out])
    expect(ids(list)).toEqual([LEAD_ID, 'out', 'back'])
    expect(list[1].startM).toBeCloseTo(2 * STEP, 3)
    expect(list[2].startM).toBeCloseTo(total - 2 * STEP, 3)
    expect(list[1].endM).toBeCloseTo(list[2].startM, 6)
    expectPartition(list, total)
  })

  it('treats a pass beyond the passes there are as the last, and a pass below 1, a fraction, or not a number as the first or its whole part', () => {
    const OB = outAndBack()
    const total = pathLength(OB)
    const spotAt = at(OB, 2 * STEP)
    const startOf = (pass: unknown) => resolveSections(OB, [{ id: 'x', name: 'X', ...spotAt, pass } as NamedSection]).list.at(-1)!.startM
    const second = total - 2 * STEP
    expect(startOf(2)).toBeCloseTo(second, 3)
    expect(startOf(3)).toBeCloseTo(second, 3)
    expect(startOf(99)).toBeCloseTo(second, 3)
    expect(startOf(2.9)).toBeCloseTo(second, 3)
    for (const first of [1, 1.9, 0, -4, 0.5, NaN, undefined, null, '2', 'x']) expect(startOf(first), String(first)).toBeCloseTo(2 * STEP, 3)
  })

  it('copes with a pass number when the route has been cut to one pass', () => {
    const cut = road(11)
    const gone = { id: 'x', name: 'X', ...at(cut, 400), pass: 2 }
    const { list } = resolveSections(cut, [gone])
    expect(list.at(-1)!.startM).toBeCloseTo(400, 3)
  })

  it('places 200 sections in order, all of them', () => {
    const long = road(80)
    const many = Array.from({ length: 200 }, (_, i) => sec(long, 40 + 31 * i, `n${i}`))
    const { list, detached } = resolveSections(long, many.slice().reverse())
    expect(detached).toEqual([])
    expect(list).toHaveLength(201)
    expect(ids(list).slice(1)).toEqual(many.map((s) => s.id))
    expectPartition(list, pathLength(long))
  })

  it('does not reach for the stand-in id: a section stored as "start" is placed under its own id', () => {
    const { list } = resolveSections(P, [sec(P, 300, LEAD_ID)])
    expect(list.map((s) => [s.id, s.lead])).toEqual([
      [LEAD_ID, true],
      [LEAD_ID, false],
    ])
  })
})

describe('sections staying put when the route is edited', () => {
  const P = road(11)
  const route = asRoute(P)
  const anchors = [sec(P, 300, 'a'), sec(P, 700, 'b')]
  const before = () => starts(resolveSections(P, anchors).list)
  const after = (r: Route) => resolveSections(r.points, anchors)

  it('keeps their places when a point is added in the middle of a segment', () => {
    for (const segment of [0, 2, 5, 9]) {
      const r = insertPoint(route, segment)!.route
      expect(r.points).toHaveLength(12)
      const { list, detached } = after(r)
      expect(detached).toEqual([])
      starts(list).forEach((m, i) => expect(m).toBeCloseTo(before()[i], 1))
    }
  })

  it('keeps their places when a point on the line is taken out', () => {
    for (const index of [1, 3, 6, 9]) {
      const { list, detached } = after(deletePoint(route, index))
      expect(detached).toEqual([])
      starts(list).forEach((m, i) => expect(m).toBeCloseTo(before()[i], 1))
    }
  })

  it('keeps them nearly where they were when a point is moved a few metres', () => {
    const moved = movePoint(route, 5, beside(P, 5 * STEP, 3))
    const { list, detached } = after(moved)
    expect(detached).toEqual([])
    starts(list).forEach((m, i) => expect(Math.abs(m - before()[i])).toBeLessThan(5))
  })

  it('keeps their places when the route is carried on past the end', () => {
    const longer = appendPoint(route, pt(12))
    const { list } = after(longer)
    expect(starts(list).slice(0, 3).map((m) => Math.round(m))).toEqual(before().map((m) => Math.round(m)))
    expect(list.at(-1)!.endM).toBeCloseTo(pathLength(longer.points), 6)
  })

  it('keeps their places when a section is driven again, back along itself', () => {
    const again = repeatSection(route, 0, 'back')!
    expect(again.points.length).toBeGreaterThan(P.length)
    const { list, detached } = after(again)
    expect(detached).toEqual([])
    // The first pass of each is still the first.
    starts(list).forEach((m, i) => expect(m).toBeCloseTo(before()[i], 1))
  })

  it('keeps a pass 2 anchor on pass 2 when points are added elsewhere on either pass or past the end', () => {
    const OB = outAndBack()
    const base = asRoute(OB)
    const second: NamedSection = { id: 'back', name: 'Back', ...at(OB, 2 * STEP), pass: 2 }
    const want = pathLength(OB) - 2 * STEP
    const startOf = (r: Route) => resolveSections(r.points, [second]).list.at(-1)!.startM
    expect(startOf(base)).toBeCloseTo(want, 3)
    // A point in the middle of segments on the first pass, and on the second.
    for (const segment of [0, 1, 3, 4, 5, 7, 9]) expect(startOf(insertPoint(base, segment)!.route), `insert ${segment}`).toBeCloseTo(want, 1)
    // A point added to the end that heads off somewhere else.
    const east = appendPoint(base, { lat: pt(0).lat, lng: 0.01 })
    expect(startOf(east)).toBeCloseTo(want, 3)
    const south = appendPoint(base, { lat: pt(0).lat - 0.003, lng: 0 })
    expect(startOf(south)).toBeCloseTo(want, 3)
  })

  it('keeps a pass 2 anchor on pass 2 when the road is driven a third time', () => {
    const OB = outAndBack()
    const third = appendPoints(asRoute(OB), [pt(1), pt(2), pt(3), pt(4)])
    const second: NamedSection = { id: 'back', name: 'Back', ...at(OB, 2 * STEP), pass: 2 }
    const first: NamedSection = { id: 'out', name: 'Out', ...at(OB, 2 * STEP) }
    expect(passesNear(third.points, pt(2))).toHaveLength(3)
    const { list } = resolveSections(third.points, [first, second])
    expect(list.slice(1).map((s) => s.id)).toEqual(['out', 'back'])
    expect(list[1].startM).toBeCloseTo(2 * STEP, 1)
    expect(list[2].startM).toBeCloseTo(pathLength(OB) - 2 * STEP, 1)
  })

  it('sets a section aside when the road it was on is taken out of the route', () => {
    const short = deletePoint(deletePoint(deletePoint(route, 10), 9), 8)
    const { list, detached } = resolveSections(short.points, [sec(P, 950, 'gone'), sec(P, 300, 'stays')])
    expect(detached.map((d) => [d.section.id, d.reason])).toEqual([['gone', 'off']])
    expect(ids(list)).toEqual([LEAD_ID, 'stays'])
  })
})

describe('adding a section', () => {
  const P = road(11)
  const length = pathLength(P)

  it('adds one at the distance asked, after the others in storage order, leaving the others as they were', () => {
    const existing = [sec(P, 700, 'b')]
    const result = addSection(P, existing, 300, '  Oak   Estate ')!
    expect(result.added.name).toBe('Oak Estate')
    expect(result.sections).toEqual([existing[0], result.added])
    expect(existing).toHaveLength(1)
    const { list } = resolveSections(P, result.sections)
    expect(ids(list)).toEqual([LEAD_ID, result.added.id, 'b'])
    expect(list[1].startM).toBeCloseTo(300, 3)
  })

  it('adds the first section of a route', () => {
    const result = addSection(P, [], 400, 'Hill')!
    expect(result.sections).toEqual([result.added])
    expectPartition(resolveSections(P, result.sections).list, length)
  })

  it('refuses one within a street of another section either side, and takes one just further away', () => {
    const existing = [sec(P, 500, 'x')]
    for (const m of [500, 500 - SECTION_GAP_M + 1, 500 + SECTION_GAP_M - 1, 490, 510]) expect(addSection(P, existing, m, 'N'), String(m)).toBeNull()
    for (const m of [500 - SECTION_GAP_M - 1, 500 + SECTION_GAP_M + 1, 300, 800]) {
      const added = addSection(P, existing, m, 'N')
      expect(added, String(m)).not.toBeNull()
      expect(resolveSections(P, added!.sections).detached).toEqual([])
    }
  })

  it('refuses one that would cut off the first, which lies near the start', () => {
    expect(addSection(P, [sec(P, 30, 'x')], 10, 'N')).toBeNull()
    expect(addSection(P, [sec(P, 30, 'x')], 6, 'N')).toBeNull()
    expect(addSection(P, [sec(P, 30, 'x')], 4, 'N')).not.toBeNull()
    expect(addSection(P, [sec(P, 30, 'x')], 0, 'N')).not.toBeNull()
    expect(addSection(P, [sec(P, 30, 'x')], 60, 'N')).not.toBeNull()
  })

  it('takes one at the very start when the stand-in is what it is naming', () => {
    const result = addSection(P, [sec(P, 400, 'x')], 0, 'Home')!
    const { list } = resolveSections(P, result.sections)
    expect(ids(list)).toEqual([result.added.id, 'x'])
    expect(list[0]).toMatchObject({ name: 'Home', startM: 0, lead: false })
  })

  it('is not held back by a section that is off the route and so has no place', () => {
    const lost: NamedSection = { id: 'lost', name: 'Lost', lat: 40, lng: 40 }
    expect(addSection(P, [lost], 300, 'N')).not.toBeNull()
  })

  it('refuses a blank name, a route with no length, and a distance that is not a number', () => {
    expect(addSection(P, [], 300, '  ')).toBeNull()
    expect(addSection([], [], 0, 'N')).toBeNull()
    expect(addSection([pt(0)], [], 0, 'N')).toBeNull()
    expect(addSection(P, [], NaN, 'N')).toBeNull()
  })

  it('refuses once there are 200, and takes the 200th', () => {
    const long = road(80)
    const nearly = Array.from({ length: 199 }, (_, i) => sec(long, 100 + 31 * i, `n${i}`))
    const full = addSection(long, nearly, 40, 'Last one')!
    expect(full.sections).toHaveLength(200)
    expect(addSection(long, full.sections, 6000 + 500, 'One too many')).toBeNull()
  })

  it('gives each section it adds an id that no other has, even in a rush', () => {
    const long = road(80)
    let sections: NamedSection[] = []
    for (let i = 0; i < 40; i++) sections = addSection(long, sections, 40 + 31 * i, `S${i}`)!.sections
    expect(new Set(ids(sections)).size).toBe(40)
    expect(ids(sections)).not.toContain(LEAD_ID)
  })

  it('does not hand out an id that a section already has', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      // With the random part fixed, the ids come one after another, so the one coming next can be taken in advance.
      const probe = anchorAt(P, 100, 'probe')!.id
      const match = /^sec([0-9a-z]+)i$/.exec(probe)!
      const next = (n: number) => `sec${(parseInt(match[1], 36) + n).toString(36)}i`
      const result = addSection(P, [sec(P, 800, next(1))], 300, 'N')!
      expect(result.added.id).toBe(next(2))
      expect(result.added.id).not.toBe(next(1))
    } finally {
      random.mockRestore()
    }
  })

  it('puts a second pass section on the way back over a spot that has a first pass section on the way out', () => {
    const OB = outAndBack()
    const total = pathLength(OB)
    const out = addSection(OB, [], 2 * STEP, 'Out')!
    const both = addSection(OB, out.sections, total - 2 * STEP, 'Back')!
    expect(both.added.pass).toBe(2)
    const { list, detached } = resolveSections(OB, both.sections)
    expect(detached).toEqual([])
    expect(list.map((s) => s.name)).toEqual([LEAD_NAME, 'Out', 'Back'])
  })

  it('refuses a spot just past the far end of a road driven out and back, rather than start it on the way out', () => {
    // 600 m out and the same line back: a start 20 m past the end on the way back would be put 40 m short of it, on the way out.
    const OB = turnBack()
    expect(addSection(OB, [], 620, 'Back')).toBeNull()
    const existing = [sec(OB, 200, 'x')]
    for (const m of [606, 610, 620, 629]) expect(addSection(OB, existing, m, 'Back'), String(m)).toBeNull()
    // Short of the end, at it, and well past it, the start is where it was asked for.
    for (const m of [571, 580, 590, 600]) {
      const added = addSection(OB, existing, m, 'Out')!
      expect(added.added.pass, String(m)).toBeUndefined()
      expect(startOf(OB, added.added), String(m)).toBeCloseTo(m, 1)
    }
    for (const m of [631, 640, 700]) {
      const added = addSection(OB, existing, m, 'Back')!
      expect(added.added.pass, String(m)).toBe(2)
      expect(startOf(OB, added.added), String(m)).toBeCloseTo(m, 1)
    }
  })

  it('refuses a spot within a street of the end of the route, which would have next to nothing in it', () => {
    const last = length - SECTION_GAP_M
    for (const m of [length, length - 5, length - 20, last + 0.5]) expect(addSection(P, [], m, 'End'), String(m)).toBeNull()
    expect(addSection(P, [], length + 100, 'End')).toBeNull()
    for (const m of [last, last - 1, last - 100]) {
      const added = addSection(P, [], m, 'End')
      expect(added, String(m)).not.toBeNull()
      const section = resolveSections(P, added!.sections).list.at(-1)!
      expect(section.endM - section.startM, String(m)).toBeGreaterThanOrEqual(SECTION_GAP_M - 0.001)
    }
    // The same for a route with others on it.
    expect(addSection(P, [sec(P, 300, 'x')], length - 10, 'End')).toBeNull()
  })

  it('refuses any spot on a route shorter than a street, which has no room for a section', () => {
    const short = [pt(0), { lat: pt(0).lat + 0.0001, lng: 0 }]
    expect(pathLength(short)).toBeLessThan(SECTION_GAP_M)
    for (const m of [0, 5, 11, 50]) expect(addSection(short, [], m, 'N'), String(m)).toBeNull()
  })

  it('still lets anchorAt put a section at the very end, as a loop that is named at the spot it ends at needs', () => {
    expect(anchorAt(P, length, 'End')).not.toBeNull()
  })

  it('finds the passes at each section once, not again for each check that is made', () => {
    const calls = vi.mocked(passesNear)
    const long = road(40)
    const existing = Array.from({ length: 10 }, (_, i) => sec(long, 100 + 200 * i, `n${i}`))
    calls.mockClear()
    const added = addSection(long, existing, 2300, 'New')!
    // One walk of the route for each of the ten that were there and one for the new one.
    expect(calls).toHaveBeenCalledTimes(11)
    expect(added.sections).toHaveLength(11)
    calls.mockClear()
    resolveSections(long, added.sections)
    expect(calls).toHaveBeenCalledTimes(11)
  })

  it('finds the passes of two sections at the same spot once, and gives each its own pass', () => {
    const OB = outAndBack()
    const total = pathLength(OB)
    const out = anchorAt(OB, 2 * STEP, 'Out')!
    const back = anchorAt(OB, total - 2 * STEP, 'Back')!
    const calls = vi.mocked(passesNear)
    calls.mockClear()
    const { list } = resolveSections(OB, [out, back])
    expect(calls).toHaveBeenCalledTimes(1)
    expect(list.map((x) => x.name)).toEqual([LEAD_NAME, 'Out', 'Back'])
    expect(list[2].startM).toBeCloseTo(total - 2 * STEP, 1)
  })

  it('refuses a spot on the way back that is within a street of a section there', () => {
    const OB = outAndBack()
    const total = pathLength(OB)
    const back = addSection(OB, [], total - 2 * STEP, 'Back')!
    expect(addSection(OB, back.sections, total - 2 * STEP + 10, 'Near')).toBeNull()
    expect(addSection(OB, back.sections, total - 2 * STEP - 10, 'Near')).toBeNull()
    // The same spot on the way out is a hundreds of metres from it along the route.
    expect(addSection(OB, back.sections, 2 * STEP, 'Out')).not.toBeNull()
  })
})

describe('renaming and removing a section', () => {
  const P = road(11)
  const base: NamedSection[] = [sec(P, 200, 'a'), sec(P, 500, 'b', { pass: 2 }), sec(P, 800, 'c')]

  it('renames one, keeping its place, spot and pass and everything else as it was', () => {
    const next = renameSection(base, 'b', '  New   name ')
    expect(next).toEqual([base[0], { ...base[1], name: 'New name' }, base[2]])
    expect(next[1].pass).toBe(2)
    expect(base[1].name).toBe('Part b')
  })

  it('cuts a long new name to 40 characters', () => {
    expect(renameSection(base, 'a', 'y'.repeat(60))[0].name).toBe('y'.repeat(40))
  })

  it('leaves the sections as they were for a blank name or an id there is not', () => {
    expect(renameSection(base, 'b', '   ')).toEqual(base)
    expect(renameSection(base, 'b', '')).toEqual(base)
    expect(renameSection(base, 'zzz', 'Name')).toEqual(base)
    expect(renameSection([], 'a', 'Name')).toEqual([])
  })

  it('allows two sections to have the same name', () => {
    expect(renameSection(base, 'c', 'Part a').map((s) => s.name)).toEqual(['Part a', 'Part b', 'Part a'])
  })

  it('removes one and keeps the others in order', () => {
    expect(removeSection(base, 'b')).toEqual([base[0], base[2]])
    expect(removeSection(base, 'a')).toEqual([base[1], base[2]])
    expect(removeSection([base[0]], 'a')).toEqual([])
    expect(base).toHaveLength(3)
  })

  it('leaves the sections as they were for an id there is not, including the stand-in, which is not stored', () => {
    expect(removeSection(base, 'zzz')).toEqual(base)
    expect(removeSection(base, LEAD_ID)).toEqual(base)
  })

  it('brings back the stand-in for the start when the first section is removed', () => {
    const first = resolveSections(P, [sec(P, 0, 'first'), sec(P, 400, 'second')]).list
    expect(ids(first)).toEqual(['first', 'second'])
    const without = resolveSections(P, removeSection([sec(P, 0, 'first'), sec(P, 400, 'second')], 'first')).list
    expect(ids(without)).toEqual([LEAD_ID, 'second'])
    expect(without[0].endM).toBeCloseTo(400, 3)
  })

  it('lets the section before take over the stretch of one that is removed', () => {
    const list = resolveSections(P, removeSection(base, 'b')).list
    expect(ids(list)).toEqual([LEAD_ID, 'a', 'c'])
    expect(list[1].endM).toBe(list[2].startM)
  })
})

describe('which section a distance is in', () => {
  const list: ResolvedSection[] = [
    { id: 'start', name: LEAD_NAME, startM: 0, endM: 300, lead: true },
    { id: 'a', name: 'A', startM: 300, endM: 700, lead: false },
    { id: 'b', name: 'B', startM: 700, endM: 1000, lead: false },
  ]
  const idAt = (along: number) => sectionAt(list, along)?.id ?? null

  it('is the section whose stretch it lies in', () => {
    expect(idAt(0)).toBe('start')
    expect(idAt(150)).toBe('start')
    expect(idAt(500)).toBe('a')
    expect(idAt(850)).toBe('b')
  })

  it('gives a boundary to the section that starts there, with a hair either side', () => {
    expect(idAt(299.999)).toBe('start')
    expect(idAt(300)).toBe('a')
    expect(idAt(300.001)).toBe('a')
    expect(idAt(699.999)).toBe('a')
    expect(idAt(700)).toBe('b')
  })

  it('gives the end of the route, and anything beyond it, to the last section', () => {
    expect(idAt(999.999)).toBe('b')
    expect(idAt(1000)).toBe('b')
    expect(idAt(5000)).toBe('b')
    expect(idAt(Infinity)).toBe('b')
  })

  it('gives anything before the start to the first section', () => {
    expect(idAt(-1)).toBe('start')
    expect(idAt(-Infinity)).toBe('start')
  })

  it('is nothing for no sections and for a distance that is not a number', () => {
    expect(sectionAt([], 100)).toBeNull()
    expect(idAt(NaN)).toBeNull()
  })

  it('is the only section for a list of one, wherever the distance', () => {
    const one: ResolvedSection[] = [{ id: 'only', name: 'Only', startM: 0, endM: 100, lead: false }]
    for (const along of [-5, 0, 50, 100, 500]) expect(sectionAt(one, along)?.id, String(along)).toBe('only')
  })

  it('returns the very section object in the list', () => {
    expect(sectionAt(list, 500)).toBe(list[1])
  })
})

describe('the stops left in each section', () => {
  const list: ResolvedSection[] = [
    { id: 'start', name: LEAD_NAME, startM: 0, endM: 300, lead: true },
    { id: 'a', name: 'A', startM: 300, endM: 700, lead: false },
    { id: 'b', name: 'B', startM: 700, endM: 1000, lead: false },
  ]
  const occs = [occ('s1', 100), occ('s2', 299), occ('s3', 300), occ('s4', 500), occ('s4#2', 650), occ('s5', 700), occ('s6', 1000), occ('s7', 1200)]
  const status = (handled: string[] = []) => sectionStatus(list, occs, new Set(handled))

  it('counts the stops met in each section, with one at a boundary in the section that starts there', () => {
    expect(status()).toEqual([
      { id: 'start', total: 2, left: 2 },
      { id: 'a', total: 3, left: 3 },
      { id: 'b', total: 3, left: 3 },
    ])
  })

  it('counts a street driven twice once for each pass, in the section of that pass', () => {
    const doubled = [occ('x', 100), occ('x#2', 900)]
    expect(sectionStatus(list, doubled, new Set())).toEqual([
      { id: 'start', total: 1, left: 1 },
      { id: 'a', total: 0, left: 0 },
      { id: 'b', total: 1, left: 1 },
    ])
  })

  it('takes off those done, going by the key of each pass', () => {
    expect(status(['s1', 's4#2', 's6'])).toEqual([
      { id: 'start', total: 2, left: 1 },
      { id: 'a', total: 3, left: 2 },
      { id: 'b', total: 3, left: 2 },
    ])
    // The first pass done does not do the second.
    expect(status(['s4'])[1]).toEqual({ id: 'a', total: 3, left: 2 })
    expect(status(['s4', 's4#2'])[1]).toEqual({ id: 'a', total: 3, left: 1 })
  })

  it('has nothing left when everything is done, and ignores keys that match no stop', () => {
    const all = occs.map((o) => o.key)
    expect(sectionStatus(list, occs, new Set([...all, 'unknown'])).map((s) => s.left)).toEqual([0, 0, 0])
    expect(status(['unknown', 's1#2'])).toEqual(status())
  })

  it('is a zero for every section when there are no stops', () => {
    expect(sectionStatus(list, [], new Set())).toEqual(list.map((s) => ({ id: s.id, total: 0, left: 0 })))
  })

  it('passes over a stop that has no place along the route and goes on to count the ones after it', () => {
    const one: ResolvedSection[] = [{ id: 'a', name: 'A', startM: 0, endM: 100, lead: false }]
    expect(sectionStatus(one, [occ('bad', NaN), occ('ok', 50)], new Set())).toEqual([{ id: 'a', total: 1, left: 1 }])
    expect(sectionStatus(one, [occ('ok', 50), occ('bad', NaN), occ('ok2', 60)], new Set(['ok2']))).toEqual([{ id: 'a', total: 2, left: 1 }])
  })

  it('is nothing for no sections', () => {
    expect(sectionStatus([], occs, new Set())).toEqual([])
  })

  it('counts the stops a real route meets, each in the section it is met in', () => {
    const P = road(11)
    const stops = [0.5, 3.2, 6.5, 9.9].map((k, i) => ({ id: `r${i}`, type: 'nothrow' as const, pathIdx: 0, ...spot(5, k * STEP) }))
    const real = occurrences({ points: P, stops })
    expect(real).toHaveLength(4)
    const resolved = resolveSections(P, [sec(P, 4 * STEP, 'mid'), sec(P, 8 * STEP, 'late')]).list
    expect(sectionStatus(resolved, real, new Set(['r0', 'r2'])).map((s) => [s.id, s.total, s.left])).toEqual([
      [LEAD_ID, 2, 1],
      ['mid', 1, 0],
      ['late', 1, 1],
    ])
  })
})

describe('the stops of a street driven twice, section by section', () => {
  it('puts each pass of a stop in the section of that pass', () => {
    const OB = outAndBack()
    const total = pathLength(OB)
    const stops = [2, 4].map((k, i) => ({ id: `x${i}`, type: 'nothrow' as const, pathIdx: 0, ...spot(5, k * STEP) }))
    const occs = occurrences({ points: OB, stops })
    expect(occs.map((o) => o.key).sort()).toEqual(['x0', 'x0#2', 'x1', 'x1#2'])
    // One section covers the way out, one starts at the far end and one is the way back.
    const sections = [sec(OB, 100, 'out'), sec(OB, 5 * STEP + 40, 'back')]
    const { list } = resolveSections(OB, sections)
    expect(ids(list)).toEqual([LEAD_ID, 'out', 'back'])
    const status = sectionStatus(list, occs, new Set(['x0', 'x1#2']))
    expect(status).toEqual([
      { id: LEAD_ID, total: 0, left: 0 },
      { id: 'out', total: 2, left: 1 },
      { id: 'back', total: 2, left: 1 },
    ])
    expect(list[2].endM).toBeCloseTo(total, 6)
  })
})

describe('reading sections back from storage', () => {
  const good = (extra: Record<string, unknown> = {}) => ({ id: 'a', name: 'Oak', lat: 51, lng: 0, ...extra })

  it('gives none for anything that is not a list', () => {
    for (const junk of [null, undefined, 0, 7, 'text', true, {}, { 0: good() }, () => [good()]]) expect(normalizeSections(junk), String(junk)).toEqual([])
  })

  it('gives none for an empty list', () => {
    expect(normalizeSections([])).toEqual([])
  })

  it('keeps good sections exactly as they were, and is the same read twice', () => {
    const stored = [good(), good({ id: 'b', name: 'Elm', lat: -33.87, lng: 151.2, pass: 3 })]
    const read = normalizeSections(stored)
    expect(read).toEqual(stored)
    expect(normalizeSections(read)).toEqual(read)
    expect(normalizeSections(JSON.parse(JSON.stringify(read)))).toEqual(read)
  })

  it('drops what is not an object', () => {
    for (const junk of [null, undefined, 5, 'x', true, [], [good()], () => 0]) expect(normalizeSections([junk]), String(junk)).toEqual([])
    expect(normalizeSections([null, good(), 'x', good({ id: 'b' })])).toHaveLength(2)
  })

  it('drops a place that is missing, not a number, not finite, or not on Earth, and keeps the edges that are', () => {
    for (const bad of [{ lat: undefined }, { lng: undefined }, { lat: '51' }, { lng: '0' }, { lat: NaN }, { lng: NaN }, { lat: Infinity }, { lng: -Infinity }, { lat: null }, { lat: 90.001 }, { lat: -90.001 }, { lng: 180.001 }, { lng: -180.001 }, { lat: 1e9 }]) {
      expect(normalizeSections([good(bad)]), JSON.stringify(bad)).toEqual([])
    }
    for (const edge of [{ lat: 90 }, { lat: -90 }, { lng: 180 }, { lng: -180 }, { lat: 0, lng: 0 }]) expect(normalizeSections([good(edge)]), JSON.stringify(edge)).toHaveLength(1)
  })

  it('drops a name that is missing, not text, or blank, and tidies and cuts the rest', () => {
    for (const bad of [{ name: undefined }, { name: 5 }, { name: null }, { name: '' }, { name: '   ' }, { name: '\n\t' }, { name: ['Oak'] }]) {
      expect(normalizeSections([good(bad)]), JSON.stringify(bad)).toEqual([])
    }
    expect(normalizeSections([good({ name: '  Oak   Estate ' })])[0].name).toBe('Oak Estate')
    expect(normalizeSections([good({ name: 'z'.repeat(90) })])[0].name).toBe('z'.repeat(40))
  })

  it('drops a name that shows nothing, and takes control characters out of one that does', () => {
    for (const name of ['\u200b\u200b', '\u2060', '\ufeff', '\0', '\u0007\u200b']) expect(normalizeSections([good({ name })]), JSON.stringify(name)).toEqual([])
    expect(normalizeSections([good({ name: 'Oak\0Estate' })])[0].name).toBe('Oak Estate')
    // Good ones either side of a name that shows nothing are kept.
    expect(normalizeSections([good({ id: 'a' }), good({ id: 'b', name: '\u200b' }), good({ id: 'c' })]).map((x) => x.id)).toEqual(['a', 'c'])
  })

  it('drops a pass that is not a number, and keeps one to whole numbers from 1 to 99, none when 1', () => {
    for (const bad of ['2', null, NaN, Infinity, -Infinity, {}, [], true]) expect(normalizeSections([good({ pass: bad })]), String(bad)).toEqual([])
    const pass = (p: number) => normalizeSections([good({ pass: p })])[0]
    expect('pass' in pass(1)).toBe(false)
    expect(pass(2).pass).toBe(2)
    expect(pass(98).pass).toBe(98)
    expect(pass(99).pass).toBe(99)
    expect(pass(100).pass).toBe(99)
    expect(pass(1e9).pass).toBe(99)
    expect(pass(2.9).pass).toBe(2)
    expect(pass(3.5).pass).toBe(3)
    for (const low of [0, -1, -50, 0.4, 1.9]) expect('pass' in pass(low), String(low)).toBe(false)
  })

  it('reads a pass that is left out as the first', () => {
    expect('pass' in normalizeSections([good()])[0]).toBe(false)
    expect('pass' in normalizeSections([good({ pass: undefined })])[0]).toBe(false)
  })

  it('keeps an id that is text and not used yet, and makes a new one for the rest', () => {
    const read = normalizeSections([good({ id: 'keep' }), good({ id: 'keep' }), good({ id: '' }), good({ id: 7 }), good({ id: undefined }), good({ id: null })])
    expect(read).toHaveLength(6)
    expect(read[0].id).toBe('keep')
    expect(new Set(ids(read)).size).toBe(6)
    for (const s of read.slice(1)) expect(s.id).not.toBe('')
    expect(typeof read[3].id).toBe('string')
  })

  it('does not let a section take the id of the start stand-in', () => {
    const read = normalizeSections([good({ id: LEAD_ID })])
    expect(read).toHaveLength(1)
    expect(read[0].id).not.toBe(LEAD_ID)
  })

  it('does not let a made-up id take one that a later section already has', () => {
    const read = normalizeSections([good({ id: 7 }), good({ id: 'a' }), good({ id: 'a' })])
    expect(new Set(ids(read)).size).toBe(3)
    expect(read[1].id).toBe('a')
  })

  it('keeps no more than 200, the first 200 good ones, whatever junk comes before and between', () => {
    const lots = Array.from({ length: 250 }, (_, i) => good({ id: `n${i}`, name: `Part ${i}` }))
    const read = normalizeSections(lots)
    expect(read).toHaveLength(200)
    expect(ids(read)).toEqual(lots.slice(0, 200).map((s) => s.id))
    const messy = [...Array.from({ length: 60 }, () => null), ...lots.flatMap((s) => [s, 'junk'])]
    expect(ids(normalizeSections(messy))).toEqual(ids(read))
    expect(normalizeSections(lots.slice(0, 199))).toHaveLength(199)
    expect(normalizeSections(lots.slice(0, 200))).toHaveLength(200)
    expect(normalizeSections(lots.slice(0, 201))).toHaveLength(200)
  })

  it('keeps only the parts of a section it knows, and gives back new objects', () => {
    const stored = good({ evil: 'yes', __proto__: { polluted: true }, extra: { deep: 1 } })
    const [read] = normalizeSections([stored])
    expect(Object.keys(read).sort()).toEqual(['id', 'lat', 'lng', 'name'])
    expect(read).not.toBe(stored)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('does not change what it was given', () => {
    const stored = [good({ name: '  x ', pass: 120 }), null]
    const copy = structuredClone(stored)
    normalizeSections(stored)
    expect(stored).toEqual(copy)
  })

  it('copes with a list that has holes in it', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(normalizeSections([, good(), , ] as unknown[])).toHaveLength(1)
  })
})

describe('where a section starts on the map', () => {
  const P = road(11)

  it('is the point that far along the route', () => {
    for (const m of [0, 150, 500, 1000]) expect(haversine(sectionPoint(P, { startM: m }), at(P, m)), String(m)).toBeLessThan(0.01)
  })

  it('is the start of the route for a distance before it, and the end for one past it', () => {
    expect(sectionPoint(P, { startM: -30 })).toEqual(P[0])
    expect(haversine(sectionPoint(P, { startM: 1e6 }), P[10])).toBeLessThan(0.01)
  })

  it('is a point of the section that was resolved, the stand-in included', () => {
    const { list } = resolveSections(P, [sec(P, 400, 'a')])
    expect(haversine(sectionPoint(P, list[0]), P[0])).toBeLessThan(0.01)
    expect(haversine(sectionPoint(P, list[1]), at(P, 400))).toBeLessThan(0.01)
  })

  it('is the one point of a route that has only one, and a made-up place when there is none, rather than failing', () => {
    expect(sectionPoint([pt(3)], { startM: 100 })).toEqual(pt(3))
    expect(sectionPoint([], { startM: 100 })).toEqual({ lat: 0, lng: 0 })
  })
})
