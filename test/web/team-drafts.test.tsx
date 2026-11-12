// The agents' drafts that wait for the owner in the Team panel (#415): every thread's at the top of
// the list, each with where it goes, its first line, its file's name and size, who wrote it and why
// the board held it, Send and Discard, and its head opening the thread; in the thread a draft says
// when the agent wrote it; the panel's data takes them from GET /api/team/threads.
import { afterEach, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { TeamBody, type TeamBodyProps } from '../../web/src/components/team/TeamPanel.tsx'
import { teamSource } from '../../web/src/hooks/useTeam.ts'
import { type DraftLine, draftWhere, type ThreadView } from '../../web/src/models/team.ts'
import { board, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch } from './support/fetch-answers.ts'
import { findAll, type Node } from './support/markup.ts'
import { type Host, hostElements } from './support/react-events.ts'

afterEach(restoreFetch)

const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
const ANNA = 'A'.repeat(43)
const TOPIC = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'
const VIEW = {
  state: 'online' as const,
  me: { peer: 'M'.repeat(43), fingerprint: 'aaaa', name: 'me' },
  hub: 'wss://hub.example.com',
  roster: [
    { peer: ANNA, name: 'anna', online: true, lastSeen: null, fingerprint: '1111', pin: 'trusted' as const, drafts: 2 },
  ],
}
const thread = (key: string, more: Partial<ThreadView> = {}): ThreadView =>
  ({
    key,
    scope: key.split('/')[0],
    id: key.split('/')[1],
    title: null,
    link: null,
    handler: null,
    muted: false,
    by: 'me',
    createdAt: 1,
    lastAt: 1,
    peerName: null,
    ...more,
  }) as ThreadView
const THREADS = [thread(`${ANNA}/${TOPIC}`, { title: 'Proposal' }), thread('team/general')]
const DRAFTS: DraftLine[] = [
  {
    id: 'ba370f97-03d9-441d-b958-4dff693e9c9e',
    to: ANNA,
    key: `${ANNA}/${TOPIC}`,
    reason: 'secret',
    agent: 'docs',
    ts: '2026-11-12T18:08:18.000Z',
    text: 'the proposal, v2\nmore lines',
    file: { name: 'PROPOSAL.md', size: 19762 },
  },
  {
    id: '7a7a7a7a-0000-4000-8000-000000000000',
    to: 'team',
    key: 'team/general',
    reason: 'loop',
    ts: '2026-11-12T13:18:00.000Z',
    text: 'hi all',
  },
]

function body(over: Partial<TeamBodyProps> = {}): TeamBodyProps {
  return {
    view: VIEW as never,
    threads: THREADS,
    selected: null,
    thread: null,
    lines: [],
    drafts: DRAFTS,
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

test('the list shows every waiting draft: where, its first line, its file and size, who and why', () => {
  const out = renderInBoard(<TeamBody {...body()} />, board())
  const cards = findAll(out, n => n.kind === 'element' && n.attrs.has('data-draft'))
  expect(cards).toHaveLength(2)
  const first = text([cards[0] as Node])
  expect(first).toContain('anna · Proposal')
  expect(first).toContain('the proposal, v2')
  expect(first).not.toContain('more lines')
  expect(first).toContain('PROPOSAL.md · 19.3 KB')
  expect(first).toContain('docs')
  expect(first).toContain('held: it looks like it carries a secret')
  expect(text([cards[1] as Node])).toContain('Team chat')
  expect(text(out)).toContain('Drafts waiting for you 2')
  // None waiting: no section.
  const none = renderInBoard(<TeamBody {...body({ drafts: [] })} />, board())
  expect(findAll(none, n => n.kind === 'element' && n.attrs.has('data-draft'))).toEqual([])
  expect(text(none)).not.toContain('Drafts waiting for you')
})

test("a draft's Send and Discard act on it; its head opens its thread; Send waits while the key changed", () => {
  const did: string[] = []
  let hosts: Host[] = []
  const probe = (over: Partial<TeamBodyProps>) => {
    function Probe() {
      hosts = hostElements(
        <TeamBody
          {...body({
            onSendDraft: id => void did.push(`send ${id}`),
            onDiscardDraft: id => void did.push(`discard ${id}`),
            onSelect: key => void did.push(`open ${key}`),
            ...over,
          })}
        />,
      )
      return null
    }
    renderInBoard(<Probe />, board())
  }
  probe({})
  const card = (id: string) => {
    const at = hosts.findIndex(h => h.props['data-draft'] === id)
    const end = hosts.findIndex((h, i) => i > at && h.props['data-draft'] !== undefined)
    return hosts.slice(at, end < 0 ? undefined : end).filter(h => h.tag === 'button')
  }
  const buttons = card(DRAFTS[0]?.id as string)
  expect(buttons).toHaveLength(3)
  for (const b of buttons) (b.props.onClick as () => void)()
  expect(did).toEqual([`open ${ANNA}/${TOPIC}`, `discard ${DRAFTS[0]?.id}`, `send ${DRAFTS[0]?.id}`])
  probe({ view: { ...VIEW, roster: [{ ...VIEW.roster[0], pin: 'changed' }] } as never })
  expect(card(DRAFTS[0]?.id as string)[2]?.props.disabled).toBe(true)
})

test('in its thread a draft says when the agent wrote it, so two drafts of one file are told apart', () => {
  const line = (id: string, ts: string) => ({
    id,
    dir: 'draft' as const,
    text: '',
    ts,
    via: 'agent' as const,
    file: { state: 'draft' as const, name: 'PROPOSAL.md', size: 19762 },
  })
  const out = renderInBoard(
    <TeamBody
      {...body({
        selected: `${ANNA}/${TOPIC}`,
        thread: THREADS[0] as ThreadView,
        lines: [line('d1', '2026-11-12T13:17:00.000Z'), line('d2', '2026-11-12T18:08:00.000Z')],
      })}
    />,
    board(),
  )
  const whens = findAll(out, n => n.kind === 'element' && n.attrs.get('class') === 'team-draft-when').map(n =>
    text([n]),
  )
  expect(whens).toHaveLength(2)
  expect(whens[0]).not.toBe(whens[1])
})

test('draftWhere: a new topic by the title it would start; a former member; a channel by its title', () => {
  const t = translator('en')
  const v = VIEW as never
  expect(draftWhere({ ...(DRAFTS[0] as DraftLine), key: `${ANNA}/general`, title: 'Plan' }, THREADS, v, t)).toBe(
    'anna · new topic “Plan”',
  )
  expect(draftWhere({ ...(DRAFTS[0] as DraftLine), key: `${'B'.repeat(43)}/general` }, THREADS, v, t)).toBe(
    'a former member',
  )
  const channel = thread(`team/${TOPIC}`, { title: 'ops', members: [ANNA] })
  expect(draftWhere({ ...(DRAFTS[1] as DraftLine), key: channel.key }, [channel], v, t)).toBe('ops')
})

test('the panel takes the drafts from the thread list; a board that sends none leaves the list empty', async () => {
  answers(
    [200, VIEW],
    [200, { threads: THREADS, drafts: DRAFTS }],
    [200, { off: false, listener: null, peers: {}, paused: {}, lanes: [] }],
    [200, { pending: [] }],
  )
  const source = teamSource({ t: () => translator('en'), toast: () => {}, remote: () => false })
  source.sync(true, 1)
  const end = Date.now() + 2000
  while (!source.now.get().drafts.length && Date.now() < end) await Bun.sleep(5)
  expect(source.now.get().drafts.map(d => d.id)).toEqual(DRAFTS.map(d => d.id))
  answers(
    [200, VIEW],
    [200, { threads: THREADS }],
    [200, { off: false, listener: null, peers: {}, paused: {}, lanes: [] }],
    [200, { pending: [] }],
  )
  source.sync(true, 2)
  const end2 = Date.now() + 2000
  while (source.now.get().drafts.length && Date.now() < end2) await Bun.sleep(5)
  expect(source.now.get().drafts).toEqual([])
})
