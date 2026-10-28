import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rotationKeeps, snapshotName } from '../../src/core/backup.ts'
import {
  applyScript,
  BACKUP_BLOCK_BEGIN,
  BACKUP_USER,
  backupKeysLine,
  DROP_FILE,
  dropScript,
  fenceBlock,
  lookIsSet,
  lookScript,
  lookVerdict,
  pruneAwk,
  readLook,
  readRun,
  undoScript,
} from '../../src/core/backup-server.ts'
import { BLOCK_BEGIN } from '../../src/core/server-texts.ts'

// The scripts run on the server's /bin/sh (dash on Debian and Ubuntu): run them with dash where
// it is, else with a POSIX sh; without one these tests are skipped.
const sh = Bun.which('dash') ?? Bun.which('sh')
const awk = Bun.which('awk')
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoardBackupTestKeyOnly0000000000000000 agent-board backup'

test('the fence lets the backup user run the drop script and nothing else', () => {
  const block = fenceBlock()
  assert.match(block, new RegExp(`^Match User ${BACKUP_USER}\\n`))
  assert.match(block, /ForceCommand \/etc\/agent-board\/backup-drop/)
  assert.match(block, /AuthenticationMethods publickey/)
  assert.match(block, /DisableForwarding yes/)
  assert.match(block, /PermitTTY no/)
  assert.match(block, /\nMatch all$/)
  // the key itself is held to the script too, were sshd's fence ever gone
  assert.equal(backupKeysLine(` ${KEY} `), `restrict,command="${DROP_FILE}" ${KEY}`)
})

test("the backup block's markers are not the tunnel's, which its own Undo strips by prefix", () => {
  assert.ok(!BACKUP_BLOCK_BEGIN.startsWith(BLOCK_BEGIN))
})

test.skipIf(!sh)('every script parses as POSIX sh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-backup-sh-'))
  try {
    for (const [name, text] of [
      ['drop', dropScript()],
      ['look', lookScript(KEY)],
      ['look-nokey', lookScript(null)],
      ['apply', applyScript(KEY)],
      ['undo', undoScript()],
    ] as const) {
      const file = join(dir, `${name}.sh`)
      writeFileSync(file, text)
      const r = spawnSync(sh as string, ['-n', file], { encoding: 'utf8' })
      assert.equal(r.status, 0, `${name}: ${r.stderr}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The drop script run as sshd would run it for the key: the command in SSH_ORIGINAL_COMMAND. */
function drop(dir: string, command: string, input: Buffer | string = '') {
  const script = join(dir, 'drop.sh')
  writeFileSync(script, dropScript(join(dir, 'snapshots')))
  return spawnSync(sh as string, [script], { input, env: { ...process.env, SSH_ORIGINAL_COMMAND: command } })
}

test.skipIf(!sh)('the drop puts, lists and gets snapshots, names them itself and never overwrites one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-drop-'))
  try {
    const snapshot = Buffer.concat([Buffer.from('ABK1'), Buffer.from([0, 255, 10, 13, 0]), Buffer.alloc(3000, 7)])
    const put = drop(dir, 'put', snapshot)
    assert.equal(put.status, 0, put.stderr.toString())
    const m = /^@@put (\S+) (\d+)$/m.exec(put.stdout.toString())
    assert.ok(m, put.stdout.toString())
    const name = m[1] as string
    assert.match(name, /^\d{8}T\d{6}Z-[0-9a-f]{8}\.abk$/)
    assert.equal(Number(m[2]), snapshot.length)
    const list = drop(dir, 'list')
    assert.equal(list.stdout.toString().trim(), `${name} ${snapshot.length}`)
    const got = drop(dir, `get ${name}`)
    assert.equal(got.status, 0)
    assert.deepEqual(got.stdout, snapshot, 'bytes come back as they went')
    const ok = drop(dir, 'check')
    assert.match(ok.stdout.toString(), /^@@ok 1$/m)
    assert.match(drop(dir, 'df').stdout.toString(), /^@@df \d+ \d+ \d+$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(!sh)('the drop refuses what is not a snapshot, other names, paths and every other command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-drop-'))
  try {
    const notOurs = drop(dir, 'put', 'hello')
    assert.equal(notOurs.status, 1)
    assert.match(notOurs.stderr.toString(), /@@error not a snapshot/)
    assert.equal(drop(dir, 'put', '').status, 1)
    for (const command of ['get ../drop.sh', 'get /etc/passwd', 'get 20261029T000000Z-abcdef01.abk', 'rm x', 'sh', ''])
      assert.equal(drop(dir, command).status, 1, command)
    // nothing was left behind by the refused puts
    assert.deepEqual(readdirSync(join(dir, 'snapshots')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(!awk)("the drop's rotation removes exactly what rotationKeeps does not keep", () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0)
  const names: string[] = []
  // every 7 hours for 900 days back, and a few in the last two days
  for (let back = 0; back < 900 * 24; back += 7)
    names.push(snapshotName(now - back * 3_600_000, back.toString(16).padStart(8, '0')))
  names.push(snapshotName(now + 3_600_000, 'ffffffff'))
  names.sort()
  const r = spawnSync(awk as string, ['-v', `now=${Math.floor(now / 1000)}`, pruneAwk()], {
    input: `${names.join('\n')}\n`,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  })
  assert.equal(r.status, 0, r.stderr)
  const removed = r.stdout.split('\n').filter(Boolean)
  const keep = rotationKeeps(names, now)
  assert.deepEqual(
    removed,
    names.filter(n => !keep.has(n)),
  )
  assert.ok(removed.length > 100 && keep.size > 60)
})

test('readLook reads what Look printed; Apply can go on only with sshd taking the fence', () => {
  const lines = [
    '@@ssh OpenSSH_9.6p1 Ubuntu-3ubuntu13.20, OpenSSL 3.0.13 30 Jan 2024',
    '@@include yes',
    '@@user none',
    '@@drop none',
    '@@keys none',
    '@@fence none',
    '@@record no',
    '@@snapshots 0 0',
    '@@df 81556436',
    '@@sshd-t ok',
    '@@candidate ok',
    '@@end',
  ]
  const look = readLook(lines)
  assert.ok(look)
  assert.equal(look.include, true)
  assert.equal(look.user, 'none')
  assert.equal(look.freeKb, 81556436)
  assert.deepEqual(lookVerdict(look), { ok: true })
  assert.equal(lookIsSet(look), false)
  assert.equal(readLook(lines.slice(0, -1)), null, 'a Look cut short is no Look')
  const other = readLook(lines.map(l => (l === '@@user none' ? '@@user other' : l)))
  assert.equal(other && lookVerdict(other).ok, false)
  const bad = readLook(lines.map(l => (l === '@@candidate ok' ? '@@candidate not in force: permittty no' : l)))
  assert.deepEqual(bad && lookVerdict(bad), {
    ok: false,
    key: 'backup.server.candidateBad',
    vars: { said: 'not in force: permittty no' },
  })
  const set = readLook(
    lines.map(l =>
      l === '@@user none'
        ? '@@user ours'
        : l === '@@drop none'
          ? '@@drop same'
          : l === '@@keys none'
            ? '@@keys same'
            : l === '@@fence none'
              ? '@@fence file'
              : l === '@@record no'
                ? '@@record yes'
                : l,
    ),
  )
  assert.equal(set && lookIsSet(set), true)
})

test('readRun reads how Apply and Undo ended', () => {
  assert.deepEqual(readRun(['@@step check', '@@step user', '@@done']), {
    ok: true,
    steps: ['check', 'user'],
    fail: null,
    none: false,
    kept: null,
    warnings: [],
  })
  const failed = readRun(['@@step check', '@@fail sshd -t refuses the config with the fence: line 3'])
  assert.equal(failed.ok, false)
  assert.equal(failed.fail, 'sshd -t refuses the config with the fence: line 3')
  const undone = readRun(['@@step fence', '@@kept /var/lib/agent-board-backup/snapshots 12', '@@done'])
  assert.deepEqual(undone.kept, { dir: '/var/lib/agent-board-backup/snapshots', count: 12 })
  assert.equal(readRun(['@@none']).ok, true)
  assert.equal(readRun([]).ok, false, 'a run that said nothing did not go through')
})

test('Apply and Undo never remove the snapshots', () => {
  const apply = applyScript(KEY)
  const undo = undoScript()
  assert.ok(!/rm -rf "\$SNAP"|userdel -r|rm -rf \/var\/lib/.test(apply + undo))
  // Apply's rollback removes the home only when it made it just now
  assert.match(apply, /\[ "\$had_home" = 1 \] \|\| rm -rf "\$HOMEDIR"/)
})
