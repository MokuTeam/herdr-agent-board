import { beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunOptions, RunResult } from '../../src/adapters/process.ts'
import { asideArgs } from '../../src/core/aside.ts'
import { useLanguage } from '../../src/core/lang.ts'
import { profileSet } from '../../src/core/profiles.ts'
import { asideCheck, askAside, claudeOnPath } from '../../src/services/aside.ts'

beforeEach(() => useLanguage('en'))

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const ANSWER = JSON.stringify({
  subtype: 'success',
  is_error: false,
  result: 'MANGO-77',
  total_cost_usd: 0.27,
  duration_ms: 2900,
  usage: { input_tokens: 2, cache_creation_input_tokens: 33756, cache_read_input_tokens: 0, output_tokens: 8 },
})

/** A session in `dir` whose conversation is in the profile folder `root`. */
function session(fields: Record<string, unknown> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'board-aside-'))
  const dir = join(base, 'Acme project')
  const root = join(base, '.claude-work')
  mkdirSync(dir)
  mkdirSync(root)
  const transcript = join(base, `${S}.jsonl`)
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: dir, sessionId: S })}\n`)
  return {
    dir,
    root,
    item: { agent: 'claude', session: S, name: 'Acme', cwd: dir, transcript, claudeRoot: root, ...fields },
  }
}

const profiles = (inherited: string) => () =>
  profileSet([{ id: 'work', title: 'Work', dir: inherited, color: 'blue', hidden: false }], inherited)

function fakeRun(result: Partial<RunResult> = {}) {
  const calls: { file: string; args: string[]; o: RunOptions }[] = []
  const run = async (file: string, args: string[], o: RunOptions = {}): Promise<RunResult> => {
    calls.push({ file, args, o })
    return { code: 0, killed: false, error: null, stdout: ANSWER, stderr: '', ...result }
  }
  return { calls, run }
}

test('a side question runs Claude once on a copy of the conversation, in its folder and profile, the question on stdin', async () => {
  const { item, dir, root } = session()
  const f = fakeRun()
  const env = { PATH: '/bin', HERDR_PANE_ID: 'wB:p1', HERDR_TAB_ID: 'wB:t1', CLAUDECODE: '1', KEEP: 'yes' }
  const r = await askAside({ profiles: profiles('/home/me/.claude'), log: () => {} }, item, '  What code word?  ', {
    run: f.run,
    env,
    claude: '/usr/local/bin/claude',
  })
  expect(r).toEqual({
    ok: true,
    text: 'MANGO-77',
    costUsd: 0.27,
    tokens: { context: 33758, cached: 0, output: 8 },
    ms: 2900,
  })
  const call = f.calls[0]
  expect(call?.file).toBe('/usr/local/bin/claude')
  expect(call?.args).toEqual(asideArgs(S))
  expect(call?.o.cwd).toBe(dir)
  expect(call?.o.input).toBe('What code word?')
  // Another profile than the board's: its folder; not a pane of the board's, nor a nested session.
  expect(call?.o.env).toEqual({ PATH: '/bin', KEEP: 'yes', CLAUDE_CONFIG_DIR: root })
})

test('in the board’s own profile the env stays as it is', async () => {
  const { item, root } = session()
  const f = fakeRun()
  await askAside({ profiles: profiles(root), log: () => {} }, item, 'q', {
    run: f.run,
    env: { PATH: '/bin' },
    claude: 'claude',
  })
  expect(f.calls[0]?.o.env).toEqual({ PATH: '/bin' })
})

test('refused before Claude runs: no question, too long, not Claude, no conversation, no Claude Code', async () => {
  const deps = { profiles: profiles('/x'), log: () => {} }
  const f = fakeRun()
  const opts = { run: f.run, env: {}, claude: 'claude' }
  const { item } = session()
  expect(await askAside(deps, item, '  ', opts)).toEqual({ ok: false, error: 'Type the question first' })
  expect(await askAside(deps, item, 'x'.repeat(4001), opts)).toEqual({
    ok: false,
    error: 'A side question is up to 4000 characters',
  })
  expect((await askAside(deps, { ...item, agent: 'pi' }, 'q', opts)).ok).toBe(false)
  expect((await askAside(deps, { ...item, session: 'pane-w1:p1' }, 'q', opts)).ok).toBe(false)
  expect(await askAside(deps, { ...item, transcript: null }, 'q', opts)).toEqual({
    ok: false,
    error: '“Acme” has no conversation on this computer yet',
  })
  expect(await askAside(deps, item, 'q', { ...opts, claude: null })).toEqual({
    ok: false,
    error: 'Claude Code (claude) is not on the board’s PATH',
  })
  expect(f.calls).toEqual([])
})

test('how it ends without an answer: cancelled, too slow, an error Claude printed', async () => {
  const deps = { profiles: profiles('/x'), log: () => {} }
  const { item } = session()
  const control = new AbortController()
  control.abort()
  const cancelled = await askAside(deps, item, 'q', {
    run: fakeRun({ killed: true }).run,
    env: {},
    claude: 'claude',
    signal: control.signal,
  })
  expect(cancelled).toEqual({ ok: false, error: 'Cancelled' })
  const slow = await askAside(deps, item, 'q', {
    run: fakeRun({ killed: true, stdout: '' }).run,
    env: {},
    claude: 'claude',
    timeoutMs: 5000,
  })
  expect(slow).toEqual({ ok: false, error: 'No answer in 5 s' })
  const failed = await askAside(deps, item, 'q', {
    run: fakeRun({ code: 1, stdout: '', stderr: 'Error: No conversation found with session ID\n' }).run,
    env: {},
    claude: 'claude',
  })
  expect(failed).toEqual({ ok: false, error: 'Error: No conversation found with session ID' })
})

test('Claude Code on PATH, as the board runs it: claude.exe on Windows (a .cmd needs a shell), claude elsewhere', () => {
  const files = new Set(['C:\\npm\\claude.cmd', 'C:\\Users\\me\\.local\\bin\\claude.exe', '/usr/local/bin/claude'])
  const isFile = (p: string) => files.has(p)
  expect(claudeOnPath({ Path: 'C:\\npm;"C:\\Users\\me\\.local\\bin"' }, 'win32', isFile)).toBe(
    'C:\\Users\\me\\.local\\bin\\claude.exe',
  )
  expect(claudeOnPath({ PATH: 'C:\\npm' }, 'win32', isFile)).toBe(null)
  expect(claudeOnPath({ PATH: '/usr/bin:/usr/local/bin' }, 'linux', isFile)).toBe('/usr/local/bin/claude')
  let now = 0
  let found: string | null = null
  const check = asideCheck({ now: () => now, find: () => found })
  expect(check()).toBe(false)
  found = 'claude'
  expect(check()).toBe(false) // looked up again only after a minute
  now = 61_000
  expect(check()).toBe(true)
})
