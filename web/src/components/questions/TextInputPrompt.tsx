// pi's text input answered from the sheet (src/core/dialogs/pi-dialogs.ts): what it asks, a field
// for one line, and how it went. The board types the line into the terminal's field and presses
// Enter once the field shows it; the input is known by its fingerprint (models/questions.ts).
import { useT } from '../../i18n/I18nProvider.tsx'
import type { QuestionDesk } from '../../models/question-desk.ts'
import { type FormState, formBusy, formLocked, type Shown } from '../../models/questions.ts'
import { classNames } from '../class-names.ts'
import { QaStatus, SpinQa } from './QuestionForm.tsx'

/** What the prompt does with the user's typing and clicks (the desk). */
export type InputActions = Pick<QuestionDesk, 'click' | 'write' | 'enter'>

export interface TextInputPromptProps {
  shown: Extract<Shown, { kind: 'input' }>
  form: FormState
  canMutate: boolean
  on?: InputActions
}

const NO_ACTIONS: InputActions = { click() {}, write() {}, enter() {} }

export function TextInputPrompt({ shown, form, canMutate, on = NO_ACTIONS }: TextInputPromptProps) {
  const t = useT()
  const d = shown.dialog
  const body = d.body.join('\n').trim()
  const locked = formLocked(form, canMutate)
  const busy = formBusy(form)
  return (
    <div
      className={classNames('asked', 'qa', 'perm', 'pi-input', busy && 'busy', !canMutate && 'read-only')}
      aria-busy={form.status === 'sending'}
    >
      <b>{t('why.input')}</b>
      {d.cut && <div className="perm-more">{t('qa.cut')}</div>}
      {d.title && <div className="perm-title">{d.title}</div>}
      {body && <pre className="perm-body">{body}</pre>}
      {d.more ? <div className="perm-more">{t('qa.perm.more', { n: d.more })}</div> : null}
      <div className="qa-opts">
        <div className="qa-opt qa-other">
          <input
            className="qa-input"
            data-focus-id="input"
            maxLength={1000}
            placeholder={t('qa.inputHint')}
            aria-label={d.title || t('why.input')}
            autoComplete="off"
            disabled={locked}
            value={form.text}
            onChange={e => on.write(e.target.value)}
            onKeyDown={e => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
              e.preventDefault()
              on.enter()
            }}
          />
        </div>
      </div>
      <div className="qa-foot">
        <span className="qa-hint" />
        <button
          type="button"
          className="button primary qa-send"
          data-qa-reply=""
          disabled={locked || !form.text.trim()}
          onClick={() => on.click({ kind: 'reply' })}
        >
          {busy && <SpinQa />}
          <span>{t('qa.send', { n: 1 })}</span>
        </button>
      </div>
      <QaStatus form={form} canMutate={canMutate} onClick={on.click} />
    </div>
  )
}
