// Decisions on the board's page (#487): the toolbar's pill only while the payload carries them (its
// count, and a dot for what went by default unseen), More's entry, a card's options with the
// recommended one marked and its default with Hold (a card without a decision drawn exactly as
// before), the panel's lines, and the words for a span and for who closed a question.
import { expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DecisionsPayload } from '../../src/core/decisions.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import { Card } from '../../web/src/components/Card.tsx'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { askedText, closedBy, defaultText, spanText } from '../../web/src/models/decisions.ts'
import { TOOLBAR_PRIORITY } from '../../web/src/models/toolbar-fit.ts'
import { toolbarEntries } from '../../web/src/models/toolbar-menu.ts'
import { type Board, BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { board, item, payload } from './support/board.tsx'

const NOW = Date.parse('2026-11-21T10:00:00Z')
const t = translator('en')

const render = (node: ReactNode, value: Board): string =>
  renderToStaticMarkup(
    <I18nProvider lang="en">
      <BoardContext.Provider value={value}>{node}</BoardContext.Provider>
    </I18nProvider>,
  )

const card = (fields: Parameters<typeof item>[0]) => (
  <Card
    item={item(fields)}
    selected={false}
    busy={undefined}
    placeholder={false}
    launch={undefined}
    onPointerDown={() => {}}
    onClick={() => {}}
    onKeyDown={() => {}}
  />
)

const queue = (over: Partial<DecisionsPayload> = {}): DecisionsPayload => ({
  items: [
    {
      key: 'anna',
      id: 'd1',
      who: 'anna',
      question: 'Merge now?',
      options: ['Merge now', 'Wait'],
      recommend: 1,
      askedAt: NOW - 5 * 60_000,
      defaultAt: NOW + 72 * 60_000,
      held: false,
    },
  ],
  defaulted: [],
  defaults: true,
  ...over,
})

test('the words: a span, the default line, the wait, who closed it', () => {
  expect(spanText(72 * 60_000, t)).toBe('1 h 12 min')
  expect(spanText(45 * 60_000, t)).toBe('45 min')
  expect(spanText(2 * 3_600_000, t)).toBe('2 h')
  expect(defaultText({ defaultAt: NOW + 72 * 60_000 }, NOW, t)).toBe('default in 1 h 12 min')
  expect(defaultText({ defaultAt: NOW - 1 }, NOW, t)).toBe('default any moment')
  expect(defaultText({ held: NOW }, NOW, t)).toBe('held, no default')
  expect(defaultText({}, NOW, t)).toBe('')
  expect(askedText(NOW - 10_000, NOW, t)).toBe('asked just now')
  expect(askedText(NOW - 5 * 60_000, NOW, t)).toBe('asked 5 min ago')
  expect(closedBy({ answeredBy: 'owner', via: 'button' }, t)).toBe('you, by button')
  expect(closedBy({ answeredBy: 'owner', via: 'prompt' }, t)).toBe('you')
  expect(closedBy({ answeredBy: 'default', via: 'default' }, t)).toBe('by default')
  expect(closedBy({ answeredBy: 'withdrawn', via: 'cleared' }, t)).toBe('withdrawn')
})

test('the toolbar: a Decisions pill only while the payload carries them; its count, and a dot for a default unseen', () => {
  const toolbar = (data: BoardPayload, on: boolean) =>
    render(<Toolbar limitsAnchor={createRef<HTMLButtonElement>()} {...(on && { onDecisions() {} })} />, board({ data }))
  expect(toolbar(payload(), false)).not.toContain('decisions-open')
  const on = toolbar(payload({ decisions: queue() }), true)
  expect(on).toContain('class="pill-toggle icon-only unread" id="decisions-open"')
  expect(on).toMatch(/id="decisions-open"[^>]*>.*?<span>Decisions<\/span><span class="n">1<\/span><\/button>/)
  const went = toolbar(
    payload({
      decisions: queue({
        items: [],
        defaulted: [{ id: 'd0', key: 'ben', who: 'ben', question: 'q', answer: 'yes', at: NOW }],
      }),
    }),
    true,
  )
  expect(went).toContain('class="n went"')
  expect(went).toContain('title="Something went by default since you last looked"')
  const quiet = toolbar(payload({ decisions: queue({ items: [] }) }), true)
  expect(quiet).toContain('class="pill-toggle icon-only" id="decisions-open"')
})

test('More lists the pill: its count, a dot for what waits or went by default', () => {
  const base = { canMutate: true, schedule: { count: 0, due: false }, tasks: null, next: 0, usage: '', presence: null }
  const entry = (decisions: { waiting: number; defaulted: number } | null) =>
    toolbarEntries({ ...base, decisions }, t).find(e => e.id === 'decisions-open')
  expect(entry(null)).toEqual({ id: 'decisions-open', label: 'Decisions' })
  expect(entry({ waiting: 2, defaulted: 0 })).toEqual({
    id: 'decisions-open',
    label: 'Decisions',
    count: 2,
    alert: true,
  })
  expect(entry({ waiting: 0, defaulted: 1 })?.hint).toBe('Something went by default since you last looked')
  expect(TOOLBAR_PRIORITY.indexOf('decisions-open')).toBe(TOOLBAR_PRIORITY.indexOf('threads-open') + 1)
})

test('a card: the options under its ask, the recommended one marked, the default with Hold; none without a decision', () => {
  const value = board({ data: payload({ decisions: queue() }), now: NOW })
  const asks = { key: 'anna', column: 'me' as const, attention: 'ask' as const, question: 'Merge now?' }
  const plain = render(card(asks), value)
  expect(plain).not.toContain('dec-')
  const shown = render(
    card({
      ...asks,
      decision: { id: 'd1', options: ['Merge now', 'Wait'], recommend: 1, defaultAt: NOW + 72 * 60_000 },
    }),
    value,
  )
  // The card's own lines are as before; the options come right under its ask.
  const choice =
    /<div class="dec-choice in-card"><div class="dec-options">.*?<\/div><div class="dec-default">.*?<\/div><\/div>/
  expect(shown.replace(choice, '')).toBe(plain)
  expect(shown).toMatch(/<div class="ask">.*?<\/div><div class="dec-choice in-card">/)
  const options = [...shown.matchAll(/class="mini dec-option( recommended)?"[^>]*><span>([^<]+)<\/span>/g)].map(m => [
    m[2],
    !!m[1],
  ])
  expect(options).toEqual([
    ['Merge now', true],
    ['Wait', false],
  ])
  expect(shown).toContain('default in 1 h 12 min')
  expect(shown).toContain('>Hold</button>')
  const held = render(card({ ...asks, decision: { id: 'd1', options: ['a', 'b'], held: NOW } }), value)
  expect(held).toContain('held, no default')
  expect(held).not.toContain('>Hold</button>')
})
