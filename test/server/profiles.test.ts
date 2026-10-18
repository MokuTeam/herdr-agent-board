// The Claude profiles on the web board's server: the folders found at its start, and the Profiles
// panel's edits.
import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serveBoard } from '../support/board-server.ts'
import { type Sandbox, sandbox } from '../support/sandbox.ts'

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
