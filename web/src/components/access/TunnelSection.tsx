// The Remote access panel's Tunnel part: what a login reaches, where the tunnel stands (with since
// when, a failed probe through the domain, the ssh it runs), On or Off, Test connection and its
// steps, the settings (saved when a field is left or on Enter, as the Profiles panel's; Escape
// puts the board's value back), the key, and the server's snippets. A new domain while passkeys or
// logins exist, and a new key over the one there, are asked first (`ask`, kept by the panel).
import type { FocusEvent, KeyboardEvent } from 'react'
import type { AccessView } from '../../../../src/core/access.ts'
import { type TestStep, TUNNEL_SOCKET, type TunnelField } from '../../../../src/core/tunnel.ts'
import { keysLine } from '../../../../src/core/tunnel-snippets.ts'
import type { AccessSend } from '../../hooks/useAccess.ts'
import { useT } from '../../i18n/I18nProvider.tsx'
import {
  fieldEdit,
  hintText,
  PORT_FIELDS,
  statusLine,
  stepLine,
  TUNNEL_FIELDS,
  type TunnelAsk,
} from '../../models/access.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { classNames } from '../class-names.ts'
import { CopyButton, Snippets } from './Snippets.tsx'

export interface TunnelSectionProps {
  view: AccessView
  send: AccessSend
  steps: TestStep[] | null
  testing: boolean
  ask: TunnelAsk
  onAsk(ask: TunnelAsk): void
}

/** A setting as its field shows it: a port not set is empty (its placeholder says the default). */
const shown = (value: string | number | null): string => (value === null ? '' : String(value))

export function TunnelSection({ view, send, steps, testing, ask, onAsk }: TunnelSectionProps) {
  const t = useT()
  const { canEdit, now } = useBoardContext()
  const { settings, problems, blocked, status, ssh, key, hostKey, listenPort } = view.tunnel
  const probe = status.state === 'connected' && status.probe && !status.probe.ok ? status.probe : null
  const hint = status.state === 'error' || status.state === 'reconnecting' ? hintText(status.hint, t) : ''

  const placeholders: Record<TunnelField, string> = {
    host: 'ssh.example.com',
    sshPort: '22',
    user: 'boardtunnel',
    key: t('access.key.own'),
    socket: TUNNEL_SOCKET,
    domain: 'board.example.com',
    publicPort: '443',
    port: String(listenPort),
  }

  /** A field left: what changed goes to the board; refused or the same, the board's value shows again. */
  async function save(field: TunnelField, input: HTMLInputElement): Promise<void> {
    const before = settings[field]
    const edit = fieldEdit(field, before, input.value)
    if (!edit) {
      input.value = shown(before)
      return
    }
    const reply = await send('tunnel', { fields: { [field]: edit.value } })
    if (reply?.ok === true) return
    input.value = shown(before)
    if (field === 'domain' && reply?.confirm === 'domain') onAsk({ kind: 'domain', domain: String(edit.value) })
  }

  const keyDown = (field: TunnelField) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') {
      // The field's own: the panel stays open.
      e.stopPropagation()
      e.currentTarget.value = shown(settings[field])
      e.currentTarget.blur()
    }
  }

  /** Generate key: at once while there is none; over the one there, asked first. */
  async function generate(): Promise<void> {
    if (key.exists && ask?.kind !== 'key') return onAsk({ kind: 'key' })
    const replace = ask?.kind === 'key'
    onAsk(null)
    const reply = await send('key-generate', replace ? { replace: true } : {})
    // The board has one the view did not know of: asked then.
    if (reply?.confirm === 'key') onAsk({ kind: 'key' })
  }

  async function changeDomain(domain: string): Promise<void> {
    onAsk(null)
    await send('tunnel', { fields: { domain }, confirm: true })
  }

  return (
    <section className="access-tunnel">
      <h3 className="access-head">{t('access.tunnel')}</h3>
      <p className="access-reach">{t('access.reach')}</p>
      <p className="access-status">{statusLine(status, t, now)}</p>
      {hint && <p className="access-hint">{hint}</p>}
      {probe && <p className="access-warn">{t('access.probeFailed', { detail: probe.detail })}</p>}
      <p className={classNames('access-ssh', !ssh && 'access-warn')}>
        {ssh ? t('access.ssh', { path: ssh }) : hintText('noSsh', t)}
      </p>
      <div className="access-actions">
        {settings.on ? (
          <button type="button" className="button" disabled={!canEdit} onClick={() => void send('off')}>
            {t('access.off')}
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={!canEdit || blocked !== null}
            onClick={() => void send('on')}
          >
            {t('access.on')}
          </button>
        )}
        <button type="button" className="button" disabled={!canEdit || testing} onClick={() => void send('test')}>
          {testing ? t('access.testing') : t('access.test')}
        </button>
      </div>
      {blocked && <p className="access-why">{blocked}</p>}
      {steps && (
        <ul className="access-steps">
          {steps.map(s => (
            <li key={s.id}>
              <span className="access-step">{stepLine(s, t)}</span>
              {s.ok === false && s.hint && <p className="access-hint">{hintText(s.hint, t)}</p>}
            </li>
          ))}
        </ul>
      )}

      <h3 className="access-head">{t('access.fields')}</h3>
      <div className="access-fields">
        {TUNNEL_FIELDS.map(field => {
          const label = t(`tunnel.field.${field}`)
          const value = shown(settings[field])
          return (
            <div className="access-entry" key={field}>
              <label className="access-field">
                <span>{label}</span>
                <input
                  // Drawn again with the board's value once it changes (an uncontrolled field: what is typed stays until then).
                  key={value}
                  className="path-add"
                  name={field}
                  aria-label={label}
                  placeholder={placeholders[field]}
                  defaultValue={value}
                  spellCheck={false}
                  autoComplete="off"
                  inputMode={PORT_FIELDS.has(field) ? 'numeric' : undefined}
                  disabled={!canEdit}
                  onKeyDown={keyDown(field)}
                  onBlur={(e: FocusEvent<HTMLInputElement>) => void save(field, e.currentTarget)}
                />
              </label>
              {problems
                .filter(p => p.field === field)
                .map(p => (
                  <p className="access-problem" key={p.message}>
                    {p.message}
                  </p>
                ))}
              {field === 'domain' && ask?.kind === 'domain' && (
                <div className="access-ask">
                  <p className="access-sure">{t('access.domainSure')}</p>
                  <div className="access-actions">
                    <button
                      type="button"
                      className="button primary"
                      disabled={!canEdit}
                      onClick={() => void changeDomain(ask.domain)}
                    >
                      {t('access.domainChange', { domain: ask.domain })}
                    </button>
                    <button type="button" className="button" onClick={() => onAsk(null)}>
                      {t('access.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="access-key">
        <h3 className="access-head">{t('access.key')}</h3>
        <p className="access-line">
          <span>{key.generated ? t('access.key.own') : t('tunnel.field.key')}</span>
          <code className="access-code">{key.path}</code>
        </p>
        {!key.exists && <p className="sheet-meta">{t('access.key.missing')}</p>}
        {key.error && <p className="access-problem">{key.error}</p>}
        {key.generated && (
          <div className="access-actions">
            <button
              type="button"
              className={classNames('button', ask?.kind === 'key' && 'primary')}
              disabled={!canEdit}
              onBlur={() => {
                if (ask?.kind === 'key') onAsk(null)
              }}
              onClick={() => void generate()}
            >
              {ask?.kind === 'key' ? t('access.replace') : t('access.generate')}
            </button>
          </div>
        )}
        {ask?.kind === 'key' && <p className="access-sure">{t('access.keySure')}</p>}
        {key.publicKey && (
          <>
            <p className="access-line">
              <span>{t('access.publicKey')}</span>
              <code className="access-code">{key.publicKey}</code>
              <CopyButton text={key.publicKey} />
            </p>
            <p className="access-line">
              <span>{t('access.keysLine')}</span>
              <code className="access-code">{keysLine(key.publicKey)}</code>
              <CopyButton text={keysLine(key.publicKey)} />
            </p>
          </>
        )}
        {hostKey && (
          <p className="access-line">
            <span>{t('access.hostKey')}</span>
            <code className="access-code">{hostKey}</code>
            <button type="button" className="button" disabled={!canEdit} onClick={() => void send('hostkey-forget')}>
              {t('access.forget')}
            </button>
          </p>
        )}
      </div>

      <Snippets settings={settings} publicKey={key.publicKey} />
    </section>
  )
}
