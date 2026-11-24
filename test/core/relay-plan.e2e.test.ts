// End-to-end tests of the relay scripts on the fake root (test/support/fake-root.ts) and real
// POSIX sh / dash: syntax checks, AuthorizedKeysCommand, forced-command enrol script, full
// Look -> Apply -> second Apply (no-op) -> Undo, plain sshd_config fallback, coexistence with
// tunnel/backup/node setups, and rollbacks on sshd errors.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRelayRun, relayLookScript, relayPlan, relayRunScript, relayUndoPlan } from '../../src/core/relay-plan.ts'
import {
  RELAY_ENROL_SCRIPT,
  RELAY_ETC,
  RELAY_FENCE,
  RELAY_KEYS_CMD,
  RELAY_KEYS_DIR,
  RELAY_MASTER_KEYS,
  RELAY_MASTER_USER,
  RELAY_NODE_USER,
  RELAY_RECORD,
  RELAY_SOCKETS_DIR,
  relayEnrolScript,
  relayFenceFile,
  relayFenceMarked,
  relayKeysCommand,
  relayMasterKeysFile,
} from '../../src/core/relay-texts.ts'
import { sh } from '../support/fake-root.ts'
import { ENROL_KEY, MASTER_KEY, NODE_KEY_A, NODE_KEY_B, relayServer, stepsOf } from '../support/relay-root.ts'

const TUNNEL_DROP_IN = "# agent-board: the tunnel's fence\nMatch User agent-board-tunnel\n    ForceCommand /bin/false\n"
const BACKUP_DROP_IN =
  "# agent-board: sshd's fence for the board's backup user\nMatch User agent-board-backup\n    ForceCommand /etc/agent-board-backup/drop\nMatch all\n"
const NODE_DROP_IN =
  "# agent-board: sshd's fence for the node's link user\nMatch User agent-board-link\n    ForceCommand /bin/false\nMatch all\n"

test.skipIf(!sh)('every relay script parses cleanly under POSIX sh', () => {
  const s = relayServer('include')
  const f = s.look(false)
  const dir = mkdtempSync(join(tmpdir(), 'board-relay-sh-'))
  try {
    const p = relayPlan(f, s.wanted())
    if (!p.ok) throw new Error(`refused: ${JSON.stringify(p.why)}`)
    const allRec = {
      v: 1 as const,
      run: 'r',
      at: '2026-11-24T10:00:00Z',
      state: 'applied' as const,
      items: [
        { kind: 'user' as const, name: RELAY_NODE_USER },
        { kind: 'user' as const, name: RELAY_MASTER_USER },
        { kind: 'socketsDir' as const },
        { kind: 'keysDir' as const },
        { kind: 'keysCmd' as const },
        { kind: 'enrol' as const },
        { kind: 'authKeysDir' as const },
        { kind: 'masterKeys' as const },
        { kind: 'fence' as const },
      ],
    }
    const scripts: [string, string][] = [
      ['look', relayLookScript({ masterKey: MASTER_KEY, enrolKey: ENROL_KEY })],
      ['keys-cmd', relayKeysCommand()],
      ['enrol', relayEnrolScript()],
      ['apply', relayRunScript(p.plan, { id: 'r', at: '2026-11-24T10:00:00Z' })],
      ['undo', relayRunScript(relayUndoPlan(allRec, { enrolled: 1 }), { id: 'u', at: '2026-11-24T10:00:00Z' })],
    ]
    for (const [name, text] of scripts) {
      const file = join(dir, `${name}.sh`)
      writeFileSync(file, text)
      const r = spawnSync(sh as string, ['-n', file], { encoding: 'utf8' })
      expect([name, r.status, r.stderr]).toEqual([name, 0, ''])
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe.skipIf(!sh)('enrol script and AuthorizedKeysCommand', () => {
  test('enrol adds, lists, replaces and removes valid keys; keys command prints them for relay-n only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-relay-enrol-'))
    try {
      const keysDir = join(dir, 'keys')
      mkdirSync(keysDir, { mode: 0o700 })
      const enrolPath = join(dir, 'enrol.sh')
      const keysCmdPath = join(dir, 'keys.sh')
      writeFileSync(enrolPath, relayEnrolScript({ keysDir, maxKeys: 3 }))
      writeFileSync(keysCmdPath, relayKeysCommand(keysDir))

      const runEnrol = (cmd: string) =>
        spawnSync(sh as string, [enrolPath], {
          env: { ...process.env, SSH_ORIGINAL_COMMAND: cmd },
          encoding: 'utf8',
        })
      const runKeys = (user: string) => spawnSync(sh as string, [keysCmdPath, user], { encoding: 'utf8' })

      expect(runEnrol('check').stdout.trim()).toBe('@@ok 1')
      expect(runEnrol('list').stdout.trim()).toBe('')

      const rsaKey = `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC${'A'.repeat(41)} laptop`
      const a1 = runEnrol(`add node-a ${NODE_KEY_A}`)
      expect([a1.status, a1.stdout.trim()]).toEqual([0, '@@added node-a'])
      const a2 = runEnrol(`add node-b ${rsaKey}`)
      expect([a2.status, a2.stdout.trim()]).toEqual([0, '@@added node-b'])
      expect(runEnrol('list').stdout.trim().split('\n')).toEqual(['node-a', 'node-b'])

      // Replace existing key without hitting maxKeys
      const a3 = runEnrol(`add node-a ${NODE_KEY_B}`)
      expect([a3.status, a3.stdout.trim()]).toEqual([0, '@@added node-a'])
      const a4 = runEnrol(`add node-c ${NODE_KEY_A}`)
      expect([a4.status, a4.stdout.trim()]).toEqual([0, '@@added node-c'])
      // 4th distinct key exceeds maxKeys=3
      const over = runEnrol(`add node-d ${NODE_KEY_A}`)
      expect(over.status).toBe(1)
      expect(over.stderr).toContain('too many relay keys')

      // AuthorizedKeysCommand outputs restricted lines for relay-n only
      const outN = runKeys(RELAY_NODE_USER)
      expect(outN.status).toBe(0)
      const lines = outN.stdout.trim().split('\n')
      expect(lines).toEqual([
        `restrict,port-forwarding ${NODE_KEY_B.split(' ').slice(0, 2).join(' ')}`,
        `restrict,port-forwarding ${rsaKey.split(' ').slice(0, 2).join(' ')}`,
        `restrict,port-forwarding ${NODE_KEY_A.split(' ').slice(0, 2).join(' ')}`,
      ])
      expect(runKeys(RELAY_MASTER_USER).stdout).toBe('')
      expect(runKeys('root').stdout).toBe('')

      // Symlink and corrupt files in keysDir are ignored by AuthorizedKeysCommand
      writeFileSync(join(keysDir, 'corrupt.pub'), 'restrict,command="/bin/sh" ssh-ed25519 AAAA\n')
      symlinkSync(join(keysDir, 'node-a.pub'), join(keysDir, 'link.pub'))
      expect(runKeys(RELAY_NODE_USER).stdout.trim().split('\n')).toHaveLength(3)
      rmSync(join(keysDir, 'corrupt.pub'))
      rmSync(join(keysDir, 'link.pub'))

      // Remove existing and missing
      expect(runEnrol('remove node-b').stdout.trim()).toBe('@@removed node-b')
      expect(runEnrol('remove node-b').stdout.trim()).toBe('@@missing node-b')
      expect(runEnrol('list').stdout.trim().split('\n')).toEqual(['node-a', 'node-c'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('enrol refuses shell injections, bad names, non-keys, option injections and extra commands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-relay-bad-'))
    try {
      const keysDir = join(dir, 'keys')
      mkdirSync(keysDir, { mode: 0o700 })
      const enrolPath = join(dir, 'enrol.sh')
      writeFileSync(enrolPath, relayEnrolScript({ keysDir }))
      const runEnrol = (cmd: string) =>
        spawnSync(sh as string, [enrolPath], {
          env: { ...process.env, SSH_ORIGINAL_COMMAND: cmd },
          encoding: 'utf8',
        })
      const validBody = NODE_KEY_A.split(' ').slice(0, 2).join(' ')
      for (const bad of [
        '',
        'id',
        'sh',
        'check extra',
        'list extra',
        'list; rm -rf /',
        `add ../evil ${validBody}`,
        `add -flag ${validBody}`,
        `add Upper ${validBody}`,
        `add bad_name ${validBody}`,
        `add ${'a'.repeat(65)} ${validBody}`,
        `add node-1 ${validBody}\nid`,
        `add node-1 restrict,command="/bin/sh" ${validBody}`,
        'add node-1 not-a-key',
        'add node-1 ssh-ed25519 short',
        'add node-1 ssh-ed25519 AAAAB3NzaC1yc2EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        `add node-1 ${validBody} $(id)`,
        'remove ../evil',
        'remove *',
        'remove a b',
      ]) {
        if (bad.endsWith('$(id)')) {
          // Shell globbing/expansion disabled; comment ignored, key body itself is validated
          const r = runEnrol(bad)
          expect(r.status).toBe(0)
          expect(readFileSync(join(keysDir, 'node-1.pub'), 'utf8')).toBe(`${validBody} node-1\n`)
        } else {
          const r = runEnrol(bad)
          expect([bad, r.status]).toEqual([bad, 1])
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!sh)('Apply, idempotency, coexistence and Undo on fake root', () => {
  test('Apply sets up both users, dirs, scripts, keys and fence; second Apply skips all; coexists byte-for-byte; Undo restores cleanly', () => {
    const s = relayServer('include')
    const R = s.root.R
    // Pre-existing tunnel, backup and node drop-ins and users must stay untouched byte for byte
    writeFileSync(s.root.path('/etc/ssh/sshd_config.d/00-agent-board.conf'), TUNNEL_DROP_IN)
    writeFileSync(s.root.path('/etc/ssh/sshd_config.d/00-agent-board-backup.conf'), BACKUP_DROP_IN)
    writeFileSync(s.root.path('/etc/ssh/sshd_config.d/00-agent-board-node.conf'), NODE_DROP_IN)
    writeFileSync(
      s.root.path('/state/passwd'),
      `${s.root.passwd()}boardtunnel:x:901:901:agent-board tunnel:/nonexistent:/usr/sbin/nologin\nagent-board-backup:x:902:902:agent-board backup:/var/lib/agent-board-backup:/bin/sh\nagent-board-link:x:903:903:agent-board node link:/nonexistent:/usr/sbin/nologin\n`,
    )
    const beforeEtc = s.root.etc()
    const beforePasswd = s.root.passwd()

    const preLook = s.look(false)
    expect(preLook.sshdNow).toBe('ok')
    expect(existsSync(s.root.path('/run/sshd'))).toBe(false)

    const r1 = s.apply({ withKeys: false })
    expect(r1.result).toBe('applied')
    expect(stepsOf(r1)).toEqual(['check ok', 'users ok', 'folders ok', 'scripts ok', 'keys ok', 'fence ok'])

    const etc = s.root.etc()
    const added = Object.keys(etc)
      .filter(k => !(k in beforeEtc))
      .sort()
    expect(added).toEqual([RELAY_ENROL_SCRIPT, RELAY_KEYS_CMD, RELAY_RECORD, RELAY_MASTER_KEYS, RELAY_FENCE])
    for (const [k, v] of Object.entries(beforeEtc)) expect([k, etc[k]]).toEqual([k, v])

    const onRoot = (text: string): string =>
      text.replaceAll('/etc/', `${R}/etc/`).replaceAll('/var/lib/agent-board-relay', `${R}/var/lib/agent-board-relay`)
    expect(etc[RELAY_FENCE]).toBe(onRoot(relayFenceFile()))
    expect(etc[RELAY_KEYS_CMD]).toBe(onRoot(relayKeysCommand()))
    expect(etc[RELAY_ENROL_SCRIPT]).toBe(onRoot(relayEnrolScript()))
    expect(etc[RELAY_MASTER_KEYS]).toBe(onRoot(relayMasterKeysFile(MASTER_KEY, ENROL_KEY)))
    expect(s.root.passwd()).toContain(`${RELAY_NODE_USER}:x:900:900:agent-board relay node:/nonexistent:`)
    expect(s.root.passwd()).toContain(`${RELAY_MASTER_USER}:x:900:900:agent-board relay master:/nonexistent:`)
    expect(s.root.log()).toContain(
      `useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --comment agent-board relay node ${RELAY_NODE_USER}`,
    )
    expect(s.root.log()).toContain(
      `useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /bin/sh --comment agent-board relay master ${RELAY_MASTER_USER}`,
    )

    const f1 = s.look(true)
    expect(f1).toMatchObject({
      nodeUser: 'ours',
      masterUser: 'ours',
      socketsDir: 'same',
      keysDir: 'same',
      authKeysDir: true,
      keysCmd: 'same',
      enrol: 'same',
      masterKeys: 'same',
      fence: 'file-same',
      sshdNow: 'ok',
      candidate: 'ok',
    })

    // Second Apply skips every changing step and leaves files byte-for-byte identical
    const etc1 = s.root.etc()
    const logLen = s.root.log().length
    const r2 = s.apply({ withKeys: true })
    expect(r2.result).toBe('applied')
    expect(stepsOf(r2)).toEqual(['check ok', 'users skip', 'folders skip', 'scripts skip', 'keys skip', 'fence skip'])
    expect(s.root.etc()).toEqual(etc1)
    const moreLog = s.root.log().slice(logLen)
    for (const op of ['useradd', 'userdel', 'chown']) expect(moreLog).not.toContain(op)

    // Undo removes relay setup only and restores other setups byte-for-byte
    const u1 = s.undo()
    expect(u1.result).toBe('undone')
    expect(stepsOf(u1)).toEqual(['check ok', 'fence ok', 'keys ok', 'scripts ok', 'folders ok', 'users ok'])
    expect(s.root.etc()).toEqual(beforeEtc)
    expect(s.root.passwd()).toBe(beforePasswd)
    expect(existsSync(s.root.path(RELAY_SOCKETS_DIR))).toBe(false)
    expect(existsSync(s.root.path(RELAY_KEYS_DIR))).toBe(false)
    expect(existsSync(s.root.path(RELAY_ETC))).toBe(false)

    // Second Undo finds no record
    const emptyRec = { v: 1 as const, run: 'x', at: '2026-11-24T10:00:00Z', state: 'applied' as const, items: [] }
    const u2 = readRelayRun(
      s.root.run(relayRunScript(relayUndoPlan(emptyRec), { id: 'u2', at: '2026-11-24T12:00:00Z' })).lines,
    )
    expect(u2.result).toBe('none')
  }, 120_000)

  test('plain sshd_config without Include uses marked block and Undo removes only the relay block', () => {
    const s = relayServer('plain')
    const R = s.root.R
    const tunnelBlock =
      '# >>> agent-board tunnel\nMatch User boardtunnel\n    ForceCommand /bin/false\n# <<< agent-board tunnel\n'
    writeFileSync(
      s.root.path('/etc/ssh/sshd_config'),
      `${readFileSync(s.root.path('/etc/ssh/sshd_config'), 'utf8')}${tunnelBlock}`,
    )
    const beforeEtc = s.root.etc()

    const r1 = s.apply({ withKeys: false })
    expect(r1.result).toBe('applied')
    const conf = readFileSync(s.root.path('/etc/ssh/sshd_config'), 'utf8')
    const onRoot = (text: string) =>
      text.replaceAll('/etc/', `${R}/etc/`).replaceAll('/var/lib/agent-board-relay', `${R}/var/lib/agent-board-relay`)
    expect(conf).toContain(tunnelBlock)
    expect(conf).toContain(onRoot(relayFenceMarked()))
    expect(s.look(true).fence).toBe('block-same')

    const r2 = s.apply({ withKeys: true })
    expect(stepsOf(r2)).toEqual(['check ok', 'users skip', 'folders skip', 'scripts skip', 'keys skip', 'fence skip'])

    const u = s.undo()
    expect(u.result).toBe('undone')
    expect(s.root.etc()).toEqual(beforeEtc)
  }, 120_000)

  test('failed fence step rolls back users, folders, scripts, keys and record completely', () => {
    const s = relayServer('include')
    const beforeEtc = s.root.etc()
    const beforePasswd = s.root.passwd()

    const r = s.apply({ withKeys: false, env: { RELAY_LEAK: '1' } })
    expect(r.result).toBe('rolled-back')
    expect(stepsOf(r)).toEqual(['check ok', 'users ok', 'folders ok', 'scripts ok', 'keys ok', 'fence fail'])
    expect(r.undone).toEqual([
      { id: 'fence', ok: true },
      { id: 'keys', ok: true },
      { id: 'scripts', ok: true },
      { id: 'folders', ok: true },
      { id: 'users', ok: true },
    ])
    expect(s.root.etc()).toEqual(beforeEtc)
    expect(s.root.passwd()).toBe(beforePasswd)
    expect(existsSync(s.root.path(RELAY_SOCKETS_DIR))).toBe(false)
    expect(existsSync(s.root.path(RELAY_KEYS_DIR))).toBe(false)
    expect(existsSync(s.root.path(RELAY_ETC))).toBe(false)
  }, 120_000)
})
