// The Remote access panel (Settings → Remote access…, on the local board only): its Tunnel part
// (components/access/TunnelSection.tsx) — what a login reaches, where the tunnel stands, On or
// Off, Test connection and its steps, the settings saved as they are left, the key, and step 1 of
// "On the server": the snippets filled in from settings that check out (step 3,
// ServerSetup.tsx, is test/web/server-setup.test.tsx's). The view is GET /api/access's
// (hooks/useAccess.ts), fetched on opening and again on each new `accessRev`; every change is a
// POST /api/access `{ op, … }` with the board's header, and what the board refuses is toasted.
import { afterEach, expect, spyOn, test } from 'bun:test'
import type { AccessView } from '../../src/core/access.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import { type TestStep, TUNNEL_SOCKET, type TunnelStatus } from '../../src/core/tunnel.ts'
import { stepOnePaste } from '../../src/core/tunnel-snippets.ts'
import { timeOf } from '../../src/core/when-format.ts'
import { AccessBody } from '../../web/src/components/access/AccessPanel.tsx'
import { TunnelSection } from '../../web/src/components/access/TunnelSection.tsx'
import { accessSource } from '../../web/src/hooks/useAccess.ts'
import {
  fieldEdit,
  hintText,
  isAccessView,
  serverSnippets,
  statusLine,
  stepLine,
  type TunnelAsk,
} from '../../web/src/models/access.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, renderInBoard } from './support/board.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { answers, type Call, restoreFetch, sent } from './support/fetch-answers.ts'
import { type Element, find, findAll, hasClass, type Node } from './support/markup.ts'
import { clone, commit, first } from './support/react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './support/react-events.ts'

const t = translator('en')
const VP = { w: 1600, h: 1000 }
/** The page's clock, and a moment earlier that day. */
const NOW = new Date(2026, 9, 21, 15, 0).getTime()
const SINCE = new Date(2026, 9, 21, 14, 5).getTime()

afterEach(restoreFetch)

const KEY_PATH = 'C:\\Users\\Иван Петров\\AppData\\Local\\agent-board\\tunnel\\id_ed25519'
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFake agent-board@DESK'

/** Nothing set up yet: the board's own key not made, the login not set up. */
const VIEW: AccessView = {
  tunnel: {
    settings: {
      on: false,
      host: '',
      sshPort: 22,
      user: '',
      key: '',
      socket: TUNNEL_SOCKET,
      domain: '',
      port: null,
      publicPort: null,
    },
    problems: [
      { field: 'host', message: 'Server: needed' },
      { field: 'user', message: 'User: needed' },
      { field: 'domain', message: 'Domain: needed' },
    ],
    blocked: 'Server: needed',
    listenPort: 12424,
    status: { state: 'off', since: SINCE },
    ssh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    key: { path: KEY_PATH, generated: true, exists: false, publicKey: null, error: null },
    hostKey: null,
  },
  login: { password: false, totp: false, passkeys: [], lockout: null },
  logins: [],
  attempts: [],
  server: null,
}

/** Set up and on: the key made, the server's key pinned. */
const READY: AccessView = {
  ...VIEW,
  tunnel: {
    ...VIEW.tunnel,
    settings: {
      ...VIEW.tunnel.settings,
      on: true,
      host: 'ssh.example.com',
      user: 'boardtunnel',
      domain: 'board.example.com',
    },
    problems: [],
    blocked: null,
    status: { state: 'connected', since: SINCE, probe: null },
    key: { path: KEY_PATH, generated: true, exists: true, publicKey: PUBLIC_KEY, error: null },
    hostKey: 'SHA256:q0wErTyUiOpAsDfGhJkL (ED25519)',
  },
  login: { password: true, totp: true, passkeys: [], lockout: null },
}

const withStatus = (view: AccessView, status: TunnelStatus): AccessView => ({
  ...view,
  tunnel: { ...view.tunnel, status },
})

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const byClass = (nodes: Node[], name: string): Element[] => findAll(nodes, el => hasClass(el, name))
const textsOf = (nodes: Node[], name: string): string[] => byClass(nodes, name).map(textOf)
const buttonsIn = (nodes: Node[]): Element[] => findAll(nodes, el => el.tag === 'button')
const button = (nodes: Node[], label: string): Element => find(nodes, el => el.tag === 'button' && textOf(el) === label)

/** The panel's body as drawn for a view, in the page's providers. */
function bodyOf(
  view: AccessView,
  more: { steps?: TestStep[] | null; testing?: boolean; lang?: string; canEdit?: boolean } = {},
): Node[] {
  return renderInBoard(
    <PanelProvider viewport={() => VP}>
      <AccessBody view={view} send={async () => null} steps={more.steps ?? null} testing={more.testing ?? false} />
    </PanelProvider>,
    board({ now: NOW, ...(more.canEdit === false && { connected: false, canEdit: false }) }),
    more.lang ?? 'en',
  )
}

// ---------------------------------------------------------------- what the part shows

test('nothing set up: what is needed under its field, On off with the reason, the status Off', () => {
  expect(isAccessView(VIEW)).toBe(true)
  expect(isAccessView(READY)).toBe(true)
  const body = bodyOf(VIEW)
  const tunnel = find(body, el => hasClass(el, 'access-tunnel'))
  expect(textsOf([tunnel], 'access-problem')).toEqual(['Server: needed', 'User: needed', 'Domain: needed'])
  // Each problem under its own field.
  const entries = byClass([tunnel], 'access-entry').map(entry => [
    textOf(find([entry], el => el.tag === 'span')),
    textsOf([entry], 'access-problem'),
  ])
  expect(entries).toEqual([
    ['Server', ['Server: needed']],
    ['SSH port', []],
    ['User', ['User: needed']],
    ['Key', []],
    ['Socket on the server', []],
    ['Domain', ['Domain: needed']],
    ['Public port', []],
    ['Local port', []],
  ])
  // A label each, its input named by it; the board's values, and what an empty one means (the
  // tunnel's settings: step 3's admin fields are server-setup.test.tsx's).
  const fields = byClass([find([tunnel], el => hasClass(el, 'access-fields'))], 'access-field')
  expect(fields.map(f => f.tag)).toEqual(Array(8).fill('label'))
  const inputs = findAll(fields, el => el.tag === 'input')
  expect(inputs.map(el => ['name', 'aria-label', 'value', 'placeholder'].map(a => el.attrs.get(a) ?? ''))).toEqual([
    ['host', 'Server', '', 'ssh.example.com'],
    ['sshPort', 'SSH port', '22', '22'],
    ['user', 'User', '', 'boardtunnel'],
    ['key', 'Key', '', "The board's own key"],
    ['socket', 'Socket on the server', TUNNEL_SOCKET, TUNNEL_SOCKET],
    ['domain', 'Domain', '', 'board.example.com'],
    ['publicPort', 'Public port', '', '443'],
    ['port', 'Local port', '', '12424'],
  ])
  // On, off for now, and why; the status.
  const on = button([tunnel], 'Turn on')
  expect(on.attrs.has('disabled')).toBe(true)
  expect(textsOf([tunnel], 'access-why')).toEqual(['Server: needed'])
  expect(buttonsIn([tunnel]).some(b => textOf(b) === 'Turn off')).toBe(false)
  expect(textsOf([tunnel], 'access-status')).toEqual(['Off'])
  expect(textsOf([tunnel], 'access-ssh')).toEqual(['SSH client: C:\\Windows\\System32\\OpenSSH\\ssh.exe'])
  expect(byClass([tunnel], 'access-warn')).toEqual([])
  // Test connection is there from the start; no steps yet.
  expect(button([tunnel], 'Test connection').attrs.has('disabled')).toBe(false)
  expect(byClass([tunnel], 'access-steps')).toEqual([])
  // The key: the board's own, not made yet; one click makes it.
  const key = find([tunnel], el => hasClass(el, 'access-key'))
  expect(textOf(key)).toContain("The board's own key")
  expect(textOf(key)).toContain(KEY_PATH)
  expect(textOf(key)).toContain('No key there yet.')
  expect(buttonsIn([key]).map(textOf)).toEqual(['Generate key'])
  // The parts in the order the panel has them.
  const order = [
    'access-reach',
    'access-status',
    'access-actions',
    'access-fields',
    'access-key',
    'access-server',
    'access-snippets',
  ]
  const seen = findAll([tunnel], el => order.some(c => hasClass(el, c))).map(el => order.find(c => hasClass(el, c)))
  expect([...new Set(seen)]).toEqual(order)

  // Without the board its fields and buttons do nothing.
  const off = find(bodyOf(READY, { canEdit: false }), el => hasClass(el, 'access-tunnel'))
  const controls = findAll([off], el => (el.tag === 'input' || el.tag === 'button') && !hasClass(el, 'access-copy'))
  expect(controls.length).toBeGreaterThan(9)
  expect(controls.filter(el => !el.attrs.has('disabled')).map(el => el.attrs.get('name') ?? textOf(el))).toEqual([])
})

test('connected since a time, with a failed probe as a warning; Off while on', () => {
  const probe = { ok: false, at: NOW, detail: '502' }
  const body = bodyOf(withStatus(READY, { state: 'connected', since: SINCE, probe }))
  expect(textsOf(body, 'access-status')).toEqual([`Connected since ${timeOf(SINCE, t)}`])
  expect(textsOf(body, 'access-warn')).toEqual(['The domain did not reach this board: 502'])
  expect(buttonsIn(body).some(b => textOf(b) === 'Turn on')).toBe(false)
  expect(button(body, 'Turn off').attrs.has('disabled')).toBe(false)
  expect(byClass(body, 'access-why')).toEqual([])
  expect(byClass(body, 'access-problem')).toEqual([])
  // A probe that went through says nothing.
  const fine = bodyOf(withStatus(READY, { state: 'connected', since: SINCE, probe: { ok: true, at: NOW, detail: '' } }))
  expect(byClass(fine, 'access-warn')).toEqual([])
  // In Russian.
  const ru = bodyOf(withStatus(READY, { state: 'connected', since: SINCE, probe }), { lang: 'ru' })
  expect(textsOf(ru, 'access-status')).toEqual([`Подключён с ${timeOf(SINCE, translator('ru'))}`])
  expect(textsOf(ru, 'access-warn')).toEqual(['Домен не дошёл до этой доски: 502'])
})

test('reconnecting with its attempt and next try; an error since a time with its hint; no ssh found', () => {
  const nextAt = new Date(2026, 9, 21, 15, 0, 12).getTime()
  const clock = new Date(nextAt).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  const timedOut = 'ssh: connect to host ssh.example.com port 22: Connection timed out'
  const reconnecting = withStatus(READY, {
    state: 'reconnecting',
    since: SINCE,
    attempt: 3,
    nextAt,
    error: timedOut,
    hint: 'network',
  })
  expect(statusLine(reconnecting.tunnel.status, t, NOW)).toBe(`Reconnecting: attempt 3, next try ${clock}. ${timedOut}`)
  const drawn = bodyOf(reconnecting)
  expect(textsOf(drawn, 'access-status')).toEqual([`Reconnecting: attempt 3, next try ${clock}. ${timedOut}`])
  expect(textsOf(drawn, 'access-hint')).toEqual([t('tunnel.hint.network')])

  const refused = 'boardtunnel@ssh.example.com: Permission denied (publickey).'
  const error = withStatus(READY, { state: 'error', since: SINCE, error: refused, hint: 'publickey' })
  const body = bodyOf(error)
  expect(textsOf(body, 'access-status')).toEqual([`Error since ${timeOf(SINCE, t)}: ${refused}`])
  expect(textsOf(body, 'access-hint')).toEqual([
    'The server refused the key: put the authorized_keys line in the keys file on the server, and the sshd Match block in sshd_config.',
  ])
  // Since another day: the day too.
  const yesterday = SINCE - 24 * 3600_000
  expect(statusLine({ state: 'error', since: yesterday, error: refused }, t, NOW)).toBe(
    `Error since yesterday ${timeOf(yesterday, t)}: ${refused}`,
  )
  expect(statusLine({ state: 'connecting', since: SINCE }, t, NOW)).toBe('Connecting…')
  expect(statusLine({ state: 'off', since: SINCE }, t, NOW)).toBe('Off')
  expect(hintText(null, t)).toBe('')
  expect(hintText(undefined, t)).toBe('')
  expect(hintText('caddy502', t)).toBe(t('tunnel.hint.caddy502'))

  // No OpenSSH client: the hint, as a warning, in place of its path.
  const noSsh = bodyOf({ ...READY, tunnel: { ...READY.tunnel, ssh: null } })
  expect(textsOf(noSsh, 'access-ssh')).toEqual([t('tunnel.hint.noSsh')])
  expect(textsOf(noSsh, 'access-warn')).toEqual([t('tunnel.hint.noSsh')])
})

test('the key: its public key and the keys file’s line with Copy, the server’s key with Forget', () => {
  const body = bodyOf(READY)
  const key = find(body, el => hasClass(el, 'access-key'))
  const codes = findAll([key], el => el.tag === 'code').map(textOf)
  expect(codes).toEqual([
    KEY_PATH,
    PUBLIC_KEY,
    `restrict,port-forwarding ${PUBLIC_KEY}`,
    'SHA256:q0wErTyUiOpAsDfGhJkL (ED25519)',
  ])
  expect(buttonsIn([key]).map(textOf)).toEqual(['Generate key', 'Copy', 'Copy', "Forget the server's key"])
  expect(textOf(key)).not.toContain('No key there yet.')
  // In Russian, the buttons as the hints name them (tunnel.hint.keyPermissions, hostKey).
  const ru = find(bodyOf(READY, { lang: 'ru' }), el => hasClass(el, 'access-key'))
  expect(buttonsIn([ru]).map(textOf)).toEqual(['Создать ключ', 'Копировать', 'Копировать', 'Забыть ключ сервера'])
  expect(translator('ru')('tunnel.hint.keyPermissions')).toContain('«Создать ключ»')
  expect(translator('ru')('tunnel.hint.hostKey')).toContain('«Забыть ключ сервера»')
  expect(t('tunnel.hint.keyPermissions')).toContain('Generate key')
  expect(t('tunnel.hint.hostKey')).toContain("Forget the server's key")

  // A key of the owner's own: its path, no Generate key; a key ssh-keygen could not read says why.
  const own = {
    ...READY,
    tunnel: {
      ...READY.tunnel,
      settings: { ...READY.tunnel.settings, key: 'D:\\keys\\board' },
      key: { path: 'D:\\keys\\board', generated: false, exists: true, publicKey: null, error: 'bad passphrase' },
      hostKey: null,
    },
  }
  const ownKey = find(bodyOf(own), el => hasClass(el, 'access-key'))
  expect(textOf(ownKey)).not.toContain("The board's own key")
  expect(findAll([ownKey], el => el.tag === 'code').map(textOf)).toEqual(['D:\\keys\\board'])
  expect(buttonsIn([ownKey])).toEqual([])
  expect(textsOf([ownKey], 'access-problem')).toEqual(['bad passphrase'])
})

test('step 1’s snippets, filled in: all of step 1 in one paste, the user and folder commands, the keys file, sshd', () => {
  const view = { ...READY, tunnel: { ...READY.tunnel, settings: { ...READY.tunnel.settings, user: '' } } }
  const body = bodyOf(view)
  const snippets = find(body, el => hasClass(el, 'access-snippets'))
  const details = findAll([snippets], el => el.tag === 'details')
  expect(details.map(d => [textOf(find([d], el => el.tag === 'summary')), d.attrs.has('open')])).toEqual([
    ['All of step 1 in one paste', false],
    ["The tunnel's user and the socket's folder", true],
    ['The keys file, /etc/ssh/authorized_keys/boardtunnel', true],
    ['At the end of /etc/ssh/sshd_config', true],
  ])
  const code = details.map(d => findAll([d], el => el.tag === 'pre').map(textOf))
  expect(code[0]).toEqual([stepOnePaste('boardtunnel', TUNNEL_SOCKET, PUBLIC_KEY)])
  expect(code[0]?.[0]).toContain(`echo 'restrict,port-forwarding ${PUBLIC_KEY}' | sudo tee`)
  // The socket's folder in the tunnel user's own group: no caddy group needed before Caddy is there.
  expect(code[1]?.[0]).toContain('sudo install -d -m 2750 -o boardtunnel -g boardtunnel /var/lib/boardtunnel')
  expect(code[1]?.[0]).not.toContain('-g caddy')
  expect(code[2]).toEqual([`restrict,port-forwarding ${PUBLIC_KEY}`])
  expect(code[3]?.[0]).toStartWith(
    'Match User boardtunnel\n    AuthorizedKeysFile /etc/ssh/authorized_keys/boardtunnel',
  )
  // The web server is step 3's (its plan, or Do it myself for a case): no Caddy or nginx here.
  expect(textOf(snippets)).not.toContain('reverse_proxy')
  // A Copy for each text.
  expect(details.map(d => buttonsIn([d]).map(textOf))).toEqual([['Copy'], ['Copy'], ['Copy'], ['Copy']])
  // In Russian, the one paste has a title of its own.
  const ru = find(bodyOf(view, { lang: 'ru' }), el => hasClass(el, 'access-snippets'))
  const ruTitle = textOf(find([ru], el => el.tag === 'summary'))
  expect(ruTitle).not.toBe('All of step 1 in one paste')
  expect(ruTitle).toBe(translator('ru')('access.snip.paste'))

  // No key yet: the one paste would write no key's line, so it says to make the key first, with nothing to copy.
  const keyless = find(bodyOf(VIEW), el => hasClass(el, 'access-snippets'))
  const first = find([keyless], el => el.tag === 'details')
  expect(textOf(find([first], el => el.tag === 'summary'))).toBe('All of step 1 in one paste')
  expect(findAll([first], el => el.tag === 'pre')).toEqual([])
  expect(buttonsIn([first])).toEqual([])
  expect(textsOf([first], 'access-note')).toEqual([t('access.snip.pasteNoKey')])
  expect(serverSnippets(VIEW.tunnel.settings, null).paste).toBeNull()

  // No key yet: an example line in its place.
  expect(serverSnippets(VIEW.tunnel.settings, null).keysLine).toBe(
    'restrict,port-forwarding ssh-ed25519 AAAA… agent-board@<PC>',
  )
  // Settings of their own, filled in.
  const mine = serverSnippets(
    { ...READY.tunnel.settings, user: 'tun', socket: '/srv/tun/board.sock', domain: 'b.example.org' },
    PUBLIC_KEY,
  )
  expect(mine.commands).toContain('sudo install -d -m 2750 -o tun -g tun /srv/tun')
  expect(mine.paste).toBe(stepOnePaste('tun', '/srv/tun/board.sock', PUBLIC_KEY))
  expect(mine.keysFile).toBe('/etc/ssh/authorized_keys/tun')
  expect(mine.sshd).toStartWith('Match User tun\n')
  // config.json edited by hand: a value that fails its check never reaches a snippet pasted into a
  // root shell; its default stands in.
  const bad = serverSnippets(
    {
      ...READY.tunnel.settings,
      user: '-l',
      socket: '/tmp/board.sock; rm -rf /',
      domain: 'Board.Example.com; curl evil',
    },
    PUBLIC_KEY,
  )
  expect(bad.commands).not.toContain('-l\n')
  expect(bad.commands).toContain('--shell /usr/sbin/nologin boardtunnel')
  expect(bad.commands).toContain('-o boardtunnel -g boardtunnel /var/lib/boardtunnel')
  expect(bad.paste).toBe(stepOnePaste('boardtunnel', TUNNEL_SOCKET, PUBLIC_KEY))
  expect(bad.keysFile).toBe('/etc/ssh/authorized_keys/boardtunnel')
  expect(bad.sshd).toStartWith('Match User boardtunnel\n')
  for (const text of Object.values(bad)) expect(text).not.toMatch(/rm -rf|curl|-oProxy/)
  expect(serverSnippets({ ...READY.tunnel.settings, user: 'x;id' }, null).user).toBe('boardtunnel')
})

test('what a login reaches, said exactly, in English and Russian', () => {
  expect(textsOf(bodyOf(VIEW), 'access-reach')).toEqual([
    "Through the domain, a login gets the board as a phone does, and the terminal: a shell on this PC with your rights. The board's own files (its settings, logins and keys) are not served through the domain, but the terminal, or a session started from it, reaches them and everything else on this PC. Treat a login like your own shell.",
  ])
  expect(textsOf(bodyOf(VIEW, { lang: 'ru' }), 'access-reach')).toEqual([
    'Через домен вход даёт доску, как телефону, и терминал: оболочку на этом компьютере с вашими правами. Собственные файлы доски (её настройки, входы и ключи) через домен не отдаются, но терминал или запущенная из него сессия достают и их, и всё остальное на этом компьютере. Относитесь ко входу как к своей оболочке.',
  ])
})

test('Test connection’s steps: a line each, the hint under the one that failed', () => {
  const steps: TestStep[] = [
    { id: 'ssh', ok: true, detail: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', hint: null },
    { id: 'forward', ok: false, detail: 'remote port forwarding failed for listen path', hint: 'listenPath' },
    { id: 'domain', ok: null, detail: '', hint: null },
  ]
  expect(steps.map(s => stepLine(s, t))).toEqual([
    '✓ SSH to the server',
    '✗ The server takes the socket: remote port forwarding failed for listen path',
    '– The domain reaches this board',
  ])
  expect(stepLine({ id: 'domain', ok: false, detail: '', hint: 'tls' }, t)).toBe('✗ The domain reaches this board')
  const body = bodyOf(READY, { steps })
  const items = findAll(byClass(body, 'access-steps'), el => el.tag === 'li')
  expect(
    items.map(li => [textOf(find([li], el => hasClass(el, 'access-step'))), textsOf([li], 'access-hint')]),
  ).toEqual([
    ['✓ SSH to the server', []],
    ['✗ The server takes the socket: remote port forwarding failed for listen path', [t('tunnel.hint.listenPath')]],
    ['– The domain reaches this board', []],
  ])
  // While it runs: the button waits.
  const running = bodyOf(READY, { testing: true })
  expect(button(running, 'Testing…').attrs.has('disabled')).toBe(true)
  expect(byClass(running, 'access-steps')).toEqual([])
  // In Russian.
  expect(stepLine({ id: 'forward', ok: true, detail: '', hint: null }, translator('ru'))).toBe(
    '✓ Сервер принимает сокет',
  )
})

test('what a field sends: numbers for the ports, the domain lowercased, text trimmed; the same, nothing', () => {
  expect(fieldEdit('sshPort', 22, ' 2222 ')).toEqual({ value: 2222 })
  expect(fieldEdit('domain', 'a.b', ' Board.Example.com ')).toEqual({ value: 'board.example.com' })
  expect(fieldEdit('port', 12500, '')).toEqual({ value: null })
  expect(fieldEdit('host', 'a.b', ' a.b ')).toBeNull()
  // Empty: the default for a port or the socket, nothing to say when it is the default already.
  expect(fieldEdit('port', null, '  ')).toBeNull()
  expect(fieldEdit('sshPort', 22, '')).toBeNull()
  expect(fieldEdit('sshPort', 2222, '')).toEqual({ value: null })
  expect(fieldEdit('socket', TUNNEL_SOCKET, '')).toBeNull()
  expect(fieldEdit('socket', '/srv/tun/board.sock', '')).toEqual({ value: null })
  // A text field emptied is cleared.
  expect(fieldEdit('host', 'a.b', '')).toEqual({ value: '' })
  expect(fieldEdit('user', '', ' boardtunnel ')).toEqual({ value: 'boardtunnel' })
  expect(fieldEdit('port', null, '12500')).toEqual({ value: 12500 })
  // Not a number: as typed, for the board to refuse with its reason (never NaN, which JSON makes null).
  expect(fieldEdit('sshPort', 22, '22x')).toEqual({ value: '22x' })
  expect(fieldEdit('key', '', ' D:\\keys\\board ')).toEqual({ value: 'D:\\keys\\board' })
  // The public port: a number; emptied, 443 again (null).
  expect(fieldEdit('publicPort', null, '8443')).toEqual({ value: 8443 })
  expect(fieldEdit('publicPort', 8443, '')).toEqual({ value: null })
  expect(fieldEdit('publicPort', null, ' ')).toBeNull()
  expect(fieldEdit('publicPort', 8443, '8443')).toBeNull()
  expect(fieldEdit('publicPort', null, '8443x')).toEqual({ value: '8443x' })
})

// ---------------------------------------------------------------- live, with React's handlers

/**
 * The Tunnel part live in a fake DOM with React's handlers on it (support/react-events.ts), drawn
 * again after every event the way React would (support/react-commit.ts): its view, steps and
 * whether Test runs from the panel's source of the view (hooks/useAccess.ts accessSource), what it
 * asks kept here as the panel keeps it. The board's answers are the test's; what it toasts is kept.
 */
function liveTunnel(view: AccessView) {
  const toasts: [string, boolean][] = []
  const context = board({ now: NOW, toast: (text, error = false) => void toasts.push([text, error]) })
  const source = accessSource({ t: () => t, toast: context.toast })
  const asks: TunnelAsk[] = []
  let ask: TunnelAsk = null
  const world = new FakeWorld({ viewport: VP })
  const tree = () => {
    const now = source.now.get()
    return (
      <TunnelSection
        view={now.view ?? view}
        send={source.send}
        steps={now.steps}
        testing={now.testing}
        ask={ask}
        onAsk={next => {
          ask = next
          asks.push(next)
        }}
      />
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
    world,
    toasts,
    asks,
    pick,
    idle,
    buttons: () =>
      page()
        .querySelectorAll('button')
        .map(b => b.textContent),
    text: (selector: string) =>
      page()
        .querySelectorAll(selector)
        .map(el => el.textContent),
    async click(label: string) {
      const found = page()
        .querySelectorAll('button')
        .find(b => b.textContent === label)
      if (!found) throw new Error(`no button ${label}`)
      await world.fire(found, 'click')
      await idle()
    },
    /** Typed into a field, then the field left (Enter, when given, first). */
    async type(name: string, text: string, key?: string) {
      const field = pick(`input[name="${name}"]`)
      field.focus()
      await world.fire(field, 'focusin')
      field.value = text
      await world.fire(field, 'input')
      if (key) await world.fire(field, 'keydown', { key })
      await world.fire(field, 'focusout')
      await idle()
    },
  }
}

const GET = ['/api/access', undefined, undefined, undefined]
const post = (body: Record<string, unknown>) => ['/api/access', 'POST', '1', body]

/** Each POST carried X-Board and JSON's content type, as the board asks of every one. */
function boardHeaders(calls: Call[]): void {
  const posts = calls.filter(c => c.init?.method === 'POST')
  expect(posts.length).toBeGreaterThan(0)
  for (const c of posts) {
    const h = c.init?.headers as Record<string, string> | undefined
    expect([h?.['x-board'], h?.['content-type']]).toEqual(['1', 'application/json'])
  }
}

test('a field left goes to the board, which sends the view again; Escape and the same value send nothing', async () => {
  const saved = { ...VIEW, tunnel: { ...VIEW.tunnel, settings: { ...VIEW.tunnel.settings, host: 'ssh.example.com' } } }
  const calls = answers([200, { ok: true }], [200, saved], [200, { ok: true }], [200, saved])
  const live = liveTunnel(VIEW)
  await live.type('host', '  ssh.example.com ')
  expect(sent(calls)).toEqual([post({ op: 'tunnel', fields: { host: 'ssh.example.com' } }), GET])
  boardHeaders(calls)
  // The view the board sent again is drawn.
  expect(live.pick('input[name="host"]').value).toBe('ssh.example.com')
  // Enter leaves the field: the port as a number.
  await live.type('sshPort', '2222', 'Enter')
  expect(sent(calls).slice(2)).toEqual([post({ op: 'tunnel', fields: { sshPort: 2222 } }), GET])
  // Escape puts the board's value back; the same value, or blanks over none, send nothing.
  await live.type('user', 'boardtunnel', 'Escape')
  expect(live.pick('input[name="user"]').value).toBe('')
  await live.type('host', ' ssh.example.com ')
  await live.type('domain', '   ')
  expect(calls).toHaveLength(4)
  expect(live.toasts).toEqual([])
})

test('a field the board refuses is toasted, and the board’s value shows again', async () => {
  const error = 'The server is a host name or an address, without spaces, @ or a leading dash'
  const calls = answers([409, { ok: false, field: 'host', error }], [200, VIEW])
  const live = liveTunnel(VIEW)
  await live.type('host', '-oProxyCommand=calc')
  expect(sent(calls)).toEqual([post({ op: 'tunnel', fields: { host: '-oProxyCommand=calc' } }), GET])
  expect(live.toasts).toEqual([[error, true]])
  expect(live.pick('input[name="host"]').value).toBe('')
})

test('a new domain while logins exist: the board warns, and only Change sends it with confirm', async () => {
  const sure = t('access.domainSure')
  const calls = answers([409, { ok: false, error: sure, confirm: 'domain' }], [200, READY])
  const live = liveTunnel(READY)
  await live.type('domain', 'New.Example.com')
  expect(sent(calls)).toEqual([post({ op: 'tunnel', fields: { domain: 'new.example.com' } }), GET])
  // Asked, not toasted; the field shows the board's domain until it changes.
  expect(live.toasts).toEqual([])
  expect(live.pick('input[name="domain"]').value).toBe('board.example.com')
  expect(live.text('.access-sure')).toEqual([sure])
  expect(live.buttons()).toContain('Change to new.example.com')
  // Cancel: nothing more goes.
  await live.click('Cancel')
  expect(live.text('.access-sure')).toEqual([])
  expect(calls).toHaveLength(2)
  // Asked again, then Change: with confirm.
  const confirmed = answers(
    [409, { ok: false, error: sure, confirm: 'domain' }],
    [200, READY],
    [200, { ok: true }],
    [200, READY],
  )
  const again = liveTunnel(READY)
  await again.type('domain', 'new.example.com')
  await again.click('Change to new.example.com')
  expect(sent(confirmed)).toEqual([
    post({ op: 'tunnel', fields: { domain: 'new.example.com' } }),
    GET,
    post({ op: 'tunnel', fields: { domain: 'new.example.com' }, confirm: true }),
    GET,
  ])
  expect(again.text('.access-sure')).toEqual([])
  expect(again.toasts).toEqual([])
  expect(again.asks).toEqual([{ kind: 'domain', domain: 'new.example.com' }, null])
})

test('On posts on; Off posts off; Forget forgets the server’s key', async () => {
  const ready = { ...VIEW, tunnel: { ...READY.tunnel, settings: { ...READY.tunnel.settings, on: false } } }
  const calls = answers([200, { ok: true }], [200, READY], [200, { ok: true }], [200, ready])
  const live = liveTunnel(ready)
  await live.click('Turn on')
  // The board's view again: on.
  expect(live.buttons()).toContain('Turn off')
  await live.click('Turn off')
  expect(sent(calls)).toEqual([post({ op: 'on' }), GET, post({ op: 'off' }), GET])
  boardHeaders(calls)

  const forgot = answers([200, { ok: true }], [200, ready])
  const host = liveTunnel(READY)
  await host.click("Forget the server's key")
  expect(sent(forgot)).toEqual([post({ op: 'hostkey-forget' }), GET])
})

test('Generate key: one click with no key yet; with one there it asks first, then replaces it', async () => {
  const made = answers([200, { ok: true, publicKey: PUBLIC_KEY }], [200, READY])
  const first = liveTunnel(VIEW)
  await first.click('Generate key')
  expect(sent(made)).toEqual([post({ op: 'key-generate' }), GET])

  const calls = answers([200, { ok: true, publicKey: PUBLIC_KEY }], [200, READY])
  const live = liveTunnel(READY)
  await live.click('Generate key')
  // Asked, not sent.
  expect(calls).toEqual([])
  expect(live.text('.access-sure')).toEqual([t('access.keySure')])
  await live.click('Replace the key')
  expect(sent(calls)).toEqual([post({ op: 'key-generate', replace: true }), GET])
  expect(live.text('.access-sure')).toEqual([])

  // The view said none, but the board has one: it asks then.
  const stale = answers([409, { ok: false, error: t('access.keySure'), confirm: 'key' }], [200, VIEW])
  const again = liveTunnel(VIEW)
  await again.click('Generate key')
  expect(again.toasts).toEqual([])
  expect(again.text('.access-sure')).toEqual([t('access.keySure')])
  expect(sent(stale)).toEqual([post({ op: 'key-generate' }), GET])
})

test('Test connection: the button waits while it runs, then the steps show', async () => {
  const steps: TestStep[] = [
    { id: 'ssh', ok: true, detail: 'ssh', hint: null },
    { id: 'forward', ok: false, detail: 'timed out', hint: 'network' },
    { id: 'domain', ok: null, detail: '', hint: null },
  ]
  let answer: (r: Response) => void = () => {}
  const calls: string[] = []
  // The board takes its time with the test: the button says so meanwhile.
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)} ${init?.body ?? ''}`)
    if (init?.method === 'POST') return new Promise<Response>(resolve => (answer = resolve))
    return new Response(JSON.stringify(READY))
  }
  const spy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(fake, { preconnect: fetch.preconnect }))
  try {
    const live = liveTunnel(READY)
    await live.click('Test connection')
    expect(live.buttons()).toContain('Testing…')
    expect(live.text('.access-steps li')).toEqual([])
    answer(new Response(JSON.stringify({ ok: true, steps })))
    await live.idle()
    expect(live.buttons()).toContain('Test connection')
    expect(live.text('.access-step')).toEqual([
      '✓ SSH to the server',
      '✗ The server takes the socket: timed out',
      '– The domain reaches this board',
    ])
    expect(live.text('.access-steps .access-hint')).toEqual([t('tunnel.hint.network')])
    expect(calls).toEqual(['POST /api/access {"op":"test"}', 'GET /api/access '])
  } finally {
    spy.mockRestore()
  }
})

test('Copy puts the text on the clipboard and says so', async () => {
  const copied: string[] = []
  const saved = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async (text: string) => void copied.push(text) },
    configurable: true,
  })
  try {
    const live = liveTunnel(READY)
    const [, line] = live.pick('.access-key').querySelectorAll('.access-copy')
    if (!line) throw new Error('no Copy')
    await live.world.fire(line, 'click')
    await live.idle()
    expect(copied).toEqual([`restrict,port-forwarding ${PUBLIC_KEY}`])
    expect(live.toasts).toEqual([['Copied', false]])
  } finally {
    if (saved) Object.defineProperty(navigator, 'clipboard', saved)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})

test('the view is fetched on opening and again on each new accessRev while open; never while closed', async () => {
  const toasts: [string, boolean][] = []
  const calls = answers([200, VIEW], [200, READY], [200, VIEW], [500, { ok: false, error: 'boom' }])
  const source = accessSource({ t: () => t, toast: (text, error = false) => void toasts.push([text, error]) })
  const settle = async () => {
    for (let i = 0; i < 6; i++) await Bun.sleep(0)
  }
  source.sync(false, 4)
  await settle()
  expect(calls).toEqual([])
  expect(source.now.get()).toEqual({ view: null, steps: null, testing: false })
  // Opened: the view.
  source.sync(true, 4)
  await settle()
  expect(source.now.get().view).toEqual(VIEW)
  // Drawn again with the same revision: nothing.
  source.sync(true, 4)
  await settle()
  expect(calls).toHaveLength(1)
  // A new revision while open: the view again.
  source.sync(true, 5)
  await settle()
  expect(source.now.get().view).toEqual(READY)
  // Closed: new revisions fetch nothing; opened again, it fetches.
  source.sync(false, 6)
  source.sync(false, 7)
  await settle()
  expect(calls).toHaveLength(2)
  source.sync(true, 7)
  await settle()
  expect(source.now.get().view).toEqual(VIEW)
  expect(sent(calls)).toEqual([GET, GET, GET])
  // Asked with no-store, as the board's own view is.
  expect(calls.map(c => c.init?.cache)).toEqual(['no-store', 'no-store', 'no-store'])
  // A view the board would not give: toasted, the last one kept.
  source.sync(true, 8)
  await settle()
  expect(toasts).toEqual([['boom', true]])
  expect(source.now.get().view).toEqual(VIEW)
})
