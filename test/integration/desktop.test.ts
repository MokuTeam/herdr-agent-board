// Each agent's own browser on the board's server, end to end (the board-on-own-server spec's
// "Later: each agent's own browser"), off unless BOARD_SERVER_IT=1: a Debian 13 test server of the
// server setup's harness (server/harness.ts) with the board installed by path A from this working
// copy, as the install lane does it (server-install.test.ts), Xvnc, Chrome and the fonts with it.
//
// A session in herdr (a pane herdr is told runs Claude), the board's MCP wrapper run in it as
// Claude runs it: its first tool call starts the session's desktop, a page opened and a screenshot
// taken by a headed Chrome; the card says it runs; its VNC through the domain answers RFB's
// greeting with a login and is refused without one, and listens on no TCP port; control to the
// owner holds a tool call, back to the agent lets it go; the session ended, the desktop stops.
//
//   BOARD_SERVER_IT=1 bun test test/integration/desktop.test.ts --timeout 7200000
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../../src/adapters/paths.ts'
import { LOGIN_COOKIE } from '../../src/core/access.ts'
import { BROWSER_MCP, DEVTOOLS_MCP_VERSION } from '../../src/core/desktop.ts'
import { BOARD_SOCKET } from '../../src/core/server-install.ts'
import { SECRET_B32, seededLogin, USER_ID } from '../support/tunnel-board.ts'
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
if (ON && !DOCKER) console.warn('desktop: BOARD_SERVER_IT=1, but Docker does not answer: skipped')

const MIN = 60_000
const DISTRO: Distro = 'debian13'
const DOMAIN = 'workbench.example.com'
const ORIGIN = `https://${DOMAIN}`
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const KEYGEN = process.platform === 'win32' ? join(SYSTEM32, 'OpenSSH', 'ssh-keygen.exe') : 'ssh-keygen'
const REPO = 'file:///opt/board.git'
const REF = 'lane'
const SCRIPT = '/root/server-install.sh'
const HOME = '/home/agent'
const STATE = `${HOME}/.local/state/herdr/plugins/agent-board`
const TRIES = process.env.BOARD_INSTALL_TRIES ?? '30'
const ENV = `BOARD_SETUP_ACME_CA=${PEBBLE_DIR} BOARD_SETUP_ACME_CA_ROOT=${PEBBLE_ROOT_ON_SERVER} BOARD_INSTALL_TRIES=${TRIES}`
const ANSWERS = [
  { name: 'packages', prompt: /Install them\? \[y\/N\] $/, answer: 'y' },
  { name: 'go', prompt: /Go ahead\? \[y\/N\] $/, answer: 'y' },
]
const TOKEN = 'L'.repeat(43)
const COOKIE = `${LOGIN_COOKIE}=${TOKEN}`
const rows: string[] = []
let lane: Lane | null = null
let adminKey = ''
let repo = ''

/** git on this checkout, its index the lane's own when `index` is given (as the install lane's). */
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

/** The working copy as a commit in a bare repository of the lane's, as the install lane makes it. */
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

/** The board's user's environment, as its services have it. */
const userEnv = (uid: string, more: string[] = []): string[] => [
  'env',
  '-i',
  `HOME=${HOME}`,
  'USER=agent',
  `PATH=${HOME}/.local/bin:${HOME}/.bun/bin:/usr/bin:/bin`,
  `XDG_RUNTIME_DIR=/run/user/${uid}`,
  'LANG=C.UTF-8',
  ...more,
]

const asAgent = (s: TestServer, script: string, check = true) =>
  s.sh(
    `runuser -u agent -- env -i HOME=${HOME} USER=agent PATH=${HOME}/.local/bin:${HOME}/.bun/bin:/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/$(id -u agent) sh -c ${JSON.stringify(script)}`,
    { check, timeoutMs: 10 * MIN },
  )

/** A file of the board's user's, written by that user (its text on stdin), 0600. */
const putAsAgent = (s: TestServer, path: string, text: string) =>
  s.exec(['runuser', '-u', 'agent', '--', 'sh', '-c', `umask 077 && mkdir -p "$(dirname "$0")" && cat > "$0"`, path], {
    stdin: text,
  })

/** https://<domain><path> from the client, Pebble's certificate checked, with the login: status and body. */
async function viaDomain(
  l: Lane,
  s: TestServer,
  path: string,
  o: { post?: unknown; cookie?: boolean } = {},
): Promise<{ code: string; body: string }> {
  const post =
    o.post === undefined
      ? ''
      : `-X POST -H 'content-type: application/json' -H 'x-board: 1' -H 'origin: ${ORIGIN}' --data-raw '${JSON.stringify(o.post)}'`
  const r = await l.client(
    `curl -sS -m 30 --cacert /root.pem --resolve ${DOMAIN}:443:${s.ip} ${o.cookie === false ? '' : `-H 'cookie: ${COOKIE}'`} ${post} -w '\\n%{http_code}' 'https://${DOMAIN}${path}'`,
    { check: false },
  )
  const lines = r.stdout.trimEnd().split('\n')
  return { code: lines.at(-1) ?? '', body: lines.slice(0, -1).join('\n') }
}

/** A WebSocket handshake to `path` through the domain from the client (openssl): what came back in a few seconds, printable. */
async function wsVia(l: Lane, s: TestServer, path: string, cookie: boolean): Promise<string> {
  // printf's format: CR LF as escapes (the client's script loses a raw CR), a % doubled
  const request = [
    `GET ${path} HTTP/1.1`,
    `Host: ${DOMAIN}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    `Origin: ${ORIGIN}`,
    ...(cookie ? [`Cookie: ${COOKIE}`] : []),
    '',
    '',
  ]
    .join('\\r\\n')
    .replaceAll('%', '%%')
  const r = await l.client(
    `(printf '${request}'; sleep 4) | timeout 10 openssl s_client -quiet -connect ${s.ip}:443 -servername ${DOMAIN} -CAfile /root.pem 2>/dev/null | head -c 2000 | tr -c '[:print:]\n' '.'`,
    { check: false, timeoutMs: 60_000 },
  )
  note(`ws ${cookie ? 'with' : 'without'} a login: ${r.stdout.slice(0, 600)}`)
  return r.stdout
}

/** The MCP wrapper as Claude runs it in the session's pane: requests in, answers by id. */
function wrapper(s: TestServer, uid: string, pane: string) {
  const proc = Bun.spawn(
    [
      'docker',
      'exec',
      '-i',
      s.name,
      'runuser',
      '-u',
      'agent',
      '--',
      ...userEnv(uid, [`HERDR_PANE_ID=${pane}`, 'BOARD_BROWSER_HOLD_MS=600000']),
      `${HOME}/.local/bin/board`,
      'browser-mcp',
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true },
  )
  const answers = new Map<number, Record<string, unknown>>()
  let err = ''
  void (async () => {
    const decoder = new TextDecoder()
    let rest = ''
    for await (const chunk of proc.stdout) {
      const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        try {
          const m = JSON.parse(line) as Record<string, unknown>
          if (typeof m.id === 'number') answers.set(m.id, m)
        } catch {
          note(`wrapper said: ${line.slice(0, 300)}`)
        }
      }
    }
  })()
  void (async () => {
    for await (const chunk of proc.stderr) err += new TextDecoder().decode(chunk)
  })()
  let id = 0
  const send = (method: string, params: unknown = {}, notification = false): number => {
    const n = notification ? 0 : ++id
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: n }), method, params })}\n`)
    proc.stdin.flush()
    return n
  }
  const answer = async (n: number, ms: number): Promise<Record<string, unknown>> => {
    await until(`the wrapper's answer ${n} (${err.slice(-500)})`, async () => answers.has(n), ms, 250)
    return answers.get(n) as Record<string, unknown>
  }
  const call = async (name: string, args: Record<string, unknown> = {}, ms = 2 * MIN) => {
    const r = await answer(send('tools/call', { name, arguments: args }), ms)
    return r.result as {
      content: { type: string; text?: string; data?: string; mimeType?: string }[]
      isError?: boolean
    }
  }
  return {
    send,
    answer,
    call,
    has: (n: number) => answers.has(n),
    stderr: () => err,
    async close() {
      proc.stdin.end()
      await Promise.race([proc.exited, Bun.sleep(10_000)])
      proc.kill()
    },
  }
}

/** The pixel size of a PNG (its IHDR), or null when it is none. */
function pngSize(data: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!sig.every((b, i) => data[i] === b)) return null
  const v = new DataView(data.buffer, data.byteOffset)
  return { width: v.getUint32(16), height: v.getUint32(20) }
}

describe.skipIf(!DOCKER)('each agent’s own browser on the board’s server (Debian 13)', () => {
  beforeAll(async () => {
    console.log(`desktop: the run's log is ${join(work(), 'run.log')}`)
    if (!(await dockerUp())) throw new Error('Docker does not answer: start Docker Desktop')
    await removeStale()
    adminKey = join(work(), 'admin_ed25519')
    await run([KEYGEN, '-q', '-t', 'ed25519', '-N', '', '-C', 'agent-board-it', '-f', adminKey])
    repo = laneRepo()
    await startMirror()
    await buildImage(DISTRO, true)
    lane = await startLane(DISTRO)
  }, 60 * MIN)

  afterAll(async () => {
    if (lane) closeLane(lane)
    console.log(`desktop results:\n${rows.join('\n')}`)
    if (process.env.BOARD_IT_LEAVE !== '1') await removeRun()
  }, 20 * MIN)

  test(
    'a session’s desktop through the MCP wrapper, watched over VNC through the domain, held for the owner, stopped at its end',
    async () => {
      const l = lane as Lane
      const s = await startServer(l, { tag: 'desktop', withDocker: true, adminKey, password: 'admin-pw' })
      const row = [`${DISTRO} desktop`]
      try {
        // the board on the server, by path A from this working copy (the install lane's way)
        await docker(['cp', repo, `${s.name}:/opt/board.git`])
        await s.sh(
          "chmod -R a+rX /opt/board.git && chown -R root:root /opt/board.git && printf '[safe]\\n\\tdirectory = /opt/board.git\\n' > /etc/gitconfig",
        )
        await s.exec(['sh', '-c', `cat > ${SCRIPT}`], {
          stdin: noCr(readFileSync(join(ROOT, 'server-install.sh'), 'utf8')),
        })
        await l.addA(DOMAIN, s.ip)
        const installed = await onTty(s, `env ${ENV} sh ${SCRIPT} --domain ${DOMAIN} --repo ${REPO} --ref ${REF}`, {
          answers: ANSWERS,
          timeoutMs: 90 * MIN,
        })
        expect(installed.code, installed.stdout.slice(-3000)).toBe(0)
        expect(installed.stdout).toContain('Install what the agents’ own browsers need')
        expect(installed.stdout).toMatch(/- the agents’ browsers: tigervnc-standalone-server, .*google-chrome-stable/)
        const record = JSON.parse((await s.sh('cat /etc/agent-board-server/install.json')).stdout)
        expect(record.desktop).toEqual(expect.arrayContaining(['tigervnc-standalone-server', 'google-chrome-stable']))
        row.push('installed with Xvnc, Chrome and the fonts')

        // the pieces, as doctor sees them; the MCP server in the profile
        const doctor = (await asAgent(s, 'board doctor', false)).stdout
        for (const line of [
          'ok The agents’ browsers: Xvnc (TigerVNC)',
          'ok The agents’ browsers: the browser',
          'ok The agents’ browsers: Noto fonts',
          `ok The agents’ browsers: chrome-devtools-mcp ${DEVTOOLS_MCP_VERSION}`,
          `ok The agents’ browsers: the MCP server ${BROWSER_MCP} in every profile`,
        ])
          expect(doctor, doctor).toContain(line)
        const cj = JSON.parse((await asAgent(s, `cat ${HOME}/.claude.json`)).stdout)
        expect(cj.mcpServers[BROWSER_MCP]).toEqual({
          type: 'stdio',
          command: `${HOME}/.local/bin/board`,
          args: ['browser-mcp'],
          env: {},
        })
        row.push('doctor: all there; the MCP server in the profile')

        // the board up, its login seeded (the setup's own lane has the link)
        await until(
          'the board’s socket',
          async () => (await s.sh(`test -S ${BOARD_SOCKET}`, { check: false })).code === 0,
          3 * MIN,
          1000,
        )
        await putAsAgent(
          s,
          `${STATE}/access.json`,
          JSON.stringify({
            passwordHash: await Bun.password.hash('correct horse battery', { algorithm: 'argon2id' }),
            totp: { secret: SECRET_B32, lastStep: 0 },
            userId: USER_ID,
            lockout: { failures: 0, until: null },
          }),
        )
        await putAsAgent(s, `${STATE}/access-logins.json`, JSON.stringify([seededLogin({ token: TOKEN })]))

        // a session: a herdr pane herdr is told runs Claude
        const uid = (await s.sh('id -u agent')).stdout.trim()
        const panes = async (): Promise<string[]> => {
          const out = (await asAgent(s, 'herdr pane list', false)).stdout
          try {
            return (JSON.parse(out).result.panes as { pane_id: string }[]).map(p => p.pane_id)
          } catch {
            return []
          }
        }
        await until('herdr answers', async () => (await panes()).length > 0, 3 * MIN, 1000)
        const before = await panes()
        await asAgent(s, 'herdr tab create')
        const pane = (await panes()).find(p => !before.includes(p)) as string
        expect(pane).toBeTruthy()
        await asAgent(s, `herdr pane report-agent --source lane --agent claude --state idle ${pane}`)
        const key = `pane-${pane}`
        const board = async (): Promise<{ fsToken: string; items: { key: string; desktop?: unknown }[] }> => {
          const r = await viaDomain(l, s, '/api/board')
          return r.code === '200' ? JSON.parse(r.body) : { fsToken: '', items: [] }
        }
        await until(
          `the session's card (${key})`,
          async () => (await board()).items.some(i => i.key === key),
          3 * MIN,
          1000,
        )
        expect((await board()).items.find(i => i.key === key)?.desktop).toBeUndefined()
        row.push(`a session in ${pane}: no desktop before its first browser call`)

        // the wrapper, as Claude runs it in that pane: its tools, then the first call starts the desktop
        const w = wrapper(s, uid, pane)
        try {
          await w.answer(
            w.send('initialize', {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'lane', version: '1' },
            }),
            2 * MIN,
          )
          w.send('notifications/initialized', {}, true)
          const list = await w.answer(w.send('tools/list'), MIN)
          const names = ((list.result as { tools: { name: string }[] }).tools ?? []).map(t => t.name)
          for (const n of ['navigate_page', 'take_screenshot', 'browser_profile', 'browser_ask_owner'])
            expect(names).toContain(n)
          expect((await s.sh('pgrep -u agent -x Xvnc', { check: false })).stdout.trim()).toBe('')
          const page =
            'data:text/html,<body style="margin:0;background:%23e33"><h1 style="font:64px sans-serif">Привет 👋 lane</h1></body>'
          const nav = await w.call('navigate_page', { type: 'url', url: page }, 3 * MIN)
          expect(nav.isError, JSON.stringify(nav).slice(0, 800) + w.stderr().slice(-800)).toBeFalsy()
          const ua = await w.call('evaluate_script', { function: '() => navigator.userAgent' })
          const uaText = ua.content.map(c => c.text ?? '').join(' ')
          expect(uaText).toContain('Chrome/')
          expect(uaText).not.toContain('HeadlessChrome')
          const shot = await w.call('take_screenshot', {})
          const image = shot.content.find(c => c.type === 'image')
          expect(image?.mimeType).toBe('image/png')
          const png = Buffer.from(image?.data ?? '', 'base64')
          const size = pngSize(png)
          expect(size?.width).toBeGreaterThan(800)
          expect(png.length).toBeGreaterThan(5000)
          const procs = (await s.sh('ps -u agent -o args=', { check: false })).stdout
          expect(procs).toMatch(/Xvnc :100 .*-rfbunixpath \S+vnc\.sock/)
          expect(procs).toContain('--remote-debugging-port=9300')
          expect(procs).not.toContain('--headless')
          row.push(
            `navigate + screenshot through the wrapper: a ${size?.width}×${size?.height} PNG, headed Chrome on :100`,
          )

          // the card says so; VNC on no TCP port
          await until(
            'the card’s desktop',
            async () => {
              const d = (await board()).items.find(i => i.key === key)?.desktop
              return (
                JSON.stringify(d) === JSON.stringify({ running: true, profile: null, control: 'agent', asks: false })
              )
            },
            MIN,
            1000,
          )
          const tcp = (await s.sh('ss -ltnp', { check: false })).stdout
          expect(tcp).not.toContain('Xvnc')
          row.push('the card: running, the agent has it; Xvnc on no TCP port')

          // VNC through the domain: RFB's greeting with the login, nothing without
          const token = (await board()).fsToken
          const path = `/api/desktop/${encodeURIComponent(key)}/vnc?t=${token}`
          const ws = await wsVia(l, s, path, true)
          expect(ws).toContain('HTTP/1.1 101')
          expect(ws).toMatch(/RFB 003\.00\d/)
          const refused = await wsVia(l, s, path, false)
          expect(refused).toContain('HTTP/1.1 401')
          expect(refused).not.toContain('RFB')
          row.push('VNC through the domain: RFB greeting with a login, 401 without')

          // control to the owner holds a call; back to the agent lets it go
          const owner = await viaDomain(l, s, `/api/desktop/${encodeURIComponent(key)}/control`, {
            post: { to: 'owner' },
          })
          expect(owner.code).toBe('200')
          expect(JSON.parse(owner.body)).toEqual({ ok: true, control: 'owner' })
          const held = w.send('tools/call', { name: 'take_screenshot', arguments: {} })
          await Bun.sleep(6000)
          expect(w.has(held)).toBe(false)
          const back = await viaDomain(l, s, `/api/desktop/${encodeURIComponent(key)}/control`, {
            post: { to: 'agent' },
          })
          expect(JSON.parse(back.body)).toEqual({ ok: true, control: 'agent' })
          const released = await w.answer(held, MIN)
          expect((released.result as { isError?: boolean }).isError).toBeFalsy()
          row.push('control to the owner held a call 6 s; back to the agent let it go')
        } finally {
          await w.close()
        }

        // the session ends: its pane closes, the desktop stops (after its start's grace)
        await asAgent(s, `herdr pane close ${pane}`)
        await until(
          'the desktop stopped',
          async () =>
            (
              await s.sh('pgrep -u agent -x Xvnc; pgrep -u agent -f remote-debugging-port', { check: false })
            ).stdout.trim() === '',
          3 * MIN,
          2000,
        )
        expect((await s.sh(`ls ${STATE}/desktop/sessions`, { check: false })).stdout.trim()).toBe('')
        row.push('the session ended: Xvnc and Chrome stopped, its folder gone')
      } finally {
        rows.push(row.join(' · '))
        if (process.env.BOARD_IT_LEAVE !== '1') await s.stop()
      }
    },
    120 * MIN,
  )
})
