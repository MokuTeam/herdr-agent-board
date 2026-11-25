import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessFile } from '../../src/adapters/access-store.ts'
import { keyFile } from '../../src/adapters/backup-store.ts'
import { calendarDir } from '../../src/adapters/calendar-cache.ts'
import { dbFile, openDb } from '../../src/adapters/db.ts'
import {
  applyHandoverFiles,
  checkBackupReadiness,
  collectMasterState,
  handoverBackupDir,
  makeEphemeralKey,
  rekeyJournalDb,
  restoreLocalBackup,
  retireShippedOldMasterState,
  sealHandoverBundle,
  sha256Hex,
  takeLocalBackup,
  unsealHandoverBundle,
} from '../../src/adapters/handover-store.ts'
import { journalFile, openJournalDb } from '../../src/adapters/journal-store.ts'
import { createNodeStore } from '../../src/adapters/node-store.ts'
import { teamKeyFile } from '../../src/adapters/paths.ts'
import { knownHostsFile } from '../../src/adapters/ssh.ts'
import { createThread } from '../../src/adapters/work-thread-store.ts'
import { HANDOVER_VERSION, type HandoverManifest } from '../../src/core/master-handover.ts'

const savedEnv = { ...process.env }
const tempDirs: string[] = []

function makeEnv(): { root: string; configDir: string; stateDir: string; backupDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'ab-ho-store-'))
  tempDirs.push(root)
  const configDir = join(root, 'cfg')
  const stateDir = join(root, 'state')
  const backupDir = join(root, 'backups')
  mkdirSync(join(configDir, 'herdr', 'plugins', 'config', 'agent-board'), { recursive: true })
  mkdirSync(join(stateDir, 'herdr', 'plugins', 'agent-board'), { recursive: true })
  mkdirSync(backupDir, { recursive: true })
  process.env.APPDATA = configDir
  process.env.LOCALAPPDATA = stateDir
  return {
    root,
    configDir: join(configDir, 'herdr', 'plugins', 'config', 'agent-board'),
    stateDir: join(stateDir, 'herdr', 'plugins', 'agent-board'),
    backupDir,
  }
}

afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
  while (tempDirs.length) {
    const d = tempDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
})

describe('adapters/handover-store (#697)', () => {
  test('collects, seals, unseals, applies with rekey, and rolls back cleanly', async () => {
    const env = makeEnv()

    // Seed old master state
    const cfgRaw = {
      language: 'en',
      threads: true,
      time: true,
      journal: true,
      nodes: {
        id: 'laptop',
        order: ['server-1', 'local'],
        devices: {
          'server-1': { link: { kind: 'direct', url: 'http://127.0.0.1:12430' } },
        },
      },
      tunnel: { on: true, host: 'srv.example.com', user: 'boardtunnel', key: join(env.root, 'custom-tunnel-key') },
    }
    writeFileSync(join(env.configDir, 'config.json'), JSON.stringify(cfgRaw))
    writeFileSync(join(env.root, 'custom-tunnel-key'), 'PRIVATE TUNNEL KEY', { mode: 0o600 })
    writeFileSync(join(env.root, 'custom-tunnel-key.pub'), 'ssh-ed25519 AAAA test')

    // DB: thread + time entry
    const db = openDb({ create: true })
    if (!db) throw new Error('openDb failed')
    db.write('user', tx => {
      createThread(tx, {
        lane: 'atlas',
        title: 'Move master',
        status: 'next',
        author: { kind: 'session', key: 'local-1', name: 'anna' },
        assignee: { kind: 'session', key: '@server-1:node-1', name: 'ben' },
        at: 1000,
      })
      tx.db
        .query(
          'INSERT INTO time_entries (id, client, project, description, tags, start, stop, date, by, at, changed, changed_by, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        )
        .run(
          'te-1',
          'atlas',
          'core',
          'handover prep',
          '[]',
          1000,
          2000,
          '2026-11-24',
          JSON.stringify({ key: 'local-1', name: 'anna' }),
          1000,
          1000,
          JSON.stringify({ key: '@server-1:node-1', name: 'ben' }),
        )
    })
    db.close()

    // Journal DB
    const jdb = openJournalDb(true)
    if (!jdb) throw new Error('openJournalDb failed')
    jdb.write('journal', tx => {
      tx.db
        .query('INSERT INTO moves (key, name, lane, kind, line, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('local-1', 'anna', 'atlas', 'start', 'working', 1000)
      tx.db
        .query('INSERT INTO last_state (key, kind, line, name, lane, at, gone) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run('@server-1:node-1', 'idle', '', 'ben', 'atlas', 2000)
    })
    jdb.close()

    // Secrets, access, team, calendar, schedule, thread-files
    writeFileSync(
      join(env.stateDir, 'access.json'),
      JSON.stringify({ passwordHash: 'h', totp: null, userId: null, lockout: { failures: 0, until: null } }),
      { mode: 0o600 },
    )
    writeFileSync(join(env.stateDir, 'team-key.json'), JSON.stringify({ v: 1, pkcs8: 'p', pub: 'u' }), { mode: 0o600 })
    mkdirSync(join(env.stateDir, 'calendar', 'secret'), { recursive: true, mode: 0o700 })
    writeFileSync(
      join(env.stateDir, 'calendar', 'secret', 'work.json'),
      JSON.stringify({ url: 'https://cal.example.com/a.ics' }),
      { mode: 0o600 },
    )
    mkdirSync(join(env.stateDir, 'thread-files', 't1'), { recursive: true })
    writeFileSync(join(env.stateDir, 'thread-files', 't1', 'note.txt'), 'attached note')
    mkdirSync(join(env.stateDir, 'schedule'), { recursive: true })
    writeFileSync(
      join(env.stateDir, 'schedule', 'aa11bb.json'),
      JSON.stringify({ id: 'aa11bb', key: '@server-1:node-1', next: 9999999999999, text: 'ping' }),
    )
    // Exclude token and ssh-pid.json from nodes/
    mkdirSync(join(env.stateDir, 'nodes', 'server-2'), { recursive: true })
    writeFileSync(join(env.stateDir, 'nodes', 'server-2', 'token'), 'secret-token-not-copied')
    writeFileSync(join(env.stateDir, 'nodes', 'server-2', 'ssh-pid.json'), '{"pid":123}')
    writeFileSync(join(env.stateDir, 'nodes', 'server-2', 'bundle.json'), '{"seq":1}')

    const collected = collectMasterState(cfgRaw, 'server-1', { pack: true })
    expect(collected.normalizedTunnelKey).toBe(true)
    const paths = collected.entries.map(e => e.path)
    expect(paths).toContain('board.db')
    expect(paths).toContain('journal.db')
    expect(paths).toContain('access.json')
    expect(paths).toContain('team-key.json')
    expect(paths).toContain('calendar/secret/work.json')
    expect(paths).toContain('tunnel/id_ed25519')
    expect(paths).toContain('thread-files/t1/note.txt')
    expect(paths).toContain('schedule/aa11bb.json')
    expect(paths).not.toContain('nodes/server-2/token')
    expect(paths).not.toContain('nodes/server-2/ssh-pid.json')

    const key = makeEphemeralKey()
    const manifest: HandoverManifest = {
      v: HANDOVER_VERSION,
      id: 'ho-test-1',
      from: 'laptop',
      to: 'server-1',
      createdAt: Date.now(),
      files: collected.entries,
      credentials: [{ id: 'laptop', token: 't'.repeat(43) }],
    }
    const sealed = sealHandoverBundle(manifest, collected.bodies, key)

    // Switch to a clean target sandbox
    const targetEnv = makeEnv()
    writeFileSync(
      join(targetEnv.configDir, 'config.json'),
      JSON.stringify({ language: 'en', node: { id: 'server-1', port: 12430 } }),
    )
    const nodeStore = createNodeStore({ dir: join(targetEnv.stateDir, 'node') })
    const origMaster = nodeStore.add('laptop', 'hand')

    // Take backup on target before applying
    takeLocalBackup('ho-test-1')

    const unpacked = unsealHandoverBundle(sealed, key)
    const applied = await applyHandoverFiles('ho-test-1', unpacked.manifest, unpacked.bodies)
    expect(applied.journalRekeyed).toEqual({ moves: 1, states: 1 })

    // Verify rekeyed DB and journal on target
    const targetSql = new Database(dbFile(), { readonly: true, strict: true })
    const threadRow = targetSql.query('SELECT created_by, assignee FROM threads').get() as {
      created_by: string
      assignee: string
    }
    expect(JSON.parse(threadRow.created_by).key).toBe('@laptop:local-1')
    expect(JSON.parse(threadRow.assignee).key).toBe('node-1')
    targetSql.close(false)

    const targetJ = new Database(join(targetEnv.stateDir, 'journal.db'), { readonly: true, strict: true })
    const moveRow = targetJ.query('SELECT key FROM moves').get() as { key: string }
    const stateRow = targetJ.query('SELECT key FROM last_state').get() as { key: string }
    expect(moveRow.key).toBe('@laptop:local-1')
    expect(stateRow.key).toBe('node-1')
    targetJ.close(false)

    const sched = JSON.parse(readFileSync(join(targetEnv.stateDir, 'schedule', 'aa11bb.json'), 'utf8')) as {
      key: string
    }
    expect(sched.key).toBe('node-1')
    expect(readFileSync(join(targetEnv.stateDir, 'thread-files', 't1', 'note.txt'), 'utf8')).toBe('attached note')

    // Rollback on target removes applied files and restores original node config + masters.json
    const rb = await restoreLocalBackup('ho-test-1')
    expect(rb.removed).toBeGreaterThan(0)
    expect(existsSync(dbFile())).toBe(false)
    expect(existsSync(join(targetEnv.stateDir, 'access.json'))).toBe(false)
    const restoredCfg = JSON.parse(readFileSync(join(targetEnv.configDir, 'config.json'), 'utf8')) as {
      node?: { id: string }
    }
    expect(restoredCfg.node?.id).toBe('server-1')
    expect(nodeStore.verify(origMaster.token)?.id).toBe(origMaster.master.id)
  })

  test('checkBackupReadiness detects missing, self-pointing, and valid folder backups', () => {
    const env = makeEnv()
    expect(checkBackupReadiness({}, ['server-1']).ok).toBe(false)

    const selfRes = checkBackupReadiness(
      { backup: { server: { host: '127.0.0.1', port: 22, admin: { user: 'u', key: '' }, set: '2026-11-01' } } },
      ['server-1', '127.0.0.1'],
    )
    expect(selfRes.ok).toBe(false)
    expect(selfRes.selfConflict).toBe('127.0.0.1')

    const folderRes = checkBackupReadiness({ backup: { folder: env.backupDir } }, ['server-1'])
    expect(folderRes.ok).toBe(true)
    expect(folderRes.target).toBe('folder')
  })

  test('rekeyJournalDb handles last_state primary key swap cycles cleanly', () => {
    const env = makeEnv()
    const jdb = openJournalDb(true)
    if (!jdb) throw new Error('openJournalDb failed')
    jdb.write('journal', tx => {
      tx.db
        .query('INSERT INTO last_state (key, kind, line, name, lane, at, gone) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run('s-1', 'working', 'a', 'anna', 'atlas', 100)
      tx.db
        .query('INSERT INTO last_state (key, kind, line, name, lane, at, gone) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run('@server-1:s-1', 'idle', 'b', 'ben', 'atlas', 200)
    })
    jdb.close()

    const r = rekeyJournalDb(join(env.stateDir, 'journal.db'), 'laptop', 'server-1')
    expect(r.states).toBe(2)
    const sql = new Database(join(env.stateDir, 'journal.db'), { readonly: true, strict: true })
    const rows = sql.query('SELECT key, name FROM last_state ORDER BY at').all() as { key: string; name: string }[]
    sql.close(false)
    expect(rows).toEqual([
      { key: '@laptop:s-1', name: 'anna' },
      { key: 's-1', name: 'ben' },
    ])
  })

  test('partial apply failure still cleans up already-written secrets via pre-recorded appliedFiles', async () => {
    const env = makeEnv()
    writeFileSync(join(env.configDir, 'config.json'), JSON.stringify({ node: { id: 'server-1', port: 12430 } }))
    takeLocalBackup('ho-partial', 1000)

    const bAccess = Buffer.from(JSON.stringify({ passwordHash: '$argon2id$x', totp: null }))
    const bTeam = Buffer.from(JSON.stringify({ v: 1, pkcs8: 'secret-pk', pub: 'pub' }))
    const bBlock = Buffer.from('blocked body')
    const manifest: HandoverManifest = {
      v: HANDOVER_VERSION,
      id: 'ho-partial',
      from: 'laptop',
      to: 'server-1',
      createdAt: 1000,
      files: [
        { path: 'access.json', category: 'access', size: bAccess.length, sha256: sha256Hex(bAccess), mode: 0o600 },
        { path: 'team-key.json', category: 'team', size: bTeam.length, sha256: sha256Hex(bTeam), mode: 0o600 },
        { path: 'blocked/sub/file.txt', category: 'threadFiles', size: bBlock.length, sha256: sha256Hex(bBlock) },
      ],
      credentials: [],
    }
    // Block write of third entry cleanly without relying on root vs non-root: make blocked a regular file.
    writeFileSync(join(env.stateDir, 'blocked'), 'not-a-dir')

    await expect(applyHandoverFiles('ho-partial', manifest, [bAccess, bTeam, bBlock])).rejects.toThrow()
    expect(existsSync(join(env.stateDir, 'access.json'))).toBe(true)
    expect(existsSync(join(env.stateDir, 'team-key.json'))).toBe(true)

    const rb = await restoreLocalBackup('ho-partial', { scope: 'all' })
    expect(rb.removed).toBeGreaterThanOrEqual(2)
    expect(existsSync(join(env.stateDir, 'access.json'))).toBe(false)
    expect(existsSync(join(env.stateDir, 'team-key.json'))).toBe(false)
  })

  test('old-master scoped restore clears stale node files and preserves post-freeze board.db', async () => {
    const env = makeEnv()
    writeFileSync(join(env.configDir, 'config.json'), JSON.stringify({ nodes: { id: 'laptop', devices: {} } }))
    const db = openDb({ create: true })
    if (!db) throw new Error('openDb failed')
    db.write('user', tx => {
      createThread(tx, {
        lane: 'atlas',
        title: 'Pre-freeze thread',
        status: 'next',
        author: { kind: 'session', key: 's-1', name: 'anna' },
        at: 1000,
      })
    })
    mkdirSync(join(env.stateDir, 'schedule'), { recursive: true })
    writeFileSync(join(env.stateDir, 'schedule', 'aa11bb.json'), JSON.stringify({ id: 'aa11bb', next: 1 }))
    writeFileSync(join(env.stateDir, 'calendar-reminders.json'), JSON.stringify([]))

    takeLocalBackup('ho-scope', 1000)

    // Simulate post-freeze live state additions & stale node/masters.json written during handover pair
    const nodeStore = createNodeStore({ dir: join(env.stateDir, 'node') })
    nodeStore.add('server-1', 'hand')
    expect(existsSync(join(env.stateDir, 'node', 'masters.json'))).toBe(true)
    db.write('user', tx => {
      createThread(tx, {
        lane: 'atlas',
        title: 'Live post-freeze thread',
        status: 'next',
        author: { kind: 'session', key: 's-2', name: 'ben' },
        at: 2000,
      })
    })
    db.close()

    // Retire shipped scheduler/reminder files (commit path)
    expect(retireShippedOldMasterState('ho-scope')).toBe(2)
    expect(existsSync(join(env.stateDir, 'schedule', 'aa11bb.json'))).toBe(false)

    // old-master-precommit clears stale node/masters.json and keeps live post-freeze board.db
    const rbPre = await restoreLocalBackup('ho-scope', { scope: 'old-master-precommit' })
    expect(rbPre.removed).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(env.stateDir, 'node', 'masters.json'))).toBe(false)
    expect(existsSync(join(env.stateDir, 'schedule', 'aa11bb.json'))).toBe(false)

    const liveSql = new Database(dbFile(), { readonly: true, strict: true })
    const countRow = liveSql.query('SELECT count(*) AS n FROM threads').get() as { n: number }
    liveSql.close(false)
    expect(countRow.n).toBe(2)

    // old-master-committed also restores retired schedule & reminder files without losing board.db
    await restoreLocalBackup('ho-scope', { scope: 'old-master-committed' })
    expect(existsSync(join(env.stateDir, 'schedule', 'aa11bb.json'))).toBe(true)
    expect(existsSync(join(env.stateDir, 'calendar-reminders.json'))).toBe(true)
    chmodSync(join(env.stateDir, 'schedule', 'aa11bb.json'), 0o600)
  })

  test('a commit moves the shipped master state under retired/, and an old-master rollback puts it back (#777)', async () => {
    const env = makeEnv()
    writeFileSync(join(env.configDir, 'config.json'), JSON.stringify({ nodes: { id: 'laptop', devices: {} } }))
    const db = openDb({ create: true })
    if (!db) throw new Error('openDb failed')
    db.write('user', tx => {
      createThread(tx, {
        lane: 'atlas',
        title: 'Kept thread',
        status: 'next',
        author: { kind: 'session', key: 's-1', name: 'anna' },
        at: 1000,
      })
    })
    db.close()
    openJournalDb(true)?.close()
    const shipped: [string, string][] = [
      [accessFile(), '{"owner":"anna"}'],
      [teamKeyFile(), '{"key":"team"}'],
      [join(calendarDir(), 'cache.json'), '[]'],
      [knownHostsFile(), 'relay.example.com ssh-ed25519 AAAA'],
      [keyFile(), '{"key":"backup"}'],
    ]
    for (const [p, body] of shipped) {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, body)
    }
    takeLocalBackup('ho-retire', 1000)

    retireShippedOldMasterState('ho-retire')
    for (const p of [dbFile(), journalFile(), ...shipped.map(([p]) => p)]) expect(existsSync(p)).toBe(false)
    const dir = handoverBackupDir('ho-retire')
    const manifestOf = () => JSON.parse(readFileSync(join(dir, 'backup-manifest.json'), 'utf8'))
    expect(manifestOf().retired).toEqual(
      expect.arrayContaining([
        'board.db',
        'journal.db',
        'access.json',
        'team-key.json',
        'calendar/cache.json',
        'tunnel/known_hosts',
        'backup/backup-key.json',
      ]),
    )
    expect(readFileSync(join(dir, 'retired', 'access.json'), 'utf8')).toBe('{"owner":"anna"}')

    // the node makes a fresh database meanwhile; a retried finalization keeps the first copy
    openDb({ create: true })?.close()
    retireShippedOldMasterState('ho-retire')
    expect(existsSync(join(dir, 'retired', 'board.db'))).toBe(true)

    const rb = await restoreLocalBackup('ho-retire', { scope: 'old-master-committed' })
    expect(rb.restored).toBeGreaterThanOrEqual(7)
    for (const [p, body] of shipped) expect(readFileSync(p, 'utf8')).toBe(body)
    expect(existsSync(journalFile())).toBe(true)
    const live = new Database(dbFile(), { readonly: true, strict: true })
    const titles = live.query('SELECT title FROM threads').all() as { title: string }[]
    live.close(false)
    expect(titles.map(r => r.title)).toEqual(['Kept thread'])
    expect(existsSync(join(dir, 'retired', 'board.db'))).toBe(false)
    expect(manifestOf().retired).toEqual([])
  })

  test('a backup without a commit retires nothing: an old-master rollback leaves the live state as it was (#777)', async () => {
    const env = makeEnv()
    writeFileSync(join(env.configDir, 'config.json'), JSON.stringify({ nodes: { id: 'laptop', devices: {} } }))
    openDb({ create: true })?.close()
    writeFileSync(accessFile(), '{"owner":"anna"}')
    takeLocalBackup('ho-keep', 1000)
    writeFileSync(accessFile(), '{"owner":"ben"}')
    await restoreLocalBackup('ho-keep', { scope: 'old-master-committed' })
    expect(readFileSync(accessFile(), 'utf8')).toBe('{"owner":"ben"}')
    expect(existsSync(dbFile())).toBe(true)
    expect(existsSync(join(handoverBackupDir('ho-keep'), 'retired'))).toBe(false)
  })

  test('a file that will not move stays live and the rest move on, named in the log (#777)', async () => {
    const env = makeEnv()
    writeFileSync(join(env.configDir, 'config.json'), JSON.stringify({ nodes: { id: 'laptop', devices: {} } }))
    openDb({ create: true })?.close()
    mkdirSync(calendarDir(), { recursive: true })
    writeFileSync(join(calendarDir(), 'cache.json'), '[]')
    writeFileSync(accessFile(), '{"owner":"anna"}')
    takeLocalBackup('ho-stuck', 1000)
    // a file where the calendar's folder would go: that move fails, as a lock or a full disk would
    const dir = handoverBackupDir('ho-stuck')
    mkdirSync(join(dir, 'retired'), { recursive: true })
    writeFileSync(join(dir, 'retired', 'calendar'), 'in the way')
    const lines: string[] = []
    expect(() => retireShippedOldMasterState('ho-stuck', line => lines.push(line))).not.toThrow()
    expect(existsSync(join(calendarDir(), 'cache.json'))).toBe(true)
    expect(existsSync(dbFile())).toBe(false)
    expect(existsSync(accessFile())).toBe(false)
    expect(lines.some(l => l.includes('calendar/cache.json stays in place'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(dir, 'backup-manifest.json'), 'utf8'))
    expect(manifest.retired).toContain('board.db')
    expect(manifest.retired).not.toContain('calendar/cache.json')
    await restoreLocalBackup('ho-stuck', { scope: 'old-master-committed' })
    expect(existsSync(dbFile())).toBe(true)
    expect(readFileSync(accessFile(), 'utf8')).toBe('{"owner":"anna"}')
    expect(readFileSync(join(calendarDir(), 'cache.json'), 'utf8')).toBe('[]')
  })

  test('the prune keeps a backup that holds retired files, and prunes the others as before (#777)', () => {
    const env = makeEnv()
    writeFileSync(join(env.configDir, 'config.json'), JSON.stringify({ nodes: { id: 'laptop', devices: {} } }))
    openDb({ create: true })?.close()
    takeLocalBackup('ho-retired', 1000)
    retireShippedOldMasterState('ho-retired')
    takeLocalBackup('ho-plain', 1000)
    const long = Date.now() / 1000 - 3600
    utimesSync(handoverBackupDir('ho-retired'), long, long)
    utimesSync(handoverBackupDir('ho-plain'), long + 1, long + 1)
    for (const n of [1, 2, 3, 4, 5]) takeLocalBackup(`ho-new-${n}`, 1000 + n)
    expect(existsSync(join(handoverBackupDir('ho-retired'), 'retired', 'board.db'))).toBe(true)
    expect(existsSync(handoverBackupDir('ho-plain'))).toBe(false)
  })
})
