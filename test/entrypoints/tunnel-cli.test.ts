// `board tunnel [on | off | test]` and the tunnel's part of `board doctor` (entrypoints/cli.ts,
// services/tunnel-facts.ts), run as an agent runs them, in a sandbox. ssh and ssh-keygen are the
// fake (test/support/fake-ssh.ts), which also stands in for Caddy when a board runs the tunnel.
// config.json always names the web port: a port of the board a test starts, or 9 where no board
// should answer.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isAccessView } from '../../src/core/access.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { TunnelStatus } from '../../src/core/tunnel.ts'
import { serveBoard, unusedPort } from '../support/board-server.ts'
import { fakeSshBin } from '../support/fake-ssh-bin.ts'
import { type ChildResult, type Sandbox, sandbox } from '../support/sandbox.ts'
import { DOMAIN, seedAccess, stateFolder } from '../support/tunnel-board.ts'

const en = translator('en')
/** Tunnel settings that check out. */
const FIELDS = { host: 'ssh.example.com', user: 'boardtunnel', domain: DOMAIN }
const OFF_LINE = 'tunnel off · Settings → Remote access… on the web board sets it up'
const NO_BOARD = 'the board does not run: open it first (herdr plugin action invoke agent-board.open)'

const configPath = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')

/** config.json as written by hand: English, no herdr-wake, the web port 9 (no board) unless given. */
function writeConfig(box: Sandbox, value: Record<string, unknown>): void {
  const path = configPath(box)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ language: 'en', wakeUrl: '', port: 9, ...value }, null, 2))
}

const tunnelOf = (box: Sandbox): Record<string, unknown> =>
  (JSON.parse(readFileSync(configPath(box), 'utf8')) as { tunnel?: Record<string, unknown> }).tunnel ?? {}

/** The fake as both programs, its state and its log in the sandbox. */
async function fakeEnv(box: Sandbox, state: unknown = {}): Promise<Record<string, string>> {
  const bin = await fakeSshBin()
  const stateFile = join(box.dir, 'ssh-state.json')
  writeFileSync(stateFile, JSON.stringify(state))
  return {
    BOARD_SSH_BIN_PATH: bin,
    BOARD_SSH_KEYGEN_BIN_PATH: bin,
    FAKE_SSH_STATE: stateFile,
    FAKE_SSH_LOG: join(box.dir, 'ssh-calls.jsonl'),
  }
}

/** The ssh the fake ran (an argument list with -R); ssh-keygen's calls left out. */
function sshCalls(box: Sandbox): string[][] {
  const log = join(box.dir, 'ssh-calls.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as string[])
    .filter(args => args.includes('-R'))
}

/** The tunnel's state as the board at `url` says it, once `want` holds for it (within 30 s). */
async function statusWhen(url: string, want: (s: TunnelStatus) => boolean): Promise<TunnelStatus> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const v: unknown = await (await fetch(`${url}/api/access`)).json()
    const status = isAccessView(v) ? v.tunnel.status : null
    if (status && want(status)) return status
    if (Date.now() > deadline) throw new Error(`the tunnel never got there: ${JSON.stringify(status)}`)
    await Bun.sleep(50)
  }
}

/** `board <args>` with the sandbox's env and `env` on top. */
const board = (box: Sandbox, args: string[], env: Record<string, string> = {}): Promise<ChildResult> =>
  box.run('cli', { args, env }).exited

describe('board tunnel without a board running', () => {
  test('nothing set up: off, and where to set it up', async () => {
    const box = await sandbox()
    writeConfig(box, {})
    const r = await board(box, ['tunnel'])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`${OFF_LINE}\n`)
  }, 30_000)

  test('on refuses settings that do not check out, with the first one’s reason', async () => {
    const box = await sandbox()
    writeConfig(box, {})
    const r = await board(box, ['tunnel', 'on'])
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('board: Server: needed\n')
    expect(tunnelOf(box).on).toBeUndefined()
  }, 30_000)

  test('values written by hand that would reach ssh as options: refused with the reason, no ssh run', async () => {
    const box = await sandbox()
    await seedAccess(box)
    const env = await fakeEnv(box)
    const cases: [Record<string, unknown>, string][] = [
      [{ host: '-oProxyCommand=calc' }, en('tunnel.err.host')],
      [{ user: '-l' }, en('tunnel.err.user')],
      [{ socket: '/tmp/board.sock' }, en('tunnel.err.socketShared', { folder: '/tmp' })],
      [{ socket: '/a:b' }, en('tunnel.err.socket')],
    ]
    for (const [fields, message] of cases) {
      writeConfig(box, { tunnel: { ...FIELDS, ...fields } })
      const r = await board(box, ['tunnel', 'on'], env)
      expect(r.code).toBe(1)
      expect(r.stderr).toBe(`board: ${message}\n`)
      expect(tunnelOf(box).on).toBeUndefined()
    }
    expect(sshCalls(box)).toEqual([])
  }, 60_000)

  test('on refuses while the password and the code are not set up', async () => {
    const box = await sandbox()
    writeConfig(box, { tunnel: FIELDS })
    const r = await board(box, ['tunnel', 'on'])
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('board: Set up the password and the code first: Settings → Remote access… on the web board\n')
    expect(tunnelOf(box).on).toBeUndefined()
  }, 30_000)

  test('on and off edit config.json, keeping what else is there', async () => {
    const box = await sandbox()
    await seedAccess(box)
    writeConfig(box, { tunnel: { ...FIELDS, note: 'by hand' } })
    const on = await board(box, ['tunnel', 'on'])
    expect(on.stderr).toBe('')
    expect(on.code).toBe(0)
    expect(on.stdout).toBe('ok · tunnel on: the board opens it in a few seconds; `board tunnel` says how it stands\n')
    expect(tunnelOf(box)).toEqual({ ...FIELDS, note: 'by hand', on: true })
    // on, with no board to run it
    expect((await board(box, ['tunnel'])).stdout).toBe('tunnel on · the board does not run\n')
    const test = await board(box, ['tunnel', 'test'])
    expect(test.code).toBe(1)
    expect(test.stderr).toBe(`board: ${NO_BOARD}\n`)
    const off = await board(box, ['tunnel', 'off'])
    expect(off.code).toBe(0)
    expect(off.stdout).toBe('ok · tunnel off\n')
    expect(tunnelOf(box)).toEqual({ ...FIELDS, note: 'by hand', on: false })
    expect((await board(box, ['tunnel'])).stdout).toBe(`${OFF_LINE}\n`)
  }, 60_000)

  test('anything else: the usage', async () => {
    const box = await sandbox()
    writeConfig(box, {})
    const r = await board(box, ['tunnel', 'sideways'])
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('board: usage: board tunnel [on | off | test]\n')
  }, 30_000)
})

describe('board doctor and the tunnel', () => {
  test('off: nothing about the tunnel, and nothing asked of ssh', async () => {
    const box = await sandbox()
    const env = await fakeEnv(box)
    writeConfig(box, { tunnel: FIELDS })
    const r = await board(box, ['doctor'], env)
    expect(r.code).toBe(0)
    expect(r.stdout).not.toMatch(/tunnel/i)
    expect(existsSync(env.FAKE_SSH_LOG as string)).toBe(false)
  }, 30_000)

  test('on, with a server written by hand that ssh would read as an option: the settings check names it, no ssh run', async () => {
    const box = await sandbox()
    await seedAccess(box)
    const env = await fakeEnv(box)
    writeConfig(box, { tunnel: { ...FIELDS, host: '-oProxyCommand=calc', on: true } })
    const r = await board(box, ['doctor'], env)
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^!! The tunnel's settings do not check out$/m)
    expect(r.stdout).toContain(`\n     ${en('tunnel.err.host')}\n`)
    expect(sshCalls(box)).toEqual([])
  }, 30_000)

  test('on, and no board running: the state is a warning', async () => {
    const box = await sandbox()
    await seedAccess(box)
    writeConfig(box, { tunnel: { ...FIELDS, on: true } })
    const r = await board(box, ['doctor'], await fakeEnv(box))
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^ok The tunnel's settings$/m)
    expect(r.stdout).toMatch(/^ok Password and code for the domain$/m)
    expect(r.stdout).toContain(`\n!  ${en('tunnel.check.noBoard')}\n`)
  }, 30_000)
})

/**
 * A board (serveBoard, reading config.json as it changes) with the tunnel on, the login set up and
 * the board's own key there, the fake as ssh in `mode`; its probe through the domain goes to the
 * fake's Caddy, or to a port where nothing listens (`probeAnswers` false). Its tunnel's state once
 * it is `want`.
 */
async function startBoard(
  box: Sandbox,
  o: { mode?: 'forward' | 'publickey'; probeAnswers?: boolean; login?: boolean; want: (s: TunnelStatus) => boolean },
): Promise<{ env: Record<string, string>; status: TunnelStatus }> {
  if (o.login !== false) await seedAccess(box)
  // the board's own key, as Generate key leaves it (the fake ssh-keygen reads it)
  mkdirSync(join(stateFolder(box), 'tunnel'), { recursive: true })
  writeFileSync(join(stateFolder(box), 'tunnel', 'id_ed25519'), 'fake key\n')
  const web = await unusedPort()
  let tunnelPort = await unusedPort()
  while (tunnelPort === web || tunnelPort === web + 1) tunnelPort = await unusedPort()
  const proxy = await unusedPort()
  const cfg = {
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    wakeUrl: null,
    refreshSec: 3600,
    port: web,
    tunnel: { ...FIELDS, on: true, port: tunnelPort },
  }
  writeConfig(box, cfg)
  const env = await fakeEnv(box, { ssh: { mode: o.mode ?? 'forward', proxyPort: proxy, domain: DOMAIN } })
  const probe = o.probeAnswers === false ? await unusedPort() : proxy
  await serveBoard(box, cfg, {
    ...env,
    BOARD_TUNNEL_PROBE_ORIGIN: `http://127.0.0.1:${probe}`,
    TEST_LIVE_CONFIG: '1',
  })
  return { env, status: await statusWhen(`http://127.0.0.1:${web}`, o.want) }
}

describe('board tunnel with the board running the tunnel', () => {
  test('on in config.json written by hand, the login not set up: not started, and why', async () => {
    const box = await sandbox()
    const { env } = await startBoard(box, { login: false, want: s => s.state === 'off' })

    const status = await board(box, ['tunnel'])
    expect(status.code).toBe(0)
    expect(status.stdout).toMatch(/^tunnel off since \d\d:\d\d · https:\/\/board\.example\.com$/m)
    expect(status.stdout).toContain(
      '\nnot started: Set up the password and the code first: Settings → Remote access… on the web board\n',
    )

    const doctor = await board(box, ['doctor'], env)
    expect(doctor.stdout).toMatch(/^!! Password and code for the domain are not set up$/m)
    expect(doctor.stdout).toContain(`\n!  ${en('tunnel.check.off')}\n     ${en('tunnel.check.offFix')}\n`)
    expect(sshCalls(box)).toEqual([])
  }, 90_000)

  test('the state since when, the domain, the socket and the ssh; test passes its three steps', async () => {
    const box = await sandbox()
    const { env } = await startBoard(box, { want: s => s.state === 'connected' })

    const status = await board(box, ['tunnel'])
    expect(status.code).toBe(0)
    expect(status.stdout).toMatch(/^tunnel connected since \d\d:\d\d · https:\/\/board\.example\.com$/m)
    expect(status.stdout).toContain(`\nsocket /var/lib/boardtunnel/board.sock · ssh ${env.BOARD_SSH_BIN_PATH}\n`)

    const test = await board(box, ['tunnel', 'test'])
    expect(test.stderr).toBe('')
    expect(test.code).toBe(0)
    const lines = test.stdout.trimEnd().split('\n')
    expect(lines.map(line => line.slice(0, 2))).toEqual(['✓ ', '✓ ', '✓ '])
    expect(lines[0]).toStartWith('✓ ssh and the key')
    expect(lines[1]).toStartWith('✓ the server takes the forward')
    expect(lines[2]).toStartWith('✓ through https://board.example.com')
  }, 90_000)

  test('a key the server refuses: the error and its fix; test fails at the forward and leaves the domain', async () => {
    const box = await sandbox()
    const refused = 'boardtunnel@ssh.example.com: Permission denied (publickey).'
    const { env, status: s } = await startBoard(box, { mode: 'publickey', want: x => x.state === 'error' })
    expect(s.hint).toBe('publickey')

    const status = await board(box, ['tunnel'])
    expect(status.code).toBe(0)
    expect(status.stdout).toMatch(/^tunnel error since \d\d:\d\d · https:\/\/board\.example\.com$/m)
    expect(status.stdout).toContain(`\nerror: ${refused}\nfix: ${en('tunnel.hint.publickey')}\n`)

    const test = await board(box, ['tunnel', 'test'])
    expect(test.code).toBe(1)
    const lines = test.stdout.trimEnd().split('\n')
    expect(lines[0]).toStartWith('✓ ssh and the key')
    expect(lines.slice(1)).toEqual([
      `✗ the server takes the forward: ${refused}`,
      `  ${en('tunnel.hint.publickey')}`,
      '– through https://board.example.com',
    ])

    const doctor = await board(box, ['doctor'], env)
    expect(doctor.stdout).toContain(
      `\n!! ${en('tunnel.check.error')}\n     ${refused}\n     ${en('tunnel.hint.publickey')}\n`,
    )
  }, 90_000)

  test('a probe through the domain that did not reach the board: a warning in board tunnel and board doctor', async () => {
    const box = await sandbox()
    const { env, status: s } = await startBoard(box, {
      probeAnswers: false,
      want: x => x.state === 'connected' && !!x.probe,
    })
    expect(s.probe?.ok).toBe(false)
    const detail = s.probe?.detail ?? ''
    expect(detail).not.toBe('')

    const status = await board(box, ['tunnel'])
    expect(status.stdout).toMatch(/^tunnel connected since \d\d:\d\d · https:\/\/board\.example\.com$/m)
    expect(status.stdout).toContain(`\nwarning: the domain did not reach this board: ${detail}\n`)

    const doctor = await board(box, ['doctor'], env)
    expect(doctor.stdout).toMatch(/^ok The tunnel is connected$/m)
    expect(doctor.stdout).toContain(`\n!  ${en('tunnel.check.probeBad')}\n     ${detail}\n`)
  }, 90_000)
})
