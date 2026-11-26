// Settings, Devices (#510, components/devices/DevicesPanel.tsx, docs/design/nodes 12): the devices
// in order with their link in words, bars, version and bundles, Pause, Drain and the thresholds;
// the lanes that may leave this computer and When everything is full. Rendered from fixtures (one
// device online, one not reachable, one refused for its version, this computer) at a desktop's and a
// phone's width. Without `devices` in the payload (a board without `nodes`) the panel holds Add a
// server alone (#509, test/web/add-server.test.tsx).
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, type ReactElement } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardDevice, BoardPayload } from '../../src/core/payload.ts'
import { DevicesPanel } from '../../web/src/components/devices/DevicesPanel.tsx'
import { offersDevices } from '../../web/src/hooks/useSettingsMenu.ts'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import {
  DEVICE_COLORS,
  deviceOptions,
  deviceRows,
  deviceTitle,
  deviceTitleEdited,
  lanesAfter,
  laneTicks,
  linkWords,
  movedOrder,
  type PanelSettings,
  refusedText,
  thresholdTyped,
  updateLine,
} from '../../web/src/models/devices.ts'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import { type Board, BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { answers, type Call, restoreFetch } from './support/fetch-answers.ts'
import { byId, findAll, hasClass, type Node, serializeNodes } from './support/markup.ts'
import { first } from './support/react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './support/react-events.ts'

const NOW = Date.now()
const MIN = 60_000
const t = translator('en')

function status(id: string, awake: number, more: Partial<NonNullable<BoardDevice['status']>> = {}) {
  return {
    api: 1,
    id,
    version: '1.2.0',
    commit: 'c',
    platform: 'linux',
    arch: 'x64',
    cpus: 4,
    memTotalMb: 8192,
    memAvailableMb: 4096,
    load: null,
    sessions: { awake, working: 0, asleep: 0 },
    launches: 0,
    workRootFreeMb: null,
    profiles: [{ id: 'work', loggedIn: true, bundle: { seq: 7, hash: 'a'.repeat(64) } }],
    agents: ['claude'],
    at: NOW,
    ...more,
  }
}

function device(id: string, fields: Partial<BoardDevice> = {}): BoardDevice {
  const local = id === 'local'
  return {
    id,
    title: id,
    kind: local ? null : 'ssh',
    link: local ? null : { state: 'online', since: NOW - 60 * MIN, heardAt: NOW - MIN },
    status: null,
    sameCommit: local ? null : true,
    payloadAt: null,
    paused: false,
    drain: false,
    maxSessions: 4,
    minFreeMemMb: 1200,
    maxLoad: 0.9,
    ...fields,
  }
}

const DEVICES: BoardDevice[] = [
  device('server-1', { title: 'Server 1', status: status('server-1', 1) }),
  device('server-2', {
    link: { state: 'offline', since: NOW - 6 * MIN, heardAt: NOW - 8.5 * MIN },
    paused: true,
  }),
  device('server-3', {
    link: { state: 'refused', since: NOW - MIN, heardAt: null, reason: 'api' },
    sameCommit: false,
    status: status('server-3', 0, { version: '1.1.0' }),
  }),
  device('local', { status: status('laptop', 3, { profiles: [] }), maxSessions: 20 }),
]

const SETTINGS: PanelSettings = {
  whenFull: 'local',
  lanes: ['atlas'],
  seen: ['atlas', 'tools'],
  defaults: { 'server-1': { maxSessions: 4, minFreeMemMb: 1229, maxLoad: 0.9 } },
  next: 'server-1',
  noToken: [],
}

const CATEGORIES = [
  { id: 'atlas', title: 'Atlas', color: '#0a84ff', colorName: 'blue', paths: [], configured: true, fallback: false },
  { id: 'tools', title: 'Tools', color: '#30d158', colorName: 'green', paths: [], configured: true, fallback: false },
  { id: 'fresh', title: 'Fresh', color: '#ff9f0a', colorName: 'orange', paths: [], configured: false, fallback: false },
]

function draw(data: BoardPayload, w = 1600, settings: PanelSettings | undefined = SETTINGS) {
  return renderInBoard(
    <PanelProvider viewport={() => ({ w, h: 900 })}>
      <DevicesPanel open onClose={() => {}} {...(settings && { initial: settings })} />
    </PanelProvider>,
    board({ data, now: NOW }),
  )
}

const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
const rowsOf = (nodes: Node[]) => findAll(nodes, el => hasClass(el, 'devices-row'))
const full = () => payload({ devices: DEVICES, categories: CATEGORIES })

describe('Settings, Devices (#510)', () => {
  test("a device's secrets (#604): those its syncs gave and those to give by hand, under its version", () => {
    const nodes = draw(full(), 1600, {
      ...SETTINGS,
      secrets: {
        'server-1': { given: ['MCP_MEMPALACE_AUTHORIZATION', 'mempalace-memory/config.json'], toGive: [] },
        'server-2': { given: [], toGive: ['API_TOKEN'] },
      },
    })
    const [one, two, three] = rowsOf(nodes).map(r => text([r]))
    expect(one).toContain('Secrets given: MCP_MEMPALACE_AUTHORIZATION, mempalace-memory/config.json')
    expect(two).toContain('Secrets to give by hand: API_TOKEN')
    expect(three).not.toContain('Secrets')
  })

  for (const [name, w] of [
    ['desktop', 1600],
    ['phone', 390],
  ] as const)
    test(`the devices in order, each with its state, at a ${name}'s width`, () => {
      const nodes = draw(full(), w)
      const sheet = byId(nodes, 'devices-sheet')
      const rows = rowsOf(nodes)
      expect(rows.map(r => r.attrs.get('data-id'))).toEqual(['server-1', 'server-2', 'server-3', 'local'])
      const [one, two, three, here] = rows.map(r => text([r]))
      expect(one).toContain('Server 1')
      expect(one).toContain('Online')
      expect(one).toContain('1 of 4 sessions')
      expect(one).toContain('4 GB free, keeps 1.2 GB')
      expect(one).toContain('Version 1.2.0 · same as this board')
      expect(one).toContain('Profile work: bundle 7')
      expect(two).toContain('Not reachable for 6 min')
      expect(two).toContain('No status yet')
      expect(three).toContain('Refused: it speaks another version of the link')
      expect(three).toContain("Version 1.1.0 · not this board's")
      // The quiet mark on the device the next start would go to, on that one only.
      expect(rows.map(r => findAll([r], el => hasClass(el, 'devices-next')).length)).toEqual([1, 0, 0, 0])
      expect(one).toContain('Next start')
      expect(here).toContain('laptop')
      expect(here).toContain('master')
      expect(here).not.toContain('This computer')
      expect(here).toContain('3 of 20 sessions')
      // Pause, Give it the secrets and Own profiles on every device but this computer; Drain on all four.
      const switches = (row: (typeof rows)[number]) =>
        findAll([row], el => el.attrs.has('data-switch')).map(el => [
          el.attrs.get('data-switch'),
          el.attrs.get('aria-checked'),
        ])
      expect(rows.map(switches)).toEqual([
        [
          ['paused', 'false'],
          ['drain', 'false'],
          ['giveSecrets', 'true'],
          ['ownProfiles', 'false'],
        ],
        [
          ['paused', 'true'],
          ['drain', 'false'],
          ['giveSecrets', 'true'],
          ['ownProfiles', 'false'],
        ],
        [
          ['paused', 'false'],
          ['drain', 'false'],
          ['giveSecrets', 'true'],
          ['ownProfiles', 'false'],
        ],
        [['drain', 'false']],
      ])
      // The thresholds: the value config.json has, the board's own figure as the placeholder.
      const inputs = findAll([rows[0] as Node], el => el.tag === 'input')
      expect(inputs.map(i => [i.attrs.get('value'), i.attrs.get('placeholder')])).toEqual([
        ['4', '4'],
        ['1200', '1229'],
        ['0.9', '0.9'],
      ])
      // Every row has a handle named for the device, for the arrows.
      expect(findAll(rows, el => hasClass(el, 'handle')).map(h => h.attrs.get('aria-label'))).toEqual([
        'Move Server 1',
        'Move server-2',
        'Move server-3',
        'Move laptop',
      ])
      // The lanes, in their colours, a new one marked; All; When everything is full.
      const lanes = findAll([sheet], el => hasClass(el, 'devices-lane'))
      expect(lanes.map(l => [text([l]), findAll([l], el => el.tag === 'input')[0]?.attrs.has('checked')])).toEqual([
        ['All lanes', false],
        ['Atlas', true],
        ['Tools', false],
        ['Freshnew', false],
      ])
      expect(serializeNodes([lanes[1] as Node])).toContain('--lane:#0a84ff')
      const whenFull = findAll([sheet], el => el.attrs.get('data-switch') === 'whenFull')[0]
      expect(whenFull?.attrs.get('aria-checked')).toBe('true')
      expect(text([sheet])).toContain('When everything is full')
    })

  test('the bars: sessions against maxSessions, memory with the floor where minFreeMemMb sits', () => {
    const [one] = rowsOf(draw(full()))
    const html = serializeNodes(one ? [one] : [])
    expect(html).toContain('--share:0.25')
    expect(html).toContain('--share:0.5')
    expect(html).toMatch(/class="devices-floor" style="--share:0\.146/)
  })

  test('in Russian', () => {
    const nodes = renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 900 })}>
        <DevicesPanel open onClose={() => {}} initial={SETTINGS} />
      </PanelProvider>,
      board({ data: full(), now: NOW }),
      'ru',
    )
    const all = text([byId(nodes, 'devices-sheet')])
    expect(all).toContain('Устройства')
    expect(all).toContain('мастер')
    expect(all).not.toContain('Этот компьютер')
    expect(all).toContain('На связи')
    expect(all).toContain('Лейны, которые могут уйти с этого компьютера')
    expect(all).toContain('новый')
  })

  test('a board without nodes: Add a server alone, no device, no lanes, no switch (#509)', () => {
    const nodes = draw(payload({ categories: CATEGORIES }), 1600, undefined)
    const all = text([byId(nodes, 'devices-sheet')])
    expect(rowsOf(nodes)).toEqual([])
    expect(all).toContain('No device yet')
    expect(all).toContain('Add a server…')
    expect(all).not.toContain('Lanes that may leave this computer')
    expect(all).not.toContain('Start on this computer')
  })

  test('a node board: no Add a server, no Add a computer, devices are added on the master (#777)', () => {
    const nodes = draw(payload({ categories: CATEGORIES, machine: 'server-1' }), 1600, undefined)
    const all = text([byId(nodes, 'devices-sheet')])
    expect(rowsOf(nodes)).toEqual([])
    expect(all).toContain('This computer is a node of the master board.')
    expect(all).not.toContain('No device yet')
    expect(all).not.toContain('Add a server…')
    expect(all).not.toContain('Add a computer')
  })

  test('a node board names the machine its board is served from (#777)', () => {
    const data = payload({
      categories: CATEGORIES,
      machine: 'server-1',
      nodeMaster: { nodeId: 'server-1', name: 'atlas', url: null, online: true },
    })
    const all = text([byId(draw(data, 1600, undefined), 'devices-sheet')])
    expect(all).toContain('This computer is a node of the board on atlas. Servers and computers are added there')
    expect(all).not.toContain('Add a server…')
  })

  test('a master that is a node too still adds devices (#777)', () => {
    const all = text([byId(draw(payload({ ...full(), machine: 'laptop' }), 1600, undefined), 'devices-sheet')])
    expect(all).toContain('Add a server…')
    expect(all).not.toContain('This computer is a node of the master board.')
  })
})

describe('the Settings menu (#510)', () => {
  const now = {
    t,
    theme: 'auto',
    languages: { en: 'English' },
    canEdit: true,
    dock: 'right' as const,
    sleepers: false,
    profiles: false,
  }
  const ids = (items: ReturnType<typeof settingsMenu>) => items.map(i => ('separator' in i ? '-' : i.id))

  test('Devices… on the local page, a board without nodes too (it adds its first server there, #509); on remote only when ownerAdmin is set (#694)', () => {
    expect(offersDevices(false)).toBe(true)
    expect(offersDevices(true)).toBe(false)
    expect(offersDevices(true, false)).toBe(false)
    expect(offersDevices(true, true)).toBe(true)
  })

  test('Devices… only when the page offers it; without, the menu is as before', () => {
    expect(ids(settingsMenu(now))).not.toContain('devices')
    expect(ids(settingsMenu({ ...now, devices: false }))).toEqual(ids(settingsMenu(now)))
    const items = ids(settingsMenu({ ...now, team: true, devices: true }))
    expect(items.indexOf('devices')).toBe(items.indexOf('team') + 1)
    expect(settingsMenu({ ...now, devices: true }).find(i => 'id' in i && i.id === 'devices')).toMatchObject({
      label: 'Devices…',
    })
    expect(settingPicked('devices')).toEqual({ kind: 'devices' })
  })
})

describe('the panel’s pure parts (#510)', () => {
  test('moved by the arrows, held inside the list', () => {
    const order = ['server-1', 'server-2', 'local']
    expect(movedOrder(order, 'server-2', -1)).toEqual(['server-2', 'server-1', 'local'])
    expect(movedOrder(order, 'server-2', 1)).toEqual(['server-1', 'local', 'server-2'])
    expect(movedOrder(order, 'server-1', -1)).toEqual(order)
    expect(movedOrder(order, 'local', 1)).toEqual(order)
  })

  test('the lanes after a tick: by name, never all but from the All tick', () => {
    const ids = ['atlas', 'tools']
    expect(lanesAfter([], ids, 'Atlas', true)).toEqual(['atlas'])
    expect(lanesAfter(['atlas'], ids, 'tools', true)).toEqual(['atlas', 'tools'])
    expect(lanesAfter('all', ids, 'tools', false)).toEqual(['atlas'])
    expect(lanesAfter(['atlas'], ids, 'atlas', false)).toEqual([])
    // Never saved: nothing is new. A lane ticked is never new.
    expect(laneTicks(CATEGORIES, [], null).map(l => l.fresh)).toEqual([false, false, false])
    expect(laneTicks(CATEGORIES, ['fresh'], ['atlas']).map(l => [l.id, l.ticked, l.fresh])).toEqual([
      ['atlas', false, false],
      ['tools', false, true],
      ['fresh', true, false],
    ])
    expect(laneTicks(CATEGORIES, 'all', ['atlas']).every(l => l.ticked && !l.fresh)).toBe(true)
  })

  test('a threshold as typed: the board’s figure when empty, nothing for a bad or unchanged value', () => {
    expect(thresholdTyped('maxSessions', '6', 4, 3)).toBe(6)
    expect(thresholdTyped('maxSessions', '', 4, 3)).toBe(4)
    expect(thresholdTyped('maxSessions', '', undefined, 3)).toBeNull()
    expect(thresholdTyped('maxSessions', '0', 4, 3)).toBeNull()
    expect(thresholdTyped('maxSessions', '2.5', 4, 3)).toBeNull()
    expect(thresholdTyped('maxSessions', '3', 4, 3)).toBeNull()
    expect(thresholdTyped('maxLoad', '0,75', 0.9, 0.9)).toBe(0.75)
    expect(thresholdTyped('maxLoad', '0', 0.9, 0.9)).toBeNull()
    expect(thresholdTyped('minFreeMemMb', 'x', 1024, 1200)).toBeNull()
  })

  test('the rows and a refusal in words', () => {
    const rows = deviceRows(DEVICES, NOW, t)
    expect(rows.map(r => [r.id, r.here, r.linkState])).toEqual([
      ['server-1', false, 'online'],
      ['server-2', false, 'offline'],
      ['server-3', false, 'refused'],
      ['local', true, null],
    ])
    expect(rows[3]?.link).toBeNull()
    // Own profiles (#802): on where the payload marks it, off everywhere else.
    expect(rows.map(r => r.ownProfiles)).toEqual([false, false, false, false])
    const marked = deviceRows(
      DEVICES.map(d => (d.id === 'server-2' ? { ...d, ownProfiles: true as const } : d)),
      NOW,
      t,
    )
    expect(marked.map(r => r.ownProfiles)).toEqual([false, true, false, false])
    // How long it has been offline, also when it was never heard; under a minute, no figure.
    expect(linkWords({ id: 'server-2', link: { state: 'offline', since: NOW - 6 * MIN, heardAt: null } }, NOW, t)).toBe(
      'Not reachable for 6 min',
    )
    expect(linkWords({ id: 'server-2', link: { state: 'offline', since: NOW - 10_000, heardAt: null } }, NOW, t)).toBe(
      'Not reachable',
    )
    expect(refusedText(400, 'maxSessions', t)).toBe('Not saved: Sessions at most does not check out')
    expect(refusedText(409, 'x', t)).toBeNull()
  })
})

// ---------------------------------------------------------------- live, with React's handlers

const VP = { w: 1600, h: 900 }

/** The panel live in a fake DOM with React's handlers on it (as test/web/profiles-panel.test.tsx does). */
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

const posted = (calls: Call[]) =>
  calls.filter(c => c.init?.method === 'POST').map(c => JSON.parse(String(c.init?.body)) as Record<string, unknown>)
const toasts: [string, boolean | undefined][] = []
const panelLive = () =>
  live(
    <DevicesPanel open onClose={() => {}} initial={SETTINGS} />,
    board({ data: full(), now: NOW, toast: (text: string, bad?: boolean) => void toasts.push([text, bad]) }),
  )
const settled = () => new Promise(r => setTimeout(r, 0))

describe('Settings, Devices live (#510)', () => {
  afterEach(() => {
    restoreFetch()
    toasts.length = 0
  })

  test('the arrows on a handle move the device and send the whole order', async () => {
    const calls = answers([200, { ok: true, settings: SETTINGS }])
    const p = panelLive()
    await p.world.fire(p.pick('[data-id="server-2"] .handle'), 'keydown', { key: 'ArrowUp' })
    await settled()
    expect(posted(calls)).toEqual([{ op: 'order', ids: ['server-2', 'server-1', 'server-3', 'local'] }])
    // At the top, up does nothing; another key does nothing.
    const none = answers()
    const q = panelLive()
    await q.world.fire(q.pick('[data-id="server-1"] .handle'), 'keydown', { key: 'ArrowUp' })
    await q.world.fire(q.pick('[data-id="server-1"] .handle'), 'keydown', { key: 'a' })
    expect(posted(none)).toEqual([])
  })

  test('Pause, Drain and When everything is full send their op', async () => {
    const calls = answers()
    const p = panelLive()
    await p.world.fire(p.pick('[data-id="server-1"] [data-switch="paused"]'), 'click')
    await p.world.fire(p.pick('[data-id="local"] [data-switch="drain"]'), 'click')
    await p.world.fire(p.pick('[data-switch="whenFull"]'), 'click')
    await settled()
    expect(posted(calls)).toEqual([
      { op: 'set', id: 'server-1', paused: true },
      { op: 'set', id: 'local', drain: true },
      { op: 'whenFull', whenFull: 'wait' },
    ])
  })

  test('a threshold is sent when left or on Enter; empty takes the board’s figure; Escape sends nothing', async () => {
    const calls = answers()
    const p = panelLive()
    const field = (i: number) => p.el.querySelectorAll('[data-id="server-1"] .devices-limit input')[i] as FakeElement
    const typeAndLeave = async (i: number, value: string, key?: string) => {
      const f = field(i)
      f.focus()
      f.value = value
      if (key) await p.world.fire(f, 'keydown', { key })
      await p.world.fire(f, 'focusout')
    }
    await typeAndLeave(0, '6')
    await typeAndLeave(1, '')
    await typeAndLeave(2, '0.5', 'Enter')
    await typeAndLeave(0, '9', 'Escape')
    await typeAndLeave(0, '0')
    await settled()
    expect(posted(calls)).toEqual([
      { op: 'set', id: 'server-1', maxSessions: 6 },
      { op: 'set', id: 'server-1', minFreeMemMb: 1229 },
      { op: 'set', id: 'server-1', maxLoad: 0.5 },
    ])
    // Escape and a bad value put the field back.
    expect(field(0).value).toBe('4')
  })

  test('a lane ticked sends the list and the lanes shown; All sends all', async () => {
    const calls = answers()
    const p = panelLive()
    const ticks = p.el.querySelectorAll('.devices-lane input') as FakeElement[]
    // The browser flips a box before React hears the click.
    const tick = async (box: FakeElement) => {
      box.checked = !box.checked
      await p.world.fire(box, 'click')
    }
    await tick(ticks[2] as FakeElement)
    await tick(ticks[0] as FakeElement)
    await settled()
    expect(posted(calls)).toEqual([
      { op: 'lanes', lanes: ['atlas', 'tools'], shown: ['atlas', 'tools', 'fresh'] },
      { op: 'lanes', lanes: 'all', shown: ['atlas', 'tools', 'fresh'] },
    ])
  })

  test('a refusal says which field, in words', async () => {
    answers([400, { error: 'maxSessions' }], [200, { settings: SETTINGS }])
    const p = panelLive()
    const f = p.el.querySelectorAll('[data-id="server-1"] .devices-limit input')[0] as FakeElement
    f.focus()
    f.value = '7'
    await p.world.fire(f, 'focusout')
    await settled()
    await settled()
    expect(toasts).toEqual([['Not saved: Sessions at most does not check out', true]])
  })
})

describe('what the owner reads (#510, polish)', () => {
  const ru = translator('ru')
  const one = (fields: Partial<BoardDevice>) => deviceRows([device('server-5', fields)], NOW, t, SETTINGS)[0]

  test('a count of one is singular, in English and Russian', () => {
    const at = (n: number, tr = t) =>
      deviceRows([device('server-5', { maxSessions: null, status: status('server-5', n) })], NOW, tr)[0]?.sessions?.text
    expect([at(1), at(2), at(5)]).toEqual(['1 session awake', '2 sessions awake', '5 sessions awake'])
    expect([at(0, ru), at(1, ru), at(2, ru), at(5, ru), at(11, ru), at(12, ru), at(21, ru)]).toEqual([
      '0 активных сессий',
      '1 активная сессия',
      '2 активные сессии',
      '5 активных сессий',
      '11 активных сессий',
      '12 активных сессий',
      '21 активная сессия',
    ])
  })

  test('master device is named by its title/selfId/status in switch and panel, never "local" or "This computer"; a title of its own stays (#752)', () => {
    const devices = [device('local', { selfId: 'server-2' }), device('server-1', { title: 'Server 1' })]
    expect(deviceOptions(devices, [], t)?.map(o => o.title)).toEqual(['All devices', 'server-2', 'Server 1'])
    expect(deviceOptions(devices, [], ru)?.map(o => o.title)).toEqual(['Все устройства', 'server-2', 'Server 1'])
    const nodes = draw(payload({ devices, categories: CATEGORIES }))
    const here = rowsOf(nodes).find(r => r.attrs.get('data-id') === 'local')
    const name = findAll([here as Node], el => hasClass(el, 'devices-name'))[0]
    expect(text([name as Node])).toBe('server-2master')
    expect(text([name as Node])).not.toContain('This computer')
    expect(findAll([here as Node], el => hasClass(el, 'devices-link'))).toEqual([])
    const ruNodes = renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 900 })}>
        <DevicesPanel open onClose={() => {}} initial={SETTINGS} />
      </PanelProvider>,
      board({ data: payload({ devices, categories: CATEGORIES }), now: NOW }),
      'ru',
    )
    const ruHere = rowsOf(ruNodes).find(r => r.attrs.get('data-id') === 'local')
    expect(text(findAll([ruHere as Node], el => hasClass(el, 'devices-name')))).toBe('server-2мастер')
    // An owner who named it keeps the name; "local" (any case) normalises to device id (#758);
    // without title/selfId/status falls back to master/мастер.
    expect(deviceTitle({ id: 'local', title: 'Workstation', kind: null }, t)).toBe('Workstation')
    expect(deviceTitle({ id: 'local', title: 'local', kind: null, selfId: 'server-2' }, t)).toBe('server-2')
    expect(deviceTitle({ id: 'local', title: ' Local ', kind: null, selfId: 'server-2' }, t)).toBe('server-2')
    expect(deviceTitle({ id: 'local', title: 'LOCAL', kind: null }, t)).toBe('master')
    expect(deviceTitle({ id: 'local', title: 'local', kind: null }, ru)).toBe('мастер')
    expect(deviceTitle({ id: 'server-1', title: 'server-1', kind: 'ssh' }, t)).toBe('server-1')
    expect(deviceTitle({ id: 'laptop', title: 'local', kind: 'ssh' }, t)).toBe('laptop')
    expect(deviceTitle({ id: 'laptop', title: 'Local', kind: 'ssh' }, t)).toBe('laptop')
    expect(deviceTitle({ id: 'laptop', title: 'LOCAL', kind: 'ssh' }, ru)).toBe('laptop')
    // A revoked device with no link has no kind either: still its own title.
    expect(deviceTitle({ id: 'server-1', title: 'server-1', kind: null }, t)).toBe('server-1')
  })

  test('the sessions bar fills against maxSessions, else the board’s figure for the device', () => {
    const own = one({ maxSessions: 2, status: status('server-5', 1) })
    expect(own?.sessions).toEqual({ share: 0.5, text: '1 of 2 sessions' })
    const byDefault = deviceRows([device('server-5', { maxSessions: null, status: status('server-5', 1) })], NOW, t, {
      ...SETTINGS,
      defaults: { 'server-5': { maxSessions: 4, minFreeMemMb: 1229, maxLoad: 0.9 } },
    })[0]
    expect(byDefault?.sessions).toEqual({ share: 0.25, text: '1 of 4 sessions' })
    // Neither: the count alone, no bar.
    expect(one({ maxSessions: null, status: status('server-5', 1) })?.sessions).toEqual({
      share: null,
      text: '1 session awake',
    })
  })

  test('a refusal for the token with none stored says so, with the command', () => {
    const refused = { state: 'refused' as const, since: NOW - MIN, heardAt: null, reason: 'token' as const }
    const words = (noToken: string[], tr = t) =>
      deviceRows([device('server-5', { link: refused })], NOW, tr, { ...SETTINGS, noToken })[0]?.link
    expect(words(['server-5'])).toBe('No token yet: board nodes token server-5')
    expect(words(['server-5'], ru)).toBe('Токена ещё нет: board nodes token server-5')
    expect(words([])).toBe("Refused: it does not take this board's token")
    // Another reason with no token stored keeps its own words.
    const api = deviceRows([device('server-5', { link: { ...refused, reason: 'api' } })], NOW, t, {
      ...SETTINGS,
      noToken: ['server-5'],
    })[0]?.link
    expect(api).toBe('Refused: it speaks another version of the link')
  })
})

describe('how a device takes an update (#793)', () => {
  test('its row says by git or from archive beside the version; nothing for a node that does not say, nor this computer', () => {
    const rows = deviceRows(
      [
        device('server-1', { status: status('server-1', 0, { updates: 'git' }) }),
        device('server-2', { status: status('server-2', 0, { updates: 'archive' }) }),
        device('server-3', { status: status('server-3', 0) }),
        device('local', { status: status('laptop', 0, { updates: 'git' }) }),
      ],
      NOW,
      t,
    )
    expect(rows.map(r => r.updates)).toEqual(['updates by git', 'updates from archive', null, null])
    const ru = deviceRows(
      [device('server-1', { status: status('server-1', 0, { updates: 'git' }) })],
      NOW,
      translator('ru'),
    )
    expect(ru[0]?.updates).toBe('обновляется через git')
  })
})

describe('Update, on a node on another version (#590)', () => {
  afterEach(() => {
    restoreFetch()
    toasts.length = 0
  })
  const en = translator('en')

  test('the row says it in words, not as a hash, and offers Update; updating, restarting and a failure each say theirs', () => {
    const behind = device('server-3', { sameCommit: false })
    expect(updateLine(behind, en)).toEqual({
      state: 'behind',
      text: 'Runs another version of the board than this computer. It updates by itself while it is online and none of its sessions is working.',
      offer: true,
    })
    const at = NOW
    expect(updateLine(device('s', { sameCommit: false, update: { state: 'updating', commit: 'b', at } }), en)).toEqual({
      state: 'updating',
      text: "Updating to this computer's version",
      offer: false,
    })
    expect(
      updateLine(device('s', { sameCommit: false, update: { state: 'restarting', commit: 'b', at } }), en)?.text,
    ).toBe('Updated: its board is restarting on the new version')
    const failed = (error: string) =>
      updateLine(device('s', { sameCommit: false, update: { state: 'failed', commit: 'b', error, at } }), en)
    expect(failed('install')).toEqual({
      state: 'failed',
      text: 'The update failed: bun install failed on the device (it needs the network); the old copy stays',
      offer: true,
    })
    // what the button cannot mend says to update by hand, with no button
    expect(failed('platform')).toEqual({
      state: 'failed',
      text: 'The update failed: it runs an older board on Windows, which does not update itself: update it by hand once',
      offer: false,
    })
    expect(failed('no-checkout')?.offer).toBe(false)
    expect(failed('teapot')?.text).toBe('The update failed: the device said teapot')
    // a checkout the node does not move by itself, and a folder with a .git it keeps (#793): words, no button
    expect(failed('git-dirty')).toEqual({
      state: 'failed',
      text: 'The update failed: its checkout has changes: commit or stash them there, or update it by hand',
      offer: false,
    })
    for (const code of ['git-ahead', 'git-diverged', 'git-locks', 'kept-old']) expect(failed(code)?.offer).toBe(false)
    for (const code of ['git', 'git-fetch', 'git-commit']) {
      expect(failed(code)?.offer).toBe(true)
      expect(failed(code)?.text).not.toContain('the device said')
    }
    for (const code of [
      'git',
      'git-dirty',
      'git-fetch',
      'git-ahead',
      'git-commit',
      'git-diverged',
      'git-locks',
      'kept-old',
    ])
      expect(
        updateLine(
          device('s', { sameCommit: false, update: { state: 'failed', commit: 'b', error: code, at } }),
          translator('ru'),
        )?.text,
      ).not.toContain('{')
    // offline: said, with no button; revoked: nothing; a node that knows no commit is behind
    const away = { state: 'offline' as const, since: NOW, heardAt: null }
    expect(updateLine(device('s', { sameCommit: false, link: away }), en)).toMatchObject({
      state: 'behind',
      offer: false,
    })
    expect(
      updateLine(
        device('s', { sameCommit: false, link: away, update: { state: 'failed', commit: 'b', error: 'install', at } }),
        en,
      )?.offer,
    ).toBe(false)
    expect(updateLine(device('s', { sameCommit: false, revoked: { told: false, kept: true } }), en)).toBeNull()
    expect(updateLine(device('s', { sameCommit: null, status: status('s', 0, { commit: '' }) }), en)?.state).toBe(
      'behind',
    )
    // the same version, an unknown one and this computer: nothing
    expect(updateLine(device('server-1'), en)).toBeNull()
    expect(updateLine(device('server-1', { sameCommit: null }), en)).toBeNull()
    expect(updateLine(device('local'), en)).toBeNull()
  })

  test('drawn: the line under the version, the button only where it can help, in Russian too', () => {
    const data = payload({
      categories: CATEGORIES,
      devices: [
        device('server-1', { status: status('server-1', 1) }),
        device('server-2', { sameCommit: false, update: { state: 'updating', commit: 'b', at: NOW } }),
        device('server-3', { sameCommit: false, status: status('server-3', 0, { version: '1.1.0' }) }),
        device('server-4', {
          sameCommit: false,
          update: { state: 'failed', commit: 'b', error: 'platform', at: NOW },
        }),
        device('local', { status: status('laptop', 3, { profiles: [] }) }),
      ],
    })
    const rows = rowsOf(draw(data))
    const lines = rows.map(r => findAll([r], el => hasClass(el, 'devices-update')).map(el => text([el])))
    expect(lines).toEqual([
      [],
      ["Updating to this computer's version"],
      [
        'Runs another version of the board than this computer. It updates by itself while it is online and none of its sessions is working.Update',
      ],
      ['The update failed: it runs an older board on Windows, which does not update itself: update it by hand once'],
      [],
    ])
    const ru = renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 900 })}>
        <DevicesPanel open onClose={() => {}} initial={SETTINGS} />
      </PanelProvider>,
      board({ data, now: NOW }),
      'ru',
    )
    const all = text([byId(ru, 'devices-sheet')])
    expect(all).toContain('Обновляется до версии этого компьютера')
    expect(all).toContain('Обновить')
  })

  test('Update sends its op; the row, not a toast, says how it went', async () => {
    const calls = answers([502, { ok: false, error: 'install' }])
    const p = live(
      <DevicesPanel open onClose={() => {}} initial={SETTINGS} />,
      board({
        data: payload({ devices: [device('server-3', { sameCommit: false })], categories: CATEGORIES }),
        now: NOW,
        toast: (text: string, bad?: boolean) => void toasts.push([text, bad]),
      }),
    )
    await p.world.fire(p.pick('[data-id="server-3"] .devices-update-go'), 'click')
    await settled()
    expect(posted(calls)).toEqual([{ op: 'update', id: 'server-3' }])
    expect(toasts).toEqual([])
  })
})

describe('what an agent on the device cannot do for git (#609)', () => {
  const gitStatus = (programs: string[], identity: boolean, logins: { host: string; user: string }[]) =>
    status('server-1', 1, { programs, git: { identity, logins } })
  test('in plain words, English and Russian, by what its status says', () => {
    const row = (s: ReturnType<typeof gitStatus>, tr = t) =>
      deviceRows([device('server-1', { title: 'server-1', status: s })], NOW, tr)[0]?.git
    expect(row(gitStatus(['git', 'gh'], false, []))).toEqual([
      'No git identity on server-1: commits there are made as the machine',
      'No GitHub login on server-1: agents there cannot push',
    ])
    expect(row(gitStatus(['git'], true, [{ host: 'github.com', user: 'owner' }]))).toEqual([
      'No gh on server-1: agents there can push but cannot open pull requests',
    ])
    expect(row(gitStatus(['bash'], false, []), translator('ru'))).toEqual([
      'На server-1 нет git: агенты там не могут ни коммитить, ни пушить',
    ])
    expect(row(gitStatus(['git', 'gh'], true, [{ host: 'github.com', user: 'owner' }]))).toEqual([])
  })
  test('a node of an older board, this computer: nothing said', () => {
    expect(deviceRows([device('server-1', { status: status('server-1', 1) })], NOW, t)[0]?.git).toEqual([])
    expect(deviceRows([device('local', { status: gitStatus(['bash'], false, []) })], NOW, t)[0]?.git).toEqual([])
  })
})

describe('held entries for offline devices (#695)', () => {
  test('deviceRows and DevicesPanel show held count and entries per device in en and ru, and omit when 0', () => {
    const schedules = [
      { id: 'a1', key: '@server-2:s1', name: 'anna', text: 'check PR', next: NOW - 60_000, why: 'node-offline' },
      { id: 'a2', key: '@server-2:s2', name: 'ben', text: 'deploy', next: NOW - 30_000, why: 'node-offline' },
      { id: 'a3', key: '@server-1:s3', name: 'cleo', text: 'not offline', next: NOW - 10_000, why: 'busy' },
    ]
    const items = [{ key: '@server-2:s1', name: 'Anna live' }] as BoardPayload['items']
    const devs = [device('server-1'), device('server-2', { held: 2 }), device('local')]
    const rowsEn = deviceRows(devs, NOW, t, SETTINGS, schedules, items)
    expect(rowsEn[0]?.held).toBeNull()
    expect(rowsEn[1]?.held).toEqual({
      count: 2,
      label: '2 entries held until it is back',
      entries: [
        { id: 'a1', who: 'Anna live', text: 'check PR' },
        { id: 'a2', who: 'ben', text: 'deploy' },
      ],
    })
    expect(rowsEn[2]?.held).toBeNull()

    const ru = translator('ru')
    const rowsRu = deviceRows([device('server-2', { held: 1 })], NOW, ru, SETTINGS, schedules.slice(0, 1), items)
    expect(rowsRu[0]?.held?.label).toBe('1 запись ждёт возвращения устройства')

    const rendered = renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 900 })}>
        <DevicesPanel open onClose={() => {}} initial={SETTINGS} />
      </PanelProvider>,
      board({ data: payload({ devices: devs, categories: CATEGORIES, schedules, items }), now: NOW }),
    )
    const row2 = rowsOf(rendered)[1]
    if (!row2) throw new Error('missing row')
    const rowText = text([row2])
    expect(rowText).toContain('2 entries held until it is back')
    expect(rowText).toContain('Anna live')
    expect(rowText).toContain('check PR')
    expect(rowText).toContain('ben')
    expect(rowText).toContain('deploy')
  })
})

describe('rename a device (#601)', () => {
  const ru = translator('ru')

  test('deviceTitleEdited, rawTitle/defaultTitle, and title refusals', () => {
    expect(deviceTitleEdited('server-1', '', 'Atlas Box')).toBe('Atlas Box')
    expect(deviceTitleEdited('server-1', 'Atlas Box', '  Atlas Box  ')).toBeNull()
    expect(deviceTitleEdited('server-1', 'Atlas Box', '   ')).toBe('')
    expect(deviceTitleEdited('server-1', 'Atlas Box', 'server-1')).toBe('')
    expect(deviceTitleEdited('server-1', '', 'server-1')).toBeNull()
    expect(deviceTitleEdited('local', '', 'Work Laptop', 'server-2')).toBe('Work Laptop')
    expect(deviceTitleEdited('local', 'Work Laptop', '', 'server-2')).toBe('')
    expect(deviceTitleEdited('local', 'Work Laptop', 'server-2', 'server-2')).toBe('')
    expect(deviceTitleEdited('local', '', 'server-2', 'server-2')).toBeNull()
    expect(deviceTitleEdited('local', '', '', 'server-2')).toBeNull()
    expect(deviceTitleEdited('laptop', 'Work Laptop', 'Local')).toBe('')
    expect(deviceTitleEdited('laptop', '', 'LOCAL')).toBeNull()

    const rows = deviceRows(
      [
        device('server-1', { title: 'Server 1' }),
        device('laptop', { title: 'Local' }),
        device('local', { title: 'LOCAL', selfId: 'server-2' }),
      ],
      NOW,
      t,
    )
    expect(rows[0]).toMatchObject({ title: 'Server 1', rawTitle: 'Server 1', defaultTitle: 'server-1' })
    expect(rows[1]).toMatchObject({ title: 'laptop', rawTitle: '', defaultTitle: 'laptop' })
    expect(rows[2]).toMatchObject({ title: 'server-2', rawTitle: '', defaultTitle: 'server-2' })

    expect(refusedText(400, 'title', t)).toBe('Not saved: Name does not check out')
    expect(refusedText(400, 'title', ru)).toBe('Не сохранено: Название не подходит')
    expect(refusedText(400, 'color', t)).toBe('Not saved: Color does not check out')
    expect(refusedText(400, 'color', ru)).toBe('Не сохранено: Цвет не подходит')
  })

  describe('interactive inline rename in DevicesPanel', () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/',
    })
    const g = globalThis as Record<string, unknown>
    const DOM_KEYS = [
      'window',
      'document',
      'navigator',
      'HTMLElement',
      'Element',
      'Node',
      'Event',
      'MouseEvent',
      'KeyboardEvent',
      'FocusEvent',
      'HTMLInputElement',
      'MutationObserver',
      'getComputedStyle',
      'devicePixelRatio',
      'ResizeObserver',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'addEventListener',
      'removeEventListener',
      'matchMedia',
    ] as const
    const saved = new Map<string, PropertyDescriptor | undefined>()
    let createRoot: typeof import('react-dom/client').createRoot

    beforeAll(async () => {
      const win = dom.window as unknown as Record<string, unknown>
      for (const k of [...DOM_KEYS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
      for (const k of DOM_KEYS) {
        if (k in win) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
      }
      g.IS_REACT_ACT_ENVIRONMENT = true
      Object.defineProperty(g, 'devicePixelRatio', { value: 1, configurable: true, writable: true })
      Object.defineProperty(g, 'ResizeObserver', {
        value: class {
          observe() {}
          disconnect() {}
        },
        configurable: true,
      })
      Object.defineProperty(g, 'requestAnimationFrame', { value: () => 0, configurable: true })
      Object.defineProperty(g, 'cancelAnimationFrame', { value: () => {}, configurable: true })
      Object.defineProperty(g, 'addEventListener', {
        value: dom.window.addEventListener.bind(dom.window),
        configurable: true,
      })
      Object.defineProperty(g, 'removeEventListener', {
        value: dom.window.removeEventListener.bind(dom.window),
        configurable: true,
      })
      Object.defineProperty(g, 'matchMedia', {
        value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        configurable: true,
      })
      ;({ createRoot } = await import('react-dom/client'))
    })

    afterAll(() => {
      restoreFetch()
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(g, k, d)
        else delete g[k]
      }
    })

    const setVal = (input: HTMLInputElement, val: string) => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(input, val)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }

    test('click to rename node and local, clear back to default, Escape cancels, refusal reverts', async () => {
      const calls = answers(
        [200, { settings: SETTINGS }], // initial mount GET /api/nodes
        [200, { ok: true, settings: SETTINGS }],
        [200, { ok: true, settings: SETTINGS }],
        [200, { ok: true, settings: SETTINGS }],
        [400, { error: 'title' }],
        [200, { settings: SETTINGS }], // refresh() after 400
      )
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)
      const closed: number[] = []
      const localToasts: [string, boolean | undefined][] = []
      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContext.Provider
              value={board({
                data: full(),
                now: NOW,
                toast: (msg, bad) => void localToasts.push([msg, bad]),
              })}
            >
              <PanelProvider viewport={() => VP}>
                <DevicesPanel
                  open
                  onClose={() => closed.push(1)}
                  initial={SETTINGS}
                  nsSessions={{ entries: [], notify: {} }}
                />
              </PanelProvider>
            </BoardContext.Provider>
          </I18nProvider>,
        )
      })

      // 1. Click node title -> input opens with current title -> Enter saves.
      const row = (id: string) => host.querySelector(`[data-id="${id}"]`) as HTMLElement
      await act(async () => {
        row('server-1')
          .querySelector('button.devices-title')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      let input = row('server-1').querySelector('input.devices-title-input') as HTMLInputElement
      expect(input).toBeTruthy()
      expect(input.value).toBe('Server 1')
      await act(async () => {
        setVal(input, 'Atlas Box')
      })
      await act(async () => {
        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(row('server-1').querySelector('button.devices-title')?.textContent).toBe('Atlas Box')
      expect(dom.window.document.activeElement).toBe(row('server-1').querySelector('button.devices-title'))

      // 2. Click local title -> input opens empty with placeholder "laptop" -> blur saves.
      await act(async () => {
        row('local')
          .querySelector('button.devices-title')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      input = row('local').querySelector('input.devices-title-input') as HTMLInputElement
      expect(input.value).toBe('')
      expect(input.placeholder).toBe('laptop')
      await act(async () => {
        setVal(input, 'Work Laptop')
      })
      await act(async () => {
        input.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))
      })
      expect(row('local').querySelector('button.devices-title')?.textContent).toBe('Work Laptop')

      // 3. Clearing title sends '' and reverts display to default.
      await act(async () => {
        row('server-1')
          .querySelector('button.devices-title')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      input = row('server-1').querySelector('input.devices-title-input') as HTMLInputElement
      await act(async () => {
        setVal(input, '')
      })
      await act(async () => {
        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(row('server-1').querySelector('button.devices-title')?.textContent).toBe('server-1')

      // 4. Escape cancels without posting or closing the panel.
      await act(async () => {
        row('server-2')
          .querySelector('button.devices-title')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      input = row('server-2').querySelector('input.devices-title-input') as HTMLInputElement
      await act(async () => {
        setVal(input, 'Temp Name')
      })
      await act(async () => {
        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(row('server-2').querySelector('button.devices-title')?.textContent).toBe('server-2')
      expect(dom.window.document.activeElement).toBe(row('server-2').querySelector('button.devices-title'))
      expect(closed).toEqual([])

      // 5. Server refusal (400 { error: 'title' }) shows toast and reverts display.
      await act(async () => {
        row('server-2')
          .querySelector('button.devices-title')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      input = row('server-2').querySelector('input.devices-title-input') as HTMLInputElement
      await act(async () => {
        setVal(input, 'Bad\u0007Name')
      })
      await act(async () => {
        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      await act(async () => {
        await settled()
      })
      expect(posted(calls)).toEqual([
        { op: 'set', id: 'server-1', title: 'Atlas Box' },
        { op: 'set', id: 'local', title: 'Work Laptop' },
        { op: 'set', id: 'server-1', title: '' },
        { op: 'set', id: 'server-2', title: 'Bad\u0007Name' },
      ])
      expect(localToasts).toEqual([['Not saved: Name does not check out', true]])
      expect(row('server-2').querySelector('button.devices-title')?.textContent).toBe('server-2')

      await act(async () => root.unmount())
      host.remove()
    })

    test('disabled when canEdit is false: title button is disabled and does not enter edit mode', async () => {
      answers([200, { settings: SETTINGS }])
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)
      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContext.Provider value={board({ data: full(), canEdit: false, now: NOW })}>
              <PanelProvider viewport={() => VP}>
                <DevicesPanel open onClose={() => {}} initial={SETTINGS} nsSessions={{ entries: [], notify: {} }} />
              </PanelProvider>
            </BoardContext.Provider>
          </I18nProvider>,
        )
      })
      const btn = host.querySelector('[data-id="server-1"] button.devices-title') as HTMLButtonElement
      expect(btn.disabled).toBe(true)
      await act(async () => {
        btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(host.querySelector('input.devices-title-input')).toBeNull()
      await act(async () => root.unmount())
      host.remove()
    })

    test('pending title is cleared once payload updates and does not resurrect after an external revert', async () => {
      answers([200, { settings: SETTINGS }], [200, { ok: true, settings: SETTINGS }], [200, { settings: SETTINGS }])
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)
      const renderWith = async (devices: BoardDevice[]) => {
        await act(async () => {
          root.render(
            <I18nProvider lang="en">
              <BoardContext.Provider value={board({ data: payload({ devices, categories: CATEGORIES }), now: NOW })}>
                <PanelProvider viewport={() => VP}>
                  <DevicesPanel open onClose={() => {}} initial={SETTINGS} nsSessions={{ entries: [], notify: {} }} />
                </PanelProvider>
              </BoardContext.Provider>
            </I18nProvider>,
          )
        })
      }
      await renderWith([device('server-1', { title: 'Server 1' }), device('local')])
      const btn = () => host.querySelector('[data-id="server-1"] button.devices-title')
      await act(async () => {
        btn()?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const input = host.querySelector('[data-id="server-1"] input.devices-title-input') as HTMLInputElement
      await act(async () => {
        setVal(input, 'Atlas Box')
      })
      await act(async () => {
        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(btn()?.textContent).toBe('Atlas Box')
      // Payload catches up with the rename, then externally reverts to "Server 1".
      await renderWith([device('server-1', { title: 'Atlas Box' }), device('local')])
      expect(btn()?.textContent).toBe('Atlas Box')
      await renderWith([device('server-1', { title: 'Server 1' }), device('local')])
      expect(btn()?.textContent).toBe('Server 1')

      await act(async () => root.unmount())
      host.remove()
    })

    test('each device row shows its colour legend swatch, opens the palette, and saves a picked colour (#758)', async () => {
      const calls = answers([200, { settings: SETTINGS }], [200, { ok: true, settings: SETTINGS }])
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)
      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContext.Provider value={board({ data: full(), now: NOW })}>
              <PanelProvider viewport={() => VP}>
                <DevicesPanel open onClose={() => {}} initial={SETTINGS} nsSessions={{ entries: [], notify: {} }} />
              </PanelProvider>
            </BoardContext.Provider>
          </I18nProvider>,
        )
      })
      const colorBtns = host.querySelectorAll('.devices-color')
      expect(colorBtns).toHaveLength(4)
      expect(host.querySelector('.devices-palette')).toBeNull()

      await act(async () => {
        colorBtns[0]?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      const palette = host.querySelector('.devices-palette')
      expect(palette).not.toBeNull()
      // The swatches and, first, Automatic (#789).
      expect(host.querySelectorAll('.devices-sw')).toHaveLength(DEVICE_COLORS.length + 1)

      await act(async () => {
        host
          .querySelector('.devices-sw[data-color="rose"]')
          ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(host.querySelector('.devices-palette')).toBeNull()
      expect(posted(calls)).toEqual([{ op: 'set', id: 'server-1', color: 'rose' }])

      await act(async () => root.unmount())
      host.remove()
    })

    test('Automatic gives the colour back to the board: the key goes (#789)', async () => {
      const calls = answers([200, { settings: SETTINGS }], [200, { ok: true, settings: SETTINGS }])
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)
      const devices = [device('server-1', { title: 'Server 1', color: 'rose' }), device('local')]
      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContext.Provider value={board({ data: payload({ devices, categories: CATEGORIES }), now: NOW })}>
              <PanelProvider viewport={() => VP}>
                <DevicesPanel open onClose={() => {}} initial={SETTINGS} nsSessions={{ entries: [], notify: {} }} />
              </PanelProvider>
            </BoardContext.Provider>
          </I18nProvider>,
        )
      })
      const open = async (id: string) =>
        act(async () => {
          host
            .querySelector(`[data-id="${id}"] .devices-color`)
            ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
      await open('server-1')
      const auto = () => host.querySelector('.devices-sw[data-color="auto"]')
      expect(auto()?.getAttribute('aria-label')).toBe('Automatic')
      expect(auto()?.getAttribute('aria-pressed')).toBe('false')
      expect(host.querySelector('.devices-sw[data-color="rose"]')?.getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        auto()?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(posted(calls)).toEqual([{ op: 'set', id: 'server-1', color: null }])
      // Shown as automatic at once, before the payload brings it.
      await open('server-1')
      expect(auto()?.getAttribute('aria-pressed')).toBe('true')
      expect(host.querySelector('.devices-sw[data-color="rose"]')?.getAttribute('aria-pressed')).toBe('false')
      // A device on its automatic colour: Automatic is the pressed one, and picking it again sends nothing.
      await open('local')
      expect(auto()?.getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        auto()?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      expect(posted(calls)).toHaveLength(1)

      await act(async () => root.unmount())
      host.remove()
    })

    test('the machine marker: a pick goes to the board whole and shows at once in the preview and the legend (#789)', async () => {
      const ok: [number, unknown] = [200, { ok: true, settings: SETTINGS }]
      const calls = answers([200, { settings: SETTINGS }], ok, ok, ok)
      const host = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(host)
      const root = createRoot(host)
      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContext.Provider value={board({ data: full(), now: NOW })}>
              <PanelProvider viewport={() => VP}>
                <DevicesPanel open onClose={() => {}} initial={SETTINGS} nsSessions={{ entries: [], notify: {} }} />
              </PanelProvider>
            </BoardContext.Provider>
          </I18nProvider>,
        )
      })
      const groups = () => [...host.querySelectorAll('.devices-marker .set-seg')]
      const press = async (group: number, label: string) =>
        act(async () => {
          ;[...(groups()[group]?.querySelectorAll('button') ?? [])]
            .find(b => b.textContent === label || b.getAttribute('aria-label') === label)
            ?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
      expect(groups()).toHaveLength(3)
      expect(host.querySelector('.devices-marker-preview .card-device-corner')?.getAttribute('class')).toBe(
        'card-device-corner',
      )
      await press(0, 'Stripe')
      expect(posted(calls)).toEqual([{ op: 'marker', marker: { style: 'stripe', position: 'left', size: 'medium' } }])
      expect(host.querySelector('.devices-marker-preview .card-device-stripe')?.getAttribute('class')).toBe(
        'card-device-stripe at-left',
      )
      expect(host.querySelector('[data-id="server-1"] .devices-color')?.getAttribute('class')).toBe(
        'devices-color mark-stripe at-left',
      )
      await press(2, 'Large')
      expect(posted(calls).at(-1)).toEqual({
        op: 'marker',
        marker: { style: 'stripe', position: 'left', size: 'large' },
      })
      // Off: no place, no size, no marker in the preview, the legend a plain dot.
      await press(0, 'Off')
      expect(groups()).toHaveLength(1)
      expect(host.querySelector('.devices-marker-preview [class*="card-device"]')).toBeNull()
      expect(host.querySelector('[data-id="server-1"] .devices-color')?.getAttribute('class')).toBe('devices-color')
      expect(posted(calls)).toHaveLength(3)

      await act(async () => root.unmount())
      host.remove()
    })
  })
})

describe("a node's own page (#786): its master's devices, relayed", () => {
  test('Add a server and Add a computer are offered (they go to the master); Move master role is not', () => {
    const relayed = draw(
      payload({
        devices: DEVICES,
        categories: CATEGORIES,
        machine: 'server-1',
        relayedDevices: { master: 'server-2' },
      }),
    )
    const words = text(relayed)
    expect(words).toContain(t('node.add.title'))
    expect(words).not.toContain(t('node.handover.title'))
    expect(words).not.toContain(t('node.add.onNode'))
    expect(rowsOf(relayed)).toHaveLength(DEVICES.length)
    // This computer's row says so; the master's row is the master.
    const roleOf = (id: string) =>
      text(
        findAll(
          rowsOf(relayed).filter(r => r.attrs.get('data-id') === id),
          el => hasClass(el, 'devices-role'),
        ),
      )
    expect(roleOf('local')).toBe(t('node.dev.here'))
    expect(roleOf('server-2')).toBe(t('node.dev.master'))
    expect(roleOf('server-1')).toBe('')
  })

  test("a master's own page is as before: Move master role is there", () => {
    expect(text(draw(full()))).toContain(t('node.handover.title'))
  })
})

describe('the machine marker on cards, in Settings, Devices (#789)', () => {
  const section = (nodes: Node[]) => findAll(nodes, el => hasClass(el, 'devices-marker'))
  const legend = (nodes: Node[], id: string) =>
    findAll(
      rowsOf(nodes).filter(r => r.attrs.get('data-id') === id),
      el => hasClass(el, 'devices-color'),
    )[0]?.attrs.get('class')

  test('a board without remote devices shows no marker setting', () => {
    expect(section(draw(payload({ categories: CATEGORIES })))).toEqual([])
    expect(section(draw(payload({ devices: [device('local')], categories: CATEGORIES })))).toEqual([])
    // Nor a node that is no master (its devices are added on the master).
    expect(section(draw(payload({ categories: CATEGORIES, machine: 'server-1' })))).toEqual([])
  })

  test('with remote devices: today’s corner picked, the corner places as glyphs with their words, the legend in kind', () => {
    const page = draw(full())
    const [own] = section(page)
    expect(own).toBeDefined()
    const words = text(own ? [own] : [])
    expect(words).toContain(t('node.marker.title'))
    const pressed = findAll(own ? [own] : [], el => el.tag === 'button' && el.attrs.get('aria-pressed') === 'true')
    expect(pressed.map(b => b.attrs.get('aria-label') ?? text(b.children))).toEqual([
      'Corner',
      'Bottom right',
      'Medium',
    ])
    const places = findAll(own ? [own] : [], el => el.tag === 'button' && !!el.attrs.get('aria-label'))
    expect(places.map(b => text(b.children))).toEqual(['◤', '◥', '◣', '◢'])
    expect(legend(page, 'server-1')).toBe('devices-color mark-corner at-bottom-right')
    // The preview draws the card's own element, in a remote device's colour.
    const [mark] = findAll(own ? [own] : [], el => hasClass(el, 'card-device-corner'))
    expect(mark?.attrs.get('class')).toBe('card-device-corner')
    expect(mark?.attrs.get('aria-hidden')).toBe('true')
  })

  test('the board’s marker as the payload has it: the stripe’s sides in words, off a plain dot', () => {
    const stripe = draw(
      payload({
        devices: DEVICES,
        categories: CATEGORIES,
        deviceMarker: { style: 'stripe', position: 'right', size: 'small' },
      }),
    )
    const [own] = section(stripe)
    const pressed = findAll(own ? [own] : [], el => el.tag === 'button' && el.attrs.get('aria-pressed') === 'true')
    expect(pressed.map(b => text(b.children))).toEqual(['Stripe', 'Right', 'Small'])
    expect(legend(stripe, 'server-1')).toBe('devices-color mark-stripe at-right')
    const off = draw(
      payload({
        devices: DEVICES,
        categories: CATEGORIES,
        deviceMarker: { style: 'off', position: 'bottom-right', size: 'medium' },
      }),
    )
    expect(findAll(section(off), el => hasClass(el, 'set-seg'))).toHaveLength(1)
    expect(legend(off, 'server-1')).toBe('devices-color')
  })
})
