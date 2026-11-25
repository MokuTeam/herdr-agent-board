import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readAllNodeEnvFiles } from '../../src/adapters/node-env.ts'

const kept: { LOCALAPPDATA: string | undefined } = { LOCALAPPDATA: process.env.LOCALAPPDATA }
const tempDirs: string[] = []

function withStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ab-node-env-'))
  tempDirs.push(dir)
  kept.LOCALAPPDATA = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = dir
  return join(dir, 'herdr', 'plugins', 'agent-board', 'node', 'env')
}

afterEach(() => {
  if (kept.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = kept.LOCALAPPDATA
  while (tempDirs.length) {
    const d = tempDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

test('readAllNodeEnvFiles returns [] when node/env does not exist', () => {
  withStateDir()
  const logged: string[] = []
  expect(readAllNodeEnvFiles(t => logged.push(t))).toEqual([])
  expect(logged).toEqual([])
})

test('readAllNodeEnvFiles reads default.env first, then remaining *.env sorted by name, never logging values', () => {
  const envDir = withStateDir()
  mkdirSync(envDir, { recursive: true })
  writeFileSync(join(envDir, 'work.env'), "MCP_TELEGRAM_AUTHORIZATION='Bearer secret-work'\n")
  writeFileSync(join(envDir, 'alpha.env'), 'MCP_OTHER=val-alpha\nPATH=/evil/bin\n')
  writeFileSync(join(envDir, 'default.env'), "MCP_TELEGRAM_AUTHORIZATION='Bearer secret-default'\n")
  writeFileSync(join(envDir, 'профиль 50%.env'), 'CUSTOM_TOK=val-cyrillic\n')
  writeFileSync(join(envDir, 'notes.txt'), 'IGNORE=1\n')
  mkdirSync(join(envDir, 'sub.env'), { recursive: true })

  const logged: string[] = []
  const sources = readAllNodeEnvFiles(t => logged.push(t))
  expect(sources).toEqual([
    { name: 'node/env/default.env', vars: { MCP_TELEGRAM_AUTHORIZATION: 'Bearer secret-default' } },
    { name: 'node/env/alpha.env', vars: { MCP_OTHER: 'val-alpha' } },
    { name: 'node/env/work.env', vars: { MCP_TELEGRAM_AUTHORIZATION: 'Bearer secret-work' } },
    { name: 'node/env/профиль 50%.env', vars: { CUSTOM_TOK: 'val-cyrillic' } },
  ])
  expect(logged).toEqual(['node env: PATH in alpha.env is set by the board itself: left out'])
  expect(logged.join('\n')).not.toContain('secret-')
  expect(logged.join('\n')).not.toContain('val-')
})
