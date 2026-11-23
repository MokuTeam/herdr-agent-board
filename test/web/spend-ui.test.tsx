import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { missingKeys, translator } from '../../src/core/i18n/translator.ts'
import type { SpendReport } from '../../src/core/spend.ts'
import { isSessionDetail } from '../../web/src/api/client.ts'
import { Card } from '../../web/src/components/Card.tsx'
import { NavRail } from '../../web/src/components/NavRail.tsx'
import { SheetHead } from '../../web/src/components/sheet/SheetHead.tsx'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { byId, findAll } from './support/markup.ts'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
  'getComputedStyle',
  'IS_REACT_ACT_ENVIRONMENT',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'ResizeObserver',
  'matchMedia',
  'devicePixelRatio',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const realFetch = globalThis.fetch
const rafTimers = new Set<ReturnType<typeof setTimeout>>()

let createRoot: typeof import('react-dom/client').createRoot
let SpendPanel: typeof import('../../web/src/components/spend/SpendPanel.tsx').SpendPanel
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let PanelProvider: typeof import('../../web/src/state/PanelProvider.tsx').PanelProvider

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  for (const k of DOM_GLOBALS) {
    saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  }
  for (const k of [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
    'MutationObserver',
    'getComputedStyle',
    'matchMedia',
  ] as const) {
    Object.defineProperty(g, k, { configurable: true, writable: true, value: win[k] })
  }
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.requestAnimationFrame = (f: (now: number) => void) => {
    const id = setTimeout(() => {
      rafTimers.delete(id)
      f(performance.now())
    }, 16)
    rafTimers.add(id)
    return id
  }
  g.cancelAnimationFrame = (id: ReturnType<typeof setTimeout>) => {
    rafTimers.delete(id)
    clearTimeout(id)
  }
  g.devicePixelRatio = 1
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SpendPanel } = await import('../../web/src/components/spend/SpendPanel.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ PanelProvider } = await import('../../web/src/state/PanelProvider.tsx'))
})

afterAll(() => {
  for (const id of rafTimers) clearTimeout(id)
  rafTimers.clear()
  globalThis.fetch = realFetch
  for (const k of DOM_GLOBALS) {
    const desc = saved.get(k)
    if (desc) Object.defineProperty(g, k, desc)
    else delete g[k]
  }
})

let root: Root | null = null
afterEach(() => {
  globalThis.fetch = realFetch
  if (root) {
    act(() => root?.unmount())
    root = null
  }
})

describe('Spend UI and detail', () => {
  test('i18n has no missing Russian keys for spend.*', () => {
    expect(missingKeys('ru')).toEqual([])
    const t = translator('en')
    expect(t('spend.title')).toBe('Token spend')
  })

  test('isSessionDetail accepts legacy detail and detail with spend, rejects malformed spend', () => {
    const base = {
      item: { key: 's1' },
      conversation: [],
      screen: '',
      dialog: null,
      checkout: false,
    }
    expect(isSessionDetail(base)).toBe(true)
    expect(
      isSessionDetail({
        ...base,
        spend: {
          total: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, responses: 1 },
          byDay: { '2026-11-23': { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, responses: 1 } },
        },
      }),
    ).toBe(true)
    expect(isSessionDetail({ ...base, spend: { total: { input: 'bad' }, byDay: {} } })).toBe(false)
  })

  test('SheetHead renders #sheet-spend only when spend > 0; compact Card never shows spend', () => {
    const it = item({ key: 's1', name: 'anna', context: 4000, activity: Date.now() })
    const withoutSpend = renderInBoard(<SheetHead item={it} missing={false} />, board(), 'en')
    expect(findAll(withoutSpend, n => n.attrs.get('id') === 'sheet-spend')).toHaveLength(0)

    const spend = {
      total: { input: 1200, output: 300, cacheRead: 5000, cacheWrite: 0, total: 6500, responses: 3 },
      byDay: { '2026-11-23': { input: 1200, output: 300, cacheRead: 5000, cacheWrite: 0, total: 6500, responses: 3 } },
    }
    const withSpend = renderInBoard(<SheetHead item={it} missing={false} spend={spend} />, board(), 'en')
    const el = byId(withSpend, 'sheet-spend')
    expect(JSON.stringify(el)).toContain('Spend 6.5k')

    const compactCard = renderInBoard(
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
      board(),
      'en',
    )
    expect(JSON.stringify(compactCard)).not.toContain('Spend')
  })

  test('NavRail shows spend-open only when onSpend is supplied', () => {
    const base = {
      expanded: true,
      onToggleExpand() {},
      drawerOpen: false,
      onCloseDrawer() {},
      activePlace: 'board' as const,
      onBoard() {},
      onSchedule() {},
      onCategories() {},
      onArchive() {},
      onSettings() {},
    }
    const without = renderInBoard(<NavRail {...base} />, board(), 'en')
    expect(findAll(without, n => n.attrs.get('id') === 'spend-open')).toHaveLength(0)

    const withBtn = renderInBoard(<NavRail {...base} onSpend={() => {}} />, board(), 'en')
    expect(byId(withBtn, 'spend-open')).toBeTruthy()
  })

  test('SpendPanel fetches nothing while closed and renders per-lane per-day table when opened', async () => {
    const fetched: string[] = []
    const sampleReport: SpendReport = {
      from: '2026-11-17',
      to: '2026-11-23',
      zone: 'UTC',
      lane: null,
      total: { input: 1000, output: 500, cacheRead: 4000, cacheWrite: 0, total: 5500, responses: 4 },
      lanes: [
        {
          lane: 'atlas',
          counts: { input: 800, output: 400, cacheRead: 3000, cacheWrite: 0, total: 4200, responses: 3 },
          byDay: {
            '2026-11-23': { input: 800, output: 400, cacheRead: 3000, cacheWrite: 0, total: 4200, responses: 3 },
          },
          sessions: 1,
        },
        {
          lane: 'personal',
          counts: { input: 200, output: 100, cacheRead: 1000, cacheWrite: 0, total: 1300, responses: 1 },
          byDay: {
            '2026-11-22': { input: 200, output: 100, cacheRead: 1000, cacheWrite: 0, total: 1300, responses: 1 },
          },
          sessions: 1,
        },
      ],
      days: [
        {
          day: '2026-11-22',
          counts: { input: 200, output: 100, cacheRead: 1000, cacheWrite: 0, total: 1300, responses: 1 },
          byLane: { personal: { input: 200, output: 100, cacheRead: 1000, cacheWrite: 0, total: 1300, responses: 1 } },
        },
        {
          day: '2026-11-23',
          counts: { input: 800, output: 400, cacheRead: 3000, cacheWrite: 0, total: 4200, responses: 3 },
          byLane: { atlas: { input: 800, output: 400, cacheRead: 3000, cacheWrite: 0, total: 4200, responses: 3 } },
        },
      ],
      sessions: [
        {
          key: 's1',
          name: 'anna-api',
          lane: 'atlas',
          agent: 'claude',
          counts: { input: 800, output: 400, cacheRead: 3000, cacheWrite: 0, total: 4200, responses: 3 },
          byDay: {
            '2026-11-23': { input: 800, output: 400, cacheRead: 3000, cacheWrite: 0, total: 4200, responses: 3 },
          },
        },
      ],
    }

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input))
      return new Response(JSON.stringify(sampleReport), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const host = dom.window.document.getElementById('root') as HTMLElement
    const ctx = board({
      data: payload({
        categories: [
          {
            id: 'atlas',
            title: 'Atlas',
            color: '#007AFF',
            colorName: 'blue',
            paths: [],
            configured: true,
            fallback: false,
          },
          {
            id: 'personal',
            title: 'Personal',
            color: '#34C759',
            colorName: 'green',
            paths: [],
            configured: true,
            fallback: false,
          },
        ],
        time: { seq: 1, date: '2026-11-23', today: {} },
      }),
    })

    root = createRoot(host)
    act(() => {
      root?.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={ctx}>
            <PanelProvider>
              <SpendPanel open={false} onClose={() => {}} />
            </PanelProvider>
          </BoardContext.Provider>
        </I18nProvider>,
      )
    })
    expect(fetched).toEqual([])

    await act(async () => {
      root?.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={ctx}>
            <PanelProvider>
              <SpendPanel open={true} onClose={() => {}} />
            </PanelProvider>
          </BoardContext.Provider>
        </I18nProvider>,
      )
      await Promise.resolve()
    })
    expect(fetched).toEqual(['/api/spend?from=2026-11-17&to=2026-11-23'])
    const text = host.textContent ?? ''
    expect(text).toContain('Token spend')
    expect(text).toContain('5.5k')
    expect(text).toContain('Atlas')
    expect(text).toContain('Personal')
    expect(text).toContain('anna-api')
  })

  test('SpendPanel clears prior error immediately when reloading starts', async () => {
    let resolveSecond: ((res: Response) => void) | null = null
    let call = 0
    globalThis.fetch = (() => {
      call++
      if (call === 1) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'boom-first' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
      return new Promise<Response>(resolve => {
        resolveSecond = resolve
      })
    }) as unknown as typeof fetch

    const host = dom.window.document.getElementById('root') as HTMLElement
    const ctx = board({
      data: payload({ time: { seq: 1, date: '2026-11-23', today: {} } }),
    })

    root = createRoot(host)
    await act(async () => {
      root?.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={ctx}>
            <PanelProvider>
              <SpendPanel open={true} onClose={() => {}} />
            </PanelProvider>
          </BoardContext.Provider>
        </I18nProvider>,
      )
      await Promise.resolve()
    })
    expect(host.textContent).toContain('boom-first')

    // Close and reopen: stale error must not linger while second request is in flight.
    await act(async () => {
      root?.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={ctx}>
            <PanelProvider>
              <SpendPanel open={false} onClose={() => {}} />
            </PanelProvider>
          </BoardContext.Provider>
        </I18nProvider>,
      )
    })
    await act(async () => {
      root?.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={ctx}>
            <PanelProvider>
              <SpendPanel open={true} onClose={() => {}} />
            </PanelProvider>
          </BoardContext.Provider>
        </I18nProvider>,
      )
    })
    expect(host.textContent).not.toContain('boom-first')

    await act(async () => {
      resolveSecond?.(
        new Response(
          JSON.stringify({
            from: '2026-11-17',
            to: '2026-11-23',
            zone: 'UTC',
            lane: null,
            total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, responses: 0 },
            lanes: [],
            days: [],
            sessions: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      await Promise.resolve()
    })
  })
})
