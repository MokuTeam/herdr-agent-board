// Web board behavior for a node opening its master's board (#744):
// - Redirects via location.replace on load when master is online with URL and ?local=1 is not set.
// - Stays local with the quiet banner when master is offline or has no URL.
// - Keeps ?local=1 for the tab in sessionStorage and offers "Open shared board" link.
// - Leaves standalone, master, and remote boards unchanged (no banner, no redirect).
// - Takes the page's deep link along (#837): #thread=<key> as it is, a notification's #session=<key>
//   as the master knows the node's session (@<node>:<key>); no query, no other hash or path.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, StrictMode } from 'react'
import type { BoardPayload } from '../../src/core/payload.ts'

let createRoot: typeof import('react-dom/client').createRoot
let NodeMasterBanner: typeof import('../../web/src/components/devices/NodeMasterBanner.tsx').NodeMasterBanner
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let support: typeof import('./support/board.tsx')
let nodeMasterAction: typeof import('../../web/src/models/node-master.ts').nodeMasterAction
let readStayLocal: typeof import('../../web/src/models/node-master.ts').readStayLocal
let STAY_LOCAL_KEY: typeof import('../../web/src/models/node-master.ts').STAY_LOCAL_KEY
let masterDeepLink: typeof import('../../web/src/models/node-master.ts').masterDeepLink
let threadInHash: typeof import('../../web/src/models/work-threads.ts').threadInHash
let sessionInHash: typeof import('../../web/src/models/reveal.ts').sessionInHash

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:12422/',
})
const g = globalThis as Record<string, unknown>
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'location',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'localStorage',
  'sessionStorage',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()

function memoryStore() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...DOM_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ NodeMasterBanner } = await import('../../web/src/components/devices/NodeMasterBanner.tsx'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ nodeMasterAction, readStayLocal, STAY_LOCAL_KEY, masterDeepLink } = await import(
    '../../web/src/models/node-master.ts'
  ))
  ;({ threadInHash } = await import('../../web/src/models/work-threads.ts'))
  ;({ sessionInHash } = await import('../../web/src/models/reveal.ts'))
  support = await import('./support/board.tsx')
})

afterAll(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

let root: ReturnType<typeof createRoot> | null = null

beforeEach(() => {
  dom.window.document.documentElement.removeAttribute('data-remote')
  dom.window.document.body.innerHTML = '<div id="root"></div>'
  dom.window.sessionStorage.clear()
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
    root = null
  }
})

function mountBanner(
  data: BoardPayload | null,
  options: {
    lang?: string
    navigate?: (url: string) => void
    search?: string
    store?: ReturnType<typeof memoryStore>
    strict?: boolean
    opened?: { pathname: string; hash: string } | null | undefined
  } = {},
) {
  const el = dom.window.document.getElementById('root')
  if (!el) throw new Error('missing root')
  root ??= createRoot(el)
  const value = support.board({ data })
  const inner = (
    <I18nProvider lang={options.lang ?? 'ru'}>
      <BoardContext.Provider value={value}>
        <NodeMasterBanner
          navigate={options.navigate}
          search={options.search ?? ''}
          sessionStore={options.store ?? null}
          opened={options.opened}
        />
      </BoardContext.Provider>
    </I18nProvider>
  )
  act(() => {
    root?.render(options.strict ? <StrictMode>{inner}</StrictMode> : inner)
  })
}

describe('node-master model (#744)', () => {
  test('readStayLocal persists ?local=1 per tab and clears on ?local=0', () => {
    const store = memoryStore()
    expect(readStayLocal('', store)).toBe(false)
    expect(readStayLocal('?local=1', store)).toBe(true)
    expect(store.getItem(STAY_LOCAL_KEY)).toBe('1')
    expect(readStayLocal('', store)).toBe(true)
    expect(readStayLocal('?local=0', store)).toBe(false)
    expect(store.getItem(STAY_LOCAL_KEY)).toBeNull()
  })

  test('nodeMasterAction enforces https, non-same-origin, remote flag, and stayLocal', () => {
    const online = { nodeId: 'server-1', name: 'atlas', url: 'https://board.atlas.test/', online: true }
    expect(nodeMasterAction(undefined)).toBeNull()
    expect(nodeMasterAction(online, { remote: true })).toBeNull()
    expect(nodeMasterAction(online, { currentOrigin: 'https://board.atlas.test' })).toEqual({
      kind: 'banner',
      nodeId: 'server-1',
      masterName: 'atlas',
      url: null,
      offline: false,
    })
    expect(nodeMasterAction(online, { currentOrigin: 'http://127.0.0.1:12422' })).toEqual({
      kind: 'redirect',
      url: 'https://board.atlas.test/',
    })
    expect(
      nodeMasterAction(
        { nodeId: 'server-1', name: 'atlas', url: 'http://board.atlas.test/', online: true },
        { currentOrigin: 'http://127.0.0.1:12422' },
      ),
    ).toEqual({
      kind: 'banner',
      nodeId: 'server-1',
      masterName: 'atlas',
      url: null,
      offline: false,
    })
  })
})

describe('NodeMasterBanner DOM (#744)', () => {
  test('redirects once on load when master is online with public URL and ?local=1 is absent', () => {
    const went: string[] = []
    mountBanner(
      support.payload({
        nodeMaster: { nodeId: 'server-1', name: 'atlas', url: 'https://board.atlas.test/', online: true },
      }),
      { navigate: url => went.push(url), store: memoryStore() },
    )
    expect(went).toEqual(['https://board.atlas.test/'])
    expect(dom.window.document.getElementById('node-master-banner')).toBeNull()
  })

  test('redirects once under StrictMode when data starts null and later loads nodeMaster', () => {
    const went: string[] = []
    const store = memoryStore()
    mountBanner(null, { navigate: url => went.push(url), store, strict: true })
    expect(went).toEqual([])
    mountBanner(
      support.payload({
        nodeMaster: { nodeId: 'server-1', name: 'atlas', url: 'https://board.atlas.test/', online: true },
      }),
      { navigate: url => went.push(url), store, strict: true },
    )
    expect(went).toEqual(['https://board.atlas.test/'])
  })

  test('shows offline banner with link in Russian and does not redirect mid-session if master later connects', () => {
    const went: string[] = []
    const store = memoryStore()
    mountBanner(
      support.payload({
        nodeMaster: { nodeId: 'server-1', name: 'atlas', url: 'https://board.atlas.test/', online: false },
      }),
      { lang: 'ru', navigate: url => went.push(url), store },
    )
    const banner = dom.window.document.getElementById('node-master-banner')
    expect(banner?.textContent).toContain('Это нода server-1. Общая доска на мастере atlas')
    expect(banner?.textContent).toContain('мастер недоступен, показаны только сессии этой машины')
    const link = banner?.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://board.atlas.test/')
    expect(link?.textContent).toBe('Открыть общую доску')
    expect(went).toEqual([])

    // Master comes online while the user is already viewing the local board: updates banner, no surprise redirect.
    mountBanner(
      support.payload({
        nodeMaster: { nodeId: 'server-1', name: 'atlas', url: 'https://board.atlas.test/', online: true },
      }),
      { lang: 'ru', navigate: url => went.push(url), store },
    )
    expect(went).toEqual([])
    const updated = dom.window.document.getElementById('node-master-banner')
    expect(updated?.textContent).toContain('Это нода server-1. Общая доска на мастере atlas')
    expect(updated?.textContent).not.toContain('мастер недоступен')
    expect(updated?.querySelector('a')?.getAttribute('href')).toBe('https://board.atlas.test/')
  })

  test('shows quiet banner without link or offline note when master is online without public URL', () => {
    const went: string[] = []
    mountBanner(
      support.payload({
        nodeMaster: { nodeId: 'server-1', name: 'atlas', url: null, online: true },
      }),
      { lang: 'en', navigate: url => went.push(url), store: memoryStore() },
    )
    expect(went).toEqual([])
    const banner = dom.window.document.getElementById('node-master-banner')
    expect(banner?.textContent).toBe('This is node server-1. The shared board is on master atlas')
    expect(banner?.querySelector('a')).toBeNull()
  })

  test('?local=1 skips redirect and persists in sessionStorage for subsequent reloads in the tab', () => {
    const went: string[] = []
    const store = memoryStore()
    mountBanner(
      support.payload({
        nodeMaster: { nodeId: 'server-1', name: 'atlas', url: 'https://board.atlas.test/', online: true },
      }),
      { lang: 'ru', navigate: url => went.push(url), search: '?local=1', store },
    )
    expect(went).toEqual([])
    expect(dom.window.document.getElementById('node-master-banner')?.querySelector('a')?.textContent).toBe(
      'Открыть общую доску',
    )

    // Unmount and remount without ?local=1 using same tab store: still stays local.
    act(() => root?.unmount())
    root = null
    mountBanner(
      support.payload({
        nodeMaster: { nodeId: 'server-1', name: 'atlas', url: 'https://board.atlas.test/', online: true },
      }),
      { lang: 'ru', navigate: url => went.push(url), search: '', store },
    )
    expect(went).toEqual([])
    expect(dom.window.document.getElementById('node-master-banner')).not.toBeNull()
  })

  test('standalone, master, and remote boards render no banner and never redirect', () => {
    const went: string[] = []
    mountBanner(support.payload({}), { navigate: url => went.push(url), store: memoryStore() })
    expect(dom.window.document.getElementById('node-master-banner')).toBeNull()
    mountBanner(
      support.payload({
        devices: [
          {
            id: 'local',
            title: 'local',
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
        ],
      }),
      { navigate: url => went.push(url), store: memoryStore() },
    )
    expect(dom.window.document.getElementById('node-master-banner')).toBeNull()

    dom.window.document.documentElement.setAttribute('data-remote', '')
    mountBanner(
      support.payload({
        nodeMaster: { nodeId: 'server-1', name: 'atlas', url: 'https://board.atlas.test/', online: true },
      }),
      { navigate: url => went.push(url), store: memoryStore() },
    )
    expect(dom.window.document.getElementById('node-master-banner')).toBeNull()
    expect(went).toEqual([])
  })
})

describe('NodeMasterBanner before the payload (#797)', () => {
  const view = { nodeId: 'server-1', name: 'atlas', url: 'https://board.atlas.test/', online: true }
  const putMeta = (content: string): void => {
    const meta = dom.window.document.createElement('meta')
    meta.setAttribute('name', 'board-node-master')
    meta.setAttribute('content', content)
    dom.window.document.head.append(meta)
  }
  afterEach(() => {
    for (const m of dom.window.document.head.querySelectorAll('meta[name="board-node-master"]')) m.remove()
  })

  test('a tab whose payload never came (in the background) goes to the master the node put in the page', () => {
    putMeta(JSON.stringify(view))
    const went: string[] = []
    mountBanner(null, { navigate: url => went.push(url), store: memoryStore() })
    expect(went).toEqual(['https://board.atlas.test/'])
  })

  test('staying local, the banner and its link show before the payload comes', () => {
    putMeta(JSON.stringify({ ...view, name: 'atlas ☃ 100%' }))
    const went: string[] = []
    mountBanner(null, { navigate: url => went.push(url), search: '?local=1', store: memoryStore(), lang: 'en' })
    expect(went).toEqual([])
    const banner = dom.window.document.getElementById('node-master-banner')
    expect(banner?.textContent).toContain('atlas ☃ 100%')
    expect(banner?.querySelector('a')?.getAttribute('href')).toBe('https://board.atlas.test/')
  })

  test('the payload, once it came, is what counts', () => {
    putMeta(JSON.stringify(view))
    const went: string[] = []
    mountBanner(support.payload({ nodeMaster: { ...view, online: false } }), {
      navigate: url => went.push(url),
      store: memoryStore(),
    })
    expect(went).toEqual([])
    expect(dom.window.document.getElementById('node-master-banner')?.textContent).toContain('atlas')
  })

  test('a page without the tag (any other board) or with a broken one: nothing before the payload, as before', () => {
    const went: string[] = []
    mountBanner(null, { navigate: url => went.push(url), store: memoryStore() })
    expect(went).toEqual([])
    expect(dom.window.document.getElementById('node-master-banner')).toBeNull()
    act(() => root?.unmount())
    root = null
    putMeta('{"nodeId":1}')
    mountBanner(null, { navigate: url => went.push(url), store: memoryStore() })
    expect(went).toEqual([])
    expect(dom.window.document.getElementById('node-master-banner')).toBeNull()
  })
})

describe('the deep link goes along with the redirect (#837)', () => {
  const view = { nodeId: 'server-1', name: 'atlas', url: 'https://board.atlas.test/', online: true }
  const at = (hash: string, pathname = '/') => ({ pathname, hash })
  const redirectOf = (opened: { pathname: string; hash: string } | null, url = view.url) =>
    nodeMasterAction({ ...view, url }, { currentOrigin: 'http://127.0.0.1:12422', opened })

  test('a thread link lands on the same thread on the master, which its page reads back', () => {
    const r = redirectOf(at('#thread=bb-19'))
    expect(r).toEqual({ kind: 'redirect', url: 'https://board.atlas.test/#thread=bb-19' })
    if (r?.kind !== 'redirect') throw new Error('no redirect')
    expect(threadInHash(new URL(r.url).hash)).toBe('bb-19')
    // a peer's thread key, upper case as a chat may write it: the key the board reads
    expect(redirectOf(at('#thread=Atlas-12@peer_1'))).toEqual({
      kind: 'redirect',
      url: 'https://board.atlas.test/#thread=atlas-12%40peer_1',
    })
  })

  test("a notification's session lands on the node's session as the master keys it", () => {
    for (const key of [
      '0f3c2a1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b',
      'pane-17',
      'C:\\Users\\Some One\\.pi\\sessions\\a b.jsonl',
      'сессия 100%',
    ]) {
      const r = redirectOf(at(`#session=${encodeURIComponent(key)}`))
      if (r?.kind !== 'redirect') throw new Error('no redirect')
      expect(new URL(r.url).origin + new URL(r.url).pathname).toBe('https://board.atlas.test/')
      expect(sessionInHash(new URL(r.url).hash)).toBe(`@server-1:${key}`)
    }
  })

  test("the master's own path stays and its hash gives way", () => {
    expect(redirectOf(at('#thread=bb-19'), 'https://atlas.test/board/?x=1#old')).toEqual({
      kind: 'redirect',
      url: 'https://atlas.test/board/?x=1#thread=bb-19',
    })
  })

  test('nothing else goes along: a foreign hash, another path, a key from elsewhere, the query', () => {
    const bare = { kind: 'redirect' as const, url: 'https://board.atlas.test/' }
    for (const opened of [
      null,
      at(''),
      at('#'),
      at('#evil=1'),
      at('#thread=not a key'),
      at('#thread=../../x-1'),
      at('#session='),
      at('#session=%40server-2%3Aabc'),
      at(`#session=${encodeURIComponent('a\u0000b')}`),
      at(`#session=${'k'.repeat(513)}`),
      at('#thread=bb-19', '/other'),
      at('#thread=bb-19', '/index.html'),
      at('#session=abc', '//evil.test/'),
    ])
      expect(redirectOf(opened)).toEqual(bare)
    expect(masterDeepLink(at('#session=abc'), 'local')).toBe('')
    expect(masterDeepLink(at('#session=abc'), 'Bad:Id')).toBe('')
  })

  test('the component redirects with the deep link, read as the page opened though the hash is gone by then', () => {
    dom.window.history.replaceState(null, '', '/?local=0#thread=bb-19')
    try {
      const went: string[] = []
      const store = memoryStore()
      mountBanner(null, { navigate: url => went.push(url), store })
      // the board came in and forgot the address (hooks/useThreadLinks.ts) before the payload named the master
      dom.window.history.replaceState(null, '', '/')
      mountBanner(support.payload({ nodeMaster: view }), {
        navigate: url => went.push(url),
        search: '?local=0',
        store,
      })
      expect(went).toEqual(['https://board.atlas.test/#thread=bb-19'])
    } finally {
      dom.window.history.replaceState(null, '', '/')
    }
  })

  test("a notification's session survives the redirect in the component", () => {
    const went: string[] = []
    mountBanner(support.payload({ nodeMaster: view }), {
      navigate: url => went.push(url),
      store: memoryStore(),
      opened: at('#session=pane-17'),
    })
    expect(went).toEqual(['https://board.atlas.test/#session=%40server-1%3Apane-17'])
  })

  test('?local=1 still stays local, with the bare link in the banner', () => {
    const went: string[] = []
    mountBanner(support.payload({ nodeMaster: view }), {
      navigate: url => went.push(url),
      search: '?local=1',
      store: memoryStore(),
      opened: at('#thread=bb-19'),
    })
    expect(went).toEqual([])
    expect(dom.window.document.querySelector('#node-master-banner a')?.getAttribute('href')).toBe(
      'https://board.atlas.test/',
    )
  })
})
