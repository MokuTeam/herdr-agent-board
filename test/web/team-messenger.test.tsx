// The Team panel as a messenger (#370): a separator for each day ("Today", "Yesterday", a date, the
// year when not this one) in the board's time zone, the times on bubbles and in the list, one
// sender's messages a few minutes apart under one name, the agent's mark, a reply's quote and its
// scroll target, the "new messages" line (where the thread opens, kept while the count drops), the
// jump to the latest, the box's keys and its slots, the draft kept per thread, and a phone's width:
// one pane at a time, nothing wider than the screen.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import { TeamComposer, type TeamComposerProps } from '../../web/src/components/team/TeamComposer.tsx'
import { TeamBody, type TeamBodyProps } from '../../web/src/components/team/TeamPanel.tsx'
import type { TeamView, ThreadLine, ThreadView } from '../../web/src/models/team.ts'
import {
  agentMark,
  bubbleTime,
  chatItems,
  deliveryOf,
  fullWhen,
  GROUP_MS,
  listWhen,
  oneLine,
  quoteOf,
  unreadStart,
} from '../../web/src/models/team-chat.ts'
import { board, renderInBoard } from './support/board.tsx'
import { findAll, hasClass, type Node } from './support/markup.ts'
import { type Host, hostElements } from './support/react-events.ts'

const en = translator('en')
const ru = translator('ru')
const NOW = Date.parse('2026-11-11T12:00:00Z')
const ANNA = 'A'.repeat(43)
const BEN = 'B'.repeat(43)
const text = (nodes: Node[]): string => nodes.map(n => (n.kind === 'text' ? n.text : text(n.children))).join('')
/** ICU puts a narrow space before AM/PM. */
const plain = (s: string): string => s.replace(/\s/g, ' ')

const msg = (id: string, ts: string, over: Partial<ThreadLine> = {}): ThreadLine => ({
  id,
  dir: 'in',
  from: ANNA,
  who: 'anna',
  text: id,
  ts,
  ...over,
})
const mine = (id: string, ts: string, over: Partial<ThreadLine> = {}): ThreadLine => ({
  id,
  dir: 'out',
  text: id,
  ts,
  state: 'acked',
  ...over,
})
const days = (lines: ThreadLine[], t = en, now = NOW) =>
  chatItems(lines, { t, now }).flatMap(i => (i.kind === 'day' ? [i.label] : []))

/** In another time zone for the length of `fn`. */
function inZone<T>(zone: string, fn: () => T): T {
  const was = process.env.TZ
  process.env.TZ = zone
  try {
    return fn()
  } finally {
    process.env.TZ = was ?? 'UTC'
  }
}

describe('days and times, on a fixed clock', () => {
  const LINES = [
    msg('a', '2025-12-31T10:00:00Z'),
    msg('b', '2026-11-09T09:00:00Z'),
    msg('c', '2026-11-10T18:00:00Z'),
    msg('d', '2026-11-11T08:00:00Z'),
    msg('e', '2026-11-11T08:01:00Z'),
  ]

  test('a separator before each day’s first message: Today, Yesterday, the weekday and date, the year when not this one', () => {
    inZone('UTC', () => {
      expect(days(LINES)).toEqual(['Wednesday, December 31, 2025', 'Monday, November 9', 'Yesterday', 'Today'])
      expect(days(LINES, ru)).toEqual(['Среда, 31 декабря 2025 г.', 'Понедельник, 9 ноября', 'Вчера', 'Сегодня'])
      // Two messages of one day: one separator.
      expect(chatItems(LINES, { t: en, now: NOW }).map(i => i.kind)).toEqual([
        'day',
        'msg',
        'day',
        'msg',
        'day',
        'msg',
        'day',
        'msg',
        'msg',
      ])
    })
  })

  test('the board’s time zone decides the day: 21:30 UTC yesterday is 01:30 today in Tbilisi', () => {
    const late = [msg('x', '2026-11-10T21:30:00Z')]
    expect(inZone('UTC', () => days(late))).toEqual(['Yesterday'])
    expect(inZone('Asia/Tbilisi', () => days(late))).toEqual(['Today'])
    expect(inZone('Asia/Tbilisi', () => bubbleTime('2026-11-10T21:30:00Z', ru))).toBe('1:30')
  })

  test('the bubble’s time, the full date and time on hover, the list’s time', () => {
    inZone('UTC', () => {
      expect(plain(bubbleTime('2026-11-11T08:05:00Z', en))).toBe('8:05 AM')
      expect(plain(fullWhen('2026-11-11T08:05:00Z', en))).toBe('Wednesday, November 11, 2026, 8:05 AM')
      expect(fullWhen('2026-11-11T08:05:00Z', ru)).toBe('Среда, 11 ноября 2026 г., 8:05')
      const list = ['2026-11-11T08:05:00Z', '2026-11-10T08:05:00Z', '2026-11-08T08:05:00Z', '2026-10-22T08:05:00Z']
      expect(list.map(ts => plain(listWhen(ts, en, NOW)))).toEqual(['8:05 AM', 'Yesterday', 'Sun', 'Oct 22'])
      expect(listWhen('2025-12-31T08:05:00Z', en, NOW)).toBe('Dec 31, 2025')
      expect(listWhen('2026-11-10T08:05:00Z', ru, NOW)).toBe('Вчера')
    })
  })
})

describe('groups', () => {
  const groups = (lines: ThreadLine[], unread = 0) =>
    chatItems(lines, { t: en, now: NOW, unread }).flatMap(i =>
      i.kind === 'msg' ? [`${i.first ? '[' : ''}${i.line.id}${i.last ? ']' : ''}`] : [i.kind],
    )

  test('one sender’s messages within a few minutes share one header; a gap, another sender or this board’s own start another', () => {
    const at = (min: number) => new Date(Date.parse('2026-11-11T08:00:00Z') + min * 60_000).toISOString()
    const lines = [
      msg('a1', at(0)),
      msg('a2', at(1)),
      msg('a3', at(1 + GROUP_MS / 60_000)),
      msg('a4', at(7 + GROUP_MS / 60_000)),
      msg('b1', at(8 + GROUP_MS / 60_000), { from: BEN, who: 'ben' }),
      mine('m1', at(9 + GROUP_MS / 60_000)),
      mine('m2', at(9 + GROUP_MS / 60_000)),
    ]
    expect(groups(lines)).toEqual(['day', '[a1', 'a2', 'a3]', '[a4]', '[b1]', '[m1', 'm2]'])
  })

  test('an agent’s message is not grouped with its board’s person, nor with another session', () => {
    const lines = [
      msg('p1', '2026-11-11T08:00:00Z'),
      msg('g1', '2026-11-11T08:01:00Z', { via: 'agent', agent: 'deploy-bot' }),
      msg('g2', '2026-11-11T08:02:00Z', { via: 'agent', agent: 'deploy-bot' }),
      msg('g3', '2026-11-11T08:03:00Z', { via: 'agent', agent: 'review-bot' }),
    ]
    expect(groups(lines)).toEqual(['day', '[p1]', '[g1', 'g2]', '[g3]'])
  })

  test('the "new messages" line stands before the first unread and opens a group of its own', () => {
    const lines = [
      msg('a1', '2026-11-11T08:00:00Z'),
      mine('m1', '2026-11-11T08:01:00Z'),
      msg('a2', '2026-11-11T08:02:00Z'),
      msg('a3', '2026-11-11T08:03:00Z'),
    ]
    expect(unreadStart(lines, 2)).toBe(2)
    expect(unreadStart(lines, 0)).toBe(-1)
    // More unread than came in here: from the first that did.
    expect(unreadStart(lines, 9)).toBe(0)
    expect(groups(lines, 1)).toEqual(['day', '[a1]', '[m1]', '[a2]', 'unread', '[a3]'])
    expect(groups(lines, 2)).toEqual(['day', '[a1]', '[m1]', 'unread', '[a2', 'a3]'])
  })
})

describe('marks and quotes', () => {
  test('the agent’s mark: the session and whose board; this board’s own; a person’s message has none', () => {
    expect(agentMark(msg('g', '2026-11-11T08:00:00Z', { via: 'agent', agent: 'deploy-bot' }), en)).toEqual({
      session: 'deploy-bot',
      board: 'anna’s board',
    })
    expect(agentMark(mine('m', '2026-11-11T08:00:00Z', { via: 'agent' }), en)).toEqual({
      session: 'agent',
      board: 'your board',
    })
    expect(agentMark(msg('p', '2026-11-11T08:00:00Z'), en)).toBeNull()
    expect(agentMark(msg('g', '2026-11-11T08:00:00Z', { via: 'agent' }), ru)?.board).toBe('доска anna')
  })

  test('how far this board’s message got: a pair’s state, a team post’s slowest copy', () => {
    expect(deliveryOf(mine('m', '2026-11-11T08:00:00Z', { state: 'delivered' }))).toBe('delivered')
    const receipts = (...states: ('queued' | 'delivered' | 'acked' | 'expired')[]) =>
      mine('t', '2026-11-11T08:00:00Z', {
        state: undefined as never,
        receipts: states.map((state, i) => ({ peer: String(i), name: String(i), state })),
      })
    expect(deliveryOf(receipts('acked', 'delivered', 'acked'))).toBe('delivered')
    expect(deliveryOf(receipts('acked', 'expired', 'queued'))).toBe('expired')
    expect(deliveryOf(msg('i', '2026-11-11T08:00:00Z'))).toBeNull()
  })

  test('a quote: the answered line’s sender and one line of it; one this board does not have says so', () => {
    const lines = [
      msg('q', '2026-11-11T08:00:00Z', { text: 'which\n\nbranch   is it?' }),
      mine('m', '2026-11-11T08:01:00Z'),
      msg('h', '2026-11-11T08:02:00Z', { text: null, held: true }),
    ]
    expect(quoteOf('q', lines, en)).toEqual({ id: 'q', found: true, who: 'anna', text: 'which branch is it?' })
    expect(quoteOf('m', lines, en)).toMatchObject({ found: true, who: 'You' })
    expect(quoteOf('h', lines, en)).toMatchObject({ found: true, text: null })
    expect(quoteOf('gone', lines, en)).toEqual({ id: 'gone', found: false, who: '', text: null })
    expect(oneLine('x'.repeat(130))).toBe(`${'x'.repeat(120)}…`)
  })
})

// ---- The panel's markup (react-dom/server).

const VIEW: TeamView = {
  state: 'online',
  me: { peer: 'M'.repeat(43), fingerprint: 'aaaa', name: 'me' },
  hub: 'wss://hub.example.com',
  roster: [
    { peer: ANNA, name: 'anna', online: true, lastSeen: null, fingerprint: '1111', pin: 'trusted', drafts: 0 },
    { peer: BEN, name: 'ben', online: false, lastSeen: 1, fingerprint: '2222', pin: 'trusted', drafts: 0 },
  ],
}
const CHAT: ThreadView = {
  key: 'team/general',
  scope: 'team',
  id: 'general',
  title: null,
  link: null,
  handler: null,
  muted: false,
  by: 'me',
  createdAt: 1,
  lastAt: 1,
  peerName: null,
  last: { dir: 'in', who: 'ben', text: 'after lunch', ts: '2026-11-11T08:03:00Z' },
}
const CHAT_LINES: ThreadLine[] = [
  msg('q1', '2026-11-11T08:00:00Z', { text: 'ship today?' }),
  mine('m1', '2026-11-11T08:01:00Z', { text: 'yes', replyTo: 'q1' }),
  msg('b1', '2026-11-11T08:02:00Z', { from: BEN, who: 'ben', text: 'after lunch', replyTo: 'gone-id' }),
  msg('b2', '2026-11-11T08:03:00Z', { from: BEN, who: 'ben', text: 'deploying', via: 'agent', agent: 'deploy-bot' }),
]

function props(over: Partial<TeamBodyProps> = {}): TeamBodyProps {
  return {
    view: VIEW,
    threads: [CHAT],
    selected: 'team/general',
    thread: CHAT,
    lines: CHAT_LINES,
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
const render = (p: TeamBodyProps, lang = 'en') => renderInBoard(<TeamBody {...p} />, board({ now: NOW }), lang)

describe('the conversation', () => {
  test('which pane a narrow panel shows: the list, a thread, or People and agents', () => {
    const pane = (p: TeamBodyProps) => findAll(render(p), el => hasClass(el, 'team-body'))[0]?.attrs.get('data-pane')
    expect(pane(props())).toBe('thread')
    expect(pane(props({ selected: null }))).toBe('list')
    expect(pane(props({ selected: null, people: true }))).toBe('people')
  })

  test('the list’s row: the latest message with its sender in a team thread, and its time', () => {
    const row = findAll(render(props({ selected: null })), el => el.attrs.get('data-thread') === 'team/general')
    const part = (name: string) => text(findAll(row, el => hasClass(el, name)))
    expect(part('team-row-last')).toBe('ben: after lunch')
    expect(plain(part('team-row-when'))).toBe('8:03 AM')
  })

  test('a reply carries its quote, which points at the line answered; a quote whose line is not here is no button', () => {
    const nodes = render(props())
    const quotes = findAll(nodes, el => hasClass(el, 'team-quote'))
    expect(quotes.map(q => [q.tag, q.attrs.get('data-quote'), text([q])])).toEqual([
      ['button', 'q1', 'annaship today?'],
      ['div', 'gone-id', 'a message this board does not have'],
    ])
    // The quote sits in the reply's bubble, and the line it points at is drawn with that id.
    const reply = findAll(nodes, el => el.attrs.get('data-line') === 'm1')
    expect(findAll(reply, el => hasClass(el, 'team-quote'))).toHaveLength(1)
    expect(findAll(nodes, el => el.attrs.get('data-line') === 'q1')).toHaveLength(1)
  })

  test('names over groups in a team thread, the agent’s message outlined with its mark, each bubble with its time and full date', () => {
    const nodes = render(props())
    expect(findAll(nodes, el => hasClass(el, 'team-msg-name')).map(n => text([n]))).toEqual(['anna', 'ben', 'ben'])
    const agent = findAll(nodes, el => hasClass(el, 'team-msg') && hasClass(el, 'agent'))
    expect(agent.map(a => a.attrs.get('data-line'))).toEqual(['b2'])
    const times = findAll(nodes, el => el.tag === 'time')
    expect(times[0]?.attrs.get('datetime')).toBe('2026-11-11T08:00:00Z')
    expect(plain(times[0]?.attrs.get('title') ?? '')).toBe('Wednesday, November 11, 2026, 8:00 AM')
  })

  test('Reply on every message with text while the box may send; none on a held one, none while disabled', () => {
    const replies = (p: TeamBodyProps) =>
      findAll(render(p), el => hasClass(el, 'team-msg-reply')).map(b => b.attrs.get('aria-label'))
    expect(replies(props())).toHaveLength(4)
    expect(replies(props({ disabled: true }))).toHaveLength(0)
    const held = [...CHAT_LINES, msg('h1', '2026-11-11T08:04:00Z', { text: null, held: true })]
    expect(replies(props({ lines: held }))).toHaveLength(4)
  })

  test('a reply being written: its quote over the box, and its id is what the panel was told', () => {
    const nodes = render(props({ replyTo: 'q1' }))
    const bar = findAll(nodes, el => el.attrs.has('data-reply'))
    expect(bar.map(b => [b.attrs.get('data-reply'), text([b])])).toEqual([['q1', 'Reply to annaship today?']])
    const asked: (string | null)[] = []
    const hosts = hostsOf(<TeamBody {...props({ onReply: id => void asked.push(id) })} />)
    const reply = hosts.filter(h => h.props['aria-label'] === 'Reply')[1]
    if (typeof reply?.props.onClick !== 'function') throw new Error('no Reply')
    reply.props.onClick()
    expect(asked).toEqual(['m1'])
  })

  test('the "new messages" line before the first unread, in both languages', () => {
    const order = (p: TeamBodyProps, lang = 'en') =>
      findAll(render(p, lang), el => el.attrs.has('data-unread-line') || el.attrs.has('data-line')).map(el =>
        el.attrs.has('data-unread-line') ? text([el]) : el.attrs.get('data-line'),
      )
    expect(order(props({ unread: { 'team/general': 2 } }))).toEqual(['q1', 'm1', 'New messages', 'b1', 'b2'])
    expect(order(props({ unread: { 'team/general': 2 } }), 'ru')).toContain('Новые сообщения')
    expect(order(props())).toEqual(['q1', 'm1', 'b1', 'b2'])
  })
})

/** A view's host elements, its hooks run in a probe. */
function hostsOf(node: ReactNode): Host[] {
  let hosts: Host[] = []
  function Probe() {
    hosts = hostElements(node)
    return null
  }
  renderInBoard(<Probe />, board({ now: NOW }))
  return hosts
}

describe('the box', () => {
  const composer = (over: Partial<TeamComposerProps> = {}) => {
    const calls: string[] = []
    const p: TeamComposerProps = {
      value: 'hi',
      placeholder: 'Write to the team…',
      disabled: false,
      canSend: true,
      onChange: v => void calls.push(`change ${v}`),
      onSend: () => void calls.push('send'),
      onCancelReply: () => void calls.push('cancel'),
      ...over,
    }
    const keydown = hostsOf(<TeamComposer {...p} />).find(h => h.tag === 'textarea')?.props.onKeyDown
    if (typeof keydown !== 'function') throw new Error('no box')
    const press = (key: string, more: { shiftKey?: boolean; isComposing?: boolean } = {}) => {
      let prevented = false
      keydown({
        key,
        shiftKey: more.shiftKey ?? false,
        nativeEvent: { isComposing: more.isComposing ?? false },
        preventDefault: () => {
          prevented = true
        },
      })
      return prevented
    }
    return { calls, press }
  }

  test('Enter sends; Shift+Enter breaks the line; nothing goes while an IME composes', () => {
    const box = composer()
    expect(box.press('Enter')).toBe(true)
    expect(box.press('Enter', { shiftKey: true })).toBe(false)
    expect(box.press('Enter', { isComposing: true })).toBe(false)
    expect(box.calls).toEqual(['send'])
  })

  test('Enter with nothing to send, or while disabled, sends nothing and breaks no line', () => {
    for (const over of [{ canSend: false }, { disabled: true }]) {
      const box = composer(over)
      expect(box.press('Enter')).toBe(true)
      expect(box.calls).toEqual([])
    }
  })

  test('Esc lets go of a reply; without one it does nothing', () => {
    const reply = { id: 'q1', found: true, who: 'anna', text: 'ship today?' }
    const box = composer({ reply })
    expect(box.press('Escape')).toBe(true)
    expect(box.calls).toEqual(['cancel'])
    const bare = composer()
    expect(bare.press('Escape')).toBe(false)
    expect(bare.calls).toEqual([])
  })

  test('the slots for #371: what goes with the message over the box, more buttons beside Send', () => {
    const nodes = renderInBoard(
      <TeamComposer
        value=""
        placeholder="x"
        disabled={false}
        canSend
        onChange={() => {}}
        onSend={() => {}}
        attachments={<span data-file>report.pdf</span>}
        actions={<button type="button" data-attach />}
      />,
      board(),
    )
    const box = findAll(nodes, el => el.attrs.has('data-composer'))
    expect(findAll(box, el => hasClass(el, 'team-compose-attachments')).map(a => text([a]))).toEqual(['report.pdf'])
    const row = findAll(box, el => hasClass(el, 'team-compose-row'))[0] as Node & { kind: 'element' }
    expect(row.children.map(c => (c.kind === 'element' ? (c.attrs.get('class') ?? c.tag) : 'text'))).toEqual([
      'team-compose-actions',
      'textarea',
      'team-send',
    ])
    // Send is on while the parent says so: files alone may turn it on.
    expect(findAll(box, el => el.attrs.has('data-send'))[0]?.attrs.has('disabled')).toBe(false)
  })
})

describe('a phone’s width (styles/team.css)', () => {
  const css = readFileSync(join(import.meta.dir, '../../web/styles/team.css'), 'utf8')
  const block = (head: string): string => {
    const at = css.indexOf(head)
    if (at < 0) return ''
    let depth = 0
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++
      if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1)
    }
    return ''
  }
  const wide = block('@container sheet (min-width: 720px) {')

  test('narrow, one pane at a time; from 720 px of panel, the list beside the conversation', () => {
    expect(css).toContain(
      '.team-body[data-pane="list"] > .team-main, .team-body:not([data-pane="list"]) > .team-side { display: none; }',
    )
    expect(wide).toContain('grid-template-columns: minmax(240px, 300px) minmax(0, 1fr)')
    expect(wide).toContain('.team-body[data-pane] > .team-side, .team-body[data-pane] > .team-main { display: flex; }')
    // The back button is the narrow panel's.
    expect(wide).toContain('.team-back')
  })

  test('nothing is laid out wider than a phone: no fixed width past 64 px outside the wide panel, long text and code wrap or scroll', () => {
    const rest = css.replace(wide, '')
    // Declarations only: a container query's own condition is no width.
    const widths = [...rest.matchAll(/[{;]\s*(?:min-)?width:\s*(\d+)px/g)].map(m => Number(m[1]))
    expect(widths.filter(w => w > 64)).toEqual([])
    expect(css).toMatch(/\.team-bubble \{[^}]*overflow-wrap: anywhere/)
    expect(css).toContain('.team-bubble .md pre { max-width: 100%; overflow-x: auto; }')
    expect(block('@container sheet (max-width: 480px) {')).toContain('.team-msg-row { max-width: 92%; }')
  })
})

// ---- In a page whose effects run (react-dom in support/mini-dom.ts): the scrolling and the drafts.

type Mini = typeof import('./support/mini-dom.ts')
let mini: Mini
let dom: ReturnType<Mini['miniWindow']>
let flush: (fn: () => void) => void
let mount: () => { draw(node: ReactNode): void; unmount(): void }
const saved: Partial<Mini['layout']> = {}

beforeAll(async () => {
  mini = await import('./support/mini-dom.ts')
  Object.assign(saved, mini.layout)
  dom = mini.miniWindow(800)
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const { I18nProvider } = await import('../../web/src/i18n/I18nProvider.tsx')
  const { BoardContext } = await import('../../web/src/state/BoardProvider.tsx')
  flush = flushSync
  mount = () => {
    const container = dom.document.body.appendChild(dom.document.createElement('div'))
    const root = createRoot(container as unknown as HTMLElement)
    return {
      draw: node =>
        flushSync(() =>
          root.render(
            <I18nProvider lang="en">
              <BoardContext.Provider value={board({ now: NOW })}>{node}</BoardContext.Provider>
            </I18nProvider>,
          ),
        ),
      unmount: () => {
        flushSync(() => root.unmount())
        dom.document.body.removeChild(container)
      },
    }
  }
})

afterAll(() => {
  Object.assign(mini.layout, saved)
  dom.uninstall()
})

describe('scrolling', () => {
  const all = (selector: string) => dom.document.body.querySelectorAll(selector)
  const scroller = () => all('div').find(d => d.className === 'team-scroll')
  const button = (name: string) => all('button').find(b => b.className.split(' ').includes(name))
  /** A conversation `height` px tall in a 400 px window, the "new messages" line 900 px down. */
  function sized(height = 2000) {
    mini.layout.scrollHeight = el => (el.className === 'team-scroll' ? height : 0)
    mini.layout.clientHeight = el => (el.className === 'team-scroll' ? 400 : 0)
    mini.layout.offsetTop = el => (el.hasAttribute('data-unread-line') ? 900 : 0)
  }
  /** The reader scrolls: a scroll is a continuous event, its update lands a moment later. */
  const scrollTo = async (top: number) => {
    const el = scroller()
    if (!el) throw new Error('no scroller')
    el.scrollTop = top
    el.dispatchEvent(new mini.MiniEvent('scroll', false))
    await new Promise(done => setTimeout(done, 20))
  }

  test('the thread opens at the "new messages" line, clear of the day’s pill; the line stays while the count drops', () => {
    const page = mount()
    sized()
    page.draw(<TeamBody {...props({ unread: { 'team/general': 2 } })} />)
    expect(scroller()?.scrollTop).toBe(900 - 44)
    // Read: the count is gone, the line is where it was.
    page.draw(<TeamBody {...props({ unread: {} })} />)
    expect(all('[data-unread-line]')).toHaveLength(1)
    // Another thread, then back: nothing is new any more.
    page.draw(<TeamBody {...props({ selected: null, unread: {} })} />)
    page.draw(<TeamBody {...props({ unread: {} })} />)
    expect(all('[data-unread-line]')).toHaveLength(0)
    page.unmount()
  })

  test('with nothing unread it opens at the end and follows a new message there; scrolled up, it counts them on the jump', async () => {
    const page = mount()
    sized()
    page.draw(<TeamBody {...props()} />)
    expect(scroller()?.scrollTop).toBe(2000)
    expect(button('team-jump')).toBeUndefined()
    sized(2100)
    const one = [...CHAT_LINES, msg('n1', '2026-11-11T08:05:00Z')]
    page.draw(<TeamBody {...props({ lines: one })} />)
    expect(scroller()?.scrollTop).toBe(2100)
    // Up the thread: the jump shows, and what comes in is counted on it, not scrolled to.
    await scrollTo(100)
    expect(button('team-jump')).toBeDefined()
    sized(2200)
    page.draw(<TeamBody {...props({ lines: [...one, msg('n2', '2026-11-11T08:06:00Z')] })} />)
    expect(scroller()?.scrollTop).toBe(100)
    expect(button('team-jump')?.textContent).toBe('1')
    flush(() => button('team-jump')?.dispatchEvent(new mini.MiniEvent('click')))
    expect(scroller()?.scrollTop).toBe(2200)
    page.unmount()
  })

  test('a click on a quote brings the message answered into view and lights it', () => {
    const page = mount()
    sized()
    page.draw(<TeamBody {...props()} />)
    const seen: string[] = []
    mini.layout.intoView = el => void seen.push(el.getAttribute('data-line') ?? '')
    flush(() => button('team-quote')?.dispatchEvent(new mini.MiniEvent('click')))
    expect(seen).toEqual(['q1'])
    const q1 = all('[data-line]').find(d => d.getAttribute('data-line') === 'q1')
    expect(q1?.className.split(' ')).toContain('flash')
    page.unmount()
  })
})

describe('the draft, per thread', () => {
  test('each thread keeps its own text and reply while another is on show; a send clears only its own', async () => {
    const { useThreadDrafts } = await import('../../web/src/components/team/TeamPanel.tsx')
    let drafts: ReturnType<typeof useThreadDrafts> | null = null
    function Probe() {
      drafts = useThreadDrafts()
      return null
    }
    const page = mount()
    page.draw(<Probe />)
    const d = () => drafts as unknown as ReturnType<typeof useThreadDrafts>
    flush(() => d().setText('team/general', 'half a thought'))
    flush(() => d().setReply('team/general', 'q1'))
    flush(() => d().setText(`${ANNA}/general`, 'for anna'))
    expect([d().text('team/general'), d().replyTo('team/general')]).toEqual(['half a thought', 'q1'])
    expect([d().text(`${ANNA}/general`), d().replyTo(`${ANNA}/general`)]).toEqual(['for anna', null])
    expect(d().text(`${BEN}/general`)).toBe('')
    flush(() => d().setReply('team/general', null))
    expect([d().text('team/general'), d().replyTo('team/general')]).toEqual(['half a thought', null])
    flush(() => d().clear('team/general'))
    expect([d().text('team/general'), d().text(`${ANNA}/general`)]).toEqual(['', 'for anna'])
    page.unmount()
  })
})
