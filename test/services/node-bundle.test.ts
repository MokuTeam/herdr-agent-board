// The bundle applied on a node (services/node/bundle.ts, #506, docs/design/nodes 9.3): on folders
// of a test's own, with the board's install as its own tests run it (installInto with fake paths)
// and config.json behind fakes. What is owned is replaced or removed, a file of the node's own is
// kept and said, one backup folder per commit, nothing written when a file does not parse or a path
// leaves the profile folder, nothing changed the second time.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installInto } from '../../src/adapters/hook-settings.ts'
import { BUNDLE_FORMAT, type BundleManifest, PROFILE_DIR } from '../../src/core/bundle.ts'
import type { Profile } from '../../src/core/profiles.ts'
import { dispatch } from '../../src/server/http.ts'
import { nodeDoorRoutes } from '../../src/server/routes/node.ts'
import { createNodeBundle, type NodeBundle, type NodeBundleDeps } from '../../src/services/node/bundle.ts'

const sha = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex')
// The node's own Bun and board folder, as a Linux node would have them.
const NODE_BUN = '/home/owner/.bun/bin/bun'
const NODE_BOARD = '/home/owner/.config/herdr/plugins/agent-board'
const PATHS = {
  bun: NODE_BUN,
  cli: `${NODE_BOARD}/src/entrypoints/cli.ts`,
  spawn: `${NODE_BOARD}/src/entrypoints/spawn-agent.ts`,
  hook: `${NODE_BOARD}/src/entrypoints/hook.ts`,
  statusline: `${NODE_BOARD}/src/entrypoints/statusline.ts`,
  toast: `${NODE_BOARD}/src/integrations/toast.ps1`,
  wakeHook: `${NODE_BOARD}/src/entrypoints/wake-hook.ts`,
  binDir: '/home/owner/.local/bin',
}

interface Rig {
  root: string
  home: string
  profile: string
  state: string
  bundle: NodeBundle
  config: { raw: Record<string, unknown> | null; broken: boolean; writes: number }
  installs: string[]
  /** Sends these contents as blobs and commits a manifest of them. */
  commit(
    seq: number,
    files: Record<string, string>,
    more?: Partial<BundleManifest>,
  ): Promise<{ status: number; body: Record<string, unknown> }>
}

function rig(o: { install?: (dir: string) => { ok: boolean; error: string } } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), 'node-bundle-'))
  const home = join(root, 'home')
  const profile = join(home, '.claude')
  const state = join(root, 'state', 'node')
  mkdirSync(profile, { recursive: true })
  const config = {
    raw: { language: 'en', node: { id: 'server-1' } } as Record<string, unknown> | null,
    broken: false,
    writes: 0,
  }
  const installs: string[] = []
  const profiles: Profile[] = [{ id: 'default', title: 'Default', dir: profile, color: 'gray', hidden: false }]
  const deps: NodeBundleDeps = {
    dir: state,
    profiles: () => profiles,
    home,
    platform: 'linux',
    readConfig: () => (config.broken ? { ok: false, file: join(root, 'config.json') } : { ok: true, raw: config.raw }),
    writeSlice(change) {
      config.raw = change(structuredClone(config.raw ?? {}))
      config.writes++
      return { ok: true }
    },
    install:
      o.install ??
      (dir => {
        installs.push(dir)
        return installInto(dir, PATHS)
      }),
    installed: dir => {
      try {
        return readFileSync(join(dir, 'settings.json'), 'utf8').includes(PATHS.hook)
      } catch {
        return false
      }
    },
    now: () => 1795210000000,
    log: () => {},
  }
  const bundle = createNodeBundle(deps)
  return {
    root,
    home,
    profile,
    state,
    bundle,
    config,
    installs,
    async commit(seq, files, more = {}) {
      const list = Object.entries(files).map(([path, text]) => {
        bundle.putBlob('default', sha(text), new TextEncoder().encode(text))
        return { path, sha256: sha(text), mode: 0o644 }
      })
      const manifest: BundleManifest = {
        format: BUNDLE_FORMAT,
        files: list,
        settings: {},
        hooks: {},
        mcp: {},
        board: { sinks: {} },
        report: [],
        ...more,
      }
      return bundle.commit('default', { seq, hash: sha(JSON.stringify([seq, manifest])), manifest })
    },
  }
}

const read = (r: Rig, path: string): string => readFileSync(join(r.profile, path), 'utf8')
const put = (r: Rig, path: string, text: string): void => {
  mkdirSync(join(r.profile, path, '..'), { recursive: true })
  writeFileSync(join(r.profile, path), text)
}
const backups = (r: Rig): string[] => {
  try {
    return readdirSync(join(r.state, 'bundle-backups', 'default')).sort((a, b) => Number(a) - Number(b))
  } catch {
    return []
  }
}
/** Every file under the root with its content and mtime: what "nothing written" compares. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const full = join(at, name)
      const st = statSync(full)
      if (st.isDirectory()) walk(full)
      else out[full] = `${st.mtimeMs} ${readFileSync(full, 'utf8')}`
    }
  }
  walk(dir)
  return out
}

describe('a commit', () => {
  test('writes the files, records the manifest as sent, and the status has its version', async () => {
    const r = rig()
    const res = await r.commit(1, { 'skills/a/SKILL.md': 'a', 'CLAUDE.md': 'rules' })
    expect(res).toEqual({
      status: 200,
      body: { ok: true, applied: ['CLAUDE.md', 'skills/a/SKILL.md'], removed: [], kept: [], backup: null },
    })
    expect([read(r, 'skills/a/SKILL.md'), read(r, 'CLAUDE.md')]).toEqual(['a', 'rules'])
    const have = r.bundle.have('default')
    expect(have.body.seq).toBe(1)
    expect(have.body.files).toEqual({ 'CLAUDE.md': sha('rules'), 'skills/a/SKILL.md': sha('a') })
    expect(r.bundle.version('default')).toEqual({ seq: 1, hash: have.body.hash as string })
    expect(r.bundle.version('work')).toBeNull()
  })

  test("keeps a file of the node's own that differs, says so, and takes over one that is the same", async () => {
    const r = rig()
    put(r, 'skills/mine/SKILL.md', 'the owner wrote this')
    put(r, 'skills/same/SKILL.md', 'same')
    const res = await r.commit(1, { 'skills/mine/SKILL.md': 'the master has this', 'skills/same/SKILL.md': 'same' })
    expect(res.body.kept).toEqual([{ path: 'skills/mine/SKILL.md', why: 'not-owned' }])
    expect(read(r, 'skills/mine/SKILL.md')).toBe('the owner wrote this')
    // Owned from now on: the same one; the kept one is not the bundle's, though the node was sent it.
    const rec = JSON.parse(readFileSync(join(r.state, 'bundle', 'default.json'), 'utf8'))
    expect(rec.manifest.files.map((f: { path: string }) => f.path)).toEqual(['skills/same/SKILL.md'])
    expect(Object.keys(r.bundle.have('default').body.files as object).sort()).toEqual([
      'skills/mine/SKILL.md',
      'skills/same/SKILL.md',
    ])
    // A later bundle still leaves the kept one alone, and replaces the one it owns.
    const again = await r.commit(2, { 'skills/mine/SKILL.md': 'newer', 'skills/same/SKILL.md': 'changed' })
    expect(again.body.kept).toEqual([{ path: 'skills/mine/SKILL.md', why: 'not-owned' }])
    expect([read(r, 'skills/mine/SKILL.md'), read(r, 'skills/same/SKILL.md')]).toEqual([
      'the owner wrote this',
      'changed',
    ])
  })

  test('removes a file it owned and no longer sends, its empty folder too, and nothing it did not own', async () => {
    const r = rig()
    await r.commit(1, { 'skills/old/SKILL.md': 'old', 'skills/old/notes.md': 'n', 'CLAUDE.md': 'c' })
    put(r, 'skills/hand/SKILL.md', 'by hand')
    const res = await r.commit(2, { 'CLAUDE.md': 'c' })
    expect(res.body.removed).toEqual(['skills/old/SKILL.md', 'skills/old/notes.md'])
    expect(existsSync(join(r.profile, 'skills', 'old'))).toBe(false)
    expect(read(r, 'skills/hand/SKILL.md')).toBe('by hand')
  })

  test('one backup folder per commit, with what it replaced or removed; the last 10 kept', async () => {
    const r = rig()
    await r.commit(1, { 'CLAUDE.md': 'one', 'agents/x.md': 'x' })
    expect(backups(r)).toEqual([])
    const res = await r.commit(2, { 'CLAUDE.md': 'two' })
    expect(res.body.backup).toBe(join(r.state, 'bundle-backups', 'default', '2'))
    expect(backups(r)).toEqual(['2'])
    const folder = join(r.state, 'bundle-backups', 'default', '2')
    expect(readFileSync(join(folder, 'CLAUDE.md'), 'utf8')).toBe('one')
    expect(readFileSync(join(folder, 'agents', 'x.md'), 'utf8')).toBe('x')
    for (let seq = 3; seq <= 13; seq++) await r.commit(seq, { 'CLAUDE.md': `v${seq}` })
    expect(backups(r)).toEqual(['4', '5', '6', '7', '8', '9', '10', '11', '12', '13'])
  })

  test('the same manifest twice changes nothing: no file, no backup, no install, no config write', async () => {
    const r = rig()
    put(r, 'settings.json', JSON.stringify({ theme: 'dark' }))
    const more = { settings: { model: 'opus' }, board: { sinks: {}, language: 'ru' } }
    const body = (await r.commit(1, { 'CLAUDE.md': 'c' }, more)).body
    expect(body.ok).toBe(true)
    const before = snapshot(r.root)
    const installs = r.installs.length
    const writes = r.config.writes
    const again = await r.commit(1, { 'CLAUDE.md': 'c' }, more)
    expect(again.body).toEqual({ ok: true, applied: [], removed: [], kept: [], backup: null })
    expect(snapshot(r.root)).toEqual(before)
    expect([r.installs.length, r.config.writes]).toEqual([installs, writes])
  })
})

describe('settings.json, mcpServers and config.json', () => {
  test("only the keys the bundle owns are replaced or removed; the owner's own stay", async () => {
    const r = rig()
    put(r, 'settings.json', JSON.stringify({ theme: 'dark', env: { MINE: '1' }, model: 'haiku' }))
    await r.commit(1, {}, { settings: { model: 'opus', effortLevel: 'high', env: { FROM_MASTER: 'x' } } })
    let s = JSON.parse(read(r, 'settings.json'))
    expect([s.theme, s.model, s.effortLevel, s.env]).toEqual(['dark', 'opus', 'high', { MINE: '1', FROM_MASTER: 'x' }])
    await r.commit(2, {}, { settings: { model: 'opus' } })
    s = JSON.parse(read(r, 'settings.json'))
    expect([s.theme, s.model, s.effortLevel, s.env]).toEqual(['dark', 'opus', undefined, { MINE: '1' }])
  })

  test("hooks: {{profile-dir}} is the node's folder, a hook it owned and no longer sends goes, the owner's stays", async () => {
    const r = rig()
    const mine = { type: 'command', command: 'notify-send hi' }
    put(r, 'settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [mine] }] } }))
    const sent = { type: 'command', command: `bash ${PROFILE_DIR}/hooks/guard.sh` }
    await r.commit(1, { 'hooks/guard.sh': '#!/bin/sh\nexit 0\n' }, { hooks: { Stop: [{ hooks: [sent] }] } })
    const commands = (): string[] =>
      JSON.parse(read(r, 'settings.json'))
        .hooks.Stop.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map(h => h.command))
        .filter((c: string) => !c.includes(NODE_BOARD))
    expect(commands()).toEqual(['notify-send hi', `bash ${r.profile.replaceAll('\\', '/')}/hooks/guard.sh`])
    if (process.platform !== 'win32') expect(statSync(join(r.profile, 'hooks', 'guard.sh')).mode & 0o777).toBe(0o755)
    await r.commit(2, {}, {})
    expect(commands()).toEqual(['notify-send hi'])
  })

  test("the board's hooks name the node's Bun and folder afterwards, whatever the master's said", async () => {
    const r = rig()
    // The master's own hooks never travel (core/bundle.ts); a settings.json without the board's
    // hooks gets them from the node's install, with its paths.
    const res = await r.commit(1, {}, { settings: { model: 'opus' } })
    expect(res.status).toBe(200)
    expect(r.installs).toEqual([r.profile])
    const text = read(r, 'settings.json')
    expect(text).toContain(NODE_BUN)
    expect(text).toContain(`${NODE_BOARD}/src/entrypoints/hook.ts`)
    expect(text).not.toContain('C:\\\\')
  })

  test("mcpServers in ~/.claude.json: the bundle's names replaced or removed, the owner's and the rest of the file stay", async () => {
    const r = rig()
    const claudeJson = join(r.home, '.claude.json')
    writeFileSync(
      claudeJson,
      JSON.stringify({ oauthAccount: { id: 1 }, mcpServers: { mine: { type: 'stdio', command: 'x' } } }),
    )
    const docs = {
      type: 'http',
      url: 'https://docs.example.com/mcp',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the reference the node is given
      headers: { Authorization: '${MCP_DOCS_AUTHORIZATION}' },
    }
    await r.commit(1, {}, { mcp: { docs } })
    let j = JSON.parse(readFileSync(claudeJson, 'utf8'))
    expect([j.oauthAccount, Object.keys(j.mcpServers).sort()]).toEqual([{ id: 1 }, ['docs', 'mine']])
    await r.commit(2, {}, { mcp: {} })
    j = JSON.parse(readFileSync(claudeJson, 'utf8'))
    expect(Object.keys(j.mcpServers)).toEqual(['mine'])
  })

  test("the board's slice: the master's keys written, a key it no longer sends removed, the rest of config.json the node's", async () => {
    const r = rig()
    r.config.raw = { language: 'en', node: { id: 'server-1' }, models: ['x'], port: 9 }
    await r.commit(1, {}, { board: { sinks: { git: { kind: 'file' } }, language: 'ru', categories: [{ id: 'a' }] } })
    expect(r.config.raw).toEqual({
      language: 'ru',
      node: { id: 'server-1' },
      models: ['x'],
      port: 9,
      categories: [{ id: 'a' }],
      secrets: { sinks: { git: { kind: 'file' } } },
    })
    await r.commit(2, {}, { board: { sinks: {}, language: 'ru' } })
    expect(r.config.raw).toEqual({
      language: 'ru',
      node: { id: 'server-1' },
      models: ['x'],
      port: 9,
      secrets: { sinks: {} },
    })
  })
})

describe('what the review found', () => {
  test("a manifest of 2000 files commits through the door route, past the board's usual 192 KB", async () => {
    const r = rig()
    r.bundle.putBlob('default', sha('x'), new TextEncoder().encode('x'))
    const files = Array.from({ length: 2000 }, (_, i) => ({
      path: `skills/s${i}/SKILL.md`,
      sha256: sha('x'),
      mode: 420,
    }))
    const manifest = { format: BUNDLE_FORMAT, files, settings: {}, hooks: {}, mcp: {}, board: { sinks: {} } }
    const send = (body: string) => {
      const url = new URL('http://127.0.0.1/api/node/bundle/default/commit')
      const req = new Request(url, { method: 'POST', body })
      const guards = { port: 0, token: '', stale: () => false }
      return dispatch(
        nodeDoorRoutes({
          status: async () => null,
          launch: async () => ({ status: 404, body: {} }) as never,
          bundle: r.bundle,
          uplink: {
            stream: () => new Response(''),
            file: () => new Response('', { status: 404 }),
            answer: () => ({ status: 404, body: {} }),
          },
        }),
        req,
        url,
        url.pathname,
        guards,
      )
    }
    const text = JSON.stringify({ seq: 1, hash: sha('h'), manifest })
    expect(text.length).toBeGreaterThan(192 << 10)
    const res = await send(text)
    expect(res.status).toBe(200)
    expect(read(r, 'skills/s1999/SKILL.md')).toBe('x')
    expect([(await send('{ nope')).status, (await send('x'.repeat(8 * 1024 * 1024 + 1))).status]).toEqual([400, 413])
  }, 30_000)

  test("the master's seq started over: the commit's backup folder is kept, beside the older ones", async () => {
    const r = rig()
    for (let seq = 20; seq <= 31; seq++) await r.commit(seq, { 'CLAUDE.md': `v${seq}` })
    await Bun.sleep(20)
    const res = await r.commit(1, { 'CLAUDE.md': 'again' })
    expect(typeof res.body.backup).toBe('string')
    expect(existsSync(res.body.backup as string)).toBe(true)
    expect(backups(r).length).toBe(10)
    // A second commit of seq 1 with something to back up: a folder of its own.
    const again = await r.commit(1, { 'CLAUDE.md': 'once more' })
    expect(again.body.backup).toBe(join(r.state, 'bundle-backups', 'default', '1-1'))
  })

  test('settings.json keeps its mode and is written through its link', async () => {
    const r = rig()
    const real = join(r.root, 'dotfiles', 'settings.json')
    mkdirSync(join(r.root, 'dotfiles'))
    writeFileSync(real, JSON.stringify({ theme: 'dark' }), { mode: 0o600 })
    let linked = true
    try {
      symlinkSync(real, join(r.profile, 'settings.json'), 'file')
    } catch {
      linked = false // no file links for this user on Windows
      writeFileSync(join(r.profile, 'settings.json'), JSON.stringify({ theme: 'dark' }), { mode: 0o600 })
    }
    await r.commit(1, {}, { settings: { model: 'opus' } })
    const file = linked ? real : join(r.profile, 'settings.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).model).toBe('opus')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test('an install that fails after the files: 500 partial, and the next commit finishes it', async () => {
    let fail = true
    const r = rig({ install: dir => (fail ? { ok: false, error: 'no bun' } : installInto(dir, PATHS)) })
    const res = await r.commit(1, { 'CLAUDE.md': 'c' }, { settings: { model: 'opus' } })
    expect([res.status, res.body.error, res.body.partial]).toEqual([500, 'install', true])
    expect(r.bundle.version('default')).toBeNull()
    fail = false
    const again = await r.commit(1, { 'CLAUDE.md': 'c' }, { settings: { model: 'opus' } })
    expect([again.status, again.body.kept]).toEqual([200, []])
    expect(r.bundle.version('default')?.seq).toBe(1)
    expect(read(r, 'settings.json')).toContain(PATHS.hook)
  })
})

describe('refused, with nothing written', () => {
  test('settings.json or config.json that does not parse: 409 settings-parse before any write', async () => {
    const r = rig()
    put(r, 'settings.json', '{ "model": ')
    const before = snapshot(r.root)
    const res = await r.commit(1, { 'CLAUDE.md': 'c' })
    expect([res.status, res.body.error, res.body.file]).toEqual([
      409,
      'settings-parse',
      join(r.profile, 'settings.json'),
    ])
    // The blob was stored on its PUT; nothing else is written.
    const after = snapshot(r.root)
    for (const key of Object.keys(after)) if (!key.includes(join('node', 'blobs'))) expect(after[key]).toBe(before[key])
    expect(existsSync(join(r.profile, 'CLAUDE.md'))).toBe(false)

    const s = rig()
    s.config.broken = true
    const res2 = await s.commit(1, { 'CLAUDE.md': 'c' })
    expect([res2.status, res2.body.error]).toEqual([409, 'settings-parse'])
    expect(existsSync(join(s.profile, 'CLAUDE.md'))).toBe(false)
    expect(s.installs).toEqual([])
    expect(existsSync(join(s.state, 'bundle'))).toBe(false)
  })

  for (const path of [
    '../escape.md',
    'skills/../../escape.md',
    '/etc/passwd',
    'C:/Windows/x',
    'skills\\..\\x',
    '.credentials.json',
    'settings.json',
    'a/.ssh/config',
  ])
    test(`a manifest with the path ${JSON.stringify(path)} is refused whole (409 path)`, async () => {
      const r = rig()
      const res = await r.commit(1, { 'CLAUDE.md': 'ok', [path]: 'evil' })
      expect([res.status, res.body.error]).toEqual([409, 'path'])
      expect(existsSync(join(r.profile, 'CLAUDE.md'))).toBe(false)
      expect(existsSync(join(r.home, 'escape.md'))).toBe(false)
      expect(existsSync(join(r.state, 'bundle'))).toBe(false)
    })

  test('a link on the way out of the profile folder: refused whole, nothing written through it', async () => {
    const r = rig()
    const outside = join(r.root, 'outside')
    mkdirSync(outside)
    try {
      symlinkSync(outside, join(r.profile, 'skills'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // no links on this machine
    }
    const res = await r.commit(1, { 'skills/x/SKILL.md': 'evil' })
    expect([res.status, res.body.error]).toEqual([409, 'path'])
    expect(readdirSync(outside)).toEqual([])
  })

  test('a blob not sent: 409 missing-blob naming it; a wrong or too big blob refused at its PUT', async () => {
    const r = rig()
    const manifest = {
      format: BUNDLE_FORMAT,
      files: [{ path: 'CLAUDE.md', sha256: sha('never sent'), mode: 420 }],
      settings: {},
      hooks: {},
      mcp: {},
      board: { sinks: {} },
    }
    const res = await r.bundle.commit('default', { seq: 1, hash: sha('h'), manifest })
    expect(res).toEqual({ status: 409, body: { error: 'missing-blob', missing: [sha('never sent')] } })
    expect(r.bundle.putBlob('default', sha('a'), new TextEncoder().encode('b')).status).toBe(400)
    expect(r.bundle.putBlob('default', sha('a'), new Uint8Array(8 * 1024 * 1024 + 1)).status).toBe(413)
    expect(existsSync(join(r.state, 'blobs', sha('a')))).toBe(false)
    // Twice the same blob: stored once, the answer the same.
    const bytes = new TextEncoder().encode('a')
    expect(r.bundle.putBlob('default', sha('a'), bytes)).toEqual(r.bundle.putBlob('default', sha('a'), bytes))
  })

  test('a profile the node does not have: 404 profile on every route', async () => {
    const r = rig()
    expect(r.bundle.have('work').status).toBe(404)
    expect(r.bundle.have('../default').status).toBe(404)
    expect(r.bundle.putBlob('work', sha('a'), new TextEncoder().encode('a')).status).toBe(404)
    expect((await r.bundle.commit('work', {})).status).toBe(404)
    rmSync(r.root, { recursive: true, force: true })
  })
})
