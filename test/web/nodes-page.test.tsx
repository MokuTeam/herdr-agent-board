// The devices of a master's board on the page (#502, docs/design/nodes 12): the device chip on a
// card of another device and on its launch card, an offline device's cards greyed with their age and
// their actions answering that it is not reachable, the device switch beside the profile switch, the
// actions a node card does not offer, and the device in the session sheet's head. Rendered fixtures
// with and without `device`; a board without `devices` draws none of it (the parity tests in
// card, toolbar and sheet show it draws as before).
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRef } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardDevice, BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import type { Item, LaunchView } from '../../src/core/types.ts'
import { ApiError, errorText } from '../../web/src/api/client.ts'
import { Card } from '../../web/src/components/Card.tsx'
import { DeviceSwitch } from '../../web/src/components/devices/DeviceSwitch.tsx'
import { LaunchCard } from '../../web/src/components/launch/LaunchCard.tsx'
import { SheetHead } from '../../web/src/components/sheet/SheetHead.tsx'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import { useBoardView } from '../../web/src/hooks/useBoardView.ts'
import {
  deviceOptions,
  deviceShowing,
  deviceShown,
  knowDevices,
  nodeLook,
  pickedDevice,
  placingText,
} from '../../web/src/models/devices.ts'
import { placeholderOf } from '../../web/src/models/launch.ts'
import { cardMenu, launchMenu, type MenuEntry } from '../../web/src/models/menu-model.ts'
import { headButtons, sheetAvailability } from '../../web/src/models/sheet.ts'
import { filterCount, filterText } from '../../web/src/models/toolbar-collapse.ts'
import type { BoardUi } from '../../web/src/state/board-ui.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { findAll, hasClass, type Node, serializeNodes } from './support/markup.ts'
import { drawSheet } from './support/sheet-scene.tsx'
import { selectorsOf } from './support/stylesheets.ts'

const NOW = Date.now()
const MIN = 60_000
const t = translator('en')

/** A device as the master's payload has it: this computer (`local`, no link) or a node online. */
function device(id: string, title: string, fields: Partial<BoardDevice> = {}): BoardDevice {
  const local = id === 'local'
  return {
    id,
    title,
    kind: local ? null : 'ssh',
    link: local ? null : { state: 'online', since: NOW - 3_600_000, heardAt: NOW - MIN },
    status: null,
    sameCommit: local ? null : true,
    payloadAt: local ? null : NOW - MIN,
    paused: false,
    drain: false,
    maxSessions: local ? null : 3,
    minFreeMemMb: null,
    maxLoad: null,
    ...fields,
  }
}

/** server-1 offline: its link dropped, its last payload 8 minutes old (and a half, not to straddle a minute). */
const offline = (fields: Partial<BoardDevice> = {}) =>
  device('server-1', 'server-1', {
    link: { state: 'offline', since: NOW - 6 * MIN, heardAt: NOW - 8.5 * MIN },
    payloadAt: NOW - 8.5 * MIN,
    ...fields,
  })

const DEVICES = [device('local', 'laptop'), device('server-1', 'server-1')]
const local = item({ key: 'a', name: 'Alpha', column: 'work', status: 'working' })
const remote = item({ key: '@server-1:b', name: 'Beta', column: 'idle', device: 'server-1', cwd: '/srv/work' })

const html = (nodes: Node[]) => serializeNodes(nodes)
const byClassAll = (nodes: Node[], name: string) => findAll(nodes, el => hasClass(el, name))

function drawCard(it: Item, data: BoardPayload, lang = 'en') {
  return renderInBoard(
    <Card
      item={it}
      selected={false}
      busy={undefined}
      placeholder={false}
      launch={undefined}
      onPointerDown={() => {}}
      onClick={() => {}}
      onKeyDown={() => {}}
    />,
    board({ data }),
    lang,
  )
}

/** The same item as this computer's: without its `device`. */
const ctxless = ({ device: _, ...rest }: Item): Item => rest

const ids = (entries: MenuEntry[]) => entries.flatMap(e => ('id' in e && e.id ? [e.id] : []))

describe('the device chip (#502)', () => {
  test('a card of another device carries the chip with the device’s title in its identity row, under the name row', () => {
    const data = payload({
      items: [local, remote],
      devices: [device('local', 'laptop'), device('server-1', 'Hetzner box')],
    })
    const card = drawCard(remote, data)
    const [row] = byClassAll(card, 'card-ident')
    expect(row).toBeDefined()
    expect(html(row ? [row] : [])).toContain('>Hetzner box<')
    // Not in the name row: the name keeps its room.
    const [top] = byClassAll(card, 'card-top')
    expect(html(top ? [top] : [])).not.toContain('device-chip')
    // Heard: no greying, no age, its tooltip names where it runs.
    expect(html(card)).not.toContain('node-offline')
    expect(html(card)).not.toContain('device-as-of')
    expect(html(card)).toContain('title="Runs on Hetzner box"')
  })

  test('a card of this computer has no chip and no identity row, also on a master’s board', () => {
    const data = payload({ items: [local, remote], devices: DEVICES })
    const card = html(drawCard(local, data))
    expect(card).not.toContain('card-ident')
    expect(card).not.toContain('device-chip')
    expect(card).not.toContain('node-offline')
  })

  test('without devices in the payload (a board without nodes) a card draws none of it', () => {
    const card = html(drawCard(local, payload({ items: [local] })))
    expect(card).not.toContain('card-ident')
    expect(card).not.toContain('device')
    expect(card).toContain('data-act="focus"')
  })

  test('a compact card (asleep in Idle) keeps its one name row and gets the chip in a row of its own', () => {
    const asleep = item({ ...remote, sleeping: true, status: 'sleeping' })
    const card = drawCard(asleep, payload({ items: [asleep], devices: DEVICES }))
    const [article] = findAll(card, el => el.tag === 'article')
    expect(article && hasClass(article, 'compact')).toBe(true)
    const rows = (article?.children ?? []).flatMap(n => (n.kind === 'element' ? [n.attrs.get('class') ?? ''] : []))
    expect(rows.slice(0, 2)).toEqual(['card-top', 'card-ident'])
  })

  test('in Russian: the chip’s tooltip and the age in Russian', () => {
    const data = payload({ lang: 'ru', items: [remote], devices: [device('local', 'ноутбук'), offline()] })
    const card = html(drawCard(remote, data, 'ru'))
    expect(card).toContain('данные 8 мин назад')
    expect(card).toContain('server-1 не на связи')
  })
})

describe('an offline device (#502)', () => {
  test('its cards grey, say how old they are and gray their actions with the device’s name', () => {
    const asks = item({ ...remote, column: 'me', attention: 'ask', status: 'idle' })
    const card = drawCard(asks, payload({ items: [asks], devices: [device('local', 'laptop'), offline()] }))
    const out = html(card)
    const [article] = findAll(card, el => el.tag === 'article')
    expect(article && hasClass(article, 'node-offline')).toBe(true)
    expect(out).toContain('>as of 8 min ago<')
    // Sleep and "no reply needed" answer that the device is not reachable, gray.
    const sleep = findAll(card, el => el.attrs.get('data-act') === 'sleep')[0]
    expect(sleep?.attrs.get('title')).toBe('server-1 is not reachable')
    expect(sleep?.attrs.has('disabled')).toBe(true)
    const dismiss = findAll(card, el => el.attrs.get('data-act') === 'dismiss')[0]
    expect(dismiss?.attrs.get('title')).toBe('server-1 is not reachable')
    expect(dismiss?.attrs.has('disabled')).toBe(true)
  })

  test('the age goes by its last payload, then by the link’s last byte; a node never heard says so', () => {
    expect(nodeLook(remote, [offline()], NOW, t)?.asOf).toBe('as of 8 min ago')
    expect(nodeLook(remote, [offline({ payloadAt: null })], NOW, t)?.asOf).toBe('as of 8 min ago')
    const never = offline({ payloadAt: null, link: { state: 'connecting', since: NOW, heardAt: null } })
    expect(nodeLook(remote, [never], NOW, t)).toEqual({
      id: 'server-1',
      title: 'server-1',
      offline: true,
      asOf: 'nothing heard yet',
      why: 'server-1 is not reachable',
    })
    // A device the payload does not list is not heard either, named by its id.
    expect(nodeLook(remote, [], NOW, t)?.why).toBe('server-1 is not reachable')
    // This computer's card: nothing.
    expect(nodeLook(local, DEVICES, NOW, t)).toBeNull()
  })

  test('a node-offline answer of the server is worded with the device’s title', () => {
    knowDevices([device('server-1', 'Hetzner box')])
    const err = new ApiError(503, { error: 'node-offline', device: 'server-1' })
    expect(errorText(err, t)).toBe('Hetzner box is not reachable')
    expect(errorText(err, translator('ru'))).toBe('Hetzner box не на связи')
    // An answer that names no device says so without a name.
    expect(errorText(new ApiError(503, { error: 'node-offline' }), t)).toBe('The device is not reachable')
    // Any other answer as before.
    expect(errorText(new ApiError(503, { error: 'busy' }), t)).toBe('busy')
    expect(errorText(new ApiError(500, {}), t)).toBe(t('err.status', { code: 500 }))
  })

  test('its card’s menu grays what goes to the device, with the reason', () => {
    const ctx = { t, canMutate: true, canEdit: true, column: 'idle', category: 'other', terminal: true, fork: true }
    const menu = cardMenu(remote, { ...ctx, device: { title: 'server-1', why: 'server-1 is not reachable' } })
    const wake = menu.find(e => 'id' in e && e.id === 'sleep')
    expect(wake && 'reason' in wake ? wake.reason : '').toBe('server-1 is not reachable')
    const rename = menu.find(e => 'id' in e && e.id === 'rename')
    expect(rename && 'disabled' in rename ? rename.disabled : false).toBe(true)
  })

  test('the session sheet of an offline device says why, its herdr buttons and edits blocked', () => {
    const av = sheetAvailability(
      { canMutate: true, canEdit: true, missing: false, turn: false, unreachable: 'server-1 is not reachable' },
      t,
    )
    expect(av.blocked).toBe(true)
    expect(av.banner).toBe('server-1 is not reachable')
    expect([av.focus, av.sleep, av.edit, av.dismiss]).toEqual([true, true, true, true])
    // Without it, as before.
    const before = sheetAvailability({ canMutate: true, canEdit: true, missing: false, turn: false }, t)
    expect([before.blocked, before.edit, before.dismiss]).toEqual([false, false, false])
  })
})

describe('a node card’s actions (#502)', () => {
  const ctx = {
    t,
    canMutate: true,
    canEdit: true,
    column: 'idle',
    category: 'other',
    terminal: true,
    fork: true,
    mokupilot: true,
  }
  const claude = { ...remote, agent: 'claude' }

  test('not offered: open in the file manager, Go to herdr; a MokuPilot call, terminal, fork, archive and the rest stay', () => {
    const node = ids(cardMenu(claude, { ...ctx, device: { title: 'server-1', why: '' } }))
    const here = ids(cardMenu(item({ ...ctxless(claude) }), ctx))
    expect(here).toEqual(expect.arrayContaining(['focus', 'reveal', 'mokupilot']))
    expect(node).not.toContain('focus')
    expect(node).not.toContain('reveal')
    expect(node).toContain('mokupilot')
    expect(node).toEqual(expect.arrayContaining(['open', 'terminal', 'fork', 'archive', 'rename', 'write', 'sleep']))
    expect(here.filter(id => !['focus', 'reveal'].includes(id))).toEqual(node)
  })

  test('the card has no Go to herdr button; a card of this computer keeps it', () => {
    const data = payload({ items: [local, remote], devices: DEVICES })
    expect(html(drawCard(remote, data))).not.toContain('data-act="focus"')
    expect(html(drawCard(local, data))).toContain('data-act="focus"')
  })

  test('the sheet: MokuPilot call stays offered, no Go to herdr for a node’s session', () => {
    expect(headButtons(claude, t, true).mokupilotHidden).toBe(false)
    expect(headButtons(item({ key: 'b', agent: 'claude' }), t, true).mokupilotHidden).toBe(false)
    const sheet = drawSheet({ items: [claude], open: claude.key })
    const body = html(sheet.reactBody)
    expect(body).not.toContain('id="sheet-focus"')
    expect(drawSheet({ items: [local], open: local.key }).reactBody.length).toBeGreaterThan(0)
    expect(html(drawSheet({ items: [local], open: local.key }).reactBody)).toContain('id="sheet-focus"')
  })

  test('a launch placed on a node: no Go to herdr in its menu or on its card', () => {
    const l = launch({ device: 'server-1', pane: 'p1', state: 'waiting' })
    expect(ids(launchMenu(l, { t, canMutate: true, canEdit: true }))).not.toContain('focus')
    expect(ids(launchMenu(launch({ pane: 'p1', state: 'waiting' }), { t, canMutate: true, canEdit: true }))).toContain(
      'focus',
    )
  })
})

describe('the session sheet’s head (#502)', () => {
  test('names the device first on its line, with the age while offline; none for this computer’s', () => {
    const data = payload({
      items: [remote, local],
      devices: [device('local', 'laptop'), offline({ title: 'Hetzner box' })],
    })
    const head = html(renderInBoard(<SheetHead item={remote} missing={false} />, board({ data })))
    expect(head).toContain('class="sheet-device"')
    expect(head).toContain('>Hetzner box<')
    expect(head).toContain('>as of 8 min ago<')
    const mine = html(renderInBoard(<SheetHead item={local} missing={false} />, board({ data })))
    expect(mine).not.toContain('sheet-device')
  })
})

// ---------------------------------------------------------------- the launch card

function launch(fields: Partial<LaunchView> = {}): LaunchView {
  return {
    id: 'l1',
    name: 'Gamma',
    cwd: '/srv/work',
    category: 'other',
    workspace: 'ws',
    workspaceId: null,
    state: 'starting',
    step: 'tab',
    error: '',
    kind: '',
    pane: null,
    key: null,
    startedAt: NOW,
    doneAt: null,
    message: '',
    worktree: null,
    newWorkspace: false,
    ...fields,
  }
}

describe('a start placed on a device (#502, design 8.3)', () => {
  const look = (devices?: BoardDevice[]) => ({
    t,
    launcher: 'Claude',
    pressed: () => false,
    ...(devices && { devices, now: NOW }),
  })

  test('its launch card shows the device’s chip; one of this computer none', () => {
    const on = html(renderInBoard(<LaunchCard launch={launch({ device: 'server-1' })} look={look(DEVICES)} />, board()))
    expect(on).toContain('class="card-ident"')
    expect(on).toContain('>server-1<')
    const here = html(renderInBoard(<LaunchCard launch={launch()} look={look(DEVICES)} />, board()))
    expect(here).not.toContain('card-ident')
  })

  test('the placer’s words, from the payload’s fields; nothing for values not sent yet', () => {
    const d = [device('local', 'laptop'), device('server-1', 'server-1', { status: statusWith(3) })]
    // Read as strings: the placer (T8) adds these values to the types.
    const as = (state: string, step: string, more: Partial<LaunchView> = {}) =>
      launch({ state, step, ...more } as unknown as Partial<LaunchView>)
    expect(placingText(as('queued', 'prepare', { device: 'server-1' }), d, t)).toBe(
      'Waiting for room: server-1 has 3 of 3 sessions',
    )
    expect(placingText(as('queued', 'prepare'), d, t)).toBe('Waiting for room')
    expect(placingText(as('starting', 'placing'), d, t)).toBe('Choosing a device…')
    expect(placingText(as('starting', 'syncing', { place: { device: 'server-1' } }), d, t)).toBe(
      'Syncing the profile to server-1…',
    )
    expect(placingText(as('starting', 'cloning', { place: { device: 'server-1' } }), d, t)).toBe('Cloning on server-1…')
    // Starting on a device it chose: the step's own words (models/launch.ts stepText).
    expect(placingText(as('starting', 'placing', { place: { device: 'server-1' } }), d, t)).toBeNull()
    // Today's steps say what they said.
    expect(placingText(launch({ device: 'server-1' }), d, t)).toBeNull()
    expect(
      html(renderInBoard(<LaunchCard launch={launch({ device: 'server-1' })} look={look(d)} />, board())),
    ).toContain('>Opening a tab…<')
  })
})

function statusWith(awake: number): BoardDevice['status'] {
  return {
    api: 1,
    id: 'server-1',
    version: 'v1',
    commit: 'c',
    platform: 'linux',
    arch: 'x64',
    cpus: 4,
    memTotalMb: 8000,
    memAvailableMb: 4000,
    load: null,
    sessions: { awake, working: 0, asleep: 0 },
    launches: 0,
    workRootFreeMb: null,
    profiles: [],
    agents: ['claude'],
    at: NOW,
  }
}

// ---------------------------------------------------------------- the device switch

function drawToolbar(data: BoardPayload, ui: Partial<BoardUi> = {}) {
  return renderInBoard(<Toolbar limitsAnchor={createRef<HTMLButtonElement>()} />, board({ data, ui }))
}

describe('the device switch (#502)', () => {
  test('beside the profile switch, only while the payload has more than one device', () => {
    const two = html(drawToolbar(payload({ items: [local, remote], devices: DEVICES })))
    expect(two).toContain('id="devices"')
    expect(two).toContain('>All devices<')
    expect(two).toMatch(/data-id="local"[^>]*>laptop<span class="n">1</)
    expect(two).toMatch(/data-id="server-1"[^>]*>server-1<span class="n">1</)
    // One device, or none (a board without nodes): no switch.
    expect(html(drawToolbar(payload({ items: [local], devices: [device('local', 'laptop')] })))).not.toContain(
      'id="devices"',
    )
    expect(html(drawToolbar(payload({ items: [local] })))).not.toContain('id="devices"')
  })

  test('the filters say how many pickers they hold, the device switch counted (#599: a phone lays them two to a line)', () => {
    const picks = (data: BoardPayload) => /data-picks="(\d)"/.exec(html(drawToolbar(data)))?.[1]
    const profile = (id: string, title: string): BoardProfile => ({
      id,
      title,
      color: '#888888',
      colorName: 'gray',
      dir: id,
      hidden: false,
      inherited: false,
      exists: true,
      hooks: true,
      sessions: 0,
      limits: null,
    })
    const both = [profile('default', 'Private'), profile('work', 'Work')]
    expect(picks(payload({ items: [local] }))).toBe('1')
    expect(picks(payload({ items: [local, remote], devices: DEVICES }))).toBe('2')
    expect(picks(payload({ items: [local, remote], devices: DEVICES, profiles: both }))).toBe('3')
  })

  test('a device picked shows its cards alone; one gone from the payload shows every card', () => {
    function Keys() {
      return (
        <i>
          {useBoardView()
            .visible.map(i => i.key)
            .join(',')}
        </i>
      )
    }
    const data = payload({ items: [local, remote], devices: DEVICES })
    const shown = (ui: Partial<BoardUi>, d = data) => html(renderInBoard(<Keys />, board({ data: d, ui })))
    expect(shown({})).toBe('<i>a,@server-1:b</i>')
    expect(shown({ device: 'server-1' })).toBe('<i>@server-1:b</i>')
    expect(shown({ device: 'local' })).toBe('<i>a</i>')
    expect(shown({ device: 'gone' })).toBe('<i>a,@server-1:b</i>')
    // A board without nodes: a pick left over reads as all.
    expect(shown({ device: 'server-1' }, payload({ items: [local] }))).toBe('<i>a</i>')
    // A start on its way to server-1 (#502): its placeholder card carries the device, so the switch finds it.
    const l = launch({ device: 'server-1' })
    expect(placeholderOf(l).device).toBe('server-1')
    expect(placeholderOf(launch())).not.toHaveProperty('device')
    expect(shown({ device: 'server-1' }, payload({ items: [local, remote], launches: [l], devices: DEVICES }))).toBe(
      '<i>@server-1:b,launch:l1</i>',
    )
    const picked = html(drawToolbar(data, { device: 'server-1' }))
    expect(picked).toMatch(/aria-selected="true"[^>]*data-id="server-1"|data-id="server-1"[^>]*aria-selected="true"/)
  })

  test('folded into its pill where the row has no room, named by the device on show', () => {
    const pill = html(
      renderInBoard(
        <DeviceSwitch
          options={deviceOptions(DEVICES, [local, remote], t) ?? []}
          picked="server-1"
          onPick={() => {}}
          folded
        />,
        board(),
      ),
    )
    expect(pill).toContain('id="devices-pick"')
    expect(pill).toContain('aria-label="Device: server-1"')
    expect(pill).toMatch(/<div[^>]*id="devices"[^>]*hidden/)
  })

  test('the folded filters’ button counts and names the device picked; without one, as before', () => {
    expect(filterCount({ lanes: [], profile: null, query: '' })).toBe(0)
    expect(filterCount({ lanes: [], profile: null, query: '', device: 'server-1' })).toBe(1)
    expect(filterText({ lanes: ['Alpha'], profile: 'Work', query: 'x', device: 'server-1' })).toBe(
      'Alpha · Work · server-1 · “x”',
    )
    expect(filterText({ lanes: ['Alpha'], profile: 'Work', query: 'x' })).toBe('Alpha · Work · “x”')
  })

  test('a session started on another device than the one picked brings every device back; none picked, nothing changes', () => {
    expect(deviceShowing('server-1', DEVICES, launch())).toBe('all')
    expect(deviceShowing('server-1', DEVICES, launch({ device: 'server-1' }))).toBeNull()
    expect(deviceShowing('local', DEVICES, launch())).toBeNull()
    expect(deviceShowing('all', DEVICES, launch({ device: 'server-1' }))).toBeNull()
    expect(deviceShowing('server-1', undefined, launch())).toBeNull()
  })

  test('its pure parts', () => {
    expect(deviceShown('all', local, DEVICES)).toBe(true)
    expect(deviceShown('local', local, DEVICES)).toBe(true)
    expect(deviceShown('local', remote, DEVICES)).toBe(false)
    expect(deviceShown('server-1', remote, DEVICES)).toBe(true)
    expect(deviceShown('server-1', local, DEVICES)).toBe(false)
    expect(pickedDevice('server-1', DEVICES)).toBe('server-1')
    expect(pickedDevice('server-1', [device('server-1', 's')])).toBe('all')
    expect(pickedDevice('server-1', undefined)).toBe('all')
    expect(deviceOptions(undefined, [local], t)).toBeNull()
    expect(deviceOptions(DEVICES, [local, remote], t)?.map(o => [o.id, o.n])).toEqual([
      ['all', 2],
      ['local', 1],
      ['server-1', 1],
    ])
  })
})

// ---------------------------------------------------------------- nodes.css, and the phone's width

describe('nodes.css (#502)', () => {
  const css = readFileSync(join(import.meta.dir, '..', '..', 'web', 'styles', 'nodes.css'), 'utf8')
  const OWN = [
    '.card-ident',
    '.device-chip',
    '.device-dot',
    '.device-title',
    '.device-as-of',
    '.node-offline',
    '.sheet-device',
    // Settings, Devices (#510).
    '.devices-',
  ]
  const body = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`)
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
  }

  test('every rule selects by a class of its own: a board without devices draws as before', () => {
    const selectors = selectorsOf(css)
    expect(selectors.length).toBeGreaterThan(0)
    for (const s of selectors) expect(OWN.some(own => s.includes(own))).toBe(true)
    // Nothing of the name row's.
    for (const s of selectors) expect(/\.card-top|\.name\b/.test(s)).toBe(false)
  })

  test('at a phone’s width the chip keeps its own row and gives way inside it, never taking the name’s room', () => {
    // No rule of a narrow screen moves the row: it is a line of its own at every width.
    expect(css).not.toMatch(/@media[^{]*max-width/)
    expect(body('.card-ident')).toContain('display: flex;')
    expect(body('.card-ident')).toContain('min-width: 0;')
    // A long title is cut inside the chip, the chip inside the row.
    expect(body('.device-chip')).toContain('flex: 0 1 auto;')
    expect(body('.device-chip')).toContain('min-width: 0;')
    expect(body('.device-chip')).toContain('max-width: 100%;')
    expect(body('.device-title')).toContain('text-overflow: ellipsis;')
    // The greying leaves the card's buttons their own showing on hover (app.css: opacity 0 until hovered).
    expect(css).toContain('.card.node-offline > :not(.card-ident):not(.card-actions) {')
    expect(body('.card.node-offline > .card-actions')).not.toContain('opacity')
    // The age beside it keeps its words whole.
    expect(body('.device-as-of')).toContain('flex: none;')
  })

  test('the page links it after the sheets it may build on', () => {
    const page = readFileSync(join(import.meta.dir, '..', '..', 'web', 'index.html'), 'utf8')
    expect(page.indexOf('styles/nodes.css')).toBeGreaterThan(page.indexOf('styles/cards.css'))
    expect(page.indexOf('styles/nodes.css')).toBeLessThan(page.indexOf('styles/look-terminal.css'))
  })
})
