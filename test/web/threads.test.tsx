// Threads on the board's page (#392, docs/design/threads 10, 8): what the panel makes of the list
// and of one thread, a card's chips (and a card with no thread drawn as before), the toolbar's
// pill only while threads are on, the sheet's fold, keys in text as links, and the links that open
// a thread: the address of a page opened for one, the same address in an open tab, and the
// stream's `thread-open`.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BoardPayload } from '../../src/core/payload.ts'
import type { Party, ThreadEntryView, ThreadRow, ThreadView } from '../../src/core/work-threads.ts'
import { Card } from '../../web/src/components/Card.tsx'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import { CardThreadChips, SheetThreads } from '../../web/src/components/threads/bits.tsx'
import { ThreadPane } from '../../web/src/components/threads/ThreadPane.tsx'
import { type Threads, ThreadsContext } from '../../web/src/hooks/useThreads.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import {
  boardLinkOf,
  chipsOf,
  feedOf,
  keyParts,
  listenForThreadOpens,
  sectionsOf,
  threadInHash,
} from '../../web/src/models/work-threads.ts'
import { type Board, BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { board, item, payload } from './support/board.tsx'
import { answers, restoreFetch } from './support/fetch-answers.ts'

const NOW = Date.parse('2026-11-12T14:00:00Z')
const MAPPER = '0b0b0b0b-0000-4000-8000-00000000000b'
const mapper: Party = { kind: 'session', key: MAPPER, name: 'atlas-mapper' }
const master: Party = { kind: 'session', key: 'pane-wP:p1', name: 'atlas-master' }

function row(fields: Partial<ThreadRow> & Pick<ThreadRow, 'key'>): ThreadRow {
  return {
    id: `${fields.key}-id`,
    lane: 'atlas',
    title: `Title of ${fields.key}`,
    summary: '',
    status: 'doing',
    waitingOn: '',
    proposed: null,
    assignee: null,
    parent: null,
    scope: 'local',
    createdBy: master,
    createdAt: NOW,
    updatedAt: NOW,
    doneAt: null,
    rev: 1,
    parentKey: null,
    children: { done: 0, all: 0 },
    ...fields,
  }
}

const ROWS: ThreadRow[] = [
  row({ key: 'atlas-1', status: 'next', children: { done: 1, all: 3 } }),
  row({
    key: 'atlas-2',
    status: 'done',
    assignee: mapper,
    parent: 'atlas-1-id',
    parentKey: 'atlas-1',
    updatedAt: NOW - 5,
  }),
  row({ key: 'atlas-3', status: 'owner', assignee: mapper, waitingOn: 'Which list wins?', updatedAt: NOW - 1 }),
  row({ key: 'atlas-4', status: 'doing', assignee: mapper, updatedAt: NOW - 2 }),
  row({ key: 'atlas-5', status: 'waiting', assignee: mapper, updatedAt: NOW - 3 }),
  row({ key: 'other-1', lane: 'other', status: 'dropped' }),
]

function threads(rows: ThreadRow[] = ROWS): Threads {
  return {
    rows,
    known: new Set(rows.map(r => r.key)),
    rev: 1,
    open() {},
    asked: null,
    shown: false,
    setShown() {},
  }
}

function render(node: ReactNode, value: Board, t: Threads | null = null): string {
  return renderToStaticMarkup(
    <I18nProvider lang="en">
      <BoardContext.Provider value={value}>
        <ThreadsContext.Provider value={t}>{node}</ThreadsContext.Provider>
      </BoardContext.Provider>
    </I18nProvider>,
  )
}

const card = (fields: Parameters<typeof item>[0]) => (
  <Card
    item={item(fields)}
    selected={false}
    busy={undefined}
    placeholder={false}
    launch={undefined}
    onPointerDown={() => {}}
    onClick={() => {}}
    onKeyDown={() => {}}
  />
)

// ------------------------------------------------------------------ the model

test('the list: five sections in order, each the newest change first; a lane and words narrow it', () => {
  const all = sectionsOf(ROWS, { lane: null, query: '' })
  expect(all.map(s => s.id)).toEqual(['owner', 'doing', 'waiting', 'next', 'done'])
  expect(all.find(s => s.id === 'done')?.rows.map(r => r.key)).toEqual(['other-1', 'atlas-2'])
  expect(sectionsOf(ROWS, { lane: 'other', query: '' }).map(s => s.rows.map(r => r.key))).toEqual([['other-1']])
  expect(sectionsOf(ROWS, { lane: null, query: 'which LIST' }).flatMap(s => s.rows.map(r => r.key))).toEqual([
    'atlas-3',
  ])
  expect(sectionsOf(ROWS, { lane: null, query: 'mapper atlas-4' }).flatMap(s => s.rows.map(r => r.key))).toEqual([
    'atlas-4',
  ])
})

test("a card's chips: its session's open threads, what needs the owner first, two at most and how many more", () => {
  expect(chipsOf(ROWS, MAPPER)).toEqual({
    shown: [ROWS[2] as ThreadRow, ROWS[3] as ThreadRow],
    more: 1,
  })
  expect(chipsOf(ROWS, 'someone-else')).toEqual({ shown: [], more: 0 })
})

test('links: #thread=<key> only for a key, and only links to this very page count', () => {
  expect(threadInHash('#thread=atlas-12')).toBe('atlas-12')
  expect(threadInHash('#thread=ATLAS-12&entry=4')).toBe('atlas-12')
  expect(threadInHash('#thread=../x')).toBe(null)
  expect(threadInHash('#session=abc')).toBe(null)
  const here = { origin: 'http://127.0.0.1:12422', pathname: '/' }
  expect(boardLinkOf('http://127.0.0.1:12422/#thread=atlas-3', here)).toEqual({ thread: 'atlas-3' })
  expect(boardLinkOf('#thread=atlas-3', here)).toEqual({ thread: 'atlas-3' })
  expect(boardLinkOf(`http://127.0.0.1:12422/#session=${MAPPER}`, here)).toEqual({ session: MAPPER })
  expect(boardLinkOf('http://127.0.0.1:9999/#thread=atlas-3', here)).toBe(null)
  expect(boardLinkOf('https://example.com/#thread=atlas-3', here)).toBe(null)
  expect(boardLinkOf('http://127.0.0.1:12422/docs#thread=atlas-3', here)).toBe(null)
})

test('keys in text: only known keys, whole words, never inside a longer name or a path', () => {
  const known = new Set(['atlas-3', 'atlas-12'])
  expect(keyParts('see atlas-3 and atlas-12, not atlas-4', known)).toEqual([
    'see ',
    { key: 'atlas-3' },
    ' and ',
    { key: 'atlas-12' },
    ', not atlas-4',
  ])
  expect(keyParts('my-atlas-3 /x/atlas-3 atlas-3x atlas-30', known)).toEqual([
    'my-atlas-3 /x/atlas-3 atlas-3x atlas-30',
  ])
  expect(keyParts('atlas-3', new Set())).toEqual(['atlas-3'])
})

test("the stream's thread-open: a key becomes the one to show, counted; anything else changes nothing", () => {
  let listener: ((e: MessageEvent) => void) | null = null
  let state: { key: string; n: number } | null = null
  listenForThreadOpens(
    {
      addEventListener: (_t, l) => {
        listener = l
      },
    },
    next => {
      state = next(state)
    },
  )
  const fire = (data: string) => listener?.({ data } as MessageEvent)
  fire('{"key":"atlas-3"}')
  fire('{"key":"atlas-3"}')
  fire('{"key":"../etc"}')
  fire('not json')
  expect(state as unknown).toEqual({ key: 'atlas-3', n: 2 })
})

const entry = (n: number, fields: Partial<ThreadEntryView>): ThreadEntryView => ({
  id: `e${n}`,
  thread: 't',
  n,
  seq: n,
  at: NOW + n,
  author: mapper,
  type: 'note',
  text: '',
  ...fields,
})

test('the feed: status lines quiet, words as messages, an open question as a block, a proposal, Confirm and Keep open said', () => {
  const head = row({ key: 'atlas-3' })
  const entries = [
    entry(1, { author: master, type: 'system', set: { title: 'x', status: 'doing', lane: 'atlas' } }),
    entry(2, { type: 'ask', text: 'Which list?', set: { status: 'owner', waitingOn: 'Which list?' } }),
    entry(3, { set: { status: 'done', summary: 'mapped' } }),
    entry(4, { author: { kind: 'owner' }, set: { status: 'owner' } }),
    entry(5, { text: 'Mapped with 2019', set: { status: 'done', summary: 'mapped again' } }),
    entry(6, { author: { kind: 'owner' }, set: { status: 'done', summary: 'mapped again' } }),
  ]
  const feed = feedOf(head, entries, 'e2')
  expect(
    feed.map(f => (f.kind === 'status' ? `${f.kind}:${f.did}:${f.to}` : f.kind === 'ask' ? `ask:${f.open}` : f.kind)),
  ).toEqual([
    'day',
    'status:created:doing',
    'ask:true',
    'status:proposed:owner',
    'status:kept:owner',
    'status:proposed:owner',
    'message',
    'status:confirmed:done',
  ])
})

test("a remote page offers threads only when hello says it is the owner's own login with threads on", async () => {
  const { helloOf } = await import('../../web/src/models/remote-page.ts')
  expect(helloOf({ board: 'agent-board', threads: true })?.threads).toBe(true)
  // As hello was: no field at all for anyone else.
  expect(helloOf({ board: 'agent-board' }) ?? {}).not.toHaveProperty('threads')
  expect(helloOf({ board: 'agent-board', threads: 'yes' }) ?? {}).not.toHaveProperty('threads')
})

// ------------------------------------------------------------------ what is drawn

test('a card whose session has no thread is drawn exactly as with threads off; one that has them shows its chips', () => {
  const value = board({ data: payload({ threads: { rev: 1, needsOwner: 1 } }) })
  const plain = { key: 'pane-p9', name: 'cleo', doing: 'Checking the codes, see atlas-3' }
  // Threads off: no context at all, as on main.
  const off = render(card(plain), value, null)
  expect(render(card(plain), value, threads([]))).toBe(off)
  // On, with threads that are other sessions': the same markup but the known key in the doing line.
  const on = render(card(plain), value, threads())
  expect(on.replace(/<a class="wt-keylink"[^>]*>(atlas-3)<\/a>/, '$1')).toBe(off)
  expect(on).toContain('href="#thread=atlas-3"')
  expect(off).not.toContain('wt-')

  const chips = render(card({ key: MAPPER, name: 'atlas-mapper' }), value, threads())
  const keys = [...chips.matchAll(/class="wt-chip"[^>]*>.*?<\/span>([a-z0-9-]+)<\/button>/g)].map(m => m[1])
  expect(keys).toEqual(['atlas-3', 'atlas-4'])
  expect(chips).toContain('class="wt-chip more"')
  expect(chips).toContain('>+1</button>')
  expect(render(<CardThreadChips session={MAPPER} />, value, null)).toBe('')
})

test('the toolbar: a Threads pill counting what needs the owner, only while the payload carries threads', () => {
  const toolbar = (data: BoardPayload, t: Threads | null) =>
    render(<Toolbar limitsAnchor={createRef<HTMLButtonElement>()} {...(t && { onThreads() {} })} />, board({ data }), t)
  const off = toolbar(payload(), null)
  expect(off).not.toContain('threads-open')
  const on = toolbar(payload({ threads: { rev: 3, needsOwner: 2 } }), threads())
  expect(on).toContain('id="threads-open"')
  expect(on).toMatch(/id="threads-open"[^>]*>.*?<span>Threads<\/span><span class="n">2<\/span>/)
  expect(on).toContain('class="pill-toggle icon-only unread" id="threads-open"')
})

test("the sheet's fold: the session's threads, folded to a line that counts them; nothing for a session with none", () => {
  const value = board()
  const fold = render(<SheetThreads session={MAPPER} />, value, threads())
  expect(fold).toContain('aria-expanded="false"')
  expect(fold).toContain('3 open of 4')
  expect(render(<SheetThreads session="pane-nobody" />, value, threads())).toBe('')
  expect(render(<SheetThreads session={MAPPER} />, value, null)).toBe('')
})

test('one thread: the head, its open question as a block with the composer answering it, a proposed close with its buttons', () => {
  const asked: ThreadView = {
    head: row({
      key: 'atlas-3',
      status: 'owner',
      assignee: mapper,
      waitingOn: 'Which list wins?',
      parentKey: 'atlas-1',
    }),
    children: [],
    entries: [
      entry(1, { author: master, type: 'system', set: { title: 'Map', status: 'doing', lane: 'atlas' } }),
      entry(2, {
        type: 'ask',
        text: 'Which list wins? See atlas-1',
        set: { status: 'owner', waitingOn: 'Which list wins?' },
      }),
    ],
    earlier: 0,
    ask: 'e2',
  }
  const value = board({ data: payload({ threads: { rev: 1, needsOwner: 1 } }) })
  const html = render(<ThreadPane view={asked} onOpen={() => {}} onBack={() => {}} />, value, threads())
  expect(html).toContain('<code>atlas-3</code>Title of atlas-3')
  expect(html).toContain('class="wt-asked open"')
  expect(html).toContain('atlas-mapper asks you')
  expect(html).toContain('placeholder="Answer"')
  expect(html).toMatch(/class="wt-crumb"><button type="button">atlas-1<\/button>/)
  expect(html).toContain('href="#thread=atlas-1"')

  const proposed: ThreadView = {
    ...asked,
    head: { ...asked.head, proposed: { by: mapper, at: NOW, why: 'mapped with 2019' } },
  }
  const p = render(<ThreadPane view={proposed} onOpen={() => {}} onBack={() => {}} />, value, threads())
  expect(p).toContain('<b>atlas-mapper</b> says this is done: mapped with 2019')
  expect(p).toContain('>Keep open</button>')
  expect(p).toContain('>Confirm</button>')

  const parent: ThreadView = {
    ...asked,
    head: row({ key: 'atlas-1', status: 'next' }),
    entries: [],
    ask: null,
    children: [ROWS[1] as ThreadRow, ROWS[2] as ThreadRow],
  }
  const k = render(<ThreadPane view={parent} onOpen={() => {}} onBack={() => {}} />, value, threads())
  expect(k).toContain('class="wt-subs"')
  expect(k).toContain('No entries yet')
  expect(k).toContain('placeholder="Add a note"')
})

// ------------------------------------------------------------------ links, live

type Globals = { location?: unknown; history?: unknown }
const saved: Globals = {}

beforeAll(() => {
  saved.location = Reflect.get(globalThis, 'location')
  saved.history = Reflect.get(globalThis, 'history')
})
afterAll(() => {
  Reflect.set(globalThis, 'location', saved.location)
  Reflect.set(globalThis, 'history', saved.history)
  restoreFetch()
})

test('a thread opens from its link: the page opened for it, the address followed in the open tab, the stream; off, nothing', async () => {
  const { miniWindow } = await import('./support/mini-dom.ts')
  const win = miniWindow(800)
  const location = { hash: '#thread=atlas-3', pathname: '/', search: '', origin: 'http://127.0.0.1:12422' }
  const replaced: string[] = []
  Reflect.set(globalThis, 'location', location)
  Reflect.set(globalThis, 'history', {
    state: null,
    replaceState(_s: unknown, _t: string, url: string) {
      replaced.push(url)
      location.hash = ''
    },
  })
  answers([200, { ok: true, rev: 1, threads: ROWS }], [200, { ok: true, rev: 1, threads: ROWS }])
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const { ThreadsProvider, useThreadsContext } = await import('../../web/src/hooks/useThreads.tsx')
  const { useThreadLinks } = await import('../../web/src/hooks/useThreadLinks.ts')
  const seen: (string | null)[] = []
  function Probe() {
    useThreadLinks()
    const t = useThreadsContext()
    if (t?.asked) seen.push(t.asked.key)
    return null
  }
  const container = win.document.body.appendChild(win.document.createElement('div'))
  const root = createRoot(container as unknown as HTMLElement)
  const show = (value: Board) =>
    flushSync(() =>
      root.render(
        <I18nProvider lang="en">
          <BoardContext.Provider value={value}>
            <ThreadsProvider>
              <Probe />
            </ThreadsProvider>
          </BoardContext.Provider>
        </I18nProvider>,
      ),
    )
  try {
    // Threads off: the address is left as it is and nothing opens.
    show(board({ data: payload() }))
    await Bun.sleep(20)
    expect(seen).toEqual([])
    expect(location.hash).toBe('#thread=atlas-3')
    // On: the page opened for atlas-3 opens it, and the address forgets it.
    show(board({ data: payload({ threads: { rev: 1, needsOwner: 1 } }) }))
    await Bun.sleep(20)
    expect(seen.at(-1)).toBe('atlas-3')
    expect(replaced).toEqual(['/'])
    // The same address followed in this open tab.
    location.hash = '#thread=atlas-4'
    dispatchEvent(new Event('hashchange'))
    await Bun.sleep(20)
    expect(seen.at(-1)).toBe('atlas-4')
    // The stream's thread-open while the page is open.
    show(board({ data: payload({ threads: { rev: 1, needsOwner: 1 } }), threadOpen: { key: 'atlas-5', n: 1 } }))
    await Bun.sleep(20)
    expect(seen.at(-1)).toBe('atlas-5')
  } finally {
    flushSync(() => root.unmount())
    // React's scheduler runs once more after the unmount: the window stays until it has.
    await Bun.sleep(20)
    win.uninstall()
  }
})
