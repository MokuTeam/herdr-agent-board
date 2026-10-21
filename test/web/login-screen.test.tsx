// Signing in through the owner's own domain (components/remote/LoginScreen.tsx, models/login.ts)
// and the gate's second way in (components/remote/RemoteGate.tsx): hello says `auth: 'login'`, and
// the page shows the login screen until this browser is signed in: a passkey first, then a
// password and a code; after a password sign-in on a browser that made no passkey, the offer to
// add one with the next code. The board's answers are the tunnel listener's (server/tunnel.ts),
// faked; every POST carries X-Board, which that listener asks of every one (else 403 `origin`).
import { afterEach, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import { timeOf } from '../../src/core/when-format.ts'
import type { PasskeyCredentials } from '../../web/src/components/remote/LoginScreen.tsx'
import { type GateFlow, GateView, gateFlow } from '../../web/src/components/remote/RemoteGate.tsx'
import { loginNote, noteText } from '../../web/src/models/login.ts'
import { markPasskeyMade, passkeyMade } from '../../web/src/models/passkey.ts'
import { keptAuth, UNPAIRED } from '../../web/src/models/remote-page.ts'
import { board, renderInBoard } from './support/board.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { type Answer, answers, type Call, restoreFetch, sent } from './support/fetch-answers.ts'
import { type Element, find, findAll, hasClass, type Node } from './support/markup.ts'
import { clone, commit, first } from './support/react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './support/react-events.ts'

const t = translator('en')
const VP = { w: 820, h: 1180 }

afterEach(restoreFetch)

/** hello through the domain (server/tunnel.ts): nothing but these fields. */
const hello = (signedIn: boolean) => ({ board: 'agent-board', api: 3, auth: 'login', signedIn, language: 'en' })
const HELLO_GET = ['/api/hello', undefined, undefined, undefined]

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))

/**
 * `node` as React draws it in the page's providers. react-dom/server hoists a
 * `<link rel="preload" as="image">` for the app's icon; a page drawn in the browser gets none.
 */
const drawnOf = (node: ReactNode): Node[] =>
  renderInBoard(node, board()).filter(
    n => !(n.kind === 'element' && n.tag === 'link' && n.attrs.get('rel') === 'preload'),
  )

/** A tablet's browser; one that can use passkeys has PublicKeyCredential. */
function browser(passkeys: boolean): FakeWorld {
  const world = new FakeWorld({ viewport: VP })
  world.install()
  if (passkeys) Object.assign(world.window, { PublicKeyCredential: class PublicKeyCredential {} })
  return world
}

/** Each POST carried X-Board and JSON's content type, as the tunnel listener asks of every one. */
function boardHeaders(calls: Call[]): void {
  const posts = calls.filter(c => c.init?.method === 'POST')
  const headers = (c: Call) => {
    const h = c.init?.headers as Record<string, string> | undefined
    return [c.url, h?.['x-board'], h?.['content-type']]
  }
  expect(posts.length).toBeGreaterThan(0)
  expect(posts.map(headers)).toEqual(posts.map(c => [c.url, '1', 'application/json']))
}

/**
 * The gate live in `world`: its markup drawn into a fake DOM with React's handlers on it
 * (support/react-events.ts) and drawn again after every event, as React would; the board behind it
 * is a <p class="the-board">.
 */
function liveGate(world: FakeWorld, credentials?: PasskeyCredentials) {
  const gate = gateFlow({ follow() {}, ...(credentials && { credentials: () => credentials }) })
  const tree = () => (
    <div className="page">
      <GateView now={gate.view.get()} login={gate.login.view.get()} on={gate} t={t}>
        <p className="the-board">The board</p>
      </GateView>
    </div>
  )
  let drawn: { el: FakeElement; markup: Element; hosts: Host[] } | null = null
  const draw = () => {
    const node = tree()
    const next = first(drawnOf(node))
    const hosts = hostElements(node)
    if (!drawn) drawn = { el: world.mount(clone(next)), markup: next, hosts }
    else {
      commit(world, drawn.el.node, drawn.markup, next)
      drawn = { el: drawn.el, markup: next, hosts }
    }
  }
  draw()
  world.afterFlush = draw
  const stop = listenLikeReact(
    world.wrap(world.body),
    () => drawn?.el ?? null,
    () => drawn?.hosts ?? [],
  )
  const page = (): FakeElement => {
    if (!drawn) throw new Error('nothing drawn')
    return drawn.el
  }
  const pick = (selector: string): FakeElement => {
    const el = page().querySelector(selector)
    if (!el) throw new Error(`no ${selector}`)
    return el
  }
  /** The board's answers and what follows them come in (no time passes). */
  const idle = async () => {
    for (let i = 0; i < 12; i++) {
      await Bun.sleep(0)
      await world.flush()
    }
  }
  return {
    gate,
    /** hello asked again (the page shown again, back from another app). */
    async check() {
      await gate.check()
      await idle()
    },
    title: () => page().querySelector('h1')?.textContent ?? null,
    note: () => page().querySelector('[role="status"]')?.textContent ?? null,
    text: () => page().textContent,
    board: () => page().querySelector('.the-board') !== null,
    buttons: () =>
      page()
        .querySelectorAll('button')
        .map(b => b.textContent),
    value: (selector: string) => pick(selector).value,
    async type(selector: string, text: string) {
      const field = pick(selector)
      field.value = text
      await world.fire(field, 'input')
      await idle()
    },
    async click(label: string) {
      const button = page()
        .querySelectorAll('button')
        .find(b => b.textContent === label)
      if (!button) throw new Error(`no button ${label}`)
      await world.fire(button, 'click')
      await idle()
    },
    async submit() {
      await world.fire(pick('form'), 'submit')
      await idle()
    },
    dispose() {
      stop()
      world.afterFlush = null
    },
  }
}

/** Runs `body` on a live gate in a browser of its own, put away after. */
async function onGate(
  options: { passkeys: boolean; credentials?: PasskeyCredentials },
  body: (live: ReturnType<typeof liveGate>, world: FakeWorld) => Promise<void>,
): Promise<void> {
  const world = browser(options.passkeys)
  const live = liveGate(world, options.credentials)
  try {
    await body(live, world)
  } finally {
    live.dispose()
    world.uninstall()
  }
}

// ---------------------------------------------------------------- the screen

/** The gate's login screen as its flow stands. */
const loginScreen = (gate: GateFlow): Node[] =>
  drawnOf(
    <GateView now={{ gate: 'login', hello: null }} login={gate.login.view.get()} on={gate} t={t}>
      {null}
    </GateView>,
  )

test('the login screen: a passkey first, then a password and a code in a form a password manager knows', () => {
  const world = browser(true)
  try {
    const gate = gateFlow({ follow() {} })
    const start = loginScreen(gate)
    // The pairing screen's parts: the screen, its card, the app's icon, the install line under it.
    const main = first(start)
    expect([main.tag, main.attrs.get('class')]).toEqual(['main', 'phone-screen'])
    expect(findAll(start, el => hasClass(el, 'phone-card'))).toHaveLength(1)
    expect(findAll(start, el => hasClass(el, 'phone-icon')).map(el => el.attrs.get('src'))).toEqual(['icon.svg'])
    expect(textOf(find(start, el => hasClass(el, 'phone-foot')))).toBe(t('pair.install'))
    expect(textOf(find(start, el => el.tag === 'h1'))).toBe('Sign in to the board')
    expect(findAll(start, el => el.tag === 'button').map(b => [textOf(b), hasClass(b, 'primary')])).toEqual([
      ['Sign in with a passkey', true],
      ['Use password and code', false],
    ])
    expect(findAll(start, el => el.tag === 'form')).toEqual([])

    // "Use password and code": the form, its user name hidden, the code a one-time code in digits.
    gate.login.openForm()
    const open = loginScreen(gate)
    const form = find(open, el => el.tag === 'form')
    const fields = findAll([form], el => el.tag === 'input').map(el =>
      ['name', 'type', 'autocomplete', 'inputmode', 'hidden', 'value'].map(a => el.attrs.get(a) ?? null),
    )
    expect(fields).toEqual([
      ['username', 'text', 'username', null, '', 'owner'],
      ['password', 'password', 'current-password', null, null, ''],
      ['code', 'text', 'one-time-code', 'numeric', null, ''],
    ])
    expect(findAll(open, el => el.tag === 'button').map(b => [textOf(b), b.attrs.get('type')])).toEqual([
      ['Sign in with a passkey', 'button'],
      ['Sign in', 'submit'],
    ])
  } finally {
    world.uninstall()
  }

  // A browser that cannot use passkeys: the form at once, nothing else to press.
  const plain = browser(false)
  try {
    const start = loginScreen(gateFlow({ follow() {} }))
    expect(findAll(start, el => el.tag === 'button').map(textOf)).toEqual(['Sign in'])
    expect(findAll(start, el => el.tag === 'input').map(el => el.attrs.get('autocomplete'))).toEqual([
      'username',
      'current-password',
      'one-time-code',
    ])
  } finally {
    plain.uninstall()
  }
})

test("a sign-in's failure as the board answers it, and what the screen says of it", () => {
  expect(loginNote(401, { ok: false, error: 'wrong' }, null)).toEqual({ kind: 'wrong' })
  expect(loginNote(423, { ok: false, error: 'locked', until: 5 }, null)).toEqual({ kind: 'locked', until: 5 })
  expect(loginNote(429, { ok: false, error: 'limited' }, '30')).toEqual({ kind: 'limited', retryAfterS: 30 })
  expect(loginNote(200, { ok: true, method: 'password' }, null)).toBeNull()
  // A limit without Retry-After: the body's seconds, else a minute.
  expect(loginNote(429, { ok: false, error: 'limited', retryAfterS: 12 }, null)).toEqual({
    kind: 'limited',
    retryAfterS: 12,
  })
  expect(loginNote(429, null, 'soon')).toEqual({ kind: 'limited', retryAfterS: 60 })
  // Anything else: the board's reason, else the status.
  expect(loginNote(403, { ok: false, error: 'origin' }, null)).toEqual({ kind: 'failed', why: 'origin' })
  expect(loginNote(502, 'Bad Gateway', null)).toEqual({ kind: 'failed', why: '502' })
  expect(loginNote(423, { ok: false, error: 'locked' }, null)).toEqual({ kind: 'failed', why: 'locked' })

  const ru = translator('ru')
  const until = new Date(2026, 9, 20, 14, 5).getTime()
  expect(noteText({ kind: 'wrong' }, t)).toBe('Wrong password or code.')
  expect(noteText({ kind: 'wrong' }, ru)).toBe('Неверный пароль или код.')
  expect(noteText({ kind: 'locked', until }, t)).toBe(
    `Too many failed tries: sign-in is locked until ${timeOf(until, t)}.`,
  )
  expect(noteText({ kind: 'limited', retryAfterS: 30 }, t)).toBe('Too many tries. Try again in 30 s.')
  expect(noteText({ kind: 'failed', why: 'origin' }, t)).toBe('Could not sign in: origin')
  expect(noteText({ kind: 'passkey' }, t)).toBe('The board did not accept this passkey.')
  expect(noteText({ kind: 'wrongCode' }, t)).toBe('That is not the next code.')
  expect(noteText({ kind: 'addFailed', why: 'origin' }, t)).toBe('Could not add the passkey: origin')
  // The offer's note, word for word (Call 34).
  expect(t('login.addNote')).toBe('Enter the next code: the one you signed in with works once only.')
  expect(ru('login.addNote')).toBe('Введите следующий код: тот, с которым вы вошли, срабатывает только один раз.')
})

// ---------------------------------------------------------------- live, with a fake board

test('a password and a code: a wrong pair says so; the right one offers a passkey; Not now gives the board', async () => {
  const calls = answers(
    [200, hello(false)],
    [401, { ok: false, error: 'wrong' }],
    [200, { ok: true, method: 'password' }],
    // Back from the authenticator app for the next code: the board is signed in, the offer stays.
    [200, hello(true)],
    // Not now.
    [200, hello(true)],
  )
  await onGate({ passkeys: true }, async live => {
    await live.check()
    expect(live.title()).toBe('Sign in to the board')
    expect(keptAuth()).toBe('login')
    await live.click('Use password and code')
    await live.type('input[name="password"]', 'correct horse battery')
    await live.type('input[name="code"]', '123 456')
    await live.submit()
    expect(live.note()).toBe('Wrong password or code.')
    expect(live.board()).toBe(false)

    await live.submit()
    expect(live.title()).toBe('Add a passkey for this device')
    expect(live.text()).toContain('Enter the next code: the one you signed in with works once only.')
    expect(live.note()).toBeNull()
    expect(live.buttons()).toEqual(['Add', 'Not now'])
    await live.check()
    expect(live.title()).toBe('Add a passkey for this device')
    expect(live.board()).toBe(false)

    await live.click('Not now')
    expect(live.board()).toBe(true)
    expect(passkeyMade()).toBe(false)
  })
  expect(sent(calls)).toEqual([
    HELLO_GET,
    ['/api/login/password', 'POST', '1', { password: 'correct horse battery', code: '123456' }],
    ['/api/login/password', 'POST', '1', { password: 'correct horse battery', code: '123456' }],
    HELLO_GET,
    HELLO_GET,
  ])
  boardHeaders(calls)
})

test('a password sign-in where a passkey was made here, or cannot be: straight to the board', async () => {
  for (const passkeys of [true, false]) {
    const calls = answers([200, hello(false)], [200, { ok: true, method: 'password' }], [200, hello(true)])
    await onGate({ passkeys }, async live => {
      if (passkeys) markPasskeyMade()
      await live.check()
      if (passkeys) await live.click('Use password and code')
      await live.type('input[name="password"]', 'correct horse battery')
      await live.type('input[name="code"]', '123456')
      await live.submit()
      expect([passkeys, live.board()]).toEqual([passkeys, true])
    })
    expect(sent(calls)).toEqual([
      HELLO_GET,
      ['/api/login/password', 'POST', '1', { password: 'correct horse battery', code: '123456' }],
      HELLO_GET,
    ])
    boardHeaders(calls)
  }
})

test('locked, limited, no connection: one note each, with the time, the seconds or the reason', async () => {
  const until = Date.now() + 60_000
  const calls = answers(
    [200, hello(false)],
    [423, { ok: false, error: 'locked', until }],
    [429, { ok: false, error: 'limited' }, { 'Retry-After': '30' }],
    new TypeError('Failed to fetch'),
  )
  await onGate({ passkeys: false }, async live => {
    await live.check()
    await live.type('input[name="password"]', 'correct horse battery')
    await live.type('input[name="code"]', '123456')
    await live.submit()
    expect(live.note()).toBe(`Too many failed tries: sign-in is locked until ${timeOf(until, t)}.`)
    await live.submit()
    expect(live.note()).toBe('Too many tries. Try again in 30 s.')
    await live.submit()
    expect(live.note()).toBe('Could not sign in: Failed to fetch')
    expect(live.board()).toBe(false)
  })
  boardHeaders(calls)
})

const REQUEST = { challenge: 'Y2hhbGxlbmdl', rpId: 'board.example.com', timeout: 120000, userVerification: 'required' }
const buffer = (...bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer
const bytesOf = (value: unknown): number[] => (value instanceof ArrayBuffer ? [...new Uint8Array(value)] : [])
const ascii = (text: string): number[] => [...text].map(c => c.charCodeAt(0))

test('a passkey: one tap signs in; cancelled says nothing; one the board does not accept says so', async () => {
  const asked: CredentialRequestOptions[] = []
  const assertion = {
    id: '-_8A',
    rawId: buffer(0xfb, 0xff, 0x00),
    type: 'public-key',
    response: { clientDataJSON: buffer(1, 2), authenticatorData: buffer(3), signature: buffer(4), userHandle: null },
  }
  const replies: (() => unknown)[] = [
    () => {
      throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError')
    },
    () => assertion,
    () => assertion,
  ]
  const credentials: PasskeyCredentials = {
    get: async options => {
      if (options) asked.push(options)
      return (replies.shift() ?? (() => null))() as Credential
    },
    create: async () => null,
  }
  const calls = answers(
    [200, hello(false)],
    [200, REQUEST],
    [200, REQUEST],
    [401, { ok: false, error: 'wrong' }],
    [200, REQUEST],
    [200, { ok: true, method: 'passkey' }],
    [200, hello(true)],
  )
  await onGate({ passkeys: true, credentials }, async live => {
    await live.check()
    await live.click('Sign in with a passkey')
    expect([live.note(), live.board()]).toEqual([null, false])
    await live.click('Sign in with a passkey')
    expect(live.note()).toBe('The board did not accept this passkey.')
    await live.click('Sign in with a passkey')
    expect(live.board()).toBe(true)
  })
  const publicKey = asked[0]?.publicKey
  expect(bytesOf(publicKey?.challenge)).toEqual(ascii('challenge'))
  expect([publicKey?.rpId, publicKey?.timeout, publicKey?.userVerification]).toEqual([
    'board.example.com',
    120000,
    'required',
  ])
  const signedWith = {
    id: '-_8A',
    rawId: '-_8A',
    type: 'public-key',
    response: { clientDataJSON: 'AQI', authenticatorData: 'Aw', signature: 'BA', userHandle: null },
  }
  expect(sent(calls)).toEqual([
    HELLO_GET,
    ['/api/login/passkey/options', 'POST', '1', {}],
    ['/api/login/passkey/options', 'POST', '1', {}],
    ['/api/login/passkey', 'POST', '1', signedWith],
    ['/api/login/passkey/options', 'POST', '1', {}],
    ['/api/login/passkey', 'POST', '1', signedWith],
    HELLO_GET,
  ])
  boardHeaders(calls)
})

test('adding a passkey after a password sign-in: the code used to sign in is refused; the next one adds it here', async () => {
  const CREATE = {
    challenge: 'Y2hhbGxlbmdl',
    rp: { id: 'board.example.com', name: 'Agent board' },
    user: { id: 'dGVzdC11c2VyLWlkLTAwMQ', name: 'owner', displayName: 'Agent board' },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    excludeCredentials: [],
    timeout: 120000,
  }
  const made: CredentialCreationOptions[] = []
  const credentials: PasskeyCredentials = {
    get: async () => null,
    create: async options => {
      if (options) made.push(options)
      return {
        id: 'AQID',
        rawId: buffer(1, 2, 3),
        type: 'public-key',
        response: { clientDataJSON: buffer(1, 2), attestationObject: buffer(0xa3), getTransports: () => ['internal'] },
      } as unknown as Credential
    },
  }
  const calls = answers(
    [200, hello(false)],
    [200, { ok: true, method: 'password' }],
    [403, { ok: false, error: 'code' }],
    [200, CREATE],
    [200, { ok: true, id: 'AQID' }],
    [200, hello(true)],
  )
  await onGate({ passkeys: true, credentials }, async live => {
    await live.check()
    await live.click('Use password and code')
    await live.type('input[name="password"]', 'correct horse battery')
    await live.type('input[name="code"]', '123456')
    await live.submit()
    expect(live.title()).toBe('Add a passkey for this device')
    // The offer's own field for the next code, empty; the password is not kept.
    expect(live.value('input[name="code"]')).toBe('')
    expect(live.gate.login.view.get().fields.password).toBe('')
    await live.type('input[name="code"]', '123456')
    await live.submit()
    expect(live.note()).toBe('That is not the next code.')
    expect(made).toEqual([])
    await live.type('input[name="code"]', '654321')
    await live.submit()
    expect(live.board()).toBe(true)
    expect(passkeyMade()).toBe(true)
  })
  const publicKey = made[0]?.publicKey
  expect(bytesOf(publicKey?.challenge)).toEqual(ascii('challenge'))
  expect(bytesOf(publicKey?.user.id)).toEqual(ascii('test-user-id-001'))
  expect(sent(calls)).toEqual([
    HELLO_GET,
    ['/api/login/password', 'POST', '1', { password: 'correct horse battery', code: '123456' }],
    ['/api/login/passkey/add/options', 'POST', '1', { code: '123456' }],
    ['/api/login/passkey/add/options', 'POST', '1', { code: '654321' }],
    [
      '/api/login/passkey/add',
      'POST',
      '1',
      {
        id: 'AQID',
        rawId: 'AQID',
        type: 'public-key',
        response: { clientDataJSON: 'AQI', attestationObject: 'ow', transports: ['internal'] },
      },
    ],
    HELLO_GET,
  ])
  boardHeaders(calls)
})

// ---------------------------------------------------------------- the gate

test('the gate: through the domain, the login screen until signed in, then the board; offline and refused say it without Tailscale', async () => {
  const world = browser(false)
  try {
    const gate = gateFlow({ follow() {} })
    const shown = () =>
      drawnOf(
        <GateView now={gate.view.get()} login={gate.login.view.get()} on={gate} t={t}>
          <p className="the-board">The board</p>
        </GateView>,
      )
        .map(textOf)
        .join('')
    answers([200, hello(false)])
    await gate.check()
    expect(gate.view.get().gate).toBe('login')
    expect(shown()).toContain('Sign in to the board')
    expect(keptAuth()).toBe('login')

    // The computer away (Caddy answers 502), or no network at all: the domain's own text.
    for (const reply of [[502, 'Bad Gateway'] as [number, unknown], new TypeError('Failed to fetch')]) {
      answers(reply)
      await gate.check()
      expect(gate.view.get().gate).toBe('offline')
      expect(shown()).toContain('The computer may be asleep, or the board closed. This page tries again by itself.')
      expect(shown()).not.toContain('Tailscale')
    }
    // Refused (not the board's host): the domain's own text too.
    answers([403, { error: 'host' }])
    await gate.check()
    expect(gate.view.get().gate).toBe('refused')
    expect(shown()).toContain('This address does not reach the board.')
    expect(shown()).not.toContain('Tailscale')

    answers([200, hello(true)])
    await gate.check()
    expect(shown()).toBe('The board')
    // The board on show stays through a check with no answer or a refusal (gateAfter, #108).
    for (const reply of [[502, 'Bad Gateway'], new TypeError('Failed to fetch'), [403, {}]] as Answer[]) {
      answers(reply)
      await gate.check()
      expect(shown()).toBe('The board')
    }

    // Through Tailscale (hello without auth): pairing, and its own texts, as today.
    answers([200, { board: 'agent-board', host: 'BOX', paired: false }])
    await gate.check()
    expect(gate.view.get().gate).toBe('pair')
    expect(keptAuth()).toBe('pair')
    expect(shown()).toContain('Use this board on your phone')
    answers([502, 'Bad Gateway'])
    await gate.check()
    expect(shown()).toContain('Check that Tailscale is on on this phone')
    answers([403, { error: 'user' }])
    await gate.check()
    expect(shown()).toContain("This board does not let in this phone's Tailscale user.")
    answers([200, { board: 'agent-board', host: 'BOX', paired: true }])
    await gate.check()
    expect(shown()).toBe('The board')
  } finally {
    world.uninstall()
  }
})

test('a login that ends (Sign out, or ended on the computer) goes back to the login screen, from its start', async () => {
  const world = browser(true)
  answers([200, hello(true)], [200, hello(false)])
  const gate = gateFlow({ follow() {} })
  const settle = async () => {
    for (let i = 0; i < 12; i++) await Bun.sleep(0)
  }
  const stop = gate.start()
  try {
    await settle()
    expect(gate.view.get().gate).toBe('board')
    // Typed earlier, before the board showed: none of it stays.
    gate.login.openForm()
    gate.login.type('password', 'correct horse battery')
    await world.fire(world.window, UNPAIRED)
    await settle()
    expect(gate.view.get().gate).toBe('login')
    expect(gate.login.view.get()).toEqual({
      step: 'start',
      form: false,
      fields: { password: '', code: '', next: '' },
      busy: false,
      note: null,
    })
  } finally {
    stop()
    world.uninstall()
  }
})
