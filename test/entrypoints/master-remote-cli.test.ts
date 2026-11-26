// Master CLI acting on node sessions (#930): board archive, sleep, move, fork, restart,
// card ops (doing, wait, ask, done, clear, favorite, cat, show) and remind resolve sessions across
// the master and paired nodes and route node actions through the master's board proxy.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nodePair, PAIR_ENV } from '../support/node-pair.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

const MASTER_ID = 'master-1'
const LAPTOP = 'laptop'
const LOCAL_SID = 'aaaaaaaa-0000-4000-8000-000000000001'
const NODE_SID = 'bbbbbbbb-0000-4000-8000-000000000002'
const SHARED_LOCAL_SID = 'cccccccc-0000-4000-8000-000000000003'
const SHARED_NODE_SID = 'dddddddd-0000-4000-8000-000000000004'
const UNICODE_SID = 'eeeeeeee-0000-4000-8000-000000000005'
const NODE_PANE_KEY = `@${LAPTOP}:pane-w2:p9`
const ME = '99999999-0000-4000-8000-000000000099'

const masterNodesConfig = {
  id: MASTER_ID,
  order: [LAPTOP, 'local'],
  devices: {
    [LAPTOP]: { title: 'Laptop', link: { kind: 'direct', url: 'http://127.0.0.1:1' } },
  },
}

const payloadItems = [
  {
    key: LOCAL_SID,
    session: LOCAL_SID,
    name: 'Master Worker',
    autoName: 'Master Worker',
    pane: 'w1:p1',
    cwd: '/srv/master',
    agent: 'claude',
    status: 'idle',
    sleeping: false,
    category: 'agent-board',
  },
  {
    key: `@${LAPTOP}:${NODE_SID}`,
    session: NODE_SID,
    name: 'Node Worker',
    autoName: 'Node Worker',
    device: LAPTOP,
    pane: 'w2:p1',
    cwd: 'C:\\Work\\repo',
    agent: 'claude',
    status: 'idle',
    sleeping: false,
    category: 'agent-board',
  },
  {
    key: SHARED_LOCAL_SID,
    session: SHARED_LOCAL_SID,
    name: 'Shared Name',
    autoName: 'Shared Name',
    pane: 'w1:p2',
    cwd: '/srv/shared',
    agent: 'claude',
    status: 'idle',
    sleeping: false,
    category: 'personal',
  },
  {
    key: `@${LAPTOP}:${SHARED_NODE_SID}`,
    session: SHARED_NODE_SID,
    name: 'Shared Name',
    autoName: 'Shared Name',
    device: LAPTOP,
    pane: 'w2:p2',
    cwd: 'C:\\Work\\shared',
    agent: 'claude',
    status: 'idle',
    sleeping: false,
    category: 'personal',
  },
  {
    key: `@${LAPTOP}:${UNICODE_SID}`,
    session: UNICODE_SID,
    name: 'Проба 100% node',
    autoName: 'Проба 100% node',
    device: LAPTOP,
    pane: 'w2:p3',
    cwd: 'C:\\Work\\проба',
    agent: 'claude',
    status: 'idle',
    sleeping: false,
    category: 'agent-board',
  },
  {
    key: NODE_PANE_KEY,
    session: null,
    name: 'Pane Only Node',
    autoName: 'Pane Only Node',
    device: LAPTOP,
    pane: 'w2:p9',
    cwd: 'C:\\Work\\pane',
    agent: 'codex',
    status: 'idle',
    sleeping: false,
    category: 'other',
  },
]

function standInMaster(
  opts: {
    archiveFail?: { key: string; error: string }
    offlineKey?: string
    sleepResults?: (targets: string[]) => Record<string, unknown>[]
    moveResults?: (targets: string[]) => Record<string, unknown>[]
  } = {},
) {
  const requests: { method: string; path: string; body: unknown }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const body: unknown = req.method === 'POST' ? await req.json().catch(() => null) : null
      requests.push({ method: req.method, path, body })
      if (req.method === 'GET' && path === '/api/board') {
        return Response.json({
          items: payloadItems,
          devices: [{ id: 'local', status: { id: MASTER_ID } }],
          profiles: [],
        })
      }
      if (req.method === 'POST' && path === '/api/archive') {
        const b = (body ?? {}) as { keys?: string[] }
        const keys = b.keys ?? []
        if (opts.offlineKey && keys.includes(opts.offlineKey)) {
          return Response.json(
            { ok: false, done: [], failed: [{ key: opts.offlineKey, error: 'node-offline' }], error: 'node-offline' },
            { status: 409 },
          )
        }
        if (opts.archiveFail && keys.includes(opts.archiveFail.key)) {
          return Response.json(
            {
              ok: false,
              done: [],
              failed: [{ key: opts.archiveFail.key, error: opts.archiveFail.error }],
              error: opts.archiveFail.error,
            },
            { status: 409 },
          )
        }
        return Response.json({
          ok: true,
          done: keys.map(k => ({
            key: k,
            name: payloadItems.find(i => i.key === k)?.name ?? k,
            held: 0,
            closed: true,
          })),
          failed: [],
        })
      }
      if (req.method === 'POST' && path === '/api/sleep') {
        const b = (body ?? {}) as { targets?: string[] }
        const targets = b.targets ?? []
        const results = opts.sleepResults
          ? opts.sleepResults(targets)
          : targets.map(t => ({
              target: t,
              key: t,
              name: payloadItems.find(i => i.key === t)?.name ?? t,
              result: 'asleep',
            }))
        return Response.json({ ok: true, results })
      }
      if (req.method === 'POST' && path === '/api/move') {
        const b = (body ?? {}) as { targets?: string[]; device?: string }
        const targets = b.targets ?? []
        if (b.device !== undefined) {
          return Response.json({
            ok: true,
            results: targets.map(t => ({ target: t, result: 'moved', newKey: t })),
          })
        }
        const results = opts.moveResults
          ? opts.moveResults(targets)
          : targets.map(t => ({
              target: t,
              key: t,
              name: payloadItems.find(i => i.key === t)?.name ?? t,
              result: 'moved',
            }))
        return Response.json({ ok: true, results })
      }
      if (req.method === 'POST' && path.startsWith('/api/session/')) {
        if (path.endsWith('/fork')) return Response.json({ ok: true, name: 'Node Worker fork' })
        if (path.endsWith('/restart')) return Response.json({ ok: true, id: 'rst123' })
        if (path.endsWith('/card')) return Response.json({ ok: true })
      }
      return new Response(null, { status: 404 })
    },
  })
  return { port: server.port as number, requests, stop: () => server.stop(true) }
}

async function runCli(
  box: Sandbox,
  port: number,
  args: string[],
  cfgExtra: Record<string, unknown> = { nodes: masterNodesConfig },
  envExtra: Record<string, string> = {},
) {
  const dir = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'en', wakeUrl: null, port, ...cfgExtra }))
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), ...args], {
    cwd: root,
    env: { ...box.env, CLAUDE_CODE_SESSION_ID: ME, ...envExtra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: `${o}${e}`.trim() }
}

describe('master CLI acting on node sessions (#930)', () => {
  test('board archive --session finds a node session by name, Name [ref], prefixed key, bare UUID, bare pane key, and unicode/% name', async () => {
    const box = await sandbox()
    box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
    const board = standInMaster()
    try {
      const byName = await runCli(box, board.port, ['archive', '--session', 'Node Worker'])
      expect(byName).toEqual({
        code: 0,
        out: "ok · archived Node Worker (on node laptop): its pane is closed; the user can bring it back from the board's archive (Archive on the toolbar)",
      })

      const byRef = await runCli(box, board.port, [
        'archive',
        '--session',
        `Shared Name [${SHARED_NODE_SID.slice(0, 8)}]`,
      ])
      expect(byRef.code).toBe(0)

      const byPrefixed = await runCli(box, board.port, ['archive', '--session', `@${LAPTOP}:${NODE_SID}`])
      expect(byPrefixed.code).toBe(0)

      const byUuid = await runCli(box, board.port, ['archive', '--session', NODE_SID])
      expect(byUuid.code).toBe(0)

      const byBarePaneKey = await runCli(box, board.port, ['archive', '--session', 'pane-w2:p9'])
      expect(byBarePaneKey.code).toBe(0)

      const byUnicode = await runCli(box, board.port, ['archive', '--session', 'Проба 100% node'])
      expect(byUnicode.code).toBe(0)

      const archives = board.requests.filter(r => r.method === 'POST' && r.path === '/api/archive')
      expect(archives.map(r => r.body)).toEqual([
        { op: 'archive', keys: [`@${LAPTOP}:${NODE_SID}`], immediate: true },
        { op: 'archive', keys: [`@${LAPTOP}:${SHARED_NODE_SID}`], immediate: true },
        { op: 'archive', keys: [`@${LAPTOP}:${NODE_SID}`], immediate: true },
        { op: 'archive', keys: [`@${LAPTOP}:${NODE_SID}`], immediate: true },
        { op: 'archive', keys: [NODE_PANE_KEY], immediate: true },
        { op: 'archive', keys: [`@${LAPTOP}:${UNICODE_SID}`], immediate: true },
      ])
    } finally {
      board.stop()
    }
  }, 30_000)

  test('ambiguous names across master and node fail cleanly; unknown names still error; non-masters make zero /api/board calls', async () => {
    const box = await sandbox()
    box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
    const board = standInMaster()
    try {
      const clash = await runCli(box, board.port, ['archive', '--session', 'Shared Name'])
      expect(clash.code).toBe(1)
      expect(clash.out).toContain('fits more than one session')
      expect(clash.out).toContain(SHARED_LOCAL_SID.slice(0, 8))
      expect(clash.out).toContain(SHARED_NODE_SID.slice(0, 8))
      expect(board.requests.filter(r => r.path === '/api/archive')).toEqual([])

      const unknown = await runCli(box, board.port, ['archive', '--session', 'nobody'])
      expect(unknown).toEqual({ code: 1, out: 'board: no session "nobody" on the board' })

      // Non-master board (no `nodes` in config.json) goes straight down the old path with zero /api/board requests.
      const before = board.requests.length
      const standalone = await runCli(box, board.port, ['archive', '--session', 'Node Worker'], {})
      expect(standalone).toEqual({ code: 1, out: 'board: no session "Node Worker" on the board' })
      expect(board.requests.slice(before)).toEqual([])
    } finally {
      board.stop()
    }
  }, 30_000)

  test('offline node and refused archive report clear errors', async () => {
    const box = await sandbox()
    box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
    const board = standInMaster({
      offlineKey: `@${LAPTOP}:${NODE_SID}`,
      archiveFail: { key: `@${LAPTOP}:${UNICODE_SID}`, error: 'it is in the middle of a turn' },
    })
    try {
      const off = await runCli(box, board.port, ['archive', '--session', 'Node Worker'])
      expect(off).toEqual({
        code: 1,
        out: `board: Node Worker stays on the board: node "${LAPTOP}" is not reachable now`,
      })

      const kept = await runCli(box, board.port, ['archive', '--session', 'Проба 100% node'])
      expect(kept).toEqual({
        code: 1,
        out: 'board: Проба 100% node stays on the board: it is in the middle of a turn',
      })
    } finally {
      board.stop()
    }
  }, 30_000)

  test('sleep, move, fork, restart, card ops, and remind act on node sessions without writing local cards on the master', async () => {
    const box = await sandbox()
    box.state({
      'api snapshot': {
        result: {
          snapshot: {
            panes: [{ pane_id: 'w1:p1', agent: 'claude', agent_session: { value: LOCAL_SID }, cwd: box.dir }],
            tabs: [],
            workspaces: [],
          },
        },
      },
    })
    const board = standInMaster()
    try {
      const slept = await runCli(box, board.port, ['sleep', 'Node Worker', '--when-free'])
      expect(slept.code).toBe(0)
      expect(slept.out).toContain('ok · 1 put to sleep')
      expect(slept.out).toContain('Node Worker: asleep')

      const movedProfile = await runCli(box, board.port, ['move', 'Node Worker', '--profile', 'work', '--when-free'])
      expect(movedProfile.code).toBe(0)
      expect(movedProfile.out).toContain('ok · 1 moved to work')

      const movedDevice = await runCli(box, board.port, [
        'move',
        `Shared Name [${SHARED_NODE_SID.slice(0, 8)}]`,
        '--device',
        'local',
      ])
      expect(movedDevice.code).toBe(0)
      expect(movedDevice.out).toContain('ok · 1 moved to this computer')

      const forked = await runCli(box, board.port, ['fork', '--session', 'Node Worker', '--name', 'Forked', 'hello'])
      expect(forked.code).toBe(0)
      expect(forked.out).toContain('ok · fork "Node Worker fork" of Node Worker starts')

      const restarted = await runCli(box, board.port, ['restart', '--session', 'Node Worker', 'reload plugins'])
      expect(restarted.code).toBe(0)
      expect(restarted.out).toBe('ok · restart rst123 (on node laptop): once the session is free')

      expect((await runCli(box, board.port, ['show', '--session', 'Node Worker'])).out).toBe(
        'ok · agent-board (on node laptop)',
      )
      expect((await runCli(box, board.port, ['doing', '--session', 'Node Worker', 'running checks'])).out).toBe(
        'ok · agent-board · doing: running checks (on node laptop)',
      )
      expect((await runCli(box, board.port, ['wait', '--session', 'Node Worker', 'waiting for CI'])).out).toBe(
        'ok · agent-board · waiting: waiting for CI (on node laptop)',
      )
      expect((await runCli(box, board.port, ['ask', '--session', 'Node Worker', 'ship it?'])).out).toBe(
        'ok · agent-board · asks the user: ship it? (on node laptop)',
      )
      expect((await runCli(box, board.port, ['done', '--session', 'Node Worker', 'finished'])).out).toBe(
        'ok · agent-board · done: finished (on node laptop)',
      )
      expect((await runCli(box, board.port, ['clear', '--session', 'Node Worker'])).out).toBe(
        'ok · agent-board (on node laptop)',
      )
      expect((await runCli(box, board.port, ['favorite', '--session', 'Node Worker'])).out).toBe(
        'ok · agent-board · favorite (on node laptop)',
      )
      expect((await runCli(box, board.port, ['cat', '--session', 'Node Worker', 'personal'])).out).toBe(
        'ok · personal (on node laptop)',
      )

      const todoRefused = await runCli(box, board.port, ['todo', 'list', '--session', 'Node Worker'])
      expect(todoRefused).toEqual({
        code: 1,
        out: 'board: board todo --session is for sessions on this computer; run it in the session on node laptop',
      })
      const compactRefused = await runCli(box, board.port, ['compact', '--session', 'Node Worker'])
      expect(compactRefused).toEqual({
        code: 1,
        out: 'board: board compact --session is for sessions on this computer; run it in the session on node laptop',
      })

      const reminded = await runCli(box, board.port, ['remind', '--session', 'Node Worker', 'in', '10m', 'ping'])
      expect(reminded.code).toBe(0)
      expect(reminded.out).toContain('ok ·')
      const schedDir = join(stateFolder(box), 'schedule')
      const schedFiles = readdirSync(schedDir).filter(f => f.endsWith('.json'))
      expect(schedFiles.length).toBe(1)
      const entry = JSON.parse(readFileSync(join(schedDir, schedFiles[0] ?? ''), 'utf8')) as Record<string, unknown>
      expect(entry.key).toBe(`@${LAPTOP}:${NODE_SID}`)
      expect(entry.pane).toBeUndefined()

      // No stray local card files written on the master for the node session.
      expect(existsSync(box.cards) ? readdirSync(box.cards) : []).toEqual([])

      const nodeSessionPosts = board.requests
        .filter(
          r => r.method === 'POST' && r.path.startsWith(`/api/session/${encodeURIComponent(`@${LAPTOP}:${NODE_SID}`)}`),
        )
        .map(r => ({ path: r.path.replace(encodeURIComponent(`@${LAPTOP}:${NODE_SID}`), ':key'), body: r.body }))
      expect(nodeSessionPosts).toEqual([
        { path: '/api/session/:key/fork', body: { name: 'Forked', message: 'hello' } },
        { path: '/api/session/:key/restart', body: { text: 'reload plugins', by: 'agent' } },
        { path: '/api/session/:key/card', body: { doing: 'running checks', by: 'agent' } },
        { path: '/api/session/:key/card', body: { wait: 'waiting for CI', by: 'agent' } },
        { path: '/api/session/:key/card', body: { ask: 'ship it?', by: 'agent' } },
        { path: '/api/session/:key/card', body: { done: true, result: 'finished', by: 'agent' } },
        { path: '/api/session/:key/card', body: { clear: true, by: 'agent' } },
        { path: '/api/session/:key/card', body: { favorite: true } },
        { path: '/api/session/:key/card', body: { category: 'personal' } },
      ])
    } finally {
      board.stop()
    }
  }, 30_000)

  test('end-to-end with nodePair: board doing, done, and archive from master act on the node and close its pane', async () => {
    const RULE = '─'.repeat(40)
    const screen = ['● done', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'].join('\n')
    const pair = await nodePair({
      panes: (_id, box) => [
        {
          pane_id: 'wN:p1',
          agent: 'claude',
          agent_session: { value: NODE_SID },
          cwd: box.dir,
          terminal_title_stripped: 'Node Claude',
        },
      ],
      masterPanes: box => [{ pane_id: 'wM:p1', agent: 'claude', agent_session: { value: LOCAL_SID }, cwd: box.dir }],
      nodeSetup: (_id, box) => {
        const projDir = join(box.env.HOME as string, '.claude/projects', box.dir.replace(/[^a-zA-Z0-9]/g, '-'))
        mkdirSync(projDir, { recursive: true })
        writeFileSync(
          join(projDir, `${NODE_SID}.jsonl`),
          `${JSON.stringify({ type: 'user', cwd: box.dir, sessionId: NODE_SID, message: { role: 'user', content: 'hi' } })}\n`,
        )
        mkdirSync(box.cards, { recursive: true })
        writeFileSync(join(box.cards, `${NODE_SID}.json`), JSON.stringify({ key: NODE_SID, name: 'Node Claude' }))
      },
    })
    const [node] = pair.nodes
    if (!node) throw new Error('no node')
    const master = pair.master

    const paneObj = {
      pane_id: 'wN:p1',
      tab_id: 'wN:t1',
      workspace_id: 'wN',
      agent: 'claude',
      agent_session: { value: NODE_SID },
      agent_status: 'idle',
      cwd: node.box.dir,
      terminal_title_stripped: 'Node Claude',
      label: '',
    }
    node.box.state({
      'api snapshot': {
        result: { snapshot: { panes: [paneObj], tabs: [], workspaces: [{ workspace_id: 'wN', label: 'Work' }] } },
      },
      'pane get': {
        until: ['tab close', 'pane close'],
        // biome-ignore lint/suspicious/noThenProperty: fake herdr transitions after pane close
        then: { code: 'pane_not_found', error: 'no such pane' },
        result: { pane: paneObj },
      },
      'pane list': { result: { panes: [paneObj] } },
      'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: NODE_SID } } } },
      'agent read': { text: screen },
      'pane close': { result: null },
      'tab close': { result: null },
    })

    // Write the master's config.json (port + nodes) so cli.ts finds the running test server.
    const cfgDir = join(master.box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({ ...pair.masterConfig, port: Number(new URL(master.url).port) }),
    )

    // Wait until the master aggregate sees the node's session with its name.
    for (const deadline = Date.now() + 15_000; ; await Bun.sleep(50)) {
      const res = await fetch(`${master.url}/api/board`)
      const payload = (await res.json()) as { items?: { key?: string; name?: string }[] }
      if (payload.items?.some(i => i.key === `@server-1:${NODE_SID}` && i.name === 'Node Claude')) break
      if (Date.now() > deadline) throw new Error('master never received node item')
    }

    const cliOnMaster = async (args: string[]) => {
      const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/cli.ts'), ...args], {
        cwd: root,
        env: { ...master.box.env, ...PAIR_ENV, CLAUDE_CODE_SESSION_ID: LOCAL_SID },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      return { code: await proc.exited, out: `${o}${e}`.trim() }
    }

    const doing = await cliOnMaster(['doing', '--session', 'Node Claude', 'checking remote'])
    expect(doing.code, doing.out).toBe(0)
    expect(JSON.parse(readFileSync(join(node.box.cards, `${NODE_SID}.json`), 'utf8')).doing).toBe('checking remote')
    expect(existsSync(join(master.box.cards, `${NODE_SID}.json`))).toBe(false)

    const done = await cliOnMaster(['done', '--session', 'Node Claude', 'all set'])
    expect(done.code, done.out).toBe(0)
    expect(JSON.parse(readFileSync(join(node.box.cards, `${NODE_SID}.json`), 'utf8')).result).toBe('all set')

    const archived = await cliOnMaster(['archive', '--session', 'Node Claude'])
    expect(archived.code, archived.out).toBe(0)
    expect(archived.out).toContain('ok · archived Node Claude (on node server-1): its pane is closed')

    const nodeArchiveFile = join(stateFolder(node.box), 'archive', `${NODE_SID}.json`)
    expect(existsSync(nodeArchiveFile)).toBe(true)
    expect(JSON.parse(readFileSync(nodeArchiveFile, 'utf8')).state).toBe('archived')
    expect(existsSync(join(stateFolder(master.box), 'archive', `${NODE_SID}.json`))).toBe(false)
    expect(node.box.calls().some(c => (c[0] === 'tab' || c[0] === 'pane') && c[1] === 'close')).toBe(true)
  }, 30_000)
})
