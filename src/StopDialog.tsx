import { useEffect, useState, type FormEvent } from 'react'
import { cleanLabel, MAX_LABEL, parseQty, qtyProblem } from './routeEdit'
import type { Stop } from './types'
import { Banner } from './ui'

interface Props {
  stop: Stop
  onSave: (change: { label?: string; qty?: number }) => void
  onClose: () => void
}

/**
 * Change what a stop is called and, for a bundle drop, how many papers it gets: the two things its alert
 * shows. Leaving either blank takes it off the stop.
 */
export function StopDialog({ stop, onSave, onClose }: Props) {
  const bundle = stop.type === 'bundle'
  const [name, setName] = useState(stop.label ?? '')
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
    onSave({ label: cleanLabel(name), qty: bundle ? parseQty(papers) : undefined })
  }

  return (
    <div className="scrim" onClick={onClose}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="stop-title" autoComplete="off" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 id="stop-title">{bundle ? 'Bundle Drop' : 'No-Throw House'}</h2>
        <p>{bundle ? 'The alert shows this name and how many papers to leave.' : 'The alert shows this name.'}</p>

        <label className="dialog-field">
          <span className="field-label">{bundle ? 'Business name' : 'Name or address'}</span>
          <input
            className="field-input"
            value={name}
            maxLength={MAX_LABEL}
            placeholder={bundle ? "e.g. Joe's Cafe" : 'e.g. 12 Oak Road'}
            enterKeyHint={bundle ? 'next' : 'done'}
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            onChange={(e) => setName(e.target.value)}
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
