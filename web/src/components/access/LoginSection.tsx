// The Remote access panel's Login part: the password (set on the local board only, no old one
// asked), the authenticator code (its QR code and key from totp-begin's own answer, kept only until
// a code checks out or the setup is closed), the passkeys (added on the device through the domain,
// listed and removed here) and a lockout of password sign-in, lifted here. Changing the password or
// setting the code up again ends every login, and the form says so first. What is open or asked
// (`ask`) the panel keeps, one thing at a time.
import type { KeyboardEvent, ReactNode } from 'react'
import type { AccessView } from '../../../../src/core/access.ts'
import type { AccessSend } from '../../hooks/useAccess.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import { groupKey, type LoginAsk, lockoutLine, passkeyHint, passkeyLine } from '../../models/access.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { Qr } from '../Qr.tsx'

export interface LoginPartProps {
  view: AccessView
  send: AccessSend
  /** What the part has open or asks (the panel keeps it). */
  ask: LoginAsk
  onAsk(ask: LoginAsk): void
}

export interface TwoClicksProps {
  /** Clicked once: the next click does it. */
  armed: boolean
  label: string
  sure: string
  disabled: boolean
  onArm(): void
  onDisarm(): void
  onSure(): void
}

/** A button that acts on its second click, as the Phones panel's Unpair; leaving it takes the first back. */
export function TwoClicks({ armed, label, sure, disabled, onArm, onDisarm, onSure }: TwoClicksProps) {
  return (
    <button
      type="button"
      className={classNames('button', armed && 'primary')}
      disabled={disabled}
      onBlur={() => {
        if (armed) onDisarm()
      }}
      onClick={() => {
        if (!armed) return onArm()
        onDisarm()
        onSure()
      }}
    >
      {armed ? sure : label}
    </button>
  )
}

/** One of the login's settings: its name, where it stands, and its button while its form is closed. */
function Setting({ name, is, children }: { name: string; is: string; children?: ReactNode }) {
  return (
    <div className="access-setting">
      <span className="access-name">{name}</span>
      <span className="access-is">{is}</span>
      {children}
    </div>
  )
}

export function LoginSection({ view, send, ask, onAsk }: LoginPartProps) {
  const t = useT()
  const { canEdit, now } = useBoardContext()
  const { password, totp, passkeys, lockout } = view.login
  const typing = ask?.kind === 'password' ? ask : null
  const setup = ask?.kind === 'totp' ? ask : null

  /** Escape in a form's field closes the form; the panel stays open. */
  const closeOnEscape = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    onAsk(null)
  }

  async function savePassword(typed: string): Promise<void> {
    const reply = await send('password', { password: typed })
    if (reply?.ok === true) onAsk(null)
  }

  /** A new secret, shown until a code checks out or the setup is closed; the board keeps it 10 minutes meanwhile. */
  async function beginTotp(): Promise<void> {
    const reply = await send('totp-begin')
    if (reply?.ok === true && typeof reply.secret === 'string' && typeof reply.uri === 'string')
      onAsk({ kind: 'totp', secret: reply.secret, uri: reply.uri, code: '' })
  }

  async function confirmTotp(code: string): Promise<void> {
    // As an app shows it, "123 456", or pasted with spaces.
    const reply = await send('totp-confirm', { code: code.replace(/\s/g, '') })
    if (reply?.ok === true) onAsk(null)
  }

  return (
    <section className="access-login">
      <h3 className="access-head">{t('access.login')}</h3>

      <Setting name={t('access.password')} is={password ? t('access.passwordOn') : t('access.passwordOff')}>
        {!typing && (
          <button
            type="button"
            className="button"
            disabled={!canEdit}
            onClick={() => onAsk({ kind: 'password', typed: '' })}
          >
            {password ? t('access.passwordChange') : t('access.passwordSet')}
          </button>
        )}
      </Setting>
      {typing && (
        <form
          className="access-form"
          onSubmit={e => {
            e.preventDefault()
            void savePassword(typing.typed)
          }}
        >
          {password && <p className="access-sure">{t('access.passwordEnds')}</p>}
          <div className="access-actions">
            <input
              className="path-add access-input"
              type="password"
              name="password"
              autoComplete="new-password"
              aria-label={t('access.passwordNew')}
              placeholder={t('access.passwordNew')}
              value={typing.typed}
              disabled={!canEdit}
              onChange={e => onAsk({ kind: 'password', typed: e.currentTarget.value })}
              onKeyDown={closeOnEscape}
            />
            <button type="submit" className="button primary" disabled={!canEdit}>
              {t('access.save')}
            </button>
            <button type="button" className="button" onClick={() => onAsk(null)}>
              {t('access.cancel')}
            </button>
          </div>
          <p className="access-tip">{t('access.err.password')}</p>
        </form>
      )}

      <Setting name={t('access.totp')} is={totp ? t('access.totpOn') : t('access.totpOff')}>
        {!setup && (
          <button type="button" className="button" disabled={!canEdit} onClick={() => void beginTotp()}>
            {totp ? t('access.totpAgain') : t('access.totpSetUp')}
          </button>
        )}
      </Setting>
      {setup && (
        <form
          className="access-form"
          onSubmit={e => {
            e.preventDefault()
            void confirmTotp(setup.code)
          }}
        >
          {totp && <p className="access-sure">{t('access.totpEnds')}</p>}
          <p className="access-tip">{t('access.totpScan')}</p>
          <Qr text={setup.uri} className="access-qr" />
          <p className="access-line">
            <span>{t('access.totpKey')}</span>
            <code className="access-code access-secret">{groupKey(setup.secret)}</code>
          </p>
          <div className="access-actions">
            <input
              className="path-add access-input"
              type="text"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label={t('access.totpCode')}
              placeholder={t('access.totpCode')}
              value={setup.code}
              disabled={!canEdit}
              onChange={e => onAsk({ ...setup, code: e.currentTarget.value })}
              onKeyDown={closeOnEscape}
            />
            <button type="submit" className="button primary" disabled={!canEdit}>
              {t('access.check')}
            </button>
            <button type="button" className="button" onClick={() => onAsk(null)}>
              {t('access.cancel')}
            </button>
          </div>
        </form>
      )}

      <h3 className="access-head">{t('access.passkeys')}</h3>
      {passkeys.length === 0 ? (
        <p className="sheet-meta access-none">{t('access.passkeysNone')}</p>
      ) : (
        <ul className="access-rows">
          {passkeys.map(p => (
            <li className="access-row" key={p.id}>
              <div className="access-about">
                <strong className="access-label">{p.label}</strong>
                <span className="access-meta">{passkeyLine(p, t, now)}</span>
              </div>
              <TwoClicks
                armed={ask?.kind === 'passkey' && ask.id === p.id}
                label={t('access.remove')}
                sure={t('access.removeSure')}
                disabled={!canEdit}
                onArm={() => onAsk({ kind: 'passkey', id: p.id })}
                onDisarm={() => onAsk(null)}
                onSure={() => void send('passkey-remove', { id: p.id })}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="access-tip">{passkeyHint(view.tunnel.settings.domain, t)}</p>

      {lockout && (
        <div className="access-lockout">
          <p className="access-lock">{lockoutLine(lockout.until, t, now)}</p>
          <button type="button" className="button" disabled={!canEdit} onClick={() => void send('lockout-lift')}>
            {t('access.lift')}
          </button>
        </div>
      )}
    </section>
  )
}
