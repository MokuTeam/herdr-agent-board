// A login fill's life (services/login-fill.ts) with a vault and an agent's browser of the test's
// own: what an ask is refused for (the owner has the browser, nothing to type into, another site, a
// fill already waiting), the card under "needs you" with the page the board read, the master
// password wrong or right, one match typed by keys (Tab between, Return when asked) and the vault
// locked again, several matches picked by the owner, no match, the page gone meanwhile, declined,
// expired, "keep unlocked" and lock now; and no value of the vault's, nor the master password, in
// anything the card, an answer, the agent, the audit or the log gets.
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useLanguage } from '../../src/core/lang.ts'
import { FILL_EXPIRES_MS, type FillAsk, RETURN, TAB } from '../../src/core/login-fill.ts'
import type { Item } from '../../src/core/types.ts'
import type { PeekResult } from '../../src/services/cdp-peek.ts'
import { createLoginFills } from '../../src/services/login-fill.ts'
import type { Vault } from '../../src/services/vault.ts'

beforeEach(() => useLanguage('en'))
const dir = mkdtempSync(join(tmpdir(), 'login-fill-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const MASTER = 'correct-master-pw'
const PASSWORD = 'Hunter2-pw!'
const USER = 'bot@acme.test'
const CODE = '492039'
const SESSION = 'SESSION-KEY-abc123'
const SECRETS = [MASTER, PASSWORD, CODE, SESSION]

const item = (o: Partial<Item> = {}): Item => ({ key: 's1', session: 's1', pane: 'p1', name: 'one', ...o }) as Item

function setup(o: { matches?: { id: string; name: string; username: string; totp: boolean }[] } = {}) {
  let clock = 1_000_000
  const typed: number[][] = []
  /** Each look at the browser: whether it made the page the active one (only before typing). */
  const peeks: boolean[] = []
  const reminders: string[] = []
  const logs: string[] = []
  const bw: string[] = []
  let control: 'agent' | 'owner' = 'agent'
  let page: PeekResult = {
    ok: true,
    url: 'https://login.acme.test/session?token=x',
    title: 'Sign in · Acme',
    field: { editable: true, kind: 'email', crossFrame: false },
  }
  let unlocked = false
  const matches = o.matches ?? [{ id: 'i1', name: 'Acme', username: USER, totp: true }]
  const vault: Vault = {
    config: () => ({ port: 8222, data: dir, env: join(dir, 'env'), unit: 'vaultwarden.service', bw: '/bw', cert: '' }),
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
      return session === SESSION && unlocked ? matches.map(m => ({ ...m, uris: ['https://acme.test'] })) : null
    },
    async secret(session, id) {
      bw.push(`secret ${id}`)
      return session === SESSION && unlocked ? { username: USER, password: PASSWORD, totp: id !== 'nototp' } : null
    },
    async totp(session) {
      bw.push('totp')
      return session === SESSION && unlocked ? CODE : null
    },
    async lock() {
      bw.push('lock')
      unlocked = false
    },
    close() {},
  }
  const fills = createLoginFills({
    vault,
    desktops: {
      peek: async (_pane, opts) => {
        peeks.push(opts?.activate === true)
        return page
      },
      typeKeys: async (_pane, keys) => {
        if (control === 'owner') return { ok: false, error: 'owner' }
        typed.push([...keys])
        return { ok: true }
      },
      control: () => control,
    },
    itemOf: pane => (pane === 'p1' ? item() : undefined),
    remind: (_item, text) => reminders.push(text),
    onChange() {},
    log: line => logs.push(line),
    now: () => clock,
    auditFile: join(dir, `audit-${Math.random()}.jsonl`),
  })
  return {
    fills,
    typed,
    peeks,
    reminders,
    logs,
    bw,
    set: {
      control: (c: 'agent' | 'owner') => {
        control = c
      },
      page: (p: PeekResult) => {
        page = p
      },
      clock: (ms: number) => {
        clock += ms
      },
    },
  }
}

const ASK: FillAsk = { fields: ['username', 'password'], submit: true, username: '', site: null }
const keysOf = (text: string): number[] => [...text].map(ch => ch.codePointAt(0) ?? 0)
/** Everything a value could have leaked into. */
const leaks = (...things: unknown[]): string[] => {
  const all = JSON.stringify(things)
  return SECRETS.filter(s => all.includes(s))
}

describe('asking', () => {
  test('refused while the owner has the browser, with nothing to type into, on another site, twice', async () => {
    const s = setup()
    s.set.control('owner')
    expect(await s.fills.ask('p1', ASK, true)).toMatchObject({ ok: false, status: 409 })
    s.set.control('agent')
    s.set.page({
      ok: true,
      url: 'https://acme.test/',
      title: '',
      field: { editable: false, kind: '', crossFrame: false },
    })
    expect(await s.fills.ask('p1', ASK, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('click the field'),
    })
    s.set.page({
      ok: true,
      url: 'https://acme.test/',
      title: '',
      field: { editable: false, kind: '', crossFrame: true },
    })
    expect(await s.fills.ask('p1', ASK, true)).toMatchObject({ ok: false, error: expect.stringContaining('frame') })
    s.set.page({ ok: true, url: 'about:blank', title: '', field: { editable: true, kind: 'text', crossFrame: false } })
    expect(await s.fills.ask('p1', ASK, true)).toMatchObject({ ok: false, error: expect.stringContaining('http') })
    s.set.page({ ok: false, error: 'which page' })
    expect(await s.fills.ask('p1', ASK, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining('which page'),
    })
    s.set.page({
      ok: true,
      url: 'https://evil.test/',
      title: '',
      field: { editable: true, kind: 'email', crossFrame: false },
    })
    expect(await s.fills.ask('p1', { ...ASK, site: 'acme.test' }, true)).toMatchObject({
      ok: false,
      error: 'The page with the focus is on evil.test, not acme.test: nothing was asked.',
    })
    expect(await s.fills.ask('p9', ASK, true)).toMatchObject({ ok: false })
    s.set.page({
      ok: true,
      url: 'https://acme.test/',
      title: '',
      field: { editable: true, kind: 'email', crossFrame: false },
    })
    expect(await s.fills.ask('p1', ASK, true)).toMatchObject({ ok: true })
    expect(await s.fills.ask('p1', ASK, true)).toMatchObject({ ok: false, error: expect.stringContaining('waits') })
    expect(s.bw).toEqual([])
  })

  test('the card under "needs you" with the page the board read: its host, title and field; no address query', async () => {
    const s = setup()
    const r = await s.fills.ask('p1', { ...ASK, site: 'acme.test' }, true)
    if (!r.ok) throw new Error(r.error)
    const card = s.fills.card(item())
    expect(card).toMatchObject({ column: 'me', attention: 'ask', question: 'Fill in a login on login.acme.test' })
    expect(card.loginFill).toEqual([
      {
        id: r.id,
        site: 'login.acme.test',
        title: 'Sign in · Acme',
        field: 'email',
        fields: ['username', 'password'],
        submit: true,
        username: '',
        at: 1_000_000,
        expires: 1_000_000 + FILL_EXPIRES_MS,
        stage: 'asked',
        matches: null,
        unlockedUntil: null,
        firstLogin: false,
        error: '',
      },
    ])
    // another session's card, or one asleep: nothing
    expect(s.fills.card(item({ key: 's2' }))).toEqual({})
    expect(s.fills.card(item({ sleeping: true }))).toEqual({})
    expect(s.fills.status('p1', r.id)).toEqual({ status: 'pending', text: expect.stringContaining('pending') })
    expect(s.fills.status('p2', r.id)).toBeNull()
  })
})

describe('the owner’s answer', () => {
  test('a wrong master password: still pending, said on the card, nothing typed; the right one: typed, locked again', async () => {
    const s = setup()
    const r = await s.fills.ask('p1', ASK, true)
    if (!r.ok) throw new Error(r.error)
    const wrong = await s.fills.approve(r.id, { password: 'nope' })
    expect(wrong).toEqual({ status: 400, body: { ok: false, error: 'The vault did not open: wrong master password?' } })
    expect(s.fills.card(item()).loginFill?.[0]).toMatchObject({ stage: 'asked', error: wrong.body.error })
    expect(s.typed).toEqual([])
    expect(await s.fills.approve(r.id, {})).toMatchObject({ status: 400 })
    const ok = await s.fills.approve(r.id, { password: MASTER })
    expect(ok).toEqual({ status: 200, body: { ok: true, result: 'ok' } })
    expect(s.typed).toEqual([[...keysOf(USER), TAB, ...keysOf(PASSWORD), RETURN]])
    // the ask only looked; before typing the page was made the active one
    expect(s.peeks).toEqual([false, true])
    // matched by the page's address without its query; locked once typed
    expect(s.bw).toEqual(['unlock', 'unlock', 'sync', 'matches https://login.acme.test/session', 'secret i1', 'lock'])
    expect(s.fills.card(item())).toEqual({})
    expect(s.fills.status('p1', r.id)?.status).toBe('ok')
    expect(s.reminders).toEqual([
      '[board reminder] Login fill (browser_fill_login) ok · the owner approved: typed username, Tab, password, Return into the field that had the focus on login.acme.test. Check the page and go on.',
    ])
    // done is done
    expect(await s.fills.approve(r.id, { password: MASTER })).toMatchObject({ status: 409 })
    expect(leaks(wrong, ok, s.reminders, s.logs, s.fills.status('p1', r.id))).toEqual([])
  })

  test('the TOTP code alone, Return or not; a login without one: not done, nothing typed', async () => {
    const s = setup()
    const r = await s.fills.ask('p1', { ...ASK, fields: ['totp'], submit: false }, false)
    if (!r.ok) throw new Error(r.error)
    expect(await s.fills.approve(r.id, { password: MASTER })).toMatchObject({ status: 200 })
    expect(s.typed).toEqual([keysOf(CODE)])
    // asked by the CLI, which waits: no reminder
    expect(s.reminders).toEqual([])
    const n = setup({ matches: [{ id: 'nototp', name: 'Acme', username: USER, totp: false }] })
    const r2 = await n.fills.ask('p1', { ...ASK, fields: ['password', 'totp'] }, true)
    if (!r2.ok) throw new Error(r2.error)
    expect(await n.fills.approve(r2.id, { password: MASTER })).toMatchObject({
      status: 409,
      body: { result: 'failed' },
    })
    expect(n.typed).toEqual([])
    expect(n.reminders[0]).toContain(
      'not done · the login fill on login.acme.test did not go through (the login has no TOTP secret in the vault)',
    )
  })

  test('several matches: the owner picks one (names and usernames only on the card); one not shown is refused', async () => {
    const s = setup({
      matches: [
        { id: 'i1', name: 'Acme work', username: 'bot@acme.test', totp: false },
        { id: 'i2', name: 'Acme admin', username: 'admin@acme.test', totp: false },
      ],
    })
    const r = await s.fills.ask('p1', ASK, true)
    if (!r.ok) throw new Error(r.error)
    expect(await s.fills.approve(r.id, { password: MASTER })).toEqual({
      status: 200,
      body: { ok: true, stage: 'pick' },
    })
    const view = s.fills.card(item()).loginFill?.[0]
    expect(view?.stage).toBe('pick')
    expect(view?.matches).toEqual([
      { id: 'i1', name: 'Acme work', username: 'bot@acme.test', totp: false },
      { id: 'i2', name: 'Acme admin', username: 'admin@acme.test', totp: false },
    ])
    expect(await s.fills.pick(r.id, 'i9')).toMatchObject({ status: 400 })
    expect(await s.fills.pick(r.id, 'i2')).toEqual({ status: 200, body: { ok: true, result: 'ok' } })
    expect(s.bw.slice(-2)).toEqual(['secret i2', 'lock'])
    expect(leaks(view, s.reminders)).toEqual([])
  })

  test('the username the agent named narrows the matches; none left: no match, nothing typed, locked', async () => {
    const s = setup()
    const r = await s.fills.ask('p1', { ...ASK, username: 'someone-else' }, true)
    if (!r.ok) throw new Error(r.error)
    expect(await s.fills.approve(r.id, { password: MASTER })).toEqual({
      status: 200,
      body: { ok: true, result: 'nomatch' },
    })
    expect(s.typed).toEqual([])
    expect(s.bw.at(-1)).toBe('lock')
    expect(s.reminders[0]).toContain(
      "no match · the owner's vault has no login for login.acme.test (none with the username someone-else)",
    )
  })

  test('the page with the focus moved meanwhile: not done; the owner has the browser: still pending', async () => {
    const s = setup()
    const r = await s.fills.ask('p1', ASK, true)
    if (!r.ok) throw new Error(r.error)
    s.set.control('owner')
    const held = await s.fills.approve(r.id, { password: MASTER })
    expect(held.body.error).toContain('give it back')
    expect(s.fills.status('p1', r.id)?.status).toBe('pending')
    s.set.control('agent')
    s.set.page({
      ok: true,
      url: 'https://evil.test/',
      title: '',
      field: { editable: true, kind: 'email', crossFrame: false },
    })
    const moved = await s.fills.approve(r.id, { password: MASTER })
    expect(moved).toMatchObject({ status: 409, body: { result: 'failed' } })
    expect(s.typed).toEqual([])
    expect(s.reminders[0]).toContain('the page with the focus is not on login.acme.test any more')
    expect(s.bw.at(-1)).toBe('lock')
  })

  test('declined, and expired: the agent told, nothing opened or typed', async () => {
    const s = setup()
    const r = await s.fills.ask('p1', ASK, true)
    if (!r.ok) throw new Error(r.error)
    expect(s.fills.decline(r.id)).toEqual({ status: 200, body: { ok: true, result: 'declined' } })
    expect(s.reminders.at(-1)).toContain('declined · the owner declined the login fill on login.acme.test')
    const r2 = await s.fills.ask('p1', ASK, true)
    if (!r2.ok) throw new Error(r2.error)
    s.set.clock(FILL_EXPIRES_MS + 1)
    expect(await s.fills.approve(r2.id, { password: MASTER })).toMatchObject({
      status: 409,
      body: { result: 'expired' },
    })
    expect(s.reminders.at(-1)).toContain('expired · nobody answered the login fill on login.acme.test')
    expect(s.typed).toEqual([])
    expect(s.bw).toEqual([])
  })

  test('kept unlocked: the next ask shows its matches at once and is approved without the password; lock now', async () => {
    const s = setup()
    const r = await s.fills.ask('p1', ASK, true)
    if (!r.ok) throw new Error(r.error)
    expect(await s.fills.approve(r.id, { password: MASTER, keep: true })).toMatchObject({ status: 200 })
    // not locked after the fill
    expect(s.bw.includes('lock')).toBe(false)
    const r2 = await s.fills.ask('p1', ASK, true)
    if (!r2.ok) throw new Error(r2.error)
    await Bun.sleep(10)
    const view = s.fills.card(item()).loginFill?.[0]
    expect(view?.matches).toEqual([{ id: 'i1', name: 'Acme', username: USER, totp: true }])
    expect(view?.unlockedUntil).toBeGreaterThan(1_000_000)
    expect(await s.fills.approve(r2.id, {})).toMatchObject({ status: 200, body: { result: 'ok' } })
    expect(s.bw.filter(c => c === 'unlock')).toEqual(['unlock'])
    await s.fills.lockNow()
    expect(s.bw.at(-1)).toBe('lock')
    const r3 = await s.fills.ask('p1', ASK, true)
    if (!r3.ok) throw new Error(r3.error)
    expect(await s.fills.approve(r3.id, {})).toMatchObject({ status: 400 })
    expect(leaks(view, s.reminders, s.logs)).toEqual([])
  })

  test('the audit says who asked for which site and what came of it, never a value', async () => {
    const audit = join(dir, 'audit-life.jsonl')
    const life = createLoginFills({
      vault: {
        config: () => ({ port: 1, data: dir, env: '', unit: 'u.service', bw: '', cert: '' }),
        port: () => 1,
        ca: () => null,
        accounts: () => ({ count: 1, email: 'o@x' }),
        signupsOpen: () => false,
        registered() {},
        closeSignups: async () => false,
        signedIn: async () => true,
        unlock: async p => (p === MASTER ? { ok: true, session: SESSION } : { ok: false, why: 'password' }),
        sync: async () => true,
        matches: async () => [{ id: 'i1', name: 'Acme', username: USER, totp: false, uris: [] }],
        secret: async () => ({ username: USER, password: PASSWORD, totp: false }),
        totp: async () => null,
        lock: async () => {},
        close() {},
      },
      desktops: {
        peek: async () => ({
          ok: true,
          url: 'https://acme.test/',
          title: '',
          field: { editable: true, kind: 'email', crossFrame: false },
        }),
        typeKeys: async () => ({ ok: true }),
        control: () => 'agent',
      },
      itemOf: () => item(),
      remind() {},
      onChange() {},
      log() {},
      auditFile: audit,
    })
    const r = await life.ask('p1', ASK, true)
    if (!r.ok) throw new Error(r.error)
    await life.approve(r.id, { password: 'wrong' })
    await life.approve(r.id, { password: MASTER })
    const lines = readFileSync(audit, 'utf8')
      .trim()
      .split('\n')
      .map(l => JSON.parse(l) as Record<string, unknown>)
    expect(lines.map(l => l.op)).toEqual(['asked', 'refused', 'typed', 'ok'])
    expect(lines[2]).toMatchObject({ site: 'acme.test', fields: ['username', 'password'], asked: 's1', item: 'i1' })
    expect(leaks(lines)).toEqual([])
    await life.close()
  })
})
