// The install's own pieces that run without a server (services/server-install.ts): versions
// compared, and the board's code written over its checkout in place (a pack, or a ref over a
// pack's checkout): what changed overwritten, what is gone removed, its packages and git kept.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atLeast, syncInto } from '../../src/services/server-install.ts'

test('a version at least another', () => {
  expect(atLeast('1.4.3', '1.4.3')).toBe(true)
  expect(atLeast('1.5.0', '1.4.3')).toBe(true)
  expect(atLeast('1.10.0', '1.9.9')).toBe(true)
  expect(atLeast('1.4.2', '1.4.3')).toBe(false)
  expect(atLeast('0.9.5', '0.9.2')).toBe(true)
  expect(atLeast('', '0.9.2')).toBe(false)
})

test('the code written over the checkout in place: changed, added, gone; node_modules and .git kept', () => {
  const sh = Bun.which('sh')
  if (!sh) return
  const dir = mkdtempSync(join(tmpdir(), 'sync-into-'))
  try {
    const to = join(dir, 'agent-board')
    const from = join(dir, 'agent-board.new')
    const put = (path: string, text: string): void => {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, text)
    }
    put(join(to, 'src', 'a.ts'), 'old a')
    put(join(to, 'src', 'gone.ts'), 'gone')
    put(join(to, 'node_modules', 'react', 'index.js'), 'react')
    put(join(to, '.git', 'HEAD'), 'ref')
    put(join(from, 'src', 'a.ts'), 'new a')
    put(join(from, 'src', 'b.ts'), 'b')
    put(join(from, 'name with space.md'), 'x')
    const unix = (p: string): string => p.replaceAll('\\', '/')
    const r = Bun.spawnSync([sh, '-c', syncInto(unix(from), unix(to))], { stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    expect(readFileSync(join(to, 'src', 'a.ts'), 'utf8')).toBe('new a')
    expect(readFileSync(join(to, 'src', 'b.ts'), 'utf8')).toBe('b')
    expect(existsSync(join(to, 'name with space.md'))).toBe(true)
    expect(existsSync(join(to, 'src', 'gone.ts'))).toBe(false)
    expect(readFileSync(join(to, 'node_modules', 'react', 'index.js'), 'utf8')).toBe('react')
    expect(readFileSync(join(to, '.git', 'HEAD'), 'utf8')).toBe('ref')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
