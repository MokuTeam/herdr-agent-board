// The rules of a login the owner typed, offered to their vault (core/login-save.ts): a caught
// sign-in checked (https, or http on the machine's own host; no empty password; the username
// trimmed), the address the vault matches on (no query), whether it is a new login, an update or
// the same, and the item built for the Bitwarden CLI. No value is said here but what the caller
// hands in.
import { describe, expect, test } from 'bun:test'
import {
  caughtLogin,
  isLocalHost,
  itemWithPassword,
  newLoginItem,
  originOf,
  type SaveMatch,
  saveKindOf,
  saveMatchUrl,
} from '../../src/core/login-save.ts'

describe('a caught sign-in checked', () => {
  test('an https page: its host, the match address without the query, the username and password', () => {
    expect(
      caughtLogin({ url: 'https://login.acme.test/in?next=/x#f', username: '  bot@acme.test  ', password: 'Hunter2' }),
    ).toEqual({
      ok: true,
      site: 'login.acme.test',
      url: 'https://login.acme.test/in',
      username: 'bot@acme.test',
      password: 'Hunter2',
    })
  })

  test('http on the machine’s own host is allowed; http anywhere else is not', () => {
    expect(caughtLogin({ url: 'http://localhost:3000/in', username: 'u', password: 'p' })).toMatchObject({
      ok: true,
      site: 'localhost',
    })
    expect(caughtLogin({ url: 'http://127.0.0.1/in', username: 'u', password: 'p' })).toMatchObject({ ok: true })
    expect(caughtLogin({ url: 'http://acme.test/in', username: 'u', password: 'p' })).toEqual({ ok: false })
  })

  test('no password, a password too long, a line in the username, or no http(s) page: refused or cleaned', () => {
    expect(caughtLogin({ url: 'https://a.test/', username: 'u', password: '' })).toEqual({ ok: false })
    expect(caughtLogin({ url: 'https://a.test/', username: 'u', password: 'x'.repeat(5000) })).toEqual({ ok: false })
    expect(caughtLogin({ url: 'about:blank', username: 'u', password: 'p' })).toEqual({ ok: false })
    expect(caughtLogin({ url: 'https://a.test/', username: 'two\nlines', password: 'p' })).toMatchObject({
      ok: true,
      username: 'twolines',
    })
  })

  test('isLocalHost and originOf and saveMatchUrl', () => {
    expect(isLocalHost('localhost')).toBe(true)
    expect(isLocalHost('app.localhost')).toBe(true)
    expect(isLocalHost('acme.test')).toBe(false)
    expect(originOf('https://a.test:8443/in?x=1')).toBe('https://a.test:8443')
    expect(saveMatchUrl('https://a.test/in?x=1#y')).toBe('https://a.test/in')
  })
})

describe('which of the vault’s logins this sign-in is', () => {
  const list: SaveMatch[] = [
    { id: 'i1', username: 'bot@acme.test', password: 'old' },
    { id: 'i2', username: 'other@acme.test', password: 'p2' },
  ]
  test('no login with that username: a new one', () => {
    expect(saveKindOf(list, 'new@acme.test', 'p')).toEqual({ kind: 'new' })
  })
  test('that username, another password: an update of it', () => {
    expect(saveKindOf(list, 'bot@acme.test', 'new')).toEqual({ kind: 'update', id: 'i1' })
    // the username matches case-insensitively
    expect(saveKindOf(list, 'BOT@ACME.TEST', 'new')).toEqual({ kind: 'update', id: 'i1' })
  })
  test('that username, the same password: the same already (no write, no offer)', () => {
    expect(saveKindOf(list, 'bot@acme.test', 'old')).toEqual({ kind: 'same', id: 'i1' })
  })
})

describe('the item for the Bitwarden CLI', () => {
  test('a new login: type 1, the site as its name, the username, the password and the origin as its URI', () => {
    expect(newLoginItem({ name: 'acme.test', username: 'bot', password: 'p', uri: 'https://acme.test' })).toEqual({
      type: 1,
      name: 'acme.test',
      notes: null,
      favorite: false,
      fields: [],
      login: { username: 'bot', password: 'p', totp: null, uris: [{ match: null, uri: 'https://acme.test' }] },
    })
    // no username: a null one, so the item is still valid
    expect(
      (newLoginItem({ name: 'a', username: '', password: 'p', uri: 'u' }).login as { username: unknown }).username,
    ).toBe(null)
  })

  test('an edit sets the login password and leaves the rest of the item as it was', () => {
    const item = {
      id: 'i1',
      type: 1,
      name: 'Acme',
      notes: 'keep',
      login: { username: 'bot', password: 'old', totp: 'seed' },
    }
    const next = itemWithPassword(item, 'new')
    expect(next).toEqual({
      id: 'i1',
      type: 1,
      name: 'Acme',
      notes: 'keep',
      login: { username: 'bot', password: 'new', totp: 'seed' },
    })
    // the original is untouched
    expect((item.login as { password: string }).password).toBe('old')
  })
})
