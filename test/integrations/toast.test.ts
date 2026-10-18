import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { copyFileSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { boardFiles } from '../../src/core/setup.ts'
import { unusedPort } from '../support/board-server.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

// The notification script as a whole is only parsed here, never run: it registers a URL protocol
// and shows notifications, which belong to the owner's computer (T30). Only a click's way to the
// web board runs, cut off before herdr (below).
const script = boardFiles(root).toast
const windows = process.platform === 'win32'
const powershell = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

test.skipIf(!windows)(
  'toast.ps1 parses in Windows PowerShell',
  () => {
    const parse = Bun.spawnSync([
      powershell,
      '-NoProfile',
      '-Command',
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$e); $e.Count`,
    ])
    assert.equal(parse.stdout.toString().trim(), '0', parse.stderr.toString())
  },
  20_000,
)

test('toast.ps1: its link handler takes a pane id only, and a click goes to this copy’s web board first', () => {
  const text = readFileSync(script, 'utf8')
  const rule = /-notmatch '(\^claude-pane:[^']+)'/.exec(text)?.[1]
  assert.ok(rule)
  const re = new RegExp(rule)
  for (const ok of ['claude-pane:wP:p3G', 'claude-pane:w12:p1/']) assert.match(ok, re)
  for (const bad of [
    'claude-pane:w1:p2;calc',
    'claude-pane:w1:p2&x',
    'claude-pane:../x',
    'claude-pane:w1:p2 x',
    'other:w1:p2',
  ])
    assert.doesNotMatch(bad, re)
  assert.ok(text.includes('Join-Path $BoardDir "src\\entrypoints\\web-open.ts"'))
  assert.ok(text.includes('$BoardDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)'))
})

// A click runs the script again as `open claude-pane:<pane id>`. Its lines up to herdr's turn run
// here, from a copy of the board in a sandbox, with `exit 9` where herdr would be asked: herdr,
// the registry and the terminal window are never reached. The copy's web-open.ts is a fake that
// logs its arguments and exits with CLICK_EXIT, or hands them to the real one (REAL_WEB_OPEN).
const HERDR_NEXT = '        if ($LASTEXITCODE -eq 0) { exit 0 }\n    }\n'
const FAKE_WEB_OPEN = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.CLICK_LOG ?? '', JSON.stringify(process.argv.slice(2)) + '\\n')
const real = process.env.REAL_WEB_OPEN
if (real) process.exit(Bun.spawnSync([process.execPath, real, ...process.argv.slice(2)]).exitCode ?? 1)
process.exit(Number(process.env.CLICK_EXIT ?? '0'))
`

function clickPart(): string {
  const text = readFileSync(script, 'utf8').replace(/\r\n/g, '\n')
  const at = text.indexOf(HERDR_NEXT)
  assert.ok(at > text.indexOf('if ($Action -eq "open") {'), 'the web board comes before herdr')
  return `${text.slice(0, at + HERDR_NEXT.length)}    exit 9\n}\n`
}

async function click(box: Sandbox, uri: string, env: Record<string, string> = {}) {
  const board = join(box.dir, 'board')
  mkdirSync(join(board, 'src', 'integrations'), { recursive: true })
  mkdirSync(join(board, 'src', 'entrypoints'), { recursive: true })
  const copy = join(board, 'src', 'integrations', 'toast.ps1')
  writeFileSync(copy, clickPart())
  writeFileSync(join(board, 'src', 'entrypoints', 'web-open.ts'), FAKE_WEB_OPEN)
  const log = join(box.dir, 'clicks.jsonl')
  writeFileSync(log, '')
  // PATHEXT, which a click's own environment has: without it PowerShell takes bun.exe for a document.
  const pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  const proc = Bun.spawn([powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', copy, 'open', uri], {
    env: { ...box.env, PATHEXT: pathext, CLICK_LOG: log, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  const calls = readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as string[])
  return { code, calls, stderr }
}

/** A board that answers /api/reveal with `status` and `body`, and records the panes it was asked for. */
function standIn(status: number, body: unknown) {
  const asked: unknown[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.method !== 'POST' || new URL(req.url).pathname !== '/api/reveal') return new Response('', { status: 404 })
      asked.push(await req.json())
      return Response.json(body, { status })
    },
  })
  stops.push(() => server.stop(true))
  return { port: server.port, asked }
}

const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

function boardConfig(box: Sandbox, cfg: unknown): void {
  const dir = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
}

test.skipIf(!windows)(
  'a click: Bun runs web-open.ts --pane <id>; the board showing it ends there, anything else goes to herdr',
  async () => {
    const box = await sandbox()
    // The board showed the session (exit 0): done.
    assert.deepEqual(await click(box, 'claude-pane:wP:p3G', { CLICK_EXIT: '0' }), {
      code: 0,
      calls: [['--pane', 'wP:p3G']],
      stderr: '',
    })
    // It has no such session or does not run (exit 3): on to herdr.
    assert.deepEqual(await click(box, 'claude-pane:w12:p1/', { CLICK_EXIT: '3' }), {
      code: 9,
      calls: [['--pane', 'w12:p1']],
      stderr: '',
    })
    // Not a pane id: nothing runs at all.
    assert.deepEqual(await click(box, 'claude-pane:w1:p2;calc', { CLICK_EXIT: '0' }), {
      code: 0,
      calls: [],
      stderr: '',
    })
  },
  60_000,
)

test.skipIf(!windows)(
  'a click finds Bun on PATH, else in ~\\.bun\\bin; with neither it goes to herdr',
  async () => {
    const box = await sandbox()
    const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    assert.deepEqual(await click(box, 'claude-pane:w1:p2', { PATH: system }), { code: 9, calls: [], stderr: '' })
    const bin = join(box.env.USERPROFILE as string, '.bun', 'bin')
    mkdirSync(bin, { recursive: true })
    try {
      linkSync(process.execPath, join(bin, 'bun.exe'))
    } catch {
      copyFileSync(process.execPath, join(bin, 'bun.exe'))
    }
    assert.deepEqual(await click(box, 'claude-pane:w1:p2', { PATH: system, CLICK_EXIT: '0' }), {
      code: 0,
      calls: [['--pane', 'w1:p2']],
      stderr: '',
    })
  },
  60_000,
)

test.skipIf(!windows)(
  'a click with the real web-open.ts: a board without that session, or no board, sends it to herdr',
  async () => {
    const box = await sandbox()
    const real = { REAL_WEB_OPEN: join(root, 'src', 'entrypoints', 'web-open.ts') }
    const board = standIn(404, { ok: false, error: 'The session is no longer on the board' })
    boardConfig(box, { language: 'en', port: board.port })
    assert.deepEqual(await click(box, 'claude-pane:w1:p9', real), { code: 9, calls: [['--pane', 'w1:p9']], stderr: '' })
    assert.deepEqual(board.asked, [{ pane: 'w1:p9' }])
    boardConfig(box, { language: 'en', port: await unusedPort() })
    assert.deepEqual(await click(box, 'claude-pane:w1:p9', real), { code: 9, calls: [['--pane', 'w1:p9']], stderr: '' })
  },
  60_000,
)
