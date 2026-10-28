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
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dropKey, FOLDER_NAME, folderProblem, keyFile, readStatus, writeKey } from '../../src/adapters/backup-store.ts'
import { dbFile, openDb } from '../../src/adapters/db.ts'
import { stateDir } from '../../src/adapters/paths.ts'
import { backupConfig } from '../../src/core/backup.ts'
import { makeKey } from '../../src/core/backup-file.ts'
import { dropScript } from '../../src/core/backup-server.ts'
import {
  BackupError,
  backupNow,
  backupView,
  fetchFrom,
  listAt,
  restore,
  startBackups,
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
  writeFileSync(script, dropScript(join(env.dir, 'server-snapshots')))
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
      for (const args of calls) {
        assert.ok(args.includes('BatchMode=yes'))
        assert.ok(args.includes('StrictHostKeyChecking=yes'))
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
