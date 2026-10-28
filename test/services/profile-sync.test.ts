// The profile sync from the local board's side (services/profile-sync.ts) against a server board's
// sync program run in this process (entrypoints/profile-sync.ts serve) on a home of its own: the
// admin's ssh is a stand-in that hands the program its stdin and stdout. Both directions, the
// secrets on each side, the paths, a profile made, a conflict and a deletion.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { RemoteEnd, RemoteStream } from '../../src/adapters/ssh.ts'
import { projectFolder } from '../../src/core/profile-sync/paths.ts'
import type { Config } from '../../src/core/types.ts'
import { serve } from '../../src/entrypoints/profile-sync.ts'
import { createProfileSync, type ProfileSync } from '../../src/services/profile-sync.ts'

const GH = `ghp_${'a1B2'.repeat(9)}`
const REMOTE = 'https://github.com/example/proj.git'
let root = ''
let pc = ''
let srv = ''
let pcProject = ''
let srvClone = ''
const saved = process.env.LOCALAPPDATA
let installs = 0
let noBoard = false
const scripts: string[] = []

const put = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}
const read = (path: string): string => readFileSync(path, 'utf8')
const json = (path: string): Record<string, unknown> => JSON.parse(read(path))
const git = (dir: string, ...args: string[]): void => {
  const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'ignore', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
}

/** The admin's ssh, standing in: the probe answers root; the sync's command runs its program here on the server's home. */
function spawn(_bin: string, args: string[]): RemoteStream {
  const command = args.at(-1) ?? ''
  const script = Buffer.from(/echo (\S+) \| base64 -d/.exec(command)?.[1] ?? '', 'base64').toString('utf8')
  scripts.push(script.split('\n')[0] ?? '')
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const errs: ((line: string) => void)[] = []
  let done: Promise<RemoteEnd>
  if (script.includes('# agent-board: probe')) {
    stdin.resume()
    stdout.end('@@uid 0\n@@sudo ok\n@@flavor Sudo version 1.9.16\n')
    done = Promise.resolve({ code: 0, error: null })
  } else if (noBoard) {
    stdin.resume()
    stdout.end()
    done = new Promise(resolve =>
      setTimeout(() => {
        for (const fn of errs) fn('@@sync none')
        resolve({ code: 3, error: null })
      }, 5),
    )
  } else {
    const op = / (scan|pack|apply|record)$/m.exec(script.trim())?.[1] ?? ''
    done = serve(op, stdin, stdout, {
      home: srv,
      platform: process.platform,
      install: () => {
        installs++
        return true
      },
    }).then(code => ({ code, error: null }))
  }
  return { stdin, stdout, onErr: fn => errs.push(fn), done, kill: () => {} }
}

let sync: ProfileSync
let changes = 0

async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what} (${JSON.stringify(sync.view()?.error)})`)
    await Bun.sleep(20)
  }
}

/** Look, then Apply with these choices, to the end. */
async function run(
  direction: 'up' | 'down',
  choices: { conflicts?: Record<string, string>; deletions?: string[] } = {},
): Promise<NonNullable<ReturnType<ProfileSync['view']>>> {
  const looked = await sync.look({ direction, password: 'pw' })
  expect(looked).toEqual({ status: 200, body: { ok: true } })
  const v = sync.view()
  if (!v?.preview) throw new Error('no preview')
  const preview = v.preview
  const applied = await sync.apply({ id: preview.id, conflicts: {}, deletions: [], ...choices, password: 'pw' })
  expect(applied.status).toBe(200)
  await until('the sync ends', () => sync.view()?.phase === 'done' || sync.view()?.phase === 'failed')
  return { ...(sync.view() as NonNullable<ReturnType<ProfileSync['view']>>), preview }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ab-psync-'))
  process.env.LOCALAPPDATA = join(root, 'state')
  pc = join(root, 'pc')
  srv = join(root, 'srv')
  // this PC: two profiles, its secrets, a Windows hook, a project with a remote cloned on the server
  pcProject = join(pc, 'code', 'proj')
  mkdirSync(pcProject, { recursive: true })
  git(pcProject, 'init', '-q')
  git(pcProject, 'remote', 'add', 'origin', REMOTE)
  put(
    join(pc, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'pc@x' },
      userID: 'pc-id',
      theme: 'dark',
      mcpServers: {
        gh: { type: 'http', url: 'https://mcp.example/x', headers: { Authorization: `Bearer ${'t'.repeat(30)}` } },
      },
      projects: { [pcProject]: { allowedTools: ['Bash'] } },
    }),
  )
  put(join(pc, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"pc-secret"}}')
  put(
    join(pc, '.claude', 'settings.json'),
    JSON.stringify({
      env: { GITHUB_TOKEN: 'pc-token', A: '1' },
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '"C:/bun.exe" "C:/agent-board/src/entrypoints/hook.ts"' }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'powershell -File C:\\x\\beep.ps1' }] }],
      },
    }),
  )
  put(join(pc, '.claude', 'CLAUDE.md'), '# from the pc\n')
  put(join(pc, '.claude', 'agents', 'old.md'), 'old\n')
  put(
    join(pc, '.claude', 'projects', projectFolder(pcProject), 's1.jsonl'),
    `${JSON.stringify({ cwd: pcProject, message: `token ${GH}` })}\n`,
  )
  put(join(pc, '.claude', 'projects', projectFolder(pcProject), 'memory', 'MEMORY.md'), '- a memory\n')
  put(join(pc, '.claude-work', 'settings.json'), '{}')
  put(join(pc, '.claude-work', 'CLAUDE.md'), '# work\n')
  // the server: its own sign-in and secrets, the board's hook, the project's clone
  srvClone = join(srv, 'work', 'proj')
  mkdirSync(srvClone, { recursive: true })
  git(srvClone, 'init', '-q')
  git(srvClone, 'remote', 'add', 'origin', 'git@github.com:example/proj.git')
  put(join(srv, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'srv@x' }, userID: 'srv-id' }))
  put(join(srv, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"srv-secret"}}')
  put(
    join(srv, '.claude', 'settings.json'),
    JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'srv-key' },
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: '"/home/agent/.bun/bin/bun" "/home/agent/agent-board/src/entrypoints/hook.ts"',
              },
            ],
          },
        ],
      },
    }),
  )
  sync = createProfileSync({
    cfg: { tunnel: { host: 'srv.example', admin: { user: 'root' } } } as unknown as Config,
    home: pc,
    platform: process.platform,
    name: 'pc',
    ssh: () => 'ssh',
    sshVersion: async () => 'OpenSSH_9.6p1',
    knownHosts: () => join(root, 'known_hosts'),
    hostKeyPinned: async () => true,
    spawn,
    onChange: () => {
      changes++
    },
    log: () => {},
    newId: () => `id-${Math.random().toString(16).slice(2)}`,
    now: () => Date.now(),
  })
})

afterAll(() => {
  if (saved === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = saved
  rmSync(root, { recursive: true, force: true })
})

const srvFolder = (): string => join(srv, '.claude', 'projects', projectFolder(srvClone))

describe('syncing the profiles with the board on the server', () => {
  test('nothing asked: no view, no ssh; a server with no board says so', async () => {
    expect(sync.view()).toBeNull()
    expect(scripts).toEqual([])
    noBoard = true
    const r = await sync.look({ direction: 'up', password: 'pw' })
    noBoard = false
    expect(r.status).toBe(409)
    expect((r.body as { error: string }).error).toContain('No board is installed on this server')
    expect(sync.view()?.phase).toBe('failed')
    sync.forget()
    expect(sync.view()).toBeNull()
  })

  test('this PC to the server: secrets stay, paths move, the work profile is made there with the board’s hooks', async () => {
    const v = await run('up')
    expect(v.phase).toBe('done')
    const p = v.preview
    expect(p?.pairs.map(x => [x.from, x.to])).toEqual([[pcProject, srvClone]])
    expect(p?.profiles.find(x => x.name === 'work')?.create).toBe(true)
    expect(p?.held.map(h => h.what)).toEqual(
      expect.arrayContaining([
        '.credentials.json',
        'env GITHUB_TOKEN',
        'oauthAccount',
        'MCP gh: headers',
        `projects/${projectFolder(pcProject)}/s1.jsonl: GitHub token`,
      ]),
    )
    // both sides run on this computer's system here: what cannot go between two systems is core's test
    // the server's own secrets as they were; none of this PC's
    expect(read(join(srv, '.claude', '.credentials.json'))).toContain('srv-secret')
    const cj = json(join(srv, '.claude.json'))
    expect(cj.oauthAccount).toEqual({ emailAddress: 'srv@x' })
    expect(cj.userID).toBe('srv-id')
    expect(cj.theme).toBe('dark')
    expect(JSON.stringify(cj)).not.toContain('Bearer')
    expect(Object.keys(cj.projects as object)).toEqual([srvClone])
    const st = json(join(srv, '.claude', 'settings.json'))
    expect(st.env).toEqual({ ANTHROPIC_API_KEY: 'srv-key', A: '1' })
    expect(JSON.stringify(st.hooks)).toContain('/home/agent/agent-board')
    // the transcript in the clone's folder, its cwd the clone's, its token cut
    const line = JSON.parse(read(join(srvFolder(), 's1.jsonl')))
    expect(line.cwd).toBe(srvClone)
    expect(line.message).not.toContain(GH)
    expect(read(join(srvFolder(), 'memory', 'MEMORY.md'))).toBe('- a memory\n')
    expect(read(join(srv, '.claude-work', 'CLAUDE.md'))).toBe('# work\n')
    expect(v.result?.created).toEqual(['work'])
    expect(installs).toBe(1)
    expect(existsSync(join(srv, '.claude', 'projects', projectFolder(pcProject)))).toBe(false)
    // again: nothing changed, nothing goes
    const again = await sync.look({ direction: 'up', password: 'pw' })
    expect(again.status).toBe(200)
    expect(sync.view()?.preview?.items).toEqual([])
  })

  test('the server back to this PC: its change arrives, its own secrets never do', async () => {
    put(join(srv, '.claude', 'CLAUDE.md'), '# changed on the server\n')
    put(join(srvFolder(), 's2.jsonl'), `${JSON.stringify({ cwd: srvClone, message: 'on the server' })}\n`)
    const v = await run('down')
    expect(v.phase).toBe('done')
    expect(v.preview?.items.map(i => [i.from, i.kind])).toEqual([
      ['CLAUDE.md', 'change'],
      [`projects/${projectFolder(srvClone)}/s2.jsonl`, 'add'],
    ])
    expect(read(join(pc, '.claude', 'CLAUDE.md'))).toBe('# changed on the server\n')
    const line = JSON.parse(read(join(pc, '.claude', 'projects', projectFolder(pcProject), 's2.jsonl')))
    expect(line.cwd).toBe(pcProject)
    expect(read(join(pc, '.claude', '.credentials.json'))).toContain('pc-secret')
    const cj = json(join(pc, '.claude.json'))
    expect(cj.oauthAccount).toEqual({ emailAddress: 'pc@x' })
    expect(JSON.stringify(cj)).not.toContain('srv')
    expect(json(join(pc, '.claude', 'settings.json')).env).toEqual({ GITHUB_TOKEN: 'pc-token', A: '1' })
  })

  test('changed on both sides: the target’s kept unless the owner takes the source’s', async () => {
    put(join(pc, '.claude', 'CLAUDE.md'), '# pc again\n')
    put(join(srv, '.claude', 'CLAUDE.md'), '# server again\n')
    const kept = await run('up')
    expect(kept.preview?.conflicts.map(c => c.key)).toEqual(['default:CLAUDE.md'])
    expect(kept.result?.kept).toBe(1)
    expect(read(join(srv, '.claude', 'CLAUDE.md'))).toBe('# server again\n')
    const taken = await run('up', { conflicts: { 'default:CLAUDE.md': 'source' } })
    expect(taken.preview?.conflicts.map(c => c.key)).toEqual(['default:CLAUDE.md'])
    expect(read(join(srv, '.claude', 'CLAUDE.md'))).toBe('# pc again\n')
  })

  test('deleted on this PC: shown, applied on the server only when ticked', async () => {
    rmSync(join(pc, '.claude', 'agents', 'old.md'))
    const left = await run('up')
    expect(left.preview?.deletions.map(d => d.key)).toEqual(['default:agents/old.md'])
    expect(existsSync(join(srv, '.claude', 'agents', 'old.md'))).toBe(true)
    const ticked = await run('up', { deletions: ['default:agents/old.md'] })
    expect(ticked.result?.deleted).toBe(1)
    expect(existsSync(join(srv, '.claude', 'agents', 'old.md'))).toBe(false)
    expect(sync.view()?.phase).toBe('done')
    const after = await sync.look({ direction: 'up', password: 'pw' })
    expect(after.status).toBe(200)
    expect(sync.view()?.preview?.deletions).toEqual([])
    expect(changes).toBeGreaterThan(0)
  })
})
