import { describe, expect, it } from 'vitest'
import { placePopover, type Rect } from './placement'

const size = { w: 300, h: 120 }
const area = { w: 390, h: 400 }

describe('placing a small box that points at a spot', () => {
  it('centres it above the spot, a little way off', () => {
    expect(placePopover({ x: 200, y: 300 }, size, area)).toEqual({ left: 50, top: 166 })
  })

  it('keeps it off the left edge and the right edge', () => {
    expect(placePopover({ x: 10, y: 300 }, size, area).left).toBe(8)
    expect(placePopover({ x: 380, y: 300 }, size, area).left).toBe(82)
  })

  it('puts it below the spot when there is no room above', () => {
    expect(placePopover({ x: 200, y: 60 }, size, area)).toEqual({ left: 50, top: 74 })
  })

  it('prefers above whenever it fits, right up to the margin', () => {
    // Exactly enough room: 8 + 120 + 14 above the spot.
    expect(placePopover({ x: 200, y: 142 }, size, area).top).toBe(8)
    // One pixel less and it goes below.
    expect(placePopover({ x: 200, y: 141 }, size, area).top).toBe(155)
  })

  it('stays on screen, as high as it can be, when there is no room above or below', () => {
    const short = { w: 390, h: 200 }
    const placed = placePopover({ x: 200, y: 100 }, size, short)
    expect(placed.top).toBe(8)
    expect(placed.top + size.h).toBeLessThanOrEqual(short.h)
  })

  it('keeps its margin from the bottom of the map too', () => {
    // Below the spot it would end 6 px from the bottom: too close, so it stays up at the top.
    const placed = placePopover({ x: 200, y: 100 }, size, { w: 390, h: 240 })
    expect(placed.top).toBe(8)
    expect(placed.top + size.h).toBeLessThanOrEqual(240 - 8)
    // With the margin to spare it does go below.
    expect(placePopover({ x: 200, y: 100 }, size, { w: 390, h: 242 }).top).toBe(114)
  })

  it('keeps off the left edge when it goes below the spot too', () => {
    expect(placePopover({ x: 10, y: 60 }, size, area)).toEqual({ left: 8, top: 74 })
    expect(placePopover({ x: 380, y: 60 }, size, area)).toEqual({ left: 82, top: 74 })
  })

  it('stays inside a map that is only just wider than the box', () => {
    expect(placePopover({ x: 150, y: 300 }, size, { w: 316, h: 400 }).left).toBe(8)
    expect(placePopover({ x: 5, y: 300 }, size, { w: 316, h: 400 }).left).toBe(8)
    expect(placePopover({ x: 315, y: 300 }, size, { w: 316, h: 400 }).left).toBe(8)
  })

  it('never goes past the margin on any side, wherever the spot is', () => {
    for (let x = 0; x <= 390; x += 15) {
      for (let y = 0; y <= 400; y += 20) {
        const { left, top } = placePopover({ x, y }, size, area)
        expect(left).toBeGreaterThanOrEqual(8)
        expect(left + size.w).toBeLessThanOrEqual(area.w - 8)
        expect(top).toBeGreaterThanOrEqual(8)
        expect(top + size.h).toBeLessThanOrEqual(area.h - 8)
      }
    }
  })

  it('takes the margin and the gap from the caller', () => {
    expect(placePopover({ x: 200, y: 300 }, size, area, { margin: 20, gap: 30 })).toEqual({ left: 50, top: 150 })
    expect(placePopover({ x: 5, y: 300 }, size, area, { margin: 20, gap: 30 }).left).toBe(20)
  })
})

const overlaps = (box: { left: number; top: number }, r: Rect) =>
  box.left < r.right && box.left + size.w > r.left && box.top < r.bottom && box.top + size.h > r.top

describe('keeping clear of the sheet', () => {
  // A phone: the sheet covers the bottom of the map from 379 down.
  const bottom: Rect = { left: 0, top: 379, right: 390, bottom: 844 }
  const phone = { w: 390, h: 844 }

  it('places it as usual when the spot is well above the sheet', () => {
    expect(placePopover({ x: 200, y: 300 }, size, phone, { avoid: bottom })).toEqual({ left: 50, top: 166 })
  })

  it('does not put it below the spot if that would run under the sheet', () => {
    // Below the spot would reach 40 + 14 + 120 = 174, but the sheet starts at 160 once it is this high.
    const high: Rect = { left: 0, top: 160, right: 390, bottom: 844 }
    const placed = placePopover({ x: 200, y: 40 }, size, phone, { avoid: high })
    expect(placed.top).toBe(8)
    expect(placed.top + size.h + 8).toBeLessThanOrEqual(high.top)
  })

  it('goes below the spot when that clears the sheet by the margin', () => {
    const sheet: Rect = { left: 0, top: 202, right: 390, bottom: 844 }
    expect(placePopover({ x: 200, y: 60 }, size, phone, { avoid: sheet }).top).toBe(74)
    // One pixel closer and it no longer clears by the margin.
    expect(placePopover({ x: 200, y: 60 }, size, phone, { avoid: { ...sheet, top: 201 } }).top).toBe(8)
  })

  it('stays a margin away from something it is beside, on either side', () => {
    const right: Rect = { left: 800, top: 267, right: 1184, bottom: 784 }
    const left: Rect = { left: 16, top: 267, right: 416, bottom: 784 }
    const wide = { w: 1200, h: 800 }
    // Centred, it would end 4 px short of the panel on its right: too close, so it slides further left.
    expect(placePopover({ x: 646, y: 500 }, size, wide, { avoid: right })).toEqual({ left: 492, top: 366 })
    // Centred, it would start 4 px from the panel on its left: too close, so it slides further right.
    expect(placePopover({ x: 570, y: 500 }, size, wide, { avoid: left })).toEqual({ left: 424, top: 366 })
  })

  it('stays a margin away from something above it, too', () => {
    const banner: Rect = { left: 0, top: 0, right: 390, bottom: 100 }
    // Below the spot would start 4 px under the banner: too close, and there is no room above, so it stays at the top.
    expect(placePopover({ x: 200, y: 90 }, size, area, { avoid: banner }).top).toBe(8)
    // With the margin to spare it does go below.
    expect(placePopover({ x: 200, y: 94 }, size, area, { avoid: banner }).top).toBe(108)
  })

  it('goes below something that is in the way above the spot, and clears it by the margin', () => {
    const banner: Rect = { left: 0, top: 0, right: 390, bottom: 100 }
    // Above would end at 16 + 120, across the banner; below the spot is clear.
    expect(placePopover({ x: 200, y: 150 }, size, area, { avoid: banner })).toEqual({ left: 50, top: 164 })
  })

  describe('on a wide screen, where the sheet is a panel at the left', () => {
    const wide = { w: 1200, h: 800 }
    const panel: Rect = { left: 16, top: 267, right: 416, bottom: 784 }

    it('ignores the panel for spots well to the right of it', () => {
      expect(placePopover({ x: 800, y: 500 }, size, wide, { avoid: panel })).toEqual({ left: 650, top: 366 })
    })

    it('slides to the right of the panel when it would sit on top of it', () => {
      const placed = placePopover({ x: 440, y: 500 }, size, wide, { avoid: panel })
      expect(placed).toEqual({ left: 424, top: 366 })
      expect(overlaps(placed, panel)).toBe(false)
      // And is still over the spot it points at.
      expect(placed.left).toBeLessThanOrEqual(440)
      expect(placed.left + size.w).toBeGreaterThanOrEqual(440)
    })

    it('slides to the left of a panel at the right instead', () => {
      const right: Rect = { left: 800, top: 267, right: 1184, bottom: 784 }
      const placed = placePopover({ x: 790, y: 500 }, size, wide, { avoid: right })
      expect(placed).toEqual({ left: 492, top: 366 })
      expect(overlaps(placed, right)).toBe(false)
    })

    it('goes above the panel when the spot is above it, however far left', () => {
      const placed = placePopover({ x: 100, y: 200 }, size, wide, { avoid: panel })
      expect(overlaps(placed, panel)).toBe(false)
    })

    it('never overlaps the panel or leaves the map, for any spot that is not under the panel', () => {
      for (let x = 0; x <= 1200; x += 40) {
        for (let y = 0; y <= 800; y += 25) {
          const under = x >= panel.left && x <= panel.right && y >= panel.top && y <= panel.bottom
          if (under) continue
          const placed = placePopover({ x, y }, size, wide, { avoid: panel })
          expect(overlaps(placed, panel), `spot ${x},${y} -> ${placed.left},${placed.top}`).toBe(false)
          expect(placed.left).toBeGreaterThanOrEqual(8)
          expect(placed.left + size.w).toBeLessThanOrEqual(wide.w - 8)
          expect(placed.top).toBeGreaterThanOrEqual(8)
          expect(placed.top + size.h).toBeLessThanOrEqual(wide.h - 8)
        }
      }
    })
  })
})
