// A question form (AskUserQuestion) answered from the sheet (the old page's questions.js
// questionHTML and sync): each question with its header, its kind and step, its options with
// their descriptions and an own answer (or the option's preview under it), the send button and
// the keys hint, and how the answer went. What is picked and sent is models/question-desk.ts's.
import type { ReactNode } from 'react'
import { useT } from '../../i18n/I18nProvider.tsx'
import type { FormClick, QuestionDesk } from '../../models/question-desk.ts'
import {
  type FormState,
  formBusy,
  formHint,
  formLocked,
  optionOn,
  type Peek,
  previewText,
  type Shown,
  sendButton,
} from '../../models/questions.ts'
import { classNames } from '../class-names.ts'

/** What the form does with the user's clicks and keys (the desk). */
export type FormActions = Pick<QuestionDesk, 'click' | 'type' | 'enter' | 'peekAt' | 'unpeek'>

const NO_ACTIONS: FormActions = { click() {}, type() {}, enter() {}, peekAt() {}, unpeek() {} }

function QaGlyph({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      {children}
    </svg>
  )
}

export const SpinQa = () => (
  <QaGlyph className="spin">
    <path d="M10 3a7 7 0 1 1-7 7" />
  </QaGlyph>
)

const CheckQa = () => (
  <QaGlyph>
    <path d="m4.5 10.5 3.5 3.5 7.5-8" />
  </QaGlyph>
)

const FocusQa = () => (
  <QaGlyph>
    <path d="M7 4.5h8.5V13M15 5 5 15" />
  </QaGlyph>
)

/** How it went: on its way, done, or why not, with a way to the terminal. */
export function QaStatus({
  form,
  canMutate,
  onClick,
}: {
  form: FormState
  canMutate: boolean
  onClick: (target: FormClick) => void
}) {
  const t = useT()
  if (form.status === 'sending')
    return (
      <div className="qa-status" role="status">
        <SpinQa />
        <span>{t('qa.sending')}</span>
      </div>
    )
  if (form.status === 'sent')
    return (
      <div className="qa-status ok" role="status">
        <CheckQa />
        <span>{t('qa.sent')}</span>
      </div>
    )
  if (form.status !== 'error') return <div className="qa-status" role="status" hidden />
  // stopped: keys went in before it stopped, so the dialog may be partly filled in.
  return (
    <div className={classNames('qa-status', 'error', form.stopped && 'stopped')} role="alert">
      <b>{t(form.stopped ? 'qa.stopped' : 'qa.failed')}</b>
      <span>{form.error}</span>
      <button
        type="button"
        className="button"
        data-qa-focus=""
        disabled={!canMutate}
        onClick={() => onClick({ kind: 'focus' })}
      >
        <FocusQa />
        <span>{t('sheet.focus')}</span>
      </button>
      {form.screen && (
        <details className="qa-screen">
          <summary>{t('qa.screen')}</summary>
          <pre className="screen">{form.screen}</pre>
        </details>
      )}
    </div>
  )
}

type QuestionShown = Extract<Shown, { kind: 'question' }>

export interface QuestionFormProps {
  shown: QuestionShown
  form: FormState
  peek: Peek | null
  /** Fresh herdr data: else the form is read only. */
  canMutate: boolean
  /** A keyboard to press the digits on (pointer: fine). */
  pointerFine: boolean
  on?: FormActions
}

/** The option under the pointer or the focus, when it is one of a question's buttons. */
function peekOf(target: EventTarget): Peek | null {
  const opt = target instanceof Element ? target.closest('button.qa-opt[data-q]') : null
  return opt ? { q: Number(opt.getAttribute('data-q')), n: Number(opt.getAttribute('data-n')) } : null
}

export function QuestionForm({ shown, form, peek, canMutate, pointerFine, on = NO_ACTIONS }: QuestionFormProps) {
  const t = useT()
  const { questions } = shown
  const busy = formBusy(form)
  const send = sendButton(questions, form, canMutate, t)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the preview follows the pointer and the focus over the options
    <div
      className={classNames('asked', 'qa', busy && 'busy', !canMutate && 'read-only')}
      aria-busy={form.status === 'sending'}
      onPointerOver={e => on.peekAt(peekOf(e.target))}
      onFocus={e => on.peekAt(peekOf(e.target))}
      onPointerLeave={() => on.unpeek()}
    >
      <b>{t('why.choice', { n: questions.length })}</b>
      {questions.map((_q, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the form's questions in their order
        <Question key={i} i={i} {...{ shown, form, peek, canMutate, on }} />
      ))}
      <div className="qa-foot">
        <span className="qa-hint" aria-live="polite">
          {formHint(questions, form.picks, canMutate, pointerFine, t)}
        </span>
        <button
          type="button"
          className="button primary qa-send"
          data-qa-send=""
          disabled={send.disabled}
          hidden={send.hidden}
          title={send.title}
          onClick={() => on.click({ kind: 'send' })}
        >
          {busy && <SpinQa />}
          <span>{send.label}</span>
        </button>
      </div>
      <QaStatus form={form} canMutate={canMutate} onClick={on.click} />
    </div>
  )
}

interface QuestionProps {
  i: number
  shown: QuestionShown
  form: FormState
  peek: Peek | null
  canMutate: boolean
  on: FormActions
}

function Question({ i, shown, form, peek, canMutate, on }: QuestionProps) {
  const t = useT()
  const q = shown.questions[i]
  if (!q) return null
  const pick = form.picks[i]
  const locked = formLocked(form, canMutate)
  const id = `qa-q-${i}`
  const many = shown.questions.length > 1
  const preview = q.preview ? previewText(q, pick, i, peek) : ''
  return (
    <section className="qa-q" data-q={i}>
      <div className="qa-head">
        {q.header && <span className="qa-tag">{q.header}</span>}
        <span className="qa-kind">{t(q.multiSelect ? 'qa.any' : 'qa.one')}</span>
        {many && (
          <span className="qa-step">
            {i + 1}/{shown.questions.length}
          </span>
        )}
      </div>
      <p className="qa-text" id={id}>
        {q.question}
      </p>
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: a group or a radiogroup, by the question's kind: both take a label */}
      <div className="qa-opts" role={q.multiSelect ? 'group' : 'radiogroup'} aria-labelledby={id}>
        {q.options.map((o, j) => {
          const n = j + 1
          const on_ = optionOn(q, pick, n)
          return (
            // biome-ignore lint/a11y/useAriaPropsSupportedByRole: a checkbox or a radio, by the question's kind: both are checked
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: the options in their order (the terminal's numbers)
              key={j}
              type="button"
              className={classNames('qa-opt', on_ && 'on')}
              role={q.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={on_}
              data-q={i}
              data-n={n}
              data-focus-id={`${i}.${n}`}
              disabled={locked}
              onClick={() => on.click({ kind: 'option', q: i, n })}
            >
              <span className="qa-n" aria-hidden="true">
                {n}
              </span>
              <span className="qa-body">
                <span className="qa-label">{o.label}</span>
                {o.description && <span className="qa-desc">{o.description}</span>}
              </span>
              <span className="qa-mark" aria-hidden="true" />
            </button>
          )
        })}
        {!q.preview && (
          // biome-ignore lint/a11y/noStaticElementInteractions: a click beside the own answer's field picks it; keys go to the field or the digits
          // biome-ignore lint/a11y/useKeyWithClickEvents: as above
          <div
            className={classNames('qa-opt', 'qa-other', optionOn(q, pick, 'other') && 'on')}
            data-q={i}
            data-n="other"
            onClick={e =>
              on.click({ kind: 'other', q: i, inField: e.target instanceof Element && !!e.target.closest('.qa-input') })
            }
          >
            <span className="qa-n" aria-hidden="true">
              {q.options.length + 1}
            </span>
            <input
              className="qa-input"
              data-q={i}
              data-focus-id={`${i}.other`}
              maxLength={1000}
              placeholder={t('qa.otherHint')}
              aria-label={t('qa.other')}
              autoComplete="off"
              disabled={locked}
              value={pick?.other ?? ''}
              onChange={e => on.type(i, e.target.value)}
              onKeyDown={e => {
                if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                e.preventDefault()
                on.enter()
              }}
            />
            <span className="qa-mark" aria-hidden="true" />
          </div>
        )}
      </div>
      {q.preview && (
        <pre className="qa-preview" data-q={i} hidden={!preview}>
          {preview}
        </pre>
      )}
    </section>
  )
}
