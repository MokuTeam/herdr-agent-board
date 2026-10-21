// The Remote access panel's Login parts, under its Tunnel part (components/access/LoginSection.tsx,
// LoginsSection.tsx): the password and the code set up on the local board (the code's QR and its
// key shown once, from totp-begin's own answer, and dropped once checked or closed), the passkeys
// listed and removed, the lockout lifted; then the logins through the domain, ended one by one or
// all, and the recent failed attempts. Every change is a POST /api/access `{ op, … }` with the
// board's header; what the board refuses is toasted.
import { afterEach, expect, test } from 'bun:test'
import type { AccessView } from '../../src/core/access.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { TUNNEL_SOCKET } from '../../src/core/tunnel.ts'
import { longWhen, shortWhen } from '../../src/core/when-format.ts'
import { AccessBody } from '../../web/src/components/access/AccessPanel.tsx'
import { LoginSection } from '../../web/src/components/access/LoginSection.tsx'
import { LoginsSection } from '../../web/src/components/access/LoginsSection.tsx'
import { accessSource } from '../../web/src/hooks/useAccess.ts'
import {
  attemptLine,
  groupKey,
  isAccessView,
  type LoginAsk,
  loginAsk,
  loginLine,
  passkeyLine,
  type TunnelAsk,
  tunnelAsk,
} from '../../web/src/models/access.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { SECRET_B32 } from '../support/tunnel-board.ts'
import { board, renderInBoard } from './support/board.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { type Element, find, findAll, hasClass, type Node } from './support/markup.ts'
import { clone, commit, first } from './support/react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './support/react-events.ts'

const t = translator('en')
const ru = translator('ru')
const VP = { w: 1600, h: 1000 }
const MIN = 60_000
/** The page's clock: Wednesday afternoon. */
const NOW = new Date(2026, 9, 21, 15, 0).getTime()

afterEach(restoreFetch)

/** The tunnel set up, the login not: the domain is known. */
const BARE: AccessView = {
  tunnel: {
    settings: {
      on: false,
      host: 'ssh.example.com',
      sshPort: 22,
      user: 'boardtunnel',
      key: '',
      socket: TUNNEL_SOCKET,
      domain: 'board.example.com',
      port: null,
    },
    problems: [],
    blocked: 'Set up the password and the code first',
    listenPort: 12424,
    status: { state: 'off', since: NOW - 60 * MIN },
    ssh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    key: {
      path: 'C:\\Users\\Иван Петров\\tunnel\\id_ed25519',
      generated: true,
      exists: false,
      publicKey: null,
      error: null,
    },
    hostKey: null,
  },
  login: { password: false, totp: false, passkeys: [], lockout: null },
  logins: [],
  attempts: [],
}

const IPAD_ADDED = new Date(2026, 9, 18, 10, 0).getTime()
const HELLO_ADDED = NOW - 120 * MIN
const UNTIL = NOW + 30 * MIN
const PHONE_IN = new Date(2026, 9, 19, 9, 30).getTime()

/** Set up: two passkeys (one used), a lockout, two logins, three failed attempts (newest first, as the board sends them). */
const SET: AccessView = {
  ...BARE,
  login: {
    password: true,
    totp: true,
    passkeys: [
      { id: 'cred-ipad', label: 'Safari on iPad', addedAt: IPAD_ADDED, usedAt: NOW - 5 * MIN },
      { id: 'cred-hello', label: 'Edge on Windows', addedAt: HELLO_ADDED, usedAt: null },
    ],
    lockout: { until: UNTIL },
  },
  logins: [
    {
      id: 'login-1',
      method: 'passkey',
      passkeyId: 'cred-ipad',
      label: 'Safari on iPad',
      address: '203.0.113.7',
      signedInAt: NOW - 180 * MIN,
      expiresAt: NOW + 29 * 24 * 60 * MIN,
      seenAt: NOW - 2 * MIN,
    },
    {
      id: 'login-2',
      method: 'password',
      label: 'Chrome on Android',
      address: '198.51.100.20',
      signedInAt: PHONE_IN,
      expiresAt: PHONE_IN + 30 * 24 * 60 * MIN,
      seenAt: null,
    },
  ],
  attempts: [
    { at: NOW - 8 * MIN, address: '192.0.2.1', label: 'Firefox on Linux', method: 'password', reason: 'limited' },
    { at: NOW - 9 * MIN, address: '192.0.2.1', label: 'Firefox on Linux', method: 'password', reason: 'locked' },
    { at: NOW - 10 * MIN, address: '', label: 'A browser', method: 'passkey', reason: 'wrong' },
  ],
}

const HINT =
  'Passkeys are added on the device: open https://board.example.com there, sign in with password and code, then Add a passkey.'
const HINT_RU =
  'Ключи доступа добавляются на самом устройстве: откройте там https://board.example.com, войдите паролем и кодом, затем «Добавить ключ доступа».'

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const byClass = (nodes: Node[], name: string): Element[] => findAll(nodes, el => hasClass(el, name))
const textsOf = (nodes: Node[], name: string): string[] => byClass(nodes, name).map(textOf)
const buttonsIn = (nodes: Node[]): string[] => findAll(nodes, el => el.tag === 'button').map(textOf)
const part = (nodes: Node[], name: string): Element => find(nodes, el => hasClass(el, name))

/** The panel's body as drawn for a view, in the page's providers. */
function bodyOf(view: AccessView, lang = 'en'): Node[] {
  return renderInBoard(
    <PanelProvider viewport={() => VP}>
      <AccessBody view={view} send={async () => null} steps={null} testing={false} />
    </PanelProvider>,
    board({ now: NOW }),
    lang,
  )
}

/** The password and the code: their name, where they stand, their button. */
const settingsOf = (login: Element) =>
  byClass([login], 'access-setting').map(row => [
    textsOf([row], 'access-name')[0],
    textsOf([row], 'access-is')[0],
    buttonsIn([row]),
  ])

/** Each row of a list: its label, its line, its buttons. */
const rowsOf = (nodes: Node[]) =>
  byClass(nodes, 'access-row').map(row => [
    textsOf([row], 'access-label')[0],
    textsOf([row], 'access-meta')[0],
    buttonsIn([row]),
  ])

// ---------------------------------------------------------------- what the parts show

test('nothing set up: the password and the code not set, no passkey rows, the hint with the domain', () => {
  expect(isAccessView(BARE)).toBe(true)
  expect(isAccessView(SET)).toBe(true)
  const body = bodyOf(BARE)
  // Under the Tunnel part: Login, then Active logins.
  const order = ['access-tunnel', 'access-login', 'access-logins']
  const seen = findAll(body, el => order.some(c => hasClass(el, c))).map(el => order.find(c => hasClass(el, c)))
  expect(seen).toEqual(order)

  const login = part(body, 'access-login')
  expect(settingsOf(login)).toEqual([
    ['Password', 'not set', ['Set']],
    ['Authenticator code', 'not set up', ['Set up']],
  ])
  expect(rowsOf([login])).toEqual([])
  expect(textsOf([login], 'access-none')).toEqual(['No passkeys yet.'])
  expect(textsOf([login], 'access-tip')).toEqual([HINT])
  expect(byClass([login], 'access-lock')).toEqual([])
  // Nothing open: no field, no QR code.
  expect(findAll([login], el => el.tag === 'input' || el.tag === 'svg')).toEqual([])

  // No logins: nothing to end; no failed attempts.
  const logins = part(body, 'access-logins')
  expect(buttonsIn([logins])).toEqual([])
  expect(textsOf([logins], 'access-none')).toEqual(['No one is signed in through the domain.', 'None.'])

  // In Russian.
  const russian = bodyOf(BARE, 'ru')
  expect(settingsOf(part(russian, 'access-login'))).toEqual([
    ['Пароль', 'не задан', ['Задать']],
    ['Код из приложения', 'не настроен', ['Настроить']],
  ])
  expect(textsOf(russian, 'access-tip')).toEqual([HINT_RU])

  // No domain yet: the hint says where it goes.
  const none = { ...BARE, tunnel: { ...BARE.tunnel, settings: { ...BARE.tunnel.settings, domain: '' } } }
  expect(textsOf(bodyOf(none), 'access-tip')).toEqual([HINT.replace('board.example.com', '<domain>')])
})

test('set up, two passkeys, one used, a lockout: two rows with Remove, the lockout line with Lift', () => {
  const login = part(bodyOf(SET), 'access-login')
  expect(settingsOf(login)).toEqual([
    ['Password', 'set', ['Change']],
    ['Authenticator code', 'set up', ['Set up again']],
  ])
  expect(rowsOf([login])).toEqual([
    ['Safari on iPad', `added ${shortWhen(IPAD_ADDED, t, NOW)} · last used 5 min ago`, ['Remove']],
    ['Edge on Windows', `added ${shortWhen(HELLO_ADDED, t, NOW)} · not used yet`, ['Remove']],
  ])
  expect(byClass([login], 'access-none')).toEqual([])
  expect(textsOf([login], 'access-tip')).toEqual([HINT])
  const lockout = part([login], 'access-lockout')
  expect(textsOf([lockout], 'access-lock')).toEqual([
    `Sign-in with password and code is locked until ${longWhen(UNTIL, t, NOW)}`,
  ])
  expect(buttonsIn([lockout])).toEqual(['Lift'])
  // Used a moment ago.
  expect(passkeyLine({ id: 'x', label: 'x', addedAt: NOW, usedAt: NOW - 1000 }, t, NOW)).toBe(
    `added ${shortWhen(NOW, t, NOW)} · last used just now`,
  )

  // In Russian.
  const russian = part(bodyOf(SET, 'ru'), 'access-login')
  expect(settingsOf(russian)).toEqual([
    ['Пароль', 'задан', ['Сменить']],
    ['Код из приложения', 'настроен', ['Настроить заново']],
  ])
  expect(rowsOf([russian])).toEqual([
    ['Safari on iPad', `добавлен ${shortWhen(IPAD_ADDED, ru, NOW)} · использован 5 мин назад`, ['Удалить']],
    ['Edge on Windows', `добавлен ${shortWhen(HELLO_ADDED, ru, NOW)} · ещё не использовался`, ['Удалить']],
  ])
  expect(textsOf([russian], 'access-lock')).toEqual([`Вход по паролю и коду закрыт до ${longWhen(UNTIL, ru, NOW)}`])
  expect(buttonsIn([part([russian], 'access-lockout')])).toEqual(['Снять блокировку'])
})

test('two logins and three attempts: their lines, End and End all, the reasons as words; in Russian too', () => {
  const logins = part(bodyOf(SET), 'access-logins')
  expect(rowsOf([logins])).toEqual([
    [
      'Safari on iPad',
      `passkey · signed in ${shortWhen(NOW - 180 * MIN, t, NOW)} · last active 2 min ago · 203.0.113.7`,
      ['End'],
    ],
    // Not seen since it signed in: active since then.
    [
      'Chrome on Android',
      `password and code · signed in ${shortWhen(PHONE_IN, t, NOW)} · last active 2 d ago · 198.51.100.20`,
      ['End'],
    ],
  ])
  expect(buttonsIn([logins])).toEqual(['End', 'End', 'End all'])
  expect(textsOf([logins], 'access-attempt')).toEqual([
    `${shortWhen(NOW - 8 * MIN, t, NOW)} · 192.0.2.1 · Firefox on Linux · too many tries`,
    `${shortWhen(NOW - 9 * MIN, t, NOW)} · 192.0.2.1 · Firefox on Linux · while locked`,
    // No address from the proxy: none shown.
    `${shortWhen(NOW - 10 * MIN, t, NOW)} · A browser · wrong sign-in`,
  ])
  expect(byClass([logins], 'access-none')).toEqual([])
  const [phone] = SET.logins
  if (!phone) throw new Error('no login')
  expect(loginLine({ ...phone, seenAt: NOW - 30_000 }, t, NOW)).toBe(
    `passkey · signed in ${shortWhen(phone.signedInAt, t, NOW)} · active now · 203.0.113.7`,
  )

  // In Russian.
  const russian = part(bodyOf(SET, 'ru'), 'access-logins')
  expect(rowsOf([russian])).toEqual([
    [
      'Safari on iPad',
      `ключ доступа · вход ${shortWhen(NOW - 180 * MIN, ru, NOW)} · активность 2 мин назад · 203.0.113.7`,
      ['Завершить'],
    ],
    [
      'Chrome on Android',
      `пароль и код · вход ${shortWhen(PHONE_IN, ru, NOW)} · активность 2 д назад · 198.51.100.20`,
      ['Завершить'],
    ],
  ])
  expect(buttonsIn([russian])).toEqual(['Завершить', 'Завершить', 'Завершить все'])
  expect(textsOf([russian], 'access-attempt')).toEqual([
    `${shortWhen(NOW - 8 * MIN, ru, NOW)} · 192.0.2.1 · Firefox on Linux · слишком много попыток`,
    `${shortWhen(NOW - 9 * MIN, ru, NOW)} · 192.0.2.1 · Firefox on Linux · во время блокировки`,
    `${shortWhen(NOW - 10 * MIN, ru, NOW)} · A browser · неверный вход`,
  ])
  expect(textsOf([russian], 'access-head')).toContain('Недавние неудачные попытки')
  const [attempt] = SET.attempts
  if (!attempt) throw new Error('no attempt')
  expect(attemptLine(attempt, ru, NOW)).toEndWith(' · слишком много попыток')
})

test('the key in groups of four, for typing into an app', () => {
  expect(groupKey(SECRET_B32)).toBe('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ')
  expect(groupKey('ABCDEF')).toBe('ABCD EF')
  expect(groupKey('')).toBe('')
})

test('the panel asks one thing at a time: the Tunnel part sees its own, the Login parts theirs', () => {
  const tunnel: TunnelAsk[] = [{ kind: 'key' }, { kind: 'domain', domain: 'new.example.com' }]
  const login: LoginAsk[] = [
    { kind: 'password', typed: 'x' },
    { kind: 'totp', secret: SECRET_B32, uri: 'otpauth://totp/x', code: '' },
    { kind: 'passkey', id: 'cred-ipad' },
    { kind: 'login', id: 'login-1' },
    { kind: 'logins' },
  ]
  expect(tunnel.map(tunnelAsk)).toEqual(tunnel)
  expect(tunnel.map(loginAsk)).toEqual([null, null])
  expect(login.map(loginAsk)).toEqual(login)
  expect(login.map(tunnelAsk)).toEqual(Array(5).fill(null))
  expect([tunnelAsk(null), loginAsk(null)]).toEqual([null, null])
})

test('without the board the Login parts’ buttons do nothing', () => {
  const drawn = renderInBoard(
    <PanelProvider viewport={() => VP}>
      <AccessBody view={SET} send={async () => null} steps={null} testing={false} />
    </PanelProvider>,
    board({ now: NOW, connected: false, canEdit: false }),
  )
  const parts = [part(drawn, 'access-login'), part(drawn, 'access-logins')]
  const buttons = findAll(parts, el => el.tag === 'button')
  expect(buttons.map(textOf)).toEqual(['Change', 'Set up again', 'Remove', 'Remove', 'Lift', 'End', 'End', 'End all'])
  expect(buttons.filter(el => !el.attrs.has('disabled')).map(textOf)).toEqual([])
})

// ---------------------------------------------------------------- live, with React's handlers

/**
 * The Login parts live in a fake DOM with React's handlers on it (support/react-events.ts), drawn
 * again after every event the way React would (support/react-commit.ts): the view from the panel's
 * source (hooks/useAccess.ts accessSource), what they ask or have open kept here as the panel keeps
 * it. The board's answers are the test's; what is toasted is kept.
 */
function liveLogin(view: AccessView) {
  const toasts: [string, boolean][] = []
  const context = board({ now: NOW, toast: (text, error = false) => void toasts.push([text, error]) })
  const source = accessSource({ t: () => t, toast: context.toast })
  const asks: LoginAsk[] = []
  let ask: LoginAsk = null
  const onAsk = (next: LoginAsk) => {
    ask = next
    asks.push(next)
  }
  const world = new FakeWorld({ viewport: VP })
  const tree = () => {
    const shown = source.now.get().view ?? view
    return (
      <div className="access-body">
        <LoginSection view={shown} send={source.send} ask={ask} onAsk={onAsk} />
        <LoginsSection view={shown} send={source.send} ask={ask} onAsk={onAsk} />
      </div>
    )
  }
  let drawn: { el: FakeElement; markup: Element; hosts: Host[] } | null = null
  const draw = () => {
    const node = tree()
    let hosts: Host[] = []
    function Probe() {
      hosts = hostElements(node)
      return null
    }
    renderInBoard(<Probe />, context)
    const next = first(renderInBoard(node, context))
    if (!drawn) drawn = { el: world.mount(clone(next)), markup: next, hosts }
    else {
      commit(world, drawn.el.node, drawn.markup, next)
      drawn = { el: drawn.el, markup: next, hosts }
    }
  }
  draw()
  world.afterFlush = draw
  listenLikeReact(
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
    toasts,
    asks,
    pick,
    page,
    all: (selector: string) => page().querySelectorAll(selector),
    text: (selector: string) =>
      page()
        .querySelectorAll(selector)
        .map(el => el.textContent),
    buttons: () =>
      page()
        .querySelectorAll('button')
        .map(b => b.textContent),
    async click(label: string) {
      const found = page()
        .querySelectorAll('button')
        .find(b => b.textContent === label)
      if (!found) throw new Error(`no button ${label}`)
      await world.fire(found, 'click')
      await idle()
    },
    async type(name: string, text: string) {
      const field = pick(`input[name="${name}"]`)
      field.value = text
      await world.fire(field, 'input')
      await idle()
    },
    async key(name: string, key: string) {
      await world.fire(pick(`input[name="${name}"]`), 'keydown', { key })
      await idle()
    },
    /** The form sent, as its submit button or Enter in its field does. */
    async submit(selector: string) {
      await world.fire(pick(selector), 'submit')
      await idle()
    },
  }
}

const GET = ['/api/access', undefined, undefined, undefined]
const post = (body: Record<string, unknown>) => ['/api/access', 'POST', '1', body]

test('Change password says first that it ends every login, then posts the password', async () => {
  const calls = answers([200, { ok: true }], [200, SET])
  const live = liveLogin(SET)
  await live.click('Change')
  expect(live.text('.access-form .access-sure')).toEqual(['Changing the password ends every login.'])
  // The field a password manager fills with a new password.
  const field = live.pick('.access-form input')
  expect(['type', 'name', 'autocomplete'].map(a => field.getAttribute(a))).toEqual([
    'password',
    'password',
    'new-password',
  ])
  expect(live.buttons()).not.toContain('Change')
  await live.type('password', 'correct horse battery')
  await live.submit('.access-form')
  expect(sent(calls)).toEqual([post({ op: 'password', password: 'correct horse battery' }), GET])
  // Saved: the form closes.
  expect(live.all('.access-form')).toEqual([])
  expect(live.buttons()).toContain('Change')
  expect(live.asks).toEqual([
    { kind: 'password', typed: '' },
    { kind: 'password', typed: 'correct horse battery' },
    null,
  ])
  expect(live.toasts).toEqual([])
})

test('Set password: no warning with none set; a refusal is toasted and the form stays; Escape and Cancel close it', async () => {
  const error = 'A password has at least 12 characters'
  const calls = answers([409, { ok: false, error }], [200, BARE])
  const live = liveLogin(BARE)
  await live.click('Set')
  expect(live.all('.access-form')).toHaveLength(1)
  expect(live.text('.access-sure')).toEqual([])
  expect(live.pick('input[name="password"]').getAttribute('autocomplete')).toBe('new-password')
  await live.type('password', 'short')
  await live.submit('.access-form')
  expect(sent(calls)).toEqual([post({ op: 'password', password: 'short' }), GET])
  expect(live.toasts).toEqual([[error, true]])
  expect(live.pick('input[name="password"]').value).toBe('short')
  // Escape in the field closes the form, sending nothing.
  await live.key('password', 'Escape')
  expect(live.all('.access-form')).toEqual([])
  await live.click('Set')
  await live.click('Cancel')
  expect(live.all('.access-form')).toEqual([])
  expect(calls).toHaveLength(2)
})

const URI =
  'otpauth://totp/Agent%20board%3Aboard.example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Agent%20board&algorithm=SHA1&digits=6&period=30'
const TOTP_SET = { ...BARE, login: { ...BARE.login, password: true, totp: true } }

test('Set up the code: the QR code and the key from totp-begin, Check posts the code, then both are gone', async () => {
  const calls = answers(
    [200, { ok: true, secret: SECRET_B32, uri: URI }],
    [200, BARE],
    [200, { ok: true }],
    [200, TOTP_SET],
  )
  const live = liveLogin(BARE)
  await live.click('Set up')
  expect(sent(calls)).toEqual([post({ op: 'totp-begin' }), GET])
  // One QR code, of the URI; the key as text, in groups.
  const qrs = live.all('svg.access-qr')
  expect(qrs).toHaveLength(1)
  expect(qrs[0]?.getAttribute('aria-label')).toBe(URI)
  expect(live.text('.access-secret')).toEqual(['GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ'])
  // Setting it up the first time ends nothing: no warning.
  expect(live.text('.access-sure')).toEqual([])
  const code = live.pick('.access-form input')
  expect(['name', 'inputmode', 'autocomplete'].map(a => code.getAttribute(a))).toEqual([
    'code',
    'numeric',
    'one-time-code',
  ])
  await live.type('code', ' 123 456 ')
  await live.submit('.access-form')
  expect(sent(calls).slice(2)).toEqual([post({ op: 'totp-confirm', code: '123456' }), GET])
  // Checked: the setup closes, its secret with it.
  expect(live.all('svg')).toEqual([])
  expect(live.page().textContent).not.toContain('GEZD')
  expect(live.asks.at(-1)).toBeNull()
  expect(settingsOf(live.pick('.access-login').node)).toEqual([
    ['Password', 'set', ['Change']],
    ['Authenticator code', 'set up', ['Set up again']],
  ])
  expect(live.toasts).toEqual([])
})

test('Set up again says first that it ends every login; a wrong code is toasted and the setup stays; Cancel drops the secret', async () => {
  const error = 'That code is not the one the app shows now'
  const calls = answers(
    [200, { ok: true, secret: SECRET_B32, uri: URI }],
    [200, TOTP_SET],
    [409, { ok: false, error }],
    [200, TOTP_SET],
  )
  const live = liveLogin(TOTP_SET)
  await live.click('Set up again')
  expect(live.text('.access-form .access-sure')).toEqual(['Setting the code up again ends every login.'])
  expect(live.all('svg.access-qr')).toHaveLength(1)
  await live.type('code', '000000')
  await live.submit('.access-form')
  expect(sent(calls)).toEqual([post({ op: 'totp-begin' }), GET, post({ op: 'totp-confirm', code: '000000' }), GET])
  expect(live.toasts).toEqual([[error, true]])
  expect(live.text('.access-secret')).toEqual(['GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ'])
  // Cancel: the secret is gone from the page and from what the panel keeps.
  await live.click('Cancel')
  expect(live.all('svg')).toEqual([])
  expect(live.page().textContent).not.toContain('GEZD')
  expect(live.asks.at(-1)).toBeNull()
  expect(calls).toHaveLength(4)
})

test('Remove takes two clicks and posts the passkey’s id; Lift posts at once', async () => {
  const calls = answers([200, { ok: true }], [200, SET], [200, { ok: true }], [200, SET])
  const live = liveLogin(SET)
  await live.click('Remove')
  // Asked, not sent: the first row's button says so.
  expect(calls).toEqual([])
  expect(live.buttons().filter(b => b.startsWith('Remove'))).toEqual(['Remove? Click again', 'Remove'])
  await live.click('Remove? Click again')
  expect(sent(calls)).toEqual([post({ op: 'passkey-remove', id: 'cred-ipad' }), GET])
  expect(live.buttons().filter(b => b.startsWith('Remove'))).toEqual(['Remove', 'Remove'])
  await live.click('Lift')
  expect(sent(calls).slice(2)).toEqual([post({ op: 'lockout-lift' }), GET])
  expect(live.toasts).toEqual([])
})

test('End and End all take two clicks each and post the login’s id, or all of them', async () => {
  const calls = answers([200, { ok: true }], [200, SET], [200, { ok: true }], [200, SET])
  const live = liveLogin(SET)
  await live.click('End')
  expect(calls).toEqual([])
  expect(live.buttons().filter(b => b.startsWith('End'))).toEqual(['End? Click again', 'End', 'End all'])
  await live.click('End? Click again')
  expect(sent(calls)).toEqual([post({ op: 'login-end', id: 'login-1' }), GET])
  await live.click('End all')
  expect(calls).toHaveLength(2)
  expect(live.buttons()).toContain('End all? Click again')
  await live.click('End all? Click again')
  expect(sent(calls).slice(2)).toEqual([post({ op: 'logins-end-all' }), GET])
  // One thing at a time: another click takes the first one back.
  await live.click('End')
  await live.click('Remove')
  expect(live.buttons().filter(b => b.includes('Click again'))).toEqual(['Remove? Click again'])
  expect(calls).toHaveLength(4)
})
