// joinHub's decisions (#356, services/team-join.ts) with scripted tries: when it tries again, when
// it stops, when it logs in instead, and what it says. The last test runs a real try against the
// hub in this process: the key is kept before the join goes out.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { generateKey, type KeyPair } from '../../src/core/team.ts'
import type { Reach } from '../../src/core/team-reach.ts'
import { type JoinDeps, joinHub, type Try, tryOnce } from '../../src/services/team-join.ts'
import { type Harness, startHarness } from '../hub/harness.ts'

let key: KeyPair
beforeAll(async () => {
  key = await generateKey()
})

const request = (keyWasSaved = false) => ({
  hub: 'wss://hub.example.com',
  invite: 'hab-x',
  name: 'anna',
  key,
  keyWasSaved,
})

const open: Reach = {
  host: 'hub.example.com',
  port: 443,
  secure: true,
  stepMs: 4000,
  literal: false,
  dns: { ok: true, ms: 5, addresses: [{ address: '203.0.113.5', family: 4 }] },
  tcp: [{ address: '203.0.113.5', family: 4, ok: true, ms: 9 }],
  tls: { address: '203.0.113.5', ok: true, ms: 20 },
}
const slowDns: Reach = { ...open, dns: { ok: false, ms: 4000, error: 'timeout', addresses: [] }, tcp: [], tls: null }
const noName: Reach = { ...open, dns: { ok: false, ms: 2, error: 'ENOTFOUND', addresses: [] }, tcp: [], tls: null }

const silent: Try = { ok: false, stage: 'connect', error: 'the connection did not open in 10 s', sent: false }
const lost: Try = { ok: false, stage: 'answer', error: 'the connection closed after the join went out', sent: true }
const refused = (code: string, message?: string): Try => ({
  ok: false,
  stage: 'answer',
  error: `the hub refused: ${code}`,
  sent: true,
  refused: { code, ...(message && { message }) },
})

/** Scripted tries, in order, by mode; what it said and did is kept. */
function script(tries: Partial<Record<'join' | 'auth', Try[]>>, probe: Reach = open) {
  const log: string[] = []
  const said: string[] = []
  const deps: JoinDeps = {
    tryMs: 10_000,
    tries: 3,
    probe: async () => {
      log.push('probe')
      return probe
    },
    say: line => said.push(line),
    pause: async () => {},
    attempt: async (_r, mode) => {
      log.push(mode)
      return tries[mode]?.shift() ?? { ok: true }
    },
  }
  return { deps, log, said }
}

describe('joinHub', () => {
  test('a first try that does not open, a way that is open: one more try, which joins', async () => {
    const s = script({ join: [silent] })
    expect(await joinHub(request(), s.deps)).toEqual({ ok: true, via: 'join' })
    expect(s.log).toEqual(['join', 'probe', 'join'])
    expect(s.said).toEqual([
      'try 1 of 3: the connection did not open in 10 s · DNS hub.example.com → 203.0.113.5 in 5 ms · TCP 203.0.113.5:443 ok in 9 ms · TLS ok in 20 ms; trying again',
    ])
  })

  test('a probe that only got no answer in time does not stop the tries (a slow first lookup)', async () => {
    const s = script({ join: [silent, silent] }, slowDns)
    expect(await joinHub(request(), s.deps)).toEqual({ ok: true, via: 'join' })
    expect(s.log).toEqual(['join', 'probe', 'join', 'probe', 'join'])
  })

  test('a name that does not exist: one try, and no more', async () => {
    const s = script({ join: [silent] }, noName)
    const r = await joinHub(request(), s.deps)
    expect(r).toEqual({
      ok: false,
      error:
        'cannot reach the hub at wss://hub.example.com: the connection did not open in 10 s · DNS hub.example.com: ENOTFOUND',
      unanswered: false,
    })
    expect(s.log).toEqual(['join', 'probe'])
  })

  test('three tries with no answer: it gives up and says the last', async () => {
    const s = script({ join: [silent, silent, silent] })
    const r = await joinHub(request(), s.deps)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toStartWith('the hub at wss://hub.example.com did not answer in 3 tries: ')
    expect(s.said).toHaveLength(2)
  })

  test('a join unanswered, then refused as a used invite: it logs in, and a welcome is a member', async () => {
    const s = script({ join: [lost, refused('invite_invalid')], auth: [{ ok: true }] })
    expect(await joinHub(request(), s.deps)).toEqual({ ok: true, via: 'auth' })
    expect(s.log).toEqual(['join', 'join', 'auth'])
  })

  test('the login then refused as unknown: the join never landed, the invite is the reason, nothing to keep', async () => {
    const s = script({ join: [lost, refused('invite_invalid')], auth: [refused('unknown_peer')] })
    expect(await joinHub(request(), s.deps)).toEqual({
      ok: false,
      error: 'the hub refused: invite_invalid',
      unanswered: false,
    })
  })

  test('the login refused as revoked: that is the reason given', async () => {
    const s = script({ join: [lost, refused('invite_invalid')], auth: [refused('revoked')] })
    expect(await joinHub(request(), s.deps)).toEqual({
      ok: false,
      error: 'the hub refused: revoked',
      unanswered: false,
    })
  })

  test('the login gets no answer either: the join may have landed, the key is worth keeping', async () => {
    const s = script({ join: [lost, refused('invite_invalid')], auth: [lost] })
    expect(await joinHub(request(), s.deps)).toEqual({
      ok: false,
      error: 'the hub refused: invite_invalid',
      unanswered: true,
    })
  })

  test('a key the board had: a member already logs in (with any invite); a fresh key with a bad invite does not', async () => {
    const member = script({ join: [refused('bad_frame', 'already a member; connect with auth')], auth: [{ ok: true }] })
    expect(await joinHub(request(true), member.deps)).toEqual({ ok: true, via: 'auth' })
    const fresh = script({ join: [refused('invite_invalid')] })
    expect(await joinHub(request(false), fresh.deps)).toEqual({
      ok: false,
      error: 'the hub refused: invite_invalid',
      unanswered: false,
    })
    expect(fresh.log).toEqual(['join'])
  })

  test('a name taken is final: no login, no other try', async () => {
    const s = script({ join: [lost, refused('name_taken')] })
    expect(await joinHub(request(), s.deps)).toEqual({
      ok: false,
      error: 'the hub refused: name_taken',
      unanswered: true,
    })
    expect(s.log).toEqual(['join', 'join'])
  })
})

describe('tryOnce against a hub', () => {
  let hub: Harness
  beforeAll(async () => {
    hub = await startHarness()
  })
  afterAll(() => hub.stop())

  test('beforeJoin runs before the join goes out: when it fails, no join reaches the hub', async () => {
    const invite = hub.invite()
    const r = { hub: hub.url.replace(/\/v1$/, ''), invite, name: 'early', key, keyWasSaved: false }
    const t = await tryOnce(r, 'join', 5000, async () => {
      throw new Error('disk full')
    })
    expect(t).toMatchObject({ ok: false, stage: 'answer', sent: false, error: 'the join did not go out: disk full' })
    // The invite is still open: the hub never saw that join.
    const other = await generateKey()
    ;(await hub.join(other, 'early', invite)).close()
  })

  test('with beforeJoin done, the join goes out and is welcomed', async () => {
    const order: string[] = []
    const r = { hub: hub.url.replace(/\/v1$/, ''), invite: hub.invite(), name: 'inorder', key, keyWasSaved: false }
    const t = await tryOnce(r, 'join', 5000, async () => {
      order.push('saved')
    })
    expect(t).toEqual({ ok: true })
    expect(order).toEqual(['saved'])
    await hub.login(key)
  })
})
