import { useCallback, useState } from 'react'
import { MAX_NAME } from './library'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel: string
  /** Shows the confirm button in red, for things that remove data. */
  destructive?: boolean
}

export interface PromptOptions {
  title: string
  message?: string
  confirmLabel: string
  defaultValue?: string
  placeholder?: string
}

type Pending =
  | ({ kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmOptions)
  | ({ kind: 'prompt'; resolve: (value: string | null) => void } & PromptOptions)

/**
 * iOS-style alerts instead of the browser's confirm and prompt boxes.
 * Render `dialog` once in the screen.
 */
export function useDialogs() {
  const [pending, setPending] = useState<Pending | null>(null)
  const [value, setValue] = useState('')

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ kind: 'confirm', resolve, ...options })),
    [],
  )

  /** Asks for a line of text. Resolves to null when cancelled. */
  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(options.defaultValue ?? '')
        setPending({ kind: 'prompt', resolve, ...options })
      }),
    [],
  )

  const finish = (ok: boolean) => {
    if (!pending) return
    if (pending.kind === 'confirm') pending.resolve(ok)
    else pending.resolve(ok ? value.trim() : null)
    setPending(null)
  }

  const isPrompt = pending?.kind === 'prompt'

  const dialog = pending ? (
    <div className="scrim" onClick={() => finish(false)}>
      <div className="alert" role="alertdialog" aria-modal="true" aria-labelledby="alert-title" onClick={(e) => e.stopPropagation()}>
        <div className="alert-text">
          <h2 id="alert-title">{pending.title}</h2>
          {pending.message && <p>{pending.message}</p>}
          {pending.kind === 'prompt' && (
            <input
              className="alert-input"
              value={value}
              maxLength={MAX_NAME}
              placeholder={pending.placeholder}
              aria-label={pending.title}
              enterKeyHint="done"
              autoCapitalize="words"
              autoCorrect="off"
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && value.trim()) finish(true)
              }}
            />
          )}
        </div>
        <div className="alert-actions">
          <button onClick={() => finish(false)}>Cancel</button>
          <button
            className={pending.kind === 'confirm' && pending.destructive ? 'danger' : undefined}
            disabled={isPrompt && !value.trim()}
            onClick={() => finish(true)}
            autoFocus={!isPrompt}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return { confirm, prompt, dialog }
}
