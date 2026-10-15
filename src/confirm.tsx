import { useCallback, useState } from 'react'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmLabel: string
  /** Shows the confirm button in red, for things that remove data. */
  destructive?: boolean
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void }

/** An iOS-style alert instead of the browser's confirm box. Render `dialog` once in the screen. */
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null)

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  )

  const close = (ok: boolean) => {
    pending?.resolve(ok)
    setPending(null)
  }

  const dialog = pending ? (
    <div className="scrim" onClick={() => close(false)}>
      <div className="alert" role="alertdialog" aria-modal="true" aria-labelledby="alert-title" onClick={(e) => e.stopPropagation()}>
        <div className="alert-text">
          <h2 id="alert-title">{pending.title}</h2>
          {pending.message && <p>{pending.message}</p>}
        </div>
        <div className="alert-actions">
          <button onClick={() => close(false)}>Cancel</button>
          <button className={pending.destructive ? 'danger' : undefined} onClick={() => close(true)} autoFocus>
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return { confirm, dialog }
}
