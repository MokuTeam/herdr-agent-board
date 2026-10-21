// The admin connection's ssh (adapters/ssh.ts spawnRemote): stdout and stderr read line by line,
// stdin written once and closed (the sudo password) or closed at once, no shell, a deadline. ssh
// is the fake (test/support/fake-ssh.ts), which answers the admin's line as a server would.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnRemote } from '../../src/adapters/ssh.ts'
import { adminSshArgs, remoteCommand } from '../../src/core/server-admin.ts'
import type { SudoMode } from '../../src/core/server-view.ts'
import { tunnelConfig } from '../../src/core/tunnel.ts'
import { useFakeSsh } from '../support/fake-ssh-bin.ts'

/** The fake's server key, as Test connection pinned it. */
const HOST_LINE = 'ssh.example.com ssh-ed25519 AAAAFAKEHOST'

async function useAdmin(state: Record<string, unknown>) {
  const fake = await useFakeSsh()
  const knownHosts = join(fake.dir, 'known_hosts')
  writeFileSync(knownHosts, `${HOST_LINE}\n`)
  const fixture = join(fake.dir, 'fixture')
  mkdirSync(fixture)
  writeFileSync(join(fixture, 'round1.txt'), 'one\ntwo\nthree\n')
  fake.state({ admin: { fixture, ...state } })
  const conf = tunnelConfig({ host: 'ssh.example.com', user: 'boardtunnel', domain: 'board.example.com' })
  const stdinLog = join(fake.dir, 'ssh-calls.jsonl.stdin')
  return {
    fake,
    args: (kind: string, mode: SudoMode): string[] =>
      adminSshArgs({
        conf,
        admin: { user: 'admin', key: '' },
        knownHosts,
        command: remoteCommand(`exec </dev/null\n# agent-board: ${kind}\n`, mode),
      }),
    stdins: (): string[] =>
      existsSync(stdinLog)
        ? readFileSync(stdinLog, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(l => JSON.parse(l) as string)
        : [],
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
