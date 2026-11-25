// Settings, Devices, "Add a computer" (#513, components/devices/AddComputer.tsx):
// renders collapsed without fetching, displays pasted command, found device + fingerprint + Approve,
// expired state, done state, and Russian strings.
import { afterEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import { COMPUTER_IDLE_VIEW, type ComputerSetupView } from '../../src/core/node-computer-setup.ts'
import type { BoardDevice } from '../../src/core/payload.ts'
import { DevicesPanel } from '../../web/src/components/devices/DevicesPanel.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { validateComputerStart } from '../../web/src/models/computer-setup.ts'
import type { PanelSettings } from '../../web/src/models/devices.ts'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { FakeWorld } from './support/fake-dom.ts'
import { answers, restoreFetch } from './support/fetch-answers.ts'
import { byId, type Node, serializeNodes } from './support/markup.ts'
import { first } from './support/react-commit.ts'
import { type Host, hostElements, listenLikeReact } from './support/react-events.ts'

const NOW = Date.now()
const VP = { w: 1600, h: 900 }
const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')

const draw = (computerSetup?: ComputerSetupView, lang: 'en' | 'ru' = 'en') =>
  renderInBoard(
    <PanelProvider viewport={() => VP}>
      <DevicesPanel open onClose={() => {}} {...(computerSetup && { computerSetup })} />
    </PanelProvider>,
    board({ data: payload({}), now: NOW }),
    lang,
  )

describe('Add a computer UI (#513)', () => {
  afterEach(restoreFetch)

  test('asks nothing while collapsed and sends start / approve on interaction', async () => {
    const calls = answers()
    let hosts: Host[] = []
    const view: ComputerSetupView = {
      ...COMPUTER_IDLE_VIEW,
      phase: 'found',
      command: 'echo ABC | base64 -d | gunzip | sh',
      socket: 'anna-mac-123',
      found: {
        id: 'anna-mac',
        host: 'anna-mbp',
        platform: 'darwin',
        version: '0.1.0',
        fingerprint: 'ab'.repeat(32),
      },
    }
    function Probe() {
      hosts = hostElements(<DevicesPanel open onClose={() => {}} computerSetup={view} />)
      return null
    }
    renderInBoard(
      <PanelProvider viewport={() => VP}>
        <Probe />
      </PanelProvider>,
      board({ data: payload({}), now: NOW }),
    )
    const world = new FakeWorld({ viewport: VP })
    const el = world.mount(
      first(
        renderInBoard(
          <PanelProvider viewport={() => VP}>
            <DevicesPanel open onClose={() => {}} computerSetup={view} />
          </PanelProvider>,
          board({ data: payload({}), now: NOW }),
        ),
      ),
    )
    listenLikeReact(
      world.wrap(world.body),
      () => el,
      () => hosts,
    )
    expect(calls).toEqual([])
    const approveBtn = el.querySelector('.devices-computer-found .button.primary')
    if (!approveBtn) throw new Error('missing Approve button')
    await world.fire(approveBtn, 'click')
    await new Promise(r => setTimeout(r, 0))
    const posts = calls.filter(c => c.init?.method === 'POST').map(c => JSON.parse(String(c.init?.body)))
    expect(posts).toEqual([{ op: 'approve', id: 'anna-mac' }])
  })

  test('renders waiting, found, expired, done, and Russian views', () => {
    const waiting = text([
      byId(
        draw({ ...COMPUTER_IDLE_VIEW, phase: 'waiting', command: 'echo XYZ | base64 -d | gunzip | sh' }),
        'devices-sheet',
      ),
    ])
    expect(waiting).toContain('echo XYZ | base64 -d | gunzip | sh')
    expect(waiting).toContain('Waiting for the computer to dial the relay')

    const found = text([
      byId(
        draw({
          ...COMPUTER_IDLE_VIEW,
          phase: 'found',
          command: 'echo XYZ | base64 -d | gunzip | sh',
          found: {
            id: 'anna-mac',
            host: 'anna-mbp',
            platform: 'darwin',
            version: '0.1.0',
            fingerprint: 'cd'.repeat(32),
          },
        }),
        'devices-sheet',
      ),
    ])
    expect(found).toContain('anna-mac (anna-mbp, darwin) answered on the relay.')
    expect(found).toContain('Approve')
    expect(serializeNodes(draw({ ...COMPUTER_IDLE_VIEW, phase: 'expired' }))).toContain('Create command')
    expect(
      text([byId(draw({ ...COMPUTER_IDLE_VIEW, phase: 'done', device: { id: 'anna-mac' } }), 'devices-sheet')]),
    ).toContain('anna-mac is now a node of this board.')
    expect(
      text([
        byId(
          draw({
            ...COMPUTER_IDLE_VIEW,
            phase: 'waiting',
            command: 'echo XYZ | base64 -d | gunzip | sh',
            next: { key: 'node.computer.hint.claimed' },
          }),
          'devices-sheet',
        ),
      ]),
    ).toContain('board node forget')
    expect(text([byId(draw(COMPUTER_IDLE_VIEW, 'ru'), 'devices-sheet')])).toContain('Добавить компьютер')
    expect(text([byId(draw(COMPUTER_IDLE_VIEW, 'en'), 'devices-sheet')])).toContain('For Linux and macOS only')
    expect(text([byId(draw(COMPUTER_IDLE_VIEW, 'ru'), 'devices-sheet')])).toContain('Только для Linux и macOS')
  })

  test('validates door port and device id before Create command without sending a request (#740)', async () => {
    expect(validateComputerStart({ id: '', port: '' })).toBeNull()
    expect(validateComputerStart({ id: 'anna-mac', port: '12430' })).toBeNull()
    expect(validateComputerStart({ id: 'ben-box', port: '65535' })).toBeNull()
    expect(validateComputerStart({ id: 'local', port: '' })).toEqual({
      key: 'node.setup.refuse.id',
      params: { id: 'local' },
    })
    expect(validateComputerStart({ id: 'Bad_Id', port: '' })).toEqual({
      key: 'node.setup.refuse.id',
      params: { id: 'Bad_Id' },
    })
    expect(validateComputerStart({ id: 'atlas', port: '' }, ['atlas'])).toEqual({
      key: 'node.setup.refuse.idTaken',
      params: { id: 'atlas' },
    })
    for (const badPort of ['0', '80', '1023', '65536', '99999', 'abc', '12.5']) {
      expect(validateComputerStart({ id: '', port: badPort })).toEqual({ key: 'node.setup.err.port' })
    }
    expect(validateComputerStart({ id: '', port: '12422' })).toEqual({
      key: 'node.computer.err.portReserved',
      params: { port: '12422' },
    })

    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/',
    })
    const g = globalThis as Record<string, unknown>
    const win = dom.window as unknown as Record<string, unknown>
    const keys = [
      'window',
      'document',
      'navigator',
      'HTMLElement',
      'HTMLInputElement',
      'Element',
      'Node',
      'Event',
      'MouseEvent',
      'MutationObserver',
      'getComputedStyle',
      'addEventListener',
      'removeEventListener',
      'devicePixelRatio',
      'ResizeObserver',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'IS_REACT_ACT_ENVIRONMENT',
    ] as const
    const saved = new Map<string, PropertyDescriptor | undefined>()
    for (const k of keys) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
    for (const k of keys) {
      if (k in win) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
    }
    g.IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(g, 'devicePixelRatio', { value: 1, configurable: true, writable: true })
    Object.defineProperty(g, 'ResizeObserver', {
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      configurable: true,
      writable: true,
    })
    Object.defineProperty(g, 'requestAnimationFrame', {
      value: () => 0,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(g, 'cancelAnimationFrame', {
      value: () => {},
      configurable: true,
      writable: true,
    })

    const { createRoot } = await import('react-dom/client')
    const rootEl = dom.window.document.getElementById('root') as HTMLElement
    const root = createRoot(rootEl)
    const calls = answers()
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
    try {
      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContext.Provider value={board({ data: payload({}), now: NOW })}>
              <PanelProvider viewport={() => VP}>
                <DevicesPanel open onClose={() => {}} computerSetup={COMPUTER_IDLE_VIEW} />
              </PanelProvider>
            </BoardContext.Provider>
          </I18nProvider>,
        )
      })
      const portInput = rootEl.querySelector('input[name="computer-port"]') as HTMLInputElement
      await act(async () => {
        setter?.call(portInput, '70000')
        portInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      const startBtn = rootEl.querySelector('.devices-computer .button.primary') as HTMLButtonElement
      await act(async () => {
        startBtn.click()
      })
      expect(calls.filter(c => c.init?.method === 'POST')).toEqual([])
      const alert = rootEl.querySelector('.devices-computer [role="alert"]')
      expect(alert?.textContent).toContain('1024 to 65535')
    } finally {
      await act(async () => {
        root.unmount()
      })
      for (const [k, desc] of saved) {
        if (desc) Object.defineProperty(g, k, desc)
        else delete g[k]
      }
      dom.window.close()
    }
  })

  test('when nodes.relay is missing on master, explains relay comes with a server master and omits config.json or wizard button (#740)', async () => {
    const devices: BoardDevice[] = [
      {
        id: 'local',
        title: 'This computer',
        kind: null,
        link: null,
        status: null,
        sameCommit: null,
        payloadAt: null,
        paused: false,
        drain: false,
        maxSessions: null,
        minFreeMemMb: null,
        maxLoad: null,
      },
    ]
    const settingsNoRelay: PanelSettings = {
      whenFull: 'local',
      lanes: [],
      seen: null,
      defaults: {},
      next: null,
      noToken: [],
    }
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/',
    })
    const g = globalThis as Record<string, unknown>
    const win = dom.window as unknown as Record<string, unknown>
    const keys = [
      'window',
      'document',
      'navigator',
      'HTMLElement',
      'HTMLInputElement',
      'Element',
      'Node',
      'Event',
      'MouseEvent',
      'MutationObserver',
      'getComputedStyle',
      'addEventListener',
      'removeEventListener',
      'devicePixelRatio',
      'ResizeObserver',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'IS_REACT_ACT_ENVIRONMENT',
    ] as const
    const saved = new Map<string, PropertyDescriptor | undefined>()
    for (const k of keys) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
    for (const k of keys) {
      if (k in win) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
    }
    g.IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(g, 'devicePixelRatio', { value: 1, configurable: true, writable: true })
    Object.defineProperty(g, 'ResizeObserver', {
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      configurable: true,
      writable: true,
    })
    Object.defineProperty(g, 'requestAnimationFrame', {
      value: () => 0,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(g, 'cancelAnimationFrame', {
      value: () => {},
      configurable: true,
      writable: true,
    })

    const { createRoot } = await import('react-dom/client')
    const rootEl = dom.window.document.getElementById('root') as HTMLElement
    const root = createRoot(rootEl)
    try {
      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContext.Provider value={board({ data: payload({ devices }), now: NOW })}>
              <PanelProvider viewport={() => VP}>
                <DevicesPanel open onClose={() => {}} initial={settingsNoRelay} computerSetup={COMPUTER_IDLE_VIEW} />
              </PanelProvider>
            </BoardContext.Provider>
          </I18nProvider>,
        )
      })
      const computerSec = rootEl.querySelector('.devices-computer')
      expect(computerSec?.textContent).not.toContain('config.json')
      expect(computerSec?.textContent).not.toContain('Set up relay server')
      expect(computerSec?.textContent).toContain('move the master role to a Linux server')
      expect(rootEl.querySelector('.devices-relay')).toBeNull()
    } finally {
      await act(async () => {
        root.unmount()
      })
      for (const [k, desc] of saved) {
        if (desc) Object.defineProperty(g, k, desc)
        else delete g[k]
      }
      dom.window.close()
    }
  })
})
