import { useState } from 'react'
import { makeBackup } from './backup'
import { BackupDialog, RestoreDialog } from './BackupDialogs'
import { useDialogs } from './confirm'
import { formatDate, plural } from './format'
import { Icon } from './Icon'
import {
  activeRoute,
  addImported,
  addRoute,
  deleteRoute,
  duplicateRoute,
  renameRoute,
  selectRoute,
  uniqueName,
} from './library'
import { formatDistance, routeLength } from './routeEdit'
import { Banner } from './ui'
import type { Library, SavedRoute } from './types'

interface Props {
  library: Library
  /** Change the saved routes. The result is saved straight away. */
  update: (change: (lib: Library) => Library) => void
  onGoSetup: () => void
}

type Notice = { text: string; warn?: boolean }
type Sheet = { kind: 'backup'; title: string; text: string } | { kind: 'restore' } | null

function describe(r: SavedRoute): string {
  const { points, stops } = r.route
  const parts = [points.length > 1 ? formatDistance(routeLength(points)) : 'No route drawn yet']
  if (stops.length) parts.push(plural(stops.length, 'stop', 'stops'))
  if (r.updatedAt) parts.push(`edited ${formatDate(r.updatedAt)}`)
  return parts.join(' · ')
}

export function Routes({ library, update, onGoSetup }: Props) {
  const { confirm, prompt, dialog } = useDialogs()
  const [notice, setNotice] = useState<Notice | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const active = activeRoute(library)

  const choose = (id: string) => {
    update((lib) => selectRoute(lib, id))
    setNotice(null)
  }

  const create = async () => {
    const name = await prompt({
      title: 'New Route',
      message: 'Give it a name, like “Monday Round”.',
      confirmLabel: 'Create',
      defaultValue: uniqueName(library, `Route ${library.routes.length + 1}`),
      placeholder: 'Route name',
    })
    if (name === null) return
    update((lib) => addRoute(lib, name))
    onGoSetup()
  }

  const rename = async () => {
    const name = await prompt({
      title: 'Rename Route',
      confirmLabel: 'Rename',
      defaultValue: active.name,
      placeholder: 'Route name',
    })
    if (name === null) return
    update((lib) => renameRoute(lib, active.id, name))
    setNotice(null)
  }

  const duplicate = () => {
    const name = uniqueName(library, `${active.name} copy`)
    update((lib) => duplicateRoute(lib, active.id))
    setNotice({ text: `Copied. You're now using “${name}”.` })
  }

  const remove = async () => {
    const ok = await confirm({
      title: `Delete “${active.name}”?`,
      message: 'This removes the route, its sections and its stops from this phone. Back it up first if you might want it again.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    update((lib) => deleteRoute(lib, active.id))
    setNotice({ text: `Deleted “${active.name}”.` })
  }

  const backUp = (scope: 'one' | 'all') => {
    const routes = (scope === 'one' ? [active] : library.routes).map((r) => ({ name: r.name, route: r.route }))
    setSheet({
      kind: 'backup',
      title: scope === 'one' ? `Back Up “${active.name}”` : `Back Up All Routes (${routes.length})`,
      text: makeBackup(routes),
    })
  }

  return (
    <div className="screen scroll">
      <div className="page">
        <h1 className="large-title">Routes</h1>

        {notice && <Banner kind={notice.warn ? 'warn' : 'info'}>{notice.text}</Banner>}

        <ul className="group" aria-label="Your routes">
          {library.routes.map((r) => (
            <li className="row" key={r.id}>
              <button className="grow rowbtn" aria-current={r.id === active.id ? 'true' : undefined} onClick={() => choose(r.id)}>
                <div className="title">{r.name}</div>
                <div className="sub">{describe(r)}</div>
              </button>
              {r.id === active.id && (
                <span className="icon-tint" aria-label="In use">
                  <Icon name="check" size={22} strokeWidth={2.6} />
                </span>
              )}
            </li>
          ))}
        </ul>

        <button className="btn primary block" onClick={create}>
          <Icon name="plus" size={20} strokeWidth={2.4} />
          New Route
        </button>

        <div className="section-label">{active.name}</div>
        <div className="group">
          <button className="row" onClick={rename}>
            <span className="icon-tint">
              <Icon name="edit" size={22} />
            </span>
            <span className="grow title">Rename</span>
          </button>
          <button className="row" onClick={duplicate}>
            <span className="icon-tint">
              <Icon name="copy" size={22} />
            </span>
            <span className="grow title">Duplicate</span>
          </button>
          <button className="row" onClick={remove}>
            <span className="icon-danger">
              <Icon name="trash" size={22} />
            </span>
            <span className="grow title danger">Delete</span>
          </button>
        </div>

        <div className="section-label">Back up and restore</div>
        <div className="group">
          <button className="row" onClick={() => backUp('one')}>
            <span className="icon-tint">
              <Icon name="download" size={22} />
            </span>
            <span className="grow title">Back Up This Route</span>
          </button>
          <button className="row" onClick={() => backUp('all')}>
            <span className="icon-tint">
              <Icon name="download" size={22} />
            </span>
            <span className="grow title">Back Up All Routes</span>
          </button>
          <button className="row" onClick={() => setSheet({ kind: 'restore' })}>
            <span className="icon-tint">
              <Icon name="upload" size={22} />
            </span>
            <span className="grow title">Restore from Backup</span>
          </button>
        </div>

        <p className="footnote">
          Your routes are saved automatically on this phone and stay here for future runs. A backup is a piece of text you can keep in Notes, or paste into the app on another phone to move your routes across.
        </p>
      </div>

      {sheet?.kind === 'backup' && <BackupDialog title={sheet.title} text={sheet.text} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'restore' && (
        <RestoreDialog
          onClose={() => setSheet(null)}
          onRestore={(routes) => {
            update((lib) => addImported(lib, routes))
            setSheet(null)
            setNotice({ text: `Added ${plural(routes.length, 'route', 'routes')} from the backup.` })
          }}
        />
      )}
      {dialog}
    </div>
  )
}
