import { afterEach, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { listDirs, roots } from '../../src/adapters/folders.ts'

const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-folders-'))
  cleanups.push(dir)
  return dir
}

test('the folder picker lists folders only, and the drives to start from', async () => {
  const dir = temp()
  for (const d of ['b-dir', 'A-dir', '.hidden']) mkdirSync(join(dir, 'pick', d), { recursive: true })
  writeFileSync(join(dir, 'pick', 'file.txt'), 'x')
  const r = await listDirs(join(dir, 'pick'))
  assert.deepEqual(r.entries, ['.hidden', 'A-dir', 'b-dir'])
  assert.equal(r.dir, true)
  assert.equal(r.sep, sep)
  assert.equal(r.parent, dir)
  assert.equal((await listDirs(join(dir, 'pick', 'file.txt'))).dir, false)
  assert.equal((await listDirs(join(dir, 'nope'))).exists, false)
  const start = await listDirs('')
  assert.ok((start.roots?.length ?? 0) >= 2)
})

test('roots: home first, then the drives (Windows) or the file-system root', async () => {
  const list = await roots()
  expect(list[0]?.name).toBe('~')
  if (process.platform === 'win32')
    expect(list.slice(1).every(r => /^[A-Z]:$/.test(r.name) && r.path === `${r.name}\\`)).toBe(true)
  else expect(list[1]).toEqual({ name: '/', path: '/' })
})

test('a typed path may use either separator; the parent of a root is empty', async () => {
  const dir = temp()
  mkdirSync(join(dir, 'a', 'b'), { recursive: true })
  // The same folder typed with the other kind of separator.
  const flipped = join(dir, 'a').replaceAll(sep, sep === '\\' ? '/' : '\\')
  if (sep === '\\') {
    const r = await listDirs(flipped)
    expect(r.exists).toBe(true)
    expect(r.entries).toEqual(['b'])
  }
  // A root has no parent to go up to.
  const top = await listDirs(parse(dir).root)
  expect(top.parent).toBe('')
})
