import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statusWriter } from '../../assistant-bridge/src/files.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const read = (file: string): { link: string } => JSON.parse(readFileSync(file, 'utf8')) as { link: string }

test('status.json ends on the latest state, also when it changed within the window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-status-'))
  dirs.push(dir)
  const file = join(dir, 'status.json')
  const write = statusWriter(file, 80)
  write({ link: 'connecting' })
  expect(read(file).link).toBe('connecting')
  write({ link: 'online' })
  write({ link: 'online' })
  expect(read(file).link).toBe('connecting')
  await new Promise(r => setTimeout(r, 160))
  expect(read(file).link).toBe('online')
})
