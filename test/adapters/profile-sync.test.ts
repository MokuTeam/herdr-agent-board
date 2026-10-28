import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createGunzip } from 'node:zlib'
import {
  FrameReader,
  findClones,
  frame,
  frameSink,
  framesOf,
  openTarget,
  prepare,
  readSynced,
  scanSide,
  sideProfiles,
  walkProfile,
  writable,
} from '../../src/adapters/profile-sync.ts'
import { projectFolder } from '../../src/core/profile-sync/paths.ts'
import { ticksOf } from '../../src/core/profile-sync/plan.ts'
import { CUT } from '../../src/core/profile-sync/secrets.ts'

const GH = `ghp_${'a1B2'.repeat(9)}`
const ALL = ticksOf({ env: true, hooks: true, statusLine: true, mcp: true, helpers: true, history: true })
const NONE = ticksOf({})
const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const posix = process.platform !== 'win32'
let root = ''
const saved = process.env.LOCALAPPDATA

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ab-sync-'))
  process.env.LOCALAPPDATA = join(root, 'state')
})
afterAll(() => {
  if (saved === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = saved
  rmSync(root, { recursive: true, force: true })
})

const put = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

/** A home with two profiles: the default one (its .claude.json in the home), and work (its own inside). */
function home(name: string): { home: string; project: string } {
  const h = join(root, name)
  const project = join(h, 'code', 'proj')
  mkdirSync(project, { recursive: true })
  put(
    join(h, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'me@x' },
      userID: 'u',
      projects: { [project]: { allowedTools: [] } },
    }),
  )
  put(join(h, '.claude', 'settings.json'), JSON.stringify({ env: { GITHUB_TOKEN: 't', A: '1' }, model: 'opus' }))
  put(join(h, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"secret"}}')
  put(join(h, '.claude', 'CLAUDE.md'), '# mine\n')
  put(join(h, '.claude', 'shell-snapshots', 's.sh'), 'x')
  put(join(h, '.claude', 'plugins', 'installed_plugins.json'), '{}')
  put(
    join(h, '.claude', 'projects', projectFolder(project), 's1.jsonl'),
    `${JSON.stringify({ cwd: project, message: `here ${GH}` })}\n`,
  )
  put(join(h, '.claude-work', '.claude.json'), JSON.stringify({ theme: 'dark' }))
  put(join(h, '.claude-work', 'settings.json'), '{}')
  return { home: h, project }
}

describe('a side of the sync on disk', () => {
  test('its profiles, their files at every level, but one machine’s own and the secret files', () => {
    const { home: h } = home('walk')
    const ps = sideProfiles(h)
    expect(ps).toEqual([
      { name: 'default', dir: join(h, '.claude'), claudeJson: join(h, '.claude.json') },
      { name: 'work', dir: join(h, '.claude-work'), claudeJson: join(h, '.claude-work', '.claude.json') },
    ])
    const w = walkProfile(ps[0] as (typeof ps)[number])
    expect([...w.files.keys()].sort()).toEqual([
      '.claude.json',
      'CLAUDE.md',
      `projects/${projectFolder(join(h, 'code', 'proj'))}/s1.jsonl`,
      'settings.json',
    ])
    expect(w.secretFiles).toEqual(['.credentials.json'])
  })

  test('its scan as the source: hashes, the secrets found by kind, what stays, its projects by their transcripts’ cwd', async () => {
    const { home: h, project } = home('scan')
    const m = await scanSide({
      home: h,
      platform: process.platform,
      peer: 'srv',
      to: { platform: 'linux', from: process.platform, fromHome: h, toHome: '/home/agent' },
      clones: false,
    })
    const d = m.profiles.find(p => p.name === 'default')
    expect(Object.keys(d?.files ?? {}).length).toBe(4)
    expect(m.findings).toEqual([
      { profile: 'default', rel: `projects/${projectFolder(project)}/s1.jsonl`, kinds: ['GitHub token'] },
    ])
    expect(m.held).toContainEqual({ profile: 'default', what: 'env GITHUB_TOKEN' })
    expect(m.held).toContainEqual({ profile: 'default', what: 'oauthAccount' })
    expect(m.projects.map(p => [p.folder, p.path, p.state])).toEqual([[projectFolder(project), project, 'plain']])
    // the .claude.json hash is of its shared part: the OAuth part changing leaves it as it was
    const before = d?.files['.claude.json']?.[0]
    put(
      join(h, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'other@x' },
        userID: 'u2',
        projects: { [project]: { allowedTools: [] } },
      }),
    )
    const again = await scanSide({ home: h, platform: process.platform, peer: 'srv', to: null, clones: false })
    expect(again.profiles[0]?.files['.claude.json']?.[0]).toBe(before)
    expect(again.findings).toEqual([])
  })

  test('a file made ready: its cwd moved, its secrets cut; .claude.json’s shared part as the target names its projects', () => {
    const { home: h, project } = home('prep')
    const p = sideProfiles(h)[0] as ReturnType<typeof sideProfiles>[number]
    const ctx = {
      to: { platform: 'linux', from: process.platform, fromHome: h, toHome: '/home/agent' },
      moves: [{ from: project, to: '/home/agent/work/proj' }],
      allow: {},
    }
    const t = prepare(p, `projects/${projectFolder(project)}/s1.jsonl`, ctx)
    const line = JSON.parse(t?.body.toString('utf8') ?? '{}')
    expect(line.cwd).toBe('/home/agent/work/proj')
    expect(line.message).not.toContain(GH)
    expect(t?.found).toEqual({ 'GitHub token': 1 })
    const cj = JSON.parse(prepare(p, '.claude.json', ctx)?.body.toString('utf8') ?? '{}')
    expect(cj).toEqual({ projects: { '/home/agent/work/proj': { allowedTools: [] } } })
    expect(prepare(p, 'nothing-here.md', ctx)).toBeNull()
    // a secret file, one machine's own or a path outside, whoever asks for it
    for (const rel of ['.credentials.json', 'shell-snapshots/s.sh', '../.claude-work/settings.json'])
      expect(prepare(p, rel, ctx)).toBeNull()
  })

  test('the target: merges keep its own secrets, a profile made, secret and outside paths refused, the hashes recorded', () => {
    const { home: h } = home('target')
    const t = openTarget({
      peer: 'pc',
      home: h,
      platform: process.platform,
      profiles: [
        { name: 'default', create: false, dir: join(h, '.claude') },
        { name: 'new', create: true, dir: join(h, '.claude-new') },
      ],
      allow: ALL,
    })
    t.write('default', '.claude.json', Buffer.from(JSON.stringify({ theme: 'light', projects: {} })), { merge: true })
    t.write('default', 'settings.json', Buffer.from(JSON.stringify({ env: { B: '2' }, model: 'sonnet' })), {
      merge: true,
    })
    t.write('new', 'CLAUDE.md', Buffer.from('# new\n'), { merge: false })
    t.write('default', 'skills/a/SKILL.md', Buffer.from('skill'), { merge: false })
    // merged even when it comes as a whole file
    t.write('default', '.claude.json', Buffer.from(JSON.stringify({ theme: 'light' })), { merge: false })
    for (const bad of ['.credentials.json', '../x', 'a/../../x', 'C:/x', 'sessions/1.json', '.claude.json.bak'])
      expect(() => t.write('default', bad, Buffer.from('x'), { merge: false })).toThrow()
    t.remove('default', 'CLAUDE.md', sha('# mine\n'))
    const { created } = t.finish()
    expect(created).toEqual(['new'])
    const cj = JSON.parse(readFileSync(join(h, '.claude.json'), 'utf8'))
    expect(cj.oauthAccount).toEqual({ emailAddress: 'me@x' })
    expect(cj.theme).toBe('light')
    const st = JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'))
    expect(st).toEqual({ env: { GITHUB_TOKEN: 't', A: '1', B: '2' }, model: 'sonnet' })
    expect(readFileSync(join(h, '.claude', '.credentials.json'), 'utf8')).toContain('secret')
    expect(existsSync(join(h, '.claude', 'CLAUDE.md'))).toBe(false)
    expect(readFileSync(join(h, '.claude-new', 'CLAUDE.md'), 'utf8')).toBe('# new\n')
    const synced = readSynced('pc')
    expect(Object.keys(synced.default ?? {}).sort()).toEqual(['.claude.json', 'settings.json', 'skills/a/SKILL.md'])
    expect(Object.keys(synced.new ?? {})).toEqual(['CLAUDE.md'])
    expect(writable('projects/x/a.jsonl')).toBe(true)
  })

  test('clones under a home: hidden folders, node_modules and the board’s checkout passed by', () => {
    const h = join(root, 'clones')
    for (const d of [
      'work/a/.git',
      'deep/1/2/3/b/.git',
      'agent-board/.git',
      '.cache/c/.git',
      'work/a/node_modules/d/.git',
    ])
      mkdirSync(join(h, d), { recursive: true })
    expect(findClones(h)).toEqual([join(h, 'work', 'a')])
    expect(findClones(h, 5)).toEqual([join(h, 'deep', '1', '2', '3', 'b'), join(h, 'work', 'a')])
  })
})

describe('a side of the sync, as reviewed', () => {
  test('its scan: remotes as keys only, the merged files’ shared parts, secrets found in history.jsonl and in a file not text', async () => {
    const { home: h, project } = home('scan2')
    const git = (dir: string, ...args: string[]): void => {
      const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'ignore', stderr: 'pipe' })
      if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    }
    git(project, 'init', '-q')
    git(project, 'remote', 'add', 'origin', 'https://me:tok3nvalue@github.com/Example/Proj.git')
    const clone = join(h, 'work', 'other')
    mkdirSync(clone, { recursive: true })
    git(clone, 'init', '-q')
    git(clone, 'remote', 'add', 'origin', 'https://me:tok3nvalue@github.com/Example/Other.git')
    put(join(h, '.claude', 'history.jsonl'), `${JSON.stringify({ display: `token ${GH}`, project })}\n`)
    writeFileSync(join(h, '.claude', 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(` ${GH} `)]))
    put(
      join(h, '.claude', 'settings.json'),
      JSON.stringify({
        env: { GITHUB_TOKEN: 't', A: '1' },
        permissions: { allow: [`Bash(curl -H "Authorization: Bearer ${'q'.repeat(30)}")`] },
        statusLine: { type: 'command', command: 'bun /x/agent-board/src/entrypoints/statusline.ts' },
      }),
    )
    const m = await scanSide({
      home: h,
      platform: process.platform,
      peer: 'srv',
      to: { platform: 'linux', from: process.platform, fromHome: h, toHome: '/home/agent' },
      clones: true,
    })
    expect(m.projects.map(p => p.remote)).toEqual(['github.com/example/proj'])
    expect(m.clones.map(c => c.remote)).toEqual(['github.com/example/proj', 'github.com/example/other'])
    expect(JSON.stringify(m)).not.toContain('tok3nvalue')
    const d = m.profiles.find(p => p.name === 'default')
    expect(d?.views?.settings).toEqual({ env: { A: '1' } })
    expect(d?.boardStatusLine).toBe(true)
    expect(d?.views?.claudeJson).toEqual({ projects: { [project]: { allowedTools: [] } } })
    expect(m.findings).toContainEqual({ profile: 'default', rel: 'history.jsonl', kinds: ['GitHub token'] })
    expect(m.findings).toContainEqual({ profile: 'default', rel: 'blob.bin', kinds: ['GitHub token'], whole: true })
    expect(m.held).toContainEqual({ profile: 'default', what: 'permissions: bearer token' })
    expect(JSON.stringify(m)).not.toContain(GH)
    expect(JSON.stringify(m)).not.toContain('q'.repeat(30))
  })

  test('a file made ready: text that is not UTF-8 byte for byte, its BOM kept, a key cut from UTF-16; a file not text with a key never goes', () => {
    const { home: h } = home('prep2')
    const p = sideProfiles(h)[0] as ReturnType<typeof sideProfiles>[number]
    const ctx = {
      to: { platform: 'linux', from: process.platform, fromHome: h, toHome: '/home/agent' },
      moves: [],
      allow: {},
    }
    // cp1251 "Привет" and a token in it: the bytes kept, the token cut
    const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a])
    writeFileSync(join(h, '.claude', 'a.ps1'), cp1251)
    expect(prepare(p, 'a.ps1', ctx)?.body.equals(cp1251)).toBe(true)
    writeFileSync(join(h, '.claude', 'b.ps1'), Buffer.concat([cp1251, Buffer.from(`$t = '${GH}'\n`)]))
    const b = prepare(p, 'b.ps1', ctx)
    expect(b?.body.subarray(0, 7).equals(cp1251)).toBe(true)
    expect(b?.body.toString('latin1')).toContain(CUT)
    expect(b?.body.toString('latin1')).not.toContain(GH)
    expect(b?.cut).toBe(true)
    // a BOM kept, with or without a cut
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    writeFileSync(join(h, '.claude', 'c.md'), Buffer.concat([bom, Buffer.from(`# c ${GH}\n`)]))
    const c = prepare(p, 'c.md', ctx)
    expect(c?.body.subarray(0, 3).equals(bom)).toBe(true)
    expect(c?.body.subarray(3).toString('utf8')).toBe(`# c ${CUT}\n`)
    writeFileSync(join(h, '.claude', 'd.md'), Buffer.concat([bom, Buffer.from('# d\n')]))
    expect(prepare(p, 'd.md', ctx)?.body.equals(Buffer.concat([bom, Buffer.from('# d\n')]))).toBe(true)
    expect(prepare(p, 'd.md', ctx)?.cut).toBe(false)
    // UTF-16 with its BOM (PowerShell's own): the key cut, still UTF-16
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`$t = '${GH}'`, 'utf16le')])
    writeFileSync(join(h, '.claude', 'e.ps1'), le)
    const e = prepare(p, 'e.ps1', ctx)
    expect(e?.body.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))).toBe(true)
    expect(e?.body.subarray(2).toString('utf16le')).toBe(`$t = '${CUT}'`)
    // not text: as it is; with a key in it, never sent (the preview holds it back)
    writeFileSync(join(h, '.claude', 'f.bin'), Buffer.from([0, 1, 2, 3]))
    expect(prepare(p, 'f.bin', ctx)?.body.equals(Buffer.from([0, 1, 2, 3]))).toBe(true)
    writeFileSync(join(h, '.claude', 'g.bin'), Buffer.concat([Buffer.from([0, 1]), Buffer.from(GH)]))
    expect(prepare(p, 'g.bin', ctx)).toBeNull()
    // its execute bit goes with it
    if (posix) {
      put(join(h, '.claude', 'hooks', 'x.sh'), '#!/bin/sh\n')
      chmodSync(join(h, '.claude', 'hooks', 'x.sh'), 0o755)
      expect(prepare(p, 'hooks/x.sh', ctx)?.exec).toBe(true)
      expect(prepare(p, 'c.md', ctx)?.exec).toBe(false)
    }
  })

  test('settings.json made ready: the groups not ticked held, its hash then not the scan’s (so it is offered again)', async () => {
    const { home: h } = home('prep3')
    put(
      join(h, '.claude', 'settings.json'),
      JSON.stringify({
        env: { A: '1' },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'beep' }] }] },
        model: 'opus',
      }),
    )
    const p = sideProfiles(h)[0] as ReturnType<typeof sideProfiles>[number]
    const to = { platform: 'linux', from: process.platform, fromHome: h, toHome: '/home/agent' }
    const scanned = (await scanSide({ home: h, platform: process.platform, peer: 'x', to: null, clones: false }))
      .profiles[0]?.files['settings.json']?.[0]
    const none = prepare(p, 'settings.json', { to, moves: [], allow: {} })
    expect(JSON.parse(none?.body.toString('utf8') ?? '')).toEqual({ model: 'opus' })
    expect(none?.hash).not.toBe(scanned)
    const all = prepare(p, 'settings.json', { to, moves: [], allow: ALL })
    expect(JSON.parse(all?.body.toString('utf8') ?? '').env).toEqual({ A: '1' })
    expect(all?.hash).toBe(scanned)
  })

  test('the target: a merged file that is not JSON there refused and listed, a copy kept before the first merge', () => {
    const { home: h } = home('target2')
    put(join(h, '.claude-work', '.claude.json'), '{"oauthAccount": {"emailAddress": "w@x"}, broken')
    const own = '{\n  "env": {"ANTHROPIC_API_KEY": "mine"},\n  "model": "opus"\n}\n'
    put(join(h, '.claude', 'settings.json'), own)
    const t = openTarget({ peer: 'pc2', home: h, platform: process.platform, profiles: [], allow: ALL })
    expect(t.write('work', '.claude.json', Buffer.from('{"theme":"light"}'), { merge: true })).toBe('unreadable')
    expect(readFileSync(join(h, '.claude-work', '.claude.json'), 'utf8')).toContain('broken')
    expect(t.write('default', 'settings.json', Buffer.from('{"model":"sonnet"}'), { merge: true })).toBeNull()
    expect(readFileSync(join(h, '.claude', 'settings.json.bak-profile-sync'), 'utf8')).toBe(own)
    expect(t.write('default', 'settings.json', Buffer.from('{"model":"haiku"}'), { merge: true })).toBeNull()
    // the copy is of the file as it was before the first merge
    expect(readFileSync(join(h, '.claude', 'settings.json.bak-profile-sync'), 'utf8')).toBe(own)
    expect(JSON.parse(readFileSync(join(h, '.claude', 'settings.json'), 'utf8'))).toEqual({
      env: { ANTHROPIC_API_KEY: 'mine' },
      model: 'haiku',
    })
    expect(readdirSync(join(h, '.claude')).some(f => f.endsWith('.agent-board-sync'))).toBe(false)
    expect(t.finish().skipped).toEqual([{ profile: 'work', rel: '.claude.json', why: 'unreadable' }])
    expect(Object.keys(readSynced('pc2').work ?? {})).toEqual([])
  })

  test('the target: nothing written or deleted that changed since Look, nothing over its copy cut, its modes kept', () => {
    const { home: h } = home('target3')
    const at = (rel: string): string => join(h, '.claude', ...rel.split('/'))
    put(at('agents/a.md'), 'a there\n')
    put(at('agents/b.md'), 'b there\n')
    put(at('agents/c.md'), 'c there\n')
    put(at('agents/d.md'), 'd there\n')
    if (posix) chmodSync(at('agents/a.md'), 0o644)
    const t = openTarget({ peer: 'pc3', home: h, platform: process.platform, profiles: [], allow: NONE })
    // changed since Look (its hash then was another): kept, listed
    expect(
      t.write('default', 'agents/b.md', Buffer.from('b new\n'), { merge: false, expect: sha('b at look\n') }),
    ).toBe('changed')
    // none there at Look, one there now
    expect(t.write('default', 'agents/c.md', Buffer.from('c new\n'), { merge: false, expect: null })).toBe('changed')
    // as at Look: written, its mode kept
    expect(
      t.write('default', 'agents/a.md', Buffer.from('a new\n'), { merge: false, expect: sha('a there\n') }),
    ).toBeNull()
    expect(readFileSync(at('agents/a.md'), 'utf8')).toBe('a new\n')
    if (posix) expect(statSync(at('agents/a.md')).mode & 0o777).toBe(0o644)
    // a secret cut from it, and the target has its own: kept; none there: written, 0600, or 0700 with its execute bit
    expect(
      t.write('default', 'agents/d.md', Buffer.from('d cut\n'), { merge: false, expect: sha('d there\n'), cut: true }),
    ).toBe('cut')
    expect(
      t.write('default', 'agents/e.md', Buffer.from('e cut\n'), { merge: false, expect: null, cut: true }),
    ).toBeNull()
    expect(
      t.write('default', 'bin/x.sh', Buffer.from('#!/bin/sh\n'), { merge: false, expect: null, exec: true }),
    ).toBeNull()
    if (posix) {
      expect(statSync(at('agents/e.md')).mode & 0o777).toBe(0o600)
      expect(statSync(at('bin/x.sh')).mode & 0o777).toBe(0o700)
    }
    // a hook's script, the hooks not ticked: not written
    expect(t.write('default', 'hooks/y.sh', Buffer.from('echo\n'), { merge: false, expect: null })).toBe('group')
    // session history not ticked: neither written nor deleted
    expect(t.write('default', 'history.jsonl', Buffer.from('{"display":"x"}\n'), { merge: true })).toBe('group')
    expect(t.write('default', 'projects/p/s.jsonl', Buffer.from('{}\n'), { merge: false, expect: null })).toBe('group')
    // a deletion of a file changed since Look: kept
    expect(t.remove('default', 'agents/b.md', sha('b at look\n'))).toBe('changed')
    expect(t.remove('default', 'agents/c.md', sha('c there\n'))).toBeNull()
    expect(existsSync(at('agents/b.md'))).toBe(true)
    expect(existsSync(at('agents/c.md'))).toBe(false)
    const { skipped } = t.finish()
    expect(skipped.map(s => [s.rel, s.why])).toEqual([
      ['agents/b.md', 'changed'],
      ['agents/c.md', 'changed'],
      ['agents/d.md', 'cut'],
      ['hooks/y.sh', 'group'],
      ['history.jsonl', 'group'],
      ['projects/p/s.jsonl', 'group'],
      ['agents/b.md', 'changed'],
    ])
    expect(Object.keys(readSynced('pc3').default ?? {}).sort()).toEqual(['agents/a.md', 'agents/e.md', 'bin/x.sh'])
    // finished twice: the same
    expect(t.finish().skipped.length).toBe(7)
  })

  test('the target: the groups not ticked never merged into its settings, whatever the source sent; its BOM kept', () => {
    const { home: h } = home('target4')
    const bom = '﻿'
    put(join(h, '.claude', 'settings.json'), `${bom}{"env":{"A":"1"},"model":"opus"}`)
    const t = openTarget({ peer: 'pc4', home: h, platform: process.platform, profiles: [], allow: NONE })
    const sent = {
      env: { A: '2', NODE: 'x' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl evil' }] }] },
      statusLine: { type: 'command', command: 'evil' },
      enabledPlugins: { 'evil@m': true },
      model: 'sonnet',
    }
    expect(t.write('default', 'settings.json', Buffer.from(JSON.stringify(sent)), { merge: true })).toBeNull()
    const text = readFileSync(join(h, '.claude', 'settings.json'), 'utf8')
    expect(text.startsWith(bom)).toBe(true)
    expect(JSON.parse(text.slice(1))).toEqual({ env: { A: '1' }, model: 'sonnet' })
    t.finish()
  })

  if (process.platform === 'win32' || process.platform === 'darwin')
    test('the target that tells no case apart: a name in another case is the file there, never written over', () => {
      const { home: h } = home('target5')
      put(join(h, '.claude', 'agents', 'X.md'), 'X there\n')
      const t = openTarget({ peer: 'pc5', home: h, platform: process.platform, profiles: [], allow: NONE })
      expect(t.write('default', 'agents/x.md', Buffer.from('x new\n'), { merge: false, expect: null })).toBe('changed')
      expect(readFileSync(join(h, '.claude', 'agents', 'X.md'), 'utf8')).toBe('X there\n')
      t.finish()
    })
})

describe('the frames', () => {
  test('read back whole from pieces of any size', () => {
    const big = Buffer.alloc(300_000, 7)
    const bytes = Buffer.concat([frame({ t: 'a' }), frame({ t: 'file', to: 'x' }, big), frame({ t: 'end' })])
    for (const step of [1, 3, 4096, 70_000, bytes.length]) {
      const r = new FrameReader()
      const got = []
      for (let at = 0; at < bytes.length; at += step) got.push(...r.push(bytes.subarray(at, at + step)))
      expect(got.map(f => [f.head.t, f.body.length])).toEqual([
        ['a', 0],
        ['file', 300_000],
        ['end', 0],
      ])
      expect(got[1]?.body.equals(big)).toBe(true)
    }
  })

  test('sent gzipped and read through gunzip', async () => {
    const pipe = new PassThrough()
    const sink = frameSink(pipe)
    const reading = (async () => {
      const out = []
      for await (const f of framesOf(pipe.pipe(createGunzip()))) out.push(f)
      return out
    })()
    await sink.send({ op: 'scan', v: 1 })
    await sink.send({ t: 'file' }, Buffer.from('hello'))
    await sink.end()
    const got = await reading
    expect(got.map(f => [f.head.op ?? f.head.t, f.body.toString()])).toEqual([
      ['scan', ''],
      ['file', 'hello'],
    ])
  })
})
