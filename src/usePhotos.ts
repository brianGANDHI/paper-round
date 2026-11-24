import { useEffect, useMemo, useState } from 'react'
import { onPhotosChanged, photoInfos, readPhoto } from './photoStore'
import type { PhotoInfo } from './photos'

/** What is known of every photo kept, up to date as they change. Null until the phone has said, or when it can't. */
export function usePhotoInfos(): readonly PhotoInfo[] | null {
  const [infos, setInfos] = useState<readonly PhotoInfo[] | null>(null)
  useEffect(() => {
    let gone = false
    // Answers come back in any order, and only the latest asked for counts.
    let asked = 0
    const load = () => {
      const mine = ++asked
      void photoInfos().then((list) => {
        if (!gone && mine === asked && list) setInfos(list)
      })
    }
    load()
    const stop = onPhotosChanged(load)
    return () => {
      gone = true
      stop()
    }
  }, [])
  return infos
}

const NONE: ReadonlySet<string> = new Set()

/** The stops that have a photo, by id. None until the phone has said which. */
export function usePhotoIds(): ReadonlySet<string> {
  const infos = usePhotoInfos()
  return useMemo(() => (infos?.length ? new Set(infos.map((i) => i.stopId)) : NONE), [infos])
}

/** Where the page can show a stop's photo from, or null while it is being read or when there is none. Read when asked for, so nothing waits for it. */
export function usePhotoUrl(stopId: string): string | null {
  const [made, setMade] = useState<{ stopId: string; url: string } | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => onPhotosChanged((ids) => ids.includes(stopId) && setVersion((v) => v + 1)), [stopId])
  useEffect(() => {
    let gone = false
    let url: string | null = null
    void readPhoto(stopId).then((jpeg) => {
      if (gone) return
      url = jpeg && URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }))
      setMade(url ? { stopId, url } : null)
    })
    return () => {
      gone = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [stopId, version])
  return made?.stopId === stopId ? made.url : null
}
