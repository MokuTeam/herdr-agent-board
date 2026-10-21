import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fakeClaudeOn } from '../support/fake-claude.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

// After a herdr restart a session in another profile than the default one comes back in it
// (core/resume.ts): its SessionStart hook has the reporter tell herdr `board resume …`
// (test/entrypoints/hook.test.ts), and herdr types that into the restored pane.
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const COMMAND = ['board', 'resume', SID, '--profile', 'work']

const claudeIn = (session: string) => ({
  result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: session } } },
})

/** The reporter as the hook starts it, to its end. */
async function report(box: Sandbox): Promise<void> {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/resume-report.ts'), 'w1:p1', SID, ...COMMAND], {
    cwd: root,
    env: box.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await proc.exited).toBe(0)
}

test('the reporter waits until herdr holds the session in the pane, then reports once', async () => {
  const box = await sandbox()
  box.state({
    'agent get': { seq: [{ result: { agent: null } }, claudeIn(SID)] },
    'pane report-agent-session': { result: null },
  })
  const before = Date.now()
  await report(box)
  const calls = box.calls()
  expect(calls.slice(0, 2)).toEqual([
    ['agent', 'get', 'w1:p1'],
    ['agent', 'get', 'w1:p1'],
  ])
  expect(calls).toHaveLength(3)
  const sent = calls[2] ?? []
  expect(sent.slice(0, 7)).toEqual([
    'pane',
    'report-agent-session',
    'w1:p1',
    '--source',
    'herdr:claude',
    '--agent',
    'claude',
  ])
  // Newer than herdr's own report, which its hook made at the start (ms).
  expect(sent[7]).toBe('--seq')
  expect(Number(sent[8])).toBeGreaterThan(before)
  expect(Number(sent[8])).toBeLessThanOrEqual(Date.now())
  expect(sent.slice(9)).toEqual(['--agent-session-id', SID, '--', ...COMMAND])
})

test('the reporter tries again when herdr refuses, and says nothing once another session has the pane', async () => {
  const box = await sandbox()
  box.state({
    'agent get': { seq: [claudeIn(SID), claudeIn(OTHER)] },
    'pane report-agent-session': {
      error: 'resume_argv requires the reporter to hold the pane',
      code: 'resume_not_accepted',
    },
  })
  await report(box)
  // A /clear since: the pane's session is another one, which this command would not resume.
  expect(box.calls().map(c => c.slice(0, 2).join(' '))).toEqual(['agent get', 'pane report-agent-session', 'agent get'])
})

/** The board's config and a fake `claude` on PATH; `board resume` as herdr types it into a restored pane. */
function setUp(box: Sandbox, config: Record<string, unknown> = {}): { bin: string; log: string; work: string } {
  const home = box.env.USERPROFILE as string
  const work = join(home, '.claude-work')
  for (const dir of [join(home, '.claude'), work]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{}')
  }
  const cfgDir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...config }))
  const bin = join(box.dir, 'bin')
  fakeClaudeOn(bin)
  return { bin, log: join(box.dir, 'claude.json'), work }
}

function putCard(box: Sandbox, key: string, card: Record<string, unknown>): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, `${key}.json`), JSON.stringify({ key, ...card }))
}

async function boardResume(
  box: Sandbox,
  args: string[],
  { bin, log }: { bin: string; log: string },
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; claude: { args: string[]; configDir: string | null; cwd: string } | null }> {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), 'resume', ...args], {
    cwd: box.dir,
    env: { ...box.env, PATH: `${bin}${delimiter}${box.env.PATH}`, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_EXIT: '7', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const claude = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : null
  return { code, out: `${stdout}${stderr}`.trim(), claude }
}

test('board resume: Claude in the profile the card names, with launch.claude and the profile’s args', async () => {
  const box = await sandbox()
  const s = setUp(box, {
    launch: { claude: ['claude', '--allow-dangerously-skip-permissions'] },
    profiles: [
      { id: 'work', title: 'Work', dir: join(box.env.USERPROFILE as string, '.claude-work'), args: ['--verbose'] },
    ],
  })
  putCard(box, SID, { profile: 'work', profileDir: s.work })
  // The restored shell's env: the default profile, as the owner's .bashrc exports it.
  const r = await boardResume(box, [SID, '--profile', 'work'], s, {
    CLAUDE_CONFIG_DIR: join(box.env.USERPROFILE as string, '.claude'),
  })
  // Claude's exit code is board resume's.
  expect(r.code).toBe(7)
  expect(r.claude).toMatchObject({
    args: ['--allow-dangerously-skip-permissions', '--verbose', '--resume', SID],
    configDir: s.work,
  })
  expect(box.calls()).toEqual([])
})

test('board resume: no card, the profile named; neither, the env as it is', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const named = await boardResume(box, [SID, '--profile', 'work'], s)
  expect(named.code).toBe(7)
  expect(named.claude?.args).toEqual(['--resume', SID])
  expect(named.claude?.configDir).toBe(s.work)
  const none = await boardResume(box, [SID], s)
  expect(none.claude?.configDir).toBeNull()
})

test('board resume refuses what is not a session id, and says so', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const r = await boardResume(box, ['nope'], s)
  expect(r.code).toBe(1)
  expect(r.out).toMatch(/^board: "nope" is not a session id/)
  expect(r.claude).toBeNull()
})
