// Addressing a peer's agent on the page (#832): the box lists the peers' agents after `@` and puts
// `@Name.handle ` in on Enter or Tab (without a list the box sends as before); People and agents shows
// what teammates can address (read only: exposure follows the lanes shared); the directories are
// asked only while a peer in the roster sent one.
import { afterEach, describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { TeamView } from '../../src/services/team-hub.ts'
import { TeamComposer, type TeamComposerProps } from '../../web/src/components/team/TeamComposer.tsx'
import { TeamBody, type TeamBodyProps } from '../../web/src/components/team/TeamPanel.tsx'
import { teamSource } from '../../web/src/hooks/useTeam.ts'
import { type AgentsView, fitMentions, mentionChoices } from '../../web/src/models/team.ts'
import { board, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch } from './support/fetch-answers.ts'
import { findAll, type Node } from './support/markup.ts'
import { type Host, hostElements } from './support/react-events.ts'

afterEach(restoreFetch)

const t = translator('en')
const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
const ANA = 'A'.repeat(43)
const BOB = 'B'.repeat(43)
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
  me: { peer: 'M'.repeat(43), fingerprint: 'aaaa', name: 'me' },
  hub: 'wss://hub.example.com',
  roster: [peer(ANA, 'Anna Lee'), peer(BOB, 'bob')],
}
const DIRECTORY = [
  { peer: ANA, name: 'Anna Lee', agents: [{ code: 'helper', about: 'Answers' }, { code: 'ops' }], ts: '' },
  { peer: BOB, name: 'bob', agents: [{ code: 'reviewer' }], ts: '' },
]

function hostsOf(node: React.ReactElement): Host[] {
  let hosts: Host[] = []
  function Probe() {
    hosts = hostElements(node)
    return null
  }
  renderInBoard(<Probe />, board())
  return hosts
}

describe("the box's list after @", () => {
  const choices = mentionChoices(DIRECTORY)
  const box = (over: Partial<TeamComposerProps>) => {
    const calls: string[] = []
    const p: TeamComposerProps = {
      value: '',
      placeholder: 'x',
      disabled: false,
      canSend: true,
      onChange: v => void calls.push(`change ${v}`),
      onSend: () => void calls.push('send'),
      ...over,
    }
    const keydown = hostsOf(<TeamComposer {...p} />).find(h => h.tag === 'textarea')?.props.onKeyDown
    if (typeof keydown !== 'function') throw new Error('no box')
    const press = (key: string) =>
      keydown({ key, shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() {} })
    return { calls, press, nodes: renderInBoard(<TeamComposer {...p} />, board()) }
  }

  test('choices: Name (no spaces).code, with the line about it; what fits the name, then the code', () => {
    expect(choices.map(c => c.word)).toEqual(['AnnaLee.helper', 'AnnaLee.ops', 'bob.reviewer'])
    expect(fitMentions(choices, 'an', null).map(c => c.code)).toEqual(['helper', 'ops'])
    expect(fitMentions(choices, 'annalee', 'o').map(c => c.code)).toEqual(['ops'])
    expect(fitMentions(choices, 'bo', 'r')).toEqual([])
  })

  test('@an lists her agents; Enter puts the first in, and sends nothing', () => {
    const b = box({ value: 'hi @an', mentions: choices })
    const list = findAll(b.nodes, el => el.attrs.has('data-mentions'))
    expect(findAll(list, el => el.attrs.get('role') === 'option').map(o => text([o]))).toEqual([
      '@AnnaLee.helperAnswers',
      '@AnnaLee.ops',
    ])
    b.press('Enter')
    expect(b.calls).toEqual(['change hi @AnnaLee.helper '])
  })

  test('Tab picks too; the arrows move the choice', () => {
    const b = box({ value: '@AnnaLee.', mentions: choices })
    b.press('Tab')
    expect(b.calls).toEqual(['change @AnnaLee.helper '])
  })

  test('no list: without directories, or when nothing fits, Enter sends as before', () => {
    for (const over of [
      { value: '@an' },
      { value: '@zed', mentions: choices },
      { value: 'hello', mentions: choices },
    ]) {
      const b = box(over)
      expect(findAll(b.nodes, el => el.attrs.has('data-mentions'))).toEqual([])
      b.press('Enter')
      expect(b.calls).toEqual(['send'])
    }
  })
})

describe('what teammates can address, shown in People and agents', () => {
  const AGENTS: AgentsView = {
    off: false,
    listener: null,
    peers: {},
    paused: {},
    lanes: [{ id: 'work', title: 'Work' }],
    loopDefault: 20,
    exposed: [{ code: 'acme-work', session: { key: 'sess-1', name: 'Acme work' }, lane: 'work', reaches: [ANA, BOB] }],
  }
  const props = (over: Partial<TeamBodyProps> = {}): TeamBodyProps => ({
    view: VIEW,
    threads: [],
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
    ...over,
  })

  test('each handle as @Me.handle, its lane, its session and who reaches it; nothing to switch', () => {
    const nodes = renderInBoard(<TeamBody {...props()} />, board())
    const rows = findAll(nodes, el => el.attrs.has('data-expose'))
    expect(rows.map(r => r.attrs.get('data-expose'))).toEqual(['acme-work'])
    const row = text([rows[0] as Node])
    expect(row).toContain('@me.acme-work')
    expect(row).toContain('Work')
    expect(row).toContain('Acme work')
    expect(row).toContain('Reached by Anna Lee, bob')
    expect(findAll(rows, el => el.tag === 'button' || el.tag === 'input')).toEqual([])
  })

  test('nothing reachable (or an older board): no section at all', () => {
    const { exposed: _e, ...plain } = AGENTS
    expect(
      findAll(renderInBoard(<TeamBody {...props({ agents: plain })} />, board()), el => el.attrs.has('data-exposed')),
    ).toEqual([])
  })
})

describe('the directories are asked only when a peer sent one', () => {
  test('a roster peer marked agents: GET /api/team/directory after the rest', async () => {
    const calls = answers(
      [200, { ...VIEW, roster: [peer(ANA, 'Anna Lee', { agents: true }), peer(BOB, 'bob')] }],
      [200, { threads: [] }],
      [200, { peers: DIRECTORY }],
    )
    const source = teamSource({ t: () => t, toast: () => {}, visible: () => true, remote: () => true })
    source.sync(true, 1, 0)
    await Bun.sleep(10)
    expect(calls.map(c => c.url)).toEqual(['/api/team', '/api/team/threads', '/api/team/directory'])
    expect(source.now.get().directory).toEqual(DIRECTORY)
  })
})
