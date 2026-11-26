// A picture from a Team message opened full size inside the board's page (#873,
// components/files/PictureLook.tsx): what is on show, where it grew out of, and whether it is on
// its way back into it. The Team panel opens it; the page draws it and counts it among its layers
// (the phone's Back closes it first).
import type { DialogLayer } from '../models/lifecycle.ts'
import { Store } from './store.ts'

export interface Picture {
  /** The board's uploads address (server/uploads.ts). */
  url: string
  name: string
  size?: number | undefined
}

export interface PictureState {
  picture: Picture
  /** The thumbnail it grows out of and folds back into. */
  from: Element | null
  /** It began folding away. */
  closing: boolean
}

export const pictureLook = new Store<PictureState | null>(null)

/** Open and not folding away. */
export const pictureOpen = (): boolean => {
  const s = pictureLook.get()
  return !!s && !s.closing
}

/** `picture`, grown out of `from`; one folding away turns around. */
export function showPicture(picture: Picture, from: Element | null = null): void {
  pictureLook.set({ picture, from, closing: false })
}

/** It folds back into where it came from. */
export function closePicture(): void {
  const s = pictureLook.get()
  if (s && !s.closing) pictureLook.set({ ...s, closing: true })
}

/** It has folded away. */
export function pictureGone(): void {
  if (pictureLook.get()?.closing) pictureLook.set(null)
}

/**
 * The page's "files" layer (models/lifecycle.ts PAGE_LAYERS): the quick look, or the picture over
 * it; the phone's Back closes the picture first, then the quick look a step at a time.
 */
export function filesLayer(quickLook: { open: boolean; back(): void }, picture: boolean): DialogLayer {
  return { open: quickLook.open || picture, close: () => (pictureOpen() ? closePicture() : quickLook.back()) }
}
