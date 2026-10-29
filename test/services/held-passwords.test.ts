// The server's passwords remembered by the local board (services/held-passwords.ts), and how
// Remote access uses them (services/remote-access.ts): held once a login with them went through,
// filled into every server action that carries none, 30 minutes since their last use (each use
// counting again), dropped when the server refuses them and on "Forget the password"; the view
// has until when only, and no answer ever holds one.
import { describe, expect, test } from 'bun:test'
import type { Config } from '../../src/core/types.ts'
import { HOLD_MS, heldPasswords } from '../../src/services/held-passwords.ts'
import type { ProfileSync } from '../../src/services/profile-sync.ts'
import { createRemoteAccess, type RemoteAccessDeps } from '../../src/services/remote-access.ts'
import type { ServerSetup } from '../../src/services/server-setup.ts'

const T0 = 1_800_000_000_000
const MIN = 60_000
const OK = { status: 200, body: { ok: true } }
const WRONG_LOGIN = {
  status: 409,
  body: { ok: false, hint: 'wrongLogin', error: 'Permission denied', need: 'password' },
}
const WRONG_SUDO = {
  status: 409,
  body: { ok: false, hint: 'wrongPassword', error: 'sudo: 1 incorrect', need: 'sudoPassword' },
}
const NETWORK = { status: 409, body: { ok: false, hint: 'network', error: 'no route' } }

function clock() {
  let at = T0
  return { now: () => at, pass: (ms: number) => (at += ms) }
}

describe('the passwords held', () => {
  test('none held: the request goes as it is, the view says none', () => {
    const held = heldPasswords(clock().now)
    const body = { op: 'server-look' }
    expect(held.fill(body)).toBe(body)
    expect(held.view()).toBeNull()
  })

  test('held once a login with them went through; used, extended; over 30 minutes after the last use', () => {
    const c = clock()
    const held = heldPasswords(c.now)
    held.settle({ password: 'pw', sudoPassword: 'sudo' }, OK, true)
    expect(held.view()).toEqual({ until: T0 + HOLD_MS })
    c.pass(10 * MIN)
    expect(held.fill({ op: 'sync-dirs', path: '' })).toEqual({
      op: 'sync-dirs',
      path: '',
      password: 'pw',
      sudoPassword: 'sudo',
    })
    // the use counts again
    expect(held.view()).toEqual({ until: T0 + 10 * MIN + HOLD_MS })
    c.pass(HOLD_MS - 1)
    expect(held.fill({}).password).toBe('pw')
    c.pass(HOLD_MS)
    expect(held.view()).toBeNull()
    expect(held.fill({})).toEqual({})
  })

  test('a password the request carries wins; only the missing one is filled', () => {
    const held = heldPasswords(clock().now)
    held.settle({ password: 'pw', sudoPassword: 'sudo' }, OK, true)
    expect(held.fill({ password: 'new' })).toEqual({ password: 'new', sudoPassword: 'sudo' })
    expect(held.fill({ password: '', sudoPassword: null })).toEqual({ password: 'pw', sudoPassword: 'sudo' })
  })

  test('refused: a wrong login drops both, a wrong sudo its own; one typed and refused is never held', () => {
    const held = heldPasswords(clock().now)
    held.settle({ password: 'typo' }, WRONG_LOGIN, true)
    expect(held.view()).toBeNull()
    held.settle({ password: 'pw', sudoPassword: 'sudo' }, OK, true)
    held.settle({ password: 'pw', sudoPassword: 'sudo' }, WRONG_SUDO, true)
    expect(held.fill({})).toEqual({ password: 'pw' })
    held.settle({ password: 'pw' }, WRONG_LOGIN, true)
    expect(held.view()).toBeNull()
    // another refusal (the network) leaves what is held as it is
    held.settle({ password: 'pw' }, OK, true)
    held.settle({ password: 'pw' }, NETWORK, true)
    expect(held.fill({}).password).toBe('pw')
  })

  test('not held: an answer that proves no login, a malformed one, none typed; Forget drops them', () => {
    const held = heldPasswords(clock().now)
    held.settle({ password: 'pw' }, OK, false)
    held.settle({ password: 'a\nb' }, OK, true)
    held.settle({}, OK, true)
    expect(held.view()).toBeNull()
    expect(held.forget()).toBe(false)
    held.settle({ password: 'pw' }, OK, true)
    expect(held.forget()).toBe(true)
    expect(held.view()).toBeNull()
    expect(held.fill({})).toEqual({})
  })
})

/** A service whose every call is recorded with the request it got, answering `answer()`. */
function fake<T>(answer: () => { status: number; body: unknown }, calls: [string, Record<string, unknown>][] = []) {
  const service = new Proxy(
    {},
    {
      get: (_, name) => async (b?: Record<string, unknown>) => {
        calls.push([String(name), b ?? {}])
        return answer()
      },
    },
  ) as T
  return { service, calls }
}

function board() {
  const c = clock()
  let next: { status: number; body: unknown } = OK
  const calls: [string, Record<string, unknown>][] = []
  const server = fake<ServerSetup>(() => next, calls)
  const sync = fake<ProfileSync>(() => next, calls)
  let changes = 0
  const held = heldPasswords(c.now)
  const deps = {
    cfg: { tunnel: {} } as unknown as Config,
    webPort: 1,
    access: {} as RemoteAccessDeps['access'],
    supervisor: {} as RemoteAccessDeps['supervisor'],
    tunnel: { listening: () => null },
    server: server.service,
    sync: sync.service,
    held,
    onChange: () => changes++,
  } satisfies RemoteAccessDeps
  const r = createRemoteAccess(deps)
  return {
    r,
    c,
    held,
    server,
    sync,
    answer: (a: { status: number; body: unknown }) => (next = a),
    changes: () => changes,
    /** What the service last got. */
    last: () => calls.at(-1)?.[1] ?? {},
  }
}

describe('every server action, with the password held', () => {
  test('typed once at Look: held, then filled into Apply, the sync and the folder listing; the view changes', async () => {
    const b = board()
    expect(await b.r.op({ op: 'server-look', password: 'pw' })).toEqual(OK)
    expect(b.held.view()).toEqual({ until: T0 + HOLD_MS })
    expect(b.changes()).toBeGreaterThan(0)
    for (const op of [
      'server-apply',
      'server-undo-look',
      'server-undo',
      'server-install-look',
      'server-install',
      'sync-look',
      'sync-pair',
      'sync-rules',
      'sync-dirs',
      'sync-mkdir',
      'sync-apply',
    ]) {
      const answer = await b.r.op({ op })
      expect(b.last().password).toBe('pw')
      // never in an answer
      expect(JSON.stringify(answer)).not.toContain('pw')
    }
    // the tunnel's own settings and the admin's fields never get it
    await b.r.op({ op: 'server-admin', user: 'root' })
    expect(b.server.calls.at(-1)).toEqual(['admin', { op: 'server-admin', user: 'root' }])
  })

  test('refused by the server: dropped, the next action asks again', async () => {
    const b = board()
    await b.r.op({ op: 'sync-look', direction: 'up', password: 'pw' })
    b.answer(WRONG_LOGIN)
    await b.r.op({ op: 'server-look' })
    expect(b.held.view()).toBeNull()
    b.answer(OK)
    await b.r.op({ op: 'server-look' })
    expect(b.last().password).toBeUndefined()
  })

  test('Forget the password: dropped at once, its answer ok and nothing more; the view changes', async () => {
    const b = board()
    await b.r.op({ op: 'server-look', password: 'pw', sudoPassword: 'sudo' })
    const before = b.changes()
    expect(await b.r.op({ op: 'server-password-forget' })).toEqual(OK)
    expect(b.changes()).toBe(before + 1)
    expect(b.held.view()).toBeNull()
    await b.r.op({ op: 'server-apply' })
    expect(b.last()).toEqual({ op: 'server-apply' })
  })

  test('30 minutes after its last use: gone, the request goes with none', async () => {
    const b = board()
    await b.r.op({ op: 'server-look', password: 'pw' })
    b.c.pass(29 * MIN)
    await b.r.op({ op: 'sync-dirs' })
    expect(b.last().password).toBe('pw')
    b.c.pass(30 * MIN)
    await b.r.op({ op: 'sync-dirs' })
    expect(b.last().password).toBeUndefined()
  })
})
