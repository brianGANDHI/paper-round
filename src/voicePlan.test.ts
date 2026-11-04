import { describe, expect, it } from 'vitest'
import { alertable, alertRadius, quietReachFor, SPOKEN_ROW_MAX, zoneExit, type AlertDistance } from './alerts'
import { approachingOccurrences, occurrences, pathLength, snapAtDistance, type Occurrence } from './geo'
import { alertWordsStale, planVoice, type DriverNow, type VoiceInput } from './voicePlan'
import type { Pt, Route, Side, SideChange, Stop, StopType } from './types'

/** A spot `x` metres east and `y` metres north of a start at 51 degrees north, for routes with exact distances. */
const M_PER_DEG = (6371000 * Math.PI) / 180
const spot = (x: number, y: number): Pt => ({ lat: 51 + y / M_PER_DEG, lng: x / (M_PER_DEG * Math.cos((51 * Math.PI) / 180)) })

/** A road north from the start, 1000 m long, with a point every 100 m. The east is its right and the west its left. */
const north: Pt[] = Array.from({ length: 11 }, (_, i) => spot(0, i * 100))
const sides = (...c: [number, Side][]): SideChange[] => c.map(([idx, side]) => ({ idx, side }))
const house = (id: string, x: number, y: number, extra: Partial<Stop> = {}): Stop => ({ id, type: 'nothrow', pathIdx: 0, ...spot(x, y), address: `${id} Oak Road`, ...extra })
/** East houses are numbered by how far up the road they are, west houses by that plus one: the number says which side and where. */
const east = (y: number) => house(String(y), 12, y)
const west = (y: number) => house(String(y + 1), -12, y)
const houses = (from: number, to: number, gap = 20): Stop[] => {
  const out: Stop[] = []
  for (let y = from; y <= to; y += gap) out.push(east(y), west(y))
  return out
}

/** The house numbers a spoken line names (not the count in "and 2 more"). */
const numbers = (text: string): number[] => [...text.replace(/and \d+ more/g, '').matchAll(/\b\d+\b/g)].map((m) => Number(m[0]))

/**
 * Drives a route the way the round screen does on every fix: the stops coming up, the ones left behind, the beep (a stop in the queue)
 * and the words. Gives what was said and where, and which stops came up. The car follows the route's own shape: its place and the
 * segment it is on (so the side thrown) are the route's at that distance along it, to its end unless `to` says otherwise.
 */
function drive(route: Route, options: { distance?: AlertDistance; step?: number; to?: number } = {}) {
  const distance = options.distance ?? 40
  const radius = alertRadius(distance)
  const allOccs = occurrences(route)
  const occs = alertable(route, allOccs, quietReachFor(distance))
  const handled = new Set<string>()
  const seen = new Set<string>()
  const announced = new Set<string>()
  let held = new Set<string>()
  let queue: Occurrence[] = []
  const said: { along: number; text: string }[] = []
  const cameUp: { along: number; key: string }[] = []
  const end = options.to ?? pathLength(route.points)
  for (let along = 0; along <= end; along += options.step ?? 5) {
    const { point: pos, idx } = snapAtDistance(route.points, along)!
    const left = queue.filter((o) => zoneExit(o, along, radius, pos))
    for (const l of left) if (zoneExit(l, along, radius, pos) === 'passed') handled.add(l.key)
    queue = queue.filter((o) => !left.includes(o))
    const fresh = approachingOccurrences(along, pos, occs, handled, radius, 0).filter((o) => !seen.has(o.key))
    for (const o of fresh) {
      seen.add(o.key)
      cameUp.push({ along, key: o.key })
    }
    const input: VoiceInput = { route, allOccs, occs, handled, radius, queue, fresh, announced, held, driver: { idx, along, driven: along, pos } }
    const plan = planVoice(input)
    for (const key of plan.announce) announced.add(key)
    held = new Set(plan.held)
    if (plan.text) said.push({ along, text: plan.text })
    queue = [...queue, ...fresh]
  }
  return { said, cameUp, spoken: said.flatMap((s) => numbers(s.text)) }
}

describe('the houses of the stretch after a change of side', () => {
  // Left to 500 m and Right from there, with a house each side every 20 m.
  const route: Route = { points: north, sideChanges: sides([0, 'left'], [5, 'right']), stops: houses(10, 990) }
  const run = drive(route)

  it('are not named while the driver is still on the other side, though their beep is up', () => {
    // The first right-hand house, 510 m up the road, comes up at 470 m: 30 m before the Right stretch starts.
    const early = run.cameUp.filter((c) => Number(c.key) % 2 === 0 && Number(c.key) >= 500 && c.along < 500)
    expect(early.length).toBeGreaterThan(0)
    const before = run.said.filter((s) => s.along < 500).flatMap((s) => numbers(s.text))
    expect(before.length).toBeGreaterThan(0)
    // Every number named before the change is a left-hand one: odd, and on the Left stretch.
    for (const n of before) expect(n % 2, `${n} named before the change`).toBe(1)
  })

  it('are named as the driver crosses the change, in the row they make', () => {
    const first = run.said.find((s) => s.along >= 500)
    expect(first?.along).toBe(500)
    expect(numbers(first?.text ?? '').every((n) => n % 2 === 0 && n >= 500)).toBe(true)
    expect(first?.text.startsWith('No throw, 510, 530')).toBe(true)
  })

  it('are each named exactly once, and every one that came up is named', () => {
    expect(new Set(run.spoken).size).toBe(run.spoken.length)
    const alerting = run.cameUp.map((c) => Number(c.key))
    for (const n of alerting) expect(run.spoken, `${n} came up`).toContain(n)
  })
})

describe('the voice at the change from Right to Left', () => {
  it('is the same the other way about: left-hand houses wait for the Left stretch', () => {
    const route: Route = { points: north, sideChanges: sides([0, 'right'], [5, 'left']), stops: houses(10, 990) }
    const run = drive(route)
    const before = run.said.filter((s) => s.along < 500).flatMap((s) => numbers(s.text))
    expect(before.length).toBeGreaterThan(0)
    for (const n of before) expect(n % 2, `${n} named before the change`).toBe(0)
    expect(run.said.find((s) => s.along >= 500)?.along).toBe(500)
    expect(new Set(run.spoken).size).toBe(run.spoken.length)
  })
})

describe('houses gone by before the driver is on their side', () => {
  it('are dropped without being named, when the fixes are far enough apart to pass them', () => {
    const route: Route = { points: north, sideChanges: sides([0, 'left'], [5, 'right']), stops: houses(10, 990) }
    const run = drive(route, { step: 40 })
    // 480 m is on the Left stretch: the right-hand house at 510 came up. At the next fix, 520 m, the driver is on the Right stretch and
    // has gone 10 m past it.
    const first = run.said.find((s) => numbers(s.text).some((n) => n % 2 === 0 && n >= 500))
    expect(first?.along).toBe(520)
    expect(run.cameUp.some((c) => c.key === '510' && c.along === 480)).toBe(true)
    expect(run.spoken).not.toContain(510)
    expect(new Set(run.spoken).size).toBe(run.spoken.length)
    // The houses still ahead at that fix are named.
    expect(numbers(first?.text ?? '').slice(0, 2)).toEqual([530, 550])
  })
})

describe('a stretch of transit', () => {
  const route: Route = { points: north, sideChanges: sides([0, 'transit'], [5, 'left']), stops: houses(10, 990) }
  const run = drive(route)

  it('has nothing named on it, and the houses just after it are named once the driver is through', () => {
    expect(run.said.filter((s) => s.along < 500)).toEqual([])
    const first = run.said[0]
    expect(first.along).toBe(500)
    expect(numbers(first.text).every((n) => n % 2 === 1 && n >= 500)).toBe(true)
  })

  it('names every house that came up', () => {
    for (const c of run.cameUp) expect(run.spoken).toContain(Number(c.key))
  })
})

describe('both sides thrown', () => {
  it('names a house on either side as soon as it comes up', () => {
    const route: Route = { points: north, sideChanges: sides([0, 'left'], [5, 'both']), stops: houses(10, 990) }
    const run = drive(route)
    // Still, the side thrown where the driver is counts: they wait for the Both stretch.
    const east = run.said.find((s) => numbers(s.text).includes(510))
    expect(east?.along).toBe(500)
    expect(run.spoken.filter((n) => n % 2 === 0 && n >= 500).length).toBeGreaterThan(0)
  })
})

describe('what is up when the voice is switched on', () => {
  const route: Route = { points: north, sideChanges: sides([0, 'left'], [5, 'right']), stops: houses(10, 990) }
  const allOccs = occurrences(route)
  const radius = alertRadius(40)
  const occs = alertable(route, allOccs, quietReachFor(40))
  // The driver is at 490 m with the alerts of the houses within 40 m ahead up, left and right.
  const along = 490
  const pos = spot(0, along)
  const queue = approachingOccurrences(along, pos, occs, new Set(), radius, 0)
  const base: Omit<VoiceInput, 'driver'> = { route, allOccs, occs, handled: new Set(), radius, queue, fresh: queue, announced: new Set(), held: new Set() }

  it('names the houses of the side being thrown and holds back the ones of the next stretch', () => {
    const plan = planVoice({ ...base, driver: { idx: 4, along, driven: along, pos } })
    const named = numbers(plan.text)
    expect(named.length).toBeGreaterThan(0)
    for (const n of named) expect(n % 2).toBe(1)
    expect(plan.held.length).toBeGreaterThan(0)
    for (const key of plan.held) expect(Number(key) % 2).toBe(0)
    // Every alert up is either named or held back, or is a house the row went past.
    for (const o of queue) expect(plan.announce.includes(o.key) || plan.held.includes(o.key) || numbers(plan.text).length >= SPOKEN_ROW_MAX).toBe(true)
  })

  it('names the held houses when the driver is on the Right stretch, and then nothing is held', () => {
    const first = planVoice({ ...base, driver: { idx: 4, along, driven: along, pos } })
    const crossed = planVoice({
      ...base,
      queue,
      fresh: [],
      announced: new Set(first.announce),
      held: new Set(first.held),
      driver: { idx: 5, along: 505, driven: 505, pos: spot(0, 505) },
    })
    expect(crossed.held).toEqual([])
    expect(numbers(crossed.text).length).toBeGreaterThan(0)
    for (const n of numbers(crossed.text)) expect(n % 2).toBe(0)
  })
})

describe('what is not named', () => {
  const route: Route = { points: north, sideChanges: sides([0, 'left']), stops: [west(300), west(320)] }
  const allOccs = occurrences(route)
  const radius = alertRadius(40)
  const occs = alertable(route, allOccs, quietReachFor(40))
  const base = { route, allOccs, occs, handled: new Set<string>(), radius, held: new Set<string>() }
  const driver = { idx: 2, along: 290, driven: 290, pos: spot(0, 290) }

  it('is a house already named', () => {
    const queue = occs
    expect(planVoice({ ...base, queue, fresh: queue, announced: new Set(), driver }).text).toBe('No throw, 301, 321.')
    expect(planVoice({ ...base, queue, fresh: queue, announced: new Set(['301', '321']), driver }).text).toBe('')
  })

  it('is a house that is up but is neither new nor held back', () => {
    expect(planVoice({ ...base, queue: occs, fresh: [], announced: new Set(), driver }).text).toBe('')
  })

  it('is a house the driver has gone by', () => {
    const past = { idx: 3, along: 340, driven: 340, pos: spot(0, 340) }
    expect(planVoice({ ...base, queue: occs, fresh: occs, announced: new Set(), driver: past }).text).toBe('')
  })

  it('is a house named twice because it is in the queue and among those just come up', () => {
    const plan = planVoice({ ...base, queue: occs, fresh: occs, announced: new Set(), driver })
    expect(plan.text).toBe('No throw, 301, 321.')
    expect(plan.announce.sort()).toEqual(['301', '321'])
  })

  it('is anything when nothing is up', () => {
    expect(planVoice({ ...base, queue: [], fresh: [], announced: new Set(), driver })).toEqual({ text: '', announce: [], held: [], noThrow: false })
  })
})

describe('a long row of houses', () => {
  const route: Route = { points: north, sideChanges: sides([0, 'left']), stops: Array.from({ length: 8 }, (_, i) => house(String(100 + i * 2), -12, 300 + i * 4)) }
  const allOccs = occurrences(route)
  const radius = alertRadius(40)
  const occs = alertable(route, allOccs, quietReachFor(40))
  const along = 290
  const pos = spot(0, along)
  const queue = approachingOccurrences(along, pos, occs, new Set(), radius, 0)
  const base = { route, allOccs, occs, handled: new Set<string>(), radius, held: new Set<string>(), driver: { idx: 2, along, driven: along, pos } }

  it('is named as the numbers that fit and how many more', () => {
    expect(queue).toHaveLength(8)
    const plan = planVoice({ ...base, queue, fresh: queue, announced: new Set() })
    expect(plan.text).toBe(`No throw, 100, 102, 104, 106, 108, 110, and ${8 - SPOKEN_ROW_MAX} more.`)
    expect(plan.announce).toHaveLength(SPOKEN_ROW_MAX)
  })

  it('does not name the rest on the next fix, as they are not newly up', () => {
    const first = planVoice({ ...base, queue, fresh: queue, announced: new Set() })
    const next = planVoice({ ...base, queue, fresh: [], announced: new Set(first.announce), held: new Set(first.held) })
    expect(next.text).toBe('')
  })
})

describe('stops that are not a no-throw house', () => {
  const stop = (id: string, type: StopType, extra: Partial<Stop> = {}): Stop => ({ id, type, pathIdx: 0, ...spot(-12, 300), address: `${id} Elm Street`, ...extra })
  const run = (stops: Stop[], changes: SideChange[]) => {
    const route: Route = { points: north, sideChanges: changes, stops }
    const allOccs = occurrences(route)
    const radius = alertRadius(40)
    const occs = alertable(route, allOccs, quietReachFor(40))
    const along = 290
    const pos = spot(0, along)
    const queue = approachingOccurrences(along, pos, occs, new Set(), radius, 0)
    return planVoice({ route, allOccs, occs, handled: new Set(), radius, queue, fresh: queue, announced: new Set(), held: new Set(), driver: { idx: 2, along, driven: along, pos } })
  }

  it('is named on any side, on transit too, and once', () => {
    for (const side of ['left', 'right', 'both', 'transit'] as const) {
      const plan = run([stop('9', 'bundle', { qty: 3 })], sides([0, side]))
      expect(plan.text, side).toBe('Bundle drop, 9, 3 papers.')
      expect(plan.announce).toEqual(['9'])
      expect(plan.held).toEqual([])
    }
  })

  it('names an apartment block with how many papers to throw and which side it is on, whatever is thrown', () => {
    for (const side of ['left', 'right', 'both', 'transit'] as const) {
      const plan = run([stop('9', 'block', { qty: 12, address: '9 Elm Street' })], sides([0, side]))
      expect(plan.text, side).toBe('Apartment block, 9, 12 papers, left.')
      expect(plan.announce).toEqual(['9'])
    }
    const right = run([{ ...stop('9', 'block', { qty: 12 }), ...spot(12, 300) }], sides([0, 'transit']))
    expect(right.text).toBe('Apartment block, 9, 12 papers, right.')
  })

  it('names an apartment block without a side when it cannot be told', () => {
    const plan = run([{ ...stop('B', 'block', { qty: 1, address: undefined, label: 'Oak Towers' }), ...spot(0, 300) }], sides([0, 'left']))
    expect(plan.text).toBe('Apartment block, Oak Towers, 1 paper.')
  })

  it('is named with the houses, after them', () => {
    const plan = run([stop('9', 'bundle', { qty: 3 }), { ...west(300), id: '5', address: '5 Elm Street' }], sides([0, 'left']))
    expect(plan.text).toBe('No throw, 5. Bundle drop, 9, 3 papers.')
    expect(plan.announce.sort()).toEqual(['5', '9'])
  })
})

describe('whether the words warn of a wrong throw', () => {
  const at = (id: string, type: StopType, x: number, y: number, extra: Partial<Stop> = {}): Stop => ({ id, type, pathIdx: 0, ...spot(x, y), address: `${id} Elm Street`, ...extra })
  const plan = (stops: Stop[], changes = sides([0, 'left'])) => {
    const route: Route = { points: north, sideChanges: changes, stops }
    const allOccs = occurrences(route)
    const radius = alertRadius(40)
    const occs = alertable(route, allOccs, quietReachFor(40))
    const along = 290
    const pos = spot(0, along)
    const queue = approachingOccurrences(along, pos, occs, new Set(), radius, 0)
    return planVoice({ route, allOccs, occs, handled: new Set(), radius, queue, fresh: queue, announced: new Set(), held: new Set(), driver: { idx: 2, along, driven: along, pos } })
  }

  it('is so when they name a no-throw house, on its own, in a row or with another stop', () => {
    expect(plan([at('5', 'nothrow', -12, 300)])).toMatchObject({ text: 'No throw, 5.', noThrow: true })
    expect(plan([at('5', 'nothrow', -12, 300), at('7', 'nothrow', -12, 310)])).toMatchObject({ text: 'No throw, 5, 7.', noThrow: true })
    expect(plan([at('5', 'nothrow', -12, 300), at('9', 'block', -15, 305, { qty: 12 })])).toMatchObject({ text: 'No throw, 5. Apartment block, 9, 12 papers, left.', noThrow: true })
  })

  it('is not so for any other stop', () => {
    for (const [type, extra] of [
      ['bundle', { qty: 3 }],
      ['request', { note: 'Leave it under the mat' }],
      ['block', { qty: 12 }],
    ] as const) {
      const p = plan([at('9', type, -12, 300, extra)])
      expect(p.text, type).not.toBe('')
      expect(p.noThrow, type).toBe(false)
    }
  })

  it('is not so while the house is held back for the side it is on, and nothing is said', () => {
    // Left to 300 m and Right from there: a house on the right just past the change comes up while the driver is on the Left stretch.
    const p = plan([at('6', 'nothrow', 12, 305)], sides([0, 'left'], [3, 'right']))
    expect(p.held).toEqual(['6'])
    expect(p.text).toBe('')
    expect(p.noThrow).toBe(false)
  })
})

describe('a house away from the route', () => {
  it('is named whatever is thrown, as it is met by where the driver is', () => {
    const far = house('77', 130, 300)
    const route: Route = { points: north, sideChanges: sides([0, 'transit']), stops: [far] }
    const allOccs = occurrences(route)
    const radius = alertRadius(40)
    const occs = alertable(route, allOccs, quietReachFor(40))
    const pos = spot(110, 300)
    const queue = approachingOccurrences(0, pos, occs, new Set(), radius, 5)
    expect(queue).toHaveLength(1)
    const plan = planVoice({ route, allOccs, occs, handled: new Set(), radius, queue, fresh: queue, announced: new Set(), held: new Set(), driver: { idx: 0, along: 0, driven: 0, pos } })
    expect(plan.text).toBe('No throw, 77.')
    expect(plan.held).toEqual([])
  })
})

describe('a house whose side cannot be told', () => {
  it('is named, to be safe, wherever a side is thrown', () => {
    const online = house('55', 0, 300)
    for (const side of ['left', 'right'] as const) {
      const route: Route = { points: north, sideChanges: sides([0, side]), stops: [online] }
      const allOccs = occurrences(route)
      const radius = alertRadius(40)
      const occs = alertable(route, allOccs, quietReachFor(40))
      const pos = spot(0, 290)
      const queue = approachingOccurrences(290, pos, occs, new Set(), radius, 0)
      const plan = planVoice({ route, allOccs, occs, handled: new Set(), radius, queue, fresh: queue, announced: new Set(), held: new Set(), driver: { idx: 2, along: 290, driven: 290, pos } })
      expect(plan.text, side).toBe('No throw, 55.')
    }
  })
})

describe('a stop already named', () => {
  const route: Route = { points: north, sideChanges: sides([0, 'left']), stops: [{ id: '9', type: 'bundle', pathIdx: 0, ...spot(-12, 300), address: '9 Elm Street', qty: 3 }] }
  const allOccs = occurrences(route)
  const radius = alertRadius(40)
  const occs = alertable(route, allOccs, quietReachFor(40))
  const pos = spot(0, 290)
  const queue = approachingOccurrences(290, pos, occs, new Set(), radius, 0)
  const base = { route, allOccs, occs, handled: new Set<string>(), radius, queue, fresh: queue, held: new Set<string>(), driver: { idx: 2, along: 290, driven: 290, pos } }

  it('is not named again, whatever kind of stop it is', () => {
    expect(planVoice({ ...base, announced: new Set() }).text).toBe('Bundle drop, 9, 3 papers.')
    expect(planVoice({ ...base, announced: new Set(['9']) })).toEqual({ text: '', announce: [], held: [], noThrow: false })
  })
})

describe('a row that reaches into the next stretch', () => {
  it('is named only as far as the side thrown where the driver is', () => {
    // Left to 500 m and both sides from there. A house on the line of the road, whose side cannot be told on a stretch of both, is named
    // wherever the driver is. The houses after it on the right are in a row with it by distance, but are not named until the driver is
    // on the stretch that throws to the right.
    const stops = [house('521', 0, 520), east(540), east(560), west(580)]
    const route: Route = { points: north, sideChanges: sides([0, 'left'], [5, 'both']), stops }
    const allOccs = occurrences(route)
    const radius = alertRadius(40)
    const occs = alertable(route, allOccs, quietReachFor(40))
    const along = 485
    const pos = spot(0, along)
    const queue = approachingOccurrences(along, pos, occs, new Set(), radius, 0)
    expect(queue.map((o) => o.key)).toEqual(['521'])
    const plan = planVoice({ route, allOccs, occs, handled: new Set(), radius, queue, fresh: queue, announced: new Set(), held: new Set(), driver: { idx: 4, along, driven: along, pos } })
    expect(plan.text).toBe('No throw, 521, 581.')
    expect(plan.announce).toEqual(['521', '581'])
  })
})

describe('an apartment block on a street driven out and back', () => {
  // Up 300 m and straight back down. The block is 15 m east: on the right going up and on the left coming back.
  const outAndBack = [0, 100, 200, 300, 200, 100, 0].map((y) => spot(0, y))
  const flats = (y: number): Stop => ({ id: 'blk', type: 'block', pathIdx: 0, ...spot(15, y), qty: 12, label: 'Lakeside Apartments' })
  const plans: Record<string, SideChange[]> = {
    'both both ways': sides([0, 'both']),
    'left both ways': sides([0, 'left']),
    'both going up and transit coming back': sides([0, 'both'], [3, 'transit']),
  }

  it('is told of on each pass, with the side it is on as that pass goes by it, as the app cannot tell which pass it was thrown on', () => {
    for (const [plan, changes] of Object.entries(plans)) {
      const route: Route = { points: outAndBack, sideChanges: changes, stops: [flats(150)] }
      const occs = alertable(route, occurrences(route))
      expect(occs.map((o) => [o.key, Math.round(o.at)]), plan).toEqual([
        ['blk', 150],
        ['blk#2', 450],
      ])
      const run = drive(route)
      expect(run.cameUp.map((c) => c.key), plan).toEqual(['blk', 'blk#2'])
      expect(run.said, plan).toEqual([
        { along: 110, text: 'Apartment block, Lakeside Apartments, 12 papers, right.' },
        { along: 410, text: 'Apartment block, Lakeside Apartments, 12 papers, left.' },
      ])
    }
  })

  it('is told of once at the turn-round, where one pass goes by it on both legs', () => {
    for (const [plan, changes] of Object.entries(plans)) {
      const route: Route = { points: outAndBack, sideChanges: changes, stops: [flats(290)] }
      const [o, ...more] = occurrences(route)
      expect(more, plan).toEqual([])
      expect(o.alt).toBeDefined()
      expect(alertable(route, [o])).toEqual([o])
      const run = drive(route)
      expect(run.cameUp.map((c) => c.key), plan).toEqual(['blk'])
      expect(run.said, plan).toHaveLength(1)
    }
  })
})

describe('an apartment block away from the route', () => {
  it('is on the side the driver comes up to it, by the way the phone is heading', () => {
    const flats: Stop = { id: 'B', type: 'block', pathIdx: 0, ...spot(110, 300), qty: 20, address: '1 Tower Street' }
    const route: Route = { points: north, sideChanges: sides([0, 'left']), stops: [flats] }
    const allOccs = occurrences(route)
    const radius = alertRadius(40)
    const occs = alertable(route, allOccs, quietReachFor(40))
    const pos = spot(80, 300)
    const queue = approachingOccurrences(0, pos, occs, new Set(), radius, 5)
    expect(queue).toHaveLength(1)
    const say = (heading: number | null) =>
      planVoice({ route, allOccs, occs, handled: new Set(), radius, queue, fresh: queue, announced: new Set(), held: new Set(), driver: { idx: 0, along: 0, driven: 0, pos, heading } }).text
    // It is east of the driver: on the right going north, on the left going south, and unknown with no heading or straight ahead.
    expect(say(0)).toBe('Apartment block, 1, 20 papers, right.')
    expect(say(180)).toBe('Apartment block, 1, 20 papers, left.')
    expect(say(null)).toBe('Apartment block, 1, 20 papers.')
    expect(say(90)).toBe('Apartment block, 1, 20 papers.')
  })
})

describe('the check that an alert’s words are out of date by their turn', () => {
  // Left thrown, a block at 200 m and two no-throw houses, numbered 220 and 240, at 219 and 239 m, all on the left.
  const route: Route = {
    points: north,
    sideChanges: sides([0, 'left']),
    stops: [{ id: 'blk', type: 'block', pathIdx: 0, ...spot(-15, 200), qty: 12, label: 'Lakeside Apartments' }, west(219), west(239)],
  }
  const radius = alertRadius(40)
  const occs = alertable(route, occurrences(route), quietReachFor(40))
  /** The driver `along` metres up the road, having got no further than `furthest`, with a turn round not sure yet when `turned` is given. */
  const at = (along: number, furthest = along, turned: { from: number; to: number } | null = null): DriverNow => ({ along, furthest, at: spot(0, along), turned })
  const check = (keys: string[], driver: () => DriverNow | null) => alertWordsStale(keys, occs, driver, radius)

  it('is false until the driver is 10 m past every stop the words name, as a stop gone by is never named', () => {
    const row = check(['220', '240'], () => driver)
    let driver = at(200)
    expect(row()).toBe(false)
    // Gone by the first house, but not the second.
    driver = at(235)
    expect(row()).toBe(false)
    driver = at(248.5)
    expect(row()).toBe(false)
    driver = at(249)
    expect(row()).toBe(true)
  })

  it('asks where the driver is each time it is checked, not where they were when the words were asked for', () => {
    let driver = at(170)
    const words = check(['blk'], () => driver)
    expect(words()).toBe(false)
    driver = at(211)
    expect(words()).toBe(true)
  })

  it('goes by the furthest the driver has got, so a wobble back does not make old words new again', () => {
    expect(check(['blk'], () => at(195, 215))()).toBe(true)
  })

  it('judges the driver where a turn round that is not sure yet put them from, as it may be undone', () => {
    // A car backing up on the way out is put far on, on the way back, until the turn is sure or undone.
    expect(check(['blk'], () => at(412, 205, { from: 205, to: 412 }))()).toBe(false)
    expect(check(['blk'], () => at(412, 212, { from: 212, to: 412 }))()).toBe(true)
    // Once the turn is sure it is where the tracker puts them.
    expect(check(['blk'], () => at(412, 412))()).toBe(true)
  })

  it('is false with no place for the driver yet, or no stop it knows', () => {
    expect(check(['blk'], () => null)()).toBe(false)
    expect(check([], () => at(900))()).toBe(false)
    expect(check(['gone'], () => at(900))()).toBe(false)
  })

  it('never takes a stop met by where the phone is as gone by, so its words are always said', () => {
    const far: Stop = { id: 'B', type: 'block', pathIdx: 0, ...spot(110, 300), qty: 20, address: '1 Tower Street' }
    const offRoute: Route = { points: north, sideChanges: sides([0, 'left']), stops: [far] }
    const farOccs = alertable(offRoute, occurrences(offRoute), quietReachFor(40))
    expect(alertWordsStale(['B'], farOccs, () => at(900), radius)()).toBe(false)
  })
})
