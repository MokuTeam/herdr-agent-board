// While a cancelled reminder folds away, the schedule panel and the session sheet's reminders keep
// what they showed when the fold began — a new board from the server (its cancel route refreshes
// before it answers) and the clock's redraw included — and draw again once the rows are gone.
// Both ways, step by step: the old page's own cancelSchedule with its draws (render() drew
// renderSchedule and the sheet's scheduleRow only while not `collapsing`; web/app.js with its own
// when.js at the parity baseline) and the React page's desk drawn by <SchedulePanel> and <SheetCard>.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import type { ScheduleEntry } from '../../src/core/schedule-rules.ts'
import type { Translator } from '../../src/core/types.ts'
import { SchedulePanel } from '../../web/src/components/schedule/SchedulePanel.tsx'
import { SheetCard } from '../../web/src/components/sheet/SheetCard.tsx'
import { postSchedule, type ScheduleShown } from '../../web/src/hooks/useSchedule.ts'
import { type BoardEdits, NO_EDITS, withEdit, withEdits } from '../../web/src/models/board-edits.ts'
import { NO_MOVES } from '../../web/src/models/board-view.ts'
import { type Held, scheduleDesk } from '../../web/src/models/schedule-desk.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { addButtonTypes, canonical, findAll, hasClass, type Node, parseHtml } from './support/markup.ts'
import { OLD_WHEN, oldCode, oldFunction } from './support/old-app.ts'
import { type Row, selectorIds, World, type WorldStep } from './support/schedule-world.ts'

const MIN = 60_000
/** A function of the baseline's when.js (the old side's own date texts). */
const when = (name: string) => oldFunction(OLD_WHEN, name)
// A Saturday morning on the local clock.
const START = new Date(2026, 9, 17, 10, 0).getTime()
const ITEMS = [item({ key: 'a', name: 'Alpha' }), item({ key: 'b', name: 'Beta' })]
const ENTRIES: ScheduleEntry[] = [
  { id: 'a1', key: 'a', text: 'First', next: START + 30 * MIN },
  { id: 'a2', key: 'a', text: 'Second', next: START + 60 * MIN },
  { id: 'a3', key: 'a', text: 'Third', next: START + 120 * MIN, cron: '0 12 * * *' },
  { id: 'a4', key: 'a', text: 'Fourth', next: START + 180 * MIN },
  { id: 'b1', key: 'b', text: 'For Beta', next: START + 240 * MIN },
]

/** A click, a new board from the server, a moment, a server answer or the folding rows done. */
type Step = { cancel: string } | { board: ScheduleEntry[] } | WorldStep

/** What the panel and the sheet show after a step. */
interface Drawn {
  panel: string
  sheet: string
}

const boardOf = (schedules: ScheduleEntry[]): BoardPayload => payload({ items: ITEMS, schedules })

/** Old markup, buttons typed as React types them. */
function markup(html: string): string {
  const nodes = parseHtml(html)
  addButtonTypes(nodes)
  return canonical(nodes)
}

async function oldDraws(steps: Step[]): Promise<Drawn[]> {
  const t = translator('en')
  const w = new World()
  try {
    const now = () => START + w.clock.now
    class Clock extends Date {
      static override now() {
        return now()
      }
    }
    const state = { data: boardOf(structuredClone(ENTRIES)), moved: new Map(), open: 'a' }
    // render()'s part for the reminders: the panel, then the sheet — neither while rows fold away.
    const probe = { _html: '', _fresh: false, html: '', wrote: false, querySelectorAll: () => [] }
    Object.defineProperty(probe, 'innerHTML', {
      set(html: string) {
        probe.html = html
        probe.wrote = true
      },
    })
    const drawn: Drawn = { panel: '', sheet: '' }
    let draw = () => {}
    const code = oldCode(
      'web/app.js',
      [
        'ICON',
        'esc',
        'plain',
        'itemOf',
        'catOf',
        'catInfo',
        'schedulesOf',
        'overdue',
        'cancelButton',
        'modeButton',
        'pendingText',
        'entryHTML',
        'logHTML',
        'renderSchedule',
        'scheduleRow',
        'disarm',
        'cancelSchedule',
        'postSchedule',
      ],
      {
        armed: null,
        collapsing: 0,
        state,
        t,
        render: () => draw(),
        toast: w.toast,
        canEdit: () => true,
        collapse: w.collapse,
        document: { querySelectorAll: (selector: string) => w.rows(selectorIds(selector)[0] ?? '') },
        CSS: { escape: (s: string) => s },
        setTimeout: w.clock.set,
        clearTimeout: w.clock.clear,
        schedPanel: { isOpen: true },
        schedBody: probe,
        appear() {},
        Date: Clock,
        capital: OLD_WHEN.get('capital'),
        timeOf: OLD_WHEN.get('timeOf'),
        span: OLD_WHEN.get('span'),
        dayLabel: (ms: number, tr: Translator) => when('dayLabel')(ms, tr, now()),
        shortWhen: (ms: number, tr: Translator) => when('shortWhen')(ms, tr, now()),
        longWhen: (ms: number, tr: Translator) => when('longWhen')(ms, tr, now()),
      },
    )
    const call = (name: string, ...args: unknown[]) => oldFunction(code, name)(...args)
    draw = () => {
      probe._html = ''
      probe.wrote = false
      call('renderSchedule')
      if (!probe.wrote) return
      drawn.panel = markup(probe.html)
      drawn.sheet = markup(String(call('scheduleRow', call('itemOf', state.open))))
    }
    draw()
    const draws: Drawn[] = []
    for (const step of steps) {
      await w.step<Step>(step, s => {
        if ('cancel' in s) return call('cancelSchedule', { dataset: { schedCancel: s.cancel } })
        // onData: the new board, then render().
        state.data = boardOf(s.board)
        draw()
      })
      // The clock's redraw every 30 s.
      if (typeof step === 'object' && 'wait' in step) draw()
      draws.push({ ...drawn })
    }
    return draws
  } finally {
    w.dispose()
  }
}

/** The React page: the desk, the board with its edits, and the two parts drawn after each step. */
async function newDraws(steps: Step[]): Promise<Drawn[]> {
  const t = translator('en')
  const w = new World()
  try {
    const now = () => START + w.clock.now
    let data = boardOf(structuredClone(ENTRIES))
    let edits: BoardEdits = NO_EDITS
    const shown = () => withEdits(data, edits)
    const desk = scheduleDesk<Row, ScheduleShown>({
      t: () => t,
      canEdit: () => true,
      entries: () => shown().schedules,
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
      view: () => ({ data: shown(), now: now(), moves: NO_MOVES }),
      changed() {},
    })
    const draw = (): Drawn => {
      const value = board({ data: shown(), now: now() })
      const armed = desk.armed()
      const held: Held<ScheduleShown> | null = desk.held()
      const schedule = { armed, held, cancel() {}, mode() {}, disarm() {} }
      const panel = renderInBoard(
        <PanelProvider viewport={() => ({ w: 1600, h: 1000 })}>
          <SchedulePanel open focus={null} onClose={() => {}} schedule={schedule} />
        </PanelProvider>,
        value,
      )
      const body = findAll(panel, el => el.attrs.get('id') === 'sched-body')[0]
      const it = shown().items.find(i => i.key === 'a')
      const card: Node[] = it
        ? renderInBoard(<SheetCard item={it} disabled={false} schedule={{ armed, held }} />, value)
        : []
      return {
        panel: canonical(body?.children ?? []),
        sheet: canonical(findAll(card, el => hasClass(el, 'sched-row'))),
      }
    }
    const draws: Drawn[] = []
    for (const step of steps) {
      await w.step<Step>(step, s => {
        if ('cancel' in s) return desk.cancel(s.cancel)
        // A new board: the page's own edits of the last one are let go (BoardProvider's settle).
        data = boardOf(s.board)
        edits = NO_EDITS
      })
      draws.push(draw())
    }
    return draws
  } finally {
    w.dispose()
  }
}

const OK: Step = { reply: { status: 200, body: { ok: true } } }
// What the server's cancel route sends before it answers: the board without the entry (and here
// two new ones for the session, counted in "+2 more" once the panel and the sheet draw again).
const AFTER_CANCEL: Step = {
  board: [
    ...ENTRIES.filter(e => e.id !== 'a1'),
    { id: 'a5', key: 'a', text: 'Fifth', next: START + 300 * MIN },
    { id: 'a6', key: 'a', text: 'Sixth', next: START + 360 * MIN },
  ],
}

describe('while a cancelled reminder folds away', () => {
  test('a new board and the clock’s redraw change nothing until the rows are gone', async () => {
    const steps: Step[] = [
      { cancel: 'a1' },
      { cancel: 'a1' },
      AFTER_CANCEL,
      // Past a2's time: it would be "due" were the panel drawn.
      { wait: 65 * MIN },
      OK,
      'folded',
      { wait: 30_000 },
    ]
    const old = await oldDraws(steps)
    const now = await newDraws(steps)
    expect(now).toEqual(old)
    // Armed, then held "Cancel?" and all through the board and the clock…
    for (const i of [0, 1, 2, 3, 4]) expect(old[i]?.sheet).toContain('Cancel?')
    expect(old[3]).toEqual(old[0] as Drawn)
    // …then drawn again: a1 gone, a5 counted, a2 waiting.
    expect(old[5]?.sheet).not.toContain('Cancel?')
    expect(old[5]?.sheet).toContain('+2 more')
    expect(old[5]?.panel).toContain('Due, waiting for the session')
  })

  test('refused: the rows come back as the board now is', async () => {
    const steps: Step[] = [
      { cancel: 'a2' },
      { cancel: 'a2' },
      { board: ENTRIES },
      { reply: { status: 404, body: { ok: false, error: 'That entry is gone already' } } },
      'folded',
    ]
    const old = await oldDraws(steps)
    expect(await newDraws(steps)).toEqual(old)
    expect(old.at(-1)?.sheet).not.toContain('Cancel?')
  })

  test('the rows gone before the server answers: still held until it does', async () => {
    const steps: Step[] = [{ cancel: 'b1' }, { cancel: 'b1' }, 'folded', AFTER_CANCEL, OK]
    const old = await oldDraws(steps)
    expect(await newDraws(steps)).toEqual(old)
  })
})
