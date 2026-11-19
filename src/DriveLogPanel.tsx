import { useEffect, useState } from 'react'
import { useDialogs } from './confirm'
import { deleteDrives, driveFileName, driveGpx, driveJson, listDrives, readDrive, saveDriveFile } from './driveLog'
import { Icon } from './Icon'

type Kept = Awaited<ReturnType<typeof listDrives>>[number]

/** How many of the drives kept are listed, newest first. */
const SHOWN = 5

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

/**
 * The drives kept with Record this round (in the round's menu), each to save as a file: JSON, which has the route in it and can be played through
 * the tracker again, or GPX, for a map. They stay on this phone until saved or deleted here.
 */
export function DriveLogPanel() {
  const [drives, setDrives] = useState<Kept[] | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const { confirm, dialog } = useDialogs()

  useEffect(() => {
    let gone = false
    void listDrives().then((list) => {
      if (!gone) setDrives(list)
    })
    return () => {
      gone = true
    }
  }, [])

  const save = async (d: Kept, kind: 'json' | 'gpx') => {
    const kept = await readDrive(d.id)
    if (!kept) return setStatus('That drive could not be read.')
    const text = kind === 'json' ? driveJson(kept.info, kept.entries) : driveGpx(kept.info, kept.entries)
    const ok = await saveDriveFile(text, driveFileName(kept.info, kind), kind === 'json' ? 'application/json' : 'application/gpx+xml')
    setStatus(ok ? null : 'Not saved.')
  }

  const remove = async () => {
    const ok = await confirm({ title: 'Delete Recorded Drives?', message: 'Every drive kept on this phone goes. Your routes and rounds stay as they are.', confirmLabel: 'Delete', destructive: true })
    if (!ok) return
    await deleteDrives()
    setDrives(await listDrives())
  }

  if (drives === null) return null
  return (
    <div className="group">
      <div className="row">
        <span className="icon-tint">
          <Icon name="download" size={22} />
        </span>
        <div className="grow">
          <div className="title">Recorded Drives</div>
          <div className="sub">
            {drives.length
              ? `${drives.length} kept on this phone. Save one as a file to replay it.`
              : 'None yet. Turn on Record this round in the round’s menu to keep the GPS of a drive here.'}
          </div>
        </div>
      </div>
      {drives.slice(0, SHOWN).map((d) => (
        <div className="row" key={d.id}>
          <div className="grow">
            <div className="title">{d.routeName}</div>
            <div className="sub">
              {when(d.startedAt)} · {d.fixes.toLocaleString()} fixes
            </div>
          </div>
          <button className="btn secondary" onClick={() => void save(d, 'json')}>
            JSON
          </button>
          <button className="btn secondary" onClick={() => void save(d, 'gpx')}>
            GPX
          </button>
        </div>
      ))}
      {status && <p className="footnote">{status}</p>}
      {drives.length > 0 && (
        <button className="btn plain danger block" onClick={() => void remove()}>
          Delete Recorded Drives
        </button>
      )}
      {dialog}
    </div>
  )
}
