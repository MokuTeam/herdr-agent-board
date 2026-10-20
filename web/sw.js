// The board in a phone's browser (src/core/pwa.ts): its service worker. It keeps the page's own
// files (the page, its script, styles and icons) for when the phone cannot reach the computer,
// so the page still opens and says so. Online they come from the board every time, so an updated
// board shows at once. What the board says (/api, /uploads: sessions, messages, files) never goes
// through here and is never kept.
//
// The page names its script by build (app.js?v=…, core/pwa.ts), and each build is kept apart: a
// new page waits for its own script rather than run the one kept from before while the new one is
// slow to come (it is megabytes); only with no answer at all does the one from before stand in.
const CACHE = 'board-shell'
const PAGE = './'
const WAIT_MS = 4000

const offline = () =>
  new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent board</title><p style="font:17px system-ui;margin:48px 24px">No connection to the board.</p>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )

/** The page, and every file it names (its href and src), as they are now; older builds of them go. */
async function keepShell() {
  const cache = await caches.open(CACHE)
  const page = await fetch(PAGE, { cache: 'no-store' })
  if (!page.ok) return
  const html = await page.clone().text()
  await cache.put(PAGE, page)
  const files = [...new Set([...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map(m => m[1]))]
  await cache.addAll(files)
  for (const file of files) await dropOlder(cache, file)
}

self.addEventListener('install', event => {
  event.waitUntil(keepShell().catch(() => {}).then(() => self.skipWaiting()))
})
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

/** What is kept for `key`: that build of a file, else the one kept before it. */
async function keptAny(cache, key) {
  return (await cache.match(key)) ?? (await cache.match(key, { ignoreSearch: true }))
}

/** A file kept under a new build (app.js?v=…): the builds kept before it go. */
async function dropOlder(cache, address) {
  const url = new URL(address, location.href)
  if (!url.search) return
  for (const kept of await cache.keys()) {
    const other = new URL(kept.url)
    if (other.pathname === url.pathname && other.search !== url.search) await cache.delete(kept)
  }
}

/**
 * The network first, kept for later; the kept one when the network fails, is slow, or the board
 * does not answer behind serve (a 502 while the computer's board is closed). Slow, only the same
 * build stands in.
 */
async function shell(request, key) {
  const cache = await caches.open(CACHE)
  const network = fetch(request).then(async res => {
    if (!res.ok) return (await keptAny(cache, key)) ?? res
    void cache
      .put(key, res.clone())
      .then(() => dropOlder(cache, typeof key === 'string' ? key : key.url))
      .catch(() => {})
    return res
  })
  const slow = new Promise(resolve => setTimeout(resolve, WAIT_MS)).then(() => cache.match(key))
  try {
    return await Promise.race([network, slow.then(kept => kept ?? network)])
  } catch {
    return (await keptAny(cache, key)) ?? (request.mode === 'navigate' ? offline() : Response.error())
  }
}

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return
  event.respondWith(shell(request, request.mode === 'navigate' ? PAGE : request))
})
