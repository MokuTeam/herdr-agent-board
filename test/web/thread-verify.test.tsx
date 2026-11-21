// Verified done on the page (#492): the panel's verification block (on, from its lane, the acceptance
// lines, the verifier running or awaited while a done is held), the held done's own words beside
// Confirm and Keep open, the feed's verifier and verdict lines with the report; nothing for a thread
// that never had verification.
import { expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Party, ThreadEntryView, ThreadRow, ThreadView } from '../../src/core/work-threads.ts'
import { ThreadPane } from '../../web/src/components/threads/ThreadPane.tsx'
import { type Threads, ThreadsContext } from '../../web/src/hooks/useThreads.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { feedOf } from '../../web/src/models/work-threads.ts'
import { type Board, BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { board, payload } from './support/board.tsx'

const NOW = Date.parse('2026-11-12T14:00:00Z')
const ben: Party = { kind: 'session', key: '0b0b0b0b-0000-4000-8000-00000000000b', name: 'ben' }
const vf: Party = { kind: 'session', key: '0c0c0c0c-0000-4000-8000-00000000000c', name: 'verify-atlas-1' }

const head = (fields: Partial<ThreadRow> = {}): ThreadRow => ({
  id: 'atlas-1-id',
  key: 'atlas-1',
  lane: 'atlas',
  title: 'Map the price columns',
  summary: '',
  status: 'doing',
  waitingOn: '',
  proposed: null,
  assignee: ben,
  parent: null,
  scope: 'local',
  createdBy: { kind: 'owner' },
  createdAt: NOW,
  updatedAt: NOW,
  doneAt: null,
  rev: 1,
  parentKey: null,
  children: { done: 0, all: 0 },
  ...fields,
})
const entry = (n: number, fields: Partial<ThreadEntryView>): ThreadEntryView => ({
  id: `e${n}`,
  thread: 'atlas-1-id',
  n,
  seq: n,
  at: NOW + n,
  author: ben,
  type: 'note',
  text: '',
  ...fields,
})
const threads: Threads = { rows: [], known: new Set(), rev: 1, open() {}, asked: null, shown: false, setShown() {} }
function render(node: ReactNode, value: Board): string {
  return renderToStaticMarkup(
    <I18nProvider lang="en">
      <BoardContext.Provider value={value}>
        <ThreadsContext.Provider value={threads}>{node}</ThreadsContext.Provider>
      </BoardContext.Provider>
    </I18nProvider>,
  )
}
const value = board({ data: payload({ threads: { rev: 1, needsOwner: 0 } }) })

test('a held done: the acceptance lines, the verifier running, its words beside Confirm and Keep open', () => {
  const view: ThreadView = {
    head: head({
      proposed: { by: ben, at: NOW, why: 'all rows mapped', verify: true },
      verify: {
        on: true,
        lane: true,
        accept: ['every row mapped', 'nothing else changed'],
        run: { key: (vf as { key: string }).key, name: 'verify-atlas-1', at: NOW, until: NOW + 30 * 60_000 },
        fails: 1,
        last: 'fail',
      },
    }),
    children: [],
    entries: [
      entry(1, {
        author: { kind: 'owner' },
        type: 'system',
        set: { title: 'Map the price columns', status: 'doing', verify: true },
      }),
    ],
    earlier: 0,
    ask: null,
  }
  const html = render(<ThreadPane view={view} onOpen={() => {}} onBack={() => {}} />, value)
  expect(html).toContain('<b>Verified done</b>')
  expect(html).toContain('from its lane')
  expect(html).toContain('Last verdict: fail')
  expect(html).toContain('<li>every row mapped</li><li>nothing else changed</li>')
  expect(html).toMatch(/Verification running: verify-atlas-1 until (\d\d:\d\d|\d{4}-\d\d-\d\d \d\d:\d\d)/)
  expect(html).toContain('says it is done; a verifier checks it first: all rows mapped')
  expect(html).toContain('>Confirm</button>')
  // Waiting for one.
  const waiting = render(
    <ThreadPane
      view={{
        ...view,
        head: { ...view.head, verify: { ...(view.head.verify as NonNullable<ThreadRow['verify']>), run: null } },
      }}
      onOpen={() => {}}
      onBack={() => {}}
    />,
    value,
  )
  expect(waiting).toContain('Waiting for a verifier')
})

test('the feed: the verifier started and the verdict, its line and report as the entry', () => {
  const entries = [
    entry(1, { author: { kind: 'owner' }, type: 'system', set: { title: 'Map', status: 'doing', verify: true } }),
    entry(2, { text: 'all 217 rows', set: { status: 'done', hold: true, summary: 'mapped' } }),
    entry(3, {
      author: vf,
      type: 'system',
      set: { verifier: { key: 'k', name: 'verify-atlas-1', at: NOW, until: NOW + 1 } },
    }),
    entry(4, {
      author: vf,
      text: 'both lines checked',
      set: { verdict: 'pass', status: 'done', summary: 'mapped' },
      files: [{ name: 'report.md', size: 10, ref: 'thread-files/t/report.md', path: '/s/report.md' }],
    }),
  ]
  const feed = feedOf(head({ status: 'done' }), entries, null)
  expect(feed.filter(f => f.kind === 'status').map(f => f.kind === 'status' && f.did)).toEqual([
    'created',
    'proposed',
    'verifier',
    'verdict',
  ])
  expect(feed.at(-1)).toMatchObject({ kind: 'message', entry: { id: 'e4' } })
  const html = render(
    <ThreadPane
      view={{
        head: head({
          status: 'done',
          summary: 'mapped',
          verify: { on: true, accept: [], run: null, fails: 0, last: 'pass' },
        }),
        children: [],
        entries,
        earlier: 0,
        ask: null,
      }}
      onOpen={() => {}}
      onBack={() => {}}
    />,
    value,
  )
  expect(html).toContain('started the verifier')
  expect(html).toContain('verdict: pass · Done')
  expect(html).toContain('report.md')
})

test('a thread that never had verification draws as before: no block, no verify words', () => {
  const html = render(
    <ThreadPane
      view={{ head: head(), children: [], entries: [], earlier: 0, ask: null }}
      onOpen={() => {}}
      onBack={() => {}}
    />,
    value,
  )
  expect(html).not.toContain('wt-verify')
  expect(html).not.toContain('Verified done')
})
