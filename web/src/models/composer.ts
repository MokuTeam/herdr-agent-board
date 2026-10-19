// The message box under the conversation: Enter sends, Shift+Enter breaks the line; files come in
// through the clip, a paste or a drop and upload at once, and the message carries their paths.
// When it can send, what its buttons say, and the toast once it went.
import type { Translator } from '../../../src/core/types.ts'

export type AttachmentStatus = 'uploading' | 'done' | 'error'

export interface Attachment {
  id: number
  name: string
  size: number
  /** A picture the box previews (from `url`, the file in the browser). */
  image: boolean
  url: string
  status: AttachmentStatus
  /** Where the board saved it, once uploaded. */
  path: string
}

/** Enter sends (not while an input method composes a word); Shift+Enter is a new line. */
export const sendsOnKey = (e: { key: string; shiftKey: boolean; isComposing: boolean }): boolean =>
  e.key === 'Enter' && !e.shiftKey && !e.isComposing

export const isUploading = (list: readonly Attachment[]): boolean => list.some(a => a.status === 'uploading')

/** The paths of the files that made it to the board: the message carries them. */
export const uploadedPaths = (list: readonly Attachment[]): string[] =>
  list.filter(a => a.status === 'done').map(a => a.path)

export interface ComposerScene {
  /** The open session is on the board and its detail does not say it is gone. */
  present: boolean
  /** A message to it is on its way. */
  sending: boolean
  canMutate: boolean
  text: string
  attachments: readonly Attachment[]
}

export interface ComposerView {
  sendDisabled: boolean
  sendTitle: string
  /** The discard button shows once there is a draft (text or files). */
  discardHidden: boolean
  discardDisabled: boolean
}

/** web/app.js syncComposer, without the box's height. */
export function composerView(scene: ComposerScene, t: Translator): ComposerView {
  const uploading = isUploading(scene.attachments)
  const ready = scene.attachments.some(a => a.status === 'done')
  return {
    sendDisabled: !scene.present || scene.sending || !scene.canMutate || uploading || !(scene.text.trim() || ready),
    sendTitle: t(uploading ? 'compose.uploading' : 'compose.send'),
    discardHidden: !(scene.text || scene.attachments.length),
    discardDisabled: scene.sending,
  }
}

/** Whether a submit goes out: fresh data, a session, nothing on its way, something to send, no upload still going. */
export function canSubmit(scene: {
  canMutate: boolean
  key: string | null
  sending: boolean
  text: string
  files: readonly string[]
  uploading: boolean
}): boolean {
  return scene.canMutate && !!scene.key && !scene.sending && !!(scene.text || scene.files.length) && !scene.uploading
}

/** "Sent to Alpha · 2 files". */
export function sentText(name: string | undefined, files: number, t: Translator): string {
  return `${t('sent.to', { name: name ?? t('session.lower') })}${files ? ` · ${t('sent.files', { n: files })}` : ''}`
}

export function sizeText(n: number, t: Translator): string {
  if (n < 1024) return t('size.b', { n })
  if (n < 1 << 20) return t('size.kb', { n: Math.round(n / 1024) })
  return t('size.mb', { n: (n / (1 << 20)).toFixed(1) })
}

/** A pasted screenshot arrives as "image.png": the name it gets instead, saying what it is (null: keep its own). */
export function screenshotName(name: string, now: Date): string | null {
  if (!/^image\.(png|jpe?g)$/i.test(name)) return null
  const stamp = now.toTimeString().slice(0, 8).replace(/:/g, '')
  return `screenshot-${stamp}.${name.split('.').pop()}`
}

/** Pictures the box previews. */
export const previewsAsImage = (type: string): boolean => /^image\/(png|jpeg|gif|webp)$/.test(type)

export type DragStep = 'enter' | 'leave' | 'drop'

/**
 * Files dragged over the panel: how deep in it the drag is (entering a child counts again), so
 * the panel lights up from the first enter to the last leave or the drop. Only drags of files
 * enter; any leave counts down.
 */
export function nextDropDepth(depth: number, step: DragStep, files: boolean): number {
  if (step === 'enter') return files ? depth + 1 : depth
  if (step === 'drop') return files ? 0 : depth
  return depth - 1 <= 0 ? 0 : depth - 1
}
