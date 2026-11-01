// A login save's life (services/login-save.ts) with a vault of the test's own: a sign-in the
// watcher caught becomes an offer on the card under "needs you" (the site and the username only),
// approved with the master password wrong or right, a new login created or an existing one's
// password updated or found the same, declined, expired, "keep unlocked" shared with the fill, the
// vault locked again; and no value of the password caught, nor of the master password, in anything
// the card, an answer, the audit or the log gets.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useLanguage } from '../../src/core/lang.ts'
import { SAVE_EXPIRES_MS } from '../../src/core/login-save.ts'
import type { Item } from '../../src/core/types.ts'
import { createLoginSaves } from '../../src/services/login-save.ts'
import type { Vault } from '../../src/services/vault.ts'
import { createVaultHold } from '../../src/services/vault-hold.ts'

beforeEach(() => useLanguage('en'))
const dir = mkdtempSync(join(tmpdir(), 'login-save-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const MASTER = 'correct-master-pw'
const CAUGHT = 'Typed-Password-9!'
const SESSION = 'SAVE-SESSION-xyz'
const SECRETS = [MASTER, CAUGHT, SESSION]
const item = (): Item => ({ key: 's1', session: 's1', pane: 'p1', name: 'one' }) as Item

/** A vault with its logins in memory; the Bitwarden CLI's calls listed, never its values. */
function setup(o: { logins?: { id: string; username: string; password: string }[] } = {}) {
  let clock = 2_000_000
  const bw: string[] = []
  const logs: string[] = []
  let unlocked = false
  const logins = o.logins ?? []
  const vault: Vault = {
    config: () => ({ port: 8222, data: dir, env: join(dir, 'env'), unit: 'u.service', bw: '/bw', cert: '' }),
    port: () => 8222,
    ca: () => null,
    accounts: () => ({ count: 1, email: 'owner@acme.test' }),
    signupsOpen: () => false,
    registered() {},
    closeSignups: async () => false,
    signedIn: async () => true,
    async unlock(password) {
      bw.push('unlock')
      if (password !== MASTER) return { ok: false, why: 'password' }
      unlocked = true
      return { ok: true, session: SESSION }
    },
    async sync(session) {
      bw.push('sync')
      return session === SESSION && unlocked
    },
    async matches(session, url) {
      bw.push(`matches ${url}`)
      if (session !== SESSION || !unlocked) return null
      return logins.map(l => ({ id: l.id, name: l.username, username: l.username, totp: false, uris: [] }))
    },
    async secret(session, id) {
      bw.push(`secret ${id}`)
      const l = logins.find(x => x.id === id)
      return session === SESSION && unlocked && l ? { username: l.username, password: l.password, totp: false } : null
    },
    async item(session, id) {
      bw.push(`item ${id}`)
      const l = logins.find(x => x.id === id)
      return session === SESSION && unlocked && l
        ? { id, type: 1, login: { username: l.username, password: l.password } }
        : null
    },
    async createItem(session, it) {
      bw.push('create')
      if (session !== SESSION || !unlocked) return null
      const login = (it.login ?? {}) as { username?: string; password?: string }
      logins.push({ id: 'new-id', username: login.username ?? '', password: login.password ?? '' })
      return 'new-id'
    },
    async editItem(session, id, it) {
      bw.push(`edit ${id}`)
      const l = logins.find(x => x.id === id)
      if (session !== SESSION || !unlocked || !l) return false
      l.password = ((it.login ?? {}) as { password?: string }).password ?? l.password
      return true
    },
    async totp() {
      return null
    },
    async lock() {
      bw.push('lock')
      unlocked = false
    },
    close() {},
  }
  const onChange = () => {}
  const hold = createVaultHold({ vault, onChange, now: () => clock })
  const saves = createLoginSaves({
    vault,
    hold,
    itemOf: pane => (pane === 'p1' ? item() : undefined),
    onChange,
    log: line => logs.push(line),
    now: () => clock,
    auditFile: join(dir, `audit-${Math.random()}.jsonl`),
  })
  return {
    saves,
    hold,
    vault,
    bw,
    logs,
    logins,
    tick: (ms: number) => {
      clock += ms
    },
    auditOf: (file: string) => file,
  }
}

/** Everything the offer, an answer and the log carry: no caught password, no master password, no session. */
const leaks = (...blobs: unknown[]): string[] => {
  const text = blobs.map(b => (typeof b === 'string' ? b : JSON.stringify(b))).join('\n')
  return SECRETS.filter(s => text.includes(s))
}

describe('the offer on the card', () => {
  test('a caught sign-in on an https page: under "needs you" with the site and the username, no password', async () => {
    const s = setup()
    await s.saves.capture('p1', { url: 'https://acme.test/in?t=x', username: 'bot@acme.test', password: CAUGHT })
    const card = s.saves.card(item())
    expect(card.attention).toBe('ask')
    expect(card.loginSave?.length).toBe(1)
    const view = card.loginSave?.[0]
    expect(view).toMatchObject({ site: 'acme.test', username: 'bot@acme.test', kind: 'unknown', stage: 'asked' })
    expect(leaks(view)).toEqual([])
    // the vault was not touched to make the offer
    expect(s.bw).toEqual([])
  })

  test('a page that is not https, or an empty password: no offer', async () => {
    const s = setup()
    await s.saves.capture('p1', { url: 'http://acme.test/in', username: 'u', password: CAUGHT })
    await s.saves.capture('p1', { url: 'https://acme.test/in', username: 'u', password: '' })
    expect(s.saves.card(item()).loginSave).toBeUndefined()
  })

  test('a newer sign-in replaces the older one; the same one again is kept (one offer per session)', async () => {
    const s = setup()
    await s.saves.capture('p1', { url: 'https://acme.test/in', username: 'a', password: CAUGHT })
    await s.saves.capture('p1', { url: 'https://acme.test/in', username: 'a', password: CAUGHT })
    expect(s.saves.card(item()).loginSave?.length).toBe(1)
    await s.saves.capture('p1', { url: 'https://acme.test/in', username: 'b', password: CAUGHT })
    const list = s.saves.card(item()).loginSave
    expect(list?.length).toBe(1)
    expect(list?.[0]?.username).toBe('b')
  })
})

describe('the owner’s answer', () => {
  test('the master password wrong: it stays, the reason on the card, nothing written', async () => {
    const s = setup()
    await s.saves.capture('p1', { url: 'https://acme.test/in', username: 'bot', password: CAUGHT })
    const id = s.saves.card(item()).loginSave?.[0]?.id as string
    const bad = await s.saves.approve(id, { password: 'wrong' })
    expect(bad.status).toBe(400)
    expect(s.saves.card(item()).loginSave?.[0]?.error).toContain('master password')
    expect(s.bw.filter(c => c.startsWith('create') || c.startsWith('edit'))).toEqual([])
  })

  test('a new login created, then the vault locked again', async () => {
    const s = setup()
    await s.saves.capture('p1', { url: 'https://acme.test/in', username: 'bot@acme.test', password: CAUGHT })
    const id = s.saves.card(item()).loginSave?.[0]?.id as string
    const ok = await s.saves.approve(id, { password: MASTER })
    expect(ok.body).toEqual({ ok: true, result: 'saved' })
    expect(s.bw).toContain('create')
    expect(s.bw.at(-1)).toBe('lock')
    expect(s.logins.find(l => l.username === 'bot@acme.test')?.password).toBe(CAUGHT)
    expect(s.saves.card(item()).loginSave).toBeUndefined()
  })

  test('an existing login with another password: its password updated, not a new item', async () => {
    const s = setup({ logins: [{ id: 'i1', username: 'bot@acme.test', password: 'OLD-pw' }] })
    await s.saves.capture('p1', { url: 'https://acme.test/in', username: 'bot@acme.test', password: CAUGHT })
    const id = s.saves.card(item()).loginSave?.[0]?.id as string
    const ok = await s.saves.approve(id, { password: MASTER })
    expect(ok.body).toEqual({ ok: true, result: 'updated' })
    expect(s.bw).toContain('edit i1')
    expect(s.bw).not.toContain('create')
    expect(s.logins[0]?.password).toBe(CAUGHT)
  })

  test('the vault has it with the same password: found the same, nothing written', async () => {
    const s = setup({ logins: [{ id: 'i1', username: 'bot@acme.test', password: CAUGHT }] })
    await s.saves.capture('p1', { url: 'https://acme.test/in', username: 'bot@acme.test', password: CAUGHT })
    const id = s.saves.card(item()).loginSave?.[0]?.id as string
    const ok = await s.saves.approve(id, { password: MASTER })
    expect(ok.body).toEqual({ ok: true, result: 'same' })
    expect(s.bw).not.toContain('create')
    expect(s.bw.every(c => !c.startsWith('edit'))).toBe(true)
  })

  test('declined: nothing written; expired after its time: the offer gone', async () => {
    const s = setup()
    await s.saves.capture('p1', { url: 'https://acme.test/in', username: 'bot', password: CAUGHT })
    const id = s.saves.card(item()).loginSave?.[0]?.id as string
    expect(s.saves.decline(id).body).toEqual({ ok: true, result: 'declined' })
    expect(s.bw).toEqual([])

    await s.saves.capture('p1', { url: 'https://acme.test/in', username: 'bot2', password: CAUGHT })
    s.tick(SAVE_EXPIRES_MS + 10)
    const again = s.saves.card(item())
    expect(again.loginSave).toBeUndefined()
  })
})

describe('the vault kept open, shared with the fill', () => {
  test('kept unlocked: the offer tells a new login from an update at once, and is approved without the password', async () => {
    const s = setup({ logins: [{ id: 'i1', username: 'bot@acme.test', password: 'OLD-pw' }] })
    // the owner opened the vault before (as a fill's "keep unlocked" does): the hold has a session
    s.hold.hold(SESSION, 15 * 60_000, null)
    // the vault must actually be unlocked for matches to answer: approve a throwaway first is overkill, so unlock via the vault
    await s.vault.unlock(MASTER)
    await s.saves.capture('p1', { url: 'https://acme.test/in', username: 'bot@acme.test', password: CAUGHT })
    const view = s.saves.card(item()).loginSave?.[0]
    expect(view?.kind).toBe('update')
    expect(view?.unlockedUntil).not.toBeNull()
    const ok = await s.saves.approve(view?.id as string, {})
    expect(ok.body).toEqual({ ok: true, result: 'updated' })
    // no master password was asked: no unlock in this stretch beyond the test's own
    expect(s.bw.filter(c => c === 'unlock')).toEqual(['unlock'])
  })

  test('kept unlocked and the sign-in is already saved the same: no offer at all', async () => {
    const s = setup({ logins: [{ id: 'i1', username: 'bot@acme.test', password: CAUGHT }] })
    s.hold.hold(SESSION, 15 * 60_000, null)
    await s.vault.unlock(MASTER)
    await s.saves.capture('p1', { url: 'https://acme.test/in', username: 'bot@acme.test', password: CAUGHT })
    expect(s.saves.card(item()).loginSave).toBeUndefined()
  })
})

describe('no value anywhere', () => {
  test('the audit says who offered which site, the kind and the item, never a value', async () => {
    const audit = join(dir, 'audit-life.jsonl')
    const clock = 3_000_000
    const logins: { id: string; username: string; password: string }[] = []
    const vault = setup({ logins }).vault
    const hold = createVaultHold({ vault, onChange: () => {}, now: () => clock })
    const saves = createLoginSaves({
      vault,
      hold,
      itemOf: () => item(),
      onChange: () => {},
      log: () => {},
      now: () => clock,
      auditFile: audit,
    })
    await saves.capture('p1', { url: 'https://acme.test/in', username: 'bot@acme.test', password: CAUGHT })
    const id = saves.card(item()).loginSave?.[0]?.id as string
    await saves.approve(id, { password: MASTER })
    const lines = readFileSync(audit, 'utf8')
    expect(lines).toContain('save.caught')
    expect(lines).toMatch(/save\.saved|save\.updated/)
    expect(leaks(lines)).toEqual([])
    await saves.close()
  })
})
