// The install's own pieces that run without a server (services/server-install.ts): versions
// compared, and the board's code written over its checkout in place (a pack, or a ref over a
// pack's checkout): what changed overwritten, what is gone removed, its packages and git kept.
// What runs as the board's user runs in a session of its own, and what goes into its home (its
// ssh keys, herdr's service) is written by the user's own script.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atLeast, keysScript, syncInto, userArgv, userFileScript, userReadScript } from '../../src/services/server-install.ts'

test('a version at least another', () => {
  expect(atLeast('1.4.3', '1.4.3')).toBe(true)
  expect(atLeast('1.5.0', '1.4.3')).toBe(true)
  expect(atLeast('1.10.0', '1.9.9')).toBe(true)
  expect(atLeast('1.4.2', '1.4.3')).toBe(false)
  expect(atLeast('0.9.5', '0.9.2')).toBe(true)
  expect(atLeast('', '0.9.2')).toBe(false)
})

test('the code written over the checkout in place: changed, added, gone; node_modules and .git kept', () => {
  const sh = Bun.which('sh')
  if (!sh) return
  const dir = mkdtempSync(join(tmpdir(), 'sync-into-'))
  try {
    const to = join(dir, 'agent-board')
    const from = join(dir, 'agent-board.new')
    const put = (path: string, text: string): void => {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, text)
    }
    put(join(to, 'src', 'a.ts'), 'old a')
    put(join(to, 'src', 'gone.ts'), 'gone')
    put(join(to, 'node_modules', 'react', 'index.js'), 'react')
    put(join(to, '.git', 'HEAD'), 'ref')
    put(join(from, 'src', 'a.ts'), 'new a')
    put(join(from, 'src', 'b.ts'), 'b')
    put(join(from, 'name with space.md'), 'x')
    const unix = (p: string): string => p.replaceAll('\\', '/')
    const r = Bun.spawnSync([sh, '-c', syncInto(unix(from), unix(to))], { stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    expect(readFileSync(join(to, 'src', 'a.ts'), 'utf8')).toBe('new a')
    expect(readFileSync(join(to, 'src', 'b.ts'), 'utf8')).toBe('b')
    expect(existsSync(join(to, 'name with space.md'))).toBe(true)
    expect(existsSync(join(to, 'src', 'gone.ts'))).toBe(false)
    expect(readFileSync(join(to, 'node_modules', 'react', 'index.js'), 'utf8')).toBe('react')
    expect(readFileSync(join(to, '.git', 'HEAD'), 'utf8')).toBe('ref')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('as the board’s user: in a session of its own (no terminal of root’s), runuser, the user’s environment alone', () => {
  const argv = userArgv({ name: 'agent', uid: 1001, home: '/home/agent' }, 'herdr --version')
  expect(argv.slice(0, 8)).toEqual(['setsid', '-w', 'runuser', '-u', 'agent', '--', 'env', '-i'])
  expect(argv.slice(-3)).toEqual(['sh', '-c', 'herdr --version'])
  const env = argv.slice(8, -3)
  expect(env).toContain('HOME=/home/agent')
  expect(env).toContain('USER=agent')
  expect(env).toContain('XDG_RUNTIME_DIR=/run/user/1001')
  expect(env.every(e => /^[A-Z_a-z]+=/.test(e))).toBe(true)
})

test('the keys and herdr’s service: written by the user’s own script, whole, then moved in place; 0700 and 0600, 0644', () => {
  const sh = Bun.which('sh')
  if (!sh) return
  const dir = mkdtempSync(join(tmpdir(), 'user-files-'))
  const unix = (p: string): string => p.replaceAll('\\', '/')
  const run = (script: string, stdin: string): void => {
    const r = Bun.spawnSync([sh, '-c', script], { stdin: new TextEncoder().encode(stdin), stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
  }
  try {
    const home = join(dir, 'home with space')
    mkdirSync(home)
    run(keysScript(unix(home)), 'ssh-ed25519 AAAA admin@pc\n')
    const keys = join(home, '.ssh', 'authorized_keys')
    expect(readFileSync(keys, 'utf8')).toBe('ssh-ed25519 AAAA admin@pc\n')
    // again (a second run): the new keys in place of the old, nothing left beside them
    run(keysScript(unix(home)), 'ssh-ed25519 BBBB admin@pc\n')
    expect(readFileSync(keys, 'utf8')).toBe('ssh-ed25519 BBBB admin@pc\n')
    expect(readdirSync(join(home, '.ssh'))).toEqual(['authorized_keys'])
    const unit = join(home, '.config', 'systemd', 'user', 'herdr.service')
    run(userFileScript(unix(unit), '644'), '[Unit]\n')
    expect(readFileSync(unit, 'utf8')).toBe('[Unit]\n')
    if (process.platform !== 'win32') {
      expect(statSync(join(home, '.ssh')).mode & 0o777).toBe(0o700)
      expect(statSync(keys).mode & 0o777).toBe(0o600)
      expect(statSync(unit).mode & 0o777).toBe(0o644)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file of the user’s read before it is written whole: not there is empty, there but not read fails', () => {
  const sh = Bun.which('sh')
  if (!sh) return
  const dir = mkdtempSync(join(tmpdir(), 'user-read-'))
  const unix = (p: string): string => p.replaceAll('\\', '/')
  const read = (path: string): { code: number; out: string } => {
    const r = Bun.spawnSync([sh, '-c', userReadScript(unix(path))], { stdout: 'pipe', stderr: 'pipe' })
    return { code: r.exitCode, out: r.stdout.toString() }
  }
  try {
    expect(read(join(dir, 'none.toml'))).toEqual({ code: 0, out: '' })
    writeFileSync(join(dir, 'config.toml'), '[keys]\nx = 1\n')
    expect(read(join(dir, 'config.toml'))).toEqual({ code: 0, out: '[keys]\nx = 1\n' })
    // there, but cat cannot read it (a folder in its place, as a file it may not read): a failure,
    // so the install writes nothing over a config it did not read
    mkdirSync(join(dir, 'odd.toml'))
    expect(read(join(dir, 'odd.toml')).code).not.toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
