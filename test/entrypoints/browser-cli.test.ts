// `board browser open` and `board browser run` (entrypoints/cli.ts), against a board of the test's
// own: the address to the session's browser with the ask, and a program run with the session's
// display and the board's xdg-open, so what it opens (a CLI's browser login: SuiteCloud's
// account:setup runs `xdg-open <address>`) reaches `board browser open`. A board on a PC: neither
// asks anything of a board, as `board browser ask` does not.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

const LOGIN =
  'https://system.netsuite.com/app/login/oauth2/authorize.nl?scope=restlets&redirect_uri=http%3A%2F%2F127.0.0.1%3A52300%2Fsuitecloud-auth&response_type=code&state=0357efc8'
const ASK = 'Войди в NetSuite: bb-success-platform-dev'

interface Call {
  path: string
  body: Record<string, unknown>
}

/** A board answering the agent's browser calls as a running one does, and what it was asked. */
async function fakeBoard(): Promise<{ port: number; calls: Call[]; close: () => Promise<void> }> {
  const calls: Call[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => {
      raw += c
    })
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      calls.push({ path: req.url ?? '', body })
      const answer =
        req.url === '/api/browser/display'
          ? { ok: true, display: 104, xauthority: '/state/desktop/sessions/104/Xauthority' }
          : req.url === '/api/browser/open'
            ? { ok: true, asked: typeof body.text === 'string' }
            : { ok: true, control: 'agent', asks: false }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(answer))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    calls,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

function config(box: Sandbox, extra: Record<string, unknown>): void {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', port: 9, ...extra }))
}

const SERVER = { serverMode: { domain: 'board.example.com', socket: '/run/agent-board/board.sock' } }

/** The board command in an agent's session (HERDR_PANE_ID), with sh and the system's tools on PATH. */
function cli(
  box: Sandbox,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, [join(root, 'src/entrypoints/cli.ts'), ...args], {
      cwd: root,
      env: { ...box.env, PATH: `${box.env.PATH}:/usr/bin:/bin`, HERDR_PANE_ID: 'w0:p1', ...env },
    })
    let out = ''
    proc.stdout.on('data', c => {
      out += c
    })
    proc.stderr.on('data', c => {
      out += c
    })
    proc.on('close', code => resolve({ code, out: out.trim() }))
  })
}

test('board browser open: the address to the session’s browser, with the ask when given; no address, an empty ask: the usage, nothing asked', async () => {
  const box = await sandbox()
  const board = await fakeBoard()
  try {
    config(box, { ...SERVER, port: board.port })
    const plain = await cli(box, ['browser', 'open', LOGIN])
    expect(plain).toEqual({ code: 0, out: 'ok · opened in your browser, in a tab of its own' })
    const asked = await cli(box, ['browser', 'open', LOGIN, '--ask', ASK])
    expect(asked.code).toBe(0)
    expect(asked.out).toStartWith('ok · opened in your browser and asked: your card is under "Needs me"')
    expect(board.calls).toEqual([
      { path: '/api/browser/open', body: { pane: 'w0:p1', url: LOGIN } },
      { path: '/api/browser/open', body: { pane: 'w0:p1', url: LOGIN, text: ASK } },
    ])
    for (const args of [
      ['browser', 'open'],
      ['browser', 'open', LOGIN, '--ask'],
    ]) {
      const r = await cli(box, args)
      expect(r.code).toBe(1)
      expect(r.out).toContain('usage: board browser')
    }
    expect(board.calls).toHaveLength(2)
  } finally {
    await board.close()
  }
})

test('board browser run: the program with the session’s display, its arguments as they came; what it opens with xdg-open (or BROWSER) goes to `board browser open` with the ask; its exit code; its opener gone after', async () => {
  const box = await sandbox()
  const board = await fakeBoard()
  try {
    config(box, { ...SERVER, port: board.port })
    // as SuiteCloud's Java SDK does: `xdg-open <address>` from the PATH, then on with its work
    const script = `printf '%s|%s|%s\\n' "$DISPLAY" "$XAUTHORITY" "$(basename "$BROWSER")"; printf '[%s]' "$@"; echo; xdg-open '${LOGIN}' && "$BROWSER" https://example.com/ && exit 3`
    const r = await cli(box, [
      'browser',
      'run',
      '--ask',
      ASK,
      '--',
      'sh',
      '-c',
      script,
      'sh',
      '--session',
      's9',
      '--name',
      'x',
      '--idle',
    ])
    expect(r.code).toBe(3)
    expect(r.out).toContain(':104|/state/desktop/sessions/104/Xauthority|xdg-open')
    // the board's own flags left in the program's arguments
    expect(r.out).toContain('[--session][s9][--name][x][--idle]')
    expect(board.calls.map(c => c.path)).toEqual(['/api/browser/display', '/api/browser/open', '/api/browser/open'])
    expect(board.calls[0]?.body).toEqual({ pane: 'w0:p1' })
    expect(board.calls[1]?.body).toEqual({ pane: 'w0:p1', url: LOGIN, text: ASK })
    expect(board.calls[2]?.body).toEqual({ pane: 'w0:p1', url: 'https://example.com/', text: ASK })
    const runDir = join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/desktop/run')
    expect(existsSync(runDir) ? readdirSync(runDir) : []).toEqual([])
    // no --ask: what it opens is opened, nothing asked; no `--`: the program all the same
    board.calls.length = 0
    const quiet = await cli(box, ['browser', 'run', 'sh', '-c', `xdg-open '${LOGIN}'`])
    expect(quiet.code).toBe(0)
    expect(board.calls.map(c => c.body)).toEqual([{ pane: 'w0:p1' }, { pane: 'w0:p1', url: LOGIN }])
    // no program: the usage, and the browser not started for nothing
    board.calls.length = 0
    const none = await cli(box, ['browser', 'run', '--'])
    expect(none.code).toBe(1)
    expect(none.out).toContain('usage: board browser')
    expect(board.calls).toEqual([])
  } finally {
    await board.close()
  }
})

test('a board on a PC (no serverMode), or outside a session: board browser open and run ask nothing of any board, as board browser ask does not', async () => {
  const box = await sandbox()
  const board = await fakeBoard()
  try {
    config(box, { port: board.port })
    for (const args of [
      ['browser', 'open', LOGIN, '--ask', ASK],
      ['browser', 'run', '--', 'sh', '-c', 'echo ran'],
      ['browser', 'ask', ASK],
    ]) {
      const r = await cli(box, args)
      expect(r).toEqual({
        code: 1,
        out: "board: board browser: the agents' browsers are on the board's own server only",
      })
    }
    config(box, { ...SERVER, port: board.port })
    const outside = await cli(box, ['browser', 'open', LOGIN], { HERDR_PANE_ID: '' })
    expect(outside).toEqual({ code: 1, out: 'board: board browser: run it in your session (no HERDR_PANE_ID)' })
    expect(board.calls).toEqual([])
  } finally {
    await board.close()
  }
})
