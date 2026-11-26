// Component and model tests for #835: folding old read topics per person with localStorage
// persistence, Slack-like sections + quick topic filter, and denser grouped messages.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import { ThreadsContext } from '../../web/src/hooks/useThreads.tsx'
import type { DraftLine, TeamView, ThreadLine, ThreadView } from '../../web/src/models/team.ts'
import {
  filterScope,
  isOldReadTopic,
  loadExpandedScopes,
  OLD_TOPIC_MS,
  OLDER_OPEN_KEY,
  saveExpandedScopes,
  splitScopeEntries,
  toggleExpandedScope,
} from '../../web/src/models/team-list.ts'
import { board, renderInBoard } from './support/board.tsx'
import { findAll, hasClass, type Node as MarkupNode } from './support/markup.ts'

const NOW = Date.parse('2026-11-26T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const ANNA = 'A'.repeat(43)
const BEN = 'B'.repeat(43)
const ME = 'M'.repeat(43)
const isoAt = (ms: number) => new Date(ms).toISOString()

const peer = (id: string, name: string, online = true) => ({
  peer: id,
  name,
  online,
  lastSeen: online ? null : NOW - 3600_000,
  fingerprint: '1111',
  pin: 'trusted' as const,
  drafts: 0,
})

const VIEW: TeamView = {
  state: 'online',
  me: { peer: ME, fingerprint: 'aaaa', name: 'me' },
  hub: 'wss://hub.example.com',
  roster: [peer(ANNA, 'Ana', true), peer(BEN, 'Ben', false)],
}

const topic = (
  scope: string,
  id: string,
  title: string | null,
  ageDays: number,
  extra: Partial<ThreadView> = {},
): ThreadView => {
  const lastAt = NOW - ageDays * DAY
  return {
    key: `${scope}/${id}`,
    scope,
    id,
    title,
    link: null,
    handler: null,
    muted: false,
    by: 'me',
    createdAt: lastAt - 3600_000,
    lastAt,
    peerName: scope === 'team' ? null : scope === ANNA ? 'Ana' : 'Ben',
    last: { dir: 'in', who: scope === ANNA ? 'Ana' : 'Ben', text: `${title ?? 'General'} latest`, ts: isoAt(lastAt) },
    ...extra,
  }
}

const text = (nodes: MarkupNode[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
const g = globalThis as Record<string, unknown>
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'MutationObserver',
  'getComputedStyle',
  'localStorage',
] as const
const saved = new Map<string, PropertyDescriptor | undefined>()

let createRoot: typeof import('react-dom/client').createRoot
let I18nProvider: typeof import('../../web/src/i18n/I18nProvider.tsx').I18nProvider
let BoardContext: typeof import('../../web/src/state/BoardProvider.tsx').BoardContext
let TeamBody: typeof import('../../web/src/components/team/TeamPanel.tsx').TeamBody
type TeamBodyProps = import('../../web/src/components/team/TeamPanel.tsx').TeamBodyProps

beforeAll(async () => {
  const win = dom.window as unknown as Record<string, unknown>
  for (const k of [...DOM_GLOBALS, 'IS_REACT_ACT_ENVIRONMENT']) saved.set(k, Object.getOwnPropertyDescriptor(g, k))
  for (const k of DOM_GLOBALS) Object.defineProperty(g, k, { value: win[k], configurable: true, writable: true })
  g.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx'))
  ;({ BoardContext } = await import('../../web/src/state/BoardProvider.tsx'))
  ;({ TeamBody } = await import('../../web/src/components/team/TeamPanel.tsx'))
})

afterEach(() => {
  dom.window.localStorage.clear()
})

afterAll(async () => {
  await new Promise(done => setTimeout(done, 25))
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(g, k, d)
    else delete g[k]
  }
})

function mount(lang = 'en') {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  return {
    host,
    draw(node: ReactNode) {
      act(() => {
        root.render(
          <I18nProvider lang={lang}>
            <BoardContext.Provider value={board({ now: NOW })}>{node}</BoardContext.Provider>
          </I18nProvider>,
        )
      })
    },
    unmount() {
      act(() => root.unmount())
      host.remove()
    },
  }
}

function bodyProps(over: Partial<TeamBodyProps> = {}): TeamBodyProps {
  return {
    view: VIEW,
    threads: [],
    selected: null,
    thread: null,
    lines: [],
    agents: null,
    draft: '',
    topic: null,
    disabled: false,
    onSelect() {},
    onTrust() {},
    onSendDraft() {},
    onDiscardDraft() {},
    onDraft() {},
    onTopic() {},
    onSend() {},
    onMute() {},
    onAgents() {},
    ...over,
  }
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

describe('team-list pure model (#835)', () => {
  test('isOldReadTopic folds only read, non-general, non-selected topics older than 7 days', () => {
    const oldRead = topic(ANNA, 't-old', 'Old topic', 8)
    const fresh = topic(ANNA, 't-fresh', 'Fresh topic', 2)
    const general = topic(ANNA, 'general', null, 30)
    const boundary = topic(ANNA, 't-7d', 'Exact 7d', 7)
    const { last: _last, ...syntheticBase } = topic(ANNA, 't-synth', 'Synthetic', 0)
    const synthetic: ThreadView = { ...syntheticBase, lastAt: 5 }

    const opts = { now: NOW, unread: { [oldRead.key]: 0 }, selected: null }
    expect(isOldReadTopic({ key: oldRead.key, thread: oldRead }, opts)).toBe(true)
    expect(isOldReadTopic({ key: fresh.key, thread: fresh }, opts)).toBe(false)
    expect(isOldReadTopic({ key: general.key, thread: general }, opts)).toBe(false)
    expect(isOldReadTopic({ key: boundary.key, thread: boundary }, opts)).toBe(false)
    expect(isOldReadTopic({ key: synthetic.key, thread: synthetic }, opts)).toBe(false)
    expect(OLD_TOPIC_MS).toBe(7 * DAY)
    // Unread never folds, selected never folds.
    expect(
      isOldReadTopic({ key: oldRead.key, thread: oldRead }, { now: NOW, unread: { [oldRead.key]: 2 }, selected: null }),
    ).toBe(false)
    expect(isOldReadTopic({ key: oldRead.key, thread: oldRead }, { now: NOW, unread: {}, selected: oldRead.key })).toBe(
      false,
    )
  })

  test('splitScopeEntries partitions general, visible (recent/unread/selected), and older read topics', () => {
    const gen = topic(ANNA, 'general', null, 20)
    const recent = topic(ANNA, 't-recent', 'Recent', 1)
    const oldUnread = topic(ANNA, 't-unread', 'Old unread', 14)
    const oldRead1 = topic(ANNA, 't-old-1', 'Old read 1', 10)
    const oldRead2 = topic(ANNA, 't-old-2', 'Old read 2', 12)
    const entries = [gen, recent, oldUnread, oldRead1, oldRead2].map(th => ({ key: th.key, thread: th }))
    const split = splitScopeEntries(entries, { now: NOW, unread: { [oldUnread.key]: 3 }, selected: null })
    expect(split.general?.key).toBe(gen.key)
    expect(split.visible.map(e => e.key)).toEqual([recent.key, oldUnread.key])
    expect(split.older.map(e => e.key)).toEqual([oldRead1.key, oldRead2.key])
  })

  test('loadExpandedScopes / saveExpandedScopes / toggleExpandedScope round-trip safely', () => {
    const mem = new Map<string, string>()
    const store = {
      read: (k: string) => mem.get(k) ?? null,
      set: (k: string, v: string) => void mem.set(k, v),
    }
    expect([...loadExpandedScopes(store)]).toEqual([])
    mem.set(OLDER_OPEN_KEY, 'not-json')
    expect([...loadExpandedScopes(store)]).toEqual([])
    const s1 = toggleExpandedScope(new Set(), ANNA)
    saveExpandedScopes(s1, store)
    expect([...loadExpandedScopes(store)]).toEqual([ANNA])
    const s2 = toggleExpandedScope(s1, ANNA)
    saveExpandedScopes(s2, store)
    expect([...loadExpandedScopes(store)]).toEqual([])
  })

  test('filterScope matches person name or topic titles', () => {
    const gen = topic(ANNA, 'general', null, 1)
    const t1 = topic(ANNA, 't1', 'Deploy checklist', 10)
    const t2 = topic(ANNA, 't2', 'Budget review', 2)
    const entries = [gen, t1, t2].map(th => ({ key: th.key, thread: th }))
    expect(filterScope(entries, 'deploy', 'Ana').general).toBeNull()
    expect(filterScope(entries, 'deploy', 'Ana').topics.map(e => e.key)).toEqual([t1.key])
    expect(filterScope(entries, 'ana', 'Ana').general?.key).toBe(gen.key)
    expect(filterScope(entries, 'ana', 'Ana').topics).toHaveLength(2)
  })
})

describe('TeamList folding, persistence and filter (#835)', () => {
  const ANA_GEN = topic(ANNA, 'general', null, 0)
  const ANA_RECENT = topic(ANNA, 'recent-1', 'Sprint kickoff', 2)
  const ANA_OLD_UNREAD = topic(ANNA, 'old-unread', 'Urgent bug', 15)
  const ANA_OLD_1 = topic(ANNA, 'old-1', 'Release 1.0', 9)
  const ANA_OLD_2 = topic(ANNA, 'old-2', 'Legacy cleanup', 20)
  const BEN_GEN = topic(BEN, 'general', null, 1)
  const BEN_OLD = topic(BEN, 'ben-old', 'Q3 retro', 14)
  const TEAM_GEN = topic('team', 'general', null, 0)
  const TEAM_OLD = topic('team', 'team-old', 'Office move', 18)
  const CHAN = topic('team', 'chan-ops', 'Ops channel', 3, { members: [ME, ANNA] })
  const WORK_TOPIC = {
    ...topic(ANNA, 'work-1', 'Track billing', 12),
    work: { key: 'atlas-3', status: 'doing', id: 'w1' },
  } as ThreadView

  const ALL_THREADS = [
    TEAM_GEN,
    TEAM_OLD,
    CHAN,
    ANA_GEN,
    ANA_RECENT,
    ANA_OLD_UNREAD,
    ANA_OLD_1,
    ANA_OLD_2,
    WORK_TOPIC,
    BEN_GEN,
    BEN_OLD,
  ]

  test('folds old read topics per person under "Older (N)", keeps general, recent and unread visible, and remembers state in localStorage', () => {
    const m = mount('en')
    try {
      const p = bodyProps({
        threads: ALL_THREADS,
        unread: { [ANA_OLD_UNREAD.key]: 4 },
      })
      m.draw(<TeamBody {...p} />)

      const visibleKeys = () =>
        [...m.host.querySelectorAll('button.team-row')].map(el => el.getAttribute('data-thread'))
      // Ana's general, recent, and old-unread are shown; her 3 older read topics (old-1, work-1, old-2) fold.
      expect(visibleKeys()).toContain(ANA_GEN.key)
      expect(visibleKeys()).toContain(ANA_RECENT.key)
      expect(visibleKeys()).toContain(ANA_OLD_UNREAD.key)
      expect(visibleKeys()).not.toContain(ANA_OLD_1.key)
      expect(visibleKeys()).not.toContain(ANA_OLD_2.key)
      expect(visibleKeys()).not.toContain(WORK_TOPIC.key)
      expect(visibleKeys()).not.toContain(BEN_OLD.key)
      expect(visibleKeys()).not.toContain(TEAM_OLD.key)

      // Unread row carries unread weight class.
      expect(m.host.querySelector(`[data-thread="${ANA_OLD_UNREAD.key}"]`)?.classList.contains('unread')).toBe(true)

      const anaToggle = m.host.querySelector(`[data-older-toggle="${ANNA}"]`) as HTMLButtonElement | null
      const benToggle = m.host.querySelector(`[data-older-toggle="${BEN}"]`) as HTMLButtonElement | null
      const teamToggle = m.host.querySelector('[data-older-toggle="team"]') as HTMLButtonElement | null
      expect(anaToggle?.textContent).toBe('Older (3)')
      expect(anaToggle?.getAttribute('aria-expanded')).toBe('false')
      expect(benToggle?.textContent).toBe('Older (1)')
      expect(teamToggle?.textContent).toBe('Older (1)')

      // Expand Ana's older topics in place.
      act(() => {
        anaToggle?.click()
      })
      expect(m.host.querySelector(`[data-older-toggle="${ANNA}"]`)?.getAttribute('aria-expanded')).toBe('true')
      expect(visibleKeys()).toContain(ANA_OLD_1.key)
      expect(visibleKeys()).toContain(ANA_OLD_2.key)
      expect(visibleKeys()).toContain(WORK_TOPIC.key)
      // Ben stays folded.
      expect(visibleKeys()).not.toContain(BEN_OLD.key)
      expect(JSON.parse(dom.window.localStorage.getItem(OLDER_OPEN_KEY) ?? '[]')).toEqual([ANNA])

      // Unmount and remount: Ana remains expanded, Ben remains folded.
      m.unmount()
      const m2 = mount('en')
      try {
        m2.draw(<TeamBody {...p} />)
        const keys2 = [...m2.host.querySelectorAll('button.team-row')].map(el => el.getAttribute('data-thread'))
        expect(keys2).toContain(ANA_OLD_1.key)
        expect(keys2).not.toContain(BEN_OLD.key)
        expect(m2.host.querySelector(`[data-older-toggle="${ANNA}"]`)?.getAttribute('aria-expanded')).toBe('true')

        // Collapse Ana again.
        act(() => {
          ;(m2.host.querySelector(`[data-older-toggle="${ANNA}"]`) as HTMLButtonElement | null)?.click()
        })
        expect(m2.host.querySelector(`[data-older-toggle="${ANNA}"]`)?.getAttribute('aria-expanded')).toBe('false')
        expect(JSON.parse(dom.window.localStorage.getItem(OLDER_OPEN_KEY) ?? '[]')).toEqual([])
      } finally {
        m2.unmount()
      }
    } finally {
      if (m.host.isConnected) m.unmount()
    }
  })

  test('Russian fold label and selected old topic stays visible', () => {
    const m = mount('ru')
    try {
      m.draw(<TeamBody {...bodyProps({ threads: [ANA_GEN, ANA_OLD_1, ANA_OLD_2], selected: ANA_OLD_1.key })} />)
      const rows = [...m.host.querySelectorAll('button.team-row')].map(el => el.getAttribute('data-thread'))
      expect(rows).toContain(ANA_OLD_1.key)
      expect(rows).not.toContain(ANA_OLD_2.key)
      expect(m.host.querySelector(`[data-older-toggle="${ANNA}"]`)?.textContent).toBe('Старые (1)')
    } finally {
      m.unmount()
    }
  })

  test('quick filter surfaces matching folded topics, person names, channels, work keys, and restores fold on clear/Escape', () => {
    const m = mount('en')
    try {
      m.draw(<TeamBody {...bodyProps({ threads: ALL_THREADS })} />)
      const input = m.host.querySelector('input[data-team-filter]') as HTMLInputElement | null
      expect(input).toBeTruthy()
      if (!input) return

      // Search a folded topic title ("Legacy"): surfaces it without needing to expand Older.
      act(() => setInput(input, 'legacy'))
      let rows = [...m.host.querySelectorAll('button.team-row')].map(el => el.getAttribute('data-thread'))
      expect(rows).toEqual([ANA_OLD_2.key])
      expect(m.host.querySelector('.team-peer-heading')?.textContent).toContain('Ana')
      expect(m.host.querySelectorAll('[data-older-toggle]')).toHaveLength(0)

      // Search by shared work key ("atlas-3").
      act(() => setInput(input, 'atlas-3'))
      rows = [...m.host.querySelectorAll('button.team-row')].map(el => el.getAttribute('data-thread'))
      expect(rows).toEqual([WORK_TOPIC.key])

      // Search by channel name.
      act(() => setInput(input, 'ops'))
      rows = [...m.host.querySelectorAll('button.team-row')].map(el => el.getAttribute('data-thread'))
      expect(rows).toEqual([CHAN.key])

      // Search with no matches shows empty state.
      act(() => setInput(input, 'nonexistent-xyz'))
      expect(m.host.querySelectorAll('button.team-row')).toHaveLength(0)
      expect(m.host.querySelector('[data-filter-empty]')?.textContent).toBe('No matching conversations.')

      // Clear button restores folded list.
      act(() => {
        ;(m.host.querySelector('[data-team-filter-clear]') as HTMLButtonElement | null)?.click()
      })
      expect(input.value).toBe('')
      expect(m.host.querySelector(`[data-older-toggle="${ANNA}"]`)).toBeTruthy()

      // Escape clears non-empty filter.
      act(() => setInput(input, 'retro'))
      expect([...m.host.querySelectorAll('button.team-row')].map(el => el.getAttribute('data-thread'))).toEqual([
        BEN_OLD.key,
      ])
      act(() => {
        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      expect(input.value).toBe('')
      expect(m.host.querySelector(`[data-older-toggle="${BEN}"]`)).toBeTruthy()
    } finally {
      m.unmount()
    }
  })
})

describe('grouped conversation messages and preserved features (#835)', () => {
  const msg = (id: string, min: number, over: Partial<ThreadLine> = {}): ThreadLine => ({
    id,
    dir: 'in',
    from: ANNA,
    who: 'Ana',
    text: `msg ${id}`,
    ts: isoAt(NOW - 60 * 60_000 + min * 60_000),
    ...over,
  })
  const mine = (id: string, min: number, over: Partial<ThreadLine> = {}): ThreadLine => ({
    id,
    dir: 'out',
    text: `mine ${id}`,
    ts: isoAt(NOW - 60 * 60_000 + min * 60_000),
    state: 'acked',
    ...over,
  })

  test('consecutive agent messages share one agent mark and carry grouped/first/last classes while keeping reactions, replies, quotes, files, shared switch, drafts', () => {
    const th: ThreadView = {
      ...topic(ANNA, 't-conv', 'Deploy', 0),
      work: { key: 'atlas-3', status: 'doing', id: 'w1' },
    } as ThreadView & { work: { key: string; status: 'doing'; id: string } }
    const lines: ThreadLine[] = [
      msg('m1', 0, {
        via: 'agent',
        agent: 'deploy-bot',
        reactions: [{ emoji: '👍', count: 1, me: true, peers: [] }],
      }),
      msg('m2', 1, { via: 'agent', agent: 'deploy-bot', replyTo: 'm1' }),
      mine('m3', 2, { file: { state: 'ready', name: 'log.txt', size: 120, url: '/uploads/2026-11-26/log.txt' } }),
      mine('m4', 3),
    ]
    const draftLine: ThreadLine = {
      id: 'd1',
      dir: 'draft',
      text: 'ready to merge',
      ts: isoAt(NOW - 60_000),
      via: 'agent',
      agent: 'deploy-bot',
      reason: 'off',
    }
    const listDraft: DraftLine = {
      id: 'd1',
      to: ANNA,
      key: th.key,
      ts: isoAt(NOW - 60_000),
      text: 'ready to merge',
      agent: 'deploy-bot',
      reason: 'off',
    }
    const nodes = renderInBoard(
      <ThreadsContext.Provider
        value={{ rows: [], known: new Set(), rev: 1, open() {}, asked: null, shown: false, setShown() {} }}
      >
        <TeamBody
          {...bodyProps({
            threads: [th],
            selected: th.key,
            thread: th,
            lines: [...lines, draftLine],
            drafts: [listDraft],
            onReact() {},
            onReply() {},
          })}
        />
      </ThreadsContext.Provider>,
      board({ now: NOW }),
    )

    const renderedMsgs = findAll(nodes, el => hasClass(el, 'team-msg'))
    expect(
      renderedMsgs.map(m => [
        m.attrs.get('data-line'),
        hasClass(m, 'first'),
        hasClass(m, 'last'),
        hasClass(m, 'grouped'),
      ]),
    ).toEqual([
      ['m1', true, false, true],
      ['m2', false, true, true],
      ['m3', true, false, true],
      ['m4', false, true, true],
    ])
    // Only m1 (first of the agent group) shows .team-agent-mark, plus the held draft has its own header.
    const msgMarks = findAll(renderedMsgs, el => hasClass(el, 'team-agent-mark'))
    expect(msgMarks).toHaveLength(1)
    expect(text(msgMarks)).toContain('deploy-bot')
    // Preserved functions: reactions, reply buttons, quote, file download, shared thread switch, drafts.
    expect(findAll(nodes, el => hasClass(el, 'team-react-chip'))).not.toHaveLength(0)
    expect(findAll(nodes, el => hasClass(el, 'team-msg-reply'))).toHaveLength(4)
    expect(findAll(nodes, el => hasClass(el, 'team-quote'))).toHaveLength(1)
    expect(text(nodes)).toContain('log.txt · 120 B')
    expect(findAll(nodes, el => el.attrs.get('data-topic-thread') === 'atlas-3')).toHaveLength(1)
    expect(findAll(nodes, el => el.attrs.has('data-draft'))).toHaveLength(1)
  })
})

describe('apple-design CSS media queries (#835)', () => {
  test('team.css honors reduced motion, reduced transparency, and increased contrast', () => {
    const css = readFileSync(resolve(import.meta.dir, '../../web/styles/team.css'), 'utf8')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('@media (prefers-reduced-transparency: reduce)')
    expect(css).toContain('@media (prefers-contrast: more)')
  })
})
