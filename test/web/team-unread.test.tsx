// The page's side of the team's unread messages (#355): the head's Team button and its More entry
// carry the count, the panel shows each person's, a thread on show in a page in front is marked
// read, a notification's click (the stream's `team-open`) names a thread, and the panel is offered
// away from the computer only to the owner's own phone or login (hello's `team`).
import { afterEach, describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { TeamView, ThreadView } from '../../src/services/team-hub.ts'
import { TeamBody, type TeamBodyProps } from '../../web/src/components/team/TeamPanel.tsx'
import { teamSource } from '../../web/src/hooks/useTeam.ts'
import { listenForTeamOpens, offersTeam, pairThread, peerOfThread, type TeamOpen } from '../../web/src/models/team.ts'
import { TOOLBAR_PRIORITY } from '../../web/src/models/toolbar-fit.ts'
import { toolbarEntries } from '../../web/src/models/toolbar-menu.ts'
import { board, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { findAll, hasClass, type Node } from './support/markup.ts'

const t = translator('en')
const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
const ANA = 'A'.repeat(43)
const BOB = 'B'.repeat(43)
const THREAD: ThreadView = {
  key: `${ANA}/general`,
  scope: ANA,
  id: 'general',
  title: null,
  link: null,
  handler: null,
  muted: false,
  by: ANA,
  createdAt: 1,
  lastAt: 1,
  peerName: 'Ana',
}
const VIEW: TeamView = {
  state: 'online',
  me: { peer: 'M'.repeat(43), fingerprint: 'aaaa bbbb cccc dddd', name: 'Dima' },
  hub: 'wss://hub.example.com',
  roster: [
    { peer: ANA, name: 'Ana', online: true, lastSeen: null, fingerprint: '1111', pin: 'trusted', drafts: 0 },
    { peer: BOB, name: 'Bob', online: true, lastSeen: null, fingerprint: '2222', pin: 'trusted', drafts: 0 },
  ],
}

afterEach(restoreFetch)

describe('who is offered the Team panel', () => {
  test('the local page with teamRev; away from the computer only with hello’s team; never without teamRev', () => {
    expect(offersTeam({ teamRev: 1 }, false, false)).toBe(true)
    expect(offersTeam({ teamRev: 1 }, true, false)).toBe(false)
    expect(offersTeam({ teamRev: 1 }, true, true)).toBe(true)
    expect(offersTeam({}, true, true)).toBe(false)
    expect(offersTeam({}, false, false)).toBe(false)
  })
})

describe('the head', () => {
  test('More’s Team entry carries the count and a dot while something is unread; Team sits after Tasks', () => {
    const base = {
      canMutate: true,
      schedule: { count: 0, due: false },
      tasks: null,
      next: 0,
      usage: '',
      presence: null,
    }
    const entry = (unread: number | null) =>
      toolbarEntries({ ...base, team: unread === null ? null : { unread } }, t).find(e => e.id === 'team-open')
    expect(entry(3)).toEqual({ id: 'team-open', label: 'Team', count: 3, alert: true })
    expect(entry(0)).toEqual({ id: 'team-open', label: 'Team' })
    expect(entry(null)).toEqual({ id: 'team-open', label: 'Team' })
    expect(TOOLBAR_PRIORITY.indexOf('team-open')).toBe(TOOLBAR_PRIORITY.indexOf('todos-open') + 1)
  })
})

describe('threads', () => {
  test('a pair’s thread key, and the person a key is with', () => {
    expect(pairThread(ANA)).toBe(`${ANA}/general`)
    expect(peerOfThread(`${ANA}/general`)).toBe(ANA)
    expect(peerOfThread('team/general')).toBeNull()
    expect(peerOfThread('')).toBeNull()
  })

  test('the stream’s team-open names a thread; each ask counts, junk is ignored', () => {
    const listeners: Array<(e: MessageEvent) => void> = []
    const seen: { now: TeamOpen | null } = { now: null }
    listenForTeamOpens({ addEventListener: (_type, l) => void listeners.push(l) }, next => {
      seen.now = next(seen.now)
    })
    const fire = (data: string) => {
      for (const l of listeners) l({ data } as MessageEvent)
    }
    fire(JSON.stringify({ thread: `${ANA}/general` }))
    fire('not json')
    fire(JSON.stringify({ other: 1 }))
    fire(JSON.stringify({ thread: `${BOB}/general` }))
    expect(seen.now).toEqual({ thread: `${BOB}/general`, n: 2 })
  })
})

describe('marking read', () => {
  const GENERAL = { thread: { ...THREAD, key: `${ANA}/general` }, lines: [] }

  test('with nothing unread no count is asked', async () => {
    const calls = answers([200, VIEW], [200, { threads: [] }])
    const source = teamSource({ t: () => t, toast: () => {}, visible: () => true, remote: () => true })
    source.sync(true, 1, 0)
    await Bun.sleep(5)
    expect(calls.map(c => c.url)).toEqual(['/api/team', '/api/team/threads'])
  })

  test('with some unread, the counts come and the thread on show in a page in front is read', async () => {
    const calls = answers(
      [200, VIEW],
      [200, { threads: [] }],
      [200, GENERAL],
      [200, { unread: 3, threads: { [`${ANA}/general`]: 2, [`${BOB}/general`]: 1 } }],
      [200, { ok: true, unread: 1 }],
    )
    const source = teamSource({ t: () => t, toast: () => {}, visible: () => true, remote: () => true })
    source.select(`${ANA}/general`)
    source.sync(true, 1, 3)
    await Bun.sleep(10)
    expect(sent(calls)).toEqual([
      ['/api/team', undefined, undefined, undefined],
      ['/api/team/threads', undefined, undefined, undefined],
      [`/api/team/threads/${ANA}/general`, undefined, undefined, undefined],
      ['/api/team/unread', undefined, undefined, undefined],
      ['/api/team/read', 'POST', '1', { thread: `${ANA}/general` }],
    ])
    expect(source.now.get().unread).toEqual({ [`${BOB}/general`]: 1 })
  })

  test('a page behind others reads nothing: the counts are drawn, no read is posted', async () => {
    const calls = answers(
      [200, VIEW],
      [200, { threads: [] }],
      [200, GENERAL],
      [200, { unread: 2, threads: { [`${ANA}/general`]: 2 } }],
    )
    const source = teamSource({ t: () => t, toast: () => {}, visible: () => false, remote: () => true })
    source.select(`${ANA}/general`)
    source.sync(true, 1, 2)
    await Bun.sleep(10)
    expect(calls.map(c => c.url)).toEqual([
      '/api/team',
      '/api/team/threads',
      `/api/team/threads/${ANA}/general`,
      '/api/team/unread',
    ])
    expect(source.now.get().unread).toEqual({ [`${ANA}/general`]: 2 })
  })
})

describe('the panel', () => {
  const props = (over: Partial<TeamBodyProps> = {}): TeamBodyProps => ({
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
  })

  test('each thread’s unread count beside it; none drawn without any', () => {
    const tree = renderInBoard(<TeamBody {...props({ unread: { [`${ANA}/general`]: 2 } })} />, board())
    const counts = findAll(tree, el => hasClass(el, 'team-unread'))
    expect(counts.map(c => text(c.children))).toEqual(['2'])
    const none = renderInBoard(<TeamBody {...props()} />, board())
    expect(findAll(none, el => hasClass(el, 'team-unread'))).toEqual([])
  })
})
