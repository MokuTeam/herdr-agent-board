// The Team panel (#231, components/team/TeamPanel.tsx) on #216's threads (#355): the list (the
// connection line, the team chat first, each person with their online dot, fingerprint, Trust when
// their key changed, and their general thread and topics under them, each with its unread count and
// whether it is muted), a thread on show (delivery states, held, a team post's copies, a link only
// when it is http(s), the mute, a new topic from a general thread), the owner's agent switches on
// this computer only, and the source's calls with the board's header; and nothing of it, no
// /api/team fetch, on a page without the payload's teamRev or on a remote page that is not the
// owner's.
import { afterEach, describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import { SidePanels } from '../../web/src/components/SidePanels.tsx'
import { TeamBody, type TeamBodyProps } from '../../web/src/components/team/TeamPanel.tsx'
import type { Schedule } from '../../web/src/hooks/useSchedule.ts'
import { teamSource } from '../../web/src/hooks/useTeam.ts'
import { settingPicked, settingsMenu } from '../../web/src/models/settings-menu.ts'
import {
  type AgentsView,
  isAgentsView,
  isTeamView,
  isThreadLines,
  isThreadList,
  offersTeam,
  sendError,
  stateLine,
  type TeamView,
  type ThreadLine,
  type ThreadView,
} from '../../web/src/models/team.ts'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
import { board, payload, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch, sent } from './support/fetch-answers.ts'
import { byClass, findAll, hasClass, type Node } from './support/markup.ts'
import { type Host, hostElements } from './support/react-events.ts'

afterEach(restoreFetch)

const t = translator('en')
const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
const ANA = 'A'.repeat(43)
const BOB = 'B'.repeat(43)
const TOPIC = '0123abcd-4567-49ab-8def-0123456789ab'
const DEPLOY = '89abcdef-0123-4567-89ab-cdef01234567'

const VIEW: TeamView = {
  state: 'online',
  me: { peer: 'M'.repeat(43), fingerprint: 'aaaa bbbb cccc dddd', name: 'Dima' },
  hub: 'wss://hub.example.com',
  roster: [
    {
      peer: ANA,
      name: 'Ana',
      online: true,
      lastSeen: null,
      fingerprint: '1111 2222 3333 4444',
      pin: 'trusted',
      drafts: 0,
    },
    {
      peer: BOB,
      name: 'Bob',
      online: false,
      lastSeen: 1000,
      fingerprint: '5555 6666 7777 8888',
      pin: 'changed',
      drafts: 0,
    },
  ],
}

const thread = (scope: string, id: string, over: Partial<ThreadView> = {}): ThreadView => ({
  key: `${scope}/${id}`,
  scope,
  id,
  title: null,
  link: null,
  handler: null,
  muted: false,
  by: 'me',
  createdAt: 1,
  lastAt: 1,
  peerName: scope === 'team' ? null : scope === ANA ? 'Ana' : 'Bob',
  ...over,
})

const THREADS: ThreadView[] = [
  thread(ANA, 'general', { lastAt: 5 }),
  thread(ANA, TOPIC, { title: 'Release', link: 'https://example.com/pr/1', lastAt: 3 }),
  thread('team', 'general', { lastAt: 4 }),
  thread('team', DEPLOY, { title: 'Deploy', muted: true, lastAt: 2 }),
]

const LINES: ThreadLine[] = [
  { id: 'q1', dir: 'out', text: 'queued one', ts: '2026-10-28T10:00:00Z', state: 'queued' },
  { id: 'q2', dir: 'out', text: 'delivered one', ts: '2026-10-28T10:01:00Z', state: 'delivered' },
  { id: 'q3', dir: 'out', text: 'acked one', ts: '2026-10-28T10:02:00Z', state: 'acked' },
  { id: 'q4', dir: 'out', text: 'expired one', ts: '2026-10-28T10:03:00Z', state: 'expired' },
  { id: 'i1', dir: 'in', from: ANA, who: 'Ana', text: null, ts: '2026-10-28T10:04:00Z', held: true },
]

const AGENTS: AgentsView = {
  off: false,
  listener: { key: 'k1', name: 'day' },
  peers: { [ANA]: { on: true, lanes: ['work'] } },
  paused: {},
  lanes: [
    { id: 'work', title: 'Work' },
    { id: 'personal', title: 'Personal' },
  ],
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
    ...over,
  }
}

/** A thread on show: its key, and the thread as the board keeps it. */
const on = (key: string, over: Partial<TeamBodyProps> = {}): Partial<TeamBodyProps> => ({
  selected: key,
  thread: THREADS.find(x => x.key === key) ?? null,
  ...over,
})

const render = (p: TeamBodyProps, lang = 'en') => renderInBoard(<TeamBody {...p} />, board(), lang)

/** The panel's host elements, to press its buttons. */
function hostsOf(p: TeamBodyProps): Host[] {
  let hosts: Host[] = []
  function Probe() {
    hosts = hostElements(<TeamBody {...p} />)
    return null
  }
  renderInBoard(<Probe />, board())
  return hosts
}

function press(hosts: Host[], pick: (h: Host) => boolean): void {
  const click = hosts.find(h => h.tag === 'button' && pick(h))?.props.onClick
  if (typeof click !== 'function') throw new Error('no such button')
  click()
}

/** A host element's class names hold `name`, as hasClass does for the markup. */
const hasClassOf = (h: Host, name: string): boolean =>
  typeof h.props.className === 'string' && h.props.className.split(' ').includes(name)

const buttons = (nodes: Node[], label: string) => findAll(nodes, el => el.tag === 'button' && text([el]) === label)
/** The box's Send (#370: an arrow, named by its label). */
const sendOf = (nodes: Node[]) => findAll(nodes, el => el.tag === 'button' && el.attrs.has('data-send'))[0]
const marks = (nodes: Node[]) => findAll(nodes, el => hasClass(el, 'team-delivery'))

describe('the list', () => {
  test('people: an online dot for who is on, none for who is not, and fingerprints (People and agents, #370)', () => {
    const list = render(props())
    expect(findAll(list, el => hasClass(el, 'team-peer'))).toHaveLength(2)
    expect(findAll(list, el => hasClass(el, 'team-avatar-dot')).map(d => hasClass(d, 'on'))).toEqual([true, false])
    // The keys are People and agents' (#370): the list is a list of conversations.
    expect(text(list)).not.toContain('Key 1111')
    const nodes = render(props({ people: true }))
    expect(findAll(nodes, el => hasClass(el, 'team-card'))).toHaveLength(2)
    const dots = findAll(nodes, el => hasClass(el, 'team-dot'))
    expect(dots.map(d => hasClass(d, 'on'))).toEqual([true, false])
    const all = text(nodes)
    expect(all).toContain('Ana')
    expect(all).toContain('online')
    expect(all).toContain('Key 1111 2222 3333 4444')
    expect(all).toContain('Key aaaa bbbb cccc dddd')
  })

  test('connection line: one per state, the error and the next try', () => {
    expect(text(render(props()))).toContain('Online at wss://hub.example.com')
    expect(stateLine({ ...VIEW, state: 'connecting' }, t)).toBe('Connecting to wss://hub.example.com…')
    expect(stateLine({ ...VIEW, state: 'error', error: 'bad hub' }, t)).toBe(
      'Could not use wss://hub.example.com: bad hub',
    )
    expect(stateLine({ ...VIEW, state: 'reconnecting', nextAt: Date.now() + 5000 }, t)).toContain('trying again')
    expect(stateLine({ ...VIEW, state: 'revoked' }, t)).toContain('removed from the team')
    expect(stateLine({ ...VIEW, state: 'online' }, translator('ru'))).toContain('На связи')
  })

  test('an error unknown_peer says the hub does not know this board, in both languages (#231)', () => {
    const view: TeamView = { ...VIEW, state: 'error', error: 'unknown_peer' }
    expect(stateLine(view, t)).toBe(
      'The hub at wss://hub.example.com does not know this board: join with an invite (board team join)',
    )
    expect(stateLine(view, translator('ru'))).toContain('не знает эту доску')
  })

  test('a key that changed: its row says so, with Trust, which asks for that person', () => {
    const trusted: string[] = []
    const row = findAll(render(props()), el => hasClass(el, 'team-row-changed'))
    expect(text(row)).toBe('key changed')
    const p = props({ people: true, onTrust: x => void trusted.push(x) })
    const nodes = render(p)
    expect(findAll(nodes, el => hasClass(el, 'team-changed'))).toHaveLength(1)
    expect(text([byClass(nodes, 'team-changed')])).toContain('The key of Bob changed')
    press(hostsOf(p), h => h.props.children === 'Trust the new key')
    expect(trusted).toEqual([BOB])
  })

  test('the team chat first, then each person: their general, then their topics, the latest first', () => {
    const nodes = render(props())
    const rows = findAll(nodes, el => hasClass(el, 'team-row')).map(r => r.attrs.get('data-thread'))
    // Bob has written nothing yet: his general is there all the same.
    expect(rows).toEqual(['team/general', `team/${DEPLOY}`, `${ANA}/general`, `${ANA}/${TOPIC}`, `${BOB}/general`])
    const titles = findAll(nodes, el => hasClass(el, 'team-row-title')).map(r => text([r]))
    expect(titles).toEqual(['Team chat', 'Deploy', 'Ana', 'Release', 'Bob'])
    expect(text(render(props(), 'ru'))).toContain('Общий чат')
  })

  test('each thread’s unread count; a muted thread is marked and counts none', () => {
    const nodes = render(props({ unread: { [`${ANA}/${TOPIC}`]: 2, [`team/${DEPLOY}`]: 4 } }))
    expect(findAll(nodes, el => hasClass(el, 'team-unread')).map(c => text([c]))).toEqual(['2'])
    const muted = findAll(nodes, el => hasClass(el, 'team-row') && hasClass(el, 'muted'))
    expect(muted.map(r => r.attrs.get('data-thread'))).toEqual([`team/${DEPLOY}`])
    expect(findAll(muted, el => hasClass(el, 'team-muted')).map(m => m.attrs.get('aria-label'))).toEqual(['muted'])
  })

  test('threads with someone no longer in the team stay listed, to read and to clear their count', () => {
    const GONE = 'C'.repeat(43)
    const gone = thread(GONE, 'general', { peerName: 'Cleo' })
    const nodes = render(props({ threads: [...THREADS, gone], unread: { [gone.key]: 3 } }))
    const section = findAll(nodes, el => hasClass(el, 'team-gone'))
    expect(section).toHaveLength(1)
    expect(text(section)).toContain('No longer in the team')
    expect(text(section)).toContain('Cleo')
    expect(findAll(section, el => hasClass(el, 'team-row')).map(r => r.attrs.get('data-thread'))).toEqual([gone.key])
    expect(findAll(render(props()), el => hasClass(el, 'team-gone'))).toHaveLength(0)
  })

  test('a row shows its thread; nothing is on show: no box to write in', () => {
    const picked: (string | null)[] = []
    const p = props({ onSelect: k => void picked.push(k) })
    press(hostsOf(p), h => h.props['data-thread'] === `${ANA}/${TOPIC}`)
    expect(picked).toEqual([`${ANA}/${TOPIC}`])
    expect(findAll(render(p), el => el.tag === 'textarea')).toHaveLength(0)
  })
})

describe('the owner’s switches (#216) and the team chat’s mute', () => {
  const sw = (nodes: Node[], name: string) => findAll(nodes, el => el.attrs.get('data-switch') === name)[0]

  test('as they stand: all agents, the listener, each scope on or off and its lanes', () => {
    expect(findAll(render(props()), el => hasClass(el, 'team-agents'))).toHaveLength(0)
    const nodes = render(props({ people: true }))
    expect(sw(nodes, 'agents')?.attrs.get('aria-checked')).toBe('true')
    expect(sw(nodes, `agents-${ANA}`)?.attrs.get('aria-checked')).toBe('true')
    expect(sw(nodes, `agents-${BOB}`)?.attrs.get('aria-checked')).toBe('false')
    expect(sw(nodes, 'agents-team')?.attrs.get('aria-checked')).toBe('false')
    expect(sw(nodes, 'mute-chat')?.attrs.get('aria-checked')).toBe('true')
    expect(text(nodes)).toContain('Listener: day')
    const ana = findAll(nodes, el => el.attrs.get('data-scope') === ANA)[0] as Node
    const lanes = findAll([ana], el => hasClass(el, 'team-lane')).map(l => [text([l]), l.attrs.get('aria-pressed')])
    expect(lanes).toEqual([
      ['Work', 'true'],
      ['Personal', 'false'],
    ])
  })

  test('each change is one call: all off, the listener cleared, a person on, a lane shared, the chat muted', () => {
    const changes: unknown[] = []
    const p = props({ people: true, onAgents: c => void changes.push(c) })
    const hosts = hostsOf(p)
    press(hosts, h => h.props['data-switch'] === 'agents')
    press(hosts, h => h.props.children === 'Clear')
    press(hosts, h => h.props['data-switch'] === `agents-${BOB}`)
    // Ana's lanes come after the team chat's: her Personal is the second.
    const personal = hosts.filter(h => hasClassOf(h, 'team-lane') && h.props.children === 'Personal')[1]
    if (typeof personal?.props.onClick !== 'function') throw new Error('no lane button')
    personal.props.onClick()
    press(hosts, h => h.props['data-switch'] === 'mute-chat')
    expect(changes).toEqual([
      { off: true },
      { listener: null },
      { peer: BOB, on: true },
      { peer: ANA, lanes: ['work', 'personal'] },
      { peer: 'team', muted: true },
    ])
  })

  test('a remote page (no switches given): neither the switches nor the team chat’s mute, nor Trust', () => {
    const nodes = render(props({ agents: null, people: true }))
    expect(findAll(nodes, el => el.attrs.has('data-switch'))).toHaveLength(0)
    expect(findAll(nodes, el => hasClass(el, 'team-agents'))).toHaveLength(0)
    // Accepting a changed key is the computer's only: the button would only be refused.
    expect(buttons(nodes, 'Trust the new key')).toHaveLength(0)
    expect(text(nodes)).toContain('Trust the new key on the computer the board runs on.')
    const bob = render(props(on(`${BOB}/general`, { agents: null })))
    expect(buttons(bob, 'Trust the new key')).toHaveLength(0)
  })
})

describe('a thread on show', () => {
  test('a person’s general: delivery states, held, back to the list, a box to write in', () => {
    const back: (string | null)[] = []
    const p = props(on(`${ANA}/general`, { lines: LINES, onSelect: k => void back.push(k) }))
    const nodes = render(p)
    const all = text(nodes)
    // A person's general is titled by them, with whether they are on (#370).
    expect(text(findAll(nodes, el => hasClass(el, 'team-thread-title')))).toBe('Ana')
    expect(all).toContain('online')
    const states = marks(nodes)
    expect(states.map(m => m.attrs.get('data-state'))).toEqual(['queued', 'delivered', 'acked', 'expired'])
    expect(states.slice(0, 3).map(m => m.attrs.get('aria-label'))).toEqual([
      'queued at the hub',
      'delivered',
      'received',
    ])
    // Expired is said in words.
    expect(text(states.slice(3))).toBe('expired, not delivered')
    expect(all).toContain('held: key changed, Trust to read')
    expect(findAll(nodes, el => hasClass(el, 'held'))).toHaveLength(1)
    expect(findAll(nodes, el => el.tag === 'textarea')).toHaveLength(1)
    press(hostsOf(p), h => h.props['aria-label'] === 'All threads')
    expect(back).toEqual([null])
  })

  test('a message the hub refused says so, with the code when there is one, in both languages', () => {
    const refused: ThreadLine = {
      id: 'r1',
      dir: 'out',
      text: 'refused one',
      ts: '2026-10-28T10:05:00Z',
      state: 'refused',
      code: 'not_member',
    }
    expect(isThreadLines({ thread: THREADS[0], lines: [refused] })).toBe(true)
    expect(isThreadLines({ thread: THREADS[0], lines: [{ ...refused, state: 'nonsense' }] })).toBe(false)
    const p = props(on(`${ANA}/general`, { lines: [refused] }))
    expect(text(marks(render(p)))).toBe('refused by the hub (not_member), not sent')
    expect(text(render(p, 'ru'))).toContain('хаб отклонил (not_member)')
    const bare = props(
      on(`${ANA}/general`, {
        lines: [{ id: 'r2', dir: 'out', text: 'r', ts: '2026-10-28T10:06:00Z', state: 'refused' }],
      }),
    )
    expect(text(marks(render(bare)))).toBe('refused by the hub, not sent')
  })

  test('a person whose key changed: Send is off and says why, with Trust there too', () => {
    const send = (key: string) => sendOf(render(props(on(key, { draft: 'hi' }))))
    expect(send(`${ANA}/general`)?.attrs.has('disabled')).toBe(false)
    expect(send(`${BOB}/general`)?.attrs.has('disabled')).toBe(true)
    const bob = text(render(props(on(`${BOB}/general`))))
    expect(bob).toContain('trust the new key before you send')
    expect(bob).toContain('Trust the new key')
    expect(sendError('changed', t)).toContain('their key changed')
  })

  test('Send is off for an empty draft and while disabled', () => {
    const send = (over: Partial<TeamBodyProps>) => sendOf(render(props(on(`${ANA}/general`, over))))
    expect(send({ draft: '' })?.attrs.has('disabled')).toBe(true)
    expect(send({ draft: 'hi', disabled: true })?.attrs.has('disabled')).toBe(true)
    expect(send({ draft: 'hi' })?.attrs.has('disabled')).toBe(false)
  })

  test('a topic: its title and link, the link drawn only when it is http(s); its mute', () => {
    const muted: [string, boolean][] = []
    const p = props(on(`${ANA}/${TOPIC}`, { onMute: (k, m) => void muted.push([k, m]) }))
    const nodes = render(p)
    expect(text(nodes)).toContain('Release')
    expect(findAll(nodes, el => el.tag === 'a').map(a => a.attrs.get('href'))).toEqual(['https://example.com/pr/1'])
    const bad = { ...(THREADS[1] as ThreadView), link: 'javascript:alert(1)' }
    expect(findAll(render(props({ selected: bad.key, thread: bad })), el => el.tag === 'a')).toHaveLength(0)
    press(hostsOf(p), h => h.props['data-switch'] === 'mute')
    expect(muted).toEqual([[`${ANA}/${TOPIC}`, true]])
  })

  test('a muted thread says what that means; a thread nothing was written in has no mute yet', () => {
    const deploy = text(render(props(on(`team/${DEPLOY}`))))
    expect(deploy).toContain('muted: no notifications, not counted as unread')
    const bob = render(props(on(`${BOB}/general`)))
    expect(findAll(bob, el => el.attrs.get('data-switch') === 'mute')).toHaveLength(0)
    // The team chat muted as a whole: every team thread says so.
    const chat = { ...AGENTS, peers: { ...AGENTS.peers, team: { on: false, lanes: [], muted: true } } }
    expect(text(render(props(on('team/general', { agents: chat }))))).toContain('muted: no notifications')
  })

  test('a new topic starts from a general thread: a title (needed) and a link, then Start the topic', () => {
    const topics: unknown[] = []
    const general = props(on(`${ANA}/general`, { onTopic: x => void topics.push(x) }))
    press(hostsOf(general), h => h.props.children === 'New topic')
    expect(topics).toEqual([{ title: '' }])
    expect(buttons(render(props(on(`${ANA}/${TOPIC}`))), 'New topic')).toHaveLength(0)
    const start = (title: string) =>
      buttons(render(props(on(`${ANA}/general`, { topic: { title }, draft: 'hi' }))), 'Start the topic')[0]
    expect(start('')?.attrs.has('disabled')).toBe(true)
    expect(start('Release')?.attrs.has('disabled')).toBe(false)
    const inputs = findAll(render(props(on(`${ANA}/general`, { topic: { title: '' } }))), el => el.tag === 'input')
    expect(inputs.map(i => i.attrs.get('aria-label'))).toEqual(['Topic', 'Link (optional, http or https)'])
  })

  test('the team chat: who wrote each message, and how far each member’s copy of yours got', () => {
    const lines: ThreadLine[] = [
      { id: 'i1', dir: 'in', from: ANA, who: 'Ana', text: 'ship it?', ts: '2026-10-28T10:00:00Z' },
      {
        id: 'o1',
        dir: 'out',
        text: 'yes',
        ts: '2026-10-28T10:01:00Z',
        receipts: [
          { peer: ANA, name: 'Ana', state: 'acked' },
          { peer: BOB, name: 'Bob', state: 'queued' },
        ],
      },
    ]
    const nodes = render(props(on('team/general', { lines })))
    const all = text(nodes)
    expect(all).toContain('Team chat')
    expect(text(findAll(nodes, el => hasClass(el, 'team-msg-name')))).toBe('Ana')
    // The post's mark is its slowest copy; its label names every member's.
    expect(marks(nodes).map(m => [m.attrs.get('data-state'), m.attrs.get('aria-label')])).toEqual([
      ['queued', 'Ana: received, Bob: queued at the hub'],
    ])
  })
})

describe('the source', () => {
  const deps = (toasts: string[] = []) => ({
    t: () => t,
    toast: (x: string) => void toasts.push(x),
    remote: () => false,
  })

  test('Trust and Send: POST /api/team/trust { peer }; a general gets { to, text }, a topic { thread: { id } }', async () => {
    const calls = answers()
    const source = teamSource(deps())
    await source.trust(BOB)
    source.select(`${ANA}/general`)
    expect(await source.send('hello')).toBe(true)
    source.select(`team/${DEPLOY}`)
    expect(await source.send('deploy now?')).toBe(true)
    expect(sent(calls).filter(c => c[1] === 'POST')).toEqual([
      ['/api/team/trust', 'POST', '1', { peer: BOB }],
      ['/api/team/send', 'POST', '1', { to: ANA, text: 'hello' }],
      ['/api/team/send', 'POST', '1', { to: 'team', text: 'deploy now?', thread: { id: DEPLOY } }],
    ])
  })

  test('a new topic goes with its title and link, and is the thread on show after', async () => {
    const calls = answers([200, { ok: true, id: 'm1', thread: `${ANA}/${TOPIC}` }])
    const source = teamSource(deps())
    source.select(`${ANA}/general`)
    expect(await source.send('notes?', { title: 'Release', link: 'https://example.com/pr/1' })).toBe(true)
    expect(sent(calls)[0]).toEqual([
      '/api/team/send',
      'POST',
      '1',
      { to: ANA, text: 'notes?', thread: { title: 'Release', link: 'https://example.com/pr/1' } },
    ])
    expect(source.now.get().selected).toBe(`${ANA}/${TOPIC}`)
  })

  test('a refused send says why and is not sent as done', async () => {
    const toasts: string[] = []
    answers([400, { ok: false, error: 'peer' }])
    const source = teamSource(deps(toasts))
    source.select(`${ANA}/general`)
    expect(await source.send('hello')).toBe(false)
    expect(toasts).toEqual(['Not sent: not in the team'])
  })

  test('mutes and switches: POST …/mute | unmute and /api/team/agents, with X-Board', async () => {
    const calls = answers()
    const source = teamSource(deps())
    await source.mute(`${ANA}/${TOPIC}`, true)
    await source.mute('team/general', false)
    await source.setAgents({ peer: 'team', muted: true })
    expect(sent(calls).filter(c => c[1] === 'POST')).toEqual([
      [`/api/team/threads/${ANA}/${TOPIC}/mute`, 'POST', '1', {}],
      ['/api/team/threads/team/general/unmute', 'POST', '1', {}],
      ['/api/team/agents', 'POST', '1', { peer: 'team', muted: true }],
    ])
  })

  test('fetched on opening and on each new teamRev while open: the view, the threads, the switches, the thread on show', async () => {
    const calls = answers(
      [200, VIEW],
      [200, { threads: THREADS }],
      [200, AGENTS],
      [200, { pending: [] }],
      [200, VIEW],
      [200, { threads: THREADS }],
      [200, { thread: THREADS[0], lines: LINES }],
      [200, AGENTS],
      [200, { pending: [] }],
      [200, VIEW],
      [200, { threads: THREADS }],
      [404, { ok: false, error: 'thread' }],
      [200, AGENTS],
      [200, { pending: [BOB] }],
    )
    const source = teamSource(deps())
    source.sync(false, 1)
    expect(calls).toHaveLength(0)
    source.sync(true, 1)
    await Bun.sleep(5)
    source.sync(true, 1)
    expect(calls.map(c => c.url)).toEqual(['/api/team', '/api/team/threads', '/api/team/agents', '/api/team/welcome'])
    source.select(`${ANA}/general`)
    await Bun.sleep(5)
    expect(source.now.get().lines).toEqual(LINES)
    expect(source.now.get().agents).toEqual(AGENTS)
    // A thread nothing was written in yet (404): empty, and no error.
    source.select(`${BOB}/general`)
    await Bun.sleep(5)
    expect(calls.slice(4).map(c => c.url)).toEqual([
      '/api/team',
      '/api/team/threads',
      `/api/team/threads/${ANA}/general`,
      '/api/team/agents',
      '/api/team/welcome',
      '/api/team',
      '/api/team/threads',
      `/api/team/threads/${BOB}/general`,
      '/api/team/agents',
      '/api/team/welcome',
    ])
    expect(source.now.get()).toMatchObject({ selected: `${BOB}/general`, thread: null, lines: [], pending: [BOB] })
  })

  test('a remote page never asks for the switches', async () => {
    const calls = answers([200, VIEW], [200, { threads: [] }])
    const source = teamSource({ ...deps(), remote: () => true })
    source.sync(true, 1)
    await Bun.sleep(5)
    expect(calls.map(c => c.url)).toEqual(['/api/team', '/api/team/threads'])
    expect(source.now.get().agents).toBeNull()
  })

  test('the answers are checked: a view, threads, a thread and switches of another shape are refused', () => {
    expect(isTeamView(VIEW)).toBe(true)
    expect(isTeamView({ ...VIEW, state: 'weird' })).toBe(false)
    expect(isTeamView({ ...VIEW, roster: [{ peer: 'x' }] })).toBe(false)
    expect(isThreadList({ threads: THREADS })).toBe(true)
    expect(isThreadList({ threads: [{ ...THREADS[0], muted: 'no' }] })).toBe(false)
    expect(isThreadLines({ thread: THREADS[0], lines: LINES })).toBe(true)
    expect(isThreadLines({ thread: THREADS[0], lines: [{ id: 1 }] })).toBe(false)
    expect(isAgentsView(AGENTS)).toBe(true)
    expect(isAgentsView({ ...AGENTS, peers: { [ANA]: { on: 'yes', lanes: [] } } })).toBe(false)
  })
})

describe('agent drafts and agent requests (#231, #216)', () => {
  const DRAFT: ThreadLine = { id: 'd1', dir: 'draft', text: 'is the build green?', ts: '2026-10-28T11:00:00Z' }

  test('a draft shows in the thread labelled "draft from an agent" with Send and Discard; the person counts it', () => {
    const nodes = render(props(on(`${ANA}/general`, { lines: [DRAFT] })))
    const all = text(nodes)
    expect(all).toContain('is the build green?')
    expect(all).toContain('draft from an agent')
    expect(buttons(nodes, 'Discard')).toHaveLength(1)
    // The draft's Send, beside the box's.
    expect(buttons(nodes, 'Send')).toHaveLength(1)
    expect(sendOf(nodes)).toBeDefined()
    // The hint on the draft's Send says where it came from, not that anyone approved it.
    expect(buttons(nodes, 'Send')[0]?.attrs.get('title')).toBe(
      'Sends it as a question marked as coming from your agent',
    )
    const counted = { ...VIEW, roster: VIEW.roster.map(p => (p.peer === ANA ? { ...p, drafts: 2 } : p)) }
    expect(text(render(props({ view: counted, people: true })))).toContain('2 draft(s) from an agent')
    expect(text(render(props({ view: counted, people: true }), 'ru'))).toContain('черновиков от агента: 2')
    expect(text(render(props(on(`${ANA}/general`, { lines: [DRAFT] })), 'ru'))).toContain('черновик от агента')
  })

  test('a draft the board held says why', () => {
    const held = { ...DRAFT, reason: 'loop' }
    const mark = findAll(render(props(on(`${ANA}/general`, { lines: [held] }))), el => hasClass(el, 'team-agent-mark'))
    expect(mark.flatMap(m => m.children).map(c => text([c]))).toEqual([
      'draft from an agent',
      'held: the last messages all came from agents',
    ])
  })

  test('Send and Discard on a draft call back with its id; Send waits while the key changed or editing is off', () => {
    const calls: string[] = []
    const p = props(
      on(`${ANA}/general`, {
        lines: [DRAFT],
        onSendDraft: id => void calls.push(`send ${id}`),
        onDiscardDraft: id => void calls.push(`discard ${id}`),
      }),
    )
    const hosts = hostsOf(p)
    press(hosts, h => h.props.children === 'Send') // the draft's: the box's is an arrow
    press(hosts, h => h.props.children === 'Discard')
    expect(calls).toEqual(['send d1', 'discard d1'])
    const bob = render(props(on(`${BOB}/general`, { lines: [{ ...DRAFT, id: 'd2' }] })))
    expect(buttons(bob, 'Send').every(b => b.attrs.has('disabled'))).toBe(true)
    const off = render(props(on(`${ANA}/general`, { lines: [DRAFT], disabled: true })))
    expect(buttons(off, 'Discard')[0]?.attrs.has('disabled')).toBe(true)
  })

  test('an agent request is labelled with whose agent it came through, on both sides, in both languages; a plain message is not', () => {
    const incoming: ThreadLine = {
      id: 'a1',
      dir: 'in',
      from: ANA,
      who: 'Ana',
      text: 'deploy?',
      ts: '2026-10-28T11:01:00Z',
      via: 'agent',
      agent: 'board-216',
    }
    const outgoing: ThreadLine = {
      id: 'a2',
      dir: 'out',
      text: 'ok?',
      ts: '2026-10-28T11:02:00Z',
      state: 'acked',
      via: 'agent',
    }
    const pressed: ThreadLine = { ...outgoing, id: 'a4', pressed: true }
    const plain: ThreadLine = {
      id: 'a3',
      dir: 'out',
      text: 'typed by hand',
      ts: '2026-10-28T11:03:00Z',
      state: 'acked',
    }
    const nodes = render(props(on(`${ANA}/general`, { lines: [incoming, outgoing, plain, pressed] })))
    // The agent's mark (#370): the session, whose board; a person's message has none.
    const agentMarks = findAll(nodes, el => hasClass(el, 'team-agent-mark')).map(m =>
      m.children.filter(c => c.kind === 'element' && c.tag !== 'svg').map(c => text([c])),
    )
    expect(agentMarks).toEqual([
      ['board-216', 'Ana’s board'],
      ['agent', 'your board'],
      ['agent', 'your board', 'an agent’s draft you sent'],
    ])
    const msgs = findAll(nodes, el => hasClass(el, 'team-msg'))
    expect(msgs.map(m => [m.attrs.get('data-line'), hasClass(m, 'agent')])).toEqual([
      ['a1', true],
      ['a2', true],
      ['a3', false],
      ['a4', true],
    ])
    expect(text(nodes)).not.toContain('approved')
    expect(text(render(props(on(`${ANA}/general`, { lines: [incoming] })), 'ru'))).toContain('доска Ana')
  })

  test('through the source: send is POST /api/team/draft/<id>/send, discard /discard, both with X-Board and no text of their own', async () => {
    const calls = answers()
    const source = teamSource({ t: () => t, toast: () => {}, remote: () => false })
    const id = '11111111-1111-4111-8111-111111111111'
    expect(await source.sendDraft(id)).toBe(true)
    await source.discardDraft(id)
    expect(sent(calls).filter(c => c[1] === 'POST')).toEqual([
      [`/api/team/draft/${id}/send`, 'POST', '1', {}],
      [`/api/team/draft/${id}/discard`, 'POST', '1', {}],
    ])
  })

  test('a refused draft send says why', async () => {
    const toasts: string[] = []
    answers([404, { ok: false, error: 'draft' }], [200, VIEW])
    const source = teamSource({ t: () => t, toast: x => void toasts.push(x), remote: () => false })
    expect(await source.sendDraft('11111111-1111-4111-8111-111111111111')).toBe(false)
    expect(toasts).toEqual(['Not sent: that draft is gone'])
  })
})

describe('without teamRev, or on a remote page', () => {
  const now = {
    t,
    theme: 'dark',
    languages: { en: 'English' },
    canEdit: true,
    dock: 'right',
    sleepers: false,
    profiles: false,
    fold: null,
  } as unknown as Parameters<typeof settingsMenu>[0]
  const ids = (team: boolean) => settingsMenu({ ...now, team }).map(e => ('id' in e ? e.id : '—'))

  test('Settings offers Team… only when asked to, and picking it opens the panel', () => {
    expect(ids(false)).not.toContain('team')
    expect(ids(true)).toContain('team')
    expect(settingsMenu({ ...now, team: true }).find(e => 'id' in e && e.id === 'team')).toMatchObject({
      label: 'Team…',
    })
    expect(settingPicked('team')).toEqual({ kind: 'team' })
  })

  test('offersTeam: the local page with teamRev (0 too), nothing else', () => {
    expect(offersTeam({ teamRev: 0 }, false)).toBe(true)
    expect(offersTeam({ teamRev: 3 }, true)).toBe(false)
    expect(offersTeam({}, false)).toBe(false)
    expect(offersTeam(null, false)).toBe(false)
  })

  test('SidePanels draws the panel only on the local page with teamRev', () => {
    const RESTING: Schedule = { armed: null, held: null, cancel() {}, mode() {}, disarm() {} }
    const draw = (data: ReturnType<typeof payload>) =>
      renderInBoard(
        <PanelProvider>
          <SidePanels
            categories={{ open: false, focus: null, onClose() {}, onOpen() {} }}
            schedule={{ open: false, focus: null, onClose() {}, schedule: RESTING }}
            team={{ open: true, onClose() {} }}
          />
        </PanelProvider>,
        board({ data }),
      )
    const ids = (nodes: Node[]) => findAll(nodes, el => el.attrs.get('id') === 'team-sheet')
    expect(ids(draw(payload()))).toHaveLength(0)
    expect(ids(draw(payload({ teamRev: 1 })))).toHaveLength(1)
  })
})
