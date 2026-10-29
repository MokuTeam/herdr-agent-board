import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dropKey, FOLDER_NAME, folderProblem, keyFile, readStatus, writeKey } from '../../src/adapters/backup-store.ts'
import { dbFile, openDb } from '../../src/adapters/db.ts'
import { stateDir } from '../../src/adapters/paths.ts'
import { backupConfig, snapshotName } from '../../src/core/backup.ts'
import { makeKey, seal } from '../../src/core/backup-file.ts'
import { dropScript } from '../../src/core/backup-server.ts'
import {
  BackupError,
  backupNow,
  backupView,
  fetchFrom,
  listAt,
  restore,
  startBackups,
  syncedPath,
  testTarget,
} from '../../src/services/backup.ts'
import { isolatedHome } from '../support/env.ts'
import { compileFake } from '../support/fake-herdr-bin.ts'

const PASS = 'correct horse battery'
const CHEAP = { logN: 10, r: 8, p: 1 }
const sh = Bun.which('dash') ?? Bun.which('sh')

/** A fresh state folder with a database holding `refs` and the board's key; the folder target's folder. */
async function setUp(refs: string[] = ['one']) {
  const dir = isolatedHome()
  const db = openDb()
  assert.ok(db)
  for (const ref of refs) db.write('user', tx => tx.journal({ store: 'test', op: 'add', ref }))
  db.close()
  const written = await writeKey(makeKey(PASS, 1, CHEAP))
  assert.ok(written.ok)
  const folder = join(dir, 'OneDrive')
  mkdirSync(folder)
  return { dir, folder }
}

const refsNow = (): string[] => {
  const db = openDb()
  assert.ok(db)
  const refs = (db.db.query('SELECT op, ref FROM journal ORDER BY seq').all() as { op: string; ref: string }[]).map(
    r => `${r.op}:${r.ref}`,
  )
  db.close()
  return refs
}

test('no database, nothing to back up, and no problem to show', async () => {
  isolatedHome()
  const r = await backupNow({ cfg: { backup: { folder: 'C:\\nowhere' } } })
  assert.equal(r.nothing, true)
  assert.equal(existsSync(dbFile()), false, 'looking does not make the file')
  assert.deepEqual(backupView({ backup: {} }).problems, [])
})

test('a snapshot goes to the folder sealed, the status says so, and an undue target is left alone', async () => {
  const { folder } = await setUp()
  const cfg = { backup: { folder } }
  const r = await backupNow({ cfg })
  assert.deepEqual(r.failed, [])
  assert.equal(r.sent.length, 1)
  const name = r.sent[0]?.name as string
  const file = readFileSync(join(folder, FOLDER_NAME, name))
  assert.equal(file.subarray(0, 4).toString(), 'ABK1')
  assert.ok(!file.includes(Buffer.from('SQLite format 3')), 'the database is not readable in the folder')
  const s = readStatus().targets.folder
  assert.equal(s?.name, name)
  assert.equal(s?.error, null)
  assert.ok((s?.seq ?? 0) > 0)
  // nothing changed since, and it is not the daily one yet: not due
  const again = await backupNow({ cfg })
  assert.deepEqual(again.sent, [])
  assert.deepEqual(again.skipped, ['folder'])
  assert.deepEqual(backupView(cfg).problems, [])
})

test('Test sends a snapshot, reads it back, opens it and compares it', async () => {
  const { folder } = await setUp()
  const r = await testTarget('folder', { backup: { folder } })
  assert.equal(r.ok, true, r.error ?? '')
  assert.ok(readdirSync(join(folder, FOLDER_NAME)).includes(r.name as string))
})

test('restore puts the database back as the snapshot had it, while it is open elsewhere, and keeps the one it replaced', async () => {
  const { folder } = await setUp(['kept'])
  const cfg = { backup: { folder } }
  await backupNow({ cfg })
  const other = openDb()
  assert.ok(other)
  other.write('user', tx => tx.journal({ store: 'test', op: 'add', ref: 'after the backup' }))
  const r = await restore({ from: { target: 'folder' }, cfg, by: 'user' })
  assert.equal(r.inPlace, true)
  assert.ok(r.before !== null && existsSync(r.before))
  assert.deepEqual(refsNow(), ['add:kept', 'restore:db'])
  // the connection that stayed open sees the restored rows too
  assert.equal((other.db.query('SELECT count(*) AS n FROM journal').get() as { n: number }).n, 2)
  other.close()
})

test('on a new computer a snapshot opens with the passphrase alone; without it, the restore says what it needs', async () => {
  const { folder } = await setUp(['kept'])
  const cfg = { backup: { folder } }
  await backupNow({ cfg })
  rmSync(keyFile())
  await assert.rejects(
    restore({ from: { target: 'folder' }, cfg, by: 'user' }),
    (err: unknown) => err instanceof BackupError && err.key === 'backup.file.needPassphrase',
  )
  await assert.rejects(
    restore({ from: { target: 'folder' }, cfg, by: 'user', passphrase: 'not the passphrase' }),
    (err: unknown) => err instanceof BackupError && err.key === 'backup.file.wrong',
  )
  const r = await restore({ from: { target: 'folder' }, cfg, by: 'user', passphrase: PASS })
  assert.equal(r.inPlace, true)
  assert.deepEqual(refsNow(), ['add:kept', 'restore:db'])
})

test('a database too damaged to restore in place is replaced as a file, only with the board stopped', async () => {
  const { folder } = await setUp(['kept'])
  const cfg = { backup: { folder } }
  await backupNow({ cfg })
  const fd = openSync(dbFile(), 'r+')
  writeSync(fd, Buffer.alloc(100, 0xab), 0, 100, 0)
  closeSync(fd)
  await assert.rejects(
    restore({ from: { target: 'folder' }, cfg, by: 'user', replaceFile: true, boardRunning: async () => true }),
    (err: unknown) => err instanceof BackupError && err.key === 'backup.err.boardRunning',
  )
  const r = await restore({
    from: { target: 'folder' },
    cfg,
    by: 'user',
    replaceFile: true,
    boardRunning: async () => false,
  })
  assert.equal(r.inPlace, false)
  assert.ok(r.aside !== undefined && existsSync(join(r.aside, 'board.db')), 'the damaged file is kept aside')
  assert.deepEqual(refsNow(), ['add:kept'])
})

test('a damaged database is never sent: every due target gets the error instead', async () => {
  const { folder } = await setUp()
  const db = openDb()
  db?.db.exec('CREATE TABLE big (v TEXT) STRICT')
  db?.write('user', tx => {
    for (let i = 0; i < 300; i++) tx.db.query('INSERT INTO big VALUES (?)').run('x'.repeat(300))
  })
  db?.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db?.close()
  const fd = openSync(dbFile(), 'r+')
  writeSync(fd, Buffer.alloc(8192, 0xab), 0, 8192, 4096 * 4)
  closeSync(fd)
  const r = await backupNow({ cfg: { backup: { folder } }, force: true })
  assert.deepEqual(r.sent, [])
  assert.equal(r.failed.length, 1)
  assert.equal(existsSync(join(folder, FOLDER_NAME)), false)
  assert.deepEqual(
    backupView({ backup: { folder } }).problems.map(p => p.kind),
    ['damaged', 'never', 'failing'],
  )
})

test('the folder target is refused inside the board’s own state folder, or as a relative path', async () => {
  await setUp()
  assert.equal(folderProblem(join(stateDir(), 'backup')), 'backup.err.folderInState')
  assert.equal(folderProblem('relative/path'), 'backup.err.folderAbsolute')
})

test('no key: nothing is sealed, and the view says why', async () => {
  const { folder } = await setUp()
  rmSync(keyFile())
  const r = await backupNow({ cfg: { backup: { folder } }, force: true })
  assert.equal(r.failed.length, 1)
  assert.ok(backupView({ backup: { folder } }).problems.some(p => p.kind === 'noKey'))
})

test('the schedule sends a first snapshot once the database is there, and stops', async () => {
  const { folder } = await setUp()
  let changed = 0
  const b = startBackups({ cfg: () => ({ backup: { folder } }), onChange: () => changed++, tickMs: 30, firstMs: 5 })
  for (let i = 0; i < 100 && !readStatus().targets.folder?.lastOk; i++) await Bun.sleep(20)
  b.stop()
  assert.ok(readStatus().targets.folder?.lastOk, 'the schedule backed it up')
  assert.ok(changed > 0)
})

/** The server target over the fake ssh that runs the real drop script here. */
async function serverSetUp() {
  const env = await setUp(['on the server'])
  const bin = await compileFake(fileURLToPath(new URL('../support/fake-drop-ssh.ts', import.meta.url)), 'fake-drop-ssh')
  const script = join(env.dir, 'drop.sh')
  writeFileSync(script, dropScript({ dir: join(env.dir, 'server-snapshots') }))
  const log = join(env.dir, 'drop-calls.jsonl')
  const saved = { ...process.env }
  process.env.BOARD_SSH_BIN_PATH = bin
  process.env.FAKE_DROP_SCRIPT = script
  process.env.FAKE_DROP_SH = sh as string
  process.env.FAKE_DROP_LOG = log
  mkdirSync(join(stateDir(), 'backup'), { recursive: true })
  writeFileSync(dropKey(), 'the board’s private key')
  const cfg = { backup: { server: { host: 'example.org', port: 2222, admin: { user: 'me', key: '' }, set: 'x' } } }
  return {
    ...env,
    cfg,
    log,
    restoreEnv: () => {
      for (const k of ['FAKE_DROP_SCRIPT', 'FAKE_DROP_SH', 'FAKE_DROP_LOG', 'FAKE_DROP_REFUSE'])
        if (saved[k] === undefined) delete process.env[k]
    },
  }
}

test.skipIf(!sh)(
  'the server target: put, list, get and Test through ssh to the drop, with the board’s key only',
  async () => {
    const s = await serverSetUp()
    try {
      const r = await backupNow({ cfg: s.cfg })
      assert.deepEqual(r.failed, [])
      const name = r.sent[0]?.name as string
      assert.match(name, /^\d{8}T\d{6}Z-[0-9a-f]{8}\.abk$/)
      const c = backupConfig(s.cfg.backup)
      const list = await listAt('server', c)
      assert.deepEqual(
        list.map(x => x.name),
        [name],
      )
      const back = await fetchFrom('server', c, name)
      assert.equal(back.subarray(0, 4).toString(), 'ABK1')
      const tested = await testTarget('server', s.cfg)
      assert.equal(tested.ok, true, tested.error ?? '')
      const restored = await restore({ from: { target: 'server', name }, cfg: s.cfg, by: 'user' })
      assert.equal(restored.from, `server/${name}`)
      const calls = readFileSync(s.log, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l) as string[])
      // scheduled backups never pin the server's key; Test may, once, when none is pinned yet
      const pinning = calls.filter(a => a.includes('StrictHostKeyChecking=accept-new'))
      assert.deepEqual(
        pinning.map(a => a.at(-1)),
        ['check'],
      )
      for (const args of calls) {
        assert.ok(args.includes('BatchMode=yes'))
        if (!pinning.includes(args)) assert.ok(args.includes('StrictHostKeyChecking=yes'))
        assert.ok(args.includes('IdentitiesOnly=yes'))
        assert.equal(args[args.indexOf('-i') + 1]?.replaceAll('\\', '/'), dropKey().replaceAll('\\', '/'))
        assert.ok(args.includes('agent-board-backup@example.org'))
        assert.equal(args[args.indexOf('-p') + 1], '2222')
      }
    } finally {
      s.restoreEnv()
    }
  },
)

test.skipIf(!sh)(
  'a refused ssh is the server target’s error, and the folder target still gets its snapshot',
  async () => {
    const s = await serverSetUp()
    try {
      process.env.FAKE_DROP_REFUSE = '1'
      const cfg = { backup: { ...s.cfg.backup, folder: s.folder } }
      const r = await backupNow({ cfg })
      assert.deepEqual(
        r.sent.map(x => x.target),
        ['folder'],
      )
      assert.equal(r.failed[0]?.target, 'server')
      assert.match(r.failed[0]?.error ?? '', /Permission denied/)
      assert.equal(readStatus().targets.server?.failures, 1)
    } finally {
      s.restoreEnv()
    }
  },
)

test('a database emptied after a backup is held: nothing scheduled sends it, by hand it goes and the hold clears', async () => {
  const { folder } = await setUp(['a', 'b', 'c'])
  const cfg = { backup: { folder } }
  assert.equal((await backupNow({ cfg })).sent.length, 1)
  // the file emptied (a reset, or an older copy put back by hand): fewer changes than the backup holds
  rmSync(dbFile(), { force: true })
  for (const end of ['-wal', '-shm']) rmSync(`${dbFile()}${end}`, { force: true })
  assert.deepEqual(
    backupView(cfg).problems.map(p => p.kind),
    ['missing'],
  )
  const db = openDb()
  db?.write('user', tx => tx.journal({ store: 'test', op: 'add', ref: 'one' }))
  db?.close()
  const held = await backupNow({ cfg, now: () => Date.now() + 2 * 86_400_000 })
  assert.equal(held.reset, true)
  assert.deepEqual(held.sent, [])
  assert.equal(backupView(cfg, Date.now() + 20_000).problems[0]?.kind, 'reset')
  const forced = await backupNow({ cfg, force: true })
  assert.equal(forced.sent.length, 1)
  assert.equal(
    backupView(cfg, Date.now() + 40_000).problems.some(p => p.kind === 'reset'),
    false,
  )
})

test('a snapshot a sync client holds in the folder stays, and the backup still goes through', async () => {
  const { folder } = await setUp()
  const now = Date.now()
  // a name the rotation removes (over two years old) that cannot be removed: a folder in its place,
  // refused as a file a sync client holds is; and a dozen recent ones, so the rotation runs
  const old = join(folder, FOLDER_NAME, snapshotName(now - 800 * 86_400_000, '00000000'))
  mkdirSync(join(old, 'held'), { recursive: true })
  for (let i = 1; i <= 12; i++)
    writeFileSync(
      join(folder, FOLDER_NAME, snapshotName(now - i * 3_600_000, `1111${String(i).padStart(4, '0')}`)),
      'ABK1',
    )
  const r = await backupNow({ cfg: { backup: { folder } } })
  assert.deepEqual(r.failed, [])
  assert.equal(r.sent.length, 1)
  assert.equal(readStatus().targets.folder?.error, null)
  assert.ok(existsSync(old), 'the one that could not go stays for the next prune')
})

test('restore by default takes the newest that opens whole: past a damaged newest one and a name from the future', async () => {
  const { folder } = await setUp(['kept'])
  const cfg = { backup: { folder } }
  const good = (await backupNow({ cfg })).sent[0]?.name as string
  const dir = join(folder, FOLDER_NAME)
  const sealed = readFileSync(join(dir, good))
  const damaged = Buffer.from(sealed)
  damaged[damaged.length - 5] = (damaged[damaged.length - 5] ?? 0) ^ 1
  writeFileSync(join(dir, snapshotName(Date.now() + 60_000, 'aaaaaaaa')), damaged)
  writeFileSync(join(dir, snapshotName(Date.now() + 5 * 86_400_000, 'bbbbbbbb')), sealed)
  const r = await restore({ from: { target: 'folder' }, cfg, by: 'user' })
  assert.equal(r.from, `folder/${good}`)
  assert.equal(r.skipped.length, 1, 'the damaged one passed over')
})

test('a refused login holds the server: no try until a Test goes through', async () => {
  const s = await serverSetUp()
  try {
    process.env.FAKE_DROP_REFUSE = '1'
    const r = await backupNow({ cfg: s.cfg })
    assert.equal(r.failed.length, 1)
    assert.ok(readStatus().targets.server?.held)
    assert.ok(backupView(s.cfg).problems.some(p => p.kind === 'held'))
    // an hour later nothing is due: no login is tried
    const later = await backupNow({ cfg: s.cfg, now: () => Date.now() + 3 * 3_600_000 })
    assert.deepEqual(later.failed, [])
    assert.deepEqual(later.skipped, ['server'])
    delete process.env.FAKE_DROP_REFUSE
    assert.equal((await testTarget('server', s.cfg)).ok, true)
    assert.equal(readStatus().targets.server?.held, null)
  } finally {
    s.restoreEnv()
  }
})

test('a plain copy a killed run left in backup/ is swept by the next run', async () => {
  const { folder } = await setUp()
  const stale = join(stateDir(), 'backup', 'snapshot-12345-deadbeef.db')
  writeFileSync(stale, 'SQLite format 3')
  const old = (Date.now() - 3_600_000) / 1000
  utimesSync(stale, old, old)
  await backupNow({ cfg: { backup: { folder } } })
  assert.equal(existsSync(stale), false)
})

test('board doctor knows a synced folder by its Windows path too', () => {
  assert.ok(syncedPath('C:\\Users\\me\\OneDrive - Acme\\AppData\\board.db'))
  assert.ok(syncedPath('/home/me/Dropbox/state/board.db'))
  assert.ok(!syncedPath('C:\\Users\\me\\AppData\\Local\\herdr\\board.db'))
})

test('restore says what it passed over and why: a newest one that will not open, one that cannot be read', async () => {
  const { folder } = await setUp(['kept'])
  const cfg = { backup: { folder } }
  const good = (await backupNow({ cfg })).sent[0]?.name as string
  const dir = join(folder, FOLDER_NAME)
  const damaged = readFileSync(join(dir, good))
  damaged[damaged.length - 5] = (damaged[damaged.length - 5] ?? 0) ^ 1
  const broken = snapshotName(Date.now() + 60_000, 'aaaaaaaa')
  writeFileSync(join(dir, broken), damaged)
  // newer still, and not a file that reads (a sync client's placeholder, say)
  const unreadable = snapshotName(Date.now() + 120_000, 'bbbbbbbb')
  mkdirSync(join(dir, unreadable))
  const r = await restore({ from: { target: 'folder' }, cfg, by: 'user' })
  assert.equal(r.from, `folder/${good}`)
  assert.deepEqual(
    r.skipped.map(x => x.name),
    [unreadable, broken],
  )
  assert.equal(r.skipped[1]?.why, 'backup.file.damaged')
  assert.ok(r.skipped[0]?.why, 'the read error, said')
})

test('on a new computer, a passphrase that opens none of the newest three stops there', async () => {
  const { folder } = await setUp(['kept'])
  const cfg = { backup: { folder } }
  // an older snapshot sealed with another passphrase: reached only if the walk went on
  const db = openDb()
  assert.ok(db)
  const plain = db.db.serialize()
  db.close()
  const other = makeKey('another passphrase', 1, CHEAP)
  mkdirSync(join(folder, FOLDER_NAME), { recursive: true })
  writeFileSync(join(folder, FOLDER_NAME, snapshotName(Date.now() - 3_600_000, 'cccccccc')), seal(plain, other))
  for (let i = 0; i < 3; i++) await backupNow({ cfg, force: true })
  rmSync(keyFile())
  await assert.rejects(
    restore({ from: { target: 'folder' }, cfg, by: 'user', passphrase: 'another passphrase' }),
    (err: unknown) =>
      err instanceof BackupError &&
      err.key === 'backup.err.walkStopped' &&
      err.skipped.length === 3 &&
      /1 older ones were not tried/.test(err.message) &&
      /--snapshot/.test(err.message),
  )
  assert.deepEqual(refsNow(), ['add:kept'], 'nothing restored')
})

test('right after Back up now the view says no reset: the seq it compares is read afresh', async () => {
  const { folder } = await setUp(['a'])
  const cfg = { backup: { folder } }
  await backupNow({ cfg })
  assert.deepEqual(
    backupView(cfg).problems.map(p => p.kind),
    [],
  )
  const db = openDb()
  db?.write('user', tx => tx.journal({ store: 'test', op: 'add', ref: 'b' }))
  db?.close()
  await backupNow({ cfg, force: true })
  assert.deepEqual(
    backupView(cfg).problems.map(p => p.kind),
    [],
  )
})

test('a snapshot named a day and more ahead in the folder stays, the rotation goes on, and it is shown', async () => {
  const { folder } = await setUp()
  const now = Date.now()
  const dir = join(folder, FOLDER_NAME)
  mkdirSync(dir, { recursive: true })
  const ahead = snapshotName(now + 400 * 86_400_000, 'ffffffff')
  writeFileSync(join(dir, ahead), 'ABK1')
  const old = snapshotName(now - 900 * 86_400_000, '00000000')
  writeFileSync(join(dir, old), 'ABK1')
  // twenty days apart: no month-long jump before the newest, which would keep everything
  for (let i = 1; i <= 12; i++)
    writeFileSync(join(dir, snapshotName(now - 20 * i * 86_400_000, `1111${String(i).padStart(4, '0')}`)), 'ABK1')
  const cfg = { backup: { folder } }
  assert.equal((await backupNow({ cfg })).sent.length, 1)
  assert.ok(existsSync(join(dir, ahead)), 'kept')
  assert.equal(existsSync(join(dir, old)), false, 'and the rest rotate as before')
  assert.equal(readStatus().targets.folder?.ahead, 1)
  assert.deepEqual(
    backupView(cfg).problems.map(p => p.kind),
    ['ahead'],
  )
})

test('two restores in one second each keep their own copy of the database as it was', async () => {
  const { folder } = await setUp(['kept'])
  const cfg = { backup: { folder } }
  await backupNow({ cfg })
  const now = () => Date.parse('2026-10-29T03:00:00Z')
  const first = await restore({ from: { target: 'folder' }, cfg, by: 'user', now })
  const second = await restore({ from: { target: 'folder' }, cfg, by: 'user', now })
  assert.notEqual(first.before, second.before)
  assert.ok(existsSync(first.before as string) && existsSync(second.before as string))
})

test.skipIf(process.platform !== 'win32')(
  '--replace-file while another process has the file open: put back, said as such, no folder left',
  async () => {
    const { folder } = await setUp(['kept'])
    const cfg = { backup: { folder } }
    await backupNow({ cfg })
    const holder = openDb()
    try {
      await assert.rejects(
        restore({ from: { target: 'folder' }, cfg, by: 'user', replaceFile: true, boardRunning: async () => false }),
        (err: unknown) => err instanceof BackupError && err.key === 'backup.err.fileBusy',
      )
    } finally {
      holder?.close()
    }
    assert.deepEqual(
      readdirSync(stateDir()).filter(n => n.startsWith('damaged-')),
      [],
    )
    assert.ok(existsSync(dbFile()))
  },
)

test('a walk that reaches its cap says so: what it tried, the older ones it did not, and how to take one', async () => {
  const { folder } = await setUp(['kept'])
  const cfg = { backup: { folder } }
  const good = (await backupNow({ cfg })).sent[0]?.name as string
  const dir = join(folder, FOLDER_NAME)
  const damaged = readFileSync(join(dir, good))
  damaged[damaged.length - 5] = (damaged[damaged.length - 5] ?? 0) ^ 1
  // twenty damaged newer ones, planted: the good one is the twenty-first
  for (let i = 1; i <= 20; i++)
    writeFileSync(join(dir, snapshotName(Date.now() + i * 60_000, `dddd${String(i).padStart(4, '0')}`)), damaged)
  await assert.rejects(
    restore({ from: { target: 'folder' }, cfg, by: 'user' }),
    (err: unknown) =>
      err instanceof BackupError &&
      err.key === 'backup.err.walkStopped' &&
      err.skipped.length === 20 &&
      /1 older ones were not tried: list them with board backup list folder/.test(err.message),
  )
  // the way it names
  const r = await restore({ from: { target: 'folder', name: good }, cfg, by: 'user' })
  assert.equal(r.from, `folder/${good}`)
})

test('a database emptied to nothing after a backup is a reset the view shows at once, with the board stopped', async () => {
  const { folder } = await setUp(['a', 'b'])
  const cfg = { backup: { folder } }
  await backupNow({ cfg })
  for (const end of ['-wal', '-shm']) rmSync(`${dbFile()}${end}`, { force: true })
  writeFileSync(dbFile(), '')
  assert.deepEqual(
    backupView(cfg, Date.now() + 20_000).problems.map(p => p.kind),
    ['reset'],
  )
})
