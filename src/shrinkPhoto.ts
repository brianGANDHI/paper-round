import { cleanJpeg, PHOTO_BYTES, PHOTO_QUALITIES, shrunkSize } from './photos'

/** Draws the picture in a file on the page, upright, as the phone shows it. Null when it isn't a picture the phone can open. */
function openPicture(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

/**
 * A photo from the camera or the library made ready to keep: drawn again small, on the phone, and saved as a JPEG with nothing in it but the picture,
 * so where and when it was taken is left behind. Null when it can't be read as a picture. The photo it came from is not touched.
 */
export async function shrinkPhoto(file: Blob): Promise<Uint8Array<ArrayBuffer> | null> {
  const url = URL.createObjectURL(file)
  try {
    const img = await openPicture(url)
    const size = img && shrunkSize(img.naturalWidth, img.naturalHeight)
    if (!img || !size) return null
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    const pen = canvas.getContext('2d')
    if (!pen) return null
    // A picture with see-through parts would come out black there.
    pen.fillStyle = '#fff'
    pen.fillRect(0, 0, size.width, size.height)
    pen.imageSmoothingQuality = 'high'
    pen.drawImage(img, 0, 0, size.width, size.height)
    let best: Uint8Array<ArrayBuffer> | null = null
    for (const quality of PHOTO_QUALITIES) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
      const jpeg = blob && cleanJpeg(new Uint8Array(await blob.arrayBuffer()))
      if (jpeg) best = jpeg
      if (jpeg && jpeg.length <= PHOTO_BYTES) break
    }
    return best
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}
