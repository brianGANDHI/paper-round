export interface Size {
  w: number
  h: number
}

export interface Spot {
  x: number
  y: number
}

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

interface Options {
  /** Something over the map the box must stay clear of, such as the sheet. */
  avoid?: Rect | null
  /** How close the box may come to the edge of the map, and to `avoid`. */
  margin?: number
  /** How far it sits from the spot it points at. */
  gap?: number
}

/**
 * Where a small box that points at `at` goes on a map of size `area`: centred above that spot, or below
 * it when there is no room above, or slid sideways clear of `avoid` when the sheet is in the way. It
 * stays inside the map and clear of `avoid` by `margin`. When there is no room anywhere it stays on
 * screen, as high as it can be.
 */
export function placePopover(at: Spot, size: Size, area: Size, { avoid = null, margin = 8, gap = 14 }: Options = {}): { left: number; top: number } {
  // Sideways it can always be nudged back on screen; up and down it has to fit as it is.
  const clampX = (x: number) => Math.max(margin, Math.min(x, area.w - size.w - margin))
  const clear = (left: number, top: number) =>
    top >= margin &&
    top + size.h <= area.h - margin &&
    (!avoid ||
      left + size.w + margin <= avoid.left ||
      left >= avoid.right + margin ||
      top + size.h + margin <= avoid.top ||
      top >= avoid.bottom + margin)

  const left = clampX(at.x - size.w / 2)
  const above = at.y - gap - size.h
  const rows = [above, at.y + gap]
  for (const top of rows) if (clear(left, top)) return { left, top }
  if (avoid) {
    const sides = [clampX(avoid.right + margin), clampX(avoid.left - margin - size.w)]
    for (const top of rows) for (const side of sides) if (clear(side, top)) return { left: side, top }
  }
  return { left, top: Math.max(margin, Math.min(above, area.h - size.h - margin)) }
}
