import { describe, expect, it } from 'vitest'
import { lineThrough, spot } from './driveSim'
import { haversine } from './geo'
import { PASS_OFFSET_M, passViews } from './passes'
import type { SideExtent } from './driveEdit'
import {
  advanceAlong,
  BACK_SLACK_M,
  clearPart,
  drawnStretches,
  FIRST_SPEED,
  isPreviewSpeed,
  mapTurn,
  markerAt,
  markerOffset,
  nextStretch,
  previewEnd,
  PREVIEW_SPEEDS,
  previousStretch,
  realSpeed,
  secondsLeft,
  stretchAt,
  timeLeftText,
  withWholeStretch,
  type PreviewStretch,
} from './playback'
import { repeatSection, sections } from './routeEdit'
import type { Route } from './types'

/*
 * The preview of the drive: a marker played along the route from its start, faster than real time, so the side of each stretch can be checked.
 * The routes are made up, laid out in metres east and north of a made-up place (see driveSim.ts), so no real street is in them.
 */

/** A straight road north, 1 km long with a point every 10 m: 300 m thrown port, 200 m of transit, then 500 m thrown on both sides. */
const ROUTE: Route = {
  points: lineThrough(
    [
      [0, 0],
      [0, 1000],
    ],
    10,
  ),
  sideChanges: [
    { idx: 0, side: 'left' },
    { idx: 30, side: 'transit' },
    { idx: 50, side: 'both' },
  ],
  stops: [],
}
const STRETCHES: PreviewStretch[] = sections(ROUTE)

describe('the speeds', () => {
  it('are ten, thirty and sixty times real time, starting at ten', () => {
    expect([...PREVIEW_SPEEDS]).toEqual([10, 30, 60])
    expect(FIRST_SPEED).toBe(10)
    expect(isPreviewSpeed(30)).toBe(true)
    expect(isPreviewSpeed(5)).toBe(false)
    expect(isPreviewSpeed('10')).toBe(false)
  })

  it('take real time as 25 km/h where papers are thrown and 50 km/h on transit', () => {
    for (const side of ['both', 'left', 'right'] as const) expect(realSpeed(side)).toBeCloseTo(25 / 3.6)
    expect(realSpeed('transit')).toBeCloseTo(50 / 3.6)
  })
})

describe('the stretch the marker is in', () => {
  it('starts at the start of a stretch and hands over at its end, as the round does', () => {
    expect(STRETCHES.map((s) => [Math.round(s.startM), Math.round(s.endM), s.side])).toEqual([
      [0, 300, 'left'],
      [300, 500, 'transit'],
      [500, 1000, 'both'],
    ])
    expect(stretchAt(STRETCHES, 0)).toBe(0)
    expect(stretchAt(STRETCHES, 299.9)).toBe(0)
    expect(stretchAt(STRETCHES, STRETCHES[0].endM)).toBe(1)
    expect(stretchAt(STRETCHES, 400)).toBe(1)
    expect(stretchAt(STRETCHES, STRETCHES[1].endM)).toBe(2)
  })

  it('is the first before the start and the last at or past the end, and none on a route with no stretches', () => {
    expect(stretchAt(STRETCHES, -50)).toBe(0)
    expect(stretchAt(STRETCHES, previewEnd(STRETCHES))).toBe(2)
    expect(stretchAt(STRETCHES, 5000)).toBe(2)
    expect(stretchAt([], 10)).toBe(-1)
    expect(previewEnd([])).toBe(0)
  })

  it('is the stretch that starts a hair further on, as one painted from where the marker is comes out once the distances are added up again', () => {
    const painted = [
      { startM: 0, endM: 400.000001, side: 'transit' },
      { startM: 400.000001, endM: 500, side: 'right' },
    ] as const
    expect(stretchAt(painted, 400)).toBe(1)
    expect(stretchAt(painted, 399.98)).toBe(0)
  })

  it('is never a stretch with no length', () => {
    const withEmpty = [
      { startM: 0, endM: 100, side: 'left' },
      { startM: 100, endM: 100, side: 'right' },
      { startM: 100, endM: 200, side: 'both' },
    ] as const
    expect(stretchAt(withEmpty, 100)).toBe(2)
  })
})

describe('playing', () => {
  it('goes along a thrown stretch at 25 km/h times the speed', () => {
    // At 10x, 25 km/h is about 69 m a second.
    expect(advanceAlong(STRETCHES, 0, 1, 10)).toBeCloseTo((25 / 3.6) * 10)
    expect(advanceAlong(STRETCHES, 0, 1, 30)).toBeCloseTo((25 / 3.6) * 30)
  })

  it('goes along transit twice as fast, and keeps to each stretch its own pace across a change of side', () => {
    // 300 m of port at 10x takes 300 / 69.4 = 4.32 s; the rest of a 5 s step is on transit at 138.9 m/s.
    const portSeconds = 300 / ((25 / 3.6) * 10)
    const along = advanceAlong(STRETCHES, 0, 5, 10)
    expect(along).toBeCloseTo(300 + (5 - portSeconds) * (50 / 3.6) * 10, 6)
    // From transit into both sides it slows down again.
    const onTransit = 200 / ((50 / 3.6) * 10)
    expect(advanceAlong(STRETCHES, 300, onTransit + 1, 10)).toBeCloseTo(500 + (25 / 3.6) * 10, 6)
  })

  it('stops at the end of the route, and stays there', () => {
    const end = previewEnd(STRETCHES)
    expect(advanceAlong(STRETCHES, 900, 60, 60)).toBe(end)
    expect(advanceAlong(STRETCHES, end, 1, 60)).toBe(end)
  })

  it('stays put for no time, time going backwards or a step that is not a number', () => {
    expect(advanceAlong(STRETCHES, 120, 0, 10)).toBe(120)
    expect(advanceAlong(STRETCHES, 120, -3, 10)).toBe(120)
    expect(advanceAlong(STRETCHES, 120, Number.NaN, 10)).toBe(120)
    expect(advanceAlong([], 0, 1, 10)).toBe(0)
  })

  it('says how long the rest takes, with transit at its own pace', () => {
    // 800 m thrown at 25 km/h and 200 m of transit at 50 km/h is 115.2 + 14.4 = 129.6 s of real time.
    expect(secondsLeft(STRETCHES, 0, 1)).toBeCloseTo(129.6, 6)
    expect(secondsLeft(STRETCHES, 0, 10)).toBeCloseTo(12.96, 6)
    // From half way along the transit, only what is left of it counts.
    expect(secondsLeft(STRETCHES, 400, 1)).toBeCloseTo(7.2 + 72, 6)
    expect(secondsLeft(STRETCHES, previewEnd(STRETCHES), 30)).toBe(0)
  })

  it('puts the time left in plain words', () => {
    expect(timeLeftText(0)).toBe('Under a minute left')
    expect(timeLeftText(59)).toBe('Under a minute left')
    expect(timeLeftText(6 * 60 + 20)).toBe('About 6 min left')
    expect(timeLeftText(19 * 60)).toBe('About 19 min left')
    expect(timeLeftText(95 * 60)).toBe('About 1 h 35 min left')
    expect(timeLeftText(120 * 60)).toBe('About 2 h left')
    expect(timeLeftText(Infinity)).toBe('')
  })
})

describe('jumping by stretch', () => {
  it('goes on to the start of the next stretch, and has nowhere to go from the last', () => {
    expect(nextStretch(STRETCHES, 0)).toBe(1)
    expect(nextStretch(STRETCHES, 299)).toBe(1)
    expect(nextStretch(STRETCHES, 300)).toBe(2)
    expect(nextStretch(STRETCHES, 700)).toBeNull()
    expect(nextStretch([], 0)).toBeNull()
  })

  it('goes back to the start of the stretch it is in, or to the one before when it is only just into it', () => {
    const transit = STRETCHES[1].startM
    expect(previousStretch(STRETCHES, 450)).toBe(1)
    expect(previousStretch(STRETCHES, transit + BACK_SLACK_M + 1)).toBe(1)
    // Just into a stretch (as after a tap on Previous Stretch), the next tap goes back one more.
    expect(previousStretch(STRETCHES, transit)).toBe(0)
    expect(previousStretch(STRETCHES, transit + BACK_SLACK_M)).toBe(0)
    // The first stretch has none before it: back is its own start.
    expect(previousStretch(STRETCHES, 5)).toBe(0)
    // From the end of the route, the last stretch's start.
    expect(previousStretch(STRETCHES, previewEnd(STRETCHES))).toBe(2)
    expect(previousStretch([], 0)).toBeNull()
  })
})

describe('the marker', () => {
  const drawn = drawnStretches(passViews(ROUTE))

  it('is on the route, as far along it as the preview has got, heading the way the route goes', () => {
    const at = markerAt(drawn, 420)
    expect(at).not.toBeNull()
    expect(haversine(at!.pos, spot([0, 420]))).toBeLessThan(0.01)
    // The road runs north.
    expect(at!.heading).toBeCloseTo(0, 3)
    expect(haversine(markerAt(drawn, 0)!.pos, spot([0, 0]))).toBeLessThan(0.01)
    expect(haversine(markerAt(drawn, 5000)!.pos, spot([0, 1000]))).toBeLessThan(0.01)
  })

  it('turns at a corner as it comes into it', () => {
    // East 100 m, then north: a few metres before the corner it already heads round it.
    const corner: Route = {
      points: lineThrough(
        [
          [0, 0],
          [100, 0],
          [100, 100],
        ],
        10,
      ),
      sideChanges: [{ idx: 0, side: 'both' }],
      stops: [],
    }
    const lines = drawnStretches(passViews(corner))
    expect(markerAt(lines, 50)!.heading).toBeCloseTo(90, 3)
    const into = markerAt(lines, 97)!.heading!
    expect(into).toBeGreaterThan(5)
    expect(into).toBeLessThan(85)
    expect(markerAt(lines, 150)!.heading).toBeCloseTo(0, 3)
  })

  it('is on the pass being played where a road is driven back, which the map draws beside the first', () => {
    // A street 400 m east, then driven back: the way back is drawn 12 m to one side, and the marker is on it, not on the first pass.
    const street: Route = {
      points: lineThrough(
        [
          [0, 0],
          [400, 0],
        ],
        20,
      ),
      sideChanges: [{ idx: 0, side: 'left' }],
      stops: [],
    }
    const both = repeatSection(street, 0, 'back')!
    const stretches = sections(both)
    const back = stretches[stretches.length - 1]
    const lines = drawnStretches(passViews(both))
    const mid = markerAt(lines, (back.startM + back.endM) / 2)!
    // Half way back along the street, at 200 m east, beside the first pass and not on it.
    expect(haversine(mid.pos, spot([200, 0]))).toBeCloseTo(PASS_OFFSET_M, 0)
    expect(mid.heading).toBeCloseTo(270, 0)
  })

  it('is nowhere on a route with no line', () => {
    expect(markerAt([], 0)).toBeNull()
  })
})

describe('turning the map the way the marker goes', () => {
  it('takes the first heading as it is, and keeps the map still for a bend of less than 20 degrees', () => {
    expect(mapTurn(null, 90)).toBe(90)
    expect(mapTurn(90, 105)).toBe(90)
    expect(mapTurn(90, 75)).toBe(90)
  })

  it('turns it at a corner, the short way round, with the heading unwrapped', () => {
    expect(mapTurn(90, 180)).toBe(180)
    expect(mapTurn(350, 30)).toBe(390)
    expect(mapTurn(10, 300)).toBe(-60)
  })

  it('leaves it as it is when the way the marker goes is not known', () => {
    expect(mapTurn(90, null)).toBe(90)
    expect(mapTurn(90, Number.NaN)).toBe(90)
    expect(mapTurn(null, null)).toBeNull()
  })
})

describe('where the marker sits on the screen', () => {
  // A phone held upright, 390 by 760: the side and the turn card down to 150 px, the panel from 520 px, and the map's buttons down the right edge.
  const PHONE = { width: 390, height: 760 }
  const top = { left: 12, top: 10, right: 378, bottom: 150 }
  const panel = { left: 8, top: 520, right: 382, bottom: 752 }
  const column = { left: 334, top: 340, right: 382, bottom: 504 }

  it('is in the middle of the map between the side at the top and the panel, the buttons at the edge being clear of it', () => {
    const clear = clearPart(PHONE, top, panel, column)
    expect(clear).toEqual({ left: 0, top: 158, right: 390, bottom: 512 })
    // 335 px down, against the middle of the map at 380: 45 px up from it.
    expect(markerOffset(PHONE, clear)).toEqual({ x: 0, y: -45 })
  })

  it('keeps above the buttons as well when they lie in a row across the middle, as on a short screen', () => {
    const row = { left: 210, top: 464, right: 382, bottom: 512 }
    expect(clearPart(PHONE, top, panel, row).bottom).toBe(456)
    // A row clear of the middle, at the right, does not count.
    const short = { left: 230, top: 464, right: 382, bottom: 512 }
    expect(clearPart(PHONE, top, panel, short).bottom).toBe(512)
  })

  it('on a phone on its side, is to the left of the panel, under the side and above the buttons', () => {
    const SIDEWAYS = { width: 844, height: 340 }
    const clear = clearPart(SIDEWAYS, { left: 0, top: 10, right: 388, bottom: 116 }, { left: 431, top: 116, right: 836, bottom: 332 }, { left: 8, top: 284, right: 114, bottom: 332 })
    expect(clear).toEqual({ left: 0, top: 124, right: 423, bottom: 276 })
    expect(markerOffset(SIDEWAYS, clear)).toEqual({ x: -210, y: 30 })
  })
})

describe('the parts of the stretch a side can be changed for', () => {
  const STRETCH = { startM: 300, endM: 500 }
  const part = (key: SideExtent['key'], fromM: number, toM: number, label: string): SideExtent => ({ key, fromM, toM, label, detail: `${toM - fromM} m` })

  it('calls the part that reaches both ends of the stretch the whole stretch, and covers all of it', () => {
    // At the start of a stretch (as after Next Stretch), "To the end of this stretch" is all of it, and the whole stretch is left out as the same.
    expect(withWholeStretch([part('toStretchEnd', 310, 500, 'To the end of this stretch')], STRETCH)).toEqual([
      { key: 'stretch', fromM: 300, toM: 500, label: 'The whole stretch', detail: '200 m, all of it' },
    ])
  })

  it('leaves them as they are when the whole stretch is there already, or the part does not reach both ends', () => {
    const both = [part('toStretchEnd', 400, 500, 'To the end of this stretch'), part('stretch', 300, 500, 'The whole stretch')]
    expect(withWholeStretch(both, STRETCH)).toEqual(both)
    const turn = [part('toTurn', 300, 420, 'To the next turn')]
    expect(withWholeStretch(turn, STRETCH)).toEqual(turn)
  })
})
