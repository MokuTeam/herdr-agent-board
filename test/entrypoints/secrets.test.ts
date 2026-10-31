// The owner's secrets reaching the sessions, end to end in a sandbox: `board secret` (set from
// stdin, list, rm, get and file for the calling session only), Claude's SessionStart hook writing
// the board's block in $CLAUDE_ENV_FILE (Bash), and Claude started with them in its env by
// `board launch` and `board resume` (MCP servers). With no secret ever set, nothing of it runs:
// no file is made, the env file is not touched, Claude starts with the env it had.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fakeClaudeOn } from '../support/fake-claude.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

const SID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const MARKER = 's3cr3t-MARKER'
const POSIX = process.platform !== 'win32'
const CLI = join(root, 'src', 'entrypoints', 'cli.ts')
const HOOK = join(root, 'src', 'entrypoints', 'hook.ts')

/** The sandbox with the profiles default and work (each a folder with settings.json) and a fake claude on PATH. */
function setUp(box: Sandbox, config: Record<string, unknown> = {}) {
  const home = box.env.USERPROFILE as string
  const work = join(home, '.claude-work')
  for (const dir of [join(home, '.claude'), work]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'settings.json'), '{}')
  }
  const cfgDir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      language: 'en',
      port: 9,
      wake: false,
      wakeUrl: '',
      profiles: [{ id: 'work', title: 'Work', dir: work, color: 'pink', hidden: false }],
      ...config,
    }),
  )
  const bin = join(box.dir, 'bin')
  fakeClaudeOn(bin)
  const run = join(box.dir, 'run')
  mkdirSync(run, { mode: 0o700 })
  return {
    work,
    bin,
    run,
    log: join(box.dir, 'claude.json'),
    secrets: join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/secrets'),
  }
}

type Ran = { code: number; stdout: string; stderr: string }

async function run(
  box: Sandbox,
  file: string,
  args: string[],
  env: Record<string, string> = {},
  stdin?: string,
): Promise<Ran> {
  const proc = Bun.spawn([process.execPath, file, ...args], {
    cwd: box.dir,
    env: { ...box.env, ...env },
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}
const board = (box: Sandbox, args: string[], env: Record<string, string> = {}, stdin?: string) =>
  run(box, CLI, args, env, stdin)

/** global A, work's A and B, the session's A: set as the owner sets them, from stdin. */
async function seed(box: Sandbox): Promise<void> {
  for (const [args, value] of [
    [['secret', 'set', 'A'], `${MARKER}-global\n`],
    [['secret', 'set', 'A', '--profile', 'work'], `${MARKER}-work`],
    [['secret', 'set', 'B', '--profile', 'work'], 'it\'s "b" $HOME'],
    [['secret', 'set', 'A', '--session', SID], `${MARKER}-session\r\n`],
  ] as const) {
    const r = await board(box, [...args], {}, value)
    expect([args, r.code, r.stderr]).toEqual([args, 0, ''])
    expect(r.stdout).toStartWith('ok · ')
    expect(r.stdout).not.toContain(MARKER)
  }
}

test('board secret: set from stdin, never as an argument; list without values; rm by scope', async () => {
  const box = await sandbox()
  const s = setUp(box)
  await seed(box)
  if (POSIX) expect(statSync(join(s.secrets, 'store.json')).mode & 0o777).toBe(0o600)
  const listed = await board(box, ['secret', 'list'])
  expect(listed.code).toBe(0)
  expect(
    listed.stdout
      .split('\n')
      .filter(Boolean)
      .map(l => l.replace(/ · set .*/, '')),
  ).toEqual(['A · global', 'A · profile work', `A · session ${SID.slice(0, 8)}`, 'B · profile work'])
  expect(listed.stdout).not.toContain(MARKER)
  for (const [args, error] of [
    [['secret', 'set', 'A', MARKER], 'the value is never an argument'],
    [['secret', 'set', '1A'], 'variable'],
    [['secret', 'set', 'PATH'], 'PATH'],
    [['secret', 'set', 'A', '--profile', 'nope'], 'no profile "nope"'],
    [['secret', 'set', 'A', '--profile', 'work', '--global'], 'one scope at most'],
    [['secret', 'rm', 'A'], 'A is set in 3 scopes'],
  ] as const) {
    const r = await board(box, [...args], {}, 'x')
    expect([args, r.code]).toEqual([args, 1])
    expect(r.stderr).toContain(error)
    expect(r.stderr).not.toContain(MARKER)
  }
  expect((await board(box, ['secret', 'set', 'C'], {}, '')).stderr).toContain('board: ')
  expect((await board(box, ['secret', 'rm', 'A', '--global'])).stdout).toBe('ok · removed A (global)\n')
  expect((await board(box, ['secret', 'rm', 'B'])).stdout).toBe('ok · removed B (profile work)\n')
  expect((await board(box, ['secret', 'rm', 'B'])).stderr).toContain('no secret B')
})

test('board secret get and file: the calling session gets its own, by session, profile, global; none outside a session', async () => {
  const box = await sandbox()
  const s = setUp(box)
  await seed(box)
  const inSession = { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CONFIG_DIR: s.work, XDG_RUNTIME_DIR: s.run }
  expect(await board(box, ['secret', 'get', 'A'], inSession)).toEqual({
    code: 0,
    stdout: `${MARKER}-session`,
    stderr: '',
  })
  expect((await board(box, ['secret', 'get', 'B'], inSession)).stdout).toBe('it\'s "b" $HOME')
  // Another session in the work profile: work's; one in the default profile: the global one, no B.
  const other = { ...inSession, CLAUDE_CODE_SESSION_ID: OTHER }
  expect((await board(box, ['secret', 'get', 'A'], other)).stdout).toBe(`${MARKER}-work`)
  const plain = { CLAUDE_CODE_SESSION_ID: OTHER, XDG_RUNTIME_DIR: s.run }
  expect((await board(box, ['secret', 'get', 'A'], plain)).stdout).toBe(`${MARKER}-global`)
  const noB = await board(box, ['secret', 'get', 'B'], plain)
  expect([noB.code, noB.stdout, noB.stderr]).toEqual([
    1,
    '',
    'board: no secret B for this session (board secret list)\n',
  ])
  // Another session's by --session, or outside a session: refused.
  const asked = await board(box, ['secret', 'get', 'A', '--session', SID], plain)
  expect([asked.code, asked.stdout]).toEqual([1, ''])
  expect(asked.stderr).toContain('for the calling session only')
  const outside = await board(box, ['secret', 'get', 'A'])
  expect([outside.code, outside.stdout]).toEqual([1, ''])
  // file: in the session's own folder in memory, 0600.
  const file = await board(box, ['secret', 'file', 'A'], inSession)
  expect(file.code).toBe(0)
  const path = file.stdout.trim()
  expect(path).toBe(join(s.run, 'agent-board', 'secrets', SID, 'A'))
  expect(readFileSync(path, 'utf8')).toBe(`${MARKER}-session`)
  if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o600)
  // Last used: this session, by file.
  const listed = await board(box, ['secret', 'list'])
  expect(listed.stdout).toMatch(
    new RegExp(`A · session ${SID.slice(0, 8)} · set .* · used .* by ${SID.slice(0, 8)} \\(file\\)`),
  )
  expect(listed.stdout).toMatch(/A · global · set .* · used .* \(get\)/)
})

test('board launch: claude with the secrets of its profile and session in its env, its arguments as they came', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const env = {
    PATH: `${s.bin}${delimiter}${box.env.PATH}`,
    FAKE_CLAUDE_LOG: s.log,
    FAKE_CLAUDE_ENV: 'A,B',
    FAKE_CLAUDE_EXIT: '5',
  }
  // No secret ever set: the env as it was, nothing made.
  const before = await board(box, ['launch', 'claude', '--name', 'x', '--session', 'y'], env)
  expect(before.code).toBe(5)
  expect(JSON.parse(readFileSync(s.log, 'utf8'))).toMatchObject({ args: ['--name', 'x', '--session', 'y'], env: {} })
  expect(existsSync(s.secrets)).toBe(false)
  await seed(box)
  const r = await board(box, ['launch', 'claude', '--allow-dangerously-skip-permissions', '--resume', SID], {
    ...env,
    CLAUDE_CONFIG_DIR: s.work,
  })
  expect(r.code).toBe(5)
  const claude = JSON.parse(readFileSync(s.log, 'utf8'))
  expect(claude).toMatchObject({
    args: ['--allow-dangerously-skip-permissions', '--resume', SID],
    configDir: s.work,
    env: { A: `${MARKER}-session`, B: 'it\'s "b" $HOME' },
  })
  // Never on its command line.
  expect(JSON.stringify(claude.args)).not.toContain(MARKER)
  expect((await board(box, ['secret', 'list'])).stdout).toMatch(/A · session .* \(launch\)/)
})

test('board resume: Claude in its profile with the session’s secrets in its env; none set, the env as before', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const env = { PATH: `${s.bin}${delimiter}${box.env.PATH}`, FAKE_CLAUDE_LOG: s.log, FAKE_CLAUDE_ENV: 'A,B' }
  const before = await board(box, ['resume', SID, '--profile', 'work'], env)
  expect(before.code).toBe(0)
  expect(JSON.parse(readFileSync(s.log, 'utf8'))).toEqual({
    args: ['--resume', SID],
    configDir: s.work,
    cwd: box.dir,
    env: {},
  })
  await seed(box)
  await board(box, ['resume', SID, '--profile', 'work'], env)
  expect(JSON.parse(readFileSync(s.log, 'utf8'))).toEqual({
    args: ['--resume', SID],
    configDir: s.work,
    cwd: box.dir,
    env: { A: `${MARKER}-session`, B: 'it\'s "b" $HOME' },
  })
  // Another session in the default profile: the global one only.
  await board(box, ['resume', OTHER], env)
  expect(JSON.parse(readFileSync(s.log, 'utf8')).env).toEqual({ A: `${MARKER}-global` })
})

/** Claude Code's SessionStart hook for `sid`, with its env file; what it printed. */
async function sessionStart(
  box: Sandbox,
  sid: string,
  env: Record<string, string>,
  more: Record<string, unknown> = {},
) {
  const r = await run(
    box,
    HOOK,
    [],
    env,
    JSON.stringify({ hook_event_name: 'SessionStart', session_id: sid, cwd: box.dir, ...more }),
  )
  expect([r.code, r.stderr]).toEqual([0, ''])
  return r.stdout
}

/** What bash has for A and B after it sources the env file, as Claude Code does before a Bash command. */
async function bashSees(envFile: string): Promise<string> {
  const proc = Bun.spawn(['bash', '--noprofile', '--norc', '-c', `. '${envFile}'; printf '%s|%s' "$A" "$B"`], {
    stdout: 'pipe',
    env: {},
  })
  return new Response(proc.stdout).text()
}

test('the hook: no secret ever set, the env file is not touched and nothing is made', async () => {
  const box = await sandbox()
  const s = setUp(box)
  const envFile = join(box.dir, 'sessionstart-hook-1.sh')
  const out = await sessionStart(box, SID, { HERDR_PANE_ID: 'p1', CLAUDE_ENV_FILE: envFile, XDG_RUNTIME_DIR: s.run })
  expect(out).toContain('additionalContext')
  expect(existsSync(envFile)).toBe(false)
  expect(existsSync(s.secrets)).toBe(false)
  expect(existsSync(join(s.run, 'agent-board'))).toBe(false)
  // Outside herdr too.
  expect(await sessionStart(box, SID, { CLAUDE_ENV_FILE: envFile })).toBe('')
  expect(existsSync(envFile)).toBe(false)
})

test.skipIf(!POSIX || !Bun.which('bash'))(
  "the hook: Bash gets the session's secrets from memory; Claude's env file holds a path, no value",
  async () => {
    const box = await sandbox()
    const s = setUp(box)
    await seed(box)
    const envFile = join(box.dir, 'sessionstart-hook-1.sh')
    writeFileSync(envFile, 'export FROM_ANOTHER_HOOK=1\n')
    const env = { HERDR_PANE_ID: 'p1', CLAUDE_ENV_FILE: envFile, CLAUDE_CONFIG_DIR: s.work, XDG_RUNTIME_DIR: s.run }
    const out = await sessionStart(box, SID, env)
    expect(out).toContain('additionalContext')
    expect(out).not.toContain(MARKER)
    const text = readFileSync(envFile, 'utf8')
    const own = join(s.run, 'agent-board', 'secrets', SID, 'env.sh')
    expect(text).toBe(
      `export FROM_ANOTHER_HOOK=1\n# agent-board secrets (begin)\n[ -r '${own}' ] && . '${own}'\n# agent-board secrets (end)\n`,
    )
    expect(text).not.toContain(MARKER)
    expect(statSync(own).mode & 0o777).toBe(0o600)
    expect(await bashSees(envFile)).toBe(`${MARKER}-session|it's "b" $HOME`)
    expect((await board(box, ['secret', 'list'])).stdout).toMatch(/A · session .* \(env\)/)
    // Resumed after the session's A went: its block again, with what it gets now; the other hook's line kept.
    expect((await board(box, ['secret', 'rm', 'A', '--session', SID])).code).toBe(0)
    await sessionStart(box, SID, { ...env, HERDR_PANE_ID: '' }, { source: 'resume' })
    expect(readFileSync(envFile, 'utf8').match(/agent-board secrets \(begin\)/g)).toHaveLength(1)
    expect(await bashSees(envFile)).toBe(`${MARKER}-work|it's "b" $HOME`)
    // A session that gets none: the block goes.
    for (const id of ['global::A', 'profile:work:A', 'profile:work:B'])
      await board(box, [
        'secret',
        'rm',
        id.split(':').at(-1) as string,
        ...(id.startsWith('global') ? ['--global'] : ['--profile', 'work']),
      ])
    await sessionStart(box, SID, env)
    expect(readFileSync(envFile, 'utf8')).toBe('export FROM_ANOTHER_HOOK=1\n')
    // Every secret gone: another session's env file is not made, nor a folder of its own.
    const fresh = join(box.dir, 'sessionstart-hook-2.sh')
    await sessionStart(box, OTHER, { ...env, CLAUDE_ENV_FILE: fresh })
    expect(existsSync(fresh)).toBe(false)
    expect(existsSync(join(s.run, 'agent-board', 'secrets', OTHER))).toBe(false)
  },
)

test.skipIf(!Bun.which('bash'))(
  'the hook without a memory folder: the export lines in the env file itself; a subagent gets nothing',
  async () => {
    const box = await sandbox()
    setUp(box)
    await seed(box)
    const envFile = join(box.dir, 'sessionstart-hook-0.sh')
    await sessionStart(box, OTHER, { CLAUDE_ENV_FILE: envFile })
    const text = readFileSync(envFile, 'utf8')
    expect(text).toBe(`# agent-board secrets (begin)\nexport A='${MARKER}-global'\n# agent-board secrets (end)\n`)
    expect(await bashSees(envFile)).toBe(`${MARKER}-global|`)
    const sub = join(box.dir, 'sub.sh')
    await sessionStart(box, OTHER, { CLAUDE_ENV_FILE: sub }, { agent_id: 'agent-1' })
    expect(existsSync(sub)).toBe(false)
  },
)
