import { beforeEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { categoryFor, categoryInfo, DEFAULT_CONFIG, laneRank, normalizeConfig } from '../../src/core/categories.ts'
import { useLanguage } from '../../src/core/lang.ts'
import type { Config } from '../../src/core/types.ts'

beforeEach(() => {
  useLanguage('en')
})

const cfg: Config = {
  ...DEFAULT_CONFIG,
  categories: [
    { id: 'acme', title: 'Acme', color: 'blue', paths: ['C:\\Clients'] },
    { id: 'beta', title: 'Beta', color: 'blue', paths: ['C:\\Beta'] },
    { id: 'globex', title: 'Globex', color: 'blue', paths: ['C:\\Clients\\Globex'] },
    { id: 'personal', title: 'Personal', color: 'blue', paths: ['C:\\Home'] },
    { id: 'other', title: 'Other', color: 'gray', paths: [] },
  ],
}

test('category from the folder: longest match wins, case and slashes do not matter', () => {
  assert.equal(categoryFor(cfg, 'C:\\Clients\\Globex'), 'globex')
  assert.equal(categoryFor(cfg, 'c:/clients/globex/sub'), 'globex')
  assert.equal(categoryFor(cfg, 'C:\\Clients\\Initech'), 'acme')
  assert.equal(categoryFor(cfg, 'C:\\ClientsX'), null)
  assert.equal(categoryFor(cfg, 'C:\\'), null)
})

test('lanes agents made up sort before "other" and get their id as title', () => {
  assert.ok(laneRank(cfg, 'newclient') > laneRank(cfg, 'personal'))
  assert.ok(laneRank(cfg, 'newclient') < laneRank(cfg, 'other'))
  assert.equal(categoryInfo(cfg, 'newclient').title, 'newclient')
})

test('normalizeConfig fills defaults, titles built-in lanes, keeps unknown fields', () => {
  const c = normalizeConfig({ language: 'ru', futureKey: 1 })
  assert.equal(c.futureKey, 1)
  assert.equal(c.language, 'ru')
  assert.equal(c.refreshSec, 2)
  assert.deepEqual(
    c.categories.map(x => x.id),
    ['work', 'personal', 'other'],
  )
  assert.ok(c.categories.every(x => x.title))
  assert.equal(normalizeConfig(null).language, 'auto')
  assert.equal(
    normalizeConfig({ categories: [{ id: 'x', title: 'X', color: 'red', paths: [] }] }).categories[0]?.title,
    'X',
  )
})

test('normalizeConfig takes only the lanes of a hand-edited list, the defaults when none is left', () => {
  const c = normalizeConfig({ categories: [null, 'x', 7, ['y'], { title: 'No id' }, { id: 'acme', title: 'Acme' }] })
  assert.deepEqual(
    c.categories.map(x => x.id),
    ['acme'],
  )
  assert.deepEqual(
    normalizeConfig({ categories: [null, { id: 3 }] }).categories.map(x => x.id),
    ['work', 'personal', 'other'],
  )
})
