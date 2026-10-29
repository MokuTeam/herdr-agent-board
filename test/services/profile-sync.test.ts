// The profile sync from the local board's side (services/profile-sync.ts) against a server board's
// sync program run in this process (entrypoints/profile-sync.ts serve) on a home of its own: the
// admin's ssh is a stand-in that hands the program its stdin and stdout. Both directions, the
// secrets on each side, the paths, a profile made, a conflict and a deletion.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ROOT } from '../../src/adapters/paths.ts'
import { frameSink, readSynced } from '../../src/adapters/profile-sync.ts'
import { type RemoteEnd, type RemoteStream, spawnRemoteStream } from '../../src/adapters/ssh.ts'
import { projectFolder } from '../../src/core/profile-sync/paths.ts'
import type { Config } from '../../src/core/types.ts'
import { SYNC_VERSION, serve } from '../../src/entrypoints/profile-sync.ts'
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
const installedInto: string[] = []
let noBoard = false
let asProcess = false
const scripts: string[] = []
const savedRules: { host: string; rules: unknown }[] = []

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
  } else if (asProcess) {
    // the program as its own process, its home the server's, as runuser starts it
    const op = / (scan|pack|apply|record|dirs|mkdir|exists)$/m.exec(script.trim())?.[1] ?? ''
    const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    process.env.HOME = srv
    process.env.USERPROFILE = srv
    try {
      return spawnRemoteStream(process.execPath, [join(ROOT, 'src', 'entrypoints', 'profile-sync.ts'), op], 60_000)
    } finally {
      for (const [k, v] of Object.entries(was))
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
  } else {
    const op = / (scan|pack|apply|record|dirs|mkdir|exists)$/m.exec(script.trim())?.[1] ?? ''
    done = serve(op, stdin, stdout, {
      home: srv,
      platform: process.platform,
      install: dirs => {
        installs++
        installedInto.push(...dirs)
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

/** Every group ticked, session history too: the tests of the sync's way; those of the ticks say theirs. */
const ALL = { env: true, hooks: true, statusLine: true, mcp: true, helpers: true, history: true }

/** Look, then Apply with these choices (every group ticked unless they say), to the end. */
async function run(
  direction: 'up' | 'down',
  choices: { conflicts?: Record<string, string>; deletions?: string[]; allow?: Record<string, boolean> } = {},
): Promise<NonNullable<ReturnType<ProfileSync['view']>>> {
  const looked = await sync.look({ direction, password: 'pw' })
  expect(looked).toEqual({ status: 200, body: { ok: true } })
  const v = sync.view()
  if (!v?.preview) throw new Error('no preview')
  const preview = v.preview
  const applied = await sync.apply({
    id: preview.id,
    conflicts: {},
    deletions: [],
    allow: ALL,
    ...choices,
    password: 'pw',
  })
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
    saveRules: (host, rules) => {
      savedRules.push({ host, rules })
      return true
    },
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
    expect(installedInto).toEqual([join(srv, '.claude-work')])
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

  test('the server’s program as a process of its own: both ways through its stdin and stdout', async () => {
    asProcess = true
    try {
      put(join(pc, '.claude', 'skills', 'big', 'SKILL.md'), 'x'.repeat(3 * 1024 * 1024))
      const up = await run('up')
      expect(up.phase).toBe('done')
      expect(read(join(srv, '.claude', 'skills', 'big', 'SKILL.md')).length).toBe(3 * 1024 * 1024)
      put(join(srv, '.claude', 'skills', 'big', 'NOTES.md'), 'from the server\n')
      const down = await run('down')
      expect(down.result?.files).toBe(1)
      expect(read(join(pc, '.claude', 'skills', 'big', 'NOTES.md'))).toBe('from the server\n')
    } finally {
      asProcess = false
    }
  })

  test('as reviewed: the server changes how this PC runs only in the groups ticked; its transcripts only with history', async () => {
    const st = json(join(srv, '.claude', 'settings.json'))
    put(
      join(srv, '.claude', 'settings.json'),
      JSON.stringify({
        ...st,
        env: { ...(st.env as object), SRV_ONLY: '1', NODE_OPTIONS: '--require /x.js' },
        hooks: {
          ...(st.hooks as object),
          Stop: [{ hooks: [{ type: 'command', command: 'notify-send from-server' }] }],
        },
        model: 'from-server',
      }),
    )
    put(join(srvFolder(), 's3.jsonl'), `${JSON.stringify({ cwd: srvClone, message: 'history' })}\n`)
    const none = await run('down', { allow: {} })
    expect(none.phase).toBe('done')
    expect(none.preview?.changes).toEqual(
      expect.arrayContaining([
        { profile: 'default', rel: 'settings.json', group: 'env', key: 'env SRV_ONLY', how: 'add' },
        {
          profile: 'default',
          rel: 'settings.json',
          group: 'hooks',
          key: 'hook Stop: notify-send from-server',
          how: 'add',
        },
        { profile: 'default', rel: 'settings.json', group: null, key: 'model', how: 'add' },
      ]),
    )
    // NODE_OPTIONS is each side's own: never even listed
    expect(JSON.stringify(none.preview?.changes)).not.toContain('NODE_OPTIONS')
    const mine = json(join(pc, '.claude', 'settings.json'))
    expect(mine.model).toBe('from-server')
    expect(mine.env).toEqual({ GITHUB_TOKEN: 'pc-token', A: '1' })
    expect(JSON.stringify(mine.hooks)).not.toContain('from-server')
    expect(existsSync(join(pc, '.claude', 'projects', projectFolder(pcProject), 's3.jsonl'))).toBe(false)
    // offered again, now ticked
    const all = await run('down', { allow: { env: true, hooks: true, history: true } })
    expect(all.preview?.items.map(i => i.from)).toEqual(
      expect.arrayContaining(['settings.json', `projects/${projectFolder(srvClone)}/s3.jsonl`]),
    )
    const now = json(join(pc, '.claude', 'settings.json'))
    expect(now.env).toEqual({ GITHUB_TOKEN: 'pc-token', A: '1', SRV_ONLY: '1' })
    expect(JSON.stringify(now.hooks)).toContain('notify-send from-server')
    expect(existsSync(join(pc, '.claude', 'projects', projectFolder(pcProject), 's3.jsonl'))).toBe(true)
  })

  test('as reviewed: a file the target changed between Look and Apply is left as it is, listed, and met again', async () => {
    put(join(pc, '.claude', 'agents', 'late.md'), 'from the pc\n')
    const looked = await sync.look({ direction: 'up', password: 'pw' })
    expect(looked.status).toBe(200)
    const preview = sync.view()?.preview
    expect(preview?.items.map(i => i.to)).toContain('agents/late.md')
    // written on the server after the preview was made
    put(join(srv, '.claude', 'agents', 'late.md'), 'written on the server meanwhile\n')
    await sync.apply({ id: preview?.id, conflicts: {}, deletions: [], allow: ALL, password: 'pw' })
    await until('the sync ends', () => sync.view()?.phase === 'done' || sync.view()?.phase === 'failed')
    expect(sync.view()?.result?.skipped).toEqual([{ profile: 'default', rel: 'agents/late.md', why: 'changed' }])
    expect(read(join(srv, '.claude', 'agents', 'late.md'))).toBe('written on the server meanwhile\n')
    // not recorded on this side: the next preview shows it, as a file both sides have
    expect(await sync.look({ direction: 'up', password: 'pw' })).toEqual({ status: 200, body: { ok: true } })
    expect(sync.view()?.preview?.conflicts.map(c => c.to)).toEqual(['agents/late.md'])
    sync.forget()
  })

  test('as reviewed: an apply cut short records what it wrote before it stopped', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    const sink = frameSink(input)
    const serving = serve('apply', input.pipe(new PassThrough()), output, {
      home: srv,
      platform: process.platform,
      install: () => true,
    })
    await sink.send({
      op: 'apply',
      v: SYNC_VERSION,
      peer: 'cut-short',
      profiles: [],
      same: [],
      forget: [],
      deletions: [],
      allow: ALL,
    })
    await sink.send(
      { t: 'file', profile: 'default', to: 'agents/cut.md', merge: false, expect: null },
      Buffer.from('cut\n'),
    )
    // then one it refuses, and the stream ends with no {t:'end'}
    await sink.send(
      { t: 'file', profile: 'default', to: '../outside.md', merge: false, expect: null },
      Buffer.from('x'),
    )
    await sink.end()
    expect(await serving).toBe(1)
    expect(read(join(srv, '.claude', 'agents', 'cut.md'))).toBe('cut\n')
    expect(Object.keys(readSynced('cut-short').default ?? {})).toEqual(['agents/cut.md'])
  })
})

describe('where the projects go: path rules and the folders picked', () => {
  test('the server’s folders listed by its program, as its board’s user; a folder made there; a name that is no folder’s refused', async () => {
    scripts.length = 0
    const home = await sync.dirs({ password: 'pw' })
    expect(home.status).toBe(200)
    const listed = home.body as { path: string; parent: string; home: string; entries: string[]; error: null }
    expect(listed.path).toBe(srv)
    expect(listed.home).toBe(srv)
    expect(listed.parent).toBe(join(srv, '..'))
    // its folders only, the hidden ones last
    expect(listed.entries.slice(0, 2)).toEqual(['work', '.bun'])
    expect(listed.entries).toContain('.claude')
    // the sync's own command, its program run as the board's user (core/profile-sync/remote.ts): no probe again
    expect(scripts.filter(x => x.includes('profile sync'))).toHaveLength(1)
    expect(scripts.some(x => x.includes('probe'))).toBe(false)
    const made = await sync.mkdir({ path: srv, name: 'migo', password: 'pw' })
    expect(made.status).toBe(200)
    expect((made.body as { path: string; entries: string[] }).path).toBe(join(srv, 'migo'))
    expect(existsSync(join(srv, 'migo'))).toBe(true)
    for (const name of ['', '..', 'a/b', 'a\\b'])
      expect((await sync.mkdir({ path: srv, name, password: 'pw' })).status).toBe(409)
    expect((await sync.mkdir({ path: srv, password: 'pw' })).status).toBe(400)
    const inside = await sync.dirs({ path: join(srv, 'work', 'proj', '..'), password: 'pw' })
    expect((inside.body as { path: string; entries: string[] }).entries).toEqual(['proj'])
    const missing = await sync.dirs({ path: join(srv, 'nowhere'), password: 'pw' })
    expect((missing.body as { error: string }).error).toBe('missing')
    expect((await sync.dirs({ path: 'relative', password: 'pw' })).status).toBe(409)
  })

  test('a project with no clone there: the rule suggested, kept for this server, the project placed by it, its folder not there until made', async () => {
    const a = join(pc, 'migo', 'a')
    mkdirSync(a, { recursive: true })
    put(join(pc, '.claude', 'projects', projectFolder(a), 's.jsonl'), `${JSON.stringify({ cwd: a, message: 'hi' })}\n`)
    put(join(pc, '.claude', 'projects', projectFolder(a), 'memory', 'MEMORY.md'), '- a\n')
    expect(await sync.look({ direction: 'up', password: 'pw' })).toEqual({ status: 200, body: { ok: true } })
    const p = sync.view()?.preview
    expect(p?.unpaired.map(u => [u.path, u.why])).toEqual([[a, 'noRemote']])
    // one project: its own folder, as placed in this home, to the same place in the server's
    const rule = { pc: a, server: join(srv, 'migo', 'a') }
    expect(p?.suggested).toEqual([{ rule, projects: 1 }])
    // the clone's pair is known there from the Look
    expect(p?.there).toEqual({ [srvClone]: true })

    expect(sync.rules({ rules: [{ pc: 'not absolute', server: '/x' }] }).status).toBe(409)
    const kept = sync.rules({ rules: [rule], password: 'pw' })
    expect(kept).toEqual({ status: 200, body: { ok: true, rules: [rule] } })
    expect(savedRules.at(-1)).toEqual({ host: 'srv.example', rules: [rule] })
    const q = sync.view()?.preview
    expect(q?.rules).toEqual([rule])
    expect(q?.suggested).toEqual([])
    expect(q?.pairs.map(x => [x.from, x.to, x.how, x.rule])).toEqual([
      [pcProject, srvClone, 'remote', undefined],
      [a, join(srv, 'migo', 'a'), 'rule', 0],
    ])
    // asked of the server in the background: not there yet; the same preview, its choices kept
    await until('the folder there asked', () => join(srv, 'migo', 'a') in (sync.view()?.preview?.there ?? {}))
    expect(sync.view()?.preview?.there[join(srv, 'migo', 'a')]).toBe(false)
    expect(sync.view()?.preview?.id).toBe(q?.id as string)
    // made there with the picker: known there at once
    await sync.mkdir({ path: join(srv, 'migo'), name: 'a', password: 'pw' })
    sync.pair({ profile: 'default', folder: projectFolder(a), path: '' })
    expect(sync.view()?.preview?.there[join(srv, 'migo', 'a')]).toBe(true)

    // the owner's own choice over the rule, then left out, then as the rules say again
    sync.pair({ profile: 'default', folder: projectFolder(a), path: join(srv, 'elsewhere') })
    expect(sync.view()?.preview?.pairs.find(x => x.folder === projectFolder(a))?.how).toBe('owner')
    sync.pair({ profile: 'default', folder: projectFolder(a), path: null })
    expect(sync.view()?.preview?.unpaired.map(u => u.why)).toEqual(['left'])
    sync.pair({ profile: 'default', folder: projectFolder(a), path: '' })
    expect(sync.view()?.preview?.pairs.find(x => x.folder === projectFolder(a))?.how).toBe('rule')
    sync.forget()

    // Apply: its memory and transcript in the folder named for the server's path, its cwd that path
    const v = await run('up')
    expect(v.preview?.pairs.find(x => x.folder === projectFolder(a))?.to).toBe(join(srv, 'migo', 'a'))
    const there = join(srv, '.claude', 'projects', projectFolder(join(srv, 'migo', 'a')))
    expect(json(join(there, 's.jsonl')).cwd).toBe(join(srv, 'migo', 'a'))
    expect(read(join(there, 'memory', 'MEMORY.md'))).toBe('- a\n')

    // and back: the server's project placed on this PC by the same rule
    put(join(there, 's2.jsonl'), `${JSON.stringify({ cwd: join(srv, 'migo', 'a'), message: 'there' })}\n`)
    const back = await run('down')
    expect(back.preview?.pairs.find(x => x.to === a)?.how).toBe('rule')
    expect(back.preview?.there[a]).toBe(true)
    expect(json(join(pc, '.claude', 'projects', projectFolder(a), 's2.jsonl')).cwd).toBe(a)
  })
})
