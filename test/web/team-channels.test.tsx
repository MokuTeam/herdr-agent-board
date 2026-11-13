// The Team panel's channels, a new member's welcome and the loop pause (#355, #360): channels
// listed on their own after the team chat, New channel with its members to pick, a channel's view
// with its members and, for its creator, Add to the channel; the one welcome screen for who joined
// (nothing changes until Done, Later puts it off and the mark stays); a channel's switches and each
// scope's loop pause; and the source's calls.
import { afterEach, describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { TeamBody, type TeamBodyProps } from '../../web/src/components/team/TeamPanel.tsx'
import { teamSource } from '../../web/src/hooks/useTeam.ts'
import type { AgentsView, TeamView, ThreadView, Welcome } from '../../web/src/models/team.ts'
import { board, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { findAll, hasClass, type Node } from './support/markup.ts'
import { type Host, hostElements } from './support/react-events.ts'

afterEach(restoreFetch)

const t = translator('en')
const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
const ME = 'M'.repeat(43)
const ANA = 'A'.repeat(43)
const BOB = 'B'.repeat(43)
const DEALS = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'
const THEIRS = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

const peer = (id: string, name: string) => ({
  peer: id,
  name,
  online: true,
  lastSeen: null,
  fingerprint: '1111',
  pin: 'trusted' as const,
  drafts: 0,
})
const VIEW: TeamView = {
  state: 'online',
  me: { peer: ME, fingerprint: 'aaaa', name: 'Dima' },
  hub: 'wss://hub.example.com',
  roster: [peer(ANA, 'Ana'), peer(BOB, 'Bob')],
}
const channel = (id: string, title: string, members: string[], by = 'me'): ThreadView => ({
  key: `team/${id}`,
  scope: 'team',
  id,
  title,
  link: null,
  handler: null,
  muted: false,
  by,
  createdAt: 1,
  lastAt: 1,
  peerName: null,
  members,
})
const THREADS = [channel(DEALS, 'Deals', [ME, ANA].sort()), channel(THEIRS, 'Theirs', [ME, ANA, BOB].sort(), ANA)]
const AGENTS: AgentsView = {
  off: false,
  listener: null,
  peers: { [`team/${DEALS}`]: { on: true, lanes: ['work'], loop: 5 } },
  paused: {},
  lanes: [
    { id: 'work', title: 'Work' },
    { id: 'home', title: 'Home' },
  ],
  loopDefault: 20,
}

function props(over: Partial<TeamBodyProps> = {}): TeamBodyProps {
  return {
    view: VIEW,
    threads: THREADS,
    selected: null,
    thread: null,
    lines: [],
    agents: AGENTS,
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
    onNewChannel() {},
    onAddMembers() {},
    onWelcome() {},
    ...over,
  }
}

const render = (p: TeamBodyProps) => renderInBoard(<TeamBody {...p} />, board())

function hostsOf(p: TeamBodyProps): Host[] {
  let hosts: Host[] = []
  function Probe() {
    hosts = hostElements(<TeamBody {...p} />)
    return null
  }
  renderInBoard(<Probe />, board())
  return hosts
}

const click = (h: Host | undefined): void => {
  const fn = h?.props.onClick
  if (typeof fn !== 'function') throw new Error('no such button')
  fn()
}

describe('channels in the list', () => {
  test('listed on their own after the team chat, each with how many members; not among the team chat’s topics', () => {
    const nodes = render(props())
    const section = findAll(nodes, el => hasClass(el, 'team-channels'))
    expect(text(section)).toContain('Channels')
    const rows = findAll(section, el => hasClass(el, 'team-row'))
    const words = (r: Node, name: string) => text(findAll([r], el => hasClass(el, name)))
    expect(rows.map(r => [words(r, 'team-row-title'), words(r, 'team-row-meta')])).toEqual([
      ['Deals', '2 members'],
      ['Theirs', '3 members'],
    ])
    expect(findAll(section, el => hasClass(el, 'team-avatar') && hasClass(el, 'channel'))).toHaveLength(2)
    const chat = findAll(nodes, el => hasClass(el, 'team-chat'))
    expect(findAll(chat, el => hasClass(el, 'team-row')).map(r => r.attrs.get('data-thread'))).toEqual(['team/general'])
  })

  test('New channel asks the panel to start one; none to start without anyone in the team', () => {
    let asked = 0
    click(hostsOf(props({ onNewChannel: () => void asked++ })).find(h => h.props.children === 'New channel'))
    expect(asked).toBe(1)
    const alone = render(props({ view: { ...VIEW, roster: [] } }))
    expect(findAll(alone, el => el.tag === 'button' && text([el]) === 'New channel')).toHaveLength(0)
  })
})

describe('a new channel', () => {
  test('in the team chat’s general: pick its members; Start the channel waits for a title and a member', () => {
    const topics: unknown[] = []
    const on = (topic: TeamBodyProps['topic'], draft = 'hi') =>
      props({ selected: 'team/general', topic, draft, onTopic: x => void topics.push(x) })
    const start = (p: TeamBodyProps) =>
      findAll(render(p), el => el.tag === 'button' && text([el]) === 'Start the channel')[0]
    expect(start(on({ title: 'Deals', members: [] }))?.attrs.has('disabled')).toBe(true)
    expect(start(on({ title: '', members: [ANA] }))?.attrs.has('disabled')).toBe(true)
    expect(start(on({ title: 'Deals', members: [ANA] }))?.attrs.has('disabled')).toBe(false)
    click(hostsOf(on({ title: 'Deals', members: [] })).find(h => h.tag === 'button' && h.props.children === 'Bob'))
    expect(topics).toEqual([{ title: 'Deals', members: [BOB] }])
    // A plain new topic has no members to pick.
    const plain = render(on({ title: 'x' }))
    expect(findAll(plain, el => el.attrs.has('data-members'))).toHaveLength(0)
  })

  test('the source sends it to the team with its title, link and members', async () => {
    const calls = answers([200, { ok: true, id: 'm1', thread: `team/${DEALS}` }])
    const source = teamSource({ t: () => t, toast() {}, remote: () => true })
    source.select('team/general')
    expect(await source.send('closing friday', { title: 'Deals', members: [ANA] })).toBe(true)
    expect(sent(calls)[0]).toEqual([
      '/api/team/send',
      'POST',
      '1',
      { to: 'team', text: 'closing friday', thread: { title: 'Deals', members: [ANA] } },
    ])
    expect(source.now.get().selected).toBe(`team/${DEALS}`)
  })
})

describe('a channel on show', () => {
  test('its members by this board’s names; its creator may add one of the roster who is not in it', () => {
    const added: [string, string[]][] = []
    const p = props({
      selected: `team/${DEALS}`,
      thread: THREADS[0] as ThreadView,
      onAddMembers: (k, peers) => void added.push([k, peers]),
    })
    const nodes = render(p)
    expect(text(nodes)).toContain('channel with Ana')
    const options = findAll(nodes, el => el.tag === 'option').map(o => text([o]))
    expect(options).toEqual(['Bob'])
    click(hostsOf(p).find(h => h.props.children === 'Add to the channel'))
    expect(added).toEqual([[`team/${DEALS}`, [BOB]]])
    // Someone else's channel: no Add.
    const theirs = render(props({ selected: `team/${THEIRS}`, thread: THREADS[1] as ThreadView }))
    expect(findAll(theirs, el => el.tag === 'select')).toHaveLength(0)
  })

  test('Add is not offered away from the computer, where the route is refused', () => {
    const remote = render(props({ selected: `team/${DEALS}`, thread: THREADS[0] as ThreadView, agents: null }))
    expect(findAll(remote, el => el.tag === 'select')).toHaveLength(0)
  })

  test('the team chat’s mute is not a channel’s', () => {
    const muted = { ...AGENTS, peers: { ...AGENTS.peers, team: { on: false, lanes: [], muted: true } } }
    const nodes = render(props({ selected: `team/${DEALS}`, thread: THREADS[0] as ThreadView, agents: muted }))
    expect(text(nodes)).not.toContain('muted: no notifications')
  })

  test('the source adds members: POST …/threads/team/<id>/members { add }', async () => {
    const calls = answers()
    const source = teamSource({ t: () => t, toast() {}, remote: () => true })
    await source.addMembers(`team/${DEALS}`, [BOB])
    expect(sent(calls)[0]).toEqual([`/api/team/threads/team/${DEALS}/members`, 'POST', '1', { add: [BOB] }])
  })
})

describe('a new member’s welcome', () => {
  test('one screen for who joined: nothing changes until Done, which sends it all at once', () => {
    const done: Welcome[] = []
    const changes: unknown[] = []
    const p = props({ pending: [BOB], onWelcome: w => void done.push(w), onAgents: c => void changes.push(c) })
    const nodes = render(p)
    expect(text(findAll(nodes, el => hasClass(el, 'team-welcome')))).toContain('Bob joined the team')
    // Bob's row carries the mark until it is done, in the list and in People and agents.
    const bob = findAll(nodes, el => el.attrs.get('data-thread') === `${BOB}/general`)
    expect(findAll(bob, el => hasClass(el, 'team-new'))).toHaveLength(1)
    expect(findAll(render({ ...p, people: true }), el => hasClass(el, 'team-new'))).toHaveLength(2)
    // Only channels this board started are offered.
    const offered = findAll(nodes, el => el.attrs.has('data-channel')).map(c => c.attrs.get('data-channel'))
    expect(offered).toEqual([`team/${DEALS}`])
    const hosts = hostsOf(p)
    click(hosts.find(h => h.props['data-welcome-done'] !== undefined))
    expect(done).toEqual([{ peer: BOB, on: false, lanes: [], channels: [] }])
    expect(changes).toEqual([])
  })

  test('no screen on a remote page, nor for anyone already welcomed', () => {
    expect(findAll(render(props({ pending: [BOB], agents: null })), el => hasClass(el, 'team-welcome'))).toHaveLength(0)
    expect(findAll(render(props({ pending: [] })), el => hasClass(el, 'team-welcome'))).toHaveLength(0)
  })

  test('the source: GET /api/team/welcome on the computer, POST it when done', async () => {
    const calls = answers()
    const source = teamSource({ t: () => t, toast() {}, remote: () => false })
    await source.welcome({ peer: BOB, on: true, lanes: ['work'], channels: [`team/${DEALS}`] })
    expect(sent(calls)[0]).toEqual([
      '/api/team/welcome',
      'POST',
      '1',
      { peer: BOB, on: true, lanes: ['work'], channels: [`team/${DEALS}`] },
    ])
  })
})

describe('switches for a channel, and the loop pause (#360)', () => {
  test('a channel’s row among the switches; each scope’s loop pause, empty for the board’s default', () => {
    const changes: unknown[] = []
    const p = props({ people: true, onAgents: c => void changes.push(c) })
    const nodes = render(p)
    const scopes = findAll(nodes, el => hasClass(el, 'team-agent')).map(a => a.attrs.get('data-scope'))
    expect(scopes).toEqual(['team', `team/${DEALS}`, `team/${THEIRS}`, ANA, BOB])
    const loops = findAll(nodes, el => el.attrs.has('data-loop'))
    expect(loops.map(l => [l.attrs.get('data-loop'), l.attrs.get('value') ?? '', l.attrs.get('placeholder')])).toEqual([
      ['team', '', '20'],
      [`team/${DEALS}`, '5', '20'],
      [`team/${THEIRS}`, '', '20'],
      [ANA, '', '20'],
      [BOB, '', '20'],
    ])
    const blur = (scope: string, value: string) => {
      const fn = hostsOf(p).find(h => h.props['data-loop'] === scope)?.props.onBlur
      if (typeof fn !== 'function') throw new Error('no loop input')
      fn({ currentTarget: { value } })
    }
    blur(ANA, '8')
    blur(`team/${DEALS}`, '')
    blur(BOB, '0')
    blur(BOB, '')
    expect(changes).toEqual([
      { peer: ANA, loop: 8 },
      { peer: `team/${DEALS}`, loop: null },
    ])
  })
})
