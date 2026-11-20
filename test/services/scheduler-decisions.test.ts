// A decision's default (#487) in the scheduler: it goes once, as "[board reminder from decisions]",
// and is recorded as the default's, only while its question is open; an owner's prompt (the ask
// cleared) or Hold before it drops it, and a reminder due beside it is never joined to it. The
// scheduler in a child process against a fake herdr, as in scheduler.test.ts.
import { setDefaultTimeout, test } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDecision } from '../../src/adapters/decision-store.ts'
import type { AskSpec } from '../../src/core/decisions.ts'
import { askDecision, holdOpen, withDecisionsDb } from '../../src/services/decisions.ts'
import { type Sandbox, sandbox, until } from '../support/sandbox.ts'

setDefaultTimeout(20_000)

const HOUR = 3600e3
const dirOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/schedule')
const cardsOf = (box: Sandbox): string => join(box.env.LOCALAPPDATA as string, 'herdr/plugins/agent-board/cards')
const spec: AskSpec = { question: 'Merge now?', options: ['Merge now', 'Wait'], recommend: 1, defaultMs: 2 * HOUR }
const RULE = '─'.repeat(40)
const SCREEN = ['● done', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'].join('\n')

function inBox<T>(box: Sandbox, fn: () => T): T {
  const saved = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA }
  process.env.APPDATA = box.env.APPDATA
  process.env.LOCALAPPDATA = box.env.LOCALAPPDATA
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
const prompts = (box: Sandbox): string[] =>
  box
    .calls()
    .filter(a => a[1] === 'prompt')
    .map(a => a[3] as string)
const runs = (box: Sandbox): Record<string, unknown>[] =>
  existsSync(join(dirOf(box), 'log.jsonl'))
    ? readFileSync(join(dirOf(box), 'log.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []
const cardOf = (box: Sandbox): Record<string, unknown> =>
  JSON.parse(readFileSync(join(cardsOf(box), 's1.json'), 'utf8'))

function herdrIdle(box: Sandbox): void {
  const snapshot = {
    panes: [{ pane_id: 'p1', agent: 'claude', agent_session: { value: 's1' }, agent_status: 'idle', cwd: box.dir }],
    tabs: [],
    workspaces: [],
  }
  box.state({
    'api snapshot': { result: { snapshot } },
    'agent get': { result: { agent: { agent: 'claude', agent_status: 'idle', agent_session: { value: 's1' } } } },
    'agent read': { text: SCREEN },
    'agent prompt': { result: {} },
  })
}

/** A question asked two hours and a second ago: its default is due. */
const askedLong = (box: Sandbox) =>
  inBox(box, () =>
    withDecisionsDb(db =>
      askDecision(db, { key: 's1', name: 'Test', spec, ask: spec.question, now: Date.now() - 2 * HOUR - 1000 }),
    ),
  )
const rowOf = (box: Sandbox, id: string) => inBox(box, () => withDecisionsDb(db => getDecision(db, id)))

async function scheduler(box: Sandbox) {
  const proc = box.run('scheduler', {
    categories: [{ id: 'other', title: 'Other', color: 'gray' }],
    wakeUrl: null,
    scheduleTickSec: 0.2,
    decisions: true,
  })
  await until(() => proc.messages.some(m => (m as { ready?: boolean }).ready))
  return proc
}

test('no answer and no prompt since: the default goes once and is recorded as the default', async () => {
  const box = await sandbox()
  herdrIdle(box)
  const r = askedLong(box)
  // A reminder due in the same minute goes in a prompt of its own.
  mkdirSync(dirOf(box), { recursive: true })
  writeFileSync(
    join(dirOf(box), 'aaaaa1.json'),
    JSON.stringify({
      id: 'aaaaa1',
      key: 's1',
      name: 'Test',
      text: 'check CI',
      at: Date.now() - 1000,
      next: Date.now() - 1000,
      created: Date.now(),
    }),
  )
  await scheduler(box)
  await until(() => prompts(box).length === 2 && rowOf(box, r.id)?.answeredAt !== null)
  await Bun.sleep(800)
  assert.deepEqual(prompts(box).sort(), [
    '[board reminder from decisions] no answer in 2 h: go with your recommendation "Merge now"',
    '[board reminder] check CI',
  ])
  assert.deepEqual(
    (({ answer, answeredBy, via }) => ({ answer, answeredBy, via }))(rowOf(box, r.id) ?? ({} as never)),
    { answer: 'Merge now', answeredBy: 'default', via: 'default' },
  )
  assert.equal(cardOf(box).ask, undefined)
  assert.equal(cardOf(box).decision, undefined)
})

test('the owner wrote meanwhile (the ask cleared): nothing goes, the entry is dropped', async () => {
  const box = await sandbox()
  herdrIdle(box)
  const r = askedLong(box)
  const entry = rowOf(box, r.id)?.entry as string
  const card = cardOf(box)
  delete card.ask
  delete card.askSince
  delete card.decision
  writeFileSync(join(cardsOf(box), 's1.json'), JSON.stringify(card))
  await scheduler(box)
  await until(() => runs(box).some(x => x.id === entry))
  await Bun.sleep(600)
  assert.deepEqual(prompts(box), [])
  assert.equal(existsSync(join(dirOf(box), `${entry}.json`)), false)
  assert.equal(runs(box).find(x => x.id === entry)?.result, 'cancelled')
})

test('held: nothing goes, the question stays open', async () => {
  const box = await sandbox()
  herdrIdle(box)
  const r = askedLong(box)
  const entry = rowOf(box, r.id)?.entry as string
  inBox(box, () => withDecisionsDb(db => holdOpen(db, 's1', r.id, Date.now())))
  // An entry left behind by a board that stopped before taking it back: dropped all the same.
  writeFileSync(
    join(dirOf(box), `${entry}.json`),
    JSON.stringify({
      id: entry,
      key: 's1',
      text: 'x',
      next: Date.now() - 1000,
      decision: r.id,
      by: 'decisions',
      from: { key: 'decisions', name: 'decisions' },
    }),
  )
  await scheduler(box)
  await until(() => !existsSync(join(dirOf(box), `${entry}.json`)))
  await Bun.sleep(600)
  assert.deepEqual(prompts(box), [])
  assert.equal(rowOf(box, r.id)?.answeredAt, null)
  assert.equal(cardOf(box).ask, 'Merge now?')
})
