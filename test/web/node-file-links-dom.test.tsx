// Node session file links in a real DOM (jsdom): Sheet + useFileChips + useFileLinks + filesApi
// route /api/fs/stat and /api/fs/preview with the node session key (@device:key) for Windows
// absolute, relative, and POSIX paths, while local sessions keep sending plain requests without key.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Item } from '../../src/core/types.ts'
import type { board as Board } from './support/board.tsx'

let createRoot: typeof import('react-dom/client').createRoot
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let PanelProvider: typeof import('../../web/src/state/PanelProvider.tsx').PanelProvider
let Sheet: typeof import('../../web/src/components/sheet/Sheet.tsx').Sheet
let QuickLook: typeof import('../../web/src/components/files/QuickLook.tsx').QuickLook
let FileChips: typeof import('../../web/src/components/files/FileChip.tsx').FileChips
let useFileChips: typeof import('../../web/src/hooks/useFileChips.ts').useFileChips
let useQuickLook: typeof import('../../web/src/hooks/useQuickLook.ts').useQuickLook
let useFileLinks: typeof import('../../web/src/hooks/useFileLinks.ts').useFileLinks
let stopAllSprings: typeof import('../../web/src/models/spring.ts').stopAllSprings
let board: typeof Board

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
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'devicePixelRatio',
  'ResizeObserver',
  'matchMedia',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const realFetch = globalThis.fetch

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...DOM_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.devicePixelRatio = 1
  g.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof requestAnimationFrame
  g.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  if (!g.matchMedia) {
    g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  }
  dom.window.HTMLElement.prototype.animate = () => ({}) as Animation
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ createRoot } = await import('react-dom/client'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ PanelProvider } = await import('../../web/src/state/PanelProvider.tsx'))
  ;({ Sheet } = await import('../../web/src/components/sheet/Sheet.tsx'))
  ;({ QuickLook } = await import('../../web/src/components/files/QuickLook.tsx'))
  ;({ FileChips } = await import('../../web/src/components/files/FileChip.tsx'))
  ;({ useFileChips } = await import('../../web/src/hooks/useFileChips.ts'))
  ;({ useQuickLook } = await import('../../web/src/hooks/useQuickLook.ts'))
  ;({ useFileLinks } = await import('../../web/src/hooks/useFileLinks.ts'))
  ;({ stopAllSprings } = await import('../../web/src/models/spring.ts'))
  ;({ board } = await import('./support/board.tsx'))
})

afterAll(() => {
  stopAllSprings()
  globalThis.fetch = realFetch
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

const NODE_KEY = '@win-node:pane-7'
const LOCAL_KEY = 'pane-1'

const nodeItem = {
  key: NODE_KEY,
  session: '11111111-2222-4333-8444-555555555555',
  name: 'Win Node',
  agent: 'claude',
  device: 'win-node',
  pane: 'w1:p7',
  cwd: 'C:\\Projects\\Demo',
  status: 'idle',
  column: 'idle',
  sleeping: false,
} as Item

const localItem = {
  key: LOCAL_KEY,
  session: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'Local Session',
  agent: 'claude',
  pane: 'w1:p1',
  cwd: '/srv/demo',
  status: 'idle',
  column: 'idle',
  sleeping: false,
} as Item

const flush = () => new Promise(r => setTimeout(r, 25))

test('node session file links stat and preview on the node with Windows, relative, and POSIX paths; local stays key-free', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const nodeDetail = {
    item: nodeItem,
    conversation: [
      {
        role: 'assistant',
        text: 'Built [popup](C:/Projects/Demo/dist/popup.html), `app/main.ts`, and `/opt/shared/notes.md`.',
        at: 1,
      },
    ],
    queued: [],
    screen: '',
    dialog: null,
    checkout: false,
    helpers: [],
    workflows: [],
  }
  const localDetail = {
    item: localItem,
    conversation: [{ role: 'assistant', text: 'See `src/index.ts`.', at: 1 }],
    queued: [],
    screen: '',
    dialog: null,
    checkout: false,
    helpers: [],
    workflows: [],
  }

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === `/api/session/${encodeURIComponent(NODE_KEY)}`) return Response.json(nodeDetail)
    if (url === `/api/session/${encodeURIComponent(LOCAL_KEY)}`) return Response.json(localDetail)
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    calls.push({ url, body })
    if (url === '/api/fs/stat') {
      const paths = (body.paths as string[]) ?? []
      return Response.json({
        items: paths.map(raw => ({
          raw,
          path:
            raw === 'C:/Projects/Demo/dist/popup.html'
              ? 'C:\\Projects\\Demo\\dist\\popup.html'
              : raw === 'app/main.ts'
                ? 'C:\\Projects\\Demo\\app\\main.ts'
                : raw === 'src/index.ts'
                  ? '/srv/demo/src/index.ts'
                  : raw,
          name: raw.split(/[\\/]/).pop() ?? raw,
          exists: true,
          dir: false,
          kind: 'text',
          line: null,
        })),
      })
    }
    if (url === '/api/fs/preview') {
      return Response.json({
        path: body.path,
        name: String(body.path).split(/[\\/]/).pop(),
        exists: true,
        dir: false,
        kind: 'text',
        text: 'ok',
        lines: 1,
      })
    }
    return Response.json({ ok: true })
  }) as typeof fetch

  function Harness() {
    const chips = useFileChips()
    const quickLook = useQuickLook(chips.upgrade)
    useFileLinks(quickLook.look)
    return (
      <>
        <Sheet upgradeFiles={chips.upgrade} />
        <FileChips chips={chips} />
        <QuickLook engine={quickLook.engine} />
      </>
    )
  }

  const host = dom.window.document.getElementById('root') as HTMLElement
  host.innerHTML = ''
  const root = createRoot(host)
  const render = (open: string) =>
    act(async () => {
      root.render(
        <I18nProvider lang="en">
          <BoardContext.Provider
            value={board({
              data: { ...board().data, items: [nodeItem, localItem] } as ReturnType<typeof board>['data'],
              ui: { open },
            })}
          >
            <PanelProvider viewport={() => ({ w: 1200, h: 800 })}>
              <Harness />
            </PanelProvider>
          </BoardContext.Provider>
        </I18nProvider>,
      )
      await flush()
    })

  await render(NODE_KEY)
  const statCall = calls.find(c => c.url === '/api/fs/stat')
  expect(statCall?.body).toEqual({
    key: NODE_KEY,
    cwd: 'C:\\Projects\\Demo',
    paths: ['C:/Projects/Demo/dist/popup.html', 'app/main.ts', '/opt/shared/notes.md'],
  })

  const popupChip = host.querySelector<HTMLElement>('[data-path="C:/Projects/Demo/dist/popup.html"]')
  expect(popupChip?.dataset.fs).toBe('file')
  expect(popupChip?.dataset.abs).toBe('C:\\Projects\\Demo\\dist\\popup.html')
  expect(popupChip?.dataset.key).toBe(NODE_KEY)

  await act(async () => {
    popupChip?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  const previewCall = calls.find(c => c.url === '/api/fs/preview')
  expect(previewCall?.body).toEqual({
    key: NODE_KEY,
    path: 'C:\\Projects\\Demo\\dist\\popup.html',
  })

  calls.length = 0
  await render(LOCAL_KEY)
  const localStat = calls.find(c => c.url === '/api/fs/stat')
  expect(localStat?.body).toEqual({
    cwd: '/srv/demo',
    paths: ['src/index.ts'],
  })
  const localChip = host.querySelector<HTMLElement>('[data-path="src/index.ts"]')
  expect(localChip?.dataset.key).toBeUndefined()
  await act(async () => {
    localChip?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await flush()
  })
  const localPreview = calls.find(c => c.url === '/api/fs/preview')
  expect(localPreview?.body).toEqual({ path: '/srv/demo/src/index.ts' })

  await act(async () => root.unmount())
})
