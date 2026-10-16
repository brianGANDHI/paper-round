import { useRef, useState } from 'react'
import { MAX_BACKUP_CHARS, parseBackup, type BackupRoute } from './backup'
import { inSafariTab } from './device'
import { Icon } from './Icon'
import { Banner } from './ui'

/** Saves a file the way a computer does: as a download. */
function download(file: File) {
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

interface BackupDialogProps {
  title: string
  text: string
  /** What the file is called when it is saved. */
  fileName: string
  onClose: () => void
}

/**
 * Shows the backup text with Copy and Save File, so it can be kept in Notes, saved on a computer, or moved
 * to a phone. Share is there too where the device has a share sheet.
 */
export function BackupDialog({ title, text, fileName, onClose }: BackupDialogProps) {
  const area = useRef<HTMLTextAreaElement>(null)
  const [status, setStatus] = useState<'idle' | 'copied' | 'saved' | 'failed'>('idle')
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

  /** On a phone, the share sheet (which has Save to Files and AirDrop). On a computer, a plain download. */
  const saveFile = async () => {
    const file = new File([text], fileName, { type: 'text/plain' })
    if (!matchMedia('(pointer: coarse)').matches || !navigator.canShare?.({ files: [file] })) {
      download(file)
      return setStatus('saved')
    }
    try {
      await navigator.share({ files: [file], title: 'Paper Round backup' })
      setStatus('saved')
    } catch (e) {
      // Closing the share sheet without choosing anything is not an error.
      if (!(e instanceof DOMException && e.name === 'AbortError')) setStatus('failed')
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
        <p>
          Copy this text, or save it as a file, and keep it somewhere safe. To get your routes back, choose Restore from Backup in the app on any device,
          then paste the text in or open the file.
        </p>
        <textarea
          ref={area}
          className="dialog-text"
          readOnly
          value={text}
          aria-label="Backup text"
          onFocus={(e) => e.currentTarget.select()}
        />
        {status === 'failed' && <Banner kind="warn">Couldn't do that automatically. Press and hold the text, choose Select All, then Copy.</Banner>}
        <div className="btn-row">
          <button className="btn primary" onClick={copy}>
            <Icon name={status === 'copied' ? 'check' : 'copy'} size={18} strokeWidth={2.4} />
            {status === 'copied' ? 'Copied' : 'Copy'}
          </button>
          <button className="btn secondary" onClick={saveFile}>
            <Icon name={status === 'saved' ? 'check' : 'download'} size={18} strokeWidth={status === 'saved' ? 2.4 : 2} />
            {status === 'saved' ? 'Saved' : 'Save File'}
          </button>
        </div>
        {canShare && (
          <button className="btn plain block" onClick={share}>
            <Icon name="share" size={18} />
            Share Text
          </button>
        )}
        <button className="btn plain block" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

interface RestoreDialogProps {
  onRestore: (routes: BackupRoute[]) => void
  onClose: () => void
}

/** Takes pasted backup text, or a saved backup file, and adds its routes. */
export function RestoreDialog({ onRestore, onClose }: RestoreDialogProps) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const canPaste = typeof navigator.clipboard?.readText === 'function'

  const paste = async () => {
    try {
      setText(await navigator.clipboard.readText())
      setError(null)
    } catch {
      setError("Couldn't read the clipboard. Press and hold in the box, then choose Paste.")
    }
  }

  const readFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_BACKUP_CHARS) return setError('That file is too big to be a backup.')
    try {
      setText(await file.text())
      setError(null)
    } catch {
      setError("Couldn't read that file.")
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
        <p>
          Paste the text you copied when you backed up, or open the file you saved. The routes in it are added to your list. If one has the name of a route
          you already have, you'll be asked whether to replace it.
        </p>
        {inSafariTab() && (
          <Banner>If you run your round from the Home Screen app, restore in that app instead. Safari and the Home Screen app keep separate routes.</Banner>
        )}
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
        <input
          ref={picker}
          type="file"
          hidden
          accept=".txt,.json,text/plain,application/json"
          aria-label="Backup file to restore"
          onChange={(e) => {
            void readFile(e.target.files?.[0])
            // So choosing the same file again still counts.
            e.target.value = ''
          }}
        />
        {error && <Banner kind="warn">{error}</Banner>}
        <div className="btn-row">
          {canPaste && (
            <button className="btn secondary" onClick={paste}>
              <Icon name="copy" size={18} />
              Paste
            </button>
          )}
          <button className="btn secondary" style={canPaste ? undefined : { gridColumn: '1 / -1' }} onClick={() => picker.current?.click()}>
            <Icon name="upload" size={18} />
            Open File
          </button>
        </div>
        <button className="btn primary block" disabled={!text.trim()} onClick={restore}>
          Restore
        </button>
        <button className="btn plain block" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}
