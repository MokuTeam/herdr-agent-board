// Addressing a peer's agent on the page (#832, #842): after `@` the box lists the teammates, Enter or
// Tab puts `@Name.` in and lists their agents (or why there are none), and then `@Name.handle ` (without
// a list the box sends as before); People and agents shows
// what teammates can address (exposure follows the lanes shared); the directories are
// asked only while a peer in the roster sent one.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { translator } from '../../src/core/i18n/translator.ts'
import type { TeamView } from '../../src/services/team-hub.ts'
import { TeamComposer, type TeamComposerProps } from '../../web/src/components/team/TeamComposer.tsx'
import { mentionMark, TeamMessage } from '../../web/src/components/team/TeamMessage.tsx'
import { TeamBody, type TeamBodyProps } from '../../web/src/components/team/TeamPanel.tsx'
import { teamSource } from '../../web/src/hooks/useTeam.ts'
import { markdown } from '../../web/src/models/markdown.ts'
import { type AgentsView, type MentionPerson, mentionPeople, mentionRows } from '../../web/src/models/team.ts'
import { board, renderInBoard } from './support/board.tsx'
import { answers, restoreFetch } from './support/fetch-answers.ts'
import { findAll, hasClass, type Node } from './support/markup.ts'
import { type Host, hostElements } from './support/react-events.ts'

afterEach(restoreFetch)

const t = translator('en')
const css = readFileSync(new URL('../../web/styles/team.css', import.meta.url), 'utf8')
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

describe("the box's list after @: the teammates, then the one picked's agents (#832, #842)", () => {
  const ROSTER = [
    peer(ANA, 'Anna Lee', { agents: true, directory: true }),
    peer(BOB, 'bob', { agents: true, directory: true }),
    peer('C'.repeat(43), 'Cleo', { directory: true }),
    peer('D'.repeat(43), 'Dima K.', { pin: 'changed' }),
    peer('E'.repeat(43), 'Echo'),
  ]
  const people = mentionPeople(DIRECTORY, ROSTER)
  const box = (value: string, mentions: readonly MentionPerson[] | null = people) => {
    const calls: string[] = []
    const p: TeamComposerProps = {
      value,
      placeholder: 'x',
      disabled: false,
      canSend: true,
      onChange: v => void calls.push(`change ${v}`),
      onSend: () => void calls.push('send'),
      ...(mentions && { mentions }),
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
    const nodes = renderInBoard(<TeamComposer {...p} />, board())
    const list = findAll(nodes, el => el.attrs.has('data-mentions'))[0]
    const options = findAll(nodes, el => el.attrs.get('role') === 'option')
    const tap = (word: string) => {
      const down = hosts.find(h => h.props['data-mention'] === word)?.props.onPointerDown
      if (typeof down !== 'function') throw new Error(`no ${word}`)
      down({ preventDefault() {} })
    }
    return { calls, press, tap, hosts, list, options }
  }
  const words = (b: { options: Node[] }) =>
    b.options.map(o => (o.kind === 'element' ? o.attrs.get('data-mention') : ''))

  test('a unique published alias is offered and picked as a canonical address; clashes keep the handles', () => {
    const alias = { code: 'helper', alias: 'Reports' }
    const directories = [{ peer: ANA, name: 'Anna Lee', agents: [alias], ts: '' }]
    const listed = mentionPeople(directories, ROSTER)
    const b = box('@rep', listed)
    expect(words(b)).toEqual(['Reports'])
    b.press('Enter')
    expect(b.calls).toEqual(['kept Enter', 'change @AnnaLee.helper '])
    const duplicates = mentionPeople(
      [...directories, { peer: BOB, name: 'bob', ts: '', agents: [{ code: 'reviewer', alias: 'REPORTS' }] }],
      ROSTER,
    )
    expect(mentionRows(duplicates, 'rep', null)).toEqual([])
    expect(mentionRows(duplicates, 'annalee', 'h').map(r => r.word)).toEqual(['AnnaLee.helper'])
    const reserved = mentionPeople(directories, [...ROSTER, peer('R'.repeat(43), 'Re ports')])
    expect(box('@rep', reserved).options.every(o => o.kind !== 'element' || o.attrs.get('data-kind') !== 'alias')).toBe(
      true,
    )
  })

  test('every teammate in the roster, by name, with or without agents; their agents by code name', () => {
    expect(people.map(p => [p.word, p.agents.map(a => a.code), p.none ?? null])).toEqual([
      ['AnnaLee', ['helper', 'ops'], null],
      ['bob', ['reviewer'], null],
      ['Cleo', [], 'lane'],
      ['DimaK', [], 'key'],
      ['Echo', [], 'unknown'],
    ])
    // Agents the page could not fetch: no agents and no reason that would say there are none.
    expect(mentionPeople([], [peer(ANA, 'Anna Lee', { agents: true })])).toEqual([
      { peer: ANA, name: 'Anna Lee', word: 'AnnaLee', agents: [] },
    ])
    // No roster yet (the tests' directories alone): each directory is a teammate.
    expect(mentionPeople(DIRECTORY).map(p => p.word)).toEqual(['AnnaLee', 'bob'])
  })

  test('the rows: the names that fit while a name is written; after a whole name and a dot, their agents or why none', () => {
    expect(mentionRows(people, '', null).map(r => [r.kind, r.word, r.insert])).toEqual([
      ['person', 'AnnaLee', '@AnnaLee.'],
      ['person', 'bob', '@bob.'],
      ['person', 'Cleo', '@Cleo.'],
      ['person', 'DimaK', '@DimaK.'],
      ['person', 'Echo', '@Echo.'],
    ])
    expect(mentionRows(people, 'an', null).map(r => r.word)).toEqual(['AnnaLee'])
    expect(mentionRows(people, 'annalee', '').map(r => [r.kind, r.word, r.insert, r.about])).toEqual([
      ['agent', 'AnnaLee.helper', '@AnnaLee.helper ', 'Answers'],
      ['agent', 'AnnaLee.ops', '@AnnaLee.ops ', undefined],
    ])
    expect(mentionRows(people, 'AnnaLee', 'o').map(r => r.word)).toEqual(['AnnaLee.ops'])
    expect(mentionRows(people, 'annalee', 'x')).toEqual([])
    expect(mentionRows(people, 'ann', '')).toEqual([])
    expect(mentionRows(people, 'cleo', '').map(r => [r.kind, r.none, r.insert])).toEqual([['none', 'lane', undefined]])
    expect(mentionRows(people, 'cleo', 'x').map(r => r.none)).toEqual(['lane'])
  })

  test('@ lists every teammate, the agents nowhere yet; Enter puts "@Name." in, which is the second list', () => {
    const b = box('hi @')
    expect(b.list?.attrs.get('data-mentions')).toBe('people')
    expect(b.list?.attrs.get('aria-label')).toBe(t('team.mentionPeople'))
    expect(words(b)).toEqual(['AnnaLee', 'bob', 'Cleo', 'DimaK', 'Echo'])
    expect(b.options.every(o => o.attrs.get('data-kind') === 'person')).toBe(true)
    expect(b.options[0]?.attrs.get('aria-selected')).toBe('true')
    b.press('Enter')
    expect(b.calls).toEqual(['kept Enter', 'change hi @AnnaLee.'])
  })

  test('typing filters the names; Tab picks too, and so does a press; the arrows are taken', () => {
    const b = box('@b')
    expect(words(b)).toEqual(['bob'])
    b.press('ArrowDown')
    b.press('Tab')
    b.tap('bob')
    expect(b.calls).toEqual(['kept ArrowDown', 'kept Tab', 'change @bob.', 'change @bob.'])
  })

  test('the second list: their agents; typing filters them; Enter or Tab puts "@Name.code " in', () => {
    const b = box('@AnnaLee.')
    expect(b.list?.attrs.get('data-mentions')).toBe('agents')
    expect(b.list?.attrs.get('aria-label')).toBe(t('team.mentions'))
    expect(b.options.map(o => text([o]))).toEqual(['@AnnaLee.helperAnswers', '@AnnaLee.ops'])
    b.press('Enter')
    expect(b.calls).toEqual(['kept Enter', 'change @AnnaLee.helper '])
    const o = box('hi @annalee.o')
    expect(words(o)).toEqual(['AnnaLee.ops'])
    o.press('Tab')
    expect(o.calls).toEqual(['kept Tab', 'change hi @AnnaLee.ops '])
  })

  test('a teammate with no agents: the second list is the line that says why; nothing puts it in, and Enter or Tab sends nothing', () => {
    for (const [value, why, words_] of [
      ['@Cleo.', 'lane', t('team.mentionNoneLane')],
      ['@DimaK.', 'key', t('team.mentionNoneKey')],
      ['hi @Echo.', 'unknown', t('team.mentionNone')],
    ] as const) {
      const name = value.slice(value.indexOf('@') + 1, -1)
      const b = box(value)
      expect(b.options.map(o => [o.attrs.get('data-none'), o.attrs.get('aria-disabled'), text([o])])).toEqual([
        [why, 'true', `@${name}${words_}`],
      ])
      expect(b.options[0]?.attrs.get('aria-selected')).toBe('false')
      expect(b.hosts.find(h => h.tag === 'textarea')?.props['aria-activedescendant']).toBeUndefined()
      b.tap(name)
      // The arrows move the caret as before: nothing to move to in the list.
      b.press('ArrowDown')
      expect(b.calls).toEqual([])
      b.press('Enter')
      b.press('Tab')
      expect(b.calls).toEqual(['kept Enter', 'kept Tab'])
    }
    expect(t('team.mentionNone')).toContain('needs the update')
    expect(t('team.mentionNoneLane')).not.toContain('update')
  })

  test('every teammate is listed, however many: the list scrolls instead of cutting them', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      peer(String.fromCharCode(97 + i).repeat(43), `Team${String(i).padStart(2, '0')}`),
    )
    const b = box('@', mentionPeople([], many))
    expect(words(b)).toEqual(many.map(p => p.name))
    const rule = css.match(/\.team-mentions \{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('max-height')
    expect(rule).toContain('overflow-y: auto')
  })

  test('Esc lets the list go', () => {
    const b = box('@')
    b.press('Escape')
    expect(b.calls).toEqual(['kept Escape'])
  })

  test('no list: without teammates, a name nobody has, agents none of whose code names fit; Enter sends as before', () => {
    for (const [value, mentions] of [
      ['@an', null],
      ['@an', []],
      ['@zed', people],
      ['@AnnaLee.zz', people],
      ['hello', people],
      ['mail@an', people],
    ] as const) {
      const b = box(value, mentions)
      expect(b.list).toBeUndefined()
      b.press('Enter')
      expect(b.calls).toEqual(['kept Enter', 'send'])
    }
  })

  test('a dotted name is written without its dot', () => {
    const dima = mentionPeople([{ peer: ANA, name: 'Dima K.', agents: [{ code: 'helper' }], ts: '' }])
    expect(mentionRows(dima, 'dimak', '').map(r => r.insert)).toEqual(['@DimaK.helper '])
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
    expect(findAll(nodes, el => el.attrs.get('role') === 'option').map(o => o.attrs.get('data-mention'))).toEqual([
      'bob',
    ])
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

  test('each handle as @Me.handle, its lane, its session, who reaches it and the alias editor', () => {
    const nodes = renderInBoard(<TeamBody {...props()} />, board())
    const rows = findAll(nodes, el => el.attrs.has('data-expose'))
    expect(rows.map(r => r.attrs.get('data-expose'))).toEqual(['acme-work'])
    const row = text([rows[0] as Node])
    expect(row).toContain('@me.acme-work')
    expect(row).toContain('Work')
    expect(row).toContain('Acme work')
    expect(row).toContain('Reached by Anna Lee, bob')
    expect(findAll(rows, el => el.tag === 'input').map(el => el.attrs.get('name'))).toEqual(['alias'])
    expect(findAll(rows, el => el.tag === 'button').map(el => text(el.children))).toEqual(['Save alias'])
  })

  test('the owner can set exposure when there are no reachable agents yet', () => {
    const { exposed: _e, ...plain } = AGENTS
    const nodes = renderInBoard(<TeamBody {...props({ agents: plain })} />, board())
    const settings = findAll(nodes, el => el.attrs.has('data-exposed'))
    expect(text(settings)).toContain('Peers can reach')
    expect(findAll(settings, el => el.attrs.has('data-expose'))).toEqual([])
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

describe("a message's leading mention, highlighted where it was written (#875)", () => {
  const marked = (text: string): string => {
    const mark = mentionMark(text)
    return mark ? mark(markdown(text)) : markdown(text)
  }
  test('the mention is wrapped, the rest of the text as Markdown made it', () => {
    expect(marked('@Anna.helper is the release green?')).toBe(
      '<p><span class="team-at">@Anna.helper</span> is the release green?</p>',
    )
    expect(marked('@bob.reviewer, look\nnow')).toBe('<p><span class="team-at">@bob.reviewer</span>, look<br>now</p>')
    expect(marked('@bob.reviewer')).toBe('<p><span class="team-at">@bob.reviewer</span></p>')
  })
  test('a name that needed escaping stays escaped; no mention, or one Markdown changed, leaves the text alone', () => {
    expect(marked('@a<b>.ops hi')).toBe('<p><span class="team-at">@a&lt;b&gt;.ops</span> hi</p>')
    expect(mentionMark('hello @Anna.helper')).toBeUndefined()
    expect(mentionMark('mail@Anna.helper')).toBeUndefined()
    expect(marked('@*x*.ops hi')).toBe(markdown('@*x*.ops hi'))
  })
  test('a bubble shows it: the mention in its own span, the words after it as written', () => {
    const line = {
      id: 'm1',
      dir: 'in' as const,
      from: ANA,
      who: 'Anna Lee',
      text: '@me.helper is it green?',
      ts: '2026-11-26T10:00:00Z',
    }
    const nodes = renderInBoard(
      <TeamMessage line={line} first last named={false} quote={null} onQuote={() => {}} />,
      board(),
    )
    const at = findAll(nodes, el => hasClass(el, 'team-at'))
    expect(at.map(n => text([n]))).toEqual(['@me.helper'])
    expect(text(findAll(nodes, el => hasClass(el, 'md')))).toBe('@me.helper is it green?')
  })
  test("the highlight is tinted in the accent, a little stronger in this board's own bubble", () => {
    expect(css).toMatch(/\.team-bubble \.team-at \{[^}]*color: var\(--accent\)/)
    expect(css).toMatch(/\.team-msg\.out \.team-bubble \.team-at \{/)
  })
})
