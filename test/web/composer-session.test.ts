// The message box across sessions (web/app.js openSheet, saveDraft, the composer's submit and
// deliver, the discard button, the thread's Retry and Edit): drafts per session under
// board.draft.<session>, files per session, one send at a time; a send leaves the box at once for
// the foot of the thread (the outbox, upstream #53) and its draft stays stored until the session
// has it.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
import type { Attachment } from '../../web/src/models/composer.ts'
import {
  COMPOSE_FOCUS_MS,
  type ComposerPage,
  composerSession,
  REDRAW_AFTER_SEND_MS,
  RELOAD_AFTER_SEND_MS,
  type SendResult,
} from '../../web/src/models/composer-session.ts'
import { draftBook } from '../../web/src/models/drafts.ts'
import { item } from './support/board.tsx'

const t = translator('en')
const done = (id: number, path: string, url = ''): Attachment => ({
  id,
  name: `f${id}`,
  size: 1,
  image: !!url,
  url,
  status: 'done',
  path,
})

/** A page around one composer: what it shows, what it stored, what it said and did. */
function page(items: Item[], storage = new Map<string, string>()) {
  const state: Omit<ComposerPage, 'item' | 't'> = { open: null, text: '', files: [], canMutate: true, detail: null }
  const log: string[] = []
  const timers: { run: () => void; ms: number }[] = []
  const posts: { key: string; body: Record<string, unknown> }[] = []
  const clock = { now: 1_000_000 }
  const counts = { changed: 0 }
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
    releaseFiles: () => {
      state.files = []
      log.push('files released')
    },
    restoreFiles: files => {
      state.files = [...state.files, ...files.filter(a => !state.files.some(f => f.id === a.id))]
      log.push('files restored')
    },
    revoke: url => log.push(`revoke ${url}`),
    sending: keys => log.push(`sending ${[...keys].join(',')}`),
    changed: () => {
      counts.changed++
    },
    foot: () => log.push('foot'),
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
    now: () => clock.now,
  })
  const open = (key: string | null, compose = false) => {
    state.open = key
    box.opened(key, compose)
  }
  const draft = (session: string) => JSON.parse(storage.get(`board.draft.${session}`) ?? 'null')
  /** The foot of the open session's thread, as the sheet draws it now. */
  const waiting = (key: string) => box.waiting(key, state.open, state.detail)
  return {
    box,
    state,
    storage,
    log,
    timers,
    posts,
    clock,
    counts,
    open,
    draft,
    waiting,
    answer: (r: SendResult) => answer(r),
  }
}

const a = item({ key: 'a', session: 'sa', name: 'Alpha' })
const b = item({ key: 'b', session: null, name: 'Beta', sleeping: true })
const c = item({ key: 'c', session: null, name: 'Gamma' })

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

test('a send posts the text, the uploaded files, the session and the draft id; the message leaves the box at once for the foot of the thread', async () => {
  const p = page([a])
  p.open('a')
  p.state.detail = { conversation: [{ role: 'assistant', text: 'ready', at: 5000 }] }
  p.box.input('  hello  ')
  const shot = done(1, 'C:\\u\\1.png', 'blob:1')
  p.state.files = [shot, { ...done(2, ''), status: 'error' }]
  const id = p.draft('sa').id
  const sent = p.box.send()
  expect(p.posts).toEqual([
    { key: 'a', body: { text: 'hello', files: ['C:\\u\\1.png'], session: 'sa', requestId: id } },
  ])
  // Out of the box, files and all, into a bubble of its own, written as the server types it.
  expect([p.state.text, p.state.files]).toEqual(['', []])
  expect(p.waiting('a')).toEqual([
    {
      id,
      text: 'hello',
      files: ['C:\\u\\1.png'],
      attached: [shot],
      full: 'hello\n\nFile:\nC:\\u\\1.png',
      key: 'hello',
      after: 5000,
      state: 'sending',
      error: '',
      sentAt: 0,
    },
  ])
  // The draft stays stored until the session has it: a reload before that keeps it.
  expect(p.draft('sa')).toEqual({ text: '  hello  ', id })
  p.answer({ ok: true })
  await sent
  expect(p.storage.has('board.draft.sa')).toBe(false)
  expect(p.waiting('a').map(e => [e.state, e.sentAt])).toEqual([['sent', p.clock.now]])
  // The thread is on show: its bubble says it, no toast.
  expect(p.log).toEqual(['files released', 'sending a', 'foot', 'sending ', 'busy a: null'])
  expect(p.timers.map(x => x.ms)).toEqual([RELOAD_AFTER_SEND_MS, REDRAW_AFTER_SEND_MS])
  p.timers[0]?.run()
  expect(p.log.at(-1)).toBe('reload a')
  const before = p.counts.changed
  p.timers[1]?.run()
  expect(p.counts.changed).toBe(before + 1)
})

test('one at a time; typed again while it went: the new text stays, in the box and as the draft', async () => {
  const p = page([a])
  p.open('a')
  p.box.input('first')
  const sent = p.box.send()
  p.box.input('and more')
  void p.box.send()
  expect(p.posts.length).toBe(1)
  p.answer({ ok: true })
  await sent
  expect(p.state.text).toBe('and more')
  expect(p.draft('sa')?.text).toBe('and more')
})

test('with the thread not on show a toast says it went; a pane with no Claude session has no thread to show it in', async () => {
  const p = page([a, c])
  p.open('a')
  p.box.input('later')
  const one = p.box.send()
  p.open(null)
  p.answer({ ok: true })
  await one
  expect(p.log.at(-1)).toBe('toast: Sent to Alpha')
  p.open('c')
  p.box.input('to the pane')
  const two = p.box.send()
  expect(p.waiting('c').length).toBe(1)
  p.answer({ ok: true })
  await two
  expect(p.log.at(-1)).toBe('toast: Sent to Gamma')
  expect(p.waiting('c')).toEqual([])
})

test('a sleeping session wakes for it; a refusal stays at the foot with why, its draft too, and Retry sends it again', async () => {
  const p = page([b])
  p.open('b')
  p.box.input('wake up')
  const sent = p.box.send()
  p.answer({ ok: false, error: 'herdr is out of date' })
  await sent
  expect(p.log).toEqual([
    'files released',
    'sending b',
    'foot',
    `busy b: ${t('busy.waking')}`,
    'sending ',
    'busy b: null',
  ])
  const [entry] = p.waiting('b')
  expect(entry).toMatchObject({ text: 'wake up', state: 'failed', error: 'herdr is out of date' })
  expect(p.state.text).toBe('')
  expect(p.draft('b')).toEqual({ text: 'wake up', id: entry?.id })
  // Retry: the same request again; without fresh data, nothing.
  p.state.canMutate = false
  await p.box.retry(entry?.id ?? '')
  expect(p.posts.length).toBe(1)
  p.state.canMutate = true
  const again = p.box.retry(entry?.id ?? '')
  expect(p.waiting('b').map(e => e.state)).toEqual(['sending'])
  expect(p.posts.at(-1)?.body).toEqual(p.posts[0]?.body)
  p.answer({ ok: true })
  await again
  expect(p.storage.has('board.draft.b')).toBe(false)
  expect(p.log.at(-1)).toBe('toast: Sent to Beta') // no Claude session: no transcript, a toast
})

test('not on show, a refusal says why in a toast', async () => {
  const p = page([a])
  p.open('a')
  p.box.input('hi')
  const sent = p.box.send()
  p.open(null)
  p.answer({ ok: false, error: 'no herdr' })
  await sent
  expect(p.log.at(-1)).toBe('error: no herdr')
})

test('Edit puts a message not sent back into the box, before what was typed since, files and all', async () => {
  const p = page([a])
  p.open('a')
  p.box.input('fix it')
  const file = done(1, '/u/1.png', 'blob:1')
  p.state.files = [file]
  const sent = p.box.send()
  p.answer({ ok: false, error: 'nope' })
  await sent
  p.box.input('also this')
  const id = p.waiting('a')[0]?.id ?? ''
  p.box.edit(id)
  expect(p.state.text).toBe('fix it\nalso this')
  expect(p.state.files).toEqual([file])
  expect(p.waiting('a')).toEqual([])
  expect(p.draft('sa')?.text).toBe('fix it\nalso this')
  expect(p.log.slice(-2)).toEqual(['files restored', 'focus'])
})

test('opened again, a message on its way or not sent is in the thread, not in the box; a reload brings its draft back', async () => {
  const storage = new Map<string, string>()
  const p = page([a, b], storage)
  p.open('a')
  p.box.input('hold on')
  const sent = p.box.send()
  // An empty box after the send keeps the message's own draft: a switch saves nothing over it.
  p.open('b')
  p.open('a')
  expect(p.state.text).toBe('')
  p.answer({ ok: false, error: 'no' })
  await sent
  p.open('b')
  p.open('a')
  expect(p.state.text).toBe('')
  // The page again: its outbox is gone, the draft comes back to the box.
  const again = page([a], storage)
  again.open('a')
  expect(again.state.text).toBe('hold on')
})

test('the thread settles: what its transcript or its queue shows after the send goes for good, previews too; a message never seen goes after a while', async () => {
  const p = page([a])
  p.open('a')
  p.state.detail = { conversation: [{ role: 'user', text: 'check the logs', at: 1000 }] }
  p.box.input('check the logs')
  p.state.files = [done(1, 'C:\\u\\1.png', 'blob:1')]
  const one = p.box.send()
  p.answer({ ok: true })
  await one
  // An older message with the same words is not this one.
  p.box.settle()
  expect(p.waiting('a').length).toBe(1)
  // In the transcript now, as the server typed it.
  p.state.detail = {
    conversation: [
      { role: 'user', text: 'check the logs', at: 1000 },
      { role: 'user', text: 'check the logs\n\nFile:\nC:\\u\\1.png', at: 2000 },
    ],
  }
  expect(p.waiting('a')).toEqual([])
  const before = p.counts.changed
  p.box.settle()
  expect(p.log.at(-1)).toBe('revoke blob:1')
  expect(p.counts.changed).toBe(before + 1)
  // In the queue: the same.
  p.box.input('then the tests')
  const two = p.box.send()
  p.state.detail = { ...p.state.detail, queued: [{ text: 'then the tests', at: 3000 }] }
  expect(p.waiting('a')).toEqual([])
  p.answer({ ok: true })
  await two
  // Sent, never seen: it goes after a while; while the sheet shows another session it stays.
  p.state.detail = null
  p.box.input('third')
  const three = p.box.send()
  p.answer({ ok: true })
  await three
  p.clock.now += 31_000
  expect(p.box.waiting('a', 'b', null).map(e => e.text)).toEqual(['then the tests', 'third'])
  expect(p.waiting('a')).toEqual([])
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
  // Files alone are enough: the line that names them is what the thread finds it by.
  p.open('a')
  p.box.input('')
  p.state.files = [done(1, '/u/1')]
  void p.box.send()
  expect(p.posts.map(x => x.body.text)).toEqual([''])
  expect(p.waiting('a').map(e => [e.full, e.key])).toEqual([['File:\n/u/1', 'File:']])
})

test('discarding clears the box, the files and the stored draft — not while the message goes', async () => {
  const p = page([a])
  p.open('a')
  p.box.input('draft')
  const sent = p.box.send()
  p.box.input('next')
  p.box.discard()
  expect(p.state.text).toBe('next')
  p.answer({ ok: false, error: 'no' })
  await sent
  p.state.files = [done(1, '/u/1')]
  p.box.discard()
  expect([p.state.text, p.state.files.length, p.storage.has('board.draft.sa')]).toEqual(['', 0, false])
  expect(p.log.at(-1)).toBe('focus')
})
