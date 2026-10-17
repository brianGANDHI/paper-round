import { useEffect, useLayoutEffect, useRef } from 'react'
import { Icon } from './Icon'
import { placePopover, type Spot } from './placement'
import { BRUSH_OPTIONS } from './sideOptions'
import type { Side } from './types'
import { Segmented } from './ui'

interface Props {
  /** Where on the map the section was tapped, in pixels from the map's top left corner. */
  at: Spot
  title: string
  /** A second line, such as which section this one drives again. */
  note?: string
  side: Side
  onSide: (side: Side) => void
  /** Change just part of the section, not all of it. */
  onPart: () => void
  onClose: () => void
}

/**
 * A small box over the map, where a section of the route was tapped, for choosing its side right there.
 * It sits clear of the sheet over the map, and closes when the map moves or is tapped.
 */
export function SidePopover({ at, title, note, side, onSide, onPart, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null)

  // Placed before it is first drawn, once its size is known, so it never shows in the wrong place.
  useLayoutEffect(() => {
    const node = box.current
    const screen = node?.offsetParent
    if (!node || !screen) return
    // The sheet covers the bottom of the map on a phone and a corner of it on a wide screen: stay clear of it either way.
    const frame = screen.getBoundingClientRect()
    const sheet = screen.querySelector('.sheet')?.getBoundingClientRect()
    const avoid = sheet && { left: sheet.left - frame.left, top: sheet.top - frame.top, right: sheet.right - frame.left, bottom: sheet.bottom - frame.top }
    const { left, top } = placePopover(at, { w: node.offsetWidth, h: node.offsetHeight }, { w: screen.clientWidth, h: screen.clientHeight }, { avoid })
    node.style.left = `${left}px`
    node.style.top = `${top}px`
  }, [at])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // Its place was worked out for this size of screen.
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div ref={box} className="side-pop" role="group" aria-label={`Change the side for ${title}`}>
      <div className="side-pop-head">
        <span className="side-pop-title">{title}</span>
        <button className="side-pop-x" aria-label="Close" onClick={onClose}>
          <Icon name="x" size={16} strokeWidth={2.4} />
        </button>
      </div>
      {note && <div className="side-pop-note">{note}</div>}
      <Segmented label={`Side for ${title}`} value={side} options={BRUSH_OPTIONS} onChange={onSide} />
      <button className="btn plain small" onClick={onPart}>
        Change just part of it
      </button>
    </div>
  )
}
