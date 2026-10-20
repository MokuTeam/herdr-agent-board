// A picture from the clipboard into the message box on a phone (the board in a phone's browser,
// models/remote-page.ts). A phone's keyboard does not paste a picture into a text box, so the box
// has a button that reads the clipboard (the async Clipboard API: HTTPS through tailscale serve
// gives the page a secure context). Chrome asks once for the right to read it; Safari shows its own
// Paste bubble. The paperclip's picker, with the camera and the photos, stays the way round.

/** What the button needs of `navigator.clipboard`. */
export interface ClipboardLike {
  read(): Promise<readonly { types: readonly string[]; getType(type: string): Promise<Blob> }[]>
}

export type ClipboardImages = { files: File[] } | { error: 'empty' | 'denied' | 'failed'; why?: string }

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

/** The pictures on the clipboard, or why there are none: nothing there, not allowed, or another failure. */
export async function readClipboardImages(clipboard: ClipboardLike): Promise<ClipboardImages> {
  let items: Awaited<ReturnType<ClipboardLike['read']>>
  try {
    items = await clipboard.read()
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    // Not allowed (the site's setting, or the Paste bubble dismissed), or the page not in front.
    if (name === 'NotAllowedError' || name === 'SecurityError') return { error: 'denied' }
    return { error: 'failed', why: err instanceof Error ? err.message : String(err) }
  }
  const files: File[] = []
  for (const item of items) {
    const type = item.types.find(t => t.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    files.push(new File([blob], clipboardName(type), { type }))
  }
  return files.length ? { files } : { error: 'empty' }
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
