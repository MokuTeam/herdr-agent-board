// Setting up the server's web server through the owner's admin connection (services/server-setup.ts):
// Look, Apply and Undo, with sudo's password on stdin only. ssh is the fake (test/support/fake-ssh.ts),
// whose admin server answers Look from what the trial servers printed (test/fixtures/server-look,
// Debian 13 with sudo and Ubuntu 26.04 with sudo-rs) and a run with the lines a test gives it.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { configFile, loadConfig } from '../../src/adapters/config-file.ts'
import { configDir, stateDir } from '../../src/adapters/paths.ts'
import {
  hostKeyFingerprint,
  hostKeyPinned,
  knownHostsFile,
  knownHostsReady,
  spawnRemote,
  sshVersion,
  tunnelDir,
} from '../../src/adapters/ssh.ts'
import type { Plan, SetupRecord } from '../../src/core/server-plan.ts'
import type { Acme } from '../../src/core/server-texts.ts'
import type { ServerPhase } from '../../src/core/server-view.ts'
import type { TestStep } from '../../src/core/tunnel.ts'
import { createServerSetup } from '../../src/services/server-setup.ts'
import { useFakeSsh } from '../support/fake-ssh-bin.ts'

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'server-look')
/** The fake's server key, as Test connection pinned it. */
const HOST_LINE = 'ssh.example.com ssh-ed25519 AAAAFAKEHOST'
/** The password the tests type: what a shell, JSON or a URL would take apart. */
const SENTINEL = `S3cr3t%$'"\`Ж`
const DISTROS = ['debian13', 'ubuntu2604'] as const
const FLAVOR = { debian13: 'sudo', ubuntu2604: 'sudo-rs' } as const
const PAIR = { user: 'boardtunnel', socket: '/var/lib/boardtunnel/board.sock' }
/** A wrong password's lines from a sudo that speaks Russian (none of the English ones the hints know). */
const WRONG_RU = [
  'Извините, попробуйте ещё раз.',
  '',
  'sudo: пароль не был указан',
  'sudo: 1 неверная попытка ввода пароля',
]
const DOMAIN_OK: TestStep[] = [
  { id: 'ssh', ok: true, detail: '', hint: null },
  { id: 'forward', ok: true, detail: '', hint: null },
  { id: 'domain', ok: true, detail: '', hint: null },
]

interface AdminState {
  uid?: number
  sudo?: 'nopasswd' | 'password' | 'requiretty' | 'notSudoer'
  flavor?: 'sudo' | 'sudo-rs'
  password?: string
  publickey?: boolean
  login?: { password: string; kbdint?: string[]; alsoPassword?: boolean }
  fixture?: string
  run?: { lines: string[]; dropAfter?: number }
  wrong?: string[]
}

type Fields = Record<string, unknown>

/**
 * A board whose config.json has the tunnel's settings (and `tunnel`'s more) and the admin user, the
 * fake as its ssh (`sshVersion`: what its `ssh -V` says); `spawn` in place of the real spawnRemote,
 * for an ssh that does not start or runs out of time; `key`, the board's public key (none without).
 */
async function useBoard(
  admin: AdminState,
  o: {
    pinned?: boolean
    tunnel?: Fields
    acme?: Acme
    spawn?: typeof spawnRemote
    sshVersion?: string
    key?: () => string | null
  } = {},
) {
  const fake = await useFakeSsh()
  if (o.pinned !== false) {
    mkdirSync(tunnelDir(), { recursive: true })
    writeFileSync(knownHostsFile(), `${HOST_LINE}\n`)
  }
  let state = admin
  const top = o.sshVersion ? { sshVersion: o.sshVersion } : {}
  fake.state({ ...top, admin })
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(
    configFile(),
    JSON.stringify({
      language: 'en',
      tunnel: {
        host: 'ssh.example.com',
        user: 'boardtunnel',
        domain: 'board.example.com',
        admin: { user: 'admin' },
        ...o.tunnel,
      },
    }),
  )
  const cfg = loadConfig()
  const logs: string[] = []
  const answers: unknown[] = []
  /** How long the board let each ssh take, oldest first. */
  const deadlines: number[] = []
  let ids = 0
  let tests = 0
  let changes = 0
  let versions = 0
  const setup = createServerSetup({
    cfg,
    webPort: 12390,
    ssh: () => fake.bin,
    sshVersion: bin => {
      versions++
      return sshVersion(bin)
    },
    knownHosts: knownHostsReady,
    hostKeyPinned: () => hostKeyPinned('ssh.example.com', 22),
    hostKeyFingerprint,
    spawn: (bin, args, stdin, ms, login) => {
      deadlines.push(ms)
      return (o.spawn ?? spawnRemote)(bin, args, stdin, ms, login)
    },
    test: async () => {
      tests++
      return DOMAIN_OK
    },
    onChange: () => {
      changes++
    },
    log: line => logs.push(line),
    now: () => Date.now(),
    newId: () => `r${++ids}`,
    ...(o.acme && { acme: o.acme }),
    ...(o.key && { publicKey: async () => o.key?.() ?? null }),
  })
  const stdinLog = join(fake.dir, 'ssh-calls.jsonl.stdin')
  const logins = (): string[][] => fake.calls().filter(c => c.includes('-T'))
  const keep = <T>(a: T): T => {
    answers.push(a)
    return a
  }
  return {
    setup,
    fake,
    logs,
    answers,
    deadlines,
    tests: () => tests,
    changes: () => changes,
    /** How often the board asked `ssh -V`. */
    versions: () => versions,
    /** Another answer from the server from now on. */
    server: (more: AdminState): void => {
      state = { ...state, ...more }
      fake.state({ ...top, admin: state })
    },
    look: async (body: Fields = {}) => keep(await setup.look(body)),
    undoLook: async (body: Fields = {}) => keep(await setup.undoLook(body)),
    apply: async (body: Fields) => keep(await setup.apply(body)),
    undo: async (body: Fields) => keep(await setup.undo(body)),
    /** The remote command of each ssh the board ran, oldest first. */
    commands: (): string[] => logins().map(c => c.at(-1) ?? ''),
    /** The argument list of each ssh to the admin (-T), oldest first; ssh-keygen's and `ssh -V` left out. */
    logins,
    stdins: (): string[] => jsonLines(stdinLog) as string[],
    /** Each prompt ssh gave its askpass, oldest first (never an answer). */
    prompts: (): string[] => jsonLines(join(fake.dir, 'ssh-calls.jsonl.askpass')) as string[],
    /** What led each ssh to its askpass: SSH_ASKPASS*, BUN_OPTIONS, BOARD_ASKPASS*. */
    leads: (): Record<string, string>[] => jsonLines(join(fake.dir, 'ssh-calls.jsonl.env')) as Record<string, string>[],
    tunnel: (): Fields => (JSON.parse(readFileSync(configFile(), 'utf8')) as { tunnel: Fields }).tunnel,
    async until(phases: ServerPhase[], ms = 20_000): Promise<void> {
      const end = Date.now() + ms
      while (!phases.includes(setup.view().phase)) {
        if (Date.now() > end) throw new Error(`still ${setup.view().phase}`)
        await Bun.sleep(20)
      }
    },
  }
}

const fixture = (distro: string, scenario: string): string => join(FIXTURES, distro, scenario)

/** A file of JSON lines, each parsed; none when it is not there. */
const jsonLines = (file: string): unknown[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as unknown)
    : []

/** A scenario's Look with a record of the board's on the server (setup.json), and its lock file when `lock` says so. */
function withRecord(
  into: string,
  distro: string,
  scenario: string,
  record: Partial<SetupRecord>,
  lock?: 'held' | 'free',
): string {
  const dir = mkdtempSync(join(into, `${scenario}-`))
  const one = readFileSync(join(fixture(distro, scenario), 'round1.txt'), 'utf8')
  const full: SetupRecord = {
    v: 1,
    id: 'r0',
    at: '2026-10-21T10:04:00.000Z',
    state: 'applied',
    case: '1',
    pair: PAIR,
    domain: 'board.example.com',
    publicPort: null,
    address: 'https://board.example.com',
    items: [],
    ...record,
  }
  writeFileSync(
    join(dir, 'round1.txt'),
    one.replace(
      /@@section record\n[\s\S]*?@@section host\n/,
      `@@section record\n@@file\n${JSON.stringify(full)}\n\n${lock ? `@@lock ${lock}\n` : ''}@@section host\n`,
    ),
  )
  const two = join(fixture(distro, scenario), 'round2.txt')
  if (existsSync(two)) writeFileSync(join(dir, 'round2.txt'), readFileSync(two))
  return dir
}

/** What a run prints for a plan that goes through: each step started, some output, done; then the end. */
const goesThrough = (p: Plan, extra: string[] = []): string[] => [
  ...p.steps.flatMap((s, i) => [`@@step ${i + 1} start`, `output of ${s.id}`, ...extra, `@@step ${i + 1} ok`]),
  '@@result applied',
  '@@exit 0',
]

const planOf = (setup: { view(): { plan: Plan | null } }): Plan => {
  const p = setup.view().plan
  if (!p) throw new Error('no plan')
  return p
}

/** Every file under a folder, with its text. */
function files(dir: string): [string, string][] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [[path, readFileSync(path, 'utf8')] as [string, string]]
  })
}

const OK = { status: 200, body: { ok: true } }

/** The board's public key, as ssh-keygen -y gives it. */
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGQ2Ym9hcmRrZXlleGFtcGxlZXhhbXBsZWV4YW1wbGU board@pc'

/** A scenario's Look on a server with none of step 1: no tunnel user, folder, keys file or fence. */
function withoutStepOne(into: string, distro: string, scenario: string): string {
  const dir = mkdtempSync(join(into, `${scenario}-`))
  const one = readFileSync(join(fixture(distro, scenario), 'round1.txt'), 'utf8')
  writeFileSync(
    join(dir, 'round1.txt'),
    one.replace(
      /@@section fence\n[\s\S]*?@@section record\n/,
      [
        '@@section fence',
        '@@user none',
        '@@keys none',
        '@@include',
        '@@section folder',
        "stat: cannot statx '/var/lib/boardtunnel': No such file or directory",
        '@@section record',
        '',
      ].join('\n'),
    ),
  )
  const two = join(fixture(distro, scenario), 'round2.txt')
  if (existsSync(two)) writeFileSync(join(dir, 'round2.txt'), readFileSync(two))
  return dir
}

/** The script a remote command carries (base64 in the fixed text). */
const carried = (command: string): string =>
  Buffer.from(/echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(command)?.[1] ?? '', 'base64').toString('utf8')

for (const distro of DISTROS) {
  const flavor = FLAVOR[distro]
  describe(`Look on ${distro} (${flavor})`, () => {
    test('every case, as root: sh -c alone, nothing on stdin', async () => {
      const b = await useBoard({ uid: 0, flavor })
      const cases: [string, string | null, string | null][] = [
        ['bare', '1', null],
        ['nodocker', '1', null],
        ['dummy80', '1b', null],
        ['caddy-unit', '2', null],
        ['compose-folder', '3a', null],
        ['compose-file', '3a', null],
        ['caddy-host', '3b', null],
        ['nginx-443', '4a', null],
        ['nginx-80-443', '4b', null],
        ['caddy-bridge', null, 'bridge'],
        ['apache', null, 'other80'],
      ]
      for (const [scenario, want, why] of cases) {
        b.server({ fixture: fixture(distro, scenario) })
        expect([scenario, await b.look()]).toEqual([scenario, OK])
        const v = b.setup.view()
        expect([scenario, v.phase, v.sudo, v.hint]).toEqual([scenario, 'plan', 'root', null])
        if (want) {
          expect([scenario, v.choice?.case, v.plan?.case, v.plan?.steps[0]?.id]).toEqual([
            scenario,
            want,
            want,
            'guard',
          ])
        } else {
          expect([scenario, v.choice?.case, v.choice?.why as unknown, v.plan]).toEqual([scenario, null, [why], null])
        }
      }
      expect(b.commands().every(c => c.startsWith('sh -c \'eval "$(echo '))).toBe(true)
      expect(b.stdins()).toEqual([])
      // the probe, then one round (nothing for round two) or two
      expect(b.commands()).toHaveLength(11 * 2 + 7)
    }, 120_000)

    test('NOPASSWD: sudo -n after the probe, nothing on stdin', async () => {
      const b = await useBoard({ sudo: 'nopasswd', flavor, fixture: fixture(distro, 'caddy-unit') })
      expect(await b.look()).toEqual(OK)
      const [probe, ...rounds] = b.commands()
      expect(probe?.startsWith('sh -c ')).toBe(true)
      expect(rounds).toHaveLength(2)
      for (const c of rounds) expect(c.startsWith('env LC_ALL=C sudo -n -- sh -c ')).toBe(true)
      expect(b.stdins()).toEqual([])
      expect(b.setup.view()).toMatchObject({ sudo: 'nopasswd', choice: { case: '2' } })
      expect(b.setup.view().plan?.steps[0]?.id).toBe('guard')
    })

    test('a password needed and none given: asked for, only the probe ran', async () => {
      const b = await useBoard({ sudo: 'password', password: SENTINEL, flavor, fixture: fixture(distro, 'caddy-unit') })
      const answer = await b.look()
      expect(answer).toEqual({
        status: 409,
        body: { ok: false, hint: 'needPassword', error: expect.any(String), need: 'password' },
      })
      expect(b.commands()).toHaveLength(1)
      expect(b.setup.view()).toMatchObject({ sudo: 'password', hint: 'needPassword', plan: null })
    })

    test('the password: on ssh’s stdin once per sudo, and nowhere else (argv, view, answers, log, files)', async () => {
      const b = await useBoard({ sudo: 'password', password: SENTINEL, flavor, fixture: fixture(distro, 'caddy-unit') })
      expect(await b.look({ password: SENTINEL })).toEqual(OK)
      expect(b.stdins()).toEqual([`${SENTINEL}\n`, `${SENTINEL}\n`])
      for (const c of b.commands().slice(1)) expect(c.startsWith("env LC_ALL=C sudo -S -p '' -- sh -c ")).toBe(true)
      // a run, with a line that holds it (it never should): kept as ••••
      const p = planOf(b.setup)
      b.server({ run: { lines: goesThrough(p, [`echo ${SENTINEL}`]) } })
      expect(await b.apply({ plan: p.id, password: SENTINEL })).toEqual(OK)
      await b.until(['done', 'failed'])
      expect(b.setup.view().phase).toBe('done')
      expect(b.stdins()).toEqual([`${SENTINEL}\n`, `${SENTINEL}\n`, `${SENTINEL}\n`])
      expect(b.setup.view().progress?.steps[1]?.out).toContain('echo ••••')
      const nowhere = (what: string, text: string): void =>
        expect([what, text.includes(SENTINEL)]).toEqual([what, false])
      nowhere('argv', JSON.stringify(b.fake.calls()))
      nowhere('view', JSON.stringify(b.setup.view()))
      nowhere('answers', JSON.stringify(b.answers))
      nowhere('log', JSON.stringify(b.logs))
      for (const [path, text] of [...files(stateDir()), ...files(configDir())]) nowhere(path, text)
    })

    test('sudo’s own password wrong: refused after one sudo, never tried again; its field asked for', async () => {
      const b = await useBoard({
        sudo: 'password',
        password: 'right one',
        flavor,
        fixture: fixture(distro, 'caddy-unit'),
      })
      const answer = await b.look({ sudoPassword: 'wrong one' })
      expect(answer).toMatchObject({ status: 409, body: { ok: false, hint: 'wrongPassword', need: 'sudoPassword' } })
      expect(b.commands()).toHaveLength(2)
      expect(b.stdins()).toEqual(['wrong one\n'])
      expect(b.setup.view()).toMatchObject({ phase: 'idle', hint: 'wrongPassword', plan: null })
    })

    test('the login’s password not sudo’s (the login went with the key): “sudo needs its own password”, one sudo try', async () => {
      const b = await useBoard({
        sudo: 'password',
        password: 'sudo’s own',
        flavor,
        fixture: fixture(distro, 'caddy-unit'),
      })
      const answer = await b.look({ password: 'the login’s' })
      expect(answer).toMatchObject({ status: 409, body: { ok: false, hint: 'sudoPassword', need: 'sudoPassword' } })
      expect(b.commands()).toHaveLength(2)
      expect(b.stdins()).toEqual(['the login’s\n'])
      expect(b.setup.view()).toMatchObject({ phase: 'idle', hint: 'sudoPassword', plan: null })
      // the next click sends sudo's own: it goes to sudo -S, not the login's
      expect(await b.look({ password: 'the login’s', sudoPassword: 'sudo’s own' })).toEqual(OK)
      expect(b.stdins().slice(1)).toEqual(['sudo’s own\n', 'sudo’s own\n'])
      const p = planOf(b.setup)
      b.server({ run: { lines: goesThrough(p) } })
      expect(await b.apply({ plan: p.id, password: 'the login’s', sudoPassword: 'sudo’s own' })).toEqual(OK)
      await b.until(['done', 'failed'])
      expect(b.setup.view().phase).toBe('done')
      expect(b.stdins().at(-1)).toBe('sudo’s own\n')
    })

    test('requiretty (sudo) and not in sudoers: stopped with the hint after the probe', async () => {
      const tty = await useBoard({ sudo: 'requiretty', flavor: 'sudo', fixture: fixture(distro, 'bare') })
      expect(await tty.look({ password: 'x' })).toMatchObject({ status: 409, body: { hint: 'requiretty' } })
      expect(tty.commands()).toHaveLength(1)
      const none = await useBoard({ sudo: 'notSudoer', flavor: 'sudo-rs', fixture: fixture(distro, 'bare') })
      expect(await none.look({ password: 'x' })).toMatchObject({ status: 409, body: { hint: 'notSudoer' } })
      expect(none.commands()).toHaveLength(1)
      expect(none.stdins()).toEqual([])
    })

    test('no server key pinned: the first login pins the one it meets (the probe alone), its fingerprint in the view', async () => {
      const b = await useBoard({ uid: 0, flavor, fixture: fixture(distro, 'bare') }, { pinned: false })
      expect(await b.look()).toEqual(OK)
      const strictness = (): string[] => b.logins().map(a => a.find(o => o.startsWith('StrictHostKeyChecking=')) ?? '')
      expect(strictness()).toEqual(['StrictHostKeyChecking=accept-new', 'StrictHostKeyChecking=yes'])
      expect(readFileSync(knownHostsFile(), 'utf8')).toBe(`${HOST_LINE}\n`)
      expect(b.setup.view().hostKey).toEqual({ fingerprint: 'SHA256:FAKEfingerprint (ED25519)', pinnedNow: true })
      // the next Look: strictly the pinned one
      expect(await b.look()).toEqual(OK)
      expect(strictness().slice(2)).toEqual(['StrictHostKeyChecking=yes', 'StrictHostKeyChecking=yes'])
      expect(b.setup.view().hostKey).toEqual({ fingerprint: 'SHA256:FAKEfingerprint (ED25519)', pinnedNow: false })
      // forgotten after Look: Apply pins nothing, it asks for a Look again
      const p = planOf(b.setup)
      rmSync(knownHostsFile())
      expect(await b.apply({ plan: p.id })).toMatchObject({ status: 409, body: { ok: false, hint: 'noHostKey' } })
      expect(b.logins()).toHaveLength(4)
    })

    test('a pinned key that changed: refused, never pinned over', async () => {
      const b = await useBoard({ uid: 0, flavor, fixture: fixture(distro, 'bare') })
      const other = 'ssh.example.com ssh-ed25519 AAAAOTHERKEY\n'
      writeFileSync(knownHostsFile(), other)
      expect(await b.look({ password: 'pw' })).toMatchObject({ status: 409, body: { ok: false, hint: 'hostKey' } })
      expect(readFileSync(knownHostsFile(), 'utf8')).toBe(other)
      expect(b.logins()).toHaveLength(1)
    })

    test('the admin key refused', async () => {
      const b = await useBoard({ publickey: true, flavor, fixture: fixture(distro, 'bare') })
      expect(await b.look()).toMatchObject({ status: 409, body: { ok: false, hint: 'publickey' } })
    })

    test('another board’s record on the server: not ours to plan over', async () => {
      const b = await useBoard({ uid: 0, flavor })
      const other = withRecord(b.fake.dir, distro, 'bare', { pair: { user: 'othertunnel', socket: '/srv/other.sock' } })
      b.server({ fixture: other })
      expect(await b.look()).toEqual(OK)
      expect(b.setup.view()).toMatchObject({ choice: { case: null, why: ['otherSetup'] }, plan: null })
      expect(b.tunnel().setup).toBeUndefined()
    })

    test('this board’s record for another domain: an update; config.json’s summary filled from the record', async () => {
      const b = await useBoard({ uid: 0, flavor })
      const old = withRecord(b.fake.dir, distro, 'bare', {
        domain: 'old.example.com',
        address: 'https://old.example.com',
      })
      b.server({ fixture: old })
      expect(await b.look()).toEqual(OK)
      expect(b.setup.view().plan?.kind).toBe('update')
      expect(b.tunnel().setup).toEqual({
        case: '1',
        address: 'https://old.example.com',
        at: '2026-10-21T10:04:00.000Z',
      })
      expect(b.setup.view().setup).toEqual({
        case: '1',
        address: 'https://old.example.com',
        at: '2026-10-21T10:04:00.000Z',
      })
    })
  })

  describe(`Apply and Undo on ${distro} (${flavor})`, () => {
    test('a plan from before (or another board’s life), Docker not ticked, one run at a time', async () => {
      const b = await useBoard({ uid: 0, flavor, fixture: fixture(distro, 'nodocker') })
      expect(await b.apply({ plan: 'r1' })).toMatchObject({ status: 409, body: { hint: 'lookAgain' } })
      expect(await b.look()).toEqual(OK)
      const p = planOf(b.setup)
      expect(p.ticks).toEqual(['docker'])
      expect(await b.apply({ plan: 'r0' })).toMatchObject({ status: 409, body: { hint: 'lookAgain' } })
      // an Apply's plan is no Undo's
      expect(await b.undo({ plan: p.id })).toMatchObject({ status: 409, body: { hint: 'lookAgain' } })
      expect(await b.apply({ plan: p.id })).toMatchObject({ status: 409, body: { ok: false, hint: null } })
      b.server({ run: { lines: goesThrough(p) } })
      const [first, second] = await Promise.all([
        b.apply({ plan: p.id, docker: true }),
        b.apply({ plan: p.id, docker: true }),
      ])
      expect(first).toEqual(OK)
      expect(second).toMatchObject({ status: 409, body: { hint: 'busy' } })
      expect(await b.look()).toMatchObject({ status: 409, body: { hint: 'busy' } })
      await b.until(['done', 'failed'])
      expect(b.setup.view().phase).toBe('done')
      // a run changed the server: the next one needs a Look again
      expect(await b.apply({ plan: p.id, docker: true })).toMatchObject({ status: 409, body: { hint: 'lookAgain' } })
      // a board started anew knows no plan
      const again = await useBoard({ uid: 0, flavor, fixture: fixture(distro, 'nodocker') })
      expect(await again.apply({ plan: p.id, docker: true })).toMatchObject({
        status: 409,
        body: { hint: 'lookAgain' },
      })
    })

    test('a run to its end: progress, done, the summary in config.json, Test after, web.log one line a step', async () => {
      const b = await useBoard({ sudo: 'nopasswd', flavor, fixture: fixture(distro, 'caddy-unit') })
      expect(await b.look()).toEqual(OK)
      const p = planOf(b.setup)
      b.server({ run: { lines: goesThrough(p) } })
      const before = b.changes()
      expect(await b.apply({ plan: p.id })).toEqual(OK)
      expect(b.setup.view().phase).toBe('applying')
      await b.until(['done', 'failed'])
      const v = b.setup.view()
      expect(v.phase).toBe('done')
      expect(v.progress?.result).toBe('applied')
      expect(v.progress?.steps.map(s => s.state)).toEqual(p.steps.map(() => 'ok'))
      expect(v.progress?.steps[0]?.out).toEqual(['output of guard'])
      expect(b.tunnel().setup).toEqual({ case: '2', address: 'https://board.example.com', at: expect.any(String) })
      expect(v.setup).toMatchObject({ case: '2', address: 'https://board.example.com' })
      expect(b.tunnel().publicPort).toBeUndefined()
      expect(v.testAfter).toEqual(DOMAIN_OK)
      expect(b.tests()).toBe(1)
      expect(b.logs).toEqual(p.steps.map(s => expect.stringMatching(new RegExp(`^server setup ${s.id} ok \\d+s$`))))
      expect(b.logs.join('\n')).not.toContain('output of')
      // the panel heard of each marker
      expect(b.changes() - before).toBeGreaterThanOrEqual(p.steps.length * 2)
      // the run went with sudo -n, as Look did
      expect(b.commands().at(-1)?.startsWith('env LC_ALL=C sudo -n -- sh -c ')).toBe(true)
    })

    test('case 4a: the public port 8443 after Apply; the Undo of that record takes it away', async () => {
      const b = await useBoard({ uid: 0, flavor, fixture: fixture(distro, 'nginx-443') })
      expect(await b.look()).toEqual(OK)
      const p = planOf(b.setup)
      expect(p.case).toBe('4a')
      b.server({ run: { lines: goesThrough(p) } })
      expect(await b.apply({ plan: p.id })).toEqual(OK)
      await b.until(['done', 'failed'])
      expect(b.tunnel().publicPort).toBe(8443)
      expect(b.tunnel().setup).toEqual({
        case: '4a',
        address: 'https://board.example.com:8443',
        at: expect.any(String),
      })

      const set = withRecord(b.fake.dir, distro, 'nginx-443', {
        case: '4a',
        publicPort: 8443,
        address: 'https://board.example.com:8443',
        items: [{ kind: 'container', name: 'agent-board-caddy', setup: 'r1' }],
      })
      b.server({ fixture: set })
      expect(await b.undoLook()).toEqual(OK)
      const u = planOf(b.setup)
      expect(u.kind).toBe('undo')
      expect(await b.apply({ plan: u.id })).toMatchObject({ status: 409, body: { hint: 'lookAgain' } })
      b.server({ run: { lines: goesThrough(u) } })
      expect(await b.undo({ plan: u.id })).toEqual(OK)
      expect(b.setup.view().phase).toBe('undoing')
      await b.until(['done', 'failed'])
      expect(b.setup.view().phase).toBe('done')
      expect(b.tunnel().setup).toBeUndefined()
      expect(b.tunnel().publicPort).toBeUndefined()
      expect(b.setup.view().setup).toBeNull()
    })

    test('the connection lost mid-run: failed, the server finishes by itself, Look again', async () => {
      const b = await useBoard({ uid: 0, flavor, fixture: fixture(distro, 'bare') })
      expect(await b.look()).toEqual(OK)
      const p = planOf(b.setup)
      b.server({ run: { lines: goesThrough(p), dropAfter: 4 } })
      expect(await b.apply({ plan: p.id })).toEqual(OK)
      await b.until(['done', 'failed'])
      expect(b.setup.view()).toMatchObject({ phase: 'failed', hint: 'lost' })
      expect(b.setup.view().progress?.steps[1]?.state).toBe('running')
      expect(b.tunnel().setup).toBeUndefined()
      expect(b.tests()).toBe(0)
    })

    test('the server changed since Look: the run stops before any change', async () => {
      const b = await useBoard({ uid: 0, flavor, fixture: fixture(distro, 'bare') })
      expect(await b.look()).toEqual(OK)
      const p = planOf(b.setup)
      b.server({ run: { lines: ['@@step 1 start', '@@changed holder443', '@@step 1 fail', '@@exit 3'] } })
      expect(await b.apply({ plan: p.id })).toEqual(OK)
      await b.until(['done', 'failed'])
      expect(b.setup.view()).toMatchObject({ phase: 'failed', hint: 'changed' })
      expect(b.logs).toEqual([expect.stringMatching(/^server setup guard fail \d+s$/)])
    })

    test('a run cut short (its record running, no lock held): Look offers its Undo, which runs; Apply refuses it', async () => {
      const at = '2026-10-21T10:04:00.000Z'
      const b = await useBoard(
        { uid: 0, flavor },
        { tunnel: { setup: { case: '1', address: 'https://board.example.com', at } } },
      )
      const cut = withRecord(
        b.fake.dir,
        distro,
        'bare',
        { state: 'running', items: [{ kind: 'container', name: 'agent-board-caddy', setup: 'r0' }] },
        'free',
      )
      b.server({ fixture: cut })
      expect(await b.look()).toEqual(OK)
      expect(b.setup.view().choice).toEqual({ case: null, why: ['interrupted'] })
      const u = planOf(b.setup)
      expect(u.kind).toBe('undo')
      expect(u.warnings[0]).toEqual({ key: 'server.warn.interrupted' })
      expect(await b.apply({ plan: u.id })).toMatchObject({ status: 409, body: { hint: 'lookAgain' } })
      b.server({ run: { lines: goesThrough(u) } })
      expect(await b.undo({ plan: u.id })).toEqual(OK)
      expect(b.setup.view().phase).toBe('undoing')
      await b.until(['done', 'failed'])
      expect(b.setup.view().phase).toBe('done')
      expect(b.tunnel().setup).toBeUndefined()
      expect(b.setup.view().setup).toBeNull()
      expect(b.tests()).toBe(0)
    })

    test('a wrong password at Apply, from a sudo in another language: failed with its lines, not “connection lost”', async () => {
      const b = await useBoard({
        sudo: 'password',
        password: SENTINEL,
        flavor,
        fixture: fixture(distro, 'caddy-unit'),
        wrong: WRONG_RU,
      })
      expect(await b.look({ password: SENTINEL })).toEqual(OK)
      const p = planOf(b.setup)
      b.server({ run: { lines: goesThrough(p) } })
      expect(await b.apply({ plan: p.id, password: 'wrong one' })).toEqual(OK)
      await b.until(['done', 'failed'])
      const v = b.setup.view()
      expect(v.phase).toBe('failed')
      expect(v.hint).not.toBe('lost')
      expect(v.hint).toBeNull()
      expect(v.error).toBe(WRONG_RU.filter(Boolean).join('\n'))
      expect(v.progress?.steps.map(s => s.state)).toEqual(p.steps.map(() => 'waiting'))
      expect(b.tunnel().setup).toBeUndefined()
      expect(b.tests()).toBe(0)
    })
  })
}

describe('step 1 by the board (the simple-setup spec)', () => {
  test('with the board’s key: Look compares the keys file with it, the plan makes what step 1 lacks, the run travels packed', async () => {
    const b = await useBoard({ uid: 0 }, { key: () => KEY })
    b.server({ fixture: withoutStepOne(b.fake.dir, 'debian13', 'bare') })
    expect(await b.look()).toEqual(OK)
    const look1 =
      b
        .commands()
        .map(carried)
        .find(s => s.includes('# agent-board: look-1')) ?? ''
    expect(look1).toContain(`= 'restrict,port-forwarding ${KEY}' ]`)
    const p = planOf(b.setup)
    expect(p.steps.map(s => s.id).slice(0, 5)).toEqual([
      'guard',
      'tunnel-user',
      'socket-folder',
      'keys-file',
      'sshd-fence',
    ])
    b.server({ run: { lines: goesThrough(p) } })
    expect(await b.apply({ plan: p.id })).toEqual(OK)
    await b.until(['done', 'failed'])
    expect(b.setup.view().phase).toBe('done')
    const launch = carried(b.commands().at(-1) ?? '')
    const data = /printf '%s\\n' '([A-Za-z0-9+/=]+)' \| base64 -d \| gunzip > "\$R\.sh"/.exec(launch)?.[1] ?? ''
    const run = gunzipSync(Buffer.from(data, 'base64')).toString('utf8')
    expect(run).toContain("--comment 'agent-board tunnel' boardtunnel")
    expect(run).toContain(`restrict,port-forwarding ${KEY}`)
  })

  test('without a key of its own (not made yet): Look and the plan as before, step 1 left to the owner', async () => {
    const b = await useBoard({ uid: 0 }, { key: () => null })
    b.server({ fixture: withoutStepOne(b.fake.dir, 'debian13', 'bare') })
    expect(await b.look()).toEqual(OK)
    expect(b.setup.view().choice).toEqual({ case: null, why: ['folder'] })
    const look1 =
      b
        .commands()
        .map(carried)
        .find(s => s.includes('# agent-board: look-1')) ?? ''
    expect(look1).not.toContain('restrict,port-forwarding')
  })

  test('the board’s key made anew between Look and Apply: Look again (the plan would put the old one in place)', async () => {
    let key = KEY
    const b = await useBoard({ uid: 0 }, { key: () => key })
    b.server({ fixture: withoutStepOne(b.fake.dir, 'debian13', 'bare') })
    expect(await b.look()).toEqual(OK)
    const p = planOf(b.setup)
    key = KEY.replace('board@pc', 'board@new')
    const calls = b.commands().length
    expect(await b.apply({ plan: p.id })).toMatchObject({ status: 409, body: { hint: 'lookAgain' } })
    expect(b.commands().length).toBe(calls)
    expect(b.setup.view().phase).toBe('plan')
  })
})

describe('a run’s ssh', () => {
  test('lasts longer than the run on the server can: its timeout, the rollback after it, the follower', async () => {
    const b = await useBoard({ uid: 0, fixture: fixture('debian13', 'bare') })
    expect(await b.look()).toEqual(OK)
    const p = planOf(b.setup)
    b.server({ run: { lines: goesThrough(p) } })
    expect(await b.apply({ plan: p.id })).toEqual(OK)
    await b.until(['done', 'failed'])
    const b64 = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(b.commands().at(-1) ?? '')?.[1] ?? ''
    const launch = Buffer.from(b64, 'base64').toString('utf8')
    const [, kill = '', most = ''] = /timeout -k (\d+) (\d+) sh /.exec(launch) ?? []
    const [, follower = ''] = /\[ "\$s" -lt (\d+) \]/.exec(launch) ?? []
    const serverS = Math.max(Number(most) + Number(kill), Number(follower))
    expect(serverS).toBeGreaterThanOrEqual(1200)
    // the follower counts its turns (a second's sleep and a look at the log each): two minutes more
    expect(b.deadlines.at(-1)).toBeGreaterThanOrEqual((serverS + 120) * 1000)
  })

  test('a launch that could not write the run (@@exit 70): failed, saying it never started', async () => {
    const b = await useBoard({ uid: 0, fixture: fixture('debian13', 'bare') })
    expect(await b.look()).toEqual(OK)
    const p = planOf(b.setup)
    b.server({ run: { lines: ['@@exit 70'] } })
    expect(await b.apply({ plan: p.id })).toEqual(OK)
    await b.until(['done', 'failed'])
    const v = b.setup.view()
    expect(v).toMatchObject({ phase: 'failed', hint: null })
    expect(v.error).toBe(
      'The server could not write the run to /etc/agent-board/runs (a full disk, or /etc read-only?): it did not start, nothing was changed.',
    )
    expect(v.progress?.steps.map(s => s.state)).toEqual(p.steps.map(() => 'waiting'))
    expect(b.tunnel().setup).toBeUndefined()
    expect(b.tests()).toBe(0)
  })
})

describe('what the panel wants, refused by the plan’s own check', () => {
  test('Look answers 409 with the check’s words, keeps nothing half made, and is not left busy', async () => {
    const b = await useBoard(
      { uid: 0, fixture: fixture('debian13', 'bare') },
      { acme: { ca: 'https://ca.example/dir; x', root: 'relative/root.pem' } },
    )
    const answer = await b.look()
    expect(answer).toEqual({
      status: 409,
      body: { ok: false, hint: null, error: 'The test CA is a URL and an absolute path' },
    })
    expect(b.setup.view()).toMatchObject({
      phase: 'idle',
      hint: null,
      error: 'The test CA is a URL and an absolute path',
      facts: null,
      choice: null,
      plan: null,
    })
    expect(await b.apply({ plan: 'r1' })).toMatchObject({ status: 409, body: { hint: 'lookAgain' } })
    // not stuck: the next Look runs (and is refused the same way)
    expect(await b.look()).toMatchObject({ status: 409, body: { hint: null } })
  })
})

describe('the admin’s fields and Cancel', () => {
  test('saved in config.json’s tunnel.admin, checked first; Cancel drops the plan', async () => {
    const b = await useBoard({ uid: 0, fixture: fixture('debian13', 'bare') })
    expect(b.setup.admin({ user: '-l' })).toEqual({
      status: 409,
      body: { ok: false, hint: null, field: 'user', error: 'The user is a plain user name, without a leading dash' },
    })
    expect(b.tunnel().admin).toEqual({ user: 'admin' })
    expect(b.setup.admin({ key: 'C:\\keys\\admin key' })).toEqual(OK)
    expect(b.tunnel().admin).toEqual({ user: 'admin', key: 'C:\\keys\\admin key' })
    expect(b.setup.view().admin).toEqual({ user: 'admin', key: 'C:\\keys\\admin key' })
    expect(b.setup.admin({ key: '' })).toEqual(OK)
    expect(b.tunnel().admin).toEqual({ user: 'admin' })
    expect(b.setup.admin({ user: '' })).toEqual(OK)
    expect(b.tunnel().admin).toBeUndefined()
    // no admin: Look says so, nothing spawned
    expect(await b.look()).toMatchObject({ status: 409, body: { field: 'user', error: 'Admin user: needed' } })
    expect(b.fake.calls()).toEqual([])
    expect(b.setup.admin({ user: 'root' })).toEqual(OK)
    expect(await b.look()).toEqual(OK)
    expect(b.setup.view().phase).toBe('plan')
    expect(b.setup.cancel()).toEqual(OK)
    expect(b.setup.view()).toMatchObject({ phase: 'idle', plan: null, facts: null, choice: null })
    expect(await b.apply({ plan: 'r1' })).toMatchObject({ status: 409, body: { hint: 'lookAgain' } })
  })

  test('a password with a line break, or not a string: malformed, nothing spawned', async () => {
    const b = await useBoard({ sudo: 'password', fixture: fixture('debian13', 'bare') })
    expect(await b.look({ password: 'a\nb' })).toEqual({ status: 400, body: { ok: false, error: 'password' } })
    expect(await b.look({ password: 'a\rb' })).toEqual({ status: 400, body: { ok: false, error: 'password' } })
    expect(await b.look({ password: 5 })).toEqual({ status: 400, body: { ok: false, error: 'password' } })
    expect(await b.look({ sudoPassword: 'a\nb' })).toEqual({ status: 400, body: { ok: false, error: 'sudoPassword' } })
    expect(await b.undoLook({ sudoPassword: [] })).toEqual({ status: 400, body: { ok: false, error: 'sudoPassword' } })
    expect(await b.apply({ plan: 'r1', sudoPassword: 7 })).toEqual({
      status: 400,
      body: { ok: false, error: 'sudoPassword' },
    })
    expect(b.fake.calls()).toEqual([])
  })
})

type End = { code: number | null; error: string | null }

/** spawnRemote, until `breakWith`: after `after` more spawns, each ssh ends so without running (a spawn error, or killed at its limit). */
function breakable() {
  let end: End | null = null
  let left = 0
  const spawn: typeof spawnRemote = (bin, args, stdin, ms) => {
    if (end && left-- <= 0) return { onLine: () => {}, done: Promise.resolve(end), kill: () => {} }
    return spawnRemote(bin, args, stdin, ms)
  }
  return {
    spawn,
    breakWith(e: End, after = 0): void {
      end = e
      left = after
    },
  }
}

const TIMEOUT = 'The server took too long to answer (a hung Docker daemon is a usual cause): try again later.'

describe('why a Look or a run stopped, said once and as it was', () => {
  test('a Look stopped by a hint alone: the hint’s sentence once, as the answer’s error, not again as the view’s', async () => {
    const pw = await useBoard({ sudo: 'password', password: SENTINEL, fixture: fixture('debian13', 'caddy-unit') })
    expect(await pw.look()).toMatchObject({
      status: 409,
      body: { hint: 'needPassword', error: 'Type admin’s sudo password.' },
    })
    expect(pw.setup.view()).toMatchObject({ phase: 'idle', hint: 'needPassword', error: null })
    const tty = await useBoard({ sudo: 'requiretty', flavor: 'sudo', fixture: fixture('debian13', 'bare') })
    expect(await tty.look({ password: 'x' })).toMatchObject({ status: 409, body: { hint: 'requiretty' } })
    expect(tty.setup.view()).toMatchObject({ hint: 'requiretty', error: null })
    // a hint with lines of its own keeps them as the error
    const key = await useBoard({ publickey: true, fixture: fixture('debian13', 'bare') })
    expect(await key.look()).toMatchObject({ status: 409, body: { hint: 'publickey' } })
    expect(key.setup.view()).toMatchObject({
      hint: 'publickey',
      error: 'admin@ssh.example.com: Permission denied (publickey).',
    })
  })

  test('a Look cut at its limit (the probe, or a round a hung Docker holds): the server took too long', async () => {
    const probe = breakable()
    const early = await useBoard({ uid: 0, fixture: fixture('debian13', 'bare') }, { spawn: probe.spawn })
    probe.breakWith({ code: null, error: 'timeout' })
    expect(await early.look()).toEqual({ status: 409, body: { ok: false, hint: null, error: TIMEOUT } })
    expect(early.setup.view()).toMatchObject({ phase: 'idle', hint: null, error: TIMEOUT, plan: null })
    const round = breakable()
    const late = await useBoard({ uid: 0, fixture: fixture('debian13', 'bare') }, { spawn: round.spawn })
    round.breakWith({ code: 1, error: 'timeout' }, 1)
    expect(await late.look()).toEqual({ status: 409, body: { ok: false, hint: null, error: TIMEOUT } })
    expect(late.setup.view()).toMatchObject({ phase: 'idle', hint: null, error: TIMEOUT })
    expect(late.commands()).toHaveLength(1)
  })

  test('ssh that could not start: no OpenSSH client only when it is missing; another reason in its own code', async () => {
    const missing = breakable()
    const none = await useBoard({ uid: 0, fixture: fixture('debian13', 'bare') }, { spawn: missing.spawn })
    missing.breakWith({ code: null, error: 'ENOENT' })
    expect(await none.look()).toMatchObject({ status: 409, body: { hint: 'noSsh' } })
    const long = breakable()
    const b = await useBoard({ uid: 0, fixture: fixture('debian13', 'bare') }, { spawn: long.spawn })
    long.breakWith({ code: null, error: 'ENAMETOOLONG' })
    const said = 'ssh could not start (ENAMETOOLONG).'
    expect(await b.look()).toEqual({ status: 409, body: { ok: false, hint: null, error: said } })
    expect(b.setup.view()).toMatchObject({ hint: null, error: said })
    // and a run's: failed with that, not "No OpenSSH client found" or "the connection was lost"
    const runs = breakable()
    const r = await useBoard({ uid: 0, fixture: fixture('debian13', 'bare') }, { spawn: runs.spawn })
    expect(await r.look()).toEqual(OK)
    runs.breakWith({ code: null, error: 'ENAMETOOLONG' })
    expect(await r.apply({ plan: planOf(r.setup).id })).toEqual(OK)
    await r.until(['done', 'failed'])
    expect(r.setup.view()).toMatchObject({ phase: 'failed', hint: null, error: said })
  })

  test('the connection gone before the run’s first line (ssh’s own words, exit 255): lost, the server finishes by itself', async () => {
    const b = await useBoard({ uid: 0, fixture: fixture('debian13', 'bare') })
    expect(await b.look()).toEqual(OK)
    const p = planOf(b.setup)
    b.server({ run: { lines: goesThrough(p), dropAfter: 0 } })
    expect(await b.apply({ plan: p.id })).toEqual(OK)
    await b.until(['done', 'failed'])
    expect(b.setup.view()).toMatchObject({
      phase: 'failed',
      hint: 'lost',
      error: 'Connection to ssh.example.com closed by remote host.',
    })
    expect(b.setup.view().progress?.steps.every(s => s.state === 'waiting')).toBe(true)
    // refused before the launch (exit 255 too, in other words): its own hint, not lost
    expect(await b.look()).toEqual(OK)
    b.server({ publickey: true })
    expect(await b.apply({ plan: planOf(b.setup).id })).toEqual(OK)
    await b.until(['done', 'failed'])
    expect(b.setup.view()).toMatchObject({ phase: 'failed', hint: 'publickey' })
  })
})

describe('the admin’s login by password (the simple-setup spec)', () => {
  const ROOT = { tunnel: { admin: { user: 'root' } } }
  const OLD_SSH = 'OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2'
  const PASSWORD_LINE = [
    'PreferredAuthentications=publickey,keyboard-interactive,password',
    'NumberOfPasswordPrompts=1',
  ]

  test('root by password, the owner’s case: each ssh’s one prompt answered, no BatchMode, one try; the password nowhere', async () => {
    const b = await useBoard(
      { uid: 0, publickey: true, login: { password: SENTINEL }, fixture: fixture('debian13', 'caddy-unit') },
      ROOT,
    )
    expect(await b.look({ password: SENTINEL })).toEqual(OK)
    expect(b.setup.view()).toMatchObject({ phase: 'plan', sudo: 'root', hint: null, choice: { case: '2' } })
    expect(b.prompts()).toEqual(Array(3).fill("root@ssh.example.com's password: "))
    for (const a of b.logins()) {
      expect(a).not.toContain('BatchMode=yes')
      expect(a).toEqual(expect.arrayContaining(PASSWORD_LINE))
    }
    // root: no sudo, nothing on stdin
    expect(b.stdins()).toEqual([])
    const p = planOf(b.setup)
    b.server({ run: { lines: goesThrough(p, [`echo ${SENTINEL}`]) } })
    expect(await b.apply({ plan: p.id, password: SENTINEL })).toEqual(OK)
    await b.until(['done', 'failed'])
    expect(b.setup.view().phase).toBe('done')
    expect(b.prompts()).toHaveLength(4)
    expect(b.setup.view().progress?.steps[1]?.out).toContain('echo ••••')
    // what led ssh to the askpass: fixed text, a port and a token; never the password
    expect(b.leads()).toHaveLength(4)
    for (const lead of b.leads()) {
      expect(lead).toMatchObject({
        SSH_ASKPASS: process.execPath,
        SSH_ASKPASS_REQUIRE: 'force',
        BUN_OPTIONS: '-e import(process.env.BOARD_ASKPASS_MAIN) --',
        BOARD_ASKPASS_MAIN: expect.stringMatching(/askpass\.ts$/),
        BOARD_ASKPASS_PORT: expect.stringMatching(/^\d+$/),
        BOARD_ASKPASS_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    }
    const tokens = new Set(b.leads().map(l => l.BOARD_ASKPASS_TOKEN))
    expect(tokens.size).toBe(4)
    const nowhere = (what: string, text: string): void => expect([what, text.includes(SENTINEL)]).toEqual([what, false])
    nowhere('argv', JSON.stringify(b.fake.calls()))
    nowhere('ssh’s environment', JSON.stringify(b.leads()))
    nowhere('prompts', JSON.stringify(b.prompts()))
    nowhere('view', JSON.stringify(b.setup.view()))
    nowhere('answers', JSON.stringify(b.answers))
    nowhere('log', JSON.stringify(b.logs))
    for (const [path, text] of [...files(stateDir()), ...files(configDir())]) nowhere(path, text)
  })

  test('no password typed, the key refused, the server takes one: the password asked for; ssh’s line as before, no ssh -V', async () => {
    const b = await useBoard({
      uid: 0,
      publickey: true,
      login: { password: 'pw' },
      fixture: fixture('debian13', 'bare'),
    })
    const answer = await b.look()
    expect(answer).toMatchObject({ status: 409, body: { ok: false, hint: 'loginPassword', need: 'password' } })
    expect(b.setup.view()).toMatchObject({ phase: 'idle', hint: 'loginPassword' })
    expect(b.logins()).toHaveLength(1)
    expect(b.logins()[0]).toContain('BatchMode=yes')
    expect(b.logins()[0]).not.toContain(PASSWORD_LINE[0])
    expect(b.versions()).toBe(0)
    expect(b.prompts()).toEqual([])
    expect(b.leads()).toEqual([])
  })

  test('a wrong password: one try, the login’s field asked for again; root’s says root may be refused a password', async () => {
    const b = await useBoard({ publickey: true, login: { password: 'right' }, fixture: fixture('debian13', 'bare') })
    expect(await b.look({ password: 'wrong' })).toMatchObject({
      status: 409,
      body: { ok: false, hint: 'wrongLogin', need: 'password' },
    })
    expect(b.prompts()).toEqual(["admin@ssh.example.com's password: "])
    expect(b.logins()).toHaveLength(1)
    const root = await useBoard({ uid: 0, publickey: true, login: { password: 'right' } }, ROOT)
    expect(await root.look({ password: 'wrong' })).toMatchObject({
      status: 409,
      body: { ok: false, hint: 'rootLogin', need: 'password' },
    })
    expect(root.prompts()).toHaveLength(1)
    // and at Apply: the run fails before it starts, with the same hint
    root.server({ fixture: fixture('debian13', 'bare') })
    expect(await root.look({ password: 'right' })).toEqual(OK)
    const p = planOf(root.setup)
    root.server({ run: { lines: goesThrough(p) } })
    expect(await root.apply({ plan: p.id, password: 'wrong' })).toEqual(OK)
    await root.until(['done', 'failed'])
    expect(root.setup.view()).toMatchObject({ phase: 'failed', hint: 'rootLogin' })
    expect(root.setup.view().progress?.steps.every(s => s.state === 'waiting')).toBe(true)
  })

  test('a one-time code after the password: ssh ended before any answer to it, the prompt named', async () => {
    const b = await useBoard({
      publickey: true,
      login: { password: 'pw', kbdint: ['Password: ', 'Verification code: '] },
      fixture: fixture('debian13', 'bare'),
    })
    const answer = await b.look({ password: 'pw' })
    expect(answer).toMatchObject({ status: 409, body: { ok: false, hint: 'otherPrompt' } })
    expect((answer.body as Fields).error).toContain('The server asked: (admin@ssh.example.com) Verification code:')
    expect(b.prompts()).toEqual(['(admin@ssh.example.com) Password: ', '(admin@ssh.example.com) Verification code: '])
    expect(b.setup.view()).toMatchObject({ phase: 'idle', hint: 'otherPrompt' })
  })

  test('keyboard-interactive, then the password method: a wrong password is never tried a second time', async () => {
    const b = await useBoard({
      publickey: true,
      login: { password: 'right', kbdint: ['Password: '], alsoPassword: true },
      fixture: fixture('debian13', 'bare'),
    })
    expect(await b.look({ password: 'wrong' })).toMatchObject({ status: 409, body: { hint: 'wrongLogin' } })
    // ssh asked twice; the askpass answered the first and ended ssh at the second
    expect(b.prompts()).toEqual(['(admin@ssh.example.com) Password: ', "admin@ssh.example.com's password: "])
  })

  test('a server that takes only keys, a password typed: it says so', async () => {
    const b = await useBoard({ publickey: true, fixture: fixture('debian13', 'bare') })
    expect(await b.look({ password: 'pw' })).toMatchObject({ status: 409, body: { ok: false, hint: 'keyOnly' } })
    expect(b.prompts()).toEqual([])
  })

  test('a key the server takes, a password typed: the key first, the password never asked; sudo gets it', async () => {
    const b = await useBoard({ sudo: 'password', password: 'pw', fixture: fixture('debian13', 'caddy-unit') })
    expect(await b.look({ password: 'pw' })).toEqual(OK)
    expect(b.prompts()).toEqual([])
    for (const a of b.logins()) expect(a).toEqual(expect.arrayContaining(PASSWORD_LINE))
    expect(b.stdins()).toEqual(['pw\n', 'pw\n'])
  })

  test('a sudo user by password whose sudo takes the same password (call 3)', async () => {
    const b = await useBoard({
      publickey: true,
      login: { password: SENTINEL },
      sudo: 'password',
      password: SENTINEL,
      fixture: fixture('debian13', 'caddy-unit'),
    })
    expect(await b.look({ password: SENTINEL })).toEqual(OK)
    expect(b.prompts()).toHaveLength(3)
    expect(b.stdins()).toEqual([`${SENTINEL}\n`, `${SENTINEL}\n`])
    // at Apply sudo refuses it (its password changed since): sudo needs its own, nothing ran
    const p = planOf(b.setup)
    b.server({ password: 'changed', run: { lines: goesThrough(p) } })
    expect(await b.apply({ plan: p.id, password: SENTINEL })).toEqual(OK)
    await b.until(['done', 'failed'])
    expect(b.setup.view()).toMatchObject({ phase: 'failed', hint: 'sudoPassword' })
    expect(b.setup.view().progress?.steps.every(s => s.state === 'waiting')).toBe(true)
  })

  test('an ssh too old for the askpass (Windows 10’s 8.1): the keys alone, as before; refused, it says why', async () => {
    const key = await useBoard(
      { sudo: 'password', password: 'pw', fixture: fixture('debian13', 'caddy-unit') },
      { sshVersion: OLD_SSH },
    )
    expect(await key.look({ password: 'pw' })).toEqual(OK)
    for (const a of key.logins()) expect(a).toContain('BatchMode=yes')
    expect(key.stdins()).toEqual(['pw\n', 'pw\n'])
    expect(key.versions()).toBe(1)
    const pw = await useBoard({ uid: 0, publickey: true, login: { password: 'pw' } }, { ...ROOT, sshVersion: OLD_SSH })
    expect(await pw.look({ password: 'pw' })).toMatchObject({ status: 409, body: { ok: false, hint: 'sshOld' } })
    expect(pw.prompts()).toEqual([])
    expect(pw.leads()).toEqual([])
  })
})
