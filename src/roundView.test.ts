import { describe, expect, it } from 'vitest'
import { barBundle } from './bundleFlow'
import { bundleList } from './bundles'
import type { Occurrence } from './geo'
import { afterUserMove, barCover, barLead, barMiddle, fitPadding, followAnimation, FREE_LOOK_MS, settleZoom, stepZoom, type LookState, type ZoomGoal, type ZoomMap } from './roundView'

const following: LookState = { overview: false, headingUp: false, freeLook: false }
const looking: LookState = { ...following, freeLook: true }

describe('free look', () => {
  it('waits fifteen seconds after the last touch', () => {
    expect(FREE_LOOK_MS).toBe(15000)
  })

  it('starts with a drag of the north-up map, and the wait starts', () => {
    expect(afterUserMove('drag', following)).toEqual({ freeLook: true, restart: true })
  })

  it('keeps going with another drag, and the wait starts again', () => {
    expect(afterUserMove('drag', looking)).toEqual({ freeLook: true, restart: true })
  })

  it('is never started by a zoom, and no wait starts', () => {
    expect(afterUserMove('zoom', following)).toEqual({ freeLook: false, restart: false })
  })

  it('is kept going by a zoom while looking around, and the wait starts again', () => {
    expect(afterUserMove('zoom', looking)).toEqual({ freeLook: true, restart: true })
  })

  it('is not started by a drag with the whole route up', () => {
    expect(afterUserMove('drag', { ...following, overview: true })).toEqual({ freeLook: false, restart: false })
    expect(afterUserMove('zoom', { ...following, overview: true })).toEqual({ freeLook: false, restart: false })
  })

  it('is not started by a drag with the map turned to the heading', () => {
    expect(afterUserMove('drag', { ...following, headingUp: true })).toEqual({ freeLook: false, restart: false })
    expect(afterUserMove('zoom', { ...following, headingUp: true })).toEqual({ freeLook: false, restart: false })
  })

  it('leaves free look as it is, and starts no wait, where it cannot apply', () => {
    // Free look is cleared on the way into the whole route or the turned map, so this is only a guard: it must not end it behind the screen's back.
    expect(afterUserMove('drag', { overview: true, headingUp: false, freeLook: true })).toEqual({ freeLook: true, restart: false })
    expect(afterUserMove('zoom', { overview: false, headingUp: true, freeLook: true })).toEqual({ freeLook: true, restart: false })
  })
})

describe('how much of the map the bar covers', () => {
  it('is the bar and the gap under it', () => {
    // A screen ending at 761 with the bar's top at 697: 56 px of bar and 8 under it.
    expect(barCover(761, 697)).toBe(64)
  })

  it('grows with the bar, as when a long notice takes more lines', () => {
    expect(barCover(761, 697)).toBe(64)
    expect(barCover(761, 661)).toBe(100)
  })

  it('is a whole number of pixels', () => {
    expect(barCover(761.4, 697.2)).toBe(64)
    expect(barCover(761.6, 697.2)).toBe(64)
    expect(barCover(761.9, 697.2)).toBe(65)
  })

  it('is nothing to go by before anything is laid out, or when the bar is not above the bottom', () => {
    expect(barCover(0, 0)).toBeNull()
    expect(barCover(500, 500)).toBeNull()
    expect(barCover(500, 520)).toBeNull()
    expect(barCover(Number.NaN, 100)).toBeNull()
    expect(barCover(500, Number.NaN)).toBeNull()
    expect(barCover(Number.POSITIVE_INFINITY, 100)).toBeNull()
  })
})

describe('the room kept round the whole route', () => {
  it('clears the column of buttons at the right: 48 px and the gap to the edge, with room to spare', () => {
    expect(fitPadding(64).bottomRight[0]).toBe(70)
    expect(fitPadding(64).bottomRight[0]).toBeGreaterThanOrEqual(48 + 8)
  })

  it('keeps the top for the side, the turn and an alert, and a margin at the left', () => {
    expect(fitPadding(64).topLeft).toEqual([30, 70])
  })

  it('keeps the bottom clear of the bar, whatever it covers, as a whole number of pixels', () => {
    expect(fitPadding(64).bottomRight[1]).toBe(94)
    expect(fitPadding(100).bottomRight[1]).toBe(130)
    expect(fitPadding(64.4).bottomRight[1]).toBe(94)
  })
})

describe('how the map goes to the driver', () => {
  it('is left to Leaflet when following a fix, or coming back from looking around, so a far way is not glided over blank tiles', () => {
    // Forcing it (true) glides over any distance; false never glides; only undefined lets Leaflet jump a far move and glide a near one.
    expect(followAnimation(false)).toBeUndefined()
  })

  it('is never a glide when the map is turned between north and the heading', () => {
    expect(followAnimation(true)).toBe(false)
  })
})

describe('what takes the middle of the bar', () => {
  it('is the next bundle drop, however long the screen has been awake', () => {
    expect(barMiddle({ problem: false, located: true, bundle: true })).toBe('bundle')
  })

  it('is a problem with the GPS first of all, which is the only thing that takes the bundle line away', () => {
    expect(barMiddle({ problem: true, located: true, bundle: true })).toBe('problem')
    expect(barMiddle({ problem: true, located: false, bundle: false })).toBe('problem')
  })

  it('is the wait for the first fix before there is one', () => {
    expect(barMiddle({ problem: false, located: false, bundle: true })).toBe('finding')
    expect(barMiddle({ problem: false, located: false, bundle: false })).toBe('finding')
  })

  it('is the alert distance only when there is nothing else to say', () => {
    expect(barMiddle({ problem: false, located: true, bundle: false })).toBe('alerts')
  })
})

describe('the word the next-bundle line leads with', () => {
  const occ = (id: string, at: number): Occurrence => ({ key: id, stop: { id, type: 'bundle', lat: -33.87, lng: 151.2, pathIdx: 0, label: 'Co-op' }, idx: 0, at, off: 0 })
  const real = barBundle(bundleList([occ('a', 100)], { handledStopIds: [] }, 0))?.lead ?? ''

  it('is what the bar really leads with, so the short form cannot drift from it', () => {
    expect(real).toBe('Next bundle')
  })

  it('is whole when the line has its room', () => {
    expect(barLead(real, false)).toBe('Next bundle')
  })

  it('is "Next" when the line is crowded, by the pill for bundles missed or the caution button', () => {
    expect(barLead(real, true)).toBe('Next')
  })

  it('is left alone when the line says how the round stands instead of what is next', () => {
    expect(barLead('Bundles', true)).toBe('Bundles')
    expect(barLead('Bundles', false)).toBe('Bundles')
  })
})

/**
 * A map that zooms the way Leaflet 1.9.4 does (Map.js: `setView`, `_tryAnimatedZoom`, `_animateZoom`, `_onZoomTransitionEnd`): the zoom
 * asked for starts on the next frame, when the map takes the new zoom and `_animatingZoom` goes on; a zoom asked for while that is on
 * is dropped, whatever its animate option; 250 ms after the frame it ends, with zoomend. The map's own `setZoom` is all the buttons get.
 */
function leaflet(start: number, min = 0, max = 19) {
  let zoom = start
  let animating = false
  let now = 0
  const tasks: { at: number; run: () => void }[] = []
  const ended: (() => void)[] = []
  const later = (ms: number, run: () => void) => tasks.push({ at: now + ms, run })
  const end = () => {
    if (!animating) return
    animating = false
    for (const f of ended) f()
  }
  const map: ZoomMap = {
    getZoom: () => zoom,
    getMinZoom: () => min,
    getMaxZoom: () => max,
    setZoom(target: number) {
      const to = Math.min(max, Math.max(min, target))
      if (zoom === to) return
      if (animating) return
      later(16, () => {
        animating = true
        zoom = to
        later(250, end)
      })
    },
  }
  /** Lets `ms` pass, running what falls due in its order. */
  const wait = (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = tasks.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      tasks.splice(tasks.indexOf(due), 1)
      now = due.at
      due.run()
    }
    now = until
  }
  return { map, wait, onZoomEnd: (f: () => void) => ended.push(f) }
}

/** The zoom buttons on that map, as MapView wires them: a press steps, and the end of a zoom settles. */
function buttons(start: number, min?: number, max?: number) {
  const sim = leaflet(start, min, max)
  const goal: ZoomGoal = { current: null }
  sim.onZoomEnd(() => settleZoom(sim.map, goal))
  return {
    ...sim,
    goal,
    press: (by: 1 | -1) => stepZoom(sim.map, goal, by),
    zoom: () => sim.map.getZoom(),
  }
}

describe('the zoom buttons', () => {
  it('the model loses a zoom asked for while the map is zooming, as Leaflet does (the bug)', () => {
    const sim = leaflet(17)
    sim.map.setZoom(16)
    sim.wait(150)
    sim.map.setZoom(15)
    sim.wait(1000)
    expect(sim.map.getZoom()).toBe(16)
  })

  it('a press is one step', () => {
    const b = buttons(17)
    b.press(1)
    b.wait(1000)
    expect(b.zoom()).toBe(18)
    b.press(-1)
    b.wait(1000)
    expect(b.zoom()).toBe(17)
  })

  it('two quick presses, while the first is still zooming, are two steps', () => {
    const b = buttons(17)
    b.press(-1)
    b.wait(150)
    b.press(-1)
    b.wait(1000)
    expect(b.zoom()).toBe(15)
  })

  it('two presses in the same frame, before the zoom has even started, are two steps', () => {
    const b = buttons(17)
    b.press(1)
    b.wait(5)
    b.press(1)
    b.wait(1000)
    expect(b.zoom()).toBe(19)
  })

  it('three quick presses are three steps', () => {
    const b = buttons(17)
    b.press(-1)
    b.wait(100)
    b.press(-1)
    b.wait(100)
    b.press(-1)
    b.wait(2000)
    expect(b.zoom()).toBe(14)
  })

  it('presses made after each zoom has ended are a step each', () => {
    const b = buttons(17)
    b.press(-1)
    b.wait(300)
    expect(b.zoom()).toBe(16)
    b.press(-1)
    b.wait(300)
    expect(b.zoom()).toBe(15)
  })

  it('in and straight out again nets nothing', () => {
    const b = buttons(17)
    b.press(1)
    b.wait(100)
    b.press(-1)
    b.wait(2000)
    expect(b.zoom()).toBe(17)
  })

  it('stops at the closest zoom, however many presses, and keeps no goal', () => {
    const b = buttons(18)
    for (let i = 0; i < 4; i++) {
      b.press(1)
      b.wait(60)
    }
    b.wait(2000)
    expect(b.zoom()).toBe(19)
    expect(b.goal.current).toBeNull()
  })

  it('stops at the furthest zoom out, and keeps no goal', () => {
    const b = buttons(3, 2)
    for (let i = 0; i < 4; i++) {
      b.press(-1)
      b.wait(60)
    }
    b.wait(2000)
    expect(b.zoom()).toBe(2)
    expect(b.goal.current).toBeNull()
  })

  it('a press at the limit with nothing under way leaves no goal behind, so a pinch that follows is not undone', () => {
    const b = buttons(19)
    b.press(1)
    expect(b.goal.current).toBeNull()
    // A pinch out to 16, which the buttons did not make.
    b.map.setZoom(16)
    b.wait(1000)
    expect(b.zoom()).toBe(16)
  })

  it('carries on from the whole zoom nearest when an interrupted pinch left a half step', () => {
    const b = buttons(16.6)
    b.press(1)
    b.wait(1000)
    expect(b.zoom()).toBe(18)
  })

  it('forgets its goal once it has got there, so the next press starts from where the map is', () => {
    const b = buttons(17)
    b.press(-1)
    b.wait(100)
    b.press(-1)
    b.wait(2000)
    expect(b.goal.current).toBeNull()
    b.map.setZoom(18)
    b.wait(1000)
    b.press(-1)
    b.wait(1000)
    expect(b.zoom()).toBe(17)
  })
})

describe('settling the zoom', () => {
  const still = (zoom: number): ZoomMap => ({ getZoom: () => zoom, getMinZoom: () => 0, getMaxZoom: () => 19, setZoom: () => undefined })

  it('does nothing when the buttons are not heading anywhere', () => {
    let asked = 0
    const goal: ZoomGoal = { current: null }
    settleZoom({ ...still(17), setZoom: () => void asked++ }, goal)
    expect(asked).toBe(0)
    expect(goal.current).toBeNull()
  })

  it('asks again for the zoom a lost press was heading for, and keeps it until the map is there', () => {
    const asked: number[] = []
    const goal: ZoomGoal = { current: 15 }
    settleZoom({ ...still(16), setZoom: (z) => void asked.push(z) }, goal)
    expect(asked).toEqual([15])
    expect(goal.current).toBe(15)
  })

  it('lets go of the goal when the map is there', () => {
    const asked: number[] = []
    const goal: ZoomGoal = { current: 15 }
    settleZoom({ ...still(15), setZoom: (z) => void asked.push(z) }, goal)
    expect(asked).toEqual([])
    expect(goal.current).toBeNull()
  })
})
