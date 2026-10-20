import { expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardPayload } from '../../src/core/payload.ts'
import { serveBoard } from '../support/board-server.ts'
import { root, type Sandbox, sandbox } from '../support/sandbox.ts'

setDefaultTimeout(20_000)
const SID = '11111111-2222-3333-4444-555555555555'
const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const snapshot = {
  result: {
    snapshot: {
      panes: [
        { pane_id: 'p1', agent: 'claude', agent_session: { value: SID }, agent_status: 'done' },
        { pane_id: 'p2', agent: 'claude', agent_session: { value: OTHER }, agent_status: 'done' },
      ],
      tabs: [],
      workspaces: [],
    },
  },
}
const cardFile = (box: Sandbox, key = SID): string => join(box.cards, `${key}.json`)
const stored = (box: Sandbox, key = SID): Record<string, unknown> =>
  JSON.parse(readFileSync(cardFile(box, key), 'utf8'))
function seed(box: Sandbox, ask: string, key = SID): void {
  mkdirSync(box.cards, { recursive: true })
  writeFileSync(cardFile(box, key), JSON.stringify({ key, ask, askSince: 1, briefV: 999 }))
  const cfg = join(box.env.APPDATA as string, 'herdr/plugins/config/agent-board')
  mkdirSync(cfg, { recursive: true })
  writeFileSync(join(cfg, 'config.json'), JSON.stringify({ language: 'en', port: 9, wakeUrl: null }))
  box.state({ 'api snapshot': snapshot })
}
async function cli(box: Sandbox, args: string[], extra: Record<string, string> = {}): Promise<void> {
  const out = await box.run('cli', { args: [...args, '--session', SID], env: {} }, extra).exited
  expect(out.code, out.stderr).toBe(0)
}
async function hook(box: Sandbox, prompt: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, join(root, 'src/entrypoints/hook.ts')], {
    cwd: root,
    env: { ...box.env, HERDR_PANE_ID: 'p1' },
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SID, cwd: box.dir, prompt }),
    ),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  expect(await proc.exited, error).toBe(0)
}
async function items(url: string) {
  return ((await (await fetch(`${url}/api/board`)).json()) as BoardPayload).items
}
async function waitItem(url: string, matches: (item: BoardPayload['items'][number]) => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  do {
    if ((await items(url)).some(matches)) return
    await Bun.sleep(20)
  } while (Date.now() < deadline)
  expect((await items(url)).some(matches)).toBe(true)
}

test('separate state roots still reproduce stale asks unless cards are explicitly shared', async () => {
  const writer = await sandbox()
  const preview = await sandbox()
  seed(writer, 'Old approval')
  seed(preview, 'Old approval')
  await cli(writer, ['done', 'Finished'])
  const { url } = await serveBoard(preview)
  await waitItem(url, i => i.key === SID)
  expect((await items(url)).find(i => i.key === SID)?.question).toBe('Old approval')
  expect(stored(writer).ask).toBeUndefined()
  expect(stored(preview).ask).toBe('Old approval')
})

test('shared cards observe CLI, hooks and UI dismissal while legitimate asks and schedules stay independent', async () => {
  const writer = await sandbox()
  const preview = await sandbox()
  seed(writer, 'Old approval')
  seed(preview, 'Old approval')
  seed(writer, 'Another session needs an answer', OTHER)
  const oldCopy = readFileSync(cardFile(preview), 'utf8')
  const env = { HERDR_BOARD_CARDS_DIR: writer.cards }
  await cli(writer, ['done', 'Finished'])
  const { url } = await serveBoard(preview, { language: 'en' }, env)
  const one = async () => (await items(url)).find(i => i.key === SID)
  await waitItem(url, i => i.key === SID)
  expect((await one())?.attention).toBe('')
  expect((await one())?.result).toBe('Finished')

  // Watching the authoritative folder observes an outside CLI writer without a forced refresh.
  await cli(writer, ['ask', 'A newer legitimate handoff'])
  await waitItem(url, i => i.key === SID && i.question === 'A newer legitimate handoff')
  expect((await one())?.attention).toBe('ask')
  await hook(writer, '[board reminder] Check progress')
  expect(stored(writer).ask).toBe('A newer legitimate handoff')
  await hook(writer, 'I have answered that')
  await waitItem(url, i => i.key === SID && i.attention === '')
  await cli(writer, ['ask', 'Dismiss this one'])
  await waitItem(url, i => i.key === SID && i.question === 'Dismiss this one')
  const dismissed = await fetch(`${url}/api/session/${SID}/card`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-board': '1' },
    body: JSON.stringify({ dismiss: true }),
  })
  expect(dismissed.status).toBe(200)
  expect(stored(writer).ask).toBeUndefined()
  expect(stored(writer, OTHER).ask).toBe('Another session needs an answer')
  expect(readFileSync(cardFile(preview), 'utf8')).toBe(oldCopy) // no migration or silent merging
  expect([...writer.calls(), ...preview.calls()].some(c => c[1] === 'prompt' || c[1] === 'send-keys')).toBe(false)

  // Both commands share cards, but their future reminders belong to separate schedulers.
  await cli(writer, ['remind', 'in', '1h', 'Writer reminder'])
  await cli(preview, ['remind', 'in', '1h', 'Preview reminder'], env)
  const schedules = (box: Sandbox): string =>
    readdirSync(join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule'))
      .filter(f => f.endsWith('.json'))
      .map(f => readFileSync(join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule', f), 'utf8'))
      .join('\n')
  expect(schedules(writer)).toContain('Writer reminder')
  expect(schedules(writer)).not.toContain('Preview reminder')
  expect(schedules(preview)).toContain('Preview reminder')
  expect(schedules(preview)).not.toContain('Writer reminder')

  const setup = (await (await fetch(`${url}/api/setup`)).json()) as {
    checks: { id: string; level: string; detail: string }[]
  }
  const store = setup.checks.find(c => c.id === 'cards')
  expect(store?.level).toBe('ok')
  expect(store?.detail).toContain(writer.cards)
  expect(store?.detail).toContain(join(preview.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule'))
})

test('the cards override applies to every key without changing its filename or other state paths', async () => {
  const box = await sandbox()
  const cards = join(box.dir, 'Команда 100%', 'cards')
  for (const key of [SID, 'pane-w1:p2', 'C:\\Team Work\\сессия 100%.jsonl']) {
    const out = await box.run('write', { key, patch: { ask: 'Keep this ask' } }, { HERDR_BOARD_CARDS_DIR: cards })
      .exited
    expect(out.code).toBe(0)
    const file = join(cards, `${key.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ key, ask: 'Keep this ask' })
  }
  expect(existsSync(box.cards)).toBe(false)
})

test('an invalid store prevents a server from starting instead of presenting an empty board', async () => {
  const box = await sandbox()
  const proc = box.run('server', { wakeUrl: null }, { HERDR_BOARD_CARDS_DIR: './cards' })
  const result = await proc.exited
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('HERDR_BOARD_CARDS_DIR must be an absolute directory path')
  expect(box.calls()).toEqual([])
  expect(existsSync(box.cards)).toBe(false)
})
