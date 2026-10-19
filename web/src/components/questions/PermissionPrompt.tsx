// A permission prompt answered from the sheet (the old page's questions.js permissionHTML and
// sync): what the tool will do, the terminal's own choices by their tone (allow, allow for good,
// refuse), and how the choice went. The prompt is known by its fingerprint (models/questions.ts).
import { useT } from '../../i18n/I18nProvider.tsx'
import { permissionTone } from '../../models/question-model.ts'
import { type FormState, formBusy, formLocked, type Shown } from '../../models/questions.ts'
import { classNames } from '../class-names.ts'
import { type FormActions, QaStatus, SpinQa } from './QuestionForm.tsx'

export interface PermissionPromptProps {
  shown: Extract<Shown, { kind: 'permission' }>
  form: FormState
  canMutate: boolean
  on?: Pick<FormActions, 'click'>
}

export function PermissionPrompt({ shown, form, canMutate, on = { click() {} } }: PermissionPromptProps) {
  const t = useT()
  const d = shown.dialog
  const body = d.body.join('\n').trim()
  const locked = formLocked(form, canMutate)
  return (
    <div
      className={classNames('asked', 'qa', 'perm', formBusy(form) && 'busy', !canMutate && 'read-only')}
      aria-busy={form.status === 'sending'}
    >
      <b>{t('why.permission')}</b>
      {d.title && <div className="perm-title">{d.title}</div>}
      {body && <pre className="perm-body">{body}</pre>}
      {d.more ? <div className="perm-more">{t('qa.perm.more', { n: d.more })}</div> : null}
      <p className="qa-text">{d.prompt}</p>
      <div className="qa-opts">
        {d.options.map(o => {
          const chosen = form.chosen === o.n
          return (
            <button
              key={o.n}
              type="button"
              className={classNames('qa-opt', 'perm-opt', permissionTone(o.label), chosen && 'chosen')}
              data-perm={o.n}
              data-focus-id={`p.${o.n}`}
              disabled={locked}
              onClick={() => on.click({ kind: 'permit', n: o.n })}
            >
              <span className="qa-n" aria-hidden="true">
                {o.n}
              </span>
              <span className="qa-body">
                <span className="qa-label">{o.label}</span>
              </span>
              {chosen && form.status === 'sending' && <SpinQa />}
            </button>
          )
        })}
      </div>
      <QaStatus form={form} canMutate={canMutate} onClick={on.click} />
    </div>
  )
}
