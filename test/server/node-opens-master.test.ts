// Node opens master's board (#744):
// - masterBoardUrl / validMasterUrl / pickNodeMaster pure rules
// - createNodeStore().setBoardUrl persistence in masters.json
// - Live nodePair: master advertises tunnel URL over existing link, node stores it and sets
//   nodeMaster on GET /api/board (online/offline transitions and tunnel off clearing stale URL),
//   while master and standalone boards keep nodeMaster undefined across Claude UUID, pane-<id>,
//   Windows path, spaces, Cyrillic, and % session keys.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNodeStore } from '../../src/adapters/node-store.ts'
import { validMasterUrl } from '../../src/core/node-key.ts'
import { pickNodeMaster } from '../../src/core/nodes.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import { masterBoardUrl } from '../../src/core/tunnel.ts'
import { serveBoard } from '../support/board-server.ts'
import { nodePair, PAIR_ENV } from '../support/node-pair.ts'
import { sandbox } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const boardJson = async (url: string): Promise<BoardPayload> => {
  const res = await fetch(`${url}/api/board`)
  if (!res.ok) throw new Error(`GET /api/board: ${res.status}`)
  return (await res.json()) as BoardPayload
}

async function waitUntil(fn: () => Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for async condition')
    await Bun.sleep(20)
  }
}

describe('master URL helpers and pickNodeMaster (#744)', () => {
  test('masterBoardUrl derives https URL only when tunnel is on with valid domain and publicPort', () => {
    expect(masterBoardUrl(undefined)).toBeNull()
    expect(masterBoardUrl({ on: false, domain: 'board.atlas.test' })).toBeNull()
    expect(masterBoardUrl({ on: true, domain: '' })).toBeNull()
    expect(masterBoardUrl({ on: true, domain: 'localhost' })).toBeNull()
    expect(masterBoardUrl({ on: true, domain: 'board.atlas.test', publicPort: 70000 })).toBe(
      'https://board.atlas.test/',
    )
    expect(masterBoardUrl({ on: true, domain: 'board.atlas.test' })).toBe('https://board.atlas.test/')
    expect(masterBoardUrl({ on: true, domain: 'board.atlas.test', publicPort: 443 })).toBe('https://board.atlas.test/')
    expect(masterBoardUrl({ on: true, domain: 'board.atlas.test', publicPort: 8443 })).toBe(
      'https://board.atlas.test:8443/',
    )
  })

  test('validMasterUrl accepts https URLs and rejects http, credentials, unprintable, and non-URLs', () => {
    expect(validMasterUrl('https://board.atlas.test')).toBe('https://board.atlas.test/')
    expect(validMasterUrl('  https://board.atlas.test:8443/  ')).toBe('https://board.atlas.test:8443/')
    expect(validMasterUrl('http://board.atlas.test/')).toBeNull()
    expect(validMasterUrl('javascript:alert(1)')).toBeNull()
    expect(validMasterUrl('https://anna:secret@board.atlas.test/')).toBeNull()
    expect(validMasterUrl('https://board.atlas.test/\u0007')).toBeNull()
    expect(validMasterUrl('')).toBeNull()
    expect(validMasterUrl(null)).toBeNull()
  })

  test('pickNodeMaster returns null with no masters and prefers online master with valid URL', () => {
    expect(pickNodeMaster('node-1', [], new Set())).toBeNull()
    const picked = pickNodeMaster(
      'node-1',
      [
        { id: 'm1', name: 'atlas', pairedAt: 100, seenAt: 200, boardUrl: 'https://old.atlas.test/' },
        { id: 'm2', name: 'ben', pairedAt: 150, seenAt: 180, boardUrl: 'https://live.atlas.test/' },
      ],
      new Set(['m2']),
    )
    expect(picked).toEqual({
      nodeId: 'node-1',
      name: 'ben',
      url: 'https://live.atlas.test/',
      online: true,
    })
  })
})

describe('NodeStore setBoardUrl (#744)', () => {
  test('persists, deduplicates, validates, and clears boardUrl in masters.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'node-store-url-'))
    try {
      const store = createNodeStore({ dir })
      const { master } = store.add('atlas', 'hand')
      expect(store.setBoardUrl(master.id, 'http://insecure.atlas.test/')).toBe(false)
      expect(store.setBoardUrl(master.id, 'https://board.atlas.test')).toBe(true)
      expect(store.setBoardUrl(master.id, 'https://board.atlas.test/')).toBe(false)
      expect(store.list()[0]?.boardUrl).toBe('https://board.atlas.test/')
      expect(store.setBoardUrl(master.id, null)).toBe(true)
      expect(store.setBoardUrl(master.id, null)).toBe(false)
      expect(store.list()[0]?.boardUrl).toBeUndefined()
      expect('boardUrl' in (JSON.parse(readFileSync(join(dir, 'masters.json'), 'utf8'))[0] as object)).toBe(false)
      if (process.platform !== 'win32') expect(statSync(join(dir, 'masters.json')).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('master board URL link propagation and nodeMaster payload (#744)', () => {
  test('node stores master URL and tracks online/offline while master omits nodeMaster', async () => {
    const pair = await nodePair({
      masterCfg: {
        tunnel: {
          on: true,
          domain: 'board.atlas.test',
          host: 'atlas.test',
          user: 'boardtunnel',
        },
      },
      nodeCfg: () => ({ id: 'server-1' }),
    })
    const [node] = pair.nodes
    if (!node) throw new Error('expected node')

    await waitUntil(async () => {
      const p = await boardJson(node.url)
      return p.nodeMaster?.online === true && p.nodeMaster.url === 'https://board.atlas.test/'
    })

    const nodePayload = await boardJson(node.url)
    expect(nodePayload.nodeMaster).toEqual({
      nodeId: 'server-1',
      name: 'master',
      url: 'https://board.atlas.test/',
      online: true,
    })

    const store = createNodeStore({ dir: join(stateFolder(node.box), 'node') })
    expect(store.list()[0]?.boardUrl).toBe('https://board.atlas.test/')

    // Master board itself has no `nodeMaster`.
    const masterPayload = await boardJson(pair.master.url)
    expect(masterPayload.nodeMaster).toBeUndefined()

    // Cutting the link flips online to false while preserving the remembered master URL.
    await node.proxy.cut('drop')
    await waitUntil(async () => (await boardJson(node.url)).nodeMaster?.online === false)
    const offlinePayload = await boardJson(node.url)
    expect(offlinePayload.nodeMaster).toEqual({
      nodeId: 'server-1',
      name: 'master',
      url: 'https://board.atlas.test/',
      online: false,
    })

    // Restoring the link brings online back to true.
    node.proxy.restore()
    await waitUntil(async () => (await boardJson(node.url)).nodeMaster?.online === true)
  }, 60_000)

  test('master with tunnel off clears a stale stored boardUrl on the node', async () => {
    const pair = await nodePair({
      masterCfg: {
        tunnel: {
          on: false,
          domain: 'board.atlas.test',
          host: 'atlas.test',
          user: 'boardtunnel',
        },
      },
      nodeCfg: () => ({ id: 'server-1' }),
    })
    const [node] = pair.nodes
    if (!node) throw new Error('expected node')
    const store = createNodeStore({ dir: join(stateFolder(node.box), 'node') })
    const masterId = store.list()[0]?.id
    if (!masterId) throw new Error('expected paired master')

    await waitUntil(async () => (await boardJson(node.url)).nodeMaster?.online === true)
    expect(store.setBoardUrl(masterId, 'https://stale.atlas.test/')).toBe(true)

    // Triggering a fresh status poll / link reconnect causes the master to push x-master-board-url: none.
    await node.proxy.cut('drop')
    await waitUntil(async () => (await boardJson(node.url)).nodeMaster?.online === false)
    node.proxy.restore()
    await waitUntil(async () => {
      const p = await boardJson(node.url)
      return p.nodeMaster?.online === true && p.nodeMaster.url === null
    })
    expect(store.list()[0]?.boardUrl).toBeUndefined()
  }, 60_000)

  test('standalone board without node or nodes leaves GET /api/board unchanged across session key types', async () => {
    const box = await sandbox()
    const sid = '5a6b7c8d-1e2f-4a3b-9c4d-5e6f7a8b9c0d'
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [
              { pane_id: '1', agent: 'claude', agent_session: { value: sid }, agent_status: 'idle', cwd: box.dir },
              {
                pane_id: '2',
                agent: 'claude',
                agent_status: 'working',
                cwd: box.dir,
                terminal_title_stripped: 'Atlas 50% Тест',
              },
              {
                pane_id: '3',
                agent: 'pi',
                agent_session: { value: 'C:\\Users\\anna\\.pi\\sessions\\Тест 50%.jsonl' },
                agent_status: 'idle',
                cwd: box.dir,
              },
            ],
            tabs: [],
            workspaces: [],
          },
        },
      },
    })
    const { url } = await serveBoard(box, { language: 'en' }, PAIR_ENV)
    const p = await boardJson(url)
    expect(p.nodeMaster).toBeUndefined()
    expect(p.items.length).toBe(3)
  })
})
