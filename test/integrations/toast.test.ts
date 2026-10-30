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
// notes its pid, logs its arguments and exits with CLICK_EXIT, or hands them to the real one
// (REAL_WEB_OPEN).
const HERDR_NEXT = '        if ($LASTEXITCODE -eq 0) { exit 0 }\n    }\n'
const FAKE_WEB_OPEN = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.CLICK_PIDS ?? '', process.pid + '\\n')
appendFileSync(process.env.CLICK_LOG ?? '', JSON.stringify(process.argv.slice(2)) + '\\n')
const real = process.env.REAL_WEB_OPEN
if (real) process.exit(Bun.spawnSync([process.execPath, real, ...process.argv.slice(2)]).exitCode ?? 1)
process.exit(Number(process.env.CLICK_EXIT ?? '0'))
`

// What toast.ps1 does to herdr, the registry, windows and notifications. A click's cut runs none
// of it; its functions may hold it, as the cut only defines them. The registry key's name
// ($ProtocolKey) is just a string until an -Item command reads or writes it.
const BEYOND_THE_CUT = [
  'Invoke-Herdr',
  'Get-HerdrSnapshot',
  'HERDR_BIN_PATH',
  'Diagnostics.Process',
  '-Item', // New-Item, Get-ItemProperty, Set-ItemProperty, New-ItemProperty
  'Import-Native',
  'Add-Type',
  'Native]::',
  'Test-TerminalForeground',
  'Register-Handlers',
  'Show-Toast',
  'Windows.UI.Notifications',
]

/**
 * The lines of a PowerShell script that run: all but its functions' bodies, which it only defines.
 * toast.ps1's functions open with `function Name … {` and close with `}` alone at the start of a
 * line. Any other line at the start (outside a here-string) ends a function too, so a layout this
 * misreads shows more as running, never less.
 */
function outsideFunctions(script: string): string {
  const runs: string[] = []
  let inFunction = false
  let hereEnd = '' // what starts the line that closes the here-string we are in: '@ or "@
  for (const line of script.split('\n')) {
    if (hereEnd) {
      if (line.startsWith(hereEnd)) hereEnd = ''
      if (!inFunction) runs.push(line)
      continue
    }
    if (/(^|[\s=(])@['"]$/.test(line)) hereEnd = `${line.at(-1)}@`
    if (inFunction && line === '}') inFunction = false
    else if (!inFunction || (line !== '' && !/^\s/.test(line))) {
      inFunction = /^function [\w-]+.*\{$/.test(line)
      if (!inFunction) runs.push(line)
    }
  }
  return runs.join('\n')
}

/** The words of BEYOND_THE_CUT in the lines of `script` that run. */
function unsafeIn(script: string): string[] {
  const runs = outsideFunctions(script)
  return BEYOND_THE_CUT.filter(word => runs.includes(word))
}

function clickPart(): string {
  const text = readFileSync(script, 'utf8').replace(/\r\n/g, '\n')
  const at = text.indexOf(HERDR_NEXT)
  assert.ok(at > text.indexOf('if ($Action -eq "open") {'), 'the web board comes before herdr')
  const cut = `${text.slice(0, at + HERDR_NEXT.length)}    exit 9\n}\n`
  // Before anything runs: an edit that moves herdr's turn above the cut stops here.
  assert.deepEqual(unsafeIn(cut), [], 'a click’s cut runs nothing of herdr, the registry, windows or notifications')
  return cut
}

test('toast.ps1: a click’s cut runs nothing of herdr, the registry, windows or notifications', () => {
  const text = readFileSync(script, 'utf8').replace(/\r\n/g, '\n')
  // The guard's words are the script's own, so a rename cannot leave it looking for nothing.
  const unknown = BEYOND_THE_CUT.filter(word => !text.includes(word))
  assert.deepEqual(unknown, [])
  // Below the cut the script runs them: herdr's turn reads the registry, focuses the pane and
  // raises the terminal; a hook shows the toast.
  const below = unsafeIn(text)
  const unseen = ['-Item', 'Invoke-Herdr', 'Native]::', 'Show-Toast'].filter(word => !below.includes(word))
  assert.deepEqual(unseen, [])
  // The cut runs none of them, and does run the board call.
  const cut = clickPart()
  assert.deepEqual(unsafeIn(cut), [])
  assert.ok(outsideFunctions(cut).includes('& $bun $boardOpen --pane $paneId'))
})

// What a test leaves running (its stand-ins, a click) ends after it, before its sandbox goes.
const stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

// A click that has not ended by then is ended, with all it started.
const CLICK_TIMEOUT = 15_000
const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')

/** Ends process `pid`, if it still is `image`, and every process under it. */
function killTree(pid: number, image: string): void {
  Bun.spawnSync([taskkill, '/T', '/F', '/FI', `IMAGENAME eq ${image}`, '/PID', String(pid)], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
}

async function click(box: Sandbox, uri: string, env: Record<string, string> = {}) {
  const board = join(box.dir, 'board')
  mkdirSync(join(board, 'src', 'integrations'), { recursive: true })
  mkdirSync(join(board, 'src', 'entrypoints'), { recursive: true })
  const copy = join(board, 'src', 'integrations', 'toast.ps1')
  writeFileSync(copy, clickPart())
  writeFileSync(join(board, 'src', 'entrypoints', 'web-open.ts'), FAKE_WEB_OPEN)
  const log = join(box.dir, 'clicks.jsonl')
  const pids = join(box.dir, 'click-pids')
  writeFileSync(log, '')
  writeFileSync(pids, '')
  // PATHEXT, which a click's own environment has: without it PowerShell takes bun.exe for a document.
  const pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  const proc = Bun.spawn([powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', copy, 'open', uri], {
    env: { ...box.env, PATHEXT: pathext, CLICK_LOG: log, CLICK_PIDS: pids, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // Ends a click still running: PowerShell, and the web-open.ts it runs with the real one under it.
  // A test that times out has PowerShell ended by Bun, which leaves its tree; the fake's pid finds it.
  let ended = false
  const end = (): void => {
    if (ended) return
    killTree(proc.pid, 'powershell.exe')
    for (const pid of readFileSync(pids, 'utf8').split('\n').filter(Boolean)) killTree(Number(pid), 'bun.exe')
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    end()
  }, CLICK_TIMEOUT)
  stops.push(() => {
    clearTimeout(timer)
    end()
  })
  const [, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  ended = true
  clearTimeout(timer)
  assert.ok(!timedOut, `the click had not ended after ${CLICK_TIMEOUT / 1000} s`)
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

// On a call (#276): the toast goes to the notification center without popping up. Test-OnCall
// runs on its own here against a state folder in a sandbox; the toast itself is never shown.
const onCallPart = (): string => {
  const text = readFileSync(script, 'utf8').replace(/\r\n/g, '\n')
  const fn = /^function Test-OnCall \{\n[\s\S]*?\n\}$/m.exec(text)?.[0]
  assert.ok(fn)
  return fn
}

test('toast.ps1: quiet only while the board has the user on a call', () => {
  const text = readFileSync(script, 'utf8')
  assert.ok(text.includes('if ($Quiet) { $toast.SuppressPopup = $true }'))
  assert.ok(text.includes('Show-Toast $title $body $attribution $env:HERDR_PANE_ID (Test-OnCall)'))
  assert.equal(text.match(/SuppressPopup/g)?.length, 1)
  assert.deepEqual(unsafeIn(onCallPart()), [])
})

test.skipIf(!windows)(
  'toast.ps1: Test-OnCall reads the board’s presence.json, no file or another state is no call',
  async () => {
    const box: Sandbox = await sandbox()
    const local = join(box.dir, 'local')
    const roaming = join(box.dir, 'roaming')
    const dir = join(local, 'herdr', 'plugins', 'agent-board')
    const configDir = join(roaming, 'herdr', 'plugins', 'config', 'agent-board')
    const ask = (env: Record<string, string> = {}) =>
      Bun.spawnSync([powershell, '-NoProfile', '-Command', `${onCallPart()}\nTest-OnCall`], {
        env: { ...process.env, LOCALAPPDATA: local, APPDATA: roaming, ...env },
      })
        .stdout.toString()
        .trim()
    assert.equal(ask(), 'False')
    mkdirSync(dir, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ language: 'en', presence: { mode: 'auto' } }))
    for (const [content, want] of [
      ['{"state":"call","since":1,"by":"auto","before":"here"}', 'True'],
      ['{"state":"here","since":1,"by":"auto"}', 'False'],
      ['{"state":"away","since":1,"by":"user"}', 'False'],
      ['not json', 'False'],
    ] as const) {
      writeFileSync(join(dir, 'presence.json'), content)
      assert.equal(ask(), want, content)
    }
    writeFileSync(join(dir, 'presence.json'), '{"state":"call","since":1,"by":"auto"}')
    assert.equal(ask({ LOCALAPPDATA: '' }), 'False')
    // Presence as config.json has it: `true` or a section is on; anything else, or none, is off.
    for (const [presence, want] of [
      [true, 'True'],
      [{}, 'True'],
      [false, 'False'],
      [1, 'False'],
      ['yes', 'False'],
      [[], 'False'],
      [null, 'False'],
    ] as const) {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({ presence }))
      assert.equal(ask(), want, JSON.stringify(presence))
    }
    writeFileSync(join(configDir, 'config.json'), '{"language":"en"}')
    assert.equal(ask(), 'False')
  },
  30_000,
)
