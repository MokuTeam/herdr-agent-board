// A login fill an agent asks for (src/core/login-fill.ts), on the board's own server, answered in
// the session sheet: the site its browser has in front (read by the board), the field with the
// focus, what will be typed, the vault's matches once it is open; the vault's master password
// (masked, kept in this form's state only, cleared once the board answers), "keep it unlocked for
// 15 minutes", Fill in or Decline; with several matches, the one to fill in. One POST to
// /api/vault/fill/<id>, which only the domain's login reaches.
import { useState } from 'react'
import type { FillField, LoginFillView } from '../../../../src/core/login-fill.ts'
import type { Item } from '../../../../src/core/types.ts'
import { ApiError, api } from '../../api/client.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { SpinQa } from '../questions/QuestionForm.tsx'

const isView = (v: unknown): v is LoginFillView =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as LoginFillView).id === 'string' &&
  typeof (v as LoginFillView).site === 'string' &&
  Array.isArray((v as LoginFillView).fields)

/** The session's login fills waiting for the owner, as far as the board sent them. */
export const loginFillsOf = (item: Item): LoginFillView[] =>
  Array.isArray(item.loginFill) ? (item.loginFill as unknown[]).filter(isView) : []

/** Every login fill of the session that waits, newest first. */
export function LoginFills({ item }: { item: Item }) {
  const list = loginFillsOf(item)
  if (!list.length) return null
  return (
    <>
      {list
        .slice()
        .reverse()
        .map(r => (
          <LoginFill key={r.id} request={r} />
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

/**
 * A browser that masks a text field by CSS gets one: its own password manager never offers to save
 * the vault's master password for the board's site (as components/secrets/SecretForm.tsx does).
 */
const CSS_MASK =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc')
const MASKED = CSS_MASK ? { type: 'text', className: 'qa-input masked' } : { type: 'password', className: 'qa-input' }

type Status =
  | { kind: 'idle' }
  | { kind: 'sending'; op: 'approve' | 'decline' | 'pick' }
  | { kind: 'error'; text: string }

const hm = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function LoginFill({ request: r }: { request: LoginFillView }) {
  const t = useT()
  const { canEdit, toast, now } = useBoardContext()
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [keep, setKeep] = useState(false)
  const [picked, setPicked] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const sending = status.kind === 'sending'
  const expired = now >= r.expires
  const busy = r.stage === 'busy'
  const locked = !canEdit || sending || expired || busy
  const unlocked = r.unlockedUntil !== null && r.unlockedUntil > now
  const picking = r.stage === 'pick' && !!r.matches && r.matches.length > 1
  const ready = picking ? !!picked : unlocked || !!password
  const word = (f: FillField): string => t(`fill.form.f.${f}`)
  const typed = [
    ...r.fields.flatMap((f, i) => (i ? [t('fill.form.tab'), word(f)] : [word(f)])),
    ...(r.submit ? [t('fill.form.enter')] : []),
  ]

  const send = async (op: 'approve' | 'decline' | 'pick') => {
    setStatus({ kind: 'sending', op })
    try {
      const reply = await api.post(
        `/api/vault/fill/${r.id}`,
        op === 'approve'
          ? { op, ...(unlocked ? {} : { password }), ...(code.trim() && { code: code.trim() }), keep }
          : op === 'pick'
            ? { op, item: picked }
            : { op },
      )
      setPassword('')
      setCode('')
      setStatus({ kind: 'idle' })
      const result = typeof reply.result === 'string' ? reply.result : ''
      if (op === 'decline') toast(t('fill.form.declined'))
      else if (result === 'ok') toast(t('fill.form.filled', { site: r.site }))
      else if (result === 'nomatch') toast(t('fill.form.nomatch', { site: r.site }))
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
        if (!locked && ready) void send(picking ? 'pick' : 'approve')
      }}
    >
      <b>{t('fill.form.why')}</b>
      <div className="qa-q">
        <p className="qa-text">
          {t('fill.form.site')} <strong>{r.site}</strong>
        </p>
        <div className="secret-where">
          {r.title && <span className="secret-sink">{r.title}</span>}
          <span className="qa-desc">{t('fill.form.field', { field: t(`fill.form.field.${r.field}`) })}</span>
          <span className="qa-desc">
            {t('fill.form.types')}: {typed.join(' → ')}
          </span>
          {r.username && <span className="qa-desc">{t('fill.form.user', { username: r.username })}</span>}
        </div>
      </div>
      {picking ? (
        <fieldset className="qa-opts login-fill-matches">
          <legend className="qa-desc">{t('fill.form.pick')}</legend>
          {r.matches?.map(m => (
            <label key={m.id} className="qa-opt">
              <input
                type="radio"
                name={`fill-${r.id}`}
                value={m.id}
                checked={picked === m.id}
                disabled={locked}
                onChange={() => setPicked(m.id)}
              />
              <span>
                {m.name || t('fill.form.noName')} · {m.username || t('fill.form.noUser')}
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <div className="qa-opts secret-fields">
          {r.matches ? (
            <p className="qa-desc">
              {t('fill.form.matches')}:{' '}
              {r.matches.length
                ? r.matches
                    .map(m => `${m.name || t('fill.form.noName')} · ${m.username || t('fill.form.noUser')}`)
                    .join('; ')
                : t('fill.form.nomatch', { site: r.site })}
            </p>
          ) : (
            <p className="qa-desc">{t('fill.form.matchesLater')}</p>
          )}
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
      )}
      <p className="qa-desc secret-never">{t('fill.form.never')}</p>
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
          <span>{t('fill.form.approve')}</span>
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
