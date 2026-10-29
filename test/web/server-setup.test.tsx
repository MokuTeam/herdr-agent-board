// The Remote access panel's Server tab, as one flow in cards (components/access/
// ServerSetup.tsx, OneCommand.tsx, models/server-setup.ts, models/server-oneshot.ts), in each
// state, from views built of Look's facts (test/support/server-facts.ts) and the core's own plans:
// nothing looked at (the login, root by default, its password, a key file folded); Set up the server
// filling in what the owner need not type, waiting for a field's save on its way, then Looking with
// the password; the passwords kept by the part alone, sudo's own field only when asked; the plan in
// plain words with the server's key, Docker's tick keeping Apply off, the full plan under Details,
// no jargon outside the folds; a server the board does not do, its steps by hand folded and never
// shown otherwise; a run, a failure with its rollback, the setup done with the login folded away and
// Undo asking for the password again, the Undo plan; "Do it myself (one command)" with its command,
// what is inside, its Undo command and Test connection finding the port; and the Tunnel part
// around it.
import { afterEach, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import type { AccessView } from '../../src/core/access.ts'
import { missingKeys, translator } from '../../src/core/i18n/translator.ts'
import { needFor } from '../../src/core/server-admin.ts'
import type { ServerFacts } from '../../src/core/server-facts.ts'
import { serverWanted } from '../../src/core/server-install.ts'
import { fenceDiff } from '../../src/core/server-look.ts'
import { plainPlan } from '../../src/core/server-plain.ts'
import {
  buildPlan,
  chooseCase,
  type Plan,
  placeholderFinders,
  type SetupCase,
  type SetupRecord,
  undoPlan,
  type Wanted,
} from '../../src/core/server-plan.ts'
import { doItMyself, type Progress, readProgress, startProgress } from '../../src/core/server-script.ts'
import { DOCKER_FILES, DOCKER_PACKAGES } from '../../src/core/server-texts.ts'
import type { AdminHint, ServerView } from '../../src/core/server-view.ts'
import { type TestStep, TUNNEL_SOCKET } from '../../src/core/tunnel.ts'
import { sshdBlock } from '../../src/core/tunnel-snippets.ts'
import { timeOf } from '../../src/core/when-format.ts'
import { AccessBody } from '../../web/src/components/access/AccessPanel.tsx'
import { ServerSetup, ServerSetupBody } from '../../web/src/components/access/ServerSetup.tsx'
import { type AccessSend, accessSource } from '../../web/src/hooks/useAccess.ts'
import { stepLine } from '../../web/src/models/access.ts'
import {
  byHandAddress,
  foundPort,
  isOneshot,
  ONESHOT_IDLE,
  oneshotStale,
  oneshotStamp,
  oneshotTest,
  oneshotWaited,
  SERVER_COMMAND_PATH,
} from '../../web/src/models/server-oneshot.ts'
import {
  answerPatch,
  flowFill,
  foundLines,
  hintLine,
  manualPlan,
  type Saves,
  SETUP_START,
  type SetupState,
  savesTracker,
  setupLine,
  stepState,
  versionOnOpen,
  withPassword,
} from '../../web/src/models/server-setup.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { factsFor, recordFor } from '../support/server-facts.ts'
import { board, renderInBoard } from './support/board.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { type Element, find, findAll, hasClass, type Node, serializeNodes } from './support/markup.ts'
import { clone, commit, first } from './support/react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './support/react-events.ts'

const t = translator('en')
const ru = translator('ru')
const VP = { w: 1600, h: 1000 }
const NOW = new Date(2026, 9, 21, 15, 0).getTime()
const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFake agent-board@DESK'
/** The passwords the tests type: quotes, `$`, `%`, a backtick and another alphabet. */
const SENTINEL = `S3cr3t%$'"\`Ж`
const SUDO_SENTINEL = `Sud0%$'"\`Щ`
const W: Wanted = { user: 'boardtunnel', socket: TUNNEL_SOCKET, domain: 'board.example.com', publicPort: null }
const NOTE = 'remembered by this board for 30 minutes after it is last used, in its memory only; never saved'
const CALL_4 = 'If the web server is not set up yet, this step fails until it is: set it up on the Server tab.'
/** What the owner must never meet outside a fold (the spec's Goals). */
const JARGON = /\b(network|case|container|caddyfile)\b|сеть|сети|контейнер|caddyfile|случа/i

/** Set up and on: the key made, the server's key pinned (Test connection passed). */
const READY: AccessView = {
  tunnel: {
    settings: {
      on: true,
      host: 'ssh.example.com',
      sshPort: 22,
      user: 'boardtunnel',
      key: '',
      socket: TUNNEL_SOCKET,
      domain: 'board.example.com',
      port: null,
      publicPort: null,
    },
    problems: [],
    blocked: null,
    listenPort: 12424,
    status: { state: 'connected', since: NOW - 60_000, probe: null },
    ssh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    key: {
      path: 'C:\\Users\\me\\tunnel\\id_ed25519',
      generated: true,
      exists: true,
      publicKey: PUBLIC_KEY,
      error: null,
    },
    hostKey: 'SHA256:q0wErTyUiOpAsDfGhJkL (ED25519)',
  },
  login: { password: true, totp: true, passkeys: [], lockout: null },
  logins: [],
  attempts: [],
  server: null,
}

/** An empty panel but for the board's address: no server, no tunnel user, no key, nothing pinned. */
const FRESH: AccessView = {
  ...READY,
  tunnel: {
    ...READY.tunnel,
    settings: { ...READY.tunnel.settings, on: false, host: '', user: '' },
    key: { ...READY.tunnel.key, exists: false, publicKey: null },
    hostKey: null,
  },
}

/** Nothing looked at yet: the admin user typed, nothing else. */
const IDLE: ServerView = {
  admin: { user: 'admin', key: '' },
  sudo: null,
  phase: 'idle',
  facts: null,
  choice: null,
  plan: null,
  progress: null,
  hint: null,
  error: null,
  setup: null,
  testAfter: null,
  hostKey: null,
}

const withServer = (over: Partial<ServerView>, view: AccessView = READY): AccessView => ({
  ...view,
  server: { ...IDLE, ...over },
})

const isPlan = (p: Plan | { case: null }): p is Plan => 'steps' in p

/** Look done for a case: its facts, the case it makes and the plan, as the board sends them. */
function planned(
  c: SetupCase | 'nodocker',
  distro: 'debian13' | 'ubuntu2604' = 'debian13',
  over: Partial<ServerView> = {},
): AccessView {
  const facts = factsFor(c, distro)
  const built = buildPlan(facts, W, { id: 'p1', docker: false })
  return withServer({
    phase: 'plan',
    sudo: 'nopasswd',
    facts,
    choice: chooseCase(facts, W),
    plan: isPlan(built) ? built : null,
    ...over,
  })
}

/** Look done on a server the board does not do: its facts, and why. */
function stopped(facts: ServerFacts, over: Partial<ServerView> = {}): AccessView {
  return withServer({ phase: 'plan', sudo: 'root', facts, choice: chooseCase(facts, W), plan: null, ...over })
}

/** Fedora: a system the board does not set up. */
const FEDORA: ServerFacts = {
  ...factsFor('1'),
  distro: { id: 'fedora', version: '41', codename: '', arch: 'x86_64', supported: false },
}

function planOf(view: AccessView): Plan {
  const plan = view.server?.plan
  if (!plan) throw new Error('no plan')
  return plan
}

/** A run's progress after these lines of it. */
const progressOf = (plan: Plan, lines: [string, number][]): Progress =>
  lines.reduce((p, [line, at]) => readProgress(p, line, at), startProgress(plan))

const title = (plan: Plan, n: number): string => {
  const step = plan.steps[n - 1]
  if (!step) throw new Error(`no step ${n}`)
  return t(step.title.key, step.title.params)
}

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const byClass = (nodes: Node[], name: string): Element[] => findAll(nodes, el => hasClass(el, name))
const textsOf = (nodes: Node[], name: string): string[] => byClass(nodes, name).map(textOf)
const buttonsIn = (nodes: Node[]): Element[] =>
  findAll(nodes, el => el.tag === 'button' && !hasClass(el, 'access-copy'))
const button = (nodes: Node[], label: string): Element => find(nodes, el => el.tag === 'button' && textOf(el) === label)
const fold = (nodes: Node[], name: string): Element => find(nodes, el => el.tag === 'details' && hasClass(el, name))
const summaryOf = (d: Element): string => textOf(find([d], el => el.tag === 'summary'))

/** What the owner reads without opening a fold: the text drawn, of a closed fold its summary only. */
function shownText(nodes: Node[]): string {
  const walk = (n: Node): string => {
    if (n.kind === 'text') return n.text
    if (n.tag === 'details' && !n.attrs.has('open')) {
      const summary = n.children.find((c): c is Element => c.kind === 'element' && c.tag === 'summary')
      return summary ? walk(summary) : ''
    }
    return n.children.map(walk).join(' ')
  }
  return nodes.map(walk).join(' ')
}

/** The part as drawn for a view, from its own start (nothing typed, nothing open). */
function partOf(view: AccessView, more: { lang?: string; canEdit?: boolean } = {}): Node[] {
  return renderInBoard(
    <ServerSetup view={view} send={async () => null} />,
    board({ now: NOW, ...(more.canEdit === false && { connected: false, canEdit: false }) }),
    more.lang ?? 'en',
  )
}

/** The part as drawn for a view with what it keeps (a state the owner's clicks led to). */
function partWith(view: AccessView, state: SetupState): Node[] {
  return renderInBoard(
    <ServerSetupBody view={view} send={async () => null} state={state} onState={() => {}} now={NOW} />,
    board({ now: NOW }),
  )
}

/** The whole panel's body, for the Tunnel part around the flow. */
function bodyOf(view: AccessView, steps: TestStep[] | null = null, lang = 'en'): Node[] {
  return renderInBoard(
    <PanelProvider viewport={() => VP}>
      <AccessBody view={view} send={async () => null} steps={steps} testing={false} />
    </PanelProvider>,
    board({ now: NOW }),
    lang,
  )
}

// ---------------------------------------------------------------- live, with React's handlers

/**
 * The part live in a fake DOM with React's handlers (support/react-events.ts), drawn again after
 * every event as React would (support/react-commit.ts). What the part keeps (SetupState) is kept
 * here as ServerSetup keeps it; what it sends goes to `reply`, and is kept with its body.
 */
function liveServer(
  view: AccessView,
  reply: (op: string, body: Record<string, unknown>) => Record<string, unknown> | null = () => ({ ok: true }),
  more: { saves?: Saves; fields?: ReactNode; steps?: TestStep[] | null } = {},
) {
  const toasts: string[] = []
  const context = board({ now: NOW, toast: text => void toasts.push(text) })
  const calls: [string, Record<string, unknown>][] = []
  let state: SetupState = SETUP_START
  const send: AccessSend = async (op, body = {}) => {
    calls.push([op, body])
    return reply(op, body)
  }
  const world = new FakeWorld({ viewport: VP })
  const tree = () => (
    <ServerSetupBody
      view={view}
      send={send}
      state={state}
      onState={patch => {
        state = { ...state, ...patch }
      }}
      now={NOW}
      {...more}
    />
  )
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
  const idle = async () => {
    for (let i = 0; i < 16; i++) {
      await Bun.sleep(0)
      await world.flush()
    }
  }
  const buttonOf = (label: string): FakeElement => {
    const found = page()
      .querySelectorAll('button')
      .find(b => b.textContent === label)
    if (!found) throw new Error(`no button ${label}`)
    return found
  }
  return {
    toasts,
    calls,
    state: () => state,
    /** What the part renders now (React's markup, not the live fields). */
    markup: () => serializeNodes(drawn ? [drawn.markup] : []),
    nodes: (): Node[] => (drawn ? [drawn.markup] : []),
    pick,
    idle,
    has: (selector: string) => page().querySelector(selector) !== null,
    buttons: () =>
      page()
        .querySelectorAll('button')
        .map(b => b.textContent),
    text: (selector: string) =>
      page()
        .querySelectorAll(selector)
        .map(el => el.textContent),
    disabled: (label: string) => buttonOf(label).getAttribute('disabled') !== null,
    async click(label: string) {
      await world.fire(buttonOf(label), 'click')
      await idle()
    },
    /** Typed into a field (it stays focused). */
    async type(name: string, text: string, key?: string) {
      const field = pick(`input[name="${name}"]`)
      field.focus()
      await world.fire(field, 'focusin')
      field.value = text
      await world.fire(field, 'input')
      if (key) await world.fire(field, 'keydown', { key })
      await idle()
    },
    /** The field left. */
    async leave(name: string) {
      await world.fire(pick(`input[name="${name}"]`), 'focusout')
      await idle()
    },
    async tick(name: string) {
      await world.fire(pick(`input[name="${name}"]`), 'click')
      await idle()
    },
    /** A fold opened or closed by the owner, as the browser does it: its `open`, then its toggle event. */
    async toggle(selector: string) {
      const d = pick(selector)
      if (d.hasAttribute('open')) d.removeAttribute('open')
      else d.setAttribute('open', '')
      await world.fire(d, 'toggle')
      await idle()
    },
  }
}

const storageSaved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
afterEach(() => {
  restoreFetch()
  if (storageSaved) Object.defineProperty(globalThis, 'localStorage', storageSaved)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

/** A localStorage that keeps what is put in it, for the test to read. */
function watchStorage(): Map<string, string> {
  const kept = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, String(value)),
      removeItem: (key: string) => void kept.delete(key),
      clear: () => kept.clear(),
      key: (i: number) => [...kept.keys()][i] ?? null,
      get length() {
        return kept.size
      },
    },
    configurable: true,
    writable: true,
  })
  return kept
}

// ---------------------------------------------------------------- nothing looked at

test('nothing looked at: the login (root by default), its password, a key file folded; Set up the server', () => {
  const part = partOf(withServer({}))
  const inputs = findAll(part, el => el.tag === 'input')
  expect(
    inputs.map(el => ['name', 'type', 'value', 'placeholder', 'aria-label'].map(a => el.attrs.get(a) ?? '')),
  ).toEqual([
    ['admin-user', '', 'admin', 'root', 'Login'],
    ['login-password', 'password', '', '', 'Password'],
    ['admin-key', '', '', 'the ssh agent and ~/.ssh keys', 'Key file'],
    // the board installed on the server answers on an address of its own, not the tunnel's
    ['install-domain', '', '', 'workbench.example.com', 'Address of the board on the server'],
  ])
  expect(textsOf(part, 'access-kept')).toEqual([NOTE])
  // The login's fields open; the key file and "Do it myself" folded.
  expect(
    [fold(part, 'access-signin'), fold(part, 'access-keyfile'), fold(part, 'access-oneshot')].map(summaryOf),
  ).toEqual(['The server and its login', 'Log in with a key file instead', 'Do it myself (one command)'])
  expect(fold(part, 'access-signin').attrs.has('open')).toBe(true)
  expect(fold(part, 'access-keyfile').attrs.has('open')).toBe(false)
  expect(fold(part, 'access-oneshot').attrs.has('open')).toBe(false)
  // beside it, the board installed on the server itself (path B of the board on a server)
  expect(buttonsIn(part).map(textOf)).toEqual(['Set up the server', 'Install the board on this server'])
  expect(button(part, 'Set up the server').attrs.has('disabled')).toBe(false)
  // No sudo field, no plan, no steps by hand, no case chips: none asked for.
  expect(findAll(part, el => el.attrs.get('name') === 'sudo-password')).toEqual([])
  for (const name of ['access-plain', 'access-details', 'access-byhand', 'access-snippets', 'access-pick'])
    expect([name, byClass(part, name)]).toEqual([name, []])
  // The words of the empty part are plain, in English and Russian.
  expect(shownText(part)).not.toMatch(JARGON)
  expect(shownText(partOf(withServer({}), { lang: 'ru' }))).not.toMatch(JARGON)

  // Nothing said of the server yet: the login is root; Set up needs neither a saved login nor a pinned key (call 2).
  const none = partOf({ ...FRESH, server: null })
  expect(find(none, el => el.attrs.get('name') === 'admin-user').attrs.get('value')).toBe('root')
  expect(button(none, 'Set up the server').attrs.has('disabled')).toBe(false)
  expect(byClass(none, 'access-look-why')).toEqual([])
  // A key file named: its fold open.
  expect(fold(partOf(withServer({ admin: { user: 'root', key: 'D:\\k' } })), 'access-keyfile').attrs.has('open')).toBe(
    true,
  )
  // No ssh: off, and why.
  const noSsh = partOf({ ...withServer({}), tunnel: { ...READY.tunnel, ssh: null } })
  expect(button(noSsh, 'Set up the server').attrs.has('disabled')).toBe(true)
  expect(textsOf(noSsh, 'access-look-why')).toEqual([t('tunnel.hint.noSsh')])
  // Without the board its fields and buttons do nothing.
  const off = partOf(withServer({}), { canEdit: false })
  const controls = findAll(off, el => (el.tag === 'input' || el.tag === 'button') && !hasClass(el, 'access-copy'))
  expect(controls.length).toBe(6)
  expect(controls.filter(el => !el.attrs.has('disabled'))).toEqual([])
})

test('an admin field left goes to the board as server-admin, trimmed; the same value sends nothing', async () => {
  const live = liveServer(withServer({}))
  await live.type('admin-user', ' root ')
  await live.leave('admin-user')
  expect(live.calls).toEqual([['server-admin', { user: 'root' }]])
  await live.type('admin-key', ' D:\\keys\\admin ')
  await live.leave('admin-key')
  expect(live.calls.at(-1)).toEqual(['server-admin', { key: 'D:\\keys\\admin' }])
  // Refused: the board's value shows again (the refusal itself is toasted by the panel's source).
  const refused = liveServer(withServer({}), () => ({ ok: false, field: 'user', error: 'no' }))
  await refused.type('admin-user', '-l')
  await refused.leave('admin-user')
  expect(refused.pick('input[name="admin-user"]').value).toBe('admin')
  // The same value: nothing.
  const same = liveServer(withServer({}))
  await same.type('admin-user', 'admin ')
  await same.leave('admin-user')
  expect(same.calls).toEqual([])
  // None saved: the field says root; tabbed through, or root typed, nothing is written (Set up the
  // server saves root itself); emptied, root shows again.
  const none = liveServer({ ...READY, server: null })
  expect(none.pick('input[name="admin-user"]').value).toBe('root')
  await none.leave('admin-user')
  await none.type('admin-user', ' root ')
  await none.leave('admin-user')
  expect(none.calls).toEqual([])
  await none.type('admin-user', '')
  await none.leave('admin-user')
  expect(none.calls).toEqual([])
  expect(none.pick('input[name="admin-user"]').value).toBe('root')
})

// ---------------------------------------------------------------- Set up the server

test('Set up the server from an empty panel: the server, the board’s login and key filled in, root saved, then Look with the password', async () => {
  const live = liveServer({ ...FRESH, server: null })
  await live.type('login-password', SENTINEL)
  await live.click('Set up the server')
  expect(live.calls).toEqual([
    ['tunnel', { fields: { host: 'board.example.com', user: 'boardtunnel' } }],
    ['key-generate', {}],
    ['server-admin', { user: 'root' }],
    ['server-look', { password: SENTINEL }],
  ])
  expect(flowFill(FRESH.tunnel.settings)).toEqual({ host: 'board.example.com', user: 'boardtunnel' })
  expect(flowFill({ ...FRESH.tunnel.settings, domain: '' })).toBeNull()

  // Everything there already (another setup, done by hand or before): Look alone, as before.
  const ready = liveServer(withServer({}))
  await ready.click('Set up the server')
  expect(ready.calls).toEqual([['server-look', {}]])
  expect(flowFill(READY.tunnel.settings)).toBeNull()
  // A key of their own (not the board's) that is not there: left to them, never made.
  const own = liveServer({
    ...withServer({}),
    tunnel: { ...READY.tunnel, key: { ...READY.tunnel.key, generated: false, exists: false } },
  })
  await own.click('Set up the server')
  expect(own.calls).toEqual([['server-look', {}]])
  // A key made meanwhile (the board says it has one): on to Look.
  const made = liveServer({ ...FRESH, server: IDLE }, op =>
    op === 'key-generate' ? { ok: false, confirm: 'key' } : { ok: true },
  )
  await made.click('Set up the server')
  expect(made.calls.map(c => c[0])).toEqual(['tunnel', 'key-generate', 'server-look'])

  // No address: nothing sent, and why.
  const empty = { ...FRESH, tunnel: { ...FRESH.tunnel, settings: { ...FRESH.tunnel.settings, domain: '' } } }
  const blank = liveServer({ ...empty, server: null })
  await blank.click('Set up the server')
  expect(blank.calls).toEqual([])
  expect(blank.text('.access-look-why')).toEqual(['Type the board’s address first.'])
  // A fill the board refuses stops before Look.
  const refused = liveServer({ ...FRESH, server: null }, op => (op === 'tunnel' ? { ok: false } : { ok: true }))
  await refused.click('Set up the server')
  expect(refused.calls.map(c => c[0])).toEqual(['tunnel'])
})

test('Set up the server waits for a field’s save on its way, and goes on from what the board took', async () => {
  const saves = savesTracker()
  let answer: (reply: Record<string, unknown>) => void = () => {}
  // The board's address typed and left just before the click: its save (with the server filled in from it) on its way.
  const fields = { domain: 'board.example.com', host: 'board.example.com' }
  void saves.track(new Promise(resolve => (answer = resolve)), { tunnel: fields })
  const empty = { ...FRESH, tunnel: { ...FRESH.tunnel, settings: { ...FRESH.tunnel.settings, domain: '' } } }
  const live = liveServer(withServer({}, empty), undefined, { saves })
  await live.click('Set up the server')
  expect(live.calls).toEqual([])
  answer({ ok: true })
  await live.idle()
  // The view has not come back yet, but the board took the address and the server: only the rest is filled in.
  expect(live.calls).toEqual([
    ['tunnel', { fields: { user: 'boardtunnel' } }],
    ['key-generate', {}],
    ['server-look', {}],
  ])
  // A save the board refused is not taken.
  const refused = savesTracker()
  void refused.track(Promise.resolve({ ok: false }), { tunnel: { domain: 'x.example.com' } })
  expect(await refused.settle()).toEqual({ tunnel: {}, admin: {} })
  void refused.track(Promise.resolve({ ok: true }), { admin: { user: 'ubuntu' } })
  expect(await refused.settle()).toEqual({ tunnel: {}, admin: { user: 'ubuntu' } })
})

// ---------------------------------------------------------------- the passwords

test('the passwords: the login’s with Look, sudo’s own only when asked; a field asked for is emptied and pointed at; kept by the part alone', async () => {
  const kept = watchStorage()
  const replies: Record<string, unknown>[] = [
    { ok: false, hint: 'wrongLogin', need: 'password' },
    { ok: false, hint: 'sudoPassword', need: 'sudoPassword' },
    { ok: true },
  ]
  const live = liveServer(withServer({}), () => replies.shift() ?? { ok: true })
  expect(live.has('input[name="sudo-password"]')).toBe(false)
  await live.type('login-password', 'wrong')
  await live.click('Set up the server')
  expect(live.calls).toEqual([['server-look', { password: 'wrong' }]])
  // The login's password refused: emptied, and its field pointed at.
  expect([live.state().need, live.state().password, live.state().asks]).toEqual(['password', '', 1])
  expect(live.has('.access-asked input[name="login-password"]')).toBe(true)
  await live.type('login-password', SENTINEL)
  // Enter in the field goes on.
  await live.type('login-password', SENTINEL, 'Enter')
  expect(live.calls.at(-1)).toEqual(['server-look', { password: SENTINEL }])
  // sudo would not take it: sudo's own field shows, asked for; the login's password stays.
  expect(live.has('input[name="sudo-password"]')).toBe(true)
  expect(live.text('.access-asked span')).toEqual(['sudo’s password'])
  expect(live.state().password).toBe(SENTINEL)
  await live.type('sudo-password', SUDO_SENTINEL)
  await live.click('Set up the server')
  expect(live.calls.at(-1)).toEqual(['server-look', { password: SENTINEL, sudoPassword: SUDO_SENTINEL }])
  expect(live.state().need).toBeNull()
  // Kept by the part (its state) and nowhere else: not stored, not drawn, not toasted.
  expect([...kept.entries()].filter(([k, v]) => /S3cr3t|Sud0/.test(`${k}${v}`))).toEqual([])
  expect(live.markup()).not.toMatch(/S3cr3t|Sud0/)
  expect(live.toasts).toEqual([])

  // The model: what an answer asks for; the passwords only once typed.
  expect(answerPatch({ ok: false, need: 'password' }, 'server-look', SETUP_START)).toEqual({
    need: 'password',
    password: '',
    asks: 1,
    again: 'server-look',
  })
  expect(answerPatch({ ok: true }, 'server-look', SETUP_START)).toEqual({ need: null, again: 'server-look' })
  // Continue goes on with Undo's Look only while Undo's ask stands.
  expect(answerPatch({ ok: true }, 'server-undo-look', { ...SETUP_START, again: 'server-undo-look' })).toEqual({
    need: null,
    again: 'server-look',
  })
  expect(withPassword(SETUP_START)).toEqual({})
  expect(withPassword({ ...SETUP_START, sudoPassword: 'x' })).toEqual({ sudoPassword: 'x' })
  // The board's hint alone (a view drawn anew) shows sudo's field too, by needFor.
  for (const hint of ['sudoPassword', 'wrongPassword'] as const) {
    expect(needFor(hint)).toBe('sudoPassword')
    expect(findAll(partOf(withServer({ hint })), el => el.attrs.get('name') === 'sudo-password')).toHaveLength(1)
  }
  expect(findAll(partOf(withServer({ hint: 'wrongLogin' })), el => el.attrs.get('name') === 'sudo-password')).toEqual(
    [],
  )
})

test('each hint of the login by password says what to do, in English and Russian, under the button', () => {
  const hints: AdminHint[] = [
    'loginPassword',
    'wrongLogin',
    'rootLogin',
    'keyOnly',
    'otherPrompt',
    'sshOld',
    'sudoPassword',
    'needPassword',
    'wrongPassword',
    'publickey',
    'hostKey',
    'network',
  ]
  for (const hint of hints) {
    const line = hintLine(hint, t, 'ubuntu')
    expect([hint, line]).toEqual([hint, t(`server.hint.${hint}`, { admin: 'ubuntu' })])
    expect(line).not.toBe(`server.hint.${hint}`)
    expect(hintLine(hint, ru, 'ubuntu')).not.toBe(line)
    expect(textsOf(partOf(withServer({ hint, admin: { user: 'ubuntu', key: '' } })), 'access-hint')).toEqual([line])
  }
  expect(hintLine('wrongLogin', t, 'ubuntu')).toContain('ubuntu')
})

test('sudo or the login asking for a password is asked by the panel, not toasted; other refusals are; the passwords only in a body', async () => {
  const toasts: string[] = []
  const need = { ok: false, hint: 'needPassword', error: 'sudo asks for a password', need: 'password' }
  const sudo = { ok: false, hint: 'sudoPassword', error: 'sudo needs its own password', need: 'sudoPassword' }
  const calls = answers(
    [409, need],
    [200, READY],
    [409, sudo],
    [200, READY],
    [409, { ok: false, hint: 'lookAgain', error: 'Look again' }],
    [200, READY],
  )
  const source = accessSource({ t: () => t, toast: text => void toasts.push(text) })
  const settle = async () => {
    for (let i = 0; i < 6; i++) await Bun.sleep(0)
  }
  expect(await source.send('server-look', {})).toEqual(need)
  await settle()
  expect(await source.send('server-look', { password: SENTINEL })).toEqual(sudo)
  await settle()
  expect(toasts).toEqual([])
  expect(
    await source.send('server-apply', { plan: 'p0', password: SENTINEL, sudoPassword: SUDO_SENTINEL }),
  ).toMatchObject({ hint: 'lookAgain' })
  await settle()
  expect(toasts).toEqual(['Look again'])
  expect(sent(calls).map(c => c.slice(0, 2))).toEqual([
    ['/api/access', 'POST'],
    ['/api/access', undefined],
    ['/api/access', 'POST'],
    ['/api/access', undefined],
    ['/api/access', 'POST'],
    ['/api/access', undefined],
  ])
  expect(calls.filter(c => String(c.init?.body ?? '').includes('S3cr3t'))).toHaveLength(2)
  expect(calls.map(c => c.url).join(' ')).not.toMatch(/S3cr3t|Sud0/)
})

// ---------------------------------------------------------------- the plan in plain words

/** sshd -T's lines as the panel's Match block sets them (Look read them back the same). */
const fenceOf = (user: string): Record<string, string> =>
  Object.fromEntries(
    sshdBlock(user)
      .split('\n')
      .slice(1)
      .map(line => {
        const [key = '', ...value] = line.trim().split(/\s+/)
        return [key.toLowerCase(), value.join(' ')]
      }),
  )

test('case 2 on Debian 13: what I found with the server’s key, what I will do, what is not touched; the full plan under Details', () => {
  const hostKey = { fingerprint: 'SHA256:q0wErTyUiOpAsDfGhJkL (ED25519)', pinnedNow: true }
  const view = planned('2', 'debian13', { hostKey })
  const plan = planOf(view)
  const facts = view.server?.facts as ServerFacts
  const part = partOf(view)
  const plain = find(part, el => hasClass(el, 'access-plain'))
  expect(textsOf([plain], 'access-sub')).toEqual(['What I found', 'What I will do'])
  expect(textsOf([plain], 'access-found-line')).toEqual([
    'Debian 13 · Caddy serves 443 and 80: blog.example.org, shop.example.org',
  ])
  expect(textsOf([plain], 'access-found-line')).toEqual([plainPlan(facts, plan, W, t).found])
  expect(textsOf([plain], 'access-hostkey')).toEqual([
    'The server’s key: SHA256:q0wErTyUiOpAsDfGhJkL (ED25519) (remembered now: the board checks it at every login)',
  ])
  expect(textsOf([plain], 'access-will-line')).toEqual([
    'Add board.example.com to your Caddy and hand it the board’s tunnel.',
  ])
  expect(textsOf([plain], 'access-untouched')).toEqual([
    'Your sites are not touched; each is checked before and after.',
  ])
  // A key pinned before: said without "remembered now".
  expect(
    textsOf(partOf(planned('2', 'debian13', { hostKey: { ...hostKey, pinnedNow: false } })), 'access-hostkey'),
  ).toEqual(['The server’s key: SHA256:q0wErTyUiOpAsDfGhJkL (ED25519)'])
  expect(byClass(partOf(planned('2')), 'access-hostkey')).toEqual([])
  expect(buttonsIn(part).map(textOf)).toEqual(['Apply', 'Cancel'])
  expect(button(part, 'Apply').attrs.has('disabled')).toBe(false)
  // No jargon outside the folds, in either language.
  expect(shownText(part)).not.toMatch(JARGON)
  expect(shownText(partOf(view, { lang: 'ru' }))).not.toMatch(JARGON)

  // Details, folded: what Look found line by line, the case, the address, the plan's steps.
  const details = fold(part, 'access-details')
  expect(details.attrs.has('open')).toBe(false)
  expect(summaryOf(details)).toBe('Details: every file and line, and how Undo removes them')
  expect(textsOf([details], 'access-fact')).toEqual(foundLines(facts, t, 'boardtunnel'))
  expect(textsOf([details], 'access-fact')).toEqual([
    'Debian 13 · Docker 29.0.1 · 443 and 80: caddy (caddy.service)',
    "The tunnel's fence in sshd: not in place (authorizedkeysfile, authenticationmethods, passwordauthentication, kbdinteractiveauthentication, …)",
    "The socket's folder: 2750 boardtunnel:boardtunnel ✓",
    "Your Caddy's config: /etc/caddy/Caddyfile (read by its service), Caddy v2.6.2",
  ])
  // One key off: named.
  const oneOff = { ...fenceOf('boardtunnel'), permittty: 'yes' }
  expect(foundLines({ ...facts, fence: oneOff }, t, 'boardtunnel')[1]).toBe(
    `The tunnel's fence in sshd: not in place (${fenceDiff(oneOff, 'boardtunnel').join(', ')})`,
  )
  expect(fenceDiff(oneOff, 'boardtunnel')).toEqual(['permittty'])
  expect(textsOf([details], 'access-case')).toEqual([t('server.case.2', { unit: 'caddy.service' })])
  expect(textsOf([details], 'access-address')).toEqual(['Address: https://board.example.com'])
  expect(textsOf([details], 'access-sub')).toContain('The plan (nothing changes until Apply)')
  expect(textsOf([details], 'access-num')).toEqual(plan.steps.map((_, i) => String(i + 1)))
  expect(textsOf([details], 'access-title')).toEqual(plan.steps.map((_, i) => title(plan, i + 1)))
  expect(textsOf([details], 'access-why-step')).toEqual(plan.steps.map(s => t(s.why.key, s.why.params)))
  expect(textsOf([details], 'access-touches')).toEqual([
    'file /etc/caddy/agent-board/board.caddy',
    'the group of /var/lib/boardtunnel',
    'a backup of /etc/caddy/Caddyfile',
    'a line in /etc/caddy/Caddyfile',
    'a reload of /etc/caddy/Caddyfile',
  ])
  expect(textsOf([details], 'access-relies')).toEqual([`Checked first, as Look found it: ${plan.relies.join(' · ')}`])
  expect(textsOf([details], 'access-undo-line')).toEqual([
    'Undo removes or puts back: file /etc/caddy/agent-board/board.caddy · the group of /var/lib/boardtunnel · a backup of /etc/caddy/Caddyfile · a line in /etc/caddy/Caddyfile. Then it reloads /etc/caddy/Caddyfile again.',
  ])
  // No run yet: no states.
  expect(byClass(part, 'access-state')).toEqual([])
  // The fence as the panel's: ✓.
  const fenced = foundLines({ ...facts, fence: fenceOf('boardtunnel') }, t, 'boardtunnel')
  expect(fenced[1]).toBe("The tunnel's fence in sshd: in place ✓")
  // No folder yet (Apply makes it), or one that is not the tunnel user's: ✗.
  expect(foundLines({ ...facts, folder: null }, t, 'boardtunnel')[2]).toBe("The socket's folder: not there yet")
  expect(
    foundLines(
      { ...facts, folder: { mode: '755', owner: 'root', group: 'root', gid: 0, members: [] } },
      t,
      'boardtunnel',
    )[2],
  ).toBe("The socket's folder: 755 root:root ✗ (the board's is 2750, the tunnel user's)")
})

test('case 3a on Ubuntu 26.04: Caddy in Docker in plain words; its network and the warnings only in Details', () => {
  const view = planned('3a', 'ubuntu2604')
  const part = partOf(view)
  expect(textsOf(part, 'access-found-line')).toEqual([
    'Ubuntu 26.04 · Caddy in Docker serves 443 and 80: shop.example.org',
  ])
  expect(shownText(part)).not.toMatch(JARGON)
  const details = fold(part, 'access-details')
  expect(textsOf([details], 'access-fact')).toEqual([
    'Ubuntu 26.04 · Docker 29.0.1 · 443 and 80: "web-caddy-1" in Docker (caddy:2, compose "web")',
    expect.stringContaining("The tunnel's fence in sshd: not in place"),
    "The socket's folder: 2750 boardtunnel:boardtunnel ✓",
    "Your Caddy's config: /srv/my web/Caddyfile (in a folder mounted into its container), Caddy v2.10.2",
  ])
  expect(textsOf([details], 'access-case')).toEqual([
    t('server.case.3a', { container: 'web-caddy-1', network: 'web_default' }),
  ])
  expect(textsOf([details], 'access-caution')).toEqual([
    t('server.warn.tcpHop'),
    t('server.warn.composeDown', { network: 'web_default' }),
  ])
  expect(textsOf(part, 'access-caution')).toHaveLength(2)
  expect(textsOf([details], 'access-touches')).toContain('container agent-board-socket · network web_default')
  // Not Debian or Ubuntu as supported, and two holders: said so in the details.
  const other: ServerFacts = {
    ...factsFor('1'),
    distro: { id: 'fedora', version: '41', codename: '', arch: 'x86_64', supported: false },
    docker: null,
    ports: { ...factsFor('1').ports, 443: { kind: 'process', program: 'httpd' }, 80: { kind: 'free' } },
  }
  expect(foundLines(other, t, 'boardtunnel')[0]).toBe(
    'Fedora 41 (not supported: Do it myself) · no Docker · 443: httpd · 80: free',
  )
})

test('the password the board remembers: until when, next to the field; Forget the password; nothing asked while it holds one', async () => {
  const until = NOW + 20 * 60_000
  const held = withServer({ passwordHeld: { until } })
  const live = liveServer(held)
  const line = `Password remembered until ${timeOf(until, t)}`
  expect(live.text('.access-held')).toEqual([line])
  expect(live.text('.access-kept')).toEqual([line])
  await live.click('Forget the password')
  expect(live.calls).toEqual([['server-password-forget', {}]])
  // Over (the board's clock past it), or none: the field's note as before, no Forget.
  for (const view of [withServer({ passwordHeld: { until: NOW - 1 } }), withServer({ passwordHeld: null })]) {
    const part = partOf(view)
    expect(textsOf(part, 'access-kept')).toEqual([NOTE])
    expect(buttonsIn(part).map(textOf)).not.toContain('Forget the password')
  }
  // In Russian.
  expect(textsOf(partOf(held, { lang: 'ru' }), 'access-held')).toEqual([`Пароль запомнен до ${timeOf(until, ru)}`])
  // sudo wants a password, none typed, but the board holds one: Apply goes, with nothing typed in it.
  const plan = planned('2', 'debian13', { sudo: 'password' })
  const apply = liveServer({ ...plan, server: plan.server && { ...plan.server, passwordHeld: { until } } })
  expect(apply.disabled('Apply')).toBe(false)
  await apply.click('Apply')
  expect(apply.calls).toEqual([['server-apply', { plan: 'p1' }]])
  // A Look that went through with the password typed: the board holds it now, the panel lets it go.
  const look = liveServer(withServer({}))
  await look.type('login-password', SENTINEL)
  await look.click('Set up the server')
  expect(look.calls).toEqual([['server-look', { password: SENTINEL }]])
  expect([look.state().password, look.state().sudoPassword]).toEqual(['', ''])
  // Refused: what was typed is asked for again, as before.
  const refused = liveServer(withServer({}), () => ({ ok: false, hint: 'network' }))
  await refused.type('login-password', 'pw')
  await refused.click('Set up the server')
  expect(refused.state().password).toBe('pw')
})

test('a plan that installs Docker: said in plain words, Apply off until its OK, then the plan, the tick and the password', async () => {
  const view = planned('nodocker', 'debian13', { sudo: 'password' })
  expect(planOf(view).ticks).toEqual(['docker'])
  const live = liveServer(view)
  expect(live.text('.access-plain .access-docker')).toEqual([
    'Docker is not installed: I will install it from Docker’s own repository.',
  ])
  expect(live.text('.access-plain .access-tick')).toEqual(['OK, install Docker'])
  // The ports to open at the provider: a warning the owner reads before Apply.
  expect(live.text('.access-plain .access-caution')).toEqual([t('server.warn.ports', planOf(view).warnings[0]?.params)])
  expect(live.has('.access-details .access-tick')).toBe(false)
  expect(live.disabled('Apply')).toBe(true)
  await live.type('login-password', SENTINEL)
  expect(live.disabled('Apply')).toBe(true)
  await live.tick('tick-docker')
  expect(live.disabled('Apply')).toBe(false)
  await live.click('Apply')
  expect(live.calls).toEqual([['server-apply', { plan: 'p1', docker: true, password: SENTINEL }]])
  // The board took it for this run: the panel keeps it no longer, Undo asks again (call 9).
  expect([live.state().password, live.state().sudoPassword]).toEqual(['', ''])
  // Ticked off again: off again.
  await live.tick('tick-docker')
  expect(live.disabled('Apply')).toBe(true)
  // sudo wants a password and none is typed: Apply off until one is.
  const noPassword = liveServer(planned('2', 'debian13', { sudo: 'password' }))
  expect(noPassword.disabled('Apply')).toBe(true)
  // A plan that needs no tick, with sudo that needs no password: Apply at once, nothing else sent.
  const plain = liveServer(planned('2'))
  await plain.click('Apply')
  expect(plain.calls).toEqual([['server-apply', { plan: 'p1' }]])
  // Apply refused for want of the password (the page reloaded since Look): its field asked for.
  const asked = liveServer(planned('2'), () => ({ ok: false, hint: 'loginPassword', need: 'password' }))
  await asked.click('Apply')
  expect(asked.state().need).toBe('password')
  expect(asked.has('.access-asked input[name="login-password"]')).toBe(true)
  // Refused for another reason: the password stays for the next try.
  const again = liveServer(planned('2'), () => ({ ok: false, hint: 'lookAgain' }))
  await again.type('login-password', 'pw')
  await again.click('Apply')
  expect(again.state().password).toBe('pw')
  // Cancel drops the plan.
  await plain.click('Cancel')
  expect(plain.calls.at(-1)).toEqual(['server-cancel', {}])
})

test('the 8443 address for case 4a and 4b; nothing to change for a setup already there', () => {
  for (const c of ['4a', '4b'] as const) {
    const part = partOf(planned(c))
    expect(textsOf(part, 'access-address')).toEqual(['Address: https://board.example.com:8443'])
    expect(textsOf(part, 'access-will-line').join(' ')).toContain('https://board.example.com:8443')
  }
  const facts = { ...factsFor('1'), record: recordFor('1') }
  const nothing = { ...planOf(planned('1')), kind: 'nothing' as const }
  const part = partOf(withServer({ phase: 'plan', facts, choice: chooseCase(facts, W), plan: nothing }))
  expect(textsOf(part, 'access-will-line')).toEqual(['Nothing to change: the board is set up here already.'])
  expect(textsOf(part, 'access-case')).toEqual([t('server.case.same', { case: '1', domain: 'board.example.com' })])
  expect(textsOf(part, 'access-nothing')).toEqual(['Nothing to change: the server is set up as the panel says.'])
  expect(buttonsIn(part).map(textOf)).toEqual(['Cancel'])
})

// ---------------------------------------------------------------- a server the board does not do

test('a server the board does not do: why in one line, the steps by hand folded; never for a server it does', async () => {
  const part = partOf(stopped(FEDORA))
  expect(textsOf(part, 'access-stop')).toEqual([
    'The board does not set this server up by itself: it sets up Debian 12 and 13 and Ubuntu 22.04 to 26.04 only, with the tools they come with.',
  ])
  expect(textsOf(part, 'access-untouched')).toEqual(['Nothing on the server is changed.'])
  expect(byClass(part, 'access-will')).toEqual([])
  // Cancel, and no Apply: the only button outside the steps by hand.
  const byHandButtons = buttonsIn([fold(part, 'access-byhand')])
  expect(
    buttonsIn(part)
      .filter(b => !byHandButtons.includes(b))
      .map(textOf),
  ).toEqual(['Cancel'])
  expect(shownText(part)).not.toMatch(JARGON)
  // Why, by name, in the details.
  expect(textsOf([fold(part, 'access-details')], 'access-reason')).toEqual([t('server.manual.os')])
  // The steps by hand: folded, under their own title; step 1's snippets, then the case picked.
  const byHand = fold(part, 'access-byhand')
  expect(byHand.attrs.has('open')).toBe(false)
  expect(summaryOf(byHand)).toBe('Your server needs steps by hand')
  expect(byClass([byHand], 'access-snippets')).toHaveLength(1)
  expect(textsOf([byHand], 'access-pick')).toEqual([
    'Nothing on 80 and 443',
    'Caddy as a service',
    'Caddy in Docker',
    'nginx or something else',
  ])
  // Another board's setup there: that setup's Undo, to run by hand.
  const record = recordFor('1', { pair: { user: 'other', socket: '/srv/other/board.sock' } })
  const facts = { ...factsFor('1'), record }
  expect(chooseCase(facts, W)).toEqual({ case: null, why: ['otherSetup'] })
  const other = partOf(stopped(facts))
  expect(textsOf(other, 'access-stop')).toEqual([
    'The board does not set this server up by itself: another board is set up on this server.',
  ])
  const undo = undoPlan(record, facts, { id: 'manual', removeDocker: false, removeEdited: false })
  expect(textsOf([fold(other, 'access-byhand')], 'access-block-title')).toEqual(
    doItMyself(undo).map((b, i) => `${i + 1}. ${t(b.title.key, b.title.params)}`),
  )
  expect(byClass(other, 'access-picker')).toEqual([])

  // A server the board does: no steps by hand, no case chips, no per-step commands, anywhere.
  for (const view of [withServer({}), planned('2'), planned('3a', 'ubuntu2604'), planned('nodocker')]) {
    const drawn = partOf(view)
    for (const name of ['access-byhand', 'access-snippets', 'access-pick', 'access-block', 'access-finder'])
      expect([name, byClass(drawn, name)]).toEqual([name, []])
  }
})

test('the steps by hand without a plan: the case picked, its commands with <placeholders> and what finds each', async () => {
  const live = liveServer(stopped(FEDORA))
  await live.click('Caddy in Docker')
  expect(live.text('.access-variant')).toEqual(['on its own network', 'on the host network'])
  const wanted = manualPlan('3a', W, 'debian')
  const blocks = doItMyself(wanted)
  expect(live.text('.access-block-title')).toEqual(blocks.map((b, i) => `${i + 1}. ${t(b.title.key, b.title.params)}`))
  expect(live.text('.access-block .access-pre')).toEqual(
    blocks.flatMap(b => [b.commands, b.check, b.undo].filter(text => text !== '')),
  )
  expect(live.text('.access-block .access-pre').join('\n')).toContain('<your Caddyfile>')
  // Each placeholder with the command that finds it, each with Copy.
  const finders = live.text('.access-finder')
  expect(finders).toEqual(placeholderFinders('3a', TUNNEL_SOCKET).map(f => `${f.placeholder}${f.command}Copy`))
  expect(finders.some(f => f.includes('docker ps'))).toBe(true)
  expect(live.text('.access-block .access-copy')).toHaveLength(live.text('.access-block .access-pre').length)
  // On the host network, and on Ubuntu: those commands instead.
  await live.click('on the host network')
  await live.click('Ubuntu')
  expect(live.text('.access-block .access-pre')).toEqual(
    doItMyself(manualPlan('3b', W, 'ubuntu')).flatMap(b => [b.commands, b.check, b.undo].filter(text => text !== '')),
  )
  // Nothing on the ports, on Debian: Docker's install from Docker's Debian repository.
  await live.click('Nothing on 80 and 443')
  await live.click('Debian')
  expect(live.text('.access-block .access-pre').join('\n')).toContain('https://download.docker.com/linux/debian')
  expect(live.text('.access-byhand .access-note').at(-1)).toBe('Then Test connection.')

  // Another socket: what finds the folder's group reads its folder, not the default one; a public
  // port the plan's check refuses: the field's words instead of the blocks, the picker still there.
  const at = (over: Partial<AccessView['tunnel']['settings']>): AccessView => ({
    ...stopped(FEDORA),
    tunnel: { ...READY.tunnel, settings: { ...READY.tunnel.settings, ...over } },
  })
  const other = liveServer(at({ socket: '/srv/b/x.sock' }))
  expect(other.text('.access-finder')).toEqual(['<gid>stat -c %g /srv/bCopy'])
  const refused = liveServer(at({ publicPort: 0 }))
  expect(refused.text('.access-byhand .access-why')).toEqual([
    t('tunnel.err.port', { field: t('tunnel.field.publicPort') }),
  ])
  expect(refused.has('.access-block')).toBe(false)
  expect(refused.has('.access-picker')).toBe(true)
})

test('manualPlan: every case on Debian and Ubuntu, from the facts Look would have found', () => {
  for (const c of ['1', '1b', '2', '3a', '3b', '4a', '4b'] as const)
    for (const distro of ['debian', 'ubuntu'] as const) {
      const plan = manualPlan(c, W, distro)
      expect([plan.case, plan.kind, plan.id]).toEqual([c, 'apply', 'manual'])
      expect(plan.address).toBe(c.startsWith('4') ? 'https://board.example.com:8443' : 'https://board.example.com')
    }
  expect(
    manualPlan('1', W, 'ubuntu')
      .steps.flatMap(s => s.commands)
      .join('\n'),
  ).toContain('https://download.docker.com/linux/ubuntu')
})

// ---------------------------------------------------------------- a run

test('a run in progress: each step waiting, running with its seconds, ✓; its output under a fold', () => {
  const view = planned('2')
  const plan = planOf(view)
  const progress = progressOf(plan, [
    ['@@step 1 start', NOW - 20_000],
    ['@@step 1 ok', NOW - 19_000],
    ['@@step 2 start', NOW - 12_000],
    ['writing /etc/caddy/agent-board/board.caddy', NOW - 11_000],
  ])
  const part = partOf({ ...view, server: { ...(view.server as ServerView), phase: 'applying', progress } })
  // The run's steps as today, not folded.
  expect(byClass(part, 'access-plan')).toHaveLength(1)
  expect(byClass([fold(part, 'access-details')], 'access-plan')).toEqual([])
  const states = textsOf(part, 'access-state')
  expect(states.slice(0, 3)).toEqual(['✓', 'running 12 s', 'waiting'])
  expect(states).toHaveLength(plan.steps.length)
  expect(textsOf(part, 'access-sub')).toContain('Applying on the server…')
  const outs = findAll(part, el => el.tag === 'details' && hasClass(el, 'access-out'))
  expect(outs.map(d => textOf(find([d], el => el.tag === 'pre')))).toEqual([
    'writing /etc/caddy/agent-board/board.caddy',
  ])
  expect(outs.map(d => d.attrs.has('open'))).toEqual([false])
  // While it runs: no Apply, no Set up, no Cancel (it runs on the server, whatever this PC does).
  expect(buttonsIn(part).map(textOf)).toEqual([])
  // The model's words for each state.
  expect(stepState(progress, 1, NOW, t)).toBe('✓')
  expect(stepState(progress, 2, NOW, t)).toBe('running 12 s')
  expect(stepState(progress, 3, NOW, t)).toBe('waiting')
  const later = progressOf(plan, [
    ['@@step 1 start', NOW],
    ['@@step 1 fail', NOW],
    ['@@step 2 start', NOW],
    ['@@step 2 skip', NOW],
  ])
  expect([stepState(later, 1, NOW, t), stepState(later, 2, NOW, t)]).toEqual(['✗', 'in place already'])
  expect(stepState(later, 2, NOW, ru)).not.toBe('in place already')
})

test('a failure: the step and its lines, the hint, what was rolled back with ✓, Look again', () => {
  const view = planned('2')
  const plan = planOf(view)
  const validate = plan.steps.findIndex(s => s.id === 'validate') + 1
  const lines: [string, number][] = []
  for (let n = 1; n < validate; n++) lines.push([`@@step ${n} start`, NOW], [`@@step ${n} ok`, NOW])
  lines.push(
    [`@@step ${validate} start`, NOW],
    ['Error: adapting config using caddyfile: /etc/caddy/Caddyfile:12: unrecognized directive: reverse_prox', NOW],
    [`@@step ${validate} fail`, NOW],
    [`@@undo ${validate - 1} ok`, NOW],
    [`@@undo ${validate - 3} ok`, NOW],
    ['@@result rolled-back', NOW],
    ['@@exit 1', NOW],
  )
  const progress = progressOf(plan, lines)
  const failed = { ...(view.server as ServerView), phase: 'failed' as const, progress }
  const part = partOf({ ...view, server: failed })
  const failure = find(part, el => hasClass(el, 'access-failure'))
  expect(textsOf([failure], 'access-warn')).toEqual([`Step ${validate} failed: ${title(plan, validate)}`])
  expect(textsOf([failure], 'access-hint')).toEqual([
    "Your Caddy refused the config with the board's block (the line it names). Nothing was reloaded; your file is as it was. A site without braces as the last block is a usual cause.",
  ])
  expect(textsOf([failure], 'access-rolled')).toEqual([
    `✓ ${title(plan, validate - 1)}`,
    `✓ ${title(plan, validate - 3)}`,
  ])
  // a Docker install that finished stays after a rollback (call 20): the line does not say the server is as it was
  expect(textsOf([failure], 'access-result')).toEqual([
    'Everything the run changed was rolled back; a Docker install that had finished stays.',
  ])
  // a failed reload leaves no mark, so the rollback reloads only a reload that took
  expect(t('server.panel.fail.reload')).toBe(
    'The reload did not go through: your file was put back as it was. Your Caddy was reloaded again only if that reload had taken; otherwise it kept its running config.',
  )
  expect(ru('server.panel.fail.reload')).not.toContain('перезагружен.')
  expect(buttonsIn([failure]).map(textOf)).toEqual(['Look again'])
  // The failed step's output, open.
  const out = find(part, el => el.tag === 'details' && hasClass(el, 'access-out'))
  expect(out.attrs.has('open')).toBe(true)
  expect(textOf(out)).toContain('unrecognized directive: reverse_prox')
  // A hint from the board (the connection lost mid-run) comes first.
  const lost = partOf({ ...view, server: { ...failed, hint: 'lost' } })
  expect(textsOf(lost, 'access-hint')).toEqual([hintLine('lost', t, 'admin')])
  expect(hintLine('lost', t, 'admin')).toBe(t('server.hint.lost', { admin: 'admin' }))
  expect(hintLine(null, t, 'admin')).toBe('')
  // A Look the server refused: its hint and the error line, with Look again.
  const refused = partOf(withServer({ phase: 'failed', hint: 'publickey', error: 'Permission denied (publickey).' }))
  expect(textsOf(refused, 'access-hint')).toEqual([hintLine('publickey', t, 'admin')])
  expect(textsOf(refused, 'access-why')).toEqual(['Permission denied (publickey).'])
  expect(buttonsIn(refused).map(textOf)).toContain('Look again')
})

// ---------------------------------------------------------------- done, and Undo

test('done: set up on a date, the login folded away; Undo takes two clicks, logs in with the keys or asks for the password again, then the Undo plan', async () => {
  const setup = { case: '3a' as const, address: 'https://board.example.com', at: '2026-10-21T10:04:00.000Z' }
  const testAfter: TestStep[] = [
    { id: 'ssh', ok: true, detail: '', hint: null },
    { id: 'forward', ok: true, detail: '', hint: null },
    { id: 'domain', ok: false, detail: 'TLS', hint: 'tls' },
  ]
  const view = withServer({ phase: 'done', sudo: 'nopasswd', setup, testAfter })
  expect(setupLine(setup, t)).toMatch(/^Set up on .+: Caddy in Docker$/)
  expect(setupLine(setup, ru)).not.toBe(setupLine(setup, t))
  const part = partOf(view)
  expect(fold(part, 'access-signin').attrs.has('open')).toBe(false)
  // Before setup, open.
  expect(fold(partOf(withServer({ phase: 'done' })), 'access-signin').attrs.has('open')).toBe(true)
  // The server takes no key of theirs: the board asks for the password (services/server-setup.ts).
  const live = liveServer(view, (op, body) =>
    op === 'server-undo-look' && body.password === undefined
      ? { ok: false, hint: 'loginPassword', need: 'password' }
      : { ok: true },
  )
  expect(live.text('.access-done')).toEqual([setupLine(setup, t)])
  expect(live.text('.access-after .access-step')).toEqual(testAfter.map(s => stepLine(s, t)))
  await live.click('Undo')
  expect(live.calls).toEqual([])
  expect(live.buttons()).toContain('Undo? Click again')
  await live.click('Undo? Click again')
  // Undo logs in at once, as Set up the server does: the keys first (a login by the ssh agent or
  // ~/.ssh asks nothing). The password is not kept: the board asks for it, the login's fields open.
  expect(live.calls).toEqual([['server-undo-look', {}]])
  expect(live.state().need).toBe('password')
  expect(live.pick('details.access-signin').hasAttribute('open')).toBe(true)
  expect(live.text('.access-ask .access-sure')).toEqual([
    'Undo logs in to the server again: type admin’s password, then Continue.',
  ])
  await live.type('login-password', SENTINEL)
  await live.click('Continue')
  expect(live.calls.at(-1)).toEqual(['server-undo-look', { password: SENTINEL }])
  expect(live.buttons()).toContain('Undo')
  // Undo's Look answered: Enter in the password field is Set up the server's Look again, not Undo's.
  expect(live.state()).toMatchObject({ need: null, again: 'server-look' })
  await live.type('login-password', SENTINEL, 'Enter')
  expect(live.calls.at(-1)).toEqual(['server-look', { password: SENTINEL }])
  // A password typed already in this panel: Undo's Look at once.
  const typed = liveServer(view)
  await typed.type('login-password', 'pw')
  await typed.click('Undo')
  await typed.click('Undo? Click again')
  expect(typed.calls).toEqual([['server-undo-look', { password: 'pw' }]])
  // A key file named: no password asked; the key logs in.
  const keyed = liveServer(withServer({ phase: 'done', setup, admin: { user: 'root', key: 'D:\\k' } }))
  await keyed.click('Undo')
  await keyed.click('Undo? Click again')
  expect(keyed.calls).toEqual([['server-undo-look', {}]])
})

test('the Undo plan: in plain words, Docker and edited files only when ticked, Undo sends them with the password', async () => {
  const record: SetupRecord = recordFor('1', {
    items: [
      { kind: 'docker', packages: DOCKER_PACKAGES, files: DOCKER_FILES },
      { kind: 'file', path: '/etc/agent-board/caddy/Caddyfile', sha256: 'ab'.repeat(32) },
      { kind: 'container', name: 'agent-board-caddy', setup: 'r0' },
    ],
  })
  const facts = { ...factsFor('1'), record }
  const plan = undoPlan(record, facts, { id: 'u1', removeDocker: false, removeEdited: false })
  expect(plan.ticks).toEqual(['removeDocker', 'removeEdited'])
  const setup = { case: record.case, address: record.address, at: record.at }
  const live = liveServer(
    withServer({ phase: 'plan', sudo: 'password', facts, choice: chooseCase(facts, W), plan, setup }),
  )
  expect(live.text('.access-will-line')).toEqual(['Remove what the board added for board.example.com.'])
  expect(live.text('.access-untouched')).toEqual(['Nothing of yours is removed.'])
  expect(live.text('.access-details .access-sub')).toContain('The Undo plan (nothing changes until Undo)')
  expect(live.text('.access-title')).toEqual(plan.steps.map((_, i) => title(plan, i + 1)))
  expect(live.text('.access-plain .access-tick')).toEqual([
    'Remove Docker too (the board installed it, and it holds nothing else)',
    "Remove the board's files you changed since, too",
  ])
  // The setup's line stays in its card; its buttons wait while its Undo is planned.
  expect(live.text('.access-card-tunnel .access-done')).toHaveLength(1)
  expect(live.buttons()).not.toContain('Update')
  expect(live.buttons()).not.toContain('Apply')
  await live.type('login-password', 'pw')
  await live.tick('tick-removeDocker')
  await live.click('Undo')
  expect(live.calls).toEqual([['server-undo', { plan: 'u1', removeDocker: true, removeEdited: false, password: 'pw' }]])
  expect(live.state().password).toBe('')
})

// ---------------------------------------------------------------- Do it myself (one command)

// As GET /api/access/server-command answers (services/server-setup.ts oneshot).
const ONESHOT = {
  ok: true,
  command: 'echo H4sIAAAAAAAAA+1YbW/bNhD+7k== | base64 -d | gunzip | sh',
  script: '#!/bin/sh\n# agent-board: "Do it myself" as one command.\nset -eu\n',
  undoCommand: 'echo H4sIUNDO== | base64 -d | gunzip | sh',
  undoScript: '#!/bin/sh\n# agent-board: Undo as one command.\nset -eu\n',
}

test('Do it myself (one command): folded; opened, the board’s command with Copy, what is inside, its Undo, then Test connection finding the port', async () => {
  const fetched = answers([200, ONESHOT])
  const steps: TestStep[] = [
    { id: 'ssh', ok: true, detail: '', hint: null },
    { id: 'forward', ok: true, detail: '', hint: null },
    { id: 'domain', ok: true, detail: 'board.example.com:8443', hint: null, port: 8443 },
  ]
  // The board's answer to a Test that found the public port (services/remote-access.ts 'test').
  const live = liveServer(
    withServer({}),
    op => (op === 'test' ? { ok: true, steps, publicPort: 8443 } : { ok: true }),
    {
      steps,
    },
  )
  expect(live.has('.access-oneshot-body')).toBe(false)
  expect(fetched).toEqual([])
  await live.toggle('details.access-oneshot')
  expect(live.state().oneshot).toBe(true)
  // Asked for once, by the board's route, with nothing else sent (everything is there already).
  expect(SERVER_COMMAND_PATH).toBe('/api/access/server-command')
  expect(sent(fetched)).toEqual([[SERVER_COMMAND_PATH, undefined, undefined, undefined]])
  expect(live.calls).toEqual([])
  expect(live.text('.access-oneshot-body .access-note')).toEqual([
    'Paste this into an ssh session on your server, as root (or a user with sudo).',
    'It looks at the server, sets up the board’s address and its tunnel, and touches nothing of yours.',
    'It prints what it did, or why it stopped. Safe to paste again.',
  ])
  // One command to copy (the Undo command folded apart), what is inside readable.
  expect(live.text('.access-command .access-pre')).toEqual([ONESHOT.command, ONESHOT.undoCommand])
  expect(live.text('.access-command .access-copy')).toEqual(['Copy', 'Copy'])
  // What is inside: the command's script, and under its Undo command, Undo's.
  expect(live.text('.access-inside summary')).toEqual([
    'What is inside (the script, readable)',
    'What is inside (the script, readable)',
  ])
  expect(live.text('.access-inside .access-pre')).toEqual([ONESHOT.script, ONESHOT.undoScript])
  expect(live.text('.access-undo-command summary')).toEqual([
    'To undo it later (one command too)',
    'What is inside (the script, readable)',
  ])
  expect(live.text('.access-undo-command .access-pre')).toEqual([ONESHOT.undoCommand, ONESHOT.undoScript])
  expect(live.pick('details.access-inside').hasAttribute('open')).toBe(false)
  expect(live.has('.access-oneshot-body .access-done')).toBe(false)
  // Then Test connection: with no setup on record, it asks the board to find the port, and says
  // where the board answered.
  await live.click('Test connection')
  expect(live.calls).toEqual([['test', { findPort: true }]])
  expect(live.text('.access-oneshot-body .access-marks')).toEqual([
    '✓ SSH to the server · ✓ The server takes the socket · ✓ The domain reaches this board',
  ])
  expect(live.state().byHand).toBe(8443)
  expect(live.text('.access-oneshot-body .access-done')).toEqual([
    'Set up by hand: the board answers at https://board.example.com:8443',
  ])
  expect(oneshotTest(withServer({}))).toEqual({ findPort: true })
  expect(oneshotTest(withServer({ setup: { case: '1', address: 'https://b', at: '2026-10-21' } }))).toEqual({})
  expect(foundPort({ ok: true, steps, publicPort: 443 })).toBe(443)
  expect(foundPort({ ok: true, steps, publicPort: null })).toBeNull()
  expect(foundPort({ ok: true, steps })).toBeNull()
  expect(foundPort(null)).toBeNull()
  expect(byHandAddress('board.example.com', 443)).toBe('https://board.example.com')
  // Closed again: folded, nothing asked.
  await live.toggle('details.access-oneshot')
  expect(live.has('.access-oneshot-body')).toBe(false)
  expect(fetched).toHaveLength(1)
  expect(isOneshot(ONESHOT)).toBe(true)
  expect(isOneshot({ command: 'x', script: 'y' })).toBe(false)
  expect(isOneshot({ command: 'x', script: 'y', undoCommand: 'z' })).toBe(false)
})

test('Do it myself (one command): a Test the board found nothing on says nothing of a setup by hand; one with a setup on record does not ask', async () => {
  answers([200, ONESHOT])
  const steps: TestStep[] = [
    { id: 'ssh', ok: true, detail: '', hint: null },
    { id: 'forward', ok: true, detail: '', hint: null },
    { id: 'domain', ok: false, detail: '443: refused; 8443: refused', hint: 'tls' },
  ]
  const none = liveServer(withServer({}), op => (op === 'test' ? { ok: true, steps, publicPort: null } : { ok: true }))
  await none.toggle('details.access-oneshot')
  await none.click('Test connection')
  expect(none.calls).toEqual([['test', { findPort: true }]])
  expect(none.state().byHand).toBeNull()
  expect(none.has('.access-oneshot-body .access-done')).toBe(false)

  answers([200, ONESHOT])
  const setup = { case: '1' as const, address: 'https://board.example.com', at: '2026-10-21T10:04:00.000Z' }
  const recorded = liveServer(withServer({ setup }), () => ({ ok: true, steps }))
  await recorded.toggle('details.access-oneshot')
  await recorded.click('Test connection')
  expect(recorded.calls).toEqual([['test', {}]])
  expect(recorded.state().byHand).toBeNull()
})

test('Do it myself (one command) from an empty panel fills in what the command needs first; refused, it says why; no address, no command', async () => {
  const fetched = answers([200, ONESHOT])
  const live = liveServer({ ...FRESH, server: null })
  await live.toggle('details.access-oneshot')
  expect(live.calls).toEqual([
    ['tunnel', { fields: { host: 'board.example.com', user: 'boardtunnel' } }],
    ['key-generate', {}],
  ])
  expect(sent(fetched)).toEqual([[SERVER_COMMAND_PATH, undefined, undefined, undefined]])
  expect(live.text('.access-command .access-pre')[0]).toBe(ONESHOT.command)

  answers([409, { ok: false, error: 'The board’s key is missing' }])
  const refused = liveServer(withServer({}))
  await refused.toggle('details.access-oneshot')
  expect(refused.text('.access-oneshot-body .access-why')).toEqual([
    'The board could not make the command: The board’s key is missing',
  ])
  expect(refused.has('.access-command')).toBe(false)

  const none = answers()
  const empty = { ...FRESH, tunnel: { ...FRESH.tunnel, settings: { ...FRESH.tunnel.settings, domain: '' } } }
  const blank = liveServer({ ...empty, server: null })
  await blank.toggle('details.access-oneshot')
  expect(none).toEqual([])
  expect(blank.calls).toEqual([])
  expect(blank.text('.access-oneshot-body .access-look-why')).toEqual(['Type the board’s address first.'])
})

test('Do it myself (one command) opened before the board’s address: asked for once the address is there; made again in the board’s new language', async () => {
  const none = answers()
  const empty = { ...FRESH, tunnel: { ...FRESH.tunnel, settings: { ...FRESH.tunnel.settings, domain: '' } } }
  const blank = liveServer({ ...empty, server: null })
  await blank.toggle('details.access-oneshot')
  expect(none).toEqual([])
  // The fold waits for the address, and says so.
  expect(blank.state().got).toEqual({ state: 'address' })
  expect(blank.text('.access-oneshot-body .access-look-why')).toEqual(['Type the board’s address first.'])
  expect(oneshotWaited(true, blank.state().got, '')).toBe(false)
  // The address typed (the view comes back with it): no word of it any more, under the fold or
  // the button, and the fold goes on as it does when it opens (ServerSetup.tsx: what the command
  // needs filled in, then the command).
  const typed = partWith({ ...FRESH, server: null }, blank.state())
  expect(textsOf(typed, 'access-look-why')).toEqual([])
  expect(oneshotWaited(true, blank.state().got, 'board.example.com')).toBe(true)
  // Closed, or refused for another reason (left idle): not asked for again by itself.
  expect(oneshotWaited(false, blank.state().got, 'board.example.com')).toBe(false)
  expect(oneshotWaited(true, ONESHOT_IDLE, 'board.example.com')).toBe(false)
  expect(oneshotWaited(true, { state: 'loading' }, 'board.example.com')).toBe(false)
  // Set up the server clicked without it: said under the button until it is there.
  const clicked = liveServer({ ...empty, server: null })
  await clicked.click('Set up the server')
  expect(clicked.text('.access-look-why')).toEqual(['Type the board’s address first.'])
  expect(textsOf(partWith({ ...FRESH, server: null }, clicked.state()), 'access-look-why')).toEqual([])

  // The command carries the board's words: the board's language switched, it is made again.
  const settings = READY.tunnel.settings
  const en = oneshotStamp(settings, PUBLIC_KEY, 'en')
  const ru = oneshotStamp(settings, PUBLIC_KEY, 'ru')
  expect(en).not.toBe(ru)
  const got = { state: 'ok' as const, oneshot: ONESHOT, stamp: en }
  expect(oneshotStale(true, got, en)).toBe(false)
  expect(oneshotStale(true, got, ru)).toBe(true)
  expect(oneshotStale(false, got, ru)).toBe(false)
  expect(oneshotStale(true, { state: 'error', error: 'x', stamp: en }, ru)).toBe(true)
  for (const waiting of [ONESHOT_IDLE, { state: 'loading' as const }, { state: 'address' as const }])
    expect(oneshotStale(true, waiting, ru)).toBe(false)
})

// ---------------------------------------------------------------- around the flow

test('the Server tab: the server and its port first, then the login; the tunnel’s other settings folded on its tab; Call 4’s line while nothing is set up', () => {
  const steps: TestStep[] = [
    { id: 'ssh', ok: true, detail: '', hint: null },
    { id: 'forward', ok: true, detail: '', hint: null },
    { id: 'domain', ok: false, detail: 'TLS handshake failed', hint: 'tls' },
  ]
  const body = bodyOf(withServer({}), steps)
  const server = find(body, el => hasClass(el, 'access-server'))
  expect(byClass([server], 'access-stage')).toEqual([])
  expect(byClass(body, 'access-snippets')).toEqual([])
  // The login's fold: the server and its port, the login, the password, the key file (the board's
  // address is the Tunnel tab's).
  const signin = fold([server], 'access-signin')
  expect(findAll([signin], el => el.tag === 'input').map(el => el.attrs.get('name'))).toEqual([
    'host',
    'sshPort',
    'admin-user',
    'login-password',
    'admin-key',
  ])
  expect(findAll([signin], el => el.tag === 'label').map(el => textOf(find([el], x => x.tag === 'span')))).toEqual([
    'Server',
    'port',
    'Login',
    'Password',
    'Key file',
  ])
  // The rest, folded: the tunnel's user, its key, the socket, the ports, and the board's key.
  const more = fold(body, 'access-more')
  expect(more.attrs.has('open')).toBe(false)
  expect(summaryOf(more)).toBe('Tunnel settings and keys')
  expect(findAll([more], el => el.tag === 'input').map(el => el.attrs.get('name'))).toEqual([
    'user',
    'key',
    'socket',
    'publicPort',
    'port',
  ])
  expect(byClass([more], 'access-key')).toHaveLength(1)
  // The domain's step, failed while no setup is on record: Call 4's line under its hint.
  const domainHints = (b: Node[]) =>
    textsOf(findAll(byClass(b, 'access-steps'), el => el.tag === 'li').slice(-1), 'access-hint')
  expect(domainHints(body)).toEqual([t('tunnel.hint.tls'), CALL_4])
  expect(domainHints(bodyOf({ ...READY, server: null }, steps))).toEqual([t('tunnel.hint.tls'), CALL_4])
  const setup = { case: '1' as const, address: 'https://board.example.com', at: '2026-10-21T10:04:00.000Z' }
  expect(domainHints(bodyOf(withServer({ setup }), steps))).toEqual([t('tunnel.hint.tls')])
  // Only the domain's step, and only when it failed.
  const fine = steps.map(s => ({ ...s, ok: true, hint: null }))
  expect(domainHints(bodyOf(withServer({}), fine))).toEqual([])
  // No jargon in the panel's flow as drawn, in English and Russian.
  expect(shownText([server])).not.toMatch(JARGON)
  expect(shownText([find(bodyOf(withServer({}), steps, 'ru'), el => hasClass(el, 'access-server'))])).not.toMatch(
    JARGON,
  )
})

test('the texts in Russian differ, and every one is there', () => {
  expect(missingKeys('ru')).toEqual([])
  const en = partOf(planned('nodocker', 'debian13', { sudo: 'password' }))
  const inRu = partOf(planned('nodocker', 'debian13', { sudo: 'password' }), { lang: 'ru' })
  for (const name of [
    'access-kept',
    'access-sub',
    'access-title',
    'access-undo-line',
    'access-address',
    'access-will-line',
    'access-docker',
    'access-untouched',
    'access-found-line',
    'access-summary',
  ])
    expect([name, textsOf(inRu, name)]).not.toEqual([name, textsOf(en, name)])
  expect(buttonsIn(inRu).map(textOf)).not.toContain('Apply')
  expect(buttonsIn(partOf(withServer({}), { lang: 'ru' })).map(textOf)).toEqual([
    'Настроить сервер',
    'Установить доску на этот сервер',
  ])
  expect(foundLines(factsFor('1'), ru, 'boardtunnel')).not.toEqual(foundLines(factsFor('1'), t, 'boardtunnel'))
})

test('Install the board on this server (path B): its own plan, then its output, the setup link apart, how it ended', () => {
  const SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'
  // its own address, not the tunnel's (board.example.com)
  const domain = 'workbench.example.com'
  const w = serverWanted(domain, 'agent')
  const facts = factsFor('1')
  const built = buildPlan(facts, w, { id: 'i1', docker: false })
  const plan = isPlan(built) ? built : null
  const install = { from: { commit: SHA, changes: true }, out: [], link: null, code: null }
  const looked = withServer({
    phase: 'plan',
    sudo: 'root',
    facts,
    choice: chooseCase(facts, w),
    plan,
    target: 'install',
    install,
    installDomain: domain,
  })
  const part = partOf(looked)
  const shown = shownText(part)
  // the web server's steps for its own address
  const will = textsOf(part, 'access-will-line').join(' ')
  expect(will).toContain(domain)
  expect(will).not.toContain(READY.tunnel.settings.domain)
  expect(shown).toContain('The board’s code: a copy of 1a2b3c4 from your computer, with its local changes.')
  // Look found no user agent: the install makes it
  expect(textsOf(part, 'access-will-line').slice(0, 3)).toEqual([
    'Make the user agent (no sudo) for herdr, Claude Code and the board.',
    'Install Bun 1.4.3, herdr and Claude Code for agent, each from its own installer (what is there is kept).',
    'Install the board: a copy of 1a2b3c4 from your computer, with its local changes.',
  ])
  // the web server's words for the board's own socket, no login of a tunnel's
  expect(shown).not.toContain('allowed only to hold the tunnel')
  expect(buttonsIn(part).map(textOf)).toContain('Install')
  // running: the output as it comes; done: the link apart, once
  const running = partOf(
    withServer({
      ...looked.server,
      phase: 'applying',
      install: { ...install, out: ['agent-board: looking at this server.'] },
    }),
  )
  expect(textsOf(running, 'access-pre')).toEqual(['agent-board: looking at this server.'])
  const link = `https://${domain}/setup#code=abc_DEF`
  const done = partOf(
    withServer({ ...looked.server, phase: 'done', install: { ...install, out: ['Done'], link, code: 0 } }),
  )
  expect(find(done, el => el.tag === 'a' && el.attrs.get('href') === link).attrs.get('rel')).toBe('noreferrer noopener')
  expect(textsOf(done, 'access-result')).toEqual([`Installed: https://${domain}`])
  expect(textsOf(done, 'access-pre').join('\n')).not.toContain('#code=')
  // in Russian too
  expect(shownText(partOf(looked, { lang: 'ru' }))).toContain('Код доски: копия 1a2b3c4 с вашего компьютера')
})

test('Install over a board already on the server: its web server has nothing to change, Install is still offered (the board, herdr and the key go on)', () => {
  const domain = 'workbench.example.com'
  const w = serverWanted(domain, 'agent')
  const facts = factsFor('1')
  const built = buildPlan(facts, w, { id: 'i2', docker: false })
  if (!isPlan(built)) throw new Error('no plan')
  const install = {
    from: { commit: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d', changes: false },
    out: [],
    link: null,
    code: null,
  }
  const base = {
    phase: 'plan',
    sudo: 'root',
    facts,
    choice: chooseCase(facts, w),
    install,
    installDomain: domain,
  } as const
  const nothing = { ...built, kind: 'nothing' as const }
  expect(buttonsIn(partOf(withServer({ ...base, plan: nothing, target: 'install' }))).map(textOf)).toContain('Install')
  // the web server's own setup with nothing to change still offers no Apply
  expect(buttonsIn(partOf(withServer({ ...base, plan: nothing, target: 'tunnel' }))).map(textOf)).not.toContain('Apply')
})

test('the address of the board on the server: its own field, saved when left as server-install-domain; refused, the board’s words under it and what was typed kept', async () => {
  const live = liveServer(withServer({}))
  expect(live.pick('input[name="install-domain"]').value).toBe('')
  expect(live.text('.access-install-domain .access-install-note')).toEqual([
    'A domain of its own: the tunnel’s address stays the board’s on this computer.',
  ])
  await live.type('install-domain', ' WorkBench.Example.com ')
  await live.leave('install-domain')
  expect(live.calls).toEqual([['server-install-domain', { domain: 'workbench.example.com' }]])
  // never one of the tunnel's settings
  expect(live.calls.map(c => c[0])).not.toContain('tunnel')
  // shown as the board has it; left again unchanged: nothing sent
  const saved = liveServer(withServer({ installDomain: 'workbench.example.com' }))
  expect(saved.pick('input[name="install-domain"]').value).toBe('workbench.example.com')
  await saved.leave('install-domain')
  expect(saved.calls).toEqual([])
  // refused: the board's words under the field, what was typed stays; put right, they go
  const error = 'board.example.com is the tunnel’s address, the board’s on this computer'
  let refuse = true
  const refused = liveServer(withServer({}), op =>
    op === 'server-install-domain' && refuse ? { ok: false, field: 'domain', error } : { ok: true },
  )
  await refused.type('install-domain', 'board.example.com')
  await refused.leave('install-domain')
  expect(refused.pick('input[name="install-domain"]').value).toBe('board.example.com')
  expect(refused.text('.access-install-domain .access-problem')).toEqual([error])
  refuse = false
  await refused.type('install-domain', 'workbench.example.com')
  await refused.leave('install-domain')
  expect(refused.text('.access-install-domain .access-problem')).toEqual([])
  // in Russian
  const inRu = partOf(withServer({}), { lang: 'ru' })
  expect(find(inRu, el => el.attrs.get('name') === 'install-domain').attrs.get('aria-label')).toBe(
    'Адрес доски на сервере',
  )
})

test('Install the board on this server asks for its own address first; with it, Look goes with no address of the tunnel’s needed when the server is there', async () => {
  // none: said, and nothing sent
  const none = liveServer(withServer({}))
  await none.click('Install the board on this server')
  expect(none.calls).toEqual([])
  expect(none.text('.access-look-why')).toEqual(['Type the address of the board on the server first.'])
  // Set up the server, the tunnel's, goes as before
  await none.click('Set up the server')
  expect(none.calls).toEqual([['server-look', {}]])
  // set: the install's Look
  const set = liveServer(withServer({ installDomain: 'workbench.example.com' }))
  await set.click('Install the board on this server')
  expect(set.calls).toEqual([['server-install-look', {}]])
  // typed and left just before the click: the Look waits for its save, and goes on once the board took it
  const saves = savesTracker()
  let answer: (reply: Record<string, unknown>) => void = () => {}
  const typed = liveServer(withServer({}), undefined, { saves })
  void saves.track(new Promise(resolve => (answer = resolve)), { install: { domain: 'workbench.example.com' } })
  await typed.click('Install the board on this server')
  expect(typed.calls).toEqual([])
  answer({ ok: true })
  await typed.idle()
  expect(typed.calls).toEqual([['server-install-look', {}]])
  expect(typed.text('.access-look-why')).toEqual([])
  // the tunnel without its address yet, the server there: the install needs no address of the tunnel's
  const noAddress = {
    ...READY,
    tunnel: { ...READY.tunnel, settings: { ...READY.tunnel.settings, domain: '' } },
  }
  const server = liveServer(withServer({ installDomain: 'workbench.example.com' }, noAddress))
  await server.click('Install the board on this server')
  expect(server.calls).toEqual([['server-install-look', {}]])
  // while Set up the server still asks for it
  await server.click('Set up the server')
  expect(server.calls).toEqual([['server-install-look', {}]])
  expect(server.text('.access-look-why')).toEqual(['Type the board’s address first.'])
  // nor the server: the tunnel's address fills it in, as for Set up the server
  const nothing = {
    ...READY,
    tunnel: { ...READY.tunnel, settings: { ...READY.tunnel.settings, domain: '', host: '' } },
  }
  const bare = liveServer(withServer({ installDomain: 'workbench.example.com' }, nothing))
  await bare.click('Install the board on this server')
  expect(bare.calls).toEqual([])
  expect(bare.text('.access-look-why')).toEqual(['Type the board’s address first.'])
  // the model: what the board took of the install's address, only once it was saved
  const took = savesTracker()
  expect(await took.settle()).toEqual({ tunnel: {}, admin: {} })
  void took.track(Promise.resolve({ ok: true }), { install: { domain: 'workbench.example.com' } })
  expect(await took.settle()).toEqual({ tunnel: {}, admin: {}, install: { domain: 'workbench.example.com' } })
})

// ---------------------------------------------------------------- the board on the server: its version, its removal

const CARD_SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d'
const CARD_NEWER = 'ffeeddccbbaa99887766554433221100ffeeddcc'
const CARD_DOMAIN = 'workbench.example.com'
const INSTALLED_AT = '2026-10-21T13:02:00.000Z'
const cardOf = (over: Partial<ServerView>, lang = 'en') => {
  const part = partOf(withServer({ installDomain: CARD_DOMAIN, ...over }), { lang })
  const card = find(part, el => el.tag === 'section' && hasClass(el, 'access-card-board'))
  return {
    line: textsOf([card], 'access-card-line')[0] ?? '',
    update: textsOf([card], 'access-update'),
    seen: textsOf([card], 'access-seen'),
    buttons: buttonsIn([card]).map(textOf),
  }
}

test('the card’s four states: not known yet, not installed, installed as this computer has it, an update', () => {
  const at = `${new Date(Date.parse(INSTALLED_AT)).toLocaleDateString('en', { day: 'numeric', month: 'short' })}, ${timeOf(Date.parse(INSTALLED_AT), t)}`
  const version = { commit: CARD_SHA, changes: true, ref: null, at: INSTALLED_AT }
  const seen = { seen: NOW - 60_000 }
  // never looked at in this board's life
  expect(cardOf({})).toEqual({
    line: `${CARD_DOMAIN} · what is installed there is not known yet`,
    update: [],
    seen: [],
    buttons: ['Install the board on this server', 'Look'],
  })
  // looked: nothing there
  expect(cardOf({ installed: { version: null, ...seen }, local: { commit: CARD_SHA, changes: true } })).toMatchObject({
    line: `${CARD_DOMAIN} · not installed`,
    update: [],
    buttons: ['Install the board on this server', 'Look'],
  })
  // the same version as this computer's: Install again, and Remove
  expect(cardOf({ installed: { version, ...seen }, local: { commit: CARD_SHA, changes: true } })).toMatchObject({
    line: `${CARD_DOMAIN} · version 1a2b3c4 (with local changes), installed ${at}`,
    update: [],
    buttons: ['Install again', 'Look', 'Remove the board from this server'],
  })
  // another commit here (or the same one without its changes): an update, and the main button says so
  for (const local of [
    { commit: CARD_NEWER, changes: false },
    { commit: CARD_SHA, changes: false },
  ]) {
    const c = cardOf({ installed: { version, ...seen }, local })
    expect(c.update).toEqual([`An update is available: this computer has version ${local.commit.slice(0, 7)}.`])
    expect(c.buttons).toEqual(['Update', 'Look', 'Remove the board from this server'])
  }
  // in Russian
  expect(
    cardOf({ installed: { version, ...seen }, local: { commit: CARD_NEWER, changes: false } }, 'ru'),
  ).toMatchObject({
    update: ['Есть обновление: на этом компьютере версия ffeeddc.'],
    buttons: ['Обновить', 'Посмотреть', 'Удалить доску с этого сервера'],
  })
})

test('the version as last seen: said when, and Look to refresh, while the board holds no password; nothing secret in the card', () => {
  const version = { commit: CARD_SHA, changes: false, ref: 'main', at: INSTALLED_AT }
  const seenAt = NOW - 5 * 60_000
  const none = cardOf({ installed: { version, seen: seenAt }, local: { commit: CARD_SHA, changes: false } })
  expect(none.seen).toEqual([`As the board saw it at ${timeOf(seenAt, t)}: Look to refresh.`])
  expect(none.line).toContain('version 1a2b3c4')
  const held = cardOf({
    installed: { version, seen: seenAt },
    local: { commit: CARD_SHA, changes: false },
    passwordHeld: { until: NOW + 60_000 },
  })
  expect(held.seen).toEqual([])
})

test('Look in the card reads the version again with the password typed; a refusal said under the card', async () => {
  const live = liveServer(withServer({ installDomain: CARD_DOMAIN }), op =>
    op === 'server-install-version'
      ? { ok: false, hint: null, error: 'ssh: connect to host ssh.example.com: refused' }
      : { ok: true },
  )
  await live.type('login-password', SENTINEL)
  await live.click('Look')
  expect(live.calls).toEqual([['server-install-version', { password: SENTINEL }]])
  expect(live.text('.access-version-why')).toEqual(['ssh: connect to host ssh.example.com: refused'])
})

test('Remove: its Look, the plan in the install’s words with the user’s tick off, what it deletes said once ticked, Remove sends the tick', async () => {
  const facts = {
    ...factsFor('1'),
    record: recordFor('1', {
      pair: { user: 'agent', socket: '/var/lib/agent-board/board.sock', server: true },
      domain: CARD_DOMAIN,
      address: `https://${CARD_DOMAIN}`,
    }),
  }
  const record = facts.record
  const plan = undoPlan(record, facts, { id: 'rm1', removeDocker: false, removeEdited: false })
  const remove = {
    id: 'rm1',
    facts: {
      user: 'agent',
      home: '/home/agent',
      ours: true,
      record: true,
      sudo: false,
      service: true,
      desktop: ['chromium'],
      desktopLibs: [],
    },
    domain: CARD_DOMAIN,
    web: true,
    removeUser: false,
    out: [],
    code: null,
  }
  const installed = { version: { commit: CARD_SHA, changes: false, ref: null, at: INSTALLED_AT }, seen: NOW }
  const local = { commit: CARD_SHA, changes: false }
  // from the card: its Look
  const idle = liveServer(withServer({ installDomain: CARD_DOMAIN, installed, local }))
  await idle.click('Remove the board from this server')
  expect(idle.calls).toEqual([['server-remove-look', {}]])
  // its plan
  const looked = withServer({
    installDomain: CARD_DOMAIN,
    installed,
    local,
    phase: 'plan',
    sudo: 'root',
    facts,
    plan,
    target: 'remove',
    remove,
  })
  const live = liveServer(looked)
  const will = live.text('.access-remove .access-will-line')
  expect(will[0]).toBe('Stop herdr’s service of agent and its start with the server.')
  expect(will.at(-1)).toBe('The user agent and its home stay (with --remove-user they go too).')
  expect(will.join(' ')).not.toContain('chromium')
  expect(live.text('.access-remove .access-tick')).toEqual(['Also remove the user agent and its home (/home/agent)'])
  expect(live.text('.access-remove .access-warn')).toEqual([])
  // the tunnel's card shows none of it
  expect(live.text('.access-card-tunnel .access-will-line')).toEqual([])
  await live.tick('tick-removeUser')
  const after = live.text('.access-remove .access-will-line')
  expect(after.at(-1)).toBe(
    'Remove the user agent and its home (/home/agent): Bun, herdr, Claude Code, the board, everything in it.',
  )
  expect(after.join(' ')).toContain('chromium')
  expect(live.text('.access-remove .access-warn')).toEqual([
    'This deletes every file in /home/agent: the agents’ projects and work, their Claude sign-in and sessions, herdr’s state. It cannot be undone.',
  ])
  await live.click('Remove')
  expect(live.calls.at(-1)).toEqual(['server-remove', { plan: 'rm1', removeUser: true }])
  // a user the installer did not make: no tick at all
  const notOurs = partOf(
    withServer({ ...looked.server, remove: { ...remove, facts: { ...remove.facts, ours: false } } }),
  )
  expect(findAll(notOurs, el => el.attrs.get('name') === 'tick-removeUser')).toEqual([])
  // its run: the output, then how it ended; in Russian too
  const running = partOf(
    withServer({
      ...looked.server,
      phase: 'undoing',
      remove: { ...remove, out: ['agent-board: looking at this server.'] },
    }),
  )
  expect(textsOf(running, 'access-pre')).toEqual(['agent-board: looking at this server.'])
  const done = partOf(
    withServer({
      ...looked.server,
      phase: 'done',
      installed: { version: null, seen: NOW },
      remove: { ...remove, out: ['Undone.'], code: 0 },
    }),
  )
  expect(textsOf(done, 'access-result')).toEqual(['Removed: the board is no longer on this server.'])
  const ru1 = partOf(looked, { lang: 'ru' })
  expect(shownText(ru1)).toContain('Удалить и пользователя agent с его домашней папкой (/home/agent)')
})

test('the Server tab opened while the board remembers the password: the version looked at again; without one, or while something runs, not', () => {
  const now = NOW
  const held = { passwordHeld: { until: now + 10 * 60_000 } }
  const server = (over: Partial<ServerView>): ServerView => ({ ...IDLE, installDomain: CARD_DOMAIN, ...over })
  expect(versionOnOpen(server(held), now)).toBe(true)
  expect(versionOnOpen(server({ ...held, phase: 'done' }), now)).toBe(true)
  expect(versionOnOpen(server({}), now)).toBe(false)
  expect(versionOnOpen(server({ passwordHeld: { until: now - 1 } }), now)).toBe(false)
  expect(versionOnOpen(server({ ...held, installDomain: '' }), now)).toBe(false)
  expect(versionOnOpen(server({ ...held, reading: true }), now)).toBe(false)
  for (const phase of ['looking', 'applying', 'undoing'] as const)
    expect(versionOnOpen(server({ ...held, phase }), now)).toBe(false)
  expect(versionOnOpen(null, now)).toBe(false)
})
