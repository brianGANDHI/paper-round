import { useRef, useState } from 'react'
import { parseBackup, type BackupRoute } from './backup'
import { Icon } from './Icon'
import { Banner } from './ui'

interface BackupDialogProps {
  title: string
  text: string
  onClose: () => void
}

/** Shows the backup text with Copy and Share, so it can be kept in Notes or sent to another phone. */
export function BackupDialog({ title, text, onClose }: BackupDialogProps) {
  const area = useRef<HTMLTextAreaElement>(null)
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const canShare = typeof navigator.share === 'function'

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus('copied')
    } catch {
      // No clipboard access: select the text and try the older copy command.
      const el = area.current
      if (!el) return setStatus('failed')
      el.focus()
      el.select()
      setStatus(document.execCommand('copy') ? 'copied' : 'failed')
    }
  }

  const share = async () => {
    try {
      await navigator.share({ title: 'Paper Round backup', text })
    } catch {
      // Closing the share sheet without choosing anything is not an error.
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="dialog-title">{title}</h2>
        <p>Copy this text and keep it somewhere safe, like a note. To get your routes back, choose Restore from Backup and paste it in.</p>
        <textarea
          ref={area}
          className="dialog-text"
          readOnly
          value={text}
          aria-label="Backup text"
          onFocus={(e) => e.currentTarget.select()}
        />
        {status === 'failed' && <Banner kind="warn">Couldn't copy automatically. Press and hold the text, choose Select All, then Copy.</Banner>}
        <div className="btn-row">
          <button className="btn primary" onClick={copy}>
            <Icon name={status === 'copied' ? 'check' : 'copy'} size={18} strokeWidth={2.4} />
            {status === 'copied' ? 'Copied' : 'Copy'}
          </button>
          {canShare ? (
            <button className="btn secondary" onClick={share}>
              <Icon name="share" size={18} />
              Share
            </button>
          ) : (
            <button className="btn secondary" onClick={onClose}>
              Done
            </button>
          )}
        </div>
        {canShare && (
          <button className="btn plain block" onClick={onClose}>
            Done
          </button>
        )}
      </div>
    </div>
  )
}

interface RestoreDialogProps {
  onRestore: (routes: BackupRoute[]) => void
  onClose: () => void
}

/** Takes pasted backup text and adds its routes. Nothing already saved is overwritten. */
export function RestoreDialog({ onRestore, onClose }: RestoreDialogProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const canPaste = typeof navigator.clipboard?.readText === 'function'

  const paste = async () => {
    try {
      setText(await navigator.clipboard.readText())
      setError(null)
    } catch {
      setError("Couldn't read the clipboard. Press and hold in the box, then choose Paste.")
    }
  }

  const restore = () => {
    const result = parseBackup(text)
    if (!result.ok) return setError(result.error)
    onRestore(result.routes)
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="dialog-title">Restore from Backup</h2>
        <p>Paste the text you copied when you backed up. The routes in it are added to your list, and nothing you already have is replaced.</p>
        <textarea
          className="dialog-text"
          value={text}
          placeholder="Paste your backup here"
          aria-label="Backup text to restore"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
        />
        {error && <Banner kind="warn">{error}</Banner>}
        <div className="btn-row">
          <button className="btn primary" disabled={!text.trim()} onClick={restore}>
            Restore
          </button>
          {canPaste ? (
            <button className="btn secondary" onClick={paste}>
              Paste
            </button>
          ) : (
            <button className="btn secondary" onClick={onClose}>
              Cancel
            </button>
          )}
        </div>
        {canPaste && (
          <button className="btn plain block" onClick={onClose}>
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
