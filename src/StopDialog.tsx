import { useEffect, useState, type FormEvent } from 'react'
import { cleanAddress, cleanLabel, MAX_ADDRESS, MAX_LABEL, parseQty, qtyProblem, stopFields } from './routeEdit'
import type { Stop } from './types'
import { Banner } from './ui'

interface Props {
  stop: Stop
  onSave: (change: { label?: string; address?: string; qty?: number }) => void
  onClose: () => void
}

/**
 * Change a stop's name, its address and, for a bundle drop, how many papers it gets: what its alert shows, with
 * the address under the name. They are separate, so a business can be named and have its address kept as well.
 * Leaving any of them blank takes it off the stop.
 */
export function StopDialog({ stop, onSave, onClose }: Props) {
  const bundle = stop.type === 'bundle'
  // A stop made before places had addresses of their own may have its address in its name: it is offered as the address.
  const start = stopFields(stop)
  const [name, setName] = useState(start.name)
  const [address, setAddress] = useState(start.address)
  const [papers, setPapers] = useState(stop.qty ? String(stop.qty) : '')
  const problem = bundle ? qtyProblem(papers) : null

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (problem) return
    onSave({ label: cleanLabel(name), address: cleanAddress(address), qty: bundle ? parseQty(papers) : undefined })
  }

  return (
    <div className="scrim" onClick={onClose}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="stop-title" autoComplete="off" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 id="stop-title">{bundle ? 'Bundle Drop' : 'No-Throw House'}</h2>
        <p>
          {bundle
            ? 'The alert shows the name and how many papers to leave, with the address under the name.'
            : 'The alert shows the name, with the address under it.'}
        </p>

        <label className="dialog-field">
          <span className="field-label">{bundle ? 'Business name' : 'Name'}</span>
          <input
            className="field-input"
            value={name}
            maxLength={MAX_LABEL}
            placeholder={bundle ? "e.g. Joe's Cafe" : 'Optional'}
            enterKeyHint="next"
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="dialog-field">
          <span className="field-label">Address</span>
          <input
            className="field-input"
            value={address}
            maxLength={MAX_ADDRESS}
            placeholder="e.g. 12 Oak Road, Lewes"
            enterKeyHint={bundle ? 'next' : 'done'}
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
        {bundle && (
          <label className="dialog-field">
            <span className="field-label">Papers</span>
            <input
              className="field-input"
              value={papers}
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="How many"
              aria-invalid={!!problem}
              enterKeyHint="done"
              onChange={(e) => setPapers(e.target.value)}
            />
          </label>
        )}

        {problem && <Banner kind="warn">{problem}</Banner>}

        <button type="submit" className="btn primary block" disabled={!!problem}>
          Save
        </button>
        <button type="button" className="btn plain block" onClick={onClose}>
          Cancel
        </button>
      </form>
    </div>
  )
}
