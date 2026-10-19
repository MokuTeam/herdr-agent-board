import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { descendantTargets, testFiles } from '../scripts/run-tests.mjs'

test('portable discovery includes nested test modules, excludes fixtures and helper scripts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'board-discovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'nested'))
  await mkdir(join(root, 'fixtures'))
  for (const name of ['a.test.mjs', 'helper.mjs', 'nested/b.test.mjs', 'fixtures/not-real.test.mjs']) await writeFile(join(root, name), '')
  assert.deepEqual(await testFiles(root), [join(root, 'a.test.mjs'), join(root, 'nested/b.test.mjs')])
})

test('cancellation targets detached descendant groups without touching unrelated groups', () => {
  const rows = [[1, 0, 1], [10, 1, 10], [11, 10, 10], [20, 11, 20], [21, 20, 20], [30, 1, 30], [40, 11, 30]]
  assert.deepEqual(descendantTargets(10, rows), [-10, -20, 40])
})
