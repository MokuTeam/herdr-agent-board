// Browser adapter safety tests (#652): CDP beforeunload cancel, duplicate-URL ambiguity refusal,
// early WebSocket close handling, and preserving tab seenAt timestamps across transient mokutab outages.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeTabViaCdp, readTabSeen, updateTabSeen } from '../../src/adapters/housekeeping-browser.ts'

const dirs: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []

afterEach(() => {
  while (servers.length) servers.pop()?.stop(true)
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

function startFakeCdp(opts: {
  targets: (port: number) => { id: string; type: string; url: string; webSocketDebuggerUrl?: string }[]
  behavior: 'close' | 'beforeunload' | 'close-before-open'
}): number {
  const srv = Bun.serve<{ behavior: string }>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      const url = new URL(req.url)
      if (url.pathname === '/json/list') {
        return Response.json(opts.targets(server.port as number))
      }
      if (url.pathname.startsWith('/ws/')) {
        if (server.upgrade(req, { data: { behavior: opts.behavior } })) return undefined
        return new Response('upgrade failed', { status: 400 })
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      open(ws) {
        if (ws.data.behavior === 'close-before-open') {
          ws.close(1011, 'early')
        }
      },
      message(ws, message) {
        const msg = JSON.parse(String(message)) as { id?: number; method?: string; params?: { accept?: boolean } }
        if (msg.method === 'Page.close') {
          if (ws.data.behavior === 'close') {
            ws.close(1000, 'closed')
          } else if (ws.data.behavior === 'beforeunload') {
            ws.send(JSON.stringify({ method: 'Page.javascriptDialogOpening', params: { type: 'beforeunload' } }))
          }
        } else if (msg.method === 'Page.handleJavaScriptDialog' && msg.params?.accept === false) {
          // Even if the socket drops right after cancelling beforeunload, outcome MUST remain 'beforeunload'.
          ws.close(1000, 'kept')
        }
      },
    },
  })
  servers.push(srv)
  return srv.port as number
}

describe('closeTabViaCdp safety', () => {
  test('closes a uniquely matched tab cleanly', async () => {
    const port = startFakeCdp({
      behavior: 'close',
      targets: p => [
        { id: '1', type: 'page', url: 'https://old.example.com/a', webSocketDebuggerUrl: `ws://127.0.0.1:${p}/ws/1` },
      ],
    })
    const res = await closeTabViaCdp(port, 'https://old.example.com/a', 2000)
    expect(res).toEqual({ closed: true })
  })

  test('cancels and keeps tab when beforeunload dialog opens (even if socket closes during settle)', async () => {
    const port = startFakeCdp({
      behavior: 'beforeunload',
      targets: p => [
        {
          id: '1',
          type: 'page',
          url: 'https://form.example.com/edit',
          webSocketDebuggerUrl: `ws://127.0.0.1:${p}/ws/1`,
        },
      ],
    })
    const res = await closeTabViaCdp(port, 'https://form.example.com/edit', 2000)
    expect(res).toEqual({ closed: false, reason: 'beforeunload' })
  })

  test('refuses to close when multiple page targets share the exact same URL (protects pinned/leased duplicate)', async () => {
    const port = startFakeCdp({
      behavior: 'close',
      targets: p => [
        { id: '1', type: 'page', url: 'https://dup.example.com/', webSocketDebuggerUrl: `ws://127.0.0.1:${p}/ws/1` },
        { id: '2', type: 'page', url: 'https://dup.example.com/', webSocketDebuggerUrl: `ws://127.0.0.1:${p}/ws/2` },
      ],
    })
    const res = await closeTabViaCdp(port, 'https://dup.example.com/', 2000)
    expect(res).toEqual({ closed: false, reason: 'ambiguous', detail: 'multiple tabs share this URL' })
  })

  test('returns not-found when URL is absent', async () => {
    const port = startFakeCdp({
      behavior: 'close',
      targets: () => [],
    })
    expect(await closeTabViaCdp(port, 'https://missing.example.com/', 2000)).toEqual({
      closed: false,
      reason: 'not-found',
    })
  })
})

describe('updateTabSeen resilience', () => {
  test('preserves seenAt timestamps when mokutab-bridge is unreachable or a profile query fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hk-seen-'))
    dirs.push(dir)
    const file = join(dir, 'seen.json')
    const t0 = 1_780_000_000_000

    // Initial observation persists both profiles.
    const first = updateTabSeen(
      {},
      [
        {
          name: 'bsd',
          tabs: [
            { tabId: 10, windowId: 1, url: 'https://a.example.com', pinned: false, active: false, lastAccessed: null },
          ],
        },
        {
          name: 'bb',
          tabs: [
            { tabId: 20, windowId: 1, url: 'https://b.example.com', pinned: false, active: false, lastAccessed: null },
          ],
        },
      ],
      t0,
      file,
      true,
      true,
    )
    expect(first).toEqual({ 'bsd:10': t0, 'bb:20': t0 })

    // 1. Transient mokutab outage (reachable = false): MUST NOT wipe seen.json!
    const duringOutage = updateTabSeen(readTabSeen(file), [], t0 + 60_000, file, true, false)
    expect(duringOutage).toEqual({ 'bsd:10': t0, 'bb:20': t0 })
    expect(readTabSeen(file)).toEqual({ 'bsd:10': t0, 'bb:20': t0 })

    // 2. Single profile query error (`bb` errored, `bsd` succeeded with tab 10 still there): keeps bb:20 untouched!
    const partial = updateTabSeen(
      readTabSeen(file),
      [
        {
          name: 'bsd',
          tabs: [
            { tabId: 10, windowId: 1, url: 'https://a.example.com', pinned: false, active: false, lastAccessed: null },
          ],
        },
        { name: 'bb', tabs: [], error: true },
      ],
      t0 + 120_000,
      file,
      true,
      true,
    )
    expect(partial).toEqual({ 'bsd:10': t0, 'bb:20': t0 })
    expect(readTabSeen(file)).toEqual({ 'bsd:10': t0, 'bb:20': t0 })
  })
})
