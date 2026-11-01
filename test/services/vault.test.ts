// The owner's Vaultwarden as the board sees it (services/vault.ts), with a database, an environment
// file and programs of the test's own: the accounts read from its database, signups closed and its
// unit restarted once the owner's account is there (and left alone before), and the Bitwarden CLI
// run with the master password on its stdin only (never an argument or a variable), its session
// in BW_SESSION only, its own folder 0700, signing in the first time with the account's e-mail and
// server, and its answers read without any value said.
import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunResult } from '../../src/adapters/process.ts'
import { createVault, type Runner } from '../../src/services/vault.ts'

const dir = mkdtempSync(join(tmpdir(), 'vault-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const MASTER = 'correct-master-pw'
const ok = (stdout = ''): RunResult => ({ code: 0, killed: false, error: null, stdout, stderr: '' })
const failed = (stderr: string): RunResult => ({ code: 1, killed: false, error: null, stdout: '', stderr })

function folder(name: string, users: string[] | null) {
  const data = join(dir, name, 'data')
  mkdirSync(data, { recursive: true })
  if (users) {
    const db = new Database(join(data, 'db.sqlite3'))
    db.run('CREATE TABLE users (uuid TEXT, email TEXT, created_at TEXT)')
    for (const [i, e] of users.entries())
      db.run('INSERT INTO users VALUES (?, ?, ?)', [`u${i}`, e, `2026-11-0${i + 1}`])
    db.close()
  }
  const env = join(dir, name, 'vaultwarden.env')
  writeFileSync(env, 'DOMAIN=https://board.example.com/vault\nSIGNUPS_ALLOWED=true\nROCKET_PORT=8222\n', {
    mode: 0o600,
  })
  const bw = join(dir, name, 'bw')
  writeFileSync(bw, '#!/bin/sh\n', { mode: 0o755 })
  const cert = join(dir, name, 'cert.pem')
  writeFileSync(cert, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
  return { data, env, bw, cert, appdata: join(dir, name, 'bwdata') }
}

function vaultFor(name: string, users: string[] | null, answers: (args: string[]) => RunResult = () => ok()) {
  const f = folder(name, users)
  const calls: { file: string; args: string[]; env: Record<string, string>; input?: string }[] = []
  const logs: string[] = []
  const run: Runner = async (file, args, o) => {
    calls.push({ file, args, env: o.env, ...(o.input !== undefined && { input: o.input }) })
    return answers(args)
  }
  const vault = createVault({
    cfg: () => ({ port: 8222, data: f.data, env: f.env, unit: 'vaultwarden.service', bw: f.bw, cert: f.cert }),
    log: line => logs.push(line),
    run,
    appdata: f.appdata,
  })
  return { vault, calls, logs, f }
}

describe('its accounts and signups', () => {
  test('no database yet, or no account: signups open, nothing changed', async () => {
    const none = vaultFor('none', null)
    expect(none.vault.accounts()).toEqual({ count: 0, email: null })
    expect(none.vault.signupsOpen()).toBe(true)
    expect(await none.vault.closeSignups()).toBe(false)
    const empty = vaultFor('empty', [])
    expect(empty.vault.signupsOpen()).toBe(true)
    expect(await empty.vault.closeSignups()).toBe(false)
    expect(readFileSync(empty.f.env, 'utf8')).toContain('SIGNUPS_ALLOWED=true')
    expect(empty.calls).toEqual([])
    none.vault.close()
    empty.vault.close()
  })

  test('the owner’s account there: signups refused, off in its settings (0600) and its unit restarted, once', async () => {
    const v = vaultFor('owned', ['owner@acme.test'])
    expect(v.vault.accounts()).toEqual({ count: 1, email: 'owner@acme.test' })
    expect(v.vault.signupsOpen()).toBe(false)
    expect(await v.vault.closeSignups()).toBe(true)
    expect(readFileSync(v.f.env, 'utf8')).toBe(
      'DOMAIN=https://board.example.com/vault\nSIGNUPS_ALLOWED=false\nROCKET_PORT=8222\n',
    )
    expect(statSync(v.f.env).mode & 0o777).toBe(0o600)
    expect(v.calls.map(c => [c.file.replace(/^.*\//, ''), ...c.args])).toEqual([
      ['systemctl', '--user', 'restart', 'vaultwarden.service'],
    ])
    expect(await v.vault.closeSignups()).toBe(false)
    expect(v.calls.length).toBe(1)
    expect(v.logs).toEqual(["vault: the owner's account is there: signups closed, vaultwarden.service restarted"])
    v.vault.close()
  })
})

describe('the Bitwarden CLI', () => {
  test('the first time: its server set to Vaultwarden on loopback, signed in with the account’s e-mail; the password on stdin only', async () => {
    let status = '{"serverUrl":null,"status":"unauthenticated"}'
    const v = vaultFor('login', ['owner@acme.test'], args => {
      if (args[0] === 'status') return ok(status)
      if (args[0] === 'config') return ok('Saved setting `config`.')
      if (args[0] === 'login') {
        status = '{"serverUrl":"https://127.0.0.1:8222/vault","status":"unlocked"}'
        return ok('SESSIONKEY123==\n')
      }
      return ok()
    })
    expect(await v.vault.signedIn()).toBe(false)
    expect(await v.vault.unlock(MASTER, '123456')).toEqual({ ok: true, session: 'SESSIONKEY123==' })
    expect(v.calls.map(c => c.args)).toEqual([
      ['status'],
      ['status'],
      ['config', 'server', 'https://127.0.0.1:8222/vault'],
      ['login', 'owner@acme.test', '--passwordfile', '/dev/stdin', '--raw', '--method', '0', '--code', '123456'],
    ])
    const login = v.calls.at(-1)
    expect(login?.input).toBe(`${MASTER}\n`)
    for (const c of v.calls) {
      expect(c.file).toBe(v.f.bw)
      expect(JSON.stringify(c.args)).not.toContain(MASTER)
      expect(JSON.stringify(c.env)).not.toContain(MASTER)
      expect(c.env.BITWARDENCLI_APPDATA_DIR).toBe(v.f.appdata)
      expect(c.env.BW_NOINTERACTION).toBe('true')
      expect(c.env.BW_SESSION).toBeUndefined()
      // Vaultwarden's own certificate on loopback, the one the CLI trusts there
      expect(c.env.NODE_EXTRA_CA_CERTS).toBe(v.f.cert)
    }
    expect(v.vault.ca()).toContain('BEGIN CERTIFICATE')
    expect(statSync(v.f.appdata).mode & 0o777).toBe(0o700)
    v.vault.close()
  })

  test('signed in before: unlock; a refusal said by its kind only', async () => {
    let answer = failed('Invalid master password.')
    const v = vaultFor('unlock', ['owner@acme.test'], args =>
      args[0] === 'status' ? ok('{"serverUrl":"https://127.0.0.1:8222/vault","status":"locked"}') : answer,
    )
    expect(await v.vault.unlock('wrong')).toEqual({ ok: false, why: 'password' })
    answer = failed('Two-step login is required')
    expect(await v.vault.unlock('x')).toEqual({ ok: false, why: 'code' })
    answer = failed('something else entirely')
    expect(await v.vault.unlock('x')).toEqual({ ok: false, why: 'failed' })
    answer = ok('SESSION\n')
    expect(await v.vault.unlock(MASTER)).toEqual({ ok: true, session: 'SESSION' })
    expect(v.calls.filter(c => c.args[0] === 'unlock').map(c => c.args)).toEqual(
      Array(4).fill(['unlock', '--passwordfile', '/dev/stdin', '--raw']),
    )
    v.vault.close()
  })

  test('the session in BW_SESSION only; the matches of a page’s address, logins only; an item; its TOTP code; lock', async () => {
    const items = [
      {
        id: 'i1',
        type: 1,
        name: 'Acme',
        login: { username: 'bot@acme.test', password: 'P', totp: 'otpauth://x', uris: [{ uri: 'https://acme.test' }] },
      },
      { id: 'n1', type: 2, name: 'A note' },
      { id: 'i2', type: 1, name: 'Old', deletedDate: '2026-01-01', login: { username: 'x' } },
    ]
    const v = vaultFor('items', ['owner@acme.test'], args => {
      if (args[0] === 'list') return ok(JSON.stringify(items))
      if (args[0] === 'get' && args[1] === 'item') return ok(JSON.stringify(items[0]))
      if (args[0] === 'get' && args[1] === 'totp') return ok('492039\n')
      return ok()
    })
    expect(await v.vault.matches('S', 'https://acme.test/login')).toEqual([
      { id: 'i1', name: 'Acme', username: 'bot@acme.test', totp: true, uris: ['https://acme.test'] },
    ])
    expect(await v.vault.secret('S', 'i1')).toEqual({ username: 'bot@acme.test', password: 'P', totp: true })
    expect(await v.vault.totp('S', 'i1')).toBe('492039')
    expect(await v.vault.secret('S', '../x y')).toBeNull()
    await v.vault.lock()
    expect(v.calls.map(c => [c.args, c.env.BW_SESSION])).toEqual([
      [['list', 'items', '--url', 'https://acme.test/login'], 'S'],
      [['get', 'item', 'i1'], 'S'],
      [['get', 'totp', 'i1'], 'S'],
      [['lock'], undefined],
    ])
    expect(v.logs).toEqual([])
    v.vault.close()
  })
})

describe('the Bitwarden CLI as the board runs it', () => {
  // a shell's /dev/stdin, as `bw --passwordfile /dev/stdin` opens it: a socket would not open (ENXIO)
  test.skipIf(process.platform === 'win32')(
    'the master password on a stdin it opens as a file, nowhere on its command line',
    async () => {
      const f = folder('real-run', ['owner@acme.test'])
      writeFileSync(
        f.bw,
        [
          '#!/bin/sh',
          'case "$1" in',
          '  status) echo \'{"serverUrl":"https://127.0.0.1:8222/vault","status":"locked"}\' ;;',
          `  unlock) read -r pw < /dev/stdin; [ "$pw" = '${MASTER}' ] && echo "SESSION-$#" || { echo "Invalid master password." >&2; exit 1; } ;;`,
          'esac',
        ].join('\n'),
        { mode: 0o755 },
      )
      const vault = createVault({
        cfg: () => ({ port: 8222, data: f.data, env: f.env, unit: 'vaultwarden.service', bw: f.bw, cert: f.cert }),
        log() {},
        appdata: f.appdata,
      })
      try {
        expect(await vault.unlock('wrong')).toEqual({ ok: false, why: 'password' })
        // unlock, --passwordfile, /dev/stdin, --raw: four words, none of them the password
        expect(await vault.unlock(MASTER)).toEqual({ ok: true, session: 'SESSION-4' })
      } finally {
        vault.close()
      }
    },
  )
})
