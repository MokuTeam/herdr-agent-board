// "On the server" in the Remote access panel's Tunnel part: 1 by hand, 2 Test connection, 3 the web
// server (components/access/ServerSetup.tsx, models/server-setup.ts). Step 3 in each state, from
// views built of Look's facts (test/support/server-facts.ts) and the core's own plans: nothing
// looked at; the sudo password asked, kept by the part alone; Look's findings and the case; the
// plan, Docker's tick keeping Apply off; a run, a failure with its rollback, the setup done with its
// two-click Undo and the Undo plan; "Do it myself" from the plan or, without Look, for the case the
// owner picks; the 8443 address; and Test connection's domain step while nothing is set up.
import { afterEach, expect, test } from 'bun:test'
import type { AccessView } from '../../src/core/access.ts'
import { missingKeys, translator } from '../../src/core/i18n/translator.ts'
import type { ServerFacts } from '../../src/core/server-facts.ts'
import { fenceDiff } from '../../src/core/server-look.ts'
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
import type { ServerView } from '../../src/core/server-view.ts'
import { type TestStep, TUNNEL_SOCKET } from '../../src/core/tunnel.ts'
import { sshdBlock } from '../../src/core/tunnel-snippets.ts'
import { AccessBody } from '../../web/src/components/access/AccessPanel.tsx'
import { ServerSetup, ServerSetupBody } from '../../web/src/components/access/ServerSetup.tsx'
import { type AccessSend, accessSource } from '../../web/src/hooks/useAccess.ts'
import { stepLine } from '../../web/src/models/access.ts'
import {
  foundLines,
  hintLine,
  manualPlan,
  SETUP_START,
  type SetupState,
  setupLine,
  stepState,
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
/** The sudo password the tests type: quotes, `$`, `%`, a backtick and another alphabet. */
const SENTINEL = `S3cr3t%$'"\`Ж`
const W: Wanted = { user: 'boardtunnel', socket: TUNNEL_SOCKET, domain: 'board.example.com', publicPort: null }
const NOTE = 'kept by this panel while it is open; never saved'
const CALL_4 = 'If the web server is not set up yet, this step fails until it is: Set up the server below.'

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
}

const withServer = (over: Partial<ServerView>): AccessView => ({ ...READY, server: { ...IDLE, ...over } })

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
const buttonsIn = (nodes: Node[]): Element[] => findAll(nodes, el => el.tag === 'button')
const button = (nodes: Node[], label: string): Element => find(nodes, el => el.tag === 'button' && textOf(el) === label)

/** Step 3 as drawn for a view, from the part's own start (nothing typed, nothing open). */
function partOf(view: AccessView, more: { lang?: string; canEdit?: boolean } = {}): Node[] {
  return renderInBoard(
    <ServerSetup view={view} send={async () => null} />,
    board({ now: NOW, ...(more.canEdit === false && { connected: false, canEdit: false }) }),
    more.lang ?? 'en',
  )
}

/** The whole panel's body, for the Tunnel part around step 3. */
function bodyOf(view: AccessView, steps: TestStep[] | null = null): Node[] {
  return renderInBoard(
    <PanelProvider viewport={() => VP}>
      <AccessBody view={view} send={async () => null} steps={steps} testing={false} />
    </PanelProvider>,
    board({ now: NOW }),
  )
}

// ---------------------------------------------------------------- live, with React's handlers

/**
 * Step 3 live in a fake DOM with React's handlers (support/react-events.ts), drawn again after
 * every event as React would (support/react-commit.ts). What the part keeps (SetupState) is kept
 * here as ServerSetup keeps it; what it sends goes to `reply`, and is kept with its body.
 */
function liveServer(view: AccessView, reply: (op: string) => Record<string, unknown> | null = () => ({ ok: true })) {
  const toasts: string[] = []
  const context = board({ now: NOW, toast: text => void toasts.push(text) })
  const calls: [string, Record<string, unknown>][] = []
  let state: SetupState = SETUP_START
  const send: AccessSend = async (op, body = {}) => {
    calls.push([op, body])
    return reply(op)
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
    for (let i = 0; i < 12; i++) {
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
    pick,
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
    async type(name: string, text: string) {
      const field = pick(`input[name="${name}"]`)
      field.focus()
      await world.fire(field, 'focusin')
      field.value = text
      await world.fire(field, 'input')
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

test('nothing looked at: the admin user and key, Look and Do it myself; no password asked', () => {
  const part = partOf(withServer({}))
  const inputs = findAll(part, el => el.tag === 'input')
  expect(inputs.map(el => ['name', 'value', 'placeholder', 'aria-label'].map(a => el.attrs.get(a) ?? ''))).toEqual([
    ['admin-user', 'admin', 'a user with sudo, or root', 'Admin user'],
    ['admin-key', '', 'the ssh agent and ~/.ssh keys', 'Admin key'],
  ])
  expect(buttonsIn(part).map(textOf)).toEqual(['Look at the server', 'Do it myself'])
  expect(buttonsIn(part).filter(b => b.attrs.has('disabled'))).toEqual([])
  expect(byClass(part, 'access-found')).toEqual([])
  expect(byClass(part, 'access-plan')).toEqual([])
  expect(findAll(part, el => el.attrs.get('type') === 'password')).toEqual([])

  // The board with nothing to say of the server yet: the same, from nothing; Look needs the admin.
  const none = partOf({ ...READY, server: null })
  expect(findAll(none, el => el.tag === 'input').map(el => el.attrs.get('value') ?? '')).toEqual(['', ''])
  expect(button(none, 'Look at the server').attrs.has('disabled')).toBe(true)
  expect(textsOf(none, 'access-look-why')).toEqual(['Look needs the admin user.'])
  // No pinned key: Test connection first, which pins it.
  const unpinned = partOf({ ...withServer({}), tunnel: { ...READY.tunnel, hostKey: null } })
  expect(button(unpinned, 'Look at the server').attrs.has('disabled')).toBe(true)
  expect(textsOf(unpinned, 'access-look-why')).toEqual([
    "Look needs the server's key: run Test connection first (step 2).",
  ])
  // Without the board its fields and buttons do nothing.
  const off = partOf(withServer({}), { canEdit: false })
  const controls = findAll(off, el => (el.tag === 'input' || el.tag === 'button') && !hasClass(el, 'access-copy'))
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
})

// ---------------------------------------------------------------- the password

test('the sudo password: a password field with the exact note, sent with Look, kept by the part alone', async () => {
  const asked = partOf(withServer({ sudo: 'password' }))
  const field = find(asked, el => el.tag === 'input' && el.attrs.get('type') === 'password')
  expect(['name', 'autocomplete', 'aria-label'].map(a => field.attrs.get(a))).toEqual([
    'sudo-password',
    'off',
    "sudo asks for admin's password",
  ])
  expect(textsOf(asked, 'access-tip')).toEqual([NOTE])
  expect(button(asked, 'Continue').attrs.has('disabled')).toBe(true)

  // sudo said nothing yet: Look asks the board, which answers that sudo needs the password.
  const kept = watchStorage()
  let looks = 0
  const live = liveServer(withServer({}), op =>
    op === 'server-look' && ++looks === 1 ? { ok: false, hint: 'needPassword', need: 'password' } : { ok: true },
  )
  expect(live.has('input[type="password"]')).toBe(false)
  await live.click('Look at the server')
  expect(live.calls).toEqual([['server-look', {}]])
  expect(live.has('input[type="password"]')).toBe(true)
  expect(live.text('.access-tip')).toEqual([NOTE])
  await live.type('sudo-password', SENTINEL)
  expect(live.disabled('Continue')).toBe(false)
  await live.click('Continue')
  expect(live.calls).toEqual([
    ['server-look', {}],
    ['server-look', { password: SENTINEL }],
  ])
  // Kept by the part (its state) and nowhere else: not stored, not drawn, not toasted.
  expect(live.state().password).toBe(SENTINEL)
  expect([...kept.entries()].filter(([k, v]) => `${k}${v}`.includes('S3cr3t'))).toEqual([])
  expect(live.markup()).not.toContain('S3cr3t')
  expect(live.toasts).toEqual([])
  // Look again sends it again, as each Look, Apply and Undo does.
  await live.click('Look at the server')
  expect(live.calls.at(-1)).toEqual(['server-look', { password: SENTINEL }])
})

test('sudo asking for its password is asked by the panel, not toasted; other refusals are; the password only in a body', async () => {
  const toasts: string[] = []
  const need = { ok: false, hint: 'needPassword', error: 'sudo asks for a password', need: 'password' }
  const calls = answers(
    [409, need],
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
  expect(toasts).toEqual([])
  expect(await source.send('server-apply', { plan: 'p0', password: SENTINEL })).toMatchObject({ hint: 'lookAgain' })
  await settle()
  expect(toasts).toEqual(['Look again'])
  expect(sent(calls).map(c => c.slice(0, 2))).toEqual([
    ['/api/access', 'POST'],
    ['/api/access', undefined],
    ['/api/access', 'POST'],
    ['/api/access', undefined],
  ])
  expect(calls.filter(c => String(c.init?.body ?? '').includes('S3cr3t'))).toHaveLength(1)
  expect(calls.map(c => c.url).join(' ')).not.toContain('S3cr3t')
})

// ---------------------------------------------------------------- Look's findings

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

test('what Look found for case 2 on Debian 13: the server, the case, the address and the plan', () => {
  const view = planned('2', 'debian13')
  const plan = planOf(view)
  const part = partOf(view)
  const facts = view.server?.facts as ServerFacts
  expect(textsOf(part, 'access-fact')).toEqual(foundLines(facts, t, 'boardtunnel'))
  expect(textsOf(part, 'access-fact')).toEqual([
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
  expect(textsOf(part, 'access-case')).toEqual([t('server.case.2', { unit: 'caddy.service' })])
  expect(textsOf(part, 'access-address')).toEqual(['Address: https://board.example.com'])
  // The plan: its numbered steps, each with why and what it touches; then what Undo removes.
  expect(textsOf(part, 'access-sub')).toContain('The plan (nothing changes until Apply)')
  expect(textsOf(part, 'access-num')).toEqual(plan.steps.map((_, i) => String(i + 1)))
  expect(textsOf(part, 'access-title')).toEqual(plan.steps.map((_, i) => title(plan, i + 1)))
  expect(textsOf(part, 'access-why-step')).toEqual(plan.steps.map(s => t(s.why.key, s.why.params)))
  expect(textsOf(part, 'access-touches')).toEqual([
    'file /etc/caddy/agent-board/board.caddy',
    'the group of /var/lib/boardtunnel',
    'a backup of /etc/caddy/Caddyfile',
    'a line in /etc/caddy/Caddyfile',
    'a reload of /etc/caddy/Caddyfile',
  ])
  // What the run checks first, as Look found it.
  expect(textsOf(part, 'access-relies')).toEqual([`Checked first, as Look found it: ${plan.relies.join(' · ')}`])
  expect(textsOf(part, 'access-undo-line')).toEqual([
    'Undo removes or puts back: file /etc/caddy/agent-board/board.caddy · the group of /var/lib/boardtunnel · a backup of /etc/caddy/Caddyfile · a line in /etc/caddy/Caddyfile. Then it reloads /etc/caddy/Caddyfile again.',
  ])
  // No run yet: no states.
  expect(byClass(part, 'access-state')).toEqual([])
  expect(buttonsIn(part).map(textOf)).toEqual(['Apply', 'Do it myself', 'Cancel'])
  expect(button(part, 'Apply').attrs.has('disabled')).toBe(false)
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

test('what Look found for case 3a on Ubuntu 26.04: their Caddy in compose, its network, the warnings', () => {
  const view = planned('3a', 'ubuntu2604')
  const part = partOf(view)
  expect(textsOf(part, 'access-fact')).toEqual([
    'Ubuntu 26.04 · Docker 29.0.1 · 443 and 80: "web-caddy-1" in Docker (caddy:2, compose "web")',
    expect.stringContaining("The tunnel's fence in sshd: not in place"),
    "The socket's folder: 2750 boardtunnel:boardtunnel ✓",
    "Your Caddy's config: /srv/my web/Caddyfile (in a folder mounted into its container), Caddy v2.10.2",
  ])
  expect(textsOf(part, 'access-case')).toEqual([
    t('server.case.3a', { container: 'web-caddy-1', network: 'web_default' }),
  ])
  expect(textsOf(part, 'access-caution')).toEqual([
    t('server.warn.tcpHop'),
    t('server.warn.composeDown', { network: 'web_default' }),
  ])
  expect(textsOf(part, 'access-touches')).toContain('container agent-board-socket · network web_default')
  // Not Debian or Ubuntu as supported, and two holders: said so.
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

test('a case the board leaves to the owner: its reasons, Do it myself in place of Apply', () => {
  const facts: ServerFacts = {
    ...factsFor('1'),
    record: recordFor('1', { pair: { user: 'other', socket: '/srv/other/board.sock' } }),
  }
  const choice = chooseCase(facts, W)
  expect(choice).toEqual({ case: null, why: ['otherSetup'] })
  const view = withServer({ phase: 'plan', sudo: 'root', facts, choice, plan: null })
  const part = partOf(view)
  expect(textsOf(part, 'access-reason')).toEqual([t('server.manual.otherSetup')])
  expect(byClass(part, 'access-case')).toEqual([])
  expect(byClass(part, 'access-plan')).toEqual([])
  expect(buttonsIn(part).map(textOf)).toEqual(['Do it myself', 'Cancel'])
})

// ---------------------------------------------------------------- the plan and Apply

test('a plan that installs Docker: Apply stays off until its tick, then sends the plan, the tick and the password', async () => {
  const view = planned('nodocker', 'debian13', { sudo: 'password' })
  expect(planOf(view).ticks).toEqual(['docker'])
  const live = liveServer(view)
  expect(live.text('.access-tick')).toEqual(["Install Docker from Docker's own repository"])
  expect(live.disabled('Apply')).toBe(true)
  await live.type('sudo-password', SENTINEL)
  expect(live.disabled('Apply')).toBe(true)
  await live.tick('tick-docker')
  expect(live.disabled('Apply')).toBe(false)
  await live.click('Apply')
  expect(live.calls).toEqual([['server-apply', { plan: 'p1', docker: true, password: SENTINEL }]])
  // Ticked off again: off again.
  await live.tick('tick-docker')
  expect(live.disabled('Apply')).toBe(true)
  // A plan that needs no tick, with sudo that needs no password: Apply at once, nothing else sent.
  const plain = liveServer(planned('2'))
  await plain.click('Apply')
  expect(plain.calls).toEqual([['server-apply', { plan: 'p1' }]])
  // Cancel drops the plan.
  await plain.click('Cancel')
  expect(plain.calls.at(-1)).toEqual(['server-cancel', {}])
})

test('the 8443 address for case 4a and 4b; nothing to change for a setup already there', () => {
  for (const c of ['4a', '4b'] as const)
    expect(textsOf(partOf(planned(c)), 'access-address')).toEqual(['Address: https://board.example.com:8443'])
  const facts = { ...factsFor('1'), record: recordFor('1') }
  const nothing = { ...planOf(planned('1')), kind: 'nothing' as const }
  const part = partOf(withServer({ phase: 'plan', facts, choice: chooseCase(facts, W), plan: nothing }))
  expect(textsOf(part, 'access-case')).toEqual([t('server.case.same', { case: '1', domain: 'board.example.com' })])
  expect(textsOf(part, 'access-nothing')).toEqual(['Nothing to change: the server is set up as the panel says.'])
  expect(buttonsIn(part).map(textOf)).toEqual(['Do it myself', 'Cancel'])
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
  const states = textsOf(part, 'access-state')
  expect(states.slice(0, 3)).toEqual(['✓', 'running 12 s', 'waiting'])
  expect(states).toHaveLength(plan.steps.length)
  expect(textsOf(part, 'access-sub')).toContain('Applying on the server…')
  const outs = findAll(part, el => el.tag === 'details' && hasClass(el, 'access-out'))
  expect(outs.map(d => textOf(find([d], el => el.tag === 'pre')))).toEqual([
    'writing /etc/caddy/agent-board/board.caddy',
  ])
  expect(outs.map(d => d.attrs.has('open'))).toEqual([false])
  // While it runs: no Apply, no Look, no Cancel (it runs on the server, whatever this PC does).
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

test('a failure: the step and its lines, the hint, what was rolled back with ✓, Look again and Do it myself', () => {
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
  expect(buttonsIn([failure]).map(textOf)).toEqual(['Look again', 'Do it myself'])
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

test('done: set up on a date with its case and Test connection after it; Undo takes two clicks, then asks for the Undo plan', async () => {
  const setup = { case: '3a' as const, address: 'https://board.example.com', at: '2026-10-21T10:04:00.000Z' }
  const testAfter: TestStep[] = [
    { id: 'ssh', ok: true, detail: '', hint: null },
    { id: 'forward', ok: true, detail: '', hint: null },
    { id: 'domain', ok: false, detail: 'TLS', hint: 'tls' },
  ]
  const view = withServer({ phase: 'done', sudo: 'nopasswd', setup, testAfter })
  expect(setupLine(setup, t)).toMatch(/^Set up on .+: Caddy in Docker$/)
  expect(setupLine(setup, ru)).not.toBe(setupLine(setup, t))
  const live = liveServer(view)
  expect(live.text('.access-done')).toEqual([setupLine(setup, t)])
  expect(live.text('.access-after .access-step')).toEqual(testAfter.map(s => stepLine(s, t)))
  await live.click('Undo')
  expect(live.calls).toEqual([])
  expect(live.buttons()).toContain('Undo? Click again')
  await live.click('Undo? Click again')
  expect(live.calls).toEqual([['server-undo-look', {}]])
  expect(live.buttons()).toContain('Undo')
})

test('the Undo plan: its steps, Docker and edited files only when ticked, Undo sends them', async () => {
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
  expect(live.text('.access-sub')).toContain('The Undo plan (nothing changes until Undo)')
  expect(live.text('.access-title')).toEqual(plan.steps.map((_, i) => title(plan, i + 1)))
  expect(live.text('.access-tick')).toEqual([
    'Remove Docker too (the board installed it, and it holds nothing else)',
    "Remove the board's files you changed since, too",
  ])
  // The setup's line waits while its Undo is planned.
  expect(live.text('.access-done')).toEqual([])
  expect(live.buttons()).not.toContain('Apply')
  await live.type('sudo-password', 'pw')
  await live.tick('tick-removeDocker')
  await live.click('Undo')
  expect(live.calls).toEqual([['server-undo', { plan: 'u1', removeDocker: true, removeEdited: false, password: 'pw' }]])
})

// ---------------------------------------------------------------- Do it myself

test('Do it myself without Look: the case picked, its commands with <placeholders> and what finds each', async () => {
  const live = liveServer(withServer({}))
  await live.click('Do it myself')
  expect(live.text('.access-pick')).toEqual([
    'Nothing on 80 and 443',
    'Caddy as a service',
    'Caddy in Docker',
    'nginx or something else',
  ])
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
  expect(live.text('.access-note').at(-1)).toBe('Then Test connection (step 2).')
  // Closed again.
  await live.click('Do it myself')
  expect(live.has('.access-myself')).toBe(false)
})

test('Do it myself without Look follows the tunnel’s socket; a plan its own check refuses says why, and the part stays', async () => {
  const settings = READY.tunnel.settings
  const at = (over: Partial<typeof settings>): AccessView => ({
    ...READY,
    tunnel: { ...READY.tunnel, settings: { ...settings, ...over } },
    server: IDLE,
  })
  // another socket: what finds the folder's group reads its folder, not the default one
  const other = liveServer(at({ socket: '/srv/b/x.sock' }))
  await other.click('Do it myself')
  expect(other.text('.access-finder')).toEqual(
    placeholderFinders('1', '/srv/b/x.sock').map(f => `${f.placeholder}${f.command}Copy`),
  )
  expect(other.text('.access-finder')).toEqual(['<gid>stat -c %g /srv/bCopy'])
  // a public port the plan's check refuses (the board's own config check never sends one): the
  // field's words instead of the blocks, the picker still there to choose another case
  const refused = liveServer(at({ publicPort: 0 }))
  await refused.click('Do it myself')
  expect(refused.text('.access-why')).toEqual([t('tunnel.err.port', { field: t('tunnel.field.publicPort') })])
  expect(refused.has('.access-block')).toBe(false)
  expect(refused.has('.access-picker')).toBe(true)
  await refused.click('Caddy as a service')
  expect(refused.text('.access-why')).toHaveLength(1)
})

test('Do it myself with Look: the plan Look made, as commands; for another board’s setup, that setup’s Undo', async () => {
  const view = planned('2')
  const live = liveServer(view)
  await live.click('Do it myself')
  expect(live.has('.access-picker')).toBe(false)
  expect(live.text('.access-block-title')).toEqual(
    doItMyself(planOf(view)).map((b, i) => `${i + 1}. ${t(b.title.key, b.title.params)}`),
  )
  // Another board's setup on the server: the Undo of its record, to run by hand.
  const record = recordFor('1', { pair: { user: 'other', socket: '/srv/other/board.sock' } })
  const facts = { ...factsFor('1'), record }
  const other = liveServer(withServer({ phase: 'plan', facts, choice: chooseCase(facts, W), plan: null }))
  await other.click('Do it myself')
  expect(other.has('.access-picker')).toBe(false)
  const undo = undoPlan(record, facts, { id: 'manual', removeDocker: false, removeEdited: false })
  expect(other.text('.access-block-title')).toEqual(
    doItMyself(undo).map((b, i) => `${i + 1}. ${t(b.title.key, b.title.params)}`),
  )
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

// ---------------------------------------------------------------- around step 3

test('On the server: 1 by hand, 2 Test connection, 3 the web server; Call 4’s line while nothing is set up', () => {
  const steps: TestStep[] = [
    { id: 'ssh', ok: true, detail: '', hint: null },
    { id: 'forward', ok: true, detail: '', hint: null },
    { id: 'domain', ok: false, detail: 'TLS handshake failed', hint: 'tls' },
  ]
  const body = bodyOf(withServer({}), steps)
  const server = find(body, el => hasClass(el, 'access-server'))
  expect(textOf(find([server], el => hasClass(el, 'access-head')))).toBe('On the server')
  expect(textsOf([server], 'access-stage-title')).toEqual(['By hand, once', 'Test connection', 'The web server'])
  expect(textsOf([server], 'access-marks')).toEqual([
    '✓ SSH to the server · ✓ The server takes the socket · ✗ The domain reaches this board',
  ])
  // Step 1 is the snippets; step 3 is the part above.
  expect(byClass([server], 'access-snippets')).toHaveLength(1)
  expect(byClass([server], 'access-web')).toHaveLength(1)
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
})

test('the texts in Russian differ, and every one is there', () => {
  expect(missingKeys('ru')).toEqual([])
  const en = partOf(planned('2', 'debian13', { sudo: 'password' }))
  const inRu = partOf(planned('2', 'debian13', { sudo: 'password' }), { lang: 'ru' })
  for (const name of ['access-tip', 'access-sub', 'access-title', 'access-undo-line', 'access-address'])
    expect([name, textsOf(inRu, name)]).not.toEqual([name, textsOf(en, name)])
  expect(buttonsIn(inRu).map(textOf)).not.toContain('Apply')
  expect(foundLines(factsFor('1'), ru, 'boardtunnel')).not.toEqual(foundLines(factsFor('1'), t, 'boardtunnel'))
})
