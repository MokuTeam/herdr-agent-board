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
    expect(mentionChoices([{ peer: ANA, name: 'Dima K.', agents: [{ code: 'helper' }], ts: '' }])[0]?.word).toBe(
      'DimaK.helper',
    )
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

describe('a teammate with no agents to address (#842)', () => {
  const ROSTER = [
    peer(ANA, 'Anna Lee', { agents: true, directory: true }),
    peer(BOB, 'bob'),
    peer('C'.repeat(43), 'Cleo', { directory: true }),
    peer('D'.repeat(43), 'Dima K.', { pin: 'changed' }),
    peer('E'.repeat(43), 'Echo', { assistant: true }),
  ]
  const choices = mentionChoices(DIRECTORY.slice(0, 1), ROSTER)
  const box = (value: string, mentions = choices) => {
    const calls: string[] = []
    const p: TeamComposerProps = {
      value,
      placeholder: 'x',
      disabled: false,
      canSend: true,
      onChange: v => void calls.push(`change ${v}`),
      onSend: () => void calls.push('send'),
      mentions,
    }
    const hosts = hostsOf(<TeamComposer {...p} />)
    const keydown = hosts.find(h => h.tag === 'textarea')?.props.onKeyDown
    if (typeof keydown !== 'function') throw new Error('no box')
    const press = (key: string) =>
      keydown({
        key,
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => void calls.push(`kept ${key}`),
      })
    const options = findAll(renderInBoard(<TeamComposer {...p} />, board()), el => el.attrs.get('role') === 'option')
    return { calls, press, hosts, options }
  }

  test('each teammate without agents is one line with why: an older board or no lane, no lane, a changed key; a bridge is left out', () => {
    expect(choices.map(c => [c.word, c.none ?? null])).toEqual([
      ['AnnaLee.helper', null],
      ['AnnaLee.ops', null],
      ['bob', 'unknown'],
      ['Cleo', 'lane'],
      ['DimaK', 'key'],
    ])
    // A peer whose agents the page could not fetch gets no line that would say there are none.
    expect(mentionChoices([], ROSTER.slice(0, 1))).toEqual([])
    // A bridge that did send a directory is a teammate like any other.
    expect(mentionChoices([], [peer(BOB, 'bob', { assistant: true, directory: true })])[0]?.none).toBe('lane')
  })

  test('fits: the start of the name, and the whole name with a dot; never a code', () => {
    expect(fitMentions(choices, 'c', null).map(c => c.word)).toEqual(['Cleo'])
    expect(fitMentions(choices, 'cleo', '').map(c => c.word)).toEqual(['Cleo'])
    expect(fitMentions(choices, 'cleo', 'x').map(c => c.word)).toEqual(['Cleo'])
    expect(fitMentions(choices, 'cl', '')).toEqual([])
  })

  test('@ with no directory at all lists the teammates, each with its line, none to pick', () => {
    const b = box('@', mentionChoices([], ROSTER.slice(1)))
    expect(
      b.options.map(o => [o.attrs.get('data-mention'), o.attrs.get('data-none'), o.attrs.get('aria-disabled')]),
    ).toEqual([
      ['bob', 'unknown', 'true'],
      ['Cleo', 'lane', 'true'],
      ['DimaK', 'key', 'true'],
    ])
    expect(b.options.map(o => text([o]))).toEqual([
      `@bob${t('team.mentionNone')}`,
      `@Cleo${t('team.mentionNoneLane')}`,
      `@DimaK${t('team.mentionNoneKey')}`,
    ])
    expect(t('team.mentionNone')).toContain('needs the update')
    expect(t('team.mentionNoneLane')).not.toContain('update')
  })

  test('a list of such lines only says why: Enter sends as before, Tab and the arrows are not taken; a press puts nothing in', () => {
    const b = box('hi @bo')
    expect(b.options.map(o => o.attrs.get('aria-selected'))).toEqual(['false'])
    b.press('Tab')
    b.press('ArrowDown')
    const option = b.hosts.find(h => h.props['data-mention'] === 'bob')?.props.onPointerDown
    if (typeof option !== 'function') throw new Error('no option')
    option({ preventDefault() {} })
    expect(b.calls).toEqual([])
    b.press('Enter')
    expect(b.calls).toEqual(['kept Enter', 'send'])
    expect(b.hosts.find(h => h.tag === 'textarea')?.props['aria-activedescendant']).toBeUndefined()
  })

  test('agents come first, so a teammate without them never takes Enter from an agent or pushes one out', () => {
    const many = Array.from({ length: 9 }, (_, i) => peer(String(i).repeat(43), `Aa${i}`))
    const mixed = mentionChoices(DIRECTORY.slice(0, 1), [peer(ANA, 'Anna Lee', { agents: true }), ...many])
    expect(
      fitMentions(mixed, 'a', null)
        .slice(0, 3)
        .map(c => c.word),
    ).toEqual(['AnnaLee.helper', 'AnnaLee.ops', 'Aa0'])
    const b = box('@a', mixed)
    expect(b.options.map(o => o.attrs.get('data-mention')).slice(0, 2)).toEqual(['AnnaLee.helper', 'AnnaLee.ops'])
    expect(b.options[0]?.attrs.get('aria-selected')).toBe('true')
    b.press('Enter')
    expect(b.calls).toEqual(['kept Enter', 'change @AnnaLee.helper '])
  })

  test('the whole name with a dot shows only its line, and Enter sends as before', () => {
    const mixed = mentionChoices(DIRECTORY.slice(0, 1), [peer(ANA, 'Anna Lee', { agents: true }), peer(BOB, 'Anne')])
    expect(fitMentions(mixed, 'ann', null).map(c => c.word)).toEqual(['AnnaLee.helper', 'AnnaLee.ops', 'Anne'])
    const b = box('@Anne.', mixed)
    expect(b.options.map(o => o.attrs.get('data-mention'))).toEqual(['Anne'])
    b.press('Enter')
    expect(b.calls).toEqual(['kept Enter', 'send'])
  })

  test('the thread offers the teammates once there is a roster, with no directory', () => {
    const nodes = renderInBoard(
      <TeamBody
        view={{ ...VIEW, roster: [peer(BOB, 'bob')] }}
        threads={[
          {
            key: `${BOB}/general`,
            scope: BOB,
            id: 'general',
            peerName: 'bob',
            title: null,
            last: null,
            unread: 0,
          } as never,
        ]}
        selected={`${BOB}/general`}
        thread={null}
        lines={[]}
        agents={null}
        draft="@"
        topic={null}
        disabled={false}
        onSelect={() => {}}
        onTrust={() => {}}
        onSendDraft={() => {}}
        onDiscardDraft={() => {}}
        onDraft={() => {}}
        onTopic={() => {}}
        onSend={() => {}}
        onMute={() => {}}
        onAgents={() => {}}
      />,
      board(),
    )
    const options = findAll(nodes, el => el.attrs.get('role') === 'option')
    expect(options.map(o => o.attrs.get('data-mention'))).toEqual(['bob'])
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
