import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readUsageCache } from '../../src/adapters/claude-home.ts'
import { usageFileFor } from '../../src/adapters/paths.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

const plain = (s: string): string => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
const input = {
  session_id: 'abc-123',
  context_window: {
    context_window_size: 200000,
    used_percentage: 8,
    current_usage: {
      input_tokens: 8500,
      output_tokens: 1200,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 2000,
    },
  },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  },
}

test('as the command Claude runs: files for the board, the line on stdout, old windows kept on an empty input', async () => {
  const box = await sandbox()
  const script = join(root, 'src', 'entrypoints', 'statusline.ts')
  const run = (stdin: unknown) =>
    spawnSync(process.execPath, [script], { input: JSON.stringify(stdin), encoding: 'utf8', env: box.env })
  const out = run(input)
  assert.equal(out.status, 0)
  assert.equal(plain(out.stdout), 'ctx 8% · 5h 24% · 7d 41%')
  const state = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
  const usage = JSON.parse(readFileSync(join(state, 'claude-limits-latest.json'), 'utf8'))
  assert.equal(usage.fiveHour.usedPercentage, 23.5)
  assert.equal(JSON.parse(readFileSync(join(state, 'context', 'abc-123.json'), 'utf8')).usedPercentage, 8)
  assert.equal(run({}).status, 0)
  assert.equal(JSON.parse(readFileSync(join(state, 'claude-limits-latest.json'), 'utf8')).fiveHour.usedPercentage, 23.5)
  assert.equal(run('not json').stdout, '') // a bad input leaves the line blank, no error
  // Outside a herdr pane no card is written.
  assert.equal(existsSync(join(box.cards, 'abc-123.json')), false)
  // The board reads it with the usagebar reader: resets in seconds become milliseconds.
  const read = readUsageCache(state, usage.fetchedAtMs + 1000).limits
  assert.equal(read.available, true)
  assert.deepEqual(
    (read.windows ?? []).map(w => [w.minutes, w.usedPercentage, w.resetsAt]),
    [
      [300, 23.5, 1738425600000],
      [10080, 41.2, 1738857600000],
    ],
  )
})

const script = join(root, 'src', 'entrypoints', 'statusline.ts')
const stateOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
const configOf = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'))
/** The status line in a herdr pane, `env` on top of the sandbox's. */
const runIn = (box: Sandbox, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...box.env, HERDR_PANE_ID: 'p1', ...env },
  })

test('usage goes to its profile: default as before, work in its own file, an unknown folder nowhere; the line is the same', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  const work = join(home, '.claude-work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'settings.json'), '{}')
  const state = stateOf(box)
  const latest = join(state, 'claude-limits-latest.json')

  let out = runIn(box)
  expect(out.status).toBe(0)
  expect(plain(out.stdout)).toBe('ctx 8% · 5h 24% · 7d 41%')
  const line = out.stdout
  expect(existsSync(latest)).toBe(true)
  expect(readJson(join(box.cards, 'abc-123.json'))).toMatchObject({ profile: 'default' })
  const saved = readFileSync(latest, 'utf8')

  out = runIn(box, { CLAUDE_CONFIG_DIR: work })
  expect(out.status).toBe(0)
  expect(out.stdout).toBe(line)
  expect(readJson(join(state, 'claude-limits-profile-work.json')).fiveHour.usedPercentage).toBe(23.5)
  expect(readFileSync(latest, 'utf8')).toBe(saved) // the default profile's usage is not touched
  expect(readJson(join(box.cards, 'abc-123.json'))).toMatchObject({ profile: 'work', profileDir: work })
  expect(existsSync(configOf(box))).toBe(false)

  // A folder no profile has: whose usage it is cannot be told, so it is not kept.
  const fresh = await sandbox()
  const odd = join(fresh.dir, 'odd')
  out = runIn(fresh, { CLAUDE_CONFIG_DIR: odd })
  expect(out.status).toBe(0)
  expect(out.stdout).toBe(line)
  expect(readdirSync(stateOf(fresh)).filter(name => name.startsWith('claude-limits-'))).toEqual([])
  expect(readJson(join(stateOf(fresh), 'context', 'abc-123.json')).usedPercentage).toBe(8)
  const card = readJson(join(fresh.cards, 'abc-123.json'))
  expect(card.profile).toBeUndefined()
  expect(card.profileDir).toBe(odd)
  expect(existsSync(configOf(fresh))).toBe(false)
})

test('each profile keeps its usage apart: one named latest leaves the default one alone, ids that read alike never share a file', async () => {
  const box = await sandbox()
  const home = box.env.USERPROFILE as string
  const named = join(home, '.claude-latest')
  mkdirSync(named, { recursive: true })
  writeFileSync(join(named, 'settings.json'), '{}')
  const state = stateOf(box)
  const latest = join(state, 'claude-limits-latest.json')

  expect(runIn(box).status).toBe(0)
  const saved = readFileSync(latest, 'utf8')
  expect(runIn(box, { CLAUDE_CONFIG_DIR: named }).status).toBe(0)
  expect(readJson(join(box.cards, 'abc-123.json'))).toMatchObject({ profile: 'latest', profileDir: named })
  expect(readFileSync(latest, 'utf8')).toBe(saved) // the default profile's usage is not overwritten
  expect(readJson(join(state, 'claude-limits-profile-latest.json')).fiveHour.usedPercentage).toBe(23.5)

  const name = (id: string): string => basename(usageFileFor(id))
  expect(name('default')).toBe('claude-limits-latest.json')
  expect(name('latest')).toBe('claude-limits-profile-latest.json')
  expect(name('a.b')).toBe('claude-limits-profile-a%2Eb.json')
  // Ids that used to fold into one file, and ones that differ only in case (one file on Windows).
  const ids = ['a.b', 'a_b', 'a-b', 'a b', 'a/b', 'a\\b', 'a%2Eb', 'a%2eb', 'Work', 'work', 'ü', '%FC', '😀', 'Default']
  const names = ids.map(id => name(id).toLowerCase())
  expect(new Set(names).size).toBe(ids.length)
  for (const n of names) expect(n).toMatch(/^claude-limits-profile-[a-z0-9_%-]+\.json$/)
})
