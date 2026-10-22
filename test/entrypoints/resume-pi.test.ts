// `board resume --pi <id>` (#178): what wake types into a sleeping pi session's pane. pi runs on
// the session's file with the command line it had, without what would start another conversation
// or set the model, in the Claude account folder it slept with and in its folder; one wake does
// not know is found among pi's session files. herdr is asked nothing.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fakePiOn } from '../support/fake-pi-program.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

const ID = '01a15d6d-9f21-7751-a71a-834d50839768'

interface Set {
  bin: string
  log: string
  home: string
  file: string
  project: string
}

/** The board's config, a fake `pi` on PATH, a pi session file in a folder with spaces, Cyrillic and %. */
function setUp(box: Sandbox): Set {
  const home = box.env.USERPROFILE as string
  for (const dir of [join(home, '.claude'), join(home, '.claude-work')]) mkdirSync(dir, { recursive: true })
  const cfgDir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ language: 'en', port: 9 }))
  const project = join(home, 'Проект x 50%')
  mkdirSync(project, { recursive: true })
  const folder = join(home, '.pi', 'agent', 'sessions', '--home-Проект x 50%--')
  mkdirSync(folder, { recursive: true })
  const file = join(folder, `2026-10-21T07-47-07-681Z_${ID}.jsonl`)
  writeFileSync(file, `${JSON.stringify({ type: 'session', version: 3, id: ID, cwd: project })}\n`)
  const bin = join(box.dir, 'bin')
  fakePiOn(bin)
  return { bin, log: join(box.dir, 'pi.json'), home, file, project }
}

/** Wake's pi file, as the wake process writes it. */
function sleeper(box: Sandbox, s: Set, fields: Record<string, unknown>): void {
  const state = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
  mkdirSync(state, { recursive: true })
  const entry = { session: s.file, name: 'Billing', pane: 'w1:p1', cwd: s.project, argv: [], slept_at: 1, ...fields }
  writeFileSync(join(state, 'wake-pi.json'), JSON.stringify({ [s.file]: entry }))
}

async function resumePi(
  box: Sandbox,
  args: string[],
  s: Set,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; pi: { args: string[]; configDir: string | null; cwd: string } | null }> {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), 'resume', ...args], {
    cwd: box.dir,
    env: { ...box.env, PATH: `${s.bin}${delimiter}${box.env.PATH}`, FAKE_PI_LOG: s.log, FAKE_PI_EXIT: '5', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const pi = existsSync(s.log) ? JSON.parse(readFileSync(s.log, 'utf8')) : null
  return { code, out: `${stdout}${stderr}`.trim(), pi }
}

test('board resume --pi: the session’s file, its options but not its model, name or message, its account and folder', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const work = join(s.home, '.claude-work')
  sleeper(box, s, {
    argv: ['pi', '--model', 'claude-bridge/claude-opus-5-5', '--no-mcp', '--name', 'billing', 'Read the brief'],
    account: work,
  })
  // The pane's shell is on the personal account: the session slept on Work, so it wakes on Work.
  const r = await resumePi(box, ['--pi', ID], s, { CLAUDE_CONFIG_DIR: join(s.home, '.claude') })
  expect(r.code).toBe(5)
  expect(r.pi).toEqual({ args: ['--no-mcp', '--session', s.file], configDir: work, cwd: s.project })
  expect(box.calls()).toEqual([])
})

test('board resume --pi: slept on the personal account, a shell on Work’s: back on the personal one', async () => {
  const box = await sandbox()
  const s = setUp(box)
  sleeper(box, s, { account: join(s.home, '.claude') })
  const r = await resumePi(box, ['--pi', ID], s, { CLAUDE_CONFIG_DIR: join(s.home, '.claude-work') })
  expect(r.pi?.configDir).toBeNull()
  expect(r.pi?.args).toEqual(['--session', s.file])
})

test('board resume --pi: one wake does not know is found by its id, with the shell’s env as it is', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const r = await resumePi(box, ['--pi', ID.toUpperCase()], s, { CLAUDE_CONFIG_DIR: '/x' })
  expect(r.code).toBe(5)
  expect(r.pi).toMatchObject({ args: ['--session', s.file], configDir: '/x', cwd: box.dir })
})

test('board resume --pi: no such session, or no id, is said and pi is not run', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const none = await resumePi(box, ['--pi', '01a10000-0000-7000-8000-000000000000'], s)
  expect(none.code).toBe(1)
  expect(none.out).toMatch(/^board: no pi session 01a10000-0000-7000-8000-000000000000/)
  const bad = await resumePi(box, ['--pi', 'a;b'], s)
  expect(bad.out).toMatch(/is not a pi session id/)
  expect(bad.pi).toBeNull()
})
