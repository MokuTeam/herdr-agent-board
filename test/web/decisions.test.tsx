// Decisions on the board's page (#487): the toolbar's pill only while the payload carries them (its
// count, and a dot for what went by default unseen), More's entry, a card's options with the
// recommended one marked and its default with Hold (a card without a decision drawn exactly as
// before), the panel's block of what went by default above the queue and how far it marks it seen,
// and the words for a span and for who closed a question. The panel's look was checked on a sandbox
// board (#487's pull request).
import { expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { DecisionsPayload } from '../../src/core/decisions.ts'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import { ApiError } from '../../web/src/api/client.ts'
import { Card } from '../../web/src/components/Card.tsx'
import { DecisionsPanel } from '../../web/src/components/decisions/DecisionsPanel.tsx'
import { NavRail } from '../../web/src/components/NavRail.tsx'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import { type DecisionsUi, decisionsActions } from '../../web/src/hooks/useDecisions.ts'
import { I18nProvider } from '../../web/src/i18n/I18nProvider.tsx'
import { askedText, closedBy, defaultText, seenUpTo, spanText } from '../../web/src/models/decisions.ts'
import { TOOLBAR_PRIORITY } from '../../web/src/models/toolbar-fit.ts'
import { toolbarEntries } from '../../web/src/models/toolbar-menu.ts'
import { type Board, BoardContext } from '../../web/src/state/BoardProvider.tsx'
import { PanelProvider } from '../../web/src/state/PanelProvider.tsx'
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

test('the rail: a Decisions item only while the payload carries them; its count, and an alert dot for a default unseen', () => {
  const noop = () => {}
  const rail = (data: BoardPayload, on: boolean) =>
    render(
      <NavRail
        expanded
        onToggleExpand={noop}
        drawerOpen={false}
        onCloseDrawer={noop}
        activePlace="board"
        onBoard={noop}
        onSchedule={noop}
        onCategories={noop}
        onArchive={noop}
        onSettings={noop}
        {...(on && { onDecisions: noop })}
      />,
      board({ data }),
    )
  expect(rail(payload(), false)).not.toContain('decisions-open')
  const on = rail(payload({ decisions: queue() }), true)
  expect(on).toContain('id="decisions-open" class="rail-item alert"')
  expect(on).toMatch(
    /id="decisions-open"[^>]*>.*?<span class="rail-label">Decisions<\/span><span class="rail-count warn">1<\/span>/,
  )
  const went = rail(
    payload({
      decisions: queue({
        items: [],
        defaulted: [{ id: 'd0', key: 'ben', who: 'ben', question: 'q', answer: 'yes', at: NOW }],
      }),
    }),
    true,
  )
  expect(went).toContain('id="decisions-open" class="rail-item alert"')
  expect(went).toContain('class="rail-dot inline"')
  expect(went).toContain('title="Something went by default since you last looked"')
  const quiet = rail(payload({ decisions: queue({ items: [] }) }), true)
  expect(quiet).toContain('id="decisions-open" class="rail-item"')
})

test('with the away journal on too (#489): Decisions in the rail, Since in the top bar, and both in the priority model', () => {
  const noop = () => {}
  const railHtml = render(
    <NavRail
      expanded
      onToggleExpand={noop}
      drawerOpen={false}
      onCloseDrawer={noop}
      activePlace="board"
      onBoard={noop}
      onDecisions={noop}
      onSchedule={noop}
      onCategories={noop}
      onArchive={noop}
      onSettings={noop}
    />,
    board({ data: payload({ decisions: queue() }) }),
  )
  const barHtml = render(
    <Toolbar
      limitsAnchor={createRef<HTMLButtonElement>()}
      journal={{ label: 'Since 23:56', open: false, onToggle() {} }}
    />,
    board({ data: payload({ decisions: queue() }) }),
  )
  expect(railHtml).toContain('id="decisions-open"')
  expect(barHtml).toContain('id="journal-open"')
  const base = { canMutate: true, schedule: { count: 0, due: false }, tasks: null, next: 0, usage: '', presence: null }
  const ids = toolbarEntries({ ...base, decisions: { waiting: 1, defaulted: 0 }, journal: 'Since 23:56' }, t).map(
    e => e.id,
  )
  expect(ids).toContain('decisions-open')
  expect(ids).toContain('journal-open')
  const at = (id: string) => TOOLBAR_PRIORITY.indexOf(id as (typeof TOOLBAR_PRIORITY)[number])
  expect([at('decisions-open'), at('journal-open')]).toEqual([at('threads-open') + 1, at('threads-open') + 2])
  // Every entry has a place in the priority list, and none is listed twice.
  expect(ids.every(id => at(id) >= 0)).toBe(true)
  expect(new Set(TOOLBAR_PRIORITY).size).toBe(TOOLBAR_PRIORITY.length)
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

test('the panel: what went by default first, its question and what the session went with; marked seen up to the newest shown', () => {
  const ui: DecisionsUi = {
    answer: async () => true,
    message: async () => true,
    hold: async () => true,
    seen: () => {},
  }
  const defaulted = [
    { id: 'd8', key: 'ben', who: 'ben', question: 'Rebase first?', answer: 'Rebase', at: NOW - 60_000 },
    { id: 'd7', key: 'cleo', who: 'cleo', question: 'Which branch?', answer: 'main', at: NOW - 3_600_000 },
  ]
  const panel = (data: BoardPayload) =>
    render(
      <PanelProvider viewport={() => ({ w: 1600, h: 1000 })}>
        <DecisionsPanel open onClose={() => {}} decisions={ui} />
      </PanelProvider>,
      board({ data, now: NOW }),
    )
  const html = panel(payload({ decisions: queue({ defaulted }) }))
  const went = /<section class="dec-went">(.*?)<\/section>/.exec(html)?.[1] ?? ''
  expect(went).toContain('<h3 class="dec-section">Went by default since you last looked</h3>')
  expect(
    [...went.matchAll(/<p class="dec-q">([^<]+)<\/p><p class="dec-answer">([^<]+)<\/p>/g)].map(m => [m[1], m[2]]),
  ).toEqual([
    ['Rebase first?', 'went with &quot;Rebase&quot;'],
    ['Which branch?', 'went with &quot;main&quot;'],
  ])
  // Above the queue.
  expect(html.indexOf('dec-went')).toBeLessThan(html.indexOf('Merge now?'))
  expect(panel(payload({ decisions: queue() }))).not.toContain('dec-went')
  expect(seenUpTo(defaulted)).toBe(NOW - 60_000)
  expect(seenUpTo([])).toBe(0)
})

test("an answer goes as the owner's (ownerPost, the passkey window on 428); its waiting to go out is no error", async () => {
  const calls: [string, string, unknown][] = []
  const toasts: [string, boolean][] = []
  let fail: unknown = null
  const ui = decisionsActions({
    post: async (path, body) => {
      calls.push(['post', path, body])
      return { ok: true }
    },
    ownerPost: async (path, body) => {
      calls.push(['owner', path, body])
      if (fail) throw fail
      return { ok: true }
    },
    toast: (text, error) => toasts.push([text, error]),
    t,
  })
  expect(await ui.answer('anna', 'd1', { option: 2 })).toBe(true)
  expect(calls).toEqual([['owner', '/api/decisions', { op: 'answer', key: 'anna', id: 'd1', option: 2 }]])
  // The owner closed the passkey window: the answer is in, only its going out to the peers waits.
  fail = new ApiError(0, { ok: false, error: 'cancelled' })
  expect(await ui.answer('anna', 'd1', { text: 'no' })).toBe(true)
  expect(toasts).toEqual([])
  // From the phone: it waits for the passkey on the computer, said as waiting.
  fail = new ApiError(428, { ok: false, error: 'confirm', where: 'computer' })
  expect(await ui.answer('anna', 'd1', { option: 1 })).toBe(true)
  expect(toasts).toEqual([[t('team.err.confirmAway'), false]])
  // A question no longer open: refused, as before.
  fail = new ApiError(409, { ok: false, error: 'This question is no longer open' })
  expect(await ui.answer('anna', 'd1', { option: 1 })).toBe(false)
  expect(toasts.at(-1)?.[1]).toBe(true)
  // Hold and seen stay plain posts.
  await ui.hold('anna', 'd1')
  expect(calls.at(-1)).toEqual(['post', '/api/decisions', { op: 'hold', key: 'anna', id: 'd1' }])
})
