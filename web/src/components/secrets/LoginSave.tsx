// A login the owner typed in an agent's browser, offered to their vault (src/core/login-save.ts),
// on the board's own server, answered in the session sheet: the site they signed in on and the
// username (read by the board), whether it is a new login or a password to update; the vault's
// master password (masked, kept in this form's state only, cleared once the board answers), "keep
// it unlocked for 15 minutes", Save or Decline. One POST to /api/vault/save/<id>, which only the
// domain's login reaches. The password the owner typed is never shown here, nor anywhere but the
// board's own memory until they answer.
import { useState } from 'react'
import type { LoginSaveView } from '../../../../src/core/login-save.ts'
import type { Item } from '../../../../src/core/types.ts'
import { ApiError, api } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { SpinQa } from '../questions/QuestionForm.tsx'

const isView = (v: unknown): v is LoginSaveView =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as LoginSaveView).id === 'string' &&
  typeof (v as LoginSaveView).site === 'string' &&
  typeof (v as LoginSaveView).kind === 'string'

/** The session's login saves waiting for the owner, as far as the board sent them. */
export const loginSavesOf = (item: Item): LoginSaveView[] =>
  Array.isArray(item.loginSave) ? (item.loginSave as unknown[]).filter(isView) : []

/** Every login save of the session that waits, newest first. */
export function LoginSaves({ item }: { item: Item }) {
  const list = loginSavesOf(item)
  if (!list.length) return null
  return (
    <>
      {list
        .slice()
        .reverse()
        .map(r => (
          <LoginSave key={r.id} request={r} />
        ))}
    </>
  )
}

/** These keep the master password out of the browser's spelling service, autofill and password managers. */
const QUIET = {
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
} as const

const CSS_MASK =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc')
const MASKED = CSS_MASK ? { type: 'text', className: 'qa-input masked' } : { type: 'password', className: 'qa-input' }

type Status = { kind: 'idle' } | { kind: 'sending'; op: 'approve' | 'decline' } | { kind: 'error'; text: string }

const hm = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function LoginSave({ request: r }: { request: LoginSaveView }) {
  const t = useT()
  const { canEdit, toast, now } = useBoardContext()
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [keep, setKeep] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const sending = status.kind === 'sending'
  const expired = now >= r.expires
  const busy = r.stage === 'busy'
  const locked = !canEdit || sending || expired || busy
  const unlocked = r.unlockedUntil !== null && r.unlockedUntil > now
  const ready = unlocked || !!password
  const note =
    r.kind === 'new' ? t('save.form.new') : r.kind === 'update' ? t('save.form.update') : t('save.form.unknown')

  const send = async (op: 'approve' | 'decline') => {
    setStatus({ kind: 'sending', op })
    try {
      const reply = await api.post(
        `/api/vault/save/${r.id}`,
        op === 'approve'
          ? { op, ...(unlocked ? {} : { password }), ...(code.trim() && { code: code.trim() }), keep }
          : { op },
      )
      setPassword('')
      setCode('')
      setStatus({ kind: 'idle' })
      const result = typeof reply.result === 'string' ? reply.result : ''
      if (op === 'decline') toast(t('fill.form.declined'))
      else if (result === 'saved') toast(t('save.form.saved', { site: r.site }))
      else if (result === 'updated') toast(t('save.form.updated', { site: r.site }))
      else if (result === 'same') toast(t('save.form.same'))
    } catch (err) {
      const text =
        err instanceof ApiError && typeof err.reply.error === 'string' ? err.reply.error : t('fill.err.internal')
      // a wrong password is asked again, never kept for another try
      setPassword('')
      setStatus({ kind: 'error', text })
    }
  }

  const lockNow = async () => {
    try {
      await api.post('/api/vault/lock', {})
    } catch {}
  }

  return (
    <form
      className={classNames(
        'asked',
        'qa',
        'secret',
        'login-fill',
        (sending || busy) && 'busy',
        !canEdit && 'read-only',
      )}
      aria-busy={sending || busy}
      autoComplete="off"
      onSubmit={e => {
        e.preventDefault()
        if (!locked && ready) void send('approve')
      }}
    >
      <b>{t('save.form.why')}</b>
      <div className="qa-q">
        <p className="qa-text">
          {t('save.form.site')} <strong>{r.site}</strong>
        </p>
        <div className="secret-where">
          <span className="qa-desc">{t('save.form.user', { username: r.username || t('save.form.noUser') })}</span>
          <span className="qa-desc">{note}</span>
        </div>
      </div>
      <div className="qa-opts secret-fields">
        {unlocked ? (
          <p className="qa-desc">
            {t('fill.form.unlocked', { time: hm(r.unlockedUntil as number) })}{' '}
            <button type="button" className="button" disabled={!canEdit} onClick={() => void lockNow()}>
              {t('fill.form.lock')}
            </button>
          </p>
        ) : (
          <>
            <label className="qa-opt qa-other secret-field">
              <span className="secret-label">
                {t('fill.form.master')}
                <small>{t('fill.form.masterHint')}</small>
              </span>
              <input
                {...MASKED}
                value={password}
                disabled={locked}
                aria-label={t('fill.form.master')}
                {...QUIET}
                onChange={e => setPassword(e.target.value)}
              />
            </label>
            {r.firstLogin && (
              <label className="qa-opt qa-other secret-field">
                <span className="secret-label">{t('fill.form.code')}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className="qa-input"
                  value={code}
                  disabled={locked}
                  aria-label={t('fill.form.code')}
                  {...QUIET}
                  onChange={e => setCode(e.target.value)}
                />
              </label>
            )}
            <label className="qa-opt">
              <input type="checkbox" checked={keep} disabled={locked} onChange={e => setKeep(e.target.checked)} />
              <span>{t('fill.form.keep')}</span>
            </label>
          </>
        )}
      </div>
      <p className="qa-desc secret-never">{t('save.form.never')}</p>
      <div className="qa-foot">
        <span className="qa-hint">
          {expired ? t('fill.form.expired') : t('fill.form.until', { time: hm(r.expires) })}
          {!canEdit && ` · ${t('fill.form.readOnly')}`}
        </span>
        <button type="button" className="button" disabled={locked} onClick={() => void send('decline')}>
          {sending && status.op === 'decline' && <SpinQa />}
          <span>{t('fill.form.decline')}</span>
        </button>
        <button type="submit" className="button primary qa-send" disabled={locked || !ready}>
          {((sending && status.op !== 'decline') || busy) && <SpinQa />}
          <span>{r.kind === 'update' ? t('save.form.updateBtn') : t('save.form.save')}</span>
        </button>
      </div>
      {(status.kind === 'error' || r.error) && (
        <div className="qa-status error" role="alert">
          <span>{status.kind === 'error' ? status.text : r.error}</span>
        </div>
      )}
    </form>
  )
}
