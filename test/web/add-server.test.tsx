// Settings, Devices, Add a server (#509, components/devices/AddServer.tsx, docs/design/nodes 11.1,
// 12): on a board without `nodes` the panel holds the form alone and asks the board nothing until
// the owner opens it; Look sends the server and the password (never a page attribute); the plan
// in plain words with the ceiling and the packages tick; the server's steps and this computer's,
// "Syncing the profile" while the first bundle goes; a failure with Continue; the end with the
// command that logs Claude in; and a device row that says its profile is not logged in.
import { afterEach, describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { NodeSetupView } from '../../src/core/node-setup.ts'
import type { BoardDevice } from '../../src/core/payload.ts'
import { DevicesPanel } from '../../web/src/components/devices/DevicesPanel.tsx'
import { deviceRows } from '../../web/src/models/devices.ts'
import { continues, loginCommand, lookBody } from '../../web/src/models/node-setup.ts'
import type { Board } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { answers, type Call, restoreFetch } from './support/fetch-answers.ts'
import { byId, type Node, serializeNodes } from './support/markup.ts'
import { first } from './support/react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './support/react-events.ts'

const NOW = Date.now()
const VP = { w: 1600, h: 900 }
const t = translator('en')
const SECRET = 'S3cr3t-pw'

function view(over: Partial<NodeSetupView> = {}): NodeSetupView {
  return {
    phase: 'idle',
    kind: null,
    server: null,
    device: null,
    hostKey: null,
    sudo: null,
    found: null,
    refusals: [],
    plan: null,
    run: null,
    master: [],
    bundle: null,
    login: null,
    hint: null,
    error: null,
    next: null,
    ...over,
  }
}

const SERVER = { host: 'ssh.example.com', sshPort: 22, user: 'root', key: '' }
const PLAN: NonNullable<NodeSetupView['plan']> = {
  id: 'p1',
  words: [
    { key: 'node.plan.users', params: { user: 'agent-board', link: 'agent-board-link', port: '12430' } },
    { key: 'node.plan.tools', params: { herdr: '0.9.5' } },
  ],
  warnings: [{ key: 'node.warn.packagesStay' }],
  steps: [
    { id: 'check', title: { key: 'node.step.check' }, why: { key: 'node.stepWhy.check' } },
    { id: 'user', title: { key: 'node.step.user' }, why: { key: 'node.stepWhy.user' } },
  ],
  ceiling: { memoryMaxMb: 4774, memoryHighMb: 3819, swapMaxMb: 512, cpuWeight: 50, tasksMax: 3000 },
  packagesNeeded: true,
}
const FOUND: NonNullable<NodeSetupView['found']> = {
  os: 'Ubuntu 24.04.1 LTS',
  arch: 'x86_64',
  cpus: 4,
  memTotalMb: 7957,
  memAvailableMb: 7128,
  homeFreeMb: 50_000,
  bun: null,
  herdr: null,
  claude: null,
  node: null,
  record: false,
}
const steps = (states: [string, NonNullable<NodeSetupView['run']>['steps'][number]['state']][]) => ({
  steps: states.map(([id, state]) => ({ id, state })),
  undone: [],
  result: null,
  warnings: [],
  said: [],
})

/** The panel live in a fake DOM with React's handlers on it (as devices-panel.test.tsx does). */
function live(node: ReactElement, context: Board) {
  let hosts: Host[] = []
  function Probe() {
    hosts = hostElements(node)
    return null
  }
  renderInBoard(
    <PanelProvider viewport={() => VP}>
      <Probe />
    </PanelProvider>,
    context,
  )
  const world = new FakeWorld({ viewport: VP })
  const el = world.mount(first(renderInBoard(<PanelProvider viewport={() => VP}>{node}</PanelProvider>, context)))
  listenLikeReact(
    world.wrap(world.body),
    () => el,
    () => hosts,
  )
  const pick = (selector: string): FakeElement => {
    const found = el.querySelector(selector)
    if (!found) throw new Error(`no ${selector}`)
    return found
  }
  return { world, el, pick }
}

const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
const draw = (setup?: NodeSetupView, devices?: BoardDevice[]) =>
  renderInBoard(
    <PanelProvider viewport={() => VP}>
      <DevicesPanel open onClose={() => {}} {...(setup && { setup })} />
    </PanelProvider>,
    board({ data: payload(devices ? { devices } : {}), now: NOW }),
  )
const sheetText = (setup?: NodeSetupView) => text([byId(draw(setup), 'devices-sheet')])
const posted = (calls: Call[]) =>
  calls.filter(c => c.init?.method === 'POST').map(c => JSON.parse(String(c.init?.body)) as Record<string, unknown>)
const settled = () => new Promise(r => setTimeout(r, 0))

describe('Add a server on a board without nodes (#509)', () => {
  afterEach(restoreFetch)

  test('the board is asked nothing while the form is closed; Look sends what was typed, the password only as typed', async () => {
    const calls = answers()
    const p = live(<DevicesPanel open onClose={() => {}} />, board({ data: payload({}), now: NOW }))
    await settled()
    expect(calls).toEqual([])
    expect(p.pick('.devices-add .button.primary').textContent).toBe('Add a server…')
    const typed = {
      host: ' ssh.example.com ',
      sshPort: '2222',
      user: '',
      key: '',
      id: '',
      port: '',
      password: SECRET,
      sudoPassword: '',
    }
    expect(lookBody('look', typed)).toEqual({
      op: 'look',
      host: 'ssh.example.com',
      user: 'root',
      sshPort: 2222,
      password: SECRET,
    })
    expect(lookBody('undo-look', { ...typed, password: '', id: 'box-2', port: '12440', key: 'C:/keys/id' })).toEqual({
      op: 'undo-look',
      host: 'ssh.example.com',
      user: 'root',
      sshPort: 2222,
      key: 'C:/keys/id',
      id: 'box-2',
      port: 12440,
    })
  })

  test("the form open: its fields, the password a field of the page's own, never an attribute", () => {
    const nodes = draw(view())
    const markup = serializeNodes(nodes)
    for (const name of ['host', 'sshPort', 'user', 'password', 'key', 'id', 'port'])
      expect(markup).toContain(`name="node-${name}"`)
    expect(markup).toContain('type="password"')
    expect(markup).not.toContain(SECRET)
    expect(text([byId(nodes, 'devices-sheet')])).toContain('Undo on this server…')
  })
})

describe('the form, phase by phase (#509)', () => {
  afterEach(restoreFetch)

  test('the plan: what was found, the key pinned now, the plan in words, the ceiling, and Apply waits for the packages tick', async () => {
    const v = view({
      phase: 'plan',
      kind: 'apply',
      server: SERVER,
      device: { id: 'server-1', port: 12430 },
      found: FOUND,
      hostKey: { fingerprint: 'SHA256:abc (ED25519)', pinnedNow: true },
      plan: PLAN,
    })
    const all = sheetText(v)
    expect(all).toContain('Ubuntu 24.04.1 LTS, 4 cores, 7.8 GB of memory, 48.8 GB free under /home')
    expect(all).toContain("The server's key, pinned now: SHA256:abc (ED25519)")
    expect(all).toContain(t('node.plan.tools', { herdr: '0.9.5' }))
    expect(all).toContain('MemoryMax, MB')
    // the packages tick needed: Apply waits for it
    expect(serializeNodes(draw(v))).toMatch(/<button type="button" class="button primary" disabled="">Apply<\/button>/)
    const calls = answers()
    const ready = { ...v, plan: { ...PLAN, packagesNeeded: false } }
    const p = live(<DevicesPanel open onClose={() => {}} setup={ready} />, board({ data: payload({}), now: NOW }))
    await p.world.fire(p.pick('.devices-add .access-plain .button.primary'), 'click')
    await settled()
    expect(posted(calls)).toEqual([{ op: 'apply', plan: 'p1', packages: false }])
  })

  test('refused: why, in words, and no Apply', () => {
    const v = view({
      phase: 'plan',
      kind: 'apply',
      server: SERVER,
      found: FOUND,
      refusals: [{ key: 'node.refuse.small', params: { total: '2000', available: '1800', min: '1500' } }],
    })
    const all = sheetText(v)
    expect(all).toContain('The board does not make this server a node:')
    expect(all).toContain(t('node.refuse.small', { total: '2000', available: '1800', min: '1500' }))
    expect(all).not.toContain('Apply')
  })

  test("while it works: the server's steps, then this computer's, and the profile syncing said so", () => {
    const v = view({
      phase: 'finishing',
      kind: 'apply',
      server: SERVER,
      device: { id: 'server-1', port: 12430 },
      plan: PLAN,
      run: steps([
        ['check', 'ok'],
        ['user', 'skip'],
      ]),
      master: [
        { id: 'config', state: 'ok', said: { key: 'node.setup.said.device', params: { id: 'server-1' } } },
        { id: 'link', state: 'ok', said: null },
        { id: 'bundle', state: 'run', said: { key: 'node.place.syncing', params: { name: 'server-1' } } },
        { id: 'login', state: 'wait', said: null },
      ],
    })
    const all = sheetText(v)
    expect(all).toContain('On the server')
    expect(all).toContain('already there')
    expect(all).toContain('On this computer')
    expect(all).toContain('Syncing the profile to server-1…')
    expect(all).not.toContain('Look')
  })

  test('a failure here: what to do, and Continue picks up', async () => {
    const v = view({
      phase: 'failed',
      kind: 'apply',
      server: SERVER,
      plan: PLAN,
      run: steps([['check', 'ok']]),
      master: [{ id: 'link', state: 'fail', said: { key: 'node.setup.said.noAnswer', params: { s: '120' } } }],
      next: { key: 'node.setup.next.link' },
    })
    expect(continues(v)).toBe(true)
    expect(continues({ ...v, next: { key: 'node.setup.next.again' } })).toBe(false)
    expect(sheetText(v)).toContain(t('node.setup.next.link'))
    const calls = answers()
    const p = live(<DevicesPanel open onClose={() => {}} setup={v} />, board({ data: payload({}), now: NOW }))
    await p.world.fire(p.pick('.access-failure .button.primary'), 'click')
    await settled()
    expect(posted(calls)).toEqual([{ op: 'finish' }])
  })

  test('done: the node, and the command that logs Claude in there, with Copy', () => {
    const done = view({
      phase: 'done',
      kind: 'apply',
      server: SERVER,
      device: { id: 'server-1', port: 12430 },
      login: { device: 'server-1', profiles: [{ id: 'default', loggedIn: false }] },
    })
    const nodes = draw(done)
    const all = text([byId(nodes, 'devices-sheet')])
    expect(all).toContain('server-1 is a node of this board.')
    expect(all).toContain('Claude is not logged in on server-1: default')
    expect(all).toContain('ssh -t root@ssh.example.com sudo -iu agent-board claude')
    expect(serializeNodes(nodes)).toContain('Copy')
    const logged = sheetText({ ...done, login: { device: 'server-1', profiles: [{ id: 'default', loggedIn: true }] } })
    expect(logged).toContain('Claude is logged in on server-1.')
  })

  test('in Russian', () => {
    const v = view({ phase: 'plan', kind: 'apply', server: SERVER, found: FOUND, plan: PLAN })
    const nodes = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <DevicesPanel open onClose={() => {}} setup={v} />
      </PanelProvider>,
      board({ data: payload({}), now: NOW }),
      'ru',
    )
    const all = text([byId(nodes, 'devices-sheet')])
    expect(all).toContain('Добавить сервер')
    expect(all).toContain('Применить')
  })
})

describe("a device's row: Claude's login there (#509)", () => {
  const device: BoardDevice = {
    id: 'server-1',
    title: 'server-1',
    kind: 'ssh',
    link: { state: 'online', since: NOW - 60_000, heardAt: NOW },
    status: {
      api: 1,
      id: 'server-1',
      version: '1.2.0',
      commit: 'c',
      platform: 'linux',
      arch: 'x64',
      cpus: 4,
      memTotalMb: 8192,
      memAvailableMb: 4096,
      load: null,
      sessions: { awake: 0, working: 0, asleep: 0 },
      launches: 0,
      workRootFreeMb: null,
      profiles: [
        { id: 'default', loggedIn: false, bundle: null },
        { id: 'mac', loggedIn: null, bundle: null },
      ],
      agents: ['claude'],
      at: NOW,
    },
    sameCommit: true,
    payloadAt: null,
    paused: false,
    drain: false,
    maxSessions: 4,
    minFreeMemMb: 1200,
    maxLoad: 0.9,
  }
  const settings = { defaults: {}, noToken: [], hosts: { 'server-1': { host: '203.0.113.10', sshPort: 2222 } } }

  test('a profile that is not logged in is said, with the command for its server; one that cannot tell is not', () => {
    expect(deviceRows([device], NOW, t, settings)[0]?.login).toEqual({
      out: ['default'],
      command: 'ssh -t -p 2222 203.0.113.10 sudo -iu agent-board claude',
    })
    expect(deviceRows([device], NOW, t, { defaults: {}, noToken: [] })[0]?.login).toEqual({
      out: ['default'],
      command: null,
    })
    const logged = {
      ...device,
      status: {
        ...(device.status as NonNullable<BoardDevice['status']>),
        profiles: [{ id: 'default', loggedIn: true, bundle: null }],
      },
    }
    expect(deviceRows([logged], NOW, t, settings)[0]?.login).toBeNull()
    expect(loginCommand({ host: 'h', sshPort: 22 })).toBe('ssh -t h sudo -iu agent-board claude')
  })

  test('the row draws it', () => {
    const all = text([byId(draw(undefined, [device]), 'devices-sheet')])
    expect(all).toContain('Claude is not logged in on server-1: default')
  })
})
