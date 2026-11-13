// The owner's confirmations by passkey (#224): a gated action waits as a pending one until the
// window on http://localhost:<port> answers with the owner's passkey. The first passkey is added
// on trust; later adds and every removal need one already there. A confirmed send unlocks sending
// for 30 minutes, in memory only. The passkeys are for RP ID `localhost`: one of the tunnel's
// domain fails here, and a change of port keeps them.
import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { teamAuditFile, teamPasskeysFile } from '../../src/adapters/paths.ts'
import { readOwnerKeys } from '../../src/adapters/team-store.ts'
import { CONFIRM_MS, MAX_PENDING, UNLOCK_MS, widens } from '../../src/core/team-confirm.ts'
import { createTeamConfirm, type TeamConfirm } from '../../src/services/team-confirm.ts'
import { isolatedHome } from '../support/env.ts'
import { type SoftAuthenticator, softAuthenticator } from '../support/soft-authenticator.ts'

const SEND = { kind: 'send', to: 'A'.repeat(43), text: 'hi' } as const
const page = <T extends object>(credential: T): T & { type: 'public-key' } => ({ ...credential, type: 'public-key' })

function world(port = 12460) {
  isolatedHome()
  let clock = Date.UTC(2026, 10, 10, 12, 0, 0)
  const at = { port }
  const make = (): TeamConfirm => createTeamConfirm({ port: () => at.port, now: () => clock })
  return {
    at,
    make,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

const origin = (port: number): string => `http://localhost:${port}`

/** The window's read of `id`: its step and challenge. */
function read(c: TeamConfirm, id: string): { step: string; challenge: string } {
  const v = c.view(id)
  if (v === null || v === 'passkey') throw new Error(`no view: ${v}`)
  return { step: v.step, challenge: v.options.challenge as string }
}

/** Adds a passkey made by `key` through a pending add, on `port`. */
function addFirst(c: TeamConfirm, key: SoftAuthenticator, port = 12460) {
  const id = c.pend({ kind: 'passkey-add' })
  const { step, challenge } = read(c, id)
  expect(step).toBe('create')
  return c.answer(
    id,
    page(key.register({ challenge, origin: origin(port), rpId: 'localhost' })),
    'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0',
  )
}

/** Confirms a pending action with `key`'s assertion. */
function confirmWith(
  c: TeamConfirm,
  id: string,
  key: SoftAuthenticator,
  o: { port?: number; rpId?: string; counter?: number } = {},
) {
  const { challenge } = read(c, id)
  return c.answer(
    id,
    page(
      key.assert({ challenge, origin: origin(o.port ?? 12460), rpId: o.rpId ?? 'localhost', counter: o.counter ?? 1 }),
    ),
    null,
  )
}

test('no passkey yet: a gated action cannot be confirmed; the first one is added on trust, and audited', async () => {
  const w = world()
  const c = w.make()
  const key = await softAuthenticator(-7)
  expect(c.hasPasskey()).toBe(false)
  expect(c.view(c.pend(SEND))).toBe('passkey')
  expect(existsSync(teamPasskeysFile())).toBe(false)
  expect(addFirst(c, key)).toEqual({ ok: true, done: true, action: { kind: 'passkey-add' } })
  expect(c.hasPasskey()).toBe(true)
  expect(c.passkeys()).toEqual([{ id: key.id, label: expect.any(String), addedAt: expect.any(Number), usedAt: null }])
  const lines = readFileSync(teamAuditFile(), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  expect(lines.at(-1)).toMatchObject({ action: 'passkey', op: 'add', count: 1 })
})

test('a confirmed send is done once and unlocks sending for 30 minutes; trust and widening never unlock', async () => {
  const w = world()
  const c = w.make()
  const key = await softAuthenticator(-7)
  addFirst(c, key)
  const id = c.pend(SEND)
  const done = confirmWith(c, id, key)
  const token = (done as { unlock: string }).unlock
  expect(typeof token).toBe('string')
  expect(done).toEqual({ ok: true, done: true, action: SEND, unlock: token })
  expect(c.unlocked(token)).toBe(true)
  expect(c.unlocked('x'.repeat(43))).toBe(false)
  expect(c.unlocked(null)).toBe(false)
  // One use: the same id is gone.
  expect(c.view(id)).toBeNull()
  expect(c.answer(id, {}, null)).toEqual({ ok: false, error: 'gone' })
  w.tick(UNLOCK_MS - 1)
  expect(c.unlocked(token)).toBe(true)
  w.tick(1)
  expect(c.unlocked(token)).toBe(false)
  const trust = confirmWith(c, c.pend({ kind: 'trust', peer: 'B'.repeat(43) }), key, { counter: 3 })
  expect(trust).toEqual({ ok: true, done: true, action: { kind: 'trust', peer: 'B'.repeat(43) } })
  const widen = confirmWith(c, c.pend({ kind: 'agents', change: { off: false } }), key, { counter: 4 })
  expect(widen).not.toHaveProperty('unlock')
  // A held draft's send unlocks like Send.
  expect(confirmWith(c, c.pend({ kind: 'draft', id: 'd1' }), key, { counter: 5 })).toHaveProperty('unlock')
})

test('a restart forgets every unlock and every pending action; the passkeys stay', async () => {
  const w = world()
  const c = w.make()
  const key = await softAuthenticator(-7)
  addFirst(c, key)
  const token = (confirmWith(c, c.pend(SEND), key) as { unlock: string }).unlock
  const waiting = c.pend(SEND)
  const after = w.make()
  expect(after.unlocked(token)).toBe(false)
  expect(after.view(waiting)).toBeNull()
  expect(after.hasPasskey()).toBe(true)
})

test('refused: a replayed assertion, a wrong origin, the tunnel domain, an expired action, a key not added', async () => {
  const w = world()
  const c = w.make()
  const key = await softAuthenticator(-7)
  const stranger = await softAuthenticator(-7)
  addFirst(c, key)

  // A challenge serves one answer: the same assertion again is refused.
  const id = c.pend(SEND)
  const { challenge } = read(c, id)
  const once = page(key.assert({ challenge, origin: origin(12460), rpId: 'localhost', counter: 1 }))
  expect(c.answer(id, { ...once, id: 'nope', rawId: 'nope' }, null)).toEqual({ ok: false, error: 'passkey' })
  expect(c.answer(id, once, null)).toEqual({ ok: false, error: 'challenge' })
  // Read again for a fresh challenge: the old assertion does not fit it.
  read(c, id)
  expect(c.answer(id, once, null)).toEqual({ ok: false, error: 'challenge' })

  for (const [o, why] of [
    [{ port: 12461 }, 'origin'],
    [{ rpId: 'board.example.com' }, 'rpId'],
  ] as const)
    expect(confirmWith(c, c.pend(SEND), key, { ...o, counter: 9 })).toEqual({ ok: false, error: why })
  expect(confirmWith(c, c.pend(SEND), stranger)).toEqual({ ok: false, error: 'passkey' })

  const late = c.pend(SEND)
  w.tick(CONFIRM_MS + 1)
  expect(c.view(late)).toBeNull()
  expect(c.answer(late, {}, null)).toEqual({ ok: false, error: 'gone' })
})

test('a change of port keeps the passkeys: the RP ID is localhost, the port only in the origin', async () => {
  const w = world(12460)
  const c = w.make()
  const key = await softAuthenticator(-257)
  addFirst(c, key, 12460)
  w.at.port = 12470
  expect(confirmWith(c, c.pend(SEND), key, { port: 12470 })).toMatchObject({ ok: true, done: true })
})

test('a later passkey needs an assertion by one there is first; so does a removal; a race to be first loses', async () => {
  const w = world()
  const c = w.make()
  const first = await softAuthenticator(-7)
  const second = await softAuthenticator(-7)

  // Two windows read an add while there is none; the first to answer is the first passkey, the
  // other was read as a first add and is refused now.
  const a = c.pend({ kind: 'passkey-add' })
  const b = c.pend({ kind: 'passkey-add' })
  const ra = read(c, a)
  const rb = read(c, b)
  expect(
    c.answer(a, page(first.register({ challenge: ra.challenge, origin: origin(12460), rpId: 'localhost' })), null),
  ).toMatchObject({ ok: true, done: true })
  expect(
    c.answer(b, page(second.register({ challenge: rb.challenge, origin: origin(12460), rpId: 'localhost' })), null).ok,
  ).toBe(false)
  expect(readOwnerKeys().passkeys.map(p => p.id)).toEqual([first.id])

  // A later add: an assertion first, then the new passkey.
  const add = c.pend({ kind: 'passkey-add' })
  expect(read(c, add).step).toBe('get')
  expect(confirmWith(c, add, first)).toEqual({ ok: true, done: false })
  const { step, challenge } = read(c, add)
  expect(step).toBe('create')
  expect(
    c.answer(add, page(second.register({ challenge, origin: origin(12460), rpId: 'localhost' })), null),
  ).toMatchObject({ ok: true, done: true })
  expect(c.passkeys().map(p => p.id)).toEqual([first.id, second.id])

  // A removal is confirmed by a passkey, the removed one or another.
  expect(confirmWith(c, c.pend({ kind: 'passkey-remove', id: first.id }), second)).toMatchObject({
    ok: true,
    done: true,
  })
  expect(c.passkeys().map(p => p.id)).toEqual([second.id])
})

test('pending actions are capped: one a window is reading stays; the oldest nobody opened goes first', async () => {
  const w = world()
  const c = w.make()
  const key = await softAuthenticator(-7)
  addFirst(c, key)
  const owners = c.pend(SEND)
  read(c, owners)
  // A flood of requests nobody opens does not push out the one the owner is confirming.
  const flood = Array.from({ length: MAX_PENDING + 5 }, () => c.pend(SEND))
  expect(confirmWith(c, owners, key)).toMatchObject({ ok: true, done: true })
  expect(c.view(flood[0] as string)).toBeNull()
  expect(c.view(flood.at(-1) as string)).not.toBeNull()
})

test('what widens: on, a listener, a lane added; off, clearing, fewer lanes and muting do not', () => {
  const P = 'A'.repeat(43)
  const now = { off: false, peers: { [P]: { on: true, lanes: ['acme'] } } }
  expect(widens(now, { listener: { key: 'k' } })).toBe(true)
  expect(widens(now, { listener: null })).toBe(false)
  expect(widens({ ...now, off: true }, { off: false })).toBe(true)
  expect(widens(now, { off: false })).toBe(false)
  expect(widens(now, { off: true })).toBe(false)
  expect(widens(now, { peer: 'B'.repeat(43), on: true })).toBe(true)
  expect(widens(now, { peer: P, on: true })).toBe(false)
  expect(widens(now, { peer: P, on: false })).toBe(false)
  expect(widens(now, { peer: P, lanes: ['acme', 'zeta'] })).toBe(true)
  expect(widens(now, { peer: P, lanes: [] })).toBe(false)
  expect(widens(now, { peer: 'team', muted: false })).toBe(false)
  // #360: the loop pause, up or down or back to the default.
  for (const loop of [5, 100, null]) expect(widens(now, { peer: P, loop })).toBe(true)
})

// ---- The switch "Confirm with a passkey" (#367)

const fileOf = (): Record<string, unknown> => JSON.parse(readFileSync(teamPasskeysFile(), 'utf8'))

test('#367 off by default; on only once a passkey there confirms it; the first passkey added leaves it off', async () => {
  const w = world()
  const c = w.make()
  expect(c.required()).toBe(false)
  // No passkey to confirm with: the window has nothing to sign, and nothing is written.
  expect(c.view(c.pend({ kind: 'passkey-on' }))).toBe('passkey')
  expect(existsSync(teamPasskeysFile())).toBe(false)
  const key = await softAuthenticator(-7)
  addFirst(c, key)
  expect(c.required()).toBe(false)
  expect(fileOf().required).toBe(false)
  // Asked, not yet confirmed: still off. A passkey that cannot sign here leaves it so.
  const on = c.pend({ kind: 'passkey-on' })
  expect(read(c, on).step).toBe('get')
  expect(c.required()).toBe(false)
  expect(confirmWith(c, on, key)).toEqual({ ok: true, done: true, action: { kind: 'passkey-on' } })
  expect(c.required()).toBe(true)
  // Kept on disk: a restart keeps it on.
  expect(w.make().required()).toBe(true)
  const ops = readFileSync(teamAuditFile(), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
    .filter(l => l.action === 'passkey')
    .map(l => l.op)
  expect(ops).toEqual(['add', 'on'])
})

test('#367 the upgrade: a file with a passkey and no switch keeps it on; one without a passkey keeps it off', async () => {
  const w = world()
  const c = w.make()
  const key = await softAuthenticator(-7)
  addFirst(c, key)
  // As #224 wrote it: no `required` field.
  const { required: _, ...before } = fileOf()
  writeFileSync(teamPasskeysFile(), JSON.stringify(before))
  const after = w.make()
  expect(after.required()).toBe(true)
  expect(readOwnerKeys().required).toBe(true)
  // The first change of the file (a send confirmed notes the passkey's use) writes it down as it was.
  expect(confirmWith(after, after.pend(SEND), key).ok).toBe(true)
  expect(fileOf().required).toBe(true)
  // #224's file with no passkey: off.
  writeFileSync(teamPasskeysFile(), JSON.stringify({ v: 1, userId: null, passkeys: [] }))
  expect(w.make().required()).toBe(false)
})

test('#367 on and off are confirmed with a passkey; removing the last one turns it off; a hand-set switch with none is off', async () => {
  const w = world()
  const c = w.make()
  const key = await softAuthenticator(-7)
  addFirst(c, key)
  expect(confirmWith(c, c.pend({ kind: 'passkey-on' }), key, { counter: 1 }).ok).toBe(true)
  const off = c.pend({ kind: 'passkey-off' })
  expect(read(c, off).step).toBe('get')
  expect(c.required()).toBe(true)
  expect(confirmWith(c, off, key, { counter: 2 })).toEqual({ ok: true, done: true, action: { kind: 'passkey-off' } })
  expect(c.required()).toBe(false)
  expect(fileOf().required).toBe(false)

  expect(confirmWith(c, c.pend({ kind: 'passkey-on' }), key, { counter: 3 }).ok).toBe(true)
  const gone = c.pend({ kind: 'passkey-remove', id: key.id })
  expect(confirmWith(c, gone, key, { counter: 4 }).ok).toBe(true)
  expect(c.hasPasskey()).toBe(false)
  expect(c.required()).toBe(false)
  expect(fileOf().required).toBe(false)

  // A file that says on with no passkey (edited by hand) locks nobody out.
  writeFileSync(teamPasskeysFile(), JSON.stringify({ v: 1, userId: null, passkeys: [], required: true }))
  expect(c.required()).toBe(false)
})

test('#367 the WebAuthn options ask for the computer’s own authenticator first, on create and on get', async () => {
  const w = world()
  const c = w.make()
  const create = c.view(c.pend({ kind: 'passkey-add' }))
  if (create === null || create === 'passkey') throw new Error('no view')
  expect(create.step).toBe('create')
  expect(create.options.hints).toEqual(['client-device'])
  addFirst(c, await softAuthenticator(-7))
  const get = c.view(c.pend(SEND))
  if (get === null || get === 'passkey') throw new Error('no view')
  expect(get.step).toBe('get')
  expect(get.options.hints).toEqual(['client-device'])
})
