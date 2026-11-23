// The target's half of a move to another device (#616 part 2, services/move-in.ts), with real git:
// a checkout here that the session left from (the master's case), its remote a bare repository of
// the test. The changes that come are written in it last and taken out again when the resume does
// not start, so the next try finds it clean; a file that becomes a folder is deleted first; check()
// changes nothing in a checkout; a file of the checkout's own that git does not show is never written over.
import { beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeCard } from '../../src/adapters/cards.ts'
import type { MovePack } from '../../src/core/move-device.ts'
import { createMoveIn, defaultMoveRepo, type MoveIn } from '../../src/services/move-in.ts'
import { isolatedHome } from '../support/env.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const ENV = {
  GIT_AUTHOR_NAME: 'Anna',
  GIT_AUTHOR_EMAIL: 'anna@example.com',
  GIT_COMMITTER_NAME: 'Anna',
  GIT_COMMITTER_EMAIL: 'anna@example.com',
}
let home = ''
let co = ''
let bare = ''
let started: unknown[] = []
let startOk = true

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, ...ENV } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

beforeEach(() => {
  home = isolatedHome()
  bare = join(home, 'remote.git')
  mkdirSync(bare)
  git(bare, 'init', '--bare', '--quiet', '-b', 'main')
  co = join(home, 'atlas')
  mkdirSync(co)
  git(co, 'init', '--quiet', '-b', 'feature-x')
  writeFileSync(join(co, 'README.md'), 'atlas\n')
  writeFileSync(join(co, 'foo'), 'a file\n')
  writeFileSync(join(co, '.gitignore'), '.env\n')
  git(co, 'add', '.')
  git(co, 'commit', '--quiet', '-m', 'first')
  git(co, 'remote', 'add', 'origin', bare)
  git(co, 'push', '--quiet', '-u', 'origin', 'feature-x')
  // The session left from here: its card says where.
  writeCard(S, { moved: { to: 'server-1', cwd: co, at: 1 } })
  started = []
  startOk = true
})

const head = (): string => git(co, 'rev-parse', 'HEAD')

function moveIn(): MoveIn {
  const dir = join(home, '.claude')
  mkdirSync(dir, { recursive: true })
  return createMoveIn({
    node: () => null,
    profiles: () => ({ list: [{ id: 'default', dir, title: 'Default', hidden: false }] }) as never,
    start: async (body, session) => {
      started.push({ body, session })
      return startOk ? { ok: true, id: 'L1' } : { ok: false, field: 'launch', error: 'herdr did not answer' }
    },
    launch: () => undefined,
    workspaces: async () => [],
    lanes: () => new Set(['atlas']),
    log: () => {},
    repo: {
      ...defaultMoveRepo(),
      // The remote is a folder of the test: its address is what the pack says.
      checkout: async d => (existsSync(d) ? { root: co, address: 'github.com/anna/atlas' } : null),
    },
  })
}

async function put(m: MoveIn, text: string): Promise<string> {
  const h = sha(text)
  const r = await m.put(h, new Response(text).body)
  if (!r.ok) throw new Error(r.why)
  return h
}

async function pack(m: MoveIn, changes: Record<string, string>, deleted: string[] = []): Promise<MovePack> {
  const t = await put(m, `${JSON.stringify({ cwd: '/elsewhere', sessionId: S })}\n`)
  const files: MovePack['files'] = [{ kind: 'transcript', path: '', size: 10, sha256: t, mode: 0o644 }]
  for (const [path, text] of Object.entries(changes))
    files.push({ kind: 'change', path, size: text.length, sha256: await put(m, text), mode: 0o644 })
  return {
    v: 1,
    session: S,
    name: 'Atlas',
    category: 'atlas',
    profile: 'default',
    workspace: 'Atlas',
    cwd: '/elsewhere',
    folder: {
      url: 'git@github.com:anna/atlas.git',
      address: 'github.com/anna/atlas',
      branch: 'feature-x',
      subdir: '',
      head: head(),
      deleted,
    },
    files,
    entries: [],
    trusted: false,
    from: 'server-1',
  }
}

test('a resume that does not start takes the changes out again: the next try finds the checkout clean', async () => {
  const m = moveIn()
  const p = await pack(m, { 'notes/a.md': 'note\n' }, ['README.md'])
  startOk = false
  const r = await m.commit(p)
  expect(r).toMatchObject({ ok: false, error: 'launch' })
  expect(git(co, 'status', '--porcelain')).toBe('')
  startOk = true
  const again = await m.commit(p)
  expect(again.ok).toBe(true)
  expect(readFileSync(join(co, 'notes', 'a.md'), 'utf8')).toBe('note\n')
  expect(existsSync(join(co, 'README.md'))).toBe(false)
})

test('a file that became a folder: the deletion goes first', async () => {
  const m = moveIn()
  const p = await pack(m, { 'foo/bar': 'inside\n' }, ['foo'])
  expect((await m.commit(p)).ok).toBe(true)
  expect(readFileSync(join(co, 'foo', 'bar'), 'utf8')).toBe('inside\n')
})

test('check() changes nothing in the checkout, even when the remote moved on; the commit fast-forwards', async () => {
  const m = moveIn()
  // Another clone pushes a commit: the checkout here is behind.
  const other = join(home, 'other')
  git(home, 'clone', '--quiet', '-b', 'feature-x', bare, other)
  writeFileSync(join(other, 'web.ts'), 'x\n')
  git(other, 'add', '.')
  git(other, 'commit', '--quiet', '-m', 'more')
  git(other, 'push', '--quiet')
  const before = head()
  const p = await pack(m, {})
  p.folder.head = git(other, 'rev-parse', 'HEAD')
  const c = await m.check(p)
  expect(c.ok).toBe(true)
  expect(head()).toBe(before)
  expect((await m.commit(p)).ok).toBe(true)
  expect(head()).toBe(p.folder.head)
})

test("a file of the checkout's own that git does not show is never written over", async () => {
  const m = moveIn()
  writeFileSync(join(co, '.env'), 'TOKEN=mine\n')
  const p = await pack(m, { '.env': 'TOKEN=theirs\n' })
  const r = await m.commit(p)
  expect(r).toMatchObject({ ok: false, error: 'repo' })
  expect(readFileSync(join(co, '.env'), 'utf8')).toBe('TOKEN=mine\n')
  expect(started).toEqual([])
})
