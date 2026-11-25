// End-to-end guided master handover tests (#697) using real sandbox board processes (nodePair).

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFile } from '../../src/adapters/config-file.ts'
import { openDb } from '../../src/adapters/db.ts'
import {
  makeEphemeralKey,
  readHandoverState,
  takeLocalBackup,
  writeHandoverState,
} from '../../src/adapters/handover-store.ts'
import { openJournalDb } from '../../src/adapters/journal-store.ts'
import { createThread } from '../../src/adapters/work-thread-store.ts'
import type { HandoverPlan } from '../../src/core/master-handover.ts'
import { ARCHIVE_COMMIT_FILE } from '../../src/core/node-texts.ts'
import { serveBoard, unusedPort } from '../support/board-server.ts'
import { nodePair } from '../support/node-pair.ts'
import { sandbox } from '../support/sandbox.ts'
import { stateFolder } from '../support/tunnel-board.ts'

setDefaultTimeout(60_000)

const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)

const tempDirs: string[] = []
function withTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ab-ho-e2e-'))
  tempDirs.push(d)
  return d
}

function stampedPluginDir(commit: string): string {
  const d = withTempDir()
  writeFileSync(join(d, ARCHIVE_COMMIT_FILE), `${commit}\n`)
  return d
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

async function runCli(
  env: Record<string, string>,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, 'run', 'src/entrypoints/cli.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

async function waitNodesReady(url: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const res = await fetch(`${url}/api/nodes`).catch(() => null)
    if (res?.ok) return
    await Bun.sleep(25)
  }
  throw new Error(`${url}/api/nodes never came back after rollback`)
}

async function postJson(
  url: string,
  path: string,
  body: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, data }
}

function seedMasterState(stateDir: string, backupDir: string): void {
  mkdirSync(stateDir, { recursive: true })
  const prev = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = join(stateDir, '..', '..', '..')
  try {
    const db = openDb({ create: true })
    if (!db) throw new Error('openDb failed')
    db.write('user', tx => {
      createThread(tx, {
        lane: 'atlas',
        title: 'Guided master handover thread',
        status: 'next',
        author: { kind: 'session', key: 's-laptop', name: 'anna' },
        assignee: { kind: 'session', key: '@server-1:s-server-1', name: 'ben' },
        at: 1000,
      })
      tx.db
        .query(
          'INSERT INTO time_entries (id, client, project, description, tags, start, stop, date, by, at, changed, changed_by, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        )
        .run(
          't-ho-1',
          'atlas',
          'handover',
          'billable entry',
          '[]',
          1000,
          4600,
          '2026-11-24',
          JSON.stringify({ key: 's-laptop', name: 'anna' }),
          1000,
          1000,
          JSON.stringify({ key: '@server-1:s-server-1', name: 'ben' }),
        )
    })
    db.close()

    const jdb = openJournalDb(true)
    if (!jdb) throw new Error('openJournalDb failed')
    const recent = Date.now() - 10_000
    jdb.write('journal', tx => {
      tx.db
        .query('INSERT INTO moves (key, name, lane, kind, line, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('s-laptop', 'anna', 'atlas', 'start', 'working', recent)
      tx.db
        .query('INSERT INTO last_state (key, kind, line, name, lane, at, gone) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run('@server-1:s-server-1', 'idle', '', 'ben', 'atlas', recent + 1000)
    })
    jdb.close()
  } finally {
    if (prev === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = prev
  }

  writeFileSync(
    join(stateDir, 'access.json'),
    JSON.stringify({ passwordHash: '$argon2id$demo', totp: null, userId: null, lockout: { failures: 0, until: null } }),
    { mode: 0o600 },
  )
  writeFileSync(join(stateDir, 'team-key.json'), JSON.stringify({ v: 1, pkcs8: 'pk', pub: 'pb' }), { mode: 0o600 })
  mkdirSync(join(stateDir, 'calendar', 'secret'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(stateDir, 'calendar', 'secret', 'team.json'),
    JSON.stringify({ url: 'https://cal.example.com/feed.ics' }),
    { mode: 0o600 },
  )
  mkdirSync(join(stateDir, 'thread-files', 'tr1'), { recursive: true })
  writeFileSync(join(stateDir, 'thread-files', 'tr1', 'spec.txt'), 'handover spec')
  mkdirSync(join(stateDir, 'schedule'), { recursive: true })
  writeFileSync(
    join(stateDir, 'schedule', '112233.json'),
    JSON.stringify({ id: '112233', key: '@server-1:s-server-1', next: 9999999999999, text: 'check deploy' }),
  )
  mkdirSync(join(stateDir, 'tunnel'), { recursive: true })
  writeFileSync(join(stateDir, 'tunnel', 'id_ed25519'), 'TUNNEL-PRIV', { mode: 0o600 })
  mkdirSync(join(stateDir, 'backup'), { recursive: true })
  mkdirSync(backupDir, { recursive: true })
}

describe('services/nodes/handover e2e (#697)', () => {
  test('dry-run, full handover, verification, and two-device rollback round trip with all state intact', async () => {
    const masterBackupDir = withTempDir()
    const targetBackupDir = withTempDir()
    const pluginDir = stampedPluginDir(COMMIT_A)
    const pair = await nodePair({
      count: 1,
      env: { BOARD_TEST_PLUGIN_ROOT: pluginDir },
      masterCfg: {
        threads: true,
        time: true,
        journal: true,
        backup: { folder: masterBackupDir },
        categories: [{ id: 'atlas', title: 'Atlas', color: 'blue', paths: [] }],
        wake: { enabled: false, telegram: 'auto', port: 12421 },
      },
      nodeCfg: () => ({
        backup: { folder: targetBackupDir },
        wake: { enabled: false, port: 12429, reaper: { enabled: false, idleMinutes: 45 } },
      }),
      masterSetup: box => {
        seedMasterState(stateFolder(box), masterBackupDir)
      },
    })

    await pair.waitDevice('server-1', d => d.link?.state === 'online')
    const [node] = pair.nodes
    if (!node) throw new Error('expected server-1')
    const reverseDoorPort = await unusedPort()

    // 1. Dry run inspects everything and mutates nothing on either side
    const dry = await postJson(pair.master.url, '/api/nodes/handover', {
      op: 'check',
      to: 'server-1',
      nodePort: reverseDoorPort,
    })
    expect(dry.status).toBe(200)
    expect(dry.data.ok).toBe(true)
    const plan = dry.data.plan as HandoverPlan
    expect(plan.ok).toBe(true)
    expect(plan.from).toBe('laptop')
    expect(plan.to).toBe('server-1')
    expect(plan.rekey.dbChanges).toBeGreaterThan(0)
    expect(plan.rekey.scheduleEntries).toBe(1)
    expect(existsSync(join(stateFolder(node.box), 'board.db'))).toBe(false)

    // 2. Full guided handover
    const run = await postJson(pair.master.url, '/api/nodes/handover', {
      op: 'run',
      to: 'server-1',
      nodePort: reverseDoorPort,
    })
    expect(run.status).toBe(200)
    expect(run.data.ok).toBe(true)

    // New master (server-1) now serves /api/nodes and sees laptop online!
    const deadline = Date.now() + 5000
    let laptopView: { id: string; title?: string; link?: { state: string } } | undefined
    while (Date.now() < deadline) {
      const r = await fetch(`${node.url}/api/nodes`)
      if (r.ok) {
        const j = (await r.json()) as { devices: { id: string; title?: string; link?: { state: string } }[] }
        laptopView = j.devices.find(d => d.id === 'laptop')
        if (laptopView?.link?.state === 'online') break
      }
      await Bun.sleep(50)
    }
    expect(laptopView?.link?.state).toBe('online')
    expect(laptopView?.title).toBe((await import('node:os')).hostname())
    expect(laptopView?.title).not.toBe('local')

    // Old master (laptop) is no longer a master (/api/nodes -> 404), retired schedule/watch files,
    // and stripped master-only keys from config.json (Item 2).
    expect((await fetch(`${pair.master.url}/api/nodes`)).status).toBe(404)
    expect(existsSync(join(stateFolder(pair.master.box), 'schedule', '112233.json'))).toBe(false)
    const oldCfgOnDisk = JSON.parse(
      readFileSync(
        join(pair.master.box.env.APPDATA ?? '', 'herdr', 'plugins', 'config', 'agent-board', 'config.json'),
        'utf8',
      ),
    ) as Record<string, unknown>
    expect(oldCfgOnDisk.nodes).toBeUndefined()
    expect(oldCfgOnDisk.threads).toBeUndefined()
    expect(oldCfgOnDisk.time).toBeUndefined()
    expect(oldCfgOnDisk.team).toBeUndefined()

    // Verify rekeyed DB, time, journal, access, team, calendar secret, tunnel key, schedule, thread-files on server-1
    const nodeState = stateFolder(node.box)
    const sql = new Database(join(nodeState, 'board.db'), { readonly: true, strict: true })
    const th = sql.query('SELECT created_by, assignee FROM threads').get() as { created_by: string; assignee: string }
    expect(JSON.parse(th.created_by).key).toBe('@laptop:s-laptop')
    expect(JSON.parse(th.assignee).key).toBe('s-server-1')
    const te = sql.query('SELECT id, description FROM time_entries').get() as { id: string; description: string }
    expect(te).toEqual({ id: 't-ho-1', description: 'billable entry' })
    sql.close(false)

    const jSql = new Database(join(nodeState, 'journal.db'), { readonly: true, strict: true })
    const jMove = jSql.query("SELECT key FROM moves WHERE key = '@laptop:s-laptop'").get() as { key: string } | null
    const jState = jSql.query("SELECT key FROM last_state WHERE key = 's-server-1'").get() as { key: string } | null
    expect(jMove?.key).toBe('@laptop:s-laptop')
    expect(jState?.key).toBe('s-server-1')
    jSql.close(false)

    expect(JSON.parse(readFileSync(join(nodeState, 'access.json'), 'utf8')).passwordHash).toBe('$argon2id$demo')
    expect(JSON.parse(readFileSync(join(nodeState, 'team-key.json'), 'utf8')).pub).toBe('pb')
    expect(JSON.parse(readFileSync(join(nodeState, 'calendar', 'secret', 'team.json'), 'utf8')).url).toBe(
      'https://cal.example.com/feed.ics',
    )
    expect(readFileSync(join(nodeState, 'tunnel', 'id_ed25519'), 'utf8')).toBe('TUNNEL-PRIV')
    expect(readFileSync(join(nodeState, 'thread-files', 'tr1', 'spec.txt'), 'utf8')).toBe('handover spec')
    expect(JSON.parse(readFileSync(join(nodeState, 'schedule', '112233.json'), 'utf8')).key).toBe('s-server-1')

    // Target (server-1) received wake.telegram: 'auto' while preserving its own wake settings (#748)
    const newMasterCfgOnDisk = JSON.parse(
      readFileSync(
        join(node.box.env.APPDATA ?? '', 'herdr', 'plugins', 'config', 'agent-board', 'config.json'),
        'utf8',
      ),
    ) as { wake?: Record<string, unknown> }
    expect(newMasterCfgOnDisk.wake).toEqual({
      enabled: false,
      port: 12429,
      reaper: { enabled: false, idleMinutes: 45 },
      telegram: 'auto',
    })

    // 3. Post-commit rollback requires explicit discardSinceCommit confirmation (Item 8)
    const rbRefused = await postJson(node.url, '/api/nodes/handover', { op: 'rollback' })
    expect(rbRefused.status).toBe(409)
    expect(String(rbRefused.data.error ?? '')).toContain('--discard-since-commit')

    // Confirmed two-device rollback from new master (server-1) restores both boards & retired schedule files
    const rb = await postJson(node.url, '/api/nodes/handover', { op: 'rollback', discardSinceCommit: true })
    expect(rb.status).toBe(200)
    expect(rb.data.ok).toBe(true)

    // Old master (laptop) is master again and reconnects to server-1 with original token
    await waitNodesReady(pair.master.url)
    await pair.waitDevice('server-1', d => d.link?.state === 'online')
    expect((await fetch(`${node.url}/api/nodes`)).status).toBe(404)
    expect(existsSync(join(nodeState, 'board.db'))).toBe(false)
    expect(existsSync(join(stateFolder(pair.master.box), 'board.db'))).toBe(true)
    expect(existsSync(join(stateFolder(pair.master.box), 'schedule', '112233.json'))).toBe(true)
    const targetCfgPath = join(node.box.env.APPDATA ?? '', 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
    expect(existsSync(targetCfgPath)).toBe(false)
  })

  test('preflight refuses offline target, missing backup, self-backup, and missing reverse link', async () => {
    const pluginDir = stampedPluginDir(COMMIT_A)
    const pair = await nodePair({
      count: 1,
      env: { BOARD_TEST_PLUGIN_ROOT: pluginDir },
      nodeCfg: () => ({
        backup: { server: { host: '127.0.0.1', port: 22, admin: { user: 'u', key: '' }, set: '2026-11-01' } },
      }),
    })
    await pair.waitDevice('server-1', d => d.link?.state === 'online')

    // Self-backup refusal
    const selfRes = await postJson(pair.master.url, '/api/nodes/handover', { op: 'check', to: 'server-1' })
    expect(selfRes.status).toBe(200)
    const selfPlan = selfRes.data.plan as HandoverPlan
    expect(selfPlan.ok).toBe(false)
    expect(selfPlan.checks.find(c => c.id === 'backup')?.ok).toBe(false)

    // Missing reverse link when overriding with invalid spec
    const badRev = await postJson(pair.master.url, '/api/nodes/handover', {
      op: 'check',
      to: 'server-1',
      reverseLink: 'bad-spec',
    })
    expect((badRev.data.plan as HandoverPlan).ok).toBe(false)
    expect((badRev.data.plan as HandoverPlan).checks.find(c => c.id === 'reverseLink')?.ok).toBe(false)

    // Offline target refusal
    const [offNode] = pair.nodes
    if (!offNode) throw new Error('expected server-1')
    await offNode.proxy.cut('drop')
    await pair.waitDevice('server-1', d => d.link?.state !== 'online')
    const offRes = await postJson(pair.master.url, '/api/nodes/handover', { op: 'check', to: 'server-1' })
    expect((offRes.data.plan as HandoverPlan).ok).toBe(false)
    expect((offRes.data.plan as HandoverPlan).checks.find(c => c.id === 'online')?.ok).toBe(false)
  })

  test('multi-node handover re-pairs peer node with fresh token and unpairs old master', async () => {
    const targetBackupDir = withTempDir()
    const pluginDir = stampedPluginDir(COMMIT_A)
    const pair = await nodePair({
      count: 2,
      env: { BOARD_TEST_PLUGIN_ROOT: pluginDir },
      nodeCfg: id => (id === 'server-1' ? { backup: { folder: targetBackupDir } } : {}),
    })
    await pair.waitDevice('server-1', d => d.link?.state === 'online')
    await pair.waitDevice('server-2', d => d.link?.state === 'online')

    const reverseDoorPort = await unusedPort()
    const run = await postJson(pair.master.url, '/api/nodes/handover', {
      op: 'run',
      to: 'server-1',
      nodePort: reverseDoorPort,
    })
    expect(run.status).toBe(200)
    expect(run.data.ok).toBe(true)

    const [firstNode] = pair.nodes
    if (!firstNode) throw new Error('expected server-1')
    const newMasterUrl = firstNode.url
    const deadline = Date.now() + 5000
    let bothOnline = false
    while (Date.now() < deadline) {
      const r = await fetch(`${newMasterUrl}/api/nodes`)
      if (r.ok) {
        const j = (await r.json()) as { devices: { id: string; link?: { state: string } }[] }
        const lap = j.devices.find(d => d.id === 'laptop')
        const s2 = j.devices.find(d => d.id === 'server-2')
        if (lap?.link?.state === 'online' && s2?.link?.state === 'online') {
          bothOnline = true
          break
        }
      }
      await Bun.sleep(50)
    }
    expect(bothOnline).toBe(true)
  })

  test('preflight refuses commit mismatch between master and target', async () => {
    const targetBackupDir = withTempDir()
    const masterPlugin = stampedPluginDir(COMMIT_A)
    const targetPlugin = stampedPluginDir(COMMIT_B)
    const pair = await nodePair({
      count: 1,
      env: { BOARD_TEST_PLUGIN_ROOT: masterPlugin },
      nodeEnv: () => ({ BOARD_TEST_PLUGIN_ROOT: targetPlugin }),
      nodeCfg: () => ({ backup: { folder: targetBackupDir } }),
    })
    await pair.waitDevice('server-1', d => d.link?.state === 'online')

    const res = await postJson(pair.master.url, '/api/nodes/handover', { op: 'check', to: 'server-1' })
    expect(res.status).toBe(200)
    const plan = res.data.plan as HandoverPlan
    expect(plan.ok).toBe(false)
    expect(plan.checks.find(c => c.id === 'commit')?.ok).toBe(false)
  })

  test('automatic rollback restores both devices when live verification fails', async () => {
    const targetBackupDir = withTempDir()
    const pluginDir = stampedPluginDir(COMMIT_A)
    const pair = await nodePair({
      count: 1,
      env: { BOARD_TEST_PLUGIN_ROOT: pluginDir, BOARD_HANDOVER_VERIFY_MS: '500' },
      nodeCfg: () => ({ backup: { folder: targetBackupDir } }),
    })
    await pair.waitDevice('server-1', d => d.link?.state === 'online')

    const [node] = pair.nodes
    if (!node) throw new Error('expected server-1')
    node.proxy.intercept = async (method, path) => {
      if (method === 'POST' && path === '/api/node/handover/verify') {
        return new Response(
          JSON.stringify({ ok: false, checks: [{ name: 'threads', ok: false, detail: 'simulated fail' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return null
    }

    const reverseDoorPort = await unusedPort()
    const run = await postJson(pair.master.url, '/api/nodes/handover', {
      op: 'run',
      to: 'server-1',
      nodePort: reverseDoorPort,
    })
    expect(run.data.ok).toBe(false)
    expect(run.data.rolledBack).toBe(true)

    node.proxy.intercept = null
    // Old master remains master and server-1 reconnects online; target has no board.db left behind.
    await pair.waitDevice('server-1', d => d.link?.state === 'online')
    expect((await fetch(`${pair.master.url}/api/nodes`)).status).toBe(200)
    expect((await fetch(`${node.url}/api/nodes`)).status).toBe(404)
    expect(existsSync(join(stateFolder(node.box), 'board.db'))).toBe(false)
  })

  test('CLI master handover --dry-run, status, live handover, and rollback work against sandbox boards', async () => {
    const targetBackupDir = withTempDir()
    const pluginDir = stampedPluginDir(COMMIT_A)
    const pair = await nodePair({
      count: 1,
      env: { BOARD_TEST_PLUGIN_ROOT: pluginDir },
      nodeCfg: () => ({ backup: { folder: targetBackupDir } }),
    })
    await pair.waitDevice('server-1', d => d.link?.state === 'online')

    const [node0] = pair.nodes
    if (!node0) throw new Error('expected server-1')
    const masterPort = Number(new URL(pair.master.url).port)
    const nodePort = Number(new URL(node0.url).port)
    expect(masterPort).not.toBe(12422)
    expect(nodePort).not.toBe(12422)

    // Materialize config.json with the sandbox port inside the sandbox APPDATA dir only.
    const masterAppData = pair.master.box.env.APPDATA ?? ''
    const masterCfgFile = join(masterAppData, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
    mkdirSync(join(masterAppData, 'herdr', 'plugins', 'config', 'agent-board'), { recursive: true })
    writeFileSync(masterCfgFile, JSON.stringify({ ...pair.masterConfig, port: masterPort }))

    const nodeAppData = node0.box.env.APPDATA ?? ''
    const nodeCfgFile = join(nodeAppData, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
    mkdirSync(join(nodeAppData, 'herdr', 'plugins', 'config', 'agent-board'), { recursive: true })
    writeFileSync(
      nodeCfgFile,
      JSON.stringify({
        language: 'en',
        port: nodePort,
        node: { id: 'server-1', port: node0.doorPort, workRoot: node0.box.dir },
        backup: { folder: targetBackupDir },
      }),
    )

    const masterCliEnv = { ...pair.master.box.env, ...pair.env }
    const reverseDoorPort = await unusedPort()

    const dry = await runCli(masterCliEnv, [
      'master',
      'handover',
      '--to',
      'server-1',
      '--node-port',
      String(reverseDoorPort),
      '--dry-run',
    ])
    expect(dry.code).toBe(0)
    expect(dry.stdout).toContain('dry-run')
    expect(dry.stdout).toContain('laptop -> server-1')
    expect((await fetch(`${node0.url}/api/nodes`)).status).toBe(404)

    const live = await runCli(masterCliEnv, [
      'master',
      'handover',
      '--to',
      'server-1',
      '--node-port',
      String(reverseDoorPort),
    ])
    expect(live.code).toBe(0)
    expect(live.stdout).toContain('ok')
    expect(live.stdout).toContain('laptop -> server-1')

    // After commit, new master (server-1) serves `board master status` and `board master rollback`.
    const nodeCliEnv = { ...node0.box.env, ...pair.env }
    const st = await runCli(nodeCliEnv, ['master', 'status'])
    expect(st.code).toBe(0)
    expect(st.stdout).toContain('handover committed')
    expect(st.stdout).toContain('rollback available')

    const rbDenied = await runCli(nodeCliEnv, ['master', 'rollback'])
    expect(rbDenied.code).toBe(1)

    const rb = await runCli(nodeCliEnv, ['master', 'rollback', '--discard-since-commit'])
    expect(rb.code).toBe(0)
    expect(rb.stdout).toContain('rolled back handover')
    await waitNodesReady(pair.master.url)
    await pair.waitDevice('server-1', d => d.link?.state === 'online')
  })

  test('lost commit reply finishes old master forward without split-brain (Item 1)', async () => {
    const targetBackupDir = withTempDir()
    const pluginDir = stampedPluginDir(COMMIT_A)
    const pair = await nodePair({
      count: 1,
      env: { BOARD_TEST_PLUGIN_ROOT: pluginDir },
      nodeCfg: () => ({ backup: { folder: targetBackupDir } }),
    })
    await pair.waitDevice('server-1', d => d.link?.state === 'online')

    const [node] = pair.nodes
    if (!node) throw new Error('expected server-1')
    let commitCalls = 0
    let droppedCheckAfterCommit = false
    let retryAlreadyCommitted = false
    node.proxy.intercept = async (method, path, forward) => {
      if (method === 'POST' && path === '/api/node/handover/commit') {
        commitCalls++
        if (commitCalls === 1) {
          // Target receives and commits, but HTTP response is lost as 502 before master sees it.
          const real = await forward()
          expect(real.status).toBe(200)
          return new Response(JSON.stringify({ error: 'simulated reply loss' }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          })
        }
        const real = await forward()
        const body = (await real
          .clone()
          .json()
          .catch(() => null)) as { alreadyCommitted?: boolean } | null
        retryAlreadyCommitted = body?.alreadyCommitted === true
        return real
      }
      if (method === 'GET' && path === '/api/node/handover/check' && commitCalls === 1 && !droppedCheckAfterCommit) {
        droppedCheckAfterCommit = true
        return new Response(JSON.stringify({ error: 'simulated probe blip' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      }
      return null
    }

    const reverseDoorPort = await unusedPort()
    const run = await postJson(pair.master.url, '/api/nodes/handover', {
      op: 'run',
      to: 'server-1',
      nodePort: reverseDoorPort,
    })
    expect(run.status).toBe(200)
    expect(run.data.ok).toBe(true)
    expect(commitCalls).toBe(2)
    expect(retryAlreadyCommitted).toBe(true)
    expect((await fetch(`${pair.master.url}/api/nodes`)).status).toBe(404)
    await waitNodesReady(node.url)
  })

  test('write freeze blocks API writes, old-master rollback keeps board.db & clears node/, and node rejects out-of-order steps (Items 3, 4)', async () => {
    const masterBackupDir = withTempDir()
    const targetBackupDir = withTempDir()
    const pluginDir = stampedPluginDir(COMMIT_A)
    const pair = await nodePair({
      count: 1,
      env: { BOARD_TEST_PLUGIN_ROOT: pluginDir, BOARD_HANDOVER_VERIFY_MS: '500' },
      masterCfg: { threads: true, backup: { folder: masterBackupDir } },
      nodeCfg: () => ({ backup: { folder: targetBackupDir } }),
      masterSetup: box => seedMasterState(stateFolder(box), masterBackupDir),
    })
    await pair.waitDevice('server-1', d => d.link?.state === 'online')

    const [node] = pair.nodes
    if (!node) throw new Error('expected server-1')

    // Item 4: node door rejects out-of-order apply / commit / rollback when not prepared
    const doorAuth = {
      'content-type': 'application/json',
      authorization: `Bearer ${node.token}`,
      'x-board': '1',
    }
    const noApply = await fetch(`http://127.0.0.1:${node.doorPort}/api/node/handover/apply`, {
      method: 'POST',
      headers: doorAuth,
      body: JSON.stringify({
        id: 'ho-fake-1',
        key: makeEphemeralKey(Date.now()),
        oldConfig: {},
        flippedNodes: {},
      }),
    })
    expect(noApply.status).toBe(409)
    const noCommit = await fetch(`http://127.0.0.1:${node.doorPort}/api/node/handover/commit`, {
      method: 'POST',
      headers: doorAuth,
      body: JSON.stringify({ id: 'ho-fake-1' }),
    })
    expect(noCommit.status).toBe(409)
    const noRb = await fetch(`http://127.0.0.1:${node.doorPort}/api/node/handover/rollback`, {
      method: 'POST',
      headers: doorAuth,
      body: JSON.stringify({ id: 'ho-fake-1' }),
    })
    expect(noRb.status).toBe(409)

    // Item 3: while handover is frozen, POST writes on master return 503 handover-frozen
    let writeStatusDuringFreeze = 0
    node.proxy.intercept = async (method, path) => {
      if (method === 'POST' && path === '/api/node/handover/verify') {
        if (writeStatusDuringFreeze === 0) {
          const w = await postJson(pair.master.url, '/api/threads', { lane: 'atlas', title: 'Blocked write' })
          writeStatusDuringFreeze = w.status
        }
        return new Response(
          JSON.stringify({ ok: false, checks: [{ name: 'threads', ok: false, detail: 'simulated fail' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return null
    }

    const reverseDoorPort = await unusedPort()
    const run = await postJson(pair.master.url, '/api/nodes/handover', {
      op: 'run',
      to: 'server-1',
      nodePort: reverseDoorPort,
    })
    expect(run.data.ok).toBe(false)
    expect(run.data.rolledBack).toBe(true)
    expect(writeStatusDuringFreeze).toBe(503)

    // Auto-rollback preserved old master board.db and cleaned stale node/masters.json
    expect(existsSync(join(stateFolder(pair.master.box), 'node', 'masters.json'))).toBe(false)
    const oldSql = new Database(join(stateFolder(pair.master.box), 'board.db'), { readonly: true, strict: true })
    const row = oldSql.query('SELECT title FROM threads').get() as { title: string } | null
    oldSql.close(false)
    expect(row?.title).toBe('Guided master handover thread')
  })

  test('boot crash recovery reverts incomplete target to node and keeps crashed old-master frozen (Item 5)', async () => {
    const withBoxEnv = <T>(env: Record<string, string>, fn: () => T): T => {
      const prev = new Map<string, string | undefined>()
      for (const k of Object.keys(env)) {
        prev.set(k, process.env[k])
        process.env[k] = env[k]
      }
      try {
        return fn()
      } finally {
        for (const [k, v] of prev) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      }
    }

    // 1. Target crashed in phase: applied -> boot recovers back to pure node
    const targetBox = await sandbox()
    const targetNodePort = await unusedPort()
    const targetCfg = {
      language: 'en',
      node: { id: 'server-1', port: targetNodePort, workRoot: targetBox.dir },
    }
    withBoxEnv(targetBox.env, () => {
      const cfgPath = configFile()
      mkdirSync(join(cfgPath, '..'), { recursive: true })
      writeFileSync(cfgPath, JSON.stringify(targetCfg))
      takeLocalBackup('ho-crash-t', 1000)
      writeFileSync(
        cfgPath,
        JSON.stringify({
          language: 'en',
          threads: true,
          nodes: { id: 'server-1', order: ['local'], devices: { local: {} } },
          node: { id: 'server-1', port: targetNodePort, workRoot: targetBox.dir },
        }),
      )
      writeHandoverState({
        v: 1,
        id: 'ho-crash-t',
        role: 'new-master',
        phase: 'applied',
        from: 'laptop',
        to: 'server-1',
        peerId: 'laptop',
        otherNodes: [],
        at: 1000,
      })
    })
    const targetSrv = await serveBoard(targetBox, targetCfg, { TEST_LIVE_CONFIG: '1' })
    expect((await fetch(`${targetSrv.url}/api/nodes`)).status).toBe(404)
    expect(existsSync(join(stateFolder(targetBox), 'board.db'))).toBe(false)

    // 2. Old master crashed in phase: prepared -> boot keeps writes frozen until rollback
    const oldBox = await sandbox()
    const oldCfg = {
      language: 'en',
      threads: true,
      nodes: { id: 'laptop', order: ['local'], devices: { local: {} } },
    }
    withBoxEnv(oldBox.env, () => {
      const cfgPath = configFile()
      mkdirSync(join(cfgPath, '..'), { recursive: true })
      writeFileSync(cfgPath, JSON.stringify(oldCfg))
      takeLocalBackup('ho-crash-m', 1000)
      writeHandoverState({
        v: 1,
        id: 'ho-crash-m',
        role: 'old-master',
        phase: 'prepared',
        from: 'laptop',
        to: 'server-1',
        peerId: 'server-1',
        otherNodes: [],
        at: 1000,
      })
    })
    const oldSrv = await serveBoard(oldBox, oldCfg, { TEST_LIVE_CONFIG: '1' })
    const blocked = await postJson(oldSrv.url, '/api/categories', { title: 'Test', color: 'blue', paths: [] })
    expect(blocked.status).toBe(503)
    const rb = await postJson(oldSrv.url, '/api/nodes/handover', { op: 'rollback' })
    expect(rb.status).toBe(200)
    expect(rb.data.ok).toBe(true)
    withBoxEnv(oldBox.env, () => {
      expect(readHandoverState()?.phase).toBe('rolled-back')
    })
  })

  test('dead commit and dead probe retry with backoff and stay frozen without finalizing blind (#697)', async () => {
    const targetBackupDir = withTempDir()
    const pluginDir = stampedPluginDir(COMMIT_A)
    const pair = await nodePair({
      count: 1,
      env: { BOARD_TEST_PLUGIN_ROOT: pluginDir },
      nodeCfg: () => ({ backup: { folder: targetBackupDir } }),
    })
    await pair.waitDevice('server-1', d => d.link?.state === 'online')

    const [node] = pair.nodes
    if (!node) throw new Error('expected server-1')
    let verifySeen = false
    let commitCalls = 0
    let probeCalls = 0
    node.proxy.intercept = async (method, path) => {
      if (method === 'POST' && path === '/api/node/handover/verify') {
        verifySeen = true
        return null
      }
      if (!verifySeen) return null
      if (method === 'POST' && path === '/api/node/handover/commit') {
        commitCalls++
        return new Response(JSON.stringify({ error: 'commit link dead' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (method === 'GET' && path === '/api/node/handover/check') {
        probeCalls++
        return new Response(JSON.stringify({ error: 'probe link dead' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      }
      return null
    }

    const reverseDoorPort = await unusedPort()
    const run = await postJson(pair.master.url, '/api/nodes/handover', {
      op: 'run',
      to: 'server-1',
      nodePort: reverseDoorPort,
    })
    expect(run.status).toBe(409)
    expect(run.data.ok).toBe(false)
    expect(run.data.rolledBack).toBe(false)
    expect(String(run.data.error ?? '')).toContain('write-frozen')
    expect(String(run.data.error ?? '')).toContain('board master status')
    expect(commitCalls).toBe(4)
    expect(probeCalls).toBe(4)

    // Old master must NOT finalize blind and must stay write-frozen.
    expect((await fetch(`${pair.master.url}/api/nodes`)).status).toBe(200)
    const blocked = await postJson(pair.master.url, '/api/categories', { title: 'Frozen', color: 'blue', paths: [] })
    expect(blocked.status).toBe(503)

    // Target never received commit, so it remained in phase: applied.
    const nodeState = JSON.parse(readFileSync(join(stateFolder(node.box), 'handover', 'state.json'), 'utf8')) as {
      role: string
      phase: string
    }
    expect(nodeState.role).toBe('new-master')
    expect(nodeState.phase).toBe('applied')

    // Operator can still explicitly roll back the frozen old master locally.
    const rb = await postJson(pair.master.url, '/api/nodes/handover', { op: 'rollback', localOnly: true })
    expect(rb.status).toBe(200)
    expect(rb.data.ok).toBe(true)
    const afterRb = await postJson(pair.master.url, '/api/categories', { title: 'Unfrozen', color: 'blue', paths: [] })
    expect(afterRb.status).not.toBe(503)
  })

  test('old master writes committed before unpair loop so rollback and crash-reboot stay frozen next to committed target (#697)', async () => {
    const b1 = withTempDir()
    const b2 = withTempDir()
    const pluginDir = stampedPluginDir(COMMIT_A)
    const pair = await nodePair({
      count: 2,
      env: { BOARD_TEST_PLUGIN_ROOT: pluginDir },
      nodeCfg: id => ({ backup: { folder: id === 'server-1' ? b1 : b2 } }),
    })
    await pair.waitDevice('server-1', d => d.link?.state === 'online')
    await pair.waitDevice('server-2', d => d.link?.state === 'online')

    const [, node2] = pair.nodes
    if (!node2) throw new Error('expected server-2')
    let releaseUnpair!: () => void
    const unpairStarted = new Promise<void>(resolve => {
      const hold = new Promise<void>(r => {
        releaseUnpair = r
      })
      node2.proxy.intercept = async (method, path) => {
        if (method === 'POST' && path === '/api/node/handover/unpair') {
          resolve()
          await hold
        }
        return null
      }
    })

    const reverseDoorPort = await unusedPort()
    const runPromise = postJson(pair.master.url, '/api/nodes/handover', {
      op: 'run',
      to: 'server-1',
      nodePort: reverseDoorPort,
    })

    await unpairStarted
    // Before unpair finishes, old-master state on disk is already 'committed'.
    const midState = JSON.parse(readFileSync(join(stateFolder(pair.master.box), 'handover', 'state.json'), 'utf8')) as {
      role: string
      phase: string
      peerId: string
    }
    expect(midState.role).toBe('old-master')
    expect(midState.phase).toBe('committed')
    expect(midState.peerId).toBe('server-1')

    releaseUnpair()
    const run = await runPromise
    expect(run.status).toBe(200)
    expect(run.data.ok).toBe(true)

    // Simulate crash during that window (state = old-master committed while config still has nodes):
    // boot keeps writes frozen and refuses unconfirmed local rollback.
    const crashBox = await sandbox()
    const crashCfg = {
      language: 'en',
      threads: true,
      nodes: { id: 'laptop', order: ['local'], devices: { local: {} } },
    }
    const prev = new Map<string, string | undefined>()
    for (const k of Object.keys(crashBox.env)) {
      prev.set(k, process.env[k])
      process.env[k] = crashBox.env[k]
    }
    try {
      const cfgPath = configFile()
      mkdirSync(join(cfgPath, '..'), { recursive: true })
      writeFileSync(cfgPath, JSON.stringify(crashCfg))
      takeLocalBackup('ho-crash-comm', 1000)
      writeHandoverState({
        v: 1,
        id: 'ho-crash-comm',
        role: 'old-master',
        phase: 'committed',
        from: 'laptop',
        to: 'server-1',
        peerId: 'server-1',
        otherNodes: ['server-2'],
        at: 1000,
      })
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
    const crashSrv = await serveBoard(crashBox, crashCfg, { TEST_LIVE_CONFIG: '1' })
    const blocked = await postJson(crashSrv.url, '/api/categories', { title: 'StillFrozen', color: 'blue', paths: [] })
    expect(blocked.status).toBe(503)
    const rbRefused = await postJson(crashSrv.url, '/api/nodes/handover', { op: 'rollback' })
    expect(rbRefused.status).toBe(409)
    expect(rbRefused.data.ok).toBe(false)
  })

  test('plain standalone board without nodes or node is completely untouched by handover', async () => {
    const box = await sandbox()
    const { url } = await serveBoard(box, { language: 'en' })
    expect((await fetch(`${url}/api/nodes/handover`)).status).toBe(404)
    expect((await postJson(url, '/api/nodes/handover', { op: 'check', to: 'server-1' })).status).toBe(405)
    expect((await fetch(`${url}/api/node/handover/check`)).status).toBe(404)
    expect(existsSync(join(stateFolder(box), 'handover'))).toBe(false)
  })
})
