// Settings → Threads (#410): editThreads into config.json under its lock, the section's other
// fields and every other key kept; POST /api/threads-settings taken while threads are off and on
// the computer only, the skill copied where the install action puts it (temporary profile folders
// only); the payload's line, the same as before for `"threads": true`, read back as the mode the
// menu checks; and a running board following it.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configFile, editThreads } from '../../src/adapters/config-file.ts'
import { useLanguage } from '../../src/core/lang.ts'
import type { Profile } from '../../src/core/profiles.ts'
import { THREADS_SKILL } from '../../src/core/setup.ts'
import { dispatch } from '../../src/server/http.ts'
import { revStream, type ThreadsApp, threadsRoutes } from '../../src/server/routes/threads.ts'
import { remoteRefusal } from '../../src/server/streams.ts'
import { installThreadsSkill } from '../../src/services/profiles.ts'
import { threadsPayload } from '../../src/services/work-threads.ts'
import { threadsNow } from '../../web/src/models/settings-menu.ts'
import { serveBoard } from '../support/board-server.ts'
import { isolatedHome } from '../support/env.ts'
import { fakeWake } from '../support/fake-wake.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

const SKILL_TEXT = readFileSync(join(root, 'skills', THREADS_SKILL, 'SKILL.md'), 'utf8')
const STATE = { port: 12422, token: '', stale: () => false }

/** Waits until `fn` (awaited) holds: sandbox.ts's until takes a promise for true. */
async function until(fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

const config = (): Record<string, unknown> => JSON.parse(readFileSync(configFile(), 'utf8'))
function writeConfig(raw: Record<string, unknown>): void {
  mkdirSync(join(configFile(), '..'), { recursive: true })
  writeFileSync(configFile(), JSON.stringify(raw))
}

test('each mode into config.json: off takes the key out, mine is agents false, agents is true', () => {
  isolatedHome()
  useLanguage('en')
  writeConfig({ language: 'en', todos: true })
  expect(editThreads({ mode: 'agents' })).toEqual({ ok: true, on: true })
  expect(config().threads).toBe(true)
  expect(editThreads({ mode: 'mine' })).toEqual({ ok: true, on: true })
  expect(config().threads).toEqual({ agents: false })
  expect(editThreads({ mode: 'none' })).toEqual({ ok: true, on: false })
  expect('threads' in config()).toBe(false)
  // Every other key as it was.
  expect(config()).toEqual({ language: 'en', todos: true })
})

test("the section's other fields stay; sharing changes threads that are on and is refused while off", () => {
  isolatedHome()
  useLanguage('en')
  writeConfig({ language: 'en', threads: { events: { gapSec: 30 }, future: 1 }, team: { hub: 'h', name: 'anna' } })
  expect(editThreads({ mode: 'mine' }).ok).toBe(true)
  expect(config().threads).toEqual({ events: { gapSec: 30 }, future: 1, agents: false })
  expect(editThreads({ share: false }).ok).toBe(true)
  expect(config().threads).toEqual({ events: { gapSec: 30 }, future: 1, agents: false, share: false })
  expect(editThreads({ mode: 'agents' }).ok).toBe(true)
  expect(config().threads).toEqual({ events: { gapSec: 30 }, future: 1, share: false })
  expect(editThreads({ share: true }).ok).toBe(true)
  expect(config().threads).toEqual({ events: { gapSec: 30 }, future: 1 })
  expect(config().team).toEqual({ hub: 'h', name: 'anna' })
  // `"threads": true` with sharing off becomes an object, and back.
  writeConfig({ threads: true })
  expect(editThreads({ share: false }).ok).toBe(true)
  expect(config().threads).toEqual({ share: false })
  expect(editThreads({ share: true }).ok).toBe(true)
  expect(config().threads).toBe(true)
  // Off: sharing alone is refused, the file as it was; so is anything that is not a setting.
  writeConfig({ threads: false, language: 'en' })
  const before = readFileSync(configFile(), 'utf8')
  expect(editThreads({ share: true })).toEqual({ ok: false, error: 'Threads are off (config.json: "threads")' })
  for (const body of [{ mode: 'all' }, { share: 'yes' }, {}, null])
    expect(editThreads(body)).toEqual({ ok: false, error: 'Not a threads setting' })
  expect(readFileSync(configFile(), 'utf8')).toBe(before)
})

test("under config.json's lock: while another writer holds it, refused in words and nothing written", () => {
  isolatedHome()
  useLanguage('en')
  writeConfig({ language: 'en' })
  const saved = process.env.BOARD_LOCK_TIMEOUT_MS
  process.env.BOARD_LOCK_TIMEOUT_MS = '100'
  mkdirSync(`${configFile()}.lock`)
  try {
    expect(editThreads({ mode: 'agents' })).toEqual({
      ok: false,
      error:
        'config.json is being changed by another process, or one stopped while changing it: try again in a moment (a lock left behind goes after 30 seconds).',
    })
    expect(config()).toEqual({ language: 'en' })
  } finally {
    if (saved === undefined) delete process.env.BOARD_LOCK_TIMEOUT_MS
    else process.env.BOARD_LOCK_TIMEOUT_MS = saved
  }
})

/** The routes with config.json's threads as the live config has them, and the skill into `profiles`. */
function routesWith(profiles: Profile[]) {
  const cfg: { threads?: unknown } = {}
  let skills = 0
  const app: ThreadsApp = {
    cfg,
    changed() {},
    tell: async () => ({ ok: true }),
    clearAsk() {},
    skill: () => {
      skills++
      installThreadsSkill(profiles)
    },
  }
  const routes = threadsRoutes(app, revStream())
  const post = async (
    body: unknown,
    headers: Record<string, string> = { 'x-board': '1' },
    path = '/api/threads-settings',
  ) => {
    const url = new URL(`http://127.0.0.1:12422${path}`)
    const req = new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    const res = await dispatch(routes, req, url, url.pathname, STATE)
    // The running board reads config.json again, as liveConfig does.
    cfg.threads = JSON.parse(readFileSync(configFile(), 'utf8')).threads
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { post, skills: () => skills }
}

test('the route: taken while off; on copies the skill into the shown profiles; off and on again do not duplicate it', async () => {
  const home = isolatedHome()
  useLanguage('en')
  writeConfig({ language: 'en' })
  const dir = (name: string) => join(home, name)
  mkdirSync(dir('.claude-work'))
  mkdirSync(dir('.claude-gamedev'))
  const profiles: Profile[] = [
    { id: 'default', title: 'Private', dir: dir('.claude'), color: 'indigo', hidden: false },
    { id: 'work', title: 'Work', dir: dir('.claude-work'), color: 'teal', hidden: false },
    { id: 'gamedev', title: 'Gamedev', dir: dir('.claude-gamedev'), color: 'pink', hidden: true },
    { id: 'old', title: 'Old', dir: dir('.claude-old'), color: 'brown', hidden: false },
  ]
  const { post, skills } = routesWith(profiles)
  const skillIn = (name: string) => join(dir(name), 'skills', THREADS_SKILL, 'SKILL.md')

  // Without X-Board: refused, nothing written.
  expect((await post({ mode: 'agents' }, {})).status).toBe(403)
  expect('threads' in config()).toBe(false)
  // The threads routes while off are refused as before, a setting sent there too.
  expect((await post({ op: 'new', lane: 'atlas', title: 'x' }, undefined, '/api/threads')).status).toBe(409)
  expect((await post({ op: 'settings', mode: 'agents' }, undefined, '/api/threads')).status).toBe(409)
  expect('threads' in config()).toBe(false)

  expect(await post({ mode: 'agents' })).toEqual({ status: 200, body: { ok: true } })
  expect(config().threads).toBe(true)
  // Where the install action puts it: the default folder made, a shown one that is there; not a
  // hidden profile, not a folder that is not there.
  expect(readFileSync(skillIn('.claude'), 'utf8')).toBe(SKILL_TEXT)
  expect(readFileSync(skillIn('.claude-work'), 'utf8')).toBe(SKILL_TEXT)
  expect(existsSync(join(dir('.claude-gamedev'), 'skills'))).toBe(false)
  expect(existsSync(dir('.claude-old'))).toBe(false)
  const written = statSync(skillIn('.claude-work')).mtimeMs

  // Off: the key goes, the skill stays (the install action does not take it out either).
  expect(await post({ mode: 'none' })).toEqual({ status: 200, body: { ok: true } })
  expect('threads' in config()).toBe(false)
  expect(existsSync(skillIn('.claude-work'))).toBe(true)
  expect(skills()).toBe(1)

  // On again: the one copy, not written again.
  await Bun.sleep(20)
  expect((await post({ mode: 'mine' })).status).toBe(200)
  expect(config().threads).toEqual({ agents: false })
  expect(readdirSync(join(dir('.claude-work'), 'skills'))).toEqual([THREADS_SKILL])
  expect(readdirSync(join(dir('.claude-work'), 'skills', THREADS_SKILL))).toEqual(['SKILL.md'])
  expect(statSync(skillIn('.claude-work')).mtimeMs).toBe(written)

  // Someone else's skill of that name stays.
  writeFileSync(skillIn('.claude-work'), '---\nname: agent-board-threads\n---\nmine\n')
  expect((await post({ mode: 'agents' })).status).toBe(200)
  expect(readFileSync(skillIn('.claude-work'), 'utf8')).toContain('mine')

  // A setting the board does not know: 400, the file as it was.
  const before = readFileSync(configFile(), 'utf8')
  expect((await post({ mode: 'all' })).status).toBe(400)
  expect(readFileSync(configFile(), 'utf8')).toBe(before)
})

test("the payload's line: `true` and a section of other fields as before; mine and local said only then", () => {
  isolatedHome()
  expect(threadsPayload({})).toBeNull()
  expect(threadsPayload({ threads: false })).toBeNull()
  expect(JSON.stringify(threadsPayload({ threads: true }))).toBe('{"rev":0,"needsOwner":0}')
  expect(JSON.stringify(threadsPayload({ threads: { events: { gapSec: 5 } } }))).toBe('{"rev":0,"needsOwner":0}')
  expect(threadsPayload({ threads: { agents: false } })).toEqual({ rev: 0, needsOwner: 0, agents: false })
  expect(threadsPayload({ threads: { share: false } })).toEqual({ rev: 0, needsOwner: 0, share: false })
  // What the menu checks, read back from each: the mode written, and with Team on its sharing.
  const read = (threads: unknown, teamRev?: number) =>
    threadsNow({ threads: threadsPayload({ threads }) ?? undefined, ...(teamRev !== undefined && { teamRev }) })
  for (const mode of ['none', 'mine', 'agents'] as const) {
    writeConfig({})
    editThreads({ mode })
    expect(read(config().threads)).toEqual({ mode })
  }
  editThreads({ mode: 'mine' })
  editThreads({ share: false })
  expect(read(config().threads, 4)).toEqual({ mode: 'mine', share: false })
  expect(read(true, 4)).toEqual({ mode: 'agents', share: true })
})

test('the setting stays on the computer: every remote listener refuses it, the owner’s own login too', () => {
  for (const owner of [false, true]) {
    expect(remoteRefusal('/api/threads-settings', '/api/threads-settings', false, owner, owner)?.status).toBe(403)
    // The threads themselves stay as they were: the owner's own login reaches them.
    expect(remoteRefusal('/api/threads', '/api/threads', false, owner, owner)?.status ?? 200).toBe(owner ? 200 : 403)
  }
})

/** A sandbox whose home has these profile folders. */
async function boardWith(folders: string[]): Promise<Sandbox> {
  const box = await sandbox()
  for (const name of folders) {
    mkdirSync(join(box.dir, 'home', name), { recursive: true })
    writeFileSync(join(box.dir, 'home', name, 'settings.json'), '{}')
  }
  box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  return box
}

test('a running board: on from Settings, the payload carries the line and the profiles the skill; off, the line goes', async () => {
  const box = await boardWith(['.claude', '.claude-work'])
  const wake = await fakeWake()
  try {
    const home = join(box.dir, 'home')
    const profiles = [
      { id: 'default', title: 'Private', dir: join(home, '.claude'), color: 'indigo', hidden: false },
      { id: 'work', title: 'Work', dir: join(home, '.claude-work'), color: 'teal', hidden: false },
    ]
    const cfg = { language: 'en', wakeUrl: wake.url, profiles }
    // The board reads config.json as it changes, as the real one does (TEST_LIVE_CONFIG).
    const file = join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(cfg))
    const { url, proc } = await serveBoard(box, cfg, { TEST_LIVE_CONFIG: '1' })
    const board = async () => (await (await fetch(`${url}/api/board`)).json()) as Record<string, unknown>
    const settings = (body: Record<string, unknown>) =>
      fetch(`${url}/api/threads-settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-board': '1' },
        body: JSON.stringify(body),
      })
    const line = async (): Promise<unknown> => {
      proc.send('refresh')
      await Bun.sleep(50)
      return (await board()).threads
    }
    expect('threads' in (await board())).toBe(false)

    expect((await settings({ mode: 'mine' })).status).toBe(200)
    await until(async () => JSON.stringify(await line()) === '{"rev":0,"needsOwner":0,"agents":false}')
    for (const name of ['.claude', '.claude-work'])
      expect(readFileSync(join(home, name, 'skills', THREADS_SKILL, 'SKILL.md'), 'utf8')).toBe(SKILL_TEXT)

    expect((await settings({ mode: 'none' })).status).toBe(200)
    await until(async () => (await line()) === undefined)
    expect(existsSync(join(home, '.claude-work', 'skills', THREADS_SKILL, 'SKILL.md'))).toBe(true)
  } finally {
    wake.down()
  }
}, 30_000)
