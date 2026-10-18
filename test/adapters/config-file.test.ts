import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCard, writeCard } from '../../src/adapters/cards.ts'
import { configFile, editCategories, editSettings, loadConfig } from '../../src/adapters/config-file.ts'
import { renameWithRetry, replaceFile } from '../../src/adapters/json-store.ts'
import { configDir } from '../../src/adapters/paths.ts'
import { isolatedHome } from '../support/env.ts'

const saved = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf8'))
const seed = (obj: unknown) => {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(obj))
}

test('renameWithRetry rides out a brief Windows file lock but not a real error', () => {
  const lock = (code: string) => Object.assign(new Error(code), { code })
  let calls = 0
  renameWithRetry('a', 'b', () => {
    if (++calls < 3) throw lock('EPERM')
  })
  assert.equal(calls, 3)
  assert.throws(
    () =>
      renameWithRetry('a', 'b', () => {
        throw lock('ENOENT')
      }),
    /ENOENT/,
  )
  calls = 0
  assert.throws(
    () =>
      renameWithRetry('a', 'b', () => {
        calls++
        throw lock('EBUSY')
      }),
    /EBUSY/,
  )
  assert.equal(calls, 10)
})

test('replaceFile puts the whole text in place, or leaves the file and no temp file behind', () => {
  const dir = isolatedHome()
  const file = join(dir, 'usage.json')
  replaceFile(file, '{"a":1}')
  assert.equal(readFileSync(file, 'utf8'), '{"a":1}')
  // A brief lock is ridden out; a lock that stays (or a real error) keeps the old file.
  const lock = Object.assign(new Error('EPERM'), { code: 'EPERM' })
  let calls = 0
  replaceFile(file, '{"a":2}', (from, to) => {
    if (++calls < 2) throw lock
    renameSync(from, to)
  })
  assert.equal(readFileSync(file, 'utf8'), '{"a":2}')
  assert.throws(
    () =>
      replaceFile(file, '{"a":3}', () => {
        throw lock
      }),
    /EPERM/,
  )
  assert.equal(readFileSync(file, 'utf8'), '{"a":2}')
  assert.deepEqual(readdirSync(dir).sort(), ['usage.json'])
})

test('loadConfig writes the defaults on first use', () => {
  isolatedHome()
  const cfg = loadConfig()
  assert.ok(cfg.categories.length > 0)
  assert.equal(saved().language, cfg.language)
})

test('editSettings keeps keys it does not know', () => {
  isolatedHome()
  seed({ language: 'en', futureKey: 1 })
  assert.deepEqual(editSettings({ language: 'ru' }), { ok: true })
  assert.equal(saved().futureKey, 1)
  assert.equal(saved().language, 'ru')
  assert.equal(loadConfig().language, 'ru')
})

test('editSettings refuses an unknown language', () => {
  isolatedHome()
  seed({ language: 'en' })
  assert.equal(editSettings({ language: 'xx' }).ok, false)
  assert.equal(saved().language, 'en')
})

test('editCategories creates, updates, orders and deletes; unknown fields survive', () => {
  isolatedHome()
  seed({
    language: 'en',
    futureKey: 1,
    categories: [
      { id: 'work', color: 'blue', paths: [], extra: 'x' },
      { id: 'other', color: 'gray', paths: [] },
    ],
  })
  assert.deepEqual(editCategories({ op: 'create', id: 'home', title: 'Home' }), { ok: true })
  assert.deepEqual(editCategories({ op: 'update', id: 'work', title: 'Job' }), { ok: true })
  type Cat = { id: string; extra?: string; title?: string }
  assert.deepEqual(
    (saved().categories as Cat[]).map(c => c.id),
    ['work', 'home', 'other'],
  )
  assert.deepEqual(editCategories({ op: 'order', ids: ['other', 'home', 'work'] }), { ok: true })
  const cats = saved().categories as Cat[]
  assert.deepEqual(
    cats.map(c => c.id),
    ['other', 'home', 'work'],
  )
  assert.equal(cats.find(c => c.id === 'work')?.extra, 'x')
  assert.equal(cats.find(c => c.id === 'work')?.title, 'Job')
  assert.equal(saved().futureKey, 1)
  assert.equal(editCategories({ op: 'create', id: 'home' }).ok, false)
  assert.equal(editCategories({ op: 'delete', id: 'other' }).ok, false)
  assert.equal(editCategories({ op: 'nope' }).ok, false)
})

test('editCategories keeps hand-edited entries it cannot read in their place, and adds no fields to the others', () => {
  isolatedHome()
  seed({
    language: 'en',
    categories: [{ id: 'work' }, null, { id: 'home', title: 'Home' }, 'lane', { title: 'No id' }, { id: 'other' }],
  })
  assert.deepEqual(editCategories({ op: 'update', id: 'home', color: 'red' }), { ok: true })
  assert.deepEqual(saved().categories, [
    { id: 'work' },
    null,
    { id: 'home', title: 'Home', color: 'red' },
    'lane',
    { title: 'No id' },
    { id: 'other' },
  ])
  assert.deepEqual(editCategories({ op: 'order', ids: ['other', 'home'] }), { ok: true })
  assert.deepEqual(saved().categories, [
    { id: 'other' },
    null,
    { id: 'home', title: 'Home', color: 'red' },
    'lane',
    { title: 'No id' },
    { id: 'work' },
  ])
  assert.deepEqual(editCategories({ op: 'create', id: 'acme', title: 'Acme' }), { ok: true })
  assert.deepEqual(editCategories({ op: 'delete', id: 'work' }), { ok: true })
  assert.deepEqual(saved().categories, [
    { id: 'acme', title: 'Acme', color: 'blue', paths: [] },
    { id: 'other' },
    null,
    { id: 'home', title: 'Home', color: 'red' },
    'lane',
    { title: 'No id' },
  ])
  // The board reads only the lanes among them.
  assert.deepEqual(
    loadConfig().categories.map(c => c.id),
    ['acme', 'other', 'home'],
  )
})

test('category folders lose trailing slashes and backslashes and are de-duplicated', () => {
  isolatedHome()
  seed({ language: 'en', categories: [{ id: 'other', color: 'gray', paths: [] }] })
  assert.deepEqual(editCategories({ op: 'create', id: 'work', paths: ['C:\\work\\', 'C:\\work', '/home/x/'] }), {
    ok: true,
  })
  const cats = saved().categories as { id: string; paths: string[] }[]
  assert.deepEqual(cats.find(c => c.id === 'work')?.paths, ['C:\\work', '/home/x'])
})

test('deleting a category clears it from the cards that named it', () => {
  isolatedHome()
  seed({
    language: 'en',
    categories: [
      { id: 'work', color: 'blue', paths: [] },
      { id: 'other', color: 'gray', paths: [] },
    ],
  })
  writeCard('c1', { category: 'work', doing: 'x' })
  assert.deepEqual(editCategories({ op: 'delete', id: 'work' }), { ok: true })
  assert.equal(readCard('c1')?.category, undefined)
  assert.equal(readCard('c1')?.doing, 'x')
})
