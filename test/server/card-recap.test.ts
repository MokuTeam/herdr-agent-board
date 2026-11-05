// A Claude Code recap on the board's items (#321): what the server reads from the transcript and the
// card, and the line the card makes of it. A card written before doingAt has its last change as
// the latest its doing can be from.
import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectFolderName } from '../../src/core/resume.ts'
import type { Item } from '../../src/core/types.ts'
import { cardWords } from '../../web/src/models/card.ts'
import { serveBoard, sharedSandbox } from '../support/board-server.ts'

const MIN = 60_000
const NOW = Date.now()
const NEW = '7ec0a000-0000-4000-8000-000000000001' // doing written after the recap
const OLD = '7ec0a000-0000-4000-8000-000000000002' // a card from before doingAt, last changed before the recap
const TOUCHED = '7ec0a000-0000-4000-8000-000000000003' // the same, changed again after the recap
const NONE = '7ec0a000-0000-4000-8000-000000000004' // no doing, no recap

const row = (o: Record<string, unknown>) => JSON.stringify(o)
const iso = (ms: number) => new Date(ms).toISOString()
const lines = (recap: boolean) => [
  row({ type: 'user', timestamp: iso(NOW - 30 * MIN), message: { content: 'go on' } }),
  row({ type: 'assistant', timestamp: iso(NOW - 25 * MIN), message: { content: [{ type: 'text', text: 'Done.' }] } }),
  ...(recap
    ? [row({ type: 'system', subtype: 'away_summary', content: 'Recap 100% Ünïcode.', timestamp: iso(NOW - 20 * MIN) })]
    : []),
]

describe('a recap on the board', () => {
  const sandbox = sharedSandbox()
  let items: Item[] = []

  beforeAll(async () => {
    const box = await sandbox()
    const cwd = join(box.dir, 'Проект 100% x')
    mkdirSync(cwd, { recursive: true })
    const projects = join(box.dir, 'home', '.claude', 'projects', projectFolderName(cwd))
    mkdirSync(projects, { recursive: true })
    mkdirSync(box.cards, { recursive: true })
    const session = (id: string, recap: boolean, card: Record<string, unknown>) => {
      writeFileSync(join(projects, `${id}.jsonl`), `${lines(recap).join('\n')}\n`)
      writeFileSync(join(box.cards, `${id}.json`), JSON.stringify({ key: id, ...card }))
      return { pane_id: `p-${id.slice(-1)}`, agent: 'claude', agent_status: 'idle', cwd, agent_session: { value: id } }
    }
    const panes = [
      session(NEW, true, { doing: 'New step', doingAt: NOW - 10 * MIN, updatedAt: NOW - 10 * MIN }),
      session(OLD, true, { doing: 'Old task', updatedAt: NOW - 40 * MIN }),
      session(TOUCHED, true, { doing: 'Old task', updatedAt: NOW - 5 * MIN }),
      session(NONE, false, { wait: 'x', updatedAt: NOW - 5 * MIN }),
    ]
    box.state({ 'api snapshot': { result: { snapshot: { panes, tabs: [], workspaces: [] } } } })
    const { url } = await serveBoard(box, { language: 'en' })
    const deadline = Date.now() + 5000
    for (;;) {
      const board = (await (await fetch(`${url}/api/board`)).json()) as { stale: boolean; items: Item[] }
      if (!board.stale) {
        items = board.items
        break
      }
      if (Date.now() > deadline) throw new Error('not fresh')
      await Bun.sleep(10)
    }
  }, 20_000)

  const of = (key: string) => items.find(i => i.key === key) as Item

  test('the recap, its time and the time of the last line come with the item', () => {
    expect(of(NEW)).toMatchObject({
      recap: 'Recap 100% Ünïcode.',
      recapAt: NOW - 20 * MIN,
      lastAt: NOW - 25 * MIN,
      doingAt: NOW - 10 * MIN,
    })
    expect(of(NONE)).toMatchObject({ recap: '', recapAt: null, doingAt: null })
  })

  test('a card from before doingAt: its last change stands for it, so a later change keeps the doing', () => {
    expect(of(OLD).doingAt).toBe(NOW - 40 * MIN)
    expect(cardWords(of(OLD))).toMatchObject({ recap: 'Recap 100% Ünïcode.', task: 'Old task' })
    expect(of(TOUCHED).doingAt).toBe(NOW - 5 * MIN)
    expect(cardWords(of(TOUCHED))).toMatchObject({ own: 'Old task', recap: '' })
    // A doing newer than the recap is the line.
    expect(cardWords(of(NEW))).toMatchObject({ own: 'New step', recap: '' })
  })
})
