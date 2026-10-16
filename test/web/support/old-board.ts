// What web/app.js draws in #board for a board, for the expected side of the board's markup parity.
// The cards come from the old code itself (cardHTML, updateCard, alarmBadge, ago, plain, the
// question card of questions.js, visibleItems, catOf/colOf: support/old-app.ts); the lane and
// column markup is laneOf's template and render()'s updates (app.js:429-449,535-598), and the
// buttons' availability syncAvailability's part for cards and lanes (app.js:175-188), by hand.
import type { BoardPayload } from '../../../src/core/payload.ts'
import type { ColumnId, Translator } from '../../../src/core/types.ts'
import { longWhen, shortWhen } from '../../../src/core/when-format.ts'
import { attentionTime, type Seen, unseenResult } from '../../../web/src/models/attention.ts'
import {
  addButtonTypes,
  byId,
  type Element,
  findAll,
  hasClass,
  type Node,
  pageMarkup,
  setAttr,
  setHtml,
  toggleAttr,
} from './markup.ts'
import { oldCode, oldFunction } from './old-app.ts'

/** The old page's state for one board (app.js `state`, `viewed`) and what it could do. */
export interface OldScene {
  t: Translator
  data: BoardPayload
  filter: string
  query: string
  sleepers: boolean
  open: string | null
  busy: Map<string, string>
  viewed: Seen
  moved: Map<string, string>
  movedCol: Map<string, { col: ColumnId; at: number }>
  canMutate: boolean
  canEdit: boolean
}

const pendingQuestions = oldFunction(oldCode('web/question-model.js', ['pendingQuestions'], {}), 'pendingQuestions')

/** questions.js's card part (initQuestions → cardAsk), with the page's translator. */
function questionsUI(t: Translator) {
  const code = oldCode('web/questions.js', ['esc', { name: 'cardAsk', indent: '  ' }], { t: () => t, pendingQuestions })
  return { cardAsk: oldFunction(code, 'cardAsk') }
}

// launch.js draws sessions on their way (Task 27): the scenes here have none.
const launchUI = { cardHTML: () => '', note: () => '', placeholders: () => [] }

const APP_CODE = [
  'COLORS',
  'ICON',
  'esc',
  'plain',
  'ago',
  'q',
  'colTitle',
  'catOf',
  'colOf',
  'inTurn',
  'catInfo',
  'compact',
  'visibleItems',
  'laneShown',
  'dismissable',
  'schedulesOf',
  'overdue',
  'alarmBadge',
  'cardHTML',
  'updateCard',
]

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const prop = (value: unknown, key: string): string => (isRecord(value) ? String(value[key]) : '')

/** One card as cardOf() makes it (class, data-key, tabindex) and updateCard() fills it. */
function oldCard(update: (...args: unknown[]) => unknown, esc: (s: unknown) => string, it: unknown): string {
  const classes = new Set(['card'])
  const dataset: Record<string, string> = { key: prop(it, 'key') }
  const card = {
    _html: '',
    innerHTML: '',
    dataset,
    classList: {
      // DOMTokenList.toggle: without a force it flips (the fixtures' items say `sleeping`, as the server's do).
      toggle(name: string, force?: unknown) {
        const on = force === undefined ? !classes.has(name) : !!force
        if (on) classes.add(name)
        else classes.delete(name)
      },
    },
  }
  update(card, it)
  const data = Object.entries(dataset)
    .map(([name, value]) => ` data-${name}="${esc(value)}"`)
    .join('')
  return `<article class="${[...classes].join(' ')}" tabindex="0"${data}>${card.innerHTML}</article>`
}

/** syncAvailability() for the cards' buttons and the lanes' "+". */
function syncAvailability(nodes: Node[], s: OldScene): void {
  const blocked = !s.canMutate
  const act = (el: Element) => el.attrs.get('data-act') ?? ''
  for (const el of findAll(nodes, el => act(el) === 'focus' || act(el) === 'sleep')) toggleAttr(el, 'disabled', blocked)
  for (const el of findAll(nodes, el => act(el) === 'dismiss')) toggleAttr(el, 'disabled', !s.canEdit)
  for (const el of findAll(nodes, el => hasClass(el, 'lane-new'))) {
    toggleAttr(el, 'disabled', blocked)
    setAttr(el, 'title', s.t(blocked ? 'mobile.readOnly' : 'launch.inLane'))
  }
}

/** #board of web/index.html after render() drew this board; buttons typed as React types them. */
export function oldBoard(s: OldScene): Node[] {
  const state = {
    data: s.data,
    filter: s.filter,
    query: s.query,
    sleepers: s.sleepers,
    open: s.open,
    busy: s.busy,
    moved: s.moved,
    movedCol: s.movedCol,
  }
  const code = oldCode('web/app.js', APP_CODE, {
    t: s.t,
    state,
    viewed: s.viewed,
    launchUI,
    questionsUI: questionsUI(s.t),
    attentionTime,
    unseenResult,
    longWhen,
    shortWhen,
  })
  const call = (name: string, ...args: unknown[]) => oldFunction(code, name)(...args)
  const esc = (v: unknown) => String(call('esc', v))
  const update = oldFunction(code, 'updateCard')
  const shown = call('visibleItems')
  const shownItems = new Set<unknown>(Array.isArray(shown) ? shown : [])
  const visible = s.data.items.filter(it => shownItems.has(it))
  const plus = prop(code.get('ICON'), 'plus')
  const label = esc(s.t('launch.inLane'))
  let anyShown = false
  const lanes = s.data.categories.map(({ id }) => {
    const info = call('catInfo', id)
    const its = visible.filter(it => call('catOf', it) === id)
    const shown = call('laneShown', id) === true
    if (its.length && shown) anyShown = true
    const cols = s.data.columns.map(c => {
      const list = its.filter(it => call('colOf', it) === c.id)
      const cards = list.map(it => oldCard(update, esc, it)).join('')
      return `<div class="col${list.length ? ' has-cards' : ''}" data-col="${c.id}"><div class="col-label"><span class="dot" style="--c:${prop(code.get('COLORS'), c.id)}"></span>${esc(call('colTitle', c.id))}</div>${cards}</div>`
    })
    return `<section class="lane${its.length ? '' : ' empty-lane'}${shown ? '' : ' filtered'}" data-cat="${esc(id)}" style="--lane: ${prop(info, 'color')}"><div class="lane-bar"><header class="lane-head"><span class="lane-tag">${esc(prop(info, 'title'))}</span><span class="lane-count">${its.length || ''}</span></header><button class="lane-new" title="${label}" aria-label="${label}">${plus}</button></div><div class="lane-grid">${cols.join('')}</div></section>`
  })
  const empty = anyShown
    ? ''
    : `<p class="empty">${esc(s.t(s.data.items.length ? 'empty.none' : 'empty.noSessions'))}</p>`
  const board = byId(pageMarkup(), 'board')
  setHtml(board, empty + lanes.join(''))
  syncAvailability([board], s)
  addButtonTypes([board])
  return [board]
}
