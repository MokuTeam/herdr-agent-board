// Stop on a working card and in its sheet, Send now on a queued message (#330): where they show,
// where they do not, the guard against a mistaken press, and the calm step from queued to sent.
import { describe, expect, test } from 'bun:test'
import type { QueuedPrompt } from '../../src/core/queue.ts'
import type { Item } from '../../src/core/types.ts'
import { Board } from '../../web/src/components/Board.tsx'
import { SheetHead } from '../../web/src/components/sheet/SheetHead.tsx'
import { Waiting } from '../../web/src/components/sheet/Thread.tsx'
import type { OutboxEntry } from '../../web/src/models/composer-session.ts'
import { noteQueue, SETTLE_WINDOW_MS, takeSettling } from '../../web/src/models/settle.ts'
import { ARM_MS, pressStop, SETTLE_MS } from '../../web/src/models/stop-guard.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { CATEGORIES } from './support/board-scene.tsx'
import { type Element, find, findAll, hasClass, type Node } from './support/markup.ts'

const working = (fields: Partial<Item> & Pick<Item, 'key'>): Item =>
  item({ agent: 'claude', status: 'working', column: 'work', name: fields.key, ...fields })

const stopsIn = (nodes: Node[]): Element[] => findAll(nodes, el => el.attrs.get('data-act') === 'stop')
const cardOf = (nodes: Node[], key: string): Node[] => [
  find(nodes, el => el.tag === 'article' && el.attrs.get('data-key') === key),
]
const textOf = (node: Node): string => ('text' in node ? node.text : node.children.map(textOf).join(''))

function boardWith(items: Item[], lang = 'en', stale = false) {
  return renderInBoard(<Board />, board({ data: payload({ items, lang, stale, categories: CATEGORIES }) }), lang)
}

describe('Stop on the card', () => {
  test('on a working Claude card, and on none where the board cannot stop it', () => {
    const items = [
      working({ key: 'claude' }),
      working({ key: 'pi', agent: 'pi' }),
      working({ key: 'codex', agent: 'codex' }),
      working({ key: 'unknown', agent: undefined }),
      // A MokuPilot call agent (#326) and a day session (#331): no pane.
      working({ key: 'call', pane: null }),
      working({ key: 'day', pane: null, day: true }),
      working({ key: 'asleep', sleeping: true, status: 'sleeping', column: 'idle' }),
      item({ key: 'idle', agent: 'claude', status: 'idle', column: 'idle' }),
      item({ key: 'done', agent: 'claude', status: 'done', column: 'done' }),
      item({ key: 'blocked', agent: 'claude', status: 'blocked', column: 'me' }),
    ]
    const nodes = boardWith(items)
    const shown = items.filter(it => stopsIn(cardOf(nodes, it.key)).length > 0).map(it => it.key)
    expect(shown).toEqual(['claude'])
    const stop = stopsIn(cardOf(nodes, 'claude'))[0] as Element
    expect(stop.attrs.get('title')).toBe(
      'Stop this turn, as Esc does in the terminal: the session and its conversation stay',
    )
    expect(stop.attrs.get('aria-label')).toBe('Stop')
    // Not armed yet: a glyph only, no words, nothing red.
    expect(hasClass(stop, 'armed')).toBe(false)
    expect(textOf(stop)).toBe('')
  })

  test('in Russian', () => {
    const stop = stopsIn(boardWith([working({ key: 'a' })], 'ru'))[0] as Element
    expect(stop.attrs.get('aria-label')).toBe('Стоп')
    expect(stop.attrs.get('title')).toBe('Остановить этот ход, как Esc в терминале: сессия и её переписка остаются')
  })

  test('a board that cannot reach herdr shows it, disabled', () => {
    const nodes = boardWith([working({ key: 'a' })], 'en', true)
    expect(stopsIn(nodes)[0]?.attrs.has('disabled')).toBe(true)
  })
})

describe('Stop in the sheet', () => {
  const head = (it: Item, lang = 'en') =>
    renderInBoard(<SheetHead item={it} />, board({ data: payload({ items: [it], lang }) }), lang)

  test('beside the status, with its word, only where the card has it', () => {
    const stop = stopsIn(head(working({ key: 'a' })))[0] as Element
    expect(hasClass(stop, 'labeled')).toBe(true)
    expect(textOf(stop)).toBe('Stop')
    expect(textOf(stopsIn(head(working({ key: 'a' }), 'ru'))[0] as Element)).toBe('Стоп')
    for (const it of [
      working({ key: 'pi', agent: 'pi' }),
      working({ key: 'call', pane: null }),
      item({ key: 'idle', agent: 'claude' }),
    ])
      expect([it.key, stopsIn(head(it)).length]).toEqual([it.key, 0])
  })
})

describe('the guard against a mistaken press', () => {
  test('the first press arms, a second one a moment later stops', () => {
    expect(pressStop(null, 1000)).toBe('arm')
    expect(pressStop(1000, 1000 + SETTLE_MS)).toBe('fire')
    expect(pressStop(1000, 1000 + ARM_MS - 1)).toBe('fire')
  })

  test('a double click, or a second press too soon, does not stop', () => {
    expect(pressStop(null, 1000, 2)).toBe('ignore')
    expect(pressStop(1000, 1100, 2)).toBe('ignore')
    expect(pressStop(1000, 1000 + SETTLE_MS - 1)).toBe('ignore')
  })

  test('armed too long ago: a press arms it afresh; the keyboard counts as a press', () => {
    expect(pressStop(1000, 1000 + ARM_MS)).toBe('arm')
    expect(pressStop(null, 1000, 0)).toBe('arm')
    expect(pressStop(1000, 1000 + SETTLE_MS, 0)).toBe('fire')
  })
})

describe('Send now on a queued message', () => {
  const queued: QueuedPrompt[] = [
    { text: 'also check the logs', at: 1000 },
    { text: 'and the tests', at: 2000 },
  ]
  const own: OutboxEntry[] = [
    { id: 'o1', key: 'a', session: 'a', text: 'mine', full: 'mine', files: [], at: 3000, state: 'sending' },
    { id: 'o2', key: 'a', session: 'a', text: 'lost', full: 'lost', files: [], at: 4000, state: 'failed', error: 'no' },
  ] as OutboxEntry[]
  const sendNow = async () => ({ ok: true })
  const foot = (onSendNow?: typeof sendNow, lang = 'en') =>
    renderInBoard(<Waiting queued={queued} own={own} onSendNow={onSendNow} />, board(), lang)
  const buttons = (nodes: Node[]) => findAll(nodes, el => hasClass(el, 'send-now'))

  test('part of each queued message, beside its "Queued" mark', () => {
    const nodes = foot(sendNow)
    const bubbles = findAll(nodes, el => hasClass(el, 'waiting'))
    expect(bubbles).toHaveLength(4)
    for (const bubble of bubbles.slice(0, 2)) {
      const when = find([bubble], el => hasClass(el, 'when'))
      expect(textOf(when)).toBe('QueuedSend now')
      expect(buttons([when])[0]?.attrs.get('title')).toBe(
        'Into the running turn at once, with every message waiting in the queue (Ctrl+Enter in the terminal)',
      )
    }
    // Not on the board's own messages on their way or not sent: they are not in the queue.
    expect(bubbles.slice(2).flatMap(b => buttons([b]))).toEqual([])
    expect(buttons(nodes)).toHaveLength(2)
  })

  test('none while the board cannot send it now (an idle session, an unknown program): still "Queued"', () => {
    const nodes = foot(undefined)
    expect(buttons(nodes)).toEqual([])
    expect(findAll(nodes, el => hasClass(el, 'when')).map(textOf).slice(0, 2)).toEqual(['Queued', 'Queued'])
  })

  test('in Russian', () => {
    const when = find(foot(sendNow, 'ru'), el => hasClass(el, 'when'))
    expect(textOf(when)).toBe('В очередиОтправить сейчас')
  })
})

describe('from queued to sent', () => {
  test('a message that left the queue settles once, as its bubble first shows', () => {
    noteQueue('s1', ['first', 'second'], 0)
    noteQueue('s1', ['second'], 100)
    expect(takeSettling('second', 200)).toBe(false)
    expect(takeSettling('first', 200)).toBe(true)
    expect(takeSettling('first', 300)).toBe(false)
  })

  test('not one that shows much later, nor another session\'s', () => {
    noteQueue('s2', ['late'], 0)
    noteQueue('s2', [], 0)
    expect(takeSettling('late', SETTLE_WINDOW_MS + 1)).toBe(false)
    noteQueue('s3', ['other'], 0)
    expect(takeSettling('other', 0)).toBe(false)
  })
})
