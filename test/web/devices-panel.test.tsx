// Settings, Devices (#510, components/devices/DevicesPanel.tsx, docs/design/nodes 12): the devices
// in order with their link in words, bars, version and bundles, Pause, Drain and the thresholds;
// the lanes that may leave this computer and When everything is full. Rendered from fixtures (one
// device online, one not reachable, one refused for its version, this computer) at a desktop's and a
// phone's width. Without `devices` in the payload (a board without `nodes`) the panel holds Add a
// server alone (#509, test/web/add-server.test.tsx).
import { afterEach, describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardDevice, BoardPayload } from '../../src/core/payload.ts'
import { DevicesPanel } from '../../web/src/components/devices/DevicesPanel.tsx'
import { offersDevices } from '../../web/src/hooks/useSettingsMenu.ts'
import {
  deviceOptions,
  deviceRows,
  deviceTitle,
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
import type { Board } from '../../web/src/state/BoardProvider.tsx'
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
      expect(here).toContain('This computer')
      expect(here).toContain('3 of 20 sessions')
      // Pause and Give it the secrets on every device but this computer; Drain on all four.
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
        ],
        [
          ['paused', 'true'],
          ['drain', 'false'],
          ['giveSecrets', 'true'],
        ],
        [
          ['paused', 'false'],
          ['drain', 'false'],
          ['giveSecrets', 'true'],
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
        'Move This computer',
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

  test('Devices… on the local page, a board without nodes too (it adds its first server there, #509); never on a remote page', () => {
    expect(offersDevices(false)).toBe(true)
    expect(offersDevices(true)).toBe(false)
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

  test('this computer is "This computer" in the switch and the panel, never its id; a title of its own stays', () => {
    const devices = [device('local'), device('server-1', { title: 'Server 1' })]
    expect(deviceOptions(devices, [], t)?.map(o => o.title)).toEqual(['All devices', 'This computer', 'Server 1'])
    expect(deviceOptions(devices, [], ru)?.map(o => o.title)).toEqual(['Все устройства', 'Этот компьютер', 'Server 1'])
    const nodes = draw(payload({ devices, categories: CATEGORIES }))
    const here = rowsOf(nodes).find(r => r.attrs.get('data-id') === 'local')
    const name = findAll([here as Node], el => hasClass(el, 'devices-name'))[0]
    expect(text([name as Node])).toBe('This computer')
    expect(findAll([here as Node], el => hasClass(el, 'devices-link'))).toEqual([])
    const ruNodes = renderInBoard(
      <PanelProvider viewport={() => ({ w: 1600, h: 900 })}>
        <DevicesPanel open onClose={() => {}} initial={SETTINGS} />
      </PanelProvider>,
      board({ data: payload({ devices, categories: CATEGORIES }), now: NOW }),
      'ru',
    )
    const ruHere = rowsOf(ruNodes).find(r => r.attrs.get('data-id') === 'local')
    expect(text(findAll([ruHere as Node], el => hasClass(el, 'devices-name')))).toBe('Этот компьютер')
    // An owner who named it keeps the name.
    expect(deviceTitle({ id: 'local', title: 'Workstation', kind: null }, t)).toBe('Workstation')
    expect(deviceTitle({ id: 'server-1', title: 'server-1', kind: 'ssh' }, t)).toBe('server-1')
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
      text: 'The update failed: it runs Windows, where the board does not update itself: update it by hand',
      offer: false,
    })
    expect(failed('no-checkout')?.offer).toBe(false)
    expect(failed('teapot')?.text).toBe('The update failed: the device said teapot')
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
      ['The update failed: it runs Windows, where the board does not update itself: update it by hand'],
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
