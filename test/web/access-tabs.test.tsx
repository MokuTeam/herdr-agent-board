// The Remote access panel's tabs (components/access/AccessPanel.tsx, models/access-tabs.ts):
// Tunnel, Server, Sync, Login & devices, each part on its own tab, the others drawn but hidden;
// the tab last picked kept by this browser (a storage that refuses: the Tunnel tab); the server's
// login once, on the Server tab, its passwords going with the Sync tab's requests too.
import { afterEach, describe, expect, test } from 'bun:test'
import type { AccessView } from '../../src/core/access.ts'
import { TUNNEL_SOCKET } from '../../src/core/tunnel.ts'
import { AccessBody } from '../../web/src/components/access/AccessPanel.tsx'
import { ServerSync } from '../../web/src/components/access/ServerSetup.tsx'
import type { AccessSend } from '../../web/src/hooks/useAccess.ts'
import { ACCESS_TABS, type AccessTab, loadTab, saveTab, TAB_KEY } from '../../web/src/models/access-tabs.ts'
import { SETUP_START } from '../../web/src/models/server-setup.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, renderInBoard } from './support/board.tsx'
import { FakeWorld } from './support/fake-dom.ts'
import { type Element, find, findAll, hasClass, type Node } from './support/markup.ts'
import { clone, commit, first } from './support/react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './support/react-events.ts'

const NOW = new Date(2026, 9, 29, 12, 0).getTime()
const VP = { w: 1600, h: 1000 }

const VIEW: AccessView = {
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
      publicPort: null,
    },
    problems: [],
    blocked: null,
    listenPort: 12424,
    status: { state: 'off', since: NOW },
    ssh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    key: { path: 'C:\\Users\\me\\tunnel\\id_ed25519', generated: true, exists: true, publicKey: null, error: null },
    hostKey: null,
  },
  login: { password: true, totp: false, passkeys: [], lockout: null },
  logins: [],
  attempts: [],
  server: {
    admin: { user: '', key: '' },
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
    installDomain: 'workbench.example.com',
  },
}

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const byClass = (nodes: Node[], name: string): Element[] => findAll(nodes, el => hasClass(el, name))
const inputs = (nodes: Node[]): string[] =>
  findAll(nodes, el => el.tag === 'input').map(el => el.attrs.get('name') ?? '')

function bodyOf(view: AccessView, tab?: AccessTab, lang = 'en'): Node[] {
  return renderInBoard(
    <PanelProvider viewport={() => VP}>
      <AccessBody view={view} send={async () => null} steps={null} testing={false} {...(tab && { tab })} />
    </PanelProvider>,
    board({ now: NOW }),
    lang,
  )
}
const paneOf = (nodes: Node[], tab: AccessTab): Element =>
  find(nodes, el => el.attrs.get('id') === `access-pane-${tab}`)

const storageSaved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
afterEach(() => {
  if (storageSaved) Object.defineProperty(globalThis, 'localStorage', storageSaved)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

/** A localStorage that keeps what is put in it (or refuses every read and write). */
function storage(refuse = false): Map<string, string> {
  const kept = new Map<string, string>()
  const no = () => {
    throw new Error('SecurityError')
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: refuse ? no : (key: string) => kept.get(key) ?? null,
      setItem: refuse ? no : (key: string, value: string) => void kept.set(key, String(value)),
    },
    configurable: true,
    writable: true,
  })
  return kept
}

describe('the tab kept', () => {
  test('none kept, or something else: the Tunnel tab; one kept: that one; a storage that refuses: the Tunnel tab, nothing thrown', () => {
    const kept = new Map<string, string>()
    const store = {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
    }
    expect(loadTab(store)).toBe('tunnel')
    saveTab('sync', store)
    expect([...kept]).toEqual([[TAB_KEY, 'sync']])
    expect(loadTab(store)).toBe('sync')
    kept.set(TAB_KEY, 'nonsense')
    expect(loadTab(store)).toBe('tunnel')
    const refusing = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(loadTab(refusing)).toBe('tunnel')
    expect(() => saveTab('server', refusing)).not.toThrow()
    expect(loadTab(null)).toBe('tunnel')
  })

  test('the panel opens on the tab this browser kept; a storage that refuses opens it on the Tunnel tab', () => {
    storage().set(TAB_KEY, 'login')
    const nodes = bodyOf(VIEW)
    const selected = findAll(nodes, el => el.attrs.get('role') === 'tab' && el.attrs.get('aria-selected') === 'true')
    expect(selected.map(textOf)).toEqual(['Login & devices'])
    expect(paneOf(nodes, 'login').attrs.has('hidden')).toBe(false)
    storage(true)
    expect(paneOf(bodyOf(VIEW), 'tunnel').attrs.has('hidden')).toBe(false)
  })
})

describe('the tabs', () => {
  test('four, in order, in English and Russian; the one picked shown, the others drawn but hidden', () => {
    const nodes = bodyOf(VIEW, 'server')
    const tabs = findAll(nodes, el => el.attrs.get('role') === 'tab')
    expect(tabs.map(textOf)).toEqual(['Tunnel', 'Server', 'Sync', 'Login & devices'])
    expect(tabs.map(el => el.attrs.get('aria-selected'))).toEqual(['false', 'true', 'false', 'false'])
    expect(tabs.map(el => el.attrs.get('aria-controls'))).toEqual(ACCESS_TABS.map(x => `access-pane-${x}`))
    expect(ACCESS_TABS.map(x => paneOf(nodes, x).attrs.has('hidden'))).toEqual([true, false, true, true])
    const ru = findAll(bodyOf(VIEW, 'server', 'ru'), el => el.attrs.get('role') === 'tab').map(textOf)
    expect(ru).toEqual(['Туннель', 'Сервер', 'Синхронизация', 'Вход и устройства'])
  })

  test('each part on its tab: the tunnel, the server’s login once and its two cards, the sync, the login and devices', () => {
    const nodes = bodyOf(VIEW)
    const tunnel = paneOf(nodes, 'tunnel')
    expect(byClass([tunnel], 'access-status').length).toBe(1)
    expect(textOf(find([tunnel], el => el.tag === 'details' && hasClass(el, 'access-more')))).toContain(
      'Tunnel settings and keys',
    )
    expect(inputs([tunnel])).toEqual(['domain', 'user', 'key', 'socket', 'publicPort', 'port'])
    const server = paneOf(nodes, 'server')
    // the login once, at the top: the server and its port, the login, its password, a key file
    expect(inputs([server]).slice(0, 5)).toEqual(['host', 'sshPort', 'admin-user', 'login-password', 'admin-key'])
    expect(
      byClass([server], 'access-card').map(c => textOf(find([c], el => hasClass(el, 'access-card-head')))),
    ).toEqual(['The tunnel on the server', 'The board on the server'])
    expect(textOf(server)).toContain('Not set up yet.')
    expect(textOf(server)).toContain('workbench.example.com')
    expect(
      byClass([server], 'access-oneshot').length + byClass([server], 'access-oneshot-fold').length,
    ).toBeGreaterThan(0)
    // nowhere else
    for (const name of ['host', 'sshPort', 'admin-user', 'login-password'])
      expect(inputs(nodes).filter(n => n === name).length).toBe(1)
    const sync = paneOf(nodes, 'sync')
    expect(textOf(sync)).toContain('Sync profiles')
    expect(textOf(sync)).toContain('with the login on the Server tab')
    const login = paneOf(nodes, 'login')
    expect(byClass([login], 'access-login').length).toBe(1)
    expect(byClass([login], 'access-logins').length).toBe(1)
    expect(textOf(login)).not.toContain('Sync profiles')
  })

  test('the Sync tab before the board is on the server: where to install it first', () => {
    const view = { ...VIEW, server: VIEW.server && { ...VIEW.server, installDomain: '' } }
    const sync = paneOf(bodyOf(view, 'sync'), 'sync')
    expect(textOf(sync)).toContain('Install the board on the server first (the Server tab)')
    expect(byClass([sync], 'access-sync')).toEqual([])
  })
})

describe('the login shared', () => {
  test('the Sync tab’s requests carry the passwords typed on the Server tab', async () => {
    const calls: [string, Record<string, unknown>][] = []
    const send: AccessSend = async (op, body = {}) => {
      calls.push([op, body])
      return { ok: true }
    }
    const state = { ...SETUP_START, password: 'S3cr3t%$Ж', sudoPassword: 'Sud0' }
    const context = board({ now: NOW })
    const world = new FakeWorld({ viewport: VP })
    const tree = () => (
      <div>
        <ServerSync view={VIEW} send={send} state={state} />
      </div>
    )
    let hosts: Host[] = []
    const node = tree()
    function Probe() {
      hosts = hostElements(node)
      return null
    }
    renderInBoard(<Probe />, context)
    const markup = first(renderInBoard(node, context))
    const el = world.mount(clone(markup))
    world.afterFlush = () => commit(world, el.node, markup, first(renderInBoard(tree(), context)))
    listenLikeReact(
      world.wrap(world.body),
      () => el,
      () => hosts,
    )
    const preview = el.querySelectorAll('button').find(b => b.textContent === 'Preview')
    if (!preview) throw new Error('no Preview')
    await world.fire(preview, 'click')
    for (let i = 0; i < 8; i++) await Bun.sleep(0)
    expect(calls).toEqual([['sync-look', { direction: 'up', password: 'S3cr3t%$Ж', sudoPassword: 'Sud0' }]])
  })
})
