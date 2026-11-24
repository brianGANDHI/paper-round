import { useState } from 'react'
import { Icon } from './Icon'
import { photoTag } from './photos'
import { stopName } from './routeEdit'
import type { Stop } from './types'
import { usePhotoUrl } from './usePhotos'
import './photos.css'

interface Props {
  stop: Stop
  /** The driver tapped it: it goes until the next alert. */
  onPutAway: () => void
}

/**
 * The driver's own photo of the place, with its alert: a small square under the alert, marked with which house or place it is of. It comes once it has
 * been read and can be drawn, and nothing waits for it: until then, or if it can't be, the alert is as it is without one. It has nothing for a screen
 * reader to read out with the alert, only the button that puts it away.
 */
export function AlertPhoto({ stop, onPutAway }: Props) {
  const url = usePhotoUrl(stop.id)
  /** The photo that has been drawn, and the one that could not be. */
  const [drawn, setDrawn] = useState<string | null>(null)
  const [broken, setBroken] = useState<string | null>(null)
  if (!url || broken === url) return null
  return (
    <button className={`alert-photo ${stop.type}`} hidden={drawn !== url} aria-label={`Photo of ${stopName(stop)}. Tap to put it away.`} onClick={onPutAway}>
      <img src={url} alt="" decoding="async" draggable={false} onLoad={() => setDrawn(url)} onError={() => setBroken(url)} />
      <span className="alert-photo-x">
        <Icon name="x" size={13} strokeWidth={3} />
      </span>
      <span className="alert-photo-tag">{photoTag(stop)}</span>
    </button>
  )
}
