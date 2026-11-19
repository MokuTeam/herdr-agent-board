import { afterEach, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareCodexHome } from '../../src/adapters/codex-dedicated.ts'
import { createCodexHome } from '../../src/adapters/codex-home.ts'

const GLOBAL = '01a15a8a-bd97-7701-a7f7-401e4bec3147'
const OWN = '01a15a8a-bd97-7701-a7f7-401e4bec3148'
const dirs: string[] = []
const saved = process.env.APPDATA
afterEach(() => {
  if (saved === undefined) delete process.env.APPDATA
  else process.env.APPDATA = saved
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function rollout(root: string, id: string): void {
  const day = join(root, 'sessions', '2026', '10', '20')
  mkdirSync(day, { recursive: true })
  const line = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-10-20T08:00:00Z', type, payload })
  writeFileSync(
    join(day, `rollout-2026-10-20T08-00-00-${id}.jsonl`),
    `${line('session_meta', { id, cwd: '/work/Дом 100%' })}\n`,
  )
}

function boxWith(config: unknown | ((own: string) => unknown)) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-dedicated-'))
  dirs.push(dir)
  process.env.APPDATA = join(dir, 'config')
  const own = join(dir, 'herdr codex')
  const file = join(dir, 'config/herdr/plugins/config/agent-board/config.json')
  const value = typeof config === 'function' ? config(own) : config
  if (value !== undefined) {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(value))
  }
  return { dir, global: join(dir, '.codex'), own }
}

test('rollouts of the dedicated Codex home are found beside the global one when config.json names it', async () => {
  const b = boxWith((own: string) => ({ codexHome: own }))
  rollout(b.global, GLOBAL)
  rollout(b.own, OWN)
  const home = createCodexHome(b.global)
  expect(await home.cwdOf(OWN)).toBe('/work/Дом 100%')
  expect(await home.cwdOf(GLOBAL)).toBe('/work/Дом 100%')
})

test('without codexHome in config.json the dedicated folder is not looked in', async () => {
  for (const config of [undefined, {}, { codexHome: '' }, { codexHome: 5 }]) {
    const b = boxWith(config)
    rollout(b.global, GLOBAL)
    rollout(b.own, OWN)
    const home = createCodexHome(b.global)
    expect(await home.cwdOf(GLOBAL)).toBe('/work/Дом 100%')
    expect(await home.cwdOf(OWN)).toBeNull()
  }
})

test('prepareCodexHome links what is shared, never replaces, and keeps skills a real folder', () => {
  const b = boxWith(undefined)
  mkdirSync(join(b.global, 'skills/mine'), { recursive: true })
  mkdirSync(join(b.global, 'rules'), { recursive: true })
  writeFileSync(join(b.global, 'rules/default.rules'), 'R')
  writeFileSync(join(b.global, 'auth.json'), 'A')
  writeFileSync(join(b.global, 'config.toml'), 'C')
  mkdirSync(join(b.own), { recursive: true })
  writeFileSync(join(b.own, 'config.toml'), 'own copy')
  const out = prepareCodexHome(b.own, b.global)
  expect(out.failed).toEqual([])
  expect(out.linked.sort()).toEqual(['auth.json', join('rules', 'default.rules'), join('skills', 'mine')])
  expect(readFileSync(join(b.own, 'config.toml'), 'utf8')).toBe('own copy')
  expect(lstatSync(join(b.own, 'auth.json')).isSymbolicLink()).toBe(true)
  expect(lstatSync(join(b.own, 'skills')).isSymbolicLink()).toBe(false)
  expect(prepareCodexHome(b.own, b.global).linked).toEqual([])
  expect(readFileSync(join(b.own, 'rules', 'agent-board.rules'), 'utf8')).toContain('prefix_rule(pattern=["board"]')
  expect(lstatSync(join(b.own, 'rules')).isSymbolicLink()).toBe(false)
  expect(() => prepareCodexHome(b.global, b.global)).toThrow('is the global one')
})

test('prepareCodexHome: the master rule for herdr agent only with master, and only the four commands', () => {
  const b = boxWith(() => ({}))
  const rules = join(b.own, 'rules/agent-board.rules')
  prepareCodexHome(b.own, b.global)
  expect(readFileSync(rules, 'utf8')).not.toContain('"herdr"')
  prepareCodexHome(b.own, b.global, { master: true })
  const master = readFileSync(rules, 'utf8')
  expect(master).toContain('prefix_rule(pattern=["board"], decision="allow")')
  expect(master).toContain(
    'prefix_rule(pattern=["herdr", "agent", ["prompt", "read", "list", "get"]], decision="allow")',
  )
  expect(master).not.toMatch(/send-keys|"pane"|"tab"|server/)
  prepareCodexHome(b.own, b.global, { master: true })
  expect(readFileSync(rules, 'utf8')).toBe(master)
  // Installed again without the option, the file is the default one.
  prepareCodexHome(b.own, b.global)
  expect(readFileSync(rules, 'utf8')).not.toContain('"herdr"')
})
