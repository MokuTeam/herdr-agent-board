import { expect, onTestFinished, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodexHome } from '../../src/adapters/codex-home.ts'

const ID = '01a15a8a-bd97-7701-a7f7-401e4bec3147'
const said = (role: string, text: string) =>
  `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'output_text', text }] } })}\n`
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'board-codex-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const date = join(root, 'sessions', '2026', '10', '20')
  mkdirSync(date, { recursive: true })
  return { root, file: join(date, `rollout-2026-10-20T08-00-00-${ID}.jsonl`) }
}

test('finds a rollout by session id in a custom home, caches unchanged tails and refreshes changed files', () => {
  const { root, file } = fixture()
  writeFileSync(file, said('user', 'fix it') + said('assistant', 'Done.'))
  const home = createCodexHome(root)
  const info = home.transcriptInfo(ID)
  expect(info).toMatchObject({ prompt: 'fix it', lastText: 'Done.' })
  expect(home.transcriptInfo(ID)).toBe(info)
  appendFileSync(file, said('user', 'push it'))
  expect(home.transcriptInfo(ID)).toMatchObject({ prompt: 'push it', replied: true })
  expect(home.sessionThread(ID).conversation).toHaveLength(3)
  expect(home.sessionThread(ID).queued).toEqual([])
})

test('missing and invalid ids, removed files and malformed rollouts leave an empty thread', () => {
  const { root, file } = fixture()
  writeFileSync(file, '{"unfinished')
  const home = createCodexHome(root)
  expect(home.transcriptInfo(ID)).toMatchObject({ prompt: '', lastText: '' })
  rmSync(file)
  expect(home.transcriptInfo(ID)).toBeNull()
  for (const id of [ID, '../secrets', 'pane-p1', ''])
    expect(home.sessionThread(id)).toEqual({ conversation: [], queued: [] })
  expect(createCodexHome(join(root, 'missing')).transcriptInfo(ID)).toBeNull()
})

test('widens the bounded read past a large tool result and skips a partial first line', () => {
  const { root, file } = fixture()
  const result = `${JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(300 << 10) } })}\n`
  writeFileSync(file, said('user', 'Привет 100%') + result + said('assistant', 'Готово.'))
  expect(createCodexHome(root).transcriptInfo(ID)).toMatchObject({ prompt: 'Привет 100%', lastText: 'Готово.' })
})
