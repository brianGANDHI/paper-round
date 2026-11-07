import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { addLine, changeLine, changePapersEach, linePapersText, loadNumberText, loadOf, loadRows, loadWhole, MAX_LOAD_LINES, MAX_LOAD_NOTE, MAX_LOAD_NUMBER, parseLoadNumber, removeLine } from './load'
import { LOAD_KINDS, type LoadKind, type LoadList } from './types'
import { Segmented } from './ui'
import './load.css'

const KIND_TITLE: Record<LoadKind, string> = { bagged: 'Bagged', unwrapped: 'Unwrapped' }
const KIND_OPTIONS = LOAD_KINDS.map((kind) => ({ value: kind, label: KIND_TITLE[kind] }))
/** What a screen reader says for the papers in a bundle, as the kind by itself doesn't say what the number is. */
const PAPERS_LABEL: Record<LoadKind, string> = { bagged: 'Papers in a bagged bundle', unwrapped: 'Papers in an unwrapped bundle' }

/** What every number field has: the numeric keypad, a grey 0 when it is blank, and no more digits than the biggest number has. */
const NUMBER_FIELD = {
  inputMode: 'numeric',
  pattern: '[0-9]*',
  placeholder: '0',
  maxLength: String(MAX_LOAD_NUMBER).length,
  enterKeyHint: 'done',
  autoComplete: 'off',
} as const

/** Return puts the keyboard away. There is nothing to send, as each change is kept as it is made. */
const closeKeyboard = (e: KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') e.currentTarget.blur()
}

/**
 * A ref for a box that is to fill the part of the screen the keyboard leaves. On an iPhone the page doesn't shrink for the keyboard, so a
 * sheet at the bottom would be behind it, and the phone would slide the whole page up to show the field, taking the totals and Done off the top.
 */
function useAboveKeyboard() {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const view = window.visualViewport
    const el = box.current
    if (!view || !el) return
    const fit = () => {
      el.style.height = `${view.height}px`
      el.style.transform = `translateY(${view.offsetTop}px)`
    }
    fit()
    view.addEventListener('resize', fit)
    view.addEventListener('scroll', fit)
    return () => {
      view.removeEventListener('resize', fit)
      view.removeEventListener('scroll', fit)
    }
  }, [])
  return box
}

interface SheetProps {
  /** The list to change, which is what the sheet shows until it is closed. */
  list: LoadList
  /** Called with the whole list at each change, as it was typed: it is tidied where it is kept (see `setLoad`). */
  onChange: (list: LoadList) => void
  onClose: () => void
}

/**
 * Changes what is loaded, as a sheet that comes up from the bottom: a box for each line with how many bundles, what kind and a note, Add
 * line, and how many papers are in a bundle of each kind. The whole stays in view at the top and each line's papers beside it, both
 * as they are typed. Every change is kept as it is made, so Done only closes it. It holds its own copy because a note has to stay as it
 * is typed (a space at the end of a word would be tidied away if the field showed what is kept), and only that note is any different.
 */
export function LoadSheet({ list, onChange, onClose }: SheetProps) {
  const [draft, setDraft] = useState(list)
  // The line Add line made, whose field is ready to type in, with the keypad up.
  const [added, setAdded] = useState<string | null>(null)
  const scrim = useAboveKeyboard()
  const addButton = useRef<HTMLButtonElement>(null)
  // Where the line just removed was, until the focus has been handed on.
  const refocus = useRef<number | null>(null)

  // The Remove button goes with its line, so the focus is handed on, to the Remove of the line that took its place or else to Add line. Left
  // alone it would drop to the top of the page, behind the sheet, for anyone on a keyboard or a screen reader.
  useLayoutEffect(() => {
    const at = refocus.current
    if (at === null) return
    refocus.current = null
    ;(scrim.current?.querySelectorAll<HTMLButtonElement>('.load-remove')[at] ?? addButton.current)?.focus()
  })

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const edit = (next: LoadList) => {
    setDraft(next)
    onChange(next)
  }

  const add = () => {
    const next = addLine(draft)
    setAdded(next.lines.at(-1)?.id ?? null)
    edit(next)
  }

  const remove = (id: string, at: number) => {
    refocus.current = at
    edit(removeLine(draft, id))
  }

  return (
    <div className="load-scrim" ref={scrim} onClick={onClose}>
      <div className="load-sheet" role="dialog" aria-modal="true" aria-label="Papers to load" onClick={(e) => e.stopPropagation()}>
        <div className="load-sheet-head">
          <div>
            <h2>Papers to load</h2>
            <div className="load-sheet-whole">{loadWhole(draft)}</div>
          </div>
          <button className="btn plain" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="load-sheet-scroll">
          {draft.lines.length === 0 && <p className="load-empty">Nothing on the list yet.</p>}
          {draft.lines.map((line, i) => (
            <div key={line.id} className="load-line" role="group" aria-label={`Line ${i + 1}`}>
              <div className="load-line-head">
                <span className="field-label">Line {i + 1}</span>
                <span className="load-line-papers">{linePapersText(line, draft)}</span>
              </div>
              <div className="load-line-row">
                <input
                  {...NUMBER_FIELD}
                  className="field-input load-bundles"
                  aria-label={`Line ${i + 1}, how many bundles`}
                  value={loadNumberText(line.bundles)}
                  autoFocus={line.id === added}
                  onKeyDown={closeKeyboard}
                  onChange={(e) => edit(changeLine(draft, line.id, { bundles: parseLoadNumber(e.target.value) }))}
                />
                <Segmented label={`Line ${i + 1}, what kind of bundle`} value={line.kind} options={KIND_OPTIONS} onChange={(kind) => edit(changeLine(draft, line.id, { kind }))} />
              </div>
              <div className="load-line-row">
                <input
                  className="field-input load-note"
                  aria-label={`Line ${i + 1}, note`}
                  value={line.note ?? ''}
                  maxLength={MAX_LOAD_NOTE}
                  placeholder="Note, e.g. 1 pallet"
                  enterKeyHint="done"
                  autoComplete="off"
                  autoCapitalize="sentences"
                  autoCorrect="off"
                  spellCheck={false}
                  onKeyDown={closeKeyboard}
                  onChange={(e) => edit(changeLine(draft, line.id, { note: e.target.value }))}
                />
                <button type="button" className="load-remove" aria-label={`Remove line ${i + 1}`} onClick={() => remove(line.id, i)}>
                  <Icon name="trash" size={20} />
                </button>
              </div>
            </div>
          ))}

          <button ref={addButton} type="button" className="btn secondary block" disabled={draft.lines.length >= MAX_LOAD_LINES} onClick={add}>
            <Icon name="plus" size={18} />
            Add line
          </button>

          <div className="section-label">Papers in a bundle</div>
          <div className="group">
            {LOAD_KINDS.map((kind) => (
              <label key={kind} className="row field">
                <span className="title">{KIND_TITLE[kind]}</span>
                <input
                  {...NUMBER_FIELD}
                  aria-label={PAPERS_LABEL[kind]}
                  value={loadNumberText(draft.papersEach[kind])}
                  onKeyDown={closeKeyboard}
                  onChange={(e) => edit(changePapersEach(draft, kind, parseLoadNumber(e.target.value)))}
                />
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

interface Props {
  /** The list kept with the route (`SavedRoute.load`). Left out, the route shows the usual list (`DEFAULT_LOAD`). */
  load?: LoadList
  /** Called with the whole list at each change in the sheet. Nothing is called until something is changed. */
  onLoad: (list: LoadList) => void
}

/**
 * What to load before the round, for the start screen: the bundles line by line and the papers they come to, as the driver writes it
 * down, ending with the whole, and Edit, which brings up the sheet that changes it.
 */
export function LoadCard({ load, onLoad }: Props) {
  const [editing, setEditing] = useState(false)
  const list = loadOf(load)
  const rows = loadRows(list)
  return (
    <section className="alert-setting load-card" aria-label="Papers to load">
      <div className="load-head">
        <div className="brush-label">Papers to load</div>
        <button className="btn plain load-edit" aria-label="Edit papers to load" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
      {rows.length > 0 ? (
        <ul className="group">
          {rows.map((row) => (
            <li key={row.id} className={row.subtotal ? 'load-row subtotal' : 'load-row'}>
              <span className="load-text">{row.text}</span>
              {row.papers && (
                <span className="load-papers">
                  {row.papers}
                  <span className="load-unit"> papers</span>
                </span>
              )}
            </li>
          ))}
          <li className="load-row whole">{loadWhole(list)}</li>
        </ul>
      ) : (
        <p className="fine">Nothing on the list yet. Tap Edit to add what you load.</p>
      )}
      {/* On the page itself, not in the start screen, whose rules for its centred text and its buttons would otherwise reach the sheet. */}
      {editing && createPortal(<LoadSheet list={list} onChange={onLoad} onClose={() => setEditing(false)} />, document.body)}
    </section>
  )
}
