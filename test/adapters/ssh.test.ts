import { expect, setDefaultTimeout, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../../src/adapters/paths.ts'
import {
  commandLineOf,
  endStraySsh,
  forgetHostKey,
  generatedKey,
  generateKey,
  hostKeyFingerprint,
  keyPath,
  knownHostsFile,
  protectKey,
  publicKeyOf,
  readPidRecord,
  type SshChild,
  spawnSsh,
  sshBin,
  sshKeygenBin,
  sshPidFile,
  tunnelDir,
  writePidRecord,
} from '../../src/adapters/ssh.ts'
import {
  forwardAccepted,
  forwardSpec,
  sshArgs,
  sshPathArg,
  TUNNEL_SOCKET,
  tunnelConfig,
} from '../../src/core/tunnel.ts'
import { isolatedHome } from '../support/env.ts'
import { useFakeSsh } from '../support/fake-ssh-bin.ts'
import { sandbox, until } from '../support/sandbox.ts'

// The first run compiles the fake ssh; PowerShell takes a second or two per command line it reads.
setDefaultTimeout(60_000)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Every line ssh printed, as it comes. */
function linesOf(child: SshChild): string[] {
  const lines: string[] = []
  child.onLine(line => lines.push(line))
  return lines
}

const ICACLS = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe')
const WHOAMI = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe')
const icacls = (...args: string[]): string => {
  const r = Bun.spawnSync([ICACLS, ...args])
  if (r.exitCode !== 0) throw new Error(`icacls ${args.join(' ')}: ${r.stdout.toString()}${r.stderr.toString()}`)
  return r.stdout.toString()
}
/** A folder whose files inherit read rights for every user (BUILTIN\Users). */
const sharedFolder = (path: string): string => {
  mkdirSync(path, { recursive: true })
  icacls(path, '/grant', '*S-1-5-32-545:(OI)(CI)R')
  return path
}
const OTHERS = ['BUILTIN\\Users', 'Everyone', 'Authenticated Users']
function expectOwnerOnly(file: string): void {
  const me = Bun.spawnSync([WHOAMI]).stdout.toString().trim().toLowerCase()
  const acl = icacls(file)
  expect(acl.toLowerCase()).toContain(me)
  for (const other of OTHERS) expect(acl).not.toContain(other)
}

for (const [find, name, variable] of [
  [sshBin, 'ssh', 'BOARD_SSH_BIN_PATH'],
  [sshKeygenBin, 'ssh-keygen', 'BOARD_SSH_KEYGEN_BIN_PATH'],
] as const) {
  test(`${name}: the variable's binary as it is, then Windows' own by its full path, then PATH`, () => {
    const own = `C:\\Windows\\System32\\OpenSSH\\${name}.exe`
    const asked: string[] = []
    const onPath = (n: string): string => {
      asked.push(n)
      return `C:\\Program Files\\Git\\usr\\bin\\${n}.exe`
    }
    const env = { SystemRoot: 'C:\\Windows' }
    // Never checked and never passed over: a sandbox's missing file fails as ENOENT and never
    // reaches System32's ssh.
    const missing = 'Z:\\sandbox\\no-ssh.exe'
    expect(find({ env: { ...env, [variable]: missing }, platform: 'win32', exists: p => p === own, onPath })).toBe(
      missing,
    )
    expect(find({ env, platform: 'win32', exists: p => p === own, onPath })).toBe(own)
    expect(find({ env: {}, platform: 'win32', exists: p => p === own, onPath })).toBe(own)
    expect(asked).toEqual([])
    expect(find({ env: { ...env, [variable]: '' }, platform: 'win32', exists: () => false, onPath })).toBe(
      `C:\\Program Files\\Git\\usr\\bin\\${name}.exe`,
    )
    expect(asked).toEqual([name])
    expect(find({ env, platform: 'linux', exists: () => true, onPath: n => `/usr/bin/${n}` })).toBe(`/usr/bin/${name}`)
    expect(find({ env, platform: 'win32', exists: () => false, onPath: () => null })).toBeNull()
    expect(find({ env, platform: 'darwin', exists: () => true, onPath: () => null })).toBeNull()
  })
}

// Real keys and their fingerprints (ssh-keygen -l), for known_hosts lines a real ssh-keygen reads.
const PINNED = {
  other: [
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDuETipp9IbUjER7VK34Uj0C5eo3D09vl/vmi9C/c6vT',
    'SHA256:KRNrLyeVP4ZZ7K5ZndLF0YRWZ0gsCYuX1d2bGMwg/wA',
  ],
  port: [
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKL1dGYOTRP48yQqrM3HkepN1J+NFxGgPOg8lzkL4SCF',
    'SHA256:33SIdqAIgs3GD/7ukP0zxPzShDH7OFPQnPSN9tRDjY0',
  ],
  ours: [
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC5VpUoDKt8tav3IU1WGcMIhUE+OnFRHYJicrpjElT7d',
    'SHA256:wr7JwRu0IgTi4MrGFVIWZO0VCDrXGXemWzvoSY6p9jo',
  ],
} as const
/** A host's name hashed as ssh's HashKnownHosts writes it: |1|salt|HMAC-SHA1(salt, name), the salt 20 bytes. */
const hashedName = (name: string, salt: string): string =>
  `|1|${Buffer.from(salt).toString('base64')}|${createHmac('sha1', Buffer.from(salt)).update(name).digest('base64')}`

test('hostKeyFingerprint: the key pinned for this server and port, whatever other servers the file holds, plain or hashed (a real ssh-keygen)', async () => {
  const real = Bun.which('ssh-keygen')
  if (!real) return
  isolatedHome()
  process.env.BOARD_SSH_KEYGEN_BIN_PATH = real
  mkdirSync(tunnelDir(), { recursive: true })
  const lines = (names: [string, string, string]): string =>
    [`${names[0]} ${PINNED.other[0]}`, `${names[1]} ${PINNED.port[0]}`, `${names[2]} ${PINNED.ours[0]}`, ''].join('\n')
  const plain = lines(['other.example.com', '[ssh.example.com]:2222', 'ssh.example.com,203.0.113.7'])
  const hashed = lines([
    hashedName('other.example.com', 'salt-one-twenty-byte'),
    hashedName('[ssh.example.com]:2222', 'salt-two-twenty-byte'),
    hashedName('ssh.example.com', 'salt-three-twenty-by'),
  ])
  for (const text of [plain, hashed]) {
    writeFileSync(knownHostsFile(), text)
    // not the first line's: the one for this name, port 22 bare, another port in brackets
    expect(await hostKeyFingerprint('ssh.example.com', 22)).toBe(`${PINNED.ours[1]} (ED25519)`)
    expect(await hostKeyFingerprint('SSH.example.com', 22)).toBe(`${PINNED.ours[1]} (ED25519)`)
    expect(await hostKeyFingerprint('ssh.example.com', 2222)).toBe(`${PINNED.port[1]} (ED25519)`)
    expect(await hostKeyFingerprint('other.example.com', 22)).toBe(`${PINNED.other[1]} (ED25519)`)
    // a server the file does not pin, or a port it does not
    expect(await hostKeyFingerprint('board.example.com', 22)).toBeNull()
    expect(await hostKeyFingerprint('ssh.example.com', 2200)).toBeNull()
    expect(await hostKeyFingerprint('', 22)).toBeNull()
  }
})

test('isolatedHome() and sandbox() point ssh and ssh-keygen at files that do not exist: nothing real is reached', async () => {
  const dir = isolatedHome()
  for (const bin of [sshBin(), sshKeygenBin()]) {
    expect(bin?.startsWith(dir)).toBe(true)
    expect(existsSync(bin as string)).toBe(false)
  }
  const ssh = spawnSsh(sshBin() as string, ['-V'])
  expect(await ssh.exited).toEqual({ code: null, error: 'ENOENT' })
  expect(await publicKeyOf(join(dir, 'key'))).toMatchObject({ ok: false, hint: 'noSsh' })
  expect(await generateKey('agent-board@PC')).toMatchObject({ ok: false })
  expect(await hostKeyFingerprint('ssh.example.com', 22)).toBeNull()
  const box = await sandbox()
  for (const bin of [box.env.BOARD_SSH_BIN_PATH, box.env.BOARD_SSH_KEYGEN_BIN_PATH]) {
    expect(bin?.startsWith(box.dir)).toBe(true)
    expect(existsSync(bin as string)).toBe(false)
  }
})

test("the tunnel's files live in the state folder's tunnel/; the key is the owner's or the generated one", () => {
  isolatedHome()
  expect(tunnelDir()).toBe(join(stateDir(), 'tunnel'))
  expect(generatedKey()).toBe(join(tunnelDir(), 'id_ed25519'))
  expect(knownHostsFile()).toBe(join(tunnelDir(), 'known_hosts'))
  expect(sshPidFile()).toBe(join(tunnelDir(), 'ssh-pid.json'))
  expect(keyPath(tunnelConfig({}))).toBe(generatedKey())
  expect(keyPath(tunnelConfig({ key: 'D:\\keys\\board' }))).toBe('D:\\keys\\board')
})

test('generateKey makes the pair with ssh-keygen and replaces an old one; publicKeyOf reads it back or says why not', async () => {
  const fake = await useFakeSsh()
  expect(await generateKey('agent-board@PC')).toEqual({
    ok: true,
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEKEY agent-board@PC',
  })
  expect(existsSync(generatedKey())).toBe(true)
  expect(readFileSync(`${generatedKey()}.pub`, 'utf8').trim()).toMatch(/ agent-board@PC$/)
  // No shell: the empty passphrase is an argument of its own.
  expect(fake.calls()).toEqual([['-q', '-t', 'ed25519', '-N', '', '-C', 'agent-board@PC', '-f', generatedKey()]])

  // ssh-keygen would ask before overwriting (the fake refuses as a prompt with no answer does).
  const again = { ok: true, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEKEY agent-board@OTHER' } as const
  expect(await generateKey('agent-board@OTHER')).toEqual(again)
  expect(readFileSync(`${generatedKey()}.pub`, 'utf8')).toContain('agent-board@OTHER')

  expect(await publicKeyOf(generatedKey())).toEqual(again)
  expect(fake.calls().at(-1)).toEqual(['-y', '-P', '', '-f', generatedKey()])

  fake.state({ keygen: 'unprotected' })
  const refused = await publicKeyOf(generatedKey())
  expect(refused).toMatchObject({ ok: false, hint: 'keyPermissions' })
  expect(refused.ok ? '' : refused.error).toBe(
    `Permissions for '${generatedKey()}' are too open.\nUNPROTECTED PRIVATE KEY FILE!`,
  )
  fake.state({ keygen: 'passphrase' })
  expect(await publicKeyOf(generatedKey())).toMatchObject({ ok: false, hint: 'passphrase' })
})

test("the server's key: none before the first connection, the pinned one's fingerprint, then forgotten", async () => {
  const fake = await useFakeSsh()
  expect(await hostKeyFingerprint('ssh.example.com', 22)).toBeNull()
  mkdirSync(tunnelDir(), { recursive: true })
  writeFileSync(knownHostsFile(), 'ssh.example.com ssh-ed25519 AAAAFAKEHOST\n')
  expect(await hostKeyFingerprint('ssh.example.com', 22)).toBe('SHA256:FAKEfingerprint (ED25519)')
  expect(fake.calls().at(-1)).toEqual(['-l', '-F', 'ssh.example.com', '-f', knownHostsFile()])
  // another server, or another port: not pinned
  expect(await hostKeyFingerprint('other.example.com', 22)).toBeNull()
  expect(await hostKeyFingerprint('ssh.example.com', 2222)).toBeNull()
  expect(fake.calls().at(-1)).toEqual(['-l', '-F', '[ssh.example.com]:2222', '-f', knownHostsFile()])
  forgetHostKey()
  expect(existsSync(knownHostsFile())).toBe(false)
  expect(await hostKeyFingerprint('ssh.example.com', 22)).toBeNull()
  forgetHostKey()
})

test.skipIf(process.platform !== 'win32')(
  "Windows: the generated key and a protected one are the user's alone; a key the owner points to keeps its rights",
  async () => {
    const fake = await useFakeSsh()
    // The state folder grants every user read, inherited: a key written there would have it too.
    sharedFolder(join(fake.dir, 'state'))
    expect((await generateKey('agent-board@PC')).ok).toBe(true)
    expectOwnerOnly(generatedKey())

    const shared = sharedFolder(join(fake.dir, 'shared'))
    const key = join(shared, 'id_ed25519')
    writeFileSync(key, '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n')
    expect(icacls(key)).toContain('BUILTIN\\Users')
    expect(await protectKey(key)).toEqual({ ok: true })
    expectOwnerOnly(key)

    // Call 8: the board reads a key the owner points to and never changes its rights.
    const owners = join(shared, 'owners_key')
    writeFileSync(owners, '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n')
    writeFileSync(`${owners}.pub`, 'ssh-ed25519 AAAAOWNER me@laptop\n')
    expect(await publicKeyOf(owners)).toEqual({ ok: true, publicKey: 'ssh-ed25519 AAAAOWNER me@laptop' })
    expect(icacls(owners)).toContain('BUILTIN\\Users')
  },
)

test('spawnSsh: a key folder with a space, % and Cyrillic reaches ssh as one argument each; its lines; kill ends it', async () => {
  const fake = await useFakeSsh()
  const folder = join(fake.dir, 'a b%c Иван')
  mkdirSync(folder)
  const conf = tunnelConfig({ host: 'ssh.example.com', user: 'boardtunnel', domain: 'board.example.com' })
  const key = join(folder, 'id_ed25519')
  const knownHosts = join(folder, 'known_hosts')
  const args = sshArgs({ conf, key, knownHosts, target: 12999 })
  const ssh = spawnSsh(fake.bin, args)
  try {
    const lines = linesOf(ssh)
    await until(() => lines.some(line => forwardAccepted(line, conf.socket)), 20_000)
    expect(ssh.pid).toBeGreaterThan(0)
    const logged = fake.calls().at(-1) as string[]
    expect(logged).toEqual(args)
    expect(logged[logged.indexOf('-i') + 1]).toBe(sshPathArg(key))
    expect(logged).toContain(`UserKnownHostsFile="${sshPathArg(knownHosts)}"`)
    // As ssh reads the quoted, %-doubled value: the server's key pinned in that very folder.
    expect(readFileSync(knownHosts, 'utf8')).toBe('ssh.example.com ssh-ed25519 AAAAFAKEHOST\n')
    expect(lines).toEqual([
      'OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2',
      "Warning: Permanently added 'ssh.example.com' (ED25519) to the list of known hosts.",
      'Authenticated to ssh.example.com ([203.0.113.5]:22) using "publickey".',
      'debug1: remote forward success for: listen /var/lib/boardtunnel/board.sock:-2, connect 127.0.0.1:12999',
      'debug1: forwarding_success: all expected forwarding replies received',
    ])
    ssh.kill()
    expect((await ssh.exited).error).toBeNull()
    expect(alive(ssh.pid)).toBe(false)
  } finally {
    ssh.killNow()
  }
})

test("the fake ssh's other answers, one per call in turn, and a forward that drops", async () => {
  const fake = await useFakeSsh()
  const forward = forwardSpec(TUNNEL_SOCKET, 12999)
  const args = ['-v', '-N', '-R', forward, 'boardtunnel@ssh.example.com']
  fake.state({ ssh: { seq: ['refuse', 'publickey', 'hostkey', 'forward'], exitAfterMs: 200 } })
  const answers: { code: number | null; last: string | undefined }[] = []
  for (let i = 0; i < 5; i++) {
    const ssh = spawnSsh(fake.bin, args)
    const lines = linesOf(ssh)
    const { code } = await ssh.exited
    answers.push({ code, last: lines.at(-1) })
  }
  expect(answers).toEqual([
    { code: 255, last: `Error: remote port forwarding failed for listen path ${TUNNEL_SOCKET}` },
    { code: 255, last: 'boardtunnel@ssh.example.com: Permission denied (publickey).' },
    { code: 255, last: 'Host key verification failed.' },
    { code: 255, last: 'Connection to ssh.example.com closed by remote host.' },
    { code: 255, last: 'Connection to ssh.example.com closed by remote host.' },
  ])
})

test('endStraySsh ends a recorded ssh that runs with this forward, leaves anything else alone, and says true once none of ours runs there', async () => {
  const fake = await useFakeSsh()
  const forward = forwardSpec(TUNNEL_SOCKET, 12999)
  const ssh = spawnSsh(fake.bin, ['-v', '-N', '-R', forward, 'boardtunnel@ssh.example.com'])
  const other = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  try {
    const lines = linesOf(ssh)
    await until(() => lines.some(line => forwardAccepted(line, TUNNEL_SOCKET)), 20_000)
    expect(await commandLineOf(ssh.pid)).toContain(`-R ${forward}`)
    expect(await endStraySsh({ pid: ssh.pid, forward, at: Date.now() })).toBe(true)
    expect(alive(ssh.pid)).toBe(false)
    await ssh.exited

    // A pid now used by another program: no ssh of ours runs there.
    expect(await commandLineOf(other.pid)).toContain('setInterval')
    expect(await endStraySsh({ pid: other.pid, forward, at: Date.now() })).toBe(true)
    expect(alive(other.pid)).toBe(true)
  } finally {
    ssh.killNow()
    other.kill()
    await other.exited
  }
  // A pid that no longer runs.
  expect(await commandLineOf(other.pid)).toBeNull()
  expect(await endStraySsh({ pid: other.pid, forward, at: Date.now() })).toBe(true)
})

test('endStraySsh says false for a pid that runs but whose command line cannot be read, and kills nothing', async () => {
  const forward = forwardSpec(TUNNEL_SOCKET, 12999)
  const other = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const killed: number[] = []
  // PowerShell (or ps) failing: what runs under the pid is unknown, maybe that ssh.
  const unreadable = { commandLine: async () => null, kill: (pid: number) => killed.push(pid), waitMs: 200 }
  try {
    expect(await endStraySsh({ pid: other.pid, forward, at: Date.now() }, unreadable)).toBe(false)
    expect(killed).toEqual([])
    expect(alive(other.pid)).toBe(true)
  } finally {
    other.kill()
    await other.exited
  }
  // Unreadable and no longer running: none of ours runs there.
  expect(await endStraySsh({ pid: other.pid, forward, at: Date.now() }, unreadable)).toBe(true)
  expect(killed).toEqual([])
})

test('endStraySsh takes the recorded forward as a whole argument: a longer port or socket path is another ssh', async () => {
  // Our own pid stands in for a process that runs; the kill is only noted, never done.
  const forward = forwardSpec(TUNNEL_SOCKET, 1242)
  const tried = async (line: string): Promise<number[]> => {
    const killed: number[] = []
    await endStraySsh(
      { pid: process.pid, forward, at: Date.now() },
      { commandLine: async () => line, kill: pid => killed.push(pid), waitMs: 0 },
    )
    return killed
  }
  const ssh = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe -v -N'
  const at = 'boardtunnel@ssh.example.com'
  // Another port that starts with the recorded one, and a socket path that ends with the recorded one.
  expect(await tried(`${ssh} -R ${forwardSpec(TUNNEL_SOCKET, 12420)} ${at}`)).toEqual([])
  expect(await tried(`${ssh} -R /srv${forward} ${at}`)).toEqual([])
  expect(await tried(`${ssh} -R ${forward}0`)).toEqual([])
  // The forward itself: in the middle, last, quoted (Windows' command line), as /proc gives it.
  expect(await tried(`${ssh} -R ${forward} ${at}`)).toEqual([process.pid])
  expect(await tried(`${ssh} ${at} -R ${forward}`)).toEqual([process.pid])
  expect(await tried(`"${ssh}" "-R" "${forward}" "${at}"`)).toEqual([process.pid])
  expect(await tried(`ssh\t-R\t${forward}\t${at}`)).toEqual([process.pid])
})

test('endStraySsh says false when the recorded ssh still runs after its wait', async () => {
  const fake = await useFakeSsh()
  fake.state({ ssh: { mode: 'hang' } })
  const forward = forwardSpec(TUNNEL_SOCKET, 12999)
  const ssh = spawnSsh(fake.bin, ['-v', '-N', '-R', forward, 'boardtunnel@ssh.example.com'])
  try {
    const killed: number[] = []
    const record = { pid: ssh.pid, forward, at: Date.now() }
    // A kill that does not take: the ssh outlives the wait.
    expect(await endStraySsh(record, { kill: pid => killed.push(pid), waitMs: 200 })).toBe(false)
    expect(killed).toEqual([ssh.pid])
    expect(alive(ssh.pid)).toBe(true)
  } finally {
    ssh.kill()
    await ssh.exited
  }
})

test('the fake ssh in hang mode stays up and silent, exitAfterMs or not', async () => {
  const fake = await useFakeSsh()
  fake.state({ ssh: { mode: 'hang', exitAfterMs: 100 } })
  const ssh = spawnSsh(fake.bin, ['-v', '-N', '-R', forwardSpec(TUNNEL_SOCKET, 12999), 'boardtunnel@ssh.example.com'])
  try {
    const lines = linesOf(ssh)
    const first = await Promise.race([ssh.exited.then(() => 'exited'), Bun.sleep(1500).then(() => 'still up')])
    expect(first).toBe('still up')
    expect(lines).toEqual([])
  } finally {
    ssh.kill()
    await ssh.exited
  }
})

test('the pid record: written, read back, removed', () => {
  isolatedHome()
  expect(readPidRecord()).toBeNull()
  writePidRecord(null)
  expect(existsSync(tunnelDir())).toBe(false)
  const record = { pid: 4242, forward: forwardSpec(TUNNEL_SOCKET, 12424), at: 1_760_000_000_000 }
  writePidRecord(record)
  expect(readPidRecord()).toEqual(record)
  writeFileSync(sshPidFile(), JSON.stringify({ pid: '4242', forward: record.forward, at: 1 }))
  expect(readPidRecord()).toBeNull()
  writePidRecord(record)
  writePidRecord(null)
  expect(existsSync(sshPidFile())).toBe(false)
})
