// A login fill's rules (core/login-fill.ts): what an agent may ask, the site and the page's host,
// the keys typed (a Tab between values, Return when asked, nothing at all for a character no key
// types), what the agent is told (never a value), and `board browser login`'s words.
import { describe, expect, test } from 'bun:test'
import {
  charKeysym,
  fillAsk,
  fillFields,
  fillKeys,
  fillResult,
  loginArgs,
  matchUrl,
  onSite,
  pageHost,
  RETURN,
  siteHost,
  TAB,
} from '../../src/core/login-fill.ts'

describe('what an agent asks', () => {
  test('the fields: each at most once, in its order', () => {
    expect(fillFields(['password'])).toEqual(['password'])
    expect(fillFields('totp, username password')).toEqual(['totp', 'username', 'password'])
    for (const v of [[], ['password', 'password'], ['pin'], 'username,secret', 7, null, ['a', 'b', 'c', 'd']])
      expect([v, fillFields(v)]).toEqual([v, null])
  })

  test('its body: username and password by default, a username of one line, a site as a host', () => {
    expect(fillAsk({})).toEqual({
      ok: true,
      ask: { fields: ['username', 'password'], submit: false, username: '', site: null },
    })
    expect(
      fillAsk({ fields: ['totp'], submit: true, username: ' bot@acme.test ', site: 'https://GitHub.com/login?x=1' }),
    ).toEqual({ ok: true, ask: { fields: ['totp'], submit: true, username: 'bot@acme.test', site: 'github.com' } })
    expect(fillAsk({ username: 'a\nb' }).ok).toBe(false)
    expect(fillAsk({ site: 'ftp://x.example' }).ok).toBe(false)
    expect(fillAsk({ fields: ['password', 'pin'] }).ok).toBe(false)
  })

  test('sites and pages: a host, a page under the named site only', () => {
    expect([siteHost('github.com'), siteHost('accounts.google.com.'), siteHost('not a site')]).toEqual([
      'github.com',
      'accounts.google.com',
      null,
    ])
    expect([pageHost('https://Gist.GitHub.com/x'), pageHost('about:blank'), pageHost('chrome://newtab')]).toEqual([
      'gist.github.com',
      null,
      null,
    ])
    expect(onSite('gist.github.com', 'github.com')).toBe(true)
    expect(onSite('github.com', 'github.com')).toBe(true)
    expect(onSite('evilgithub.com', 'github.com')).toBe(false)
    expect(onSite('github.com', 'gist.github.com')).toBe(false)
    expect(matchUrl('https://acme.test/login?token=s3cr3t#x')).toBe('https://acme.test/login')
  })
})

describe('the keys typed', () => {
  test('each character’s keysym, a Tab between values, Return after when asked', () => {
    expect(fillKeys(['ab', 'C1!'], true)).toEqual([0x61, 0x62, TAB, 0x43, 0x31, 0x21, RETURN])
    expect(fillKeys(['123456'], false)).toEqual([0x31, 0x32, 0x33, 0x34, 0x35, 0x36])
    // Latin-1 as it is, the keymap's Cyrillic by its code point (core/desktop.ts deskKeymap)
    expect(fillKeys(['é', 'Пароль'], false)).toEqual([
      0xe9,
      TAB,
      ...[...'Пароль'].map(ch => 0x01000000 + (ch.codePointAt(0) ?? 0)),
    ])
    expect(charKeysym(' ')).toBe(0x20)
  })

  test('nothing at all when a value has a character no key types', () => {
    for (const v of ['line\nbreak', 'tab\there', 'emoji 🙂', '中文'])
      expect([v, fillKeys(['user', v], false)]).toEqual([v, null])
  })
})

describe('what the agent is told', () => {
  test('how it ended, the site and what was typed: never a value', () => {
    const r = { site: 'acme.test', fields: ['username', 'password'] as const, submit: true }
    expect(fillResult({ ...r, fields: [...r.fields], status: 'ok' })).toBe(
      'ok · the owner approved: typed username, Tab, password, Return into the field that had the focus on acme.test. Check the page and go on.',
    )
    expect(fillResult({ ...r, fields: [...r.fields], status: 'declined' })).toStartWith('declined · ')
    expect(fillResult({ ...r, fields: [...r.fields], status: 'expired' })).toStartWith('expired · ')
    expect(fillResult({ ...r, fields: [...r.fields], status: 'nomatch', reason: 'none with the username x' })).toBe(
      "no match · the owner's vault has no login for acme.test (none with the username x): nothing was typed.",
    )
    expect(fillResult({ ...r, fields: [...r.fields], status: 'failed', reason: 'the page moved' })).toBe(
      'not done · the login fill on acme.test did not go through (the page moved).',
    )
  })
})

describe('board browser login’s words', () => {
  test('its flags, waiting by default', () => {
    expect(loginArgs([])).toEqual({ ok: true, args: { fields: ['username', 'password'], submit: false, wait: true } })
    expect(loginArgs(['--fields', 'totp', '--enter', '--no-wait', '--username', 'bot', '--site', 'acme.test'])).toEqual(
      {
        ok: true,
        args: { fields: ['totp'], submit: true, wait: false, username: 'bot', site: 'acme.test' },
      },
    )
    expect(loginArgs(['--fields']).ok).toBe(false)
    expect(loginArgs(['--fields', 'pin']).ok).toBe(false)
    expect(loginArgs(['hunter2']).ok).toBe(false)
  })
})
