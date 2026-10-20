// A picture from the clipboard into the message box on a phone (the board in a phone's browser,
// models/remote-page.ts). A phone's keyboard does not paste a picture into a text box, so the box
// has a button that reads the clipboard (the async Clipboard API: HTTPS through tailscale serve
// gives the page a secure context). Chrome asks once for the right to read it; Safari shows its own
// Paste bubble. The paperclip's picker, with the camera and the photos, stays the way round.

/** What the button needs of `navigator.clipboard`. */
export interface ClipboardLike {
  read(): Promise<readonly { types: readonly string[]; getType(type: string): Promise<Blob> }[]>
}

/**
 * The pictures, or why there are none; `seen` says what the clipboard held, for the toast and the
 * board's log (#102: a phone's Chrome may hand over no picture though one was copied).
 */
export type ClipboardImages = { files: File[] } | { error: 'empty' | 'denied' | 'failed'; why?: string; seen: string }

/** Whether this browser can read pictures from the clipboard at all. */
export const canReadClipboard = (clipboard: unknown): clipboard is ClipboardLike =>
  !!clipboard && typeof (clipboard as { read?: unknown }).read === 'function'

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** The name a picture from the clipboard goes under, as a pasted screenshot's on the computer. */
export const clipboardName = (type: string): string => `image.${EXT[type] ?? type.split('/')[1] ?? 'png'}`

/** A picture's type as the clipboard names it: `image/…`, or a page's own `web image/…`. */
const imageType = (type: string): string | null =>
  /^(?:web )?(image\/[\w.+-]+)$/i.exec(type)?.[1]?.toLowerCase() ?? null

/** A picture written into HTML as a data: URL (some apps copy a picture so), else null. */
export function htmlImage(html: string): File | null {
  const m = /<img\b[^>]*\bsrc\s*=\s*["']data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)["']/i.exec(html)
  if (!m?.[1] || !m[2]) return null
  try {
    const bytes = Uint8Array.from(atob(m[2].replace(/\s+/g, '')), c => c.charCodeAt(0))
    return new File([bytes], clipboardName(m[1]), { type: m[1] })
  } catch {
    return null
  }
}

/** The pictures on the clipboard, or why there are none: nothing there, not allowed, or another failure. */
export async function readClipboardImages(clipboard: ClipboardLike): Promise<ClipboardImages> {
  let items: Awaited<ReturnType<ClipboardLike['read']>>
  try {
    items = await clipboard.read()
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    const why = err instanceof Error ? err.message : String(err)
    const seen = `${name || 'Error'}: ${why}`
    // Not allowed (the site's setting, or the Paste bubble dismissed), or the page not in front.
    if (name === 'NotAllowedError' || name === 'SecurityError') return { error: 'denied', seen }
    return { error: 'failed', why, seen }
  }
  const files: File[] = []
  for (const item of items) {
    const type = item.types.find(t => imageType(t))
    const html = item.types.includes('text/html') ? 'text/html' : null
    if (type) {
      const blob = await item.getType(type)
      const as = imageType(type) ?? 'image/png'
      files.push(new File([blob], clipboardName(as), { type: as }))
    } else if (html) {
      const found = htmlImage(await (await item.getType(html)).text())
      if (found) files.push(found)
    }
  }
  if (files.length) return { files }
  const seen = items.map(item => item.types.join(' + ') || 'an empty item').join('; ') || 'nothing'
  return { error: 'empty', seen }
}

const HINT_KEY = 'agent-board:paste-hint-seen'

/** Whether the paste button's one-time hint was seen (used or tapped away) in this browser. */
export function pasteHintSeen(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return true
  }
}

export function keepPasteHintSeen(): void {
  try {
    localStorage.setItem(HINT_KEY, '1')
  } catch {}
}
