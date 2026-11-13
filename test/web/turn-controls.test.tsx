// Stop on a working card and as the sheet's send button (#330, #340), Send now on a queued message
// (#330): where they show, where they do not, the guard against a mistaken press, and the calm step
// from queued to sent.
import { describe, expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { QueuedPrompt } from '../../src/core/queue.ts'
import type { Item, Lang } from '../../src/core/types.ts'
import { Board } from '../../web/src/components/Board.tsx'
import { Composer } from '../../web/src/components/sheet/Composer.tsx'
import { SheetHead } from '../../web/src/components/sheet/SheetHead.tsx'
import { Waiting } from '../../web/src/components/sheet/Thread.tsx'
import { NO_OUTBOX } from '../../web/src/hooks/useComposer.ts'
import { type Attachment, sendIsStop } from '../../web/src/models/composer.ts'
import type { OutboxEntry } from '../../web/src/models/composer-session.ts'
import { noteQueue, SETTLE_WINDOW_MS, takeSettling } from '../../web/src/models/settle.ts'
import { NO_HEAD_BUTTONS, sheetAvailability } from '../../web/src/models/sheet.ts'
import { ARM_MS, pressComposerStop, pressStop, SETTLE_MS } from '../../web/src/models/stop-guard.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { CATEGORIES } from './support/board-scene.tsx'
import { type Element, find, findAll, hasClass, type Node } from './support/markup.ts'
import { composerOf } from './support/sheet-scene.tsx'

const working = (fields: Partial<Item> & Pick<Item, 'key'>): Item =>
  item({ agent: 'claude', status: 'working', column: 'work', name: fields.key, ...fields })

const stopsIn = (nodes: Node[]): Element[] => findAll(nodes, el => el.attrs.get('data-act') === 'stop')
const cardOf = (nodes: Node[], key: string): Node[] => [
  find(nodes, el => el.tag === 'article' && el.attrs.get('data-key') === key),
]
const textOf = (node: Node): string => ('text' in node ? node.text : node.children.map(textOf).join(''))

function boardWith(items: Item[], lang: Lang = 'en', stale = false) {
  return renderInBoard(<Board />, board({ data: payload({ items, lang, stale, categories: CATEGORIES }) }), lang)
}

describe('Stop on the card', () => {
  test('on a working Claude card, and on none where the board cannot stop it', () => {
    const items = [
      working({ key: 'claude' }),
      working({ key: 'pi', agent: 'pi' }),
      working({ key: 'codex', agent: 'codex' }),
      (({ agent: _a, ...rest }: Item) => rest)(working({ key: 'unknown' })),
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

describe('Stop in the sheet: the send button while the turn runs and the box is empty (#340)', () => {
  const head = (it: Item, lang: Lang = 'en') =>
    renderInBoard(<SheetHead item={it} missing={false} />, board({ data: payload({ items: [it], lang }) }), lang)

  /** The message box of `it`'s sheet: its send button, as the composer draws it. */
  function sendOf(
    it: Item,
    {
      message = '',
      lang = 'en' as Lang,
      sending = false,
      stale = false,
      files = [] as Attachment[],
      busy = false,
      outbox = [] as OutboxEntry[],
    } = {},
  ): Element {
    const value = board({
      data: payload({ items: [it], lang, stale, categories: CATEGORIES }),
      ui: { open: it.key, ...(busy && { busy: new Map([[it.key, 'Stopping…']]) }) },
    })
    const av = sheetAvailability(
      { canMutate: value.canMutate, canEdit: true, missing: false, turn: it.status === 'working' },
      translator(lang),
    )
    const nodes = renderInBoard(
      <Composer
        composer={{
          ...composerOf({ message, attachments: files, open: it.key, sending: sending ? [it.key] : [] }),
          outbox: { ...NO_OUTBOX, waiting: key => (key === it.key ? outbox : []) },
        }}
        item={it}
        availability={av}
        buttons={NO_HEAD_BUTTONS}
        changesHidden
        present
        canMutate={value.canMutate}
      />,
      value,
      lang,
    )
    return find(nodes, el => el.tag === 'button' && hasClass(el, 'send'))
  }
  const isStop = (el: Element) => hasClass(el, 'stop')

  test('the Stop pill at the top of the sheet is gone', () => {
    for (const it of [
      working({ key: 'a' }),
      working({ key: 'pi', agent: 'pi' }),
      item({ key: 'idle', agent: 'claude' }),
    ])
      expect([it.key, stopsIn(head(it)).length]).toEqual([it.key, 0])
  })

  test('a working Claude session with an empty box: Stop, a button that does not submit', () => {
    const stop = sendOf(working({ key: 'a' }))
    expect(isStop(stop)).toBe(true)
    expect(stop.attrs.get('type')).toBe('button')
    expect(stop.attrs.get('aria-label')).toBe('Stop')
    expect(stop.attrs.get('title')).toBe(
      'Stop this turn, as Esc does in the terminal: the session and its conversation stay',
    )
    expect(stop.attrs.has('disabled')).toBe(false)
  })

  test('typed text or a file in the box, a message on its way, or the turn over: Send', () => {
    const it = working({ key: 'a' })
    const file = { id: 1, name: 'a.txt', size: 1, image: false, url: '', status: 'done', path: 'p' } as Attachment
    for (const [why, el] of [
      ['typed', sendOf(it, { message: 'one more thing' })],
      ['a space', sendOf(it, { message: ' ' })],
      ['a file', sendOf(it, { files: [file] })],
      ['sending', sendOf(it, { sending: true })],
      ['idle', sendOf(item({ key: 'idle', agent: 'claude', status: 'idle', column: 'idle' }))],
      ['done', sendOf(item({ key: 'done', agent: 'claude', status: 'done', column: 'done' }))],
      ['blocked', sendOf(item({ key: 'blocked', agent: 'claude', status: 'blocked', column: 'me' }))],
    ] as const) {
      expect([why, isStop(el), el.attrs.get('type'), el.attrs.get('aria-label')]).toEqual([
        why,
        false,
        'submit',
        'Send',
      ])
    }
    // Typed into a working session: Send sends (into its queue), as it always did.
    expect(sendOf(it, { message: 'one more thing' }).attrs.has('disabled')).toBe(false)
    expect(sendOf(it, { files: [file] }).attrs.has('disabled')).toBe(false)
    // An idle session's empty box: Send waits for text, as it always did.
    expect(sendOf(item({ key: 'idle', agent: 'claude', status: 'idle', column: 'idle' })).attrs.has('disabled')).toBe(
      true,
    )
  })

  test("#336's rules for where Stop exists: none for pi, Codex, an unknown program, no pane or a sleeper", () => {
    const none = [
      working({ key: 'pi', agent: 'pi' }),
      working({ key: 'codex', agent: 'codex' }),
      (({ agent: _a, ...rest }: Item) => rest)(working({ key: 'unknown' })),
      working({ key: 'call', pane: null }),
      working({ key: 'day', pane: null, day: true }),
      working({ key: 'asleep', sleeping: true, status: 'sleeping', column: 'idle' }),
    ]
    for (const it of none) {
      const send = sendOf(it)
      expect([it.key, isStop(send), send.attrs.get('type')]).toEqual([it.key, false, 'submit'])
    }
  })

  test('a board that cannot reach herdr shows Stop, disabled, as the card does', () => {
    const stop = sendOf(working({ key: 'a' }), { stale: true })
    expect(isStop(stop)).toBe(true)
    expect(stop.attrs.has('disabled')).toBe(true)
  })

  test('a stop on its way: Stop stays, disabled, so a second press is no second Esc', () => {
    const stop = sendOf(working({ key: 'a' }), { busy: true })
    expect(isStop(stop)).toBe(true)
    expect(stop.attrs.has('disabled')).toBe(true)
  })

  test('a message that did not go: the arrow stays, dead, so pressing it again stops nothing', () => {
    const entry = (state: OutboxEntry['state']): OutboxEntry => ({
      id: 'd1',
      text: 'hi',
      files: [],
      attached: [],
      full: 'hi',
      key: 'hi',
      after: 0,
      state,
      error: '',
      sentAt: 0,
    })
    const failed = sendOf(working({ key: 'a' }), { outbox: [entry('failed')] })
    expect([isStop(failed), failed.attrs.get('type'), failed.attrs.has('disabled')]).toEqual([false, 'submit', true])
    // One that went (taken, not in the transcript yet) is no reason to hold Stop back.
    expect(isStop(sendOf(working({ key: 'a' }), { outbox: [entry('sent')] }))).toBe(true)
  })

  test('in Russian', () => {
    const stop = sendOf(working({ key: 'a' }), { lang: 'ru' })
    expect(stop.attrs.get('aria-label')).toBe('Стоп')
    expect(stop.attrs.get('title')).toBe('Остановить этот ход, как Esc в терминале: сессия и её переписка остаются')
    const send = sendOf(working({ key: 'a' }), { lang: 'ru', message: 'ещё' })
    expect([isStop(send), send.attrs.get('type')]).toEqual([false, 'submit'])
  })

  test('the model: Stop only while the turn runs, the box is empty and no press on it can mean "send"', () => {
    const scene = {
      present: true,
      sending: false,
      text: '',
      attachments: [],
      stoppable: true,
      aside: false,
      unsent: false,
    }
    expect(sendIsStop(scene)).toBe(true)
    expect(sendIsStop({ ...scene, stoppable: false })).toBe(false)
    expect(sendIsStop({ ...scene, present: false })).toBe(false)
    expect(sendIsStop({ ...scene, sending: true })).toBe(false)
    expect(sendIsStop({ ...scene, text: 'x' })).toBe(false)
    expect(sendIsStop({ ...scene, aside: true })).toBe(false)
    expect(sendIsStop({ ...scene, unsent: true })).toBe(false)
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

describe("the message box's Stop: one press, not the gesture that sent", () => {
  test('one press stops, once it has been Stop a moment', () => {
    expect(pressComposerStop(1000, 1000 + SETTLE_MS)).toBe(true)
    expect(pressComposerStop(1000, 1000 + 60_000)).toBe(true)
    // The keyboard (detail 0) counts as a press.
    expect(pressComposerStop(1000, 1000 + SETTLE_MS, 0)).toBe(true)
  })

  test('the second click of a double click on Send, or a press right as Send turned into Stop, stops nothing', () => {
    expect(pressComposerStop(1000, 1000 + 60_000, 2)).toBe(false)
    expect(pressComposerStop(1000, 1000 + SETTLE_MS - 1)).toBe(false)
  })
})

describe('Send now on a queued message', () => {
  const queued: QueuedPrompt[] = [
    { text: 'also check the logs', at: 1000 },
    { text: 'and the tests', at: 2000 },
  ]
  const out = (id: string, text: string, state: OutboxEntry['state'], error = ''): OutboxEntry => ({
    id,
    text,
    files: [],
    attached: [],
    full: text,
    key: text,
    after: 0,
    state,
    error,
    sentAt: 0,
  })
  const own = [out('o1', 'mine', 'sending'), out('o2', 'lost', 'failed', 'no')]
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
    expect(
      findAll(nodes, el => hasClass(el, 'when'))
        .map(textOf)
        .slice(0, 2),
    ).toEqual(['Queued', 'Queued'])
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

  test("not one that shows much later, nor another session's", () => {
    noteQueue('s2', ['late'], 0)
    noteQueue('s2', [], 0)
    expect(takeSettling('late', SETTLE_WINDOW_MS + 1)).toBe(false)
    noteQueue('s3', ['other'], 0)
    expect(takeSettling('other', 0)).toBe(false)
  })
})
