// An agent's display drawn into a canvas (hooks/useDesktop.ts), in the order the board's VNC client
// (models/rfb.ts) hands it over. A JPEG is decoded by the browser itself (createImageBitmap, off
// the page's thread) and what comes after it waits until it is drawn: a later picture of a place is
// never covered by an earlier one that took longer to decode. With nothing being decoded, each
// is drawn at once, as before.
import type { RfbScreen } from './rfb.ts'

/** A decoded picture: drawn, then let go. */
export type Decoded = CanvasImageSource & { close?(): void }
export type JpegDecoder = (data: Uint8Array) => Promise<Decoded>

/** The browser's own decoder: createImageBitmap, or an image element where there is none. */
export function decodeJpeg(data: Uint8Array): Promise<Decoded> {
  const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob)
  const url = URL.createObjectURL(blob)
  const image = new Image()
  image.src = url
  return image
    .decode()
    .then(() => image)
    .finally(() => URL.revokeObjectURL(url))
}

/** The display drawn into `canvas`; `later(fn)`: fn once what came before is drawn. */
export type CanvasScreen = RfbScreen & { later(fn: () => void): void }

/** The display drawn into `canvas` (none drawn where the page has no 2D context). */
export function canvasScreen(canvas: HTMLCanvasElement, decode: JpegDecoder = decodeJpeg): CanvasScreen {
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
  /** What waits behind a picture still being decoded, in order; empty: drawn at once. */
  const waiting: { ready: boolean; draw: () => void }[] = []
  const flush = () => {
    while (waiting[0]?.ready) waiting.shift()?.draw()
  }
  const draw = (fn: () => void) => {
    if (waiting.length) waiting.push({ ready: true, draw: fn })
    else fn()
  }
  return {
    later: draw,
    size(width, height) {
      draw(() => {
        canvas.width = width
        canvas.height = height
      })
    },
    put(x, y, width, height, rgba) {
      draw(() => ctx?.putImageData(new ImageData(rgba, width, height), x, y))
    },
    copy(sx, sy, x, y, width, height) {
      draw(() => ctx?.drawImage(canvas, sx, sy, width, height, x, y, width, height))
    },
    fill(x, y, width, height, r, g, b) {
      draw(() => {
        if (!ctx) return
        ctx.fillStyle = `rgb(${r},${g},${b})`
        ctx.fillRect(x, y, width, height)
      })
    },
    jpeg(x, y, width, height, data) {
      const picture = { ready: false, draw: () => {} }
      waiting.push(picture)
      decode(data)
        .then(
          image => {
            picture.draw = () => {
              ctx?.drawImage(image, x, y, width, height)
              image.close?.()
            }
          },
          // one that does not decode is left out: what was there stays until that place changes again
          () => {},
        )
        .finally(() => {
          picture.ready = true
          flush()
        })
    },
  }
}
