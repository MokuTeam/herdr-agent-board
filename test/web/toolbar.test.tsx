// The React toolbar against the old page's (at the parity baseline): the toolbar block of
// web/index.html after web/app.js filled it for the same board (applyTexts, the "new session"
// button, renderToolbar, renderLimits, updateLive, syncAvailability, renderScheduleCount). The
// thumb's inline position is set after layout on both pages, so neither side has it here.
import { describe, expect, test } from 'bun:test'
import { createRef } from 'react'
import { translator } from '../../src/core/i18n/translator.ts'
import type { BoardPayload } from '../../src/core/payload.ts'
import type { Translator } from '../../src/core/types.ts'
import { Toolbar } from '../../web/src/components/Toolbar.tsx'
import { resultToken } from '../../web/src/models/attention.ts'
import type { BoardUi } from '../../web/src/state/board-ui.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import {
  addButtonTypes,
  applyTexts,
  byClass,
  byId,
  canonical,
  find,
  hasClass,
  type Node,
  OLD_PAGE_ONLY,
  pageMarkup,
  prepend,
  removeAttr,
  setAttr,
  setHtml,
  setText,
  stripAttrs,
  toggleAttr,
  toggleClass,
} from './support/markup.ts'

const NOW = Date.now()
const done = item({ key: 'c', name: 'Gamma', column: 'done', status: 'done', result: 'Fixed', activity: 100 })
const ITEMS = [
  item({ key: 'a', name: 'Alpha', column: 'work', status: 'working', category: 'proj' }),
  item({ key: 'b', name: 'Beta', column: 'me', attention: 'ask', category: 'proj', askSince: NOW - 5000 }),
  item({ key: 'e', name: 'Eps', column: 'ext', category: 'proj', wait: 'review' }),
  done,
  item({ key: 'd', name: 'Delta', column: 'idle', status: 'sleeping', sleeping: true }),
]
const CATEGORIES: BoardPayload['categories'] = [
  { id: 'proj', title: 'Project', color: '#007AFF', colorName: 'blue', paths: [], configured: true, fallback: false },
  { id: 'other', title: 'Other', color: '#8E8E93', colorName: 'gray', paths: [], configured: true, fallback: true },
  {
    id: 'unused',
    title: 'Unused',
    color: '#FF9500',
    colorName: 'orange',
    paths: [],
    configured: true,
    fallback: false,
  },
]
const LIMITS: BoardPayload['limits'] = {
  source: 'usagebar',
  observedAt: NOW - 60_000,
  stale: false,
  windows: [
    { minutes: 300, usedPercentage: 92, resetsAt: null, expired: false },
    { minutes: 10080, usedPercentage: 40.4, resetsAt: null, expired: false },
  ],
}
const SCHEDULES: BoardPayload['schedules'] = [
  { id: 's1', key: 'a', text: 'ping', next: NOW - 60_000 },
  { id: 's2', key: 'b', text: 'later', next: NOW + 3_600_000 },
]

function renderToolbar(value: ReturnType<typeof board>, lang: string): Node[] {
  return renderInBoard(<Toolbar limitsAnchor={createRef<HTMLButtonElement>()} />, value, lang)
}

/** The toolbar of web/index.html as web/app.js starts it: the "new session" button in, the texts filled. */
function oldToolbar(t: Translator): Node[] {
  const toolbar = [find(pageMarkup(), el => el.tag === 'header' && hasClass(el, 'toolbar'))]
  // app.js "new sessions, renaming, menus": the button with ICON.plus, prepended, then applyTexts().
  prepend(
    byClass(toolbar, 'controls'),
    '<button class="pill-toggle new-session" id="new-session" data-hint="launch.toolbarHint"><svg viewBox="0 0 20 20"><path d="M10 4.5v11M4.5 10h11"/></svg><span data-i18n="launch.toolbar"></span></button>',
  )
  applyTexts(toolbar, t)
  setText(byId(toolbar, 'lang-code'), t.lang.toUpperCase())
  setAttr(byId(toolbar, 'lang'), 'title', t('tb.lang', { name: t.lang === 'ru' ? 'Русский' : 'English' }))
  return toolbar
}

/** syncAvailability() for the toolbar's part. */
function syncAvailability(toolbar: Node[], t: Translator, canMutate: boolean, canEdit: boolean): void {
  const banner = byId(toolbar, 'connection-state')
  toggleAttr(banner, 'hidden', canMutate)
  setText(banner, t(canEdit ? 'mobile.readOnly' : 'live.off'))
  toggleAttr(byId(toolbar, 'lang'), 'disabled', !canEdit)
  const add = byId(toolbar, 'new-session')
  toggleAttr(add, 'disabled', !canMutate)
  setAttr(add, 'title', t(canMutate ? 'launch.toolbarHint' : 'mobile.readOnly'))
}

/** What React renders differently on purpose: see support/markup.ts. */
function asReactRendersIt(toolbar: Node[]): string {
  setAttr(byId(toolbar, 'search'), 'value', '') // the controlled input reflects its value; app.js set the property
  addButtonTypes(toolbar)
  stripAttrs(toolbar, OLD_PAGE_ONLY)
  return canonical(toolbar)
}

const ui = (fields: Partial<BoardUi>) => fields

describe('toolbar markup parity', () => {
  test('a fresh board in English: counts, lanes, attention, schedule badge, usage and the live dot', () => {
    const t = translator('en')
    const data = payload({ items: ITEMS, categories: CATEGORIES, limits: LIMITS, schedules: SCHEDULES })
    const actual = renderToolbar(board({ data, ui: ui({ filter: 'all', sleepers: true }) }), 'en')

    const old = oldToolbar(t)
    setHtml(
      byId(old, 'summary'),
      '<b>5</b> sessions · <b>1</b> working · <b>1</b> needs you · <b>1</b> waits on others · 1 asleep',
    )
    const next = byId(old, 'next-attention')
    setText(
      find([next], el => el.tag === 'span'),
      'Next · 2',
    )
    setAttr(next, 'title', t('attention.nextHint'))
    setAttr(next, 'aria-label', 'Next card needing attention, 2 in this view')
    setHtml(
      byId(old, 'lanes'),
      '<span class="thumb"></span><button role="tab" data-id="all" aria-selected="true">All<span class="n">5</span></button><button role="tab" data-id="proj" aria-selected="false">Project<span class="n">3</span></button><button role="tab" data-id="other" aria-selected="false">Other<span class="n">2</span></button>',
    )
    setHtml(
      byId(old, 'columns-head'),
      '<div class="col-head"><span class="dot" style="--c:var(--green)"></span>Working<span class="n">1</span></div>' +
        '<div class="col-head"><span class="dot" style="--c:var(--orange)"></span>Needs me<span class="n">1</span></div>' +
        '<div class="col-head"><span class="dot" style="--c:var(--purple)"></span>Waiting on others<span class="n">1</span></div>' +
        '<div class="col-head"><span class="dot" style="--c:var(--blue)"></span>Done<span class="n">1</span></div>' +
        '<div class="col-head"><span class="dot" style="--c:var(--gray)"></span>Idle<span class="n">1</span></div>',
    )
    const limits = byId(old, 'limits')
    removeAttr(limits, 'hidden')
    setAttr(limits, 'aria-label', 'Claude usage')
    setAttr(limits, 'title', 'Show usage, source and reading time')
    setHtml(limits, '<span class="hot">5h <b>92%</b></span><span>7d <b>40%</b></span>')
    const live = byId(old, 'live')
    toggleClass(live, 'on', true)
    setAttr(live, 'title', 'Live')
    syncAvailability(old, t, true, true)
    setText(byId(old, 'sched-count'), '2')
    toggleClass(byId(old, 'sched-open'), 'due', true)

    expect(canonical(actual)).toBe(asReactRendersIt(old))
  })

  test('stale herdr data in Russian, one lane picked, sleepers hidden, nothing needing attention', () => {
    const t = translator('ru')
    const old = NOW - 3_600_000
    const data = payload({
      lang: 'ru',
      stale: true,
      lastSuccessfulRefreshAt: NOW - 120_000,
      items: ITEMS,
      categories: CATEGORIES,
      limits: { ...LIMITS, observedAt: old, stale: true },
    })
    const viewed = { c: resultToken(done) }
    const actual = renderToolbar(board({ data, ui: ui({ filter: 'other', sleepers: false, viewed }) }), 'ru')

    const page = oldToolbar(t)
    setHtml(
      byId(page, 'summary'),
      '<b>5</b> сессий · <b>1</b> работает · <b>1</b> ждёт тебя · <b>1</b> ждёт ответа извне · 1 спит',
    )
    const next = byId(page, 'next-attention')
    toggleAttr(next, 'disabled', true)
    setText(
      find([next], el => el.tag === 'span'),
      t('attention.noneShort'),
    )
    setAttr(next, 'title', t('attention.none'))
    setAttr(next, 'aria-label', t('attention.none'))
    setHtml(
      byId(page, 'lanes'),
      '<span class="thumb"></span><button role="tab" data-id="all" aria-selected="false">Все<span class="n">4</span></button><button role="tab" data-id="proj" aria-selected="false">Project<span class="n">3</span></button><button role="tab" data-id="other" aria-selected="true">Other<span class="n">1</span></button>',
    )
    setHtml(
      byId(page, 'columns-head'),
      '<div class="col-head"><span class="dot" style="--c:var(--green)"></span>Работает<span class="n">0</span></div>' +
        '<div class="col-head"><span class="dot" style="--c:var(--orange)"></span>Ждёт меня<span class="n">0</span></div>' +
        '<div class="col-head"><span class="dot" style="--c:var(--purple)"></span>Ждёт внешнего<span class="n">0</span></div>' +
        '<div class="col-head"><span class="dot" style="--c:var(--blue)"></span>Готово<span class="n">1</span></div>' +
        '<div class="col-head"><span class="dot" style="--c:var(--gray)"></span>Простой<span class="n">0</span></div>',
    )
    const limits = byId(page, 'limits')
    removeAttr(limits, 'hidden')
    setAttr(limits, 'aria-label', 'Расход Claude')
    setAttr(limits, 'title', t('limits.open'))
    setHtml(limits, '<span class="hot">5ч <b>92%</b></span><span>7д <b>40%</b></span>')
    toggleClass(limits, 'stale', true)
    const live = byId(page, 'live')
    toggleClass(live, 'stale', true)
    setAttr(live, 'title', t('live.stale', { time: new Date(NOW - 120_000).toLocaleTimeString('ru') }))
    syncAvailability(page, t, false, true)
    setAttr(byId(page, 'sleepers'), 'aria-pressed', 'false')

    expect(canonical(actual)).toBe(asReactRendersIt(page))
  })

  test('before the first board: "Loading…", no lanes or heads, usage unknown, not connected yet', () => {
    const t = translator('en')
    const actual = renderToolbar(board({ data: null }), 'en')

    // The page as it starts: the connection reported "not connected" once (renderLimits,
    // updateLive, syncAvailability), the title of the dot put back by the second applyTexts().
    const old = oldToolbar(t)
    const limits = byId(old, 'limits')
    removeAttr(limits, 'hidden')
    setAttr(limits, 'aria-label', 'Claude usage')
    setAttr(limits, 'title', 'Show usage, source and reading time')
    setText(limits, 'Usage —')
    const live = byId(old, 'live')
    toggleClass(live, 'stale', true)
    setAttr(live, 'title', t('live.none'))
    syncAvailability(old, t, false, false)

    expect(canonical(actual)).toBe(asReactRendersIt(old))
  })
})
