// The question forms of every session on the board, without the DOM (the old page's questions.js
// state): the form on show and what is picked on it, kept per form while the sheet shows another
// session; the answer sent once, and how it went; clicks, typing and digits on it. The server types
// the answer into the pane and checks the screen after every key (src/services/answer.ts).
import type { Item, Translator } from '../../../src/core/types.ts'
import {
  choose,
  chooseOther,
  currentQuestion,
  type DigitTarget,
  digitTarget,
  emptyPicks,
  instant,
  payload,
  remaining,
  typeOther,
} from './question-model.ts'
import {
  type Answered,
  type DialogDetail,
  dialogFor,
  type FormState,
  formBusy,
  formLocked,
  type Peek,
  type Shown,
} from './questions.ts'

/** What the server answered to an answer or a permission choice (useSessionActions.act). */
export type AnswerResult =
  | { ok: true; [extra: string]: unknown }
  | { ok: false; error: string; [extra: string]: unknown }

export interface DeskDeps {
  /** Date.now(): when an answer went through. */
  now(): number
  /** performance.now(): when a dialog came up. */
  clock(): number
  t(): Translator
  canMutate(): boolean
  act(key: string, action: 'answer' | 'permit', body: Record<string, unknown>): Promise<AnswerResult>
  toast(text: string, error?: boolean): void
  focusSession(key: string): void
  /** A control of the form takes the focus: the own answer of question `q`, or option `n` of it. */
  focus(target: { q: number; n: DigitTarget }): void
  /** The form's state changed: draw it again. */
  changed(): void
}

/** What the form on show draws from. */
export interface FormView {
  shown: Shown
  form: FormState
  peek: Peek | null
}

/** A click on the form, by what it landed on. */
export type FormClick =
  | { kind: 'focus' }
  | { kind: 'send' }
  | { kind: 'permit'; n: number }
  /** pi's text input: what is typed goes. */
  | { kind: 'reply' }
  | { kind: 'option'; q: number; n: number }
  /** On the own answer's row; `inField`: into its text field. */
  | { kind: 'other'; q: number; inField: boolean }

export interface DigitPress {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  repeat: boolean
}

/** Where the focus is when a digit is pressed: in a text field, and in which question. */
export interface DigitFocus {
  typing: boolean
  question: number | null
}

/** What digitFocus reads of the focused element. */
export interface Focused {
  tagName?: string | undefined
  isContentEditable?: boolean | undefined
  closest(selector: string): { getAttribute(name: string): string | null } | null
}

const TEXT_FIELDS = /^(INPUT|TEXTAREA|SELECT)$/

/** Where the focus is: a text field (whose digits are its own), and the question it is in. */
export function digitFocus(active: Focused | null | undefined): DigitFocus {
  const question = active?.closest('[data-q]')?.getAttribute('data-q')
  return {
    typing: TEXT_FIELDS.test(active?.tagName ?? '') || !!active?.isContentEditable,
    question: question == null ? null : Number(question),
  }
}

export interface QuestionDesk {
  /** The sheet draws `it`: the form it shows, or null (the old mount). */
  mount(it: Item, detail: DialogDetail | null | undefined): FormView | null
  /** The form on show now, as last mounted. */
  view(): FormView | null
  click(target: FormClick): void
  /** Text typed into question `q`'s own answer. */
  type(q: number, text: string): void
  /** Text typed into pi's text input. */
  write(text: string): void
  /** Enter in an own answer's field: the answers go when none is left; in pi's text input, the text goes. */
  enter(): void
  /** The pointer or the focus on an option (null: on none). */
  peekAt(target: Peek | null): void
  /** The pointer left the form. */
  unpeek(): void
  /** Digits 1 to 9 while the focus is in the sheet; true when it took the key. */
  key(press: DigitPress, focus: DigitFocus): boolean
}

/** A click or a digit right after another dialog took the place of the one on show was meant for the one before. */
export const SETTLE_MS = 500
/** Only the forms of the sessions on show are worth keeping. */
const KEEP_FORMS = 12

export function questionDesk(deps: DeskDeps): QuestionDesk {
  const forms = new Map<string, FormState>()
  let shown: Shown | null = null
  let answered: Answered | null = null
  let keyAt = 0
  let peek: Peek | null = null
  const settling = () => deps.clock() - keyAt < SETTLE_MS

  function formOf(s: Shown): FormState {
    let f = forms.get(s.key)
    if (!f) {
      const picks = s.kind === 'question' ? emptyPicks(s.questions) : []
      f = { picks, status: 'idle', error: '', stopped: false, screen: '', chosen: null, text: '' }
      forms.set(s.key, f)
      for (const k of forms.keys()) if (forms.size > KEEP_FORMS && k !== s.key) forms.delete(k)
    }
    return f
  }

  const view = (): FormView | null => (shown ? { shown, form: formOf(shown), peek } : null)

  function wants(it: Item, detail: DialogDetail | null | undefined): Shown | null {
    const next = dialogFor(it, detail, answered, deps.now())
    if (next.expired && answered) {
      if (forms.get(answered.shown.key)?.status === 'sent') forms.delete(answered.shown.key)
      answered = null
    }
    return next.shown
  }

  // Drawing the sheet again changes nothing more: the second of two mounts finds what the first left.
  function mount(it: Item, detail: DialogDetail | null | undefined): FormView | null {
    const before = shown?.key ?? null
    shown = wants(it, detail)
    if ((shown?.key ?? null) !== before) {
      // The dialog went or another took its place: a finished form goes with it.
      if (before && forms.get(before)?.status === 'sent') forms.delete(before)
      if (shown) keyAt = deps.clock()
    }
    return view()
  }

  function finish(s: Shown, f: FormState, r: AnswerResult, done: () => string): void {
    if (r.ok) {
      f.status = 'sent'
      answered = { shown: s, at: deps.now() }
      deps.toast(done())
    } else if (r.gone) {
      // Nothing left to answer (answered in the terminal meanwhile): the form goes, the reason in a toast.
      forms.delete(s.key)
      deps.toast(r.error, true)
    } else
      Object.assign(f, {
        status: 'error',
        error: r.error || deps.t()('qa.failed'),
        stopped: !!r.stopped,
        screen: typeof r.screen === 'string' ? r.screen : '',
      })
    if (shown?.key === s.key) deps.changed()
    // The form went with the dialog meanwhile: the reason in a toast.
    else if (!r.ok && !r.gone) deps.toast(f.error, true)
  }

  async function sendQuestions(): Promise<void> {
    const s = shown
    if (s?.kind !== 'question' || !deps.canMutate()) return
    const f = forms.get(s.key)
    if (!f || formBusy(f) || remaining(s.questions, f.picks)) return
    Object.assign(f, { status: 'sending', error: '', stopped: false, screen: '' })
    deps.changed()
    const r = await deps.act(s.it.key, 'answer', {
      session: s.it.session ?? null,
      toolUseId: s.it.tool?.id,
      answers: payload(s.questions, f.picks),
    })
    finish(s, f, r, () => deps.t()('qa.done', { name: s.it.name }))
  }

  async function sendPermission(n: number): Promise<void> {
    const s = shown
    if (s?.kind !== 'permission' || !deps.canMutate()) return
    const f = forms.get(s.key)
    const o = s.dialog.options.find(x => x.n === n)
    if (!f || !o || formBusy(f)) return
    Object.assign(f, { status: 'sending', error: '', stopped: false, screen: '', chosen: n })
    deps.changed()
    const r = await deps.act(s.it.key, 'permit', {
      session: s.it.session ?? null,
      fingerprint: s.dialog.fingerprint,
      option: n,
    })
    finish(s, f, r, () => deps.t()('qa.permDone', { name: s.it.name, choice: o.label }))
  }

  async function sendText(): Promise<void> {
    const s = shown
    if (s?.kind !== 'input' || !deps.canMutate()) return
    const f = forms.get(s.key)
    const text = f?.text.trim() ?? ''
    if (!f || !text || formBusy(f)) return
    Object.assign(f, { status: 'sending', error: '', stopped: false, screen: '' })
    deps.changed()
    const r = await deps.act(s.it.key, 'permit', {
      session: s.it.session ?? null,
      fingerprint: s.dialog.fingerprint,
      text,
    })
    finish(s, f, r, () => deps.t()('qa.permDone', { name: s.it.name, choice: text }))
  }

  function pick(i: number, n: DigitTarget, viaKey = false): void {
    const s = shown
    const f = s && forms.get(s.key)
    if (!s || !f || s.kind !== 'question' || formLocked(f, deps.canMutate())) return
    if (f.status === 'error') f.status = 'idle'
    if (n === 'other') {
      f.picks = chooseOther(f.picks, s.questions, i)
      deps.changed()
      if (f.picks[i]?.otherOn || !s.questions[i]?.multiSelect) deps.focus({ q: i, n: 'other' })
      return
    }
    f.picks = choose(f.picks, s.questions, i, n)
    deps.changed()
    if (instant(s.questions)) return void sendQuestions()
    // A key moves on to the next question, as the terminal does after a single select.
    if (viaKey) {
      const next = !s.questions[i]?.multiSelect && s.questions[i + 1] ? i + 1 : i
      deps.focus({ q: next, n: next === i ? n : 1 })
    }
  }

  return {
    mount,
    view,
    click(target) {
      if (target.kind === 'focus') {
        if (shown) deps.focusSession(shown.it.key)
        return
      }
      if (settling()) return
      if (target.kind === 'send') return void sendQuestions()
      if (target.kind === 'permit') return void sendPermission(target.n)
      if (target.kind === 'reply') return void sendText()
      if (target.kind === 'option') return pick(target.q, target.n)
      // A click into the own answer's field types; a click beside it picks it.
      if (target.inField) {
        const p = shown && forms.get(shown.key)?.picks[target.q]
        if (p && !p.otherOn && p.other.trim()) pick(target.q, 'other')
        return
      }
      pick(target.q, 'other')
    },
    type(q, text) {
      const f = shown && forms.get(shown.key)
      if (!shown || !f || shown.kind !== 'question') return
      if (f.status === 'error') f.status = 'idle'
      f.picks = typeOther(f.picks, shown.questions, q, text)
      deps.changed()
    },
    write(text) {
      const f = shown && forms.get(shown.key)
      if (shown?.kind !== 'input' || !f || formLocked(f, deps.canMutate())) return
      if (f.status === 'error') f.status = 'idle'
      f.text = text
      deps.changed()
    },
    enter() {
      const f = shown && forms.get(shown.key)
      if (shown?.kind === 'input') return void sendText()
      if (shown?.kind === 'question' && f && !remaining(shown.questions, f.picks)) void sendQuestions()
    },
    peekAt(target) {
      const next = target && shown?.kind === 'question' && shown.questions[target.q]?.preview ? target : null
      if (next?.q === peek?.q && next?.n === peek?.n) return
      peek = next
      deps.changed()
    },
    unpeek() {
      if (!peek) return
      peek = null
      deps.changed()
    },
    key(press, focus) {
      if (!shown || press.ctrlKey || press.metaKey || press.altKey || !/^[1-9]$/.test(press.key)) return false
      if (focus.typing || !deps.canMutate()) return false
      // A held key repeats; a dialog that just came up may not be the one the key was meant for.
      if (press.repeat || settling()) return true
      const d = Number(press.key)
      // pi's text input takes digits as text, in its field only.
      if (shown.kind === 'input') return false
      if (shown.kind === 'permission') {
        if (!shown.dialog.options.some(o => o.n === d)) return false
        void sendPermission(d)
        return true
      }
      const f = forms.get(shown.key)
      if (!f) return false
      const i = currentQuestion(shown.questions, f.picks, focus.question)
      const target = digitTarget(shown.questions[i], d)
      if (target === null) return false
      pick(i, target, true)
      return true
    },
  }
}
