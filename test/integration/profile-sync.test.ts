// The profile sync end to end (the board-on-own-server spec's "Next step: syncing the Claude
// profiles"), off unless BOARD_SERVER_IT=1: a Debian 13 test server of the server setup's harness
// (server/harness.ts) with the board installed by path A from this working copy, as the install
// lane does it (server-install.test.ts); this test as the local board, its Claude profiles a
// fixture pair in a home of its own (a fake credentials file, an OAuth part, an MCP header token,
// a Windows hook, a project whose git remote the server has a clone of), syncing over the admin's
// password login with sudo's password, as the panel does (services/profile-sync.ts).
//
// This PC to the server: the secrets absent there, the paths moved, the work profile made with
// the board's hooks, every file the sync wrote the board's user's. A change on the server back to
// this PC: it arrives, the server's own secrets never do. A conflict, the target's kept; a
// deletion, applied only when ticked. And the server board's install bound the board's key in
// herdr. Then three projects under one root with no clone there: the rule suggested and used,
// each landing under /home/agent/migo (folder names and cwd), the picker's listing and New
// folder as the board's user, and a session there back under this PC's own path.
//
//   BOARD_SERVER_IT=1 bun test test/integration/profile-sync.test.ts --timeout 7200000
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from '../../src/adapters/paths.ts'
import { spawnRemoteStream, sshVersion } from '../../src/adapters/ssh.ts'
import { projectFolder } from '../../src/core/profile-sync/paths.ts'
import type { SyncView } from '../../src/core/profile-sync/view.ts'
import type { Config } from '../../src/core/types.ts'
import { createProfileSync, type ProfileSync } from '../../src/services/profile-sync.ts'
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
if (ON && !DOCKER) console.warn('profile-sync: BOARD_SERVER_IT=1, but Docker does not answer: skipped')

const MIN = 60_000
const DISTRO: Distro = 'debian13'
const DOMAIN = 'workbench.example.com'
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const KEYGEN = process.platform === 'win32' ? join(SYSTEM32, 'OpenSSH', 'ssh-keygen.exe') : 'ssh-keygen'
const SSH = process.platform === 'win32' ? join(SYSTEM32, 'OpenSSH', 'ssh.exe') : 'ssh'
const REPO = 'file:///opt/board.git'
const REF = 'lane'
const SCRIPT = '/root/server-install.sh'
const HOME = '/home/agent'
const TRIES = process.env.BOARD_INSTALL_TRIES ?? '30'
const ENV = `BOARD_SETUP_ACME_CA=${PEBBLE_DIR} BOARD_SETUP_ACME_CA_ROOT=${PEBBLE_ROOT_ON_SERVER} BOARD_INSTALL_TRIES=${TRIES}`
const ANSWERS = [
  { name: 'packages', prompt: /Install them\? \[y\/N\] $/, answer: 'y' },
  { name: 'go', prompt: /Go ahead\? \[y\/N\] $/, answer: 'y' },
]
const REMOTE = 'https://github.com/example/proj.git'
const GH = `ghp_${'a1B2'.repeat(9)}`
const MCP_TOKEN = `Bearer ${'m'.repeat(32)}`
const rows: string[] = []
let lane: Lane | null = null
let adminKey = ''
let repo = ''

/** git on this checkout, its index the lane's own when `index` is given (as the install lane's). */
function git(args: string[], index?: string, cwd = ROOT): string {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], {
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

const asAgent = (s: TestServer, script: string, check = true) =>
  s.sh(
    `runuser -u agent -- env -i HOME=${HOME} USER=agent PATH=${HOME}/.local/bin:${HOME}/.bun/bin:/usr/bin:/bin XDG_RUNTIME_DIR=/run/user/$(id -u agent) sh -c ${JSON.stringify(script)}`,
    { check, timeoutMs: 10 * MIN },
  )

const put = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const read = (path: string): string => readFileSync(path, 'utf8')

/** This PC's profiles, a fixture pair in a home of the lane's own. */
function pcHome(): { home: string; project: string } {
  const home = join(work(), 'pc-home')
  rmSync(home, { recursive: true, force: true })
  const project = join(home, 'code', 'proj')
  mkdirSync(project, { recursive: true })
  git(['init', '-q'], undefined, project)
  git(['remote', 'add', 'origin', REMOTE], undefined, project)
  put(
    join(home, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'pc@example.com', accountUuid: 'pc-account' },
      userID: 'pc-user-id',
      theme: 'dark',
      mcpServers: {
        remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: MCP_TOKEN } },
        local: { command: 'C:\\tools\\mcp.exe', args: [] },
      },
      projects: { [project]: { allowedTools: ['Bash(git:*)'], hasTrustDialogAccepted: true } },
    }),
  )
  put(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"pc-credential-secret"}}')
  put(
    join(home, '.claude', 'settings.json'),
    JSON.stringify({
      env: { GITHUB_TOKEN: 'pc-env-token', DISABLE_TELEMETRY: '1' },
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'powershell -NoProfile -File C:\\Users\\me\\beep.ps1' }] },
          { hooks: [{ type: 'command', command: 'echo stopped' }] },
        ],
      },
    }),
  )
  put(join(home, '.claude', 'CLAUDE.md'), '# from the pc\n')
  put(join(home, '.claude', 'agents', 'old.md'), 'an old agent\n')
  put(join(home, '.claude', 'skills', 'lane', 'SKILL.md'), '---\nname: lane\n---\nA skill.\n')
  const folder = join(home, '.claude', 'projects', projectFolder(project))
  put(join(folder, 's1.jsonl'), `${JSON.stringify({ type: 'user', cwd: project, message: `my token ${GH}` })}\n`)
  put(join(folder, 'memory', 'MEMORY.md'), '- a memory of the project\n')
  put(
    join(home, '.claude', 'history.jsonl'),
    `${JSON.stringify({ display: 'hello', timestamp: 1, project })}\n${JSON.stringify({ display: 'elsewhere', timestamp: 2, project: 'C:\\elsewhere' })}\n`,
  )
  put(join(home, '.claude-work', 'settings.json'), '{"model":"opus"}')
  put(join(home, '.claude-work', 'CLAUDE.md'), '# work\n')
  return { home, project }
}

/** Look, then Apply with these choices, to its end; the view at the end, with the preview Apply had. */
async function synced(
  sync: ProfileSync,
  direction: 'up' | 'down',
  choices: { conflicts?: Record<string, string>; deletions?: string[]; allow?: Record<string, boolean> } = {},
): Promise<SyncView> {
  const pw = { password: 'admin-pw' }
  const looked = await sync.look({ direction, ...pw })
  expect(looked.status, JSON.stringify(looked.body)).toBe(200)
  const preview = sync.view()?.preview
  if (!preview) throw new Error('no preview')
  // every group ticked, session history too, unless the test says: the lane goes the whole way
  const allow = { env: true, hooks: true, statusLine: true, mcp: true, helpers: true, history: true }
  const applied = await sync.apply({ id: preview.id, conflicts: {}, deletions: [], allow, ...choices, ...pw })
  expect(applied.status, JSON.stringify(applied.body)).toBe(200)
  await until(
    `the ${direction} sync ends`,
    async () => sync.view()?.phase === 'done' || sync.view()?.phase === 'failed',
    20 * MIN,
    250,
  )
  const v = sync.view() as SyncView
  expect(v.phase, v.error ?? '').toBe('done')
  return { ...v, preview }
}

describe.skipIf(!DOCKER)('the profiles synced with the board on the server (Debian 13)', () => {
  beforeAll(async () => {
    console.log(`profile-sync: the run's log is ${join(work(), 'run.log')}`)
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
    console.log(`profile-sync results:\n${rows.join('\n')}`)
    await removeRun()
  }, 20 * MIN)

  test(
    'this PC to the server and back: secrets stay, paths move, a profile made, a conflict and a deletion',
    async () => {
      const l = lane as Lane
      const s = await startServer(l, { tag: 'sync', withDocker: true, adminKey, password: 'admin-pw' })
      const row = [`${DISTRO} profile sync`]
      const savedState = process.env.LOCALAPPDATA
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
        row.push('installed')
        // the board's key in herdr: bound by the install, none was
        const herdrConfig = await asAgent(s, `cat ${HOME}/.config/herdr/config.toml`)
        expect(herdrConfig.stdout).toContain('command = "agent-board.open"')
        expect(herdrConfig.stdout).toContain('key = "prefix+a"')
        row.push("herdr's key bound")

        // the server's own: its sign-in and secrets, and the project's clone
        await asAgent(
          s,
          [
            `mkdir -p ${HOME}/work/proj && cd ${HOME}/work/proj && git init -q && git remote add origin git@github.com:example/proj.git`,
            `mkdir -p ${HOME}/.claude && printf '%s' '{"claudeAiOauth":{"accessToken":"srv-credential-secret"}}' > ${HOME}/.claude/.credentials.json`,
            `printf '%s' '{"oauthAccount":{"emailAddress":"srv@example.com"},"userID":"srv-user-id"}' > ${HOME}/.claude.json`,
          ].join(' && '),
        )
        const serverSettings = JSON.parse((await asAgent(s, `cat ${HOME}/.claude/settings.json`)).stdout)
        expect(JSON.stringify(serverSettings.hooks)).toContain('agent-board')

        // this PC: the fixture pair, the board's state of the lane's own, the server's key pinned
        const { home, project } = pcHome()
        process.env.LOCALAPPDATA = join(work(), 'pc-state')
        const knownHosts = join(work(), 'sync_known_hosts')
        // the server's key as its own file has it (this PC's ssh-keyscan may not speak the server's
        // key exchange), pinned as the server setup's Look pins it
        const hostKey = (await s.sh('cat /etc/ssh/ssh_host_ed25519_key.pub')).stdout.trim().split(/\s+/)
        writeFileSync(knownHosts, `[127.0.0.1]:${s.sshPort} ${hostKey[0]} ${hostKey[1]}\n`)
        const sync = createProfileSync({
          cfg: { tunnel: { host: '127.0.0.1', sshPort: s.sshPort, admin: { user: 'admin' } } } as unknown as Config,
          home,
          platform: process.platform,
          name: 'lane-pc',
          ssh: () => SSH,
          sshVersion,
          knownHosts: () => knownHosts,
          hostKeyPinned: async () => existsSync(knownHosts) && read(knownHosts).includes('ssh-ed25519'),
          spawn: spawnRemoteStream,
          onChange: () => {},
          log: line => note(`board: ${line}`),
          newId: () => `sync-${Math.random().toString(16).slice(2, 8)}`,
          now: () => Date.now(),
        })

        // ---- this PC to the server
        const up = await synced(sync, 'up')
        const p = up.preview
        expect(p?.pairs.map(x => [x.from, x.to])).toEqual([[project, `${HOME}/work/proj`]])
        expect(p?.profiles.find(x => x.name === 'work')?.create).toBe(true)
        const held = p?.held.map(h => h.what) ?? []
        for (const what of ['.credentials.json', 'env GITHUB_TOKEN', 'oauthAccount', 'MCP remote: headers'])
          expect(held).toContain(what)
        expect(held).toContain(`projects/${projectFolder(project)}/s1.jsonl: GitHub token`)
        const cantGo = p?.cantGo.map(c => c.what) ?? []
        expect(cantGo).toContain('hook Stop: powershell -NoProfile -File C:\\Users\\me\\beep.ps1')
        expect(cantGo).toContain('MCP local: C:\\tools\\mcp.exe')
        expect(up.result?.created).toEqual(['work'])
        row.push(`up: ${up.result?.files} files, held back ${held.length}, can't go ${cantGo.length}`)
        // no secret of this PC's on the server; the server's own as they were
        const secrets = await s.sh(
          `grep -rl -e pc-credential-secret -e pc-env-token -e ${GH} -e "${MCP_TOKEN}" -e pc-account ${HOME}/.claude ${HOME}/.claude-work ${HOME}/.claude.json`,
          { check: false },
        )
        expect(secrets.stdout.trim()).toBe('')
        expect((await s.sh(`cat ${HOME}/.claude/.credentials.json`)).stdout).toContain('srv-credential-secret')
        const cj = JSON.parse((await s.sh(`cat ${HOME}/.claude.json`)).stdout)
        expect(cj.oauthAccount).toEqual({ emailAddress: 'srv@example.com' })
        expect(cj.userID).toBe('srv-user-id')
        expect(cj.theme).toBe('dark')
        expect(Object.keys(cj.projects)).toEqual([`${HOME}/work/proj`])
        expect(cj.mcpServers).toEqual({ remote: { type: 'http', url: 'https://mcp.example.com/mcp' } })
        const st = JSON.parse((await s.sh(`cat ${HOME}/.claude/settings.json`)).stdout)
        expect(st.env).toEqual({ DISABLE_TELEMETRY: '1' })
        expect(JSON.stringify(st.hooks)).toContain('agent-board')
        expect(JSON.stringify(st.hooks)).toContain('echo stopped')
        expect(JSON.stringify(st.hooks)).not.toContain('beep')
        // the transcript in the clone's folder, its cwd the clone's; the history's line moved, the other left out
        const folder = `${HOME}/.claude/projects/${projectFolder(`${HOME}/work/proj`)}`
        const line = JSON.parse((await s.sh(`cat ${folder}/s1.jsonl`)).stdout)
        expect(line.cwd).toBe(`${HOME}/work/proj`)
        expect((await s.sh(`cat ${folder}/memory/MEMORY.md`)).stdout).toBe('- a memory of the project\n')
        const history = (await s.sh(`cat ${HOME}/.claude/history.jsonl`)).stdout.trim().split('\n')
        expect(history.map(h => JSON.parse(h).project)).toEqual([`${HOME}/work/proj`])
        // the work profile made, with the board's hooks; every file of the sync the board's user's
        expect((await s.sh(`cat ${HOME}/.claude-work/CLAUDE.md`)).stdout).toBe('# work\n')
        expect(up.result?.install).toBe(true)
        expect((await s.sh(`cat ${HOME}/.claude-work/settings.json`)).stdout).toContain('agent-board')
        expect(
          (await s.sh(`find ${HOME}/.claude ${HOME}/.claude-work ${HOME}/.claude.json ! -user agent`)).stdout.trim(),
        ).toBe('')
        row.push('secrets stayed, paths moved, work made with its hooks, all the user’s')

        // ---- the server back to this PC: its change arrives, its own secrets never do
        await asAgent(
          s,
          `printf '# changed on the server\\n' > ${HOME}/.claude/CLAUDE.md && printf '%s\\n' '{"type":"user","cwd":"${HOME}/work/proj","message":"on the server"}' > ${folder}/s2.jsonl`,
        )
        const down = await synced(sync, 'down')
        expect(down.preview?.items.map(i => [i.from, i.kind])).toEqual(
          expect.arrayContaining([
            ['CLAUDE.md', 'change'],
            [`projects/${projectFolder(`${HOME}/work/proj`)}/s2.jsonl`, 'add'],
          ]),
        )
        expect(read(join(home, '.claude', 'CLAUDE.md'))).toBe('# changed on the server\n')
        const back = JSON.parse(read(join(home, '.claude', 'projects', projectFolder(project), 's2.jsonl')))
        expect(back.cwd).toBe(project)
        expect(read(join(home, '.claude', '.credentials.json'))).toContain('pc-credential-secret')
        const pcCj = JSON.parse(read(join(home, '.claude.json')))
        expect(pcCj.oauthAccount).toEqual({ emailAddress: 'pc@example.com', accountUuid: 'pc-account' })
        expect(pcCj.mcpServers.remote.headers).toEqual({ Authorization: MCP_TOKEN })
        const pcText = [
          read(join(home, '.claude.json')),
          read(join(home, '.claude', 'settings.json')),
          read(join(home, '.claude', 'CLAUDE.md')),
        ].join('\n')
        expect(pcText).not.toContain('srv-credential-secret')
        expect(pcText).not.toContain('srv@example.com')
        expect(pcText).not.toContain('/home/agent/agent-board')
        row.push('down: the change arrived, the server’s secrets and hooks stayed there')

        // ---- a conflict: the target's kept by default, the source's when taken
        put(join(home, '.claude', 'CLAUDE.md'), '# the pc again\n')
        await asAgent(s, `printf '# the server again\\n' > ${HOME}/.claude/CLAUDE.md`)
        const kept = await synced(sync, 'up')
        expect(kept.preview?.conflicts.map(c => c.key)).toEqual(['default:CLAUDE.md'])
        expect((await s.sh(`cat ${HOME}/.claude/CLAUDE.md`)).stdout).toBe('# the server again\n')
        await synced(sync, 'up', { conflicts: { 'default:CLAUDE.md': 'source' } })
        expect((await s.sh(`cat ${HOME}/.claude/CLAUDE.md`)).stdout).toBe('# the pc again\n')
        row.push('conflict: the target’s kept, then the source’s taken')

        // ---- a deletion: shown, applied only when ticked
        rmSync(join(home, '.claude', 'agents', 'old.md'))
        const left = await synced(sync, 'up')
        expect(left.preview?.deletions.map(d => d.key)).toEqual(['default:agents/old.md'])
        expect((await s.sh(`test -e ${HOME}/.claude/agents/old.md`, { check: false })).code).toBe(0)
        await synced(sync, 'up', { deletions: ['default:agents/old.md'] })
        expect((await s.sh(`test -e ${HOME}/.claude/agents/old.md`, { check: false })).code).not.toBe(0)
        row.push('deletion: kept unticked, gone ticked')

        // ---- projects under one root with no clone on the server: the rule suggested, used, both ways
        const migo = join(home, 'migo')
        const projects = [join(migo, 'dev'), join(migo, 'dev', 'x y'), join(migo, 'notes')]
        const onServer = (p: string): string => `${HOME}/migo/${p.slice(migo.length + 1).replace(/\\/g, '/')}`
        for (const [i, p] of projects.entries()) {
          mkdirSync(p, { recursive: true })
          const f = join(home, '.claude', 'projects', projectFolder(p))
          put(join(f, `r${i}.jsonl`), `${JSON.stringify({ type: 'user', cwd: p, message: `project ${i}` })}\n`)
          put(join(f, 'memory', 'MEMORY.md'), `- memory ${i}\n`)
        }
        const pw = { password: 'admin-pw' }
        expect((await sync.look({ direction: 'up', ...pw })).status).toBe(200)
        const before = sync.view()?.preview
        expect(before?.unpaired.map(u => u.path).sort()).toEqual([...projects].sort())
        const rule = { pc: migo, server: `${HOME}/migo` }
        expect(before?.suggested).toEqual([{ rule, projects: 3 }])
        // the picker on the server: its home listed and a folder made, both as the board's user
        const listed = await sync.dirs(pw)
        expect(listed.status, JSON.stringify(listed.body)).toBe(200)
        expect((listed.body as { path: string; entries: string[] }).path).toBe(HOME)
        expect((listed.body as { entries: string[] }).entries).toContain('.claude')
        expect((await sync.mkdir({ path: HOME, name: 'migo', ...pw })).status).toBe(200)
        expect((await s.sh(`stat -c %U ${HOME}/migo`)).stdout.trim()).toBe('agent')
        // the rule used: every project placed by it, its folder there not yet
        expect(sync.rules({ rules: [rule], ...pw }).status).toBe(200)
        const ruled = sync.view()?.preview
        expect(ruled?.pairs.filter(x => x.how === 'rule').map(x => [x.from, x.to])).toEqual(
          projects.map(p => [p, onServer(p)]),
        )
        await until(
          'the folders there asked',
          async () => projects.every(p => onServer(p) in (sync.view()?.preview?.there ?? {})),
          2 * MIN,
          250,
        )
        expect(projects.map(p => sync.view()?.preview?.there[onServer(p)])).toEqual([false, false, false])
        const id = sync.view()?.preview?.id
        const allow = { env: true, hooks: true, statusLine: true, mcp: true, helpers: true, history: true }
        expect((await sync.apply({ id, conflicts: {}, deletions: [], allow, ...pw })).status).toBe(200)
        await until(
          'the rule’s sync ends',
          async () => ['done', 'failed'].includes(sync.view()?.phase ?? ''),
          20 * MIN,
          250,
        )
        expect(sync.view()?.phase, sync.view()?.error ?? '').toBe('done')
        for (const [i, p] of projects.entries()) {
          const f = `${HOME}/.claude/projects/${projectFolder(onServer(p))}`
          expect(JSON.parse((await s.sh(`cat '${f}/r${i}.jsonl'`)).stdout).cwd).toBe(onServer(p))
          expect((await s.sh(`cat '${f}/memory/MEMORY.md'`)).stdout).toBe(`- memory ${i}\n`)
        }
        expect(projectFolder(onServer(projects[1] as string))).toBe('-home-agent-migo-dev-x-y')
        row.push('rule: suggested, used, 3 projects under /home/agent/migo')

        // ---- and back: a session on the server under the rule's folder, on this PC under its own
        const dev = projects[0] as string
        await asAgent(
          s,
          `printf '%s\\n' '{"type":"user","cwd":"${onServer(dev)}","message":"on the server"}' > ${HOME}/.claude/projects/${projectFolder(onServer(dev))}/srv.jsonl`,
        )
        const ruledDown = await synced(sync, 'down')
        expect(ruledDown.preview?.pairs.find(x => x.from === onServer(dev))).toMatchObject({ to: dev, how: 'rule' })
        expect(JSON.parse(read(join(home, '.claude', 'projects', projectFolder(dev), 'srv.jsonl'))).cwd).toBe(dev)
        row.push('back: the server’s session under the PC’s own path')
      } finally {
        if (savedState === undefined) delete process.env.LOCALAPPDATA
        else process.env.LOCALAPPDATA = savedState
        rows.push(row.join(' · '))
        await s.stop()
      }
    },
    150 * MIN,
  )
})
