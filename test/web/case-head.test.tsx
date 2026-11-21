// Case files on the page (#488, components/threads/CaseHead.tsx): a case's reference, its state with
// the author's name as the board knows it, and its sessions with where they are; nothing for a thread
// that is no case, or while the route sends no case (case files off).
import { expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CaseSessionView } from '../../src/core/work-cases.ts'
import type { Party, ThreadRow } from '../../src/core/work-threads.ts'
import { CaseHead } from '../../web/src/components/threads/CaseHead.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { board } from './support/board.tsx'

const NOW = Date.parse('2026-11-20T14:00:00Z')
const ANNA = '0f8fad5b-d9cb-469f-a165-70867728950e'
const anna: Party = { kind: 'session', key: ANNA, name: '0f8fad5b' }

const row = (fields: Partial<ThreadRow> = {}): ThreadRow => ({
  id: 'atlas-1-id',
  key: 'atlas-1',
  lane: 'atlas',
  title: 'Import mapping',
  summary: '',
  status: 'doing',
  waitingOn: '',
  proposed: null,
  assignee: anna,
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

const sessions: CaseSessionView[] = [
  {
    key: ANNA,
    name: 'anna',
    holds: true,
    held: true,
    created: false,
    wrote: 2,
    last: NOW,
    state: 'archived',
    cwd: '/work',
  },
  {
    key: 'pane-wA:p3',
    name: 'ben cooper',
    holds: false,
    held: false,
    created: false,
    wrote: 1,
    last: NOW,
    state: 'up',
  },
]

const render = (node: ReactNode): string =>
  renderToStaticMarkup(
    <I18nProvider lang="en">
      <BoardContext.Provider value={board()}>{node}</BoardContext.Provider>
    </I18nProvider>,
  )

test('a case: its reference as a link, its state with its author by name, its sessions with where they are', () => {
  const html = render(
    <CaseHead
      head={row({
        ref: 'https://tracker.example/browse/ABC-12',
        state: { text: 'Mapped.\nNext: prices.', at: NOW, by: anna },
      })}
      sessions={sessions}
    />,
  )
  expect(html).toContain('class="wt-case"')
  expect(html).toContain('href="https://tracker.example/browse/ABC-12"')
  expect(html).toContain('Where it stands')
  expect(html).toMatch(/· anna<\/span>/)
  expect(html).toContain('Mapped.\nNext: prices.')
  expect(html).toContain('data-state="archived"')
  expect(html).toContain('>archived<')
  expect(html).toContain('>holds it<')
  expect(html).toContain('data-state="up"')
  expect(html).toContain('>pane-wA:p3<')
  // A bare id as code, not a link.
  expect(render(<CaseHead head={row({ ref: 'ABC-12' })} sessions={[]} />)).toContain('<code>ABC-12</code>')
})

test("a node's session: up on its device, or on its device and not known here", () => {
  const html = render(
    <CaseHead
      head={row({ ref: 'ABC-12' })}
      sessions={[
        { ...sessions[1], key: '@server-1:s-1', state: 'unknown', device: 'server-1' } as CaseSessionView,
        { ...sessions[1], key: '@server-1:s-2', state: 'up', device: 'server-1' } as CaseSessionView,
      ]}
    />,
  )
  expect(html).toContain('>on server-1, state not known here<')
  expect(html).toContain('>up on server-1<')
  expect(html).not.toContain('>gone<')
  const seen = render(
    <CaseHead
      head={row({ ref: 'ABC-12' })}
      sessions={[
        { ...sessions[1], key: '@server-1:s-1', state: 'up', device: 'server-1', seenAt: NOW } as CaseSessionView,
      ]}
    />,
  )
  expect(seen).toMatch(/>last seen up on server-1, [^<]+</)
})

test('no case: nothing drawn, also while case files are off (no sessions sent)', () => {
  expect(render(<CaseHead head={row()} sessions={[]} />)).toBe('')
  expect(render(<CaseHead head={row({ ref: 'ABC-12' })} sessions={undefined} />)).toBe('')
})
