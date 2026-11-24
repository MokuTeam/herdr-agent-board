import { afterEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { BoardDevice } from '../../src/core/payload.ts'
import { DevicesPanel } from '../../web/src/components/devices/DevicesPanel.tsx'
import { MasterHandover } from '../../web/src/components/devices/MasterHandover.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { findAll, type Node } from './support/markup.ts'

const NOW = Date.now()
const VP = { w: 1600, h: 900 }
const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')

const DEVICES: BoardDevice[] = [
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
  {
    id: 'server-1',
    title: 'Atlas',
    kind: 'ssh',
    link: { state: 'online', since: NOW, heardAt: NOW },
    status: null,
    sameCommit: true,
    payloadAt: NOW,
    paused: false,
    drain: false,
    maxSessions: null,
    minFreeMemMb: null,
    maxLoad: null,
  },
]

const PLAN = {
  ok: true,
  from: 'laptop',
  to: 'server-1',
  targetTitle: 'Atlas',
  commit: 'abc12345',
  checks: [
    { id: 'online', ok: true, detail: 'server-1 is online', blocking: true },
    { id: 'backup', ok: true, detail: 'folder /bak', blocking: true },
  ],
  items: [{ category: 'db', files: 1, bytes: 4096 }],
  totalFiles: 1,
  totalBytes: 4096,
  requiredFreeMb: 64,
  targetFreeMb: 2048,
  errors: [],
  warnings: [],
}

describe('web/MasterHandover (#697)', () => {
  afterEach(restoreFetch)

  test('closed by default inside DevicesPanel, makes zero handover fetches on mount, and hidden without nodes', () => {
    const calls = answers()
    const nodes = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <DevicesPanel open={true} onClose={() => {}} />
      </PanelProvider>,
      board({ data: payload({ devices: DEVICES }), canEdit: true, now: NOW }),
    )
    expect(calls).toEqual([])
    const openBtn = findAll(nodes, el => el.tag === 'button' && text([el]) === 'Move master role…')
    expect(openBtn).toHaveLength(1)

    const plainP = payload({})
    delete (plainP as unknown as Record<string, unknown>).devices
    const plainNodes = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <DevicesPanel open={true} onClose={() => {}} />
      </PanelProvider>,
      board({ data: plainP, canEdit: true, now: NOW }),
    )
    expect(findAll(plainNodes, el => el.tag === 'button' && text([el]) === 'Move master role…')).toHaveLength(0)
  })

  test('renders preflight check results, verify status, and rollback button from initial view', () => {
    const nodes = renderInBoard(
      <PanelProvider viewport={() => VP}>
        <MasterHandover
          open={true}
          devices={DEVICES}
          initial={{
            phase: 'checked',
            step: null,
            id: 'ho-1',
            target: 'server-1',
            plan: PLAN,
            verify: { ok: true, checks: [{ name: 'nodes', ok: true, detail: '1 node(s) online' }] },
            error: null,
            rolledBack: false,
            canRollback: true,
            rollbackNeedsConfirm: true,
          }}
        />
      </PanelProvider>,
      board({ data: payload({ devices: DEVICES }), canEdit: true, now: NOW }),
    )
    const allText = text(nodes)
    expect(allText).toContain('Preflight checks')
    expect(allText).toContain('server-1 is online')
    expect(allText).toContain('Verification')
    expect(allText).toContain('1 node(s) online')
    const rbButtons = findAll(nodes, el => el.tag === 'button' && text([el]) === 'Rollback handover')
    expect(rbButtons).toHaveLength(1)
  })

  test('post-commit rollback shows inline confirmation before posting discardSinceCommit: true', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/',
    })
    const g = globalThis as Record<string, unknown>
    const win = dom.window as unknown as Record<string, unknown>
    const winKeys = [
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
    ] as const
    const ownKeys = [
      'devicePixelRatio',
      'ResizeObserver',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'IS_REACT_ACT_ENVIRONMENT',
    ] as const
    const saved = new Map<string, PropertyDescriptor | undefined>()
    for (const k of [...winKeys, ...ownKeys]) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
    for (const k of winKeys) {
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
      value: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0),
      configurable: true,
      writable: true,
    })
    Object.defineProperty(g, 'cancelAnimationFrame', {
      value: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      configurable: true,
      writable: true,
    })

    const { createRoot } = await import('react-dom/client')
    const rootEl = dom.window.document.getElementById('root') as HTMLElement
    const root = createRoot(rootEl)
    const calls = answers(
      [
        200,
        {
          ok: true,
          handover: {
            phase: 'done',
            step: null,
            id: 'ho-1',
            target: 'server-1',
            plan: PLAN,
            verify: { ok: true, checks: [{ name: 'nodes', ok: true, detail: '1 node(s) online' }] },
            error: null,
            rolledBack: false,
            canRollback: true,
            rollbackNeedsConfirm: true,
          },
        },
      ],
      [
        200,
        {
          ok: true,
          handover: {
            phase: 'idle',
            step: null,
            id: 'ho-1',
            target: 'server-1',
            plan: null,
            verify: null,
            error: null,
            rolledBack: true,
            canRollback: false,
            rollbackNeedsConfirm: false,
          },
        },
      ],
    )

    try {
      await act(async () => {
        root.render(
          <I18nProvider lang="en">
            <BoardContext.Provider value={board({ data: payload({ devices: DEVICES }), canEdit: true, now: NOW })}>
              <PanelProvider viewport={() => VP}>
                <MasterHandover
                  open={true}
                  devices={DEVICES}
                  initial={{
                    phase: 'done',
                    step: null,
                    id: 'ho-1',
                    target: 'server-1',
                    plan: PLAN,
                    verify: { ok: true, checks: [{ name: 'nodes', ok: true, detail: '1 node(s) online' }] },
                    error: null,
                    rolledBack: false,
                    canRollback: true,
                    rollbackNeedsConfirm: true,
                  }}
                />
              </PanelProvider>
            </BoardContext.Provider>
          </I18nProvider>,
        )
      })

      const findButton = (label: string) =>
        Array.from(rootEl.querySelectorAll('button')).find(b => b.textContent?.trim() === label)

      const callsAfterMount = calls.length
      const rbBtn = findButton('Rollback handover')
      expect(rbBtn).toBeTruthy()
      await act(async () => {
        rbBtn?.click()
      })
      expect(calls).toHaveLength(callsAfterMount)
      expect(rootEl.textContent).toContain(
        'Rolling back after commit will discard all changes written on this master since the handover.',
      )

      const confirmBtn = findButton('Confirm rollback and discard changes')
      expect(confirmBtn).toBeTruthy()
      await act(async () => {
        confirmBtn?.click()
      })

      const posts = sent(calls.slice(callsAfterMount)).filter(([, method]) => method === 'POST')
      expect(posts).toEqual([['/api/nodes/handover', 'POST', '1', { op: 'rollback', discardSinceCommit: true }]])
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
