// What web/app.js draws in the session panel (#sheet of web/index.html) for one scene, for the
// expected side of the sheet's markup parity. The drawing is the old code's own, as it was at the
// parity baseline — renderSheetHead, renderSheetBody (renderSheetCard, scheduleRow, modeButton,
// cancelButton, thread, thumbs, clock), renderDetailState, renderAttachments, syncComposer and
// syncSheetProperties picked out of web/app.js (support/old-app.ts) with its own markdown.js and
// when.js, questions.js's threadHTML — run against a small `$` over the parsed page. By hand: the
// "New here" button app.js puts before More at start (#55's app.js:2658-2664), the Changes button's
// rule in the detail's `changed` (app.js:903) and syncAvailability's part for the sheet (app.js:175-195).
// The page and renderSheetHead are those of the archive (upstream PR #56): the baseline's with the
// sheet's Terminal button (#36), the facts under its name one span each and Wake's tooltip (#43),
// "Call in MokuPilot" (#44), Restart (#51), More at the row's end (#54), the call before the
// Terminal (#55) and Archive (#56, with its archive-model.js archiveBlock), nothing else. The reminders' row (scheduleRow) is #51's: a call's results by their title (#45), a restart
// with how it stands.
import { translator } from '../../../src/core/i18n/translator.ts'
import type { BoardPayload } from '../../../src/core/payload.ts'
import type { ColumnId, Item, Translator } from '../../../src/core/types.ts'
import type { SessionDetail } from '../../../web/src/api/client.ts'
import type { Attachment } from '../../../web/src/models/composer.ts'
import type { DetailValue } from '../../../web/src/models/detail-resource.ts'
import {
  addButtonTypes,
  applyTexts,
  byClass,
  byId,
  type Element,
  findAll,
  type Node,
  OLD_PAGE_ONLY,
  pageMarkup,
  parseHtml,
  setAttr,
  setHtml,
  setText,
  stripAttrs,
  toggleAttr,
  toggleClass,
} from './markup.ts'
import { OLD_MARKDOWN, OLD_WHEN, oldCode, oldFunction, oldModule } from './old-app.ts'

/** The old page's state for one scene (app.js `state`, the composer's and the sheet's own). */
export interface OldSheetScene {
  lang?: string
  data: BoardPayload
  /** state.open */
  open: string | null
  /** state.selectedItem: the item the sheet showed last (a session gone from the board). */
  selected?: Item
  /** state.detailState (state.detail is its data). */
  detail?: DetailValue<SessionDetail>
  connected?: boolean
  moved?: Map<string, string>
  movedCol?: Map<string, { col: ColumnId; at: number }>
  /** The schedule entry whose cancel button asks "Cancel?". */
  armed?: string | null
  /** questionsUI.mount(): the session waits on a form, drawn in #sheet-question as `formHtml`. */
  form?: boolean
  formHtml?: string
  narrow?: boolean
  propertiesOpen?: boolean
  /** The message box's text. */
  message?: string
  attachments?: Attachment[]
  /** Sessions with a message on its way. */
  sending?: string[]
}

type StyleRule = [string, string]

/**
 * Upstream's merge of the archive (PR #56), which has the terminal's (#36), the compact toolbar's
 * (#43), MokuPilot's call (#44), its results (#45), the restart's (#51), the session panel's row
 * (#54) and the call's move to the row's front (#55) in it.
 */
const SHEET_MERGE = '2b9e6b7'
const OLD_CALL = await oldModule('web/notice-model.js', SHEET_MERGE)
const OLD_ARCHIVE = await oldModule('web/archive-model.js', SHEET_MERGE)
const archiveBlock = (it: unknown, schedules: unknown): unknown => {
  const fn = OLD_ARCHIVE.get('archiveBlock')
  if (typeof fn !== 'function') throw new Error('no archiveBlock')
  return Reflect.apply(fn, undefined, [it, schedules])
}

/** Just enough of an element for the old code's writes, onto a parsed node. */
class FakeElement {
  _html: unknown
  scrollHeight = 0
  scrollTop = 0
  clientHeight = 0
  constructor(readonly node: Element) {}
  set innerHTML(html: string) {
    setHtml(this.node, html)
  }
  set textContent(text: string) {
    setText(this.node, text)
  }
  set title(value: string) {
    setAttr(this.node, 'title', value)
  }
  set hidden(on: boolean) {
    toggleAttr(this.node, 'hidden', on)
  }
  set disabled(on: boolean) {
    toggleAttr(this.node, 'disabled', on)
  }
  set tabIndex(n: number) {
    setAttr(this.node, 'tabindex', String(n))
  }
  setAttribute(name: string, value: string) {
    setAttr(this.node, name, value)
  }
  readonly style = {
    setProperty: (name: string, value: string) => {
      const rules: StyleRule[] = (this.node.attrs.get('style') ?? '')
        .split(';')
        .map(r => r.split(':').map(s => s.trim()))
        .filter((r): r is StyleRule => r.length === 2 && !!r[0])
      const kept = rules.filter(([n]) => n !== name)
      setAttr(this.node, 'style', [...kept, [name, value]].map(([n, v]) => `${n}: ${v}`).join('; '))
    },
  }
  readonly classList = { toggle: (name: string, on: boolean) => toggleClass(this.node, name, on) }
  contains = () => false
  querySelectorAll = () => []
}

const pickedFromApp = [
  'COLORS',
  'ICON',
  'esc',
  'plain',
  'UPLOAD_IMAGE',
  'thumbs',
  'ago',
  'clock',
  'itemOf',
  'q',
  'catOf',
  'colOf',
  'inTurn',
  'catInfo',
  'dismissable',
  'schedulesOf',
  'overdue',
  'colTitle',
  'canMutate',
  'canEdit',
  'syncSheetProperties',
  'renderDetailState',
  'renderSheetCard',
  'renderSheetBody',
  'thread',
  'syncComposer',
  'size',
  'renderAttachments',
  'modeButton',
  'cancelButton',
]

/** questions.js's threadHTML (initQuestions → threadHTML), with the page's translator. */
function threadHTML(t: Translator) {
  const code = oldCode('web/questions.js', ['esc', { name: 'threadHTML', indent: '  ' }], { t: () => t })
  return oldFunction(code, 'threadHTML')
}

/** syncAvailability(), the sheet's part (#56's: a restart on its way grays Restart, archiveBlock grays Archive). */
function syncAvailability(nodes: Node[], s: OldSheetScene, call: Call): void {
  const t = translator(s.lang ?? 'en')
  const blocked = !call('canMutate')
  const canEdit = !!call('canEdit')
  const onBoard = !!(s.open && call('itemOf', s.open))
  const missing = !!s.open && (!onBoard || s.detail?.status === 'missing')
  const el = (id: string) => byId(nodes, id)
  const banner = el('sheet-connection-state')
  toggleAttr(banner, 'hidden', !blocked)
  setText(banner, t(canEdit ? 'mobile.readOnly' : 'live.off'))
  const turn = !!call('inTurn', (s.open && call('itemOf', s.open)) ?? {})
  const restarting = !!call('restartPending', s.open)
  const archiveWhy = !!archiveBlock(s.open ? call('itemOf', s.open) : undefined, s.data.schedules ?? [])
  for (const id of ['sheet-focus', 'sheet-sleep', 'sheet-restart', 'sheet-wake', 'sheet-archive'])
    toggleAttr(
      el(id),
      'disabled',
      blocked ||
        missing ||
        (id === 'sheet-sleep' && turn) ||
        (id === 'sheet-restart' && restarting) ||
        (id === 'sheet-archive' && archiveWhy),
    )
  const card = el('sheet-card')
  const edits = [el('attach'), el('sheet-mokupilot'), ...findAll([card], e => e.tag === 'button' || e.tag === 'input')]
  for (const e of edits) toggleAttr(e, 'disabled', !canEdit)
  const acts = findAll(nodes, e => e.attrs.has('data-act'))
  for (const e of acts) if (e.attrs.get('data-act') === 'dismiss') toggleAttr(e, 'disabled', !canEdit)
  const here = el('sheet-new')
  toggleAttr(here, 'disabled', blocked)
  setAttr(here, 'title', t(blocked ? 'mobile.readOnly' : 'launch.hereHint'))
  const files = [el('sheet-changes'), el('sheet-history')]
  if (missing) for (const e of [...edits, ...acts, here, ...files]) toggleAttr(e, 'disabled', true)
  else for (const e of files) toggleAttr(e, 'disabled', false)
}

type Call = (name: string, ...args: unknown[]) => unknown

/** #sheet of web/index.html as web/app.js leaves it for the scene; buttons typed as React types them. */
export function oldSheet(scene: OldSheetScene): Element {
  const t = translator(scene.lang ?? 'en')
  const aside = byId(pageMarkup(SHEET_MERGE), 'sheet')
  const nodes: Node[] = [aside]
  const fake = (id: string) => new FakeElement(byId(nodes, id))
  const $ = (selector: string) => {
    if (selector === '#composer .send') return new FakeElement(byClass([byId(nodes, 'composer')], 'send'))
    const found = findAll(nodes, e => e.attrs.get('id') === selector.slice(1))[0]
    return found ? new FakeElement(found) : null
  }
  const detail = scene.detail ?? null
  const state = {
    data: scene.data,
    open: scene.open,
    selectedItem: scene.selected,
    detail: detail?.data ?? null,
    detailState: detail,
    connected: scene.connected ?? true,
    moved: scene.moved ?? new Map(),
    movedCol: scene.movedCol ?? new Map(),
  }
  const deps: Record<string, unknown> = {
    t,
    state,
    $,
    document: { activeElement: null },
    sheetCard: fake('sheet-card'),
    sheetBody: fake('sheet-body'),
    sheetQuestion: fake('sheet-question'),
    questionsUI: { mount: () => !!scene.form, threadHTML: threadHTML(t) },
    files: { upgrade() {} },
    syncAvailability() {},
    narrowSheet: { matches: !!scene.narrow },
    propertiesOpen: !!scene.propertiesOpen,
    attachments: scene.attachments ?? [],
    sending: new Set(scene.sending ?? []),
    message: { style: {}, scrollHeight: 0, value: scene.message ?? '' },
    sendBtn: $('#composer .send'),
    armed: scene.armed ? { id: scene.armed } : null,
    markdown: OLD_MARKDOWN.get('markdown'),
    capital: OLD_WHEN.get('capital'),
    longWhen: OLD_WHEN.get('longWhen'),
  }
  // renderSheetBody's scheduleRow, #51's, over the baseline's helpers: bound once both are there.
  let scheduleRow: (...args: unknown[]) => unknown = () => ''
  deps.scheduleRow = (...args: unknown[]) => scheduleRow(...args)
  const baseline = oldCode('web/app.js', pickedFromApp, deps)
  // A restart on its way, as #51 reads it, for the head's Restart and the reminders' row.
  const restart = oldCode(
    'web/app.js',
    ['restartOf', 'restartPending', 'restartOn', 'restartText'],
    { ...deps, ...Object.fromEntries(baseline) },
    SHEET_MERGE,
  )
  // #51's own ICON (it has the restart's arrows) and modeButton (none for a restart) in place of the baseline's.
  const picked = ['ICON', 'entryText', 'modeButton', 'scheduleRow']
  const helpers = Object.fromEntries([...baseline, ...restart].filter(([name]) => !picked.includes(name)))
  scheduleRow = oldFunction(
    oldCode('web/app.js', picked, { ...deps, ...helpers, callTitle: OLD_CALL.get('callTitle') }, SHEET_MERGE),
    'scheduleRow',
  )
  // The head with the Terminal button's rule, the facts as spans, Restart and Archive, over the baseline's helpers.
  const head = oldCode(
    'web/app.js',
    ['renderSheetHead'],
    { ...deps, ...Object.fromEntries(baseline), ...Object.fromEntries(restart), archiveBlock },
    SHEET_MERGE,
  )
  const code = new Map([...baseline, ...restart, ...head])
  const call: Call = (name, ...args) => oldFunction(code, name)(...args)

  // At start: the "new session here" button before More, the name focusable, the texts in the language.
  const icons = code.get('ICON')
  const plus = typeof icons === 'object' && icons !== null && 'plus' in icons ? String(icons.plus) : ''
  const actions = byClass(nodes, 'composer-actions')
  const more = actions.children.indexOf(byId([actions], 'sheet-more'))
  actions.children.splice(
    more,
    0,
    ...parseHtml(
      `<button class="button" id="sheet-new" data-hint="launch.hereHint">${plus}<span data-i18n="launch.here"></span></button>`,
    ),
  )
  setAttr(byId(nodes, 'sheet-name'), 'tabindex', '0')
  applyTexts(nodes, t)
  if (scene.open) {
    call('syncSheetProperties')
    toggleAttr(byId(nodes, 'sheet-changes'), 'hidden', !detail?.data?.checkout)
    call('renderSheetHead')
    call('renderSheetBody', false)
    if (scene.form && scene.formHtml !== undefined) setHtml(byId(nodes, 'sheet-question'), scene.formHtml)
    call('renderAttachments')
  }
  syncAvailability(nodes, scene, call)
  call('syncComposer')
  call('renderDetailState')
  // The message box's value, where React's server markup has it: as the textarea's text.
  if (scene.message) setText(byId(nodes, 'message'), scene.message)
  stripAttrs(nodes, OLD_PAGE_ONLY)
  addButtonTypes(nodes)
  return aside
}

/** The aside's head title (`.sheet-title`) and what comes under the head in `.sheet-inner`. */
export function sheetParts(aside: Element): { title: Element; body: Node[] } {
  const inner = byClass([aside], 'sheet-inner')
  const title = byClass([aside], 'sheet-title')
  return { title, body: inner.children.filter(n => !(n.kind === 'element' && n.tag === 'header')) }
}
