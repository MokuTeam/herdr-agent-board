// The board command's sh shim under Git Bash (#532): Git Bash turns every argument that starts with /
// into a Windows path when it starts the native Bun, so `board doing "/review is done"` carried
// "C:/Program Files/Git/review is done". The shim turns that off; the board converts its file and
// folder words itself (core/board-paths.ts). Runs Git Bash's real sh against the sandbox, on Windows
// only, as spawn-agent-git-bash.e2e.test.ts does for spawn-agent (#490).
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { planShims } from '../../src/core/install-plan.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

const SH = process.platform === 'win32' ? Bun.which('sh') : null
const SESSION = '11111111-2222-3333-4444-555555555555'

/** The shim install writes on Windows, in the sandbox, running this copy's cli.ts. */
function shim(box: Sandbox): string {
  const file = join(box.dir, 'bin', 'board')
  mkdirSync(join(box.dir, 'bin'), { recursive: true })
  const cli = join(root, 'src', 'entrypoints', 'cli.ts')
  const paths = { bun: process.execPath, cli, hook: '', statusline: '', toast: '', binDir: '', spawn: '' }
  writeFileSync(file, planShims({ ...paths, platform: 'win32' }).board)
  // Port 9 answers nothing, so the board never reaches a live one.
  const conf = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(conf, { recursive: true })
  writeFileSync(join(conf, 'config.json'), JSON.stringify({ language: 'en', port: 9 }))
  return file
}

/** C:\\x\\y as Git Bash writes it: /c/x/y. */
const msys = (path: string): string => `/${path[0]?.toLowerCase()}${path.slice(2).replace(/\\/g, '/')}`

async function viaGitBash(box: Sandbox, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn([SH as string, shim(box), ...args], {
    cwd: box.dir,
    // Git's usr/bin (sh, cygpath) on PATH, as in a Git Bash window.
    env: { ...box.env, PATH: `${dirname(SH as string)}${delimiter}${box.env.PATH}`, MSYSTEM: 'MINGW64', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: `${stdout}${stderr}`.trim() }
}

const doing = (box: Sandbox): unknown => JSON.parse(readFileSync(join(box.cards, `${SESSION}.json`), 'utf8')).doing

test.skipIf(!SH)(
  'board in Git Bash: a text that starts with / arrives as typed (#532)',
  async () => {
    const box = await sandbox()
    const r = await viaGitBash(box, ['doing', '/review is done', '--session', SESSION])
    expect(r.code).toBe(0)
    expect(doing(box)).toBe('/review is done')
  },
  30_000,
)

test.skipIf(!SH)(
  'board in Git Bash: a /c/ --file is converted (#532)',
  async () => {
    const box = await sandbox()
    const report = join(box.dir, 'report.md')
    writeFileSync(report, '/review: all green\n')
    const r = await viaGitBash(box, ['call-report', '--session', SESSION, '--file', msys(report)])
    // Read from the converted path: a /c/ path left as typed is no file for the native Bun.
    expect(r).toEqual({ code: 0, out: expect.stringMatching(/^ok/) })
  },
  30_000,
)

test.skipIf(!SH)(
  'board in Git Bash: the folder of backup folder is converted (#532)',
  async () => {
    const box = await sandbox()
    const folder = join(box.dir, 'backups')
    mkdirSync(folder)
    const r = await viaGitBash(box, ['backup', 'folder', msys(folder)])
    expect(r.code).toBe(0)
    const conf = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board/config.json')
    expect(JSON.parse(readFileSync(conf, 'utf8')).backup.folder.replace(/\\/g, '/')).toBe(folder.replace(/\\/g, '/'))
  },
  30_000,
)

test.skipIf(!SH)(
  'board in Git Bash with MSYS_NO_PATHCONV set by the user: the shim leaves it as before',
  async () => {
    const box = await sandbox()
    const r = await viaGitBash(box, ['doing', '/review is done', '--session', SESSION], { MSYS_NO_PATHCONV: '1' })
    expect(r.code).toBe(0)
    expect(doing(box)).toBe('/review is done')
  },
  30_000,
)

test.skipIf(!SH)(
  'board from sh outside Git Bash (no MSYSTEM): the shim changes nothing, the runtime converts as before',
  async () => {
    const box = await sandbox()
    const r = await viaGitBash(box, ['doing', '/review is done', '--session', SESSION], { MSYSTEM: '' })
    expect(r.code).toBe(0)
    expect(doing(box)).toMatch(/.review is done$/)
    expect(doing(box)).not.toBe('/review is done')
  },
  30_000,
)
