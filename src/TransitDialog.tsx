import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from './Icon'
import { routeByAddress, TransitError, transitMessage, type Stage, type TransitResult } from './transit'
import { Banner, Segmented } from './ui'
import type { Route } from './types'

const STAGE_TEXT: Record<Stage, string> = {
  start: 'Finding the start…',
  end: 'Finding the end…',
  link: 'Working out the way to the start…',
  road: 'Working out the fastest road…',
}

type Start = 'address' | 'end'

const START_OPTIONS: { value: Start; label: string }[] = [
  { value: 'address', label: 'Address' },
  { value: 'end', label: 'End of Route' },
]

interface Props {
  open: boolean
  route: Route
  onAdded: (result: TransitResult) => void
  onClose: () => void
}

/**
 * Asks for a start and an end address and adds the fastest road between them to the route as Transit.
 * Stays mounted while closed, so what was typed is still there when it opens again.
 */
export function TransitDialog({ open, route, onAdded, onClose }: Props) {
  const [start, setStart] = useState<Start>('address')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [stage, setStage] = useState<Stage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const toInput = useRef<HTMLInputElement>(null)
  const fromEnd = route.points.length > 0 && start === 'end'
  const ready = !!to.trim() && (fromEnd || !!from.trim())

  // Leaving while a lookup runs must not keep calling the services.
  useEffect(() => () => abort.current?.abort(), [])

  const close = () => {
    abort.current?.abort()
    abort.current = null
    setStage(null)
    onClose()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (stage || !ready) return
    const lookup = new AbortController()
    abort.current = lookup
    setError(null)
    setStage(fromEnd ? 'end' : 'start')
    try {
      const result = await routeByAddress(route, { from: fromEnd ? null : from, to }, { signal: lookup.signal, onStage: setStage })
      // Closed in the meantime: the answer is no longer wanted.
      if (abort.current !== lookup) return
      abort.current = null
      setStage(null)
      setFrom('')
      setTo('')
      onAdded(result)
    } catch (err) {
      if (abort.current !== lookup) return
      abort.current = null
      setStage(null)
      const failure = err instanceof TransitError ? err : new TransitError('service')
      if (failure.kind !== 'cancelled') setError(transitMessage(failure))
    }
  }

  return (
    <div className="scrim" onClick={() => !stage && close()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transit-title"
        autoComplete="off"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 id="transit-title">Route by Address</h2>
        <p>Type where the transit starts and where it ends. The fastest road between them is drawn for you, with nothing thrown on it.</p>

        {route.points.length > 0 && (
          <Segmented
            label="Where the transit starts"
            value={start}
            options={START_OPTIONS}
            onChange={(next) => {
              setStart(next)
              setError(null)
              // With no start to type, the end is the next thing to fill in. (Going back to Address brings its field up focused.)
              if (next === 'end') toInput.current?.focus()
            }}
          />
        )}
        {fromEnd ? (
          <p>It starts where your route ends now.</p>
        ) : (
          <label className="field">
            <span className="field-label">From</span>
            <input
              className="field-input"
              value={from}
              placeholder="Street address and suburb"
              enterKeyHint="next"
              autoCapitalize="words"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              onChange={(e) => {
                setFrom(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                toInput.current?.focus()
              }}
            />
          </label>
        )}
        <label className="field">
          <span className="field-label">To</span>
          <input
            ref={toInput}
            className="field-input"
            value={to}
            placeholder="Street address and suburb"
            enterKeyHint="go"
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={fromEnd}
            onChange={(e) => {
              setTo(e.target.value)
              setError(null)
            }}
          />
        </label>

        {error && <Banner kind="warn">{error}</Banner>}
        {stage && <Banner>{STAGE_TEXT[stage]}</Banner>}

        <button type="submit" className="btn primary block" disabled={!ready || !!stage}>
          <Icon name="route" size={20} />
          Find Fastest Route
        </button>
        <button type="button" className="btn plain block" onClick={close}>
          Cancel
        </button>
        <p>
          Needs internet. The addresses you type are sent to OpenStreetMap's search service, and FOSSGIS's routing server works out the road. Undo takes the
          stretch back off.
        </p>
      </form>
    </div>
  )
}
