import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const GH = `ghp_${'a1B2'.repeat(9)}`
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
    })
    t.write('default', '.claude.json', Buffer.from(JSON.stringify({ theme: 'light', projects: {} })), true)
    t.write('default', 'settings.json', Buffer.from(JSON.stringify({ env: { B: '2' }, model: 'sonnet' })), true)
    t.write('new', 'CLAUDE.md', Buffer.from('# new\n'), false)
    t.write('default', 'skills/a/SKILL.md', Buffer.from('skill'), false)
    // merged even when it comes as a whole file
    t.write('default', '.claude.json', Buffer.from(JSON.stringify({ theme: 'light' })), false)
    for (const bad of ['.credentials.json', '../x', 'a/../../x', 'C:/x', 'sessions/1.json', '.claude.json.bak'])
      expect(() => t.write('default', bad, Buffer.from('x'), false)).toThrow()
    t.remove('default', 'CLAUDE.md')
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
