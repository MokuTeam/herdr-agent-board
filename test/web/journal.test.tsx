// The away journal on the page (#489): the strip's rows in the list's order with its count lines,
// a row of a card gone from the board, the toolbar's "Since" only while there is a return; on a
// real DOM, dismiss hides the strip once per return and posts it, a row opens its card, and the
// toolbar's button opens the list again.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { act, createRef } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { JournalList } from '../../src/core/journal.ts'
import type { JournalPayload } from '../../src/core/payload.ts'
import { AwayStrip } from '../../web/src/components/journal/AwayStrip.tsx'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import type { JournalView } from '../../web/src/hooks/useJournal.ts'
import { isJournalList, journalButton, stripTitle } from '../../web/src/models/journal.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { findAll, type Node } from './support/markup.ts'

const t = translator('en')
const at = (h: number, m: number) => new Date(2026, 10, 21, h, m).getTime()
const NOW = at(8, 10)
const list: JournalList = {
  since: at(0, 5),
  rows: [
    { key: 'anna', name: 'anna', lane: 'personal', kind: 'owner', line: 'May I push?', at: at(3, 0) },
    { key: 'ben', name: 'ben', lane: 'personal', kind: 'done', line: 'PR opened', at: at(4, 0) },
    { key: 'gone', name: 'cleo', lane: 'other', kind: 'ext', line: 'CI', at: at(5, 0) },
  ],
  more: 0,
  rest: { work: 2, idle: 1 },
  before: 1,
}
const text = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(text).join(''))
const view = (fields: Partial<JournalView> = {}): JournalView => ({
  shown: { title: 'While you were away, 00:05 to 08:00', list },
  button: 'Since 00:05',
  toggle() {},
  close() {},
  open() {},
  onBoard: key => key !== 'gone',
  ...fields,
})

test('the model: the button, the titles, what the route answers', () => {
  expect(journalButton(null, t, NOW)).toBeNull()
  expect(journalButton({ from: at(0, 5) }, t, NOW)).toBe('Since 00:05')
  expect(stripTitle(at(0, 5), at(8, 0), t, NOW)).toBe('While you were away, 00:05 to 08:00')
  expect(stripTitle(at(0, 5), null, t, NOW)).toBe('Since 00:05')
  expect(isJournalList(list)).toBe(true)
  expect(isJournalList({ ...list, rows: [{ key: 'x', kind: 'work' }] })).toBe(false)
  expect(isJournalList({ since: 1 })).toBe(false)
})

test('the strip: rows in order, the old waits after the first group, the rest folded; a gone card is no link', () => {
  const nodes = renderInBoard(<AwayStrip journal={view()} />, board({ now: NOW }))
  const lines = findAll(nodes, el => el.tag === 'li').map(text)
  expect(lines).toEqual([
    'waits on youannapersonalMay I push?03:00',
    'and 1 more was waiting on you before',
    'finishedbenpersonalPR opened04:00',
    'waits on someone elsecleootherCI05:00',
    'and 3 more moved: 2 working, 1 idle',
  ])
  const buttons = findAll(nodes, el => el.attrs.get('class') === 'away-open')
  expect(buttons.map(b => b.attrs.get('aria-disabled'))).toEqual(['false', 'false', 'true'])
  expect(renderInBoard(<AwayStrip journal={view({ shown: null })} />, board())).toEqual([])
})

test('the toolbar: "Since" only while there is a return', () => {
  const ids = (journal?: Parameters<typeof Toolbar>[0]['journal']) =>
    findAll(
      renderInBoard(<Toolbar limitsAnchor={createRef()} {...(journal && { journal })} />, board()),
      el => el.attrs.get('id') === 'journal-open',
    ).map(text)
  expect(ids()).toEqual([])
  expect(ids({ label: 'Since 00:05', open: false, onToggle() {} })).toEqual(['Since 00:05'])
  // it names the strip it controls only while the strip is there
  const button = (open: boolean) =>
    findAll(
      renderInBoard(
        <Toolbar limitsAnchor={createRef()} journal={{ label: 'Since 00:05', open, onToggle() {} }} />,
        board(),
      ),
      el => el.attrs.get('id') === 'journal-open',
    )[0]
  expect([button(false)?.attrs.get('aria-expanded'), button(false)?.attrs.get('aria-controls')]).toEqual([
    'false',
    undefined,
  ])
  expect([button(true)?.attrs.get('aria-expanded'), button(true)?.attrs.get('aria-controls')]).toEqual([
    'true',
    'away-strip',
  ])
})

// ---------------------------------------------------------------- on a real DOM
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
const KEYS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'fetch',
] as const
const saved = new Map<string, unknown>()
const posts: { path: string; body: unknown }[] = []
let gets: string[] = []
beforeAll(() => {
  for (const k of KEYS) saved.set(k, g[k])
  for (const k of KEYS.slice(0, -1)) g[k] = (dom.window as unknown as Record<string, unknown>)[k]
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.fetch = async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ ok: true, dismissed: true }))
    }
    gets.push(path)
    return new Response(JSON.stringify({ ok: true, journal: { ...list, rows: list.rows.slice(1) } }))
  }
})
afterAll(() => {
  for (const [k, v] of saved) g[k] = v
})

test('dismiss hides the strip once per return and posts it; a row opens its card; Since opens it again', async () => {
  const { createRoot } = await import('react-dom/client')
  const { useJournal } = await import('../../web/src/hooks/useJournal.ts')
  const { I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx')
  const { BoardContext } = await import('../../web/src/state/BoardProvider.tsx')
  const opened: unknown[] = []
  function Page() {
    const journal = useJournal()
    return (
      <>
        {journal.button && (
          <button type="button" id="since" onClick={journal.toggle}>
            {journal.button}
          </button>
        )}
        <AwayStrip journal={journal} />
      </>
    )
  }
  const root = createRoot(document.getElementById('root') as HTMLElement)
  const show = (journal: JournalPayload) =>
    act(() =>
      root.render(
        <I18nProvider lang="en">
          <BoardContext.Provider
            value={board({
              now: NOW,
              data: payload({ items: [item({ key: 'anna' }), item({ key: 'ben' })], journal }),
              dispatch: a => opened.push(a),
            })}
          >
            <Page />
          </BoardContext.Provider>
        </I18nProvider>,
      ),
    )
  const strip = () => document.querySelector('.away-strip')
  const click = (selector: string) => {
    const el = document.querySelector(selector)
    if (!(el instanceof dom.window.HTMLElement)) throw new Error(`no ${selector}`)
    el.click()
  }
  const first = { strip: { ...list, from: at(0, 5), to: at(8, 0) }, last: { from: at(0, 5), to: at(8, 0) } }
  await show(first)
  expect(strip()?.querySelector('.away-title')?.textContent).toBe('While you were away, 00:05 to 08:00')
  click('.away-strip .away-open')
  expect(opened).toEqual([{ type: 'open', key: 'anna' }])
  await act(async () => click('.away-strip .away-close'))
  expect(strip()).toBeNull()
  expect(posts).toEqual([{ path: '/api/journal', body: { op: 'dismiss' } }])
  // the same return again (the payload before the server's answer): still hidden
  await show(first)
  expect(strip()).toBeNull()
  // Since opens the list again, up to now, and closes it
  gets = []
  await act(async () => click('#since'))
  expect(gets).toEqual([`/api/journal?since=${at(0, 5)}`])
  expect(strip()?.querySelector('.away-title')?.textContent).toBe('Since 00:05')
  expect(strip()?.querySelectorAll('.away-row')).toHaveLength(2)
  await act(async () => click('#since'))
  expect(strip()).toBeNull()
  // the next return shows again
  await show({ strip: { ...list, from: at(9, 0), to: at(10, 0) }, last: { from: at(9, 0), to: at(10, 0) } })
  expect(strip()?.querySelector('.away-title')?.textContent).toBe('While you were away, 09:00 to 10:00')
  // the pill, pressed while the return's strip is on show, closes it here without dismissing it
  gets = []
  await act(async () => click('#since'))
  expect(strip()).toBeNull()
  expect(posts).toHaveLength(1)
  expect(gets).toEqual([])
  // pressed again: the list since that return began
  await act(async () => click('#since'))
  expect(gets).toEqual([`/api/journal?since=${at(9, 0)}`])
  expect(strip()?.querySelector('.away-title')?.textContent).toBe('Since 09:00')
  await act(async () => root.unmount())
})
