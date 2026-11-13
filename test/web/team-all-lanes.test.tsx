// Every lane shared with a peer in the Team panel (#386, docs/design/assistant-bridge, 8.4): an
// "All lanes" control above the lanes of every scope's switches and of a new member's welcome;
// on, each lane shows shared and cannot be picked alone. Agents turned on for an assistant's
// bridge that shares no lane yet share every lane with it, and its welcome starts with All lanes
// ticked; for every other peer the panel sends what it sent before.
import { describe, expect, test } from 'bun:test'
import { TeamBody, type TeamBodyProps } from '../../web/src/components/team/TeamPanel.tsx'
import type { AgentsView, TeamView, ThreadView, Welcome } from '../../web/src/models/team.ts'
import { board, renderInBoard } from './support/board.tsx'
import { findAll, type Node } from './support/markup.ts'
import { type Host, hostElements } from './support/react-events.ts'

const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
const ME = 'M'.repeat(43)
const ANA = 'A'.repeat(43)
const BOT = 'E'.repeat(43)

const peer = (id: string, name: string, more: Record<string, unknown> = {}) => ({
  peer: id,
  name,
  online: true,
  lastSeen: null,
  fingerprint: '1111',
  pin: 'trusted' as const,
  drafts: 0,
  ...more,
})
const VIEW: TeamView = {
  state: 'online',
  me: { peer: ME, fingerprint: 'aaaa', name: 'me' },
  hub: 'wss://hub.example.com',
  roster: [peer(ANA, 'Ana'), peer(BOT, 'ana-assistant', { assistant: true })],
}
const AGENTS: AgentsView = {
  off: false,
  listener: null,
  peers: {},
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
    threads: [] as ThreadView[],
    selected: null,
    thread: null,
    lines: [],
    agents: AGENTS,
    draft: '',
    topic: null,
    disabled: false,
    people: true,
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

/** The buttons of one scope's lanes, in order: [label, pressed, disabled]. */
function lanesOf(nodes: Node[], scope: string): [string, string | undefined, boolean][] {
  const row = findAll(nodes, el => el.attrs.get('data-scope') === scope)
  return findAll(row, el => el.tag === 'button' && (el.attrs.get('class') ?? '').includes('team-lane')).map(b => [
    text([b]),
    b.attrs.get('aria-pressed'),
    b.attrs.has('disabled'),
  ])
}

describe('the switches (#386)', () => {
  test('every scope has All lanes above its lanes; a click turns it on, and off again', () => {
    const changes: unknown[] = []
    const p = props({ onAgents: c => void changes.push(c) })
    const nodes = render(p)
    expect(lanesOf(nodes, ANA)).toEqual([
      ['All lanes', 'false', false],
      ['Work', 'false', false],
      ['Home', 'false', false],
    ])
    expect(lanesOf(nodes, 'team')[0]).toEqual(['All lanes', 'false', false])
    click(hostsOf(p).find(h => h.props['data-all-lanes'] === ANA))
    const on = props({
      agents: { ...AGENTS, peers: { [ANA]: { on: true, lanes: ['work'], allLanes: true } } },
      onAgents: c => void changes.push(c),
    })
    // On: every lane shows shared and is not picked alone.
    expect(lanesOf(render(on), ANA)).toEqual([
      ['All lanes', 'true', false],
      ['Work', 'true', true],
      ['Home', 'true', true],
    ])
    click(hostsOf(on).find(h => h.props['data-all-lanes'] === ANA))
    expect(changes).toEqual([
      { peer: ANA, allLanes: true },
      { peer: ANA, allLanes: false },
    ])
  })

  test('Agents on for an assistant that shares nothing yet shares every lane; anyone else gets what main sent', () => {
    const changes: unknown[] = []
    const flip = (agents: AgentsView, scope: string) => {
      const p = props({ agents, onAgents: c => void changes.push(c) })
      click(hostsOf(p).find(h => h.props['data-switch'] === `agents-${scope}`))
    }
    flip(AGENTS, ANA)
    flip(AGENTS, 'team')
    flip(AGENTS, BOT)
    flip({ ...AGENTS, peers: { [BOT]: { on: false, lanes: ['home'] } } }, BOT)
    flip({ ...AGENTS, peers: { [BOT]: { on: true, lanes: [] } } }, BOT)
    expect(changes).toEqual([
      { peer: ANA, on: true },
      { peer: 'team', on: true },
      { peer: BOT, on: true, allLanes: true },
      // A lane picked already is the owner's choice: left as it is.
      { peer: BOT, on: true },
      // Turning off never adds lanes.
      { peer: BOT, on: false },
    ])
  })
})

describe('a new member’s welcome (#386)', () => {
  const welcomeOf = (who: string, agents: AgentsView = AGENTS) => {
    const done: Welcome[] = []
    const p = props({ people: false, pending: [who], agents, onWelcome: w => void done.push(w) })
    return { p, done }
  }

  test('anyone but an assistant: All lanes unticked, and Done sends what main sent', () => {
    const { p, done } = welcomeOf(ANA)
    const card = findAll(render(p), el => el.attrs.get('data-welcome') === ANA)
    const all = findAll(card, el => el.attrs.get('data-all-lanes') === ANA)[0]
    expect(all?.attrs.get('aria-pressed')).toBe('false')
    click(hostsOf(p).find(h => h.props['data-welcome-done'] !== undefined))
    expect(done).toEqual([{ peer: ANA, on: false, lanes: [], channels: [] }])
  })

  test('an assistant’s bridge: All lanes ticked from the start, and Done says so', () => {
    const { p, done } = welcomeOf(BOT)
    const card = findAll(render(p), el => el.attrs.get('data-welcome') === BOT)
    const all = findAll(card, el => el.attrs.get('data-all-lanes') === BOT)[0]
    expect(all?.attrs.get('aria-pressed')).toBe('true')
    click(hostsOf(p).find(h => h.props['data-welcome-done'] !== undefined))
    expect(done).toEqual([{ peer: BOT, on: false, lanes: [], allLanes: true, channels: [] }])
  })

  test('switches set before keep their word: all lanes on stays on unless unticked', () => {
    const { p, done } = welcomeOf(ANA, { ...AGENTS, peers: { [ANA]: { on: true, lanes: [], allLanes: true } } })
    click(hostsOf(p).find(h => h.props['data-welcome-done'] !== undefined))
    expect(done).toEqual([{ peer: ANA, on: true, lanes: [], allLanes: true, channels: [] }])
  })
})
