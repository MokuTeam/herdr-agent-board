// A picture from the clipboard on a phone (models/clipboard-image.ts): what the paste button makes
// of what the async Clipboard API gives, and of its refusals.
import { expect, test } from 'bun:test'
import {
  type ClipboardLike,
  canReadClipboard,
  clipboardName,
  readClipboardImages,
} from '../../web/src/models/clipboard-image.ts'

const item = (types: Record<string, string>) => ({
  types: Object.keys(types),
  getType: async (type: string) => new Blob([types[type] ?? ''], { type }),
})
const clipboard = (items: ReturnType<typeof item>[]): ClipboardLike => ({ read: async () => items })
const refusing = (name: string, message = 'no'): ClipboardLike => ({
  read: async () => {
    throw Object.assign(new Error(message), { name })
  },
})

test('the pictures on the clipboard become files named as a pasted screenshot is', async () => {
  const got = await readClipboardImages(
    clipboard([
      item({ 'text/plain': 'hi' }),
      item({ 'image/png': 'PNG', 'text/html': '<img>' }),
      item({ 'image/jpeg': 'JPG' }),
    ]),
  )
  if (!('files' in got)) throw new Error(JSON.stringify(got))
  expect(got.files.map(f => [f.name, f.type])).toEqual([
    ['image.png', 'image/png'],
    ['image.jpg', 'image/jpeg'],
  ])
  expect(await got.files[0]?.text()).toBe('PNG')
  expect(clipboardName('image/webp')).toBe('image.webp')
  expect(clipboardName('image/heic')).toBe('image.heic')
})

test('nothing to paste, not allowed, or another failure: each says which', async () => {
  expect(await readClipboardImages(clipboard([item({ 'text/plain': 'just text' })]))).toEqual({ error: 'empty' })
  expect(await readClipboardImages(clipboard([]))).toEqual({ error: 'empty' })
  // Chrome's permission refused, or Safari's Paste bubble dismissed.
  expect(await readClipboardImages(refusing('NotAllowedError'))).toEqual({ error: 'denied' })
  expect(await readClipboardImages(refusing('SecurityError'))).toEqual({ error: 'denied' })
  expect(await readClipboardImages(refusing('DataError', 'bad data'))).toEqual({ error: 'failed', why: 'bad data' })
})

test('the button shows only where the browser can read the clipboard', () => {
  expect(canReadClipboard({ read: async () => [] })).toBe(true)
  expect(canReadClipboard({ readText: async () => '' })).toBe(false)
  expect(canReadClipboard(undefined)).toBe(false)
})
