// The link a call in link mode opens in the viewer's browser (core/mokupilot.ts callLink):
// mokupilot://call with claude-session and, when known, cwd, each percent-encoded, nothing else;
// read back the way MokuPilot's parse_call_url does (one of each key, no port, path or fragment).
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { callLink } from '../../src/core/mokupilot.ts'

const ID = '0b3f8c2e-5d1a-4c6b-9e7f-1a2b3c4d5e6f'
const claude = { agent: 'claude', session: ID }

/** What MokuPilot reads from a link: its keys and values, decoded; it refuses anything else. */
function parsed(link: string | null): Record<string, string> {
  assert.ok(link)
  const url = new URL(link)
  assert.equal(url.protocol, 'mokupilot:')
  assert.equal(url.host, 'call')
  assert.equal(url.port, '')
  assert.equal(url.pathname, '')
  assert.equal(url.hash, '')
  const keys = [...url.searchParams.keys()]
  assert.equal(new Set(keys).size, keys.length, `a key twice in ${link}`)
  return Object.fromEntries(url.searchParams)
}

test('a call link: the session and its folder, nothing else', () => {
  assert.equal(callLink(claude, '/srv/acme'), `mokupilot://call?claude-session=${ID}&cwd=%2Fsrv%2Facme`)
  assert.deepEqual(parsed(callLink(claude, '/srv/acme')), { 'claude-session': ID, cwd: '/srv/acme' })
})

test('the folder comes back as it was: spaces, other alphabets, & # ? = + % in it', () => {
  for (const cwd of [
    '/home/u/Acme project',
    '/home/u/Проект/日本',
    '/srv/a&b#c?d=e',
    '/srv/x+y%20z',
    "/srv/it's (1)",
    '/srv/emoji 🚀',
  ]) {
    const link = callLink(claude, cwd)
    assert.ok(link)
    // The query is one claude-session and one cwd, whatever the folder has in it.
    assert.doesNotMatch(link.slice(link.indexOf('cwd=')), /[ #?&]/)
    assert.deepEqual(parsed(link), { 'claude-session': ID, cwd }, cwd)
  }
  assert.equal(callLink(claude, '/a b'), `mokupilot://call?claude-session=${ID}&cwd=%2Fa%20b`)
})

test('no folder known: no cwd at all', () => {
  assert.equal(callLink(claude), `mokupilot://call?claude-session=${ID}`)
  assert.equal(callLink(claude, ''), `mokupilot://call?claude-session=${ID}`)
  assert.deepEqual(parsed(callLink(claude, '')), { 'claude-session': ID })
})

test('only a Claude Code session with a UUID: anything else gets no link', () => {
  for (const item of [
    null,
    undefined,
    { agent: 'claude', session: null },
    { agent: 'claude', session: 'pane-p3' },
    { agent: 'claude', session: `${ID}&cwd=/etc` },
    { agent: 'claude', session: `${ID}x` },
    { agent: 'codex', session: ID },
    { agent: 'pi', session: ID },
  ])
    assert.equal(callLink(item, '/srv/acme'), null, JSON.stringify(item))
})
