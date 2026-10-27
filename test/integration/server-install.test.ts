// The board on a server of the owner's, end to end (the board-on-own-server spec's "Testing"), off
// unless BOARD_SERVER_IT=1: a Debian 13 test server (BOARD_SERVER_IT_LANES=debian13,ubuntu2604,…
// for others) of the server setup's harness (server/harness.ts: Pebble for the certificates, a
// client container as the outside), and path A from this working copy: its tracked and new files
// committed into a bare repository on the server (in place of GitHub), the bootstrap
// server-install.sh run there in a terminal as root, as it is piped from GitHub, its questions
// answered.
//
// An empty server (case 1, the board's own Caddy): the user, Bun, herdr and Claude Code from their
// own installers, herdr's user service up, the server mode in the board's config, the web server's
// record of the server mode, the domain in front of the board's socket (a stand-in answers on the
// socket while the board's listener is not in this branch; with it, its login and setup pages),
// the script run again (nothing to change, herdr left running), `board update` following the ref,
// a reboot bringing herdr back, then Undo, and Undo with the user. Their Caddy in Docker with two
// sites (case 3a): the board added and their sites answering all along.
//
// Long (the installers download Bun, herdr, Claude Code and Docker's images; a flaky internet is
// tried again, BOARD_INSTALL_TRIES): BOARD_SERVER_IT=1 bun test test/integration/server-install.test.ts
// --timeout 7200000. BOARD_IT_KEEP=1 keeps the images for the next run.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../../src/adapters/paths.ts'
import { BOARD_SOCKET, BOARD_USER_COMMENT } from '../../src/core/server-install.ts'
import { FENCE_FILE } from '../../src/core/server-texts.ts'
import {
  buildImage,
  closeLane,
  type Distro,
  docker,
  dockerUp,
  type Lane,
  noCr,
  note,
  onTty,
  PEBBLE_DIR,
  PEBBLE_ROOT_ON_SERVER,
  removeRun,
  removeStale,
  run,
  scenarioScript,
  startLane,
  startMirror,
  startServer,
  type TestServer,
  until,
  work,
} from './server/harness.ts'

const ON = process.env.BOARD_SERVER_IT === '1'
function dockerAnswers(): boolean {
  try {
    return (
      Bun.spawnSync(['docker', 'info', '--format', '{{.ServerVersion}}'], {
        stdout: 'ignore',
        stderr: 'ignore',
        timeout: 60_000,
        windowsHide: true,
      }).exitCode === 0
    )
  } catch {
    return false
  }
}
const DOCKER = ON && dockerAnswers()
if (ON && !DOCKER) console.warn('server-install: BOARD_SERVER_IT=1, but Docker does not answer: skipped')

const MIN = 60_000
const DOMAIN = 'board.example.com'
const LANES = (process.env.BOARD_SERVER_IT_LANES ?? 'debian13').split(',').filter(Boolean) as Distro[]
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const KEYGEN = process.platform === 'win32' ? join(SYSTEM32, 'OpenSSH', 'ssh-keygen.exe') : 'ssh-keygen'
const REPO = 'file:///opt/board.git'
const REF = 'lane'
const SCRIPT = '/root/server-install.sh'
const HOME = '/home/agent'
/** How often the server's downloads are tried: this PC's internet drops connections now and then. */
const TRIES = process.env.BOARD_INSTALL_TRIES ?? '30'
const ENV = `BOARD_SETUP_ACME_CA=${PEBBLE_DIR} BOARD_SETUP_ACME_CA_ROOT=${PEBBLE_ROOT_ON_SERVER} BOARD_INSTALL_TRIES=${TRIES}`
const ANSWERS = [
  { name: 'packages', prompt: /Install them\? \[y\/N\] $/, answer: 'y' },
  { name: 'go', prompt: /Go ahead\? \[y\/N\] $/, answer: 'y' },
]
const rows: string[] = []
const lanes = new Map<Distro, Lane>()
let adminKey = ''
let repo = ''

/** git on this checkout, its index the lane's own when `index` is given; stdout. */
function git(args: string[], index?: string): string {
  const r = Bun.spawnSync(['git', '-C', ROOT, ...args], {
    env: {
      ...process.env,
      ...(index && { GIT_INDEX_FILE: index }),
      GIT_AUTHOR_NAME: 'lane',
      GIT_AUTHOR_EMAIL: 'lane@example.com',
      GIT_COMMITTER_NAME: 'lane',
      GIT_COMMITTER_EMAIL: 'lane@example.com',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

/**
 * The working copy as a commit (its tracked files with their changes and its new ones, through an
 * index of the lane's own: the checkout and its refs stay as they are), pushed to a bare
 * repository as the branch `lane`: the server fetches the board from it as from GitHub.
 */
function laneRepo(): string {
  const dir = join(work(), 'board.git')
  const index = join(work(), 'lane.index')
  rmSync(dir, { recursive: true, force: true })
  Bun.spawnSync(['git', 'init', '-q', '--bare', dir])
  git(['read-tree', 'HEAD'], index)
  git(['add', '-A'], index)
  const tree = git(['write-tree'], index)
  const commit = git(['commit-tree', tree, '-p', 'HEAD', '-m', 'lane: the working copy'])
  git(['push', '-q', dir, `${commit}:refs/heads/${REF}`])
  note(`lane repository ${dir} at ${commit}`)
  return dir
}

/** A server of the lane with the lane's repository at /opt/board.git and the bootstrap at /root (as pasted from GitHub). */
async function serverFor(l: Lane, tag: string, scenario?: string): Promise<TestServer> {
  const s = await startServer(l, { tag, withDocker: true, adminKey, password: 'admin-pw' })
  if (scenario)
    await s.sh(scenarioScript(scenario), {
      env: { THEIR_ACME: PEBBLE_DIR, THEIR_ACME_ROOT: PEBBLE_ROOT_ON_SERVER },
      timeoutMs: 15 * MIN,
    })
  await docker(['cp', repo, `${s.name}:/opt/board.git`])
  // root's: git (2.45 and later) takes a local repository of another user's only when it is a safe one
  await s.sh(
    "chmod -R a+rX /opt/board.git && chown -R root:root /opt/board.git && printf '[safe]\\n\\tdirectory = /opt/board.git\\n' > /etc/gitconfig",
  )
  const bootstrap = noCr(readFileSync(join(ROOT, 'server-install.sh'), 'utf8'))
  await s.exec(['sh', '-c', `cat > ${SCRIPT}`], { stdin: bootstrap })
  await l.addA(DOMAIN, s.ip)
  return s
}

/** The install as the owner runs it: in a terminal on the server as root, its questions answered yes. */
async function install(s: TestServer, more = ''): Promise<{ code: number; out: string }> {
  const r = await onTty(s, `env ${ENV} sh ${SCRIPT} --domain ${DOMAIN} --repo ${REPO} --ref ${REF} ${more}`.trim(), {
    answers: ANSWERS,
    timeoutMs: 90 * MIN,
  })
  return { code: r.code, out: r.stdout }
}

const asAgent = (s: TestServer, script: string, check = true) =>
  s.sh(
    `runuser -u agent -- env -i HOME=${HOME} USER=agent PATH=${HOME}/.local/bin:${HOME}/.bun/bin:/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/$(id -u agent) sh -c ${JSON.stringify(script)}`,
    {
      check,
      timeoutMs: 10 * MIN,
    },
  )

const herdrActive = async (s: TestServer): Promise<boolean> =>
  (await asAgent(s, 'systemctl --user is-active herdr.service', false)).stdout.trim() === 'active'

/**
 * The board's socket answers: the board's own listener once it is there (the board-on-own-server
 * branch's login listener); while it is not, a stand-in on the socket as the board's user, as the
 * board makes it (0660 in the 2750 folder, whose group the web server reaches it by).
 */
async function onSocket(s: TestServer): Promise<'board' | 'stand-in'> {
  if ((await s.sh(`test -S ${BOARD_SOCKET}`, { check: false })).code === 0) return 'board'
  const serve = `const s = Bun.serve({ unix: '${BOARD_SOCKET}', fetch: r => new Response('stand-in ' + new URL(r.url).pathname + ' ' + (r.headers.get('x-forwarded-proto') ?? '')) }); require('node:fs').chmodSync('${BOARD_SOCKET}', 0o660)`
  await asAgent(
    s,
    `cd /tmp && nohup ${HOME}/.bun/bin/bun -e "${serve.replaceAll('"', '\\"')}" >/tmp/standin.log 2>&1 &`,
  )
  await until(
    'the stand-in on the socket',
    async () => (await s.sh(`test -S ${BOARD_SOCKET}`, { check: false })).code === 0,
    30_000,
  )
  return 'stand-in'
}

/** https://board.example.com from the client, Pebble's certificate checked: what it answers (status, body). */
async function fromClient(
  l: Lane,
  s: TestServer,
  host: string,
  path = '/',
  insecure = false,
): Promise<{ code: string; body: string }> {
  const r = await l.client(
    `curl -sS -m 10 ${insecure ? '-k' : '--cacert /root.pem'} --resolve ${host}:443:${s.ip} -w '\\n%{http_code}' https://${host}${path}`,
    { check: false },
  )
  const lines = r.stdout.trimEnd().split('\n')
  return { code: lines.at(-1) ?? '', body: lines.slice(0, -1).join('\n') }
}

/** The domain answering from the client (its certificate first: a few tries while Caddy gets it). */
async function domainAnswers(l: Lane, s: TestServer, who: 'board' | 'stand-in'): Promise<string> {
  let last = { code: '', body: '' }
  await until(
    `${DOMAIN} answers from the client (${last.code} ${last.body.slice(0, 80)})`,
    async () => {
      last = await fromClient(l, s, DOMAIN)
      return who === 'stand-in' ? last.body.startsWith('stand-in / https') : /^(200|302|303|401)$/.test(last.code)
    },
    5 * MIN,
    3000,
  )
  if (who === 'board') {
    // the board's login: nothing but the setup page before a login is set (the listener's own branch)
    const setup = await fromClient(l, s, DOMAIN, '/setup')
    expect(setup.code).toBe('200')
  }
  return `${last.code} ${last.body.slice(0, 40)}`
}

describe.skipIf(!DOCKER)('the board on a server of the owner’s (path A from this working copy)', () => {
  beforeAll(async () => {
    console.log(`server-install: the run's log is ${join(work(), 'run.log')}`)
    if (!(await dockerUp())) throw new Error('Docker does not answer: start Docker Desktop')
    await removeStale()
    adminKey = join(work(), 'admin_ed25519')
    await run([KEYGEN, '-q', '-t', 'ed25519', '-N', '', '-C', 'agent-board-it', '-f', adminKey])
    repo = laneRepo()
    await startMirror()
    await Promise.all(LANES.map(d => buildImage(d, true)))
    for (const l of await Promise.all(LANES.map(d => startLane(d)))) lanes.set(l.distro, l)
  }, 60 * MIN)

  afterAll(async () => {
    for (const l of lanes.values()) closeLane(l)
    console.log(`server-install results:\n${rows.join('\n')}`)
    await removeRun()
  }, 20 * MIN)

  for (const d of LANES) {
    test(
      `${d}: an empty server, the board's own Caddy (case 1): install, again, update, reboot, Undo`,
      async () => {
        const l = lanes.get(d) as Lane
        const s = await serverFor(l, 'install-bare')
        const row = [`${d} case 1`]
        try {
          // the first run
          const first = await install(s)
          expect(first.out, first.out.slice(-3000)).toContain(`Done: the board is at https://${DOMAIN}`)
          expect(first.code).toBe(0)
          expect(first.out).toContain('Make the user agent (no sudo)')
          row.push('installed')
          // the user, marked, lingering, no sudo
          expect((await s.sh('getent passwd agent | cut -d: -f5')).stdout.trim()).toBe(BOARD_USER_COMMENT)
          expect((await s.sh('loginctl show-user agent -p Linger')).stdout.trim()).toBe('Linger=yes')
          expect((await s.sh('ls /etc/sudoers.d')).stdout).not.toContain('agent-board')
          // the tools, as the user
          const versions = await asAgent(s, 'bun --version; herdr --version; claude --version')
          expect(versions.stdout).toContain('1.4.3')
          row.push(versions.stdout.trim().split('\n').join(', '))
          // herdr's service up, as the user, from its unit
          expect(await herdrActive(s)).toBe(true)
          expect((await asAgent(s, 'systemctl --user is-enabled herdr.service')).stdout.trim()).toBe('enabled')
          // the board: its checkout at the lane's commit, the server mode, where the code came from
          const conf = await s.sh(`cat ${HOME}/.config/herdr/plugins/config/agent-board/config.json`)
          expect(JSON.parse(conf.stdout).serverMode).toEqual({ domain: DOMAIN, socket: BOARD_SOCKET })
          const source = JSON.parse(
            (await s.sh(`cat ${HOME}/.config/herdr/plugins/config/agent-board/source.json`)).stdout,
          )
          expect(source).toMatchObject({ kind: 'git', repo: REPO, ref: REF })
          expect((await asAgent(s, `git -C ${HOME}/agent-board rev-parse HEAD`)).stdout.trim()).toBe(source.commit)
          expect((await asAgent(s, 'herdr plugin list')).stdout).toContain(`${HOME}/agent-board`)
          expect((await s.sh(`test -x ${HOME}/.local/bin/board`, { check: false })).code).toBe(0)
          // the web server's record: the server mode's, case 1; the socket's folder for the board's user
          const record = JSON.parse((await s.sh('cat /etc/agent-board/setup.json')).stdout)
          expect(record).toMatchObject({
            state: 'applied',
            case: '1',
            pair: { user: 'agent', socket: BOARD_SOCKET, server: true },
          })
          expect((await s.sh('stat -c "%a %U" /var/lib/agent-board')).stdout.trim()).toBe('2750 agent')
          expect(
            (await s.sh(`test -e /etc/ssh/authorized_keys/agent || test -e ${FENCE_FILE}`, { check: false })).code,
          ).not.toBe(0)
          expect(JSON.parse((await s.sh('cat /etc/agent-board/install.json')).stdout)).toMatchObject({
            user: 'agent',
            domain: DOMAIN,
          })
          // the domain in front of the board's socket
          const who = await onSocket(s)
          row.push(`${DOMAIN}: ${await domainAnswers(l, s, who)} (${who})`)

          // again: nothing changes on the web server, herdr goes on
          const pid = (await s.sh('pgrep -u agent -f "herdr server" | head -n 1')).stdout.trim()
          const again = await install(s)
          expect(again.code, again.out.slice(-3000)).toBe(0)
          expect(again.out).toContain('Nothing to change: the board is set up here already.')
          expect(again.out).not.toContain('Make the user agent')
          expect((await s.sh('pgrep -u agent -f "herdr server" | head -n 1')).stdout.trim()).toBe(pid)
          row.push('again: nothing to change, herdr left running')

          // board update follows the ref: the same commit, then a new one on the branch
          expect((await asAgent(s, 'board update')).stdout).toContain(`Already at ${REF}`)
          await s.sh(
            `rm -rf /tmp/w && git clone -q ${REPO} -b ${REF} /tmp/w && git -C /tmp/w -c user.name=lane -c user.email=l@x commit -q --allow-empty -m next && git -C /tmp/w push -q origin ${REF}`,
          )
          const next = (await s.sh('git -C /tmp/w rev-parse HEAD')).stdout.trim()
          const updated = await asAgent(s, 'board update')
          expect(updated.stdout).toContain(`Updated to ${REF} (${next.slice(0, 7)})`)
          expect((await asAgent(s, `git -C ${HOME}/agent-board rev-parse HEAD`)).stdout.trim()).toBe(next)
          row.push('board update: followed the ref')

          // a reboot: herdr's service back with nothing typed (lingering), the board's Caddy up
          await docker(['restart', s.name], { timeoutMs: 5 * MIN })
          await until(
            'systemd up after the restart',
            async () =>
              /^(running|degraded)/.test((await s.sh('systemctl is-system-running', { check: false })).stdout),
            3 * MIN,
            1000,
          )
          await until('herdr back after the restart', () => herdrActive(s), 3 * MIN, 2000)
          await until(
            "the board's Caddy back after the restart",
            async () =>
              (
                await s.sh("docker inspect -f '{{.State.Running}}' agent-board-caddy", { check: false })
              ).stdout.trim() === 'true',
            3 * MIN,
            2000,
          )
          // the board's own listener comes back with herdr (a stand-in does not: it was the test's)
          row.push(
            `reboot: herdr and the board's Caddy back${who === 'board' ? `, ${DOMAIN}: ${await domainAnswers(l, s, 'board')}` : ''}`,
          )

          // Undo: the service, lingering, the web server's part; the user stays
          const undo = await onTty(s, `sh ${SCRIPT} --undo`, { answers: ANSWERS, timeoutMs: 20 * MIN })
          expect(undo.code, undo.stdout.slice(-3000)).toBe(0)
          expect(undo.stdout).toContain('Undone.')
          expect((await s.sh('loginctl show-user agent -p Linger', { check: false })).stdout.trim()).not.toBe(
            'Linger=yes',
          )
          expect((await s.sh('pgrep -u agent -f "herdr server"', { check: false })).code).not.toBe(0)
          expect((await s.sh('docker ps -a --format "{{.Names}}"')).stdout).not.toContain('agent-board-caddy')
          expect(
            (
              await s.sh(
                'test -e /etc/agent-board || test -e /usr/local/lib/agent-board || test -e /var/lib/agent-board',
                { check: false },
              )
            ).code,
          ).not.toBe(0)
          expect((await s.sh('getent passwd agent', { check: false })).code).toBe(0)
          expect(
            JSON.parse((await s.sh(`cat ${HOME}/.config/herdr/plugins/config/agent-board/config.json`)).stdout)
              .serverMode,
          ).toBeUndefined()
          // and with the user: gone with its home
          const gone = await onTty(s, `env ${ENV} sh ${SCRIPT} --undo --remove-user --repo ${REPO} --ref ${REF}`, {
            answers: ANSWERS,
            timeoutMs: 20 * MIN,
          })
          expect(gone.code, gone.stdout.slice(-3000)).toBe(0)
          expect((await s.sh('getent passwd agent', { check: false })).code).not.toBe(0)
          expect((await s.sh(`test -e ${HOME}`, { check: false })).code).not.toBe(0)
          row.push('Undo, then Undo with the user: all gone')
        } finally {
          rows.push(row.join(' · '))
          await s.stop()
        }
      },
      150 * MIN,
    )

    test(
      `${d}: their Caddy in Docker with two sites (case 3a): the board added, their sites answering all along`,
      async () => {
        const l = lanes.get(d) as Lane
        const s = await serverFor(l, 'install-3a', 'compose-folder')
        const row = [`${d} case 3a`]
        const sites = ['a.example.com', 'b.example.com']
        try {
          for (const host of sites) expect((await fromClient(l, s, host, '/', true)).code).toBe('200')
          // their sites fetched from the client twice a second while the install runs
          const watch = '/tmp/watch-install-3a'
          const each = sites
            .map(
              h =>
                `printf '%s %s\\n' ${h} "$(curl -sk -m 5 -o /dev/null -w '%{http_code}' --resolve ${h}:443:${s.ip} https://${h}/)"`,
            )
            .join('; ')
          await l.clientBackground(
            `rm -f ${watch} ${watch}.stop; while [ ! -e ${watch}.stop ]; do { ${each}; } >> ${watch}; sleep 0.5; done`,
          )
          const done = await install(s)
          await l.client(`touch ${watch}.stop; sleep 1`)
          expect(done.code, done.out.slice(-3000)).toBe(0)
          expect(done.out).toContain(`Add ${DOMAIN} to your Caddy and hand it the board.`)
          const seen = (await l.client(`cat ${watch}`)).stdout.trim().split('\n')
          expect(seen.length).toBeGreaterThan(10)
          expect(seen.filter(x => !x.endsWith(' 200'))).toEqual([])
          const record = JSON.parse((await s.sh('cat /etc/agent-board/setup.json')).stdout)
          expect(record).toMatchObject({ case: '3a', pair: { user: 'agent', socket: BOARD_SOCKET, server: true } })
          const who = await onSocket(s)
          row.push(`${DOMAIN}: ${await domainAnswers(l, s, who)} (${who})`)
          for (const host of sites) expect((await fromClient(l, s, host, '/', true)).body).toContain(`site ${host[0]}`)
          row.push(`their sites answered all along (${seen.length} fetches)`)
          const undo = await onTty(s, `sh ${SCRIPT} --undo`, { answers: ANSWERS, timeoutMs: 20 * MIN })
          expect(undo.code, undo.stdout.slice(-3000)).toBe(0)
          for (const host of sites) expect((await fromClient(l, s, host, '/', true)).code).toBe('200')
          expect((await s.sh("grep -c 'agent-board' '/srv/my web/Caddyfile'", { check: false })).stdout.trim()).toBe(
            '0',
          )
          row.push('Undo: their Caddyfile as it was, their sites answering')
        } finally {
          rows.push(row.join(' · '))
          await s.stop()
        }
      },
      150 * MIN,
    )
  }
})
