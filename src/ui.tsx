import { useRef, type ReactNode } from 'react'
import { Icon } from './Icon'

interface SegmentedProps<T extends string> {
  value: T
  options: { value: T; label: ReactNode; ariaLabel?: string }[]
  onChange: (value: T) => void
  /** Describes the control to screen readers. */
  label: string
  /** Use tab semantics when the control switches between pages of content. */
  tabs?: boolean
}

/** iOS-style segmented control: a grey track with a raised thumb under the chosen option. */
export function Segmented<T extends string>({ value, options, onChange, label, tabs }: SegmentedProps<T>) {
  return (
    <div className="segmented" role={tabs ? 'tablist' : 'group'} aria-label={label}>
      {options.map((o) => {
        const on = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role={tabs ? 'tab' : undefined}
            aria-selected={tabs ? on : undefined}
            aria-pressed={tabs ? undefined : on}
            aria-label={o.ariaLabel}
            data-on={on || undefined}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

interface SheetProps {
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  /** Stays put while the body scrolls. */
  header?: ReactNode
  children: ReactNode
}

/** How far the grabber must be dragged, in px, to count as a swipe rather than a tap. */
const SWIPE_PX = 24

/** A bottom sheet over the map. Swipe or tap the grabber to switch between medium and tall. */
export function Sheet({ expanded, onExpandedChange, header, children }: SheetProps) {
  const startY = useRef<number | null>(null)

  return (
    <section className={expanded ? 'sheet expanded' : 'sheet'}>
      <button
        className="sheet-grab"
        aria-label={expanded ? 'Show less' : 'Show more'}
        aria-expanded={expanded}
        onPointerDown={(e) => {
          startY.current = e.clientY
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerUp={(e) => {
          const dy = e.clientY - (startY.current ?? e.clientY)
          startY.current = null
          if (dy < -SWIPE_PX) onExpandedChange(true)
          else if (dy > SWIPE_PX) onExpandedChange(false)
          else onExpandedChange(!expanded)
        }}
        onPointerCancel={() => {
          startY.current = null
        }}
        // Pointer taps are handled above; a click with no pointer is the keyboard.
        onClick={(e) => {
          if (e.detail === 0) onExpandedChange(!expanded)
        }}
      >
        <span />
      </button>
      {header && <div className="sheet-head">{header}</div>}
      <div className="sheet-body">{children}</div>
    </section>
  )
}

export function Banner({ kind = 'info', children }: { kind?: 'info' | 'warn'; children: ReactNode }) {
  return (
    <p className={`banner ${kind}`} role="status">
      <Icon name={kind === 'warn' ? 'alert' : 'info'} size={18} />
      <span>{children}</span>
    </p>
  )
}

/** Shown where a screen has nothing to work with yet. */
export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  )
}
