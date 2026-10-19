import { afterEach, beforeEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { attentionOf, COLUMNS, columnOf, noteOf } from '../../src/core/board.ts'
import { t, useLanguage } from '../../src/core/lang.ts'
import type { Item } from '../../src/core/types.ts'

beforeEach(() => {
  useLanguage('en')
})
afterEach(() => {
  useLanguage('en')
})

const item = (over: Partial<Item>): Item => ({
  key: 'k',
  session: null,
  pane: null,
  workspace: null,
  cwd: '',
  status: 'idle',
  name: 'A',
  autoName: 'A',
  category: 'other',
  categorySet: false,
  column: 'idle',
  attention: '',
  ...over,
})

test('columns: herdr state first, then the wait note', () => {
  assert.equal(columnOf('working', { wait: 'x' }), 'work')
  assert.equal(columnOf('blocked', { wait: 'x' }), 'me')
  assert.equal(columnOf('done', { wait: 'x' }), 'ext')
  assert.equal(columnOf('sleeping', { wait: 'x' }), 'ext')
  assert.equal(columnOf('done', {}), 'done')
  assert.equal(columnOf('idle', null), 'idle')
  assert.equal(columnOf('sleeping', {}), 'idle')
})

test('a column the user dragged the card to wins, except while a turn is on', () => {
  const asked = { question: 'Send it?', replied: false }
  assert.equal(columnOf('done', { pin: 'me' }), 'me')
  assert.equal(attentionOf('done', { pin: 'me' }), 'later')
  assert.equal(attentionOf('done', { pin: 'me' }, asked), 'question') // its own question says more
  assert.equal(columnOf('idle', { pin: 'done' }, asked), 'done')
  assert.equal(attentionOf('idle', { pin: 'done' }, asked), '')
  assert.equal(columnOf('done', { pin: 'idle', wait: 'x' }), 'idle')
  assert.equal(columnOf('sleeping', { pin: 'ext' }), 'ext')
  assert.equal(columnOf('working', { pin: 'me' }), 'work')
  assert.equal(columnOf('blocked', { pin: 'done' }), 'me')
  assert.equal(columnOf('done', { pin: 'work' as never }), 'done') // not a column the user can pin
  assert.equal(noteOf(item({ column: 'me', attention: 'later', title: 'Import' })), 'parked by you · Import')
  assert.equal(noteOf(item({ column: 'ext', wait: '' })), 'parked by you')
})

test('card note: wait text, then what the agent said, then the ai title, then the last prompt', () => {
  const base = { name: 'Acme-Billing', title: 'Receipt import', prompt: 'go on' }
  assert.equal(noteOf(item({ ...base, column: 'ext', wait: 'client reply' })), 'client reply')
  assert.equal(noteOf(item({ ...base, column: 'work', doing: 'fixing the import' })), 'fixing the import')
  assert.equal(noteOf(item({ ...base, column: 'work' })), 'Receipt import')
  assert.equal(noteOf(item({ ...base, title: 'Acme-Billing', column: 'work' })), 'go on')
  assert.equal(noteOf(item({ ...base, column: 'done', result: 'uploaded' })), 'uploaded')
})

test('"needs me": dialogs, the agent\'s ask, then an unanswered last question', () => {
  const q = { question: 'Send it?', replied: false }
  assert.equal(attentionOf('working', { ask: 'x' }, q), '')
  assert.equal(attentionOf('blocked', {}, {}), 'decision')
  assert.equal(attentionOf('done', { ask: 'OK?' }, {}), 'ask')
  assert.equal(attentionOf('idle', {}, q), 'question')
  assert.equal(attentionOf('sleeping', {}, q), 'question')
  assert.equal(attentionOf('idle', {}, { ...q, replied: true }), '')
  assert.equal(attentionOf('idle', { wait: 'client' }, q), '')
  assert.equal(attentionOf('idle', { dismissed: 'Send it?' }, q), '')
  assert.equal(attentionOf('idle', { dismissed: 'another' }, q), 'question')
  assert.equal(columnOf('done', { ask: 'OK?' }, {}), 'me')
  assert.equal(columnOf('done', { ask: 'OK?', wait: 'x' }, {}), 'me')
  assert.equal(columnOf('idle', {}, q), 'me')
})

test('the board switches language in place: columns and notes follow', () => {
  useLanguage('ru')
  assert.equal(COLUMNS.find(c => c.id === 'me')?.title, 'Ждёт меня')
  assert.equal(noteOf(item({ column: 'ext', wait: '' })), 'отложено тобой')
  assert.equal(t('lane.other'), 'Прочее')
  useLanguage('en')
  assert.equal(COLUMNS.find(c => c.id === 'me')?.title, 'Needs me')
})
