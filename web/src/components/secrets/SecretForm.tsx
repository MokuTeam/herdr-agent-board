// A secret an agent asks for (#273, src/core/secrets.ts), filled in the session sheet: where the
// values go first, then a field for each, masked unless the request shows it as typed. The values
// live in this form's state only and go in one POST to /api/secret/<id>, which writes the sink (the
// board's own store, Settings → Secrets…, where config.json defines none); they are cleared once it
// answers. Decline answers the agent without a write.
import { useState } from 'react'
import type { SecretView } from '../../../../src/core/secrets.ts'
import type { Item } from '../../../../src/core/types.ts'
import { ApiError, api } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { SpinQa } from '../questions/QuestionForm.tsx'

const isView = (v: unknown): v is SecretView =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as SecretView).id === 'string' &&
  typeof (v as SecretView).fingerprint === 'string' &&
  Array.isArray((v as SecretView).fields)

/** The session's pending requests, as far as the board sent them. */
export const secretsOf = (item: Item): SecretView[] =>
  Array.isArray(item.secrets) ? (item.secrets as unknown[]).filter(isView) : []

/** Every pending request of the session, newest first. */
export function SecretRequests({ item }: { item: Item }) {
  const list = secretsOf(item)
  if (!list.length) return null
  return (
    <>
      {list
        .slice()
        .reverse()
        .map(r => (
          <SecretForm key={r.id} request={r} />
        ))}
    </>
  )
}

/** These keep a typed value out of the browser's spelling service, autofill and password managers. */
const QUIET = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
} as const

/**
 * A browser that masks a text field by CSS gets one: its own password manager never offers to save
 * a token as a password once the form goes away (`autocomplete` does not stop it for a password
 * field). Elsewhere a password field.
 */
const CSS_MASK =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc')
const maskProps = (masked: boolean) =>
  masked
    ? CSS_MASK
      ? { type: 'text', className: 'qa-input masked' }
      : { type: 'password', className: 'qa-input' }
    : { type: 'text', className: 'qa-input' }

type Status = { kind: 'idle' } | { kind: 'sending'; op: 'submit' | 'decline' } | { kind: 'error'; text: string }

function SecretForm({ request: r }: { request: SecretView }) {
  const t = useT()
  const { canEdit, toast, now } = useBoardContext()
  const [values, setValues] = useState<Record<string, string>>({})
  const [session, setSession] = useState('')
  // a field the owner turned the other way: shown when the request masks it, masked when it shows it
  const [flipped, setFlipped] = useState<Record<string, boolean>>({})
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const sending = status.kind === 'sending'
  const expired = now >= r.expires
  const locked = !canEdit || sending || expired
  const broken = !!r.problem
  const ready =
    !broken &&
    (r.kind === 'bitwarden'
      ? !!session.trim() && r.fields.some(f => (values[f.name] ?? '').trim())
      : r.fields.every(f => (values[f.name] ?? '').trim()))
  // the store's scope is in its line already (where it goes, for whom): no session id to read
  const params = r.kind === 'store' ? [] : Object.entries(r.params)

  const send = async (op: 'submit' | 'decline') => {
    setStatus({ kind: 'sending', op })
    try {
      const reply = await api.post(
        `/api/secret/${r.id}`,
        op === 'decline'
          ? { op }
          : { op, values, fingerprint: r.fingerprint, ...(r.kind === 'bitwarden' && { session }) },
      )
      setValues({})
      setSession('')
      setStatus({ kind: 'idle' })
      toast(
        op === 'decline'
          ? t('secret.form.declined')
          : t('secret.form.written', { target: typeof reply.target === 'string' ? reply.target : r.where }),
      )
    } catch (err) {
      const text =
        err instanceof ApiError && typeof err.reply.error === 'string' ? err.reply.error : t('secret.err.internal')
      // a failed write keeps what was typed, for another try; a Bitwarden session is asked again
      setSession('')
      setStatus({ kind: 'error', text })
    }
  }

  return (
    <form
      className={classNames('asked', 'qa', 'secret', sending && 'busy', !canEdit && 'read-only')}
      aria-busy={sending}
      autoComplete="off"
      onSubmit={e => {
        e.preventDefault()
        if (!locked && ready) void send('submit')
      }}
    >
      <b>{t('secret.form.why')}</b>
      <div className="qa-q">
        <p className="qa-text">{r.title}</p>
        <div className="secret-where">
          <span className="qa-tag">{t(`secret.form.kind.${r.kind}`)}</span>
          {r.sinkTitle && <span className="secret-sink">{r.sinkTitle}</span>}
          {r.where && <code className="secret-path">{r.where}</code>}
          {r.detail && <span className="qa-desc">{r.detail}</span>}
          {params.length > 0 && (
            <span className="qa-desc">
              {t('secret.form.params')}: {params.map(([k, v]) => `${k} = ${v}`).join(', ')}
            </span>
          )}
        </div>
      </div>
      {broken ? (
        <div className="qa-status error" role="alert">
          <span>{r.problem}</span>
        </div>
      ) : (
        <div className="qa-opts secret-fields">
          {r.fields.map(f => {
            const masked = f.hidden !== !!flipped[f.name]
            return (
              <label key={f.name} className="qa-opt qa-other secret-field">
                <span className="secret-label">
                  {f.name}
                  {f.once && <small>{t('secret.form.once')}</small>}
                </span>
                <input
                  {...maskProps(masked)}
                  value={values[f.name] ?? ''}
                  disabled={locked}
                  aria-label={f.name}
                  {...QUIET}
                  onChange={e => setValues(v => ({ ...v, [f.name]: e.target.value }))}
                />
                <button
                  type="button"
                  className="button secret-eye"
                  aria-pressed={!masked}
                  disabled={locked}
                  onClick={() => setFlipped(s => ({ ...s, [f.name]: !s[f.name] }))}
                >
                  {masked ? t('secret.form.show') : t('secret.form.hide')}
                </button>
              </label>
            )
          })}
          {r.kind === 'bitwarden' && (
            <label className="qa-opt qa-other secret-field">
              <span className="secret-label">
                {t('secret.form.session')}
                <small>{t('secret.form.sessionHint')}</small>
              </span>
              <input
                {...maskProps(true)}
                value={session}
                disabled={locked}
                aria-label={t('secret.form.session')}
                {...QUIET}
                onChange={e => setSession(e.target.value)}
              />
            </label>
          )}
        </div>
      )}
      <p className="qa-desc secret-never">
        {t(r.kind === 'store' ? 'secret.form.neverStore' : 'secret.form.never')} {t('secret.form.asTyped')}
      </p>
      <div className="qa-foot">
        <span className="qa-hint">
          {expired
            ? t('secret.form.expired')
            : t('secret.form.until', {
                time: new Date(r.expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              })}
          {!canEdit && ` · ${t('secret.form.readOnly')}`}
        </span>
        <button type="button" className="button" disabled={locked} onClick={() => void send('decline')}>
          {sending && status.op === 'decline' && <SpinQa />}
          <span>{t('secret.form.decline')}</span>
        </button>
        <button type="submit" className="button primary qa-send" disabled={locked || !ready}>
          {sending && status.op === 'submit' && <SpinQa />}
          <span>{t('secret.form.write')}</span>
        </button>
      </div>
      {status.kind === 'error' && (
        <div className="qa-status error" role="alert">
          <span>{status.text}</span>
        </div>
      )}
    </form>
  )
}
