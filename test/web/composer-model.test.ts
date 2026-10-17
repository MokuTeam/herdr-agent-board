// The composer's rules (web/app.js syncComposer, the submit guard, the toast, sizes, pasted names).
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import {
  type Attachment,
  canSubmit,
  composerView,
  type DragStep,
  isUploading,
  nextDropDepth,
  previewsAsImage,
  screenshotName,
  sendsOnKey,
  sentText,
  sizeText,
  uploadedPaths,
} from '../../web/src/models/composer.ts'

const t = translator('en')
const file = (id: number, status: Attachment['status'], path = ''): Attachment => ({
  id,
  name: `f${id}`,
  size: 10,
  image: false,
  url: '',
  status,
  path,
})

test('Enter sends; Shift+Enter and a word being composed do not', () => {
  expect(sendsOnKey({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true)
  expect(sendsOnKey({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false)
  expect(sendsOnKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false)
  expect(sendsOnKey({ key: 'a', shiftKey: false, isComposing: false })).toBe(false)
})

test('send needs the session, fresh data, nothing on its way, no upload going, and text or a file', () => {
  const scene = { present: true, sending: false, canMutate: true, text: 'hi', attachments: [] }
  expect(composerView(scene, t)).toEqual({
    sendDisabled: false,
    sendTitle: 'Send (Enter)',
    discardHidden: false,
    discardDisabled: false,
  })
  expect(composerView({ ...scene, present: false }, t).sendDisabled).toBe(true)
  expect(composerView({ ...scene, sending: true }, t)).toMatchObject({ sendDisabled: true, discardDisabled: true })
  expect(composerView({ ...scene, canMutate: false }, t).sendDisabled).toBe(true)
  expect(composerView({ ...scene, text: '  \n' }, t)).toMatchObject({ sendDisabled: true, discardHidden: false })
  expect(composerView({ ...scene, text: '' }, t)).toMatchObject({ sendDisabled: true, discardHidden: true })
  const uploading = composerView({ ...scene, attachments: [file(1, 'done', 'p'), file(2, 'uploading')] }, t)
  expect(uploading).toMatchObject({ sendDisabled: true, sendTitle: 'Files are still uploading' })
  expect(composerView({ ...scene, text: '', attachments: [file(1, 'done', 'p')] }, t)).toMatchObject({
    sendDisabled: false,
    discardHidden: false,
  })
  expect(composerView({ ...scene, text: '', attachments: [file(1, 'error')] }, t)).toMatchObject({
    sendDisabled: true,
    discardHidden: false,
  })
})

test('a submit goes out on the same rules; the message carries the uploaded paths only', () => {
  const list = [file(1, 'done', 'C:\\u\\a.png'), file(2, 'error'), file(3, 'done', '/u/b.txt')]
  expect(uploadedPaths(list)).toEqual(['C:\\u\\a.png', '/u/b.txt'])
  expect(isUploading(list)).toBe(false)
  expect(isUploading([...list, file(4, 'uploading')])).toBe(true)
  const scene = { canMutate: true, key: 'a', sending: false, text: 'hi', files: [], uploading: false }
  expect(canSubmit(scene)).toBe(true)
  expect(canSubmit({ ...scene, text: '', files: ['/u/b.txt'] })).toBe(true)
  expect(canSubmit({ ...scene, text: '' })).toBe(false)
  expect(canSubmit({ ...scene, key: null })).toBe(false)
  expect(canSubmit({ ...scene, canMutate: false })).toBe(false)
  expect(canSubmit({ ...scene, sending: true })).toBe(false)
  expect(canSubmit({ ...scene, uploading: true })).toBe(false)
})

test('the toast once it went, in both languages', () => {
  expect(sentText('Alpha', 0, t)).toBe('Sent to Alpha')
  expect(sentText('Alpha', 2, t)).toBe('Sent to Alpha · 2 files')
  expect(sentText(undefined, 1, t)).toBe('Sent to the session · 1 file')
  const ru = translator('ru')
  expect(sentText('Альфа', 5, ru)).toBe(`${ru('sent.to', { name: 'Альфа' })} · ${ru('sent.files', { n: 5 })}`)
})

test('sizes, pasted screenshots and the pictures the box previews', () => {
  expect([sizeText(1023, t), sizeText(1536, t), sizeText(3 * (1 << 20) + 1, t)]).toEqual(['1023 B', '2 KB', '3.0 MB'])
  const at = new Date(2026, 9, 17, 9, 5, 7)
  expect(screenshotName('image.png', at)).toBe('screenshot-090507.png')
  expect(screenshotName('IMAGE.JPEG', at)).toBe('screenshot-090507.JPEG')
  expect(screenshotName('image.gif', at)).toBe(null)
  expect(screenshotName('photo.png', at)).toBe(null)
  expect(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', ''].map(previewsAsImage)).toEqual([
    true,
    true,
    true,
    true,
    false,
    false,
  ])
})

test('files dragged over the panel light it from the first enter to the last leave, or the drop', () => {
  let depth = 0
  const steps: [DragStep, boolean][] = [
    ['enter', true], // the panel
    ['enter', true], // a child in it
    ['leave', true],
    ['enter', false], // text dragged: not counted
  ]
  const lit = steps.map(([step, files]) => {
    depth = nextDropDepth(depth, step, files)
    return depth > 0
  })
  expect(lit).toEqual([true, true, true, true])
  expect(nextDropDepth(1, 'leave', true)).toBe(0)
  expect(nextDropDepth(0, 'leave', false)).toBe(0)
  expect(nextDropDepth(3, 'drop', true)).toBe(0)
  expect(nextDropDepth(3, 'drop', false)).toBe(3)
})
