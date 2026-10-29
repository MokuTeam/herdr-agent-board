import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aheadCount, KEEP_NEWEST, rotationKeeps, snapshotName } from '../../src/core/backup.ts'
import {
  aheadAwk,
  applyScript,
  BACKUP_BLOCK_BEGIN,
  BACKUP_USER,
  backupKeysLine,
  DROP_FILE,
  DROP_MAX_FILE,
  DROP_MAX_KB,
  DROP_VERSION,
  type DropLimits,
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
import { fakeRoot, sh } from '../support/fake-root.ts'

const awk = Bun.which('awk')
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoardBackupTestKeyOnly0000000000000000 agent-board backup'
const DAY = 86_400_000

test('the fence lets the backup user run the drop script and nothing else', () => {
  const block = fenceBlock()
  assert.match(block, new RegExp(`^Match User ${BACKUP_USER}\\n`))
  assert.match(block, /ForceCommand \/etc\/agent-board-backup\/drop/)
  assert.match(block, /AuthenticationMethods publickey/)
  assert.match(block, /DisableForwarding yes/)
  assert.match(block, /PermitTTY no/)
  assert.match(block, /\nMatch all$/)
  // the key itself is held to the script too, were sshd's fence ever gone
  assert.equal(backupKeysLine(` ${KEY} `), `restrict,command="${DROP_FILE}" ${KEY}`)
})

test("the backup's folder and markers are its own: the tunnel's runner removes /etc/agent-board, its Undo strips by prefix", () => {
  assert.ok(!DROP_FILE.startsWith('/etc/agent-board/'))
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

// ------------------------------------------------------------------ the drop script

/** The drop script as sshd would run it for the key: the command in SSH_ORIGINAL_COMMAND. */
function dropper(limits: Partial<DropLimits> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'board-drop-'))
  const snaps = join(dir, 'snapshots')
  const script = join(dir, 'drop.sh')
  writeFileSync(script, dropScript({ dir: snaps, ...limits }))
  const run = (command: string, input: Buffer | string = '') =>
    spawnSync(sh as string, [script], { input, env: { ...process.env, SSH_ORIGINAL_COMMAND: command } })
  return {
    snaps,
    run,
    put: (bytes: Buffer, declared = bytes.length) => run(`put ${declared}`, bytes),
    files: () => (existsSync(snaps) ? readdirSync(snaps).sort() : []),
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}
const snapshot = (n = 3000, fill = 7) =>
  Buffer.concat([Buffer.from('ABK1'), Buffer.from([0, 255, 10, 13, 0]), Buffer.alloc(n, fill)])

test.skipIf(!sh)('the drop puts, lists and gets snapshots, names them itself and never overwrites one', () => {
  const d = dropper()
  try {
    const one = snapshot()
    const put = d.put(one)
    assert.equal(put.status, 0, put.stderr.toString())
    const m = /^@@put (\S+) (\d+)$/m.exec(put.stdout.toString())
    assert.ok(m, put.stdout.toString())
    const name = m[1] as string
    assert.match(name, /^\d{8}T\d{6}Z-[0-9a-f]{8}\.abk$/)
    assert.equal(Number(m[2]), one.length)
    // the same bytes again: the same name, nothing over it; other bytes: a file of their own
    assert.equal(d.put(one).status, 0)
    assert.equal(d.put(snapshot(3000, 8)).status, 0)
    assert.ok(d.files().filter(f => f.endsWith('.abk')).length >= 2)
    const list = d.run('list').stdout.toString()
    assert.match(list, new RegExp(`^${name} ${one.length}$`, 'm'))
    const got = d.run(`get ${name}`)
    assert.equal(got.status, 0)
    assert.deepEqual(got.stdout, one, 'bytes come back as they went')
    assert.match(d.run('check').stdout.toString(), new RegExp(`^@@ok ${DROP_VERSION}$`, 'm'))
    assert.match(d.run('df').stdout.toString(), /^@@df \d+ \d+ \d+$/m)
  } finally {
    d.done()
  }
})

test.skipIf(!sh)('the drop keeps nothing cut short or long, and refuses what is not a snapshot or not one line', () => {
  const d = dropper()
  try {
    const one = snapshot()
    const cut = d.put(one.subarray(0, 1000), one.length)
    assert.equal(cut.status, 1)
    assert.match(cut.stderr.toString(), /cut short or long: 1000 of/)
    assert.equal(d.put(one, 100).status, 1, 'more than it said')
    assert.match(d.run('put', one).stderr.toString(), /needs the snapshot's size/)
    assert.match(d.put(Buffer.from('hello'), 5).stderr.toString(), /not a snapshot of the board/)
    assert.equal(d.put(Buffer.alloc(0), 0).status, 1)
    for (const command of [
      'get ../drop.sh',
      'get /etc/passwd',
      'get 20261029T000000Z-abcdef01.abk',
      'get 20261029T000000Z-abcdef01.abk\nrm -rf /',
      'list\nrm x',
      'put 12x',
      'rm x',
      'sh',
      '',
    ])
      assert.equal(d.run(command).status, 1, JSON.stringify(command))
    // nothing was left behind by the refused puts
    assert.deepEqual(
      d.files().filter(f => !f.startsWith('.')),
      [],
    )
  } finally {
    d.done()
  }
})

test.skipIf(!sh)('a full folder makes room: the rotation runs before the cap is checked', () => {
  const now = Date.now()
  const fill = (d: ReturnType<typeof dropper>) => {
    mkdirSync(d.snaps)
    // two recent snapshots over twenty-eight from over two years back, 40 KB each: all but the
    // newest ten past keeping
    for (let i = 0; i < 30; i++) {
      const back = i === 0 ? 10 : i === 1 ? 35 : 900 + i * 20
      writeFileSync(join(d.snaps, snapshotName(now - back * DAY, i.toString(16).padStart(8, '0'))), snapshot(40_000))
    }
  }
  const tight = dropper({ maxKb: 64 })
  const roomy = dropper({ maxKb: 1024 })
  try {
    fill(tight)
    assert.equal(tight.put(snapshot()).status, 1, 'the ten kept are still over 64 KB')
    fill(roomy)
    const ok = roomy.put(snapshot())
    assert.equal(ok.status, 0, ok.stderr.toString())
    // the rotation again after the put: the ten newest, the new one among them
    assert.equal(roomy.files().length, 10)
  } finally {
    tight.done()
    roomy.done()
  }
})

test.skipIf(!sh)('a disk nearly full is refused before anything is written', () => {
  const d = dropper({ reserveKb: 1024 * 1024 * 1024 * 1024 })
  try {
    const r = d.put(snapshot())
    assert.equal(r.status, 1)
    assert.match(r.stderr.toString(), /nearly full/)
    assert.deepEqual(
      d.files().filter(f => f.endsWith('.abk')),
      [],
    )
  } finally {
    d.done()
  }
})

test.skipIf(!awk)("the drop's rotation removes exactly what rotationKeeps does not keep", () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0)
  const run = (names: string[], force = false) => {
    const r = spawnSync(
      awk as string,
      ['-v', `now=${Math.floor(now / 1000)}`, '-v', `force=${force ? 1 : 0}`, pruneAwk()],
      {
        input: `${[...names].sort().join('\n')}\n`,
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
      },
    )
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.split('\n').filter(Boolean)
  }
  const same = (names: string[]) => {
    const keep = rotationKeeps(names, now)
    assert.deepEqual(
      run(names),
      [...names].sort().filter(n => !keep.has(n)),
    )
  }
  // every 7 hours for 900 days back, and one an hour ahead
  const history: string[] = []
  for (let back = 0; back < 900 * 24; back += 7)
    history.push(snapshotName(now - back * 3_600_000, back.toString(16).padStart(8, '0')))
  history.push(snapshotName(now + 3_600_000, 'ffffffff'))
  same(history)
  assert.ok(run(history).length > 100)
  // a name a year ahead (a clock set wrong once, or a file put there): it stays, and the rest
  // rotate as they would without it
  const ahead = [...history, snapshotName(now + 400 * DAY, 'eeeeeeee')]
  same(ahead)
  assert.deepEqual(run(ahead), run(history))
  // and the drop counts it, as aheadCount does
  const count = spawnSync(awk as string, ['-v', `now=${Math.floor(now / 1000)}`, aheadAwk()], {
    input: `${[...ahead].sort().join('\n')}\n`,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  })
  assert.equal(count.stdout.trim(), String(aheadCount(ahead, now)))
  assert.equal(count.stdout.trim(), '1')
  // the newest a month and more after the one before it (a clock that jumped, a board asleep): nothing goes
  const cutoff = snapshotName(now - 40 * DAY, '00000000')
  const jumped = history.filter(n => n < cutoff).concat(snapshotName(now, 'dddddddd'))
  same(jumped)
  assert.deepEqual(run(jumped), [])
  // the clock a month and more past the newest (a jump forward, before the put that follows it): nothing goes
  const stale = history.filter(n => n < snapshotName(now - 40 * DAY, '00000000'))
  same(stale)
  assert.deepEqual(run(stale), [])
  // over the cap the drop prunes again with that guard off: the rotation as rotationKeeps' force
  const forced = rotationKeeps(stale, now, { force: true })
  assert.deepEqual(
    run(stale, true),
    [...stale].sort().filter(n => !forced.has(n)),
  )
  assert.ok(run(stale, true).length > 0)
  // ten from years ago under two recent ones: the newest ten stay whatever their age, two go
  const old = Array.from({ length: 10 }, (_, i) =>
    snapshotName(now - (1000 + i) * DAY, i.toString(16).padStart(8, '0')),
  ).concat(snapshotName(now - 20 * DAY, 'aaaaaaaa'), snapshotName(now - 5 * DAY, 'bbbbbbbb'))
  same(old)
  assert.equal(run(old).length, 2)
})

test.skipIf(!sh)(
  'old files over the cap, past the clock’s guard: a second prune makes room, the newest ten kept',
  () => {
    const now = Date.now()
    const d = dropper({ maxKb: 600 })
    try {
      mkdirSync(d.snaps)
      // eighteen of 40 KB put 45 days ago an hour apart (a flood a stolen key left): over the cap,
      // and the newest a month and more back, so the first prune keeps them all
      for (let i = 0; i < 18; i++)
        writeFileSync(
          join(d.snaps, snapshotName(now - 45 * DAY + i * 3_600_000, `ffff${String(i).padStart(4, '0')}`)),
          snapshot(40_000),
        )
      const ok = d.put(snapshot())
      assert.equal(ok.status, 0, ok.stderr.toString())
      // the newest ten and the first of that day, then the new one
      assert.equal(d.files().length, 12)
    } finally {
      d.done()
    }
  },
)

test('the newest ten, which the rotation always keeps, fit in the folder at their largest with room for one more', () => {
  // else ten large files put with a stolen key would fill the folder for good: nothing new goes in,
  // so nothing old rotates out
  assert.ok(((KEEP_NEWEST + 1) * DROP_MAX_FILE) / 1024 < DROP_MAX_KB)
})

// ------------------------------------------------------------------ what Look and the runs said

test('readLook reads what Look printed; Apply can go on only with sshd taking the fence', () => {
  const lines = [
    '@@ssh OpenSSH_9.6p1 Ubuntu-3ubuntu13.20, OpenSSL 3.0.13 30 Jan 2024',
    '@@include yes',
    '@@useradd yes',
    '@@user none',
    '@@drop none',
    '@@keys none',
    '@@fence none',
    '@@block whole',
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
  const changed = (from: string, to: string) => {
    const l = readLook(lines.map(x => (x === from ? to : x)))
    assert.ok(l)
    return lookVerdict(l)
  }
  assert.equal(changed('@@user none', '@@user other').ok, false)
  assert.deepEqual(changed('@@useradd yes', '@@useradd no'), { ok: false, key: 'backup.server.noUseradd' })
  assert.deepEqual(changed('@@block whole', '@@block torn'), { ok: false, key: 'backup.server.blockTorn' })
  assert.deepEqual(changed('@@candidate ok', '@@candidate not in force: permittty no'), {
    ok: false,
    key: 'backup.server.candidateBad',
    vars: { said: 'not in force: permittty no' },
  })
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

// ------------------------------------------------------------------ Look, Apply and Undo on a fake root

const okRun = (r: { lines: string[]; code: number | null; err: string }) => {
  assert.equal(r.code, 0, `${r.lines.join('\n')}\n${r.err}`)
  assert.ok(r.lines.includes('@@done') || r.lines.includes('@@end'), r.lines.join('\n'))
}
const SNAP = '/var/lib/agent-board-backup/snapshots/20261029T000000Z-abcdef01.abk'

test.skipIf(!sh)(
  'Look changes nothing and reads a fresh server: no user, the fence takes, /run/sshd left alone',
  () => {
    const root = fakeRoot('include')
    const before = root.etc()
    const r = root.run(lookScript(KEY))
    okRun(r)
    const look = readLook(r.lines)
    assert.ok(look)
    assert.equal(look.user, 'none')
    assert.equal(look.useradd, true)
    assert.equal(look.include, true)
    assert.equal(look.candidate, 'ok', r.lines.join('\n'))
    assert.deepEqual(root.etc(), before)
    assert.equal(existsSync(root.path('/run/sshd')), false)
  },
  60_000,
)

test.skipIf(!sh)(
  'Apply in a file of its own, twice; Undo takes out what it made and keeps the snapshots',
  () => {
    const root = fakeRoot('include')
    const before = root.etc()
    okRun(root.run(applyScript(KEY)))
    const etc = root.etc()
    assert.ok(etc['/etc/ssh/sshd_config.d/00-agent-board-backup.conf']?.includes('ForceCommand'))
    assert.ok(etc['/etc/agent-board-backup/drop']?.startsWith('#!/bin/sh'))
    assert.match(etc['/etc/agent-board-backup/record'] ?? '', /^user=1\nkeysdir=1\nfence=file\n/)
    assert.ok(etc['/etc/ssh/authorized_keys/agent-board-backup']?.includes(KEY))
    assert.match(root.passwd(), /^agent-board-backup:/m)
    assert.match(root.log(), /systemctl try-reload-or-restart ssh/)
    // again: the user is the board's own, the record keeps that the first run made it
    okRun(root.run(applyScript(KEY)))
    assert.match(root.etc()['/etc/agent-board-backup/record'] ?? '', /^user=1\nkeysdir=1\nfence=file\n/)
    // a snapshot in the folder, then Undo: the user, its files and the fence go, the snapshot stays
    writeFileSync(root.path(SNAP), 'ABK1x')
    const undo = root.run(undoScript())
    okRun(undo)
    assert.equal(readRun(undo.lines).kept?.count, 1)
    assert.deepEqual(root.etc(), before, 'etc as it was')
    assert.doesNotMatch(root.passwd(), /agent-board-backup/)
    assert.ok(existsSync(root.path(SNAP)))
    assert.match(root.log(), /chown -R root:root/)
  },
  60_000,
)

test.skipIf(!sh)(
  'a failed record write on a second Apply puts back what it changed and keeps the snapshots',
  () => {
    const root = fakeRoot('include')
    okRun(root.run(applyScript(KEY)))
    writeFileSync(root.path(SNAP), 'ABK1x')
    const after1 = root.etc()
    // a folder where the record's temp file goes: every record write fails
    mkdirSync(root.path('/etc/agent-board-backup/record.part'))
    const r = root.run(applyScript(KEY))
    assert.equal(r.code, 1)
    assert.match(r.lines.join('\n'), /@@fail could not write/)
    assert.ok(existsSync(root.path(SNAP)), 'the snapshot stays')
    assert.match(root.passwd(), /^agent-board-backup:/m, 'the user an earlier run made stays')
    rmSync(root.path('/etc/agent-board-backup/record.part'), { recursive: true })
    assert.deepEqual(root.etc(), after1, 'etc as the first run left it')
  },
  60_000,
)

test.skipIf(!sh)(
  'each of Apply’s record writes failing in turn: the first run leaves etc as it was, a second keeps what the first made',
  () => {
    const count = fakeRoot('include')
    okRun(count.run(applyScript(KEY)))
    const writes = count.records()
    assert.ok(writes >= 4, `the record is written as each step is done (${writes})`)
    okRun(count.run(applyScript(KEY)))
    // a second run makes no user: one write fewer
    const writes2 = count.records() - writes
    assert.ok(writes2 >= 3, `a second run writes it too (${writes2})`)
    for (let n = 1; n <= Math.max(writes, writes2); n++) {
      const first = fakeRoot('include')
      const before = first.etc()
      if (n <= writes) {
        const r = first.run(applyScript(KEY), { FAIL_RECORD_AT: String(n) })
        assert.equal(r.code, 1, `first run, write ${n}`)
        assert.deepEqual(first.etc(), before, `first run, write ${n}: etc as it was`)
        assert.doesNotMatch(first.passwd(), /agent-board-backup/, `first run, write ${n}`)
      }
      if (n > writes2) continue
      const again = fakeRoot('include')
      okRun(again.run(applyScript(KEY)))
      writeFileSync(again.path(SNAP), 'ABK1x')
      const after1 = again.etc()
      const second = again.records() + n
      const r2 = again.run(applyScript(KEY), { FAIL_RECORD_AT: String(second) })
      assert.equal(r2.code, 1, `second run, write ${n}`)
      assert.deepEqual(again.etc(), after1, `second run, write ${n}: etc as the first left it`)
      assert.match(again.passwd(), /^agent-board-backup:/m, `second run, write ${n}: the user stays`)
      assert.ok(existsSync(again.path(SNAP)), `second run, write ${n}: the snapshot stays`)
    }
  },
  120_000,
)

test.skipIf(!sh)(
  'a fence not in force, one that leaks into root’s settings, or an AllowUsers that leaves the user out: all put back',
  () => {
    for (const env of [{ SWALLOW: '1' }, { LEAK: '1' }, { ALLOWUSERS: 'admin' }] as Record<string, string>[]) {
      const root = fakeRoot('include')
      const before = root.etc()
      const r = root.run(applyScript(KEY), env)
      assert.equal(r.code, 1, JSON.stringify(env))
      assert.deepEqual(root.etc(), before, JSON.stringify(env))
      assert.doesNotMatch(root.passwd(), /agent-board-backup/)
      assert.equal(existsSync(root.path('/var/lib/agent-board-backup')), false)
    }
  },
  60_000,
)

test.skipIf(!sh)(
  'in sshd_config itself: Apply three times and Undo leave it byte for byte',
  () => {
    const root = fakeRoot('plain')
    const before = root.etc()
    for (let i = 0; i < 3; i++) okRun(root.run(applyScript(KEY)))
    const conf = root.etc()['/etc/ssh/sshd_config'] ?? ''
    assert.equal(conf.split(BACKUP_BLOCK_BEGIN).length, 2, 'one block')
    okRun(root.run(undoScript()))
    assert.deepEqual(root.etc(), before)
  },
  60_000,
)

test.skipIf(!sh)(
  'a block of the board’s that is not whole is never touched: Look says so, Apply refuses',
  () => {
    const root = fakeRoot('plain')
    const torn = `${root.etc()['/etc/ssh/sshd_config']}${BACKUP_BLOCK_BEGIN}: half\nMatch User deploy\n    ForceCommand /usr/local/bin/deploy\n`
    writeFileSync(root.path('/etc/ssh/sshd_config'), torn)
    assert.equal(readLook(root.run(lookScript(KEY)).lines)?.blockTorn, true)
    const r = root.run(applyScript(KEY))
    assert.equal(r.code, 1)
    assert.match(r.lines.join('\n'), /not whole/)
    assert.equal(root.etc()['/etc/ssh/sshd_config'], torn)
  },
  60_000,
)

test.skipIf(!sh)(
  'an admin connection that drops mid-run: the run ends on its own, and Undo after it finds everything',
  async () => {
    const root = fakeRoot('include')
    const before = root.etc()
    await root.runCut(applyScript(KEY), 4)
    // finished despite the broken pipe: the record says what was made
    assert.match(root.etc()['/etc/agent-board-backup/record'] ?? '', /user=1/)
    okRun(root.run(undoScript()))
    assert.deepEqual(root.etc(), before)
    assert.doesNotMatch(root.passwd(), /agent-board-backup/)
  },
  60_000,
)
