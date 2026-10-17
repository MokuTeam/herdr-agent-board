// The reminders' buttons both ways, step by step: the old page's own cancelSchedule, toggleMode,
// disarm and postSchedule (web/app.js as it was at the parity baseline, its buttons drawn by its
// cancelButton) and the React page's desk (models/schedule-desk.ts with hooks/useSchedule.ts's
// postSchedule), given the same clicks, clock and server answers through the same fetch
// (support/schedule-world.ts). Each side keeps what it posted, toasted, folded away and unfolded.
// Then what the desk holds while rows fold away, and the fold itself (collapse), frame by frame in
// a fake DOM.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import { collapse, postSchedule } from '../../web/src/hooks/useSchedule.ts'
import { NO_EDITS, withEdit, withEdits } from '../../web/src/models/board-edits.ts'
import { scheduleDesk } from '../../web/src/models/schedule-desk.ts'
import { Spring } from '../../web/src/models/spring.ts'
import { payload } from './support/board.tsx'
import { box, type FakeElement, FakeWorld } from './support/fake-dom.ts'
import { parseHtml } from './support/markup.ts'
import { oldCode, oldFunction } from './support/old-app.ts'
import { type Row, selectorIds, World, type WorldStep } from './support/schedule-world.ts'

const ENTRIES: ScheduleEntry[] = [
  { id: 's1', key: 'a', text: 'Check the **deploy** at [the dashboard](https://x)', next: 1 },
  { id: 's2', key: 'a', text: 'Standup notes', next: 2, cron: '0 9 * * 1-5', idle: true },
  { id: 's3', key: 'b', text: 'Ping', next: 3 },
]

/** One click, a moment, a server answer or the folding rows done. */
type Step = { cancel: string } | { mode: string } | WorldStep

interface Trace {
  armed: string | null
  shown: string[]
  posts: string[]
  toasts: [string, boolean][]
  folded: string[]
  unfolded: string[]
}

const shownOf = (list: ScheduleEntry[]) => list.map(e => `${e.id}${e.idle ? ' idle' : ''}`)

async function oldTrace(steps: Step[], { lang = 'en', canEdit = true } = {}): Promise<Trace[]> {
  const t = translator(lang)
  const w = new World()
  try {
    const state = { data: { schedules: structuredClone(ENTRIES) } }
    const code = oldCode(
      'web/app.js',
      ['ICON', 'esc', 'plain', 'cancelButton', 'disarm', 'toggleMode', 'cancelSchedule', 'postSchedule'],
      {
        armed: null,
        collapsing: 0,
        state,
        t,
        render() {},
        toast: w.toast,
        canEdit: () => canEdit,
        collapse: w.collapse,
        // Its selector names the entry's row in the panel, then in the sheet.
        document: { querySelectorAll: (selector: string) => w.rows(selectorIds(selector)[0] ?? '') },
        CSS: { escape: (s: string) => s },
        setTimeout: w.clock.set,
        clearTimeout: w.clock.clear,
      },
      { baseline: true },
    )
    const cancelButton = oldFunction(code, 'cancelButton')
    const armedNow = () => state.data.schedules.find(e => String(cancelButton(e)).includes('data-confirm'))?.id ?? null
    const traces: Trace[] = []
    for (const step of steps) {
      await w.step<Step>(step, s => {
        if (typeof s === 'object' && 'cancel' in s)
          return oldFunction(code, 'cancelSchedule')({ dataset: { schedCancel: s.cancel } })
        if (typeof s === 'object' && 'mode' in s)
          return oldFunction(code, 'toggleMode')({ dataset: { schedMode: s.mode } })
      })
      traces.push({ armed: armedNow(), shown: shownOf(state.data.schedules), ...w.sent() })
    }
    return traces
  } finally {
    w.dispose()
  }
}

function newDesk(w: World, { lang = 'en', canEdit = true } = {}) {
  const t = translator(lang)
  const data = payload({ schedules: structuredClone(ENTRIES) })
  let edits = NO_EDITS
  const shown = () => withEdits(data, edits).schedules
  // What the page shows: here the entries, and a draw counted for each change.
  let draws = 0
  const desk = scheduleDesk<Row, string[]>({
    t: () => t,
    canEdit: () => canEdit,
    entries: shown,
    post: body => postSchedule(body, t),
    rows: w.rows,
    collapse: w.collapse,
    restore: row => row.removeAttribute('style'),
    edit: edit => {
      edits = withEdit(edits, edit)
    },
    toast: w.toast,
    setTimeout: w.clock.set,
    clearTimeout: w.clock.clear,
    view: () => shownOf(shown()),
    changed() {
      draws++
    },
  })
  return { desk, shown, draws: () => draws }
}

async function newTrace(steps: Step[], options: { lang?: string; canEdit?: boolean } = {}): Promise<Trace[]> {
  const w = new World()
  try {
    const { desk, shown } = newDesk(w, options)
    const traces: Trace[] = []
    for (const step of steps) {
      await w.step<Step>(step, s => {
        if (typeof s === 'object' && 'cancel' in s) return desk.cancel(s.cancel)
        if (typeof s === 'object' && 'mode' in s) return desk.mode(s.mode)
      })
      traces.push({ armed: desk.armed(), shown: shownOf(shown()), ...w.sent() })
    }
    return traces
  } finally {
    w.dispose()
  }
}

test('while rows fold away the desk holds what was shown, "Cancel?" and all, and says so at once', async () => {
  const w = new World()
  try {
    const { desk, draws } = newDesk(w)
    await w.step<Step>({ cancel: 's1' }, s => 'cancel' in s && desk.cancel(s.cancel))
    expect(desk.held()).toBe(null)
    const before = draws()
    await w.step<Step>({ cancel: 's1' }, s => 'cancel' in s && desk.cancel(s.cancel))
    // Drawn at once with what was on show when the fold began; the button no longer asks.
    expect(draws()).toBe(before + 1)
    expect(desk.held()).toEqual({ view: ['s1', 's2 idle', 's3'], armed: 's1' })
    expect(desk.armed()).toBe(null)
    // Another entry's cancel while it folds: the page keeps what it holds (the old page drew nothing then).
    await w.step<Step>({ cancel: 's2' }, s => 'cancel' in s && desk.cancel(s.cancel))
    expect(desk.held()).toEqual({ view: ['s1', 's2 idle', 's3'], armed: 's1' })
    await w.step({ reply: { status: 200, body: { ok: true } } }, () => {})
    expect(desk.held()).not.toBe(null)
    await w.step('folded', () => {})
    expect(desk.held()).toBe(null)
    expect(desk.armed()).toBe('s2')
  } finally {
    w.dispose()
  }
})

async function same(steps: Step[], options: { lang?: string; canEdit?: boolean } = {}): Promise<Trace[]> {
  const old = await oldTrace(steps, options)
  const now = await newTrace(steps, options)
  expect(now).toEqual(old)
  return now
}

const OK: Step = { reply: { status: 200, body: { ok: true } } }

describe('cancel: the first click asks "Cancel?", a second within four seconds removes the entry', () => {
  test('arming, another entry taking over, asking no more after four seconds', async () => {
    const traces = await same([{ cancel: 's1' }, { cancel: 's2' }, { wait: 3999 }, { wait: 1 }, { cancel: 's3' }])
    expect(traces.map(t => t.armed)).toEqual(['s1', 's2', 's2', null, 's3'])
    expect(traces.at(-1)?.posts).toEqual([])
  })

  test('confirmed: both its rows fold away while the server removes it, then it is off the board', async () => {
    const traces = await same([{ cancel: 's1' }, { cancel: 's1' }, OK, 'folded'])
    const last = traces.at(-1)
    expect(last?.posts).toEqual([
      'POST /api/schedule {"content-type":"application/json","x-board":"1"} {"op":"cancel","id":"s1"}',
    ])
    expect(last?.folded).toEqual(['sched-entry s1', 'sched-mini s1'])
    expect(last?.shown).toEqual(['s2 idle', 's3'])
    expect(last?.toasts).toEqual([['Cancelled: Check the deploy at the dashboard', false]])
    // Folding and the answer both count: the entry stays until the rows are gone.
    expect(traces[2]?.shown).toEqual(['s1', 's2 idle', 's3'])
  })

  test('the rows fold before the server answers, in Russian', async () => {
    await same([{ cancel: 's3' }, { cancel: 's3' }, 'folded', OK], { lang: 'ru' })
  })

  test('refused or offline: its rows unfold and the toast says why', async () => {
    const refused = await same([
      { cancel: 's2' },
      { cancel: 's2' },
      { reply: { status: 404, body: { ok: false, error: 'That entry is gone already' } } },
      'folded',
    ])
    expect(refused.at(-1)?.unfolded).toEqual(['sched-entry s2 style', 'sched-mini s2 style'])
    expect(refused.at(-1)?.toasts).toEqual([['That entry is gone already', true]])
    const offline = await same([{ cancel: 's2' }, { cancel: 's2' }, 'folded', { reply: 'offline' }])
    expect(offline.at(-1)?.shown).toEqual(['s1', 's2 idle', 's3'])
    await same([{ cancel: 's2' }, { cancel: 's2' }, 'folded', { reply: { status: 500, body: 'oops' } }])
  })

  test('without the board nothing is posted; the rows still fold and come back', async () => {
    const traces = await same([{ cancel: 's1' }, { cancel: 's1' }, 'folded'], { canEdit: false })
    expect(traces.at(-1)?.posts).toEqual([])
    expect(traces.at(-1)?.toasts).toEqual([['No connection to the board, reconnecting…', true]])
  })
})

describe('delivery: on time or when the session is free', () => {
  test('switched at once, the server agrees, the toast says which', async () => {
    const traces = await same([{ mode: 's1' }, OK, { mode: 's2' }, OK])
    expect(traces[0]?.shown).toEqual(['s1 idle', 's2 idle', 's3'])
    expect(traces.at(-1)?.shown).toEqual(['s1 idle', 's2', 's3'])
    expect(traces.at(-1)?.posts.map(p => p.split(' ').at(-1))).toEqual([
      '{"op":"mode","id":"s1","idle":true}',
      '{"op":"mode","id":"s2","idle":false}',
    ])
    expect(traces.at(-1)?.toasts).toEqual([
      ['Delivery: When free', false],
      ['Delivery: On time', false],
    ])
  })

  test('refused: it goes back, the toast says why; an entry gone does nothing', async () => {
    const traces = await same([{ mode: 's3' }, { reply: { status: 409, body: { error: 'busy' } } }, { mode: 'gone' }])
    expect(traces.at(-1)?.shown).toEqual(['s1', 's2 idle', 's3'])
    expect(traces.at(-1)?.toasts).toEqual([['busy', true]])
    await same([{ mode: 's2' }, { reply: 'offline' }], { lang: 'ru' })
    await same([{ mode: 's2' }], { canEdit: false })
  })
})

describe('collapse: a row folds away, its height, paddings and opacity springing to nothing', () => {
  const rects = (el: FakeElement) => (el.node.attrs.get('class') === 'sched-entry' ? box(0, 0, 400, 72) : null)
  const computed = () => ({ paddingTop: '11px', paddingBottom: '13px' })

  async function frames(fold: (el: unknown) => Promise<unknown>): Promise<string[]> {
    const world = new FakeWorld({ viewport: { w: 1200, h: 800 }, rects, computed })
    world.install()
    try {
      const [node] = parseHtml('<div class="sched-entry" data-id="s1"></div>')
      if (node?.kind !== 'element') throw new Error('no row')
      const row = world.mount(node)
      let done = false
      void fold(row).then(() => {
        done = true
      })
      const seen: string[] = []
      while (!done && seen.length < 500) {
        seen.push(row.node.attrs.get('style') ?? '')
        await world.tick()
      }
      seen.push(`done ${done}: ${row.node.attrs.get('style') ?? ''}`)
      return seen
    } finally {
      try {
        await world.settle()
      } finally {
        world.uninstall()
      }
    }
  }

  test('frame by frame as the old page’s collapse', async () => {
    const reducedMotion = { matches: false }
    const old = oldFunction(
      oldCode('web/app.js', ['collapse'], { Spring, reducedMotion }, { baseline: true }),
      'collapse',
    )
    const before = await frames(el => Promise.resolve(old(el)))
    const after = await frames(el => collapse(el as HTMLElement))
    expect(after).toEqual(before)
    expect(after.length).toBeGreaterThan(5)
    expect(after.at(-1)).toBe(
      'done true: overflow: hidden; height: 0px; padding-top: 0px; padding-bottom: 0px; opacity: 0',
    )
  })

  test('a row no longer in the page is gone already', async () => {
    const [node] = parseHtml('<div class="sched-mini"></div>')
    if (node?.kind !== 'element') throw new Error('no row')
    const world = new FakeWorld({ viewport: { w: 1200, h: 800 } })
    world.install()
    try {
      const row = world.wrap(node)
      await collapse(row as unknown as HTMLElement)
      expect(row.node.attrs.has('style')).toBe(false)
    } finally {
      world.uninstall()
    }
  })
})
