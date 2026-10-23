// The admin connection's ssh (adapters/ssh.ts spawnRemote): stdout and stderr read line by line,
// stdin written once and closed (the sudo password) or closed at once, no shell, a deadline; the
// login's password through the board's askpass (openAskpass and entrypoints/askpass.ts). ssh is
// the fake (test/support/fake-ssh.ts), which answers the admin's line as a server would.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openAskpass, spawnRemote, sshVersion } from '../../src/adapters/ssh.ts'
import { adminSshArgs, remoteCommand } from '../../src/core/server-admin.ts'
import type { SudoMode } from '../../src/core/server-view.ts'
import { tunnelConfig } from '../../src/core/tunnel.ts'
import { useFakeSsh } from '../support/fake-ssh-bin.ts'

/** The fake's server key, as Test connection pinned it. */
const HOST_LINE = 'ssh.example.com ssh-ed25519 AAAAFAKEHOST'

async function useAdmin(state: Record<string, unknown>, top: Record<string, unknown> = {}) {
  const fake = await useFakeSsh()
  const knownHosts = join(fake.dir, 'known_hosts')
  writeFileSync(knownHosts, `${HOST_LINE}\n`)
  const fixture = join(fake.dir, 'fixture')
  mkdirSync(fixture)
  writeFileSync(join(fixture, 'round1.txt'), 'one\ntwo\nthree\n')
  fake.state({ ...top, admin: { fixture, ...state } })
  const conf = tunnelConfig({ host: 'ssh.example.com', user: 'boardtunnel', domain: 'board.example.com' })
  const lines = (file: string): unknown[] =>
    existsSync(file)
      ? readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l) as unknown)
      : []
  return {
    fake,
    args: (kind: string, mode: SudoMode, password = false): string[] =>
      adminSshArgs({
        conf,
        admin: { user: 'admin', key: '' },
        knownHosts,
        command: remoteCommand(`exec </dev/null\n# agent-board: ${kind}\n`, mode),
        password,
      }),
    stdins: (): string[] => lines(join(fake.dir, 'ssh-calls.jsonl.stdin')) as string[],
    prompts: (): string[] => lines(join(fake.dir, 'ssh-calls.jsonl.askpass')) as string[],
    leads: (): unknown[] => lines(join(fake.dir, 'ssh-calls.jsonl.env')),
  }
}

/** Every line the run gave, with the stream it came on, and how it ended. */
async function collect(run: ReturnType<typeof spawnRemote>) {
  const lines: [string, string][] = []
  run.onLine((line, from) => lines.push([line, from ?? '']))
  const end = await run.done
  return { lines, end }
}

describe('spawnRemote', () => {
  test('stdin written once, then closed: sudo -S reads the password there', async () => {
    const a = await useAdmin({ sudo: 'password', password: 'pw' })
    const { lines, end } = await collect(spawnRemote(a.fake.bin, a.args('look-1', 'password'), 'pw\n', 10_000))
    expect(end).toEqual({ code: 0, error: null })
    expect(a.stdins()).toEqual(['pw\n'])
    expect(lines.filter(([, from]) => from === 'out').map(([l]) => l)).toEqual(['one', 'two', 'three'])
  })

  test('null: stdin closed at once (the fake reads to its end before it answers)', async () => {
    const a = await useAdmin({ sudo: 'nopasswd' })
    const started = Date.now()
    const { lines, end } = await collect(spawnRemote(a.fake.bin, a.args('look-1', 'nopasswd'), null, 10_000))
    expect(end).toEqual({ code: 0, error: null })
    expect(Date.now() - started).toBeLessThan(8000)
    expect(lines.map(([l]) => l)).toEqual(['one', 'two', 'three'])
    expect(a.stdins()).toEqual([])
  })

  test('the lines as they come, one by one; stderr told from stdout', async () => {
    const run = ['@@step 1 start', 'pulling', '@@step 1 ok', '@@result applied', '@@exit 0']
    const a = await useAdmin({ sudo: 'password', password: 'pw', flavor: 'sudo-rs', run: { lines: run } })
    const { lines, end } = await collect(spawnRemote(a.fake.bin, a.args('launch', 'password'), 'pw\n', 10_000))
    expect(end.code).toBe(0)
    expect(lines.filter(([, from]) => from === 'out').map(([l]) => l)).toEqual(run)
    // sudo-rs prints an empty line on stderr when the password is right; an empty line is no line
    expect(lines.filter(([, from]) => from === 'err')).toEqual([])
  })

  test('sudo’s own lines come on stderr', async () => {
    const a = await useAdmin({ sudo: 'password', password: 'pw' })
    const { lines, end } = await collect(spawnRemote(a.fake.bin, a.args('look-1', 'password'), 'nope\n', 10_000))
    expect(end.code).toBe(1)
    expect(lines).toEqual([
      ['Sorry, try again.', 'err'],
      ['sudo: no password was provided', 'err'],
      ['sudo: 1 incorrect password attempt', 'err'],
    ])
  })

  test('past its deadline it is killed, and done says so', async () => {
    const a = await useAdmin({ sudo: 'nopasswd' })
    const started = Date.now()
    const { end } = await collect(spawnRemote(a.fake.bin, a.args('hang', 'nopasswd'), null, 300))
    expect(end.error).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test('no shell: -T, and the remote command as one argument', async () => {
    const a = await useAdmin({ uid: 0 })
    const args = a.args('look-1', 'root')
    await collect(spawnRemote(a.fake.bin, args, null, 10_000))
    const [call] = a.fake.calls()
    expect(call).toEqual(args)
    expect(call).toContain('-T')
    expect(call?.at(-1)).toBe(remoteCommand('exec </dev/null\n# agent-board: look-1\n', 'root'))
  })

  test('a program that is not there: done with its error, no line', async () => {
    const a = await useAdmin({})
    const { lines, end } = await collect(spawnRemote(join(a.fake.dir, 'no-ssh.exe'), ['x'], null, 10_000))
    expect(end.code).toBeNull()
    expect(end.error).toBe('ENOENT')
    expect(lines).toEqual([])
  })
})

/** The askpass helper as ssh runs it: SSH_ASKPASS with the prompt as its one argument, in ssh's environment. */
async function helper(env: Record<string, string>, prompt: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn([env.SSH_ASKPASS ?? '', prompt], {
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  return { code, out }
}

describe('the askpass: the board answers its helper on loopback, one-time token', () => {
  const PASSWORD = `S3cr3t%$'"\`Ж -e x`

  test('the password once, for a password prompt; a passphrase gets none (ssh skips the key); the rest ends ssh', async () => {
    let refusals = 0
    const a = openAskpass(PASSWORD, () => refusals++)
    try {
      expect(a.env).toMatchObject({
        SSH_ASKPASS: process.execPath,
        SSH_ASKPASS_REQUIRE: 'force',
        BUN_OPTIONS: '-e import(process.env.BOARD_ASKPASS_MAIN) --',
      })
      expect(JSON.stringify(a.env)).not.toContain('S3cr3t')
      expect(await helper(a.env, "Enter passphrase for key 'C:/Users/me/.ssh/id_ed25519': ")).toEqual({
        code: 1,
        out: '',
      })
      expect(await helper(a.env, "admin@ssh.example.com's password: ")).toEqual({ code: 0, out: `${PASSWORD}\n` })
      expect(a.report()).toEqual({ answered: 1, refused: null })
      expect(refusals).toBe(0)
      // asked again: no second try; ssh is ended (here: the channel closes) before the helper answers anything
      const again = helper(a.env, "admin@ssh.example.com's password: ")
      await Bun.sleep(1000)
      expect(refusals).toBe(1)
      a.close()
      expect(await again).toEqual({ code: 1, out: '' })
      expect(a.report()).toEqual({ answered: 1, refused: "admin@ssh.example.com's password: " })
    } finally {
      a.close()
    }
  })

  test('a one-time code, or a prompt made to look like an option of Bun’s: never answered, never run', async () => {
    let refusals = 0
    const a = openAskpass(PASSWORD, () => refusals++)
    try {
      const evil = helper(a.env, '--eval=console.log("ran")')
      await Bun.sleep(1000)
      a.close()
      expect(await evil).toEqual({ code: 1, out: '' })
      expect(a.report()).toEqual({ answered: 0, refused: '--eval=console.log("ran")' })
      expect(refusals).toBe(1)
    } finally {
      a.close()
    }
  })

  test('a helper without the token gets nothing, and the password is still there for ssh’s own', async () => {
    const a = openAskpass(PASSWORD, () => {})
    try {
      const wrong = { ...a.env, BOARD_ASKPASS_TOKEN: 'f'.repeat(64) }
      expect(await helper(wrong, "admin@ssh.example.com's password: ")).toEqual({ code: 1, out: '' })
      expect(await helper({ ...a.env, BOARD_ASKPASS_TOKEN: '' }, "admin@ssh.example.com's password: ")).toEqual({
        code: 1,
        out: '',
      })
      expect(a.report()).toEqual({ answered: 0, refused: null })
      expect(await helper(a.env, "admin@ssh.example.com's password: ")).toEqual({ code: 0, out: `${PASSWORD}\n` })
    } finally {
      a.close()
    }
  })

  test('closed: the helper fails, nothing printed', async () => {
    const a = openAskpass(PASSWORD, () => {})
    a.close()
    expect(await helper(a.env, "admin@ssh.example.com's password: ")).toEqual({ code: 1, out: '' })
  })
})

describe('spawnRemote with the login’s password', () => {
  test('the key refused, the password taken: one prompt answered; nothing of it in ssh’s argv or environment', async () => {
    const a = await useAdmin({ sudo: 'nopasswd', publickey: true, login: { password: 'pw Ж' } })
    const run = spawnRemote(a.fake.bin, a.args('look-1', 'nopasswd', true), null, 20_000, { password: 'pw Ж' })
    const { lines, end } = await collect(run)
    expect(end).toEqual({ code: 0, error: null, askpass: { answered: 1, refused: null } })
    expect(lines.map(([l]) => l)).toEqual(['one', 'two', 'three'])
    expect(a.prompts()).toEqual(["admin@ssh.example.com's password: "])
    expect(JSON.stringify(a.fake.calls())).not.toContain('pw Ж')
    expect(JSON.stringify(a.leads())).not.toContain('pw Ж')
  })

  test('a wrong one: one try (NumberOfPasswordPrompts=1), refused', async () => {
    const a = await useAdmin({ sudo: 'nopasswd', publickey: true, login: { password: 'right' } })
    const { lines, end } = await collect(
      spawnRemote(a.fake.bin, a.args('look-1', 'nopasswd', true), null, 20_000, { password: 'wrong' }),
    )
    expect(end).toEqual({ code: 255, error: null, askpass: { answered: 1, refused: null } })
    expect(lines).toEqual([['admin@ssh.example.com: Permission denied (publickey,password).', 'err']])
    expect(a.prompts()).toHaveLength(1)
  })

  test('a one-time code: ssh ended at that prompt, no answer to it', async () => {
    const a = await useAdmin({
      sudo: 'nopasswd',
      publickey: true,
      login: { password: 'pw', kbdint: ['Password: ', 'Verification code: '] },
    })
    const started = Date.now()
    const { lines, end } = await collect(
      spawnRemote(a.fake.bin, a.args('look-1', 'nopasswd', true), null, 20_000, { password: 'pw' }),
    )
    expect(end.code).not.toBe(0)
    expect(end.askpass).toEqual({ answered: 1, refused: '(admin@ssh.example.com) Verification code: ' })
    expect(lines.filter(([, from]) => from === 'out')).toEqual([])
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  test('without a login: no askpass, ssh’s end as before', async () => {
    const a = await useAdmin({ sudo: 'nopasswd' })
    const { end } = await collect(spawnRemote(a.fake.bin, a.args('look-1', 'nopasswd'), null, 10_000))
    expect(end).toEqual({ code: 0, error: null })
    expect(a.leads()).toEqual([])
  })
})

test('ssh -V’s line (ssh says it on stderr)', async () => {
  const a = await useAdmin({}, { sshVersion: 'OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024' })
  expect(await sshVersion(a.fake.bin)).toBe('OpenSSH_9.6p1 Ubuntu-3ubuntu13.5, OpenSSL 3.0.13 30 Jan 2024')
})
