// Settings → Sleep and wake… (components/wake/WakePanel.tsx), drawn only while the payload carries
// wake's state line: the switch, the state line and the buttons its state offers, the hooks a
// shown profile lacks, the reaper and Telegram as GET /api/wake has them; on a phone the state line
// only, read only. What its controls do goes to POST /api/wake (hooks/useWake.ts wakeActions); the
// toolbar's quiet "Wake stopped" note opens it; the Profiles panel's Install says when it left
// wake's hooks out beside the old plugin's.
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import type { ReactElement } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardPayload, BoardProfile } from '../../src/core/payload.ts'
import type { WakeSettingsView, WakeView } from '../../src/core/wake/view.ts'
import { timeOf } from '../../src/core/when-format.ts'
import { ProfilesPanel } from '../../web/src/components/profiles/ProfilesPanel.tsx'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import { WakeNote } from '../../web/src/components/wake/WakeNote.tsx'
import { WakeBody, WakePanel } from '../../web/src/components/wake/WakePanel.tsx'
import { type WakeActions, wakeActions } from '../../web/src/hooks/useWake.ts'
import type { Board } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { byId, canonical, type Element, find, findAll, hasClass, type Node } from './support/markup.ts'
import { first } from './support/react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './support/react-events.ts'

const VP = { w: 1600, h: 1000 }
const NOW = Date.now()
const SINCE = NOW - 3_600_000

const RUNNING: WakeView = { on: true, state: 'running', since: SINCE, asleep: 4, port: 12421, downSince: null }
const CRASHED: WakeView = {
  on: true,
  state: 'crashed',
  since: null,
  asleep: 2,
  port: 12421,
  crashes: 5,
  error: 'EADDRINUSE: address already in use\n  at listen',
  downSince: NOW - 120_000,
}
const SETTINGS: WakeSettingsView = {
  reaper: { enabled: true, idleMinutes: 60, exclude: ['build', 'Проект x 50%'], maxPerRound: 3 },
  telegram: 'auto',
  found: { host: '127.0.0.1:8787' },
  lastError: null,
  log: 'C:\\Users\\Иван Петров\\AppData\\Local\\herdr\\plugins\\agent-board\\wake.log',
  hooks: [
    { id: 'default', title: 'Private', state: 'in' },
    { id: 'work', title: 'Работа 100%', state: 'missing' },
    { id: 'old', title: 'Old', state: 'old' },
  ],
}

const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const texts = (els: Element[]): string[] => els.map(textOf)

/** The panel as drawn for a payload's wake (none: not in the payload). */
function panelNodes(wake: WakeView | undefined, lang = 'en'): Node[] {
  return renderInBoard(
    <PanelProvider viewport={() => VP}>
      <WakePanel open={false} onClose={() => {}} />
    </PanelProvider>,
    board({ data: payload({ lang: lang === 'ru' ? 'ru' : 'en', ...(wake && { wake }) }) }),
    lang,
  )
}

/** Records what the panel's controls ask for. */
function recorder(): { act: WakeActions; asked: unknown[][] } {
  const asked: unknown[][] = []
  const rec =
    (name: string) =>
    async (...args: unknown[]) => {
      asked.push([name, ...args])
      return true
    }
  return {
    asked,
    act: {
      turn: rec('turn'),
      reaper: rec('reaper'),
      telegram: rec('telegram'),
      start: rec('start'),
      again: rec('again'),
      log: rec('log'),
      install: rec('install'),
    },
  }
}

/** The panel's body as drawn for a view and settings. */
function bodyOf(
  fields: { view?: WakeView; settings?: WakeSettingsView | null; log?: string | null; phone?: boolean },
  lang = 'en',
): Element {
  const { act } = recorder()
  const nodes = renderInBoard(
    <WakeBody
      view={fields.view ?? RUNNING}
      settings={fields.settings ?? null}
      log={fields.log ?? null}
      phone={fields.phone ?? false}
      canEdit
      now={NOW}
      act={act}
    />,
    board(),
    lang,
  )
  return first(nodes)
}

const buttonsIn = (el: Element): string[] => texts(findAll([el], n => n.tag === 'button' && hasClass(n, 'button')))
const switchesIn = (el: Element) =>
  findAll([el], n => n.attrs.get('role') === 'switch').map(s => [
    s.attrs.get('aria-label'),
    s.attrs.get('aria-checked'),
  ])

describe('the panel as drawn', () => {
  test('nothing while the payload has no wake (wake off, nothing asleep in its file)', () => {
    expect(panelNodes(undefined)).toEqual([])
  })

  test('its title, the switch, the state line; running offers no button', () => {
    const panel = byId(panelNodes(RUNNING), 'wake-sheet')
    expect(panel.attrs.get('aria-label')).toBe('Sleep and wake')
    expect(textOf(find([panel], el => el.tag === 'h2'))).toBe('Sleep and wake')
    expect(switchesIn(panel)).toEqual([['Sleep and wake', 'true']])
    expect(textOf(find([panel], el => hasClass(el, 'wake-state')))).toBe(
      `Running since ${timeOf(SINCE, translator('en'))}, 4 asleep`,
    )
    expect(buttonsIn(panel)).toEqual([])
    // In Russian.
    const ru = byId(panelNodes(RUNNING, 'ru'), 'wake-sheet')
    expect(textOf(find([ru], el => el.tag === 'h2'))).toBe('Сон и пробуждение')
    expect(textOf(find([ru], el => hasClass(el, 'wake-state')))).toBe(
      `Работает с ${timeOf(SINCE, translator('ru'))}, 4 спят`,
    )
  })

  test('off: the switch off and the sessions still asleep; not running: Start', () => {
    const off = byId(panelNodes({ ...RUNNING, on: false, state: 'off', since: null, asleep: 3 }), 'wake-sheet')
    expect(switchesIn(off)).toEqual([['Sleep and wake', 'false']])
    expect(textOf(find([off], el => hasClass(el, 'wake-state')))).toBe('Off. 3 asleep still wake from their cards')
    expect(buttonsIn(off)).toEqual([])
    const down = byId(panelNodes({ ...RUNNING, state: 'notRunning', since: null }), 'wake-sheet')
    expect(buttonsIn(down)).toEqual(['Start'])
  })

  test('crashed: Start again and Log; the log’s text once asked for', () => {
    const crashed = byId(panelNodes(CRASHED), 'wake-sheet')
    expect(textOf(find([crashed], el => hasClass(el, 'wake-state')))).toBe(
      'Crashed: stopped after 5 crashes in 10 minutes. EADDRINUSE: address already in use',
    )
    expect(buttonsIn(crashed)).toEqual(['Start again', 'Log'])
    expect(findAll([crashed], el => hasClass(el, 'wake-log'))).toEqual([])
    const log = '[09:12] wake listens on 127.0.0.1:12421\n[09:14] crashed: EADDRINUSE'
    const body = bodyOf({ view: CRASHED, log })
    const pre = find([body], el => hasClass(el, 'wake-log'))
    expect(pre.tag).toBe('pre')
    expect(textOf(pre)).toBe(log)
    expect(buttonsIn(bodyOf({ view: CRASHED }, 'ru'))).toEqual(['Запустить заново', 'Журнал'])
  })

  test('the reaper and Telegram as the board has them', () => {
    const body = bodyOf({ settings: SETTINGS })
    expect(switchesIn(body)).toEqual([
      ['Sleep and wake', 'true'],
      ['Put idle sessions to sleep', 'true'],
    ])
    expect(textOf(find([body], el => hasClass(el, 'wake-reaper-after')))).toBe('after 60 minutes')
    const minutes = find([body], el => hasClass(el, 'wake-minutes'))
    expect([minutes.tag, minutes.attrs.get('value'), minutes.attrs.get('aria-label')]).toEqual([
      'input',
      '60',
      'Minutes idle',
    ])
    const exclude = find([body], el => hasClass(el, 'wake-exclude'))
    expect([exclude.tag, textOf(exclude), exclude.attrs.get('placeholder')]).toEqual([
      'textarea',
      'build\nПроект x 50%',
      'Names, workspaces or /regex/, one per line',
    ])
    const seg = find([body], el => hasClass(el, 'wake-telegram-mode'))
    expect(findAll([seg], el => el.tag === 'button').map(b => [textOf(b), b.attrs.get('aria-pressed')])).toEqual([
      ['Auto', 'true'],
      ['Off', 'false'],
    ])
    expect(textOf(find([body], el => hasClass(el, 'wake-telegram-line')))).toBe('connected to 127.0.0.1:8787')
    // The reaper off: no "after".
    const off = bodyOf({ settings: { ...SETTINGS, reaper: { ...SETTINGS.reaper, enabled: false } } })
    expect(findAll([off], el => hasClass(el, 'wake-reaper-after'))).toEqual([])
  })

  test('a shown profile without wake’s hooks offers Install; one with the old plugin’s says so', () => {
    const notes = (body: Element) =>
      findAll([body], el => hasClass(el, 'wake-hooks')).map(note => ({
        id: note.attrs.get('data-id'),
        text: textOf(find([note], el => el.tag === 'p')),
        buttons: texts(findAll([note], el => el.tag === 'button')),
      }))
    expect(notes(bodyOf({ settings: SETTINGS }))).toEqual([
      {
        id: 'work',
        text: 'Sleep and wake’s hooks are not in Работа 100%’s settings.json: its sessions do not see sleeping sessions, and a message to one does not wake it',
        buttons: ['Install'],
      },
      {
        id: 'old',
        text: 'Old’s settings.json has the separate herdr-wake plugin’s hooks: its sessions ask that plugin, not the board’s wake',
        buttons: [],
      },
    ])
    expect(notes(bodyOf({ settings: SETTINGS }, 'ru'))[0]?.buttons).toEqual(['Установить'])
    // Held or off: none.
    expect(notes(bodyOf({ view: { ...RUNNING, state: 'held', since: null }, settings: SETTINGS }))).toEqual([])
    expect(notes(bodyOf({ view: { ...RUNNING, on: false, state: 'off', since: null }, settings: SETTINGS }))).toEqual(
      [],
    )
  })

  test('on a phone: the state line and that it is changed on the computer only; no switch, no button', () => {
    const body = bodyOf({ view: CRASHED, settings: SETTINGS, phone: true })
    expect(switchesIn(body)).toEqual([])
    expect(findAll([body], el => el.tag === 'button' || el.tag === 'input' || el.tag === 'textarea')).toEqual([])
    expect(textOf(find([body], el => hasClass(el, 'wake-state')))).toBe(
      'Crashed: stopped after 5 crashes in 10 minutes. EADDRINUSE: address already in use',
    )
    expect(textOf(find([body], el => hasClass(el, 'wake-read-only')))).toBe('Changed on the computer only')
    expect(textOf(find([bodyOf({ phone: true }, 'ru')], el => hasClass(el, 'wake-read-only')))).toBe(
      'Меняется только на компьютере',
    )
  })

  test('a board that cannot edit (no connection): every control greyed', () => {
    const { act } = recorder()
    const body = first(
      renderInBoard(
        <WakeBody view={CRASHED} settings={SETTINGS} log={null} phone={false} canEdit={false} now={NOW} act={act} />,
        board(),
      ),
    )
    const controls = findAll([body], el => el.tag === 'button' || el.tag === 'input' || el.tag === 'textarea')
    expect(controls.length).toBeGreaterThan(5)
    expect(controls.every(el => el.attrs.has('disabled'))).toBe(true)
  })
})

// ---------------------------------------------------------------- live, with React's handlers

/** `node` live in a fake DOM with React's handlers on it (as test/web/profiles-panel.test.tsx). */
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

type Call = { url: string; init: RequestInit | undefined }
let restore: (() => void) | undefined
afterEach(() => {
  restore?.()
  restore = undefined
})

/** The server's answers to the page's fetches, in turn; the calls kept. */
function answers(...replies: [number, unknown][]): Call[] {
  const calls: Call[] = []
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const [status, body] = replies.shift() ?? [200, { ok: true }]
    return new Response(JSON.stringify(body), { status })
  }
  const spy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(fake, { preconnect: fetch.preconnect }))
  restore = () => spy.mockRestore()
  return calls
}

/** What went to the board: the path, the method, its header and the body. */
const sent = (calls: Call[]) =>
  calls.map(c => [
    c.url,
    c.init?.method,
    (c.init?.headers as Record<string, string> | undefined)?.['x-board'],
    JSON.parse(String(c.init?.body)),
  ])

test('the panel’s switch goes to the board: off, and on again', async () => {
  const calls = answers([200, { ok: true }], [200, { ok: true }])
  const on = live(<WakePanel open={false} onClose={() => {}} />, board({ data: payload({ wake: RUNNING }) }))
  await on.world.fire(on.pick('[data-switch="wake"]'), 'click')
  const off = live(
    <WakePanel open={false} onClose={() => {}} />,
    board({ data: payload({ wake: { ...RUNNING, on: false, state: 'off', since: null } }) }),
  )
  await off.world.fire(off.pick('[data-switch="wake"]'), 'click')
  for (let i = 0; i < 4; i++) await off.world.flush()
  expect(sent(calls)).toEqual([
    ['/api/wake', 'POST', '1', { op: 'off' }],
    ['/api/wake', 'POST', '1', { op: 'on' }],
  ])
})

test('the panel’s controls ask for what they say', async () => {
  const { act, asked } = recorder()
  const side = live(
    <WakeBody view={CRASHED} settings={SETTINGS} log={null} phone={false} canEdit now={NOW} act={act} />,
    board(),
  )
  const [again, log] = side.el.querySelectorAll('.wake-actions button')
  if (!again || !log) throw new Error('no Start again and Log')
  await side.world.fire(again, 'click')
  await side.world.fire(log, 'click')
  await side.world.fire(side.pick('[data-switch="reaper"]'), 'click')
  // The minutes when the field is left, Enter leaving it; the same number sends nothing.
  const minutes = side.pick('.wake-minutes')
  minutes.focus()
  minutes.value = ' 45 '
  await side.world.fire(minutes, 'keydown', { key: 'Enter' })
  await side.world.fire(minutes, 'focusout')
  minutes.value = '60'
  await side.world.fire(minutes, 'focusout')
  // The names when the field is left.
  const exclude = side.pick('.wake-exclude')
  exclude.value = 'build\n/^tmp/\n'
  await side.world.fire(exclude, 'focusout')
  // Telegram: the one pressed sends nothing.
  const [auto, off] = side.el.querySelectorAll('.wake-telegram-mode button')
  if (!auto || !off) throw new Error('no Auto and Off')
  await side.world.fire(auto, 'click')
  await side.world.fire(off, 'click')
  // Install for the profile without wake's hooks.
  await side.world.fire(side.pick('.wake-hooks[data-id="work"] button'), 'click')
  expect(asked).toEqual([
    ['again'],
    ['log'],
    ['reaper', { enabled: false }],
    ['reaper', { idleMinutes: 45 }],
    ['reaper', { exclude: ['build', '/^tmp/'] }],
    ['telegram', 'off'],
    ['install', 'work'],
  ])
})

describe('what the actions send, and what comes of the answers', () => {
  function deps(...replies: [number, Record<string, unknown>][]) {
    const posts: unknown[][] = []
    const toasts: [string, boolean][] = []
    const pending: unknown[] = []
    const logs: string[] = []
    let reloads = 0
    const act = wakeActions({
      post: async (path, body) => {
        posts.push([path, body])
        const [status, reply] = replies.shift() ?? [200, { ok: true }]
        if (status !== 200 || reply.ok === false) {
          const { ApiError } = await import('../../web/src/api/client.ts')
          throw new ApiError(status, reply)
        }
        return reply
      },
      t: () => translator('en'),
      canEdit: () => true,
      toast: (text, error = false) => void toasts.push([text, error]),
      sent: p => void pending.push(p),
      reload: () => void reloads++,
      showLog: text => void logs.push(text),
    })
    return { act, posts, toasts, pending, logs, reloads: () => reloads }
  }

  test('the switches: sent, held as sent until the board says the same, a refusal toasted', async () => {
    const d = deps(
      [200, { ok: true }],
      [200, { ok: true }],
      [200, { ok: true }],
      [409, { ok: false, error: 'Minutes idle: a whole number of minutes, 1 or more' }],
    )
    expect(await d.act.turn(false)).toBe(true)
    expect(await d.act.reaper({ enabled: true })).toBe(true)
    expect(await d.act.telegram('auto')).toBe(true)
    expect(await d.act.reaper({ idleMinutes: 'soon' })).toBe(false)
    expect(d.posts).toEqual([
      ['/api/wake', { op: 'off' }],
      ['/api/wake', { op: 'reaper', enabled: true }],
      ['/api/wake', { op: 'telegram', mode: 'auto' }],
      ['/api/wake', { op: 'reaper', idleMinutes: 'soon' }],
    ])
    expect(d.pending).toEqual([{ on: false }, { reaper: { enabled: true } }, { telegram: 'auto' }])
    expect(d.toasts).toEqual([['Minutes idle: a whole number of minutes, 1 or more', true]])
  })

  test('Start, Start again and Log; Install into a profile reads the hooks again', async () => {
    const d = deps(
      [200, { ok: true }],
      [409, { ok: false, error: 'Sleep and wake is off (Settings → Sleep and wake…)' }],
      [200, { ok: true, text: 'line 1\nline 2' }],
      [200, { ok: true }],
    )
    await d.act.start()
    await d.act.again()
    await d.act.log()
    await d.act.install('work')
    expect(d.posts).toEqual([
      ['/api/wake', { op: 'start' }],
      ['/api/wake', { op: 'again' }],
      ['/api/wake', { op: 'log' }],
      ['/api/profiles', { op: 'install', id: 'work' }],
    ])
    expect(d.toasts).toEqual([['Sleep and wake is off (Settings → Sleep and wake…)', true]])
    expect(d.logs).toEqual(['line 1\nline 2'])
    expect(d.reloads()).toBe(1)
  })

  test('without the board: nothing is sent, the toast says why', async () => {
    const posts: unknown[] = []
    const toasts: string[] = []
    const act = wakeActions({
      post: async (...args) => {
        posts.push(args)
        return { ok: true }
      },
      t: () => translator('en'),
      canEdit: () => false,
      toast: text => void toasts.push(text),
      sent: () => {},
      reload: () => {},
      showLog: () => {},
    })
    expect(await act.turn(true)).toBe(false)
    expect(posts).toEqual([])
    expect(toasts).toEqual([translator('en')('live.off')])
  })
})

// ---------------------------------------------------------------- the toolbar's note

describe('the toolbar’s quiet note', () => {
  const toolbarOf = (data: BoardPayload, onWake?: () => void) =>
    renderInBoard(
      <PanelProvider viewport={() => VP}>
        <Toolbar limitsAnchor={{ current: null }} {...(onWake && { onWake })} />
      </PanelProvider>,
      board({ data, now: NOW }),
    )
  const notesIn = (nodes: Node[]) => findAll(nodes, el => el.attrs.get('id') === 'wake-note')

  test('on and not running for more than a minute: "Wake stopped", beside the setup note', () => {
    const nodes = toolbarOf(payload({ wake: CRASHED }), () => {})
    const [note] = notesIn(nodes)
    if (!note) throw new Error('no note')
    expect(textOf(note)).toBe('Wake stopped')
    expect(note.attrs.get('title')).toBe('Sleep and wake is on but not running: open its settings')
    // Drawn as "Setup incomplete" is, right after it.
    expect(note.attrs.get('class')).toBe('setup-note wake-note')
    const controls = find(nodes, el => hasClass(el, 'controls')).children.filter(
      (n): n is Element => n.kind === 'element',
    )
    const at = controls.findIndex(el => el.attrs.get('id') === 'wake-note')
    expect(controls[at - 1]?.attrs.get('id')).toBe('next-attention')
  })

  test('otherwise the toolbar is as it was: running, down less than a minute, off, or no wake at all', () => {
    const without = canonical(toolbarOf(payload(), () => {}))
    for (const wake of [
      RUNNING,
      { ...CRASHED, downSince: NOW - 30_000 },
      { ...RUNNING, on: false, state: 'off' as const, since: null, asleep: 3 },
      { ...RUNNING, state: 'held' as const, since: null, downSince: null },
    ])
      expect([wake.state, canonical(toolbarOf(payload({ wake }), () => {}))]).toEqual([wake.state, without])
    // A page that opens no panel: no note either.
    expect(notesIn(toolbarOf(payload({ wake: CRASHED })))).toEqual([])
  })

  test('the note opens the panel', async () => {
    let opened = 0
    const side = live(<WakeNote onOpen={() => opened++} />, board({ data: payload({ wake: CRASHED }), now: NOW }))
    expect(side.el.getAttribute('id')).toBe('wake-note')
    await side.world.fire(side.el, 'click')
    expect(opened).toBe(1)
  })

  test('on a phone: no note', () => {
    const doc = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { documentElement: { hasAttribute: (name: string) => name === 'data-remote' } },
    })
    try {
      expect(
        renderInBoard(<WakeNote onOpen={() => {}} />, board({ data: payload({ wake: CRASHED }), now: NOW })),
      ).toEqual([])
    } finally {
      if (doc) Object.defineProperty(globalThis, 'document', doc)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  })
})

// ---------------------------------------------------------------- the Profiles panel's Install

test('the Profiles panel’s Install says when it left wake’s hooks out beside the old plugin’s', async () => {
  const profile = (id: string, title: string, hooks: boolean): BoardProfile => ({
    id,
    title,
    color: '#30B0C7',
    colorName: 'teal',
    dir: `C:\\Users\\Иван Петров\\.claude-${id}`,
    hidden: false,
    inherited: false,
    exists: true,
    hooks,
    sessions: 0,
    limits: null,
  })
  const calls = answers([200, { ok: true, wakeHooks: 'old' }], [200, { ok: true }])
  const toasts: [string, boolean][] = []
  const data = payload({ profiles: [profile('default', 'Private', true), profile('work', 'Работа 100%', false)] })
  for (let i = 0; i < 2; i++) {
    const side = live(
      <ProfilesPanel open={false} onClose={() => {}} />,
      board({ data, toast: (text, error = false) => void toasts.push([text, error]) }),
    )
    await side.world.fire(side.pick('.profile-note button'), 'click')
    for (let j = 0; j < 4; j++) await side.world.flush()
  }
  expect(sent(calls).map(c => c[3])).toEqual([
    { op: 'install', id: 'work' },
    { op: 'install', id: 'work' },
  ])
  // Said once, for the answer that left them out; quiet otherwise, as before.
  expect(toasts).toEqual([
    [
      'Sleep and wake’s hooks were not added to Работа 100%: its settings.json has the separate herdr-wake plugin’s hooks',
      false,
    ],
  ])
})
