// Attachments in a node session's chat (#640) on a real DOM (jsdom): uploading via useComposer
// sends POST /api/upload?key=<nodeKey> and delivers the node's returned path in the message;
// local sessions keep posting to plain /api/upload; image thumbnails in Thread and Waiting carry
// ?key=<nodeKey> for node sessions and none for local sessions.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act } from 'react'
import type { Item } from '../../src/core/types.ts'
import type { ComposerControls } from '../../web/src/hooks/useComposer.ts'
import type { OutboxEntry } from '../../web/src/models/composer-session.ts'
import type { board as Board } from './support/board.tsx'

let createRoot: typeof import('react-dom/client').createRoot
let useComposer: typeof import('../../web/src/hooks/useComposer.ts').useComposer
let Thread: typeof import('../../web/src/components/sheet/Thread.tsx').Thread
let Waiting: typeof import('../../web/src/components/sheet/Thread.tsx').Waiting
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let board: typeof Board
let drawSheet: typeof import('./support/sheet-scene.tsx').drawSheet
let serializeNodes: typeof import('./support/markup.ts').serializeNodes

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
  'MutationObserver',
  'getComputedStyle',
  'localStorage',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()
const realFetch = globalThis.fetch
const realCreateObjectURL = URL.createObjectURL
const realRevokeObjectURL = URL.revokeObjectURL

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...DOM_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  URL.createObjectURL = () => 'blob:mock'
  URL.revokeObjectURL = () => {}
  dom.window.HTMLElement.prototype.animate = () => ({}) as Animation
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useComposer } = await import('../../web/src/hooks/useComposer.ts'))
  ;({ Thread, Waiting } = await import('../../web/src/components/sheet/Thread.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ board } = await import('./support/board.tsx'))
  ;({ drawSheet } = await import('./support/sheet-scene.tsx'))
  ;({ serializeNodes } = await import('./support/markup.ts'))
})

afterAll(() => {
  globalThis.fetch = realFetch
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

const NODE_KEY = '@server-2:509dfc37-b58e-4851-9988-a8c7befe9f0d'
const LOCAL_KEY = '509dfc37-b58e-4851-9988-a8c7befe9f0d'
const NODE_PATH = '/home/agent-board/.local/state/herdr/plugins/agent-board/uploads/2026-11-23/120000-shot.png'
const LOCAL_PATH = 'C:\\Users\\me\\AppData\\Local\\herdr\\plugins\\agent-board\\uploads\\2026-11-23\\120000-shot.png'

const nodeItem = {
  key: NODE_KEY,
  session: '509dfc37-b58e-4851-9988-a8c7befe9f0d',
  name: 'Server Agy',
  agent: 'agy',
  device: 'server-2',
  pane: 'w5:p9',
  status: 'idle',
  column: 'idle',
  sleeping: false,
} as Item

const localItem = {
  key: LOCAL_KEY,
  session: LOCAL_KEY,
  name: 'Local Claude',
  agent: 'claude',
  pane: 'w1:p1',
  status: 'idle',
  column: 'idle',
  sleeping: false,
} as Item

function mountComposer(items: Item[], initialOpen: string | null) {
  let latest: ComposerControls | null = null
  const toasts: { text: string; error?: boolean }[] = []
  function Harness() {
    latest = useComposer(() => {})
    return null
  }
  const el = dom.window.document.getElementById('root') as HTMLElement
  el.innerHTML = ''
  const root = createRoot(el)
  const render = (open: string | null) =>
    act(async () => {
      root.render(
        <I18nProvider lang="en">
          <BoardContext.Provider
            value={board({
              data: { ...board().data, items } as ReturnType<typeof board>['data'],
              ui: { open },
              toast: (text, error) => toasts.push({ text, ...(error !== undefined && { error }) }),
            })}
          >
            <Harness />
          </BoardContext.Provider>
        </I18nProvider>,
      )
    })
  return {
    get controls(): ComposerControls {
      if (!latest) throw new Error('not mounted')
      return latest
    },
    toasts,
    render,
    start: () => render(initialOpen),
    unmount: () => act(async () => root.unmount()),
  }
}

test('attaching a file in a node session uploads with ?key= and sends the node path; local sessions stay on /api/upload (#640)', async () => {
  const requests: { url: string; method: string; body?: string }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    requests.push({ url, method, ...(body !== undefined && { body }) })
    if (url.startsWith('/api/upload?key=')) return Response.json({ ok: true, path: NODE_PATH })
    if (url === '/api/upload') return Response.json({ ok: true, path: LOCAL_PATH })
    return Response.json({ ok: true })
  }) as typeof fetch

  const h = mountComposer([nodeItem, localItem], NODE_KEY)
  await h.start()

  const shot = new File(['png'], 'shot.png', { type: 'image/png' })
  await act(async () => {
    h.controls.addFiles([shot])
    await new Promise(r => setTimeout(r, 20))
  })
  expect(requests[0]?.url).toBe(`/api/upload?key=${encodeURIComponent(NODE_KEY)}`)
  expect(h.controls.attachments[0]?.status).toBe('done')
  expect(h.controls.attachments[0]?.path).toBe(NODE_PATH)

  await act(async () => {
    h.controls.send()
    await new Promise(r => setTimeout(r, 20))
  })
  const msgReq = requests.find(r => r.url === `/api/session/${encodeURIComponent(NODE_KEY)}/message`)
  expect(msgReq).toBeDefined()
  expect(JSON.parse(msgReq?.body ?? '{}')).toMatchObject({ files: [NODE_PATH] })

  // Switch to a local session: uploads go to plain /api/upload without ?key=.
  await h.render(LOCAL_KEY)
  await act(async () => {
    h.controls.addFiles([shot])
    await new Promise(r => setTimeout(r, 20))
  })
  const localUpload = requests.filter(r => r.url.startsWith('/api/upload')).at(-1)
  expect(localUpload?.url).toBe('/api/upload')
  expect(h.controls.attachments[0]?.path).toBe(LOCAL_PATH)

  // Switching away while a node upload is still in flight drops it cleanly and never leaks its path to the next session.
  let finishSlow: (r: Response) => void = () => {}
  globalThis.fetch = ((url: string) => {
    requests.push({ url, method: 'POST' })
    return new Promise<Response>(resolve => {
      finishSlow = resolve
    })
  }) as typeof fetch
  await h.render(NODE_KEY)
  await act(async () => {
    h.controls.addFiles([shot])
  })
  expect(requests.at(-1)?.url).toBe(`/api/upload?key=${encodeURIComponent(NODE_KEY)}`)
  await h.render(LOCAL_KEY)
  expect(h.controls.attachments).toEqual([])
  await act(async () => {
    finishSlow(Response.json({ ok: true, path: NODE_PATH }))
    await new Promise(r => setTimeout(r, 20))
  })
  expect(h.controls.attachments).toEqual([])

  // Dropping/pasting while the sheet is closing (open === null) does not upload to master.
  const beforeClosed = requests.length
  await h.render(null)
  await act(async () => {
    h.controls.addFiles([shot])
    await new Promise(r => setTimeout(r, 20))
  })
  expect(requests.length).toBe(beforeClosed)
  expect(h.controls.attachments).toEqual([])

  // An offline node (503 node-offline) marks the attachment failed and reports it in a toast.
  globalThis.fetch = (async () =>
    Response.json({ error: 'node-offline', device: 'server-2' }, { status: 503 })) as unknown as typeof fetch
  await h.render(NODE_KEY)
  await act(async () => {
    h.controls.addFiles([shot])
    await new Promise(r => setTimeout(r, 20))
  })
  expect(h.controls.attachments[0]?.status).toBe('error')
  expect(h.toasts.at(-1)).toMatchObject({ error: true })
  expect(h.toasts.at(-1)?.text).toContain('server-2')

  await h.unmount()
})

test('Thread and Waiting upload thumbnails carry ?key= for node sessions and none for local sessions (#640)', async () => {
  const el = dom.window.document.getElementById('root') as HTMLElement
  el.innerHTML = ''
  const root = createRoot(el)
  const outbox = (full: string): OutboxEntry => ({
    id: 'out-1',
    text: 'see',
    files: [NODE_PATH],
    attached: [],
    full,
    key: 'see',
    after: 1,
    state: 'sending',
    error: '',
    sentAt: 0,
  })
  const draw = (it: Item, path: string) =>
    act(async () => {
      root.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={board()}>
            <Thread conversation={[{ role: 'user', text: `see\n\nFile:\n${path}`, at: 1 }]} item={it} />
            <Waiting
              queued={[{ text: `queued\n\nFile:\n${path}`, at: 2 }]}
              own={[outbox(`own\n\nFile:\n${path}`)]}
              sessionKey={it.key}
            />
          </BoardContext.Provider>
        </I18nProvider>,
      )
    })

  await draw(nodeItem, NODE_PATH)
  const nodeSrcs = [...el.querySelectorAll('img')].map(img => img.getAttribute('src'))
  const nodeHrefs = [...el.querySelectorAll('a.fs-inline')].map(a => a.getAttribute('href'))
  const wantNode = `/uploads/2026-11-23/120000-shot.png?key=${encodeURIComponent(NODE_KEY)}`
  expect(nodeSrcs).toEqual([wantNode, wantNode, wantNode])
  expect(nodeHrefs).toEqual([wantNode, wantNode, wantNode])

  await draw(localItem, LOCAL_PATH)
  const localSrcs = [...el.querySelectorAll('img')].map(img => img.getAttribute('src'))
  expect(localSrcs).toEqual([
    '/uploads/2026-11-23/120000-shot.png',
    '/uploads/2026-11-23/120000-shot.png',
    '/uploads/2026-11-23/120000-shot.png',
  ])

  await act(async () => root.unmount())

  // SheetView wires item.key into both Thread and Waiting (queued) thumbnails.
  const sheet = drawSheet({
    items: [nodeItem],
    open: NODE_KEY,
    detail: {
      key: NODE_KEY,
      status: 'ready',
      error: '',
      at: Date.now(),
      data: {
        item: nodeItem,
        conversation: [{ role: 'user', text: `see\n\nFile:\n${NODE_PATH}`, at: 1 }],
        queued: [{ text: `queued\n\nFile:\n${NODE_PATH}`, at: 2 }],
        screen: '',
        dialog: null,
        checkout: false,
        helpers: [],
        workflows: [],
      },
    },
  })
  const html = serializeNodes(sheet.reactBody)
  expect(html.split(`src="${wantNode}"`).length - 1).toBe(2)
})
