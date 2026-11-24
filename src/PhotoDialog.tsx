import { useEffect, useRef, useState } from 'react'
import { useDialogs } from './confirm'
import { Icon } from './Icon'
import { PHOTO_TROUBLE, streetViewUrl } from './photos'
import { removePhotos, savePhoto } from './photoStore'
import { stopName } from './routeEdit'
import { shrinkPhoto } from './shrinkPhoto'
import { loadPhotoNoThrow, savePhotoNoThrow } from './storage'
import type { Pt, Stop } from './types'
import { Banner, Segmented } from './ui'
import { usePhotoIds, usePhotoUrl } from './usePhotos'
import './photos.css'

interface Props {
  stop: Stop
  /** The route's line, for which way Street View looks. */
  points: Pt[]
  onClose: () => void
}

type Status = { text: string; warn?: boolean } | null

/** A phone has a camera to open straight into. A computer's is at the desk, so it only chooses a file. */
const hasCamera = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/**
 * A stop's photo, in Setup: take one, choose one already taken, or remove it. It is kept the moment it is picked, not with the stop's other details, as
 * it is no part of the route: the round in progress is not touched by it. What the phone says of each save is said here, a photo that wasn't kept as
 * plainly as one that was. Under it is the link to Street View, for finding out what the place looks like before there is a photo of it.
 */
export function PhotoDialog({ stop, points, onClose }: Props) {
  const has = usePhotoIds().has(stop.id)
  const url = usePhotoUrl(stop.id)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [noThrow, setNoThrow] = useState(loadPhotoNoThrow)
  const { confirm, dialog } = useDialogs()
  const camera = useRef<HTMLInputElement>(null)
  const library = useRef<HTMLInputElement>(null)
  const name = stopName(stop)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !dialog && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, dialog, busy])

  const keep = async (file: File | undefined) => {
    if (!file || busy) return
    setBusy(true)
    setStatus(null)
    const replaced = has
    const jpeg = await shrinkPhoto(file)
    if (!jpeg) {
      setStatus({ text: "That file couldn't be opened as a photo, so nothing was changed.", warn: true })
    } else {
      const result = await savePhoto(stop.id, jpeg)
      if (result === 'saved') setStatus({ text: replaced ? 'New photo saved on this phone.' : 'Photo saved on this phone.' })
      else setStatus({ text: `${PHOTO_TROUBLE[result]}${replaced && result !== 'failed' ? ' The old photo is still there.' : ''}`, warn: true })
    }
    setBusy(false)
  }

  const remove = async () => {
    const ok = await confirm({ title: 'Remove This Photo?', message: 'It goes from this phone, and can only come back from a photos file you have saved.', confirmLabel: 'Remove', destructive: true })
    if (!ok) return
    const gone = await removePhotos([stop.id])
    setStatus(gone ? { text: 'Photo removed.' } : { text: 'The photo could not be removed. Try again.', warn: true })
  }

  const picker = (ref: typeof camera, label: string, capture?: 'environment') => (
    <input
      ref={ref}
      type="file"
      hidden
      accept="image/*"
      capture={capture}
      aria-label={label}
      onChange={(e) => {
        void keep(e.target.files?.[0])
        // So choosing the same photo again still counts.
        e.target.value = ''
      }}
    />
  )

  return (
    // It stays up until a save is over, so a photo that wasn't kept is never missed.
    <div className="scrim" onClick={busy ? undefined : onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="photo-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="photo-title">{name}</h2>
        {url ? (
          <img className="photo-view" src={url} alt={`The place at ${name}`} />
        ) : (
          <div className="photo-view none">
            <Icon name="camera" size={34} strokeWidth={1.6} />
            <span>{has ? 'Opening the photo...' : 'No photo yet'}</span>
          </div>
        )}
        {status && <Banner kind={status.warn ? 'warn' : 'info'}>{status.text}</Banner>}
        <div className="btn-row photo-picks">
          {hasCamera() && (
            <button className="btn primary" disabled={busy} onClick={() => camera.current?.click()}>
              <Icon name="camera" size={18} />
              Take Photo
            </button>
          )}
          <button className={hasCamera() ? 'btn secondary' : 'btn primary wide'} disabled={busy} onClick={() => library.current?.click()}>
            <Icon name="image" size={18} />
            Choose Photo
          </button>
        </div>
        {picker(camera, 'Take a photo of this stop', 'environment')}
        {picker(library, 'Choose a photo of this stop')}
        {busy && <p>Saving the photo...</p>}
        {stop.type === 'nothrow' && (
          <div className="photo-switch">
            <span className="field-label">Photos of no-throw houses on the round</span>
            <Segmented
              label="Whether photos of no-throw houses show on the round"
              value={noThrow ? 'on' : 'off'}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'on', label: 'On' },
              ]}
              onChange={(v) => {
                setNoThrow(v === 'on')
                if (!savePhotoNoThrow(v === 'on')) setStatus({ text: "This phone isn't letting the app save, so the switch goes back to Off when the app closes.", warn: true })
              }}
            />
          </div>
        )}
        <a className="btn secondary block" href={streetViewUrl(stop, points)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
          <Icon name="map" size={18} />
          Open Street View
        </a>
        <p className="photo-note">
          Your photo is made small and kept on this phone only, with where it was taken left out. Street View opens in Google Maps, and tells Google where this stop is only
          when you tap it. Use photos of your own: Google doesn't allow its pictures to be saved.
        </p>
        {has && (
          <button className="btn plain danger block" disabled={busy} onClick={() => void remove()}>
            Remove Photo
          </button>
        )}
        <button className="btn plain block" disabled={busy} onClick={onClose}>
          Done
        </button>
      </div>
      {dialog}
    </div>
  )
}
