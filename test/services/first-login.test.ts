// The first login on the board's own server (services/first-login.ts): the link's code made by
// `board login link`, kept as its hash only, used up once within its hour; the setup it opens for
// 10 minutes; `board login reset` with no board running.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import {
  accessFile,
  readSecrets,
  setupFile,
  updateLogins,
  updatePasskeys,
  updateSecrets,
  writeSetupCode,
} from '../../src/adapters/access-store.ts'
import { LOGIN_MS, type Passkey } from '../../src/core/access.ts'
import { base32Bytes, totpCode, totpStep } from '../../src/core/totp.ts'
import { createAccess } from '../../src/services/access.ts'
import { createFirstLogin, newSetupLink, resetLogin } from '../../src/services/first-login.ts'
import { hashToken } from '../../src/services/remote.ts'
import { isolatedHome } from '../support/env.ts'

const DOMAIN = 'workbench.example.com'
const PASSWORD = 'correct horse battery'
const LINK = /^https:\/\/workbench\.example\.com\/setup#code=([\w-]{32})$/

function setup() {
  isolatedHome()
  let clock = Date.now()
  const access = createAccess({ onChange: () => {} })
  const first = createFirstLogin({ access, domain: () => DOMAIN, now: () => clock })
  const link = (): string => LINK.exec(newSetupLink(DOMAIN, { now: () => clock }))?.[1] ?? ''
  return {
    access,
    first,
    link,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

const codeNow = (secret: string): string => totpCode(base32Bytes(secret) ?? new Uint8Array(), totpStep(Date.now()))

test('the link: 24 random bytes in its fragment, on file as their hash only, for an hour', () => {
  const { link } = setup()
  const code = link()
  expect(Buffer.from(code, 'base64url')).toHaveLength(24)
  const file = readFileSync(setupFile(), 'utf8')
  expect(file).not.toContain(code)
  const kept = JSON.parse(file)
  expect(Object.keys(kept)).toEqual(['codeHash', 'expiresAt'])
  expect(kept.codeHash).toBe(hashToken(code))
  // a new one in place of the one before
  const next = link()
  expect(next).not.toBe(code)
  expect(JSON.parse(readFileSync(setupFile(), 'utf8')).codeHash).toBe(hashToken(next))
})

test('a code works once, within its hour; any other: one answer', () => {
  const { first, link, tick } = setup()
  const refused = { ok: false, status: 401, error: 'link' } as const
  const code = link()
  for (const other of [undefined, '', 7, 'x'.repeat(32), `${code}x`]) expect(first.start(other)).toEqual(refused)
  const r = first.start(code)
  expect(r).toMatchObject({ ok: true, setup: expect.stringMatching(/^[\w-]{43}$/) })
  expect(r.ok && base32Bytes(r.secret)).toHaveLength(20)
  expect(r.ok && r.uri).toContain(encodeURIComponent(DOMAIN))
  expect(first.start(code)).toEqual(refused)
  expect(existsSync(setupFile())).toBe(false)
  // one made an hour ago is spent, and goes with the try
  const late = link()
  tick(3_600_000)
  expect(first.start(late)).toEqual(refused)
  expect(existsSync(setupFile())).toBe(false)
})

test('the setup: the password and the first code together, within 10 minutes; a wrong code can be sent again', async () => {
  const { access, first, link } = setup()
  const r = first.start(link())
  if (!r.ok) throw new Error('not started')
  const late = first.start(link())
  if (!late.ok) throw new Error('not started')
  // a second start takes the place of the first
  expect(await first.finish({ setup: r.setup, password: PASSWORD, code: codeNow(late.secret) })).toEqual({
    ok: false,
    status: 401,
    error: 'setup',
  })
  expect(await first.finish({ setup: late.setup, password: PASSWORD, code: '000000' })).toMatchObject({
    ok: false,
    status: 400,
    error: 'code',
  })
  expect(access.ready()).toBe(false)
  // a link asked for meanwhile goes once the login is set
  link()
  expect(await first.finish({ setup: late.setup, password: PASSWORD, code: codeNow(late.secret) })).toEqual({
    ok: true,
  })
  expect(access.ready()).toBe(true)
  expect(readSecrets().totp?.secret).toBe(late.secret)
  expect(existsSync(setupFile())).toBe(false)
  expect(await first.finish({ setup: late.setup, password: PASSWORD, code: codeNow(late.secret) })).toMatchObject({
    status: 401,
  })

  // a setup left for longer than 10 minutes is over
  const again = setup()
  const s = again.first.start(again.link())
  if (!s.ok) throw new Error('not started')
  again.tick(10 * 60_000 + 1)
  expect(await again.first.finish({ setup: s.setup, password: PASSWORD, code: codeNow(s.secret) })).toEqual({
    ok: false,
    status: 401,
    error: 'setup',
  })
  expect(again.access.ready()).toBe(false)
})

test('board login reset with no board running: no password, code, passkey or login left', async () => {
  isolatedHome()
  updateSecrets(s => ({
    ...s,
    passwordHash: '$argon2id$x',
    totp: { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', lastStep: 1 },
    userId: 'dGVzdC11c2VyLWlkLTAwMQ',
    lockout: { failures: 3, until: null },
  }))
  updatePasskeys(() => [{ id: 'p1' } as unknown as Passkey])
  const at = Date.now()
  updateLogins(() => [
    {
      id: 'l1',
      tokenHash: 'h',
      method: 'password',
      label: 'x',
      address: '203.0.113.9',
      signedInAt: at,
      expiresAt: at + LOGIN_MS,
      seenAt: null,
    },
  ])
  writeSetupCode({ codeHash: 'old', expiresAt: at + 1000 })
  // port 9: nothing answers
  expect(await resetLogin(9)).toBe(false)
  const s = JSON.parse(readFileSync(accessFile(), 'utf8'))
  expect(s).toMatchObject({ passwordHash: null, totp: null, lockout: { failures: 0, until: null } })
  // the WebAuthn user id stays: it names no passkey by itself
  expect(s.userId).toBe('dGVzdC11c2VyLWlkLTAwMQ')
  expect(readFileSync(accessFile().replace('access.json', 'access-passkeys.json'), 'utf8')).toBe('[]')
  expect(readFileSync(accessFile().replace('access.json', 'access-logins.json'), 'utf8')).toBe('[]')
})
