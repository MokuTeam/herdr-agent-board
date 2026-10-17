// The question forms both ways, step by step, for parity: the old page's questions.js as it was at
// the parity baseline (initQuestions, with question-model.js), run on a fake #sheet-question
// (support/fake-dom.ts), and the React port — models/question-desk.ts's desk drawn by <QuestionForm>
// or <PermissionPrompt> — driven through the same steps: the same clicks, typing and digits, the
// same server answers. Each side keeps what it posted and toasted. A third side runs questions.js
// as it is now (its pure parts from the new models), which the old page serves until Task 27.
import type { ReactNode } from 'react'
import { translator } from '../../../src/core/i18n/translator.ts'
import type { Item } from '../../../src/core/types.ts'
import { PermissionPrompt } from '../../../web/src/components/questions/PermissionPrompt.tsx'
import { QuestionForm } from '../../../web/src/components/questions/QuestionForm.tsx'
import { type AnswerResult, digitFocus, type FormClick, questionDesk } from '../../../web/src/models/question-desk.ts'
import * as questionModel from '../../../web/src/models/question-model.ts'
import {
  type DialogDetail,
  dialogFor,
  formHint,
  formLocked,
  optionOn,
  previewText,
  sendButton,
} from '../../../web/src/models/questions.ts'
import { board, renderInBoard } from './board.tsx'
import { type FakeElement, FakeWorld } from './fake-dom.ts'
import { canonical, type Node, parseHtml } from './markup.ts'
import { oldCode } from './old-app.ts'

export interface Posted {
  key: string
  action: string
  body: unknown
}

export interface QaOptions {
  lang?: string
  canMutate?: boolean
  pointerFine?: boolean
}

/** What questions.js imports now, from the new models. */
const IMPORTED_NOW = { ...questionModel, dialogFor, formHint, formLocked, optionOn, previewText, sendButton }

const MODEL = [
  'pendingQuestions',
  'formKey',
  'emptyPicks',
  'update',
  'choose',
  'chooseOther',
  'typeOther',
  'answered',
  'remaining',
  'payload',
  'instant',
  'digitTarget',
  'currentQuestion',
  'permissionTone',
]

/** What the two sides share: the clocks, the server's answers waiting to be given, what went out. */
class Side {
  clock = 10_000
  now = Date.UTC(2026, 9, 17, 9, 0)
  posted: Posted[] = []
  toasts: [string, boolean][] = []
  private waiting: ((r: AnswerResult) => void)[] = []
  canMutate: boolean
  readonly t
  constructor(readonly options: QaOptions) {
    this.canMutate = options.canMutate ?? true
    this.t = translator(options.lang ?? 'en')
  }
  act = (key: string, action: string, body: unknown): Promise<AnswerResult> => {
    this.posted.push({ key, action, body: JSON.parse(JSON.stringify(body)) })
    return new Promise(resolve => this.waiting.push(resolve))
  }
  toast = (text: string, error = false) => void this.toasts.push([text, error])
  /** The server answers what is on its way. */
  answer(r: AnswerResult): void {
    for (const resolve of this.waiting.splice(0)) resolve(r)
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** The old page's question forms on a fake #sheet-question. */
export class OldQuestions extends Side {
  readonly world = new FakeWorld({ viewport: { w: 1200, h: 800 } })
  readonly box: FakeElement
  private item: Item | null = null
  private readonly ui: Record<string, (...args: unknown[]) => unknown>

  /** `now`: questions.js as it is now, else as it was at the parity baseline. */
  constructor(options: QaOptions = {}, now = false) {
    super(options)
    const [node] = parseHtml('<div class="sheet-question" id="sheet-question"></div>')
    if (node?.kind !== 'element') throw new Error('no box')
    this.box = this.world.mount(node)
    const imported = now
      ? IMPORTED_NOW
      : Object.fromEntries(oldCode('web/question-model.js', MODEL, {}, { baseline: true }))
    const code = oldCode(
      'web/questions.js',
      ['esc', 'SPIN', 'CHECK', 'FOCUS', 'initQuestions'],
      {
        ...imported,
        document: this.world.document,
        performance: { now: () => this.clock },
        Date: { now: () => this.now },
        CSS: { escape: (s: string) => s },
        matchMedia: () => ({ matches: !!options.pointerFine }),
      },
      { baseline: !now },
    )
    const init = code.get('initQuestions')
    if (typeof init !== 'function') throw new Error('no initQuestions')
    this.ui = init({
      box: this.box,
      t: () => this.t,
      item: () => this.item,
      act: this.act,
      toast: this.toast,
      canMutate: () => this.canMutate,
      focusSession: (key: string) => this.posted.push({ key, action: 'focus', body: {} }),
    })
  }

  private call(name: string, ...args: unknown[]): unknown {
    const fn = this.ui[name]
    if (typeof fn !== 'function') throw new Error(`no ${name}`)
    return fn(...args)
  }

  mount(it: Item, detail: DialogDetail | null = null): boolean {
    this.item = it
    return !!this.call('mount', it, detail)
  }

  /** syncAvailability(): the read-only state, as the page draws it after a change of connection. */
  sync(): void {
    this.call('sync')
  }

  find(selector: string): FakeElement {
    const el = this.box.querySelector(selector)
    if (!el) throw new Error(`no ${selector}`)
    return el
  }

  async click(selector: string): Promise<void> {
    await this.world.fire(this.find(selector), 'click')
    await flush()
  }

  async over(selector: string): Promise<void> {
    await this.world.fire(this.find(selector), 'pointerover')
  }

  async leave(): Promise<void> {
    await this.world.fire(this.box, 'pointerleave')
  }

  async type(q: number, text: string): Promise<void> {
    const input = this.find(`.qa-input[data-q="${q}"]`)
    input.value = text
    await this.world.fire(input, 'input')
  }

  async enter(q: number): Promise<void> {
    await this.world.fire(this.find(`.qa-input[data-q="${q}"]`), 'keydown', { key: 'Enter' })
    await flush()
  }

  /** A digit, with the focus on `focus` (an element in the form) or on the page. */
  async key(digit: string, focus: string | null = null, repeat = false): Promise<boolean> {
    this.world.document.activeElement = focus ? this.find(focus) : this.world.document.body
    const took = !!this.call('onKey', { key: digit, ctrlKey: false, metaKey: false, altKey: false, repeat })
    await flush()
    return took
  }

  /** The focused element's focus id. */
  focused(): string | undefined {
    return this.world.document.activeElement?.dataset.focusId
  }

  markup(): Node[] {
    return this.box.node.children
  }
}

/** The React port: the desk, drawn by the form or the prompt. */
export class NewQuestions extends Side {
  focusedId: string | undefined
  readonly desk = questionDesk({
    now: () => this.now,
    clock: () => this.clock,
    t: () => this.t,
    canMutate: () => this.canMutate,
    act: (key, action, body) => this.act(key, action, body),
    toast: this.toast,
    focusSession: key => void this.posted.push({ key, action: 'focus', body: {} }),
    focus: ({ q, n }) => {
      this.focusedId = `${q}.${n}`
    },
    changed() {},
  })
  private shownItem: Item | null = null

  constructor(options: QaOptions = {}) {
    super(options)
  }

  mount(it: Item, detail: DialogDetail | null = null): boolean {
    this.shownItem = it
    return !!this.desk.mount(it, detail)
  }

  async click(target: FormClick): Promise<void> {
    this.desk.click(target)
    await flush()
  }

  /** A digit, with the focus on an element of the form (its attributes) or on the page. */
  async key(digit: string, focus: { tag: string; q: string | null } | null = null, repeat = false): Promise<boolean> {
    const active = focus && {
      tagName: focus.tag,
      closest: (s: string) => (s === '[data-q]' && focus.q !== null ? { getAttribute: () => focus.q } : null),
    }
    const took = this.desk.key(
      { key: digit, ctrlKey: false, metaKey: false, altKey: false, repeat },
      digitFocus(active),
    )
    await flush()
    return took
  }

  node(): ReactNode {
    const view = this.desk.view()
    if (!view || !this.shownItem) return null
    const { shown, form, peek } = view
    return shown.kind === 'permission' ? (
      <PermissionPrompt shown={shown} form={form} canMutate={this.canMutate} />
    ) : (
      <QuestionForm
        shown={shown}
        form={form}
        peek={peek}
        canMutate={this.canMutate}
        pointerFine={!!this.options.pointerFine}
      />
    )
  }

  markup(): Node[] {
    const value = board({ connected: true })
    return renderInBoard(this.node(), { ...value, canMutate: this.canMutate }, this.options.lang ?? 'en')
  }
}

/** What a click on this element of the old form means to the desk (what the React form's handlers send). */
export function clickOf(el: FakeElement, inner: FakeElement = el): FormClick {
  if (el.matches('[data-qa-focus]')) return { kind: 'focus' }
  if (el.matches('[data-qa-send]')) return { kind: 'send' }
  const perm = el.dataset.perm
  if (perm !== undefined) return { kind: 'permit', n: Number(perm) }
  const q = Number(el.dataset.q)
  if (el.dataset.n === 'other') return { kind: 'other', q, inField: inner.matches('.qa-input') }
  return { kind: 'option', q, n: Number(el.dataset.n) }
}

/** The sides, stepped together: the baseline's (`old`), today's old page (`now`) and the React port. */
export class BothQuestions {
  readonly old: OldQuestions
  readonly now: OldQuestions
  readonly react: NewQuestions
  constructor(options: QaOptions = {}) {
    this.old = new OldQuestions(options)
    this.now = new OldQuestions(options, true)
    this.react = new NewQuestions(options)
  }
  private olds(): OldQuestions[] {
    return [this.old, this.now]
  }
  mount(it: Item, detail: DialogDetail | null = null): [boolean, boolean] {
    const [old, now] = this.olds().map(side => side.mount(it, detail))
    if (old !== now) throw new Error('questions.js now mounts otherwise than it did')
    return [!!old, this.react.mount(it, detail)]
  }
  /** A click on the old form's element at `selector` (`inner`: on that child of it), and the same on the desk. */
  async click(selector: string, inner?: string): Promise<void> {
    let target: FormClick | null = null
    for (const side of this.olds()) {
      const el = side.find(selector)
      const at = inner ? (el.querySelector(inner) ?? el) : el
      target ??= clickOf(el, at)
      await side.world.fire(at, 'click')
    }
    if (target) await this.react.click(target)
  }
  async type(q: number, text: string): Promise<void> {
    for (const side of this.olds()) await side.type(q, text)
    this.react.desk.type(q, text)
  }
  async enter(q: number): Promise<void> {
    for (const side of this.olds()) await side.enter(q)
    this.react.desk.enter()
    await flush()
  }
  async over(selector: string): Promise<void> {
    const el = this.old.find(selector)
    for (const side of this.olds()) await side.over(selector)
    this.react.desk.peekAt(
      el.matches('button.qa-opt[data-q]') ? { q: Number(el.dataset.q), n: Number(el.dataset.n) } : null,
    )
  }
  async leave(): Promise<void> {
    for (const side of this.olds()) await side.leave()
    this.react.desk.unpeek()
  }
  async key(digit: string, focus: string | null = null, repeat = false): Promise<[boolean, boolean]> {
    const el = focus ? this.old.find(focus) : null
    const q = el?.closest('[data-q]')?.dataset.q ?? null
    const old = await this.old.key(digit, focus, repeat)
    if ((await this.now.key(digit, focus, repeat)) !== old) throw new Error('questions.js now takes keys otherwise')
    const react = await this.react.key(digit, el ? { tag: el.tagName, q } : null, repeat)
    return [old, react]
  }
  async answer(r: AnswerResult): Promise<void> {
    for (const side of this.olds()) side.answer(r)
    this.react.answer(r)
    await flush()
  }
  /** Time goes by on every clock. */
  later(ms: number): void {
    for (const side of [this.old, this.now, this.react]) {
      side.clock += ms
      side.now += ms
    }
  }
  set canMutate(on: boolean) {
    for (const side of this.olds()) {
      side.canMutate = on
      side.sync()
    }
    this.react.canMutate = on
  }
  /** The forms as canonical text. */
  forms(): { old: string; now: string; react: string } {
    return {
      old: canonical(this.old.markup()),
      now: canonical(this.now.markup()),
      react: canonical(this.react.markup()),
    }
  }
}
