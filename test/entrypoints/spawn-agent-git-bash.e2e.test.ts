// spawn-agent's sh shim under Git Bash (#490): Git Bash turns every argument that starts with / into
// a Windows path when it starts the native Bun, so a brief "/review this" reached the session as
// "C:/Program Files/Git/review this". The shim turns that off; spawn-agent converts its folder
// itself. Runs Git Bash's real sh against the sandbox's fake herdr, on Windows only.
import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { planShims } from '../../src/core/install-plan.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

const SH = process.platform === 'win32' ? Bun.which('sh') : null
const READY = { result: { pane: { pane_id: 'wA:p9', tab_id: 'wA:t9', agent: 'claude', agent_status: 'idle' } } }
const STATE = {
  'tab create': { result: { tab: { tab_id: 'wA:t9' }, root_pane: { pane_id: 'wA:p9', terminal_id: 'term-9' } } },
  'tab rename': { result: null },
  'pane run': { result: null },
  'pane get': { seq: [{ result: { pane: { pane_id: 'wA:p9', agent: null } } }, READY] },
  'agent list': { result: { agents: [{ pane_id: 'wA:p9' }] } },
  'agent rename': { result: null },
  'agent prompt': { result: null },
  'pane read': { text: 'Session renamed to: Anna' },
  'pane send-keys': { result: null },
}

/** The shim install writes on Windows, in the sandbox, running this copy's spawn-agent. */
function shim(box: Sandbox): string {
  const file = join(box.dir, 'bin', 'spawn-agent')
  mkdirSync(join(box.dir, 'bin'), { recursive: true })
  const spawn = join(root, 'src', 'entrypoints', 'spawn-agent.ts')
  const paths = { bun: process.execPath, cli: '', hook: '', statusline: '', toast: '', binDir: '', spawn }
  writeFileSync(file, planShims({ ...paths, platform: 'win32' })['spawn-agent'])
  return file
}

/** C:\\x\\y as Git Bash writes it: /c/x/y. */
const msys = (dir: string): string => `/${dir[0]?.toLowerCase()}${dir.slice(2).replace(/\\\\/g, '/')}`

async function viaGitBash(box: Sandbox, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([SH as string, shim(box), ...args], {
    cwd: box.dir,
    // Git's usr/bin (sh, cygpath) on PATH, as in a Git Bash window.
    env: {
      ...box.env,
      PATH: `${dirname(SH as string)}${delimiter}${box.env.PATH}`,
      BOARD_TEST_PACE: '0.02',
      MSYSTEM: 'MINGW64',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

const created = (box: Sandbox): string | undefined =>
  box
    .calls()
    .map(a => a.join(' '))
    .find(c => c.startsWith('tab create'))

test.skipIf(!SH)(
  'spawn-agent in Git Bash: a brief that starts with / arrives as typed, the /c/ folder converted',
  async () => {
    const box = await sandbox()
    box.state(STATE)
    const r = await viaGitBash(
      box,
      ['--name', 'Anna', '--cwd', msys(box.dir), '--workspace', 'wA', '--brief', '/review this'],
      { HERDR_BIN_PATH: msys(box.env.HERDR_BIN_PATH as string) },
    )
    // The fake herdr was found from a /c/ path in the env: Git Bash still converts the environment.
    expect([r.code, r.stderr]).toEqual([0, ''])
    const calls = box.calls().map(a => a.join(' '))
    expect(calls).toContain('agent prompt wA:p9 /review this')
    expect(created(box)?.replace(/\\/g, '/')).toBe(
      `tab create --workspace wA --cwd ${box.dir.replace(/\\/g, '/')} --label Anna --no-focus`,
    )
  },
  30_000,
)

test.skipIf(!SH)(
  'spawn-agent in Git Bash: a name that starts with / is refused as it is, not taken as a path',
  async () => {
    const box = await sandbox()
    box.state(STATE)
    const r = await viaGitBash(box, ['--name', '/anna', '--cwd', msys(box.dir), '--brief', 'Hi'])
    expect([r.code, r.stderr.trim()]).toEqual([1, 'spawn-agent: --name must not start with - or /'])
    expect(box.calls()).toEqual([])
  },
  30_000,
)

test.skipIf(!SH)(
  'spawn-agent in Git Bash with MSYS_NO_PATHCONV set by the user: the shim leaves it as before',
  async () => {
    const box = await sandbox()
    box.state(STATE)
    const brief = join(box.dir, 'brief.txt')
    writeFileSync(brief, 'Go on.\n')
    // Git Bash converts nothing, so spawn-agent gets and keeps the Windows paths typed.
    const r = await viaGitBash(box, ['--name', 'Ben', '--cwd', box.dir, '--workspace', 'wA', '--brief-file', brief], {
      MSYS_NO_PATHCONV: '1',
    })
    expect(r.code).toBe(0)
    expect(created(box)).toBe(`tab create --workspace wA --cwd ${box.dir} --label Ben --no-focus`)
  },
  30_000,
)

test.skipIf(!SH)(
  'spawn-agent from sh outside Git Bash (no MSYSTEM): the shim changes nothing, the runtime converts as before',
  async () => {
    const box = await sandbox()
    box.state(STATE)
    const r = await viaGitBash(
      box,
      ['--name', 'Cleo', '--cwd', msys(box.dir), '--workspace', 'wA', '--brief', '/review this'],
      {
        MSYSTEM: '',
      },
    )
    expect(r.code).toBe(0)
    const prompt = box
      .calls()
      .map(a => a.join(' '))
      .find(c => c.startsWith('agent prompt wA:p9') && c.endsWith('review this'))
    expect(prompt).toBeDefined()
    expect(prompt).not.toBe('agent prompt wA:p9 /review this')
  },
  30_000,
)
