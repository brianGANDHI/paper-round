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

export interface Choice<T extends string> {
  value: T
  label: string
  /** A line of explanation under the label. */
  detail?: string
}

export interface ChooseOptions<T extends string> {
  title: string
  message?: string
  choices: Choice<T>[]
}

type Pending =
  | ({ kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmOptions)
  | ({ kind: 'prompt'; resolve: (value: string | null) => void } & PromptOptions)
  | ({ kind: 'choose'; resolve: (value: string | null) => void } & ChooseOptions<string>)

/**
 * iOS-style alerts and action sheets instead of the browser's confirm and prompt boxes.
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

  /** Offers a short list of choices in an action sheet. Resolves to the one picked, or null when cancelled. */
  const choose = useCallback(
    <T extends string>(options: ChooseOptions<T>) =>
      new Promise<T | null>((resolve) =>
        setPending({ kind: 'choose', resolve: resolve as (value: string | null) => void, ...options }),
      ),
    [],
  )

  const finish = (ok: boolean) => {
    if (!pending) return
    if (pending.kind === 'confirm') pending.resolve(ok)
    else if (pending.kind === 'prompt') pending.resolve(ok ? value.trim() : null)
    else pending.resolve(null)
    setPending(null)
  }

  const isPrompt = pending?.kind === 'prompt'

  let dialog = null
  if (pending?.kind === 'choose') {
    const { title, message, choices, resolve } = pending
    dialog = (
      <div className="scrim bottom" onClick={() => finish(false)}>
        <div className="action-sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" onClick={(e) => e.stopPropagation()}>
          <div className="action-group">
            <div className="action-head">
              <h2 id="sheet-title">{title}</h2>
              {message && <p>{message}</p>}
            </div>
            {choices.map((c) => (
              <button
                key={c.value}
                className="action-choice"
                onClick={() => {
                  resolve(c.value)
                  setPending(null)
                }}
              >
                <span>{c.label}</span>
                {c.detail && <small>{c.detail}</small>}
              </button>
            ))}
          </div>
          <div className="action-group">
            <button className="action-choice cancel" onClick={() => finish(false)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  } else if (pending) {
    dialog = (
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
    )
  }

  return { confirm, prompt, choose, dialog }
}
