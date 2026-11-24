// The relay on real Debian and Ubuntu sshd servers (#511, design 20), off unless BOARD_SERVER_IT=1:
// Look, Apply twice, enrol adds a node key, node user makes a remote unix socket forward (-R) and
// nothing else (no TCP forward, no shell, no TTY), master user opens that socket (-L) and exchanges
// HTTP bytes through it and nothing else (no TCP forward, no -R, no shell, no enrol), enrol key
// runs enrol only and cannot forward or get a shell, enrol removes the key and node user is
// refused, admin/root logins still work, Undo removes everything cleanly.
//
// Run:
//   BOARD_SERVER_IT=1 bun test test/integration/relay-setup.test.ts --timeout 3600000
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { protectKey } from '../../src/adapters/ssh.ts'
import {
  readRelayLook,
  readRelayRun,
  relayLookScript,
  relayPlan,
  relayRunScript,
  relayUndoPlan,
} from '../../src/core/relay-plan.ts'
import {
  RELAY_ENROL_SCRIPT,
  RELAY_FENCE,
  RELAY_KEYS_CMD,
  RELAY_MASTER_KEYS,
  RELAY_MASTER_USER,
  RELAY_NODE_USER,
  RELAY_RECORD,
  RELAY_SOCKETS_DIR,
} from '../../src/core/relay-texts.ts'
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
  console.warn('relay-setup: BOARD_SERVER_IT=1, but Docker does not answer: skipped (start Docker Desktop)')
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
let masterKey = ''
let enrolKey = ''
let nodeKey = ''
let otherKey = ''
const lanes = new Map<Distro, Lane>()

async function keygen(path: string): Promise<string> {
  await run([KEYGEN, '-q', '-t', 'ed25519', '-N', '', '-C', 'agent-board-it', '-f', path])
  const rights = await protectKey(path)
  if (!rights.ok) throw new Error(rights.error)
  return noCr(readFileSync(`${path}.pub`, 'utf8')).trim()
}

function sshSync(s: TestServer, user: string, key: string, command: string[], options: string[] = []) {
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
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000 },
  )
  return { code: r.exitCode, out: Buffer.from(r.stdout ?? []).toString(), err: Buffer.from(r.stderr ?? []).toString() }
}

function sshBg(s: TestServer, user: string, key: string, options: string[]) {
  return Bun.spawn(
    [
      SSH,
      '-F',
      'none',
      '-N',
      '-i',
      key,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile=${join(dir, 'known_hosts').replaceAll('\\', '/')}`,
      '-p',
      String(s.sshPort),
      ...options,
      `${user}@127.0.0.1`,
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  )
}

async function scenario(l: Lane, include: boolean): Promise<void> {
  const s = await startServer(l, {
    tag: `relay-${include ? 'd' : 'plain'}`,
    withDocker: false,
    adminKey,
    password: 'pw',
  })
  try {
    if (!include) await s.sh("sed -i 's|^Include /etc/ssh/sshd_config.d/\\*.conf|# &|' /etc/ssh/sshd_config && sshd -t")
    const masterPub = noCr(readFileSync(`${masterKey}.pub`, 'utf8')).trim()
    const enrolPub = noCr(readFileSync(`${enrolKey}.pub`, 'utf8')).trim()
    const nodePub = noCr(readFileSync(`${nodeKey}.pub`, 'utf8')).trim()
    const before = await s.hashes(['/etc/ssh/sshd_config', RELAY_FENCE])

    const look1 = readRelayLook(
      (await s.sh(relayLookScript({ masterKey: masterPub, enrolKey: enrolPub }))).stdout.split('\n'),
    )
    expect(look1).not.toBeNull()
    if (!look1) return
    expect(look1.include).toBe(include)
    expect(look1.candidate).toBe('ok')
    const built = relayPlan(look1, { masterKey: masterPub, enrolKey: enrolPub })
    expect(built.ok).toBe(true)
    if (!built.ok) return

    for (let i = 0; i < 2; i++) {
      const f = readRelayLook(
        (await s.sh(relayLookScript({ masterKey: masterPub, enrolKey: enrolPub }))).stdout.split('\n'),
      )
      expect(f).not.toBeNull()
      if (!f) return
      const p = relayPlan(f, { masterKey: masterPub, enrolKey: enrolPub })
      expect(p.ok).toBe(true)
      if (!p.ok) return
      const res = readRelayRun(
        (
          await s.sh(relayRunScript(p.plan, { id: `it-${i}`, at: '2026-11-24T10:00:00Z' }), { check: false })
        ).stdout.split('\n'),
      )
      expect(res.result).toBe('applied')
    }
    expect(
      (
        await s.sh(
          `test -x ${RELAY_KEYS_CMD} && test -x ${RELAY_ENROL_SCRIPT} && test -f ${RELAY_MASTER_KEYS} && echo yes`,
        )
      ).stdout.trim(),
    ).toBe('yes')

    // Enrol key: check, add node-a, list, refuse shell/forwarding
    expect(sshSync(s, RELAY_MASTER_USER, enrolKey, ['check']).out.trim()).toBe('@@ok 1')
    expect(sshSync(s, RELAY_MASTER_USER, enrolKey, [`add node-a ${nodePub}`]).out.trim()).toBe('@@added node-a')
    expect(sshSync(s, RELAY_MASTER_USER, enrolKey, ['list']).out.trim()).toBe('node-a')
    expect(sshSync(s, RELAY_MASTER_USER, enrolKey, ['id']).code).not.toBe(0)

    // Node user: -R unix socket forward works, TCP forward and shell/TTY refused
    const localSrv = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('relay-ok') })
    const sock = `${RELAY_SOCKETS_DIR}/node-a.sock`
    const nodeFwd = sshBg(s, RELAY_NODE_USER, nodeKey, ['-R', `${sock}:127.0.0.1:${localSrv.port}`])
    let masterFwd: ReturnType<typeof sshBg> | null = null
    try {
      let body = ''
      const localPort = 25000 + Math.floor(Math.random() * 15000)
      for (let i = 0; i < 30; i++) {
        await Bun.sleep(200)
        if ((await s.sh(`test -S ${sock} && echo yes`, { check: false })).stdout.trim() === 'yes') break
      }
      masterFwd = sshBg(s, RELAY_MASTER_USER, masterKey, ['-L', `127.0.0.1:${localPort}:${sock}`])
      for (let i = 0; i < 30; i++) {
        await Bun.sleep(200)
        try {
          const r = await fetch(`http://127.0.0.1:${localPort}/`, { signal: AbortSignal.timeout(2000) })
          body = await r.text()
          break
        } catch {}
      }
      expect(body).toBe('relay-ok')

      // Refusals for node user: TCP -R, TCP -L, shell, TTY, unknown key
      expect(sshSync(s, RELAY_NODE_USER, nodeKey, ['id']).code).not.toBe(0)
      expect(sshSync(s, RELAY_NODE_USER, nodeKey, ['-t', 'sh']).code).not.toBe(0)
      expect(
        sshSync(
          s,
          RELAY_NODE_USER,
          nodeKey,
          [],
          ['-N', '-R', '127.0.0.1:19999:127.0.0.1:22', '-o', 'ExitOnForwardFailure=yes'],
        ).code,
      ).not.toBe(0)
      expect(
        sshSync(
          s,
          RELAY_NODE_USER,
          nodeKey,
          [],
          ['-N', '-L', '127.0.0.1:19998:127.0.0.1:22', '-o', 'ExitOnForwardFailure=yes'],
        ).code,
      ).not.toBe(0)
      expect(sshSync(s, RELAY_NODE_USER, otherKey, ['true']).code).not.toBe(0)

      // Refusals for master user: TCP -L, -R socket, shell, enrol command with forward key
      expect(sshSync(s, RELAY_MASTER_USER, masterKey, ['id']).code).not.toBe(0)
      expect(sshSync(s, RELAY_MASTER_USER, masterKey, ['check']).code).not.toBe(0)
      expect(
        sshSync(
          s,
          RELAY_MASTER_USER,
          masterKey,
          [],
          ['-N', '-L', '127.0.0.1:19997:127.0.0.1:22', '-o', 'ExitOnForwardFailure=yes'],
        ).code,
      ).not.toBe(0)
      expect(
        sshSync(
          s,
          RELAY_MASTER_USER,
          masterKey,
          [],
          ['-N', '-R', `${RELAY_SOCKETS_DIR}/bad.sock:127.0.0.1:22`, '-o', 'ExitOnForwardFailure=yes'],
        ).code,
      ).not.toBe(0)
    } finally {
      masterFwd?.kill()
      nodeFwd.kill()
      localSrv.stop(true)
    }

    // Removing key locks out node-a immediately
    expect(sshSync(s, RELAY_MASTER_USER, enrolKey, ['remove node-a']).out.trim()).toBe('@@removed node-a')
    expect(
      sshSync(s, RELAY_NODE_USER, nodeKey, [], ['-N', '-R', `${sock}:127.0.0.1:22`, '-o', 'ExitOnForwardFailure=yes'])
        .code,
    ).not.toBe(0)

    // Admin and root untouched
    expect(sshSync(s, 'admin', adminKey, ['true']).code).toBe(0)
    expect(sshSync(s, 'root', adminKey, ['true']).code).toBe(0)

    // Undo
    const rec = JSON.parse((await s.sh(`cat ${RELAY_RECORD}`)).stdout)
    const undo = relayUndoPlan(rec)
    const undone = readRelayRun(
      (await s.sh(relayRunScript(undo, { id: 'it-undo', at: '2026-11-24T11:00:00Z' }), { check: false })).stdout.split(
        '\n',
      ),
    )
    expect(undone.result).toBe('undone')
    expect(await s.hashes(['/etc/ssh/sshd_config', RELAY_FENCE])).toEqual(before)
    expect((await s.sh(`getent passwd ${RELAY_NODE_USER} || echo gone`)).stdout.trim()).toBe('gone')
    expect((await s.sh(`getent passwd ${RELAY_MASTER_USER} || echo gone`)).stdout.trim()).toBe('gone')
    expect(sshSync(s, 'admin', adminKey, ['true']).code).toBe(0)
  } finally {
    await s.stop()
  }
}

describe.skipIf(!DOCKER)('the relay on Debian and Ubuntu test servers', () => {
  beforeAll(async () => {
    if (!(await dockerUp())) throw new Error('Docker does not answer: start Docker Desktop')
    await removeStale()
    dir = mkdtempSync(join(tmpdir(), 'board-relay-it-'))
    adminKey = join(dir, 'admin_ed25519')
    masterKey = join(dir, 'master_ed25519')
    enrolKey = join(dir, 'enrol_ed25519')
    nodeKey = join(dir, 'node_ed25519')
    otherKey = join(dir, 'other_ed25519')
    for (const k of [adminKey, masterKey, enrolKey, nodeKey, otherKey]) await keygen(k)
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
        `${d}, ${include ? 'sshd_config.d included' : 'sshd_config alone'}: Look, Apply twice, forwards, enrol, Undo`,
        async () => {
          const l = lanes.get(d)
          if (!l) throw new Error(`no lane for ${d}`)
          await scenario(l, include)
        },
        20 * MIN,
      )
})
