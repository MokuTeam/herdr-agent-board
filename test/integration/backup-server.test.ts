// The backup's server side on real sshd (#233), off unless BOARD_SERVER_IT=1: the server-setup
// harness's Debian 13, Ubuntu 26.04 and Ubuntu 24.04 servers (Debian 12 and Ubuntu 22.04 too with
// BOARD_SERVER_IT_ALL=1; BOARD_SERVER_IT_LANES=debian13,… picks some), one fresh server each. Per
// server: Look as root finds nothing and the fence would take; Apply; Apply again; then the board's
// own ssh, with the drop key Apply put there, puts a snapshot, lists it and gets it back byte for
// byte, a snapshot cut short is not kept, and a shell command, a port forward and a login as the
// backup user with any other key are refused; root's and the admin's own logins still work; Undo
// takes it all out, keeps the snapshot, and the admin still logs in. Both of sshd's layouts: with
// sshd_config.d included, and with sshd_config alone (its Include taken out first). The drop runs
// under each server's own awk: mawk, Debian's and Ubuntu's default (test/core/backup-server.test.ts
// holds its rotation against rotationKeeps under every awk the machine running it has).
//
// Run it before Apply on a server of your own:
//   BOARD_SERVER_IT=1 bun test test/integration/backup-server.test.ts --timeout 3600000
// About ten minutes with the images built (BOARD_IT_KEEP=1 keeps them and the mirror for the next
// run); skipped, saying so, while Docker does not answer.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { protectKey } from '../../src/adapters/ssh.ts'
import {
  applyScript,
  BACKUP_FENCE,
  BACKUP_KEYS,
  BACKUP_RECORD,
  DROP_FILE,
  lookScript,
  lookVerdict,
  readLook,
  readRun,
  SNAPSHOTS_DIR,
  undoScript,
} from '../../src/core/backup-server.ts'
import {
  buildImage,
  closeLane,
  type Distro,
  dockerUp,
  type Lane,
  noCr,
  removeRun,
  removeStale,
  run,
  startLane,
  startMirror,
  startServer,
  type TestServer,
} from './server/harness.ts'

const ON = process.env.BOARD_SERVER_IT === '1'
function dockerAnswers(): boolean {
  try {
    const r = Bun.spawnSync(['docker', 'info', '--format', '{{.ServerVersion}}'], {
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 60_000,
      windowsHide: true,
    })
    return r.exitCode === 0
  } catch {
    return false
  }
}
const DOCKER = ON && dockerAnswers()
if (ON && !DOCKER)
  console.warn('backup-server: BOARD_SERVER_IT=1, but Docker does not answer: skipped (start Docker Desktop)')
const ALL = process.env.BOARD_SERVER_IT_ALL === '1'
const WINDOWS = process.platform === 'win32'
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const SSH = WINDOWS ? join(SYSTEM32, 'OpenSSH', 'ssh.exe') : 'ssh'
const KEYGEN = WINDOWS ? join(SYSTEM32, 'OpenSSH', 'ssh-keygen.exe') : 'ssh-keygen'
const LANES: Distro[] = (
  ['debian13', 'ubuntu2604', 'ubuntu2404', ...(ALL ? ['debian12', 'ubuntu2204'] : [])] as Distro[]
).filter(d => !process.env.BOARD_SERVER_IT_LANES || process.env.BOARD_SERVER_IT_LANES.split(',').includes(d))
const MIN = 60_000

let dir = ''
let adminKey = ''
let dropKey = ''
let otherKey = ''
const lanes = new Map<Distro, Lane>()

async function keygen(path: string): Promise<string> {
  await run([KEYGEN, '-q', '-t', 'ed25519', '-N', '', '-C', 'agent-board-it', '-f', path])
  const rights = await protectKey(path)
  if (!rights.ok) throw new Error(rights.error)
  return noCr(readFileSync(`${path}.pub`, 'utf8')).trim()
}

/** ssh from this PC to the server, no user config, its key pinned in a known_hosts of the run's own. */
function ssh(s: TestServer, user: string, key: string, command: string[], input?: Buffer, options: string[] = []) {
  const r = Bun.spawnSync(
    [
      SSH,
      '-F',
      'none',
      '-T',
      '-i',
      key,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile=${join(dir, 'known_hosts').replaceAll('\\', '/')}`,
      '-p',
      String(s.sshPort),
      ...options,
      `${user}@127.0.0.1`,
      ...command,
    ],
    { stdin: input ?? 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 120_000 },
  )
  return { code: r.exitCode, out: Buffer.from(r.stdout ?? []), err: Buffer.from(r.stderr ?? []).toString() }
}

const sealed = (n: number) => Buffer.concat([Buffer.from('ABK1'), Buffer.alloc(n, 7)])

async function scenario(l: Lane, include: boolean): Promise<void> {
  const s = await startServer(l, {
    tag: `backup-${include ? 'd' : 'plain'}`,
    withDocker: false,
    adminKey,
    password: 'pw',
  })
  try {
    if (!include) await s.sh("sed -i 's|^Include /etc/ssh/sshd_config.d/\\*.conf|# &|' /etc/ssh/sshd_config && sshd -t")
    const dropPub = noCr(readFileSync(`${dropKey}.pub`, 'utf8')).trim()
    const before = await s.hashes(['/etc/ssh/sshd_config', BACKUP_FENCE])

    const look = readLook((await s.sh(lookScript(dropPub))).stdout.split('\n'))
    expect(look).not.toBeNull()
    expect(look?.include).toBe(include)
    expect(look && lookVerdict(look)).toEqual({ ok: true })

    for (let i = 0; i < 2; i++) {
      const applied = readRun((await s.sh(applyScript(dropPub), { check: false })).stdout.split('\n'))
      expect(applied.fail).toBeNull()
      expect(applied.ok).toBe(true)
    }
    expect((await s.sh(`cat ${BACKUP_RECORD}`)).stdout).toMatch(/^user=1\n/)
    expect((await s.sh(`test -x ${DROP_FILE} && test -f ${BACKUP_KEYS} && echo yes`)).stdout.trim()).toBe('yes')

    // the drop through real sshd, with the board's own key
    const one = sealed(200_000)
    const put = ssh(s, 'agent-board-backup', dropKey, [`put ${one.length}`], one)
    expect(put.code, put.err).toBe(0)
    const name = /^@@put (\S+) (\d+)$/m.exec(put.out.toString())?.[1] ?? ''
    expect(name).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}\.abk$/)
    expect(ssh(s, 'agent-board-backup', dropKey, ['list']).out.toString()).toContain(`${name} ${one.length}`)
    expect(ssh(s, 'agent-board-backup', dropKey, [`get ${name}`]).out.equals(one)).toBe(true)
    // cut short: refused and nothing kept
    const cut = ssh(s, 'agent-board-backup', dropKey, [`put ${one.length}`], one.subarray(0, 1000))
    expect(cut.code).not.toBe(0)
    expect((await s.sh(`ls ${SNAPSHOTS_DIR} | grep -c abk`)).stdout.trim()).toBe('1')
    // nothing but the drop: a shell command, a forward, another key
    expect(ssh(s, 'agent-board-backup', dropKey, ['id']).code).not.toBe(0)
    expect(
      ssh(s, 'agent-board-backup', dropKey, [], undefined, [
        '-N',
        '-L',
        '9999:127.0.0.1:22',
        '-o',
        'ExitOnForwardFailure=yes',
      ]).code,
    ).not.toBe(0)
    expect(ssh(s, 'agent-board-backup', otherKey, ['list']).code).not.toBe(0)
    // the owner's own logins as they were
    expect(ssh(s, 'admin', adminKey, ['true']).code).toBe(0)
    expect(ssh(s, 'root', adminKey, ['true']).code).toBe(0)

    const undone = readRun((await s.sh(undoScript(), { check: false })).stdout.split('\n'))
    expect(undone.ok).toBe(true)
    expect(undone.kept?.count).toBe(1)
    expect(await s.hashes(['/etc/ssh/sshd_config', BACKUP_FENCE])).toEqual(before)
    expect((await s.sh('getent passwd agent-board-backup || echo gone')).stdout.trim()).toBe('gone')
    expect((await s.sh(`ls ${SNAPSHOTS_DIR}`)).stdout.trim()).toBe(name)
    expect(ssh(s, 'admin', adminKey, ['true']).code).toBe(0)
    expect(ssh(s, 'agent-board-backup', dropKey, ['list']).code).not.toBe(0)
  } finally {
    await s.stop()
  }
}

describe.skipIf(!DOCKER)('the backup on Debian and Ubuntu test servers', () => {
  beforeAll(async () => {
    if (!(await dockerUp())) throw new Error('Docker does not answer: start Docker Desktop')
    await removeStale()
    dir = mkdtempSync(join(tmpdir(), 'board-backup-it-'))
    adminKey = join(dir, 'admin_ed25519')
    dropKey = join(dir, 'drop_ed25519')
    otherKey = join(dir, 'other_ed25519')
    await keygen(adminKey)
    await keygen(dropKey)
    await keygen(otherKey)
    await startMirror()
    await Promise.all(LANES.map(d => buildImage(d, false)))
    for (const l of await Promise.all(LANES.map(d => startLane(d)))) lanes.set(l.distro, l)
  }, 60 * MIN)

  afterAll(async () => {
    for (const l of lanes.values()) closeLane(l)
    await removeRun()
  }, 20 * MIN)

  for (const d of LANES)
    for (const include of [true, false])
      test(
        `${d}, ${include ? 'sshd_config.d included' : 'sshd_config alone'}: Look, Apply twice, the drop, Undo`,
        async () => {
          const l = lanes.get(d)
          if (!l) throw new Error(`no lane for ${d}`)
          await scenario(l, include)
        },
        20 * MIN,
      )
})
