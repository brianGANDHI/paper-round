import { describe, expect, it } from 'vitest'
import { alertable, alertRadius, isGoneBy, pickCurrent, zoneExit } from './alerts'
import { bannerBlock, bannerWaiting, shownSide } from './bannerBlock'
import { approachingOccurrences, occurrences, type Occurrence } from './geo'
import type { Pt, Route, Side, Stop, StopType } from './types'

/** A spot `x` metres east and `y` metres north of a start at 51 degrees north, for routes with exact distances. */
const M_PER_DEG = (6371000 * Math.PI) / 180
const spot = (x: number, y: number): Pt => ({ lat: 51 + y / M_PER_DEG, lng: x / (M_PER_DEG * Math.cos((51 * Math.PI) / 180)) })

const radius = alertRadius(40)

/** A stop queued on a road along the route, `at` metres along it. */
const q = (key: string, type: StopType, at: number, off = 0): Occurrence => ({ key, stop: { id: key, type, pathIdx: 0, lat: 0, lng: 0 }, idx: 0, at, off })

describe('the apartment block shown in the banner of another stop', () => {
  it('is the block still to come while a house is the banner', () => {
    const queue = [q('h', 'nothrow', 120), q('k', 'block', 125)]
    const current = pickCurrent(queue, 100, 100, null, radius)
    expect(current?.key).toBe('h')
    expect(bannerBlock(queue, current, 100, 100, null, radius)?.key).toBe('k')
  })

  it('is there for a block just behind the car, until the block is gone by, as its own banner would be', () => {
    const queue = [q('h', 'nothrow', 130), q('k', 'block', 100)]
    const at = (y: number) => bannerBlock(queue, pickCurrent(queue, y, y, null, radius), y, y, null, radius)?.key
    expect(at(105)).toBe('k')
    expect(at(109.5)).toBe('k')
    expect(at(110)).toBeUndefined()
    expect(at(125)).toBeUndefined()
  })

  it('is in the banner of a bundle drop or a special request too, and none in a block banner of its own or with no banner', () => {
    const k = q('k', 'block', 120)
    for (const type of ['bundle', 'request'] as const) {
      const queue = [q('x', type, 110), k]
      expect(bannerBlock(queue, queue[0], 100, 100, null, radius)?.key, type).toBe('k')
    }
    // A block's own banner shows its papers already, and not those of another block after it.
    const blocks = [k, q('k2', 'block', 130)]
    expect(bannerBlock(blocks, blocks[0], 100, 100, null, radius)).toBeNull()
    expect(bannerBlock([k], undefined, 100, 100, null, radius)).toBeNull()
  })

  it('is none when no block is queued', () => {
    const queue = [q('h', 'nothrow', 120), q('b', 'bundle', 125), q('r', 'request', 130)]
    expect(bannerBlock(queue, queue[0], 100, 100, null, radius)).toBeNull()
  })

  it('is the nearest of two blocks still to come', () => {
    const queue = [q('h', 'nothrow', 110), q('far', 'block', 135), q('near', 'block', 118), q('gone', 'block', 85)]
    expect(bannerBlock(queue, queue[0], 100, 100, null, radius)?.key).toBe('near')
  })

  it('goes by the furthest the driver got, so a wobble back does not bring back a block gone by', () => {
    const queue = [q('h', 'nothrow', 130), q('k', 'block', 100)]
    expect(bannerBlock(queue, queue[0], 112, 95, null, radius)).toBeNull()
  })

  it('measures a block met by where the driver is from where they are, and keeps it while it is queued', () => {
    // 33 m north of the driver, though its place along the route is well behind: it is there until the driver leaves its zone.
    const off: Occurrence = { ...q('off', 'block', 20, 200), stop: { id: 'off', type: 'block', pathIdx: 0, ...spot(0, 33) } }
    const house = q('h', 'nothrow', 110)
    expect(bannerBlock([house, off], house, 100, 100, spot(0, 0), radius)?.key).toBe('off')
    // Nearer than a block 20 m ahead along the route, and further than one 10 m ahead.
    expect(bannerBlock([house, q('k', 'block', 120), off], house, 100, 100, spot(0, 20), radius)?.key).toBe('off')
    expect(bannerBlock([house, q('k', 'block', 110), off], house, 100, 100, spot(0, 0), radius)?.key).toBe('k')
  })
})

describe('the count of alerts waiting behind the banner', () => {
  it('leaves out the row it shows, a block shown in it and the stops gone by', () => {
    const queue = [q('gone', 'nothrow', 80), q('h', 'nothrow', 110), q('h2', 'nothrow', 120), q('k', 'block', 115), q('b', 'bundle', 130)]
    expect(bannerWaiting(queue, [queue[1], queue[2], queue[3]], 100, 100, null, radius)).toBe(1)
    // Without the block in the banner it waits, as any other stop does.
    expect(bannerWaiting(queue, [queue[1], queue[2]], 100, 100, null, radius)).toBe(2)
    expect(bannerWaiting([], [], 100, 100, null, radius)).toBe(0)
  })
})

describe('the side a stop is shown on', () => {
  const road = (stops: Stop[]): Route => ({ points: [spot(0, 0), spot(0, 600)], sideChanges: [{ idx: 0, side: 'left' }], stops })

  it('is the side as the route passes it, for a stop beside the route', () => {
    const route = road([{ id: 'k', type: 'block', pathIdx: 0, ...spot(-12, 300) }, { id: 'e', type: 'block', pathIdx: 0, ...spot(12, 400) }])
    const all = occurrences(route)
    expect(all.map((o) => shownSide(route, all, o, radius, null, null))).toEqual(['left', 'right'])
  })

  it('is the side as the driver comes up to it, for one met by where they are', () => {
    // 100 m west of the road, so met by where the driver is. Heading north it is on the left; heading south, on the right.
    const route = road([{ id: 'k', type: 'block', pathIdx: 0, ...spot(-100, 330) }])
    const all = occurrences(route)
    expect(shownSide(route, all, all[0], radius, 0, spot(0, 300))).toBe('left')
    expect(shownSide(route, all, all[0], radius, 180, spot(0, 360))).toBe('right')
    expect(shownSide(route, all, all[0], radius, null, spot(0, 300))).toBeNull()
  })
})

// A road north with a block 12 m off it, 300 m along, and another stop on the same side some way before or after it. The driver goes along
// in 1 m steps without tapping anything. As the screen does, each step leaves the zones that have been left (a stop gone past is done),
// brings up what has come into reach, shows what pickCurrent picks, and shows the block in that banner when it is not the block's own.
const BLOCK_AT = 300
const GONE_BY = BLOCK_AT + 10
const block: Stop = { id: 'k', type: 'block', pathIdx: 0, qty: 12, ...spot(-12, BLOCK_AT) }
interface Step {
  y: number
  /** The stop of the banner showing, the block shown in it, and whether the house's alert is up and not gone by. */
  banner?: string
  strip?: string
  houseLive: boolean
}
const drive = (side: Side, stops: Stop[]): Step[] => {
  const route: Route = { points: [spot(0, 0), spot(0, 600)], sideChanges: [{ idx: 0, side }], stops }
  const occs = alertable(route, occurrences(route))
  let queue: Occurrence[] = []
  const seen = new Set<string>()
  const handled = new Set<string>()
  const log: Step[] = []
  for (let y = 0; y <= 600; y++) {
    const pos = spot(0, y)
    const left = queue.flatMap((o) => {
      const exit = zoneExit(o, y, radius, pos)
      return exit ? [{ o, exit }] : []
    })
    queue = queue.filter((o) => !left.some((l) => l.o.key === o.key))
    for (const l of left) {
      if (l.exit === 'passed') handled.add(l.o.key)
      else seen.delete(l.o.key)
    }
    const fresh = approachingOccurrences(y, pos, occs, handled, radius, 5).filter((o) => !seen.has(o.key))
    for (const o of fresh) seen.add(o.key)
    queue = [...queue, ...fresh]
    const current = pickCurrent(queue, y, y, pos, radius)
    log.push({
      y,
      banner: current?.stop.id,
      strip: bannerBlock(queue, current, y, y, pos, radius)?.stop.id,
      houseLive: queue.some((o) => o.stop.type === 'nothrow' && !isGoneBy(o, y, y, pos, radius)),
    })
  }
  return log
}
/** Where the block's papers are on screen: in its own banner, or in the strip of another's. */
const countShown = (s: Step) => s.banner === 'k' || s.strip === 'k'
/** How a distance before or after the block is told, in a test's name. */
const placed = (offset: number, what: string) => (offset < 0 ? `${-offset} m before` : offset > 0 ? `${offset} m after` : 'at the same spot as') + ` ${what}`

describe('driving past an apartment block with a no-throw house near it, as the round screen does', () => {
  const house = (offset: number): Stop => ({ id: 'h', type: 'nothrow', pathIdx: 0, ...spot(-12, BLOCK_AT + offset) })

  it('shows the block in its own banner from 40 m before it to 40 m past, with no house near', () => {
    const log = drive('left', [block])
    expect(log.filter((s) => s.banner === 'k').map((s) => s.y)).toEqual(Array.from({ length: 80 }, (_, i) => BLOCK_AT - 40 + i))
    expect(log.some((s) => s.strip)).toBe(false)
  })

  for (const side of ['left', 'both'] as const) {
    for (const offset of [-15, -5, 0, 5, 15]) {
      describe(`thrown ${side}, with the house ${placed(offset, 'the block')}`, () => {
        const log = drive(side, [block, house(offset)])

        it('has the papers on screen from about 40 m before the block until it is gone by', () => {
          const first = log.find(countShown)?.y
          expect(first).toBeLessThanOrEqual(BLOCK_AT - 39)
          const missing = log.filter((s) => s.y >= BLOCK_AT - 39 && s.y < GONE_BY && !countShown(s)).map((s) => s.y)
          expect(missing).toEqual([])
        })

        it('never hides the red banner of the house while it is up', () => {
          const hidden = log.filter((s) => s.houseLive && s.banner !== 'h').map((s) => s.y)
          expect(hidden).toEqual([])
          expect(log.some((s) => s.houseLive)).toBe(true)
        })

        it('shows the strip only in the banner of the house, and not once the block is gone by', () => {
          for (const s of log.filter((x) => x.strip)) expect(s.banner, `${s.y}`).toBe('h')
          expect(log.filter((s) => s.y >= GONE_BY && s.strip).map((s) => s.y)).toEqual([])
        })
      })
    }
  }

  it('would leave the block hidden behind a house at the same spot without the strip', () => {
    // What the strip is for: the house outranks the block the whole time the block is still to come.
    const log = drive('left', [block, house(0)])
    expect(log.filter((s) => s.y < GONE_BY && s.banner === 'k')).toEqual([])
    expect(log.filter((s) => s.y >= BLOCK_AT - 40 && s.y < GONE_BY).every((s) => s.strip === 'k')).toBe(true)
  })
})

describe('driving past an apartment block with a bundle drop or a special request near it, as the round screen does', () => {
  /** A special request with what to do there, or a bundle drop of 5 papers that is not tapped, 12 m off the road on the block's side. */
  const other = (type: 'request' | 'bundle', offset: number): Stop => ({
    id: 'o',
    type,
    pathIdx: 0,
    ...spot(-12, BLOCK_AT + offset),
    ...(type === 'request' ? { note: 'Blue gate, deliver by hand' } : { qty: 5 }),
  })

  for (const type of ['request', 'bundle'] as const) {
    for (const offset of [-15, -5, -2, 0, 2, 5, 15]) {
      for (const order of ['block first', `${type} first`]) {
        describe(`with the ${type} ${placed(offset, 'the block')}, the ${order} in the route`, () => {
          const stops = order === 'block first' ? [block, other(type, offset)] : [other(type, offset), block]
          const log = drive('left', stops)
          const at = BLOCK_AT + offset

          it('has the papers on screen from about 40 m before the block until it is gone by', () => {
            const missing = log.filter((s) => s.y >= BLOCK_AT - 39 && s.y < GONE_BY && !countShown(s)).map((s) => s.y)
            expect(missing).toEqual([])
          })

          it(`keeps the ${type === 'request' ? "request's note" : "bundle's Dropped button"} on screen from 35 m before it to 5 m past it`, () => {
            const hidden = log.filter((s) => s.y >= at - 35 && s.y <= at + 5 && s.banner !== 'o').map((s) => s.y)
            expect(hidden).toEqual([])
          })

          it('shows the strip only in a banner that is not the block, and not once the block is gone by', () => {
            for (const s of log.filter((x) => x.strip)) expect(s.banner, `${s.y}`).not.toBe('k')
            expect(log.filter((s) => s.y >= GONE_BY && s.strip).map((s) => s.y)).toEqual([])
          })
        })
      }
    }
  }
})
