import { useEffect, useRef, useState } from 'react'
import { useDialogs } from './confirm'
import { inSafariTab } from './device'
import { saveDriveFile } from './driveLog'
import { plural } from './format'
import { Icon } from './Icon'
import { formatBytes, MAX_PHOTOS_FILE, parsePhotosFile, PHOTOS_FILE_END, photosFileEntry, photosFileName, photosFileStart, restoreSummary, UNUSED_DAYS, type PhotoEntry, type PhotoInfo } from './photos'
import { photoInfos, readPhoto, removePhotos, restorePhotos } from './photoStore'
import { Banner } from './ui'
import { usePhotoInfos } from './usePhotos'

/** The photos file, made ready: its pieces, how many photos are in it, and how many could not be read. */
interface Made {
  parts: string[]
  saved: number
  unread: number
}

/** Makes the photos file ready, or null when the photos can't be read or it is no longer wanted. */
async function makeFile(isGone: () => boolean): Promise<Made | null> {
  const list = await photoInfos()
  if (!list) return null
  const parts = [photosFileStart(new Date())]
  let saved = 0
  for (const { stopId } of list) {
    const jpeg = await readPhoto(stopId)
    if (isGone()) return null
    if (jpeg) parts.push(photosFileEntry({ stopId, jpeg }, saved++ === 0))
  }
  parts.push(PHOTOS_FILE_END)
  return { parts, saved, unread: list.length - saved }
}

interface BackUpProps {
  /** The stops on every route here, for telling which photos are of none. */
  used: ReadonlySet<string>
  onClose: () => void
}

/**
 * Saves every photo kept on this phone as one file, apart from the routes' backup, which is text to paste and has no room for pictures. Photos of stops
 * on no route any more are in it too, and can be deleted here sooner than the app would.
 */
export function BackUpPhotosDialog({ used, onClose }: BackUpProps) {
  const infos = usePhotoInfos()
  const [made, setMade] = useState<{ file: Made; of: readonly PhotoInfo[] | null } | null>(null)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const { confirm, dialog } = useDialogs()
  const ready = made && made.of === infos ? made.file : null
  const unused = infos?.filter((i) => !used.has(i.stopId)) ?? []

  // The file has to be ready before Save File is tapped, as a phone opens its share sheet only at a tap. It is made again when a photo is added or
  // removed, as deleting those on no route does here.
  useEffect(() => {
    let gone = false
    void makeFile(() => gone).then((file) => {
      if (gone) return
      setMade(file && { file, of: infos })
      setTrouble(file ? null : "This phone isn't letting the app read its photos. Close the app, open it again and try again.")
    })
    return () => {
      gone = true
    }
  }, [infos])

  const saveFile = async () => {
    if (!ready) return
    setTrouble(null)
    const ok = await saveDriveFile(ready.parts, photosFileName(new Date()), 'text/plain', 'Paper Round photos')
    setSaved(ok)
    if (!ok) setTrouble('The file was not saved.')
  }

  const deleteUnused = async () => {
    const ok = await confirm({
      title: `Delete ${plural(unused.length, 'Photo', 'Photos')}?`,
      message: 'They are of stops on no route here. If you restore a route that has those stops, their photos will not come back.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    if (!(await removePhotos(unused.map((i) => i.stopId)))) setTrouble('They could not be deleted. Try again.')
  }

  const total = infos?.reduce((sum, i) => sum + i.bytes, 0) ?? 0
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="dialog-title">Back Up Photos</h2>
        {infos?.length === 0 ? (
          <p>There are no photos on this phone yet. Add one in Setup, under Stops, with the camera button beside a stop.</p>
        ) : (
          <p>
            {infos ? `${plural(infos.length, 'photo', 'photos')}, ${formatBytes(total)}. ` : ''}Save them as a file and keep it somewhere private, as anyone who has it can see them. To get them back, choose Restore Photos,
            after restoring the routes they go with. A backup of your routes has no photos in it.
          </p>
        )}
        {trouble && <Banner kind="warn">{trouble}</Banner>}
        {ready && ready.unread > 0 && <Banner kind="warn">{plural(ready.unread, 'photo', 'photos')} couldn't be read, so the file doesn't have {ready.unread === 1 ? 'it' : 'them'}.</Banner>}
        {infos?.length !== 0 && (
          <button className="btn primary block" disabled={!ready || ready.saved === 0} onClick={() => void saveFile()}>
            <Icon name={saved ? 'check' : 'download'} size={18} strokeWidth={saved ? 2.4 : 2} />
            {saved ? 'Saved' : ready || trouble ? 'Save File' : 'Getting them ready...'}
          </button>
        )}
        {unused.length > 0 && (
          <>
            <p>
              {plural(unused.length, 'photo is of a stop', 'photos are of stops')} on no route here any more. {unused.length === 1 ? 'It is' : 'They are'} kept for {UNUSED_DAYS} days in case you restore the route.
            </p>
            <button className="btn plain danger block" onClick={() => void deleteUnused()}>
              Delete {unused.length === 1 ? 'It' : 'Them'} Now
            </button>
          </>
        )}
        <button className="btn plain block" onClick={onClose}>
          Done
        </button>
      </div>
      {dialog}
    </div>
  )
}

interface RestoreProps {
  used: ReadonlySet<string>
  onClose: () => void
}

/** Puts the photos of a photos file back, each with the stop it is of. Asks first where a stop here has a photo already. */
export function RestorePhotosDialog({ used, onClose }: RestoreProps) {
  const [status, setStatus] = useState<{ text: string; warn?: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const { choose, dialog } = useDialogs()
  const picker = useRef<HTMLInputElement>(null)

  const restore = async (photos: PhotoEntry[], damaged: number) => {
    const infos = await photoInfos()
    if (!infos) return setStatus({ text: "This phone isn't letting the app keep photos, so nothing was restored. Try a normal (not private) tab.", warn: true })
    const here = new Set(infos.map((i) => i.stopId))
    const clashes = photos.filter((p) => here.has(p.stopId)).length
    let wanted = photos
    if (clashes) {
      const picked = await choose({
        title: clashes === 1 ? 'One Stop Already Has a Photo' : `${clashes} Stops Already Have Photos`,
        message: 'Use the photos in the file for them, or keep the ones here?',
        choices: [
          { value: 'replace', label: "Use the File's", detail: 'The photos here are replaced' },
          { value: 'keep', label: 'Keep the Ones Here', detail: 'Only stops with no photo get one from the file' },
        ],
      })
      if (!picked) return
      if (picked === 'keep') wanted = photos.filter((p) => !here.has(p.stopId))
    }
    if (!wanted.length) {
      setDone(true)
      return setStatus({ text: 'Nothing was changed: every stop in the file has a photo here already.' })
    }
    setBusy(`Restoring 1 of ${wanted.length}...`)
    const count = await restorePhotos(wanted, (n) => setBusy(`Restoring ${Math.min(n + 1, wanted.length)} of ${wanted.length}...`))
    const trouble = count.saved < wanted.length
    setDone(!trouble)
    setStatus({ text: restoreSummary(count, damaged, trouble ? 0 : wanted.filter((p) => !used.has(p.stopId)).length), warn: trouble || damaged > 0 })
  }

  const open = async (file: File | undefined) => {
    if (!file) return
    setStatus(null)
    setDone(false)
    if (file.size > MAX_PHOTOS_FILE) return setStatus({ text: 'That file is too big to be a photos file.', warn: true })
    setBusy('Reading the file...')
    try {
      const result = parsePhotosFile(await file.text())
      if (result.ok) await restore(result.photos, result.damaged)
      else setStatus({ text: result.error, warn: true })
    } catch {
      setStatus({ text: "Couldn't read that file.", warn: true })
    }
    setBusy(null)
  }

  return (
    <div className="scrim" onClick={busy ? undefined : onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="dialog-title">Restore Photos</h2>
        <p>Open the photos file you saved. Each photo goes back to its own stop, so restore the routes first if they aren't here.</p>
        {inSafariTab() && <Banner>If you run your round from the Home Screen app, restore in that app instead. Safari and the Home Screen app keep separate photos.</Banner>}
        {status && <Banner kind={status.warn ? 'warn' : 'info'}>{status.text}</Banner>}
        <input
          ref={picker}
          type="file"
          hidden
          accept=".txt,.json,text/plain,application/json"
          aria-label="Photos file to restore"
          onChange={(e) => {
            void open(e.target.files?.[0])
            // So choosing the same file again still counts.
            e.target.value = ''
          }}
        />
        {!done && (
          <button className="btn primary block" disabled={busy !== null} onClick={() => picker.current?.click()}>
            <Icon name="upload" size={18} />
            {busy ?? 'Open File'}
          </button>
        )}
        <button className="btn plain block" disabled={busy !== null} onClick={onClose}>
          {done ? 'Done' : 'Cancel'}
        </button>
      </div>
      {dialog}
    </div>
  )
}
