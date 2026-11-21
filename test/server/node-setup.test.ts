// "Add a server" on a real board (#509, services/nodes/setup.ts, the routes in
// server/routes/nodes.ts and app.ts): on a board without `nodes` the form's two routes answer on
// this computer's listener alone and nothing of them runs until asked; a node's door does not have
// them; and the whole of it end to end: Look and Apply through the fake ssh (fake-ssh.ts), whose
// admin runs the node's real scripts on a fake root (fake-root.ts), then the master's half against
// the board's own config.json, its real link through the fake ssh's forward to a node board
// (node-pair.ts), the first status, the thresholds and the first bundle.
import { describe, expect, test } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { NODE_API } from '../../src/core/node-door.ts'
import type { NodeSetupView } from '../../src/core/node-setup.ts'
import { type DeviceView, deviceIdFromHost } from '../../src/core/nodes.ts'
import { serveBoard, unusedPort } from '../support/board-server.ts'
import { fakeRoot, sh } from '../support/fake-root.ts'
import { fakeSshBin } from '../support/fake-ssh-bin.ts'
import { nodeBoard, PAIR_ENV } from '../support/node-pair.ts'
import { sandbox } from '../support/sandbox.ts'
import { routeTable, stateFolder } from '../support/tunnel-board.ts'

const SLOW = 900_000
const MASTERS = '/home/agent-board/.local/state/herdr/plugins/agent-board/node/masters.json'
const HELLO = JSON.stringify({ api: 1, version: '0.0.0', node: { api: NODE_API, id: 'server-1', claimed: true } })
const configOf = (box: { env: Record<string, string> }): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')

const post = (url: string, body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
  fetch(`${url}/api/nodes/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
const view = async (url: string): Promise<NodeSetupView> =>
  (await (await fetch(`${url}/api/nodes/setup`)).json()) as NodeSetupView

describe('without nodes', () => {
  test("Settings can add the first server: the form's routes answer on this board, are in no route table, ask the panel's header, and nothing of them runs until asked", async () => {
    const box = await sandbox()
    const bin = await fakeSshBin()
    const log = join(box.dir, 'ssh-calls.jsonl')
    const { url, proc } = await serveBoard(
      box,
      { language: 'en' },
      {
        TEST_ROUTE_TABLE: '1',
        BOARD_SSH_BIN_PATH: bin,
        BOARD_SSH_KEYGEN_BIN_PATH: bin,
        FAKE_SSH_LOG: log,
      },
    )
    // the table every remote listener and a node's door serve has nothing of it
    expect(routeTable(proc).filter(r => r.path.includes('nodes'))).toEqual([])
    const payload = async (): Promise<string[]> =>
      Object.keys((await (await fetch(`${url}/api/board`)).json()) as object).sort()
    const keys = await payload()
    expect(keys).not.toContain('devices')
    expect((await fetch(`${url}/api/nodes`)).status).toBe(404)
    // the form opened: its view, and still no ssh, no file, no payload field
    const v = await view(url)
    expect(v.phase).toBe('idle')
    expect(v.master).toEqual([])
    expect(existsSync(log)).toBe(false)
    expect(existsSync(join(stateFolder(box), 'nodes'))).toBe(false)
    expect(await payload()).toEqual(keys)
    // writes are the panel's: X-Board, and no other site's Origin
    expect((await post(url, { op: 'cancel' }, {})).status).toBe(403)
    expect((await post(url, { op: 'cancel' }, { 'x-board': '1', origin: 'https://evil.example' })).status).toBe(403)
    expect(await (await post(url, { op: 'nope' })).json()).toEqual({ ok: false, error: 'op' })
    expect((await post(url, { op: 'look', host: '', user: 'admin' })).status).toBe(409)
    expect(existsSync(log)).toBe(false)
  }, 60_000)

  test("a node's door does not have the form's routes, with its master's token or without", async () => {
    const node = await nodeBoard('server-1')
    const door = `http://127.0.0.1:${node.doorPort}`
    for (const headers of [{}, { authorization: `Bearer ${node.token}` }]) {
      const get = await fetch(`${door}/api/nodes/setup`, { headers })
      expect(get.status).toBe(headers.authorization ? 404 : 401)
      const res = await fetch(`${door}/api/nodes/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1', ...headers },
        body: JSON.stringify({ op: 'look', host: 'ssh.example.com', user: 'admin' }),
      })
      expect(res.status).toBe(headers.authorization ? 404 : 401)
    }
  }, 60_000)
})

describe('Add a server, end to end', () => {
  test(
    'a board without nodes adds a server: Look and Apply on the fake root, nodes written here, the link through ssh, the first status, the thresholds and the first bundle, and the login left',
    async () => {
      const node = await nodeBoard('server-1')
      const root = fakeRoot('include', { node: true })
      writeFileSync(root.path('/state/hello'), HELLO)
      const bin = await fakeSshBin()
      const box = await sandbox()
      // the master's default profile: what the first bundle carries
      const profile = join(box.env.HOME as string, '.claude')
      mkdirSync(join(profile, 'skills', 'a'), { recursive: true })
      writeFileSync(join(profile, 'CLAUDE.md'), 'rules')
      writeFileSync(join(profile, 'skills', 'a', 'SKILL.md'), 'A')
      writeFileSync(join(profile, 'settings.json'), JSON.stringify({ model: 'opus' }))
      const sshState = join(box.dir, 'ssh-state.json')
      const sshLog = join(box.dir, 'ssh-calls.jsonl')
      writeFileSync(sshState, JSON.stringify({ admin: { root: { R: root.R, dir: root.path('') } } }))
      const port = await unusedPort()
      const cfg = {
        language: 'en',
        port,
        categories: [{ id: 'other', title: 'Other', color: 'gray' }],
        wakeUrl: null,
        refreshSec: 3600,
      }
      mkdirSync(join(configOf(box), '..'), { recursive: true })
      writeFileSync(configOf(box), JSON.stringify(cfg, null, 2))
      await serveBoard(box, cfg, {
        ...PAIR_ENV,
        TEST_LIVE_CONFIG: '1',
        BOARD_SSH_BIN_PATH: bin,
        BOARD_SSH_KEYGEN_BIN_PATH: bin,
        FAKE_SSH_STATE: sshState,
        FAKE_SSH_LOG: sshLog,
        REAL_BUN: process.execPath.replaceAll('\\', '/'),
        FAKE_SH: sh as string,
        // git for the archive of this checkout (the sandbox's PATH reaches only Bun)
        PATH: [dirname(process.execPath), dirname(Bun.which('git') as string)].join(delimiter),
        BOARD_NODE_SETUP_LINK_MS: '60000',
      })
      const url = `http://127.0.0.1:${port}`
      const lookRes = await post(url, { op: 'look', host: 'ssh.example.com', user: 'admin', port: node.doorPort })
      expect([lookRes.status, await lookRes.json()]).toEqual([200, { ok: true }])
      const looked = await view(url)
      expect(looked.phase).toBe('plan')
      expect(looked.hostKey?.pinnedNow).toBe(true)
      expect(looked.device).toEqual({ id: 'server-1', port: node.doorPort })
      // the run writes masters.json on the server: the node's board reads it from its own folder
      const nodeMasters = join(stateFolder(node.box), 'node', 'masters.json')
      let copied = false
      const copier = setInterval(() => {
        if (!copied && existsSync(root.path(MASTERS))) {
          copyFileSync(root.path(MASTERS), nodeMasters)
          copied = true
        }
      }, 25)
      try {
        expect((await post(url, { op: 'apply', plan: looked.plan?.id })).status).toBe(200)
        const end = Date.now() + SLOW
        let v = await view(url)
        while (v.phase !== 'done' && v.phase !== 'failed' && Date.now() < end) {
          await Bun.sleep(200)
          v = await view(url)
        }
        expect([
          v.phase,
          v.error,
          v.next,
          v.bundle?.why ?? null,
          v.master.find(s => s.state === 'fail') ?? null,
        ]).toEqual(['done', null, null, null, null])
        expect(v.run?.result).toBe('applied')
        // the placer, made with the links, may write the thresholds from the same first status first
        const states = v.master.map(s => `${s.id} ${s.state}`)
        expect(states.filter(s => !s.startsWith('thresholds '))).toEqual([
          'token ok',
          'key ok',
          'archive ok',
          'upload ok',
          'config ok',
          'link ok',
          'status ok',
          'bundle ok',
          v.login?.profiles.every(p => p.loggedIn === true) ? 'login ok' : 'login wait',
        ])
        expect(['thresholds ok', 'thresholds skip']).toContain(states[7] ?? '')
        expect(v.login?.device).toBe('server-1')
        expect(v.bundle).toMatchObject({ ok: true, why: null })
        // the node has the master's profile: its CLAUDE.md came with the first bundle
        expect(readFileSync(join(node.box.env.HOME as string, '.claude', 'CLAUDE.md'), 'utf8')).toBe('rules')
        // config.json: nodes made, the device linked by ssh as the link user, its thresholds from the status
        const written = JSON.parse(readFileSync(configOf(box), 'utf8')) as { nodes: Record<string, unknown> }
        expect(written.nodes).toMatchObject({
          id: deviceIdFromHost(hostname()),
          order: ['server-1', 'local'],
          whenFull: 'local',
          devices: {
            'server-1': {
              link: {
                kind: 'ssh',
                host: 'ssh.example.com',
                sshPort: 22,
                user: 'agent-board-link',
                port: node.doorPort,
              },
              maxLoad: 0.9,
            },
          },
        })
        expect(written.nodes).not.toHaveProperty('lanes')
        // the link is up through the fake ssh's forward, the node's payload in
        const devices = ((await (await fetch(`${url}/api/nodes`)).json()) as { devices: DeviceView[] }).devices
        expect(devices.map(d => [d.id, d.link?.state ?? null])).toEqual([
          ['server-1', 'online'],
          ['local', null],
        ])
        const calls = readFileSync(sshLog, 'utf8')
        expect(calls).toContain('"-L"')
        expect(calls).toContain('agent-board-link@ssh.example.com')
      } finally {
        clearInterval(copier)
      }
    },
    SLOW,
  )
})
