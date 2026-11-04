// A MokuPilot call agent's card (#326): first a quiet line that it is on a call and for how long
// (or, after the call, how many helpers it still finishes), then its own line and its task board
// as the card's task lines; no button that needs a terminal. A card without a call is drawn as
// before (card.test.tsx compares those with the old page).
import { describe, expect, test } from 'bun:test'
import type { CallView } from '../../src/core/call-agent.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
import { callLines } from '../../web/src/models/call.ts'
import { cardMenu, type MenuEntry, type MenuItem } from '../../web/src/models/menu-model.ts'
import { headButtons } from '../../web/src/models/sheet.ts'
import { termButton } from '../../web/src/models/terminal.ts'
import { item } from './support/board.tsx'
import { bothCards } from './support/board-scene.tsx'

const MIN = 60_000
const NOW = Date.UTC(2026, 10, 4, 15, 30)

const call = (over: Partial<CallView> = {}): CallView => ({
  phase: 'on',
  since: NOW - 14.5 * MIN,
  parent: 'p',
  helpers: null,
  tasks: [
    { id: 'b1', text: 'Check the invoice totals', status: 'doing' },
    { id: 'b2', text: 'Compare with the contract', status: 'doing', steps: { done: 2, total: 5 } },
    { id: 'b3', text: 'Ask about the discount', status: 'doing' },
    { id: 'b4', text: 'Draft the summary', status: 'next' },
    { id: 'b5', text: 'Book the follow-up', status: 'next' },
    { id: 'b6', text: 'Read the contract', status: 'done' },
  ],
  ...over,
})
const agent = (fields: Partial<Item> = {}): Item =>
  item({
    key: 'c',
    name: 'Call · Invoices',
    pane: null,
    status: 'working',
    column: 'work',
    doing: 'Check the invoice totals',
    call: call(),
    ...fields,
  })

describe('call lines', () => {
  const en = translator('en')
  const ru = translator('ru')

  test('on a call: how long and how much is done; doing lines but the card’s own, then what is next', () => {
    expect(callLines(agent(), NOW, en)).toEqual({
      phase: 'on',
      label: 'On a call',
      detail: '14 min · 1 done',
      hint: expect.stringContaining('MokuPilot’s agent on the call since'),
      rows: [
        { id: 'b2', kind: 'doing', label: 'Doing', text: 'Compare with the contract', steps: '2/5', more: '' },
        { id: 'b3', kind: 'doing', label: 'Doing', text: 'Ask about the discount', steps: '', more: '' },
        { id: 'b4', kind: 'next', label: 'Next', text: 'Draft the summary', steps: '', more: '+1' },
      ],
    })
    const r = callLines(agent(), NOW, ru)
    expect([r?.label, r?.detail, r?.rows.map(x => x.label)]).toEqual([
      'На звонке',
      '14 мин · готово: 1',
      ['Делает', 'Делает', 'Дальше'],
    ])
  })

  test('more doing than the card has room for: the last line says how many more', () => {
    const tasks = ['a', 'b', 'c', 'd'].map(id => ({ id, text: `Task ${id}`, status: 'doing' as const }))
    const rows = callLines(agent({ doing: '', call: call({ tasks }) }), NOW, en)?.rows
    expect(rows?.map(x => [x.text, x.more])).toEqual([
      ['Task a', ''],
      ['Task b', '+2'],
    ])
  })

  test('after the call: its helpers at work, from its transcript, else MokuPilot’s count; none: handing over', () => {
    // `running`: what its transcript says (null: the board could not read any helper of it).
    const after = (helpers: number | null, running: number | null = null) =>
      callLines(
        agent({
          call: call({ phase: 'after', helpers }),
          helpers: running === null ? null : { running, total: 3, workflows: 0, live: [], at: NOW },
        }),
        NOW,
        en,
      )
    expect(after(2)?.label).toBe('After the call: 2 helpers finishing')
    expect(after(5, 1)?.label).toBe('After the call: 1 helper finishing')
    // Its transcript says they are all done: MokuPilot's count is behind.
    expect(after(2, 0)?.label).toBe('After the call: handing over')
    expect(after(0)?.label).toBe('After the call: handing over')
    expect(after(null)?.hint).toContain('hands their results over and ends')
    const ru = translator('ru')
    const n = (k: number) => callLines(agent({ call: call({ phase: 'after', helpers: k }) }), NOW, ru)?.label
    expect([n(1), n(3), n(5), n(0)]).toEqual([
      'После звонка: доделывает 1 помощник',
      'После звонка: доделывают 3 помощника',
      'После звонка: доделывают 5 помощников',
      'После звонка: передаёт итоги',
    ])
  })

  test('two tasks of the same text are two lines', () => {
    const tasks = [
      { id: 'b1', text: 'Same', status: 'doing' as const },
      { id: 'b2', text: 'Same', status: 'doing' as const },
    ]
    const { react } = bothCards({ items: [agent({ doing: '', call: call({ tasks }) })] }, 'c')
    expect(react.match(/class="call-task doing task"/g)).toHaveLength(2)
  })

  test('a card without a call has no call lines', () => {
    expect(callLines(item({ key: 'a' }), NOW, en)).toBeNull()
  })
})

describe('the card', () => {
  test('its call first, its own line, its task board as task lines; no terminal buttons', () => {
    const { react } = bothCards({ items: [agent({ activity: Date.now() })] }, 'c')
    // Class names in the canonical markup are sorted.
    expect(react).toContain('class="call now"')
    expect(react).toContain('>On a call<')
    expect(react.indexOf('call now')).toBeLessThan(react.indexOf('class="what"'))
    expect(react.indexOf('class="what"')).toBeLessThan(react.indexOf('call-task'))
    expect(react).toContain('Compare with the contract')
    expect(react).toContain('class="call-steps"')
    expect(react).toContain('class="call-task next task"')
    for (const act of ['sleep', 'write', 'focus']) expect(react).not.toContain(`data-act="${act}"`)
  })

  test('after the call, in Russian: the line says so, quietly', () => {
    const it = agent({ status: 'idle', column: 'idle', call: call({ phase: 'after', helpers: 2 }) })
    const { react } = bothCards({ items: [it], lang: 'ru' }, 'c')
    expect(react).toContain('class="after call now"')
    expect(react).toContain('После звонка: доделывают 2 помощника')
  })

  test('a call agent in a pane keeps its pane’s buttons; a card without a call shows no call line', () => {
    const inPane = bothCards({ items: [agent({ pane: 'w1:p1', status: 'idle', column: 'idle' })] }, 'c').react
    for (const act of ['sleep', 'write', 'focus']) expect(inPane).toContain(`data-act="${act}"`)
    const plain = bothCards({ items: [item({ key: 'a', doing: 'Work' })] }, 'a').react
    expect(plain).not.toContain('call now')
    expect(plain).not.toContain('call-task')
  })
})

describe('its menu', () => {
  const t = translator('en')
  const ctx = {
    t,
    canMutate: true,
    canEdit: true,
    terminal: true,
    categories: [],
    column: 'idle',
    category: 'other',
    mokupilot: true,
    fork: true,
    profiles: [
      { id: 'a', title: 'A', color: 'blue' },
      { id: 'b', title: 'B', color: 'red' },
    ],
  }
  const ids = (items: readonly MenuEntry[]) => items.filter((i): i is MenuItem => !i.separator).map(i => i.id)
  const HERDR = ['focus', 'terminal', 'mokupilot', 'fork', 'sleep', 'restart', 'renameWorkspace', 'profile', 'archive']

  test('a call agent with no pane: nothing that needs a terminal or a tab; with a pane, all as before', () => {
    const base = { key: 'c', session: 'c', agent: 'claude', cwd: '/w', status: 'idle', workspace: 'ws' }
    const paneless = ids(cardMenu({ ...base, pane: null, call: call() }, ctx))
    for (const id of HERDR) expect(paneless).not.toContain(id)
    expect(paneless).toEqual(expect.arrayContaining(['open', 'rename', 'favorite', 'category', 'status', 'copy']))
    const inPane = ids(cardMenu({ ...base, pane: 'w1:p1', call: call() }, ctx))
    const plain = ids(cardMenu({ ...base, pane: 'w1:p1' }, ctx))
    expect(inPane).toEqual(plain)
    for (const id of HERDR) expect(plain).toContain(id)
  })
})

describe('its sheet', () => {
  const t = translator('en')
  const hidden = (it: Item) => {
    const b = headButtons(it, t, true, [], true)
    return {
      sleep: b.sleepHidden,
      restart: b.restartHidden,
      mokupilot: b.mokupilotHidden,
      fork: b.forkHidden,
      archive: b.archiveHidden,
      terminal: termButton(it, { terminal: true }, t).hidden,
    }
  }
  const NONE = { sleep: false, restart: false, mokupilot: false, fork: false, archive: false, terminal: false }

  test('a call agent with no pane: no herdr or terminal button; in a pane, and any other card, as before', () => {
    const base = { agent: 'claude', cwd: '/w', session: '7a2b4c6d-0000-4000-8000-000000000002' }
    expect(hidden(agent({ ...base, pane: null }))).toEqual({
      sleep: true,
      restart: true,
      mokupilot: true,
      fork: true,
      archive: true,
      terminal: true,
    })
    expect(hidden(agent({ ...base, pane: 'w1:p1', status: 'idle', column: 'idle' }))).toEqual(NONE)
    expect(hidden(item({ key: 'a', ...base, pane: 'w1:p1' }))).toEqual(NONE)
  })
})
