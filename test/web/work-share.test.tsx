// Shared threads on the board's page (#394, docs/design/threads 11): what a thread's head says of
// its sharing (shared with whom, an agent's request, a teammate's offer, the owner's Share), what an
// entry's way to the hub says, the feed's lines for sharing, a peer's agent named at its board, the
// Team list's pill and a topic's "Open as a thread" and "Track as a thread", and the confirmation
// window's words. A local thread on a board without Team draws exactly what it drew before.
import { expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Translator } from '../../src/core/types.ts'
import type { Party, ThreadEntryView, ThreadRow, ThreadView } from '../../src/core/work-threads.ts'
import { confirmLines } from '../../web/src/components/team/ConfirmScreen.tsx'
import { TeamList } from '../../web/src/components/team/TeamList.tsx'
import { TeamThread } from '../../web/src/components/team/TeamThread.tsx'
import { ThreadPane } from '../../web/src/components/threads/ThreadPane.tsx'
import { type Threads, ThreadsContext } from '../../web/src/hooks/useThreads.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import type { AgentsView, TeamView, ThreadView as TopicView } from '../../web/src/models/team.ts'
import {
  offerPeers,
  outWord,
  peerLabel,
  requestTarget,
  sendable,
  sentToast,
  sharedWith,
  shareStateOf,
  shareTargets,
  topicWork,
} from '../../web/src/models/work-share.ts'
import { feedOf, partyLabel } from '../../web/src/models/work-threads.ts'
import { type Board, BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { board, payload } from './support/board.tsx'

const NOW = Date.parse('2026-11-12T14:00:00Z')
const ME = 'M'.repeat(43)
const BEN = 'B'.repeat(43)
const CLEO = 'C'.repeat(43)
const TOPIC = `${BEN}/0b0b0b0b-0000-4000-8000-00000000000b`
const master: Party = { kind: 'session', key: 'pane-wP:p1', name: 'atlas-master' }
const benAgent: Party = { kind: 'peer', peer: BEN, name: 'ben', agent: 'atlas-mapper' }

const t = Object.assign(
  (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  {
    lang: 'en' as const,
  },
) as unknown as Translator

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

const entry = (n: number, fields: Partial<ThreadEntryView>): ThreadEntryView => ({
  id: `e${n}`,
  thread: 't',
  n,
  seq: n,
  at: NOW + n,
  author: master,
  type: 'note',
  text: '',
  ...fields,
})

const SHARED = { kind: 'peer' as const, peer: BEN, topic: TOPIC, key: 'atlas-3', by: 'me', at: NOW }

const threads = (): Threads => ({
  rows: [],
  known: new Set(),
  rev: 1,
  open() {},
  asked: null,
  shown: false,
  setShown() {},
})

function render(node: ReactNode, value: Board, th: Threads | null = threads()): string {
  return renderToStaticMarkup(
    <I18nProvider lang="en">
      <BoardContext.Provider value={value}>
        <ThreadsContext.Provider value={th}>{node}</ThreadsContext.Provider>
      </BoardContext.Provider>
    </I18nProvider>,
  )
}

const view = (head: ThreadRow, entries: ThreadEntryView[] = []): ThreadView => ({
  head,
  children: [],
  entries,
  earlier: 0,
  ask: null,
})

const pane = (v: ThreadView) => <ThreadPane view={v} onOpen={() => {}} onBack={() => {}} />

const teamView = (roster: { peer: string; name: string; pin?: 'trusted' | 'changed'; work?: true }[]): TeamView => ({
  state: 'online',
  me: { peer: ME, fingerprint: '', name: 'anna' },
  hub: 'ws://127.0.0.1:7443',
  roster: roster.map(p => ({
    peer: p.peer,
    name: p.name,
    online: true,
    lastSeen: null,
    fingerprint: '',
    pin: p.pin ?? 'trusted',
    drafts: 0,
    ...(p.work && { work: true }),
  })),
})

const topic = (fields: Partial<TopicView> & Pick<TopicView, 'key' | 'scope' | 'id'>): TopicView => ({
  title: 'Price columns',
  link: null,
  handler: null,
  muted: false,
  by: 'me',
  createdAt: NOW,
  lastAt: NOW,
  peerName: null,
  ...fields,
})

// ------------------------------------------------------------------ the model

test('a head says where it stands: local, an agent asked, shared (this board or a teammate), an offer, no longer', () => {
  expect(shareStateOf({ scope: 'local' })).toEqual({ kind: 'local' })
  expect(
    shareStateOf({ scope: { kind: 'local', request: { to: 'ben', history: true, by: master, at: NOW } } }),
  ).toEqual({ kind: 'request', to: 'ben', history: true, by: master })
  expect(shareStateOf({ scope: SHARED })).toMatchObject({ kind: 'shared', mine: true, offer: false })
  expect(shareStateOf({ scope: { ...SHARED, by: BEN, offer: { by: BEN, at: NOW } } })).toMatchObject({
    kind: 'shared',
    mine: false,
    offer: true,
  })
  expect(shareStateOf({ scope: { ...SHARED, ended: NOW } })).toMatchObject({ kind: 'ended' })
})

test("who it goes to, by this board's names; where the owner can share: trusted teammates, the team, its own channels", () => {
  const v = teamView([
    { peer: BEN, name: 'ben', work: true },
    { peer: CLEO, name: 'cleo', pin: 'changed' },
    { peer: 'D'.repeat(43), name: 'dana' },
  ])
  expect(sharedWith(SHARED, v.roster, ME, t)).toBe('ben')
  expect(sharedWith({ ...SHARED, kind: 'team' }, v.roster, ME, t)).toBe('wt.share.theTeam')
  expect(sharedWith({ ...SHARED, kind: 'channel', members: [BEN, CLEO, ME] }, v.roster, ME, t)).toBe('ben, cleo')
  // A board without `work` can still be picked: it reads the entries as plain lines.
  expect(sharedWith({ ...SHARED, peer: 'X'.repeat(43) }, v.roster, ME, t)).toBe('wt.share.someone')
  const mine = topic({ key: 'team/c1', scope: 'team', id: 'c1', members: [BEN, ME], title: 'Ops' })
  const theirs = topic({ key: 'team/c2', scope: 'team', id: 'c2', members: [BEN, ME], by: BEN })
  const targets = shareTargets(v, [mine, theirs, topic({ key: TOPIC, scope: BEN, id: 'x' })], t)
  expect(targets).toEqual([
    { to: BEN, label: 'ben', kind: 'peer' },
    { to: 'D'.repeat(43), label: 'dana', kind: 'peer', old: true },
    { to: 'team', label: 'wt.share.theTeam', kind: 'team' },
    { to: 'team/c1', label: '# Ops', kind: 'channel' },
  ])
  expect(shareTargets(null, [], t)).toEqual([])
  // What a shared thread can be offered to (11.6): the pair's peer, any teammate, a channel's others.
  expect(offerPeers(SHARED, v.roster, ME, t)).toEqual([{ peer: BEN, name: 'ben' }])
  expect(offerPeers({ ...SHARED, peer: 'E'.repeat(43) }, [], ME, t)).toEqual([
    { peer: 'E'.repeat(43), name: 'wt.share.someone' },
  ])
  expect(
    offerPeers({ ...SHARED, peer: 'E'.repeat(43) }, [], ME, t, { kind: 'peer', peer: 'E'.repeat(43), name: 'eve' }),
  ).toEqual([{ peer: 'E'.repeat(43), name: 'eve' }])
  expect(offerPeers({ ...SHARED, kind: 'team' }, v.roster, ME, t).map(p => p.name)).toEqual(['ben', 'cleo', 'dana'])
  expect(offerPeers({ ...SHARED, kind: 'channel', members: [BEN, ME] }, v.roster, ME, t)).toEqual([
    { peer: BEN, name: 'ben' },
  ])
  expect(requestTarget('Ben', targets)?.to).toBe(BEN)
  expect(requestTarget('ops', targets)?.to).toBe('team/c1')
  expect(requestTarget('nobody', targets)).toBe(null)
})

test("an entry's way to the hub, in words; only a held one has Send; a write's answer as a toast", () => {
  expect(outWord('held')).toBe('wt.out.held')
  expect(outWord('queued')).toBe('wt.out.queued')
  expect(outWord('refused')).toBe('wt.out.refused')
  expect(outWord('copy')).toBe('wt.out.copy')
  expect(outWord('sent')).toBe(null)
  expect(outWord(undefined)).toBe(null)
  expect(sendable('held')).toBe(true)
  expect(sendable('queued')).toBe(false)
  expect(sentToast({ out: 'held', reason: 'lane' }, t)).toEqual({
    text: 'wt.out.heldToast {"reason":"lane"}',
    error: false,
  })
  expect(sentToast({ out: 'refused', error: 'rate_peer' }, t)?.error).toBe(true)
  expect(sentToast({ out: 'sent' }, t)).toBe(null)
  expect(sentToast({ ok: true }, t)).toBe(null)
})

test("a teammate's agent is named at its board; a topic row's thread is read strictly", () => {
  expect(peerLabel(benAgent as Extract<Party, { kind: 'peer' }>)).toBe('atlas-mapper@ben')
  expect(partyLabel(benAgent, 'You')).toBe('atlas-mapper@ben')
  expect(partyLabel({ kind: 'peer', peer: BEN, name: 'ben' }, 'You')).toBe('ben')
  expect(topicWork({ work: { key: 'atlas-3', status: 'doing', id: 'x' } })).toEqual({
    key: 'atlas-3',
    status: 'doing',
    id: 'x',
  })
  expect(topicWork({ work: { key: 'atlas-3', status: 'finished', id: 'x' } })).toBe(null)
  expect(topicWork({})).toBe(null)
  expect(topicWork(null)).toBe(null)
})

test("the feed: sharing and stopping as quiet lines, the board's own lines as written; a local thread's system text as before", () => {
  const entries = [
    entry(1, { type: 'system', set: { title: 'x', status: 'doing', lane: 'atlas' } }),
    entry(2, { type: 'system', author: { kind: 'owner' }, text: 'shared', set: { title: 'x', status: 'doing' } }),
    entry(3, {
      type: 'system',
      author: { kind: 'peer', peer: BEN, name: 'ben' },
      text: "entries missing here (#3 to #4); the head is taken from ben's copy",
      private: true,
      set: { status: 'waiting' },
    }),
    entry(4, { type: 'system', author: { kind: 'owner' }, text: 'stopped sharing', out: 'queued' }),
  ]
  const shared = feedOf(row({ key: 'atlas-3', scope: SHARED }), entries, null)
  expect(shared.filter(i => i.kind === 'status').map(i => (i.kind === 'status' ? i.did : ''))).toEqual([
    'created',
    'shared',
    'said',
    'unshared',
  ])
  // A teammate's share comes in as a system entry without words: shared, not a status change.
  const received = feedOf(
    row({ key: 'atlas-3', scope: { ...SHARED, by: BEN } }),
    [
      entry(7, {
        type: 'system',
        author: { kind: 'peer', peer: BEN, name: 'ben' },
        set: { title: 'x', status: 'doing', summary: 'mapping' },
      }),
    ],
    null,
  )
  expect(received.filter(i => i.kind === 'status').map(i => (i.kind === 'status' ? i.did : ''))).toEqual(['shared'])
  // An imported thread (#393) is local: its system text stays as phase 3 drew it.
  const local = feedOf(row({ key: 'atlas-3' }), entries, null)
  expect(local.filter(i => i.kind === 'status').map(i => (i.kind === 'status' ? i.did : ''))).toEqual([
    'created',
    'fields',
    'status',
  ])
})

test('the confirmation window words what goes to the teammates as the owner', () => {
  expect(confirmLines({ kind: 'thread-send', thread: 'atlas-3', title: 'Map', text: 'mapped' }, t)).toEqual({
    title: 'wt.confirm.send {"thread":"atlas-3 Map"}',
    text: 'mapped',
    note: 'team.confirm.unlocks',
  })
  expect(confirmLines({ kind: 'thread-share', thread: 'atlas-3', title: 'Map', who: 'ben', history: true }, t)).toEqual(
    {
      title: 'wt.confirm.share {"thread":"atlas-3 Map","who":"ben"}',
      items: ['wt.confirm.withHistory'],
    },
  )
  expect(confirmLines({ kind: 'thread-share', thread: 'atlas-3', who: 'team', history: false }, t).items).toEqual([
    'wt.confirm.noHistory',
  ])
  expect(confirmLines({ kind: 'thread-history', thread: 'atlas-3' }, t).title).toBe(
    'wt.confirm.history {"thread":"atlas-3"}',
  )
  expect(confirmLines({ kind: 'thread-track', lane: 'atlas' }, t)).toEqual({
    title: 'wt.confirm.track',
    items: ['wt.confirm.trackLane {"lane":"atlas"}'],
  })
})

// ------------------------------------------------------------------ the thread's head and feed

test('a local thread: Share only while Team is on, and nothing of sharing without it', () => {
  const local = view(row({ key: 'atlas-3' }))
  const off = render(pane(local), board({ data: payload({ threads: { rev: 1, needsOwner: 0 } }) }))
  expect(off).not.toContain('wt-share')
  expect(off).not.toContain('Share')
  const on = render(pane(local), board({ data: payload({ threads: { rev: 1, needsOwner: 0 }, teamRev: 3 }) }))
  expect(on).toContain('class="wt-share-pill"')
  expect(on).toContain('>Share</button>')
  // A sub-thread is shared with its parent, never alone.
  const sub = render(
    pane(view(row({ key: 'atlas-4', parent: 'atlas-3-id', parentKey: 'atlas-3' }))),
    board({ data: payload({ teamRev: 3 }) }),
  )
  expect(sub).not.toContain('wt-share-pill')
})

test('a shared thread: who it goes to, Stop sharing for its sharer, an offer with Take and Decline, out marks with Send', () => {
  const value = board({ data: payload({ threads: { rev: 2, needsOwner: 1 }, teamRev: 3 }) })
  const mine = render(
    pane(
      view(row({ key: 'atlas-3', scope: SHARED }), [
        entry(1, { type: 'system', set: { title: 'x', status: 'doing', lane: 'atlas' } }),
        entry(2, { author: { kind: 'owner' }, text: 'mapped the 2019 columns', out: 'held' }),
        entry(3, { author: master, text: 'report attached', out: 'queued' }),
        entry(4, { author: benAgent, text: '<b>not html</b>' }),
      ]),
    ),
    value,
  )
  expect(mine).toContain('data-share="shared"')
  expect(mine).toContain('Stop sharing')
  expect(mine).not.toContain('wt-share-pill')
  expect(mine).toContain('Waits for you to send')
  expect(mine).toMatch(
    /data-out="held"><span>Waits for you to send<\/span><button type="button" class="mini">Send<\/button>/,
  )
  expect(mine).toContain('Not sent yet')
  expect(mine).toContain('atlas-mapper@ben')
  // A peer's words stay text.
  expect(mine).not.toContain('<b>not html</b>')
  expect(mine).toContain('&lt;b&gt;not html&lt;/b&gt;')

  const offered = render(
    pane(view(row({ key: 'atlas-3', scope: { ...SHARED, by: BEN, offer: { by: BEN, at: NOW } } }))),
    value,
  )
  expect(offered).toContain('data-share="offer"')
  expect(offered).toContain('>Take</button>')
  expect(offered).toContain('>Decline</button>')
  expect(offered).not.toContain('Stop sharing')
  // A thread offered to a teammate keeps them in its assignee control, by their board.
  const toBen = render(
    pane(view(row({ key: 'atlas-3', scope: SHARED, assignee: { kind: 'peer', peer: BEN, name: 'ben' } }))),
    value,
  )
  expect(toBen).toContain(`<option value="peer:${BEN}" selected="">Offer to ben</option>`)

  const asked = render(
    pane(
      view(
        row({ key: 'atlas-3', scope: { kind: 'local', request: { to: 'ben', history: true, by: master, at: NOW } } }),
      ),
    ),
    value,
  )
  expect(asked).toContain('data-share="request"')
  expect(asked).toContain('atlas-master asks to share it with ben, with its history')

  const ended = render(pane(view(row({ key: 'atlas-3', scope: { ...SHARED, ended: NOW } }))), value)
  expect(ended).toContain('No longer shared')
  expect(ended).not.toContain('Stop sharing')
})

// ------------------------------------------------------------------ the Team panel

test('the Team list: a topic that is a shared thread carries its key and status; any other row as before', () => {
  const v = teamView([{ peer: BEN, name: 'ben' }])
  const rows: TopicView[] = [
    topic({ key: `${BEN}/general`, scope: BEN, id: 'general', title: null }),
    {
      ...topic({ key: TOPIC, scope: BEN, id: '0b0b0b0b-0000-4000-8000-00000000000b' }),
      work: { key: 'atlas-3', status: 'owner', id: 'x' },
    } as TopicView,
    topic({ key: `${BEN}/1b0b0b0b-0000-4000-8000-00000000000b`, scope: BEN, id: '1b', title: 'Plain topic' }),
  ]
  const html = render(
    <TeamList
      view={v}
      threads={rows}
      selected={null}
      unread={{}}
      agents={null}
      pending={[]}
      disabled={false}
      onSelect={() => {}}
      onPeople={() => {}}
    />,
    board({ now: NOW }),
    null,
  )
  expect(html).toContain('class="wt-topic-pill"')
  expect(html.match(/wt-topic-pill/g)?.length).toBe(1)
  expect(html).toContain('atlas-3</span>')
})

test('a topic in the Team panel: Open as a thread when it is one, Track as a thread on the computer when not, nothing with threads off', () => {
  const v = teamView([{ peer: BEN, name: 'ben' }])
  const th = topic({ key: TOPIC, scope: BEN, id: '0b0b0b0b-0000-4000-8000-00000000000b' })
  const agents: AgentsView = { off: false, listener: null, peers: {}, paused: {}, lanes: [] }
  const props = {
    view: v,
    selected: TOPIC,
    thread: th,
    lines: [],
    agents,
    unreadFrom: null,
    draft: '',
    topic: null,
    replyTo: null,
    disabled: false,
    onBack() {},
    onTrust() {},
    onSendDraft() {},
    onDiscardDraft() {},
    onDraft() {},
    onTopic() {},
    onSend() {},
    onMute() {},
    onReply() {},
  }
  const value = board({ now: NOW })
  const open = render(<TeamThread {...props} work={{ key: 'atlas-3', status: 'doing', id: 'x' }} />, value)
  expect(open).toContain('data-topic-thread="atlas-3"')
  expect(open).toContain('>Open as a thread</button>')
  const track = render(<TeamThread {...props} work={null} />, value)
  expect(track).toContain('>Track as a thread</button>')
  // On a phone (no switches) the owner does not share from here; with threads off nothing at all.
  expect(render(<TeamThread {...props} agents={null} work={null} />, value)).not.toContain('Track as a thread')
  const off = render(<TeamThread {...props} work={{ key: 'atlas-3', status: 'doing', id: 'x' }} />, value, null)
  expect(off).not.toContain('wt-topic')
})
