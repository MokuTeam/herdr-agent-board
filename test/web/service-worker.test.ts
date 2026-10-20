// The phone's service worker (web/sw.js) in a fake browser: its cache, a network that answers when
// told, and a clock on which the 4 seconds it gives the network are over at once. The page names
// its script by build (core/pwa.ts), and each build is kept apart (#116): a page of a new build
// never runs the script kept from before only because the new one is slow to come.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(import.meta.dir, '..', '..', 'web', 'sw.js'), 'utf8')
const ORIGIN = 'https://board.example.ts.net'
const PAGE = `<!doctype html><html data-remote><head><link rel="stylesheet" href="styles/app.css"></head><body><script type="module" src="app.js?v=new"></script></body></html>`

type Key = string | { url: string }
type Handler = (event: Record<string, unknown>) => void
const urlOf = (key: Key) => new URL(typeof key === 'string' ? key : key.url, `${ORIGIN}/`).href
const bare = (url: string) => url.replace(/\?.*$/, '')

/** The worker in a browser whose network answers `answer(url)`; `kept` is what its cache holds. */
function worker(answer: (url: string) => Promise<Response>, kept: Record<string, string> = {}) {
  const store = new Map(Object.entries(kept).map(([path, body]) => [urlOf(path), new Response(body)]))
  const cache = {
    async match(key: Key, options?: { ignoreSearch?: boolean }) {
      const url = urlOf(key)
      const near = options?.ignoreSearch ? [...store].find(([k]) => bare(k) === bare(url))?.[1] : undefined
      return (store.get(url) ?? near)?.clone()
    },
    async put(key: Key, res: Response) {
      store.set(urlOf(key), res)
    },
    async addAll(keys: Key[]) {
      for (const key of keys) store.set(urlOf(key), await answer(urlOf(key)))
    },
    async keys() {
      return [...store.keys()].map(url => ({ url }))
    },
    async delete(key: Key) {
      return store.delete(urlOf(key))
    },
  }
  const on: Record<string, Handler> = {}
  const self = {
    addEventListener: (type: string, handler: Handler) => {
      on[type] = handler
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  }
  new Function('self', 'caches', 'fetch', 'location', 'setTimeout', SOURCE)(
    self,
    { open: async () => cache },
    (input: Key) => answer(urlOf(input)),
    new URL(`${ORIGIN}/`),
    (fn: () => void) => setTimeout(fn, 0),
  )
  return {
    /** What the cache holds, by path. */
    kept: () => [...store.keys()].map(url => url.slice(ORIGIN.length + 1)).sort(),
    async install() {
      let done: Promise<unknown> = Promise.resolve()
      on.install?.({ waitUntil: (p: Promise<unknown>) => (done = p) })
      await done
    },
    /** The page asks for `path`; resolves the worker's answer as text. */
    async get(path: string, mode = 'cors') {
      let response: Promise<Response> | null = null
      on.fetch?.({
        request: { url: urlOf(path), method: 'GET', mode },
        respondWith: (p: Promise<Response>) => (response = p),
      })
      if (!response) throw new Error(`the worker left ${path} to the browser`)
      return (await (response as Promise<Response>)).text()
    },
  }
}

/** A network that answers when `release` is called. */
function later() {
  let release: (res: Response) => void = () => {}
  const reply = new Promise<Response>(resolve => (release = resolve))
  return { reply, release }
}

const settle = () => Bun.sleep(10)

test('installing keeps the page and its script by build; the builds kept before go', async () => {
  const sw = worker(
    async url => new Response(url === `${ORIGIN}/` ? PAGE : `file ${url}`),
    // Kept by the worker before builds had names, and by the build before.
    { 'app.js': 'old', 'app.js?v=old': 'old' },
  )
  await sw.install()
  expect(sw.kept()).toEqual(['', 'app.js?v=new', 'styles/app.css'])
})

test('a slow network for a new build: the page waits for its own script, not the one kept before', async () => {
  const net = later()
  const sw = worker(url => (url.endsWith('app.js?v=new') ? net.reply : Promise.reject(new Error('offline'))), {
    'app.js?v=old': 'old script',
  })
  const answer = sw.get('app.js?v=new')
  await settle() // the 4 seconds are over: only the same build may stand in, and none is kept
  net.release(new Response('new script'))
  expect(await answer).toBe('new script')
  await settle()
  expect(sw.kept()).toEqual(['app.js?v=new'])
})

test('a slow network for the build kept: the kept one, as before', async () => {
  const net = later()
  const sw = worker(() => net.reply, { 'app.js?v=new': 'kept script' })
  expect(await sw.get('app.js?v=new')).toBe('kept script')
})

test('no answer at all, or the board closed behind serve: the build kept before stands in', async () => {
  const kept = { 'app.js?v=old': 'old script' }
  expect(await worker(() => Promise.reject(new Error('offline')), kept).get('app.js?v=new')).toBe('old script')
  expect(await worker(async () => new Response('', { status: 502 }), kept).get('app.js?v=new')).toBe('old script')
})

test('the page itself: the network first, the kept one with no connection', async () => {
  const kept = { './': 'kept page' }
  expect(await worker(async () => new Response('new page'), kept).get('/', 'navigate')).toBe('new page')
  expect(await worker(() => Promise.reject(new Error('offline')), kept).get('/', 'navigate')).toBe('kept page')
  expect(await worker(() => Promise.reject(new Error('offline'))).get('/', 'navigate')).toContain(
    'No connection to the board.',
  )
})
