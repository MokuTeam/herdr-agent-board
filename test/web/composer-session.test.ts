// The message box across sessions (web/app.js openSheet, saveDraft, the composer's submit, the
// discard button): drafts per session under board.draft.<session>, files per session, one send at
// a time, and what a finished send may clear.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
import type { Attachment } from '../../web/src/models/composer.ts'
import {
  COMPOSE_FOCUS_MS,
  type ComposerPage,
  composerSession,
  RELOAD_AFTER_SEND_MS,
  type SendResult,
} from '../../web/src/models/composer-session.ts'
import { draftBook } from '../../web/src/models/drafts.ts'
import { item } from './support/board.tsx'

const t = translator('en')
const done = (id: number, path: string): Attachment => ({
  id,
  name: `f${id}`,
  size: 1,
  image: false,
  url: '',
  status: 'done',
  path,
})

/** A page around one composer: what it shows, what it stored, what it said and did. */
function page(items: Item[]) {
  const storage = new Map<string, string>()
  const state: Omit<ComposerPage, 'item' | 't'> = { open: null, text: '', files: [], canMutate: true }
  const log: string[] = []
  const timers: { run: () => void; ms: number }[] = []
  const posts: { key: string; body: Record<string, unknown> }[] = []
  let answer: (r: SendResult) => void = () => {}
  const box = composerSession({
    drafts: draftBook({
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => void storage.set(k, v),
      removeItem: k => void storage.delete(k),
    }),
    page: () => ({ ...state, item: key => items.find(i => i.key === key), t }),
    setText: text => {
      state.text = text
    },
    clearFiles: () => {
      state.files = []
      log.push('files cleared')
    },
    sending: keys => log.push(`sending ${[...keys].join(',')}`),
    toast: (text, error) => log.push(`${error ? 'error' : 'toast'}: ${text}`),
    busy: (key, label) => log.push(`busy ${key}: ${label}`),
    post: (key, body) => {
      posts.push({ key, body })
      return new Promise(resolve => {
        answer = resolve
      })
    },
    reload: key => log.push(`reload ${key}`),
    focus: () => log.push('focus'),
    later: (run, ms) => void timers.push({ run, ms }),
  })
  const open = (key: string | null, compose = false) => {
    state.open = key
    box.opened(key, compose)
  }
  const draft = (session: string) => JSON.parse(storage.get(`board.draft.${session}`) ?? 'null')
  return { box, state, storage, log, timers, posts, open, draft, answer: (r: SendResult) => answer(r) }
}

const a = item({ key: 'a', session: 'sa', name: 'Alpha' })
const b = item({ key: 'b', session: null, name: 'Beta', sleeping: true })

test('a draft stays with its session through a switch, a close and opening it again', () => {
  const p = page([a, b])
  p.open('a')
  p.box.input('for alpha')
  expect(p.draft('sa')).toMatchObject({ text: 'for alpha' })
  p.open('b')
  expect(p.state.text).toBe('')
  p.box.input('for beta') // no Claude session: it goes by the card
  expect(p.draft('b')).toMatchObject({ text: 'for beta' })
  p.open(null)
  p.open('a')
  expect(p.state.text).toBe('for alpha')
  // The stored format: { text, id }.
  expect(Object.keys(p.draft('sa'))).toEqual(['text', 'id'])
})

test('the text a page had but did not save yet is saved on a switch and on a close', () => {
  const p = page([a, b])
  p.open('a')
  p.state.text = 'typed, not saved'
  p.open('b')
  expect(p.draft('sa')?.text).toBe('typed, not saved')
  p.state.text = 'beta too'
  p.open(null)
  expect(p.draft('b')?.text).toBe('beta too')
})

test('files belong to the session they were added for: another one drops them with a toast, the same one keeps them', () => {
  const p = page([a, b])
  p.open('a')
  p.state.files = [done(1, '/u/1')]
  p.open(null)
  p.open('a')
  expect(p.state.files.length).toBe(1)
  p.open('b')
  expect(p.state.files).toEqual([])
  expect(p.log).toEqual(['files cleared', `toast: ${t('toast.attachDropped')}`])
})

test('"Write" puts the focus in the box once the sheet is in', () => {
  const p = page([a])
  p.open('a', true)
  expect(p.timers.map(x => x.ms)).toEqual([COMPOSE_FOCUS_MS])
  p.timers[0]?.run()
  expect(p.log).toEqual(['focus'])
})

test('a send posts the text, the uploaded files, the session and the draft id; it clears what it sent', async () => {
  const p = page([a])
  p.open('a')
  p.box.input('  hello  ')
  p.state.files = [done(1, 'C:\\u\\1.png'), { ...done(2, ''), status: 'error' }]
  const id = p.draft('sa').id
  const sent = p.box.send()
  expect(p.posts).toEqual([
    { key: 'a', body: { text: 'hello', files: ['C:\\u\\1.png'], session: 'sa', requestId: id } },
  ])
  // One at a time.
  void p.box.send()
  expect(p.posts.length).toBe(1)
  p.answer({ ok: true })
  await sent
  expect(p.state.text).toBe('')
  expect(p.state.files).toEqual([])
  expect(p.storage.has('board.draft.sa')).toBe(false)
  expect(p.log).toEqual(['sending a', 'sending ', 'busy a: null', 'files cleared', 'toast: Sent to Alpha · 1 file'])
  expect(p.timers.map(x => x.ms)).toEqual([RELOAD_AFTER_SEND_MS])
  p.timers[0]?.run()
  expect(p.log.at(-1)).toBe('reload a')
})

test('typed again while it went: the new text stays, in the box and as the draft', async () => {
  const p = page([a])
  p.open('a')
  p.box.input('first')
  const sent = p.box.send()
  p.box.input('first, and more')
  p.answer({ ok: true })
  await sent
  expect(p.state.text).toBe('first, and more')
  expect(p.draft('sa')?.text).toBe('first, and more')
})

test('a sleeping session wakes for it; a refusal says why and keeps everything', async () => {
  const p = page([b])
  p.open('b')
  p.box.input('wake up')
  const sent = p.box.send()
  p.answer({ ok: false, error: 'herdr is out of date' })
  await sent
  expect(p.log).toEqual([
    'sending b',
    `busy b: ${t('busy.waking')}`,
    'sending ',
    'busy b: null',
    'error: herdr is out of date',
  ])
  expect(p.state.text).toBe('wake up')
  expect(p.draft('b')?.text).toBe('wake up')
})

test('nothing goes without fresh data, without a session on the board, with nothing to send or while files upload', async () => {
  const p = page([a])
  p.open('a')
  await p.box.send()
  p.box.input('hi')
  p.state.canMutate = false
  await p.box.send()
  p.state.canMutate = true
  p.state.files = [{ ...done(1, ''), status: 'uploading' }]
  await p.box.send()
  p.state.files = []
  p.open('gone')
  p.box.input('to nobody')
  await p.box.send()
  expect(p.posts).toEqual([])
  // Files alone are enough.
  p.open('a')
  p.box.input('')
  p.state.files = [done(1, '/u/1')]
  void p.box.send()
  expect(p.posts.map(x => x.body.text)).toEqual([''])
})

test('discarding clears the box, the files and the stored draft — not while the message goes', async () => {
  const p = page([a])
  p.open('a')
  p.box.input('draft')
  const sent = p.box.send()
  p.box.discard()
  expect(p.state.text).toBe('draft')
  p.answer({ ok: false, error: 'no' })
  await sent
  p.state.files = [done(1, '/u/1')]
  p.box.discard()
  expect([p.state.text, p.state.files.length, p.storage.has('board.draft.sa')]).toEqual(['', 0, false])
  expect(p.log.at(-1)).toBe('focus')
})
