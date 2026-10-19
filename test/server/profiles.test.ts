// The Claude profiles on the web board's server: the folders found at its start, the Profiles
// panel's edits, and each session's records read from its own profile.
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { quote } from '../../src/core/install-plan.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import { isBoardPayload } from '../../web/src/api/client.ts'
import { serveBoard } from '../support/board-server.ts'
import { type Child, root, type Sandbox, sandbox, until } from '../support/sandbox.ts'

/** The sandbox's config.json, where the board keeps its settings. */
const configOf = (box: Sandbox): string =>
  join(box.env.APPDATA as string, 'herdr', 'plugins', 'config', 'agent-board', 'config.json')
const profilesIn = (box: Sandbox): Record<string, unknown>[] =>
  (JSON.parse(readFileSync(configOf(box), 'utf8')) as { profiles: Record<string, unknown>[] }).profiles

/** A sandbox whose home has these profile folders, each with its settings.json or projects/. */
async function boardWith(folders: Record<string, 'settings.json' | 'projects'>): Promise<Sandbox> {
  const box = await sandbox()
  for (const [name, holds] of Object.entries(folders)) {
    const dir = join(box.dir, 'home', name)
    mkdirSync(holds === 'projects' ? join(dir, 'projects') : dir, { recursive: true })
    if (holds === 'settings.json') writeFileSync(join(dir, 'settings.json'), '{}')
  }
  box.state({ 'api snapshot': { result: { snapshot: { panes: [], tabs: [], workspaces: [] } } } })
  return box
}

test('POST /api/profiles renames a profile; without X-Board it is refused', async () => {
  const box = await boardWith({ '.claude': 'settings.json' })
  const { url } = await serveBoard(box, { language: 'en' })
  const post = (body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
    fetch(`${url}/api/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  const renamed = await post({ op: 'update', id: 'default', title: 'Private' })
  expect(renamed.status).toBe(200)
  expect(await renamed.json()).toEqual({ ok: true })
  expect(profilesIn(box)).toEqual([expect.objectContaining({ id: 'default', title: 'Private', hidden: false })])
  expect((await post({ op: 'update', id: 'default', title: 'Other' }, {})).status).toBe(403)
  // It writes Claude's settings.json (Install): a page of another origin is refused, as for the launches.
  for (const body of [
    { op: 'update', id: 'default', title: 'Evil' },
    { op: 'install', id: 'default' },
  ]) {
    const foreign = await post(body, { 'x-board': '1', origin: 'http://evil.example' })
    expect([foreign.status, await foreign.json()]).toEqual([403, { error: 'origin' }])
  }
  expect(readFileSync(join(box.dir, 'home', '.claude', 'settings.json'), 'utf8')).toBe('{}')
  expect(existsSync(join(box.dir, 'home', '.claude', 'settings.json.bak-agent-board'))).toBe(false)
  expect(profilesIn(box).map(p => p.title)).toEqual(['Private'])
  // The board's own page passes.
  const own = await post({ op: 'update', id: 'default', title: 'Private' }, { 'x-board': '1', origin: url })
  expect(own.status).toBe(200)
  const missing = await post({ op: 'update', id: 'work', title: 'Work' })
  expect(missing.status).toBe(409)
  expect(await missing.json()).toEqual({ ok: false, error: 'No profile “work”' })
  expect(profilesIn(box).map(p => p.title)).toEqual(['Private'])
}, 20_000)

test('at its start the board keeps the folders found in its config.json, its own one shown', async () => {
  const box = await boardWith({ '.claude': 'settings.json', '.claude-work': 'projects', '.claude-gamedev': 'projects' })
  mkdirSync(join(configOf(box), '..'), { recursive: true })
  writeFileSync(configOf(box), JSON.stringify({ language: 'en', keep: 1 }))
  // A board in a pane of cld-work: Git Bash's ~ in the variable is the home folder.
  await serveBoard(box, { language: 'en' }, { CLAUDE_CONFIG_DIR: '~/.claude-work' })
  expect(profilesIn(box).map(p => [p.id, p.hidden])).toEqual([
    ['default', false],
    ['gamedev', true],
    ['work', false],
  ])
  expect((JSON.parse(readFileSync(configOf(box), 'utf8')) as { keep: unknown }).keep).toBe(1)
}, 20_000)

type Item = Record<string, unknown> & { key: string }
type Board = { items: Item[]; stale: boolean; lastSuccessfulRefreshAt: number | null }

function byKey(items: Item[], key: string): Item {
  const item = items.find(i => i.key === key)
  if (!item) throw new Error(`no item ${key}`)
  return item
}

test('items carry their profile; records come from that profile; hidden ones keep their title', async () => {
  const box = await boardWith({ '.claude': 'settings.json', '.claude-work': 'settings.json' })
  const home = join(box.dir, 'home')
  const work = join(home, '.claude-work')
  // The work profile's records: s1 runs there as "Work one", its transcript has Claude's title, and
  // an earlier session in its folder has a prompt the history search finds.
  mkdirSync(join(work, 'sessions'))
  writeFileSync(
    join(work, 'sessions', '1.json'),
    JSON.stringify({ sessionId: 's1', kind: 'interactive', pid: process.pid, name: 'Work one' }),
  )
  const project = join(work, 'projects', box.dir.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 's1.jsonl'), `${JSON.stringify({ type: 'ai-title', aiTitle: 'Invoices' })}\n`)
  const said = {
    type: 'user',
    cwd: box.dir,
    timestamp: '2026-10-18T09:00:00Z',
    message: { content: 'Book the invoices' },
  }
  writeFileSync(join(project, 's0.jsonl'), `${JSON.stringify(said)}\n`)
  // The cards as the hooks left them: s2 in a folder no profile has, s3 with none yet, s4 started
  // for default but reporting work.
  mkdirSync(box.cards, { recursive: true })
  const card = (key: string, fields: Record<string, unknown>) =>
    writeFileSync(join(box.cards, `${key}.json`), JSON.stringify({ key, ...fields }))
  card('s1', { profile: 'work', profileDir: work })
  card('s2', { profileDir: 'D:\\old\\.claude-x' })
  card('s4', { profile: 'work', profileDir: work, profileWant: 'default' })
  const panes = ['s1', 's2', 's3', 's4'].map((s, i) => ({
    pane_id: `p${i + 1}`,
    agent: 'claude',
    agent_session: { value: s },
    agent_status: 'idle',
    cwd: box.dir,
  }))
  box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } } })
  // The board reads config.json as it changes, as the real one does (TEST_LIVE_CONFIG).
  const cfg = {
    language: 'en',
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    wakeUrl: null,
    refreshSec: 3600,
    profiles: [
      { id: 'default', title: 'Default', dir: join(home, '.claude'), color: 'indigo', hidden: false },
      { id: 'work', title: 'Work', dir: work, color: 'teal', hidden: false },
    ],
  }
  mkdirSync(join(configOf(box), '..'), { recursive: true })
  writeFileSync(configOf(box), JSON.stringify(cfg))
  const { url, proc } = await serveBoard(box, cfg, { TEST_LIVE_CONFIG: '1' })
  /** The board as a refresh after `after` (ms) collected it. */
  const board = async (after = 0): Promise<Board> => {
    for (let i = 0; i < 100; i++) {
      const b = (await (await fetch(`${url}/api/board`)).json()) as Board
      if (!b.stale && b.items.length === 4 && (b.lastSuccessfulRefreshAt ?? 0) > after) return b
      proc.send('refresh')
      await Bun.sleep(50)
    }
    throw new Error('the board did not refresh')
  }

  const items = (await board()).items
  expect(byKey(items, 's1')).toMatchObject({ profile: 'work', name: 'Work one', title: 'Invoices' })
  expect(byKey(items, 's2')).toMatchObject({ profile: null, profileFolder: 'D:\\old\\.claude-x' })
  expect(byKey(items, 's3').profile).toBeNull()
  expect(byKey(items, 's4').profileWanted).toBe('default')
  expect(items.some(i => 'claudeRoot' in i)).toBe(false)
  // The session's detail leaves the folder out too; its history is searched in its own profile.
  const detail = (await (await fetch(`${url}/api/session/s1`)).json()) as { item: Item }
  expect(detail.item).toMatchObject({ key: 's1', profile: 'work' })
  expect('claudeRoot' in detail.item).toBe(false)
  const history = (await (await fetch(`${url}/api/session/s3/history?q=invoices`)).json()) as { unavailable?: true }
  expect(history.unavailable).toBe(true) // s3 is no work session: the default profile has no such project
  const found = (await (await fetch(`${url}/api/session/s1/history?q=invoices`)).json()) as {
    results: { text: string }[]
  }
  expect(found.results.map(r => r.text)).toEqual(['Book the invoices'])

  // Hidden: out of the switch and the launch choices, but its running sessions keep their records.
  const reloads = () => proc.messages.filter(m => (m as { reloaded?: boolean }).reloaded).length
  const before = reloads()
  const hide = await fetch(`${url}/api/profiles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'update', id: 'work', hidden: true }),
  })
  expect(hide.status).toBe(200)
  expect(profilesIn(box).map(p => [p.id, p.hidden])).toEqual([
    ['default', false],
    ['work', true],
  ])
  await until(() => reloads() > before)
  const hidden = (await board(Date.now())).items
  expect(byKey(hidden, 's1')).toMatchObject({ profile: 'work', name: 'Work one', title: 'Invoices' })
}, 30_000)

test('Install from the board writes a shown profile’s hooks and refuses a hidden one', async () => {
  const box = await boardWith({
    '.claude': 'settings.json',
    '.claude-work': 'settings.json',
    '.claude-gamedev': 'settings.json',
  })
  const home = join(box.dir, 'home')
  const dir = (name: string): string => join(home, name)
  const profiles = [
    { id: 'default', title: 'Private', dir: dir('.claude'), color: 'indigo', hidden: false },
    { id: 'work', title: 'Work', dir: dir('.claude-work'), color: 'teal', hidden: false },
    { id: 'gamedev', title: 'Gamedev', dir: dir('.claude-gamedev'), color: 'pink', hidden: true },
    { id: 'old', title: 'Old', dir: dir('.claude-old'), color: 'brown', hidden: false },
  ]
  const { url } = await serveBoard(box, { language: 'en', profiles })
  const post = (body: unknown, headers: Record<string, string> = { 'x-board': '1' }) =>
    fetch(`${url}/api/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  const ours = {
    hooks: [
      {
        type: 'command',
        command: `${quote(process.execPath)} ${quote(join(root, 'src', 'entrypoints', 'hook.ts'))}`,
        timeout: 10,
      },
    ],
  }

  const installed = await post({ op: 'install', id: 'work' })
  expect(installed.status).toBe(200)
  expect(await installed.json()).toEqual({ ok: true })
  const work = JSON.parse(readFileSync(join(dir('.claude-work'), 'settings.json'), 'utf8'))
  expect(work.hooks.SessionStart.at(-1)).toEqual(ours)
  expect(work.hooks.UserPromptSubmit).toEqual([ours])
  expect(readFileSync(join(dir('.claude-work'), 'settings.json.bak-agent-board'), 'utf8')).toBe('{}')
  // Only that profile's folder.
  expect(readdirSync(dir('.claude'))).toEqual(['settings.json'])

  const hidden = await post({ op: 'install', id: 'gamedev' })
  expect(hidden.status).toBe(409)
  expect(await hidden.json()).toEqual({
    ok: false,
    error: 'Show Gamedev first: the board installs only into shown profiles',
  })
  expect(readdirSync(dir('.claude-gamedev'))).toEqual(['settings.json'])
  expect(readFileSync(join(dir('.claude-gamedev'), 'settings.json'), 'utf8')).toBe('{}')

  const gone = await post({ op: 'install', id: 'old' })
  expect(gone.status).toBe(409)
  expect(await gone.json()).toEqual({ ok: false, error: `There is no folder ${dir('.claude-old')}` })
  expect(existsSync(dir('.claude-old'))).toBe(false)
  const unknown = await post({ op: 'install', id: 'nope' })
  expect(await unknown.json()).toEqual({ ok: false, error: 'No profile “nope”' })
  expect((await post({ op: 'install', id: 'default' }, {})).status).toBe(403)
  expect(readdirSync(dir('.claude'))).toEqual(['settings.json'])
}, 20_000)

test('Install from the panel shows at once: the board goes out with the hooks there, and the setup check runs again', async () => {
  const box = await boardWith({ '.claude': 'settings.json', '.claude-work': 'settings.json' })
  const home = join(box.dir, 'home')
  const { url } = await serveBoard(box, {
    language: 'en',
    profiles: [
      { id: 'default', title: 'Private', dir: join(home, '.claude'), color: 'indigo', hidden: false },
      { id: 'work', title: 'Work', dir: join(home, '.claude-work'), color: 'teal', hidden: false },
    ],
  })
  type Payload = { profiles: { id: string; hooks: boolean | null }[]; setup: { sig: string } | null }
  const latest = async (): Promise<Payload> => (await (await fetch(`${url}/api/board`)).json()) as Payload
  const hooksOf = (b: Payload, id: string) => b.profiles.find(p => p.id === id)?.hooks
  /** The board as it last went out, once `done` says so (no refresh runs by itself here: refreshSec 3600). */
  const once = async (done: (b: Payload) => boolean): Promise<Payload> => {
    for (let i = 0; i < 250; i++) {
      const b = await latest()
      if (done(b)) return b
      await Bun.sleep(20)
    }
    throw new Error(`the board did not go out so: ${JSON.stringify(await latest())}`)
  }
  // The check at the start: "Setup incomplete" names work's hooks.
  await once(b => (b.setup?.sig ?? '').includes('hooks:work:error'))
  expect(hooksOf(await latest(), 'work')).toBe(false)

  const installed = await fetch(`${url}/api/profiles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ op: 'install', id: 'work' }),
  })
  expect(await installed.json()).toEqual({ ok: true })
  // At once: the panel's note goes.
  const after = await latest()
  expect([hooksOf(after, 'work'), hooksOf(after, 'default')]).toEqual([true, false])
  // Then the check, run again in a moment, no longer names work: the note does not wait 10 minutes.
  const checked = await once(b => !(b.setup?.sig ?? '').includes(':work:'))
  expect(checked.setup?.sig).toContain('hooks:default:error')
}, 20_000)

test('a pane record herdr no longer has is dropped at the next refresh', async () => {
  const box = await boardWith({ '.claude': 'settings.json', '.claude-work': 'settings.json' })
  const file = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'profile-panes.json')
  mkdirSync(join(file, '..'), { recursive: true })
  const p1 = { profile: 'work', terminal: 'term-1', at: 1, by: 'board' }
  // A record written while the refresh was asking herdr: its pane is not in that answer yet.
  const fresh = { profile: 'work', terminal: 'term-3', at: Date.now() + 3_600_000 }
  writeFileSync(
    file,
    JSON.stringify({
      gone: { profile: 'work', terminal: 'term-0', at: 1 },
      p1,
      p2: { profile: 'work', terminal: 'term-old', at: 1 }, // herdr gave the id to another terminal
      fresh,
    }),
  )
  const panes = [
    { pane_id: 'p1', terminal_id: 'term-1' },
    { pane_id: 'p2', terminal_id: 'term-2' },
  ]
  box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } } })
  const { proc } = await serveBoard(box, { language: 'en' })
  // The refresh at its start may still be on its way: the one asked for then runs after it.
  proc.send('refresh')
  const left = (): string => {
    try {
      return Object.keys(JSON.parse(readFileSync(file, 'utf8')) as object)
        .sort()
        .join()
    } catch {
      return '' // read while it was being replaced
    }
  }
  await until(() => left() === 'fresh,p1')
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ p1, fresh })
}, 20_000)

test('the Wake button and Go to herdr refuse a work session started outside the board; herdr-wake is not asked', async () => {
  const box = await boardWith({ '.claude': 'settings.json', '.claude-work': 'settings.json' })
  const home = join(box.dir, 'home')
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(join(box.cards, 's1.json'), JSON.stringify({ key: 's1', profileDir: join(home, '.claude-work') }))
  // herdr-wake put s1 to sleep in p1, a plain terminal now.
  box.state({
    'api snapshot': {
      result: { snapshot: { panes: [{ pane_id: 'p1', terminal_id: 'term-1' }], tabs: [], workspaces: [] } },
    },
    'agent focus': { result: null },
  })
  let wakes = 0
  const wake = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/sleeping') return res.end(JSON.stringify([{ session: 's1', pane: 'p1', name: 'Sleepy' }]))
    if (req.url === '/wake') wakes++
    res.end('{"ok":true}')
  })
  await new Promise<void>(resolve => wake.listen(0, '127.0.0.1', resolve))
  try {
    const { url } = await serveBoard(box, {
      language: 'en',
      wakeUrl: `http://127.0.0.1:${(wake.address() as AddressInfo).port}`,
      profiles: [
        { id: 'default', title: 'Default', dir: join(home, '.claude'), color: 'indigo', hidden: false },
        { id: 'work', title: 'Work', dir: join(home, '.claude-work'), color: 'teal', hidden: false },
      ],
    })
    const post = async (path: string) => {
      const res = await fetch(`${url}${path}`, { method: 'POST', headers: { 'x-board': '1' }, body: '{}' })
      return [res.status, await res.json()]
    }
    // The board has the sleeper, its card saying work.
    for (let i = 0; ; i++) {
      const b = (await (await fetch(`${url}/api/board`)).json()) as Board
      if (b.items.some(it => it.key === 's1' && it.sleeping && it.profile === 'work')) break
      if (i > 100) throw new Error('the board did not show the sleeper')
      await Bun.sleep(50)
    }
    const refused = {
      ok: false,
      error:
        'Started outside the board in profile Work, so waking could resume it in the wrong account; wake it in herdr where you started it',
    }
    expect(await post('/api/session/s1/wake')).toEqual([409, refused])
    expect(await post('/api/session/s1/focus')).toEqual([409, refused])
    expect(wakes).toBe(0)
    // The board opened p1 in work, and herdr shows it still holds that terminal: woken.
    const file = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board', 'profile-panes.json')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ p1: { profile: 'work', terminal: 'term-1', at: 1 } }))
    expect(await post('/api/session/s1/wake')).toEqual([200, { ok: true }])
    expect(wakes).toBe(1)
  } finally {
    await new Promise(resolve => wake.close(resolve))
  }
}, 20_000)

/** A usage reading as the status line and the usagebar write it: the 5-hour window `used` % full. */
const reading = (used: number): string =>
  JSON.stringify({
    fetchedAtMs: Date.now() - 60_000,
    fiveHour: { usedPercentage: used },
    sevenDay: { usedPercentage: 10 },
  })

/** The board once a refresh after `after` (ms) collected `n` sessions, checked as the page checks it. */
async function boardOf(url: string, proc: Child, n: number, after = 0): Promise<BoardPayload> {
  for (let i = 0; i < 100; i++) {
    const body: unknown = await (await fetch(`${url}/api/board`)).json()
    if (!isBoardPayload(body)) throw new Error('the page would not take the board')
    if (!body.stale && body.items.length === n && (body.lastSuccessfulRefreshAt ?? 0) > after) return body
    proc.send('refresh')
    await Bun.sleep(50)
  }
  throw new Error('the board did not refresh')
}

test('the board sends every profile with its usage, sessions, hooks and folder, and the page’s check takes it', async () => {
  const box = await boardWith({ '.claude': 'settings.json', '.claude-work': 'settings.json' })
  const home = join(box.dir, 'home')
  const own = join(home, '.claude')
  const work = join(home, '.claude-work')
  // The board's hooks are in work's settings.json, not in default's.
  const ours = {
    hooks: [
      { type: 'command', command: `${quote(process.execPath)} ${quote(join(root, 'src', 'entrypoints', 'hook.ts'))}` },
    ],
  }
  writeFileSync(
    join(work, 'settings.json'),
    JSON.stringify({ hooks: { SessionStart: [ours], UserPromptSubmit: [ours] } }),
  )
  // The status line's readings, each profile's in its own file; work's usagebar cache too, which its
  // status line's reading beats.
  const state = join(box.env.LOCALAPPDATA as string, 'herdr', 'plugins', 'agent-board')
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'claude-limits-latest.json'), reading(20))
  writeFileSync(join(state, 'claude-limits-profile-work.json'), reading(60))
  mkdirSync(join(work, 'herdr-usagebar'))
  writeFileSync(join(work, 'herdr-usagebar', 'claude-limits-latest.json'), reading(99))
  // Three sessions whose hooks reported default, default and work.
  mkdirSync(box.cards, { recursive: true })
  const dirs = [own, own, work]
  for (const [i, dir] of dirs.entries())
    writeFileSync(join(box.cards, `s${i + 1}.json`), JSON.stringify({ key: `s${i + 1}`, profileDir: dir }))
  const panes = dirs.map((_, i) => ({
    pane_id: `p${i + 1}`,
    agent: 'claude',
    agent_session: { value: `s${i + 1}` },
    agent_status: 'idle',
    cwd: box.dir,
  }))
  box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } } })
  const { url, proc } = await serveBoard(box, {
    language: 'en',
    profiles: [
      { id: 'default', title: 'Private', dir: own, color: 'indigo', hidden: false },
      { id: 'work', title: 'Work', dir: work, color: 'teal', hidden: false },
    ],
  })

  const body = await boardOf(url, proc, 3)
  const profiles = body.profiles ?? []
  expect(profiles.map(p => [p.id, p.hidden, p.inherited, p.exists, p.sessions])).toEqual([
    ['default', false, true, true, 2],
    ['work', false, false, true, 1],
  ])
  expect(profiles.map(p => [p.title, p.color, p.colorName, p.dir, p.hooks])).toEqual([
    ['Private', '#5856D6', 'indigo', own, false],
    ['Work', '#30B0C7', 'teal', work, true],
  ])
  expect(profiles.map(p => [p.limits?.source, p.limits?.windows.map(w => w.usedPercentage)])).toEqual([
    ['statusline', [20, 10]],
    ['statusline', [60, 10]],
  ])
  // The pill's usage is the board's own profile's, as before profiles.
  expect(body.limits).toEqual(profiles[0]?.limits ?? null)
}, 20_000)

test('a profile without a status-line reading has its usagebar’s; a hidden one’s hooks are not read; a lane keeps its usual profile', async () => {
  const box = await boardWith({ '.claude': 'settings.json' })
  const home = join(box.dir, 'home')
  mkdirSync(join(home, '.claude', 'herdr-usagebar'))
  writeFileSync(join(home, '.claude', 'herdr-usagebar', 'claude-limits-latest.json'), reading(30))
  const { url, proc } = await serveBoard(box, {
    language: 'en',
    categories: [
      { id: 'acme', title: 'Acme', color: 'blue', paths: [], profile: 'default' },
      { id: 'other', title: 'Other', color: 'gray', paths: [] },
    ],
    profiles: [
      { id: 'default', title: 'Default', dir: join(home, '.claude'), color: 'indigo', hidden: false },
      // Listed, hidden, and its folder gone.
      { id: 'old', title: 'Old', dir: join(home, '.claude-old'), color: 'teal', hidden: true },
    ],
  })

  const body = await boardOf(url, proc, 0)
  const profiles = body.profiles ?? []
  expect(
    profiles.map(p => [p.id, p.hidden, p.inherited, p.exists, p.hooks, p.sessions, p.limits?.source ?? null]),
  ).toEqual([
    ['default', false, true, true, false, 0, 'usagebar'],
    ['old', true, false, false, null, 0, null],
  ])
  expect(body.limits).toEqual(profiles[0]?.limits ?? null)
  expect(body.limits?.windows.map(w => w.usedPercentage)).toEqual([30, 10])
  // A lane's usual profile goes with it; a lane without one has no such field.
  expect(body.categories.map(c => [c.id, 'profile' in c ? c.profile : '-'])).toEqual([
    ['acme', 'default'],
    ['other', '-'],
  ])
}, 20_000)

test('a session in the wrong profile: one herdr notification, not one per refresh', async () => {
  const box = await boardWith({ '.claude': 'settings.json', '.claude-work': 'settings.json' })
  const home = join(box.dir, 'home')
  // Started for work, but its hooks report the default folder.
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(
    join(box.cards, 's1.json'),
    JSON.stringify({ key: 's1', name: 'Invoices', profileDir: join(home, '.claude'), profileWant: 'work' }),
  )
  const pane = { pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir }
  box.state({
    'api snapshot': { result: { snapshot: { panes: [pane], tabs: [], workspaces: [] } } },
    'notification show': { result: null },
  })
  const { url, proc } = await serveBoard(box, {
    language: 'en',
    profiles: [
      { id: 'default', title: 'Private', dir: join(home, '.claude'), color: 'indigo', hidden: false },
      { id: 'work', title: 'Work', dir: join(home, '.claude-work'), color: 'teal', hidden: false },
    ],
  })
  const shown = (): string[][] => box.calls().filter(c => c[0] === 'notification' && c[1] === 'show')

  let body = await boardOf(url, proc, 1)
  expect(body.items[0]).toMatchObject({ key: 's1', profile: 'default', profileWanted: 'work' })
  await until(() => shown().length > 0)
  // Three refreshes more: the first two ran to their end (the next one starts only after).
  for (let i = 0; i < 3; i++) body = await boardOf(url, proc, 1, body.lastSuccessfulRefreshAt ?? 0)
  expect(shown()).toEqual([
    [
      'notification',
      'show',
      'Wrong profile: Invoices',
      '--body',
      'Invoices was started in Work but runs in Private',
      '--sound',
      'request',
    ],
  ])
}, 20_000)

test('the board sends each profile’s start command ("" for none) and launch.claude’s program; a bad one is refused with 409', async () => {
  const box = await boardWith({ '.claude': 'settings.json', '.claude-work': 'settings.json' })
  const home = join(box.dir, 'home')
  const listed = [
    { id: 'default', title: 'Private', dir: join(home, '.claude'), color: 'indigo', hidden: false },
    {
      id: 'work',
      title: 'Work',
      dir: join(home, '.claude-work'),
      color: 'teal',
      hidden: false,
      command: ['cld-work', '--verbose'],
    },
  ]
  // config.json too: the panel's edits go there.
  mkdirSync(join(configOf(box), '..'), { recursive: true })
  writeFileSync(configOf(box), JSON.stringify({ language: 'en', profiles: listed }))
  const { url, proc } = await serveBoard(box, {
    language: 'en',
    launch: { claude: ['claude-tg', '--model', 'opus'] },
    profiles: listed,
  })
  const body = await boardOf(url, proc, 0)
  expect(body.profiles?.map(p => [p.id, p.command])).toEqual([
    ['default', ''],
    ['work', 'cld-work --verbose'],
  ])
  expect(body.claudeProgram).toBe('claude-tg')
  const post = (b: unknown) =>
    fetch(`${url}/api/profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board': '1' },
      body: JSON.stringify(b),
    })
  const bad = await post({ op: 'update', id: 'work', command: '-cld' })
  expect([bad.status, await bad.json()]).toEqual([
    409,
    { ok: false, error: 'A start command begins with a program, not “-cld”, which starts with a dash' },
  ])
  expect((await post({ op: 'update', id: 'work', command: 'cld-work' })).status).toBe(200)
  expect(profilesIn(box).find(p => p.id === 'work')?.command).toBe('cld-work')
}, 20_000)
