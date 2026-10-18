// The Claude profiles on the web board's server: the folders found at its start, the Profiles
// panel's edits, and each session's records read from its own profile.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'

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
